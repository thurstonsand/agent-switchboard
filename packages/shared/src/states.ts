// The states every query asks of the db's facts, each defined once. A query uses these rather than its own copy, so
// the Deck, the CLI, the clock, and the lines can't disagree about the same row.

/** Archived and not prompted since. Over `sessions s` joined to `marks m`; NULL, so not archived, without a marks row. */
export const ARCHIVED = "m.archived_at >= s.last_prompt_at";

/** Not archived, or prompted since. Over `sessions s` LEFT JOINed to `marks m`. */
export const OPEN = `NOT coalesce(${ARCHIVED}, 0)`;

/** Idle on its provider's error, and no turn started since. Over `sessions s`. */
export const ERRORED = "s.phase = 'idle' AND s.ending IS 'errored'";

/** Idle on a question for me, and no turn started since. Over `sessions s`. */
export const ASKING = "s.phase = 'idle' AND s.ending IS 'asked'";

/**
 * A reload whose restart hasn't started: the session's line quits for it when its turn ends. Over `marks`, unaliased.
 * One started stays until the harness it started registers.
 */
export const RELOAD_UNSTARTED = "reload IS NOT NULL AND reload_started_at IS NULL";

/** A message neither delivered nor cancelled. The `messages_pending` index is on the same condition. */
export const PENDING_MESSAGE = "delivered_at IS NULL AND cancelled_at IS NULL";

/** A schedule still due to fire. The `schedules_due` index is on the same condition. */
export const PENDING_SCHEDULE = "next_at IS NOT NULL AND cancelled_at IS NULL";
