/**
 * Reports from scorecards: a run against its baseline (HTML and Markdown)
 * and a benchmark's history across runs and Factory versions (HTML and
 * Markdown). The HTML is one self-contained file: inline CSS and SVG, no
 * script, font or image from the network, light and dark from the
 * viewer's setting. Every number comes from a scorecard; a null shows as
 * "n/a", never 0.
 */
import {
  compare,
  DIAGNOSTICS,
  graderMetric,
  graderMetricNames,
  isCurrent,
  isPartial,
  METRICS,
  OUTCOMES,
  SHOWN,
  spread,
  verdict,
} from "./metrics.mjs";
import { WASTE_CAUSES, WEIGHTS } from "./outcomes.mjs";

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

export const usd = (v) =>
  v === null || v === undefined ? "n/a" : `$${v.toFixed(2)}`;

export function value(unit, v) {
  if (v === null || v === undefined) return "n/a";
  if (unit === "tokens") return tokens(v);
  if (unit === "ms") return duration(v);
  if (unit === "rate") return percent(v);
  if (unit === "usd") return usd(v);
  // A grader's metric: as it reported it, to three decimals.
  if (unit === "number") return String(Number(v.toFixed(3)));
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/** The grader's metrics of a grade, as `name value` text. */
const gradeMetrics = (grade) =>
  Object.entries(grade?.metrics ?? {})
    .map(([name, v]) => `${name} ${value("number", v)}`)
    .join(", ");

/** What a reviewing grader (#2273) found of a grade, as text: verified findings and surviving mutants; "" for a grader that reports neither. */
const gradeReview = (grade) =>
  [
    ...(grade?.findings
      ? [
          `${grade.findings.length} verified finding(s), ${grade.findings.filter((f) => f.severity === "defect").length} defect(s)`,
        ]
      : []),
    ...(grade?.mutation
      ? [
          `${grade.mutation.survived} of ${grade.mutation.survived + grade.mutation.killed} mutant(s) survived`,
        ]
      : []),
  ].join(", ");

const time = (at) => (at ? `${at.slice(0, 16).replace("T", " ")} UTC` : "n/a");
const clock = (at) => (at ? at.slice(11, 16) : "");
/** A card's outcome, marked when the card is partial or of an older version. */
const outcomeOf = (card) =>
  `${card.outcome}${isPartial(card) ? " (partial)" : ""}${isCurrent(card) ? "" : ` (scorecard v${card.schemaVersion}: rescore)`}`;
const PARTIAL_NOTE =
  "This run hadn't ended when it was scored: its totals cover the run so far and are lower only because it is unfinished. It is left out of every comparison.";
const RESCORE_NOTE =
  "This card is of an older scorecard version: it has no outcome metrics (grade, human effort, time to delivery, waste, escapes, cost), and it is left out of every comparison. Score it again with bench/score.mjs.";
const ACCEPT_RULE =
  "A candidate is accepted when its grade is not worse, its human effort or its time to delivery is better, its stage escapes are not worse, and its cost is not worse (skipped, with a warning, when the cost is unknown on both sides); better or worse means beyond the baseline's whole spread. With a judge, its blind pairwise intent win rate is not below 50% too. Waste and the grader's own metrics are shown, and the effort metrics after them are diagnostics: they don't decide.";

/** One line per outcome of `card`, label then value then detail (null: an older card). */
export function outcomeLines(card) {
  if (!isCurrent(card)) return null;
  const { grade, human, delivery, waste, escapes, cost } = card;
  const gradeGap = card.unavailable.find((g) => g.metric === "grade");
  return [
    [
      "Grade",
      grade?.error ? "error" : percent(grade?.passRate),
      grade
        ? grade.error
          ? `the grader failed: ${grade.error}`
          : `${grade.passed} passed, ${grade.failed} failed, ${grade.unknown} unknown of ${grade.criteria.length} criteria at ${grade.commit.slice(0, 12)} (${grade.graderVersion})${gradeMetrics(grade) ? `; ${gradeMetrics(grade)}` : ""}${gradeReview(grade) ? `; ${gradeReview(grade)}` : ""}`
        : `not graded: ${gradeGap?.reason ?? "no grade"}`,
    ],
    [
      "Human effort",
      String(human.score),
      `${human.stamps} stamp(s) × ${WEIGHTS.stamp}, ${human.judgments} judgment(s) × ${WEIGHTS.judgment}${human.scriptedJudgments ? ` (${human.scriptedJudgments} scripted)` : ""}, ${human.handFixes} hand fix(es) × ${WEIGHTS.handFix}; ${human.unattended ? "unattended" : "attended"}`,
    ],
    [
      "Time to delivery",
      duration(card.deliveryMs),
      `active ${duration(delivery.activeWallMs)} + ${delivery.questions} question(s) for the operator × ${duration(delivery.questionChargeMs)}`,
    ],
    [
      "Waste",
      percent(waste.tokensShare),
      `${tokens(waste.tokens)} tokens and ${duration(waste.modelMs)} of model time (${percent(waste.modelMsShare)}) on work that didn't reach the result`,
    ],
    [
      "Stage escapes",
      String(escapes.total),
      `${escapes.finalReviewRefusals} final-review refusal(s), ${escapes.handFixesAfterFinalReview} hand fix(es) after final review, ${escapes.graderFailedPassed ?? "n/a"} criteria the grader failed that final review passed, ${escapes.graderDefects ?? "n/a"} verified defect(s) in the result final review passed`,
    ],
    [
      "Cost",
      usd(cost?.usd),
      cost
        ? cost.usd === null
          ? `the definition prices no ${cost.unpriced.join(", ")}`
          : "at the definition's prices"
        : "the definition has no prices",
    ],
  ];
}

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
    ...(card.totals.holdBlocked ?? []).map((b) => ({
      ...b,
      what: "waiting on an answer, nothing running",
    })),
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
  return `<div class="chart wide"><div class="legend"><span><i class="key" style="background:var(--s1)"></i>Work Item, first step to merge</span><span><i class="key" style="background:var(--off)"></i>Outage, pause, or waiting on an answer with nothing running (excluded)</span><span>● hold for the operator</span><span>○ hold of a kind the policy answers</span></div>
<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Timeline of the Work Items, UTC"><g class="grid">${axis}</g>${off}${marks}</svg></div>`;
}

