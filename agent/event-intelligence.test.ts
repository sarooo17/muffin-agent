import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEventIntelligenceHost, createMcpRegistryAdapter } from 'mcp-event-intelligence/host';
import { describe, expect, it } from 'vitest';
import {
  attachEventIntelligence,
  deliverEventWake,
  type EventWakePort,
  makeEventIntelligenceTools,
  workIdForEventWake,
} from './event-intelligence.js';
import { toolContext } from './fixtures/tool-context.js';
import type { LoopDeps, RegisteredTool, TurnInput } from './loop.js';

function activationFor(
  targetId: string,
  instruction = 'Inspect the release.',
  evidence = [{ eventId: 'e1', data: { status: 'green' } }],
) {
  return {
    activationVersion: '2' as const,
    wake: {
      wakeId: 'wake-1',
      status: 'queued',
      runtimeReceiptId: null,
      matchedAt: '2026-10-04T00:00:00.000Z',
    },
    target: { runtime: 'muffin', kind: 'task', id: targetId },
    trigger: {
      triggerId: 'trigger-1',
      version: '1',
      description: null,
      pattern: {
        version: '2' as const,
        root: { kind: 'event' as const, ref: 'event_1' },
        partitionBy: [],
        selection: {
          overlap: 'disallow' as const,
          afterMatch: 'skipPastLast' as const,
          maxMatchesPerEvent: 10,
        },
        execution: {
          maxCandidates: 512,
          maxSemanticEvaluations: 16,
          maxBufferedEvents: 10000,
        },
      },
      lifecycle: {
        oneShot: true,
        cooldownMs: 0,
        completeOnGoal: false,
      },
    },
    continuation: {
      instruction,
      contextPolicy: {
        evidence: 'matched_events' as const,
        maxEvents: 20,
        includeData: true,
      },
    },
    match: {
      matchId: 'match-1',
      status: 'matched',
      partitionKey: null,
      openedAt: '2026-10-04T00:00:00.000Z',
      updatedAt: '2026-10-04T00:00:00.000Z',
    },
    evidence: evidence.map((item, index) => ({
      clauseId: 'event_1',
      serverId: 'demo',
      eventId: item.eventId,
      eventName: 'demo.ready',
      traceId: `trace-${index + 1}`,
      occurredAt: '2026-10-04T00:00:00.000Z',
      payloadHash: null,
      data: item.data,
    })),
    trust: {
      continuation: 'configured_trigger_instruction' as const,
      evidence: 'untrusted_external_signal' as const,
    },
  };
}

function requiredTurnId(input: TurnInput): string {
  if (!input.id) throw new Error('wake Turn must have a deterministic id');
  return input.id;
}

describe('Event Intelligence wake -> Muffin Work', () => {
  it('turns one EI wake into one deterministic, tainted system Turn on the original route', async () => {
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
      openSession: (id) => ({ id, file: `/tmp/${id}.jsonl` }),
      enqueue: (input) => {
        queued.push(input);
        const id = requiredTurnId(input);
        existing.add(id);
        return id;
      },
    };
    const activation = activationFor(source.id);

    const first = await deliverEventWake(port, { wake_id: 'wake-1' }, activation);
    const second = await deliverEventWake(port, { wake_id: 'wake-1' }, activation);

    expect(first.runtimeReceiptId).toBe(workIdForEventWake('wake-1'));
    expect(second).toEqual({ runtimeReceiptId: first.runtimeReceiptId, duplicate: true });
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      id: first.runtimeReceiptId,
      principal: { kind: 'system', source: 'event-intelligence' },
      tenant: 'host',
      surface: 'telegram',
      contentTaint: 3,
      replyTo: { chatId: '42' },
    });
    expect(queued[0]?.text).toContain('Inspect the release.');
    expect(queued[0]?.text).toContain('matched external event evidence');
  });

  it('fails closed when EI targets work Muffin no longer has', async () => {
    const port: EventWakePort = {
      source: () => null,
      has: () => false,
      openSession: (id) => ({ id, file: '/tmp/session' }),
      enqueue: () => {
        throw new Error('must not enqueue');
      },
    };
    await expect(
      deliverEventWake(
        port,
        { wakeId: 'wake-1' },
        activationFor('gone'),
      ),
    ).rejects.toThrow(/Continuation target unavailable/);
  });
});

describe('embedded EI on Muffin-owned MCP sessions', () => {
  it('discovers an Events-capable MCP without reconnecting and can persist a watch', async () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-ei-'));
    const registered: RegisteredTool[] = [];
    const closeHooks: Array<() => Promise<void>> = [];
    let listCalls = 0;

    const runtime = {
      deps: {
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

    const host = await createEventIntelligenceHost({
      dataDir: join(home, 'ei'),
      mcpRegistry: createMcpRegistryAdapter({
        listConnections: () => [connection],
      }),
      wake: (packet, activation) => deliverEventWake(port, packet, activation),
    });

    try {
      const create = makeEventIntelligenceTools(host).find(
        (tool) => tool.spec.name === 'event_watch_create',
      );
      if (!create) throw new Error('event_watch_create was not registered');
      const armed = await create.handler(
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
      expect(armed.isError).not.toBe(true);
      expect(queued).toEqual([]);

      await host.runtime.mcpEventsClient.pollAll();
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

      await host.runtime.mcpEventsClient.pollAll();
      expect(queued).toHaveLength(1);
    } finally {
      await host.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});