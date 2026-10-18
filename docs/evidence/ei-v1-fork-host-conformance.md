# Muffin fork / Event Intelligence v1 host conformance

## Provenance and source boundaries

- **Host:** real `muffin-project/muffin-agent` `dev` code at `a6e6bfaec5d6847b1985980fe6f524ef0193dc02`, copied by a GitHub branch pointer in the `sarooo17/muffin-agent` fork.
- **Candidate EI:** `sarooo17/event-intelligence` commit `6ff40250afc67c259e8b784a7eb9ec03d9184fa9`.
- **Package installation:** CI uses `npm pack` in a clean candidate checkout and overlays that tarball in the fork CI **only**. Muffin manifest and lockfile remain pinned to public `mcp-event-intelligence@0.11.0`; neither public npm nor Muffin upstream is changed.
- **Host authorship:** Muffin runtime and production integration were originally written in the Muffin project, but the additions and CI harness here were authored by the EI project maintainer. **Independent third-party adapter authorship is NOT certified**. The host was not deployed and no external MCP credential/network service was exercised.
- **No claim** of live MCP transport reconnect, real multi-worker failover or exactly-once external work effects.

## Concrete contract under test

The fork test extracts existing Muffin `activationDelivery()` and `portableTooling()` through a small `createMuffinEventIntelligenceHostCallbacks()` factory. Both the existing shipped embedded adapter and the new opt-in candidate facade use **the same code for Muffin owner identity, policy denial, Turn enqueue and receipt lookup**, without granting EI permission to bypass Muffin.

With the candidate gate enabled, the existing Muffin fixture now runs the **entire public EI v3 management contract through the new canonical `createEventIntelligence()` facade and negotiated HostContract v1**, using the production Muffin callback factory. With the gate disabled it continues testing the existing pinned 0.11.0 integration. The seven canonical v3 scenarios prove: trigger create/list/pause/resume/update/delete, match/no-match, replay, a true EI storage close/reopen and authoritative `getWakeDelivery(wakeId)` after restart. This is a local-process restart, **not** SIGKILL or full OS-process recovery. It additionally asserts a machine-readable `event-intelligence.host-conformance.v3` report with exactly seven passing scenarios.

An additional candidate-only test independently probes `createEventIntelligence()` on the actual Muffin host callback factory, requiring `mcp.registry`, `storage.durable`, `wake.receipts`, `tooling.owner-scoped`. It asserts invalid missing receipts fail before startup, immutable negotiation, denied system-authority creation without persisted state mutation, approved owner creation, host-managed registry detach/reattach, host-owned system Turn wake, and no duplicate Turn on replay after storage reopen.

## Running / recording the evidence

The fork PR job `EI v1 candidate host conformance / muffin-candidate-host` installs the candidate and runs the TypeScript compiler plus the seven focused Muffin EI test files. It writes and uploads `ei-host-conformance-report.json` when the v3 host test completes.

Integration LOC accounting must be computed from the actual final Git diff, separately counting the ~15-line reusable host callback factory, the test fixture and the CI workflow. This is not a claim that a full independent host integration fits 30 LOC. The actual Muffin adapter logic remains significantly larger because Muffin owns Turn/policy/tool translation.

## Actual CI result, 2026-10-18

The complete candidate/host run [#39134522074](https://github.com/sarooo17/muffin-agent/actions/runs/39134522074) passed on exact commit `eff3a0db8ad2674394af18ccb6ca4816eba5deee`: compiler green, **7/7 Muffin EI test files and 10/10 tests**, including **all 7/7 v3 conformance scenarios through the canonical v1 facade**. The JSON report is retained in the Actions artifact. The integration fixture was changed to observe the actual EI wakeId separately from Muffin's deterministic Turn receipt ID, so durable delivery is checked against the correct key.

The inherited general `verifica` workflow includes a legal DCO check that remains red for the coding-tool-created, unsigned commits. The owner must certify/sign the commits personally before this PR can merge. This DCO state is distinct from the successful targeted EI contract test, and must not be bypassed by attributing a sign-off to the owner without their own attestation.

## Unproven requirements blocking issue #42

1. Independent author review and independently authored host conformance adapter (the fork itself does not establish that).
2. Full lifecycle coverage across the canonical facade: host policy interrupts and approvals for **every** mutating operation, real MCP registry transport detach/reattach, and actual process restart/replay under the v1 facade.
3. Final canonical API/export clean-up, stable error-matrix audit and breaking-change notes with evidence in the EI repository. These must be verified before checking the aggregate acceptance criteria.

Keep #42 **OPEN** until the above are verified; do not treat one green local CI result as external adoption certification.