/** One metric (METRICS's, or a grader's) across runs: a dot per run, each group's median and min–max band, x in run order grouped. */
function historyChart(metric, cards, baselineGroup) {
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
    // A partial card is plotted, hollow, but left out of its group's spread.
    const s = spread(
      group.cards.filter((card) => !isPartial(card)).map(metric.get),
    );
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
          isPartial(card)
            ? `<circle cx="${cx}" cy="${y(v)}" r="4" fill="var(--surface)" stroke="var(--s1)" stroke-width="2" stroke-dasharray="2 2"><title>${esc(`${card.run.label}: ${value(metric.unit, v)} so far (partial: ${card.outcome}, not ended; left out of the spread)`)}</title></circle>`
            : `<circle cx="${cx}" cy="${y(v)}" r="4.5" fill="var(--s1)" stroke="var(--surface)" stroke-width="2"><title>${esc(`${card.run.label}: ${value(metric.unit, v)}`)}</title></circle>`,
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
  return `<div class="chart"><h3>${esc(metric.label)} <span class="meta">(${metric.better ? `${metric.better} is better` : "the grader's measure"})</span></h3>
<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(metric.label)} per run"><g class="grid">${grid}</g><line class="axis" x1="${left}" x2="${W - right}" y1="${H - bottom}" y2="${H - bottom}"/>${parts.join("")}</svg></div>`;
}

// --- run report -------------------------------------------------------------

/** The baseline runs a card is compared with: the baseline group's ended runs of this scorecard version, without the card itself. */
export function baselineOf(card, cards, definition) {
  return cards.filter(
    (c) =>
      c.run.group === definition.baseline &&
      c.run.id !== card.run.id &&
      !isPartial(c) &&
      isCurrent(c),
  );
}

/** A short text of a grader's evidence, whatever its shape. */
const evidence = (value) => {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 240 ? `${text.slice(0, 239)}…` : text;
};

