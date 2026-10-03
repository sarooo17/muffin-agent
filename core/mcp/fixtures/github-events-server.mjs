// Test fixture: a real MCP Events server over stdio.
//
// It observes public GitHub branch state through the live GitHub REST API.
// The test driver mutates the branch from outside this process; this server is
// read-only and only reports a change through MCP Events.
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
        const owner = String(args.owner);
        const repo = String(args.repo);
        const branch = String(args.branch);
        const baseline = cursor ?? String(args.baselineSha);
        const response = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
          {
            headers: {
              Accept: 'application/vnd.github+json',
              'User-Agent': 'muffin-ei-transport-fixture',
              'X-GitHub-Api-Version': '2022-11-28',
            },
          },
        );
        if (!response.ok) {
          const body = await response.text();
          throw new Error(`GitHub GET ref failed: ${response.status} ${body}`);
        }
        const ref = await response.json();
        const current = ref?.object?.sha;
        if (typeof current !== 'string' || current.length === 0) {
          throw new Error('GitHub ref response did not contain object.sha');
        }

        if (current === baseline) {
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
