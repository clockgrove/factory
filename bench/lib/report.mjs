/**
 * Reports from scorecards: a run against its baseline (HTML and Markdown)
 * and a benchmark's history across runs and Factory versions (HTML and
 * Markdown). The HTML is one self-contained file: inline CSS and SVG, no
 * script, font or image from the network, light and dark from the
 * viewer's setting. Every number comes from a scorecard; a null shows as
 * "n/a", never 0.
 */
import { compare, METRICS, SHOWN, spread, verdict } from "./metrics.mjs";

// --- formatting -------------------------------------------------------------

export const esc = (text) =>
  String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function tokens(n) {
  if (n === null || n === undefined) return "n/a";
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

export function duration(ms) {
  if (ms === null || ms === undefined) return "n/a";
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} m`;
}

const percent = (r) =>
  r === null || r === undefined ? "n/a" : `${Math.round(r * 100)}%`;

export function value(unit, v) {
  if (v === null || v === undefined) return "n/a";
  if (unit === "tokens") return tokens(v);
  if (unit === "ms") return duration(v);
  if (unit === "rate") return percent(v);
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

const time = (at) => (at ? `${at.slice(0, 16).replace("T", " ")} UTC` : "n/a");
const clock = (at) => (at ? at.slice(11, 16) : "");

// --- page -------------------------------------------------------------------

const STYLE = `
:root{color-scheme:light;--page:#f9f9f7;--surface:#fcfcfb;--ink:#0b0b0b;--ink-2:#52514e;--muted:#6f6d68;--grid:#e1e0d9;--axis:#c3c2b7;--ring:rgba(11,11,11,.10);
--s1:#2a78d6;--s2:#eb6834;--band:rgba(42,120,214,.12);--off:rgba(137,135,129,.22);--good:#006300;--bad:#c22f2f;--warn:#8a5a00}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])){color-scheme:dark;--page:#0d0d0d;--surface:#1a1a19;--ink:#f0efec;--ink-2:#c3c2b7;--muted:#9a988f;--grid:#2c2c2a;--axis:#383835;--ring:rgba(255,255,255,.10);
--s1:#3987e5;--s2:#d95926;--band:rgba(57,135,229,.18);--off:rgba(137,135,129,.28);--good:#0ca30c;--bad:#e66767;--warn:#e0a24f}}
:root[data-theme="dark"]{color-scheme:dark;--page:#0d0d0d;--surface:#1a1a19;--ink:#f0efec;--ink-2:#c3c2b7;--muted:#9a988f;--grid:#2c2c2a;--axis:#383835;--ring:rgba(255,255,255,.10);
--s1:#3987e5;--s2:#d95926;--band:rgba(57,135,229,.18);--off:rgba(137,135,129,.28);--good:#0ca30c;--bad:#e66767;--warn:#e0a24f}
*{box-sizing:border-box}
body{margin:0;background:var(--page);color:var(--ink);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:980px;margin:0 auto;padding:28px 16px 64px;display:grid;gap:34px}
h1,h2,h3{margin:0;line-height:1.2;text-wrap:balance}h1{font-size:1.7rem}h2{font-size:1.2rem;padding-bottom:6px;border-bottom:1px solid var(--grid)}h3{font-size:1rem}
p{margin:0;max-width:72ch}section{display:grid;gap:12px;min-width:0}
.eyebrow{font-size:.75rem;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}.meta{color:var(--ink-2);font-size:.9rem}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}
.tile{background:var(--surface);border:1px solid var(--ring);border-radius:8px;padding:12px 14px;display:grid;gap:2px}
.tile b{font-size:1.35rem;font-weight:600}.tile span{color:var(--ink-2);font-size:.82rem}
.wrap{overflow-x:auto;background:var(--surface);border:1px solid var(--ring);border-radius:8px}
table{border-collapse:collapse;width:100%;font-size:.86rem}th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--grid);vertical-align:top}
th{font-size:.72rem;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);white-space:nowrap}tr:last-child td{border-bottom:0}
td.n{font-variant-numeric:tabular-nums;white-space:nowrap;text-align:right}th.n{text-align:right}
.pill{font-size:.72rem;font-weight:600;padding:2px 8px;border-radius:999px;border:1px solid currentColor;white-space:nowrap}
.better{color:var(--good)}.worse{color:var(--bad)}.within,.unknown{color:var(--muted)}
.chart{background:var(--surface);border:1px solid var(--ring);border-radius:8px;padding:12px}
.chart svg{display:block;width:100%;height:auto}.chart.wide{overflow-x:auto}.chart.wide svg{min-width:600px}
.legend{display:flex;flex-wrap:wrap;gap:14px;font-size:.82rem;color:var(--ink-2)}.key{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}
svg text{fill:var(--muted);font:11px system-ui,-apple-system,"Segoe UI",sans-serif}svg .lab{fill:var(--ink-2)}
.grid line{stroke:var(--grid);stroke-width:1}.axis{stroke:var(--axis);stroke-width:1}
.small{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px}
details summary{cursor:pointer;color:var(--ink-2)}
`;

function page(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}

const tile = (big, small) =>
  `<div class="tile"><b>${esc(big)}</b><span>${esc(small)}</span></div>`;

function table(head, rows, numeric = []) {
  return `<div class="wrap"><table><thead><tr>${head
    .map(
      (h, i) => `<th${numeric.includes(i) ? ' class="n"' : ""}>${esc(h)}</th>`,
    )
    .join("")}</tr></thead><tbody>${rows
    .map(
      (row) =>
        `<tr>${row
          .map(
            (cell, i) =>
              `<td${numeric.includes(i) ? ' class="n"' : ""}>${cell}</td>`,
          )
          .join("")}</tr>`,
    )
    .join("")}</tbody></table></div>`;
}

const pill = (v) =>
  `<span class="pill ${v}">${{ better: "▲ better", worse: "▼ worse", within: "≈ within spread", unknown: "n/a" }[v]}</span>`;

// --- charts -----------------------------------------------------------------

/** Clean axis ticks from 0 to past `max`; durations step in whole minutes or hours. */
function ticks(max, count = 4, unit = "") {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const steps =
    unit === "ms"
      ? [1, 5, 10, 15, 30, 60, 120, 180, 240, 360, 720].map((m) => m * 60_000)
      : [1, 2, 2.5, 5, 10].map((m) => m * 10 ** Math.floor(Math.log10(raw)));
  const step = steps.find((s) => s >= raw) ?? steps.at(-1);
  const out = [];
  for (let t = 0; t <= max + step * 0.001; t += step) out.push(t);
  if (out.at(-1) < max) out.push(out.at(-1) + step);
  return out;
}

/** A bar from the baseline: square at the left, its data end rounded (4px) when `round`. */
function barPath(x, y, w, h, round) {
  const r = round ? Math.min(4, w / 2, h / 2) : 0;
  return `M${x} ${y}h${w - r}${r ? `a${r} ${r} 0 0 1 ${r} ${r}` : ""}v${h - 2 * r}${r ? `a${r} ${r} 0 0 1 ${-r} ${r}` : ""}h${-(w - r)}z`;
}

/** Horizontal stacked bars: own (series 1) and child threads (series 2) per row. */
function tokenBars(rows) {
  const W = 760;
  const left = 170;
  const right = 90;
  const bar = 18;
  const gap = 14;
  const top = 8;
  const H = top + rows.length * (bar + gap) + 26;
  const max = Math.max(...rows.map((r) => r.own + r.child), 1);
  const axis = ticks(max);
  const x = (v) => left + (v / axis.at(-1)) * (W - left - right);
  const marks = rows
    .map((r, i) => {
      const y = top + i * (bar + gap);
      const ownW = Math.max(0, x(r.own) - left);
      const childW = r.child
        ? Math.max(0, x(r.own + r.child) - x(r.own) - 2)
        : 0;
      const tip = `${r.label}: ${tokens(r.own + r.child)} (own ${tokens(r.own)}, child threads ${tokens(r.child)})`;
      return `<g><title>${esc(tip)}</title>
