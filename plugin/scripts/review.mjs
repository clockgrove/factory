#!/usr/bin/env node
// Factory review job: one comment-only reviewer pass, one worker pass to answer it,
// then the merge queue.
//   node scripts/review.mjs --repo OWNER/NAME --pr N [--checkout DIR] [--usage-dir DIR]
// With the App token: fetch the PR diff, body and the issue body; run the reviewer
// harness once with the factory-review-pr skill and the reviewer agent definition (model
// pinned there); parse its findings and post them as one PR review with line
// comments (REST, event COMMENT); run one worker pass with the comments as the
// prompt (a fresh session: the worker job's session does not survive the runner),
// which leaves its replies, PR body and exit record in $FACTORY_OUT for Factory to
// push and post (lib/handoff.mjs); run the validation commands again; then, if
// auto_merge, record the head as mergeable and merge exactly it once its required
// checks are green (now, or at the dispatcher's next tick). Unaddressed findings or
// red validation after the pass is the blocked exit.
import { agentServicePorts, noteSetupStart, pinRunnerGit } from "./lib/claude-runner.mjs";
import { pathToFileURL } from "node:url";
import { existsSync, mkdirSync } from "node:fs";
import { dropOwned, privateTmp } from "./lib/fsafe.mjs";
import { join, resolve } from "node:path";
import { AGENT_DIRS, PLUGIN_ROOT, branchIdentity, installCommand, installDeps, installPlugin, runnerFileEnv, sh } from "./lib/checkout.mjs";
import { credentialEnv, gatewaySession, harnessVersion, runHarness, scrubbedEnv, stageSpendSoFar } from "./lib/harness.mjs";
import { addLabels, closingIssues, getIssue, hasMergeQueue, getPr, listComments, postReview, prDiff, primeWriters, removeLabel, repoOf, resolveFactoryThreads, rest, runningSince, setDraft, transientError } from "./lib/github.mjs";
import { eventAction, eventSender, log, parseArgs, resolveInputs, setOutput } from "./lib/inputs.mjs";
import { unpricedCodex } from "./lib/usage.mjs";
import { PLACEHOLDER_MARKER, REVIEW_LABEL, acceptanceEntries, capReached, copilotCount, costByPhase, decideExit, decisionsRead, decisionsSection, decisionsShown, diffLines, marker, maxUsdReached, parseFindings, parseReview, promptDiff, protectedPaths, protectedTouched, refusalCause, refusalReason, sessionCapNote, setupPaths, snapComments, sumSpend, trustedAuthor, unmeteredRun } from "./lib/logic.mjs";
import { agentUser } from "./lib/proc.mjs";
import { backend, spendInProgress } from "./lib/backend.mjs";
import { refusalExit } from "./lib/local.mjs";
import { OUTAGE, stopWaiting, unreachable, waitOutages } from "./lib/network.mjs";
import { openOutbox } from "./lib/outbox.mjs";
import { allowAgentEnv } from "./lib/agent.mjs";
import { authorGate, choiceGate, planGate } from "./lib/objective-trust.mjs";
import { ranWith } from "./lib/choice.mjs";
import { credentialChecks } from "./doctor.mjs";
import { exitFromOut, handoverChecker, handoverPosted, isSplitPart, noReviewReason, openHandoff, partsRecord, postNote, postReplies, publishPr, reviewAnswer, reviewCallEnd, reviewCallTimeout, reviewMissed, reviewPost, reviewRetry, splitPartOf } from "./lib/handoff.mjs";
import { openTriage, triageKey } from "./lib/triage.mjs";
import { openWorkerSecrets, packShellSecrets } from "./lib/worker-secrets.mjs";
import { closeWorkerRelay, openWorkerRelay } from "./lib/worker-relay.mjs";
import { CALL_LOG, stageBlockCause, stageBlockReason } from "./lib/gateway-relay.mjs";
import { GOALS, openDrift } from "./lib/drift.mjs";
import {
  TASK_CARD_TEMPLATE,
  applyExit as applyExitNow,
  openAccess,
  commitAuthor,
  gitIdentity,
  buildPrompt,
  configureGit,
  deadline,
  exitRecord,
  isValidated,
  liveActivity,
  maskFile,
  mirrorDiff,
  earlyOutageEnd,
  outageExit,
  restoreTranscript,
  saveTranscript,
  saveAgentTranscript,
  stageThreads,
  answerFreshAfter,
  crashed,
  holdScope,
  observe,
  postValidated,
  progressReporter,
  remainingMs,
  unaddressedReviewComments,
  validationLoop,
  writeUsage,
  questionRaisedAt,
  answeredDuringJob,
  recordMergeable,
  mergeBlockCause,
  mergeBlockReason,
  mergeReadyOne,
  stopStage,
  stoppedEnd,
  unreadNow,
} from "./lib/session.mjs";
import { claimExit, commitExit, confirmRunning, holdIfStopped, objectiveReader, parked, stopCause, stopText, watchObjective } from "./lib/stop.mjs";
import { stageSpendLine, usdText } from "./lib/logic.mjs";

/** The most of a PR's diff Factory reads from its mirror for the review (comments are fitted to it). */
const REVIEW_DIFF_BYTES = 256 * 1024 * 1024;

/**
 * The reviewer's prompt: the skill does the work; the JSON shape is what the job
 * parses. Claude and Copilot run as the pinned reviewer agent (--agent); Codex has
 * no such flag, so the prompt names the definition file. The issue's acceptance
 * entries (acceptanceEntries) are listed by id: the answer judges each one, and an
 * entry left unjudged is named on the review (handoff.mjs reviewPost). `part` is set only on a split Objective's part
 * that leaves work for the next (handoff.mjs isSplitPart): the prompt says so, so the reviewer judges the entries the
 * PR body assigns to a later part as deferred; the last part and a one-PR Objective get the prompt without it.
 */
export function reviewerPrompt({ issue, issueTitle, issueBody, prBody, diff, harness, decisions = [], part = null, handover = null }) {
  const agentFile = `${AGENT_DIRS[harness]}/reviewer${harness === "codex" ? ".toml" : harness === "copilot" ? ".agent.md" : ".md"}`;
  const entries = acceptanceEntries(issueBody);
  const brief = (t) => (t.length > 160 ? `${t.slice(0, 159)}…` : t);
  return [
    `You are the Factory reviewer for the pull request on issue #${issue}: ${issueTitle}.${harness === "codex" ? ` Act as the reviewer agent defined in ${agentFile} and` : ""} Follow the factory-review-pr skill (in .claude/skills/factory-review-pr and .agents/skills/factory-review-pr) exactly. Read the repository as you need to.`,
    "Do NOT post anything to GitHub yourself: the job posts your findings. Your final message must be only a JSON object of this shape, with no prose around it:",
    '```json\n{"acceptance": [{"entry": "2", "met": true, "path": "src/file.ts", "line": 40, "evidence": "..."}], "comments": [{"path": "src/file.ts", "line": 42, "entry": "2", "body": "acceptance 2: ..."}]}\n```',
    "`acceptance` has one judgment for every acceptance entry: `met` is true only when the diff and the repository show the entry holds, `path` and `line` point at the code that shows it, and `evidence` says how in a sentence. Where an entry says behaviour stays as it was, read what the diff removes or changes in that behaviour before you judge it. Every entry judged not met also gets a comment carrying its `entry`. `comments` may be empty. `line` is a line number on the new side of the diff.",
    entries.length
      ? `The issue's acceptance entries, by the ids to use (the full text is in the issue below):\n${entries.map((e) => `- ${e.id}: ${brief(e.text)}`).join("\n")}`
      : "Name each acceptance entry the issue states by its own label, or by its position when it has none.",
    ...(part ? [splitPartBrief(part)] : []),
    "",
    "## Issue",
    issueBody || "(no body)",
    "",
    ...(decisionsSection(decisions) ? [decisionsSection(decisions), ""] : []),
    "## PR body",
    prBody || "(no body)",
    "",
    "## Diff",
    "```diff",
    promptDiff(diff),
    "```",
    // The workflow change the PR leaves for a person (handover.mjs), as Factory published it: part of the change.
    ...(handover ? ["", "## Workflow hand-over", "Factory's comment on the issue hands this change to a person to apply after the merge; review it as part of the change (the factory-review-pr reference, \"Workflow hand-over\").", "```diff", handover.trimEnd(), "```"] : []),
  ].join("\n");
}

/** The reviewer's brief for a split part that is not the last (factory-review-pr reference.md, "Split parts"). */
export const splitPartBrief = (part) =>
  `This PR is part ${part.number} of this Objective, which is split into sequential PRs, and it is not the last part: a later part delivers the acceptance entries its PR body assigns to one. Judge such an entry \`"met": false, "deferred": true\` with no comment, as the factory-review-pr reference says under "Split parts". That changes only those judgments: review every line this part changes, every claim its body makes for this part, and the repository's rules and checklist answers exactly as for any PR. A defect in this part's own lines is a finding on those lines even when the entry it relates to is deferred: a schema, constraint, signature or error this part adds that a later part's entry cannot be built on as it stands (a column that cannot hold a record that entry needs, a call with no way to bound or stop it, a refusal whose reason is lost) is raised now, not left for that part.`;

