// Sibling Objectives that change the same files (#277): the dispatcher holds a Queued Objective whose known files
// overlap a Running or In-review sibling's heavily until that sibling leaves, and says so on the waiting issue; one
// that overlaps lightly starts and says it will rebase on the other. Files come only from structure Factory already
// has: an open PR's changed files (GitHub's list) and the plan comment's `Files:` lines (factory-objective-plan). An
// Objective with neither (a first run before its plan) has unknown files: it starts as before and nothing is said.
import { findPr, listComments, rest } from "./github.mjs";
import { planOf } from "./handoff.mjs";
import { isSelf, marker, selfLogin, stateOf, trustedAuthor } from "./logic.mjs";

/** The plan line that names a checklist item's files (factory-objective-plan): `Files: a/b.mjs, c.md`. */
export const PLAN_FILES_KEY = "Files";
/** At most this many paths are kept per Objective: a plan line or a PR past it is read as its first ones. */
export const FILES_MAX = 200;
/** A heavy overlap: at least this many shared files, or half of the smaller Objective's files. */
export const HEAVY_SHARED = 3;
/** Queued Objectives past the free slots whose files are read when an earlier one waits (each read is one or two calls). */
export const LOOKAHEAD = 3;
/** The states whose Objectives a Queued one waits for: they are on their way to a merge without a person. */
const ACTIVE = new Set(["Running", "In review"]);

/** One path as a plan names it, repository-relative, or null when it is no plain path (absolute, `..`, a space, a URL). */
export function cleanPath(raw) {
  let p = String(raw ?? "").trim().replace(/^[`'"]+|[`'"]+$/g, "").trim();
  p = p.replace(/^\.\//, "");
  if (!p || p.length > 300 || /\s/.test(p) || p.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(p) || p.split("/").includes("..")) return null;
  return p;
}

/**
 * The files a plan's `Files:` lines name (a list marker before the key is allowed), in order, once each, at most
 * FILES_MAX. Entries are separated by commas; one that is not a plain path is skipped. Prose elsewhere is never read.
 */
export function plannedFiles(text) {
  const out = new Set();
  const key = new RegExp(`^\\s*(?:[-*+]\\s+(?:\\[[ xX]\\]\\s+)?|\\d+[.)]\\s+)?\\**${PLAN_FILES_KEY}:\\**\\s*(.*)$`);
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const m = key.exec(line);
    if (!m) continue;
    for (const part of m[1].split(",")) {
      const p = cleanPath(part);
      if (p && out.size < FILES_MAX) out.add(p);
    }
  }
  return [...out];
}

/** The paths both lists name, sorted. */
export function sharedFiles(a, b) {
  const other = new Set(b || []);
  return [...new Set(a || [])].filter((p) => other.has(p)).sort();
}

/** Whether `shared` paths between lists of `a` and `b` files is a heavy overlap (HEAVY_SHARED, or half the smaller). */
export function heavyOverlap(shared, a, b) {
  const n = shared.length;
  if (!n) return false;
  return n >= HEAVY_SHARED || n * 2 >= Math.min(new Set(a).size, new Set(b).size);
}

/**
 * The order (pure): `candidates` are the Queued Objectives in pick order, each `{number, files}` (null: unknown);
 * `siblings` the Running and In-review ones, each `{number, files, state}`; `slots` how many may start. A candidate
 * with known files waits for the first sibling, or earlier starter of this tick, it overlaps heavily; one it overlaps
 * lightly starts with a note naming them. Returns `{ready, waits: [{number, on, shared, of}], notes: [{number, with:
 * [{number, shared}]}]}`; an unknown candidate always starts (while slots last) and gets no note.
 */
export function siblingOrder({ candidates, siblings, slots }) {
  const ready = [];
  const waits = [];
  const notes = [];
  const started = [];
  for (const c of candidates) {
    if (ready.length >= slots) break;
    if (!c.files?.length) {
      ready.push(c.number);
      continue;
    }
    const others = [...siblings, ...started].filter((s) => s.number !== c.number && s.files?.length);
    const overlaps = others.map((s) => ({ number: s.number, state: s.state, shared: sharedFiles(c.files, s.files), heavy: false, files: s.files }));
    for (const o of overlaps) o.heavy = heavyOverlap(o.shared, c.files, o.files);
    const heavy = overlaps.find((o) => o.heavy);
    if (heavy) {
      waits.push({ number: c.number, on: heavy.number, state: heavy.state, shared: heavy.shared, of: new Set(c.files).size });
      continue;
    }
    ready.push(c.number);
    started.push({ number: c.number, files: c.files, state: "Running" });
    const light = overlaps.filter((o) => o.shared.length).map(({ number, shared }) => ({ number, shared }));
    if (light.length) notes.push({ number: c.number, with: light });
  }
  return { ready, waits, notes };
}

const list = (paths, max = 5) => `${paths.slice(0, max).map((p) => `\`${p.replace(/`/g, "")}\``).join(", ")}${paths.length > max ? ` and ${paths.length - max} more` : ""}`;

/** Why a waiting Objective is skipped this tick (the dispatcher's skipped reason). */
export const waitReason = (w) => `waits for #${w.on} to merge: both change ${w.shared.length} file(s) (${list(w.shared, 3)})`;

/** The overlap comment's text on a waiting Objective (its marker added by the caller). */
export function waitNote(w) {
  return `Factory: this Objective waits for #${w.on} (${String(w.state || "running").toLowerCase()}) to merge before it starts: both change ${list(w.shared)}, ${w.shared.length} of this Objective's ${w.of} known file(s). Started together, the one that merges second would rebase over the other. It starts on the first dispatcher tick after #${w.on} merges or stops (Blocked, a Question, its label removed). A run named by hand for this issue starts it now.`;
}

