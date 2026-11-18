// The cards' shared look (#589): the words, figures and colours the finish card (finish-card.mjs) and a stage's progress
// comment (progress-card.mjs) both use, so the two read as one system. Money in cents (the exact figures stay in the
// hidden lines), durations, model names, what dollars are, the state vocabulary, badges, table cells, and the charts'
// Mermaid themes. Pure: no reads, no writes.
import { billingRead } from "./usage.mjs";

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
 * A stage's state as both cards name it, by its exit (`running` while it runs): the progress comment's headline, and the
 * finish card's own (`merged`).
 */
export const STATES = Object.freeze({
  running: "⏳ running",
  delivered: "✅ delivered",
  merged: "✅ merged",
  blocked: "⛔ Blocked",
  question: "❓ Question",
  stopped: "⏹️ stopped",
  skipped: "⏭️ skipped",
  paused: "⏸️ paused",
  waiting: "⏸️ waiting",
});
/** A state's words (STATES), any other exit named as it is. */
export const stateText = (exit) => STATES[exit ?? "running"] ?? `🏁 ${exit}`;

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
