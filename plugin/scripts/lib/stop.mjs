// A person's stop of one Objective (docs/USAGE.md, "An Objective's lifecycle"): its `factory:objective` label removed,
// its issue closed, or `factory:draft` applied (a draft never runs, its Objective label on or not); and its restart from the issue's current text (`factory:restart`), which stops a running stage
// the same way before the dispatcher discards what the earlier run left (restartObjective). No tick, loop or relaunch picks a stopped Objective (they list only labelled, open issues); this
// module is the rest of it: the cause read from the issue, the running stage's own stop (its watch on its issue, the
// abort every harness pass of the stage listens to, its claim on the exit), and the tidy that leaves the Objective
// stopped (its PR a draft without the review label, its state label off, its card back in Queued).
import { dequeuePr, findPr, findProject, getIssue, getPr, listComments, mergeQueueEntry, moveCard, removeLabel, rest, setDraft, setStateLabel, upsertComment } from "./github.mjs";
import { log } from "./inputs.mjs";
import { REVIEW_LABEL, marker, restartedAt, trustedAuthor } from "./logic.mjs";

/** How often a running stage reads its issue for a stop. */
export const STOP_POLL_MS = 60_000;
/** How long a stopping stage waits for its harness passes to end (proc.mjs exec kills a stopped one within 15 s). */
export const STOP_SETTLE_MS = 30_000;
/**
 * The longest a stopping stage takes before it exits anyway: past it, what is left of its end is written at once,
 * synchronously (the usage, a lower bound; the spend line as the stop signal writes it), and the process exits.
 */
export const STOP_EXIT_MS = 120_000;
/** How long a stopped stage gives its GitHub tidy (applyStop), its usage already written: the dispatcher finishes the rest. */
export const STOP_TIDY_MS = 45_000;
/**
 * How long after its stop a stopped Objective may still carry the Running label before the dispatcher tidies it (its
 * stage died, or never saw the stop): past what a live stage's own stop takes (a poll, the settle, the exit).
 */
export const STOP_GRACE_MS = 10 * 60_000;

/** The label a person applies to restart an Objective from its issue's current text, in any state. */
export const RESTART_LABEL = "factory:restart";
/**
 * The label of a draft Objective: an issue Factory never runs (no dispatch, claim or spend, on any route) while it is
 * on, even beside the Objective label. Starting a draft takes it off and applies the Objective label.
 */
export const DRAFT_LABEL = "factory:draft";

const names = (issue) => (issue?.labels || []).map((l) => (typeof l === "string" ? l : l?.name));

/** Whether the issue is a draft (DRAFT_LABEL on it). */
export const isDraft = (issue) => names(issue).includes(DRAFT_LABEL);

/**
 * Whether the issue's Objective may run, and if not why: the one answer the dispatcher, the launcher, the worker, the
 * review job, the merge pass and the local loop each read. "closed", "draft" (DRAFT_LABEL on it, whatever else is),
 * "unlabeled" (its Objective label is off), "restart" (a restart is asked for: its running stage stops first, and
 * nothing starts until the dispatcher has restarted it), or null: it may run.
 */
export function stopCause(issue, label) {
  if (!issue) return null;
  if (issue.state && issue.state !== "open") return "closed";
  if (isDraft(issue)) return "draft";
  if (!names(issue).includes(label)) return "unlabeled";
  // `restarted`: a restart recorded after the reader's stage began (objectiveReader), its label already gone.
  if (names(issue).includes(RESTART_LABEL) || issue.restarted === true) return "restart";
  return null;
}

/**
 * A stage's read of its issue for its watch and its last checks (stop.mjs watchObjective, confirmRunning): the issue
 * (`read`), marked `restarted` once its comments (`list`, read again only when the issue's comment count changed) hold a
 * restart record other than, and newer than, the newest one at the stage's first read (`prime()`, called as the stage
 * starts), so a stage that missed the restart's label still learns of it. Records are compared with each other only,
 * never with this machine's clock, which may be behind GitHub's.
 */