<text class="lab" x="${left - 8}" y="${y + bar / 2 + 4}" text-anchor="end">${esc(r.label)}</text>
<path d="${barPath(left, y, ownW, bar, !childW)}" fill="var(--s1)"/>
${childW > 0 ? `<path d="${barPath(x(r.own) + 2, y, childW, bar, true)}" fill="var(--s2)"/>` : ""}
<text x="${x(r.own + r.child) + 6}" y="${y + bar / 2 + 4}">${esc(tokens(r.own + r.child))}</text></g>`;
    })
    .join("\n");
  const gridLines = axis
    .map(
      (t) =>
        `<line x1="${x(t)}" x2="${x(t)}" y1="${top - 4}" y2="${H - 22}"/><text x="${x(t)}" y="${H - 6}" text-anchor="middle">${tokens(t)}</text>`,
    )
    .join("");
  return `<div class="chart wide"><div class="legend"><span><i class="key" style="background:var(--s1)"></i>Own tokens</span><span><i class="key" style="background:var(--s2)"></i>Child threads</span></div>
<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Tokens per Work Item"><g class="grid">${gridLines}</g>${marks}</svg></div>`;
}

/** Each Work Item's span over the run, with outages and pauses shaded and holds marked. */
function timeline(card) {
  const start = Date.parse(card.startedAt);
  const end = Date.parse(card.endedAt);
  if (!(end > start)) return "";
  const rows = card.items.filter((i) => i.startedAt && i.endedAt);
  const W = 760;
  const left = 170;
  const right = 20;
  const bar = 14;
  const gap = 16;
  const top = 10;
  const H = top + rows.length * (bar + gap) + 28;
  const x = (at) =>
    left + ((Date.parse(at) - start) / (end - start)) * (W - left - right);
  const hours = [];
  for (
    let t = Math.ceil(start / 3_600_000) * 3_600_000;
    t <= end;
    t += 3_600_000
  )
    hours.push(new Date(t).toISOString());
  const every = Math.max(1, Math.ceil(hours.length / 8));
  const off = [
    ...card.totals.outages.map((o) => ({ ...o, what: "outage" })),
    ...card.totals.pauses.map((p) => ({ ...p, what: "paused" })),
  ]
    .map(
      (s) =>
        `<rect x="${x(s.from)}" y="${top - 6}" width="${Math.max(1.5, x(s.to) - x(s.from))}" height="${H - top - 16}" fill="var(--off)"><title>${esc(`${s.what} ${clock(s.from)}–${clock(s.to)} UTC (${duration(s.ms)}), excluded from active time`)}</title></rect>`,
    )
    .join("");
  const holdsByItem = new Map();
  for (const d of card.operator.decisions) {
    const key = d.item ?? "";
    holdsByItem.set(key, [...(holdsByItem.get(key) ?? []), d]);
  }
  const marks = rows
    .map((item, i) => {
      const y = top + i * (bar + gap);
      const holds = (holdsByItem.get(item.id) ?? [])
        .map(
          (d) =>
            `<circle cx="${x(d.askedAt)}" cy="${y + bar / 2}" r="4" fill="${d.policy ? "var(--surface)" : "var(--ink)"}" stroke="${d.policy ? "var(--ink-2)" : "var(--surface)"}" stroke-width="2"><title>${esc(`${d.kind} hold at ${clock(d.askedAt)} UTC, ${d.answer ? `answered ${d.answer} after ${duration(d.waitMs)}` : "open"}${d.policy ? " (the policy's kind)" : ""}`)}</title></circle>`,
        )
        .join("");
      return `<text class="lab" x="${left - 8}" y="${y + bar / 2 + 4}" text-anchor="end">${esc(item.id)}</text>
<rect x="${x(item.startedAt)}" y="${y}" width="${Math.max(2, x(item.endedAt) - x(item.startedAt))}" height="${bar}" rx="4" fill="var(--s1)"><title>${esc(`${item.id}: ${clock(item.startedAt)}–${clock(item.endedAt)} UTC, active ${duration(item.activeWallMs)}`)}</title></rect>${holds}`;
    })
    .join("\n");
  const axis = hours
    .filter((_, i) => i % every === 0)
    .map(
      (h) =>
        `<line x1="${x(h)}" x2="${x(h)}" y1="${top - 6}" y2="${H - 22}"/><text x="${x(h)}" y="${H - 6}" text-anchor="middle">${clock(h)}</text>`,
    )
    .join("");
  return `<div class="chart wide"><div class="legend"><span><i class="key" style="background:var(--s1)"></i>Work Item, first step to merge</span><span><i class="key" style="background:var(--off)"></i>Outage or pause (excluded)</span><span>● hold for the operator</span><span>○ hold of a kind the policy answers</span></div>
<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Timeline of the Work Items, UTC"><g class="grid">${axis}</g>${off}${marks}</svg></div>`;
}

