// A stage lost to a network failure on the Action's runners and the cloud sandbox is relaunched (#245): one that ended on
// an `outage` (session.mjs outageExit: its Block, written as the stage's one try), and one that vanished with no exit at
// all (the dispatcher's Running pass: no live job, no lease). Such losses are almost always transient, so the dispatcher
// starts the Objective's work again on its branch, in the slot it held, at most RELAUNCH_MAX times since a person last
// started it; past that it Blocks for a person. The count is a record Factory owns on the issue, so a dispatcher that
// restarts keeps it. The local route pauses and resumes a stage itself (local.mjs) and never gets here.
import { addLabels, moveCard, removeLabel, rest, setStateLabel, upsertComment, workflowFile } from "./github.mjs";
import { CLOCK_SKEW_MS, blockCauseOf, isSelf, marker, restartedAt, selfLogin, trustedAuthor } from "./logic.mjs";
import { startTime } from "./objective-trust.mjs";
import { neverStarted } from "./triage.mjs";

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
 * (personStart), so a later start begins a new count with no clock compared; `run` is the Actions run that relaunched it
 * (its work job runs there: stintWorkJob).
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

/**
 * The issue's comments as its timeline carries them (`commented` events: id, body, author, times), so one timeline read
 * serves the label times, the outage notice and the relaunch record.
 */
export const commentsOf = (events) =>
  (events || []).filter((e) => e?.event === "commented").map((e) => ({ id: e.id, body: e.body ?? "", user: e.user ?? e.actor ?? null, author_association: e.author_association, created_at: e.created_at, updated_at: e.updated_at ?? e.created_at }));

/** When the issue last became Running (its latest `labeled factory:running` event, GitHub's clock), or null. */
export function lastRunningAt(events) {
  let last = null;
  for (const e of events || []) if (e?.event === "labeled" && e.label?.name === "factory:running" && Number.isFinite(Date.parse(e.created_at)) && (!last || Date.parse(e.created_at) > Date.parse(last))) last = e.created_at;
  return last;
}

/**
 * The issue's Running stint as its timeline shows it: the newest `labeled` or `unlabeled` factory:running event (the later
 * in the timeline's order on a tie). `key` names that event, so any label change since gives another key (`none`
 * without one); `at` is its time; `running` is whether it applied the label.
 */
export function runningStint(events) {
  let last = null;
  for (const e of events || []) {
    if ((e?.event !== "labeled" && e?.event !== "unlabeled") || e.label?.name !== "factory:running" || !Number.isFinite(Date.parse(e.created_at))) continue;
    if (!last || Date.parse(e.created_at) >= Date.parse(last.created_at)) last = e;
  }
  return last ? { key: `${last.event}:${last.id ?? ""}@${last.created_at}`, at: last.created_at, running: last.event === "labeled" } : { key: "none", at: null, running: false };
}

/** The key of an outage Block notice: its comment and the time it was last written (a stage may rewrite one in place). */
export const blockKey = (c) => `block:${c.id}@${c.updated_at ?? c.created_at ?? ""}`;
/** The key of a vanished Running stint: when it became Running. */
export const stintKey = (since) => `stint:${since ?? "unknown"}`;

/**
 * The outage Block a stage of this route wrote, when it is the issue's newest Blocked notice: Factory's own, written by
 * a stage that ended on its network (session.mjs outageExit: stage `outage`, cause `outage`), after the Objective last
 * became Running (`runningAt`, GitHub's clock). Null otherwise: a later Blocked notice is the newest (the dispatcher's
 * own once the relaunches are used up, or any other), or the notice is from before the last Running stint (a relaunch
 * began since, so a later Block whose notice never landed is not taken for it; applyExit sets the label first).
 */
