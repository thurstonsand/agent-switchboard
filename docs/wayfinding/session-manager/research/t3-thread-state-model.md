# T3 Code thread-state model

Primary source: `/tmp/t3/t3code`, tag `v0.0.46-nightly.20261005.2676`.

## Answers

### Exact storage and derivation inputs

- **Lifecycle is composed, not a single status.** The thread payload carries `archivedAt`, `settledOverride` (`null | "settled" | "active"`), `settledAt`, `unsettledAt`, `pinOrderKey`, `activeOrderKey`, and `lastVisitedAt` (`packages/contracts/src/orchestrationV2.ts:392-414`). The shell separately exposes latest/active/activity run timestamps and statuses, pending runtime requests, message timestamps, archive/settlement/order/visit fields (`packages/contracts/src/orchestrationV2.ts:1735-1796`).
- **Most lifecycle fields are JSON, not SQL columns.** `orchestration_v2_projection_threads` has first-class `created_at`, `updated_at`, and `archived_at`, but settlement, ordering, and visit state live inside `payload_json` (`apps/server/src/persistence/Migrations/055_OrchestrationV2.ts:57-73`). The projection writer materializes only `archived_at` while writing the complete thread payload (`apps/server/src/orchestration-v2/ProjectionStore.ts:1703-1749`).
- **Run state supplies completion/activity.** `orchestration_v2_projection_runs` stores `thread_id`, monotonic per-thread `ordinal`, `status`, `requested_at`, `completed_at`, and the full payload (`apps/server/src/persistence/Migrations/055_OrchestrationV2.ts:75-90`). The shell chooses the highest-ordinal interruptible run and activity run; activity includes `preparing`, `starting`, `running`, or `waiting` (`apps/server/src/orchestration-v2/ProjectionStore.ts:1321-1330`, `apps/server/src/orchestration-v2/ProjectionStore.ts:1460-1471`). Pending requests and latest user messages are also independently derived (`apps/server/src/orchestration-v2/ProjectionStore.ts:1330-1345`).
- **Attention is compositional.** Pending approvals/input outrank run activity; nonterminal runtime is “working,” runtime `idle` is “waiting,” failure is failure/limited, and the fallback is ready (`apps/web/src/components/Sidebar.logic.ts:972-997`). Unseen completion is separate from that status (`apps/web/src/components/Sidebar.logic.ts:937-947`).
- **Ordering has distinct keys and policies.** Active threads may carry a fractional `activeOrderKey`; unkeyed rows use `max(createdAt, unsettledAt)`, and keyed rows preserve manual order while ordinary activity leaves placement unchanged (`packages/client-runtime/src/state/threadSort.ts:121-137`, `packages/client-runtime/src/state/threadSort.ts:341-370`). Settled rows sort newest-first by `settledAt`, falling back through latest message/run timestamps and `updatedAt` (`packages/client-runtime/src/state/threadSort.ts:23-68`).

### Mutation and derivation rules

