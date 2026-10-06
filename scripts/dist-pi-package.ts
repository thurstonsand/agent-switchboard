import { readFileSync, writeFileSync } from "node:fs";

const source = JSON.parse(readFileSync("packages/pi/package.json", "utf8"));
const manifest = {
	name: source.name,
	version: process.env.SWB_VERSION ?? source.version,
	type: "module",
	description: source.description,
	license: source.license,
	keywords: source.keywords,
	pi: { extensions: ["./index.js"] },
	peerDependencies: source.peerDependencies,
};
writeFileSync("dist/pi/package.json", `${JSON.stringify(manifest, null, "\t")}\n`);
