import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInit } from '../../cli/init.js';
import { loadConfig, saveConfig } from '../../core/config/config.js';
import { toolContext } from '../../agent/fixtures/tool-context.js';
import { runTurn } from '../../agent/loop.js';
import { attachMcp, buildRuntime } from '../../agent/runtime.js';
import { makeLaneRunner } from '../../agent/turn-lane.js';
import { connectServer } from '../../core/mcp/connect.js';
import {
  pinTools,
  saveMcpRegistry,
  type McpServerEntry,
} from '../../core/mcp/registry.js';
import { TurnLane } from '../../core/turns/lane.js';
import { ModelLane } from '../../core/turns/model-lane.js';

const OWNER = { kind: 'owner', connector: 'cli', externalId: 'local' } as const;
const TENANT = 'host';
const MODEL = process.env.EI_E2E_MODEL ?? 'gpt-5.6-sol';
const REPOSITORY = process.env.EI_E2E_REPOSITORY ?? 'sarooo17/muffin-agent';
const BRANCH = process.env.EI_E2E_BRANCH ?? 'ei-model-e2e-fixture';
const TIMEOUT_MS = Number(process.env.EI_E2E_TIMEOUT_MS ?? 180_000);
const PAUSE_VERIFY_MS = Number(process.env.EI_E2E_PAUSE_VERIFY_MS ?? 20_000);
const WATCH_ID = 'luna-lifecycle-watch';

function requireSecret(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function fixturePath(): string {
  return join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'core',
    'mcp',
    'fixtures',
    'github-events-server.mjs',
  );
}

function fixtureEntry(): McpServerEntry {
  return {
    command: process.execPath,
    args: [fixturePath()],
    env: {},
    approvedAt: new Date().toISOString(),
    tools: {},
  };
}

function safeLine(label: string, value: unknown): void {
  process.stdout.write(`${label} ${JSON.stringify(value)}\n`);
}