/** The outcome sections of a run report: the grade, human effort, waste and cost (current cards only). */
function outcomeSections(card) {
  if (!isCurrent(card)) return "";
  const { grade, human, waste, cost } = card;
  const touches = [
    ...card.operator.decisions
      .filter((d) => d.touch)
      .map((d) => [
        d.answeredAt,
        d.scripted ? `${d.touch}, scripted` : d.touch,
        `${d.answer} to a ${d.kind} hold${d.step ? ` (${d.step})` : ""}`,
        [d.by, d.as].filter(Boolean).join(" as "),
      ]),
    ...card.operator.actions.map((a) => [
      a.at,
      a.scripted ? `${a.touch}, scripted` : (a.touch ?? ""),
      `${a.kind}${a.answer ? ` ${a.answer}` : ""}${a.item ? ` (${a.item})` : ""}`,
      [a.by, a.as].filter(Boolean).join(" as "),
    ]),
    ...human.fixes.map((f) => [
      f.at,
      "hand fix",
      `commit ${f.sha.slice(0, 12)} on the default branch${f.afterFinalReview ? ", after final review" : ""}`,
      f.from === "given"
        ? "given with --hand-fix"
        : "the run repository's history",
    ]),
  ].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const wasteRows = (rows) =>
    rows.map(([name, row]) => [
      esc(name),
      esc(tokens(row.tokens)),
      esc(duration(row.modelMs)),
      String(row.calls),
    ]);
  return `
<section>
<h2>Grade</h2>
${
  grade?.criteria?.length
    ? table(
        ["Criterion", "Verdict", "Method", "Evidence"],
        grade.criteria.map((c) => [
          `<b>${esc(c.id)}</b>${c.text ? ` ${esc(c.text)}` : ""}`,
          `<span class="${c.verdict === "pass" ? "better" : c.verdict === "fail" ? "worse" : "unknown"}">${esc(c.verdict)}</span>`,
          esc(c.method ?? ""),
          esc(evidence(c.evidence)),
        ]),
      )
    : `<p class="meta">${esc(outcomeLines(card)[0][2])}</p>`
}
${
  Object.keys(grade?.metrics ?? {}).length
    ? table(
        ["Grader metric", "Value"],
        Object.entries(grade.metrics).map(([name, v]) => [
          esc(name),
          esc(value("number", v)),
        ]),
        [1],
      )
    : ""
}
${
  grade?.findings
    ? `<h3>Verified findings</h3>
<p class="meta">Problems the grader's reviewers reported and its verifier reproduced on the graded commit: a <b>defect</b> violates a criterion the Objective states. ${grade.mutation ? esc(`${grade.mutation.survived} of ${grade.mutation.survived + grade.mutation.killed} mutants of the changed lines survived the delivered tests.`) : ""}</p>
${
  grade.findings.length
    ? table(
        ["Finding", "Severity", "Evidence", "Reproduce"],
        grade.findings.map((f) => [
          `<b>${esc(f.id)}</b>${f.title ? ` ${esc(f.title)}` : ""}`,
          `<span class="${f.severity === "defect" ? "worse" : "unknown"}">${esc(f.severity)}</span>`,
          esc(evidence(f.evidence)),
          esc(evidence(f.reproduce)),
        ]),
      )
    : "<p>None.</p>"
}`
    : ""
}
</section>
<section>
<h2>Human effort</h2>
<p class="meta">Every operator touch, weighted: a stamp (more, a plain retry, adopt, continue, pause, resume) ${WEIGHTS.stamp}, a judgment (an answer with text, accept, refuse, replan, repair, cancel, ...) ${WEIGHTS.judgment}, a hand fix (a commit on the default branch no Factory merge made) ${WEIGHTS.handFix}. ${human.policyStamps} of the stamps are on holds of the kinds the policy answers. ${human.scriptedJudgments ?? 0} of the judgments are the scripted operator's (bench/README.md#The scripted operator), weighed as an operator's would be.</p>
${
  touches.length
    ? table(
        ["When", "Touch", "What", "By"],
        touches.map(([at, touch, what, by]) => [
          esc(time(at)),
          esc(touch),
          esc(what),
          esc(by),
        ]),
      )
    : "<p>No operator touch: unattended.</p>"
}
</section>
<section>
<h2>Waste</h2>
<p class="meta">Calls whose work didn't reach the result: cut by an outage, a hedge that lost, an amendment rejected or left unchanged, or a result a later attempt of the same step made again (bench/README.md#Scorecard). ${tokens(waste.tokens)} tokens (${percent(waste.tokensShare)}) and ${duration(waste.modelMs)} of model time (${percent(waste.modelMsShare)}).</p>
<div class="small">
${table(
  ["Cause", "Tokens", "Model time", "Calls"],
  wasteRows(WASTE_CAUSES.map((cause) => [cause, waste.byCause[cause]])),
  [1, 2, 3],
)}
${table(["Work Item", "Tokens", "Model time", "Calls"], wasteRows(Object.entries(waste.byItem)), [1, 2, 3])}
</div>
</section>
${
  cost
    ? `<section>
<h2>Cost</h2>
${table(
  ["Model", "Calls", "Uncached input", "Cached input", "Output", "Cost"],
  Object.entries(cost.byModel).map(([model, row]) => [
    esc(model),
    String(row.calls),
    esc(tokens(row.uncachedInput)),
    esc(tokens(row.cachedInput)),
    esc(tokens(row.output)),
    esc(usd(row.usd)),
  ]),
  [1, 2, 3, 4, 5],
)}
</section>`
    : ""
}`;
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
    `${i.validation.passedFirstTime ?? "n/a"} of ${i.validation.results ?? "n/a"}; ${i.validation.runs} (${i.validation.passed})`,
    `${i.ci.published} / ${i.ci.rounds} (${i.ci.passedFirstTime}${i.ci.conflicts ? `; ${i.ci.conflicts} conflict` : ""})`,
    `${i.reviews.runs} (${i.reviews.passed})`,
  ]);
}

