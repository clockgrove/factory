// A stage lost to a network failure on the Action's runners and the cloud sandbox is relaunched (#245): one that ended on
// an `outage` (session.mjs outageExit: its Block, written as the stage's one try), and one that vanished with no exit at
// all (the dispatcher's Running pass: no live job, no lease). Such losses are almost always transient, so the dispatcher
// starts the Objective's work again on its branch, in the slot it held, at most RELAUNCH_MAX times since a person last
// started it; past that it Blocks for a person. The count is a record Factory owns on the issue, so a dispatcher that
// restarts keeps it. The local route pauses and resumes a stage itself (local.mjs) and never gets here.
import { addLabels, moveCard, removeLabel, rest, setStateLabel, upsertComment } from "./github.mjs";
import { blockCauseOf, isSelf, marker, restartedAt, selfLogin, trustedAuthor } from "./logic.mjs";
import { startTime } from "./objective-trust.mjs";

/** How many times a lost stage is relaunched since a person last started the Objective, before it Blocks. */
export const RELAUNCH_MAX = 2;
/** How many tries the record keeps, the latest last. */
const KEEP_TRIES = 10;

const RECORD_LINE = /^<!-- factory:relaunch (\{[^\n]*\}) -->$/m;
// Factory's own comment (the marker on its first line); before Factory knows its login, one by someone who can push, as
// upsertComment decides which comment is its own to edit.
const ours = (c) => (selfLogin() ? isSelf(c) : trustedAuthor(c));

/**
 * The relaunch record among an issue's comments: `{tries: [{at, lost, key, start}], commentId}`, or null. `lost` is
 * `outage` (the stage ended on one) or `vanished` (no exit); `key` names the loss it answered (blockKey, stintKey), so a
 * tick that finds the same loss again does not count it twice; `start` is the person's start it counted against
 * (personStart), so a later start begins a new count with no clock compared.
 */
export function relaunchRecordOf(comments, issue) {
  const head = `${marker(issue, "relaunch")}\n`;
  const c = (comments || []).filter((x) => ours(x) && (x.body || "").startsWith(head)).sort((a, b) => a.id - b.id)[0];
  if (!c) return null;
  let tries = [];
  try {
    const parsed = JSON.parse(RECORD_LINE.exec(c.body)?.[1] ?? "null");
    if (Array.isArray(parsed?.tries)) tries = parsed.tries.filter((t) => t && typeof t === "object" && Number.isFinite(Date.parse(t.at)) && typeof t.key === "string");
  } catch {
    tries = [];
  }
  return { tries, commentId: c.id };
}

/** The key of an outage Block notice: its comment and the time it was last written (a stage may rewrite one in place). */
export const blockKey = (c) => `block:${c.id}@${c.updated_at ?? c.created_at ?? ""}`;
/** The key of a vanished Running stint: when it became Running. */
export const stintKey = (since) => `stint:${since ?? "unknown"}`;

/**
 * The outage Block a stage of this route wrote, when it is the issue's newest Blocked notice: Factory's own, written by
 * a stage that ended on its network (session.mjs outageExit: stage `outage`, cause `outage`). Null otherwise, or when a
 * later Blocked notice (the dispatcher's own, once the relaunches are used up, or any other) is the newest.
 */
export function outageBlockOf(comments, issue) {
  const head = `<!-- factory:${issue}:blocked:`;
  const time = (c) => Date.parse(c.created_at) || 0;
  const newest = (comments || []).filter((c) => ours(c) && (c.body || "").startsWith(head)).sort((a, b) => time(a) - time(b) || a.id - b.id).at(-1);
  if (!newest || !newest.body.startsWith(`${head}outage:`) || blockCauseOf(newest.body) !== "outage") return null;
  return { id: newest.id, key: blockKey(newest) };
}

/**
 * When a person last started the Objective, which starts the relaunch count over: its label applied, its draft label
 * taken off (objective-trust.mjs startTime), or a restart (logic.mjs restartedAt). Null when none can be told.
 */
export function personStart(events, comments, label) {
  const times = [startTime(events, label), restartedAt(comments)].filter((t) => Number.isFinite(Date.parse(t)));
  return times.sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) ?? null;
}

/** The record's tries counted against `start`: the relaunches since a person last started the Objective. */
export const triesSince = (record, start) => (record?.tries || []).filter((t) => (t.start ?? null) === (start ?? null));

/**
 * What the dispatcher does with a lost stage: `{relaunch: true, tries}` with the record to write (`record`, null when the
 * same loss was counted already and only its relaunch is to finish), or `{block: true, tries}` once RELAUNCH_MAX
 * relaunches since `start` were used.
 */
export function relaunchDecision({ record, start, key, lost, at, max = RELAUNCH_MAX }) {
  const since = triesSince(record, start);
  if (since.some((t) => t.key === key)) return { relaunch: true, tries: since.length, record: null };
  if (since.length >= max) return { block: true, tries: since.length };
  const tries = [...(record?.tries || []), { at, lost, key, start: start ?? null }].slice(-KEEP_TRIES);
  return { relaunch: true, tries: since.length + 1, record: { tries } };
}

/** The record comment's text after its marker: one line for a person, then the record. */
export function relaunchBody({ tries }, count, { max = RELAUNCH_MAX } = {}) {
  const last = tries.at(-1);
  const how = last?.lost === "outage" ? "it ended on its network (an outage)" : "it vanished with no exit (its runner or sandbox could not report)";
  return `Factory relaunched this Objective's stage: ${count} of ${max} since it was last started; the latest because ${how}. Past ${max} it is Blocked for you.\n<!-- factory:relaunch ${JSON.stringify({ tries })} -->`;
}

/** The issue's timeline (label events), for personStart. */
export const timelineOf = async (repo, n, opts) => (await rest(`repos/${repo.full}/issues/${n}/timeline?per_page=100`, { ...opts, paginate: true })) || [];

/** Write the record (one comment, updated in place). */
export const writeRelaunchRecord = (repo, n, record, count, opts) => upsertComment(repo, n, marker(n, "relaunch"), relaunchBody(record, count), opts);

/**
 * A new Running stint for the Objective: `factory:running` applied afresh (taken off first when on), so the stint's
 * start (github.mjs runningSince) is now and the grace a job or sandbox start gets counts from the relaunch. Any other
 * state label goes; the card moves to Running.
 */
export async function newStint(repo, n, { project, wasRunning }, opts) {
  if (wasRunning) {
    await removeLabel(repo, n, "factory:running", opts);
    await addLabels(repo, n, ["factory:running"], opts);
  } else await setStateLabel(repo, n, "running", opts);
  await moveCard(project, repo, n, "Running", opts).catch(() => {});
}
