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
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { TokenKeeper } from "./lib/token-keeper.mjs";
import { PLUGIN_ROOT, defaultBranchOf, installCommand, installPlugin, prepareBranch, sh } from "./lib/checkout.mjs";
import { credentialEnv, runHarness, scrubbedEnv } from "./lib/harness.mjs";
import { addLabels, getIssue, getRepo, repoOf } from "./lib/github.mjs";
import { log, parseArgs, resolveInputs, setOutput } from "./lib/inputs.mjs";
import { decideExit, protectedPaths, protectedTouched } from "./lib/logic.mjs";
import {
  TASK_CARD_TEMPLATE,
  applyExit,
  botId,
  buildPrompt,
  configureGit,
  deadline,
  ensurePr,
  lastMessage,
  markRunning,
  observe,
  postValidated,
  push,
  questionRaised,
  remainingMs,
  validationLoop,
  writeUsage,
} from "./lib/session.mjs";
import { jobChecks } from "./doctor.mjs";

export const REVIEW_LABEL = "factory:review";

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

  // The App token: every write goes through it. The keeper re-mints it during the
  // job (an installation token lives an hour; a job may run six) and the children
  // read it from a file, so a six-hour harness session never holds a stale token.
  const keeper = await new TokenKeeper({ dir: join(usageDir, "..", `factory-auth-${issue}`), appId: inputs.appId, privateKey: inputs.appPrivateKey, owner: repo.owner, repo: repo.name, fixedToken: inputs.appToken || null }).start();
  const token = { token: keeper.getter };
  const app = keeper.app;

  const finish = async (exit, reason) => {
    keeper.stop();
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
  const { branch, base, resumed } = await prepareBranch(checkout, { issue, defaultBranch });
  log(`branch ${branch} from ${defaultBranch}@${base.slice(0, 7)}${resumed ? " (existing branch resumed)" : ""}`);
  const written = installPlugin(checkout, PLUGIN_ROOT);
  log(`plugin written into the checkout: ${written.length} path(s), git-excluded`);
  await configureGit(checkout, { appSlug: app.appSlug, botId: await botId(app.appSlug, keeper.token), protectedList, credentialHelper: keeper.credentialHelper() });
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
  const cred = await credentialEnv({ harness: inputs.harness, credential: inputs.credential, inputs });
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
  const session = { id: null, canResume: inputs.harness !== "copilot" };
  let died = 0;
  let rec = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    log(`harness ${inputs.harness}${inputs.model ? ` (${inputs.model})` : ""}, attempt ${attempt}, wall clock ${Math.round(remainingMs(deadlineAt) / 60000)} min, budget $${inputs.maxUsd}`);
    rec = await runHarness({
      harness: inputs.harness,
      model: inputs.model,
      prompt: attempt === 1 || !session.id ? prompt : "Your previous process died. Continue the Objective from where the branch and the plan comment stand; do not redo finished items.",
      maxUsd: inputs.maxUsd,
      resume: attempt > 1 && session.canResume ? session.id : null,
      cwd: checkout,
      env: harnessEnv,
      timeoutMs: remainingMs(deadlineAt),
      eventsFile,
      label: `work-${attempt}`,
    });
    records.push(rec);
    if (rec.sessionId) session.id = rec.sessionId;
    // A death is a process that ended without a harness result (signal, or a non-zero exit with no turn recorded).
    const crashed = !rec.ok && !rec.timedOut && !rec.budgetExceeded && (!!rec.signal || (rec.exitCode !== 0 && !rec.subtype && !rec.turns));
    if (!crashed) break;
    died += 1;
    log(`harness process died (${rec.error}); ${died < 2 ? "retrying once" : "second death"}`);
    if (died >= 2) break;
  }

  // 6. What the run left behind: commits, protected paths, the PR.
  await push(checkout, branch, harnessEnv).catch(() => {});
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
      session,
      taskCard: prompt,
      env: harnessEnv,
      deadlineAt,
      eventsFile,
    });
    records.push(...validation.usage);
    passes = validation.passes;
    if (validation.usage.length) {
      await push(checkout, branch, harnessEnv);
      ({ pr, delta } = await observe(repo, checkout, { branch, base, prNumber: pr?.number }, token));
    }
  }

  // 8. The exit.
  // Green validation on an open PR outweighs a harness error code (max turns, a late tool failure);
  // with no validation commands at all, the harness's own verdict stands.
  const evidenceOk = !!(validation?.green && inputs.validation.length && pr);
  const decision = decideExit({
    harness: { ...rec, ok: rec.ok || evidenceOk, died, timedOut: rec.timedOut || validation?.harness?.timedOut, budgetExceeded: rec.budgetExceeded || validation?.harness?.budgetExceeded },
    pr: pr ? { exists: true, draft: pr.draft, body: pr.body } : null,
    commits: delta.count,
    validation: validation ? { passes: validation.passes, green: validation.green, lastOutput: validation.lastOutput } : undefined,
    protectedHits: protectedTouched(delta.files, protectedList),
    planHasQuestion: pr ? await questionRaised(repo, { issue, pr }, token) : false,
  });
  await applyExit(repo, { issue, pr, exit: decision.exit, reason: decision.reason, notify: inputs.notify, stage: "work" }, token);
  if (decision.exit === "delivered" && pr) {
    const head = (await observe(repo, checkout, { branch, base, prNumber: pr.number }, token)).pr.head.sha;
    await postValidated(repo, pr.number, issue, head, token);
    // The App applies this label, so the pull_request(labeled) event fires and the review job runs.
    await addLabels(repo, pr.number, [REVIEW_LABEL], token).catch((e) => log(`review label: ${e.message.slice(0, 120)}`));
  }
  await finish(decision.exit, decision.reason);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    process.stderr.write(`[factory] worker failed: ${e.message}\n`);
    process.exit(1);
  });
}

export { main as runWorker };