/** The source commits provisioning put on the base, so a reader sees it wasn't pristine. */
function basePatchesNote(card) {
  return `Base patches, on the base before the Objective was queued and never counted as hand fixes: ${card.run.basePatches
    .map(
      (patch) =>
        `${patch.commit.slice(0, 8)} as ${patch.applied.slice(0, 8)} (${patch.reason})`,
    )
    .join("; ")}.`;
}

export function runReport(card, cards, definition) {
  const t = card.totals;
  const baseline = baselineOf(card, cards, definition);
  const isBaseline = card.run.group === definition.baseline;
  const partial = isPartial(card);
  const current = isCurrent(card);
  const compared = !partial && current;
  const rows = compare(baseline, [card], SHOWN);
  const decision =
    !isBaseline && compared && baseline.length
      ? verdict(definition, baseline, [card])
      : null;
  const comparison = (ids) =>
    table(
      ["Metric", "This run", "Baseline median", "Baseline range", "Verdict"],
      rows
        .filter((r) => ids.includes(r.id))
        .map((r) => [
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
    );
  const outcomes = outcomeLines(card);
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
  )}). Models: ${esc(card.models.map((m) => `${m.role} ${m.provider} ${m.model} ${m.effort} (${m.calls} calls)`).join("; "))}. Outcome: <b>${esc(outcomeOf(card))}</b>.</p>
