import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`usage: set-release-version.ts X.Y.Z, got ${version}`);

const manifest = "packages/pi/package.json";
const pkg = JSON.parse(readFileSync(manifest, "utf8"));
pkg.version = version;
writeFileSync(manifest, `${JSON.stringify(pkg, null, "\t")}\n`);
writeFileSync("packages/cli/src/version.ts", `export const VERSION = "${version}";\n`);
