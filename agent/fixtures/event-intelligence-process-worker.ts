import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMuffinEventIntelligenceHostCallbacks, type EventWakePort } from '../event-intelligence.js';
import { toolContext } from './tool-context.js';
import type { TurnInput } from '../loop.js';

const [mode, home] = process.argv.slice(2);
if (!home || (mode !== 'first' && mode !== 'reopen')) throw new Error('usage: first|reopen <home>');
const receiptPath = join(home!, 'host-turn-receipts.json');
const checkedHostReceiptIds: string[] = [];
type TurnReceipt = { receiptId: string; wakeId: string; triggerId: string };
const loadReceipts = (): TurnReceipt[] =>
  existsSync(receiptPath) ? JSON.parse(readFileSync(receiptPath, 'utf8')) as TurnReceipt[] : [];
const sourceTurn = {
  id: 'host-source-turn',
  tenant: 'host',
  surface: 'cli' as const,
  sessionId: 'owner',
  replyTo: { channel: 'cli' },
  principal: { kind: 'owner', connector: 'cli', externalId: 'local' } as const,
};
const port: EventWakePort = {
  source: id => id === sourceTurn.id ? sourceTurn : null,
  has: id => {
    checkedHostReceiptIds.push(id);
    return loadReceipts().some(row => row.receiptId === id);
  },
  openSession: id => ({ id, file: join(home!, id + '.jsonl') }),
  enqueue: (input: TurnInput, wake) => {
    const receiptId = input.id;
    if (!receiptId || !wake?.wakeId || !wake.triggerId) {
      throw new Error('Muffin Turn receipt and EI wake IDs must remain distinct');
    }
    assert.notEqual(wake.wakeId, receiptId,
      'EI wakeId and Muffin deterministic Turn receipt must be distinct');
    const existing = loadReceipts();
    if (!existing.some(row => row.receiptId === receiptId)) {
      existing.push({ receiptId, wakeId: wake.wakeId, triggerId: wake.triggerId });
      // The fixture persists the host-side receipt before acknowledging the
      // wake; the process is killed abruptly after the EI delivery commits.
      writeFileSync(receiptPath, JSON.stringify(existing, null, 2) + '\n');
    }
    return receiptId;
  },
};
const connection = {
  connectionId: 'process-source',
  serverId: 'process-source',
  getCapabilities: () => ({ extensions: { 'io.modelcontextprotocol/events': {} } }),
  request: async (method: string) => {
    if (method === 'events/list') return {
      events: [{
        name: 'muffin.process.changed',
        delivery: ['poll'],
        description: 'Host process fixture',
        inputSchema: { type: 'object' },
        payloadSchema: {
          type: 'object',
          required: ['value'],
          properties: { value: { type: 'number' } },
        },
      }],
      nextCursor: null,
    };
    if (method === 'events/poll') {
      return { events: [], cursor: null, hasMore: false, nextPollMs: 60_000 };
    }
    throw new Error('unexpected process MCP method: ' + method);
  },
  pollIntervalMs: 60_000,
};

const candidate = await import('mcp-event-intelligence/embedded') as unknown as {
  createEventIntelligence: (input: Record<string, unknown>) => Promise<any>;
};
const boundary = createMuffinEventIntelligenceHostCallbacks(port);
const host = await candidate.createEventIntelligence({
  dataDir: join(home!, 'event-intelligence'),
  env: {
    TYPESAFE_API_KEY: '', RUNTIME_WAKE_TARGETS_JSON: '{}',
    TEMPORAL_TICK_MS: '100000', WAKE_RETRY_TICK_MS: '100000',
  },
  mcp: { list: () => [connection] },
  runtime: boundary.runtime,
  hostContract: {
    version: '1',
    required: [
      'mcp.registry', 'storage.durable', 'wake.receipts', 'tooling.owner-scoped',
    ],
  },
});
assert.equal(host.hostContract.schema, 'event-intelligence.host-contract.v1');
const emit = (id: string, value: number) =>
  host.host.runtime.compositeEventConsumer.ingestCorrelatable({
    traceId: 'host-process:' + id,
    sourceEventId: id,
    name: 'muffin.process.changed',
    serverId: 'process-source',
    provider: 'muffin-process-fixture',
    occurredAt: new Date(Date.now() - 1000).toISOString(),
    data: { value },
  });

