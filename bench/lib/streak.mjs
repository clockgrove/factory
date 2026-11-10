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

/** One finished row's verdict for the streak: `{ok, why}`. */
export function verdict(row) {
  const escapes = (row.quality?.escapes || []).filter(isP1);
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
 * sequence: [{issue, endedAt, ok, why}], inFlight: [issue]}}, before: [issue]}`. `before` lists rows whose clock started
 * earlier (left out).
 */
export function streaks(rows, { from }) {
  const out = { from, harnesses: {}, before: [] };
  const counted = [];
  for (const r of rows) {
    if (from && ms(r.walkAway?.since) < ms(from)) out.before.push(r.issue);
    else counted.push(r);
  }
  const slot = (h) => (out.harnesses[h] ??= { current: 0, best: 0, finished: 0, walkAway: 0, sequence: [], inFlight: [] });
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

const cell = (s) => String(s ?? "").replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

/** The streak as Markdown: one line per harness, then each harness's sequence, oldest first. */
export function streakTable(result, { repository = "", tag = null } = {}) {
  const head = ["Harness", "Current streak", "Best", "Walk-away / finished", "In flight"];
  const lines = [`Streak on ${repository} from ${tag ? `${tag} (${result.from})` : result.from}: consecutive walk-away merges per harness; any human input, Blocked, a stall, an unmerged end, a later P1 escape or an input source not read breaks it, and an unknown harness's break breaks every harness.`, "", `| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`];
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
    for (const x of seq) lines.push(`- #${x.issue} ${x.endedAt}: ${x.ok ? "yes" : `no: ${cell(x.why)}`}`);
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
