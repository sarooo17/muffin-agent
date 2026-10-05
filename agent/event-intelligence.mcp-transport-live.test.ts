import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { connectServer } from '../core/mcp/connect.js';
import { type McpServerEntry, pinTools } from '../core/mcp/registry.js';
import { createMuffinEventIntelligence, type EventWakePort } from './event-intelligence.js';
import { toolContext } from './fixtures/tool-context.js';
import type { TurnInput } from './loop.js';
import { buildMcpTools } from './tools/mcp.js';

const liveDescribe = process.env.EI_LIVE_GITHUB_TRANSPORT === '1' ? describe : describe.skip;
const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'core',
  'mcp',
  'fixtures',
  'github-events-server.mjs',
);

function fixtureEntry(): McpServerEntry {
  return {
    command: process.execPath,
    args: [FIXTURE],
    env: {},
    approvedAt: '2026-10-03T00:00:00Z',
    tools: {},
  };
}

liveDescribe('real MCP stdio -> GitHub -> EI -> Muffin Work', () => {
  it("shares Muffin's real MCP session and wakes once after an external GitHub ref change", async () => {
    const repository = process.env.GITHUB_REPOSITORY;
    const expectedHead = process.env.GITHUB_SHA;
    const branch = process.env.EI_LIVE_BRANCH;
    const baselineSha = process.env.EI_LIVE_BASE_SHA;

    if (!repository || !expectedHead || !branch || !baselineSha) {
      throw new Error('GitHub transport E2E context is incomplete');
    }

    const [owner, repo] = repository.split('/');
    if (!owner || !repo) throw new Error(`Invalid GITHUB_REPOSITORY: ${repository}`);

    // Approve exactly what Muffin sees from the real stdio server.
    const probe = await connectServer('github-events', fixtureEntry());
    const pins = pinTools(probe.tools);
    expect(probe.getCapabilities?.()).toMatchObject({
      extensions: { 'io.modelcontextprotocol/events': {} },
    });
    await probe.close();

    const attachment = await buildMcpTools({
      schemaVersion: 1,
      servers: {
        'github-events': {
          ...fixtureEntry(),
          tools: pins,
        },
      },
    });

    const home = mkdtempSync(join(tmpdir(), 'muffin-ei-transport-live-'));
    const queued: TurnInput[] = [];
    const existing = new Set<string>();
    const source = {
      id: 'transport-live-source-turn',
      tenant: 'host',
      surface: 'telegram',
      sessionId: 'owner',
      replyTo: { chatId: '42' },
    };
    const port: EventWakePort = {
      source: (id) => (id === source.id ? source : null),
      has: (id) => existing.has(id),
      openSession: (id) => ({ id, file: join(home, `${id}.jsonl`) }),
      enqueue: (input) => {
        queued.push(input);
        const id = input.id;
        if (!id) throw new Error('wake Turn must have a deterministic id');
        existing.add(id);
        return id;
      },
    };

    expect(attachment.eventConnections).toHaveLength(1);

    const embedded = await createMuffinEventIntelligence(attachment.eventConnections, home, port);

    try {
      const statuses = await embedded.status();
      expect(statuses).toHaveLength(1);
      expect(JSON.stringify(statuses)).toContain('github.branch.head_changed');

      const create = embedded.toolCatalog.get('event_watch_create');
      if (!create) throw new Error('event_watch_create was not registered');

      const armed = await create.execute(
        {
          events: [
            {
              event: 'github.branch.head_changed',
              arguments: { owner, repo, branch, baselineSha },
              where: [{ path: 'after', op: 'eq', value: expectedHead }],
            },
          ],
          instruction: `GitHub branch ${branch} changed. Inspect the new head.`,
          one_shot: true,
        },
        toolContext({ turnId: source.id }),
      );
      expect(armed.ok).toBe(true);

      // Baseline through the real Muffin MCP client -> stdio child -> GitHub.
      await embedded.host.runtime.mcpEventsClient.pollAll();
      expect(queued).toHaveLength(0);

      // A separate test driver moves the remote branch while this process waits.
      for (let attempt = 0; attempt < 30 && queued.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        await embedded.host.runtime.mcpEventsClient.pollAll();
      }

      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({
        principal: { kind: 'system', source: 'event-intelligence' },
        tenant: 'host',
        surface: 'telegram',
        replyTo: { chatId: '42' },
        contentTaint: 3,
      });
      expect(queued[0]?.text).toContain(branch);
      expect(queued[0]?.text).toContain(expectedHead);
      expect(queued[0]?.text).toContain(baselineSha);

      await embedded.host.runtime.mcpEventsClient.pollAll();
      expect(queued).toHaveLength(1);
    } finally {
      await embedded.close().catch(() => {});
      await attachment.close();
      rmSync(home, { recursive: true, force: true });
    }
  }, 90_000);
});
