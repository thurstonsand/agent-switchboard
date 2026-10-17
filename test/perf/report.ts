// Results: the samples each probe took in each variant, their statistics, and where the time went according to the
// trace swb's processes wrote while each sample ran.

export type Stat = { n: number; median: number; p25: number; p75: number; p90: number; min: number; max: number; mean: number };

/** A span's total time, or a mark's moment, within a sample's window, medians across samples. */
export type SpanStat = { name: string; kind: "span" | "mark"; at: number; ms: number | null; count: number; seen: number };

export type VariantResult = {
	samples: Record<string, number>[];
	stats: Record<string, Stat>;
	spans: SpanStat[];
	error: string | null;
};

export type ProbeResult = {
	name: string;
	suite: string;
	feels: string;
	primary: string;
	variants: Record<string, VariantResult>;
	skipped: string | null;
};

export type Meta = {
	date: string;
	sha: string;
	dirty: boolean;
	branch: string;
	host: string;
	platform: string;
	cpus: string;
	memoryGb: number;
	bun: string;
	tmux: string;
	args: string[];
};

export type Results = { meta: Meta; variants: string[]; probes: ProbeResult[] };

export type TraceEvent = { name: string; at: number; ms?: number; pid: number };

function quantile(sorted: number[], q: number): number {
	if (sorted.length === 0) return Number.NaN;
	const pos = (sorted.length - 1) * q;
	const lo = Math.floor(pos);
	const hi = Math.ceil(pos);
	return (sorted[lo] as number) + ((sorted[hi] as number) - (sorted[lo] as number)) * (pos - lo);
}

export function stat(values: number[]): Stat {
	const sorted = values.toSorted((a, b) => a - b);
	return {
		n: sorted.length,
		median: quantile(sorted, 0.5),
		p25: quantile(sorted, 0.25),
		p75: quantile(sorted, 0.75),
		p90: quantile(sorted, 0.9),
		min: sorted[0] ?? Number.NaN,
		max: sorted.at(-1) ?? Number.NaN,
		mean: sorted.reduce((a, b) => a + b, 0) / (sorted.length || 1),
	};
}

export function stats(samples: Record<string, number>[]): Record<string, Stat> {
	const names = [...new Set(samples.flatMap((sample) => Object.keys(sample)))];
	return Object.fromEntries(
		names.map((name) => [name, stat(samples.flatMap((sample) => (name in sample ? [sample[name] as number] : [])))]),
	);
}

/** Each sample's window runs from its t0 to its slowest metric; spans that start inside it count toward it. */
export function spans(events: TraceEvent[], windows: { t0: number; end: number }[]): SpanStat[] {
	const per = windows.map(({ t0, end }) => {
		const seen = new Map<string, { kind: "span" | "mark"; at: number; ms: number; count: number }>();
		for (const event of events) {
			if (event.at < t0 || event.at > end) continue;
			const kind = event.ms === undefined ? "mark" : "span";
			const entry = seen.get(event.name) ?? { kind, at: event.at - t0, ms: 0, count: 0 };
			entry.ms += event.ms ?? 0;
			entry.count++;
			seen.set(event.name, entry);
		}
		return seen;
	});
	const names = [...new Set(per.flatMap((seen) => [...seen.keys()]))];
	return names
		.map((name): SpanStat => {
			const found = per.flatMap((seen) => (seen.has(name) ? [seen.get(name)] : [])) as {
				kind: "span" | "mark";
				at: number;
				ms: number;
				count: number;
			}[];
			const kind = (found[0] as { kind: "span" | "mark" }).kind;
			return {
				name,
				kind,
				at: stat(found.map((f) => f.at)).median,
				ms: kind === "span" ? stat(found.map((f) => f.ms)).median : null,
				count: stat(found.map((f) => f.count)).median,
				seen: found.length,
			};
		})
		.toSorted((a, b) => a.at - b.at);
}

export type Verdict = "slower" | "faster" | "same";

/**
 * A change only when the medians differ by at least 5% and 2 ms and the middle halves of the two samples don't overlap;
 * anything less is within what this machine's noise produces.
 */
