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

      expect(registered.map((tool) => tool.spec.name)).toEqual(
        expect.arrayContaining([
          'event_watch_sources',
          'event_watch_create',
          'event_watch_list',
          'event_watch_inspect',
          'event_watch_pause',
          'event_watch_resume',
          'event_watch_delete',
          'event_watch_update',
        ]),
      );

      const create = registered.find((tool) => tool.spec.name === 'event_watch_create');
      if (!create) throw new Error('event_watch_create was not registered');
      const created = await create.handler(
        {
          trigger_id: 'demo-watch',
          events: [{ event: 'demo.ready', where: [{ path: 'value', op: 'gt', value: 10 }] }],
          instruction: 'Tell me the demo is ready.',
          one_shot: true,
        },
        toolContext({ turnId: 'source-turn' }),
      );
      expect(created.isError).not.toBe(true);
      expect(created.content).toContain('event watch create: demo-watch');

      const list = registered.find((tool) => tool.spec.name === 'event_watch_list');
      if (!list) throw new Error('event_watch_list was not registered');
      const listedWatches = await list.handler(
        { status: 'active' },
        toolContext({ turnId: 'list-turn' }),
      );
      expect(listedWatches.isError).not.toBe(true);
      expect(listedWatches.content).toContain('"triggerId": "demo-watch"');

      const pause = registered.find((tool) => tool.spec.name === 'event_watch_pause');
      if (!pause) throw new Error('event_watch_pause was not registered');
      const paused = await pause.handler(
        { trigger_id: 'demo-watch' },
        toolContext({ turnId: 'pause-turn' }),
      );
      expect(paused.isError).not.toBe(true);
      expect(paused.content).toContain('event watch pause: demo-watch');

      const resume = registered.find((tool) => tool.spec.name === 'event_watch_resume');
      if (!resume) throw new Error('event_watch_resume was not registered');
      const resumed = await resume.handler(
        { trigger_id: 'demo-watch' },
        toolContext({ turnId: 'resume-turn' }),
      );
      expect(resumed.isError).not.toBe(true);
      expect(resumed.content).toContain('event watch resume: demo-watch');

      const remove = registered.find((tool) => tool.spec.name === 'event_watch_delete');
      if (!remove) throw new Error('event_watch_delete was not registered');
      const deleted = await remove.handler(
        { trigger_id: 'demo-watch' },
        toolContext({ turnId: 'delete-turn' }),
      );
      expect(deleted.isError).not.toBe(true);
      expect(deleted.content).toContain('event watch delete: demo-watch');

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
      principal: { kind: 'owner', connector: 'cli', externalId: 'local' } as const,
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
          trigger_id: 'wake-readable-watch',
          events: [
            {
              event: 'demo.ready',
              where: [{ path: 'value', op: 'gt', value: 10 }],
            },
          ],
          instruction: 'Inspect the matched demo event.',
          // Keep it active after the wake so the assertion below reaches
          // Muffin's authority boundary instead of the one-shot lifecycle
          // filter returning TRIGGER_NOT_FOUND first.
          one_shot: false,
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

      const wakeTurnId = requiredTurnId(queued[0]!);
      const wakeContext = toolContext({
        turnId: wakeTurnId,
        principal: { kind: 'system', source: 'event-intelligence' },
      });
      const list = embedded.toolCatalog.get('event_watch_list');
      const inspect = embedded.toolCatalog.get('event_watch_inspect');
      const pause = embedded.toolCatalog.get('event_watch_pause');
      if (!list || !inspect || !pause) throw new Error('EI lifecycle tools were not registered');

      const wakeList = await list.execute(
        { trigger_id: 'wake-readable-watch', limit: 10 },
        wakeContext,
      );
      expect(wakeList.ok).toBe(true);
      expect(wakeList.data?.triggers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ triggerId: 'wake-readable-watch' }),
        ]),
      );

      const wakeInspect = await inspect.execute(
        { trigger_id: 'wake-readable-watch', version: '1' },
        wakeContext,
      );
      expect(wakeInspect.ok).toBe(true);
      expect(wakeInspect.data?.trigger).toMatchObject({
        triggerId: 'wake-readable-watch',
        version: '1',
      });

      // The read scope inherited from the wake never becomes owner authority.
      const deniedMutation = await pause.execute(
        { trigger_id: 'wake-readable-watch', version: '1' },
        wakeContext,
      );
      expect(deniedMutation.ok).toBe(false);
      expect(deniedMutation.error?.code).toBe('EVENT_WATCH_OWNER_REQUIRED');

      await embedded.host.runtime.mcpEventsClient.pollAll();
      expect(queued).toHaveLength(1);
    } finally {
      await embedded.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