export function objectiveReader({ read, list }) {
  let count = null;
  let base;
  let restarted = false;
  const reader = async () => {
    const issue = await read();
    if (!restarted && issue && issue.comments !== count) {
      const at = restartedAt(await list());
      count = issue.comments;
      if (base === undefined) base = at;
      else restarted = !!at && at !== base && (!base || Date.parse(at) > Date.parse(base));
    }
    return restarted ? { ...issue, restarted: true } : issue;
  };
  /** The stage's first read: the restart records already there are no restart of this stage. A failed read waits for the next. */
  reader.prime = () => reader().catch(() => null);
  return reader;
}

/** The stop's cause in words, for logs, the progress comment and the stage's exit reason (its exit is `stopped`). */
export const stopText = (cause, label = "factory:objective") =>
  cause === "closed" ? "the issue was closed" : cause === "restart" ? `\`${RESTART_LABEL}\` was applied` : cause === "draft" ? `\`${DRAFT_LABEL}\` was applied` : `\`${label}\` was removed`;

// This process's stage: whether a stop was asked for (its cause), the abort its harness passes listen to, who ends it
// (`exit`), and whether its own exit is under way (`committed`: an exit being applied, or a merge), which a later stop
// never overrides.
const STOP = { cause: null, ctl: new AbortController(), exit: false, committed: false };

/** The signal every harness pass of this stage is stopped by (harness.mjs runOnce). */
export const stageStopSignal = () => STOP.ctl.signal;
/** The cause of this stage's stop, or null while it runs on. */
export const stageStopped = () => STOP.cause;
/** Whether the stage is stopping: a stop was asked for and no exit of its own was under way before it. */
export const stopping = () => !!STOP.cause && !STOP.committed;

/**
 * The stage commits to its own exit (applying it, or merging): true from then on, and a stop that comes later ends
 * nothing (session.mjs stopStage; a state label it put back is the dispatcher's to tidy). False when a stop came first:
 * the caller parks, and the stop writes the end.
 */
export function commitExit() {
  if (STOP.committed) return true;
  if (STOP.cause) return false;
  STOP.committed = true;
  return true;
}
/** Whether the stage committed to its own exit. */
export const exitCommitted = () => STOP.committed;

/** Ask this stage to stop: every running harness pass is ended and none starts after. False when it was asked already. */
export function requestStageStop(cause) {
  if (STOP.cause) return false;
  STOP.cause = cause || "unlabeled";
  STOP.ctl.abort();
  return true;
}

/**
 * The stage's end is one writer's: the first to claim it (its own finish, or its stop) writes the exit; the other
 * waits for the process to end. True for the first claim only.
 */
export function claimExit() {
  if (STOP.exit) return false;
  STOP.exit = true;
  return true;
}

/** Never settles: what a stage's main flow waits on once its stop (or its own end) owns the exit. */
export const parked = () => new Promise(() => {});

/**
 * Resolves at once while the stage runs on; parks it once it is stopping, so it makes no change after the stop. Every
 * step that writes to GitHub or starts a command on the stage's behalf waits on it: a harness pass (harness.mjs
 * runOnce), a repository command (checkout.mjs sh), a push (outbox.mjs), the PR's text (handoff.mjs publishPr), the
 * replies (handoff.mjs postReplies) and every exit.
 */
export const holdIfStopped = () => (stopping() ? parked() : Promise.resolve());

/**
 * Before the stage's last changes (its exit, its merge): its issue read once more, since the watch reads it only once
 * a minute. A stopped Objective asks for the stop (`onStop`) and parks the caller; a read that fails goes on.
 */
export async function confirmRunning({ read, label, onStop, commit = false }) {
  await holdIfStopped();
  const cause = stopCause(await read().catch(() => null), label);
  // `commit`: the caller's exit begins now (commitExit), with no await between the read and the commit, so a stop after
  // the read ends nothing (the dispatcher's stopped pass tidies what the exit leaves) and one before it parks the caller.
  if (!cause || STOP.committed) return commit && !commitExit() ? parked() : true;
  onStop(cause);
  return parked();
}