async function fetchBranchHead(): Promise<string> {
  const [owner, repo] = REPOSITORY.split('/');
  if (!owner || !repo) throw new Error(`Invalid EI_E2E_REPOSITORY: ${REPOSITORY}`);
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(BRANCH)}`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'muffin-ei-model-e2e',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  );
  if (!response.ok) {
    throw new Error(`GitHub GET ref failed: ${response.status} ${await response.text()}`);
  }
  const payload = await response.json() as { object?: { sha?: unknown } };
  const sha = payload.object?.sha;
  if (typeof sha !== 'string' || sha.length === 0) {
    throw new Error('GitHub ref response did not contain object.sha');
  }
  return sha;
}

async function main(): Promise<void> {
  const apiKey = requireSecret('OPENAI_API_KEY');
  process.env.MUFFIN_EVENT_INTELLIGENCE = '1';

  const home = mkdtempSync(join(tmpdir(), 'muffin-ei-model-home-'));
  const workspace = mkdtempSync(join(tmpdir(), 'muffin-ei-model-ws-'));

  let runtime: ReturnType<typeof buildRuntime> | null = null;
  try {
    runInit({
      home,
      provider: 'openai-compat',
      apiKey,
      mainModel: MODEL,
      lightModel: MODEL,
    });

    const config = loadConfig(home);
    saveConfig({
      ...config,
      thinking: 'off',
      provider: {
        ...config.provider,
        reasoningDialect: 'reasoning_effort',
      },
    }, home);

    const probe = await connectServer('github-events', fixtureEntry());
    const pins = pinTools(probe.tools);
    await probe.close();
    saveMcpRegistry({
      schemaVersion: 1,
      servers: {
        'github-events': {
          ...fixtureEntry(),
          tools: pins,
        },
      },
    }, home);

    runtime = buildRuntime(home, workspace, { extraDenyRead: [homedir()] });
    runtime.consolidation.stop();

    const provider = runtime.deps.provider;
    const originalChat = provider.chat.bind(provider);
    provider.chat = async (call) => {
      try {
        return await originalChat(call);
      } catch (error) {
        safeLine('EI_MODEL_E2E_PROVIDER_ERROR', {
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    };

    runtime.memory.store.hasActiveFacts = () => true;

    const attachReport = await attachMcp(runtime, home);

    const fixtureAbout = runtime.deps.tools.findIndex(
      (tool) => tool.spec.name === 'mcp_github-events_about',
    );
    if (fixtureAbout >= 0) runtime.deps.tools.splice(fixtureAbout, 1);

    const exposure = runtime.recomputeExposure();
    if (attachReport.some((line) => line.includes('attach fallito'))) {
      throw new Error(`EI attach failed: ${attachReport.join(' | ')}`);
    }
    const lifecycleTools = [
      'event_watch_sources',
      'event_watch_create',
      'event_watch_list',
      'event_watch_inspect',
      'event_watch_pause',
      'event_watch_resume',
      'event_watch_update',
      'event_watch_delete',
    ];
    if (exposure.some((line) => lifecycleTools.some((name) => line.includes(name)))) {
      throw new Error(`EI lifecycle tools were truncated from model exposure: ${exposure.join(' | ')}`);
    }

    safeLine('EI_MODEL_E2E_BOOT', {
      model: MODEL,
      repository: REPOSITORY,
      branch: BRANCH,
      attachReport,
      exposure,
      tools: runtime.deps.tools.map((tool) => tool.spec.name),
    });

    const session = runtime.deps.sessions.open('ei-model-e2e');
    const runOwnerTurn = async (label: string, text: string) => {
      const result = await runTurn(runtime!.deps, {
        principal: OWNER,
        tenant: TENANT,
        surface: 'cli',
        session,
        text,
        replyTo: { channel: 'cli', chatId: 'ei-model-e2e' },
      });
      const calls = runtime!.deps.turns.effects({ turnId: result.turnId }).calls.map((call) => ({
        tool: call.tool,
        capability: call.capability,
        isError: call.isError,
      }));
      safeLine(label, {
        turnId: result.turnId,
        stopped: result.stopped,
        toolCalls: calls,
        response: result.text,
      });
      return { result, calls };
    };
    const requireTool = (
      calls: Array<{ tool: string; isError?: boolean | null }>,
      tool: string,
      phase: string,
    ) => {
      const call = calls.find((entry) => entry.tool === tool);
      if (!call) {
        throw new Error(
          `${phase}: model did not call ${tool}; calls=${calls.map((entry) => entry.tool).join(', ') || '(none)'}`,
        );
      }
      if (call.isError) {
        throw new Error(`${phase}: ${tool} returned an error`);
      }
    };

    const readWatchTool = async (
      name: 'event_watch_list' | 'event_watch_inspect',
      args: Record<string, unknown>,
      label: string,
    ) => {
      const tool = runtime!.deps.tools.find((candidate) => candidate.spec.name === name);
      if (!tool) throw new Error(`${label}: ${name} is not registered`);
      const result = await tool.handler(
        args,
        toolContext({
          turnId: `ei-e2e-assert:${label}`,
          sessionId: `ei-e2e-assert:${label}`,
        }),
      );
      if (result.isError) {
        throw new Error(`${label}: ${name} failed: ${result.content}`);
      }
      const parsed = JSON.parse(result.content) as Record<string, unknown>;
      safeLine('EI_MODEL_E2E_STATE_ASSERT', { label, tool: name, value: parsed });
      return parsed;
    };

    const inspectCurrentWatch = async (label: string) => {
      const listed = await readWatchTool(
        'event_watch_list',
        {
          trigger_id: WATCH_ID,
          status: ['active', 'paused'],
          include_definition: true,
          limit: 200,
        },
        `${label}:list`,
      );
      const entries = Array.isArray(listed.triggers)
        ? listed.triggers as Array<{ version?: unknown; status?: unknown }>
        : [];
      if (entries.length !== 1 || !entries[0]?.version) {
        throw new Error(
          `${label}: expected exactly one current watch ${WATCH_ID}; found ${entries.length}`,
        );
      }
      const version = String(entries[0].version);
      const inspected = await readWatchTool(
        'event_watch_inspect',
        { trigger_id: WATCH_ID, version },
        `${label}:inspect`,
      );
      return { version, inspected };
    };

    const created = await runOwnerTurn(
      'EI_MODEL_E2E_CREATE',
      `Crea davvero un monitor persistente con id "${WATCH_ID}" che mi avvisi ogni volta che cambia l'HEAD del branch "${BRANCH}" del repo "${REPOSITORY}". ` +
        'Usa prima event_watch_sources per verificare la sorgente e poi event_watch_create. ' +
        'Il monitor deve restare attivo dopo un match, quindi non deve essere one-shot.',
    );
    requireTool(created.calls, 'event_watch_sources', 'create');
    requireTool(created.calls, 'event_watch_create', 'create');
    safeLine('EI_MODEL_E2E_ARMED', { watchId: WATCH_ID, turnId: created.result.turnId });

    const inspected = await runOwnerTurn(
      'EI_MODEL_E2E_LIST_INSPECT',
      `Verifica il monitor "${WATCH_ID}" appena creato: usa event_watch_list per trovarlo e event_watch_inspect per mostrarmi stato e dettagli. Non modificarlo.`,
    );
    requireTool(inspected.calls, 'event_watch_list', 'list/inspect');
    requireTool(inspected.calls, 'event_watch_inspect', 'list/inspect');

    const initialPersisted = await inspectCurrentWatch('after-create');
    const initialLifecycle = initialPersisted.inspected.lifecycle as { status?: unknown } | undefined;
    const initialTrigger = initialPersisted.inspected.trigger as {
      lifecycle?: { oneShot?: unknown };
    } | undefined;
    if (initialLifecycle?.status !== 'active') {
      throw new Error(`after-create: expected active, got ${String(initialLifecycle?.status)}`);
    }
    if (initialTrigger?.lifecycle?.oneShot !== false) {
      throw new Error(
        `after-create: expected persistent oneShot=false, got ${String(initialTrigger?.lifecycle?.oneShot)}`,
      );
    }

    const branchHeadBeforePause = await fetchBranchHead();

    const delivery: { value: { turnId: string; text: string } | null } = { value: null };
    const laneEvents: Array<Record<string, unknown>> = [];
    const lane = new TurnLane({
      turns: runtime.deps.turns,
      modelLane: new ModelLane(),
      run: makeLaneRunner(
        runtime.deps,
        async (turn, text) => {
          delivery.value = { turnId: turn.id, text };
        },
        (event) => laneEvents.push(event as unknown as Record<string, unknown>),
      ),
      onEvent: (event) => laneEvents.push(event as unknown as Record<string, unknown>),
    });

    const paused = await runOwnerTurn(
      'EI_MODEL_E2E_PAUSE',
      `Metti in pausa il monitor "${WATCH_ID}" usando event_watch_pause. Non cancellarlo e non crearne un altro.`,
    );
    requireTool(paused.calls, 'event_watch_pause', 'pause');
    const pausedPersisted = await inspectCurrentWatch('after-pause');
    const pausedLifecycle = pausedPersisted.inspected.lifecycle as { status?: unknown } | undefined;
    if (pausedLifecycle?.status !== 'paused') {
      throw new Error(`after-pause: expected paused, got ${String(pausedLifecycle?.status)}`);
    }
    safeLine('EI_MODEL_E2E_PAUSED', {
      watchId: WATCH_ID,
      branchHeadBeforePause,
    });

    const pauseDeadline = Date.now() + PAUSE_VERIFY_MS;
    let branchHeadDuringPause = branchHeadBeforePause;
    while (Date.now() < pauseDeadline && branchHeadDuringPause === branchHeadBeforePause) {
      lane.tick(new Date());
      if (delivery.value !== null) {
        throw new Error('paused watch produced a wake before pause verification completed');
      }
      branchHeadDuringPause = await fetchBranchHead();
      if (branchHeadDuringPause === branchHeadBeforePause) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    if (branchHeadDuringPause === branchHeadBeforePause) {
      throw new Error(
        `fixture branch did not change while watch was paused within ${PAUSE_VERIFY_MS}ms`,
      );
    }

    // Give the MCP Events poller enough time to observe the changed remote ref
    // while the trigger remains paused. A broken pause implementation must wake here.
    const pausedSettleDeadline = Date.now() + 4_000;
    while (Date.now() < pausedSettleDeadline) {
      lane.tick(new Date());
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (delivery.value !== null) {
        throw new Error('paused watch produced a wake after the fixture branch changed');
      }
    }
    safeLine('EI_MODEL_E2E_PAUSE_VERIFIED', {
      watchId: WATCH_ID,
      branchHeadBeforePause,
      branchHeadDuringPause,
      noWakeAfterObservedChangeMs: 4_000,
    });

    const resumed = await runOwnerTurn(
      'EI_MODEL_E2E_RESUME',
      `Riattiva il monitor "${WATCH_ID}" usando event_watch_resume. Mantieni la stessa condizione e resta in attesa del prossimo cambio del branch.`,
    );
    requireTool(resumed.calls, 'event_watch_resume', 'resume');
    const resumedPersisted = await inspectCurrentWatch('after-resume');
    const resumedLifecycle = resumedPersisted.inspected.lifecycle as { status?: unknown } | undefined;
    if (resumedLifecycle?.status !== 'active') {
      throw new Error(`after-resume: expected active, got ${String(resumedLifecycle?.status)}`);
    }
    safeLine('EI_MODEL_E2E_RESUMED', {
      watchId: WATCH_ID,
      version: resumedPersisted.version,
    });

    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline && delivery.value === null) {
      lane.tick(new Date());
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const delivered = delivery.value;
    if (delivered === null) {
      throw new Error(`timed out waiting for EI wake/model reply after ${TIMEOUT_MS}ms`);
    }

    const wakeRecord = runtime.deps.turns.get(delivered.turnId);
    const wakeCalls = runtime.deps.turns.effects({ turnId: delivered.turnId }).calls.map((call) => ({
      tool: call.tool,
      capability: call.capability,
      isError: call.isError,
    }));

    safeLine('EI_MODEL_E2E_WAKE', {
      wakeTurnId: delivered.turnId,
      principal: wakeRecord?.principal ?? null,
      toolCalls: wakeCalls,
      response: delivered.text,
      laneEvents,
    });

    const updated = await runOwnerTurn(
      'EI_MODEL_E2E_UPDATE',
      `Aggiorna il monitor persistente "${WATCH_ID}" usando event_watch_update: continua a monitorare lo stesso branch "${BRANCH}" del repo "${REPOSITORY}", ma cambia l'istruzione di continuazione in "Segnala il nuovo HEAD e confrontalo con quello precedente". Non renderlo one-shot.`,
    );
    requireTool(updated.calls, 'event_watch_update', 'update');
    const updatedPersisted = await inspectCurrentWatch('after-update');
    const updatedTrigger = updatedPersisted.inspected.trigger as {
      continuation?: { instruction?: unknown } | null;
      lifecycle?: { oneShot?: unknown };
    } | undefined;
    const expectedInstruction = 'Segnala il nuovo HEAD e confrontalo con quello precedente';
    if (updatedTrigger?.continuation?.instruction !== expectedInstruction) {
      throw new Error(
        `after-update: continuation instruction mismatch: ${String(updatedTrigger?.continuation?.instruction)}`,
      );
    }
    if (updatedTrigger?.lifecycle?.oneShot !== false) {
      throw new Error(
        `after-update: expected oneShot=false, got ${String(updatedTrigger?.lifecycle?.oneShot)}`,
      );
    }
    if (updatedPersisted.version === resumedPersisted.version) {
      throw new Error('after-update: expected immutable update to create a new trigger version');
    }

    const removed = await runOwnerTurn(
      'EI_MODEL_E2E_DELETE',
      `Elimina definitivamente il monitor "${WATCH_ID}" usando event_watch_delete.`,
    );
    requireTool(removed.calls, 'event_watch_delete', 'delete');

    const deletedInspection = await readWatchTool(
      'event_watch_inspect',
      { trigger_id: WATCH_ID, version: updatedPersisted.version },
      'after-delete:inspect',
    );
    const deletedLifecycle = deletedInspection.lifecycle as { status?: unknown } | undefined;
    if (deletedLifecycle?.status !== 'deleted') {
      throw new Error(
        `after-delete: expected deleted, got ${String(deletedLifecycle?.status)}`,
      );
    }

    const finalList = await runOwnerTurn(
      'EI_MODEL_E2E_FINAL_LIST',
      `Usa event_watch_list per verificare lo stato finale del monitor "${WATCH_ID}" dopo la cancellazione. Non creare o modificare nulla.`,
    );
    requireTool(finalList.calls, 'event_watch_list', 'final list');
    const finalPersistedList = await readWatchTool(
      'event_watch_list',
      {
        trigger_id: WATCH_ID,
        status: ['active', 'paused'],
        include_definition: true,
        limit: 200,
      },
      'after-delete:list',
    );
    const remaining = Array.isArray(finalPersistedList.triggers)
      ? finalPersistedList.triggers
      : [];
    if (remaining.length !== 0) {
      throw new Error(
        `after-delete: active/paused list still contains ${WATCH_ID}: ${JSON.stringify(remaining)}`,
      );
    }

    safeLine('EI_MODEL_E2E_COMPLETE', {
      watchId: WATCH_ID,
      createCalls: created.calls,
      listInspectCalls: inspected.calls,
      pauseCalls: paused.calls,
      resumeCalls: resumed.calls,
      wakeTurnId: delivered.turnId,
      updateCalls: updated.calls,
      deleteCalls: removed.calls,
      finalListCalls: finalList.calls,
    });
  } finally {
    runtime?.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `EI_MODEL_E2E_FAILED ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
