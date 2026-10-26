import { HARNESSES, type Harness } from "@swb/shared";
import { SwbError } from "../errors.ts";

// The query session_search and recall_search share, after pi-sessions': plain words match as prefixes and must all
// appear, falling back to any of them; "quoted phrases" match exactly; OR, AND, NOT, -word, and parentheses narrow it.
// Filters ride in the same string as key:value.

export type Filters = {
	harness: Harness | null;
	project: string | null;
	file: string | null;
	after: number | null;
	before: number | null;
	archived: boolean | null;
};

export type Query = {
	/** The FTS5 match, or null when the query is only filters. */
	match: string | null;
	/** The match with adjacent words relaxed to OR, when that differs. */
	relaxed: string | null;
	/** Sessions matching any of these are left out. */
	excludes: string[];
	/** Every positive word, for matching titles. */
	terms: string[];
	filters: Filters;
};

type Term = { kind: "term"; value: string; quoted: boolean };
type Node = Term | { kind: "and" | "or"; children: Node[] } | { kind: "adjacent"; children: Term[] } | { kind: "not"; child: Node };
type Token = Term | { kind: "and" | "or" | "not" | "(" | ")" };

const FILTER = /^(harness|project|file|after|before|archived):/;

function lex(input: string, filters: Filters): Token[] {
	const tokens: Token[] = [];
	let i = 0;
	const quoted = (start: number): [string, number] => {
		const end = input.indexOf('"', start + 1);
		if (end === -1) throw new SwbError(`query: unclosed quote at ${start}`);
		return [input.slice(start + 1, end), end + 1];
	};
	while (i < input.length) {
		const c = input[i] as string;
		if (/\s/.test(c)) i++;
		else if (c === "(" || c === ")") {
			tokens.push({ kind: c });
			i++;
		} else if (c === '"') {
			const [value, next] = quoted(i);
			if (value.trim() === "") throw new SwbError(`query: empty quotes at ${i}`);
			tokens.push({ kind: "term", value, quoted: true });
			i = next;
		} else if (c === "-" && (i === 0 || /[\s(]/.test(input[i - 1] as string)) && /[^\s)]/.test(input[i + 1] ?? " ")) {
			tokens.push({ kind: "not" });
			i++;
		} else {
			const key = FILTER.exec(input.slice(i))?.[1];
			if (key) {
				const start = i + key.length + 1;
				const [value, next] = input[start] === '"' ? quoted(start) : [/^[^\s()]*/.exec(input.slice(start))?.[0] ?? "", 0];
				i = next || start + value.length;
				if (tokens.at(-1)?.kind === "not") throw new SwbError(`query: ${key}: can't be negated`);
				filter(filters, key as keyof Filters, value);
				continue;
			}
			const word = /^[^\s()"]+/.exec(input.slice(i))?.[0] as string;
			i += word.length;
			const upper = word.toUpperCase();
			if (upper === "AND" || upper === "OR" || upper === "NOT") tokens.push({ kind: upper.toLowerCase() as "and" | "or" | "not" });
			else if (word.replace(/\*$/, "") === "") throw new SwbError("query: a lone * matches nothing");
			else tokens.push({ kind: "term", value: word.replace(/\*$/, ""), quoted: false });
		}
	}
	return tokens;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;
const DURATION = /^P(?=\d|T\d)(?:(\d+)W)?(?:(\d+)D)?(?:T(?=\d)(?:(\d+)H)?(?:(\d+)M)?)?$/;

/** A date or time, local unless it has an offset, or a duration ago, as epoch ms. */
function instant(key: string, text: string): number {
	const duration = DURATION.exec(text);
	if (duration) {
		const [w, d, h, m] = duration.slice(1).map((part) => Number(part ?? 0)) as [number, number, number, number];
		return Date.now() - (((w * 7 + d) * 24 + h) * 60 + m) * 60_000;
	}
	const at = DATE.test(text) ? new Date(`${text}T00:00`).getTime() : TIME.test(text) ? Date.parse(text) : Number.NaN;
	if (Number.isNaN(at)) throw new SwbError(`query: ${key}:${text} is neither a date, an ISO 8601 time, nor a duration ago like P7D`);
	return at;
}

function filter(filters: Filters, key: keyof Filters, value: string): void {
	if (value === "") throw new SwbError(`query: ${key}: needs a value`);
	if (filters[key] !== null) throw new SwbError(`query: ${key}: given twice`);
	switch (key) {
		case "harness":
			if (!(HARNESSES as readonly string[]).includes(value)) throw new SwbError(`query: harness:${value}: pi, claude, or codex`);
			filters.harness = value as Harness;
			return;
		case "archived":
			if (value !== "yes" && value !== "no") throw new SwbError(`query: archived:${value}: yes or no`);
			filters.archived = value === "yes";
			return;
		case "after":
		case "before":
			filters[key] = instant(key, value);
			return;
		case "project":
		case "file":
			filters[key] = value;
	}
}

class Parser {
	#i = 0;
	constructor(readonly tokens: Token[]) {}

	parse(): Node {
		const node = this.or();
		if (this.#i < this.tokens.length) throw new SwbError(`query: unexpected ${this.tokens[this.#i]?.kind}`);
		return node;
	}

	or(): Node {
		const children = [this.and()];
		while (this.take("or")) children.push(this.and());
		return children.length === 1 ? (children[0] as Node) : { kind: "or", children };
	}

	and(): Node {
		const children = [this.adjacent()];
		for (;;) {
			if (this.take("and")) children.push(this.adjacent());
			else if (["term", "(", "not"].includes(this.peek()?.kind ?? "")) children.push(this.adjacent());
			else break;
		}
		return children.length === 1 ? (children[0] as Node) : { kind: "and", children };
	}

	/** Plain words side by side: all of them, relaxed to any. */
	adjacent(): Node {
		const children: Term[] = [];
		for (let t = this.peek(); t?.kind === "term" && !t.quoted; t = this.peek()) {
			children.push(t);
			this.#i++;
		}
		if (children.length === 0) return this.unary();
		return children.length === 1 ? (children[0] as Term) : { kind: "adjacent", children };
	}

	unary(): Node {
		if (this.take("not")) return { kind: "not", child: this.unary() };
		const t = this.tokens[this.#i++];
		if (t?.kind === "term") return t;
		if (t?.kind === "(") {
			const node = this.or();
			if (!this.take(")")) throw new SwbError("query: unclosed parenthesis");
			return node;
		}
		throw new SwbError(t ? `query: unexpected ${t.kind}` : "query: ends too soon");
	}

	peek(): Token | undefined {
		return this.tokens[this.#i];
	}

	take(kind: Token["kind"]): boolean {
		if (this.peek()?.kind !== kind) return false;
		this.#i++;
		return true;
	}
}

function fts(node: Node, adjacent: "AND" | "OR"): string {
	switch (node.kind) {
		case "term":
			return `"${node.value.replaceAll('"', '""')}"${node.quoted ? "" : "*"}`;
		case "and":
		case "or":
			return `(${node.children.map((child) => fts(child, adjacent)).join(` ${node.kind.toUpperCase()} `)})`;
		case "adjacent":
			return `(${node.children.map((child) => fts(child, adjacent)).join(` ${adjacent} `)})`;
		case "not":
			throw new SwbError("query: NOT and -word only go at the top level, beside the words they exclude");
	}
}

function terms(node: Node): string[] {
	if (node.kind === "term") return [node.value];
	if (node.kind === "not") return [];
	return node.children.flatMap(terms);
}

export function parseQuery(input: string): Query {
	const filters: Filters = { harness: null, project: null, file: null, after: null, before: null, archived: null };
	const tokens = lex(input, filters);
	if (tokens.length === 0) return { match: null, relaxed: null, excludes: [], terms: [], filters };
	const root = new Parser(tokens).parse();
	const top = root.kind === "and" ? root.children : [root];
	const positive = top.filter((n) => n.kind !== "not");
	const excludes = top.flatMap((n) => (n.kind === "not" ? [fts(n.child, "AND")] : []));
	if (positive.length === 0) throw new SwbError("query: say what to find, not only what to leave out");
	const node: Node = positive.length === 1 ? (positive[0] as Node) : { kind: "and", children: positive };
	const match = fts(node, "AND");
	const relaxed = fts(node, "OR");
	return { match, relaxed: relaxed === match ? null : relaxed, excludes, terms: terms(node), filters };
}
