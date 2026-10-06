/** A failed action: exit 1 with the message on stderr. */
export class SwbError extends Error {}

/** Bad invocation: exit 2. */
export class UsageError extends Error {}
