#!/usr/bin/env node
// Factory worker job: one Objective, one branch, one PR.
//   node scripts/worker.mjs --repo OWNER/NAME --issue N [--checkout DIR] [--usage-dir DIR]
// Steps: doctor's job checks; checkout factory/<issue> from the default branch;
// write the plugin's skills and agent definitions into the checkout (git-excluded);
// setup and offline install; render the task card and launch the harness headless
// under a wall clock with the App token as GH_TOKEN; make sure a PR exists for the
// branch; run the repository's validation as Factory's own pass (two at most,
// failures sent back to the same harness); decide the exit (delivered, question,
// blocked); move the card, set the label, draft/comment/request as the exit says;
// write usage/events.jsonl and usage/result.json for the artifact.
import { pathToFileURL } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { TokenKeeper } from "./lib/token-keeper.mjs";
import { PLUGIN_ROOT, defaultBranchOf, installCommand, installPlugin, prepareBranch, sh } from "./lib/checkout.mjs";
import { credentialEnv, runHarness, scrubbedEnv } from "./lib/harness.mjs";
import { addLabels, getIssue, getRepo, repoOf, setDraft } from "./lib/github.mjs";
import { log, parseArgs, resolveInputs, setOutput } from "./lib/inputs.mjs";
import { REVIEW_LABEL, decideExit, protectedPaths, protectedTouched, sumSpend } from "./lib/logic.mjs";
import {
  TASK_CARD_TEMPLATE,
  applyExit,
  gitIdentity,
  buildPrompt,
  configureGit,
  crashed,
  deadline,
  ensurePr,
  lastMessage,
  markRunning,
  maskFile,
  observe,
  postValidated,
  push,
  questionRaised,
  remainingMs,
  validationLoop,
  writeUsage,
} from "./lib/session.mjs";
import { jobChecks } from "./doctor.mjs";

