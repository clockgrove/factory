// The 1.0 streak: consecutive walk-away merges per harness from a given Factory tag (docs/PLAN.md, the 1.0 bar).
// Pure: takes scored rows (lib/objective.mjs scoreObjective) and returns the streak; score.mjs --streak prints it.
//
// Only Objectives whose clock started at or after the tag count: an earlier one ran, at least in part, on an older
// Factory. They are ordered by how they ended (merged, Blocked, closed). Each finished Objective either extends its
// harness's streak or breaks it:
//   extends  merged, walk-away yes (no human input of any kind, no Blocked, no stall), every input source read, and no
//            P1 escape found later
//   breaks   anything else that finished: input of any kind, Blocked, a stall, closed unmerged, a P1 escape on its
//            merge, or an input source the scorer could not read (workflow runs, body edits): input may hide there
// One still running, in review or waiting on a Question has not finished: it is listed as in flight, neither.
// An External one (walkAway.bucket: its only stops were external Blocks, lib/objective.mjs walkAwayBucket) is listed
// in the sequence as skipped: it neither extends nor breaks, and does not count as finished. A P1 escape found in its
// merge makes it a break.
// A finished row whose harness is unknown (none recorded, or two on one Objective) is listed under "unknown", which is
// no harness's streak; when it breaks, it breaks every harness's streak, since it may have been any of them.

const ms = (at) => (at ? Date.parse(at) : NaN);
/** The slot for rows with no harness: listed, but never a harness's streak. */
export const UNKNOWN = "unknown";

/** Whether an escape is a P1 one: the auto-found ones carry `priority`; a hand-filled one may be a string naming P1. */
export const isP1 = (e) => (typeof e === "string" ? /\bP1\b/.test(e) : e?.priority === "P1");

/** When a row's Objective finished, or null while it is in flight. */
export function endedAt(row) {
  if (row.mergedAt) return row.mergedAt;
  if (row.exit === "blocked") return row.walkAway?.blocked?.at ?? row.closedAt ?? null;
  return row.closedAt ?? null; // closed without a merge; open and not Blocked: in flight
}

/** One finished row's verdict for the streak: `{ok, why}`; an External row's is `{ok: null, external: true, why}`, skipped. */
export function verdict(row) {
  const escapes = (row.quality?.escapes || []).filter(isP1);
  if (row.walkAway?.bucket === "external" && !escapes.length) return { ok: null, external: true, why: `external: Blocked: ${[...new Set((row.walkAway.blocks || []).map((b) => b.cause))].join(", ")}` };
  if (!row.mergedAt) return { ok: false, why: `not merged (${row.exit})` };
  if (!row.walkAway?.value) return { ok: false, why: row.walkAway?.reason ?? "not walk-away" };
  // Undefined (a row from before the scorer recorded it) is as unread as a listed source.
  const unseen = row.walkAway.unseen === undefined ? ["input sources not recorded"] : row.walkAway.unseen;
  if (unseen.length) return { ok: false, why: `input not readable (${unseen.join(", ")}): walk-away unproven` };
  if (escapes.length) return { ok: false, why: `P1 escape: ${escapes.map((e) => (typeof e === "string" ? e : e.issue)).join(", ")}` };
  return { ok: true, why: "walk-away merge" };
}

/**
 * Streaks per harness from `from` (ISO time: the tag's): `{from, harnesses: {[h]: {current, best, finished, walkAway,
 * external, sequence: [{issue, endedAt, ok, why, external?}], inFlight: [issue]}}, before: [issue]}`. An External entry
 * has `ok: null` and `external: true`; `finished` leaves it out. `before` lists rows whose clock started
 * earlier (left out).
 */
export function streaks(rows, { from }) {
  const out = { from, harnesses: {}, before: [] };
  const counted = [];
  for (const r of rows) {
    if (from && ms(r.walkAway?.since) < ms(from)) out.before.push(r.issue);
    else counted.push(r);
  }
  const slot = (h) => (out.harnesses[h] ??= { current: 0, best: 0, finished: 0, walkAway: 0, external: 0, sequence: [], inFlight: [] });
  const finished = [];
  for (const r of counted) {
    const end = endedAt(r);
    if (end) finished.push({ r, end });
    else slot(r.harness ?? UNKNOWN).inFlight.push(r.issue);
  }
  finished.sort((a, b) => ms(a.end) - ms(b.end) || a.r.issue - b.r.issue);
  for (const { r, end } of finished) {
    const h = slot(r.harness ?? UNKNOWN);
    const v = verdict(r);
    if (v.external) {
      h.external += 1;
      h.sequence.push({ issue: r.issue, endedAt: end, ok: null, external: true, why: v.why });
      continue;
    }
    h.finished += 1;
    if (v.ok) {
      h.walkAway += 1;
      h.current += 1;
      h.best = Math.max(h.best, h.current);
    } else h.current = 0;
    h.sequence.push({ issue: r.issue, endedAt: end, ok: v.ok, why: v.why });
    // Unknown harness: it may have been any of them, so a break breaks every harness's streak, and says so there.
    if (!r.harness && !v.ok)
      for (const [name, other] of Object.entries(out.harnesses)) {
        if (name === UNKNOWN) continue;
        other.current = 0;
        other.sequence.push({ issue: r.issue, endedAt: end, ok: false, why: `harness unknown, breaks every harness: ${v.why}` });
      }
  }
  return out;
}

