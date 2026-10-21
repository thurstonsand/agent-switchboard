import { budgets, type LsEntry, type Scenario, until } from "./index.ts";

type Runtime = { tmux_session: string; session_id: string; cwd: string; pid: number };

export const runtimes = (s: Scenario) => s.query<Runtime>("SELECT * FROM runtimes");
export const entry = (s: Scenario, id: string) => s.ls().find((e) => e.id === id) as LsEntry;

/** `swb new` in the drive harness, waiting until pi is ready and its runtime row exists. */
export async function startManaged(s: Scenario): Promise<Runtime> {
	s.swb("drive", "start", "--", "new");
	await until(() => s.screen().includes("faux-1"), budgets.piReady, "managed pi to be ready");
	return until(() => runtimes(s)[0], budgets.settle, "the runtime row");
}

export async function prompt(s: Scenario, text: string): Promise<void> {
	s.keys("-l", text, "Enter");
}

export async function waitFor(s: Scenario, name: string): Promise<void> {
	await until(() => s.signal(name) !== "", budgets.settle, name);
}
