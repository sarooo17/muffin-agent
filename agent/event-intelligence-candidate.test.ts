import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMuffinEventIntelligenceHostCallbacks, type EventWakePort } from './event-intelligence.js';
import { toolContext } from './fixtures/tool-context.js';
import type { TurnInput } from './loop.js';

/**
 * Candidate-only test: upstream Muffin remains pinned to EI 0.11.0.
 * The isolated fork workflow installs the exact EI candidate tarball without
 * publishing it or changing Muffin's package.json / lockfile.
 */
describe.skipIf(process.env.EI_CANDIDATE_CONFORMANCE !== '1')(
  'Muffin-owned callbacks against canonical EI HostContract v1', () => {
    it('negotiates, fails closed, enforces owner denial, reconnects sources and survives reopen', async () => {
      // Cast the dynamic optional export: stock Muffin CI compiles against
      // pinned EI 0.11.0, whereas the isolated candidate job verifies v1.
      const api = await import('mcp-event-intelligence/embedded') as unknown as {
        createEventIntelligence?: (input: Record<string, unknown>) => Promise<any>;
      };
      expect(typeof api.createEventIntelligence).toBe('function');
      const create = api.createEventIntelligence!;

      let unexpectedStarts = 0;
      await expect(create({
        hostContract: { version: '1', required: ['wake.receipts'] },
        runtime: { deliver: () => ({ runtimeReceiptId: 'unreachable' }) },
        createHost: async () => { unexpectedStarts++; throw new Error('started on invalid contract'); },
      })).rejects.toMatchObject({ code: 'EI_HOST_CAPABILITY_UNAVAILABLE' });
      expect(unexpectedStarts).toBe(0);

      const home = mkdtempSync(join(tmpdir(), 'muffin-ei-v1-candidate-'));
      const receipts = new Set<string>();
      const queued: TurnInput[] = [];
      const sourceTurn = {
        id: 'source-turn',
        tenant: 'host',
        surface: 'cli' as const,
        sessionId: 'owner-session',
        replyTo: { channel: 'cli' },
        principal: { kind: 'owner', connector: 'cli', externalId: 'local' } as const,
      };
      const port: EventWakePort = {
        source: id => id === sourceTurn.id ? sourceTurn : null,
        has: id => receipts.has(id),
        openSession: id => ({ id, file: join(home, id + '.jsonl') }),
        enqueue: input => {
          if (!input.id) throw new Error('missing deterministic Muffin Turn receipt');
          receipts.add(input.id);
          queued.push(input);
          return input.id;
        },
      };

      const connection = {
        connectionId: 'v1-registry',
        serverId: 'v1-registry',
        getCapabilities: () => ({ extensions: { 'io.modelcontextprotocol/events': {} } }),
        request: async (method: string) => {
          if (method === 'events/list') return {
            events: [{
              name: 'muffin.value.changed',
              delivery: ['poll'],
              description: 'Test event from host-owned MCP connection',
              inputSchema: { type: 'object' },
              payloadSchema: {
                type: 'object', required: ['value'],
                properties: { value: { type: 'number' } },
              },
            }],
            nextCursor: null,
          };
          if (method === 'events/poll') return {
            events: [], cursor: null, hasMore: false, nextPollMs: 60_000,
          };
          throw new Error('unexpected host MCP method: ' + method);
        },
        pollIntervalMs: 60_000,
      };

      let connected = [connection];
      let registryChanged: (() => void) | null = null;
      let unsubscribeCount = 0;
      const boot = async () => {
        // Fresh Muffin owner binding for every boot: no trusted owner authority
        // is smuggled across restart from an in-memory map.
        const boundary = createMuffinEventIntelligenceHostCallbacks(port);
        return create({
          dataDir: join(home, 'event-intelligence'),
          env: {
            TYPESAFE_API_KEY: '', RUNTIME_WAKE_TARGETS_JSON: '{}',
            TEMPORAL_TICK_MS: '100000', WAKE_RETRY_TICK_MS: '100000',
          },
          mcp: {
            list: () => connected,
            subscribe: (listener: () => void) => {
              registryChanged = listener;
              return () => { registryChanged = null; unsubscribeCount++; };
            },
          },
          runtime: boundary.runtime,
          hostContract: {
            version: '1',
            required: [
              'mcp.registry', 'storage.durable',
              'wake.receipts', 'tooling.owner-scoped',
            ],
          },
        });
      };

      let integration: any;
      try {
        integration = await boot();
        expect(integration.hostContract).toMatchObject({
          schema: 'event-intelligence.host-contract.v1',
          version: '1',
          readiness: 'configuration-validated',
        });
        expect(integration.hostContract.required).toHaveLength(4);
        expect(Object.isFrozen(integration.hostContract)).toBe(true);
        expect(integration.toolCatalog.all).toHaveLength(8);
        expect((await integration.diagnostics()).connections).toBe(1);

        // Owner authorization comes from Muffin's real production callbacks,
        // not from an EI-supplied allow-all mock.
        const createTool = integration.toolCatalog.get('trigger_create');
        expect(createTool).toBeTruthy();
        const trigger = {
          trigger_id: 'muffin-v1-watch',
          events: [{
            event: 'muffin.value.changed',
            serverId: 'v1-registry',
            where: [{ path: 'value', op: 'gt', value: 1000 }],
          }],
          instruction: 'Continue through Muffin after a matched event.',
          one_shot: false,
        };
        const denied = await createTool.execute(
          trigger,
          toolContext({ turnId: sourceTurn.id, principal: { kind: 'system', source: 'automation' } }),
        );
        expect(denied.ok).toBe(false);
        expect(await integration.host.store.listTriggers()).toHaveLength(0);

        const allowed = await createTool.execute(
          trigger,
          toolContext({ turnId: sourceTurn.id }),
        );
        expect(allowed.ok, JSON.stringify(allowed.error)).toBe(true);

        // The subscription callback MUST perform reconciliation by itself.
        // Calling refreshMcpRegistry() or diagnostics() here would conceal a
        // broken notification listener. Observe the actual registered MCP
        // connection map, first detached, then reattached.
        const awaitRegistryCount = async (count: number) => {
          for (let attempt = 0; attempt < 100; attempt++) {
            const actual = (await integration.host.mcpStatus()).length;
            if (actual === count) return;
            await new Promise(resolve => setTimeout(resolve, 20));
          }
          expect((await integration.host.mcpStatus()).length).toBe(count);
        };
        expect(typeof registryChanged).toBe('function');
        connected = [];
        (registryChanged as (() => void) | null)?.();
        await awaitRegistryCount(0);
        connected = [connection];
        (registryChanged as (() => void) | null)?.();
        await awaitRegistryCount(1);

        const event = {
          traceId: 'muffin-v1-event',
          sourceEventId: 'muffin-v1-event',
          name: 'muffin.value.changed',
          serverId: 'v1-registry',
          provider: 'muffin-candidate',
          occurredAt: new Date().toISOString(),
          data: { value: 1001 },
        };
        await integration.host.runtime.compositeEventConsumer.ingestCorrelatable(event);
        expect(queued).toHaveLength(1);
        expect(queued[0]?.principal).toMatchObject({ kind: 'system', source: 'automation' });
        expect(queued[0]?.contentTaint).toBe(3);
        expect(queued[0]?.id).toBeTruthy();

        await integration.close();
        integration = await boot();
        expect(integration.hostContract.readiness).toBe('configuration-validated');
        expect((await integration.host.store.listTriggers()).length).toBeGreaterThan(0);
        await integration.host.runtime.compositeEventConsumer.ingestCorrelatable(event);
        expect(queued).toHaveLength(1); // replay cannot create another Muffin Turn
      } finally {
        if (integration) await integration.close();
        rmSync(home, { recursive: true, force: true });
      }
      expect(unsubscribeCount).toBe(2);
    });
  },
);
