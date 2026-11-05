// The states every query asks of the db's facts, each defined once. A query uses these rather than its own copy, so
// the Deck, the CLI, the clock, and the lines can't disagree about the same row.

/** Archived and not prompted since. Over `sessions s` joined to `marks m`; NULL, so not archived, without a marks row. */
export const ARCHIVED = "m.archived_at >= s.last_prompt_at";

/** Not archived, or prompted since. Over `sessions s` LEFT JOINed to `marks m`. */
export const OPEN = `NOT coalesce(${ARCHIVED}, 0)`;

/** A message neither delivered nor cancelled. The `messages_pending` index is on the same condition. */
export const PENDING_MESSAGE = "delivered_at IS NULL AND cancelled_at IS NULL";

/** A schedule still due to fire. The `schedules_due` index is on the same condition. */
export const PENDING_SCHEDULE = "next_at IS NOT NULL AND cancelled_at IS NULL";
