import { readFileSync, writeFileSync } from "node:fs";
import { $ } from "bun";
import { CHANGELOG, compareVersions, MANIFEST, manifestVersion, parseChangelog, parseVersion, type Version } from "./changelog.ts";

function refuse(reason: string): never {
	console.error(`release: ${reason}`);
	process.exit(1);
}

const version = process.argv[2] ?? "";
const next = parseVersion(version);
if (!next) refuse(`the version must be X.Y.Z, got "${version}"`);

if ((await $`git symbolic-ref --short HEAD`.text()).trim() !== "main") refuse("not on main");
if ((await $`git status --porcelain`.text()).trim()) refuse("the tree has uncommitted changes");
await $`git fetch --quiet origin main`;
const head = (await $`git rev-parse HEAD`.text()).trim();
if (head !== (await $`git rev-parse origin/main`.text()).trim()) refuse("main doesn't match origin/main");
const [run] = await $`gh run list --workflow ci --commit ${head} --limit 1 --json status,conclusion,url`.json();
if (run?.conclusion !== "success") {
	refuse(run ? `CI on ${head.slice(0, 7)} is ${run.conclusion || run.status}: ${run.url}` : `CI hasn't run on ${head.slice(0, 7)}`);
}

const changelog = readFileSync(CHANGELOG, "utf8");
if (!parseChangelog(changelog).unreleased.trim()) refuse(`${CHANGELOG} has nothing under [Unreleased]`);
const current = manifestVersion();
if (compareVersions(next, parseVersion(current) as Version) <= 0) refuse(`${version} isn't greater than ${current}`);

await $`mise run release:check`;

const now = new Date();
const today = [now.getFullYear(), now.getMonth() + 1, now.getDate()].map((n) => String(n).padStart(2, "0")).join("-");
writeFileSync(CHANGELOG, changelog.replace(/^## \[Unreleased\]$/m, `## [Unreleased]\n\n## [${version}] - ${today}`));
const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
manifest.version = version;
writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, "\t")}\n`);
await $`bun install`.quiet();
await $`bun scripts/changelog.ts`;

await $`git commit --quiet -m ${`chore(release): ${version}`} -- ${CHANGELOG} ${MANIFEST} bun.lock`;
const notes = await $`scripts/extract-release-notes.sh v${version}`.text();
await $`git tag -a v${version} --cleanup=verbatim -F - < ${new Response(notes)}`;
await $`git push --atomic origin main v${version}`;
console.log(`release: pushed v${version}; the Release workflow publishes it: gh run list --workflow Release`);
