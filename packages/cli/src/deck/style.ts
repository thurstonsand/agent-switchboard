import { homedir } from "node:os";
import { type RgbColor, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const sgr = (open: string, close: string) => (s: string) => `\x1b[${open}m${s}\x1b[${close}m`;

export const bold = sgr("1", "22");
export const dim = sgr("2", "22");
export const red = sgr("31", "39");
export const green = sgr("32", "39");
export const yellow = sgr("33", "39");
export const magenta = sgr("35", "39");
export const cyan = sgr("36", "39");
export const gray = sgr("90", "39");
/** The glimpse companion's attention purple, #c084fc. */
export const attention = sgr("38;2;192;132;252", "39");

const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

export function spinnerFrame(now: number): string {
	return SPINNER[Math.floor(now / 80) % SPINNER.length] as string;
}

/** The blocked glyph flashes at about 1 Hz. */
export function flashOn(now: number): boolean {
	return Math.floor(now / 500) % 2 === 0;
}

export function key(name: string, label: string): string {
	return `${bold(name)} ${dim(label)}`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function age(at: number, now: number): string {
	const d = now - at;
	if (d < MINUTE) return "now";
	if (d < HOUR) return `${Math.floor(d / MINUTE)}m`;
	if (d < DAY) return `${Math.floor(d / HOUR)}h`;
	return `${Math.floor(d / DAY)}d`;
}

export function shortPath(path: string): string {
	const home = homedir();
	return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** An SGR background parameter mixed from two colors, `t` of the way from a to b. */
export function mix(a: RgbColor, b: RgbColor, t: number): string {
	const ch = (x: number, y: number) => Math.round(x + (y - x) * t);
	return `48;2;${ch(a.r, b.r)};${ch(a.g, b.g)};${ch(a.b, b.b)}`;
}

export function hex(color: RgbColor): string {
	return `#${[color.r, color.g, color.b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/** Paints a background under a whole line, surviving the resets inside it. */
export function sgrBg(code: string, s: string): string {
	const open = `\x1b[${code}m`;
	return `${open}${s.replaceAll("\x1b[0m", `\x1b[0m${open}`).replaceAll("\x1b[49m", open)}\x1b[0m`;
}

export function spread(left: string, right: string, width: number): string {
	const gap = width - visibleWidth(left) - visibleWidth(right);
	if (gap < 1) return truncateToWidth(left, width, "…");
	return left + " ".repeat(gap) + right;
}
