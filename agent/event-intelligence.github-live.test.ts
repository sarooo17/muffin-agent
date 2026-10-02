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

async function github<T = JsonObject>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is required for the live GitHub EI test');

  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API ${init.method ?? 'GET'} ${path} -> ${response.status}: ${body}`);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

liveDescribe('live GitHub -> MCP Events -> EI -> Muffin Work', () => {
  it('sleeps on a real GitHub branch head and wakes when the remote ref changes', async () => {
    const repository = process.env.GITHUB_REPOSITORY;
    const headSha = process.env.GITHUB_SHA;
    const runId = process.env.GITHUB_RUN_ID;
    const attempt = process.env.GITHUB_RUN_ATTEMPT ?? '1';

    if (!repository || !headSha || !runId) {
      throw new Error('GitHub Actions repository/run context is required');
    }

    const [owner, repo] = repository.split('/');
    if (!owner || !repo) throw new Error(`Invalid GITHUB_REPOSITORY: ${repository}`);

    const commit = await github<{ parents: Array<{ sha: string }> }>(
      `/repos/${owner}/${repo}/commits/${headSha}`,
    );
    const parentSha = commit.parents[0]?.sha;
    if (!parentSha) throw new Error('Live EI test needs a commit with a parent');

    // An ephemeral branch gives us a real remote state change without creating
    // an issue/comment or polluting the spike branch with synthetic commits.
    const branch = `ei-live-${runId}-${attempt}`;
    const encodedBranch = encodeURIComponent(branch);
    const home = mkdtempSync(join(tmpdir(), 'muffin-ei-github-live-'));

    await github(`/repos/${owner}/${repo}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({
        ref: `refs/heads/${branch}`,
        sha: parentSha,
      }),
    });

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
            required: ['owner', 'repo', 'branch'],
            additionalProperties: false,
            properties: {
              owner: { type: 'string', minLength: 1 },
              repo: { type: 'string', minLength: 1 },
              branch: { type: 'string', minLength: 1 },
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
          const ref = await github<{ object: { sha: string } }>(
            `/repos/${targetOwner}/${targetRepo}/git/ref/heads/${encodeURIComponent(targetBranch)}`,
          );
          const current = ref.object.sha;

          // First observation establishes a cursor. Watching a branch must not
          // fire just because the watcher was created.
          if (cursor === null || cursor === current) {
            return {
              events: [],
              cursor: current,
              hasMore: false,
              nextPollMs: 60_000,
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
                before: cursor,
                after: current,
              },
            }],
            cursor: current,
            hasMore: false,
            nextPollMs: 60_000,
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
      pollIntervalMs: 60_000,
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
            arguments: { owner, repo, branch },
            where: [{ path: 'after', op: 'eq', value: headSha }],
          }],
          instruction: `GitHub branch ${branch} changed. Inspect the new head.`,
          one_shot: true,
        },
        toolContext({ turnId: source.id }),
      );
      expect(armed.isError).not.toBe(true);

      // Baseline the real remote ref while Muffin is "sleeping".
      await host.runtime.mcpEventsClient.pollAll();
      expect(queued).toHaveLength(0);

      // Real external state transition on GitHub: parent -> current spike SHA.
      await github(`/repos/${owner}/${repo}/git/refs/heads/${encodedBranch}`, {
        method: 'PATCH',
        body: JSON.stringify({ sha: headSha, force: false }),
      });

      await host.runtime.mcpEventsClient.pollAll();

      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({
        principal: { kind: 'system', source: 'event-intelligence' },
        tenant: 'host',
        surface: 'telegram',
        replyTo: { chatId: '42' },
        contentTaint: 3,
      });
      expect(queued[0]!.text).toContain(branch);
      expect(queued[0]!.text).toContain(headSha);
      expect(queued[0]!.text).toContain(parentSha);

      // The one-shot trigger plus deterministic wake id must not replay.
      await host.runtime.mcpEventsClient.pollAll();
      expect(queued).toHaveLength(1);
    } finally {
      await host.close().catch(() => {});
      await github(`/repos/${owner}/${repo}/git/refs/heads/${encodedBranch}`, {
        method: 'DELETE',
      }).catch(() => {});
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});