/** One metric across runs: a dot per run, each group's median and min–max band, x in run order grouped. */
function historyChart(metricId, cards, baselineGroup) {
  const metric = METRICS[metricId];
  const groups = [];
  for (const card of cards) {
    const group = groups.find((g) => g.name === card.run.group);
    if (group) group.cards.push(card);
    else groups.push({ name: card.run.group, cards: [card] });
  }
  const W = 340;
  const H = 200;
  const left = 58;
  const right = 10;
  const top = 12;
  const bottom = 44;
  const values = cards.map(metric.get).filter((v) => v !== null);
  const max = metric.unit === "rate" ? 1 : Math.max(...values, 0) * 1.1 || 1;
  const axis =
    metric.unit === "rate"
      ? [0, 0.25, 0.5, 0.75, 1]
      : ticks(max, 4, metric.unit);
  const y = (v) => H - bottom - (v / axis.at(-1)) * (H - top - bottom);
  const slots = cards.length + groups.length - 1;
  const slot = (W - left - right) / Math.max(slots, 1);
  let at = 0;
  const parts = [];
  for (const [g, group] of groups.entries()) {
    if (g) at += 1;
    const x0 = left + at * slot;
    const s = spread(group.cards.map(metric.get));
    const x1 = x0 + group.cards.length * slot;
    if (s) {
      parts.push(
        `<rect x="${x0 + 2}" y="${y(s.max)}" width="${x1 - x0 - 4}" height="${Math.max(2, y(s.min) - y(s.max))}" fill="var(--band)"><title>${esc(`${group.name}: ${s.n} run(s), median ${value(metric.unit, s.median)}, ${value(metric.unit, s.min)} to ${value(metric.unit, s.max)}`)}</title></rect>`,
        `<line x1="${x0 + 2}" x2="${x1 - 2}" y1="${y(s.median)}" y2="${y(s.median)}" stroke="var(--s1)" stroke-width="2"/>`,
      );
    }
    for (const card of group.cards) {
      const v = metric.get(card);
      const cx = left + (at + 0.5) * slot;
      if (v !== null)
        parts.push(
          `<circle cx="${cx}" cy="${y(v)}" r="4.5" fill="var(--s1)" stroke="var(--surface)" stroke-width="2"><title>${esc(`${card.run.label}: ${value(metric.unit, v)}`)}</title></circle>`,
        );
      at += 1;
    }
    const room = Math.max(8, Math.floor((x1 - x0) / 6.5));
    const label =
      group.name.length > room
        ? `${group.name.slice(0, room - 1)}…`
        : group.name;
    parts.push(
      `<text class="lab" x="${(x0 + x1) / 2}" y="${H - bottom + 16}" text-anchor="middle">${esc(label)}</text>`,
      `<text x="${(x0 + x1) / 2}" y="${H - bottom + 30}" text-anchor="middle">${group.cards.length} run${group.cards.length === 1 ? "" : "s"}${group.name === baselineGroup ? " · baseline" : ""}</text>`,
    );
  }
  const grid = axis
    .map(
      (t) =>
        `<line x1="${left}" x2="${W - right}" y1="${y(t)}" y2="${y(t)}"/><text x="${left - 6}" y="${y(t) + 4}" text-anchor="end">${esc(value(metric.unit, t))}</text>`,
    )
    .join("");
  return `<div class="chart"><h3>${esc(metric.label)} <span class="meta">(${metric.better} is better)</span></h3>
<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(metric.label)} per run"><g class="grid">${grid}</g><line class="axis" x1="${left}" x2="${W - right}" y1="${H - bottom}" y2="${H - bottom}"/>${parts.join("")}</svg></div>`;
}

