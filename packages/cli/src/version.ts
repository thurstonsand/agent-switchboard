declare const SWB_VERSION: string | undefined;

/** A release build is stamped with its version, and `mise run install` with the release it builds on, so a dev install doesn't yield its servers to that release. */
export const VERSION = typeof SWB_VERSION === "string" ? SWB_VERSION : "0.0.0-dev";
