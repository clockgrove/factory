#!/usr/bin/env node
// Pendulum worker job: one Objective, one branch, one PR.
//   node scripts/worker.mjs --repo OWNER/NAME --issue N [--checkout DIR] [--usage-dir DIR]
// Steps: doctor's job checks; checkout pendulum/<issue> from the default branch;
// write the plugin's skills and agent definitions into the checkout (git-excluded);
// setup and the lockfile's install; render the task card and $PENDULUM_IN, and launch the
// harness headless under a wall clock; read what it left in $PENDULUM_OUT (lib/handoff.mjs),
// push its commits and open or update the PR from pr.md, the plan comment from plan.md;
// run the repository's validation as Pendulum's own pass (two at most, failures sent
// back to the same harness); decide the exit (delivered, question, blocked); move the
// card, set the label, draft/comment/request as the exit says; write usage/events.jsonl
// and usage/result.json for the artifact. The harness writes nothing to GitHub.
import { agentServicePorts, noteSetupStart, pinRunnerGit } from "./lib/claude-runner.mjs";
import { pathToFileURL } from "node:url";
import { existsSync, mkdirSync } from "node:fs";
import { dropOwned, privateTmp, writeOwn } from "./lib/fsafe.mjs";
import { join, resolve } from "node:path";
import { PLUGIN_ROOT, branchIdentity, installCommand, installDeps, installPlugin, installTools, runnerFileEnv, runSetup } from "./lib/checkout.mjs";
import { LIMIT, USAGE_LIMIT, UsageLimitReached, credentialEnv, gatewaySession, harnessVersion, runHarness, scrubbedEnv, stageLimits, stageSpendSoFar } from "./lib/harness.mjs";
import { addLabels, findPr, getIssue, getRepo, listComments, prComment, primeWriters, markReady, removeLabel, repoOf, rest, runningSince } from "./lib/github.mjs";
import { commandFailed, log, mask, parseArgs, postedError, redactSecrets, resolveInputs, setOutput } from "./lib/inputs.mjs";
import { unpricedCodex } from "./lib/usage.mjs";
import { REVIEW_LABEL, conflictFiles, ontoRecord, rebaseCost, copilotCount, costByPhase, stageSpendLine, usdText, unmeteredRun, decideExit, decisionsRead, marker, maxUsdReached, planAskedOf, protectedPaths, protectedTouched, sessionCapNote, setupPaths, sumSpend, isSelf, restartedAt } from "./lib/logic.mjs";
import { TASK_CARD_TEMPLATE, servedSilent, applyExit as applyExitNow, buildPrompt, commitAuthor, openAccess, configureGit, crashed, deadline, doctorBlock, earlyOutageEnd, exitStep, outageExit, outageFirst, usageLimitExit, exitRecord, gitIdentity, lastMessage, liveActivity, markRunning, maskFile, objectiveDecisions, observe, postHandedOff, postValidated, progressReporter, rebaseExitLine, recordMergeable, remainingMs, reviewScope, restoreTranscript, saveAgentTranscript, saveTranscript, stageThreads, stopStage, stoppedRebase, unreadNow, validationLoop, writeUsage } from "./lib/session.mjs";
import { eventPayload, stageSealKey, usageSeal } from "./lib/seal.mjs";
import { DRAFT_LABEL, RESTART_LABEL, claimExit, objectiveReader, commitExit, confirmRunning, holdIfStopped, parked, stopCause, watchObjective } from "./lib/stop.mjs";
import { openOutbox } from "./lib/outbox.mjs";
import { allowAgentEnv } from "./lib/agent.mjs";
import { jobChecks } from "./doctor.mjs";
import { routeInputs, stageMoves } from "./lib/accounts.mjs";
import { routeLimits } from "./lib/route-holds.mjs";
import { reviewHold, waitReason } from "./lib/overlap.mjs";
import { accountGate, authorGate, choiceGate, planGate, startedAt } from "./lib/objective-trust.mjs";
import { ranWith } from "./lib/choice.mjs";
import { agentUser, exec } from "./lib/proc.mjs";
import { backend, spendInProgress } from "./lib/backend.mjs";
import { openStageHosts, prepareClone, refusalExit } from "./lib/local.mjs";
import { OUTAGE, outageMet, stopWaiting, unreachable, waitOutages } from "./lib/network.mjs";
import { exitFromOut, handoverChecker, handoverOnIssue, handoverUpFront, isSplitPart, openHandoff, reviewsCover, partsRecord, postNote, publishPr, recordPart } from "./lib/handoff.mjs";
import { plannedWorkflows, workflowPathsNamed } from "./lib/handover.mjs";
import { openTriage, triageKey } from "./lib/triage.mjs";
import { missingSecretsFix, openWorkerSecrets, packShellSecrets } from "./lib/worker-secrets.mjs";
import { closeWorkerRelay, openWorkerRelay } from "./lib/worker-relay.mjs";
import { CALL_LOG, stageBlockCause, stageBlockReason } from "./lib/gateway-relay.mjs";
import { GOALS, openDrift } from "./lib/drift.mjs";
import { openFenceCheck } from "./lib/fence-check.mjs";
import { openProgressCheck } from "./lib/fix-progress.mjs";
import { openKeptCheck } from "./lib/kept.mjs";
import { answerAtStart, openAnswerCheck, reopenQuestion } from "./lib/answer-check.mjs";
import { answeredRepos, declaredQuestion, planNeeds as planNeedsOf, plannedRepos } from "./lib/one-repo.mjs";
import { judgedAnswers, openPlanAnswerCheck } from "./lib/plan-answer.mjs";
import { CLEAN_REFUSED, checkoutHolds, continuePrompt, decisionsFed, enterStage, installEnd, keptPrompt, loginOf, pauseRecord } from "./lib/continue.mjs";
import { openEditCheck } from "./lib/edit-check.mjs";

/**
 * The conflict pass: the task card, then the rebase to make. `cause` says why the branch fell behind: a sibling
 * merging (a send-back), or the default branch changing a workflow file during the run (outbox.mjs catchUp).
 */
export function conflictPassPrompt({ prompt, branch, defaultBranch, cause = "after a sibling merged" }) {
  const here = `Your branch ${branch} fell behind ${defaultBranch} ${cause}, and \`git rebase origin/${defaultBranch}\` conflicts. Rebase it onto origin/${defaultBranch} (Pendulum has fetched it; never fetch or pull), resolve each conflict keeping both the default branch's change and this Objective's intent.`;
  return `${prompt.trimEnd()}\n\n---\n\n${here} Run the validation commands, commit, and stop: Pendulum pushes the branch. Do not ask questions.`;
}

/**
 * Before a send-back's conflict pass is pushed, whatever ended it (a cap, a death, a refusal included): why what it left
 * is not the branch rebased onto `onto.base` (outbox.mjs rebaseLeft), with the outbox blocked so nothing of it goes out,
 * or "" (no send-back conflict, `onto` null, or a good rebase). `judge`: the decision model for a file not exactly the
 * branch's (kept.mjs openKeptCheck), null with no decider; `progress`: where the check's note goes (outbox rebaseNote).
 * In local mode a finished rebase the check stops is kept on a branch of the Objective's clone (`issue`'s, outbox.mjs
 * setAside), and the reason gives its full sha, what to check and the command that delivers it.
 * `limited()`: the stage harness's usage limit that stopped the check's questions (kept.mjs). Then nothing is pushed and
 * it throws UsageLimitReached: the stage ends as a pass meeting the limit does (paused locally until the reset, held or
 * Blocked `provider-quota` elsewhere), and an unanswered question never reads as a change not kept.
 */
export async function sendBackGuard({ outbox, onto, defaultBranch, judge = null, progress = null, limited = null, issue = null }) {
  if (!onto) return "";
  const left = await outbox.rebaseLeft({ from: onto.from, onto: onto.base, judge });
  const limit = limited?.() ?? null;
  if (limit) {
    const why = `the rebase check met ${limit.harness}'s usage limit; nothing of the send-back's conflict pass was pushed, and it is checked again after the reset`;
    outbox.block(why);
    log(why);
    throw new UsageLimitReached(limit, { since: Date.now(), label: "rebase check" });
  }
  // A change the branch undid that the head carries anyway: said on the progress comment when the branch goes out.
  if (!left && outbox.rebaseNote) {
    log(`rebase check: ${outbox.rebaseNote}`);
    try {
      await progress?.(`rebase check: ${outbox.rebaseNote}`);
    } catch (e) {
      log(`rebase note: ${String(e?.message || e).slice(0, 120)}`);
    }
  }
  if (!left) return "";
  // Local mode keeps what the pass left in the Objective's clone (outbox.mjs setAside), and the Block says how to deliver it.
  const kept = await Promise.resolve(outbox.setAside?.()).catch(() => null);
  const clone = issue ? `the Objective's local clone (\`.pendulum/${issue}/repo\`)` : "the Objective's local clone";
  const resume = !kept
    ? ""
    : kept.removed
      ? `; this pass left nothing to keep, so the result of an earlier one kept on the branch \`${kept.name}\` of ${clone} was removed`
      : kept.failed
        ? `; its result could not be kept on a branch of ${clone} (the local loop's log says why)`
        : `; the conflict pass's result is kept as ${kept.sha} on the branch \`${kept.name}\` of ${clone}. To deliver it, first check that it keeps the Objective's change and touches no secret or protected path (Pendulum's push checks did not run on it), then run \`git push --force-with-lease origin ${kept.name}:${kept.branch}\` in that clone and re-apply the Objective's label: the stages after it validate and review that head like any other`;
  const why = `the worker could not resolve the conflict with \`${defaultBranch}\` at ${onto.base.slice(0, 7)} in ${conflictFiles(onto.files)}: ${left}; nothing of it was pushed${resume}`;
  outbox.block(why);
  log(why);
  return why;
}

/** Every exit this stage applies waits while a stop of its Objective is under way: the stop's own exit stands (stop.mjs). */
// `beforeExit`: the stage's last read of its issue (stop.mjs confirmRunning), once its watch runs. A stop racing an exit
// already being applied ends nothing (stop.mjs commitExit); a state label that exit put back is the dispatcher's to tidy.
let beforeExit = null;
// A stage's exit, once it is committed to (a stop that came first parks it).
const settleExit = async () => {
  await holdIfStopped();
  await beforeExit?.();
  if (!commitExit()) await parked();
};
const applyExit = async (...args) => {
  await settleExit();
  return applyExitNow(...args);
};

/**
 * The work stage's answer check (lib/answer-check.mjs answerAtStart), before anything is set up: when the writer
 * comments since the Question this stint resumes give no decision, the stage commits to its exit (`settle`), puts the
 * Objective back to Question with its notice (reopenQuestion) and ends with a Question (`finish`), which a local loop
 * holds for an answer (lib/local.mjs stopHold). A notice that cannot be written Blocks instead, naming why: a Question
 * with no notice since its label would never resume on a comment. Returns whether the stage ended here.
 */