${card.run.basePatches ? `<p class="meta">${esc(basePatchesNote(card))}</p>` : ""}
${partial ? `<p class="worse"><b>Partial.</b> ${esc(PARTIAL_NOTE)}</p>` : ""}
${current ? "" : `<p class="worse"><b>Scorecard version ${esc(card.schemaVersion)}.</b> ${esc(RESCORE_NOTE)}</p>`}
</header>
${
  outcomes
    ? `<section>
<h2>Outcomes</h2>
<div class="tiles">
${outcomes.map(([label, big, small]) => tile(big, `${label}: ${small}`)).join("\n")}
</div>
</section>`
    : ""
}
<section>
<h2>Diagnostics</h2>
<div class="tiles">
${tile(tokens(t.tokens.total), `tokens, own ${tokens(t.tokens.own)} + child threads ${tokens(t.tokens.childThreads)}`)}
${tile(duration(t.activeWallMs), `active wall time; ${duration(t.wallMs)} span, ${duration(t.excludedMs)} excluded (${duration(t.downtimeMs)} down or paused, ${duration(t.holdBlockedMs)} waiting on answers)`)}
${tile(duration(t.modelMs), "model time, summed over calls")}
${tile(tokens(t.tokensPerCriterion), `tokens per criterion (${t.criteria ?? "n/a"} criteria)`)}
${tile(String(t.repairs), "repairs")}
${tile(`${t.holds.operator} + ${t.holds.scripted}`, `holds: for the operator + of the policy's kinds; ${duration(t.holds.operatorWaitMs)} operator wait`)}
${tile(percent(t.validation.firstPassRate), `results passing their first validation (${t.validation.passedFirstTime} of ${t.validation.results}); ${t.validation.passed} of ${t.validation.runs} runs passed, ${t.validation.holds} held`)}
${tile(percent(t.ci.firstPassRate), `CI first-pass (${t.ci.passedFirstTime} of ${t.ci.published - t.ci.conflicts} pushes whose checks ran; ${t.ci.conflicts} base conflict(s), ${t.ci.rounds} rounds)`)}
</div>
</section>
<section>
<h2>Against the baseline</h2>
${
  partial
    ? `<p class="meta">Not compared: the run is partial.</p>`
    : !current
      ? `<p class="meta">Not compared: the card is of an older scorecard version. Score it again.</p>`
      : baseline.length
        ? `<p class="meta">Baseline: ${esc(definition.baseline)}, ${baseline.length} run(s). ${esc(ACCEPT_RULE)}</p>
<h3>Outcomes</h3>
${comparison(OUTCOMES)}
<h3>Diagnostics</h3>
${comparison(DIAGNOSTICS)}
${decision ? `<p><b>Hill-climb: ${decision.accept ? "accept" : "reject"}.</b> ${esc([...decision.reasons, ...decision.warnings].join("; ") || "Grade and escapes not worse, human effort or time to delivery better, cost not worse.")}</p>` : ""}`
        : `<p class="meta">${isBaseline ? `This run is the baseline (${esc(definition.baseline)}) and the only run in it: later runs are compared with it.` : `No baseline runs (${esc(definition.baseline)}) of this scorecard version in the results yet.`}</p>`
}
</section>
${outcomeSections(card)}
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
    "First validation passed; runs (passed)",
    "CI pushes / rounds (first pass)",
    "Reviews (passed)",
  ],
  itemRows(card),
  [2, 3, 4, 5, 6, 7, 8],
)}
<p class="meta">Tokens include child threads (Codex sub-agents), each counted once: a resumed session's cumulative child threads count only what they added. An amendment's planning is charged to the Work Item whose worker proposed it. Active time leaves out the outages and pauses, and the item's waits for an answer while none of its steps ran. First validation: of the results the item's work produced, how many passed the first validate run that judged them (a retry validates the same result again, and is not counted); runs (passed) counts every validate verdict.</p>
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
<h2>Excluded from active time</h2>
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
    : "<p>No outages or pauses.</p>"
}
${
  (t.holdBlocked ?? []).length
    ? `<details><summary>${t.holdBlocked.length} stretch(es) waiting on an answer with nothing running, ${duration(t.holdBlockedMs)} beyond the outages and pauses</summary>
${table(
  ["From", "To", "Length"],
  t.holdBlocked.map((b) => [
    esc(time(b.from)),
    esc(time(b.to)),
    esc(b.ms < 60_000 ? `${Math.round(b.ms / 1000)} s` : duration(b.ms)),
  ]),
  [2],
)}
</details>`
    : ""
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
      "Hold waits without downtime (asked to answered)",
      `${duration(t.holds.waitMs)} (${duration(t.holds.rawWaitMs)})`,
    ],
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
      `${t.final.passed} of ${t.final.runs} passed; ${t.final.review ? `${t.final.review.outcome}, ${t.final.review.criteria} criteria` : "n/a"}${t.final.reviewPassed && t.final.review?.outcome !== "pass" ? "; passed on the operator's answers" : ""}`,
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
      "Worker Validate runs (targeted), edit to verdict (median), passing commands' share",
      t.workerValidation
        ? `${t.workerValidation.runs} (${t.workerValidation.targeted}), ${t.workerValidation.feedbackMs === null ? "n/a" : `${Math.round(t.workerValidation.feedbackMs / 1000)} s`},${percent(t.workerValidation.passedShare)}`
        : "n/a",
    ],
    [
      "Retry waits (time)",
      `${card.telemetry.retries.waits} (${duration(card.telemetry.retries.waitMs)})`,
    ],
    [
      "GitHub requests (failed, rate-limited)",
      `${card.telemetry.github.calls} (${card.telemetry.github.failed}, ${card.telemetry.github.rateLimited})`,
    ],
    ["Cost the provider reported", usd(t.costUsd)],
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
    `Benchmark \`${card.benchmark}\`, run \`${card.run.id}\` (${card.run.source}): ${card.run.repository}#${card.run.issue}, ${time(card.startedAt)} to ${time(card.endedAt)}, Factory ${card.factory.versions.join(" → ")}. Outcome: **${outcomeOf(card)}**.`,
    "",
    ...(card.run.basePatches ? [basePatchesNote(card), ""] : []),
    ...(isPartial(card) ? [`**Partial.** ${PARTIAL_NOTE}`, ""] : []),
    ...(isCurrent(card)
      ? [
          "| Outcome | This run | |",
          "| --- | ---: | --- |",
          ...outcomeLines(card).map(
            ([label, big, small]) => `| ${label} | ${big} | ${small} |`,
          ),
          "",
          ...(card.grade?.findings?.length
            ? [
                "Verified findings:",
                "",
                ...card.grade.findings.map(
                  (f) =>
                    `- **${f.severity}** ${f.id}${f.title ? `: ${f.title}` : ""}`,
                ),
                "",
              ]
            : []),
        ]
      : [`**Scorecard version ${card.schemaVersion}.** ${RESCORE_NOTE}`, ""]),
    "| Diagnostic | This run |",
    "| --- | ---: |",
    `| Tokens (own + child threads) | ${tokens(t.tokens.total)} (${tokens(t.tokens.own)} + ${tokens(t.tokens.childThreads)}) |`,
    `| Active wall time (span; down or paused, waiting on answers) | ${duration(t.activeWallMs)} (${duration(t.wallMs)}; ${duration(t.downtimeMs)}, ${duration(t.holdBlockedMs)}) |`,
    `| Model time | ${duration(t.modelMs)} |`,
    `| Tokens per criterion | ${tokens(t.tokensPerCriterion)} |`,
    `| Repairs | ${t.repairs} |`,
    `| Holds (for the operator, policy's kinds) | ${t.holds.total} (${t.holds.operator}, ${t.holds.scripted}) |`,
    `| Results passing their first validation | ${t.validation.passedFirstTime} of ${t.validation.results} |`,
    `| Validation runs passed (held) | ${t.validation.passed} of ${t.validation.runs} (${t.validation.holds}) |`,
    `| CI first-pass (base conflicts) | ${t.ci.passedFirstTime} of ${t.ci.published - t.ci.conflicts} (${t.ci.conflicts}) |`,
    "",
  ];
  if (isPartial(card))
    lines.push("Not compared with the baseline: the run is partial.", "");
  else if (!isCurrent(card))
    lines.push(
      "Not compared with the baseline: the card is of an older scorecard version.",
      "",
    );
  else if (baseline.length) {
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
    if (card.run.group !== definition.baseline) {
      const decision = verdict(definition, baseline, [card]);
      lines.push(
        `Hill-climb: **${decision.accept ? "accept" : "reject"}**${decision.reasons.length ? `: ${decision.reasons.join("; ")}` : ""}.`,
        "",
      );
    }
  } else
    lines.push(
      card.run.group === definition.baseline
        ? "This run is the baseline."
        : "No baseline runs yet.",
      "",
    );
  lines.push(
    "| Work Item | Tokens | Child threads | Active time | Repairs | Holds | First validation passed | Validation runs (passed) |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...card.items.map(
      (i) =>
        `| ${i.id} | ${tokens(i.tokens.total)} | ${tokens(i.tokens.childThreads)} | ${duration(i.activeWallMs)} | ${i.repairs} | ${i.holds.total} | ${i.validation.passedFirstTime} of ${i.validation.results} | ${i.validation.runs} (${i.validation.passed}) |`,
    ),
    "",
  );
  return `${lines.join("\n")}\n`;
}

