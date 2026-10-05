import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHostConformance } from 'mcp-event-intelligence/conformance';
import { describe, expect, it } from 'vitest';
import { createMuffinEventIntelligence, type EventWakePort } from './event-intelligence.js';
import { toolContext } from './fixtures/tool-context.js';
import type { TurnInput } from './loop.js';

function requiredTurnId(input: TurnInput): string {
  if (!input.id) throw new Error('conformance wake requires a deterministic turn id');
  return input.id;
}

describe('Muffin Event Intelligence host conformance', () => {
  it('passes the public EI v0.9 host contract', async () => {
    const adapter = {
      name: 'muffin-agent',

      async createHarness({ observability }: { observability: (event: unknown) => void }) {
        const home = mkdtempSync(join(tmpdir(), 'muffin-ei-conformance-'));
        const deliveries: Array<{
          triggerId: string;
          wakeId: string;
          runtimeReceiptId: string;
        }> = [];
        const persistedReceipts = new Set<string>();
        let embedded: Awaited<ReturnType<typeof createMuffinEventIntelligence>> | null = null;
        let eventClock = Date.parse('2026-10-05T06:00:00.000Z');

        const connection = {
          connectionId: 'conformance',
          serverId: 'conformance',
          getCapabilities: () => ({
            extensions: { 'io.modelcontextprotocol/events': {} },
          }),
          request: async (method: string) => {
            if (method === 'events/list') {
              return {
                events: [
                  {
                    name: 'conformance.value.changed',
                    description: 'Synthetic value change used only by host conformance.',
                    delivery: ['poll'],
                    inputSchema: { type: 'object' },
                    payloadSchema: {
                      type: 'object',
                      additionalProperties: false,
                      required: ['value'],
                      properties: {
                        value: { type: 'number' },
                        secretProbe: { type: 'string' },
                      },
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
            throw new Error(`unexpected conformance MCP method ${method}`);
          },
          pollIntervalMs: 60_000,
        };

        const port: EventWakePort = {
          source: (turnId) => ({
            id: turnId,
            tenant: 'host',
            surface: 'cli',
            sessionId: `conformance:${turnId}`,
            replyTo: { conformanceTriggerId: turnId },
          }),
          has: (receiptId) => persistedReceipts.has(receiptId),
          openSession: (sessionId) => ({
            id: sessionId,
            file: join(home, `${sessionId.replaceAll(':', '_')}.jsonl`),
          }),
          enqueue: (input) => {
            const runtimeReceiptId = requiredTurnId(input);
            persistedReceipts.add(runtimeReceiptId);
            const replyTo = input.replyTo;
            if (
              !replyTo ||
              typeof replyTo !== 'object' ||
              !('conformanceTriggerId' in replyTo) ||
              typeof replyTo.conformanceTriggerId !== 'string'
            ) {
              throw new Error('conformance delivery lost its Muffin source turn');
            }
            deliveries.push({
              triggerId: replyTo.conformanceTriggerId,
              wakeId: runtimeReceiptId,
              runtimeReceiptId,
            });
            return runtimeReceiptId;
          },
        };

        const start = async () => {
          embedded = await createMuffinEventIntelligence([connection], home, port, observability);
        };

        await start();

        return {
          async createTrigger({
            triggerId,
            threshold,
            oneShot,
            maxFirings,
          }: {
            triggerId: string;
            threshold: number;
            oneShot: boolean;
            maxFirings?: number;
          }) {
            const create = embedded?.toolCatalog.get('event_watch_create');
            if (!create) throw new Error('event_watch_create unavailable');

            const result = await create.execute(
              {
                trigger_id: triggerId,
                events: [
                  {
                    event: 'conformance.value.changed',
                    serverId: 'conformance',
                    where: [{ path: 'value', op: 'gt', value: threshold }],
                  },
                ],
                instruction: 'Continue the isolated EI host conformance scenario.',
                one_shot: oneShot,
                ...(maxFirings === undefined ? {} : { max_firings: maxFirings }),
              },
              toolContext({
                turnId: triggerId,
                sessionId: `conformance:${triggerId}`,
              }),
            );
            if (!result.ok) {
              throw new Error(result.error?.message ?? 'conformance trigger creation failed');
            }
          },

          async emitEvent({
            eventId,
            value,
            secretProbe,
          }: {
            eventId: string;
            value: number;
            secretProbe?: string;
          }) {
            eventClock += 1_000;
            await embedded?.host.runtime.compositeEventConsumer.ingestCorrelatable({
              traceId: `muffin-conformance:${eventId}`,
              sourceEventId: eventId,
              name: 'conformance.value.changed',
              serverId: 'conformance',
              provider: 'conformance',
              occurredAt: new Date(eventClock).toISOString(),
              data: {
                value,
                ...(secretProbe ? { secretProbe } : {}),
              },
            });
          },

          deliveries() {
            return [...deliveries];
          },

          async restart() {
            await embedded?.close();
            embedded = null;
            await start();
          },

          async inspectTrigger(triggerId: string) {
            const rows = await embedded?.host.triggerControl.listTriggers();
            const entry = rows?.find(
              (candidate: { definition: { triggerId: string } }) =>
                candidate.definition.triggerId === triggerId,
            );
            return entry?.state ?? null;
          },

          async close() {
            await embedded?.close();
            embedded = null;
            rmSync(home, { recursive: true, force: true });
          },
        };
      },
    };

    const report = await runHostConformance(adapter);
    expect(report.passed, JSON.stringify(report, null, 2)).toBe(true);
    expect(report.adapter).toBe('muffin-agent');
    expect(report.summary.failed).toBe(0);
    expect(report.observability.eventNames).toContain('ei.trigger.created');
    expect(report.observability.eventNames).toContain('ei.match.matched');
    expect(report.observability.eventNames).toContain('ei.wake.delivered');
  });
});
