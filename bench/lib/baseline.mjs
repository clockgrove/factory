// baseline.mjs: the before-and-after line for a wave, computed from scorecard rows.
const quantile = (xs, q, digits = 1) => {
  const s = xs.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const k = 10 ** digits;
  return Math.round((s[lo] + (s[hi] - s[lo]) * (pos - lo)) * k) / k;
};
const spread = (xs, digits = 1, leftOut = 0) => ({ median: quantile(xs, 0.5, digits), p25: quantile(xs, 0.25, digits), p75: quantile(xs, 0.75, digits), n: xs.filter((x) => typeof x === "number").length, ...(leftOut ? { leftOut } : {}) });

/**
 * Whether a row's dollars hold runs of unknown cost (plugin usage.mjs UNKNOWN_WHY: the model's, a relayed key's or a
 * sandbox's): its known dollars are then not its cost, so it is left out of every dollar measure and counted beside it.
 */
const unknownCost = (r) => (r.cost?.usdUnknown ?? 0) > 0 || (r.cost?.totalUnknown ?? 0) > 0 || (r.cost?.vendor?.usdUnknown ?? 0) > 0;
/** The measures in dollars: a row with runs of unknown cost is left out of them. */
const DOLLARS = new Set(["usd", "workerKeyUsd", "vendorUsd", "totalUsd"]);

export const MEASURES = [
  ["modelMinutes", (r) => r.phases?.modelMinutes ?? null, "model min"],
  ["turns", (r) => r.activity?.turns ?? null, "turns"],
  ["usd", (r) => r.cost?.usd ?? null, "$"],
  // A sandbox's cost is cents per stage: kept to four places, where the other measures keep one.
  // The spend through a relayed AI Gateway key (#97), already in "$": the worker's pipeline, apart from the harness.
  ["workerKeyUsd", (r) => r.cost?.workerKeyUsd ?? null, "worker key $", 2],
  ["vendorUsd", (r) => r.cost?.vendorUsd ?? null, "sandbox $", 4],
  ["totalUsd", (r) => r.cost?.totalUsd ?? r.cost?.usd ?? null, "total $", 2],
  ["cachedTokens", (r) => r.cost?.tokens?.cached ?? null, "cached tok"],
  ["writtenTokens", (r) => r.cost?.tokens?.written ?? null, "written tok"],
  ["ciWaitMinutes", (r) => r.phases?.ciWaitMinutes ?? null, "CI wait min"],
  // The reviewer's minutes beside the required checks it ran with (bench/lib/phases.mjs), in neither model nor CI wait.
  ["overlapMinutes", (r) => r.phases?.overlapMinutes ?? null, "review beside CI min"],
  ["dispatchSeconds", (r) => r.dispatch?.maxSeconds ?? null, "dispatch s"],
  ["slotWaitSeconds", (r) => r.dispatch?.slotWaitSeconds ?? null, "slot wait s"],
  ["setupSeconds", (r) => r.phases?.setupSeconds ?? null, "setup s"],
  ["setupMinutes", (r) => r.phases?.setupMinutes ?? null, "setup min"],
  ["firstSetupMinutes", (r) => r.phases?.firstSetupMinutes ?? null, "first-time setup min"],
  ["wallMinutes", (r) => r.wallMinutes ?? null, "wall min"],
  ["sessions", (r) => r.activity?.sessions ?? null, "sessions"],
];

/** Merged rows of one repository, newest-merged first, optionally the last N or those merged since a date. */
export function selectRows(rows, { repo = null, last = null, since = null } = {}) {
  let out = rows.filter((r) => r.exit === "merged" && r.mergedAt && (!repo || r.repository === repo));
  if (since) out = out.filter((r) => r.mergedAt >= since);
  out.sort((a, b) => (a.mergedAt < b.mergedAt ? 1 : -1));
  if (last) out = out.slice(0, last);
  return out;
}

export function baselineOf(rows, opts = {}) {
  const picked = selectRows(rows, opts);
  const line = { label: opts.label ?? null, repo: opts.repo ?? null, rows: picked.length, issues: picked.map((r) => r.issue), from: picked.at(-1)?.mergedAt ?? null, to: picked[0]?.mergedAt ?? null, walkAway: picked.length ? Math.round((100 * picked.filter((r) => r.walkAway?.value).length) / picked.length) : null, walkAwayAskedOnly: picked.length && picked.every((r) => r.walkAway?.askedOnly) ? Math.round((100 * picked.filter((r) => r.walkAway.askedOnly.value).length) / picked.length) : null, measures: {} };
  for (const [key, pick, , digits] of MEASURES) {
    const rows = DOLLARS.has(key) ? picked.filter((r) => !unknownCost(r)) : picked;
    line.measures[key] = spread(rows.map(pick), digits, picked.length - rows.length);
  }
  return line;
}

export function formatBaseline(line) {
  const head = `baseline ${line.label ?? ""}${line.repo ? ` ${line.repo}` : ""}: ${line.rows} merged Objective(s)${line.from ? ` ${line.from.slice(0, 10)}..${line.to.slice(0, 10)}` : ""}, walk-away ${line.walkAway ?? "?"}% (${line.walkAwayAskedOnly ?? "?"}% counting only input Pendulum asked for)\n`;
  const out = (m) => (m.leftOut ? `; ${m.leftOut} left out: runs of unknown cost` : "");
  const fmt = (m) => (m.median === null ? `none${m.leftOut ? ` (${m.leftOut} left out: runs of unknown cost)` : ""}` : `${m.median} (${m.p25}..${m.p75}, n=${m.n}${out(m)})`);
  return head + MEASURES.map(([key, , name]) => `  ${name.padEnd(12)} ${fmt(line.measures[key])}`).join("\n") + "\n";
}
