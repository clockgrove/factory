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
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { TokenKeeper } from "./lib/token-keeper.mjs";
import { AGENT_DIRS, PLUGIN_ROOT, defaultBranchOf, installCommand, installPlugin, sh } from "./lib/checkout.mjs";
import { credentialEnv, finalText, runHarness, scrubbedEnv } from "./lib/harness.mjs";
import { enableAutoMerge, getIssue, getPr, postReview, prDiff, removeLabel, repoOf, rest, setDraft } from "./lib/github.mjs";
import { log, parseArgs, resolveInputs, setOutput } from "./lib/inputs.mjs";
import { decideExit, diffLines, marker, parseFindings, protectedPaths, protectedTouched, snapComments } from "./lib/logic.mjs";
import { git } from "./lib/proc.mjs";
import {
  TASK_CARD_TEMPLATE,
  applyExit,
  botId,
  buildPrompt,
  configureGit,
  deadline,
  observe,
  push,
  questionRaised,
  remainingMs,
  unaddressedReviewComments,
  validationLoop,
  writeUsage,
} from "./lib/session.mjs";
import { REVIEW_LABEL } from "./worker.mjs";

/** The reviewer's prompt: the skill does the work; the JSON shape is what the job parses. */
export function reviewerPrompt({ issue, issueTitle, issueBody, prBody, diff, harness }) {
  const agentFile = `${AGENT_DIRS[harness]}/reviewer${harness === "codex" ? ".toml" : harness === "copilot" ? ".agent.md" : ".md"}`;
  return [
    `You are the Factory reviewer for pull request on issue #${issue}: ${issueTitle}. Act as the reviewer agent defined in ${agentFile} and follow the review-pr skill (in .claude/skills/review-pr and .agents/skills/review-pr) exactly. Read the repository as you need to.`,
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

  const finish = async (exit, reason) => {
    keeper.stop();
    const usage = writeUsage(usageDir, { harness: inputs.harness, model: inputs.reviewerModel, records, passes, exit, reason, credentialBasis: "see worker" });
    log(`review exit: ${exit}${reason ? ` (${reason})` : ""}; usd ${usage.usd ?? "unmetered"}`);
    setOutput("exit", exit);
    setOutput("reason", reason || "");
    setOutput("issue", String(issue));
  };

  if (pr.draft) {
    log(`PR #${pr.number} is a draft (question or blocked); the reviewer waits for a human to mark it ready`);
    await finish("skipped", "draft PR");
    return;
  }
  const alreadyReviewed = (await rest(`repos/${repo.full}/pulls/${pr.number}/reviews?per_page=100`, { ...token, paginate: true })).some((r) => (r.body || "").includes(marker(issue, "review")));
  if (alreadyReviewed) {
    log(`PR #${pr.number} already has Factory's one review pass; not repeating it`);
    await finish("skipped", "already reviewed");
    return;
  }

  // Checkout the branch, write the plugin in, set up.
  await git(checkout, ["fetch", "origin", branch, defaultBranch]);
  await git(checkout, ["checkout", "-B", branch, `origin/${branch}`]);
  const base = (await git(checkout, ["merge-base", `origin/${defaultBranch}`, "HEAD"])).stdout.trim();
  installPlugin(checkout, PLUGIN_ROOT);
  await configureGit(checkout, { appSlug: app.appSlug, botId: await botId(app.appSlug, keeper.token), protectedList, credentialHelper: keeper.credentialHelper() });
  const childBase = scrubbedEnv(process.env, { ...keeper.childEnv(), CI: "true" });
  for (const k of Object.keys(childBase)) if (childBase[k] === undefined) delete childBase[k];
  if (inputs.setup) {
    const s = await sh(checkout, inputs.setup, { env: childBase, timeoutMs: remainingMs(deadlineAt) });
    if (!s.ok) {
      await applyExit(repo, { issue, pr, exit: "blocked", reason: `setup failed before review: ${inputs.setup}`, notify: inputs.notify, stage: "review" }, token);
      await finish("blocked", "setup failed");
      return;
    }
  }
  const install = installCommand(checkout, inputs.install);
  if (install) await sh(checkout, install, { env: childBase, timeoutMs: remainingMs(deadlineAt) });

  // The reviewer: one call, comment-only, findings parsed from its last message.
  const issueData = await getIssue(repo, issue, token);
  const diff = await prDiff(repo, pr.number, token);
  const cred = await credentialEnv({ harness: inputs.harness, credential: inputs.credential, inputs });
  const harnessEnv = { ...childBase, ...cred.env, FACTORY_ISSUE: String(issue), FACTORY_BRANCH: branch };
  const reviewRec = await runHarness({
    harness: inputs.harness,
    model: inputs.reviewerModel,
    prompt: reviewerPrompt({ issue, issueTitle: issueData.title, issueBody: issueData.body, prBody: pr.body, diff, harness: inputs.harness }),
    maxUsd: inputs.maxUsd,
    agent: inputs.harness === "copilot" ? "reviewer" : undefined,
    cwd: checkout,
    env: harnessEnv,
    timeoutMs: Math.min(remainingMs(deadlineAt), 45 * 60_000),
    eventsFile,
    label: "review",
  });
  records.push(reviewRec);
  // The events file holds only the review run at this point, so its last message is the reviewer's.
  const findings = parseFindings(finalText(inputs.harness, readFileSync(eventsFile, "utf8")));
  let comments = snapComments(findings, diff);
  if (!comments.length) {
    const first = Object.entries(diffLines(diff)).find(([, v]) => v.first !== null);
    if (first) comments = [{ path: first[0], line: first[1].first, side: "RIGHT", body: reviewRec.ok ? "Factory reviewer: no findings; the pass ran and returned nothing line-tied." : `Factory reviewer: the reviewer call failed (${reviewRec.error || "unknown"}); no findings were produced.` }];
  }
  if (comments.length) {
    await postReview(repo, pr.number, { body: `${marker(issue, "review")}\nFactory reviewer: one comment-only pass, ${comments.length} comment(s).`, comments, commitId: pr.head.sha }, token);
    log(`posted review with ${comments.length} comment(s)`);
  }
  const reviewerLogin = app.appSlug ? `${app.appSlug}[bot]` : null;
  const toAnswer = await unaddressedReviewComments(repo, pr.number, reviewerLogin, token);

  // One worker pass to answer, then validation again.
  const taskCard = buildPrompt({
    templatePath: TASK_CARD_TEMPLATE(PLUGIN_ROOT),
    issue,
    issueTitle: issueData.title,
    issueBody: issueData.body,
    maxUsd: inputs.maxUsd,
    timeoutMinutes: inputs.timeoutMinutes,
    validation: inputs.validation,
    budgetCommand: inputs.budgetCommand,
    protectedList,
  });
  const session = { id: null, canResume: inputs.harness !== "copilot" };
  if (toAnswer.length) {
    const rec = await runHarness({
      harness: inputs.harness,
      model: inputs.model,
      prompt: answerPrompt({ taskCard, prNumber: pr.number, comments: toAnswer.map((c) => ({ id: c.id, path: c.path, line: c.line ?? c.original_line, body: c.body })) }),
      maxUsd: inputs.maxUsd,
      cwd: checkout,
      env: harnessEnv,
      timeoutMs: remainingMs(deadlineAt),
      eventsFile,
      label: "answer",
    });
    records.push(rec);
    if (rec.sessionId) session.id = rec.sessionId;
    await push(checkout, branch, harnessEnv);
  }
  const validation = await validationLoop({ checkout, commands: inputs.validation, harness: inputs.harness, model: inputs.model, maxUsd: inputs.maxUsd, session, taskCard, env: harnessEnv, deadlineAt, eventsFile, label: "review-validation" });
  records.push(...validation.usage);
  passes = validation.passes;
  if (validation.usage.length) await push(checkout, branch, harnessEnv);

  // The exit.
  const after = await observe(repo, checkout, { branch, base, prNumber: pr.number }, token);
  pr = after.pr;
  const unaddressed = (await unaddressedReviewComments(repo, pr.number, reviewerLogin, token)).length;
  const decision = decideExit({
    harness: validation.harness ?? { ok: true },
    pr: { exists: true, draft: pr.draft, body: pr.body },
    commits: after.delta.count,
    validation: { passes: validation.passes, green: validation.green },
    protectedHits: protectedTouched(after.delta.files, protectedList),
    planHasQuestion: await questionRaised(repo, { issue, pr }, token),
    reviewUnaddressed: unaddressed,
  });
  await removeLabel(repo, pr.number, REVIEW_LABEL, token);
  if (decision.exit === "delivered") {
    if (pr.draft) await setDraft(repo, pr.number, false, token);
    // The merge closes the issue only through a closing keyword; add one when the body lacks it.
    if (!new RegExp(`\\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\\s+#${issue}\\b`, "i").test(pr.body || "")) {
      await rest(`repos/${repo.full}/pulls/${pr.number}`, { ...token, method: "PATCH", body: { body: `${pr.body || ""}\n\nCloses #${issue}\n` } }).catch((e) => log(`body: ${e.message.slice(0, 120)}`));
    }
    if (inputs.autoMerge) {
      await enableAutoMerge(repo, pr.number, token);
      log(`auto-merge enabled on PR #${pr.number}; the merge queue takes it`);
    } else log(`auto_merge is false: PR #${pr.number} is ready for a human merge`);
    await applyExit(repo, { issue, pr, exit: "delivered", reason: "", notify: inputs.notify, stage: "review" }, token);
  } else {
    await applyExit(repo, { issue, pr, exit: decision.exit, reason: decision.reason, notify: inputs.notify, stage: "review" }, token);
  }
  await finish(decision.exit, decision.reason);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    process.stderr.write(`[factory] review failed: ${e.message}\n`);
    process.exit(1);
  });
}