/**
 * The decisions an answer pass is given to apply, as answerPrompt renders them: those that fit its task card (a fresh
 * pass) and those listed after it (all unread ones uncut; else what fits). Only these are recorded as read.
 */
export function answerFed({ fresh, decisions, listed, afterPush }) {
  return [...(fresh ? decisionsShown(decisions) : []), ...(afterPush ? listed : decisionsShown(listed))];
}

/** The harness, model and effort of a worker pass the review job runs (the answer pass): the worker's own, effort included. */
export function workerRun(inputs) {
  return { harness: inputs.harness, model: inputs.model, effort: inputs.effort };
}

/** The worker's prompt for the one pass that answers the review. */
export function answerPrompt({ taskCard, prNumber, comments, decisions = [], afterPush = false }) {
  const list = comments.map((c) => `- ${c.path || "(review body)"}${Number.isInteger(c.line) ? `:${c.line}` : ""} (comment id ${JSON.stringify(c.id)}): ${c.body}`).join("\n");
  // Unread decisions are what this pass is for: all of them, never cut for length (answerFed records them all).
  const recorded = decisionsSection(decisions, afterPush ? Infinity : undefined);
  const ask = comments.length
    ? `The reviewer has posted its one pass on PR #${prNumber} (the comments are below and in \`$FACTORY_IN/review-comments.json\`). Load the factory-deliver-pr skill's "Reviewer comments" section and handle each comment once: make the change and reply with the commit, or reply with a rebuttal naming the acceptance entry or repository rule. Write the replies to \`$FACTORY_OUT/replies.json\` as [{"id": <comment id>, "body": "..."}]; Factory posts them.${recorded ? " Apply the maintainers' decisions below as well." : ""}`
    : afterPush
      ? `A maintainer commented on PR #${prNumber} after the last pass read the decisions (new or edited comments). Apply the decisions below to the branch: they are the specification where they differ from the code or your assumptions. If a decision asks for nothing to change, change nothing for it.`
      : `A maintainer answered PR #${prNumber}'s question and marked it ready. Apply the decisions below to the branch: they are the specification where they differ from your assumptions. Update the Assumptions in \`$FACTORY_OUT/pr.md\` (start from \`$FACTORY_IN/pr.md\`) so no answered item starts with QUESTION: any more.`;
  return [
    taskCard.trimEnd(),
    "",
    "---",
    "",
    `${ask} Then rebase onto the default branch as Factory fetched it (never fetch or pull), run the validation commands, commit, write your exit record, and stop: Factory pushes the branch.`,
    "",
    "## Reviewer comments",
    list || "(none)",
    ...(recorded ? ["", recorded] : []),
  ].join("\n");
}

/** Every exit this stage applies waits while a stop of its Objective is under way: the stop's own exit stands (stop.mjs). */
// `beforeExit`: the stage's last read of its issue (stop.mjs confirmRunning), once its watch runs. A stop racing an exit
// already being applied ends nothing (stop.mjs commitExit); a state label that exit put back is the dispatcher's to tidy.
let beforeExit = null;
const applyExit = async (...args) => {
  await holdIfStopped();
  await beforeExit?.();
  if (!commitExit()) await parked();
  return applyExitNow(...args);
};

