declare const SWB_INSTALL_VERSION: string | undefined;

/** `mise run install` stamps the release it builds on, so a dev install doesn't yield its servers to that release. */
export const VERSION = typeof SWB_INSTALL_VERSION === "string" ? SWB_INSTALL_VERSION : "0.0.0-dev";
