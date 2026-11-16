// A stage lost to a network failure on the Action's runners and the cloud sandbox is relaunched (#245): one that ended on
// an `outage` (session.mjs outageExit: its Block, written as the stage's one try), and one that vanished with no exit at
// all (the dispatcher's Running pass: no live job, no lease). Such losses are almost always transient, so the dispatcher
// starts the Objective's work again on its branch, in the slot it held, at most RELAUNCH_MAX times since a person last
// started it; past that it Blocks for a person. The count is a record Factory owns on the issue, so a dispatcher that
// restarts keeps it. The local route pauses and resumes a stage itself (local.mjs) and never gets here.
import { addLabels, moveCard, removeLabel, rest, setStateLabel, upsertComment, workflowFile } from "./github.mjs";
import { CLOCK_SKEW_MS, blockCauseOf, isSelf, marker, restartedAt, selfLogin, trustedAuthor } from "./logic.mjs";
import { startTime } from "./objective-trust.mjs";
import { failedStep, neverStarted, reports } from "./triage.mjs";
import { parseYaml } from "./yaml.mjs";

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
 * When a person last started the Objective, which starts the relaunch count over: its label applied or its draft label
 * taken off by someone `trusted` takes as a person's go (objective-trust.mjs startTime), or a restart (logic.mjs
 * restartedAt). Null when none can be told.
 */
export async function personStart(events, comments, label, trusted) {
  const times = [await startTime(events, label, trusted), restartedAt(comments)].filter((t) => Number.isFinite(Date.parse(t)));
  return times.sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) ?? null;
}

/** The record's tries counted against `start`: the relaunches since a person last started the Objective. */
export const triesSince = (record, start) => (record?.tries || []).filter((t) => (t.start ?? null) === (start ?? null));

/**
 * What the dispatcher does with a lost stage: `{relaunch: true, tries}` with the record to write (`record`, null when the
 * same loss was counted already and only its relaunch is to finish), or `{block: true, tries}` once RELAUNCH_MAX
 * relaunches since `start` were used. `setup`: the step a vanished work job failed at before Factory ran (endedNotLost
 * `{step, number}`), kept on the try so the next loss can be told to fail at the same step (setupAgain).
 */
export function relaunchDecision({ record, start, key, lost, at, run = null, setup = null, max = RELAUNCH_MAX }) {
  const since = triesSince(record, start);
  if (since.some((t) => t.key === key)) return { relaunch: true, tries: since.length, record: null };
  if (since.length >= max) return { block: true, tries: since.length };
  const tries = [...(record?.tries || []), { at, lost, key, start: start ?? null, ...(run ? { run: String(run) } : {}), ...(setup ? { setup: { step: setup.step ?? null, number: setup.number ?? null } } : {}) }].slice(-KEEP_TRIES);
  return { relaunch: true, tries: since.length + 1, record: { tries } };
}

/** The record comment's text after its marker: one line for a person, then the record. */
export function relaunchBody({ tries }, count, { max = RELAUNCH_MAX } = {}) {
  const last = tries.at(-1);
  const how = last?.lost === "outage" ? "it ended on its network (an outage)" : "it vanished with no exit (its runner or sandbox could not report)";
  return `Factory relaunched this Objective's stage: ${count} of ${max} since it was last started; the latest because ${how}. Past ${max} it is Blocked for you.\n<!-- factory:relaunch ${JSON.stringify({ tries })} -->`;
}

/**
 * How a vanished stage ended when its runner or network was not what ended it, so it is not relaunched; null when it
 * was lost (relaunch it). Decided on structure only, never a log's words:
 * - `{by: "sandbox"}`: on the sandbox, a record that says its stage ended (stage.mjs writes `ended`, with `endedBy` for
 *   a watchdog's kill: it reached GitHub);
 * - on the Action, its last `work (N)` job (stintWorkJob, GitHub's jobs API with its `conclusion` and `steps[]`):
 *   `{by: "cancelled"}` when the job concluded `cancelled` or `timed_out` (a person, or the job's timeout): a stop;
 *   `{by: "setup", step, number}` when GitHub never started it (triage.mjs neverStarted: no step, no runner; `step` and
 *   `number` null), or its first failed step came before Factory's own ran: GitHub's Set up job (step 1), or a step
 *   numbered below `workStep`, Factory's work step's number read from the workflow file (workStepNumber); `step` and
 *   `number` are the failed step's. One such failure may be passing (a checkout's or a token mint's 5xx, a runner not
 *   acquired), so the dispatcher relaunches it once; the same step failing on the relaunch's job too (setupAgain) is a
 *   set-up that fails the same way every time, and Blocks.
 * Anything else is lost: no job, a job with no failed step of its own (a runner that went away), Factory's own step
 * failing with no exit written (its network), or a failed step that cannot be placed (`workStep` null: the workflow
 * file unread; the caller logs that).
 */
