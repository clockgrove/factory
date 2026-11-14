// A person's stop of one Objective (docs/USAGE.md, "An Objective's lifecycle"): its `factory:objective` label removed,
// or its issue closed. No tick, loop or relaunch picks a stopped Objective (they list only labelled, open issues); this
// module is the rest of it: the cause read from the issue, the running stage's own stop (its watch on its issue, the
// abort every harness pass of the stage listens to, its claim on the exit), and the tidy that leaves the Objective
// stopped (its PR a draft without the review label, its state label off, its card back in Queued).
import { dequeuePr, findPr, findProject, getPr, mergeQueueEntry, moveCard, removeLabel, setDraft, setStateLabel } from "./github.mjs";
import { log } from "./inputs.mjs";
import { REVIEW_LABEL } from "./logic.mjs";

/** How often a running stage reads its issue for a stop. */
export const STOP_POLL_MS = 60_000;
/** How long a stopping stage waits for its harness passes to end (proc.mjs exec kills a stopped one within 15 s). */
export const STOP_SETTLE_MS = 30_000;
/** The longest a stopping stage takes to write its end before it exits anyway. */
export const STOP_EXIT_MS = 120_000;
/**
 * How long after its stop a stopped Objective may still carry the Running label before the dispatcher tidies it (its
 * stage died, or never saw the stop): past what a live stage's own stop takes (a poll, the settle, the exit).
 */
export const STOP_GRACE_MS = 10 * 60_000;

const names = (issue) => (issue?.labels || []).map((l) => (typeof l === "string" ? l : l?.name));

/** Why the issue's Objective is stopped: "closed", "unlabeled" (its Objective label is off), or null when it is not. */
export function stopCause(issue, label) {
  if (!issue) return null;
  if (issue.state && issue.state !== "open") return "closed";
  if (!names(issue).includes(label)) return "unlabeled";
  return null;
}

/** The stop's cause in words, for logs, the progress comment and the stage's exit reason (its exit is `stopped`). */
export const stopText = (cause, label = "factory:objective") => (cause === "closed" ? "the issue was closed" : `\`${label}\` was removed`);

// This process's stage: whether a stop was asked for (its cause), the abort its harness passes listen to, and who ends it.
const STOP = { cause: null, ctl: new AbortController(), exit: false };

/** The signal every harness pass of this stage is stopped by (harness.mjs runOnce). */
export const stageStopSignal = () => STOP.ctl.signal;
/** The cause of this stage's stop, or null while it runs on. */
export const stageStopped = () => STOP.cause;

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

/** Resolves at once while the stage runs on; parks it once a stop was asked for, so it makes no change after the stop. */
export const holdIfStopped = () => (STOP.cause ? parked() : Promise.resolve());

/** Tests only: a fresh stage state. */
export function resetStageStop() {
  STOP.cause = null;
  STOP.ctl = new AbortController();
  STOP.exit = false;
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
 */
export function stoppedRecords(passes) {
  return (passes || []).map((r) => (r && r.stopped && !r.noRun && !Number.isFinite(r.usd) && Number.isFinite(r.stoppedUsd) ? { ...r, usd: r.stoppedUsd, usdLowerBound: true, basis: "lower bound: the stage was stopped before the harness reported its cost; the live reading of its stream" } : r));
}
