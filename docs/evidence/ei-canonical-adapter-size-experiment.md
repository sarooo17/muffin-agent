# Muffin / EI canonical adapter size experiment

This is a **fork-only**, candidate-gated integration experiment, stacked on
PR #15. No npm version is released and neither Muffin's pinned `0.11.0`
dependency nor its lockfile is modified.

## Reproduction

- Base: upstream Muffin `dev` at `a6e6bfa` (same as fork PR #15).
- Old production adapter `agent/event-intelligence.ts` at that base: **398
  physical lines / 365 nonblank lines**, including host-owned policy, Turn
  delivery, owner mapping, untrusted evidence and tool-output translation.
- The earlier candidate conformance branch (PR #15) had **420 physical lines
  / 386 nonblank lines**. Its integration still used the old facade.
- This PR exercises canonical `createEventIntelligence()` from exact
  EI `bd051604da315b5f0015a01df1767787dcd098b3` inside the
  **real `createMuffinEventIntelligence` adapter function** when
  `EI_CANDIDATE_CONFORMANCE=1`. Normal `0.11.0` uses the original
  `createEmbeddedRuntimeIntegration()` path.
- Compare physical and nonblank lines via `wc -l agent/event-intelligence.ts`
  and `grep -cve '^[[:space:]]*$' agent/event-intelligence.ts` on each branch.
  **Both branches of the adapter are counted**. Removing the 0.11 compatibility
  branch requires a published candidate and a consumer-owned package-pin update.

The current dual-path adapter has **427 physical lines / 395 nonblank lines**. The extra path is necessary while the 0.11.0 dependency remains pinned. Measured source line counts exclude the trailing empty sentinel after the final newline.

The canonical entry point eliminates *generic* lifecycle/registry binding
boilerplate. It does **not** replace the Muffin-specific responsibilities:
policy and approval decisions, Turn continuation and receipts, owner mapping,
untrusted event evidence fencing, and native tool-output translation.
Those functions cannot safely be claimed as EI configuration LOC.

## Evidence and release gates

The existing fork candidate workflow packs an exact-source tarball, installs
it only inside CI, typechecks, and runs eight Muffin EI test files. The new
adapter assertion must negotiate HostContract v1, expose eight tools, and
discover its MCP source. The existing tests cover owner-denied mutations,
replay/receipts, host interrupts, lifecycle, and SIGKILL fixture recovery.

This is **not** independent third-party authoring, production TurnStore
recovery, real provider-network failover, an SLO pass, or a v1 release.
Keep PR in draft until exact-head CI, an independent review, and owner DCO
sign-off. Do not merge based solely on the previous #15 candidate result.

## Defect reproduced in exact-source CI (2026-10-27)

The first candidate job using EI main `729eb901c` completed 3/11 tests
and failed eight tests because the canonical facade silently discarded the
Muffin-owned tool name mapping. This is **not** a test-only renaming issue:
Muffin's existing tool registry and caller-facing command names must remain
stable, so silently publishing the uncorrected facade would be a breaking
behavioral regression.

Upstream candidate [EI PR #268](https://github.com/sarooo17/event-intelligence/pull/268)
adds data-only `runtime.names` pass-through and pre-start validation.
This experiment now pins its exact candidate commit, without claiming the
upstream fix has been merged or published. Only the subsequent run can show
whether the real adapter now conforms.

## Passing follow-up on exact candidate (2026-10-27)

After EI candidate [#268](https://github.com/sarooo17/event-intelligence/pull/268)
restored `runtime.names`, the fork's first retry showed that the
*generic conformance fixtures* must deliberately request default canonical
tool names, while the *production Muffin factory* must retain native
`event_watch_*` names. The follow-up [run 40499080956](https://github.com/sarooo17/muffin-agent/actions/runs/40499080956)
on fork commit `fd552683368c677298d325d5db40a2e802dc318b`
completed **8/8 test files and 11/11 tests**, including the real adapter
factory. The candidate is still unpublished and the PR remains unmerged.