// --- run report -------------------------------------------------------------

/** The baseline runs a card is compared with: the baseline group, without the card itself. */
export function baselineOf(card, cards, definition) {
  return cards.filter(
    (c) => c.run.group === definition.baseline && c.run.id !== card.run.id,
  );
}

function itemRows(card) {
  return card.items.map((i) => [
    esc(i.id),
    esc(i.outcome),
    i.criteria ?? "n/a",
    tokens(i.tokens.total),
    tokens(i.tokens.childThreads),
    tokens(i.tokensPerCriterion),
    duration(i.activeWallMs),
    duration(i.modelMs),
    i.repairs,
    `${i.holds.total} (${i.holds.operator})`,
    `${i.validation.runs} (${i.validation.passed})`,
    `${i.ci.published} / ${i.ci.rounds} (${i.ci.passedFirstTime})`,
    `${i.reviews.runs} (${i.reviews.passed})`,
  ]);
}

export function runReport(card, cards, definition) {
  const t = card.totals;
  const baseline = baselineOf(card, cards, definition);
  const isBaseline = card.run.group === definition.baseline;
  const rows = compare(baseline, [card], SHOWN);
  const decision =
    !isBaseline && baseline.length
      ? verdict(definition, baseline, [card])
      : null;
  const objectiveTokens = card.objective?.tokens;
  const bars = [
    ...card.items.map((i) => ({
      label: i.id,
      own: i.tokens.own,
      child: i.tokens.childThreads,
    })),
    ...(objectiveTokens
      ? [
          {
            label: "Objective (planning, final)",
            own: objectiveTokens.own,
            child: objectiveTokens.childThreads,
          },
        ]
      : []),
  ];
  const kinds = Object.entries(t.holds.byKind).sort(
    (a, b) => b[1].count - a[1].count,
  );
  const body = `
<header style="display:grid;gap:8px">
<span class="eyebrow">Benchmark ${esc(card.benchmark)} · run ${esc(card.run.id)} · ${esc(card.run.source)}</span>
<h1>${esc(card.run.label)}</h1>
<p class="meta">${esc(card.run.repository)}#${card.run.issue}, ${time(card.startedAt)} to ${time(card.endedAt)}. Factory ${esc(card.factory.versions.join(" → "))} (${esc(
    Object.entries(card.factory.commits)
      .map(([v, c]) => `${v} ${c ? c.slice(0, 8) : "commit unknown"}`)
      .join(", "),
  )}). Models: ${esc(card.models.map((m) => `${m.role} ${m.provider} ${m.model} ${m.effort} (${m.calls} calls)`).join("; "))}. Outcome: <b>${esc(card.outcome)}</b>.</p>
</header>
<section>
<div class="tiles">
${tile(tokens(t.tokens.total), `tokens, own ${tokens(t.tokens.own)} + child threads ${tokens(t.tokens.childThreads)}`)}
${tile(duration(t.activeWallMs), `active wall time; ${duration(t.wallMs)} span, ${duration(t.excludedMs)} excluded`)}
${tile(duration(t.modelMs), "model time, summed over calls")}
${tile(tokens(t.tokensPerCriterion), `tokens per criterion (${t.criteria ?? "n/a"} criteria)`)}
${tile(String(t.repairs), "repairs")}
${tile(`${t.holds.operator} + ${t.holds.scripted}`, `holds: for the operator + of the policy's kinds; ${duration(t.holds.operatorWaitMs)} operator wait`)}
${tile(percent(t.validation.firstPassRate), `validation runs passed (${t.validation.passed} of ${t.validation.runs})`)}
${tile(percent(t.ci.firstPassRate), `CI first-pass (${t.ci.passedFirstTime} of ${t.ci.published} pushes, ${t.ci.rounds} rounds)`)}
</div>
</section>
<section>
<h2>Against the baseline</h2>
${
  baseline.length
    ? `<p class="meta">Baseline: ${esc(definition.baseline)}, ${baseline.length} run(s). Better or worse means beyond the baseline's whole spread.</p>
${table(
  ["Metric", "This run", "Baseline median", "Baseline range", "Verdict"],
  rows.map((r) => [
    esc(r.label),
    esc(value(r.unit, r.candidate?.median)),
    esc(value(r.unit, r.baseline?.median)),
    r.baseline
      ? esc(
          `${value(r.unit, r.baseline.min)} – ${value(r.unit, r.baseline.max)}`,
        )
      : "n/a",
    pill(r.verdict),
  ]),
  [1, 2, 3],
)}
${decision ? `<p><b>Hill-climb: ${decision.accept ? "accept" : "reject"}.</b> ${esc([...decision.reasons, ...decision.warnings].join("; ") || "Every primary metric is better and no guard is worse.")}</p>` : ""}`
    : `<p class="meta">${isBaseline ? `This run is the baseline (${esc(definition.baseline)}) and the only run in it: later runs are compared with it.` : `No baseline runs (${esc(definition.baseline)}) in the results yet.`}</p>`
}
</section>
<section>
<h2>Tokens per Work Item</h2>
${tokenBars(bars)}
${table(
  [
    "Work Item",
    "Outcome",
    "Criteria",
    "Tokens",
    "Child threads",
    "Per criterion",
    "Active time",
    "Model time",
    "Repairs",
    "Holds (operator)",
    "Validation (passed)",
    "CI pushes / rounds (first pass)",
    "Reviews (passed)",
  ],
  itemRows(card),
  [2, 3, 4, 5, 6, 7, 8],
)}
<p class="meta">Tokens include child threads (Codex sub-agents), each counted once: a resumed session's cumulative child threads count only what they added. An amendment's planning is charged to the Work Item whose worker proposed it. Validation counts Factory's validate step; each run checks a new result.</p>
</section>
<section>
<h2>Timeline</h2>
${timeline(card)}
</section>
<section>
<h2>Holds and operator decisions</h2>
${table(
  ["Kind", "Holds", "Answered by policy", "Wait"],
  kinds.map(([kind, k]) => [
    esc(kind),
    k.count,
    k.scripted ? "yes" : "no, the operator",
    duration(k.waitMs),
  ]),
  [1, 3],
)}
<details><summary>Every decision (${card.operator.decisions.length} holds, ${card.operator.actions.length} other operator actions)</summary>
${table(
  ["Asked", "Kind", "Step", "Answer", "Wait", "By"],
  [
    ...card.operator.decisions.map((d) => [
      esc(time(d.askedAt)),
      esc(d.kind),
      esc(d.step ?? ""),
      esc(d.answer ?? "open"),
      duration(d.waitMs),
      esc([d.by, d.as].filter(Boolean).join(" as ") || ""),
    ]),
    ...card.operator.actions.map((a) => [
      esc(time(a.at)),
      esc(a.kind),
      esc(a.item ?? ""),
      esc(a.answer ?? ""),
      "",
      esc([a.by, a.as].filter(Boolean).join(" as ")),
    ]),
  ],
  [4],
)}
</details>
</section>
<section>
<h2>Outages and pauses</h2>
${
  t.outages.length || t.pauses.length
    ? table(
        ["What", "From", "To", "Length"],
        [
          ...t.outages.map((o) => [
            `outage after a run ended ${esc(o.runEnd)}`,
            esc(time(o.from)),
            esc(time(o.to)),
            esc(`${Math.round(o.ms / 1000)} s`),
          ]),
          ...t.pauses.map((p) => [
            "operator pause",
            esc(time(p.from)),
            esc(time(p.to)),
            duration(p.ms),
          ]),
        ],
        [3],
      )
    : "<p>None.</p>"
}
</section>
<section>
<h2>Telemetry</h2>
${table(
  ["Measure", "Value"],
  [
    [
      "Model calls (tokens unknown)",
      `${t.tokens.calls} (${t.tokens.unknownCalls})`,
    ],
    [
      "Counted by the spend limit (log) / spend ledger",
      `${tokens(t.tokens.counted)} / ${tokens(t.tokens.spendLedger)}`,
    ],
    [
      "Input, cached, uncached, output, reasoning",
      [
        t.tokens.input,
        t.tokens.cached,
        t.tokens.uncached,
        t.tokens.output,
        t.tokens.reasoning,
      ]
        .map(tokens)
        .join(", "),
    ],
    ["Cache hit rate (cached of input)", percent(t.cacheHitRate)],
    [
      "Planning rounds, revisions",
      `${t.planning.rounds}, ${t.planning.revisions}`,
    ],
    [
      "Amendments proposed (accepted, rejected, unchanged)",
      `${t.amendments.proposed} (${t.amendments.accepted}, ${t.amendments.rejected}, ${t.amendments.unchanged})`,
    ],
    [
      "Final validation, final review",
      `${t.final.passed} of ${t.final.runs} passed; ${t.final.review ? `${t.final.review.outcome}, ${t.final.review.criteria} criteria` : "n/a"}`,
    ],
    [
      "Hedged calls (lost, tokens)",
      (() => {
        const h = Object.values(card.telemetry.hedges ?? {});
        return `${h.reduce((s, x) => s + x.hedged, 0)} (${h.reduce((s, x) => s + x.lost, 0)}, ${tokens(h.reduce((s, x) => s + x.tokens, 0))})`;
      })(),
    ],
    [
      "Validation commands (failed), time",
      `${card.telemetry.validationCommands.commands} (${card.telemetry.validationCommands.failed}), ${duration(card.telemetry.validationCommands.ms)}`,
    ],
    [
      "Retry waits (time)",
      `${card.telemetry.retries.waits} (${duration(card.telemetry.retries.waitMs)})`,
    ],
    [
      "GitHub requests (failed, rate-limited)",
      `${card.telemetry.github.calls} (${card.telemetry.github.failed}, ${card.telemetry.github.rateLimited})`,
    ],
    ["Cost", t.costUsd === null ? "n/a" : `$${t.costUsd.toFixed(2)}`],
  ].map(([a, b]) => [esc(a), esc(b)]),
)}
</section>
<section>
<h2>Checks and gaps</h2>
${table(
  ["Against Factory's diagnostics", "Scorecard", "Diagnostics", ""],
  card.checks.map((c) => [
    esc(c.name),
    esc(c.scorecard),
    esc(c.diagnostics),
    c.ok ? "agree" : '<b class="worse">differ</b>',
  ]),
  [1, 2],
)}
${card.unavailable.length ? `<ul>${card.unavailable.map((u) => `<li><b>${esc(u.metric)}</b>: ${esc(u.reason)}</li>`).join("")}</ul>` : ""}
</section>`;
  return page(`${card.benchmark} ${card.run.id}`, body);
}

export function runMarkdown(card, cards, definition) {
  const t = card.totals;
  const baseline = baselineOf(card, cards, definition);
  const lines = [
    `# ${card.run.label}`,
    "",
    `Benchmark \`${card.benchmark}\`, run \`${card.run.id}\` (${card.run.source}): ${card.run.repository}#${card.run.issue}, ${time(card.startedAt)} to ${time(card.endedAt)}, Factory ${card.factory.versions.join(" → ")}. Outcome: **${card.outcome}**.`,
    "",
    "| Metric | This run |",
    "| --- | ---: |",
    `| Tokens (own + child threads) | ${tokens(t.tokens.total)} (${tokens(t.tokens.own)} + ${tokens(t.tokens.childThreads)}) |`,
    `| Active wall time (span, excluded) | ${duration(t.activeWallMs)} (${duration(t.wallMs)}, ${duration(t.excludedMs)}) |`,
    `| Model time | ${duration(t.modelMs)} |`,
    `| Tokens per criterion | ${tokens(t.tokensPerCriterion)} |`,
    `| Repairs | ${t.repairs} |`,
    `| Holds (for the operator, policy's kinds) | ${t.holds.total} (${t.holds.operator}, ${t.holds.scripted}) |`,
    `| Validation runs passed | ${t.validation.passed} of ${t.validation.runs} |`,
    `| CI first-pass | ${t.ci.passedFirstTime} of ${t.ci.published} |`,
    "",
  ];
  if (baseline.length) {
    lines.push(
      `Against the baseline (${definition.baseline}, ${baseline.length} run(s)):`,
      "",
      "| Metric | This run | Baseline median | Range | Verdict |",
      "| --- | ---: | ---: | ---: | --- |",
      ...compare(baseline, [card], SHOWN).map(
        (r) =>
          `| ${r.label} | ${value(r.unit, r.candidate?.median)} | ${value(r.unit, r.baseline?.median)} | ${r.baseline ? `${value(r.unit, r.baseline.min)} – ${value(r.unit, r.baseline.max)}` : "n/a"} | ${r.verdict} |`,
      ),
      "",
    );
  } else
    lines.push(
      card.run.group === definition.baseline
        ? "This run is the baseline."
        : "No baseline runs yet.",
      "",
    );
  lines.push(
    "| Work Item | Tokens | Child threads | Active time | Repairs | Holds | Validation (passed) |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...card.items.map(
      (i) =>
        `| ${i.id} | ${tokens(i.tokens.total)} | ${tokens(i.tokens.childThreads)} | ${duration(i.activeWallMs)} | ${i.repairs} | ${i.holds.total} | ${i.validation.runs} (${i.validation.passed}) |`,
    ),
    "",
  );
  return `${lines.join("\n")}\n`;
}

