// Test fixture: a real MCP Events server over stdio.
//
// It observes public GitHub branch state through the live GitHub REST API.
// The test driver mutates the branch from outside this process; this server is
// read-only and only reports a change through MCP Events.
import { readFile } from 'node:fs/promises';
import { McpServer, ProtocolError } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import {
  createMcpEventsProvider,
  MCP_EVENTS_CAPABILITY,
  MCP_EVENTS_CAPABILITY_KEY,
} from 'mcp-event-intelligence/provider';
import * as z from 'zod';

const provider = createMcpEventsProvider({
  events: [
    {
      descriptor: {
        name: 'github.branch.head_changed',
        description: 'A public GitHub branch head changed to a different commit SHA.',
        delivery: ['poll'],
        inputSchema: {
          type: 'object',
          required: ['owner', 'repo', 'branch'],
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
        const owner = String(args.owner);
        const repo = String(args.repo);
        const branch = String(args.branch);
        const requestedBaseline =
          typeof args.baselineSha === 'string' && args.baselineSha.length > 0
            ? args.baselineSha
            : null;
        const headFile = process.env.EI_E2E_HEAD_FILE;
        let current;
        if (headFile) {
          current = (await readFile(headFile, 'utf8')).trim();
        } else {
          // The live transport test intentionally stays credential-free.
          // Lifecycle E2E supplies EI_E2E_HEAD_FILE instead, so its correctness
          // never depends on shared GitHub egress quotas or feed caching.
          const branchPath = branch.split('/').map(encodeURIComponent).join('/');
          const response = await fetch(
            `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${branchPath}.atom`,
            {
              headers: {
                Accept: 'application/atom+xml',
                'User-Agent': 'muffin-ei-transport-fixture',
              },
            },
          );
          if (!response.ok) {
            const body = await response.text();
            throw new Error(`GitHub Atom feed failed: ${response.status} ${body}`);
          }
          const feed = await response.text();
          current = feed.match(/\/commit\/([0-9a-f]{40})/i)?.[1];
        }
        if (!current) {
          throw new Error('GitHub event fixture did not contain a head SHA');
        }

        // A natural-language watch does not know a SHA. Its first poll is a
        // baseline observation, never an event. Tests that need a deterministic
        // baseline may still pass baselineSha explicitly.
        if (cursor === null && requestedBaseline === null) {
          return {
            events: [],
            cursor: current,
            hasMore: false,
            nextPollMs: 1_000,
          };
        }

        const baseline = cursor ?? requestedBaseline;
        if (baseline === null || current === baseline) {
          return {
            events: [],
            cursor: current,
            hasMore: false,
            nextPollMs: 1_000,
          };
        }

        return {
          events: [
            {
              eventId: `github:${owner}/${repo}:${branch}:${current}`,
              name: 'github.branch.head_changed',
              timestamp: new Date().toISOString(),
              data: {
                owner,
                repo,
                branch,
                before: baseline,
                after: current,
              },
            },
          ],
          cursor: current,
          hasMore: false,
          nextPollMs: 1_000,
        };
      },
    },
  ],
});

const server = new McpServer(
  { name: 'github-events-fixture', version: '1.0.0' },
  {
    capabilities: {
      extensions: {
        [MCP_EVENTS_CAPABILITY_KEY]: MCP_EVENTS_CAPABILITY,
      },
    },
  },
);

// Muffin v1 always lists tools during MCP connection setup. Keep one inert,
// hash-pinnable tool so this fixture exercises the exact production path.
server.registerTool(
  'about',
  {
    description: 'Describe the GitHub Events fixture.',
    inputSchema: z.object({}),
  },
  async () => ({
    content: [{ type: 'text', text: 'read-only GitHub branch Events fixture' }],
  }),
);

const paramsSchema = z.record(z.string(), z.unknown());

server.server.setRequestHandler('events/list', { params: paramsSchema }, async (params) => {
  const response = await provider.handleRequest({
    jsonrpc: '2.0',
    id: 'events/list',
    method: 'events/list',
    params,
  });
  if ('error' in response) {
    throw new ProtocolError(response.error.code, response.error.message, response.error.data);
  }
  return response.result;
});

server.server.setRequestHandler('events/poll', { params: paramsSchema }, async (params) => {
  const response = await provider.handleRequest({
    jsonrpc: '2.0',
    id: 'events/poll',
    method: 'events/poll',
    params,
  });
  if ('error' in response) {
    throw new ProtocolError(response.error.code, response.error.message, response.error.data);
  }
  return response.result;
});

await server.connect(new StdioServerTransport());
