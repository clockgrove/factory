// baseline.mjs: the before-and-after line for a wave, computed from scorecard rows.
const quantile = (xs, q) => {
  const s = xs.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return Math.round((s[lo] + (s[hi] - s[lo]) * (pos - lo)) * 10) / 10;
};
const spread = (xs) => ({ median: quantile(xs, 0.5), p25: quantile(xs, 0.25), p75: quantile(xs, 0.75), n: xs.filter((x) => typeof x === "number").length });

export const MEASURES = [
  ["modelMinutes", (r) => r.phases?.modelMinutes ?? null, "model min"],
  ["turns", (r) => r.activity?.turns ?? null, "turns"],
  ["usd", (r) => r.cost?.usd ?? null, "$"],
  ["cachedTokens", (r) => r.cost?.tokens?.cached ?? null, "cached tok"],
  ["writtenTokens", (r) => r.cost?.tokens?.written ?? null, "written tok"],
  ["ciWaitMinutes", (r) => r.phases?.ciWaitMinutes ?? null, "CI wait min"],
  ["dispatchSeconds", (r) => r.dispatch?.maxSeconds ?? null, "dispatch s"],
  ["setupMinutes", (r) => r.phases?.setupMinutes ?? null, "setup min"],
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
  const line = { label: opts.label ?? null, repo: opts.repo ?? null, rows: picked.length, issues: picked.map((r) => r.issue), from: picked.at(-1)?.mergedAt ?? null, to: picked[0]?.mergedAt ?? null, walkAway: picked.length ? Math.round((100 * picked.filter((r) => r.walkAway?.value).length) / picked.length) : null, measures: {} };
  for (const [key, pick] of MEASURES) line.measures[key] = spread(picked.map(pick));
  return line;
}

export function formatBaseline(line) {
  const head = `baseline ${line.label ?? ""}${line.repo ? ` ${line.repo}` : ""}: ${line.rows} merged Objective(s)${line.from ? ` ${line.from.slice(0, 10)}..${line.to.slice(0, 10)}` : ""}, walk-away ${line.walkAway ?? "?"}%\n`;
  const fmt = (m) => (m.median === null ? "none" : `${m.median} (${m.p25}..${m.p75}, n=${m.n})`);
  return head + MEASURES.map(([key, , name]) => `  ${name.padEnd(12)} ${fmt(line.measures[key])}`).join("\n") + "\n";
}
