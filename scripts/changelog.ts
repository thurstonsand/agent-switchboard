import { readFileSync } from "node:fs";

export const CHANGELOG = "CHANGELOG.md";
export const MANIFEST = "packages/lines/pi/package.json";

export type Version = [number, number, number];

export function parseVersion(text: string): Version | undefined {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(text);
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

export function compareVersions(a: Version, b: Version): number {
	return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** The released version in the manifest npm publishes, which the swb binary is stamped from too. */
export function manifestVersion(): string {
	return JSON.parse(readFileSync(MANIFEST, "utf8")).version;
}

/**
 * Reads CHANGELOG.md: `## [Unreleased]` first, then `## [x.y.z] - YYYY-MM-DD` sections, newest first. Any other `## `
 * heading, or versions that don't strictly descend, is an error.
 */
export function parseChangelog(text: string): { unreleased: string; versions: string[] } {
	const lines = text.split("\n");
	const headings = lines.flatMap((line, index) => (line.startsWith("## ") ? [{ line, index }] : []));
	if (headings[0]?.line !== "## [Unreleased]") throw new Error(`${CHANGELOG}: the first section must be "## [Unreleased]"`);
	const versions: string[] = [];
	for (const { line } of headings.slice(1)) {
		const match = /^## \[(\d+\.\d+\.\d+)\] - \d{4}-\d{2}-\d{2}$/.exec(line);
		if (!match?.[1]) throw new Error(`${CHANGELOG}: "${line}" isn't "## [x.y.z] - YYYY-MM-DD"`);
		const previous = versions.at(-1);
		if (previous && compareVersions(parseVersion(match[1]) as Version, parseVersion(previous) as Version) >= 0) {
			throw new Error(`${CHANGELOG}: ${match[1]} follows ${previous}; versions must strictly descend`);
		}
		versions.push(match[1]);
	}
	const unreleased = lines.slice(headings[0].index + 1, headings[1]?.index).join("\n");
	return { unreleased, versions };
}

if (import.meta.main) {
	const { versions } = parseChangelog(readFileSync(CHANGELOG, "utf8"));
	const manifest = manifestVersion();
	if (versions[0] !== manifest) {
		console.error(`${CHANGELOG}: its latest release is ${versions[0]}, but ${MANIFEST} publishes ${manifest}`);
		process.exit(1);
	}
}
