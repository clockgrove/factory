// A person's stop of one Objective (docs/USAGE.md, "An Objective's lifecycle"): its `factory:objective` label removed,
// or its issue closed; and its restart from the issue's current text (`factory:restart`), which stops a running stage
// the same way before the dispatcher discards what the earlier run left (restartObjective). No tick, loop or relaunch picks a stopped Objective (they list only labelled, open issues); this
// module is the rest of it: the cause read from the issue, the running stage's own stop (its watch on its issue, the
// abort every harness pass of the stage listens to, its claim on the exit), and the tidy that leaves the Objective
// stopped (its PR a draft without the review label, its state label off, its card back in Queued).
import { dequeuePr, findPr, findProject, getPr, listComments, mergeQueueEntry, moveCard, removeLabel, rest, setDraft, setStateLabel, upsertComment } from "./github.mjs";
import { log } from "./inputs.mjs";
import { REVIEW_LABEL, marker, trustedAuthor } from "./logic.mjs";

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

const names = (issue) => (issue?.labels || []).map((l) => (typeof l === "string" ? l : l?.name));

/**
 * Why the issue's Objective is stopped: "closed", "unlabeled" (its Objective label is off), "restart" (a restart is
 * asked for: its running stage stops first, and nothing starts until the dispatcher has restarted it), or null.
 */
export function stopCause(issue, label) {
  if (!issue) return null;
  if (issue.state && issue.state !== "open") return "closed";
  if (!names(issue).includes(label)) return "unlabeled";
  if (names(issue).includes(RESTART_LABEL)) return "restart";
  return null;
}

/** The stop's cause in words, for logs, the progress comment and the stage's exit reason (its exit is `stopped`). */
export const stopText = (cause, label = "factory:objective") => (cause === "closed" ? "the issue was closed" : cause === "restart" ? `\`${RESTART_LABEL}\` was applied` : `\`${label}\` was removed`);

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

/** The record's body: the restart's time, and what it discarded. */
export const restartRecord = ({ at, pr = null }) => `<!-- factory:restart ${JSON.stringify({ at, ...(pr ? { pr } : {}) })} -->\nFactory restarted this Objective from the issue's current text (\`${RESTART_LABEL}\`, applied ${at}).${pr ? ` Its earlier pull request #${pr} is closed and its branch deleted; its history stays on that pull request.` : ""} The earlier plan and comments do not feed the restarted run; it starts from the default branch.`;

/**
 * Restart the issue's Objective from its current text (`at`: when the restart label was applied), once no stage of it
 * runs: the restart's record first; the earlier PR closed with a comment linking the record (its history stays on it,
 * out of the merge queue first); the factory/<issue> branch deleted; the plan comment and a split's parts record
 * retired (their markers renamed, their text kept), so the restarted run reads neither; every state label off, the card
 * in Queued, and the restart label off last. Each step is idempotent, so a restart cut off halfway is finished by the
 * next tick. Throws when a step fails: the label stays and the next tick tries again.
 */
export async function restartObjective(repo, issue, { at, project = undefined }, opts) {
  const pr = await findPr(repo, `factory/${issue}`, opts);
  const key = restartMarker(issue, at);
  const record = await upsertComment(repo, issue, key, restartRecord({ at, pr: pr?.number ?? null }), opts);
  if (pr?.number) {
    if (await mergeQueueEntry(repo, pr.number, opts).catch(() => null)) await dequeuePr(repo, pr.node_id ?? (await getPr(repo, pr.number, opts)).node_id, opts);
    await removeLabel(repo, pr.number, REVIEW_LABEL, opts);
    const link = record?.html_url ? ` ([the restart](${record.html_url}))` : "";
    await upsertComment(repo, pr.number, marker(issue, "restarted", String(at).replace(/[^0-9TZ]/g, "")), `Factory: #${issue} was restarted from its current text${link}. This pull request is closed and its branch deleted; its commits and review stay here. The restarted run opens a new one.`, opts);
    await rest(`repos/${repo.full}/pulls/${pr.number}`, { ...opts, method: "PATCH", body: { state: "closed" } });
  }
  await rest(`repos/${repo.full}/git/refs/heads/${encodeURIComponent(`factory/${issue}`).replace(/%2F/g, "/")}`, { ...opts, method: "DELETE" }).catch((e) => {
    if (![404, 422].includes(e.status)) throw e;
  });
  // The earlier plan and split record, kept readable under markers no reader looks for (handoff.mjs currentPlan, partsRecord).
  const retire = [
    [`${marker(issue, "plan")}`, `${marker(issue, "restarted-plan")}`],
    [`<!-- factory:${issue}:parts `, `<!-- factory:${issue}:restarted-parts `],
  ];
  for (const c of await listComments(repo, issue, opts)) {
    const hit = retire.find(([from]) => (c.body || "").startsWith(from));
    if (!hit || !trustedAuthor(c)) continue;
    await rest(`repos/${repo.full}/issues/comments/${c.id}`, { ...opts, method: "PATCH", body: { body: `${hit[1]}${c.body.slice(hit[0].length)}` } });
  }
  await setStateLabel(repo, issue, null, opts);
  if (project === undefined) project = await findProject(repo, opts).catch(() => null);
  await moveCard(project, repo, issue, "Queued", opts).catch((e) => log(`#${issue} restart: card: ${String(e?.message || e).slice(0, 120)}`));
  await removeLabel(repo, issue, RESTART_LABEL, opts);
  return { pr: pr?.number ?? null };
}
