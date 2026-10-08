import { copyFileSync, readFileSync, writeFileSync } from "node:fs";

const source = JSON.parse(readFileSync("packages/pi/package.json", "utf8"));
const manifest = {
	name: source.name,
	version: source.version,
	type: "module",
	description: source.description,
	license: source.license,
	repository: source.repository,
	keywords: source.keywords,
	pi: { extensions: ["./index.js"] },
	peerDependencies: source.peerDependencies,
};
writeFileSync("dist/pi/package.json", `${JSON.stringify(manifest, null, "\t")}\n`);
copyFileSync("LICENSE", "dist/pi/LICENSE");
