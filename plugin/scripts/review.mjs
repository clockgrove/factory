#!/usr/bin/env node
// Factory review job: one comment-only reviewer pass, one worker pass to answer it,
// then the merge queue.
//   node scripts/review.mjs --repo OWNER/NAME --pr N [--checkout DIR] [--usage-dir DIR]
// With the App token: fetch the PR diff, body and the issue body; run the reviewer
// harness once with the review-pr skill and the reviewer agent definition (model
// pinned there); parse its findings and post them as one PR review with line
// comments (REST, event COMMENT); run one worker pass with the comments as the
// prompt (a fresh session: the worker job's session does not survive the runner);
// run the validation commands again; then, if auto_merge, `gh pr merge --auto
// --squash` as the App so the merge queue runs. Unaddressed findings or red
// validation after the pass is the blocked exit.
import { pathToFileURL } from "node:url";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { TokenKeeper } from "./lib/token-keeper.mjs";
import { AGENT_DIRS, PLUGIN_ROOT, branchIdentity, defaultBranchOf, installCommand, installPlugin, runnerFileEnv, sh } from "./lib/checkout.mjs";
import { credentialEnv, harnessVersion, runHarness, scrubbedEnv } from "./lib/harness.mjs";
import { closingIssues, enableAutoMerge, getIssue, getPr, postReview, prDiff, removeLabel, repoOf, resolveFactoryThreads, rest, setDraft } from "./lib/github.mjs";
import { eventAction, log, parseArgs, resolveInputs, setOutput } from "./lib/inputs.mjs";
import { PLACEHOLDER_MARKER, REVIEW_LABEL, costByPhase, decideExit, diffLines, marker, parseFindings, protectedPaths, protectedTouched, snapComments, sumSpend } from "./lib/logic.mjs";
import { git } from "./lib/proc.mjs";
import {
  TASK_CARD_TEMPLATE,
  applyExit,
  gitIdentity,
  buildPrompt,
  configureGit,
  deadline,
  exitRecord,
  isValidated,
  liveActivity,
  maskFile,
  restoreTranscript,
  saveTranscript,
  crashed,
  observe,
  postValidated,
  progressReporter,
  push,
  remainingMs,
  unaddressedReviewComments,
  validationLoop,
  writeUsage,
} from "./lib/session.mjs";

/**
 * The reviewer's prompt: the skill does the work; the JSON shape is what the job
 * parses. Claude and Copilot run as the pinned reviewer agent (--agent); Codex has
 * no such flag, so the prompt names the definition file.
 */
export function reviewerPrompt({ issue, issueTitle, issueBody, prBody, diff, harness }) {
  const agentFile = `${AGENT_DIRS[harness]}/reviewer${harness === "codex" ? ".toml" : harness === "copilot" ? ".agent.md" : ".md"}`;
  return [
    `You are the Factory reviewer for the pull request on issue #${issue}: ${issueTitle}.${harness === "codex" ? ` Act as the reviewer agent defined in ${agentFile} and` : ""} Follow the review-pr skill (in .claude/skills/review-pr and .agents/skills/review-pr) exactly. Read the repository as you need to.`,
    "Do NOT post anything to GitHub yourself: the job posts your findings. Your final message must be only a JSON object of this shape, with no prose around it:",
    '```json\n{"comments": [{"path": "src/file.ts", "line": 42, "body": "acceptance 2: ..."}]}\n```',
    "`line` is a line number on the new side of the diff. If you found nothing, return one comment on the first changed line saying so and naming the acceptance entries you checked.",
    "",
    "## Issue",
    issueBody || "(no body)",
    "",
    "## PR body",
    prBody || "(no body)",
    "",
    "## Diff",
    "```diff",
    diff,
    "```",
  ].join("\n");
}