/** Tests only: a fresh stage state. */
export function resetStageStop() {
  STOP.cause = null;
  STOP.ctl = new AbortController();
  STOP.exit = false;
  STOP.committed = false;
}

/**
 * Read the issue (`read`) every `everyMs`; on the first read that shows the Objective stopped (stopCause), stop
 * watching and call `onStop(cause)` once. A failed read is no answer: the next one decides. The timer never keeps the
 * process alive. Returns {stop()} to end the watch.
 */
export function watchObjective({ read, label, everyMs = STOP_POLL_MS, onStop }) {
  let done = false;
  let busy = false;
  const timer = setInterval(async () => {
    if (done || busy) return;
    busy = true;
    let cause = null;
    try {
      cause = stopCause(await read(), label);
    } catch {
      // unread: the next poll reads it again
    } finally {
      busy = false;
    }
    if (!cause || done) return;
    done = true;
    clearInterval(timer);
    onStop(cause);
  }, everyMs);
  timer.unref?.();
  return {
    stop: () => {
      done = true;
      clearInterval(timer);
    },
  };
}

/**
 * Leave the issue's Objective stopped: its open PR (`pr`, or the factory/<issue> branch's, found here when undefined) out
 * of the merge queue and a draft without the review label, so nothing merges it and no review starts; and, unless the issue is closed (the
 * dispatcher's Done pass moves a closed one), no state label and its card in Queued, so re-applying the label starts it
 * again. Each step is tried whatever the one before did; returns the failures' messages (none: []).
 */
export async function applyStop(repo, issue, { pr = undefined, closed = false, project = undefined } = {}, opts) {
  const failed = [];
  const step = async (what, fn) => {
    try {
      await fn();
    } catch (e) {
      failed.push(`${what}: ${String(e?.message || e).slice(0, 120)}`);
    }
  };
  if (pr === undefined) pr = await findPr(repo, `factory/${issue}`, opts).catch((e) => (failed.push(`PR: ${String(e?.message || e).slice(0, 120)}`), null));
  if (pr?.number) {
    // Out of the merge queue first, where it waits (a draft cannot merge, and the queue never takes it back by itself).
    await step(`PR #${pr.number} out of the merge queue`, async () => {
      if (!(await mergeQueueEntry(repo, pr.number, opts))) return;
      await dequeuePr(repo, pr.node_id ?? (await getPr(repo, pr.number, opts)).node_id, opts);
    });
    await step(`PR #${pr.number} to draft`, () => setDraft(repo, pr.number, true, opts));
    await step(`PR #${pr.number}'s ${REVIEW_LABEL} label`, () => removeLabel(repo, pr.number, REVIEW_LABEL, opts));
  }
  if (!closed) {
    await step("state label", () => setStateLabel(repo, issue, null, opts));
    if (project === undefined) project = await findProject(repo, opts).catch(() => null);
    await step("card", () => moveCard(project, repo, issue, "Queued", opts));
  }
  for (const f of failed) log(`#${issue} stop: ${f}`);
  return failed;
}

/**
 * The stopped stage's records for its usage: each harness pass this stage ran (harness.mjs stagePasses). A pass the
 * stop ended before its harness reported dollars (a Claude run prints them only in its last line) counts its stream's
 * live reading (`stoppedUsd`, harness.mjs runOnce), a lower bound, so the stop's spend is recorded once and not lost.
 * `open`: the passes still running (harness.mjs openPasses), each at its live reading, a lower bound too.
 */
export function stoppedRecords(passes, open = []) {
  return [...(passes || []), ...open].map((r) => (r && r.stopped && !r.noRun && !Number.isFinite(r.usd) && Number.isFinite(r.stoppedUsd) ? { ...r, usd: r.stoppedUsd, usdLowerBound: true, basis: "lower bound: the stage was stopped before the harness reported its cost; the live reading of its stream" } : r));
}