export function outageBlockOf(comments, issue, runningAt) {
  const head = `<!-- factory:${issue}:blocked:`;
  const time = (c) => Date.parse(c.created_at) || 0;
  const newest = (comments || []).filter((c) => ours(c) && (c.body || "").startsWith(head)).sort((a, b) => time(a) - time(b) || a.id - b.id).at(-1);
  if (!newest || !newest.body.startsWith(`${head}outage:`) || blockCauseOf(newest.body) !== "outage") return null;
  if (!Number.isFinite(Date.parse(runningAt)) || !(time(newest) > Date.parse(runningAt))) return null;
  return { id: newest.id, key: blockKey(newest), at: newest.created_at };
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
export function relaunchDecision({ record, start, key, lost, at, run = null, max = RELAUNCH_MAX }) {
  const since = triesSince(record, start);
  if (since.some((t) => t.key === key)) return { relaunch: true, tries: since.length, record: null };
  if (since.length >= max) return { block: true, tries: since.length };
  const tries = [...(record?.tries || []), { at, lost, key, start: start ?? null, ...(run ? { run: String(run) } : {}) }].slice(-KEEP_TRIES);
  return { relaunch: true, tries: since.length + 1, record: { tries } };
}

/** The record comment's text after its marker: one line for a person, then the record. */
export function relaunchBody({ tries }, count, { max = RELAUNCH_MAX } = {}) {
  const last = tries.at(-1);
  const how = last?.lost === "outage" ? "it ended on its network (an outage)" : "it vanished with no exit (its runner or sandbox could not report)";
  return `Factory relaunched this Objective's stage: ${count} of ${max} since it was last started; the latest because ${how}. Past ${max} it is Blocked for you.\n<!-- factory:relaunch ${JSON.stringify({ tries })} -->`;
}

/**
 * GitHub's name for a step that runs Factory's own action with no `name:` of its own: `Run <uses>`, with `uses`
 * `clockgrove/factory@<ref>` (the `uses` doctor.mjs and local.mjs read as Factory's).
 */
const OWN_ACTION_STEP = /^Run clockgrove\/factory@\S+$/;

/**
 * How a vanished stage ended when its runner or network was not what ended it, so it is not relaunched; null when it
 * was lost (relaunch it). Decided on structure only, never a log's words:
 * - `{by: "sandbox"}`: on the sandbox, a record that says its stage ended (stage.mjs writes `ended`, with `endedBy` for
 *   a watchdog's kill: it reached GitHub);
 * - on the Action, its last `work (N)` job (stintWorkJob, GitHub's jobs API with its `conclusion` and `steps[]`):
 *   `{by: "cancelled"}` when the job concluded `cancelled` or `timed_out` (a person, or the job's timeout): a stop;
 *   `{by: "setup", step}` when GitHub never started it (triage.mjs neverStarted: no step, no runner; `step` null) or a
 *   step failed before Factory's own ran: GitHub's Set up job (step 1), or any step before the job's last step that
 *   runs Factory's action (OWN_ACTION_STEP); `step` is that step's name. A set-up failure fails the same way every time.
 * Anything else is lost: no job, a job with no failed step of its own (a runner that went away), or Factory's own step
 * failing with no exit written (its network).
 */
export function endedNotLost({ record = null, job = null }) {
  if (record?.state === "ended" || record?.endedBy) return { by: "sandbox" };
  if (!job) return null;
  if (job.conclusion === "cancelled" || job.conclusion === "timed_out") return { by: "cancelled" };
  if (neverStarted(job)) return { by: "setup", step: null };
  const steps = Array.isArray(job.steps) ? job.steps : [];
  const factory = steps.filter((x) => OWN_ACTION_STEP.test(String(x?.name ?? ""))).at(-1);
  const failed = steps.find((x) => x?.conclusion === "failure");
  if (failed && (failed.number === 1 || (factory && failed.number < factory.number))) return { by: "setup", step: String(failed.name ?? "").slice(0, 120) };
  return null;
}

/** The dispatcher's Block reason and cause for a vanished stage endedNotLost placed (`end`), after `note`. */
export function notLostBlock(end, note = "") {
  if (end?.by === "setup") return { reason: `worker job failed before Factory ran: ${end.step ? `its step "${end.step}" failed` : "GitHub never started it (no runner was assigned)"}${note}; a set-up failure, so it was not relaunched`, cause: "setup" };
  if (end?.by === "cancelled") return { reason: `worker job vanished: its work job was cancelled (a person, or its timeout)${note}; a stop, so it was not relaunched`, cause: "factory" };
  return { reason: `worker job vanished: Running with no job in progress${note}`, cause: "factory" };
}

/**
 * The Running stint's `work (N)` job, or null: only a job created in the stint (from `since`) counts. The dispatcher that
 * applied `factory:running` named the job in its own run: `run`, when the record names the relaunch's run, is read
 * first; else the runs created in the hour up to the label (that run was created before it; any status, since a run's
 * wake job may still sleep), the newest first, at most `maxRuns` of them, one jobs read each.
 */
export async function stintWorkJob(repo, n, since, opts, { run = null, maxRuns = 10 } = {}) {
  const at = Date.parse(since);
  if (!Number.isFinite(at)) return null;
  const inStint = (j) => j.name === `work (${n})` && Date.parse(j.created_at ?? j.started_at) >= at - CLOCK_SKEW_MS;
  const jobsOf = async (id) => (await rest(`repos/${repo.full}/actions/runs/${id}/jobs?per_page=100`, opts))?.jobs || [];
  if (run) {
    const job = (await jobsOf(run)).find(inStint);
    if (job) return job;
  }
  const window = `${new Date(at - 60 * 60_000).toISOString()}..${new Date(at).toISOString()}`;
  const runs = (await rest(`repos/${repo.full}/actions/workflows/${workflowFile()}/runs?created=${encodeURIComponent(window)}&per_page=${maxRuns}`, opts))?.workflow_runs || [];
  for (const r of runs.slice(0, maxRuns)) {
    if (String(r.id) === String(run)) continue;
    const job = (await jobsOf(r.id)).find(inStint);
    if (job) return job;
  }
  return null;
}

/** The Actions run that made the latest relaunch the record holds, or null. */
export const relaunchRun = (record) => record?.tries?.at(-1)?.run ?? null;

/** The issue's timeline (label events and comments), for personStart, the outage notice and the record. */
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