/** A sequence entry's verdict: yes, skipped (External) or no, with why. */
const entryText = (x) => (x.external ? `skipped: ${cell(x.why)}` : x.ok ? "yes" : `no: ${cell(x.why)}`);

const cell = (s) => String(s ?? "").replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

/** The streak as Markdown: one line per harness, then each harness's sequence, oldest first. */
export function streakTable(result, { repository = "", tag = null } = {}) {
  const head = ["Harness", "Current streak", "Best", "Walk-away / finished", "In flight"];
  const lines = [`Streak on ${repository} from ${tag ? `${tag} (${result.from})` : result.from}: consecutive walk-away merges per harness; any human input, Blocked, a stall, an unmerged end, a later P1 escape or an input source not read breaks it, an unknown harness's break breaks every harness, and an External Objective (only external Blocks) is skipped.`, "", `| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`];
  const names = Object.keys(result.harnesses).sort();
  for (const h of names) {
    const s = result.harnesses[h];
    lines.push(`| ${[h, s.current, s.best, `${s.walkAway} / ${s.finished}`, s.inFlight.length ? s.inFlight.map((n) => `#${n}`).join(", ") : "none"].map(cell).join(" | ")} |`);
  }
  if (!names.length) lines.push("| none | 0 | 0 | 0 / 0 | none |");
  for (const h of names) {
    const seq = result.harnesses[h].sequence;
    if (!seq.length) continue;
    lines.push("", `${h}, oldest first:`);
    for (const x of seq) lines.push(`- #${x.issue} ${x.endedAt}: ${entryText(x)}`);
  }
  if (result.before.length) lines.push("", `Left out (clock started before ${tag ?? result.from}): ${result.before.map((n) => `#${n}`).join(", ")}`);
  return `${lines.join("\n")}\n`;
}

/** A Factory tag's time: its GitHub Release's publication (each tag gets one on push), else its commit's date. */
export async function tagTime(api, repo, tag) {
  try {
    const release = await api(`repos/${repo}/releases/tags/${encodeURIComponent(tag)}`);
    if (release?.published_at) return release.published_at;
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  const commit = await api(`repos/${repo}/commits/${encodeURIComponent(tag)}`);
  return commit?.commit?.committer?.date ?? null;
}

/**
 * The pooled streak across repositories (docs/PLAN.md, the 1.0 bar): every finished row of every repository, in the
 * order they ended, on any harness; a walk-away merge (verdict ok) extends it, any miss resets it and an External row is
 * skipped (listed, `ok: null`, `external: true`). `rows` carry
 * their `repository`. Returns `{from, current, best, finished, walkAway, sequence: [{repository, issue, harness,
 * endedAt, ok, why}], inFlight: [{repository, issue}], before: [{repository, issue}]}`.
 */
export function pooledStreak(rows, { from }) {
  const out = { from, current: 0, best: 0, finished: 0, walkAway: 0, external: 0, sequence: [], inFlight: [], before: [] };
  const finished = [];
  for (const r of rows) {
    const id = { repository: r.repository, issue: r.issue };
    if (from && ms(r.walkAway?.since) < ms(from)) out.before.push(id);
    else if (endedAt(r)) finished.push({ r, end: endedAt(r) });
    else out.inFlight.push(id);
  }
  finished.sort((a, b) => ms(a.end) - ms(b.end) || String(a.r.repository).localeCompare(String(b.r.repository)) || a.r.issue - b.r.issue);
  for (const { r, end } of finished) {
    const v = verdict(r);
    if (v.external) {
      out.external += 1;
      out.sequence.push({ repository: r.repository, issue: r.issue, harness: r.harness ?? UNKNOWN, endedAt: end, ok: null, external: true, why: v.why });
      continue;
    }
    out.finished += 1;
    if (v.ok) {
      out.walkAway += 1;
      out.current += 1;
      out.best = Math.max(out.best, out.current);
    } else out.current = 0;
    out.sequence.push({ repository: r.repository, issue: r.issue, harness: r.harness ?? UNKNOWN, endedAt: end, ok: v.ok, why: v.why });
  }
  return out;
}

const ref = (x) => `${x.repository}#${x.issue}`;

/** The pooled streak as Markdown: one line of totals, then the sequence it counted, oldest first. */
export function pooledTable(result, { repositories = [], tag = null } = {}) {
  const head = ["Current streak", "Best", "Walk-away / finished", "In flight"];
  const lines = [
    `Pooled streak across ${repositories.join(", ")} from ${tag ? `${tag} (${result.from})` : result.from}: consecutive walk-away merges on any harness, in the order they ended; any miss on any repository resets it and an External Objective is skipped.`,
    "",
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    `| ${[result.current, result.best, `${result.walkAway} / ${result.finished}`, result.inFlight.length ? result.inFlight.map(ref).join(", ") : "none"].map(cell).join(" | ")} |`,
  ];
  if (result.sequence.length) {
    lines.push("", "Pooled, oldest first:");
    for (const x of result.sequence) lines.push(`- ${ref(x)} (${x.harness}) ${x.endedAt}: ${entryText(x)}`);
  }
  if (result.before.length) lines.push("", `Left out (clock started before ${tag ?? result.from}): ${result.before.map(ref).join(", ")}`);
  return `${lines.join("\n")}\n`;
}