async function main() {
  const startedAt = Date.now();
  // Factory's own temp directory, 700 and out of the agent's reach; the harness and its commands keep the stage's TMPDIR.
  const tmp = privateTmp();
  const args = parseArgs(process.argv.slice(2));
  const inputs = resolveInputs({ args });
  if (!inputs.repo) throw new Error("--repo OWNER/NAME is required");
  if (!inputs.pr) throw new Error("--pr N is required");
  const repo = repoOf(inputs.repo);
  let checkout = resolve(args.checkout || process.env.GITHUB_WORKSPACE || process.cwd());
  const deadlineAt = deadline(startedAt, inputs.timeoutMinutes);
  // This machine's network (lib/network.mjs), as for the worker: a wait in place, fifteen minutes on the local route
  // (then paused, for serve to resume) and up to the work's deadline elsewhere.
  const local = backend().name === "local";
  waitOutages({ until: (since) => (local ? Math.min(since + OUTAGE.stageWaitMs, deadlineAt) : deadlineAt) });
  const protectedList = protectedPaths(inputs.protectedAdditions);
  const records = [];
  let passes = 0;
  // The job's dollar cap (max_usd), kept as the worker job keeps it: no harness run starts once it is spent, and a run
  // that ends at or past it (Codex and Copilot have no in-run cap) is marked and ends the job Blocked.
  let overBudget = false;
  const over = (...pending) => capReached(inputs.maxUsd, [...records, ...pending]);
  // A Copilot run that did work but reported no priced AI credits leaves the cap unenforceable: the same stop.
  let unmetered = false;
  const capReason = () => (unmetered ? "unmetered: max_usd cannot be enforced" : "dollar cap reached");
  const mark = (rec, ...pending) => {
    // A run that hit its cap (Claude's in-run cap, or Copilot's 30-credit floor that starts no run) is over budget too.
    if (rec?.budgetExceeded) overBudget = true;
    if (rec && over(...pending)) {
      rec.budgetExceeded = true;
      overBudget = true;
    }
    if (rec && inputs.maxUsd > 0 && unmeteredRun(rec)) {
      Object.assign(rec, { budgetExceeded: true, unmetered: true });
      overBudget = true;
      unmetered = true;
    }
    return rec;
  };
  // A Block's reason with what the gateway relay saw named first (gateway-relay.mjs stageBlockReason): its shutdown is no
  // max_usd overrun.
  const relayReason = (reason) => (relay ? stageBlockReason(reason, relay.totals(), maxUsdReached(inputs.maxUsd, records, relay.totals())) : reason);
  // Its cause beside it (logic.mjs BLOCK_CAUSES): the gateway's own refusal, or a relay shutdown that is no max_usd overrun.
  const relayCause = (cause) => (relay ? stageBlockCause(cause, relay.totals(), maxUsdReached(inputs.maxUsd, records, relay.totals())) : cause);
  const capCause = () => (unmetered ? "factory" : "max-usd");
  const blockedAtCap = async (before) => {
    log(`max_usd ${inputs.maxUsd} ${unmetered ? "cannot be enforced (a run reported no priced AI credits)" : "spent"} before ${before}; not running it`);
    await dropLabel();
    const reason = relayReason(capReason());
    await applyExit(repo, { issue, pr, exit: "blocked", reason, cause: relayCause(capCause()), notify: inputs.notify, stage: "review" }, token);
    await finish("blocked", reason);
  };
  // The stage's time cap reached before a reviewer call (handoff.mjs reviewCallTimeout): Blocked, as a call that ran
  // into it would be, rather than a call with no wall-clock cap.
  const blockedAtTime = async (before) => {
    const reason = "time cap reached";
    log(`${reason} before ${before}; not running it`);
    await dropLabel();
    await applyExit(repo, { issue, pr, exit: "blocked", reason, cause: "work", notify: inputs.notify, stage: "review" }, token);
    await finish("blocked", reason);
  };

  // The write token in memory; on Actions the agent uid, its read-only token and its own clone (session.mjs openAccess).
  // These first steps (the token, the writers, the PR, the local loop's hold) end on an outage the same way the stage
  // does (session.mjs earlyOutageEnd): paused locally, an `outage` Block elsewhere once the issue is known.
  const factoryTree = checkout;
  let keeper;
  let token = null;
  let agentError = null;
  let pr = null;
  let issue = null;
  let access;
  try {
    access = await openAccess({ inputs, repo, args, given: factoryTree });
    keeper = access.keeper;
    checkout = access.checkout;
    // notice: local mode's App, for the notices that @mention a person (session.mjs applyExit).
    token = { token: keeper.getter, notice: access.notice };
    // No agent uid on this runner (no sudo, no systemd): the run Blocks before anything else.
    agentError = access.agentError || null;
    await primeWriters(repo, token, { maintainers: inputs.maintainers });
    pr = await getPr(repo, inputs.pr, token);
    const m = /^factory\/(\d+)$/.exec(pr.head?.ref || "");
    if (!m) {
      log(`PR #${pr.number} is not on a factory/<issue> branch; nothing to review`);
      setOutput("exit", "skipped");
      return;
    }
    issue = Number(m[1]);
    if (await backend().trigger.stepsAside(repo, issue, token)) {
      log(`#${issue} is held by a local loop, which runs its own review; nothing to do here`);
      setOutput("exit", "skipped");
      setOutput("issue", "");
      return;
    }
  } catch (e) {
    if (!unreachable(e)) throw e;
    const dir = args.usage_dir || process.env.FACTORY_USAGE_DIR || (issue ? join(factoryTree, "..", `factory-usage-${issue}-review`) : null);
    await earlyOutageEnd(e, { local, usageDir: dir ? resolve(dir) : null, harness: inputs.harness, model: inputs.reviewerModel, block: issue && token ? (reason) => applyExit(repo, { issue, pr, exit: "blocked", reason, cause: "outage", notify: null, stage: "outage" }, token) : null });
    if (issue) setOutput("issue", String(issue));
    return;
  }
  const app = keeper.app;
  const usageDir = resolve(args.usage_dir || process.env.FACTORY_USAGE_DIR || join(factoryTree, "..", `factory-usage-${issue}-review`));
  mkdirSync(usageDir, { recursive: true });
  const eventsFile = join(usageDir, "events.jsonl");
  const branch = pr.head.ref;
  const defaultBranch = pr.base?.ref || "main";

  let cred = { env: {} };
  // The worker secrets' values, once the fix and answer passes have them: masked in the saved stream and transcript.
  let shellSecretValues = [];
  // The gateway relay for the fix and answer passes (lib/worker-relay.mjs), closed and booked when the stage ends.
  let relay = null;
  const progress = progressReporter(repo, issue, token, { stage: "review", harness: inputs.harness, model: inputs.reviewerModel });
  if (pr.html_url) progress.link(`PR #${pr.number}`, pr.html_url);
  // The work lineage's session (a restored worker session, a fix pass, the answer pass): what a later stage resumes.
  // finish saves it and every other session this stage ran (the reviewer's own), so the review's spend can be checked.
  const session = { id: null, canResume: true };
  let reentry = null;
  // The harness and model labels this Objective runs on (objective-trust.mjs choiceGate), recorded with its usage.
  let chosenLabels = [];
  // The watch on the issue for a person's stop (stop.mjs), from the moment the stage has checked the issue.
  let watch = null;
  // The stage's end is written once: by this finish, or by the stop's (stopNow), whichever claims it first.
  const finish = async (exit, reason, outage = null) => {
    watch?.stop();
    if (!claimExit()) return parked();
    return finishNow(exit, reason, outage);
  };
  const finishNow = async (exit, reason, outage = null) => {
    keeper.stop();
    // The stage's spend as last read, the relay's key spend in it: what a pass that reported no dollars counts.
    const known = await stageSpendSoFar().catch(() => null);
    // Totals once the relay has closed: every call in flight is priced by then.
    await closeWorkerRelay(relay);
    const workerKey = relay ? relay.totals() : null;
    const masked = maskFile(eventsFile, [...Object.values(cred.env), ...shellSecretValues, ...keeper.issued, inputs.githubToken, inputs.appPrivateKey]);
    if (masked) log(`masked ${masked} secret occurrence(s) in events.jsonl`);
    // The gateway relay's call log (uploaded with the usage directory) carries text the caller chose: masked the same way.
    const maskedLog = maskFile(join(usageDir, CALL_LOG), [...Object.values(cred.env), ...shellSecretValues, ...keeper.issued, inputs.githubToken, inputs.appPrivateKey]);
    if (maskedLog) log(`masked ${maskedLog} secret occurrence(s) in ${CALL_LOG}`);
    let usage;
    try {
      usage = writeUsage(usageDir, { ran: ranWith(inputs, chosenLabels), spendInProgress: spendInProgress(), harness: inputs.harness, model: inputs.reviewerModel, records, passes, exit, reason, outage, reentry, workerKey, credentialBasis: "see worker", harnessVersion: harnessVersion(inputs.harness), session: await (agentUser() ? saveAgentTranscript : saveTranscript)({ harness: inputs.harness, sessionId: session.id, also: stageThreads(records), usageDir, checkout, secrets: [...Object.values(cred.env), ...shellSecretValues, ...keeper.issued, inputs.githubToken, inputs.appPrivateKey] }) });
    } finally {
      // Only now, and whatever happened: the transcript's archive above is made in Factory's temp directory (its TMPDIR).
      dropOwned(tmp.factory);
    }
    log(`review exit: ${exit}${reason ? ` (${reason})` : ""}; usd ${usage.usd ?? "unmetered"}`);
    // Local runs upload no usage artifact: the spend line in the progress comment is what the daily cap counts.
    // Every stage records one, $0 when no harness ran (logic.mjs stageSpendLine).
    if (spendInProgress()) {
      const line = stageSpendLine(usage, { records, known });
      progress.spend(line.usd, line.parts);
    }
    await progress(`exit: ${exit}${reason ? ` (${reason})` : ""}; usd ${usdText(usage)}${copilotCount(usage)}${costByPhase(records)}`);
    // The stage's last write is done: a request still waiting for the network (a background one) ends now, not at its limit.
    stopWaiting();
    setOutput("exit", exit);
    setOutput("reason", reason || "");
    setOutput("issue", String(issue));
  };
  // The trigger label comes off on every exit, so a re-label is always one more pass.
  const dropLabel = () => removeLabel(repo, pr.number, REVIEW_LABEL, token).catch((e) => log(`review label: ${e.message.slice(0, 120)}`));

  try {
    await run();
  } catch (e) {
    // A harness start Factory refused (local mode: the clone's git): Blocked with a fixed reason, the detail in the log.
    const refused = refusalExit(e, { stage: "review", issue });
    if (refused) {
      log(e.message.slice(0, 300));
      await dropLabel();
      await applyExit(repo, { issue, pr, exit: "blocked", reason: refused.reason, key: refused.key, cause: "setup", notify: inputs.notify, stage: "review" }, token).catch((x) => log(`exit after refusal failed: ${x.message.slice(0, 120)}`));
      await finish("blocked", refused.reason);
      return;
    }
    // This machine's network, not the stage: paused locally (its review label stays, for serve's resume), an `outage`
    // Block elsewhere (session.mjs outageExit) that mentions no one: the dispatcher relaunches the Objective's work.
    if (unreachable(e)) {
      await outageExit(e, {
        local,
        records,
        finish,
        block: async (reason) => {
          await dropLabel();
          await applyExit(repo, { issue, pr, exit: "blocked", reason, cause: "outage", notify: null, stage: "outage" }, token);
        },
      });
      return;
    }
    log(`review crashed: ${e.message.slice(0, 300)}`);
    const reason = `review crashed: ${e.message.slice(0, 200)}`;
    await dropLabel();
    await applyExit(repo, { issue, pr, exit: "blocked", reason, cause: "factory", notify: inputs.notify, stage: "crash" }, token).catch((x) => log(`exit after crash failed: ${x.message.slice(0, 120)}`));
    await finish("blocked", reason);
    throw e;
  }

  async function run() {
  if (agentError) {
    await dropLabel();
    await applyExit(repo, { issue, pr, exit: "blocked", reason: agentError, cause: "setup", notify: inputs.notify, stage: "doctor" }, token);
    await finish("blocked", agentError);
    return;
  }
  if (pr.draft) {
    log(`PR #${pr.number} is a draft (question or blocked); the reviewer waits for a human to mark it ready`);
    await dropLabel();
    await finish("skipped", "draft PR");
    return;
  }
  // The worker marks the PR ready and then applies factory:review after its validation pass; the App's own
  // ready_for_review is that transition seen first, never a review cue (the workflow's `if:` filters it out; this skip
  // covers a workflow rendered before that filter). A person marking it ready is how a Question is answered (PLAN.md): the review job runs, and the answer pass applies
  // the maintainers' decisions even when the PR was already reviewed.
  const humanReady = eventAction() === "ready_for_review" && eventSender()?.type !== "Bot";
  if (eventAction() === "ready_for_review" && !humanReady) {
    log(`PR #${pr.number} marked ready; the review runs on the factory:review label, not on this event`);
    await finish("skipped", "ready_for_review is not a review cue");
    return;
  }
  // A stopped Objective (its label removed, its issue closed: stop.mjs) gets no review: the label comes off and nothing
  // else changes. From here on the stage stops when a person stops it (session.mjs stopStage).
  const stopped = stopCause(await getIssue(repo, issue, token), inputs.objectiveLabel);
  if (stopped) {
    log(`#${issue}: ${stopText(stopped, inputs.objectiveLabel)}; no review`);
    await dropLabel();
    await finish("skipped", `the Objective is stopped (${stopText(stopped, inputs.objectiveLabel)})`);
    return;
  }
  // The stopped stage's end when the usual one runs out of time (session.mjs stopStage): written at once, its stream
  // masked first, its usage only if the usual end did not write it, and its live spend in its progress line.
  const endNow = (recs, why) => {
    const secrets = [...Object.values(cred.env), ...shellSecretValues, ...keeper.issued, inputs.githubToken, inputs.appPrivateKey];
    maskFile(eventsFile, secrets);
    maskFile(join(usageDir, CALL_LOG), secrets);
    if (!existsSync(join(usageDir, "result.json"))) writeUsage(usageDir, { ran: ranWith(inputs, chosenLabels), spendInProgress: spendInProgress(), harness: inputs.harness, model: inputs.reviewerModel, records: recs, passes, exit: "stopped", reason: why, credentialBasis: "see worker", reentry, workerKey: relay ? relay.totals() : null });
    progress.flushNow();
  };
  const stopNow = async (cause) => {
    let took = true;
    try {
      took = await stopStage({ cause, label: inputs.objectiveLabel, repo, issue, pr, records, finish: finishNow, opts: token, endNow });
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
  // One review pass per PR. A PR that already has it (a Question draft a human marked ready, or a
  // rebased PR relabelled by the worker) skips the reviewer, answers only what is still unanswered, and
  // still gets validation, the exit and auto-merge: the merge path is this job's, not the reviewer's.
  // Only text a writer wrote reaches the reviewer and the answer and fix passes (objective-trust.mjs): the body read
  // with its author and last editor, checked again at this stage before anything is set up for it, or a Block.
  const trusted = await authorGate({ repo, issue, issueData: await getIssue(repo, issue, token), pr, notify: inputs.notify, opts: token, apply: applyExit, before: dropLabel });
  if (!trusted.ok) {
    log(trusted.reason);
    await finish("blocked", trusted.reason);
    return;
  }
  const { issueData } = trusted;
  // The text its plan was made from (objective-trust.mjs planGate): changed since, the review, the answer pass and the
  // merge do not go on with code made for the earlier text. The stage Blocks before anything is set up for it.
  const planned = await planGate({ repo, issue, sha: trusted.sha, editedAt: trusted.editedAt, pr, notify: inputs.notify, opts: token, apply: applyExit, before: dropLabel, stage: "review" });
  if (!planned.ok) {
    log(planned.reason);
    await finish("blocked", planned.reason);
    return;
  }
  // The harness and models this Objective runs on (objective-trust.mjs choiceGate): the reviewer, and the fix and answer
  // passes, on what its labels choose over the repository's defaults, or a Block before anything is set up for it.
  const chosen = await choiceGate({ repo, issue, labels: trusted.labels, args, pr, notify: inputs.notify, opts: token, apply: applyExit, before: dropLabel, stage: "review" });
  if (!chosen.ok) {
    log(chosen.reason);
    await finish("blocked", chosen.reason);
    return;
  }
  Object.assign(inputs, chosen.inputs);
  chosenLabels = chosen.labels;
  progress.ran(ranWith(inputs, chosenLabels));
  // The chosen harness's credential (doctor.mjs credentialChecks), as the worker's job checks have it: a missing one Blocks
  // with its fix before anything is set up, never a crash at the first harness pass.
  const credFails = (await credentialChecks({ inputs })).filter((c) => c.status === "FAIL");
  if (credFails.length) {
    const reason = `doctor: ${credFails.map((c) => `${c.name} (${c.fix || c.detail})`).join("; ")}`;
    log(reason);
    await dropLabel();
    await applyExit(repo, { issue, pr, exit: "blocked", reason, cause: "setup", notify: inputs.notify, stage: "doctor" }, token);
    await finish("blocked", reason);
    return;
  }
  const alreadyReviewed = (await rest(`repos/${repo.full}/pulls/${pr.number}/reviews?per_page=100`, { ...token, paginate: true })).some((r) => trustedAuthor(r) && (r.body || "").includes(marker(issue, "review")));
  if (alreadyReviewed) log(`PR #${pr.number} already has Factory's one review pass; validating and merging without a second pass`);

  // Factory's git runs only in its own mirror (lib/outbox.mjs): the branch reaches the agent's checkout as a bundle, and
  // every git command there runs in the agent's sandbox (on Actions, as the agent uid). What this stage answers for
  // starts at GitHub's head now. No GitHub token reaches a child: on Actions the agent reads with its own read-only
  // token; locally nothing.
  const childBase = scrubbedEnv(process.env, { CI: "true", TMPDIR: access.agent ? access.agent.tmp : tmp.agent, ...branchIdentity(branch) });
  const outbox = await openOutbox({ branch, defaultBranch, checkout, remote: `https://github.com/${repo.full}.git`, token: keeper.getter, agentEnv: childBase, local: backend().name === "local", protectedList, toolchain: setupPaths(inputs), deadlineAt, base: tmp.factory });
  // Before each push, the issue once more: a stopped or restarted Objective pushes nothing (stop.mjs confirmRunning).
  outbox.beforePush = () => beforeExit?.();
  const identity = await gitIdentity(app, keeper.token);
  // Factory's own commits (its rebases, its merge of a default branch that changed a workflow file) carry its identity.
  const botWho = commitAuthor(identity);
  outbox.author = botWho;
  await configureGit(checkout, { ...identity, protectedList, credentialHelper: access.readHelper || null, env: childBase });
  await outbox.feed();
  // Whatever an earlier stage left in a reused checkout (local mode) is discarded (outbox.mjs putOn).
  const onBranch = await outbox.putOn(`refs/remotes/origin/${branch}`);
  if (onBranch.code !== 0) throw new Error(`the checkout could not be put on ${branch}: ${onBranch.error}`);
  // Git LFS before validation and any fix pass: filters set up in the checkout, the branch's objects handed over.
  const lfs = await outbox.lfsSetup(outbox.expected(), { timeoutMs: remainingMs(deadlineAt) });
  // Factory's own git work on the checkout is done: locally its git state is recorded, and checked before each harness start.
  backend(childBase).sandbox.pinGitState(childBase);
  // A runner's harness: the same state, put back before each start (lib/claude-runner.mjs), since the repository's
  // install and validation run as the agent outside the harness's sandbox.
  if (access.agent) await pinRunnerGit(checkout, childBase);
  if (lfs.used) log(!lfs.ok ? lfs.reason : lfs.warning ? `warning: ${lfs.warning}; the run goes on with pointer files` : "Git LFS: filters set up in the checkout, objects handed over");
  if (!lfs.ok) {
    await dropLabel();
    await applyExit(repo, { issue, pr, exit: "blocked", reason: lfs.reason, cause: "setup", notify: inputs.notify, stage: "review" }, token);
    await finish("blocked", lfs.reason);
    return;
  }
  await installPlugin(checkout, PLUGIN_ROOT, { harness: inputs.harness, models: { subagent: inputs.subagentModel, reviewer: inputs.reviewerModel }, env: childBase });
  // What already listens on loopback is no service of the setup's: Claude Code's commands reach only what it starts.
  if (inputs.harness === "claude" && access.agent) noteSetupStart();
  if (inputs.setup) {
    await progress("setup");
    // On Actions setup may need sudo: it runs as the runner on a clean tree of the default branch, never on branch code.
    const s = access.agent ? await sh(await outbox.defaultTree(), inputs.setup, { env: { ...childBase, TMPDIR: tmp.factory }, timeoutMs: remainingMs(deadlineAt), asRunner: true }) : await sh(checkout, inputs.setup, { env: childBase, timeoutMs: remainingMs(deadlineAt) });
    if (!s.ok) {
      await dropLabel();
      await applyExit(repo, { issue, pr, exit: "blocked", reason: `setup failed before review: ${inputs.setup}`, cause: "setup", notify: inputs.notify, stage: "review" }, token);
      await finish("blocked", "setup failed");
      return;
    }
    const wrote = runnerFileEnv(childBase); // PATH and env the setup wrote for the steps after it
    Object.assign(childBase, wrote);
    allowAgentEnv(Object.keys(wrote));
  }
  const install = installCommand(access.agent ? factoryTree : checkout, inputs.install);
  if (install) {
    await progress("install");
    // An install that failed or left a dependency missing is not a red for the branch: what validation would say after
    // it is no verdict on the PR. installDeps repairs it once; still broken, the stage Blocks naming the install.
    const i = await installDeps(checkout, install, { env: childBase, timeoutMs: remainingMs(deadlineAt) });
    if (i.repaired) log(`install: ${i.first} the first time; repaired by a clean reinstall`);
    if (!i.ok) {
      log(i.reason);
      await dropLabel();
      await applyExit(repo, { issue, pr, exit: "blocked", reason: i.reason, cause: "setup", notify: inputs.notify, stage: "install" }, token);
      await finish("blocked", i.reason);
      return;
    }
  }

  // The maintainers' word since the issue was filed: a Question's answer, a decision recorded in a comment. Read whole
  // or not at all: a partial read could hide the one comment that says "do not merge this".
  let decisions;
  let unread;
  // A decision posted or edited after this read, with a person's ready mark, answers a Question this job raises.
  const readAt = Date.now();
  try {
    ({ decisions, unread } = await unreadNow(repo, { issue, prNumber: pr.number, self: await progress.self() }, token));
  } catch (e) {
    const reason = `the maintainers' comments could not be read, so Factory cannot tell whether one asks for a change: ${e.message.slice(0, 160)}`;
    await dropLabel();
    await applyExit(repo, { issue, pr, exit: "blocked", reason, cause: "factory", notify: inputs.notify, stage: "review" }, token);
    await finish("blocked", reason);
    return;
  }
  if (decisions.length) log(`${decisions.length} maintainer decision(s) from the issue and PR`);
  // A person marked a Question ready: only what a maintainer said after the Question answers it. With nothing new and
  // the question still in the body, the PR goes back to a Question rather than merging an unanswered one.
  const questionAt = humanReady ? await questionRaisedAt(repo, pr, token) : null;
  // An earlier comment edited after the Question counts as its answer.
  const newDecisions = humanReady ? decisions.filter((d) => Date.parse(d.seen ?? d.at) > Date.parse(questionAt)) : [];
  // A maintainer's word no pass has read (posted or edited during or after the worker's run, or during an earlier
  // review job: a change asked for after the review, a regression found by a person) has not reached the code: the
  // answer pass applies it before anything merges, review or no review. A Question answered keeps its own rule above.
  const afterPush = humanReady && newDecisions.length ? [] : unread;
  if (afterPush.length) log(`${afterPush.length} maintainer decision(s) no pass has read yet; the answer pass applies them`);
  if (humanReady && !newDecisions.length && /(^|\n)\s*(?:[-*]|\d+\.)?\s*(?:\*\*)?QUESTION:/.test(pr.body || "")) {
    const reason = "marked ready, but no maintainer answer since the question; answer in a comment on the issue or the PR, then mark it ready again";
    log(`PR #${pr.number}: ${reason}`);
    await dropLabel();
    await applyExit(repo, { issue, pr, exit: "question", reason, notify: inputs.notify, stage: "review" }, token);
    await finish("question", reason);
    return;
  }
  // Codex through the AI Gateway: the stint's session id, the one the worker's passes sent (harness.mjs gatewaySession).
  const gatewayId = inputs.harness === "codex" && inputs.codexGatewayKey ? gatewaySession({ repo: repo.full, issue, since: await runningSince(repo, issue, token).catch(() => null) }) : null;
  cred = await credentialEnv({ harness: inputs.harness, credential: inputs.credential, inputs, session: gatewayId });
  // $FACTORY_IN and $FACTORY_OUT: fresh for this stage; the harness writes nothing to GitHub (lib/handoff.mjs).
  const io = await openHandoff({ repo, issue, issueData, env: childBase, opts: token, outbox, branch, record: planned.record });
  // The drift advisory (lib/drift.mjs) on the answer and fix passes: off without an AI Gateway key; advice only.
  const drift = openDrift({ inputs, progress });
  io.set({ decisions, prNumber: pr.number });
  const harnessEnv = { ...childBase, ...cred.env, ...io.env, FACTORY_ISSUE: String(issue), FACTORY_BRANCH: branch, ...(inputs.compactionWindow ? { FACTORY_COMPACTION_WINDOW: inputs.compactionWindow } : {}), FACTORY_PROMPT_CACHE_TTL: inputs.promptCacheTtl };
  // The secrets this repository opted in to the worker's shell (lib/worker-secrets.mjs): the fix and answer passes
  // continue the worker's session, so they get them as the work stage's passes do (passEnv). The reviewer never does: it
  // runs on harnessEnv, and its calls are marked `reviewer` (runHarness strips them there too).
  // An opted-in AI Gateway key stays in this process behind the relay; the passes get its token (lib/worker-relay.mjs).
  const opened = await openWorkerRelay({ inputs, shell: openWorkerSecrets(inputs, { factoryKey: () => triageKey({ inputs }) }), usageDir });
  relay = opened.relay;
  const shellSecrets = opened.shell;
  // The token, the other values, and the key itself (which the shell no longer holds): masked in what the stage saves.
  shellSecretValues = [...Object.values(shellSecrets), ...opened.masked];
  if (opened.blocked) {
    await dropLabel();
    await applyExit(repo, { issue, pr, exit: "blocked", reason: opened.blocked, cause: "setup", notify: inputs.notify, stage: "review" }, token);
    await finish("blocked", opened.blocked);
    return;
  }
  const passEnv = { ...harnessEnv, ...packShellSecrets(shellSecrets) };
  // A split part's PR keeps `Refs #N` whatever pr.md the answer pass writes, and its reviewer is told it is a part.
  const parts = await partsRecord(repo, issue, token).catch(() => null);
  const splitPart = isSplitPart(parts, pr.number);
  const part = splitPartOf(parts, pr.number);
  // A PR GitHub would read as closing anything but this Objective's issue Blocks the stage (handoff.mjs closingChecked).
  let publishRefused = "";
  // The answer pass may change the workflow hand-over too (handoff.mjs handoverChecker); one that cannot go out Blocks.
  const handover = handoverChecker(() => io.files(), outbox);
  const publish = async (current) => publishPr(repo, { branch, base: defaultBranch, issue, prText: io.files()["pr.md"], splitPart, pr: current, handover: await handover.now() }, token).catch((e) => {
    log(`PR body: ${e.message.slice(0, 160)}`);
    if (e.code === "closing-refs") publishRefused = e.message;
    return e.pr || current;
  });
  const taskCard = buildPrompt({
    templatePath: TASK_CARD_TEMPLATE(PLUGIN_ROOT),
    harness: inputs.harness,
    services: inputs.harness === "claude" && access.agent ? agentServicePorts(access.agent) : [],
    issue,
    issueTitle: issueData.title,
    issueBody: issueData.body,
    decisions,
    maxUsd: inputs.maxUsd,
    timeoutMinutes: inputs.timeoutMinutes,
    validation: inputs.validation,
    ciChecks: inputs.ciChecks,
    budgetCommand: inputs.budgetCommand,
    protectedList,
    shellSecrets: Object.keys(shellSecrets),
  });
  // Resume policy: under fix-passes the worker's saved session carries this job's fix and answer
  // passes; the reviewer always runs in its own fresh session.
  let restored = null;
  if (inputs.resumePolicy === "fix-passes") {
    restored = await restoreTranscript({ repo, issue, token: inputs.githubToken || token.token, checkout, workDir: join(usageDir, ".."), harness: inputs.harness });
    if (restored.id) session.id = restored.id;
  }
  // Every stage says how it entered, resumed or fresh and why, in its progress and in result.json.
  reentry = restored ? { resumed: !!restored.id, from: restored.from ?? null, reason: restored.id ? null : restored.reason } : { resumed: false, from: null, reason: "resume policy is fresh" };
  await progress(`re-entry: ${reentry.resumed ? `resumed session ${restored.id.slice(0, 8)} from ${reentry.from}` : `fresh (${reentry.reason})`}`);
  for (const m of new Set([inputs.reviewerModel, inputs.model].filter(Boolean))) {
    const unpriced = unpricedCodex(inputs.harness, m, { gateway: !!inputs.codexGatewayKey });
    if (unpriced) {
      log(`warning: ${unpriced}`);
      await progress(`unpriced: ${unpriced}`);
    }
  }

  // The reviewer runs after validation passes (PLAN.md): a head the worker job validated
  // carries the marker; a head a human pushed or marked ready does not, so Factory's own
  // pass runs first and a red result is Blocked before any review.
  if (!(await isValidated(repo, pr.number, issue, pr.head.sha, token))) {
    log(`head ${pr.head.sha.slice(0, 7)} has no validation marker; running Factory's validation before the review`);
    const pre = await validationLoop({ onPhase: progress, progress, checks: inputs.ciChecks.length ? { repo, issue, prNumber: pr.number, names: inputs.ciChecks, token: token.token, actionsToken: inputs.githubToken || token.token } : null, outbox, checkout, commands: inputs.validation, harness: inputs.harness, model: inputs.model, effort: inputs.effort, maxUsd: inputs.maxUsd, spentUsd: 0, session, taskCard, env: passEnv, deadlineAt, eventsFile, label: "pre-review-validation", io, triage: openTriage({ inputs, repo, issue, prNumber: pr.number, token: token.token, actionsToken: inputs.githubToken || token.token, progress }), drift });
    records.push(...pre.usage);
    passes = pre.passes;
    if (pre.usage.length) {
      await outbox.push();
      pr = await publish(pr);
    }
    if (pre.conflict) {
      // Not red: the PR conflicts after a sibling merged. Unlabelled and In review, the dispatcher sends it back for a rebase.
      const reason = `PR #${pr.number} conflicts with ${defaultBranch} after a sibling merged; the dispatcher sends it back for a rebase`;
      log(reason);
      await dropLabel();
      await applyExit(repo, { issue, pr, exit: "delivered", reason, notify: inputs.notify, stage: "review" }, token);
      await finish("delivered", reason);
      return;
    }
    if (!pre.green) {
      const d = decideExit({ harness: pre.harness ?? { ok: true }, pr: { exists: true, draft: false, body: "" }, commits: 1, validation: pre.died || pre.harness ? undefined : { passes: pre.passes, green: false, baseFailure: pre.baseFailure, notStarted: pre.notStarted, stuck: pre.stuck?.reason, stuckCause: pre.stuck?.cause, triageRefused: pre.triageRefused, scope: pre.scope, unchanged: pre.unchanged }, sessionCap: sessionCapNote(process.env.FACTORY_STAGE_SESSION_CAP) });
      await dropLabel();
      const why = relayReason(d.reason || "validation red before review");
      await applyExit(repo, { issue, pr, exit: "blocked", reason: why, cause: relayCause(d.exit === "blocked" ? d.cause : "work"), detail: pre.lastOutput, notify: inputs.notify, stage: "review" }, token);
      await finish("blocked", why);
      return;
    }
    pr = await getPr(repo, pr.number, token);
    await postValidated(repo, pr.number, issue, pr.head.sha, token);
  }

  // The reviewer: one call, comment-only, findings parsed from its last message. With the cap spent it is not run and
  // nothing is posted, so a later run (the cap raised, the label re-applied) still reviews.
  if (!alreadyReviewed && over()) return blockedAtCap("the reviewer");
  const reviewTimeout = reviewCallTimeout(remainingMs(deadlineAt));
  if (!alreadyReviewed && reviewTimeout === null) return blockedAtTime("the reviewer");
  // From Factory's mirror (no file limit); GitHub's files API only when the mirror cannot make it.
  const prd = await prDiff(repo, pr, token, { diffOf: (base, head) => mirrorDiff(outbox.git, base, head, { mergeBase: true, maxBytes: REVIEW_DIFF_BYTES }) });
  if (prd.source !== "history") log(`the PR's diff came from GitHub's files API (Factory's mirror: ${prd.historyError})${prd.unlisted ? `; ${prd.unlisted} file(s) are past the API's listing` : ""}`);
  const diff = prd.text;
  // The workflow hand-over Factory published for this Objective (handoff.mjs handoverPosted), reviewed with the diff.
  const handoverPatch = (await handoverPosted(repo, issue, token).catch(() => null))?.patch ?? null;
  if (!alreadyReviewed) {
    // The reviewer's effort is passed on its call: no harness applies its reviewer agent file's effort to this run.
    log(`reviewer on ${inputs.reviewerModel || `${inputs.harness}'s default model`} at ${inputs.reviewerEffort || `${inputs.harness}'s default effort`}`);
    await progress(`reviewer ${inputs.reviewerModel || inputs.harness}`);
  }
  const reviewLive = alreadyReviewed ? null : liveActivity(progress, { harness: inputs.harness, model: inputs.reviewerModel });
  const reviewRec = alreadyReviewed ? { ok: true, noRun: true, finalText: "", usd: null, tokens: { input: null, output: null, cached: null }, basis: "no reviewer run: already reviewed" } : await runHarness({
    harness: inputs.harness,
    model: inputs.reviewerModel,
    effort: inputs.reviewerEffort,
    prompt: reviewerPrompt({ issue, issueTitle: issueData.title, issueBody: issueData.body, prBody: pr.body, diff, harness: inputs.harness, decisions, part, handover: handoverPatch }),
    maxUsd: Math.max(0, inputs.maxUsd - sumSpend(records)),
    agent: inputs.harness === "codex" ? undefined : "reviewer",
    reviewer: true,
    cwd: checkout,
    env: harnessEnv,
    timeoutMs: reviewTimeout,
    eventsFile,
    label: "review",
    onLine: reviewLive?.onLine,
  });
  reviewLive?.finish();
  if (!alreadyReviewed) mark(reviewRec, reviewRec);
  // A pass that missed (handoff.mjs reviewMissed: the call failed, as a crash, a non-zero exit, a cap or an idle kill
  // does; its answer held no JSON; or it judged none of the issue's acceptance entries) reruns once in a fresh session,
  // on every harness: on the fallback reviewer where the harness has one (Claude's Opus 5.5 at xhigh, since Fable's quota
  // can run out mid-day and the harness reports no error code for quota), else on the same model (reviewRetry).
  const entries = acceptanceEntries(issueData.body);
  const reviewOf = (rec) => parseReview(rec.finalText || "");
  let retryRec = null;
  // Less than a call's minimum time left (handoff.mjs reviewCallTimeout): no rerun, so the first pass's answer goes up
  // when it produced one, else the stage Blocks with how it ended (the time cap, typically).
  const missed = !alreadyReviewed && reviewMissed({ ok: reviewRec.ok, review: reviewOf(reviewRec), entries });
  const retryTimeout = reviewCallTimeout(remainingMs(deadlineAt));
  if (missed && retryTimeout === null) log(`reviewer ended in ${reviewCallEnd(reviewRec, reviewOf(reviewRec))} with the stage's time cap reached: it is not run again`);
  else if (missed && reviewRec.refusal) log(`reviewer was refused by the provider (${reviewRec.error}): it is not run again`);
  else if (missed) {
    const again = reviewRetry({ model: inputs.reviewerModel, effort: inputs.reviewerEffort, fallback: inputs.reviewerFallback });
    log(`reviewer on ${inputs.reviewerModel || inputs.harness} ended in ${reviewCallEnd(reviewRec, reviewOf(reviewRec))}${reviewRec.ok && reviewOf(reviewRec).parsed ? " that judged no acceptance entry" : ""}${reviewRec.error ? ` (${reviewRec.error})` : ""}; running it once more on ${again.model || inputs.harness}${again.effort ? ` at ${again.effort}` : ""}`);
    records.push(reviewRec);
    if (over() || overBudget) return blockedAtCap("the reviewer's rerun");
    retryRec = await runHarness({
      harness: inputs.harness,
      model: again.model,
      effort: again.effort,
      prompt: reviewerPrompt({ issue, issueTitle: issueData.title, issueBody: issueData.body, prBody: pr.body, diff, harness: inputs.harness, decisions, part, handover: handoverPatch }),
      maxUsd: Math.max(0, inputs.maxUsd - sumSpend(records)),
      agent: inputs.harness === "codex" ? undefined : "reviewer",
      reviewer: true,
      cwd: checkout,
      env: harnessEnv,
      timeoutMs: retryTimeout,
      eventsFile,
      label: again.label,
    });
    mark(retryRec, retryRec);
  }
  if (!alreadyReviewed) records.push(retryRec || reviewRec);
  // The call whose answer goes up: the rerun's when it produced a review, else the first pass's when that did (a pass that
  // ran but judged nothing, then a rerun that failed). Neither did: no review exists, so nothing is posted (no placeholder
  // stands in for it) and the stage Blocks; Factory never merges past the review (handoff.mjs reviewAnswer).
  const answer = alreadyReviewed ? reviewRec : reviewAnswer(reviewRec, retryRec, reviewOf);
  if (!answer) {
    const reason = reviewRec.refusal && !retryRec ? refusalReason(reviewRec.refusal) : noReviewReason([reviewRec, retryRec], reviewOf);
    const cause = reviewRec.refusal && !retryRec ? refusalCause(reviewRec.refusal) : "factory";
    log(reason);
    await dropLabel();
    await applyExit(repo, { issue, pr, exit: "blocked", reason, cause, notify: inputs.notify, stage: "review" }, token);
    await finish("blocked", reason);
    return;
  }
  if (retryRec && answer === reviewRec) log(`the reviewer's rerun ended in ${reviewCallEnd(retryRec, reviewOf(retryRec))}; posting the first pass's answer`);
  const post = alreadyReviewed ? null : reviewPost({ issue, review: reviewOf(answer), diff, entries, ok: answer.ok, splitPart });
  if (post?.unjudged.length) log(`reviewer left ${post.unjudged.length} of ${entries.length} acceptance entr${entries.length === 1 ? "y" : "ies"} unjudged: ${post.unjudged.join(", ")}`);
  const comments = post ? post.comments : [];
  const placeholder = !!post?.placeholder;
  if (comments.length) {
    const posted = await postReview(repo, pr.number, { body: post.body, comments, commitId: pr.head.sha }, token);
    log(`posted review with ${comments.length} comment(s)${placeholder ? " (placeholder: nothing to answer)" : ""}${posted.moved ? `; ${posted.moved} moved to a line GitHub takes` : ""}${posted.inBody ? `; ${posted.inBody} in the review body${posted.retried ? ` (GitHub answered ${posted.retried} to the line comments)` : " (no line GitHub can take)"}, answered from there` : ""}`);
  }
  const reviewerLogin = app.appSlug ? `${app.appSlug}[bot]` : null;
  // A pass with nothing to answer (the reviewer's JSON had no comments: Factory's placeholder went up) skips the worker pass.
  // Factory's own reviews on this PR (the marker in the body, from Factory or someone who can push): their comments are the reviewer's.
  // A failed read falls back to the author filter (null), not a crashed review run.
  const factoryReviewIds = async () => {
    try {
      return new Set(((await rest(`repos/${repo.full}/pulls/${pr.number}/reviews?per_page=100`, { ...token, paginate: true })) || []).filter((r) => trustedAuthor(r) && (r.body || "").includes(marker(issue, "review"))).map((r) => r.id));
    } catch {
      return null;
    }
  };
  const toAnswer = placeholder ? [] : await unaddressedReviewComments(repo, pr.number, reviewerLogin, { ...token, reviewIds: await factoryReviewIds() });
  // A Question answered (a person marked the PR ready): the answer pass applies the decisions even with no comment open.
  const answerQuestion = newDecisions.length > 0 || afterPush.length > 0;
  let answering = toAnswer.length > 0 || answerQuestion;
  // With the cap spent the answer pass is not run; the job Blocks below with what the reviewer left.
  if (answering && (over() || overBudget)) {
    log(`max_usd ${inputs.maxUsd} ${unmetered ? "cannot be enforced" : "spent"} before the answer pass; not running it`);
    overBudget = true;
    answering = false;
  }
  if (answering) await progress(toAnswer.length ? `answer pass: ${toAnswer.length} comment(s)${answerQuestion ? " and the maintainers' answer" : ""}` : afterPush.length ? `answer pass: ${afterPush.length} unread maintainer decision(s)` : "answer pass: the maintainers' answer to the question");

  // One worker pass to answer, then validation again. Its exit record (JSON it writes, or answers
  // with) says whether it raised a question; the PR's draft state does not.
  let answerRecord = null;
  let answerRun = null;
  // The answer pass put back toolchain files its fix needs and asked a Question (holdScope): no validation pass follows.
  let heldQuestion = false;
  let jobRead = {};
  if (answering) {
    // The pass reads its comments and the PR from $FACTORY_IN; an exit record from an earlier pass must not speak for it.
    io.set({ reviewComments: toAnswer });
    await io.clear(["exit.json", "replies.json"]);
    await io.render();
    const answerLive = liveActivity(progress, { harness: inputs.harness, model: inputs.model, tick: io.tick, drift: drift?.watch({ stage: "answer", goal: GOALS.answer, root: checkout, plan: io.plan }) });
    const resumeAnswer = inputs.resumePolicy === "fix-passes" && session.id ? session.id : null;
    let fed = [];
    const comments = toAnswer.map((c) => ({ id: c.id, path: c.path, line: c.line ?? c.original_line, body: c.body }));
    const listedFor = (resume) => (afterPush.length ? afterPush : resume ? decisions : []);
    const answerArgs = (resume) => {
      const listed = listedFor(resume);
      fed = answerFed({ fresh: !resume, decisions, listed, afterPush: afterPush.length > 0 });
      return {
        onLine: answerLive.onLine,
        onResume: answerLive.onResume,
        ...workerRun(inputs),
        resume,
        prompt: answerPrompt({ taskCard: resume ? "" : taskCard, prNumber: pr.number, comments, decisions: listed, afterPush: afterPush.length > 0 }),
        // A resume the provider refuses for a rotated credential runs fresh with the full card (harness.mjs runHarness).
        ...(resume ? { freshPrompt: answerPrompt({ taskCard, prNumber: pr.number, comments, decisions: listedFor(null), afterPush: afterPush.length > 0 }) } : {}),
        maxUsd: Math.max(0, inputs.maxUsd - sumSpend(records)),
        cwd: checkout,
        env: passEnv,
        timeoutMs: remainingMs(deadlineAt),
        eventsFile,
        label: "answer",
      };
    };
    // The answer pass is a fix pass (outbox.mjs fence): the plan, the issue, the decisions and the comments it answers name its scope.
    const scope = io.scope();
    await outbox.fence({ plan: scope.plan, texts: [...scope.texts, ...toAnswer.map((c) => `${c.path || ""}\n${c.body || ""}`)] }).catch((e) => log(`fix-pass scope not set: ${String(e?.message || e).slice(0, 160)}`));
    let rec = await runHarness(answerArgs(resumeAnswer));
    // It ran fresh: the decisions it read are a fresh pass's.
    if (rec.resumeRefused) {
      fed = answerFed({ fresh: true, decisions, listed: listedFor(null), afterPush: afterPush.length > 0 });
      reentry = { ...(reentry || {}), resumed: false, reason: "resume refused by the provider (another credential)" };
    }
    // A resumed session the CLI could not continue falls back to a fresh answer pass with the full card, budget left.
    if (answerFreshAfter(resumeAnswer, rec) && !mark(rec, rec).budgetExceeded) {
      records.push(rec);
      log(`resumed session ${resumeAnswer.slice(0, 8)} failed (${rec.error}); answering fresh`);
      await progress("re-entry: resume failed; answering fresh");
      reentry = { ...(reentry || {}), resumed: false, reason: "resume failed" };
      session.id = null;
      rec = await runHarness(answerArgs(null));
    }
    mark(rec, rec);
    answerLive.finish();
    records.push(rec);
    if (rec.sessionId) session.id = rec.sessionId;
    answerRun = rec;
    let out = await io.collect();
    // Toolchain files the answer changed outside its scope: one turn to put them back, else the push below is refused.
    if (!crashed(rec) && !rec.timedOut && !rec.budgetExceeded && !rec.refusal) {
      const held = await holdScope({ outbox, session, harness: inputs.harness, model: inputs.model, effort: inputs.effort, taskCard, cwd: checkout, env: passEnv, eventsFile, deadlineAt, maxUsd: inputs.maxUsd, spentUsd: sumSpend(records), label: "answer-scope", progress, io });
      for (const r of held.usage) mark(r, r);
      records.push(...held.usage);
      if (held.usage.length) out = io.files();
      if (held.question) {
        heldQuestion = true;
        await progress(`answer-scope: put back and asked a Question: ${held.refused}`);
      }
    }
    // Factory pushes the answer, updates the PR from pr.md, then posts the replies: only to the comments this pass was given.
    // A refused push leaves GitHub without the answer: its pr.md and replies ("fixed") would describe work the branch lacks.
    if (!(await outbox.push())) log(`push refused: ${outbox.error}`);
    const pushed = !outbox.failed;
    if (pushed) pr = await publish(pr);
    const replied = !pushed
      ? 0
      : await postReplies(repo, pr.number, issue, out["replies.json"], toAnswer.map((c) => c.id), token).catch((e) => {
          log(`replies: ${e.message.slice(0, 160)}`);
          return 0;
        });
    if (toAnswer.length) log(`${replied} of ${toAnswer.length} reviewer comment(s) answered`);
    // An exit file the pass wrote is read as ever; with the cap unenforceable the harness is not asked for one.
    // A provider's refusal is not asked again: the answer Blocks with it.
    const asked = rec.refusal ? { record: { exit: "blocked", reason: refusalReason(rec.refusal), questions: [] }, usage: [] } : unmetered && typeof io.files()["exit.json"] !== "string" ? { record: { exit: "blocked", reason: capReason(), questions: [] }, usage: [] } : await exitRecord({ text: io.files()["exit.json"], harness: inputs.harness, model: inputs.model, effort: inputs.effort, session, cwd: checkout, env: passEnv, eventsFile, deadlineAt, maxUsd: inputs.maxUsd, spentUsd: sumSpend(records), unmetered });
    records.push(...asked.usage);
    for (const r of asked.usage) mark(r);
    answerRecord = asked.record;
    // The question check may have turned QUESTION: items into assumptions: the PR body and plan comment follow pr.md and plan.md.
    if (asked.checked) {
      await io.collect();
      pr = await publish(pr);
    }
    // Read means applied: only a pass that finished and did not stop blocked records the decisions it was given.
    if (rec.ok && !outbox.failed && answerRecord.exit !== "blocked") {
      jobRead = decisionsRead(fed);
      await progress.decisionsRead(jobRead);
    }
    if (answerRecord.exit === "question") log(`answer pass raised a question: ${(answerRecord.questions[0] || answerRecord.reason || "").slice(0, 160)}`);
  }
  // No fix pass starts once a run left the cap unenforceable; the job Blocks below.
  const validation = answering && !unmetered && !outbox.failed && !heldQuestion && !answerRun?.refusal
    ? await validationLoop({ onPhase: progress, progress, checks: inputs.ciChecks.length ? { repo, issue, prNumber: pr.number, names: inputs.ciChecks, token: token.token, actionsToken: inputs.githubToken || token.token } : null, outbox, checkout, commands: inputs.validation, harness: inputs.harness, model: inputs.model, effort: inputs.effort, maxUsd: inputs.maxUsd, spentUsd: sumSpend(records), session, taskCard, env: passEnv, deadlineAt, eventsFile, label: "review-validation", io, triage: openTriage({ inputs, repo, issue, prNumber: pr.number, token: token.token, actionsToken: inputs.githubToken || token.token, progress }), drift })
    : { green: true, passes: 0, usage: [] };
  records.push(...validation.usage);
  passes += validation.passes;
  if (validation.usage.length) {
    if (!(await outbox.push())) log(`push refused: ${outbox.error}`);
    if (!outbox.failed) pr = await publish(pr);
  }
  // A validation fix pass that put back toolchain files and asked a Question (holdScope): its exit record is the answer's.
  if (validation.question) answerRecord = exitFromOut(io.files()) || answerRecord;
  await postNote(repo, issue, io.files()["note.md"], token).catch((e) => log(`note: ${e.message.slice(0, 120)}`));

  // Answered threads (and no-finding ones) are resolved so a ruleset that requires thread resolution
  // can merge; they stay visible on the PR. Not after a refused push: the answers never reached the branch.
  const resolvedThreads = outbox.failed
    ? 0
    : await resolveFactoryThreads(repo, pr.number, issue, token).catch((e) => {
        log(`threads: ${e.message.slice(0, 120)}`);
        return 0;
      });
  if (resolvedThreads) log(`resolved ${resolvedThreads} answered review thread(s)`);

  // The exit. A question is open only if the PR is still a draft now: the worker converts
  // to draft when it raises one, and a human's "mark ready" answers it.
  const after = await observe(repo, outbox, { branch, prNumber: pr.number }, token);
  pr = after.pr;
  const unaddressed = (await unaddressedReviewComments(repo, pr.number, reviewerLogin, { ...token, reviewIds: await factoryReviewIds() })).length;
  // The answer pass's own result counts: one that failed while applying maintainers' decisions Blocks even on green
  // validation (green proves the old code, not the change asked for); one that only answered findings is judged as
  // the worker's run is, where green validation outweighs a late harness error.
  const answerOk = !answerRun || answerRun.ok || (!answerQuestion && validation.green && inputs.validation.length > 0);
  // A PR that started conflicting during validation is not red: every other gate still decides (a Question, a Blocked
  // answer, unanswered findings); a delivered exit merges nothing and goes to the dispatcher's send-back, whose rebase
  // brings it back to review.
  const conflict = !!validation.conflict;
  const decision = decideExit({
    harness: validation.harness ?? (answerRun ? { ...answerRun, ok: answerOk } : { ok: true }),
    pr: { exists: true, draft: pr.draft, body: pr.body },
    commits: after.delta.count,
    validation: validation.died || validation.harness || validation.question || conflict ? undefined : { passes: validation.passes, green: validation.green, baseFailure: validation.baseFailure, notStarted: validation.notStarted, stuck: validation.stuck?.reason, stuckCause: validation.stuck?.cause, triageRefused: validation.triageRefused, scope: validation.scope, unchanged: validation.unchanged },
    protectedHits: protectedTouched(after.delta.files, protectedList),
    record: answerRecord,
    question: answerRecord ? answerRecord.exit === "question" : false,
    reviewUnaddressed: unaddressed,
    sessionCap: sessionCapNote(process.env.FACTORY_STAGE_SESSION_CAP),
    // Every push went through the outbox, which refuses plain blobs LFS should hold and media over the cap.
    pushRejected: outbox.failed ? outbox.error : "",
    lfsRefused: outbox.lfsRefused,
    lfsQuota: outbox.errorKind === "lfs-quota",
    handoverRefused: handover.refused(),
  });
  if (publishRefused && decision.exit !== "blocked") Object.assign(decision, { exit: "blocked", reason: publishRefused, cause: "work" });
  if (overBudget && decision.exit !== "blocked") Object.assign(decision, { exit: "blocked", reason: capReason(), cause: capCause() });
  // Stopped meanwhile (the watch's last read, or the issue read once more now): nothing of this exit is applied (no
  // merge, no ready mark, no label); the stop's end stands.
  await holdIfStopped();
  // The exit begins here (stop.mjs confirmRunning `commit`): a stop after this read ends nothing, and the dispatcher's
  // stopped pass tidies what this exit leaves; the merge pass reads the issue once more before any merge.
  await beforeExit?.(true);
  // The AI Gateway refused a relayed call for its own budget or credits: a Block names it first, not a cap of Factory's.
  if (decision.exit === "blocked") {
    decision.reason = relayReason(decision.reason);
    decision.cause = relayCause(decision.cause);
  }
  await dropLabel();
  // On Actions, a Question answered while this job ran (a writer's decision and a person's ready mark, both) is not put
  // back to draft (locally nothing runs an unlabelled ready PR, so the Question stands there). The PR stays ready and unlabelled: the review job the ready mark started runs next, and its answer pass
  // applies the answer (or, with nothing new since the Question, makes it a Question again). Either alone, or
  // unreadable comments, keep the Question.
  if (decision.exit === "question") {
    const answered = await answeredDuringJob(repo, { issue, prNumber: pr.number, self: await progress.self(), readAt, startedAt }, token, jobRead).catch((e) => {
      log(`the maintainers' comments could not be re-read before the Question exit: ${e.message.slice(0, 160)}`);
      return "";
    });
    if (answered) {
      log(`${answered}; not reverting it to a Question, the review the ready mark started applies it`);
      Object.assign(decision, { exit: "delivered", rerun: true, reason: `${answered}; the review the ready mark started applies it` });
    }
  }
  // A maintainer who commented while this job ran (after its read above) has not been heard: no merge yet. The review
  // runs again (the label re-applied), and its answer pass applies the comment. Unreadable comments Block.
  if (decision.exit === "delivered" && !decision.rerun && conflict) {
    decision.reason = `PR #${pr.number} conflicts with ${defaultBranch} after a sibling merged; the dispatcher sends it back for a rebase`;
    log(decision.reason);
  } else if (decision.exit === "delivered" && !decision.rerun) {
    try {
      const late = (await unreadNow(repo, { issue, prNumber: pr.number, self: await progress.self() }, token, jobRead)).unread;
      if (late.length) {
        log(`${late.length} maintainer decision(s) arrived during this review; not merging, the review runs again to apply them`);
        decision.rerun = true;
        decision.reason = `${late.length} maintainer comment(s) arrived during the review; the review runs again to apply them`;
        await addLabels(repo, pr.number, [REVIEW_LABEL], token).catch((e) => {
          decision.exit = "blocked";
          decision.cause = "factory";
          decision.reason = `${late.length} maintainer comment(s) arrived during the review and the review label could not be re-applied to run it again: ${e.message.slice(0, 120)}`;
        });
      }
    } catch (e) {
      decision.exit = "blocked";
      decision.cause = "factory";
      decision.reason = `the maintainers' comments could not be re-read before the merge: ${e.message.slice(0, 160)}`;
    }
  }
  let stoppedAtMerge = null;
  if (decision.exit === "delivered" && !decision.rerun && !conflict) {
    // A harness may have converted the PR to a draft (the task card keeps PRs drafts until Factory's pass); delivered means ready.
    if (pr.draft) await setDraft(repo, pr.number, false, token).catch((e) => log(`ready: ${e.message.slice(0, 120)}`));
    // The merge closes the issue only through a closing reference GitHub itself parsed; add one when it is missing (a
    // split part that leaves work for the next says `Refs #N` and closes nothing).
    const closes = splitPart ? null : await closingIssues(repo, pr.number, token).catch(() => null);
    if (closes && !closes.includes(issue)) {
      await rest(`repos/${repo.full}/pulls/${pr.number}`, { ...token, method: "PATCH", body: { body: `${pr.body || ""}\n\nCloses #${issue}\n` } }).catch((e) => log(`body: ${e.message.slice(0, 120)}`));
    }
    // The stop mergeReadyOne found: its own end replaces this exit.
    if (inputs.autoMerge) {
      // The head Factory validated and pushed is the one it merges; nothing armed rides a later push.
      // The merge closes the issue, which is no stop of a merged Objective: the watch ends here.
      watch?.stop();
      let recorded = false;
      try {
        await recordMergeable(repo, pr.number, issue, outbox.expected() || pr.head.sha, token);
        recorded = true;
        const report = {};
        const how = await mergeReadyOne(repo, { issue, prNumber: pr.number, queue: await hasMergeQueue(repo, token).catch(() => true), checkNames: inputs.ciChecks, report, actionsToken: inputs.githubToken || null, objectiveLabel: inputs.objectiveLabel }, token);
        log(`PR #${pr.number}: ${{ merged: "merged", queued: "in the merge queue", pending: "its required checks are still running; the dispatcher merges it once they are green", "re-review": "its head moved; the review runs again", unread: "a maintainer commented; the review runs again", held: "a person took it out of the merge queue; it stays out until they enqueue it again", stopped: "its Objective was stopped; nothing merges", conflict: `it conflicts with ${defaultBranch}; the dispatcher sends it back once for a rebase` }[how] || how}`);
        const why = mergeBlockReason(how, report);
        // A sibling merged first (#2647): not a Block. Unlabelled and In review, the dispatcher sends it back once to
        // rebase (dispatch.mjs, logic.mjs staleDecision), and a conflict after that rebase Blocks there.
        // Stopped since the stage's last read: nothing merged, and the stage ends as a stop does.
        if (how === "stopped") stoppedAtMerge = stopCause(await getIssue(repo, issue, token).catch(() => null), inputs.objectiveLabel) || "unlabeled";
        if (how === "conflict") decision.reason = `PR #${pr.number} conflicts with ${defaultBranch} after a sibling merged; the dispatcher sends it back for a rebase`;
        if (why) {
          decision.exit = "blocked";
          decision.cause = mergeBlockCause(how, report);
          decision.reason = why;
        }
      } catch (e) {
        log(`merge: ${String(e.stderr || e.message).slice(0, 300)}`);
        const code = Number.isInteger(e?.status) && e.status > 0 ? `HTTP ${e.status}` : e?.transport ? "network" : "error";
        // GitHub or the network failing for now, after the mergeable head is recorded: the PR stays delivered and the
        // dispatcher's merge pass (ticked as this stage ends) merges it. A transient error requeues; it never Blocks.
        if (recorded && transientError(e)) log(`PR #${pr.number}: the merge pass failed for now (${code}); the dispatcher merges it on its next tick`);
        else {
          decision.exit = "blocked";
          decision.cause = "factory";
          decision.reason = `the merge failed (${code}); the job log has GitHub's answer`;
        }
      }
    } else log(`auto_merge is false: PR #${pr.number} is ready for a human merge`);
  }
  if (stoppedAtMerge) {
    await dropLabel();
    await stoppedEnd({ cause: stoppedAtMerge, label: inputs.objectiveLabel, repo, issue, pr, finish, opts: token });
    return;
  }
  // Hosts the answer pass's sandbox denied: the backend names the operator's fix (local mode: FACTORY_LOCAL_DOMAINS).
  const fix = decision.exit === "blocked" && decision.deniedHosts ? backend().sandbox.deniedFix(decision.deniedHosts, process.env, inputs.harness) : null;
  await applyExit(repo, { issue, pr, exit: decision.exit, reason: decision.reason, detail: decision.exit === "blocked" ? validation.lastOutput : "", notify: inputs.notify, stage: "review", fix, cause: decision.cause }, token);
  await finish(decision.exit, decision.reason);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    process.stderr.write(`[factory] review failed: ${e.message}\n`);
    process.exit(1);
  });
}
