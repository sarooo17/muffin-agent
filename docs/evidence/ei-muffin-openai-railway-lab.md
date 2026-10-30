# EI × Muffin × OpenAI API — private one-shot Railway lab

**Status:** candidate validation only, not a production/independent-host certificate
and not the real full Muffin multi-turn LLM runtime. This harness uses
Muffin's **actual** `createMuffinEventIntelligence` adapter and tool
catalog, but invokes the OpenAI SDK as a *test driver* (not the Muffin
agent's live scheduling/agent loop). The MCP source emits one synthetic
`demo.ready` event; there is no independent external source finality.

## Chain that is actually exercised

1. Real OpenAI Chat Completions **forced tool call**, limited to
   `event_watch_create`, emits two constrained arguments; the host
   validates exact values and supplies a fixed, synthetic event pattern.
2. The resulting arguments are passed to the real Muffin EI portable
   `event_watch_create` integration with an owner ToolContext. The
   Muffin host owns actor/owner approval, receipt namespace and target.
3. Muffin's real embedded EI polls an in-process synthetic MCP Events
   source, correlates `value=42` and calls the Muffin
   `EventWakePort.enqueue()`. The test persists a uniquely keyed
   host receipt on a mounted state volume and confirms **system** principal
   plus **external** taint 3; it does *not* prove distributed atomicity.
4. A second actual OpenAI completion acknowledges the synthetic result.
   Prompt/response, raw response IDs, receipts and API credentials do not
   appear in exported logs. Only token counts, booleans and run ID do.
5. Two total OpenAI calls maximum, `gpt-4o-mini`, 96 + 64
   requested max completion tokens, per-call 15-second timeout,
   OpenAI SDK `maxRetries:0`, tools disabled in the second call.
   Host-side caps do not equal a provider invoice/spend stop.
   A timeout can still be billable.

This harness does NOT validate the real Muffin agent scheduling loop
or independently maintained consumer adoption (#317), external MCP
complete-through guarantees (#48), or settled provider invoice (#49).
These require separate proof.

## Operator deployment — strict requirements

The current Railway `ei-validation/staging` **has an uncommitted
environment patch** that adds `OPENAI_API_KEY` to the shared variables
AND all five existing services, including the **Postgres** service.
**DO NOT APPLY THAT PATCH.** Scope the key to a *single new runner*
service, and remove it from Postgres, both workers, `ei-benchmark`,
`ei-slo-staging-runner` and environment-level shared variables.
There is no reason for those services to possess an LLM key.

Build the experimental Muffin branch under this review; mount a
**private persistent volume** at `/data` on the new **staging-only** service.
The service has NO public HTTP domain and no background scheduler:
run exactly once via its start command, then expect it to exit.
Recommended start command:
`npm run e2e:ei:openai`, after normal `npm ci` and `npm run build`.
The code dynamically imports compiled `dist/agent/event-intelligence.js`
only *after* validating the operator flag and mounted state dir.

Set on the runner **only**, through Railway's secret UI:

| Variable | Value |
| --- | --- |
| `OPENAI_API_KEY` | Restricted API project key, **never logged/shared** |
| `EI_CONFIRM_MUFFIN_OPENAI_LIVE` | `YES` |
| `EI_MUFFIN_RUN_VOLUME_CONFIRMED` | `YES` after checking the volume |
| `EI_MUFFIN_RUN_ID` | Unique non-secret 8–96 char ID (do not change for retries) |
| `EI_MUFFIN_RUN_STATE_DIR` | `/data` |
| `NODE_ENV` | `production` |

`intent-{runId}.reserved.json` is created exclusively and fsynced
**before** the first possibly billable call. A crash, provider timeout
or failed tool execution leaves it reserved. Never auto-retry with a new
ID; review the provider account's actual charges first. The
`wake-{runId}.json` receipt is fsynced before acknowledging a host
delivery. The volume's persistence is a user/operator claim; it is
not safe to use this as a horizontally scaled receipt backend.

The original `mcp-event-intelligence@0.12.0-next.0` dependency was
published before the recent #369/#370 strict-receipt source changes:
do **not** advertise this test as proving those new unshipped changes.
The fork PR #18 remains unmerged, blocked by DCO/install workflows
and independent review. This lab branch is stacked on it; no automatic
Muffin or EI production merge occurs.

Run offline checks first:
`npm run build && npm run test:e2e:ei:openai`.
This command **never invokes OpenAI**. Live command has its own
separate opt-in, durable state and no automatic billing retry.