/** The restart's record on the issue (logic.mjs restartedAt reads it): one per restart, keyed by its time. */
export const restartMarker = (issue, at) => marker(issue, "restart", String(at).replace(/[^0-9TZ]/g, ""));

/** The fields of a restart record's comment (its JSON line), or null. */
export function restartRecordOf(comment) {
  const m = /^<!-- factory:\d+:restart:[0-9TZ]+ -->\n<!-- factory:restart (\{[^\n]*\}) -->/.exec(comment?.body || "");
  if (!m) return null;
  try {
    const v = JSON.parse(m[1]);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

/**
 * The record's body: the restart's time (when the label was applied), who applied it, the earlier PR and the deleted
 * branch's last commit, which restores the branch.
 */
export const restartRecord = ({ issue, at, by = null, pr = null, head = null }) =>
  `<!-- factory:restart ${JSON.stringify({ at, ...(by ? { by } : {}), ...(pr ? { pr } : {}), ...(head ? { head } : {}) })} -->\nFactory restarted this Objective from the issue's current text (\`${RESTART_LABEL}\`, applied ${at}${by ? ` by ${by}` : ""}).${pr ? ` Its earlier pull request #${pr} is closed; its commits and review stay there.` : ""}${head ? ` Its branch \`factory/${issue}\` is deleted; its last commit was ${head}, and \`git push origin ${head}:refs/heads/factory/${issue}\` restores it.` : ""} The earlier plan and the comments from before the restart do not feed the restarted run; it starts from the default branch.`;

/** A restart Factory could not finish as asked (a ruleset keeps the branch): the dispatcher Blocks with `fix`. */
export class RestartRefused extends Error {
  constructor(message, fix) {
    super(message);
    this.code = "restart-refused";
    this.fix = fix;
  }
}

/**
 * Restart the issue's Objective from its current text (`at`: when the restart label was applied, `by`: who applied it),
 * once no stage of it runs: the restart's record first (the PR and the branch's head an earlier try of this restart
 * recorded are kept, once they are gone); the earlier PR out of the merge queue and its review label off; the
 * factory/<issue> branch deleted, read back after a refusal (only a 404 is gone: a ruleset answers 422 and keeps it,
 * which throws RestartRefused, the PR untouched beyond that); the PR then commented with a link to the record and
 * closed (its history stays on it); the plan comment and a split's parts record retired (their markers renamed, their
 * text kept); and, unless another loop finished this restart meanwhile (its label already off), every state label off,
 * the card in Queued, and the restart label off last. Each step is idempotent, so a restart cut off halfway is finished
 * by the next tick. Throws when a step fails: the label stays and the next tick tries again.
 */
export async function restartObjective(repo, issue, { at, by = null, project = undefined }, opts) {
  const key = restartMarker(issue, at);
  // The label gone already: another loop finished this restart (or a person took the label off). Nothing to do.
  const labelled = (i) => (i?.labels || []).some((l) => (typeof l === "string" ? l : l?.name) === RESTART_LABEL);
  if (!labelled(await getIssue(repo, issue, opts))) return { pr: null, head: null, finished: false };
  const comments = await listComments(repo, issue, opts);
  const prior = restartRecordOf(comments.find((c) => (c.body || "").startsWith(key) && trustedAuthor(c)));
  const pr = await findPr(repo, `factory/${issue}`, opts);
  const ref = `repos/${repo.full}/git/refs/heads/${encodeURIComponent(`factory/${issue}`).replace(/%2F/g, "/")}`;
  const headNow = () =>
    rest(`repos/${repo.full}/git/ref/heads/${encodeURIComponent(`factory/${issue}`).replace(/%2F/g, "/")}`, opts).then(
      (r) => r?.object?.sha ?? null,
      (e) => {
        if (e.status === 404) return null;
        throw e;
      },
    );
  const head = await headNow();
  const fields = { issue, at, by: by ?? prior?.by ?? null, pr: pr?.number ?? prior?.pr ?? null, head: head ?? prior?.head ?? null };
  const record = await upsertComment(repo, issue, key, restartRecord(fields), opts);
  if (pr?.number) {
    if (await mergeQueueEntry(repo, pr.number, opts).catch(() => null)) await dequeuePr(repo, pr.node_id ?? (await getPr(repo, pr.number, opts)).node_id, opts);
    await removeLabel(repo, pr.number, REVIEW_LABEL, opts);
  }
  if (head) {
    await rest(ref, { ...opts, method: "DELETE" }).catch((e) => {
      if (![404, 422].includes(e.status)) throw e;
    });
    if (await headNow()) {
      // Nothing was discarded: the record is retired (its marker renamed), so no reader takes it for a restart and drops
      // the plan, the parts record or the decisions from before it.
      const id = record?.id ?? comments.find((c) => (c.body || "").startsWith(key) && trustedAuthor(c))?.id;
      if (id) await rest(`repos/${repo.full}/issues/comments/${id}`, { ...opts, method: "PATCH", body: { body: `${marker(issue, "restart-undone", String(at).replace(/[^0-9TZ]/g, ""))}\nFactory could not restart this Objective: GitHub kept its branch \`factory/${issue}\`. Nothing was discarded.` } });
      throw new RestartRefused(`the restart could not delete \`factory/${issue}\`: GitHub kept the branch (a ruleset that protects it refuses its deletion)`, `let Factory delete \`factory/*\` branches (the ruleset's bypass list, or a rule that leaves them out), or delete \`factory/${issue}\` yourself, then apply \`${RESTART_LABEL}\` again`);
    }
  }
  // The PR the record names: GitHub closed it when its branch went, so a retry finds it closed and still comments on it.
  if (fields.pr) {
    const link = record?.html_url ? ` ([the restart](${record.html_url}))` : "";
    await upsertComment(repo, fields.pr, marker(issue, "restarted", String(at).replace(/[^0-9TZ]/g, "")), `Factory: #${issue} was restarted from its current text${link}. This pull request is closed and its branch deleted; its commits and review stay here. The restarted run opens a new one.`, opts);
    // Only an open PR is closed: one the merge queue merged before this retry stays as it is (closing it fails every tick).
    if ((await getPr(repo, fields.pr, opts))?.state === "open") await rest(`repos/${repo.full}/pulls/${fields.pr}`, { ...opts, method: "PATCH", body: { state: "closed" } });
  }
  // The earlier plan and split record, kept readable under markers no reader looks for (handoff.mjs planOf, partsRecord,
  // which also skip anything from before the restart).
  const retire = [
    [`${marker(issue, "plan")}`, `${marker(issue, "restarted-plan")}`],
    [`<!-- factory:${issue}:parts `, `<!-- factory:${issue}:restarted-parts `],
  ];
  for (const c of comments) {
    const hit = retire.find(([from]) => (c.body || "").startsWith(from));
    if (!hit || !trustedAuthor(c)) continue;
    await rest(`repos/${repo.full}/issues/comments/${c.id}`, { ...opts, method: "PATCH", body: { body: `${hit[1]}${c.body.slice(hit[0].length)}` } });
  }
  // Another loop that finished this restart first may have started the Objective since: its Running label stays.
  if (!labelled(await getIssue(repo, issue, opts))) return { pr: fields.pr, head: fields.head, finished: false };
  await setStateLabel(repo, issue, null, opts);
  if (project === undefined) project = await findProject(repo, opts).catch(() => null);
  await moveCard(project, repo, issue, "Queued", opts).catch((e) => log(`#${issue} restart: card: ${String(e?.message || e).slice(0, 120)}`));
  await removeLabel(repo, issue, RESTART_LABEL, opts);
  return { pr: fields.pr, head: fields.head, finished: true };
}
