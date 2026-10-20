import { afterEach, expect, test } from "bun:test";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DeckState, SettingsItem } from "../../packages/cli/src/deck/protocol.ts";
import { config, waitState } from "./harness/deck.ts";
import { budgets, type Scenario, scenario, until } from "./harness/index.ts";

let s: Scenario;
afterEach(async () => {
	try {
		s.save("final-screen.txt", s.screen());
	} catch {}
	await s.cleanup();
});

const file = () => join(s.env.XDG_CONFIG_HOME as string, "agent-switchboard", "config.toml");
const read = () => readFileSync(file(), "utf8");
const item = (st: DeckState, key: string): SettingsItem | undefined =>
	st.settings?.items.find((i) => i.kind === "setting" && i.key === key);

/** The column and row of `text` on screen. */
function find(text: string): [string, string] {
	const lines = s.screen().split("\n");
	const y = lines.findIndex((line) => line.includes(text));
	if (y === -1) throw new Error(`${text} not on screen:\n${lines.join("\n")}`);
	return [String((lines[y] as string).indexOf(text) + 1), String(y)];
}

async function click(text: string): Promise<void> {
	await Bun.sleep(350);
	s.swb("drive", "click", ...find(text));
}

const COMMENTED = `# mine: every comment here outlives Settings' edits
inactive_after = "96h" # long weekends

[dirs]
# where my code lives
scan = ["~/code"]
`;

test("Settings edits config.toml by keyboard and mouse, keeps its comments, and a value set back to its default leaves the file", async () => {
	s = scenario("settings", "edits");
	config(s, COMMENTED);
	s.swb("drive", "start", "--size", "160x40");
	await waitState(s, "ready", (x) => x.ready);
	s.keys(",");
	let st = await waitState(s, "Settings open across the Deck", (x) => x.mode === "settings" && x.layout.width === 160);
	expect(st.settings?.section).toBe("General");
	// Defaults are unset; the one the file sets is set.
	expect(item(st, "wake_on_highlight")).toMatchObject({ value: "off", set: false });
	expect(item(st, "inactive_after")).toMatchObject({ value: "96h", set: true });
	s.save("general.txt", s.screen());

	// ⏎ toggles a bool and saves it; the rest of the file is untouched.
	s.keys("Enter");
	await waitState(s, "wake on", (x) => item(x, "wake_on_highlight")?.value === "on");
	expect(read()).toBe(COMMENTED.replace("# long weekends\n", "# long weekends\nwake_on_highlight = true\n"));
	// Back to its default takes the key out again: the file is as it was.
	s.keys("Enter");
	await waitState(s, "wake off", (x) => item(x, "wake_on_highlight")?.set === false);
	expect(read()).toBe(COMMENTED);

	// A duration typed in, read back as it's typed.
	s.keys("j", "j", "Enter", "C-u", "-l", "3d");
	await until(() => s.screen().includes("= 3 days"), budgets.settle, "the duration read back");
	s.keys("Enter");
	await waitState(s, "3d saved", (x) => item(x, "inactive_after")?.value === "3d");
	expect(read()).toContain('inactive_after = "3d" # long weekends');

	// A bad value is refused in place and nothing is written.
	s.keys("k", "Enter", "C-u", "-l", "5", "Enter");
	await until(() => s.screen().includes("must be columns (20 or more)"), budgets.settle, "the width refused");
	expect(read()).not.toContain("roster_width");
	s.keys("Escape");

	// The mouse: a section in the rail, then a value, which cycles.
	await click("Directories");
	st = await waitState(s, "Directories", (x) => x.settings?.section === "Directories");
	await click("name");
	await waitState(s, "dirs.sort cycled", (x) => item(x, "dirs.sort")?.value === "recent");
	expect(read()).toContain('[dirs]\n# where my code lives\nscan = ["~/code"]\nsort = "recent"\n');
	s.save("directories.txt", s.screen());

	// Search finds a setting by a word only its synonyms have, across sections.
	s.keys("/", "-l", "sidebar");
	st = await waitState(s, "a search", (x) => x.settings?.search === "sidebar");
	expect(st.settings?.items.filter((i) => i.kind === "setting").map((i) => i.key)).toEqual(["roster_width"]);
	s.keys("Escape");
	await waitState(s, "search cleared", (x) => x.settings?.search === null);

	// esc goes back to sessions, and the roster has its width back.
	s.keys("Escape");
	st = await waitState(s, "back to the roster", (x) => x.mode === "roster");
	await until(
		() => s.tmux(s.servers.ui, "display", "-p", "-t", `=${st.deck}:`, "#{window_zoomed_flag}") === "0",
		budgets.settle,
		"the roster unzoomed",
	);
});

