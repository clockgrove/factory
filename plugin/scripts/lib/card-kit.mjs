// The cards' shared look (#589): the words, figures and colours the finish card (finish-card.mjs) and a stage's progress
// comment (progress-card.mjs) both use, so the two read as one system. Money in cents (the exact figures stay in the
// hidden lines), durations, model names, what dollars are, the state vocabulary, badges, table cells, and the charts'
// Mermaid themes. Pure: no reads, no writes.
import { billingRead } from "./usage.mjs";
import { zoneOffsetMs } from "./clock.mjs";

/** A model id as a card may print it: model-id characters only, else null. */
export const modelId = (v) => (typeof v === "string" && /^[A-Za-z0-9._:/-]{1,80}$/.test(v) ? v : null);

/** The Pendulum mark the card shows, from the repository's own brand assets. */
export const MARK_URL = "https://raw.githubusercontent.com/clockgrove/pendulum/main/assets/brand/pendulum/web/mark-240.png";

/** The brand colours of the badges and charts. */
export const COLORS = Object.freeze({ amber: "c9822e", brown: "7a4a24", green: "4a7a3a", slate: "2b4a5f", ink: "b06f22" });

const pad = (v) => String(v).padStart(2, "0");
/** A duration as the card's prose and table say it: "59 s", "3 min 55 s", "2 h 5 min", "1 d 3 h". */
export function durationText(d) {
  const s = Math.max(0, Math.round(d / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}`;
  if (s < 86400) return `${Math.floor(s / 3600)} h${Math.floor((s % 3600) / 60) ? ` ${Math.floor((s % 3600) / 60)} min` : ""}`;
  return `${Math.floor(s / 86400)} d${Math.floor((s % 86400) / 3600) ? ` ${Math.floor((s % 86400) / 3600)} h` : ""}`;
}
/** The same, short, for a badge: "59s", "3m 55s", "2h 05m", "1d 3h". */
export const durationShort = (d) => {
  const s = Math.max(0, Math.round(d / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${pad(s % 60)}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${pad(Math.floor((s % 3600) / 60))}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
};
export const cents = (n) => `$${(n / 100).toFixed(2)}`;
export const dollars = (usd) => cents(Math.round(usd * 100));
/** Known dollars and runs of unknown cost as a figure: "$0.52", "unknown", "$0.52 + unknown". */
export const costText = (usd, unknown) => (unknown > 0 ? (usd > 0 ? `${dollars(usd)} + unknown` : "unknown") : dollars(usd ?? 0));

/** A model id as people say it: claude-opus-5-5 is Opus 5.5; any other id as it is. */
export function modelName(id) {
  const m = /^claude-([a-z]+)-(\d+)-(\d+)(?:-\d{8})?$/.exec(String(id || ""));
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : modelId(id);
}

/**
 * Each cost row's known dollars in whole cents, so the rows and the chart add up to the total's cents: each row rounded
 * down, and the cents left given to the rows with the largest remainders (`rows`: dollar figures; null stays null).
 */
export function centsOf(rows) {
  const known = rows.map((usd, i) => [i, usd]).filter(([, usd]) => usd !== null && usd > 0);
  const out = rows.map((usd) => (usd === null ? null : 0));
  const want = Math.round(known.reduce((s, [, usd]) => s + usd, 0) * 100);
  for (const [i, usd] of known) out[i] = Math.floor(usd * 100 + 1e-9);
  let left = want - known.reduce((s, [i]) => s + out[i], 0);
  for (const [i] of [...known].sort((a, b) => (b[1] * 100 - Math.floor(b[1] * 100 + 1e-9)) - (a[1] * 100 - Math.floor(a[1] * 100 + 1e-9)) || a[0] - b[0])) {
    if (left <= 0) break;
    out[i] += 1;
    left -= 1;
  }
  return out;
}

/**
 * What a figure's dollars are, from its dollars by billing (usage.mjs BILLING, read through billingRead): the kinds that
 * hold at least half a cent of it, "" standing for dollars no record names a billing for (a sandbox vendor's).
 */
export function kindsOf(usd, byBilling) {
  const map = billingRead(byBilling);
  const out = Object.keys(map).filter((k) => map[k] >= 0.005);
  const unnamed = typeof usd === "number" ? usd - Object.values(map).reduce((s, n) => s + n, 0) : 0;
  if (out.length && unnamed >= 0.005) out.push("");
  return out;
}

/** The card's short words for a kind other than billed API spend; `unknown` is no billing, so it says none was recorded. */
export const SHORT = { subscription: "API-equivalent", credits: "Copilot AI credits", unknown: "billing not recorded" };

/**
 * The words after a dollar figure: none for billed API spend or when nothing names a billing; for one other kind
 * " API-equivalent", " in Copilot AI credits" or " (billing not recorded)"; for a mix the kinds other than billed spend,
 * " (part API-equivalent, part billing not recorded)". The table spells each stage out.
 */
export function billingWords(usd, byBilling) {
  const kinds = kindsOf(usd, byBilling);
  const odd = kinds.filter((k) => k && k !== "api" && SHORT[k]);
  if (!odd.length) return "";
  if (kinds.length === 1) return { subscription: " API-equivalent", credits: " in Copilot AI credits", unknown: " (billing not recorded)" }[odd[0]];
  return ` (part ${odd.map((k) => SHORT[k]).join(", part ")})`;
}

/**
 * What a figure's dollars are, said after it where the reader may not know the run's billing (the progress comment's
 * headline, progress-card.mjs): "on your subscription (API-equivalent)", "billed to your API or AI Gateway key", "in
 * Copilot AI credits", a mix as billingWords says it, "" when nothing names a billing.
 */
export function billingBasis(usd, byBilling) {
  const kinds = kindsOf(usd, byBilling);
  if (kinds.length === 1 && kinds[0] === "subscription") return `on your subscription (${SHORT.subscription})`;
  if (kinds.length === 1 && kinds[0] === "api") return "billed to your API or AI Gateway key";
  return billingWords(usd, byBilling).trim();
}


/** A shields.io static badge, for-the-badge style: its label and message escaped as shields.io reads them. */
export function badge(label, message, color) {
  const part = (s) => encodeURIComponent(String(s).replace(/-/g, "--").replace(/_/g, "__").replace(/ /g, "_"));
  return `<img alt="${label}: ${message}" src="https://img.shields.io/badge/${part(label)}-${part(message)}-${color}?style=for-the-badge">`;
}

export const many = (n, one, more = `${one}s`) => `${n} ${n === 1 ? one : more}`;

/**
 * The charts' colours. GitHub's web view applies a diagram's `init` in both colour modes; a viewer that ignores it (the
 * GitHub Mobile app in dark mode) draws with its own light or dark theme instead. So:
 * - every bar is an `active` task: the stock light and dark themes paint those blue with dark text, where a plain task is
 *   grey in the dark theme and a `done` one grey in both;
 * - with `init` applied, the bars are amber with dark text in them, and every text outside a bar (a label too long for
 *   its bar, the section names, the time axis) is a mid-tone ink, #b06f22, which reads at about 4:1 or better on white
 *   and on GitHub's dark background alike (`themeCSS` sets it on an active task's outside label, which the theme
 *   otherwise draws in the bar's dark text colour);
 * - the stage names are the section names, drawn in the theme's own title colour, so under a stock theme they read too;
 *   a bar's own label is only its duration, also in the table;
 * - the section bands are a faint amber wash, and the grid lines a mid grey (`themeCSS`: the axis draws them in its
 *   text colour otherwise), on either page.
 * `gantt.useWidth` draws the timeline at a phone-friendly width, so GitHub's scaling to the comment's width keeps its
 * text legible on a phone.
 */
export const INK = `#${COLORS.ink}`;
export const GANTT_THEME = {
  theme: "base",
  themeVariables: { fontSize: "16px", taskBkgColor: `#${COLORS.amber}`, taskBorderColor: `#${COLORS.brown}`, activeTaskBkgColor: `#${COLORS.amber}`, activeTaskBorderColor: `#${COLORS.brown}`, taskTextColor: "#1f1206", taskTextDarkColor: "#1f1206", taskTextLightColor: "#1f1206", taskTextOutsideColor: INK, taskTextClickableColor: INK, sectionBkgColor: "rgba(201,130,46,0.12)", altSectionBkgColor: "rgba(201,130,46,0.04)", sectionBkgColor2: "rgba(201,130,46,0.12)", titleColor: INK, textColor: INK, gridColor: "#8b949e", excludeBkgColor: "transparent" },
  themeCSS: `text.taskTextOutsideRight, text.taskTextOutsideLeft { fill: ${INK} !important; } .grid .tick line { stroke: #8b949e; }`,
  gantt: { useWidth: 440, barHeight: 24, barGap: 6, fontSize: 15, sectionFontSize: 15, leftPadding: 80 },
};
export const PIE_THEME = { theme: "base", themeVariables: { pie1: `#${COLORS.amber}`, pie2: `#${COLORS.green}`, pie3: `#${COLORS.slate}`, pie4: `#${COLORS.brown}`, pie5: "#8b949e", pieStrokeColor: `#${COLORS.brown}`, pieOuterStrokeColor: `#${COLORS.brown}`, pieTitleTextColor: INK, pieSectionTextColor: "#ffffff", pieLegendTextColor: INK, pieSectionTextSize: "16px", pieOpacity: "1" } };
export const mermaidInit = (theme) => `%%{init: ${JSON.stringify(theme)}}%%`;

/**
 * A state's badge and words, as both cards say them (the only emoji they use: the word always follows it): by a stage's
 * exit (`running` while it runs), and the finish card's own ends (`merged`, `closed`).
 */
export const STATES = Object.freeze({
  running: ["⏳", "running"],
  delivered: ["✅", "delivered"],
  merged: ["✅", "Merged"],
  blocked: ["⛔", "Blocked"],
  question: ["❓", "has a Question"],
  paused: ["⏸️", "paused"],
  waiting: ["⏸️", "waiting"],
  stopped: ["⏹️", "stopped"],
  skipped: ["⏹️", "skipped"],
  closed: ["⏹️", "Closed without merging"],
});
/** A state's badge (STATES); any other exit's is the stop's. */
export const stateBadge = (exit) => (STATES[exit ?? "running"] ?? STATES.stopped)[0];
/** A state's words (STATES); any other exit is named as it is. */
export const stateWords = (exit) => STATES[exit ?? "running"]?.[1] ?? String(exit);

/** A GitHub table cell's longest text, in characters (tableCell). */
export const CELL_MAX = 300;
/** Text for a GitHub table cell: one line, its pipes escaped, no HTML, at most `max` characters. */
export function tableCell(text, max = CELL_MAX) {
  const one = String(text ?? "").replace(/\r?\n/g, " ").replace(/</g, "&lt;").replace(/>/g, "&gt;").trim();
  const cut = one.length > max ? `${one.slice(0, max - 1)}…` : one;
  return cut.replace(/\\?\|/g, "\\|");
}
/** Text for a paragraph a card writes: no HTML. */
export const plainText = (s) => String(s ?? "").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/**
 * A label inside a Mermaid chart (a gantt task, a pie slice, a section): one line of letters, digits, spaces and plain
 * punctuation, none of the characters Mermaid reads as syntax (quotes, colons, semicolons, hashes, brackets, `%`).
 */
export const mermaidLabel = (s, max = 60) => {
  const one = String(s ?? "").replace(/[\r\n"':;#%<>{}\[\]()`|\\]+/g, " ").replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

/** A duration as a headline says it: to the minute from one minute on ("26 min", "3 h 42 min"), seconds below it. */
export const minutesText = (d) => (d >= 60_000 ? durationText(Math.round(d / 60_000) * 60_000) : durationText(d));

/** A known figure in a cell: "<$0.01" for under a cent above zero, never "$0.00" for spend that happened. */
export const moneyText = (usd) => (usd > 0 && usd < 0.005 ? "<$0.01" : dollars(usd ?? 0));
/** Known dollars and runs of unknown cost in a cell: "$1.59", "<$0.01", "unknown", "$1.59 + unknown". */
export const cellCost = (usd, unknown = 0) => (unknown > 0 ? (usd > 0 ? `${moneyText(usd)} + unknown` : "unknown") : moneyText(usd ?? 0));

/** What each kind of dollars is, in the cards' words. */
export const BASIS = Object.freeze({ subscription: "API-equivalent, not billed", api: "billed to your API key", credits: "Copilot AI credits, billed to your seat", unknown: "billing not recorded" });
/** The same, short, for a mix's parts. */
const BASIS_SHORT = Object.freeze({ subscription: "API-equivalent", api: "billed to your API key", credits: "Copilot AI credits", unknown: "billing not recorded", "": "billing not recorded" });
/**
 * What a figure's dollars are, said once on the headline's second line: one kind's words (BASIS); a mix as "$1.50: $1.20
 * API-equivalent, $0.30 billed to your API key"; "" for none (no dollars, or no kind recorded).
 */
export function basisText(usd, byBilling) {
  const kinds = kindsOf(usd, byBilling);
  if (!kinds.length) return "";
  if (kinds.length === 1) return BASIS[kinds[0] || "unknown"];
  const map = billingRead(byBilling);
  const named = Object.values(map).reduce((a, n) => a + n, 0);
  return `${dollars(usd)}: ${kinds.map((k) => `${dollars(k ? map[k] : usd - named)} ${BASIS_SHORT[k]}`).join(", ")}`;
}
/** The sentence that says what an API-equivalent figure is, for Run details. */
export const BASIS_NOTE = Object.freeze({
  subscription: "API-equivalent is what this usage would cost at API list prices; you are on a subscription, so it is not billed.",
  api: "These dollars are billed to your API key or AI Gateway key.",
  credits: "Copilot AI credits are billed to your Copilot seat.",
  unknown: "Pendulum did not record how these dollars were billed.",
});

/** The causes of unknown cost (usage.mjs UNKNOWN_WHY codes) in plain words: [codes, short, sentence (by count)]. */
const CAUSES = [
  [["decision", "decision-no-cost", "decision-lookup", "decision-unsettled", "relay"], "AI judge calls", (n) => `${many(n, "AI judge call")} went through the AI Gateway, which did not report ${n === 1 ? "its" : "their"} cost.`],
  [["unreported", "running", "stopped"], "ended before it reported", (n) => `${many(n, "AI run")} ended (or ${n === 1 ? "was" : "were"} still running) before ${n === 1 ? "it" : "they"} reported ${n === 1 ? "its" : "their"} cost.`],
  [["zeroed", "resumed-total"], "untrusted total", (n) => `${many(n, "AI run")} reported a total that could not be trusted.`],
  [["no-price", "price-ended", "long-context"], "no list price", (n) => `${many(n, "AI run")} had no usable list price for ${n === 1 ? "its" : "their"} model.`],
  [["failed-request", "sub-agent"], "Codex left part unreported", (n) => `${many(n, "AI run")} ran on Codex, which did not report part of the usage.`],
  [["credits"], "Copilot credits not reported", (n) => `${many(n, "AI run")} ran on Copilot, which did not report ${n === 1 ? "its" : "their"} AI credits in full.`],
  [["sandbox"], "sandbox usage not reported", (n) => `${many(n, "sandbox stage")} had usage the vendor did not report.`],
];
const OTHER = [[], "record not read", (n) => `${many(n, "AI run")} had a record Pendulum could not read or attribute.`];
const causeOf = (code) => CAUSES.find(([codes]) => codes.includes(code)) ?? OTHER;
/** The unknown runs' causes, short, for a headline's parenthesis: "AI judge calls", "ended before it reported". */
export const causesShort = (codes = []) => [...new Set(codes.map((c) => causeOf(c)[1]))].join(", ");
/**
 * One sentence per cause of unknown cost, with its count (`counts`: [code, runs] pairs): "7 AI judge calls went through
 * the AI Gateway, which did not report their cost. They are counted as unknown, never as $0."
 */
export function causeSentences(counts = []) {
  const by = new Map();
  for (const [code, n] of counts) {
    const c = causeOf(code);
    by.set(c, (by.get(c) ?? 0) + n);
  }
  const out = [...by].map(([c, n]) => c[2](n));
  const total = [...by.values()].reduce((a, n) => a + n, 0);
  return out.length ? `${out.join(" ")} ${total === 1 ? "It is" : "They are"} counted as unknown, never as $0.` : "";
}

/** The agents by harness, as people name them. */
export const AGENTS = Object.freeze({ claude: "Claude Code", codex: "Codex", copilot: "Copilot" });

/** The timeline's theme: the cards' gantt colours, with a grey for time on hold and a red for a Blocked or Question end. */
export const ganttTheme = (leftPadding = 80) => ({ ...GANTT_THEME, themeVariables: { ...GANTT_THEME.themeVariables, doneTaskBkgColor: "#8b949e", doneTaskBorderColor: "#6e7781", critBkgColor: "#b3402a", critBorderColor: "#7a2a1c" }, gantt: { ...GANTT_THEME.gantt, leftPadding } });
/** The tick for a time span: about five ticks across. */
export function tickFor(span) {
  const steps = [["1minute", 6e4], ["2minute", 12e4], ["5minute", 3e5], ["10minute", 6e5], ["15minute", 9e5], ["30minute", 18e5], ["1hour", 36e5], ["2hour", 72e5], ["6hour", 216e5], ["12hour", 432e5], ["1day", 864e5], ["1week", 6048e5]];
  return (steps.find(([, step]) => span / step <= 5) ?? steps.at(-1))[0];
}
const isoSecond = (t) => new Date(t).toISOString().slice(0, 19);
/**
 * A Mermaid gantt (pure) over `rows` ({section, bars: [{start, end, tag, label?}]}, ms; `tag` active, crit or done), in
 * `zone`'s wall time: a section name that repeats is numbered ("Review 1", "Review 2"), since Mermaid merges sections of
 * one name and would put the names beside the wrong bars. Each bar's label is its duration, then its own words.
 * `days`: the axis carries dates. Null with no bar.
 */
export function ganttChart(rows, { zone, days = false, leftPadding = 80 }) {
  const bars = rows.flatMap((r) => r.bars);
  if (!bars.length) return null;
  const from = Math.min(...bars.map((b) => b.start));
  const to = Math.max(...bars.map((b) => Math.max(b.end, b.start + 1000)));
  const shift = zoneOffsetMs(from, zone);
  const seen = new Map();
  for (const r of rows) seen.set(r.section, (seen.get(r.section) ?? 0) + 1);
  const n = new Map();
  const lines = ["gantt", "    dateFormat YYYY-MM-DDTHH:mm:ss", `    axisFormat ${days ? "%b %d %H:%M" : "%H:%M"}`, `    tickInterval ${tickFor(to - from)}`, "    todayMarker off"];
  for (const r of rows) {
    if (!r.bars.length) continue;
    const k = (n.get(r.section) ?? 0) + 1;
    n.set(r.section, k);
    lines.push(`    section ${mermaidLabel(seen.get(r.section) > 1 ? `${r.section} ${k}` : r.section)}`);
    for (const b of r.bars) {
      const end = Math.max(b.end, b.start + 1000);
      lines.push(`    ${durationShort(end - b.start)}${b.label ? ` ${mermaidLabel(b.label, 20)}` : ""} :${b.tag || "active"}, ${isoSecond(b.start + shift)}, ${isoSecond(end + shift)}`);
    }
  }
  return ["```mermaid", mermaidInit(ganttTheme(leftPadding)), ...lines, "```"].join("\n");
}

/** Text inside a Mermaid quoted string: one line, no quotes, at most 60 characters. */
const quoted = (t) => {
  const one = String(t ?? "").replace(/["\r\n`]+/g, " ").replace(/\s+/g, " ").trim();
  return one.length > 60 ? `${one.slice(0, 59)}…` : one;
};
/** The cost chart's theme: one amber series on a transparent page, its text in the ink both page modes read. */
const xyTheme = (height) => ({ theme: "base", themeVariables: { xyChart: { backgroundColor: "transparent", titleColor: INK, xAxisLabelColor: INK, xAxisTitleColor: INK, xAxisTickColor: "#8b949e", xAxisLineColor: "#8b949e", yAxisLabelColor: INK, yAxisTitleColor: INK, yAxisTickColor: "#8b949e", yAxisLineColor: "#8b949e", plotColorPalette: `#${COLORS.amber}` } }, xyChart: { width: 440, height, titleFontSize: 16, xAxis: { labelFontSize: 14 }, yAxis: { labelFontSize: 13, showTitle: false } } });
/** The y axis's top: the largest bar rounded up to a tidy step (1, 2 or 5 times a power of ten). */
export function tidyTop(max) {
  if (!(max > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(max));
  return [1, 2, 5, 10].map((m) => m * p).find((t) => t >= max);
}
/**
 * A horizontal Mermaid bar chart (pure) of recorded dollars, one amber series: `rows` ({label, usd}), each label carrying
 * its own figure. Null with fewer than two bars.
 */
export function costChart(rows, { title = "Recorded cost (USD)" } = {}) {
  const drawn = rows.filter((r) => r.usd > 0);
  if (drawn.length < 2) return null;
  const top = tidyTop(Math.max(...drawn.map((r) => r.usd)));
  const height = Math.max(150, 70 + 30 * drawn.length);
  return ["```mermaid", mermaidInit(xyTheme(height)), "xychart-beta horizontal", `    title "${quoted(title)}"`, `    x-axis [${drawn.map((r) => `"${quoted(r.label)}"`).join(", ")}]`, `    y-axis "USD" 0 --> ${top}`, `    bar [${drawn.map((r) => (Math.round(r.usd * 100) / 100).toFixed(2)).join(", ")}]`, "```"].join("\n");
}

/**
 * The vendor comment's two-line headline (pure; launch.mjs bookVendor): the sandbox's cost for one stage (`stage`, work
 * or review; `cost` and `rates` as logic.mjs vendorLine takes them): "**Cloud sandbox** · Work · **<$0.01**", then its
 * CPU time, wall time, size and the rates' date; a usage the vendor did not report reads "**unknown**".
 */
export function vendorCard({ stage, cost = {}, rates = {} }) {
  const name = { work: "Work", review: "Review" }[stage] ?? "Stage";
  const unreported = cost.usd === null || cost.usd === undefined || cost.usageUnknown;
  const figure = unreported ? (cost.usd > 0 ? `${moneyText(cost.usd)} + unknown` : "unknown") : moneyText(cost.usd);
  const size = Number.isFinite(cost.vcpus) || Number.isFinite(cost.memoryMb) ? `${cost.vcpus ?? "?"} vCPU / ${Number.isFinite(cost.memoryMb) ? Math.round(cost.memoryMb / 1024) : "?"} GB` : null;
  const date = typeof rates?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(rates.date) ? rates.date : null;
  const use = unreported ? "The sandbox vendor did not report this stage's usage." : `${Number.isFinite(cost.activeCpuMs) ? `${(cost.activeCpuMs / 1000).toFixed(1)} s of CPU` : "CPU time not reported"}${Number.isFinite(cost.wallMs) ? ` in ${minutesText(cost.wallMs)}` : ""}`;
  const second = unreported ? use : [use, size, `vendor list rates${date ? `, read ${date}` : ""}`].filter(Boolean).join(" · ");
  return `**Cloud sandbox** · ${name} · **${figure}**\n${second}`;
}