export function endedNotLost({ record = null, job = null, workStep = null }) {
  if (record?.state === "ended" || record?.endedBy) return { by: "sandbox" };
  if (!job) return null;
  if (job.conclusion === "cancelled" || job.conclusion === "timed_out") return { by: "cancelled" };
  if (neverStarted(job)) return { by: "setup", step: null, number: null };
  const failed = failedStep(job);
  if (failed && (failed.number === 1 || (Number.isInteger(workStep) && failed.number < workStep))) return { by: "setup", step: String(failed.name ?? "").slice(0, 120), number: failed.number };
  return null;
}

/**
 * Whether a set-up failure (endedNotLost `{by: "setup"}`) is the second in a row at the same step: the latest relaunch
 * since `start` (triesSince) was made for a job that failed at that step too (its try's `setup`: the same number and
 * name, or both never started).
 */
export function setupAgain(record, start, end) {
  const last = triesSince(record, start).at(-1)?.setup;
  return !!last && end?.by === "setup" && (last.number ?? null) === (end.number ?? null) && (last.step ?? null) === (end.step ?? null);
}

/**
 * Whether placing a vanished stage's work job needs its workflow file (endedNotLost `workStep`): a job GitHub started,
 * not cancelled, whose first failed step is after GitHub's Set up job.
 */
export const needsWorkStep = (job) => !!job && job.conclusion !== "cancelled" && job.conclusion !== "timed_out" && !neverStarted(job) && (failedStep(job)?.number ?? 1) !== 1;

/**
 * The number Factory's work step has in GitHub's `steps[]` for the job reporting `jobName`, read from the workflow file's
 * text: GitHub's Set up job is step 1 and the job's YAML steps follow in order, so the step at index i is i + 2. Factory's
 * work step is the top-level step that `uses: clockgrove/factory@…` with `mode: work` (Factory renders the workflow;
 * the account step runs the same action with `mode: account`). Null when the text does not parse or names no such step.
 */
export function workStepNumber(text, jobName) {
  let doc;
  try {
    doc = parseYaml(String(text || ""));
  } catch {
    return null;
  }
  for (const [id, j] of Object.entries(doc?.jobs || {})) {
    if (!reports(typeof j?.name === "string" ? j.name : id, jobName) || !Array.isArray(j?.steps)) continue;
    const i = j.steps.findIndex((st) => /^clockgrove\/factory@\S+$/.test(String(st?.uses ?? "").trim()) && st?.with?.mode === "work");
    if (i >= 0) return i + 2;
  }
  return null;
}

/**
 * Factory's work step's number for a vanished work job (workStepNumber), from the workflow file at the job's commit
 * (`head_sha`): this workflow's own file (github.mjs workflowFile), one contents read. Null when it cannot be read.
 */
export async function stintWorkStep(repo, job, opts) {
  if (!job?.head_sha) return null;
  const text = await rest(`repos/${repo.full}/contents/.github/workflows/${workflowFile()}?ref=${job.head_sha}`, { ...opts, raw: "Accept: application/vnd.github.raw+json" }).then(String, () => "");
  return text ? workStepNumber(text, job.name) : null;
}

/** The dispatcher's Block reason and cause for a vanished stage endedNotLost placed (`end`), after `note`. */
export function notLostBlock(end, note = "") {
  if (end?.by === "setup") return { reason: `worker job failed before Factory ran: ${end.step ? `its step "${end.step}" failed, as it did on the job Factory relaunched it from` : "GitHub never started it (no runner was assigned), nor the job Factory relaunched it from"}${note}; a set-up failure that fails the same way every time, so it was not relaunched again`, cause: "setup" };
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