export function verdict(base: Stat, other: Stat): Verdict {
	const delta = other.median - base.median;
	if (Math.abs(delta) < Math.max(2, base.median * 0.05)) return "same";
	if (delta > 0 && other.p25 > base.p75) return "slower";
	if (delta < 0 && other.p75 < base.p25) return "faster";
	return "same";
}

const ms = (value: number | undefined) =>
	value === undefined || Number.isNaN(value) ? "—" : value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${value.toFixed(1)} ms`;

/** The table a person or an agent reads at the end of a run. */
export function table(results: Results): string {
	const [base, other] = results.variants as [string, string | undefined];
	const header = other ? ["probe", "metric", base, other, "Δ", ""] : ["probe", "metric", "median", "p90", "min", "n"];
	// A row is either full, or a probe that has only a note to show.
	const rows: (string[] | { name: string; metric: string; note: string })[] = [];
	for (const probe of results.probes) {
		const a = probe.variants[base];
		const b = other ? probe.variants[other] : undefined;
		const failed = a?.error ?? b?.error;
		const sa = a?.stats[probe.primary];
		const sb = b?.stats[probe.primary];
		if (probe.skipped || failed || !sa || (other && !sb)) {
			const note = probe.skipped ? `skipped: ${probe.skipped}` : `failed: ${(failed ?? "no samples").split("\n")[0]}`;
			rows.push({ name: probe.name, metric: probe.primary, note });
		} else if (!sb) rows.push([probe.name, probe.primary, ms(sa.median), ms(sa.p90), ms(sa.min), String(sa.n)]);
		else {
			const delta = sb.median - sa.median;
			const pct = (delta / sa.median) * 100;
			const v = verdict(sa, sb);
			const sign = (x: number) => (x >= 0 ? "+" : "−");
			rows.push([
				probe.name,
				probe.primary,
				ms(sa.median),
				ms(sb.median),
				`${sign(delta)}${ms(Math.abs(delta))} (${sign(pct)}${Math.abs(pct).toFixed(1)}%)`,
				v === "same" ? "~" : v,
			]);
		}
	}
	const full = [header, ...rows.filter((r): r is string[] => Array.isArray(r))];
	const notes = rows.filter((r) => !Array.isArray(r)) as { name: string; metric: string }[];
	const widths = header.map((_, i) =>
		Math.max(
			...full.map((r) => (r[i] ?? "").length),
			...(i === 0 ? notes.map((n) => n.name.length) : i === 1 ? notes.map((n) => n.metric.length) : [0]),
		),
	);
	const pad = (cell: string, i: number) => (i < 2 ? cell.padEnd(widths[i] as number) : cell.padStart(widths[i] as number));
	const line = (r: string[] | { name: string; metric: string; note: string }) =>
		Array.isArray(r) ? r.map(pad).join("  ") : `${pad(r.name, 0)}  ${pad(r.metric, 1)}  ${r.note}`;
	return [line(header), ...rows.map(line)].join("\n");
}

/** The slowest probes by their primary median, each with the spans and marks that fill it. */
export function slowest(results: Results, count = 6): string {
	const variant = results.variants.at(-1) as string;
	const ranked = results.probes
		.flatMap((probe) => {
			const v = probe.variants[variant];
			const st = v?.stats[probe.primary];
			return st && !v.error ? [{ probe, v, median: st.median }] : [];
		})
		.toSorted((a, b) => b.median - a.median)
		.slice(0, count);
	const out: string[] = [`Slowest in ${variant}, with what swb's trace saw inside them:`];
	for (const { probe, v, median } of ranked) {
		out.push(`  ${probe.name}  ${ms(median)}  (${probe.primary})`);
		const common = v.spans.filter((sp) => sp.seen * 2 >= v.samples.length);
		const longest = common
			.filter((sp) => sp.kind === "span")
			.toSorted((a, b) => (b.ms as number) - (a.ms as number))
			.slice(0, 6);
		const inside = [...longest, ...common.filter((sp) => sp.kind === "mark")];
		for (const sp of inside.toSorted((a, b) => a.at - b.at))
			out.push(
				`      +${ms(sp.at).padStart(9)}  ${sp.kind === "span" ? `${ms(sp.ms ?? 0).padStart(9)}` : "     mark".padStart(9)}  ${sp.name}${sp.count > 1 ? ` ×${sp.count}` : ""}`,
			);
	}
	return out.join("\n");
}