test("a hand edit applies to an open Deck at once; an invalid one stops new swb commands, and the Deck keeps going and says where", async () => {
	s = scenario("settings", "invalid");
	config(s, "wake_on_highlight = false\n");
	s.swb("drive", "start", "--size", "160x40");
	await waitState(s, "ready", (x) => x.ready);
	s.keys(",");
	await waitState(s, "Settings", (x) => x.mode === "settings");

	// Saved the way editors do, by renaming a new file into place.
	writeFileSync(`${file()}.new`, "wake_on_highlight = true\n");
	renameSync(`${file()}.new`, file());
	await waitState(s, "the hand edit applied", (x) => item(x, "wake_on_highlight")?.value === "on");

	writeFileSync(file(), "wake_on_highlight = true\n\n[dirs]\ndept = 3\n");
	const st = await waitState(s, "the error reported", (x) => x.configError !== null);
	expect(st.configError).toContain("config.toml:4: unknown key dirs.dept (did you mean dirs.depth?)");
	await until(() => s.screen().includes("O open config.toml at that line"), budgets.settle, "Settings showing the error");
	s.save("invalid-settings.txt", s.screen());
	const ls = s.swbTry("ls");
	expect(ls.code).toBe(1);
	expect(ls.err).toContain("config.toml:4: unknown key dirs.dept");

	s.keys("Escape");
	await waitState(s, "back to the roster", (x) => x.mode === "roster");
	await until(() => / O config\.toml:4: unknown key dirs\.dept/.test(s.screen()), budgets.settle, "the roster's red line");
	s.save("invalid-roster.txt", s.screen());

	writeFileSync(file(), "wake_on_highlight = true\n\n[dirs]\ndepth = 3\n");
	await waitState(s, "the error cleared", (x) => x.configError === null);
	expect(s.swbTry("ls").code).toBe(0);
});

test("a new prefix, pressed rather than typed, moves the open Deck to it at once", async () => {
	s = scenario("settings", "prefix");
	s.swb("drive", "start", "--size", "160x40");
	const deck = (await waitState(s, "ready", (x) => x.ready)).deck;
	s.keys(",");
	await waitState(s, "Settings", (x) => x.mode === "settings");
	s.keys("]", "]", "]");
	await waitState(s, "Keys & commands", (x) => x.settings?.section === "Keys & commands");
	s.keys("Enter");
	await waitState(s, "waiting for a chord", (x) => x.settings?.editing === "chord");
	s.keys("C-b");
	await until(() => s.screen().includes("C-b"), budgets.settle, "the chord shown as tmux spells it");
	s.keys("Enter");
	await waitState(s, "the prefix saved", (x) => item(x, "keys.prefix")?.value === "C-b");
	expect(read()).toBe('[keys]\nprefix = "C-b"\n');
	await until(() => s.tmux(s.servers.ui, "show", "-gv", "prefix") === "C-b", budgets.settle, "the UI server on C-b");
	// The new prefix's , comes back to Settings from the Stage.
	s.keys("Escape");
	await waitState(s, "the roster", (x) => x.mode === "roster");
	s.keys("C-b", ",");
	await waitState(s, "Settings by C-b ,", (x) => x.mode === "settings" && x.deck === deck);
});

test("the shortlist is automatic until its first edit writes it out; ↺ brings the automatic one back", async () => {
	s = scenario("settings", "shortlist");
	config(s, "# mine\n");
	s.swb("drive", "start", "--size", "160x40");
	await waitState(s, "ready", (x) => x.ready);
	s.keys(",", "]");
	// Once pi has listed its models: until then, faux-1 shows at pi's default effort.
	const st = await waitState(
		s,
		"the automatic shortlist",
		(x) => x.settings?.section === "Harnesses" && (x.settings.items.some((i) => i.kind === "preset" && i.value?.endsWith(" off")) ?? false),
		budgets.piReady,
	);
	const items = st.settings?.items ?? [];
	// Only pi is on this PATH: Claude Code and Codex say why they can't start.
	expect(items.filter((i) => i.kind === "harness").map((i) => [i.label, i.problem])).toEqual([
		["claude", "not found on PATH"],
		["codex", "not found on PATH"],
		["pi", null],
	]);
	const presets = items.filter((i) => i.kind === "preset");
	expect(presets).toEqual([expect.objectContaining({ label: "faux-1⁻³", set: false, default: true })]);
	s.save("automatic.txt", s.screen());

	// The first edit, a note, writes the list out with it. faux-1 doesn't reason, so its only effort is off.
	for (let x = st; x.settings?.items[x.settings.cursor]?.kind !== "preset"; ) {
		const before = x.settings?.cursor;
		s.keys("j");
		x = await waitState(s, "the cursor moving down", (y) => y.settings?.cursor !== before);
	}
	s.keys("Enter", "-l", "Scripted turns", "Enter");
	await waitState(s, "written", (x) => x.settings?.items.find((i) => i.kind === "preset")?.set === true);
	expect(read()).toBe(
		'# mine\n\n[[targets]]\nharness = "pi"\nprovider = "faux"\nmodel = "faux-1"\neffort = "off"\nuse = "Scripted turns"\ndefault = true\n',
	);
	s.save("written.txt", s.screen());

	s.keys("r");
	await waitState(s, "automatic again", (x) => x.settings?.items.find((i) => i.kind === "preset")?.set === false);
	expect(read()).toBe("# mine\n");
});