// --- history ----------------------------------------------------------------

export function historyPage(cards, definition) {
  const sorted = [...cards].sort((a, b) =>
    (a.startedAt ?? "").localeCompare(b.startedAt ?? ""),
  );
  const body = `
<header style="display:grid;gap:8px">
<span class="eyebrow">Benchmark history</span>
<h1>${esc(definition.title)}</h1>
<p class="meta">${sorted.length} run(s) of <code>${esc(definition.id)}</code>, in the order they ran, grouped by Factory build. Each dot is a run; a band is a group's spread (min to max) and its line the median. Baseline: ${esc(definition.baseline)}. A candidate is accepted only when its primary metrics (${esc(definition.hillClimb.primary.join(", "))}) are better than the baseline's whole spread and no guard (${esc(definition.hillClimb.guards.join(", "))}) is worse.</p>
</header>
<section class="small">
${SHOWN.map((id) => historyChart(id, sorted, definition.baseline)).join("\n")}
</section>
<section>
<h2>Runs</h2>
${table(
  [
    "Run",
    "Group",
    "Started",
    "Factory",
    "Outcome",
    ...SHOWN.map((id) => METRICS[id].label),
  ],
  sorted.map((c) => [
    esc(c.run.id),
    esc(c.run.group),
    esc(time(c.startedAt)),
    esc(c.factory.versions.join(" → ")),
    esc(c.outcome),
    ...SHOWN.map((id) => esc(value(METRICS[id].unit, METRICS[id].get(c)))),
  ]),
  SHOWN.map((_, i) => i + 5),
)}
</section>`;
  return page(`${definition.id} history`, body);
}

export function historyMarkdown(cards, definition) {
  const sorted = [...cards].sort((a, b) =>
    (a.startedAt ?? "").localeCompare(b.startedAt ?? ""),
  );
  return `${[
    `# ${definition.title}: history`,
    "",
    `${sorted.length} run(s); baseline: ${definition.baseline}.`,
    "",
    `| Run | Group | Outcome | ${SHOWN.map((id) => METRICS[id].label).join(" | ")} |`,
    `| --- | --- | --- | ${SHOWN.map(() => "---:").join(" | ")} |`,
    ...sorted.map(
      (c) =>
        `| ${c.run.id} | ${c.run.group} | ${c.outcome} | ${SHOWN.map((id) => value(METRICS[id].unit, METRICS[id].get(c))).join(" | ")} |`,
    ),
  ].join("\n")}\n`;
}
