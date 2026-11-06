import { homedir } from "node:os";
import type { RgbColor } from "@earendil-works/pi-tui";

const sgr = (open: string, close: string) => (s: string) => `\x1b[${open}m${s}\x1b[${close}m`;

export const bold = sgr("1", "22");
let muted: string | null = null;
export const dim = (s: string): string => (muted ? `\x1b[${muted}m${s}\x1b[39m` : sgr("2", "22")(s));

export function dimColors(background: RgbColor, foreground: RgbColor, light: boolean): void {
	muted = light ? mix(38, background, foreground, 0.6) : null;
}

export const red = sgr("31", "39");
export const green = sgr("32", "39");
export const yellow = sgr("33", "39");
export const magenta = sgr("35", "39");
export const blue = sgr("34", "39");
export const cyan = sgr("36", "39");
export const gray = dim;
export const attention = yellow;
export const blockedMark = sgr("1;33", "22;39");

export function keyName(name: string): string {
	return name.replaceAll("M-", "Alt+").replaceAll("C-", "Ctrl+").replaceAll("S-", "Shift+");
}

const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

export function spinnerFrame(now: number): string {
	return SPINNER[Math.floor(now / 80) % SPINNER.length] as string;
}

export function key(name: string, label: string): string {
	return `${bold(name)} ${label}`;
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

/** When a snooze ends: "2:30p" today, "Sun 9a" within the week, "Oct 25" after. */
export function wakeAt(at: number, now: number): string {
	const d = new Date(at);
	const [h, m] = [d.getHours(), d.getMinutes()];
	const time = `${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""}${h < 12 ? "a" : "p"}`;
	if (d.toDateString() === new Date(now).toDateString()) return time;
	if (at - now < 6 * DAY) {
		const day = d.toLocaleDateString("en-US", { weekday: "short" });
		return `${day} ${time}`;
	}
	return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function shortPath(path: string): string {
	const home = homedir();
	return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export function lerp(a: RgbColor, b: RgbColor, t: number): RgbColor {
	const ch = (x: number, y: number) => Math.round(x + (y - x) * t);
	return { r: ch(a.r, b.r), g: ch(a.g, b.g), b: ch(a.b, b.b) };
}

/** An SGR foreground (38) or background (48) parameter mixed from two colors, `t` of the way from a to b. */
export function mix(layer: 38 | 48, a: RgbColor, b: RgbColor, t: number): string {
	const c = lerp(a, b, t);
	return `${layer};2;${c.r};${c.g};${c.b}`;
}

export function hex(color: RgbColor): string {
	return `#${[color.r, color.g, color.b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/** Paints a background under a whole line, surviving the resets inside it. */
export function sgrBg(code: string, s: string): string {
	const open = `\x1b[${code}m`;
	return `${open}${s.replaceAll("\x1b[0m", `\x1b[0m${open}`).replaceAll("\x1b[49m", open)}\x1b[0m`;
}