// --- history ----------------------------------------------------------------

/** The history's columns: the outcomes and diagnostics, then each grader metric any card has. */
function historyColumns(cards) {
  return [
    ...SHOWN.map((id) => METRICS[id]),
    ...graderMetricNames(cards).map(graderMetric),
  ];
}

export function historyPage(cards, definition) {
  const sorted = [...cards].sort((a, b) =>
    (a.startedAt ?? "").localeCompare(b.startedAt ?? ""),
  );
  const columns = historyColumns(sorted);
  const graderMetrics = graderMetricNames(sorted);
  const body = `
<header style="display:grid;gap:8px">
<span class="eyebrow">Benchmark history</span>
<h1>${esc(definition.title)}</h1>
<p class="meta">${sorted.length} run(s) of <code>${esc(definition.id)}</code>, in the order they ran, grouped by Factory build. Each dot is a run; a band is a group's spread (min to max) and its line the median. Baseline: ${esc(definition.baseline)}. ${esc(ACCEPT_RULE)}${sorted.some(isPartial) ? " A hollow dot is a run that hadn't ended when it was scored (partial): it is left out of its group's spread and of every comparison." : ""}${sorted.some((c) => !isCurrent(c)) ? ` ${sorted.filter((c) => !isCurrent(c)).length} run(s) have cards of an older scorecard version, with no outcome metrics: score them again.` : ""}</p>
</header>
<section>
<h2>Outcomes</h2>
<div class="small">
${OUTCOMES.map((id) => historyChart(METRICS[id], sorted, definition.baseline)).join("\n")}
</div>
</section>
${
  graderMetrics.length
    ? `<section>
<h2>Grader metrics</h2>
<p class="meta">What the benchmark's grader measured besides its verdicts, such as the delivered tests' mutation score. Shown, never deciding.</p>
<div class="small">
${graderMetrics.map((name) => historyChart(graderMetric(name), sorted, definition.baseline)).join("\n")}
</div>
</section>`
    : ""
}
<section>
<h2>Diagnostics</h2>
<div class="small">
${DIAGNOSTICS.map((id) => historyChart(METRICS[id], sorted, definition.baseline)).join("\n")}
</div>
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
    ...columns.map((metric) => metric.label),
  ],
  sorted.map((c) => [
    esc(c.run.id),
    esc(c.run.group),
    esc(time(c.startedAt)),
    esc(c.factory.versions.join(" → ")),
    esc(outcomeOf(c)),
    ...columns.map((metric) => esc(value(metric.unit, metric.get(c)))),
  ]),
  columns.map((_, i) => i + 5),
)}
</section>`;
  return page(`${definition.id} history`, body);
}

export function historyMarkdown(cards, definition) {
  const sorted = [...cards].sort((a, b) =>
    (a.startedAt ?? "").localeCompare(b.startedAt ?? ""),
  );
  const columns = historyColumns(sorted);
  return `${[
    `# ${definition.title}: history`,
    "",
    `${sorted.length} run(s); baseline: ${definition.baseline}. ${ACCEPT_RULE}`,
    "",
    `| Run | Group | Outcome | ${columns.map((metric) => metric.label).join(" | ")} |`,
    `| --- | --- | --- | ${columns.map(() => "---:").join(" | ")} |`,
    ...sorted.map(
      (c) =>
        `| ${c.run.id} | ${c.run.group} | ${outcomeOf(c)} | ${columns.map((metric) => value(metric.unit, metric.get(c))).join(" | ")} |`,
    ),
  ].join("\n")}\n`;
}
