import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInit } from '../../cli/init.js';
import { loadConfig, saveConfig } from '../../core/config/config.js';
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
      calls: Array<{ tool: string; isError?: boolean }>,
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
    safeLine('EI_MODEL_E2E_PAUSED', { watchId: WATCH_ID });

    const pauseDeadline = Date.now() + PAUSE_VERIFY_MS;
    while (Date.now() < pauseDeadline) {
      lane.tick(new Date());
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (delivery.value !== null) {
        throw new Error('paused watch produced a wake after the fixture branch changed');
      }
    }
    safeLine('EI_MODEL_E2E_PAUSE_VERIFIED', {
      watchId: WATCH_ID,
      noWakeForMs: PAUSE_VERIFY_MS,
    });

    const resumed = await runOwnerTurn(
      'EI_MODEL_E2E_RESUME',
      `Riattiva il monitor "${WATCH_ID}" usando event_watch_resume. Mantieni la stessa condizione e resta in attesa del prossimo cambio del branch.`,
    );
    requireTool(resumed.calls, 'event_watch_resume', 'resume');
    safeLine('EI_MODEL_E2E_RESUMED', { watchId: WATCH_ID });

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

    const removed = await runOwnerTurn(
      'EI_MODEL_E2E_DELETE',
      `Elimina definitivamente il monitor "${WATCH_ID}" usando event_watch_delete.`,
    );
    requireTool(removed.calls, 'event_watch_delete', 'delete');

    const finalList = await runOwnerTurn(
      'EI_MODEL_E2E_FINAL_LIST',
      `Usa event_watch_list per verificare lo stato finale del monitor "${WATCH_ID}" dopo la cancellazione. Non creare o modificare nulla.`,
    );
    requireTool(finalList.calls, 'event_watch_list', 'final list');

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