if (mode === 'first') {
  const tool = host.toolCatalog.get('trigger_create');
  assert.ok(tool);
  const result = await tool.execute({
    trigger_id: 'process-watch',
    events: [{
      event: 'muffin.process.changed',
      serverId: 'process-source',
      where: [{ path: 'value', op: 'gt', value: 1000 }],
    }],
    instruction: 'Resume a Muffin Turn after the external event.',
    one_shot: false,
    max_firings: 3,
  }, toolContext({ turnId: sourceTurn.id }));
  assert.equal(result.ok, true, JSON.stringify(result.error));
  await emit('replay-me-after-sigkill', 1001);
  const first = loadReceipts();
  assert.equal(first.length, 1, 'initial event did not enqueue exactly one host Turn');
  const wake = await host.host.store.getWakeDelivery(first[0]!.wakeId);
  assert.equal(wake?.status, 'delivered');
  assert.equal(wake?.runtimeReceiptId, first[0]!.receiptId);
  assert.notEqual(first[0]!.wakeId, first[0]!.receiptId);
  // Parent sends SIGKILL only AFTER observing this line, leaving no chance
  // for graceful host close or in-memory EI state to be reused.
  process.stdout.write('READY ' + JSON.stringify({ wakeId: first[0]!.wakeId, receiptId: first[0]!.receiptId }) + '\n');
  setInterval(() => {}, 1000);
} else {
  const first = loadReceipts();
  assert.equal(first.length, 1, 'reopen lost host-owned persisted Turn receipt');
  const persisted = await host.host.store.getWakeDelivery(first[0]!.wakeId);
  assert.equal(persisted?.status, 'delivered', 'EI receipt was not persisted across SIGKILL');
  assert.equal(persisted?.runtimeReceiptId, first[0]!.receiptId);
  assert.notEqual(first[0]!.wakeId, first[0]!.receiptId);
  // Explicitly call the actual reopened Muffin port's persisted receipt
  // lookup. Source-event dedup may otherwise short-circuit before EI invokes
  // hasReceipt() for a previously delivered event.
  assert.equal(port.has(first[0]!.receiptId), true,
    'new PID could not read the host Turn receipt persisted by prior PID');
  assert.ok(checkedHostReceiptIds.includes(first[0]!.receiptId));
  const trigger = (await host.host.store.listTriggers())
    .find((entry: { triggerId?: string }) => entry.triggerId === 'process-watch');
  assert.ok(trigger, 'reopened EI durable trigger missing');
  await emit('replay-me-after-sigkill', 1001);
  assert.equal(loadReceipts().length, 1, 'identical event redelivered across PID restart');
  await emit('fresh-after-sigkill', 1002);
  const after = loadReceipts();
  assert.equal(after.length, 2, 'fresh event after PID restart failed to queue exactly once');
  assert.notEqual(after[1]!.wakeId, first[0]!.wakeId);
  assert.notEqual(after[1]!.receiptId, first[0]!.receiptId);
  process.stdout.write('RESULT ' + JSON.stringify({
    schema: 'muffin.ei-host.process-restart.v1',
    passed: true,
    firstWakeId: first[0]!.wakeId,
    firstReceiptId: first[0]!.receiptId,
    deduplicatedAfterSigkill: true,
    hostReceiptReopenLookupVerified: true,
    postCrashPendingWakeRetryVerified: false,
    freshAfterSigkill: true,
    hostReceiptPersistence: 'fixture-json-file',
    eiPersistence: 'EI-store-jsonl',
    runtime: 'Muffin-owned callback boundary',
    actualNetworkMcp: false,
  }) + '\n');
  await host.close();
}