/** The overlap comment's text on an Objective that starts beside siblings it shares a few files with. */
export function besideNote(n) {
  const each = n.with.map((o) => `#${o.number} (${list(o.shared, 3)})`).join("; ");
  return `Factory: this Objective starts beside ${each}, which change some of the same files. Whichever merges second rebases onto the other; each rebase and its cost show in that stage's progress comment.`;
}

/** The overlap comment's text once a waiting Objective starts with no overlap left. */
export const clearedNote = (on) => `Factory: this Objective no longer waits for #${on}: no Running or In-review sibling shares its files now, so it started.`;

/**
 * The files Factory knows an Objective will change: its open PR's changed files (the first page, 100) and its plan
 * comment's `Files:` lines, joined; null when it has neither. An issue with no comments has no plan and no Factory PR
 * (a PR comes with progress comments), so it costs no read.
 */
export async function knownFiles(repo, issue, opts) {
  if (!(issue.comments > 0)) return { files: null, comments: [] };
  const all = await listComments(repo, issue.number, opts);
  const planned = plannedFiles(planOf(all, issue.number)?.text ?? "");
  const pr = await findPr(repo, `factory/${issue.number}`, opts);
  const changed = pr ? ((await rest(`repos/${repo.full}/pulls/${pr.number}/files?per_page=100`, opts)) || []).map((f) => f?.filename).filter((f) => typeof f === "string") : [];
  const files = [...new Set([...changed, ...planned])].slice(0, FILES_MAX);
  return { files: files.length ? files : null, comments: all };
}

/** The overlap comment's marker: its kind (`waits-<sibling>`, `beside`, `cleared`) on the first line, read back by overlapKind. */
export const overlapMarker = (n, kind) => marker(n, "overlap", kind);

/** Factory's own overlap comment on issue `n` among `comments` and its kind, or null. */
export function overlapOf(comments, n) {
  const prefix = marker(n, "overlap").replace(/ -->$/, ":");
  // Only Factory's own comment (anyone can paste the marker); before Factory knows its login, one by a writer (as upsertComment).
  const c = (comments || []).find((x) => (selfLogin() ? isSelf(x) : trustedAuthor(x)) && (x.body || "").startsWith(prefix));
  if (!c) return null;
  const kind = /^([a-z]+)(?:-(\d+))? -->/.exec(c.body.slice(prefix.length));
  return { id: c.id, body: c.body, kind: kind?.[1] ?? null, on: kind?.[2] ? Number(kind[2]) : null };
}

/**
 * The dispatcher's pass (dispatch.mjs, after selectReady): `ready` the picks and `waiting` the Queued Objectives left
 * out for max_concurrent, both in pick order, with `slots` free. Reads files only when a slot is free and a sibling is
 * active or two picks could meet; a failed read leaves that Objective unknown (it starts, as before). Writes the
 * overlap comments unless `dryRun`, each only when its text changed. Returns `{ready, waits, notes}` (siblingOrder).
 */
export async function orderSiblings(repo, { issues, statuses = {}, ready, waiting = [], slots }, opts, { dryRun = false, log = () => {} } = {}) {
  const byNumber = new Map(issues.map((i) => [i.number, i]));
  const active = issues.filter((i) => ACTIVE.has(stateOf(i, statuses[i.number] ?? null)) && !ready.includes(i.number));
  const pool = slots > 0 ? [...ready, ...waiting].slice(0, slots + LOOKAHEAD).map((n) => byNumber.get(n)).filter(Boolean) : [];
  if (!pool.length || (!active.length && pool.length < 2)) return { ready: ready.slice(0, Math.max(0, slots)), waits: [], notes: [] };
  const read = async (issue) =>
    knownFiles(repo, issue, opts).catch((e) => {
      log(`  #${issue.number}: its files are unread (${String(e.message).slice(0, 80)}); taken as unknown`);
      return { files: null, comments: null };
    });
  const candidates = [];
  const seen = {};
  for (const issue of pool) {
    seen[issue.number] = await read(issue);
    candidates.push({ number: issue.number, files: seen[issue.number].files });
  }
  // Siblings are read only when some candidate's files are known: nothing can overlap an unknown one.
  const siblings = [];
  if (candidates.some((c) => c.files?.length)) for (const issue of active) siblings.push({ number: issue.number, state: stateOf(issue, statuses[issue.number] ?? null), files: (await read(issue)).files });
  const order = siblingOrder({ candidates, siblings, slots });
  if (!dryRun) {
    const say = async (n, kind, text) => {
      const old = overlapOf(seen[n]?.comments, n);
      const body = `${overlapMarker(n, kind)}\n${text}`;
      if (old?.body === body) return;
      await rest(old ? `repos/${repo.full}/issues/comments/${old.id}` : `repos/${repo.full}/issues/${n}/comments`, { ...opts, method: old ? "PATCH" : "POST", body: { body } }).catch((e) => log(`  #${n}: overlap comment: ${String(e.message).slice(0, 120)}`));
    };
    for (const w of order.waits) await say(w.number, `waits-${w.on}`, waitNote(w));
    for (const n of order.notes) await say(n.number, "beside", besideNote(n));
    // A waiting comment left from an earlier tick, now started with no overlap: said once that it no longer waits.
    for (const n of order.ready) {
      const old = overlapOf(seen[n]?.comments, n);
      if (old?.kind === "waits" && !order.notes.some((x) => x.number === n)) await say(n, "cleared", clearedNote(old.on));
    }
  }
  for (const w of order.waits) log(`  #${w.number}: ${waitReason(w)}`);
  return order;
}
