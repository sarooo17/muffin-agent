# Muffin fork / Event Intelligence v1 host conformance

## Provenance and source boundaries

- **Host:** real `muffin-project/muffin-agent` `dev` code at `a6e6bfaec5d6847b1985980fe6f524ef0193dc02`, copied by a GitHub branch pointer in the `sarooo17/muffin-agent` fork.
- **Candidate EI:** `sarooo17/event-intelligence` commit `6ff40250afc67c259e8b784a7eb9ec03d9184fa9`.
- **Package installation:** CI uses `npm pack` in a clean candidate checkout and overlays that tarball in the fork CI **only**. Muffin manifest and lockfile remain pinned to public `mcp-event-intelligence@0.11.0`; neither public npm nor Muffin upstream is changed.
- **Host authorship:** Muffin runtime and production integration were originally written in the Muffin project, but the additions and CI harness here were authored by the EI project maintainer. **Independent third-party adapter authorship is NOT certified**. The host was not deployed and no external MCP credential/network service was exercised.
- **No claim** of live MCP transport reconnect, real multi-worker failover or exactly-once external work effects.

## Concrete contract under test

The fork test extracts existing Muffin `activationDelivery()` and `portableTooling()` through a small `createMuffinEventIntelligenceHostCallbacks()` factory. Both the existing shipped embedded adapter and the new opt-in candidate facade use **the same code for Muffin owner identity, policy denial, Turn enqueue and receipt lookup**, without granting EI permission to bypass Muffin.

The retained upstream Muffin conformance fixture executes the public EI **v3** management contract: trigger create/list/pause/resume/update/delete, match/no-match, replay, a true EI storage close/reopen and authoritative `getWakeDelivery(wakeId)` after restart. This is a local-process restart, **not** SIGKILL or full OS-process recovery. It additionally asserts a machine-readable `event-intelligence.host-conformance.v3` report with exactly seven passing scenarios.

A separate candidate-only test runs `createEventIntelligence()` on the actual Muffin host callback factory, requiring `mcp.registry`, `storage.durable`, `wake.receipts`, `tooling.owner-scoped`. It asserts invalid missing receipts fail before startup, immutable negotiation, denied system-authority creation without persisted state mutation, approved owner creation, host-managed registry detach/reattach, host-owned system Turn wake, and no duplicate Turn on replay after storage reopen.

## Running / recording the evidence

The fork PR job `EI v1 candidate host conformance / muffin-candidate-host` installs the candidate and runs the TypeScript compiler plus the seven focused Muffin EI test files. It writes and uploads `ei-host-conformance-report.json` when the v3 host test completes.

Integration LOC accounting must be computed from the actual final Git diff, separately counting the ~15-line reusable host callback factory, the test fixture and the CI workflow. This is not a claim that a full independent host integration fits 30 LOC. The actual Muffin adapter logic remains significantly larger because Muffin owns Turn/policy/tool translation.

## Unproven requirements blocking issue #42

1. Independent author review and independently authored host conformance adapter (the fork itself does not establish that).
2. Full lifecycle coverage across the canonical facade: host policy interrupts and approvals for **every** mutating operation, real MCP registry transport detach/reattach, and actual process restart/replay under the v1 facade.
3. Final canonical API/export clean-up, stable error-matrix audit and breaking-change notes with evidence in the EI repository. These must be verified before checking the aggregate acceptance criteria.

Keep #42 **OPEN** until the above are verified; do not treat one green local CI result as external adoption certification.
