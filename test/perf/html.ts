import { type ProbeResult, type Results, type SpanStat, type Stat, verdict } from "./report.ts";

// One self-contained page per run: every probe's primary metric per variant on one log scale, and, folded under each,
// its metrics and a waterfall of the spans and marks swb's processes traced while it ran.

const COLORS = ["#7c6f64", "#076678"];

const esc = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const ms = (value: number) => (Number.isNaN(value) ? "—" : value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${value.toFixed(1)} ms`);

function scale(results: Results): (value: number) => number {
	const all = results.probes.flatMap((p) =>
		Object.values(p.variants).flatMap((v) => (v.stats[p.primary] ? [v.stats[p.primary]?.p75 as number] : [])),
	);
	const top = Math.log10(Math.max(10, ...all) + 1);
	// The longest bar stops short of the track's end, where the value sits.
	return (value) => Math.max(0.5, (Math.log10(Math.max(0, value) + 1) / top) * 85);
}

function bars(probe: ProbeResult, results: Results, x: (value: number) => number): string {
	return results.variants
		.map((label, i) => {
			const v = probe.variants[label];
			const st = v?.stats[probe.primary];
			if (!v || v.error || !st)
				return `<div class="bar"><span class="note">${esc(v?.error?.split("\n")[0] ?? probe.skipped ?? "no samples")}</span></div>`;
			return `<div class="bar" title="${esc(label)}: median ${ms(st.median)}, p25 ${ms(st.p25)}, p75 ${ms(st.p75)}, n ${st.n}">
				<div class="fill" style="width:${x(st.median)}%;background:${COLORS[i]}"></div>
				<div class="iqr" style="left:${x(st.p25)}%;width:${Math.max(0.3, x(st.p75) - x(st.p25))}%"></div>
				<span class="val">${ms(st.median)}</span></div>`;
		})
		.join("");
}

function chip(probe: ProbeResult, results: Results): string {
	if (results.variants.length < 2) return "";
	const [a, b] = results.variants.map((label) => probe.variants[label]?.stats[probe.primary]) as [Stat | undefined, Stat | undefined];
	if (!a || !b) return "";
	const v = verdict(a, b);
	const pct = ((b.median - a.median) / a.median) * 100;
	return `<span class="chip ${v}">${v === "same" ? "~" : v} ${pct >= 0 ? "+" : "−"}${Math.abs(pct).toFixed(1)}%</span>`;
}

function waterfall(spans: SpanStat[], primary: Stat | undefined): string {
	const shown = spans.filter((sp) => sp.seen > 0);
	if (shown.length === 0) return `<p class="note">swb traced nothing inside this probe.</p>`;
	const end = Math.max(primary?.median ?? 0, ...shown.map((sp) => sp.at + (sp.ms ?? 0)), 1);
	return `<div class="wf">${shown
		.map((sp) => {
			const left = (Math.max(0, sp.at) / end) * 100;
			const width = sp.kind === "span" ? Math.max(0.4, ((sp.ms ?? 0) / end) * 100) : 0;
			const label = `${esc(sp.name)}${sp.count > 1 ? ` ×${sp.count}` : ""}`;
			const time = sp.kind === "span" ? `${ms(sp.ms ?? 0)} at +${ms(sp.at)}` : `at +${ms(sp.at)}`;
			return `<div class="wfrow"><div class="wfname">${label}</div><div class="wftrack">${
				sp.kind === "span"
					? `<div class="wfspan" style="left:${left}%;width:${width}%"></div>`
					: `<div class="wfmark" style="left:${left}%"></div>`
			}<span class="wftime" style="left:${Math.min(left + width, 80)}%">${time}</span></div></div>`;
		})
		.join(
			"",
		)}${primary ? `<div class="wfrow"><div class="wfname">median end</div><div class="wftrack"><div class="wfend" style="left:${(primary.median / end) * 100}%"></div></div></div>` : ""}</div>`;
}

function metrics(probe: ProbeResult, results: Results): string {
	const names = [...new Set(results.variants.flatMap((label) => Object.keys(probe.variants[label]?.stats ?? {})))];
	const head = `<tr><th>metric</th>${results.variants.map((l) => `<th colspan="4">${esc(l)}</th>`).join("")}</tr><tr><th></th>${results.variants.map(() => "<th>median</th><th>p90</th><th>min</th><th>n</th>").join("")}</tr>`;
	const rows = names
		.map(
			(name) =>
				`<tr><td>${esc(name)}${name === probe.primary ? " ★" : ""}</td>${results.variants
					.map((label) => {
						const st = probe.variants[label]?.stats[name];
						return st ? `<td>${ms(st.median)}</td><td>${ms(st.p90)}</td><td>${ms(st.min)}</td><td>${st.n}</td>` : "<td colspan=4>—</td>";
					})
					.join("")}</tr>`,
		)
		.join("");
	return `<table class="metrics">${head}${rows}</table>`;
}

export function html(results: Results): string {
	const x = scale(results);
	const { meta } = results;
	const suites = [...new Set(results.probes.map((p) => p.suite))];
	const legend = results.variants
		.map((label, i) => `<span class="key"><i style="background:${COLORS[i]}"></i>${esc(label)}</span>`)
		.join("");
	const body = suites
		.map((name) => {
			const probes = results.probes.filter((p) => p.suite === name);
			return `<h2>${esc(name)}</h2>${probes
				.map((probe) => {
					const last = probe.variants[results.variants.at(-1) as string];
					return `<details class="probe"><summary>
						<div class="name"><code>${esc(probe.name)}</code> ${chip(probe, results)}<div class="feels">${esc(probe.feels)}</div></div>
						<div class="bars">${bars(probe, results, x)}</div></summary>
						<div class="inside">${metrics(probe, results)}<h3>Inside ${esc(results.variants.at(-1) as string)}</h3>${waterfall(last?.spans ?? [], last?.stats[probe.primary])}</div>
					</details>`;
				})
				.join("")}`;
		})
		.join("");
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>swb perf ${esc(meta.sha)}</title><style>
body{font:14px/1.45 -apple-system,system-ui,sans-serif;color:#3c3836;background:#fbf8ef;margin:0;padding:24px 32px;max-width:1180px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:22px 0 6px;color:#7c6f64;text-transform:uppercase;letter-spacing:.06em}h3{font-size:13px;margin:14px 0 6px}
.meta{color:#7c6f64;font-size:12px;margin-bottom:10px}.legend{margin:8px 0 4px}.key{margin-right:16px;font-size:13px}.key i{display:inline-block;width:12px;height:12px;border-radius:2px;margin-right:5px;vertical-align:-1px}
.probe{border-top:1px solid #e5dcc3}.probe summary{display:grid;grid-template-columns:420px 1fr;gap:16px;padding:8px 0;cursor:pointer;list-style:none}.probe summary::-webkit-details-marker{display:none}
.name code{font-size:13px;font-weight:600}.feels{color:#7c6f64;font-size:12px}
.bar{position:relative;height:16px;margin:3px 0;background:#f2ead3;border-radius:3px}.fill{position:absolute;top:0;bottom:0;left:0;border-radius:3px;opacity:.85}
.iqr{position:absolute;top:6px;height:4px;background:#3c3836;opacity:.35;border-radius:2px}.val{position:absolute;right:6px;top:0;font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}
.note{font-size:12px;color:#9d0006;padding-left:6px;line-height:16px}
.chip{font-size:11px;padding:1px 6px;border-radius:8px;margin-left:6px;background:#ebdbb2}.chip.slower{background:#fbd5cf;color:#9d0006}.chip.faster{background:#d5e8c4;color:#427b58}
.inside{padding:4px 0 14px 12px}.metrics{border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums}.metrics td,.metrics th{padding:2px 10px 2px 0;text-align:right}.metrics td:first-child,.metrics th:first-child{text-align:left}
.wf{font-size:12px}.wfrow{display:grid;grid-template-columns:260px 1fr;align-items:center;height:18px}.wfname{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:ui-monospace,monospace;font-size:11px}
.wftrack{position:relative;height:14px;background:#f6f0dd;border-radius:2px}.wfspan{position:absolute;top:2px;bottom:2px;background:#076678;border-radius:2px;opacity:.8}
.wfmark{position:absolute;top:0;bottom:0;width:2px;background:#b57614}.wfend{position:absolute;top:0;bottom:0;width:2px;background:#9d0006}.wftime{position:absolute;padding-left:6px;font-size:10px;line-height:14px;color:#7c6f64;white-space:nowrap}
</style></head><body>
<h1>swb perf</h1>
<div class="meta">${esc(meta.date)} · ${esc(meta.branch)} @ ${esc(meta.sha)}${meta.dirty ? " (uncommitted changes)" : ""} · ${esc(meta.host)} · ${esc(meta.platform)} · ${esc(meta.cpus)} · ${meta.memoryGb} GB · bun ${esc(meta.bun)} · ${esc(meta.tmux)}</div>
<div class="legend">${legend}<span class="key">bar: median · dark line: middle half · log scale · click a probe for its spans</span></div>
${body}</body></html>`;
}
