---
status: closed
type: research
blocked-by: []
---

# T3 Code thread-state model, the parts to adapt

## Question

Thurston wants to reuse T3 Code's persistence model where it works. Extract the concrete schema and rules behind T3's thread state so the schema ticket can adapt them.

T3 nightly is at `/tmp/t3/t3code` (re-clone tag `v0.0.46-nightly.20261005.2676` from `https://github.com/pingdotgg/t3code` if missing). Starting points: `packages/contracts/src/orchestrationV2.ts:359-946`, `apps/server/src/orchestration-v2/ProjectionStore.ts:1400`, `apps/server/src/orchestration-v2/Orchestrator.ts:2659-2795, 2674-2695, 3140-3202`, `apps/server/src/persistence/Migrations/055_OrchestrationV2.ts`, `apps/web/src/components/Sidebar.logic.ts:937-1009`, `packages/client-runtime/src/state/threadSort.ts`, `apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts:577-714`.

Report:

- The exact columns and tables for thread lifecycle: archive and settle timestamps, settlement override, visit watermark, ordering keys, activity/attention derivation inputs.
- The rules: what sets and clears each field, how unseen is computed from the watermark versus the latest completed run, how undo works, and how restart reconciliation marks interrupted work.
- Which parts are event-sourcing machinery we should drop for a local single-user tool, and which are the minimal state tables plus rules worth copying.
- A suggested minimal SQLite schema sketch in T3's terms, mapped onto our vocabulary (Archive, Visit, Unseen, Interrupted, Live/Dormant).

## Resolution

Reuse T3's orthogonal lifecycle axes, Visit watermark, completion-based Unseen derivation, and restart reconciliation, but not its event log/projection machinery. T3 notably cancels—not interrupts—live runs during restart recovery, so our `Interrupted` state is a deliberate local semantic. See [the findings](../research/t3-thread-state-model.md).