/** The worker's prompt for the one pass that answers the review. */
export function answerPrompt({ taskCard, prNumber, comments }) {
  const list = comments.map((c) => `- ${c.path}:${c.line} (comment id ${c.id}): ${c.body}`).join("\n");
  return [
    taskCard.trimEnd(),
    "",
    "---",
    "",
    `The reviewer has posted its one pass on PR #${prNumber}. Load the deliver-pr skill's "Reviewer comments" section and handle each comment once: make the change and reply with the commit, or reply with a rebuttal naming the acceptance entry or repository rule. Reply through \`gh api repos/{owner}/{repo}/pulls/${prNumber}/comments/<id>/replies\` (GraphQL may be unavailable). Then rebase on the default branch, run the validation commands, push, and stop.`,
    "",
    "## Reviewer comments",
    list || "(none)",
  ].join("\n");
}

async function main() {
  const startedAt = Date.now();
  const args = parseArgs(process.argv.slice(2));
  const inputs = resolveInputs({ args });
  if (!inputs.repo) throw new Error("--repo OWNER/NAME is required");
  if (!inputs.pr) throw new Error("--pr N is required");
  const repo = repoOf(inputs.repo);
  const checkout = resolve(args.checkout || process.env.GITHUB_WORKSPACE || process.cwd());
  const deadlineAt = deadline(startedAt, inputs.timeoutMinutes);
  const protectedList = protectedPaths(inputs.protectedAdditions);
  const records = [];
  let passes = 0;

  const keeper = await new TokenKeeper({ dir: join(checkout, "..", `factory-auth-review-${inputs.pr}`), appId: inputs.appId, privateKey: inputs.appPrivateKey, owner: repo.owner, repo: repo.name, fixedToken: inputs.appToken || null }).start();
  const token = { token: keeper.getter };
  const app = keeper.app;

  let pr = await getPr(repo, inputs.pr, token);
  const m = /^factory\/(\d+)$/.exec(pr.head?.ref || "");
  if (!m) {
    log(`PR #${pr.number} is not on a factory/<issue> branch; nothing to review`);
    setOutput("exit", "skipped");
    return;
  }
  const issue = Number(m[1]);
  const usageDir = resolve(args.usage_dir || process.env.FACTORY_USAGE_DIR || join(checkout, "..", `factory-usage-${issue}-review`));
  mkdirSync(usageDir, { recursive: true });
  const eventsFile = join(usageDir, "events.jsonl");
  const branch = pr.head.ref;
  const defaultBranch = pr.base?.ref || (await defaultBranchOf(checkout));

  let cred = { env: {} };
  const progress = progressReporter(repo, issue, token, { stage: "review" });
  if (pr.html_url) progress.link(`PR #${pr.number}`, pr.html_url);
  const finish = async (exit, reason) => {
    keeper.stop();
    const masked = maskFile(eventsFile, [...Object.values(cred.env), ...keeper.issued, inputs.githubToken, inputs.appPrivateKey]);
    if (masked) log(`masked ${masked} secret occurrence(s) in events.jsonl`);
    const usage = writeUsage(usageDir, { harness: inputs.harness, model: inputs.reviewerModel, records, passes, exit, reason, credentialBasis: "see worker", harnessVersion: harnessVersion(inputs.harness), session: saveTranscript({ harness: inputs.harness, sessionId: session.id, usageDir, checkout, secrets: [...Object.values(cred.env), ...keeper.issued, inputs.githubToken, inputs.appPrivateKey] }) });
    log(`review exit: ${exit}${reason ? ` (${reason})` : ""}; usd ${usage.usd ?? "unmetered"}`);
    await progress(`exit: ${exit}${reason ? ` (${reason})` : ""}; usd ${usage.usd ?? "unmetered"}${costByPhase(records)}`);
    setOutput("exit", exit);
    setOutput("reason", reason || "");
    setOutput("issue", String(issue));
  };
  // The trigger label comes off on every exit, so a re-label is always one more pass.
  const dropLabel = () => removeLabel(repo, pr.number, REVIEW_LABEL, token).catch((e) => log(`review label: ${e.message.slice(0, 120)}`));

  try {
    await run();
  } catch (e) {
    log(`review crashed: ${e.message.slice(0, 300)}`);
    const reason = `review crashed: ${e.message.slice(0, 200)}`;
    await dropLabel();
    await applyExit(repo, { issue, pr, exit: "blocked", reason, notify: inputs.notify, stage: "crash" }, token).catch((x) => log(`exit after crash failed: ${x.message.slice(0, 120)}`));
    await finish("blocked", reason);
    throw e;
  }

  async function run() {
  if (pr.draft) {
    log(`PR #${pr.number} is a draft (question or blocked); the reviewer waits for a human to mark it ready`);
    await dropLabel();
    await finish("skipped", "draft PR");
    return;
  }
  // The worker marks the PR ready and then applies factory:review after its validation pass; the
  // ready_for_review event is that same transition seen first, never a review cue. A human who
  // answers a Question re-applies factory:objective (the worker reruns and labels); a human who
  // wants a review pass applies factory:review.
  if (eventAction() === "ready_for_review") {
    log(`PR #${pr.number} marked ready; the review runs on the factory:review label, not on this event`);
    await finish("skipped", "ready_for_review is not a review cue");
    return;
  }
  // One review pass per PR. A PR that already has it (a Question draft a human marked ready, or a
  // rebased PR relabelled by the worker) skips the reviewer and the answer pass but still gets
  // validation, the exit and auto-merge: the merge path is this job's, not the reviewer's.
  const alreadyReviewed = (await rest(`repos/${repo.full}/pulls/${pr.number}/reviews?per_page=100`, { ...token, paginate: true })).some((r) => (r.body || "").includes(marker(issue, "review")));
  if (alreadyReviewed) log(`PR #${pr.number} already has Factory's one review pass; validating and merging without a second pass`);

  // Git identity and the credential helper first (the fetch needs the App's token on a runner), then the branch and the plugin.
  await configureGit(checkout, { ...(await gitIdentity(app, keeper.token)), protectedList, credentialHelper: keeper.credentialHelper() });
  await git(checkout, ["fetch", "origin", branch, defaultBranch]);
  await git(checkout, ["checkout", "-B", branch, `origin/${branch}`]);
  const base = (await git(checkout, ["merge-base", `origin/${defaultBranch}`, "HEAD"])).stdout.trim();
  installPlugin(checkout, PLUGIN_ROOT, { harness: inputs.harness, models: { subagent: inputs.subagentModel, reviewer: inputs.reviewerModel } });
  const childBase = scrubbedEnv(process.env, { ...keeper.childEnv(), CI: "true", ...branchIdentity(branch) });
  if (inputs.setup) {
    await progress("setup");
    const s = await sh(checkout, inputs.setup, { env: childBase, timeoutMs: remainingMs(deadlineAt) });
    if (!s.ok) {
      await dropLabel();
      await applyExit(repo, { issue, pr, exit: "blocked", reason: `setup failed before review: ${inputs.setup}`, notify: inputs.notify, stage: "review" }, token);
      await finish("blocked", "setup failed");
      return;
    }
    Object.assign(childBase, runnerFileEnv(childBase)); // PATH and env the setup wrote for the steps after it
  }
  const install = installCommand(checkout, inputs.install);
  if (install) {
    await progress("install");
    await sh(checkout, install, { env: childBase, timeoutMs: remainingMs(deadlineAt) });
  }

  const issueData = await getIssue(repo, issue, token);
  cred = await credentialEnv({ harness: inputs.harness, credential: inputs.credential, inputs });
  const exitFile = join(usageDir, "exit.json");
  rmSync(exitFile, { force: true });
  const harnessEnv = { ...childBase, ...cred.env, FACTORY_ISSUE: String(issue), FACTORY_BRANCH: branch, FACTORY_EXIT_FILE: exitFile, ...(inputs.harness === "claude" && inputs.compactionWindow ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: inputs.compactionWindow } : {}) };
  const taskCard = buildPrompt({
    templatePath: TASK_CARD_TEMPLATE(PLUGIN_ROOT),
    issue,
    issueTitle: issueData.title,
    issueBody: issueData.body,
    maxUsd: inputs.maxUsd,
    timeoutMinutes: inputs.timeoutMinutes,
    validation: inputs.validation,
    ciChecks: inputs.ciChecks,
    budgetCommand: inputs.budgetCommand,
    protectedList,
  });
  const session = { id: null, canResume: true };
  // Resume policy: under fix-passes the worker's saved session carries this job's fix and answer
  // passes; the reviewer always runs in its own fresh session.
  let restored = null;
  if (inputs.harness === "claude" && inputs.resumePolicy === "fix-passes") {
    restored = await restoreTranscript({ repo, issue, token: inputs.githubToken, checkout, workDir: join(usageDir, "..") });
    if (restored.id) session.id = restored.id;
  }
  if (restored) await progress(`re-entry: ${restored.id ? `resumed session ${restored.id.slice(0, 8)} from ${restored.from}` : `fresh (${restored.reason})`}`);

  // The reviewer runs after validation passes (PLAN.md): a head the worker job validated
  // carries the marker; a head a human pushed or marked ready does not, so Factory's own
  // pass runs first and a red result is Blocked before any review.
  if (!(await isValidated(repo, pr.number, issue, pr.head.sha, token))) {
    log(`head ${pr.head.sha.slice(0, 7)} has no validation marker; running Factory's validation before the review`);
    const pre = await validationLoop({ onPhase: progress, progress, checks: inputs.ciChecks.length ? { repo, prNumber: pr.number, names: inputs.ciChecks, token: token.token } : null, push: () => push(checkout, branch, childBase), checkout, commands: inputs.validation, harness: inputs.harness, model: inputs.model, effort: inputs.effort, maxUsd: inputs.maxUsd, spentUsd: 0, session, taskCard, env: harnessEnv, deadlineAt, eventsFile, label: "pre-review-validation" });
    records.push(...pre.usage);
    passes = pre.passes;
    if (pre.usage.length) await push(checkout, branch, childBase);
    if (!pre.green) {
      const d = decideExit({ harness: pre.harness ?? { ok: true }, pr: { exists: true, draft: false, body: "" }, commits: 1, validation: pre.died || pre.harness ? undefined : { passes: pre.passes, green: false } });
      await dropLabel();
      await applyExit(repo, { issue, pr, exit: "blocked", reason: d.reason || "validation red before review", detail: pre.lastOutput, notify: inputs.notify, stage: "review" }, token);
      await finish("blocked", d.reason || "validation red before review");
      return;
    }
    pr = await getPr(repo, pr.number, token);
    await postValidated(repo, pr.number, issue, pr.head.sha, token);
  }

  // The reviewer: one call, comment-only, findings parsed from its last message.
  const diff = await prDiff(repo, pr.number, token);
  if (!alreadyReviewed) await progress(`reviewer ${inputs.reviewerModel || inputs.harness}`);
  const reviewLive = alreadyReviewed ? null : liveActivity(progress, { harness: inputs.harness, model: inputs.reviewerModel });
  const reviewRec = alreadyReviewed ? { ok: true, finalText: "", usd: null, tokens: { input: null, output: null, cached: null }, basis: "no reviewer run: already reviewed" } : await runHarness({
    harness: inputs.harness,
    model: inputs.reviewerModel,
    prompt: reviewerPrompt({ issue, issueTitle: issueData.title, issueBody: issueData.body, prBody: pr.body, diff, harness: inputs.harness }),
    maxUsd: Math.max(0, inputs.maxUsd - sumSpend(records)),
    agent: inputs.harness === "codex" ? undefined : "reviewer",
    cwd: checkout,
    env: harnessEnv,
    timeoutMs: Math.min(remainingMs(deadlineAt), 45 * 60_000),
    eventsFile,
    label: "review",
    onLine: reviewLive?.onLine,
  });
  reviewLive?.finish();
  // Fable's quota can run out mid-day: a reviewer call that failed (non-zero exit, no result) reruns once on the
  // fallback model (Opus 5.5 at xhigh effort) rather than posting "the reviewer call failed". The harness
  // reports no error code for quota, so any failure of the call is the cue; a second failure is posted.
  let reviewRecord = reviewRec;
  if (!alreadyReviewed && !reviewRec.ok && inputs.reviewerFallback) {
    log(`reviewer on ${inputs.reviewerModel} failed (exit ${reviewRec.exitCode ?? reviewRec.signal ?? "?"}); falling back to ${inputs.reviewerFallback.model} at ${inputs.reviewerFallback.effort}`);
    records.push(reviewRec);
    reviewRecord = await runHarness({
      harness: inputs.harness,
      model: inputs.reviewerFallback.model,
      effort: inputs.reviewerFallback.effort,
      prompt: reviewerPrompt({ issue, issueTitle: issueData.title, issueBody: issueData.body, prBody: pr.body, diff, harness: inputs.harness }),
      maxUsd: Math.max(0, inputs.maxUsd - sumSpend(records)),
      agent: inputs.harness === "codex" ? undefined : "reviewer",
      cwd: checkout,
      env: harnessEnv,
      timeoutMs: Math.min(remainingMs(deadlineAt), 45 * 60_000),
      eventsFile,
      label: "review-fallback",
    });
  }
  if (!alreadyReviewed) records.push(reviewRecord);
  const findings = parseFindings(reviewRecord.finalText || "");
  let comments = alreadyReviewed ? [] : snapComments(findings, diff);
  let placeholder = alreadyReviewed;
  if (!comments.length && !alreadyReviewed) {
    const first = Object.entries(diffLines(diff)).find(([, v]) => v.first !== null);
    placeholder = !!first;
    if (first) comments = [{ path: first[0], line: first[1].first, side: "RIGHT", body: reviewRecord.ok ? `${PLACEHOLDER_MARKER}\nFactory reviewer: no findings; the pass ran and returned nothing line-tied.` : `${PLACEHOLDER_MARKER}\nFactory reviewer: the reviewer call failed (${reviewRecord.error || "unknown"}); no findings were produced.` }];
  }
  if (comments.length) {
    await postReview(repo, pr.number, { body: `${marker(issue, "review")}\nFactory reviewer: one comment-only pass, ${comments.length} comment(s).`, comments, commitId: pr.head.sha }, token);
    log(`posted review with ${comments.length} comment(s)${placeholder ? " (placeholder: nothing to answer)" : ""}`);
  }
  const reviewerLogin = app.appSlug ? `${app.appSlug}[bot]` : null;
  // A pass with nothing to answer (the reviewer's JSON had no comments: Factory's placeholder went up) skips the worker pass.
  const toAnswer = placeholder ? [] : await unaddressedReviewComments(repo, pr.number, reviewerLogin, token);
  if (toAnswer.length) await progress(`answer pass: ${toAnswer.length} comment(s)`);

  // One worker pass to answer, then validation again. Its exit record (JSON it writes, or answers
  // with) says whether it raised a question; the PR's draft state does not.
  let answerRecord = null;
  if (toAnswer.length) {
    const answerLive = liveActivity(progress, { harness: inputs.harness, model: inputs.model });
    const resumeAnswer = inputs.resumePolicy === "fix-passes" && session.id ? session.id : null;
    const answerArgs = (resume) => ({
      onLine: answerLive.onLine,
      harness: inputs.harness,
      model: inputs.model,
      resume,
      prompt: answerPrompt({ taskCard: resume ? "" : taskCard, prNumber: pr.number, comments: toAnswer.map((c) => ({ id: c.id, path: c.path, line: c.line ?? c.original_line, body: c.body })) }),
      maxUsd: Math.max(0, inputs.maxUsd - sumSpend(records)),
      cwd: checkout,
      env: harnessEnv,
      timeoutMs: remainingMs(deadlineAt),
      eventsFile,
      label: "answer",
    });
    let rec = await runHarness(answerArgs(resumeAnswer));
    // A resumed session the CLI could not continue falls back to a fresh answer pass with the full card.
    if (resumeAnswer && crashed(rec)) {
      records.push(rec);
      log(`resumed session ${resumeAnswer.slice(0, 8)} failed (${rec.error}); answering fresh`);
      await progress("re-entry: resume failed; answering fresh");
      session.id = null;
      rec = await runHarness(answerArgs(null));
    }
    answerLive.finish();
    records.push(rec);
    if (rec.sessionId) session.id = rec.sessionId;
    await push(checkout, branch, childBase);
    const asked = await exitRecord({ file: exitFile, harness: inputs.harness, model: inputs.model, effort: inputs.effort, session, cwd: checkout, env: harnessEnv, eventsFile, deadlineAt, maxUsd: inputs.maxUsd, spentUsd: sumSpend(records) });
    records.push(...asked.usage);
    answerRecord = asked.record;
    if (answerRecord.exit === "question") log(`answer pass raised a question: ${(answerRecord.questions[0] || answerRecord.reason || "").slice(0, 160)}`);
  }
  const validation = toAnswer.length
    ? await validationLoop({ onPhase: progress, progress, checks: inputs.ciChecks.length ? { repo, prNumber: pr.number, names: inputs.ciChecks, token: token.token } : null, push: () => push(checkout, branch, childBase), checkout, commands: inputs.validation, harness: inputs.harness, model: inputs.model, effort: inputs.effort, maxUsd: inputs.maxUsd, spentUsd: sumSpend(records), session, taskCard, env: harnessEnv, deadlineAt, eventsFile, label: "review-validation" })
    : { green: true, passes: 0, usage: [] };
  records.push(...validation.usage);
  passes += validation.passes;
  if (validation.usage.length) await push(checkout, branch, childBase);

  // Answered threads (and no-finding ones) are resolved so a ruleset that requires thread resolution
  // can merge; they stay visible on the PR.
  const resolvedThreads = await resolveFactoryThreads(repo, pr.number, issue, token).catch((e) => {
    log(`threads: ${e.message.slice(0, 120)}`);
    return 0;
  });
  if (resolvedThreads) log(`resolved ${resolvedThreads} answered review thread(s)`);

  // The exit. A question is open only if the PR is still a draft now: the worker converts
  // to draft when it raises one, and a human's "mark ready" answers it.
  const after = await observe(repo, checkout, { branch, base, defaultBranch, prNumber: pr.number }, token);
  pr = after.pr;
  const unaddressed = (await unaddressedReviewComments(repo, pr.number, reviewerLogin, token)).length;
  const decision = decideExit({
    harness: validation.harness ?? { ok: true },
    pr: { exists: true, draft: pr.draft, body: pr.body },
    commits: after.delta.count,
    validation: validation.died || validation.harness ? undefined : { passes: validation.passes, green: validation.green },
    protectedHits: protectedTouched(after.delta.files, protectedList),
    record: answerRecord,
    question: answerRecord ? answerRecord.exit === "question" : false,
    reviewUnaddressed: unaddressed,
  });
  await dropLabel();
  if (decision.exit === "delivered") {
    // A harness may have converted the PR to a draft (the task card keeps PRs drafts until Factory's pass); delivered means ready.
    if (pr.draft) await setDraft(repo, pr.number, false, token).catch((e) => log(`ready: ${e.message.slice(0, 120)}`));
    // The merge closes the issue only through a closing reference GitHub itself parsed; add one when it is missing.
    const closes = await closingIssues(repo, pr.number, token).catch(() => null);
    if (closes && !closes.includes(issue)) {
      await rest(`repos/${repo.full}/pulls/${pr.number}`, { ...token, method: "PATCH", body: { body: `${pr.body || ""}\n\nCloses #${issue}\n` } }).catch((e) => log(`body: ${e.message.slice(0, 120)}`));
    }
    if (inputs.autoMerge) {
      try {
        const how = await enableAutoMerge(repo, pr.number, token);
        log(how === "auto" ? `auto-merge enabled on PR #${pr.number}; the merge queue takes it` : `PR #${pr.number} was already mergeable; merge requested directly`);
      } catch (e) {
        decision.exit = "blocked";
        decision.reason = `auto-merge could not be enabled: ${String(e.stderr || e.message).slice(0, 160)}`;
      }
    } else log(`auto_merge is false: PR #${pr.number} is ready for a human merge`);
  }
  await applyExit(repo, { issue, pr, exit: decision.exit, reason: decision.reason, detail: decision.exit === "blocked" ? validation.lastOutput : "", notify: inputs.notify, stage: "review" }, token);
  await finish(decision.exit, decision.reason);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    process.stderr.write(`[factory] review failed: ${e.message}\n`);
    process.exit(1);
  });
}