async function main() {
  const startedAt = Date.now();
  const args = parseArgs(process.argv.slice(2));
  const inputs = resolveInputs({ args });
  if (!inputs.repo) throw new Error("--repo OWNER/NAME (or GITHUB_REPOSITORY) is required");
  if (!inputs.issue) throw new Error("--issue N is required");
  const repo = repoOf(inputs.repo);
  const issue = inputs.issue;
  const checkout = resolve(args.checkout || process.env.GITHUB_WORKSPACE || process.cwd());
  const usageDir = resolve(args.usage_dir || process.env.FACTORY_USAGE_DIR || join(checkout, "..", `factory-usage-${issue}`));
  mkdirSync(usageDir, { recursive: true });
  const eventsFile = join(usageDir, "events.jsonl");
  const deadlineAt = deadline(startedAt, inputs.timeoutMinutes);
  const protectedList = protectedPaths(inputs.protectedAdditions);
  const records = [];
  let passes = 0;
  let pr = null;
  let credentialBasis = "none";
  let cred = { env: {} };

  // The App token: every write goes through it. The keeper re-mints it during the
  // job (an installation token lives an hour; a job may run six) and the children
  // read it from a file, so a six-hour harness session never holds a stale token.
  const keeper = await new TokenKeeper({ dir: join(usageDir, "..", `factory-auth-${issue}`), appId: inputs.appId, privateKey: inputs.appPrivateKey, owner: repo.owner, repo: repo.name, fixedToken: inputs.appToken || null }).start();
  const token = { token: keeper.getter };
  const app = keeper.app;

  const finish = async (exit, reason) => {
    keeper.stop();
    // The raw harness stream is uploaded for 90 days: every secret this job held is masked in it first.
    const masked = maskFile(eventsFile, [...Object.values(cred.env), ...keeper.issued, inputs.githubToken, inputs.appPrivateKey]);
    if (masked) log(`masked ${masked} secret occurrence(s) in events.jsonl`);
    const usage = writeUsage(usageDir, { harness: inputs.harness, model: inputs.model, records, passes, exit, reason, credentialBasis });
    log(`exit: ${exit}${reason ? ` (${reason})` : ""}; usd ${usage.usd ?? "unmetered"}; basis ${usage.basis}`);
    setOutput("exit", exit);
    setOutput("reason", reason || "");
    setOutput("pr", pr ? String(pr.number) : "");
    setOutput("usd", usage.usd === null ? "" : String(usage.usd));
    if (process.env.GITHUB_STEP_SUMMARY) {
      const { appendFileSync } = await import("node:fs");
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Factory #${issue}: ${exit}\n\n${reason || ""}\n\nPR: ${pr ? `#${pr.number}` : "none"} · USD: ${usage.usd ?? "unmetered"} (${usage.basis}) · passes: ${passes}\n`);
    }
  };

  // Any uncaught failure from here on still applies an exit: an issue left Running
  // forever holds a max_concurrent slot and never reaches the Blocked column.
  try {
    await run();
  } catch (e) {
    log(`worker crashed: ${e.message.slice(0, 300)}`);
    const reason = `worker crashed: ${e.message.slice(0, 200)}`;
    await applyExit(repo, { issue, pr, exit: "blocked", reason, notify: inputs.notify, stage: "crash" }, token).catch((x) => log(`exit after crash failed: ${x.message.slice(0, 120)}`));
    await finish("blocked", reason);
    throw e;
  }

  async function run() {
  // 1. Doctor's job checks: a misconfigured repository Blocks with one line, not a run.
  const checks = await jobChecks({ inputs, repo, token: keeper.token, app, checkout });
  const failed = checks.filter((c) => c.status === "FAIL");
  for (const c of checks) log(`${c.status} ${c.name}${c.detail ? `: ${c.detail}` : ""}${c.fix && c.status !== "PASS" ? ` — fix: ${c.fix}` : ""}`);
  if (failed.length) {
    const reason = `doctor: ${failed.map((c) => `${c.name} (${c.fix || c.detail})`).join("; ")}`;
    await applyExit(repo, { issue, pr: null, exit: "blocked", reason, notify: inputs.notify, stage: "doctor" }, token);
    await finish("blocked", reason);
    return;
  }

  // 2. The issue.
  const issueData = await getIssue(repo, issue, token);
  const labels = (issueData.labels || []).map((l) => l.name);
  if (issueData.state !== "open" || !labels.includes(inputs.objectiveLabel)) {
    log(`#${issue} is not an open ${inputs.objectiveLabel} issue; nothing to do`);
    await finish("skipped", `not an open ${inputs.objectiveLabel} issue`);
    return;
  }

  // 3. Branch, plugin, git identity.
  const repoData = await getRepo(repo, token);
  const defaultBranch = repoData.default_branch || (await defaultBranchOf(checkout));
  // Git identity and the credential helper first: on a runner (persist-credentials: false) the
  // very first fetch already needs the App's token.
  await configureGit(checkout, { ...(await gitIdentity(app, keeper.token)), protectedList, credentialHelper: keeper.credentialHelper() });
  const { branch, base, resumed } = await prepareBranch(checkout, { issue, defaultBranch });
  log(`branch ${branch} from ${defaultBranch}@${base.slice(0, 7)}${resumed ? " (existing branch resumed)" : ""}`);
  const written = installPlugin(checkout, PLUGIN_ROOT, { harness: inputs.harness, models: { subagent: inputs.subagentModel, reviewer: inputs.reviewerModel } });
  log(`plugin written into the checkout: ${written.length} path(s), git-excluded`);
  await markRunning(repo, issue, token);

  // 4. setup and offline install: the model secrets never reach these.
  // Children (setup, install, the harness) act as the App through gh's hosts.yml and the
  // git credential helper, both re-written by the keeper; no token sits in their env.
  const childBase = scrubbedEnv(process.env, { ...keeper.childEnv(), CI: "true" });
  for (const k of Object.keys(childBase)) if (childBase[k] === undefined) delete childBase[k];
  if (inputs.setup) {
    log(`setup: ${inputs.setup}`);
    const s = await sh(checkout, inputs.setup, { env: childBase, timeoutMs: remainingMs(deadlineAt) });
    if (!s.ok) {
      const reason = `setup failed: ${inputs.setup} exited ${s.timedOut ? "by timeout" : s.code}`;
      await applyExit(repo, { issue, pr: null, exit: "blocked", reason, notify: inputs.notify, stage: "setup" }, token);
      await finish("blocked", reason);
      return;
    }
  }
  const install = installCommand(checkout, inputs.install);
  if (install) {
    log(`install: ${install}`);
    const i = await sh(checkout, install, { env: childBase, timeoutMs: remainingMs(deadlineAt) });
    if (!i.ok) {
      const reason = `offline install failed: ${install}`;
      await applyExit(repo, { issue, pr: null, exit: "blocked", reason, notify: inputs.notify, stage: "install" }, token);
      await finish("blocked", reason);
      return;
    }
  }

  // 5. The prompt and the harness.
  cred = await credentialEnv({ harness: inputs.harness, credential: inputs.credential, inputs });
  credentialBasis = cred.basis;
  const harnessEnv = { ...childBase, ...cred.env, FACTORY_ISSUE: String(issue), FACTORY_BRANCH: branch };
  const prompt = buildPrompt({
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
  writeFileSync(join(usageDir, "task-card.md"), prompt.split("\n---\n")[0]);
  const session = { id: null, canResume: true };
  const budgetLeft = () => (inputs.maxUsd > 0 ? Math.max(0, inputs.maxUsd - sumSpend(records)) : 0);
  let died = 0;
  let rec = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    log(`harness ${inputs.harness}${inputs.model ? ` (${inputs.model})` : ""}, attempt ${attempt}, wall clock ${Math.round(remainingMs(deadlineAt) / 60000)} min, budget $${inputs.maxUsd}`);
    rec = await runHarness({
      harness: inputs.harness,
      model: inputs.model,
      prompt: attempt === 1 || !session.id ? prompt : "Your previous process died. Continue the Objective from where the branch and the plan comment stand; do not redo finished items.",
      maxUsd: attempt === 1 ? inputs.maxUsd : budgetLeft(),
      resume: attempt > 1 && session.canResume ? session.id : null,
      cwd: checkout,
      env: harnessEnv,
      timeoutMs: remainingMs(deadlineAt),
      eventsFile,
      label: `work-${attempt}`,
    });
    records.push(rec);
    if (rec.sessionId) session.id = rec.sessionId;
    // Claude enforces max_usd inside the run; Codex and Copilot are checked here after it.
    if (inputs.maxUsd > 0 && sumSpend(records) >= inputs.maxUsd) rec.budgetExceeded = true;
    if (!crashed(rec)) break;
    died += 1;
    log(`harness process died (${rec.error}); ${died < 2 ? "retrying once" : "second death"}`);
    if (died >= 2) break;
  }

  // 6. What the run left behind: commits, protected paths, the PR. Pushes carry no model secret.
  await push(checkout, branch, childBase).catch(() => {});
  let { pr: found, delta } = await observe(repo, checkout, { branch, base }, token);
  const hits = protectedTouched(delta.files, protectedList);
  if (!found && delta.count > 0 && !hits) {
    found = await ensurePr(repo, { branch, base: defaultBranch, issue, issueTitle: issueData.title, bodyText: lastMessage(inputs.harness, rec), draft: !rec.ok }, token).catch((e) => {
      log(`PR could not be opened: ${e.message.slice(0, 200)}`);
      return null;
    });
  }
  pr = found;

  // 7. Factory's own validation pass, twice at most, failures back to the harness.
  let validation = null;
  // Hard stops only; a harness that errored but left commits still gets Factory's validation pass.
  const early = decideExit({ harness: { ok: true, died, timedOut: rec.timedOut, budgetExceeded: rec.budgetExceeded }, pr: pr ? { exists: true, draft: pr.draft, body: pr.body } : null, commits: delta.count, protectedHits: hits });
  if (early.exit !== "blocked") {
    validation = await validationLoop({
      checkout,
      commands: inputs.validation,
      harness: inputs.harness,
      model: inputs.model,
      maxUsd: inputs.maxUsd,
      spentUsd: sumSpend(records),
      session,
      taskCard: prompt,
      env: harnessEnv,
      deadlineAt,
      eventsFile,
    });
    records.push(...validation.usage);
    passes = validation.passes;
    if (validation.died) died += 1;
    if (validation.usage.length) {
      await push(checkout, branch, childBase);
      ({ pr, delta } = await observe(repo, checkout, { branch, base, prNumber: pr?.number }, token));
    }
  }

  // 8. The exit.
  // Green validation on an open PR outweighs a harness error code (max turns, a late tool failure);
  // with no validation commands at all, the harness's own verdict stands. A validation fix run that
  // died is a death, not a red pass; a deadline or budget reached during it is that cap.
  const evidenceOk = !!(validation?.green && inputs.validation.length && pr);
  const decision = decideExit({
    harness: { ...rec, ok: rec.ok || evidenceOk, died, timedOut: rec.timedOut || validation?.harness?.timedOut, budgetExceeded: rec.budgetExceeded || validation?.harness?.budgetExceeded },
    pr: pr ? { exists: true, draft: pr.draft, body: pr.body } : null,
    commits: delta.count,
    validation: validation && !validation.died && !validation.harness ? { passes: validation.passes, green: validation.green, lastOutput: validation.lastOutput } : undefined,
    protectedHits: protectedTouched(delta.files, protectedList),
    planHasQuestion: pr ? await questionRaised(repo, { issue, pr }, token) : false,
  });
  if (decision.exit === "delivered" && pr) {
    // Delivered means an open, non-draft PR (the worker may have opened a draft after a harness error);
    // the review label goes on first, because the App applying it is what fires the review job.
    const head = (await observe(repo, checkout, { branch, base, prNumber: pr.number }, token)).pr.head.sha;
    await postValidated(repo, pr.number, issue, head, token);
    if (pr.draft) await setDraft(repo, pr.number, false, token);
    try {
      await addLabels(repo, pr.number, [REVIEW_LABEL], token);
    } catch (e) {
      decision.exit = "blocked";
      decision.reason = `the review label could not be applied, so no review job would run: ${e.message.slice(0, 160)}`;
    }
  }
  await applyExit(repo, { issue, pr, exit: decision.exit, reason: decision.reason, notify: inputs.notify, stage: "work" }, token);
  await finish(decision.exit, decision.reason);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    process.stderr.write(`[factory] worker failed: ${e.message}\n`);
    process.exit(1);
  });
}
