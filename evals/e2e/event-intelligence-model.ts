import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInit } from '../../cli/init.js';
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
const MODEL = process.env.EI_E2E_MODEL ?? 'gpt-5.6-luna';
const REPOSITORY = process.env.EI_E2E_REPOSITORY ?? 'sarooo17/muffin-agent';
const BRANCH = process.env.EI_E2E_BRANCH ?? 'ei-model-e2e-fixture';
const TIMEOUT_MS = Number(process.env.EI_E2E_TIMEOUT_MS ?? 180_000);

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
  // Read the secret once, only to hand it to Muffin's existing init secret
  // store. It is never printed and never passed in argv.
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

    // Pin the exact real MCP stdio server definition before Muffin attaches it,
    // using the same allowlist/rug-pull path as a normal install.
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

    const attachReport = await attachMcp(runtime, home);
    const exposure = runtime.recomputeExposure();
    if (attachReport.some((line) => line.includes('attach fallito'))) {
      throw new Error(`EI attach failed: ${attachReport.join(' | ')}`);
    }
    if (exposure.some((line) => /event_watch_(sources|create)/.test(line))) {
      throw new Error(`EI tools were truncated from model exposure: ${exposure.join(' | ')}`);
    }

    safeLine('EI_MODEL_E2E_BOOT', {
      model: MODEL,
      repository: REPOSITORY,
      branch: BRANCH,
      attachReport,
      exposure,
    });

    const session = runtime.deps.sessions.open('ei-model-e2e');
    const prompt =
      `Avvisami quando cambia l'HEAD del branch "${BRANCH}" del repo "${REPOSITORY}". ` +
      'Non serve controllarlo continuamente con il modello: aspetta il cambiamento e dimmelo quando succede.';

    const first = await runTurn(runtime.deps, {
      principal: OWNER,
      tenant: TENANT,
      surface: 'cli',
      session,
      text: prompt,
      replyTo: { channel: 'cli', chatId: 'ei-model-e2e' },
    });

    const firstCalls = runtime.deps.turns.effects({ turnId: first.turnId }).calls.map((call) => ({
      tool: call.tool,
      capability: call.capability,
      isError: call.isError,
    }));
    const createdWatch = firstCalls.some((call) => call.tool === 'event_watch_create');
    if (!createdWatch) {
      throw new Error(
        `model did not create an event watch; tool calls: ${firstCalls.map((c) => c.tool).join(', ') || '(none)'}`,
      );
    }

    safeLine('EI_MODEL_E2E_ARMED', {
      turnId: first.turnId,
      stopped: first.stopped,
      toolCalls: firstCalls,
      response: first.text,
    });

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

    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline && delivery.value === null) {
      lane.tick(new Date());
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const delivered = delivery.value;
    if (delivered === null) {
      throw new Error(`timed out waiting for EI wake/model reply after ${TIMEOUT_MS}ms`);
    }

    const finalRecord = runtime.deps.turns.get(delivered.turnId);
    const finalCalls = runtime.deps.turns.effects({ turnId: delivered.turnId }).calls.map((call) => ({
      tool: call.tool,
      capability: call.capability,
      isError: call.isError,
    }));

    safeLine('EI_MODEL_E2E_COMPLETE', {
      wakeTurnId: delivered.turnId,
      principal: finalRecord?.principal ?? null,
      toolCalls: finalCalls,
      response: delivered.text,
      laneEvents,
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