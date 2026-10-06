import { VERSION } from "./version.ts";

const [command] = process.argv.slice(2);

switch (command) {
	case "--version":
		console.log(VERSION);
		break;
	default:
		console.error(`swb: unknown command ${command ?? "(none)"}`);
		process.exit(2);
}
