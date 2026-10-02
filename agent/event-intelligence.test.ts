import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { toolContext } from './fixtures/tool-context.js';
import type { LoopDeps, RegisteredTool, TurnInput } from './loop.js';
import {
  attachEventIntelligence,
  deliverEventWake,
  workIdForEventWake,
  type EventWakePort,
} from './event-intelligence.js';

describe('Event Intelligence wake -> Muffin Work', () => {
  it('turns one EI wake into one deterministic, tainted system Turn on the original route', () => {
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
        existing.add(input.id!);
        return input.id!;
      },
    };
    const activation = {
      target: { runtime: 'muffin', kind: 'task', id: source.id },
      continuation: { instruction: 'Inspect the release.' },
      evidence: [{ eventId: 'e1', data: { status: 'green' } }],
    };

    const first = deliverEventWake(port, { wake_id: 'wake-1' }, activation);
    const second = deliverEventWake(port, { wake_id: 'wake-1' }, activation);

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
    expect(queued[0]!.text).toContain('Inspect the release.');
    expect(queued[0]!.text).toContain('matched external event evidence');
  });

  it('fails closed when EI targets work Muffin no longer has', () => {
    const port: EventWakePort = {
      source: () => null,
      has: () => false,
      openSession: (id) => ({ id, file: '/tmp/session' }),
      enqueue: () => {
        throw new Error('must not enqueue');
      },
    };
    expect(() =>
      deliverEventWake(port, { wakeId: 'missing' }, {
        target: { runtime: 'muffin', kind: 'task', id: 'gone' },
      }),
    ).toThrow(/source Work not found/);
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
        [{
          connectionId: 'demo',
          serverId: 'demo',
          getCapabilities: () => ({
            extensions: { 'io.modelcontextprotocol/events': {} },
          }),
          request: async (method) => {
            if (method === 'events/list') {
              listCalls += 1;
              return {
                events: [{
                  name: 'demo.ready',
                  description: 'A demo item became ready.',
                  delivery: ['poll'],
                  inputSchema: { type: 'object' },
                  payloadSchema: {
                    type: 'object',
                    properties: { value: { type: 'number' } },
                  },
                }],
                nextCursor: null,
              };
            }
            if (method === 'events/poll') {
              return { events: [], cursor: null, hasMore: false, nextPollMs: 60_000 };
            }
            throw new Error(`unexpected method ${method}`);
          },
          pollIntervalMs: 60_000,
        }],
        home,
      );

      expect(report.join('\n')).toContain('1 Events-capable');
      expect(listCalls).toBeGreaterThan(0);

      const sources = registered.find((tool) => tool.spec.name === 'event_watch_sources')!;
      const listed = await sources.handler({}, toolContext());
      expect(listed.content).toContain('demo.ready');

      const create = registered.find((tool) => tool.spec.name === 'event_watch_create')!;
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