- Creation initializes archive, settlement, and visit state to null (`apps/server/src/orchestration-v2/Orchestrator.ts:2158-2167`). Archive stamps `archivedAt`; unarchive clears it (`apps/server/src/orchestration-v2/Orchestrator.ts:2672-2677`). Archive is independent of settlement: settlement has its own commands and fields, and settlement/unsettlement operations are rejected once archived (`apps/server/src/orchestration-v2/Orchestrator.ts:2410-2427`).
- Explicit settle writes override `"settled"`, stamps `settledAt`, clears `unsettledAt` and both manual order keys, and unpins; explicit unsettle writes override `"active"`, clears `settledAt`, and stamps `unsettledAt` (`apps/server/src/orchestration-v2/Orchestrator.ts:2678-2703`). Starting new work clears either explicit settlement override and `settledAt`; a previously settled thread gets a fresh `unsettledAt` (`apps/server/src/orchestration-v2/Orchestrator.ts:4410-4431`). This is the T3 analogue of “new turn unarchives,” but T3 does **not** clear `archivedAt` there; archived threads are separately guarded from work (`apps/server/src/orchestration-v2/Orchestrator.ts:4323-4327`).
- A Visit accepts a supplied watermark, advances `lastVisitedAt` only if newer, and deliberately does not bump activity (`updatedAt`) (`apps/server/src/orchestration-v2/Orchestrator.ts:2229-2251`; `apps/server/src/orchestration-v2/ProjectionStore.ts:674-681`). Unseen is `latestRun.completedAt > lastVisitedAt`; no completion, no watermark, or malformed completion means false, while malformed visit with a valid completion means true (`apps/web/src/components/Sidebar.logic.ts:767-775`).
- “Mark unread” is an undo/rewind: it requires a completed latest run and sets the visit watermark to exactly one millisecond before that completion (`apps/server/src/orchestration-v2/Orchestrator.ts:2659-2671`, `apps/server/src/orchestration-v2/Orchestrator.ts:2789-2790`). Server visit state remains authoritative even when rewound (`apps/web/src/components/Sidebar.logic.ts:749-765`).
- **Restart finding, correcting the initial hypothesis:** startup/shutdown reconciliation does not mark an in-flight T3 run `interrupted`; it changes selected nonterminal runs to `cancelled`, with `completedAt = now` (`apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts:180-210`, `apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts:310-319`). It expires/cancels unresolved non-message runtime requests (`apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts:292-307`), cancels process-owned child entities/items (`apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts:320-430`), changes active provider threads to idle, clears background rosters, and stops provider sessions (`apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts:577-619`). It also retires process-bound outbox effects (`apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts:656-703`). T3 does have an `interrupted` run status in its shell model (`apps/server/src/orchestration-v2/ProjectionStore.ts:1500-1516`), but this recovery path uses `cancelled`.

### Adaptation decision

Drop T3's event-sourcing layer for this local, single-user manager: the append-only event log, idempotent command receipts, JSON snapshots, projection replay/upserts, run attempts, orchestration nodes, provider turns, runtime requests, and process-effect outbox exist to coordinate T3's richer orchestration. The event log and receipts alone are explicit tables (`apps/server/src/persistence/Migrations/055_OrchestrationV2.ts:22-55`), while attempts, nodes, provider sessions/threads/turns, and runtime requests add separate projections (`apps/server/src/persistence/Migrations/055_OrchestrationV2.ts:92-190`). This recommendation is an adaptation judgment, not a claim made by T3.

Copy the small invariants: orthogonal archive/runtime/activity/attention state; a monotonic Visit watermark; Unseen derived from latest completed turn; rewind to just before completion for undo; stable open-list ordering; explicit terminalization of process-bound work on restart. Unlike T3, use `Interrupted` for a turn found in progress after reboot, matching this project's standing vocabulary and requirement; T3's restart cancellation is evidence for reconciliation, not for the chosen label.

### Minimal SQLite sketch in this project's vocabulary

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  activity_at TEXT NOT NULL,
  archived_at TEXT,
  last_visited_at TEXT,
  latest_turn_completed_at TEXT,
  open_order_key TEXT
);

CREATE TABLE runtimes (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  boot_id TEXT NOT NULL,
  pid INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('working', 'blocked', 'idle')),
  turn_started_at TEXT,
  updated_at TEXT NOT NULL
);
```

Derive **Archive/Open** from `archived_at`; **Visit** is `last_visited_at`; **Unseen** is open and `latest_turn_completed_at > last_visited_at` (with no Visit treated as a product decision—T3 treats it as not unseen); **Live** is a runtime row valid for the current boot/process and **Dormant** is its absence; **Interrupted** is Dormant plus a persisted `turn_started_at` with no corresponding completion. Persist activity timestamps and a manual key only if the agreed roster needs stable manual ordering; otherwise `activity_at` alone implements newest-activity-first. This schema is intentionally a design sketch, not T3's schema.

## Uncertainties

- T3's `hasUnseenCompletion` returns false when `lastVisitedAt` is null (`apps/web/src/components/Sidebar.logic.ts:767-772`). The sessions example expects an unseen completed session after reboot, but the desired first-completion/no-Visit rule is not yet explicit.
- T3 distinguishes user-authored messages from provider wakes because both can use the user role (`packages/contracts/src/orchestrationV2.ts:1752-1758`). Pi recorder events may make that distinction unnecessary; the schema owner should confirm which event advances `activity_at` and which only changes runtime activity.