export async function answerGuard({ repo, issue, check, decisions, label, appId = null, opts, prepare = null, notify = null, settle = settleExit, finish }) {
  const answer = await answerAtStart({ repo, issue, check, decisions, label, appId, opts, prepare });
  if (!answer.open) return false;
  log(`answer check: ${answer.open}; the Question stays open`);
  await settle();
  try {
    await reopenQuestion(repo, { issue, notice: answer.notice, label }, opts);
  } catch (e) {
    const code = Number.isInteger(e?.status) ? `HTTP ${e.status}` : String(e?.message || e).slice(0, 120);
    const reason = `the comments since the Question give no decision on it, but its notice could not be written on the issue (${code}), so no comment would resume it`;
    log(reason);
    await applyExitNow(repo, { issue, pr: null, exit: "blocked", reason, cause: "pendulum", notify, stage: "work" }, opts).catch((x) => log(`exit: ${String(x?.message || x).slice(0, 120)}`));
    await finish("blocked", reason);
    return true;
  }
  await finish("question", answer.open);
  return true;
}

async function main() {
  const jobStartMs = Date.now();
  // Pendulum's own temp directory, 700 and out of the agent's reach; the harness and its commands keep the stage's TMPDIR.
  const tmp = privateTmp();
  const args = parseArgs(process.argv.slice(2));
  // On an account (#267) its credential is the step's own input alone, never a job-level variable (accounts.mjs routeInputs).
  const inputs = routeInputs(resolveInputs({ args }));
  if (!inputs.repo) throw new Error("--repo OWNER/NAME (or GITHUB_REPOSITORY) is required");
  if (!inputs.issue) throw new Error("--issue N is required");
  const repo = repoOf(inputs.repo);
  const issue = inputs.issue;
  // The key that opens an earlier stage's sealed session (lib/seal.mjs): the one a sandbox stage's launcher handed over,
  // else derived from the App's private key.
  const sealKey = stageSealKey({ appPrivateKey: inputs.appPrivateKey, repoFull: repo.full });
  let checkout = resolve(args.checkout || process.env.GITHUB_WORKSPACE || process.cwd());
  const usageDir = resolve(args.usage_dir || process.env.PENDULUM_USAGE_DIR || join(checkout, "..", `pendulum-usage-${issue}`));
  mkdirSync(usageDir, { recursive: true });
  const eventsFile = join(usageDir, "events.jsonl");
  const deadlineAt = deadline(jobStartMs, inputs.timeoutMinutes);
  // This machine's network (lib/network.mjs): a GitHub call, a git command or a harness pass that cannot leave it waits
  // in place for its host to answer, up to PENDULUM_LOCAL_WAIT_MINUTES (fifteen by default) on the local route (then the stage ends paused, for serve to
  // resume) and up to the work's deadline elsewhere, where the dispatcher relaunches a stage the network ended. GitHub's
  // primary rate limit spent is the same wait, to its reset: one past that bound ends the stage at once (paused locally,
  // Blocked elsewhere).
  const local = backend().name === "local";
  // The repository's usage-limit waits and, locally, the in-place bound (PENDULUM_LOCAL_WAIT_MINUTES).
  stageLimits(inputs, { local });
  waitOutages({ until: (since) => (local ? Math.min(since + OUTAGE.stageWaitMs, deadlineAt) : deadlineAt) });
  const protectedList = protectedPaths(inputs.protectedAdditions);
  const records = [];
  let passes = 0;
  let pr = null;
  let credentialBasis = "none";
  let cred = { env: {} };
  // The early decision calls' own credential read (readyDecisionEnv), masked like `cred` in everything the stage saves.
  let decisionCred = {};
  // The worker secrets' values (lib/worker-secrets.mjs), masked in the uploaded stream like every other secret.
  let shellSecretValues = [];
  // The gateway relay for an opted-in AI Gateway key (lib/worker-relay.mjs), closed and booked when the stage ends.
  let relay = null;

  // The App token: every write goes through it. The keeper re-mints it during the
  // job (an installation token lives an hour; a job may run six) and the children
  // read it from a file, so a six-hour harness session never holds a stale token.
  // The write token in memory; on Actions the agent uid, its read-only token and its own clone (session.mjs openAccess).
  const pendulumTree = checkout;
  let access;
  try {
    access = await openAccess({ inputs, repo, args, given: pendulumTree });
  } catch (e) {
    // Its token's mint could not reach GitHub (lib/app-token.mjs): the outage's end, before any other.
    if (!unreachable(e)) throw e;
    await earlyOutageEnd(e, { local, usageDir, harness: inputs.harness, model: inputs.model, deadlineAt });
    return;
  }
  const { keeper } = access;
  checkout = access.checkout;
  // notice: local mode's App, for the notices that @mention a person (session.mjs applyExit).
  const token = { token: keeper.getter, notice: access.notice };
  // No agent uid on this runner (no sudo, no systemd): the run Blocks before anything else.
  const agentError = access.agentError || null;
  await primeWriters(repo, token, { maintainers: inputs.maintainers });
  const app = keeper.app;
  const progress = progressReporter(repo, issue, token, { stage: "work", harness: inputs.harness, model: inputs.model });

  let reentry = null;
  // While the work pass runs on the local route (not a send-back's): the pause's record a usage limit leaves for the next
  // work stage to continue (lib/continue.mjs), read as the stage ends on it.
  let pauseNow = null;
  // The harness and model labels this Objective runs on (objective-trust.mjs choiceGate), recorded with its usage.
  let chosenLabels = [];
  // The watch on the issue for a person's stop (stop.mjs), from the moment the stage has checked the issue.
  let watch = null;
  // A send-back's rebase stage ({conflict}): its end writes the rebase line and this Objective's rebases so far (#277).
  let rebaseStage = null;
  // Automatic account choice on GitHub Actions and the cloud sandbox (lib/route-holds.mjs routeLimits, #268): a usage
  // limit holds this stage's account in Pendulum's records on GitHub, and the Objective goes on on a free one.
  let limits = null;
  // The stage's end is written once: by this finish, or by the stop's (stopNow), whichever claims it first.
  const finish = async (exit, reason, outage = null, usageLimit = null) => {
    watch?.stop();
    if (!claimExit()) return parked();
    return finishNow(exit, reason, outage, usageLimit);
  };
  const finishNow = async (exit, reason, outage = null, usageLimit = null) => {
    keeper.stop();
    // The stage's spend as last read, the relay's key spend in it: what a pass that reported no dollars counts.
    const known = await stageSpendSoFar().catch(() => null);
    // Totals once the relay has closed: every call in flight is priced by then.
    await closeWorkerRelay(relay);
    const workerKey = relay ? relay.totals() : null;
    // The raw harness stream is uploaded for 90 days: every secret this job held is masked in it first.
    const masked = maskFile(eventsFile, [...Object.values(cred.env), ...Object.values(decisionCred), ...shellSecretValues, ...keeper.issued, inputs.githubToken, inputs.appPrivateKey]);
    if (masked) log(`masked ${masked} secret occurrence(s) in events.jsonl`);
    // The gateway relay's call log (uploaded with the usage directory) carries text the caller chose: masked the same way.
    const maskedLog = maskFile(join(usageDir, CALL_LOG), [...Object.values(cred.env), ...Object.values(decisionCred), ...shellSecretValues, ...keeper.issued, inputs.githubToken, inputs.appPrivateKey]);
    if (maskedLog) log(`masked ${maskedLog} secret occurrence(s) in ${CALL_LOG}`);
    let usage;
    try {
      usage = writeUsage(usageDir, { progressRun: progress.runId, ran: ranWith(inputs, chosenLabels, process.env.PENDULUM_STAGE_ACCOUNT), spendInProgress: spendInProgress(), harness: inputs.harness, model: inputs.model, records, passes, exit, reason, outage, usageLimit, credentialBasis, reentry, workerKey, harnessVersion: harnessVersion(inputs.harness), session: await (agentUser() ? saveAgentTranscript : saveTranscript)({ harness: inputs.harness, sessionId: records.map((r) => r?.sessionId).filter(Boolean).at(-1) ?? null, also: stageThreads(records), usageDir, checkout, secrets: [...Object.values(cred.env), ...Object.values(decisionCred), ...shellSecretValues, ...keeper.issued, inputs.githubToken, inputs.appPrivateKey] }) });
    } finally {
      // Only now, and whatever happened: the transcript's archive above is made in Pendulum's temp directory (its TMPDIR).
      dropOwned(tmp.pendulum);
    }
    log(`exit: ${exit}${reason ? ` (${reason})` : ""}; usd ${usage.usd ?? "unmetered"}; basis ${usage.basis}`);
    // Blocked on its account's usage limit with no reset reported: automatic account choice passes the account over a while.
    if (limits && exit === "blocked" && usage.limitRefused) await limits.spent(usage.limitRefused).catch((e) => log(`the account's guess could not be written (${String(e?.message || e).slice(0, 120)})`));
    // The provider's quota reading for the account, kept on the holds issue for automatic account choice (#391).
    if (limits && (usage.quota || servedSilent(usage))) await limits.reading(usage.quota ?? { harness: inputs.harness, silent: true }, { warmUntil: usage.cacheWarmUntil ?? null }).catch((e) => log(`the account's quota reading could not be written (${String(e?.message || e).slice(0, 120)})`));
    // Local runs upload no usage artifact: the spend line in the progress comment is what the daily cap counts.
    // Every stage records one, $0 when no harness ran (logic.mjs stageSpendLine).
    if (spendInProgress()) {
      const line = stageSpendLine(usage, { records, known });
      progress.spend(line.usd, line.parts);
    }
    // A rebase's dollars on every route, with the spend line's bound marks: 0 when no harness pass ran, else its passes'
    // (a conflict pass, fix passes).
    let rebaseText = "";
    if (rebaseStage) {
      const cost = rebaseCost(usage, { records, known });
      // The earlier rebases are read from the issue, but not through an outage this stage is ending on; unread, the
      // line names this rebase alone. The rebase line is set before that read, so a stop's write carries it.
      const read = outage ? null : () => listComments(repo, issue, token);
      const passesRan = records.filter((r) => r && !r.noRun && !r.decision).length;
      rebaseText = `; ${await rebaseExitLine(progress, issue, { cost, conflict: rebaseStage.conflict, passes: passesRan }, read)}`;
    }
    await progress(`exit: ${exit}${reason ? ` (${reason})` : ""}; usd ${usdText(usage)}${copilotCount(usage)}${costByPhase(records)}${rebaseText}`);
    // The stage's last write is done: a request still waiting for the network (a background one) ends now, not at its limit.
    stopWaiting();
    setOutput("exit", exit);
    setOutput("reason", reason || "");
    setOutput("pr", pr ? String(pr.number) : "");
    setOutput("usd", usage.usd === null ? "" : String(usage.usd));
    if (process.env.GITHUB_STEP_SUMMARY) {
      const { appendFileSync } = await import("node:fs");
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Pendulum #${issue}: ${exit}\n\n${redactSecrets(reason || "")}\n\nPR: ${pr ? `#${pr.number}` : "none"} · USD: ${usage.usd ?? "unmetered"} (${usage.basis}) · passes: ${passes}\n`);
    }
  };

  // Any uncaught failure from here on still applies an exit: an issue left Running
  // forever holds a max_concurrent slot and never reaches the Blocked column.
  try {
    await run();
  } catch (e) {
    // A harness start Pendulum refused (local mode: the clone's git): Blocked with a fixed reason, the detail in the log.
    const refused = refusalExit(e, { stage: "work", issue });
    if (refused) {
      log(e.message.slice(0, 300));
      await applyExit(repo, { issue, pr, exit: "blocked", reason: refused.reason, key: refused.key, cause: "setup", notify: inputs.notify, stage: "work" }, token).catch((x) => log(`exit after refusal failed: ${x.message.slice(0, 120)}`));
      await finish("blocked", refused.reason);
      return;
    }
    // The harness's usage limit, past what the stage waits for in place: paused locally until its reset, a
    // `provider-quota` Block elsewhere (session.mjs usageLimitExit).
    if (e?.code === USAGE_LIMIT) {
      const pause = local && pauseNow ? await pauseNow().catch((x) => log(`the pause's record could not be read, so the next stage starts fresh: ${String(x?.message || x).slice(0, 160)}`) ?? null) : null;
      await usageLimitExit(e, { local, records, finish, pause, goOn: limits?.limit, block: (reason, cause) => applyExit(repo, { issue, pr, exit: "blocked", reason, cause, notify: inputs.notify, stage: "work" }, token) });
      return;
    }
    // This machine's network or GitHub's spent rate limit, not the stage: paused locally, an External Block elsewhere
    // (session.mjs outageExit): `outage`, which mentions no one (the dispatcher relaunches the stage, and its own notice
    // mentions the person once that is used up), or `provider-quota`, which waits for the person it mentions.
    if (unreachable(e)) {
      await outageExit(e, { local, records, finish, deadlineAt, block: (reason, cause) => applyExit(repo, { issue, pr, exit: "blocked", reason, cause, notify: cause === "outage" ? null : inputs.notify, stage: "outage" }, token) });
      return;
    }
    log(`worker crashed: ${e.message.slice(0, 300)}`);
    // A system error by its code and call alone: its message names a path on this machine (postedError).
    const reason = `worker crashed: ${postedError(e, { log: "the stage's log" }).slice(0, 200)}`;
    await applyExit(repo, { issue, pr, exit: "blocked", reason, cause: "pendulum", notify: inputs.notify, stage: "crash" }, token).catch((x) => log(`exit after crash failed: ${x.message.slice(0, 120)}`));
    await finish("blocked", reason);
    throw e;
  }

  async function run() {
  if (agentError) {
    const block = doctorBlock([agentError]);
    await applyExit(repo, { issue, pr: null, exit: "blocked", ...block, notify: inputs.notify }, token);
    await finish("blocked", block.reason);
    return;
  }
  // 1. The issue.
  let issueData = await getIssue(repo, issue, token);
  const labels = (issueData.labels || []).map((l) => l.name);
  // A draft (pendulum:draft) never runs, its Objective label on or not (lib/stop.mjs stopCause): nothing is claimed or spent.
  if (stopCause(issueData, inputs.objectiveLabel) === "draft") {
    log(`#${issue} is a draft (${DRAFT_LABEL}); Pendulum never runs a draft; nothing to do`);
    await finish("skipped", `a draft (${DRAFT_LABEL})`);
    return;
  }
  if (issueData.state !== "open" || !labels.includes(inputs.objectiveLabel)) {
    log(`#${issue} is not an open ${inputs.objectiveLabel} issue; nothing to do`);
    await finish("skipped", `not an open ${inputs.objectiveLabel} issue`);
    return;
  }

  // A restart is pending (pendulum:restart): the dispatcher restarts it from its current text first.
  if (stopCause(issueData, inputs.objectiveLabel) === "restart") {
    log(`#${issue} has ${RESTART_LABEL}: the dispatcher restarts it first; nothing to do here`);
    await finish("skipped", `a restart is pending (${RESTART_LABEL})`);
    return;
  }

  // A local loop holds this Objective (pendulum run / serve on a developer box): the Actions job steps aside.
  if (await backend().trigger.stepsAside(repo, issue, token, issueData)) {
    log(`#${issue} is held by a local loop; nothing to do here`);
    await finish("skipped", "held by a local loop");
    return;
  }

  // From here the stage stops when a person stops its Objective (its label removed, its issue closed): every harness
  // pass ends, its spend is recorded, its PR is left a draft, and the stage exits (session.mjs stopStage).
  // The stopped stage's end when the usual one runs out of time (session.mjs stopStage): written at once, its stream
  // masked first, its usage only if the usual end did not write it, and its live spend in its progress line.
  const endNow = (recs, why) => {
    const secrets = [...Object.values(cred.env), ...Object.values(decisionCred), ...shellSecretValues, ...keeper.issued, inputs.githubToken, inputs.appPrivateKey];
    maskFile(eventsFile, secrets);
    maskFile(join(usageDir, CALL_LOG), secrets);
    if (rebaseStage) stoppedRebase(progress, rebaseStage.conflict, recs);
    if (!existsSync(join(usageDir, "result.json"))) writeUsage(usageDir, { progressRun: progress.runId, ran: ranWith(inputs, chosenLabels, process.env.PENDULUM_STAGE_ACCOUNT), spendInProgress: spendInProgress(), harness: inputs.harness, model: inputs.model, records: recs, passes, exit: "stopped", reason: why, credentialBasis: credentialBasis, reentry, workerKey: relay ? relay.totals() : null });
    progress.flushNow();
  };
  const stopNow = async (cause) => {
    let took = true;
    try {
      took = await stopStage({ cause, label: inputs.objectiveLabel, repo, issue, records, finish: finishNow, opts: token, endNow });
    } catch (e) {
      log(`the stop's end failed: ${String(e?.message || e).slice(0, 200)}`);
    }
    if (took) process.exit(0);
  };
  // The issue as the watch and the last checks read it: a restart recorded after this stage began stops it too, its
  // label gone or not (stop.mjs objectiveReader); the records already there are read now, as the stage's own.
  const readObjective = objectiveReader({ read: () => getIssue(repo, issue, token), list: () => listComments(repo, issue, token) });
  await readObjective.prime();
  watch = watchObjective({ read: readObjective, label: inputs.objectiveLabel, onStop: (cause) => void stopNow(cause) });
  beforeExit = (commit = false) => confirmRunning({ read: readObjective, label: inputs.objectiveLabel, onStop: (cause) => void stopNow(cause), commit });

  // When the Objective was last started (its label applied, or its draft label taken off: objective-trust.mjs startedAt),
  // read before the text (planGate): an edit and a start landing between the two reads then count as after this stage's
  // plan, never as before it.
  const labeledAt = await startedAt(repo, issue, inputs.objectiveLabel, token);
  // Only text a writer wrote reaches a harness (objective-trust.mjs): the stage acts on the title and body read with their
  // author, last editor and latest title renamer, and Blocks before any harness when one cannot push and is not a pinned
  // maintainer.
  const trusted = await authorGate({ repo, issue, issueData, notify: inputs.notify, opts: token, apply: applyExit });
  if (!trusted.ok) {
    log(trusted.reason);
    await finish("blocked", trusted.reason);
    return;
  }
  issueData = trusted.issueData;
  const prNow = await findPr(repo, `pendulum/${issue}`, token).catch(() => null);

  // The harness and models this Objective runs on (objective-trust.mjs choiceGate): its harness and model labels, read
  // with the text, over the repository's defaults; a label no writer applied, two of one kind, a model the harness cannot
  // run, or a harness other than the one this stage was prepared for Blocks before any harness.
  const chosen = await choiceGate({ repo, issue, labels: trusted.labels, args, pr: prNow, notify: inputs.notify, opts: token, apply: applyExit, stage: "work" });
  if (!chosen.ok) {
    log(chosen.reason);
    await finish("blocked", chosen.reason);
    return;
  }
  Object.assign(inputs, chosen.inputs);
  chosenLabels = chosen.labels;
  // A foundation Objective (`pendulum:foundation`): its rebased PR keeps its review only when that covers the foundation pass.
  const foundation = !!chosen.foundation;
  // The hosts its approved `pendulum:host:` labels open, for this stage's sandboxes alone (local.mjs openStageHosts).
  openStageHosts(chosen.hosts);
  if (chosen.hosts.length) log(`this Objective's host labels open ${chosen.hosts.join(", ")} to its sandboxes`);
  // The account it runs on off local mode (objective-trust.mjs accountGate, #267): the one its labels pick, when the
  // repository declares accounts, must be the one whose credential this stage was given, or it Blocks before any harness.
  const acct = await accountGate({ repo, issue, harness: inputs.harness, labels: trusted.labels, local, pr: prNow, notify: inputs.notify, opts: token, apply: applyExit, stage: "work" });
  if (acct.wait) {
    log(acct.wait);
    await finish("skipped", acct.wait);
    return;
  }
  if (!acct.ok) {
    log(acct.reason);
    await finish("blocked", acct.reason);
    return;
  }
  progress.ran(ranWith(inputs, chosenLabels, process.env.PENDULUM_STAGE_ACCOUNT));
  limits = local || !acct.account ? null : routeLimits({ repo, issue, stage: "work", harness: inputs.harness, account: acct.account, pinned: acct.pinned, opts: token });
  if (limits) LIMIT.elsewhere = limits.elsewhere;
  if (limits) LIMIT.hold = limits.hold;
  // Automatic choice picked the account: a limit with no reset ends the stage, to move the Objective or Block (#332).
  LIMIT.moves = stageMoves({ local, limits, pinned: acct.pinned });
  // An account label with no accounts declared for this route does nothing: the progress says so, once.
  if (acct.note) await progress(acct.note);
  if (chosen.labels.length) log(`this Objective's labels choose ${chosen.labels.join(", ")}: ${inputs.harness}${inputs.model ? ` ${inputs.model}` : ""}`);

  // 2. Doctor's job checks, for the harness this Objective runs on: a misconfigured repository Blocks with one line, not a run.
  const checks = await jobChecks({ inputs, repo, token: keeper.token, app, checkout: pendulumTree, notice: !!access.notice });
  const failed = checks.filter((c) => c.status === "FAIL");
  for (const c of checks) log(`${c.status} ${c.name}${c.detail ? `: ${c.detail}` : ""}${c.fix && c.status !== "PASS" ? ` — fix: ${c.fix}` : ""}`);
  if (failed.length) {
    // The rows decide the Block (doctorBlock): each failing check named once, and the step its row names as the fix.
    const block = doctorBlock(failed);
    await applyExit(repo, { issue, pr: null, exit: "blocked", ...block, notify: inputs.notify }, token);
    await finish("blocked", block.reason);
    return;
  }

  // The decision calls (lib/decider.mjs): without an AI Gateway key, this stage's harness answers them on its login, each
  // call's spend in the stage's usage: one decision stage for all of them. Their env is the harness's own once the stage
  // builds it (step 5); before that, for the edit check and the answer check at the stage's start, the env every child
  // starts from with a credential read of their own (readyDecisionEnv), only when one asks the harness.
  let decisionEnv = null;
  const decisionStage = { harness: inputs.harness, model: inputs.model, env: () => decisionEnv ?? {}, record: (r) => records.push(r) };
  // That early read, once: never the passes' own, since federate() returns a key with no expiry and the passes read theirs
  // as they start (step 5), never one minted before setup and install. Masked like `cred` in everything the stage saves.
  const readyDecisionEnv = async () => {
    if (decisionEnv) return;
    decisionCred = (await credentialEnv({ harness: inputs.harness, credential: inputs.credential, inputs })).env;
    for (const v of Object.values(decisionCred)) mask(v);
    decisionEnv = { ...scrubbedEnv(process.env, { CI: "true", TMPDIR: access.agent ? access.agent.tmp : tmp.agent }), ...decisionCred };
  };
  // The edit check (lib/edit-check.mjs): on decision_route off nothing is read for it.
  const editCheck = async () => {
    if (inputs.decisionRoute === "off") return openEditCheck({ inputs });
    try {
      await readyDecisionEnv();
    } catch (e) {
      log(`edit check: ${inputs.harness}'s credential could not be read (${String(e?.message || e).slice(0, 160)}); only the AI Gateway can answer it`);
      return openEditCheck({ inputs });
    }
    return openEditCheck({ inputs, stage: decisionStage });
  };
  // The text its plan was made from (objective-trust.mjs planGate), before anything acts on the text: changed since, with
  // no label applied after the last work stage started from it, the stage Blocks; with one, the plan is made again from
  // this text. An edit by people who vouch for it is judged first (the edit check): wording only keeps the plan.
  const planned = await planGate({ repo, issue, sha: trusted.sha, text: { title: issueData.title, body: issueData.body, labels: trusted.labels }, editedAt: trusted.editedAt, labeledAt, work: true, pr: prNow, objectiveLabel: inputs.objectiveLabel, notify: inputs.notify, opts: token, apply: applyExit, stage: "work", check: editCheck, progress });
  if (!planned.ok) {
    log(planned.reason);
    await finish("blocked", planned.reason);
    return;
  }
  if (planned.state === "replan") log("the Objective's text changed since its plan and the label was applied again after it: the plan is made again from the new text");
  // The text a paused pass is held to (continue.mjs): the plan's own when this text is that plan's (the same, or an edit the
  // edit check kept), so a kept edit does not discard the pause; else the text read now.
  const planText = planned.state === "same" && planned.record?.sha256 ? planned.record.sha256 : trusted.sha;

  // One repository per Objective (lib/one-repo.mjs): a body that names another repository (declaredQuestion) is a
  // Question before any branch work or harness spend. An open PR the Objective already has goes back to a draft with
  // it, as on every Question: the dispatcher sends no draft back for a rebase (logic.mjs staleDecision), so a
  // conflicting PR does not restart this worker, and ask again, on every tick.
  const named = declaredQuestion(issueData.body, { source: repo, label: inputs.objectiveLabel });
  if (named) {
    log(`plan-time Question: ${named}`);
    const asking = await findPr(repo, `pendulum/${issue}`, token).catch(() => null);
    await applyExit(repo, { issue, pr: asking, exit: "question", reason: named, notify: inputs.notify, stage: "work", askOnIssue: true }, token);
    await finish("question", named);
    return;
  }
  // The answer check (lib/answer-check.mjs), first thing once the stage's decider exists: a stint that resumes a Question
  // goes on only when the writer comments since it give a decision, so one that does not costs no branch, no Running
  // mark, no setup, no install, no hand-off and no relay. A send-back resumes no Question; a relaunch or a continued
  // pause finds its comment's verdict kept on the issue and asks nothing.
  const answerCheck = openAnswerCheck({ inputs, stage: decisionStage });
  const readyDecisions = async () => {
    if (decisionEnv || answerCheck.asked().name !== "harness") return true;
    try {
      await readyDecisionEnv();
      return true;
    } catch (e) {
      log(`answer check: the stage's credential is not ready (${String(e?.message || e).slice(0, 160)}); the comment resumes the Question unjudged`);
      return false;
    }
  };
  const decisionsNow = () => objectiveDecisions(repo, { issue, prNumber: prNow?.number ?? null }, token);
  if (await answerGuard({ repo, issue, check: answerCheck, decisions: decisionsNow, label: inputs.objectiveLabel, appId: inputs.appId || process.env.PENDULUM_NOTICE_APP_ID || null, opts: token, prepare: readyDecisions, notify: inputs.notify, finish })) return;

  // A workflow change the Objective names (handover.mjs): Pendulum never pushes one, so the issue says so now, before any
  // harness runs, and how it goes instead (the hand-over). Most needs show only in the plan or the work: the plan's
  // Needs-Workflow line is said as the harness writes it, and the PR's hand-over carries any found later.
  const namedWorkflows = workflowPathsNamed(`${issueData.title || ""}\n${issueData.body || ""}`);
  if (await handoverUpFront(repo, issue, { named: namedWorkflows }, token).catch((e) => log(`hand-over notice: ${e.message.slice(0, 120)}`))) log(`the issue names ${namedWorkflows.join(", ")}: the workflow hand-over notice is on the issue`);

  // 3. Branch, plugin, git identity. Pendulum's git runs only in its own mirror (lib/outbox.mjs); what the agent's
  // checkout needs (the default branch, the Objective's branch, Pendulum's rebase) reaches it as a bundle, and every git
  // command there runs in the agent's sandbox (backend.mjs sandbox.git).
  const repoData = await getRepo(repo, token);
  const defaultBranch = repoData.default_branch || "main";
  const branch = `pendulum/${issue}`;
  // The env every child starts from, sandbox settings included. No GitHub token reaches a child: on Actions the agent
  // reads with its own read-only token; locally nothing.
  const childBase = scrubbedEnv(process.env, { CI: "true", TMPDIR: access.agent ? access.agent.tmp : tmp.agent, ...branchIdentity(branch) });
  let outbox;
  try {
    outbox = await openOutbox({ branch, defaultBranch, checkout, remote: `https://github.com/${repo.full}.git`, token: keeper.getter, agentEnv: childBase, local: backend().name === "local", protectedList, toolchain: setupPaths(inputs, { env: process.env, roots: [checkout] }), toolchainPaths: inputs.toolchainPaths, setup: inputs.setup, setupContext: { env: process.env, roots: [checkout] }, deadlineAt, base: tmp.pendulum });
    // Before each push, the issue once more: a stopped or restarted Objective pushes nothing (stop.mjs confirmRunning).
    outbox.beforePush = () => beforeExit?.();
  } catch (e) {
    if (e.code !== "ref-collision") throw e;
    log(e.message);
    await applyExit(repo, { issue, pr: null, exit: "blocked", reason: e.message, cause: "setup", notify: inputs.notify, stage: "branch" }, token);
    await finish("blocked", e.message);
    return;
  }
  const { base, resumed } = outbox;
  const identity = await gitIdentity(app, keeper.getter);
  // Pendulum's own commits (its rebases, its merge of a default branch that changed a workflow file) carry its identity.
  const botWho = commitAuthor(identity);
  outbox.author = botWho;
  await configureGit(checkout, { ...identity, protectedList, credentialHelper: access.readHelper || null, env: childBase });
  await outbox.feed();
  // Local mode, the one decision on the reused clone (lib/continue.mjs enterStage): continue the work pass a usage limit
  // paused here, on its kept checkout, when the branch on GitHub, the newest restart record, the Running stint and the
  // Objective's text are all as the pause recorded them; else start fresh, its untracked leftovers cleaned in the clone's
  // sandbox (lib/local.mjs prepareClone).
  // Whatever an earlier stage or run left in a reused checkout (local mode) is discarded (outbox.mjs putOn).
  const putOn = async () => {
    const onBranch = await outbox.putOn(resumed ? `refs/remotes/origin/${branch}` : `refs/remotes/origin/${defaultBranch}`);
    if (onBranch.code !== 0) throw commandFailed(`the checkout could not be put on ${branch}`, { code: onBranch.code, stderr: onBranch.error });
  };
  // What an abandoned pass left untracked, once the checkout is on the branch: a clean that fails leaves it, and a
  // later `git add -A` could push it, so the stage Blocks (setup) rather than run on such a clone.
  const clean = () =>
    prepareClone(checkout, [], (inner) => exec(...backend(childBase).sandbox.git(inner, childBase), { env: childBase }), { fresh: true, strict: true }).catch((e) => {
      log(`the clone's leftovers could not be removed: ${String(e?.message || e).slice(0, 200)}`);
      throw Object.assign(new Error(CLEAN_REFUSED), { code: "clone-clean" });
    });
  let entry = null;
  try {
    entry = local
      ? await enterStage({
          ws: join(usageDir, ".."),
          own: usageDir,
          now: async () => ({ branch: outbox.expected() || "", restart: restartedAt(await listComments(repo, issue, token)), running: labels.includes("pendulum:running") ? await runningSince(repo, issue, token) : null, text: planText, harness: inputs.harness, login: loginOf(inputs.harness) }),
          holds: (pause) => checkoutHolds((args) => outbox.agentGit(args), branch, pause),
          putOn,
          clean,
          restore: (from) => restoreTranscript({ checkout, workDir: join(usageDir, ".."), harness: inputs.harness, only: from }),
        })
      : await putOn();
  } catch (e) {
    if (e?.code !== "clone-clean") throw e;
    log(e.message);
    await applyExit(repo, { issue, pr: null, exit: "blocked", reason: e.message, cause: "setup", notify: inputs.notify, stage: "branch" }, token);
    await finish("blocked", e.message);
    return;
  }
  const continued = entry?.continue ? entry : null;
  if (entry?.reason) log(`the paused work pass in ${entry.from} is not continued: ${entry.reason}; starting fresh from the branch`);
  if (continued) log(`continuing the work pass paused in ${continued.from} on its kept checkout${continued.carry ? `, in a fresh session (${continued.carry})` : ""}`);
  log(`branch ${branch} from ${defaultBranch}@${base.slice(0, 7)}${resumed ? " (existing branch resumed)" : ""}`);
  // Git LFS before any harness: filters set up in the checkout, the branch's objects handed over (outbox.mjs lfsSetup).
  const lfs = await outbox.lfsSetup(resumed ? outbox.expected() : base, { timeoutMs: remainingMs(deadlineAt) });
  // Pendulum's own git work on the checkout is done: locally its git state is recorded, and checked before each harness start.
  backend(childBase).sandbox.pinGitState(childBase);
  // A runner's harness: the same state, put back before each start (lib/claude-runner.mjs), since the repository's
  // install and validation run as the agent outside the harness's sandbox.
  if (access.agent) await pinRunnerGit(checkout, childBase);
  if (lfs.used) log(!lfs.ok ? lfs.reason : lfs.warning ? `warning: ${lfs.warning}; the run goes on with pointer files` : "Git LFS: filters set up in the checkout, objects handed over");
  if (!lfs.ok) {
    await applyExit(repo, { issue, pr: null, exit: "blocked", reason: lfs.reason, cause: "setup", notify: inputs.notify, stage: "lfs" }, token);
    await finish("blocked", lfs.reason);
    return;
  }
  const openPr = resumed ? await findPr(repo, branch, token).catch(() => null) : null;
  // Rebase mode: the dispatcher sent an In-review PR back because its branch fell behind the default
  // branch (no merge queue). Pendulum rebases in its own mirror, with no model; only a conflict goes to the harness.
  let rebaseMode = false;
  let rebaseConflict = false;
  let rebasedTo = null;
  // The default branch's head a conflicting rebase was made onto, and the files that conflicted.
  let rebaseOnto = null;
  // Only the dispatcher's send-back (its rebase marker on the PR) means "rebase and nothing else";
  // a relabel after a Question or Blocked exit brings new decisions and runs the harness.
  // Pendulum's own marker only (isSelf): a writer's pasted one is no send-back.
  if (openPr) await progress.self();
  // Read once: the covered record on it says what Pendulum's review covers (session.mjs coveredHead).
  const prComments = openPr ? await listComments(repo, openPr.number, token).catch(() => []) : [];
  const sentBack = prComments.some((c) => isSelf(c) && (c.body || "").includes(marker(issue, "rebase").replace(/ -->$/, "")));
  // A plan made again needs the harness: no rebase-only stage for it. A continued pause was no send-back: it goes on.
  if (openPr && sentBack && planned.state !== "replan" && !continued) {
    const behind = await outbox.behind();
    if (behind > 0) {
      rebaseMode = true;
      rebasedTo = await outbox.rebase(botWho);
      rebaseConflict = !rebasedTo;
      rebaseStage = { conflict: rebaseConflict };
      if (rebasedTo) {
        // Exactly the commit Pendulum's own rebase made is pushed (with its merge of a default branch that changed a
        // workflow file meanwhile, if any), and the checkout is put on it for validation.
        await outbox.push({ sha: rebasedTo });
        if (outbox.merged) log(`${defaultBranch} changed ${outbox.merged.paths.join(", ")} after the rebase: Pendulum merged ${defaultBranch}@${outbox.merged.default.slice(0, 7)} into ${branch} before pushing`);
        // Pointer files for its Git LFS media first, then the media handed over (outbox.mjs putOnRebased).
        const moved = await outbox.putOnRebased(outbox.head || rebasedTo);
        if (moved.code !== 0) throw commandFailed(`the checkout could not be put on the rebased ${branch}`, { code: moved.code, stderr: moved.error });
        if (moved.warning) log(`warning: ${moved.warning}`);
      }
      log(`rebase mode: ${behind} commit(s) behind ${defaultBranch}; ${rebaseConflict ? "conflicts, the harness resolves them" : `rebased cleanly to ${rebasedTo.slice(0, 7)} in Pendulum's mirror, no harness run`}`);
      if (rebaseConflict) {
        // The record of this rebase on the PR (logic.mjs ontoRecord): once this pass pushes, the dispatcher reads the
        // same conflict on the same base as no progress, and a new base as a new send-back.
        rebaseOnto = { from: outbox.expected(), base: outbox.base, files: outbox.conflicts };
        await prComment(repo, openPr.number, ontoRecord(issue, { ...rebaseOnto, defaultBranch }), token).catch((e) => log(`rebase record: ${String(e.message).slice(0, 120)}`));
      }
    }
  }
  const written = await installPlugin(checkout, PLUGIN_ROOT, { harness: inputs.harness, models: { subagent: inputs.subagentModel, reviewer: inputs.reviewerModel }, env: childBase });
  log(`plugin written into the checkout: ${written.length} path(s), git-excluded`);
  await holdIfStopped();
  await markRunning(repo, issue, token);

  // 4. setup and the lockfile's install (checkout.mjs installCommand): the model secrets never reach these.
  // A local Objective's first stage on a machine: a fresh clone and a cold install, reported apart from the run's own
  // setup so the bench does not count a one-time cost against every run (bench/lib/phases.mjs: firstSetup).
  const firstMs = Number(process.env.PENDULUM_LOCAL_FIRST_SETUP_MS);
  const first = Number.isFinite(firstMs) && firstMs >= 0;
  if (first) await progress(`first-time setup: cloned in ${Math.round(firstMs / 1000)} s`);
  // What already listens on loopback is no service of the setup's: Claude Code's commands reach only what it starts.
  if (inputs.harness === "claude" && access.agent) noteSetupStart();
  if (inputs.setup) {
    log(`setup: ${inputs.setup}`);
    await progress("setup");
    // On Actions setup may need sudo: it runs as the runner on a clean tree of the default branch, never on branch code.
    // One that fails while this machine's network is down runs once more after it is back (checkout.mjs runSetup).
    const tree = access.agent ? await outbox.defaultTree() : checkout;
    const s = await runSetup({ tree, command: inputs.setup, env: access.agent ? { ...childBase, TMPDIR: tmp.pendulum } : childBase, asRunner: !!access.agent, deadlineAt, head: "setup failed:" });
    if (!s.ok) {
      const reason = s.reason;
      await applyExit(repo, { issue, pr: null, exit: "blocked", reason, cause: "setup", notify: inputs.notify, stage: "setup" }, token);
      await finish("blocked", reason);
      return;
    }
    const wrote = runnerFileEnv(childBase); // PATH and env the setup wrote for the steps after it
    Object.assign(childBase, wrote);
    allowAgentEnv(Object.keys(wrote));
  }
  // Which install runs is read from Pendulum's own checkout when the agent has a clone of its own.
  const installTree = access.agent ? pendulumTree : checkout;
  const install = installCommand(installTree, inputs.install);
  // A continued stage's install that failed on its kept checkout: the pass is told, and finishes it (continue.mjs installEnd).
  let installNote = "";
  if (install) {
    log(`install: ${install}`);
    await progress(first ? "install (first time on this machine)" : "install");
    const i = await installDeps(checkout, install, { env: childBase, timeoutMs: remainingMs(deadlineAt), tools: installTools(installTree, inputs.install) });
    if (i.repaired) log(`install: ${i.first} the first time; repaired by a clean reinstall`);
    const ended = installEnd(i, { continued: !!continued, command: install });
    if (ended.block) {
      const reason = ended.block;
      await applyExit(repo, { issue, pr: null, exit: "blocked", reason, cause: "setup", notify: inputs.notify, stage: "install" }, token);
      await finish("blocked", reason);
      return;
    }
    if (ended.note) {
      log(`${i.reason}; the continued pass finishes its dependency change on the kept checkout`);
      await progress("install failed on the kept checkout; the continued pass finishes it");
      installNote = ended.note;
    }
  }

  // 5. The prompt, the hand-off and the harness.
  // Codex through the AI Gateway: one session id for the Objective's Running stint, so its resumes keep their credential.
  const gatewayId = inputs.harness === "codex" && inputs.codexGatewayKey ? gatewaySession({ repo: repo.full, issue, since: await runningSince(repo, issue, token).catch(() => null) }) : null;
  cred = await credentialEnv({ harness: inputs.harness, credential: inputs.credential, inputs, session: gatewayId });
  credentialBasis = cred.basis;
  // $PENDULUM_IN and $PENDULUM_OUT: fresh for this stage, so no record from an earlier attempt speaks for this one.
  const io = await openHandoff({ repo, issue, issueData, env: childBase, opts: token, outbox, branch, record: planned.record });
  // The secrets this repository opted in to the worker's shell (lib/worker-secrets.mjs): carried to the harness alone.
  // An opted-in AI Gateway key stays in this process behind the relay; the shell gets its token (lib/worker-relay.mjs).
  const opened = await openWorkerRelay({ inputs, shell: openWorkerSecrets(inputs, { pendulumKey: () => triageKey({ inputs }) }), usageDir });
  relay = opened.relay;
  const shellSecrets = opened.shell;
  // The token, the other values, and the key itself (which the shell no longer holds): masked in what the stage saves.
  shellSecretValues = [...Object.values(shellSecrets), ...opened.masked];
  if (opened.blocked) {
    await applyExit(repo, { issue, pr: null, exit: "blocked", reason: opened.blocked, cause: "setup", notify: inputs.notify, stage: "work" }, token);
    await finish("blocked", opened.blocked);
    return;
  }
  const harnessEnv = { ...childBase, ...cred.env, ...io.env, PENDULUM_ISSUE: String(issue), PENDULUM_BRANCH: branch, ...(inputs.compactionWindow ? { PENDULUM_COMPACTION_WINDOW: inputs.compactionWindow } : {}), PENDULUM_PROMPT_CACHE_TTL: inputs.promptCacheTtl, ...packShellSecrets(shellSecrets) };
  // The decision calls' env from here on: the harness's own (decisionStage, above).
  decisionEnv = harnessEnv;
  // The drift advisory (lib/drift.mjs): a line on the progress comment, never an action.
  const drift = openDrift({ inputs, progress, stage: decisionStage });
  // The fence check (lib/fence-check.mjs): a fix pass's toolchain change outside its scope goes only on its yes.
  if (outbox) outbox.fenceCheck = openFenceCheck({ inputs, stage: decisionStage });
  // A rerun after a Question or Blocked exit: the maintainers' answers may be comments on the issue or the open PR.
  const decisions = await objectiveDecisions(repo, { issue, prNumber: openPr?.number ?? null }, token);
  if (decisions.length) log(`${decisions.length} maintainer decision(s) from the issue and PR comments go to the harness`);
  io.set({ decisions, prNumber: openPr?.number ?? null });
  // The plan-time Question (lib/one-repo.mjs): a repository other than this one that the plan needs, unless a maintainer
  // has answered about it since a run asked (Pendulum's own record of the ask, in its progress comments), as the
  // plan-answer check judges the comments since (lib/plan-answer.mjs). A rebase send-back changes no plan.
  const askedAt = rebaseMode ? {} : planAskedOf(await listComments(repo, issue, token).catch(() => []), { issue, self: await progress.self() });
  const answered = await judgedAnswers(askedAt, decisions, { source: repo, label: inputs.objectiveLabel, check: openPlanAnswerCheck({ inputs, stage: decisionStage }) });
  if (answered.size) log(`plan-time Question answered since it was asked: ${[...answered].join(", ")}`);
  // The mid-run stop counts any maintainer decision since the ask, naming the repository or not: until the harness has
  // re-planned with the answer, its plan.md (a copy of the plan comment, a first draft) may still carry the line, and
  // stopping there would ask again what the owner just answered. The end of the run decides with `answered` alone.
  const replied = answeredRepos(askedAt, decisions, { named: false });
  const needsOf = (plan, seen = answered) => (rebaseMode ? {} : planNeedsOf(plan, { source: repo, label: inputs.objectiveLabel, answered: seen }));
  const prompt = buildPrompt({
    templatePath: TASK_CARD_TEMPLATE(PLUGIN_ROOT),
    harness: inputs.harness,
    services: inputs.harness === "claude" && access.agent ? agentServicePorts(access.agent) : [],
    shellSecrets: Object.keys(shellSecrets),
    issue,
    issueTitle: issueData.title,
    issueBody: issueData.body,
    decisions,
    maxUsd: inputs.maxUsd,
    maxParts: inputs.maxParts,
    timeoutMinutes: inputs.timeoutMinutes,
    validation: inputs.validation,
    ciChecks: inputs.ciChecks,
    budgetCommand: inputs.budgetCommand,
    protectedList,
    // What the setup command runs, so the worker leaves it alone (the push refuses a change to it).
    setupGuard: outbox?.setupFiles ? await outbox.setupFiles().catch(() => null) : null,
  });
  writeOwn(join(usageDir, "task-card.md"), prompt.split("\n---\n")[0]);
  const session = { id: null, canResume: true };
  // Resume policy: under fix-passes, a rebase send-back that conflicts resumes the worker's saved
  // session (on Actions it rides the usage artifact; locally it is on the box); every other entry starts fresh.
  let restored = null;
  // A continued pause resumes its own session when it carries over (enterStage restored it), whatever the policy.
  if (continued) restored = continued.session ?? { id: null, from: continued.from, reason: continued.carry };
  else if (inputs.resumePolicy === "fix-passes" && rebaseConflict) restored = await restoreTranscript({ repo, issue, token: inputs.githubToken || token.token, checkout, workDir: join(usageDir, ".."), harness: inputs.harness, seal: usageSeal({ key: sealKey, publish: inputs.publishTranscripts, payload: eventPayload(), readRepo: () => getRepo(repo, { token: inputs.githubToken || token.token, noRateWait: true }) }) });
  if (restored?.id) session.id = restored.id;
  // Every stage says how it entered, resumed or fresh and why, in its progress and in result.json: a continued pause
  // (`continued`), or a pause not continued, naming the guards that changed (`changed`).
  reentry = continued
    ? { resumed: !!restored.id, continued: true, from: continued.from, reason: restored.id ? null : continued.carry }
    : entry?.reason
      ? { resumed: false, from: entry.from, reason: entry.reason, changed: entry.changed }
      : restored
        ? { resumed: !!restored.id, from: restored.from ?? null, reason: restored.id ? null : restored.reason }
        : { resumed: false, from: null, reason: inputs.resumePolicy !== "fix-passes" ? "resume policy is fresh" : rebaseMode ? "a clean rebase runs no session" : "a new run" };
  await progress(`re-entry: ${continued ? `continued the paused work pass from ${reentry.from} on its kept checkout, ${reentry.resumed ? `resumed session ${restored.id.slice(0, 8)}` : `fresh session (${reentry.reason})`}` : reentry.resumed ? `resumed session ${restored.id.slice(0, 8)} from ${reentry.from}` : `fresh (${reentry.reason})`}`);
  const unpriced = unpricedCodex(inputs.harness, inputs.model, { gateway: !!inputs.codexGatewayKey });
  if (unpriced) {
    log(`warning: ${unpriced}`);
    await progress(`unpriced: ${unpriced}`);
  }
  const budgetLeft = () => (inputs.maxUsd > 0 ? Math.max(0, inputs.maxUsd - sumSpend(records)) : 0);
  let died = 0;
  let rec = null;
  // Whether the work run has been recorded as reading the decisions. Only the work run is told to apply them: a
  // conflict pass is told only to rebase (even with the full card), and a fix pass only to make validation green.
  let fedDecisions = false;
  // The plan.md the mid-run stop read (the hand-off tick), when it stopped the harness.
  let stoppedPlan = null;
  const conflictPrompt = conflictPassPrompt({ prompt, branch, defaultBranch });
  // A continued pause: its resumed session is told where it stands and the new hand-off folders; a fresh session on the
  // kept checkout gets the task card and what the checkout holds (lib/continue.mjs).
  const workPrompt = continued ? keptPrompt(prompt, { note: installNote }) : prompt;
  const resumedPrompt = continued ? continuePrompt(io.dirs, { note: installNote }) : conflictPrompt.split("\n\n---\n\n").at(-1);
  // The plan's Needs-Workflow lines (handover.mjs plannedWorkflows): the hand-over notice goes on the issue as the plan
  // is written, once, unless one is there already.
  let workflowsNoticed = false;
  const planWorkflows = (plan) => {
    const named = plannedWorkflows(plan);
    if (workflowsNoticed || !named.length) return;
    workflowsNoticed = true;
    handoverUpFront(repo, issue, { named, from: "plan" }, token).then(
      (wrote) => wrote && log(`the plan needs ${named.join(", ")}: the workflow hand-over notice is on the issue`),
      (e) => log(`hand-over notice: ${e.message.slice(0, 120)}`),
    );
  };
  // The work pass's pause, while it runs (not a send-back's conflict pass): the four guards as they stand when it ends on
  // its usage limit, which the next work stage here weighs (lib/continue.mjs).
  if (local && !rebaseMode) pauseNow = async () => pauseRecord({ branch: outbox.expected(), restart: restartedAt(await listComments(repo, issue, token)), running: await runningSince(repo, issue, token), text: planText, harness: inputs.harness });
  if (rebaseMode && !rebaseConflict) rec = { ok: true, noRun: true, timedOut: false, budgetExceeded: false, error: null, finalText: "", usd: null, tokens: { input: null, output: null, cached: null }, basis: "no harness run: clean rebase", harness: inputs.harness, model: inputs.model };
  for (let attempt = 1; attempt <= 2 && !(rebaseMode && !rebaseConflict); attempt += 1) {
    log(`harness ${inputs.harness}${inputs.model ? ` (${inputs.model})` : ""}, attempt ${attempt}, wall clock ${Math.round(remainingMs(deadlineAt) / 60000)} min, budget ${inputs.maxUsd}`);
    await progress(`harness ${inputs.harness}${inputs.model ? ` (${inputs.model})` : ""} attempt ${attempt}`);
    await io.render();
    // The plan.md this pass wrote, read on the hand-off's tick: once it needs another repository, the harness is stopped there, so the Question costs the plan and not the work.
    // A repository a maintainer has replied about since the ask never stops it (`replied`), so the stop implies the end
    // of the run's Question: the stopping plan is kept for it.
    const planStop = new AbortController();
    const tick = () =>
      io.tick((plan) => {
        planWorkflows(plan);
        if (planStop.signal.aborted || !needsOf(plan, new Set([...answered, ...replied])).reason) return;
        log("plan-time Question: the plan needs another repository; stopping the harness");
        stoppedPlan = plan;
        planStop.abort();
      });
    const live = liveActivity(progress, { harness: inputs.harness, model: inputs.model, tick, drift: drift?.watch({ stage: `work-${attempt}`, goal: GOALS.work, root: checkout, plan: io.plan }) });
    const full = !(attempt === 1 && restored?.id) && (attempt === 1 || !session.id);
    // Recorded before the run: a comment posted while it works is unread, and the review's answer pass applies it.
    // Only the decisions that fit the card are recorded; those cut for length stay unread.
    // A continued session's resumed pass reads them all again from $PENDULUM_IN/decisions.md (continue.mjs decisionsFed).
    const fed = fedDecisions ? null : decisionsFed({ decisions, full, continued: !!continued, rebaseConflict });
    if (fed) {
      await progress.decisionsRead(decisionsRead(fed));
      fedDecisions = true;
    }
    rec = await runHarness({
      onLine: live.onLine,
      onResume: live.onResume,
      harness: inputs.harness,
      model: inputs.model,
      effort: inputs.effort,
      prompt: attempt === 1 && restored?.id ? resumedPrompt : full ? (rebaseConflict ? conflictPrompt : workPrompt) : "Your previous process died. Continue the Objective from where the branch and $PENDULUM_OUT/plan.md stand; do not redo finished items.",
      // A resume the provider refuses for the session alone runs fresh with the whole card (harness.mjs runHarness).
      freshPrompt: (attempt === 1 && restored?.id && !continued) || rebaseConflict ? conflictPrompt : workPrompt,
      maxUsd: attempt === 1 ? inputs.maxUsd : budgetLeft(),
      resume: (attempt > 1 || restored?.id) && session.canResume ? session.id : null,
      cwd: checkout,
      env: harnessEnv,
      timeoutMs: remainingMs(deadlineAt),
      eventsFile,
      label: `work-${attempt}`,
      signal: planStop.signal,
    });
    await live.finish();
    records.push(rec);
    if (rec.sessionId) session.id = rec.sessionId;
    // The restored session ran fresh instead (harness.mjs runHarness: the provider refused its resume).
    if (rec.resumeRefused && attempt === 1 && restored?.id) {
      restored = { ...restored, id: null, reason: "resume refused by the provider" };
      reentry = { ...reentry, resumed: false, from: restored.from ?? null, reason: restored.reason };
    }
    // Claude enforces max_usd inside the run; Codex and Copilot are checked here after it. A Copilot run that reported
    // no priced credits leaves the cap unenforceable, so nothing more runs.
    if (inputs.maxUsd > 0 && sumSpend(records) >= inputs.maxUsd) rec.budgetExceeded = true;
    // A Copilot run Pendulum stopped at its plan writes no usage file: unmetered, but nothing more runs after it (the plan-time
    // Question skips every later pass), so it is no cap reached and the exit stays the Question.
    if (inputs.maxUsd > 0 && unmeteredRun(rec)) Object.assign(rec, rec.stopped ? { unmetered: true } : { budgetExceeded: true, unmetered: true });
    if (rec.refusal) log(`harness ${inputs.harness} was refused by the provider (${rec.error}); not retried`);
    if (rec.budgetExceeded || !crashed(rec)) break;
    // A resumed session the CLI could not continue falls back to a fresh run with the full prompt.
    if (attempt === 1 && restored?.id) {
      log(`resumed session ${restored.id.slice(0, 8)} failed (${rec.error}); running fresh`);
      await progress("re-entry: resume failed; running fresh");
      restored = { ...restored, id: null, reason: "resume failed" };
      reentry = { ...reentry, resumed: false, from: restored.from ?? null, reason: "resume failed" };
      session.id = null;
    }
    died += 1;
    log(`harness process died (${rec.error}); ${died < 2 ? "retrying once" : "second death"}`);
    if (died >= 2) break;
  }
  // Every pass after the work pass (a conflict, a validation fix, the exit record's ask) starts fresh after a pause.
  pauseNow = null;

  // 6. What the run left behind: the hand-off files, commits, protected paths, the PR. Pendulum pushes and opens the PR;
  // pushes carry no model secret. A stopped Objective's stage goes no further: its stop writes the end.
  await holdIfStopped();
  await io.collect();
  // A plan that needs a change in another repository (its Needs-Repository line, pendulum-objective-plan) is a Question at plan
  // time (lib/one-repo.mjs): the harness stops after its plan, and Pendulum runs no validation, fix pass or exit-record
  // call for it. Whatever it committed anyway still goes up, as a draft. A rebase send-back changes no plan.
  const ignoredNeeds = plannedRepos(io.plan()).ignored;
  if (ignoredNeeds) log(`plan: ${ignoredNeeds} Needs-Repository line(s) name no OWNER/NAME (a placeholder): no need`);
  // A harness stopped at its plan is asked about that plan, even if it rewrote plan.md as it was stopped.
  const needs = needsOf(io.plan()).reason || !stoppedPlan ? needsOf(io.plan()) : needsOf(stoppedPlan);
  const planNeeds = needs.reason || "";
  if (planNeeds) log(`plan-time Question: ${planNeeds}`);
  // A send-back's conflict pass that left the checkout not the branch rebased onto the base Pendulum's rebase conflicted
  // on (outbox.mjs rebaseLeft: a rebase left in progress, the base not taken, a change of the branch missing from it):
  // nothing of it is pushed, whatever ended the pass. Blocked naming the files and the changes, with no validation run;
  // a cap, death or refusal that ended it stays the reason (decideExit puts those first). A file not exactly the
  // branch's is judged by the decision model when there is a key (kept.mjs); without one the commits are matched.
  const keptCheck = rebaseOnto ? openKeptCheck({ inputs, stage: decisionStage }) : null;
  const unresolved = await sendBackGuard({ outbox, onto: rebaseOnto, defaultBranch, judge: keptCheck?.judge ?? null, progress, limited: keptCheck?.limited ?? null, issue });
  let pushed = await outbox.push();
  // The default branch changed a workflow file during the run and the new branch conflicts with Pendulum's merge of it
  // (outbox.mjs catchUp): GitHub would refuse the branch as it is, so the harness resolves the conflict once, as a
  // send-back's conflict pass does, and Pendulum pushes again. A second conflict is refused there. A plan-time Question
  // spends nothing on it: its draft just does not go up.
  const catchConflict = () => !pushed && !!outbox.conflict && !outbox.failed;
  if (catchConflict() && remainingMs(deadlineAt) <= 0) rec.timedOut = true;
  if (catchConflict() && !planNeeds && !rec.budgetExceeded && !rec.timedOut && !rec.refusal) {
    log(`${defaultBranch} changed ${outbox.conflict.paths.join(", ")} during the run and ${branch} conflicts with it; the harness resolves the conflict`);
    await progress(`conflict with ${defaultBranch}: harness ${inputs.harness} resolves it`);
    await outbox.feed();
    // The default branch's Git LFS media is in the checkout's store already (outbox.mjs push), so the harness's own merge
    // or rebase downloads nothing; what fell short is said here.
    if (outbox.lfsWarning) log(`warning: ${outbox.lfsWarning}`);
    const catchPrompt = conflictPassPrompt({ prompt, branch, defaultBranch, cause: `because ${defaultBranch} changed ${outbox.conflict.paths.join(", ")} during the run` });
    const resume = session.canResume ? session.id : null;
    const live = liveActivity(progress, { harness: inputs.harness, model: inputs.model, tick: () => io.tick() });
    const pass = await runHarness({ onLine: live.onLine, onResume: live.onResume, harness: inputs.harness, model: inputs.model, effort: inputs.effort, prompt: resume ? catchPrompt.split("\n\n---\n\n").at(-1) : catchPrompt, freshPrompt: catchPrompt, maxUsd: budgetLeft(), resume, cwd: checkout, env: harnessEnv, timeoutMs: remainingMs(deadlineAt), eventsFile, label: "conflict" });
    await live.finish();
    records.push(pass);
    if (pass.sessionId) session.id = pass.sessionId;
    // The pass answers for the branch like the work pass: a cap it reached Blocks with that cap, a death or a rebase or
    // merge it left in progress Blocks unpushed (the checkout's HEAD is then part of the work, not the branch).
    if (pass.timedOut) rec.timedOut = true;
    if (pass.budgetExceeded || (inputs.maxUsd > 0 && sumSpend(records) >= inputs.maxUsd)) rec.budgetExceeded = true;
    if (inputs.maxUsd > 0 && unmeteredRun(pass)) Object.assign(rec, { budgetExceeded: true, unmetered: true });
    await io.collect();
    // A provider's refusal of the pass Blocks the stage with it (decideExit), unpushed.
    if (pass.refusal) rec.refusal = pass.refusal;
    const busy = rec.timedOut || rec.budgetExceeded || rec.refusal || crashed(pass) ? { ops: [] } : await outbox.inProgress();
    if (rec.timedOut || rec.budgetExceeded) log(`the conflict pass reached the ${rec.timedOut ? "time" : "dollar"} cap; ${branch} is not pushed`);
    else if (rec.refusal) log(`the conflict pass was refused by the provider (${pass.error}); ${branch} is not pushed`);
    else if (crashed(pass)) outbox.block(`the harness died resolving ${branch}'s conflict with ${defaultBranch} (exit ${pass.exitCode ?? "none"}${pass.signal ? `, ${pass.signal}` : ""}); nothing was pushed`);
    else if (busy.code !== undefined) outbox.block(`after the conflict pass Pendulum could not check the checkout for a rebase or merge left in progress (exit ${busy.code}); ${branch} was not pushed`);
    else if (busy.ops.length) outbox.block(`the conflict pass left a ${busy.ops.join(" and ")} in progress in the checkout; ${branch} was not pushed`);
    else pushed = await outbox.push();
  }
  // A conflict no pass resolved, and no cap or plan-time Question to name: Blocked with it, not as a run that left no commits.
  if (catchConflict() && !planNeeds && !rec.timedOut && !rec.budgetExceeded && !rec.refusal) outbox.block(outbox.error);
  if (!pushed) log(`push refused: ${outbox.error}${outbox.detail ? ` (GitHub: ${outbox.detail})` : ""}`);
  else if (outbox.merged) log(`${defaultBranch} changed ${outbox.merged.paths.join(", ")} since the branch's base: Pendulum merged ${defaultBranch}@${outbox.merged.default.slice(0, 7)} into ${branch} before pushing${outbox.synced ? "" : " (the checkout could not take the merge; the next push builds on it)"}${outbox.lfsWarning ? `; warning: ${outbox.lfsWarning}` : ""}`);
  let { pr: found, delta } = await observe(repo, outbox, { branch }, token);
  const hits = protectedTouched(delta.files, protectedList);
  // A split part's PR says `Refs #N`, every other one `Closes #N`. The exit record's `part` decides when the pass wrote
  // one; a pass that wrote none (a clean rebase, a conflict or fix pass) keeps the part Pendulum recorded.
  const priorParts = await partsRecord(repo, issue, token).catch(() => null);
  const partLeft = (record) => (record?.part ? record.part.remaining.length : (pr || found) && isSplitPart(priorParts, (pr || found).number) ? priorParts.remaining : 0);
  const splitNow = () => partLeft(exitFromOut(io.files())) > 0;
  // The worker's workflow hand-over (handoff.mjs handoverChecker): one that cannot go out Blocks the stage.
  const handover = handoverChecker(() => io.files(), outbox);
  const handoverNow = handover.now;
  // A PR GitHub would read as closing anything but this Objective's issue Blocks the stage (handoff.mjs closingChecked).
  let publishRefused = "";
  const publish = async (current) =>
    publishPr(repo, { branch, base: defaultBranch, issue, issueTitle: issueData.title, prText: io.files()["pr.md"], fallbackBody: lastMessage(inputs.harness, rec), splitPart: splitNow(), pr: current, handover: await handoverNow() }, token).catch((e) => {
      log(`PR could not be ${current ? "updated" : "opened"}: ${e.message.slice(0, 200)}`);
      if (e.code === "closing-refs") publishRefused = e.message;
      // No PR to deliver on because of an outage (network.mjs outageMet): the stage ends on that outage, not on a Block
      // for the missing PR.
      if (!(e.pr || current) && outageMet(e)) throw e;
      return e.pr || current;
    });
  if (found || (delta.count > 0 && !hits.length && !outbox.failed)) found = await publish(found);
  pr = found;
  if (pr) io.set({ prNumber: pr.number });
  if (pr?.html_url) progress.link(`PR #${pr.number}`, pr.html_url);


  // 7. Pendulum's own validation passes, failures back to the harness while its fix passes make progress (validationLoop).
  let validation = null;
  // Hard stops only; a harness that errored but left commits still gets Pendulum's validation pass.
  const early = decideExit({ harness: { ok: true, died, timedOut: rec.timedOut, budgetExceeded: rec.budgetExceeded, unmetered: rec.unmetered, refusal: rec.refusal }, pr: pr ? { exists: true, draft: pr.draft, body: pr.body } : null, commits: delta.count, protectedHits: hits, unresolved, sessionCap: sessionCapNote(process.env.PENDULUM_STAGE_SESSION_CAP) });
  if (early.exit !== "blocked" && !planNeeds) {
    validation = await validationLoop({
      onPhase: progress,
      progress,
      checks: inputs.ciChecks.length && pr ? { repo, issue, prNumber: pr.number, names: inputs.ciChecks, token: token.token, actionsToken: inputs.githubToken || token.token, stall: inputs.stall } : null,
      outbox,
      checkout,
      commands: inputs.validation,
      harness: inputs.harness,
      effort: inputs.effort,
      model: inputs.model,
      maxUsd: inputs.maxUsd,
      spentUsd: sumSpend(records),
      session,
      taskCard: prompt,
      env: harnessEnv,
      deadlineAt,
      eventsFile,
      io,
      // Red-check triage (lib/triage.mjs), asked through the stage's decider. Jobs are read and rerun with the job token on
      // Actions (actions: write), the repository token locally.
      triage: pr ? openTriage({ inputs, repo, issue, prNumber: pr.number, token: token.token, actionsToken: inputs.githubToken || token.token, progress, stage: decisionStage }) : null,
      drift,
      // Whether a fix pass moved the red closer to green, where the exact checks cannot tell (lib/fix-progress.mjs).
      progressCheck: openProgressCheck({ inputs, stage: decisionStage }),
      // A work pass that ended well hands its pushed head to the review stage without waiting for the required checks:
      // the review waits for them beside its reviewer, and its answer pass fixes a red with the review's comments. A
      // send-back's rebase waits here as before (a reviewed head merges on it), as does a pass whose harness erred
      // (green checks are what outweigh its error).
      handOff: !!rec.ok && !rebaseMode && !!pr,
    });
    records.push(...validation.usage);
    passes = validation.passes;
    if (validation.died) died += 1;
    if (validation.usage.length) {
      await outbox.push();
      ({ pr, delta } = await observe(repo, outbox, { branch, prNumber: pr?.number }, token));
      // A refused push leaves GitHub without that pass's work: its pr.md does not describe the branch.
      if ((pr || delta.count > 0) && !outbox.failed) pr = await publish(pr);
    }
  }

  // 8. The exit. The harness's own verdict is its exit record (JSON it wrote, or answered with);
  // a run that had no harness (clean rebase) delivered by construction. A provider's refusal is not asked again.
  const refusal = rec?.refusal || validation?.harness?.refusal || null;
  const asked = rebaseMode && !rebaseConflict ? { record: { exit: "delivered", reason: "", questions: [] }, usage: [] } : refusal ? { record: null, usage: [] } : planNeeds ? { record: exitFromOut(io.files()), usage: [] } : await exitRecord({ text: io.files()["exit.json"], harness: inputs.harness, model: inputs.model, effort: inputs.effort, session, cwd: checkout, env: harnessEnv, eventsFile, deadlineAt, maxUsd: inputs.maxUsd, spentUsd: sumSpend(records), unmetered: !!(rec?.unmetered || validation?.harness?.unmetered) });
  records.push(...asked.usage);
  if (asked.usage.length) log(`exit record asked from the harness: ${asked.record.exit}`);
  // The question check may have turned QUESTION: items into assumptions: the PR body and plan comment follow pr.md and plan.md.
  if (asked.checked) {
    await io.collect();
    if (pr) pr = await publish(pr);
  }
  // Green validation on an open PR outweighs a harness error code (max turns, a late tool failure);
  // with no validation commands at all, the harness's own verdict stands. A validation fix run that
  // died is a death, not a red pass; a deadline or budget reached during it is that cap.
  const evidenceOk = !!(validation?.green && inputs.validation.length && pr);
  // A PR that started conflicting during validation is not red: every other gate still decides, and a delivered exit
  // goes to In review for the dispatcher's send-back (a rebase onto the default branch first), not to the reviewer.
  const conflict = !!validation?.conflict;
  // With nothing pushed there is no PR to carry the hand-over: it goes on the issue (handoff.mjs handoverOnIssue).
  const handoverLeft = !pr && !delta.count ? await handoverNow() : undefined;
  const decision = decideExit({
    harness: { ...rec, ok: rec.ok || evidenceOk, died, refusal, timedOut: rec.timedOut || validation?.harness?.timedOut, budgetExceeded: rec.budgetExceeded || validation?.harness?.budgetExceeded, unmetered: rec.unmetered || validation?.harness?.unmetered },
    pr: pr ? { exists: true, draft: pr.draft, body: pr.body } : null,
    commits: delta.count,
    validation: validation?.handedOff ? { passes: validation.passes, green: true } : validation && !validation.died && !validation.harness && !validation.question && !conflict ? { passes: validation.passes, green: validation.green, lastOutput: validation.lastOutput, command: validation.command, baseFailure: validation.baseFailure, notStarted: validation.notStarted, stuck: validation.stuck?.reason, stuckCause: validation.stuck?.cause, triageRefused: validation.triageRefused, scope: validation.scope, unchanged: validation.unchanged, freshPass: validation.freshPass, stalled: validation.stalled, stalledCause: validation.stalledCause } : undefined,
    protectedHits: protectedTouched(delta.files, protectedList),
    unresolved,
    record: asked.record,
    recordBasis: asked.basis,
    // Every push went through the outbox, which refuses plain blobs LFS should hold and media over the cap.
    pushRejected: outbox.failed && outbox.error !== unresolved ? outbox.error : "",
    pushCause: outbox.failed && outbox.error !== unresolved ? outbox.errorCause : null,
    lfsRefused: outbox.lfsRefused,
    lfsQuota: outbox.errorKind === "lfs-quota",
    planNeeds,
    sessionCap: sessionCapNote(process.env.PENDULUM_STAGE_SESSION_CAP),
    handoverRefused: handover.refused(),
    handoverOnly: !pr && !delta.count && !!handoverLeft,
  });
  if (publishRefused && decision.exit !== "blocked") Object.assign(decision, { exit: "blocked", reason: publishRefused, cause: "work" });
  // Stopped meanwhile (the watch's last read, or the issue read once more now): nothing of this exit is applied (no ready
  // mark, no review label); the stop's end stands.
  await holdIfStopped();
  // The exit begins here (stop.mjs confirmRunning `commit`): a stop after this read ends nothing, and the dispatcher's
  // stopped pass tidies the ready mark and review label this exit may leave.
  await beforeExit?.(true);
  // The harness's account of what blocked it, posted on the issue.
  await postNote(repo, issue, io.files()["note.md"], token).catch((e) => log(`note: ${e.message.slice(0, 120)}`));
  if (decision.handoverOnly) await handoverOnIssue(repo, { issue, handover: handoverLeft, defaultBranch }, token).catch((e) => log(`hand-over on the issue: ${e.message.slice(0, 120)}`));
  if (decision.exit === "delivered" && pr) {
    // A split Objective: this part's PR joins the record, with the items left for the next part (none for the last).
    const remaining = partLeft(asked.record);
    // Each of these exit steps that fails Blocks, tagged with the outage it met, if any (session.mjs exitStep, outageFirst).
    await exitStep(decision, "the split record could not be written", async () => {
      const rec = await recordPart(repo, issue, pr.number, remaining, token);
      pr = await publishPr(repo, { branch, base: defaultBranch, issue, prText: null, splitPart: isSplitPart(rec, pr.number), pr }, token);
      if (rec) log(remaining ? `split: PR #${pr.number} is part ${rec.prs.length}; ${remaining} item(s) remain for the next part` : `split: PR #${pr.number} is the last of ${rec.prs.length} part(s)`);
    });
  }
  if (decision.exit === "delivered" && pr && conflict) {
    // Ready, unvalidated and unlabelled: the dispatcher sends a ready In-review PR that conflicts back to a worker.
    pr = await markReady(repo, pr, token);
    decision.reason = `PR #${pr.number} conflicts with ${defaultBranch} after a sibling merged; the dispatcher sends it back for a rebase`;
    log(decision.reason);
  } else if (decision.exit === "delivered" && pr) {
    // Delivered means an open, non-draft PR (Pendulum opens it as a draft until its own validation is green);
    // the review label goes on first, because the App applying it is what fires the review job.
    const head = (await observe(repo, outbox, { branch, prNumber: pr.number }, token)).pr.head.sha;
    // A head handed off with its checks running is not validated: the review stage waits for them (session.mjs
    // postHandedOff, read back by review.mjs).
    if (validation?.handedOff) await postHandedOff(repo, pr.number, issue, head, token);
    else await postValidated(repo, pr.number, issue, head, token);
    pr = await markReady(repo, pr, token);
    // A conflicting PR gets no pull_request runs at all (GitHub cannot build its merge ref), so it may reach
    // rebase mode without a review pass. Reviewed already: the rebased head Pendulum pushed is recorded as mergeable, and
    // it merges once its required checks are green (the dispatcher's next tick). Not yet reviewed: relabel (remove,
    // then add) so the review job fires now.
    // Only Pendulum's own clean rebase keeps the review: a head the harness made (a conflict resolved, a validation fix)
    // goes back to the reviewer, and nothing of it is recorded mergeable.
    // A foundation Objective's review covers the foundation pass too (handoff.mjs reviewsCover): one reviewed before the
    // label goes back to the review job, which runs that pass alone.
    // And only a rebase of the head that review covers (#350): commits written after it (a Question's answer the work
    // stage wrote before this send-back) go to the review job, whose reviewer reads them.
    const prReviews = rebaseMode && rebasedTo && outbox.expected() === rebasedTo ? await rest(`repos/${repo.full}/pulls/${pr.number}/reviews?per_page=100`, { ...token, paginate: true }).catch(() => []) : null;
    const cover = prReviews ? reviewsCover(prReviews, issue) : null;
    let reviewed = !!cover?.reviewed && (!foundation || cover.foundation);
    if (reviewed) {
      const scope = await reviewScope(outbox.git, { reviews: prReviews, comments: prComments, issue, base: outbox.base, head: rebasedTo });
      if (!scope.covered) {
        log(`PR #${pr.number}: commits since the head Pendulum's review covers (${String(scope.since || "").slice(0, 7) || "none"}) are more than this rebase; the review job reviews them`);
        reviewed = false;
      }
    }
    // A maintainer's comment no pass has read (a change asked for after the review) has not reached the code: no merge.
    // The review job runs instead (relabel below) and its answer pass applies it. Unreadable comments Block.
    if (rebaseMode && reviewed) {
      await exitStep(decision, "the maintainers' comments could not be read before the merge", async () => {
        const { unread } = await unreadNow(repo, { issue, prNumber: pr.number, self: await progress.self() }, token);
        if (unread.length) {
          log(`${unread.length} maintainer decision(s) no pass has read; the review job applies them before any merge`);
          reviewed = false;
        }
      });
    }
    if (decision.exit === "delivered" && rebaseMode && reviewed && inputs.autoMerge) {
      await exitStep(decision, "the rebased head could not be recorded for the merge", async () => {
        await recordMergeable(repo, pr.number, issue, rebasedTo, token);
        log(`PR #${pr.number} rebased onto ${defaultBranch} as ${outbox.expected().slice(0, 7)}; it merges once its required checks are green`);
      });
    }
    // Remove, then add: a label already present (a harness applied it early) fires no labeled event.
    if (decision.exit === "delivered") {
      if (!(rebaseMode && reviewed)) await removeLabel(repo, pr.number, REVIEW_LABEL, token).catch(() => {});
      // A head no review has seen (the one Pendulum pushed) waits, unlabelled, while a sibling it conflicts with is ahead
      // of it (overlap.mjs reviewHold): the dispatcher labels it once none is, after its one rebase if it conflicts by
      // then. The rebase that follows such a wait goes to review: it is next.
      const held = await reviewHold(repo, { issue, pr, head: outbox?.expected() || pr.head?.sha, autoMerge: inputs.autoMerge, hold: inputs.siblingHold, objectiveLabel: inputs.objectiveLabel, rebaseMode, reviewed, waitMaxMs: inputs.siblingWaitMs }, token, { log });
      if (held) decision.reason = `PR #${pr.number} is ready; ${waitReason(held)}`;
      else await exitStep(decision, "the review label could not be applied, so no review job would run", () => addLabels(repo, pr.number, [REVIEW_LABEL], token));
    }
  }
  // The AI Gateway refused a relayed call for its own budget or credits, or the relay shut the gateway for calls it could
  // not price: a Block names it first, and reads "dollar cap reached" only when max_usd was in fact reached.
  if (decision.exit === "blocked" && relay) {
    const capped = maxUsdReached(inputs.maxUsd, records, relay.totals());
    decision.reason = stageBlockReason(decision.reason, relay.totals(), capped);
    decision.cause = stageBlockCause(decision.cause, relay.totals(), capped);
  }
  const askedAtPlan = decision.exit === "question" && !!planNeeds;
  // Recorded with the ask, so the rerun knows which answer is to it (one-repo.mjs answeredRepos).
  if (askedAtPlan) await progress.planAsked(needs.repos);
  // Hosts the worker's sandbox denied: the backend names the operator's fix (local mode: PENDULUM_LOCAL_DOMAINS). Variables
  // its shell lacked: the opt-in (worker_secrets) and where the value goes on this route.
  const fixes = decision.exit === "blocked" ? [decision.deniedHosts ? backend().sandbox.deniedFix(decision.deniedHosts, process.env, inputs.harness) : null, decision.missingSecrets ? missingSecretsFix(decision.missingSecrets, inputs.workerSecrets, backend().name === "local" ? "local" : "runner") : null].filter(Boolean) : [];
  const fix = fixes.length ? fixes.join(" ") : null;
  // A Block that came from an outage (an exit step that met it) ends the stage on that outage instead (session.mjs
  // outageFirst, outageExit); any other Block stands.
  outageFirst(decision);
  const applied = await applyExit(repo, { issue, pr, exit: decision.exit, reason: decision.reason, detail: decision.exit === "blocked" ? validation?.lastOutput : "", notify: inputs.notify, stage: "work", askOnIssue: askedAtPlan, fix, cause: decision.cause }, token);
  await finish(applied?.exit ?? decision.exit, applied?.exit === decision.exit ? decision.reason : (applied?.reason ?? decision.reason));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    process.stderr.write(`[pendulum] worker failed: ${e.message}\n`);
    process.exit(1);
  });
}
