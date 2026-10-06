import { homedir } from "node:os";
import { join } from "node:path";

export const SCHEMA_VERSION = 1;

/** Suffix every tmux server name with the instance, so tests never touch a real server. */
export function instanced(name: string): string {
	const instance = process.env.SWB_INSTANCE;
	return instance ? `${name}-${instance}` : name;
}

export function stateDir(): string {
	return join(process.env.XDG_STATE_HOME || join(homedir(), ".local/state"), "agent-switchboard");
}

export function configDir(): string {
	return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "agent-switchboard");
}

export function dbPath(): string {
	return join(stateDir(), "swb.db");
}
