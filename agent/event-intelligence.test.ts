import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  attachEventIntelligence,
  createMuffinEventIntelligence,
  type EventWakePort,
} from './event-intelligence.js';
import { toolContext } from './fixtures/tool-context.js';
import type { LoopDeps, RegisteredTool, TurnInput } from './loop.js';

function requiredTurnId(input: TurnInput): string {
  if (!input.id) throw new Error('wake Turn must have a deterministic id');
  return input.id;
}

describe('embedded EI on Muffin-owned MCP sessions', () => {
  it('discovers an Events-capable MCP without reconnecting and can persist a watch', async () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-ei-'));
    const registered: RegisteredTool[] = [];
    const closeHooks: Array<() => Promise<void>> = [];
    const traced: Array<{
      name: string;
      attributes: Record<string, unknown>;
      outcome?: unknown;
    }> = [];
    let listCalls = 0;

    const runtime = {
      deps: {
        tracer: {
          start: (name: string, attributes: Record<string, unknown> = {}) => ({
            traceId: 'test-trace',
            spanId: 'test-span',
            setAttributes: () => {},
            end: (outcome?: unknown) => traced.push({ name, attributes, outcome }),
          }),
        },
        turns: {
          get: () => null,
        },
        sessions: {
          open: (id: string) => ({ id, file: join(home, `${id}.jsonl`) }),
        },
      } as unknown as LoopDeps,
      register: (tool: RegisteredTool) => registered.push(tool),
      onClose: (hook: () => Promise<void>) => closeHooks.push(hook),
    };

    try {
      const report = await attachEventIntelligence(
        runtime,
        [
          {
            connectionId: 'demo',
            serverId: 'demo',
            getCapabilities: () => ({
              extensions: { 'io.modelcontextprotocol/events': {} },
            }),
            request: async (method) => {
              if (method === 'events/list') {
                listCalls += 1;
                return {
                  events: [
                    {
                      name: 'demo.ready',
                      description: 'A demo item became ready.',
                      delivery: ['poll'],
                      inputSchema: { type: 'object' },
                      payloadSchema: {
                        type: 'object',
                        properties: { value: { type: 'number' } },
                      },
                    },
                  ],
                  nextCursor: null,
                };
              }
              if (method === 'events/poll') {
                return {
                  events: [],
                  cursor: null,
                  hasMore: false,
                  nextPollMs: 60_000,
                };
              }
              throw new Error(`unexpected method ${method}`);
            },
            pollIntervalMs: 60_000,
          },
        ],
        home,
      );

      expect(report.join('\n')).toContain('1 Events-capable');
      expect(listCalls).toBeGreaterThan(0);

      const sources = registered.find((tool) => tool.spec.name === 'event_watch_sources');
      if (!sources) throw new Error('event_watch_sources was not registered');
      const listed = await sources.handler({}, toolContext());
      expect(listed.content).toContain('demo.ready');

      const create = registered.find((tool) => tool.spec.name === 'event_watch_create');
      if (!create) throw new Error('event_watch_create was not registered');
      const created = await create.handler(
        {
          events: [{ event: 'demo.ready', where: [{ path: 'value', op: 'gt', value: 10 }] }],
          instruction: 'Tell me the demo is ready.',
          one_shot: true,
        },
        toolContext({ turnId: 'source-turn' }),
      );
      expect(created.isError).not.toBe(true);
      expect(created.content).toContain('event watch armed');
      expect(
        traced.some(
          (span) =>
            span.name === 'muffin.event_intelligence' &&
            span.attributes['muffin.event_intelligence.event'] === 'ei.trigger.created',
        ),
      ).toBe(true);
    } finally {
      for (const close of closeHooks) await close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('MCP event -> EI match -> Muffin Work E2E', () => {
  it('sleeps on a persisted condition and wakes exactly one canonical Muffin Turn when the event arrives', async () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-ei-e2e-'));
    const queued: TurnInput[] = [];
    const existing = new Set<string>();
    const source = {
      id: 'source-turn',
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
        const id = requiredTurnId(input);
        existing.add(id);
        return id;
      },
    };

    let delivered = false;
    const connection = {
      connectionId: 'demo',
      serverId: 'demo',
      getCapabilities: () => ({
        extensions: { 'io.modelcontextprotocol/events': {} },
      }),
      request: async (method: string, params?: unknown) => {
        if (method === 'events/list') {
          return {
            events: [
              {
                name: 'demo.ready',
                description: 'A demo item became ready.',
                delivery: ['poll'],
                inputSchema: { type: 'object' },
                payloadSchema: {
                  type: 'object',
                  properties: { value: { type: 'number' } },
                },
              },
            ],
            nextCursor: null,
          };
        }
        if (method === 'events/poll') {
          if (!delivered) {
            delivered = true;
            return {
              events: [
                {
                  eventId: 'event-1',
                  name: 'demo.ready',
                  timestamp: '2026-10-02T20:00:00.000Z',
                  data: { value: 42 },
                },
              ],
              cursor: 'done',
              hasMore: false,
              nextPollMs: 60_000,
            };
          }
          return {
            events: [],
            cursor: 'done',
            hasMore: false,
            nextPollMs: 60_000,
          };
        }
        throw new Error(`unexpected method ${method} ${JSON.stringify(params)}`);
      },
      pollIntervalMs: 60_000,
    };

    const embedded = await createMuffinEventIntelligence([connection], home, port);

    try {
      const create = embedded.toolCatalog.get('event_watch_create');
      if (!create) throw new Error('event_watch_create was not registered');
      const armed = await create.execute(
        {
          events: [
            {
              event: 'demo.ready',
              where: [{ path: 'value', op: 'gt', value: 10 }],
            },
          ],
          instruction: 'Inspect the matched demo event.',
          one_shot: true,
        },
        toolContext({ turnId: source.id }),
      );
      expect(armed.ok).toBe(true);
      expect(queued).toEqual([]);

      await embedded.host.runtime.mcpEventsClient.pollAll();
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({
        principal: { kind: 'system', source: 'event-intelligence' },
        tenant: 'host',
        surface: 'telegram',
        replyTo: { chatId: '42' },
        contentTaint: 3,
      });
      expect(queued[0]?.text).toContain('Inspect the matched demo event.');
      expect(queued[0]?.text).toContain('"value": 42');

      await embedded.host.runtime.mcpEventsClient.pollAll();
      expect(queued).toHaveLength(1);
    } finally {
      await embedded.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
