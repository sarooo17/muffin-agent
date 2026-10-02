import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createEventIntelligenceHost,
  createMcpRegistryAdapter,
} from 'mcp-event-intelligence/host';
import { createMcpEventsProvider } from 'mcp-event-intelligence/provider';
import { toolContext } from './fixtures/tool-context.js';
import type { TurnInput } from './loop.js';
import {
  deliverEventWake,
  makeEventIntelligenceTools,
  type EventWakePort,
} from './event-intelligence.js';

type JsonObject = Record<string, unknown>;

const liveDescribe = process.env.EI_LIVE_GITHUB === '1' ? describe : describe.skip;

async function github<T = JsonObject>(path: string): Promise<T> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is required for the live GitHub EI test');

  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API GET ${path} -> ${response.status}: ${body}`);
  }
  return (await response.json()) as T;
}

liveDescribe('live GitHub -> MCP Events -> EI -> Muffin Work', () => {
  it('wakes when a real remote branch ref changes while Muffin is waiting', async () => {
    const repository = process.env.GITHUB_REPOSITORY;
    const expectedHead = process.env.GITHUB_SHA;
    const branch = process.env.EI_LIVE_BRANCH;
    const baselineSha = process.env.EI_LIVE_BASE_SHA;

    if (!repository || !expectedHead || !branch || !baselineSha) {
      throw new Error('GitHub live EI test context is incomplete');
    }

    const [owner, repo] = repository.split('/');
    if (!owner || !repo) throw new Error(`Invalid GITHUB_REPOSITORY: ${repository}`);

    const home = mkdtempSync(join(tmpdir(), 'muffin-ei-github-live-'));
    const queued: TurnInput[] = [];
    const existing = new Set<string>();
    const source = {
      id: 'github-live-source-turn',
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
        existing.add(input.id!);
        return input.id!;
      },
    };

    const provider = createMcpEventsProvider({
      events: [{
        descriptor: {
          name: 'github.branch.head_changed',
          description: 'A GitHub branch head changed to a different commit SHA.',
          delivery: ['poll'],
          inputSchema: {
            type: 'object',
            required: ['owner', 'repo', 'branch', 'baselineSha'],
            additionalProperties: false,
            properties: {
              owner: { type: 'string', minLength: 1 },
              repo: { type: 'string', minLength: 1 },
              branch: { type: 'string', minLength: 1 },
              baselineSha: { type: 'string', minLength: 40, maxLength: 64 },
            },
          },
          payloadSchema: {
            type: 'object',
            required: ['owner', 'repo', 'branch', 'before', 'after'],
            additionalProperties: false,
            properties: {
              owner: { type: 'string' },
              repo: { type: 'string' },
              branch: { type: 'string' },
              before: { type: 'string' },
              after: { type: 'string' },
            },
          },
        },
        poll: async ({ arguments: args, cursor }) => {
          const targetOwner = String(args.owner);
          const targetRepo = String(args.repo);
          const targetBranch = String(args.branch);
          const baseline = cursor ?? String(args.baselineSha);

          const ref = await github<{ object: { sha: string } }>(
            `/repos/${targetOwner}/${targetRepo}/git/ref/heads/${encodeURIComponent(targetBranch)}`,
          );
          const current = ref.object.sha;

          if (current === baseline) {
            return {
              events: [],
              cursor: current,
              hasMore: false,
              nextPollMs: 1_000,
            };
          }

          return {
            events: [{
              eventId: `github:${targetOwner}/${targetRepo}:${targetBranch}:${current}`,
              name: 'github.branch.head_changed',
              timestamp: new Date().toISOString(),
              data: {
                owner: targetOwner,
                repo: targetRepo,
                branch: targetBranch,
                before: baseline,
                after: current,
              },
            }],
            cursor: current,
            hasMore: false,
            nextPollMs: 1_000,
          };
        },
      }],
    });

    let requestId = 0;
    const connection = {
      connectionId: 'github-live',
      serverId: 'github-live',
      getCapabilities: () => ({
        extensions: { 'io.modelcontextprotocol/events': {} },
      }),
      request: async (method: string, params?: unknown) => {
        const response = await provider.handleRequest({
          jsonrpc: '2.0',
          id: ++requestId,
          method,
          ...(params === undefined ? {} : { params }),
        });
        if ('error' in response && response.error) {
          throw new Error(`MCP Events ${method} failed: ${response.error.message}`);
        }
        return 'result' in response ? response.result : undefined;
      },
      pollIntervalMs: 1_000,
    };

    const host = await createEventIntelligenceHost({
      dataDir: join(home, 'ei'),
      mcpRegistry: createMcpRegistryAdapter({
        listConnections: () => [connection],
      }),
      wake: (packet, activation) => deliverEventWake(port, packet, activation),
    });

    try {
      const create = makeEventIntelligenceTools(host)
        .find((tool) => tool.spec.name === 'event_watch_create');
      expect(create).toBeDefined();

      const armed = await create!.handler(
        {
          events: [{
            event: 'github.branch.head_changed',
            arguments: { owner, repo, branch, baselineSha },
            where: [{ path: 'after', op: 'eq', value: expectedHead }],
          }],
          instruction: `GitHub branch ${branch} changed. Inspect the new head.`,
          one_shot: true,
        },
        toolContext({ turnId: source.id }),
      );
      expect(armed.isError).not.toBe(true);

      // Establish the watch against the real remote branch, then remain idle.
      await host.runtime.mcpEventsClient.pollAll();

      // The branch is moved by the test driver OUTSIDE this process. That is
      // intentional: the observer does not manufacture the event it watches.
      for (let i = 0; i < 30 && queued.length === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        await host.runtime.mcpEventsClient.pollAll();
      }

      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({
        principal: { kind: 'system', source: 'event-intelligence' },
        tenant: 'host',
        surface: 'telegram',
        replyTo: { chatId: '42' },
        contentTaint: 3,
      });
      expect(queued[0]!.text).toContain(branch);
      expect(queued[0]!.text).toContain(expectedHead);
      expect(queued[0]!.text).toContain(baselineSha);

      // One-shot + deterministic wake identity: no replay on the stable head.
      await host.runtime.mcpEventsClient.pollAll();
      expect(queued).toHaveLength(1);
    } finally {
      await host.close().catch(() => {});
      rmSync(home, { recursive: true, force: true });
    }
  }, 90_000);
});
