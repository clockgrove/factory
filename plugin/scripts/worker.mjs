#!/usr/bin/env node
// Factory worker job: one Objective, one branch, one PR.
//   node scripts/worker.mjs --repo OWNER/NAME --issue N [--checkout DIR] [--usage-dir DIR]
// Steps: doctor's job checks; checkout factory/<issue> from the default branch;
// write the plugin's skills and agent definitions into the checkout (git-excluded);
// setup and offline install; render the task card and $FACTORY_IN, and launch the
// harness headless under a wall clock; read what it left in $FACTORY_OUT (lib/handoff.mjs),
// push its commits and open or update the PR from pr.md, the plan comment from plan.md;
// run the repository's validation as Factory's own pass (two at most, failures sent
// back to the same harness); decide the exit (delivered, question, blocked); move the
// card, set the label, draft/comment/request as the exit says; write usage/events.jsonl
// and usage/result.json for the artifact. The harness writes nothing to GitHub.
import { pathToFileURL } from "node:url";
import { mkdirSync } from "node:fs";
import { dropOwned, privateTmp, writeOwn } from "./lib/fsafe.mjs";
import { join, resolve } from "node:path";
import { PLUGIN_ROOT, branchIdentity, installCommand, installPlugin, runnerFileEnv, sh } from "./lib/checkout.mjs";
import { credentialEnv, harnessVersion, runHarness, scrubbedEnv } from "./lib/harness.mjs";
import { addLabels, findPr, getIssue, getRepo, listComments, primeWriters, removeLabel, repoOf, rest, setDraft } from "./lib/github.mjs";
import { log, parseArgs, resolveInputs, setOutput } from "./lib/inputs.mjs";
import { REVIEW_LABEL, copilotCount, costByPhase, unmeteredRun, decideExit, decisionsRead, decisionsShown, marker, planAskedOf, protectedPaths, protectedTouched, sessionCapNote, setupPaths, sumSpend, trustedAuthor } from "./lib/logic.mjs";
import { TASK_CARD_TEMPLATE, applyExit, buildPrompt, commitAuthor, openAccess, configureGit, crashed, deadline, exitRecord, gitIdentity, lastMessage, liveActivity, markRunning, maskFile, objectiveDecisions, observe, postValidated, progressReporter, recordMergeable, remainingMs, restoreTranscript, saveAgentTranscript, saveTranscript, unreadNow, validationLoop, writeUsage } from "./lib/session.mjs";
import { openOutbox } from "./lib/outbox.mjs";
import { allowAgentEnv } from "./lib/agent.mjs";
import { jobChecks } from "./doctor.mjs";
import { authorGate } from "./lib/objective-trust.mjs";
import { agentUser } from "./lib/proc.mjs";
import { backend, spendInProgress } from "./lib/backend.mjs";
import { refusalExit } from "./lib/local.mjs";
import { exitFromOut, isSplitPart, openHandoff, partsRecord, postNote, publishPr, recordPart } from "./lib/handoff.mjs";
import { openTriage } from "./lib/triage.mjs";
import { GOALS, openDrift } from "./lib/drift.mjs";
import { answeredRepos, declaredQuestion, planNeeds as planNeedsOf, plannedRepos } from "./lib/one-repo.mjs";

/**
 * The conflict pass: the task card, then the rebase to make. `cause` says why the branch fell behind: a sibling
 * merging (a send-back), or the default branch changing a workflow file during the run (outbox.mjs catchUp).
 */
export function conflictPassPrompt({ prompt, branch, defaultBranch, cause = "after a sibling merged" }) {
  const here = `Your branch ${branch} fell behind ${defaultBranch} ${cause}, and \`git rebase origin/${defaultBranch}\` conflicts. Rebase it onto origin/${defaultBranch} (Factory has fetched it; never fetch or pull), resolve each conflict keeping both the default branch's change and this Objective's intent.`;
  return `${prompt.trimEnd()}\n\n---\n\n${here} Run the validation commands, commit, and stop: Factory pushes the branch. Do not ask questions.`;
}

async function main() {
  const startedAt = Date.now();
  // Factory's own temp directory, 700 and out of the agent's reach; the harness and its commands keep the stage's TMPDIR.
  const tmp = privateTmp();
  const args = parseArgs(process.argv.slice(2));
  const inputs = resolveInputs({ args });
  if (!inputs.repo) throw new Error("--repo OWNER/NAME (or GITHUB_REPOSITORY) is required");
  if (!inputs.issue) throw new Error("--issue N is required");
  const repo = repoOf(inputs.repo);
  const issue = inputs.issue;
  let checkout = resolve(args.checkout || process.env.GITHUB_WORKSPACE || process.cwd());
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
  // The write token in memory; on Actions the agent uid, its read-only token and its own clone (session.mjs openAccess).
  const factoryTree = checkout;
  const access = await openAccess({ inputs, repo, args, given: factoryTree });
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
  const finish = async (exit, reason) => {
    keeper.stop();
    // The raw harness stream is uploaded for 90 days: every secret this job held is masked in it first.
    const masked = maskFile(eventsFile, [...Object.values(cred.env), ...keeper.issued, inputs.githubToken, inputs.appPrivateKey]);
    if (masked) log(`masked ${masked} secret occurrence(s) in events.jsonl`);
    let usage;
    try {
      usage = writeUsage(usageDir, { spendInProgress: spendInProgress(), harness: inputs.harness, model: inputs.model, records, passes, exit, reason, credentialBasis, reentry, harnessVersion: harnessVersion(inputs.harness), session: await (agentUser() ? saveAgentTranscript : saveTranscript)({ harness: inputs.harness, sessionId: records.map((r) => r?.sessionId).filter(Boolean).at(-1) ?? null, usageDir, checkout, secrets: [...Object.values(cred.env), ...keeper.issued, inputs.githubToken, inputs.appPrivateKey] }) });
    } finally {
      // Only now, and whatever happened: the transcript's archive above is made in Factory's temp directory (its TMPDIR).
      dropOwned(tmp.factory);
    }
    log(`exit: ${exit}${reason ? ` (${reason})` : ""}; usd ${usage.usd ?? "unmetered"}; basis ${usage.basis}`);
    // Local runs upload no usage artifact: the spend line in the progress comment is what the daily cap counts.
    if (spendInProgress()) progress.spend(usage.usd);
    await progress(`exit: ${exit}${reason ? ` (${reason})` : ""}; usd ${usage.usd ?? "unmetered"}${copilotCount(usage)}${costByPhase(records)}`);
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
    // A harness start Factory refused (local mode: the clone's git): Blocked with a fixed reason, the detail in the log.
    const refused = refusalExit(e, { stage: "work", issue });
    if (refused) {
      log(e.message.slice(0, 300));
      await applyExit(repo, { issue, pr, exit: "blocked", reason: refused.reason, key: refused.key, notify: inputs.notify, stage: "work" }, token).catch((x) => log(`exit after refusal failed: ${x.message.slice(0, 120)}`));
      await finish("blocked", refused.reason);
      return;
    }
    log(`worker crashed: ${e.message.slice(0, 300)}`);
    const reason = `worker crashed: ${e.message.slice(0, 200)}`;
    await applyExit(repo, { issue, pr, exit: "blocked", reason, notify: inputs.notify, stage: "crash" }, token).catch((x) => log(`exit after crash failed: ${x.message.slice(0, 120)}`));
    await finish("blocked", reason);
    throw e;
  }

  async function run() {
  if (agentError) {
    await applyExit(repo, { issue, pr: null, exit: "blocked", reason: agentError, notify: inputs.notify, stage: "doctor" }, token);
    await finish("blocked", agentError);
    return;
  }
  // 1. Doctor's job checks: a misconfigured repository Blocks with one line, not a run.
  const checks = await jobChecks({ inputs, repo, token: keeper.token, app, checkout: factoryTree, notice: !!access.notice });
  const failed = checks.filter((c) => c.status === "FAIL");
  for (const c of checks) log(`${c.status} ${c.name}${c.detail ? `: ${c.detail}` : ""}${c.fix && c.status !== "PASS" ? ` — fix: ${c.fix}` : ""}`);
  if (failed.length) {
    const reason = `doctor: ${failed.map((c) => `${c.name} (${c.fix || c.detail})`).join("; ")}`;
    await applyExit(repo, { issue, pr: null, exit: "blocked", reason, notify: inputs.notify, stage: "doctor" }, token);
    await finish("blocked", reason);
    return;
  }

  // 2. The issue.
  let issueData = await getIssue(repo, issue, token);
  const labels = (issueData.labels || []).map((l) => l.name);
  if (issueData.state !== "open" || !labels.includes(inputs.objectiveLabel)) {
    log(`#${issue} is not an open ${inputs.objectiveLabel} issue; nothing to do`);
    await finish("skipped", `not an open ${inputs.objectiveLabel} issue`);
    return;
  }

  // A local loop holds this Objective (factory run / serve on a developer box): the Actions job steps aside.
  if (await backend().trigger.stepsAside(repo, issue, token, issueData)) {
    log(`#${issue} is held by a local loop; nothing to do here`);
    await finish("skipped", "held by a local loop");
    return;
  }

  // Only text a writer wrote reaches a harness (objective-trust.mjs): the stage acts on the body read with its author
  // and last editor, and Blocks before any harness when either cannot push and is not a pinned maintainer.
  const trusted = await authorGate({ repo, issue, issueData, notify: inputs.notify, opts: token, apply: applyExit });
  if (!trusted.ok) {
    log(trusted.reason);
    await finish("blocked", trusted.reason);
    return;
  }
  issueData = trusted.issueData;

  // One repository per Objective (lib/one-repo.mjs): a body that names another repository (declaredQuestion) is a
  // Question before any branch work or harness spend. An open PR the Objective already has goes back to a draft with
  // it, as on every Question: the dispatcher sends no draft back for a rebase (logic.mjs staleDecision), so a
  // conflicting PR does not restart this worker, and ask again, on every tick.
  const named = declaredQuestion(issueData.body, { source: repo, label: inputs.objectiveLabel });
  if (named) {
    log(`plan-time Question: ${named}`);
    const asking = await findPr(repo, `factory/${issue}`, token).catch(() => null);
    await applyExit(repo, { issue, pr: asking, exit: "question", reason: named, notify: inputs.notify, stage: "work", askOnIssue: true }, token);
    await finish("question", named);
    return;
  }

  // 3. Branch, plugin, git identity. Factory's git runs only in its own mirror (lib/outbox.mjs); what the agent's
  // checkout needs (the default branch, the Objective's branch, Factory's rebase) reaches it as a bundle, and every git
  // command there runs in the agent's sandbox (backend.mjs sandbox.git).
  const repoData = await getRepo(repo, token);
  const defaultBranch = repoData.default_branch || "main";
  const branch = `factory/${issue}`;
  // The env every child starts from, sandbox settings included. No GitHub token reaches a child: on Actions the agent
  // reads with its own read-only token; locally nothing.
  const childBase = scrubbedEnv(process.env, { CI: "true", TMPDIR: access.agent ? access.agent.tmp : tmp.agent, ...branchIdentity(branch) });
  let outbox;
  try {
    outbox = await openOutbox({ branch, defaultBranch, checkout, remote: `https://github.com/${repo.full}.git`, token: keeper.getter, agentEnv: childBase, local: backend().name === "local", protectedList, toolchain: setupPaths(inputs), base: tmp.factory });
  } catch (e) {
    if (e.code !== "ref-collision") throw e;
    log(e.message);
    await applyExit(repo, { issue, pr: null, exit: "blocked", reason: e.message, notify: inputs.notify, stage: "branch" }, token);
    await finish("blocked", e.message);
    return;
  }
  const { base, resumed } = outbox;
  const identity = await gitIdentity(app, keeper.token);
  // Factory's own commits (its rebases, its merge of a default branch that changed a workflow file) carry its identity.
  const botWho = commitAuthor(identity);
  outbox.author = botWho;
  await configureGit(checkout, { ...identity, protectedList, credentialHelper: access.readHelper || null, env: childBase });
  await outbox.feed();
  // Whatever an earlier stage or run left in a reused checkout (local mode) is discarded (outbox.mjs putOn).
  const onBranch = await outbox.putOn(resumed ? `refs/remotes/origin/${branch}` : `refs/remotes/origin/${defaultBranch}`);
  if (onBranch.code !== 0) throw new Error(`the checkout could not be put on ${branch}: ${onBranch.error}`);
  log(`branch ${branch} from ${defaultBranch}@${base.slice(0, 7)}${resumed ? " (existing branch resumed)" : ""}`);
  // Git LFS before any harness: filters set up in the checkout, the branch's objects handed over (outbox.mjs lfsSetup).
  const lfs = await outbox.lfsSetup(resumed ? outbox.expected() : base, { timeoutMs: remainingMs(deadlineAt) });
  // Factory's own git work on the checkout is done: locally its git state is recorded, and checked before each harness start.
  backend(childBase).sandbox.pinGitState(childBase);
  if (lfs.used) log(!lfs.ok ? lfs.reason : lfs.warning ? `warning: ${lfs.warning}; the run goes on with pointer files` : "Git LFS: filters set up in the checkout, objects handed over");
  if (!lfs.ok) {
    await applyExit(repo, { issue, pr: null, exit: "blocked", reason: lfs.reason, notify: inputs.notify, stage: "lfs" }, token);
    await finish("blocked", lfs.reason);
    return;
  }
  const openPr = resumed ? await findPr(repo, branch, token).catch(() => null) : null;
  // Rebase mode: the dispatcher sent an In-review PR back because its branch fell behind the default
  // branch (no merge queue). Factory rebases in its own mirror, with no model; only a conflict goes to the harness.
  let rebaseMode = false;
  let rebaseConflict = false;
  let rebasedTo = null;
  // Only the dispatcher's send-back (its rebase marker on the PR) means "rebase and nothing else";
  // a relabel after a Question or Blocked exit brings new decisions and runs the harness.
  const sentBack = openPr ? (await listComments(repo, openPr.number, token).catch(() => [])).some((c) => trustedAuthor(c) && (c.body || "").includes(marker(issue, "rebase").replace(/ -->$/, ""))) : false;
  if (openPr && sentBack) {
    const behind = await outbox.behind();
    if (behind > 0) {
      rebaseMode = true;
      rebasedTo = await outbox.rebase(botWho);
      rebaseConflict = !rebasedTo;
      if (rebasedTo) {
        // Exactly the commit Factory's own rebase made is pushed (with its merge of a default branch that changed a
        // workflow file meanwhile, if any), and the checkout is put on it for validation.
        await outbox.push({ sha: rebasedTo });
        if (outbox.merged) log(`${defaultBranch} changed ${outbox.merged.paths.join(", ")} after the rebase: Factory merged ${defaultBranch}@${outbox.merged.default.slice(0, 7)} into ${branch} before pushing`);
        await outbox.feed({ rebased: outbox.head || rebasedTo });
        await outbox.agentGit(["checkout", "-q", "-B", branch, "refs/factory/rebased"]);
      }
      log(`rebase mode: ${behind} commit(s) behind ${defaultBranch}; ${rebaseConflict ? "conflicts, the harness resolves them" : `rebased cleanly to ${rebasedTo.slice(0, 7)} in Factory's mirror, no harness run`}`);
    }
  }
  const written = await installPlugin(checkout, PLUGIN_ROOT, { harness: inputs.harness, models: { subagent: inputs.subagentModel, reviewer: inputs.reviewerModel }, env: childBase });
  log(`plugin written into the checkout: ${written.length} path(s), git-excluded`);
  await markRunning(repo, issue, token);

  // 4. setup and offline install: the model secrets never reach these.
  // A local Objective's first stage on a machine: a fresh clone and a cold install, reported apart from the run's own
  // setup so the bench does not count a one-time cost against every run (bench/lib/phases.mjs: firstSetup).
  const firstMs = Number(process.env.FACTORY_LOCAL_FIRST_SETUP_MS);
  const first = Number.isFinite(firstMs) && firstMs >= 0;
  if (first) await progress(`first-time setup: cloned in ${Math.round(firstMs / 1000)} s`);
  if (inputs.setup) {
    log(`setup: ${inputs.setup}`);
    await progress("setup");
    // On Actions setup may need sudo: it runs as the runner on a clean tree of the default branch, never on branch code.
    const s = access.agent ? await sh(await outbox.defaultTree(), inputs.setup, { env: { ...childBase, TMPDIR: tmp.factory }, timeoutMs: remainingMs(deadlineAt), asRunner: true }) : await sh(checkout, inputs.setup, { env: childBase, timeoutMs: remainingMs(deadlineAt) });
    if (!s.ok) {
      const reason = `setup failed: ${inputs.setup} exited ${s.timedOut ? "by timeout" : s.code}`;
      await applyExit(repo, { issue, pr: null, exit: "blocked", reason, notify: inputs.notify, stage: "setup" }, token);
      await finish("blocked", reason);
      return;
    }
    const wrote = runnerFileEnv(childBase); // PATH and env the setup wrote for the steps after it
    Object.assign(childBase, wrote);
    allowAgentEnv(Object.keys(wrote));
  }
  const install = installCommand(access.agent ? factoryTree : checkout, inputs.install);
  if (install) {
    log(`install: ${install}`);
    await progress(first ? "install (first time on this machine)" : "install");
    const i = await sh(checkout, install, { env: childBase, timeoutMs: remainingMs(deadlineAt) });
    if (!i.ok) {
      const reason = `offline install failed: ${install}`;
      await applyExit(repo, { issue, pr: null, exit: "blocked", reason, notify: inputs.notify, stage: "install" }, token);
      await finish("blocked", reason);
      return;
    }
  }

  // 5. The prompt, the hand-off and the harness.
  cred = await credentialEnv({ harness: inputs.harness, credential: inputs.credential, inputs });
  credentialBasis = cred.basis;
  // $FACTORY_IN and $FACTORY_OUT: fresh for this stage, so no record from an earlier attempt speaks for this one.
  const io = await openHandoff({ repo, issue, issueData, env: childBase, opts: token, outbox, branch });
  // The drift advisory (lib/drift.mjs): off without an AI Gateway key; a line on the progress comment, never an action.
  const drift = openDrift({ inputs, progress });
  const harnessEnv = { ...childBase, ...cred.env, ...io.env, FACTORY_ISSUE: String(issue), FACTORY_BRANCH: branch, ...(inputs.compactionWindow ? { FACTORY_COMPACTION_WINDOW: inputs.compactionWindow } : {}), FACTORY_PROMPT_CACHE_TTL: inputs.promptCacheTtl };
  // A rerun after a Question or Blocked exit: the maintainers' answers may be comments on the issue or the open PR.
  const decisions = await objectiveDecisions(repo, { issue, prNumber: openPr?.number ?? null }, token);
  if (decisions.length) log(`${decisions.length} maintainer decision(s) from the issue and PR comments go to the harness`);
  io.set({ decisions, prNumber: openPr?.number ?? null });
  // The plan-time Question (lib/one-repo.mjs): a repository other than this one that the plan needs, unless a maintainer
  // has answered about it since a run asked (Factory's own record of the ask, in its progress comments). A rebase
  // send-back changes no plan.
  const askedAt = rebaseMode ? {} : planAskedOf(await listComments(repo, issue, token).catch(() => []), { issue, self: await progress.self() });
  const answered = answeredRepos(askedAt, decisions);
  if (answered.size) log(`plan-time Question answered since it was asked: ${[...answered].join(", ")}`);
  // The mid-run stop counts any maintainer decision since the ask, naming the repository or not: until the harness has
  // re-planned with the answer, its plan.md (a copy of the plan comment, a first draft) may still carry the line, and
  // stopping there would ask again what the owner just answered. The end of the run decides with `answered` alone.
  const replied = answeredRepos(askedAt, decisions, { named: false });
  const needsOf = (plan, seen = answered) => (rebaseMode ? {} : planNeedsOf(plan, { source: repo, label: inputs.objectiveLabel, answered: seen }));
  const prompt = buildPrompt({
    templatePath: TASK_CARD_TEMPLATE(PLUGIN_ROOT),
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
  });
  writeOwn(join(usageDir, "task-card.md"), prompt.split("\n---\n")[0]);
  const session = { id: null, canResume: true };
  // Resume policy: under fix-passes, a rebase send-back that conflicts resumes the worker's saved
  // session (on Actions it rides the usage artifact; locally it is on the box); every other entry starts fresh.
  let restored = null;
  if (inputs.resumePolicy === "fix-passes" && rebaseConflict) {
    restored = await restoreTranscript({ repo, issue, token: inputs.githubToken, checkout, workDir: join(usageDir, ".."), harness: inputs.harness });
    if (restored.id) session.id = restored.id;
  }
  // Every stage says how it entered, resumed or fresh and why, in its progress and in result.json.
  reentry = restored ? { resumed: !!restored.id, from: restored.from ?? null, reason: restored.id ? null : restored.reason } : { resumed: false, from: null, reason: inputs.resumePolicy !== "fix-passes" ? "resume policy is fresh" : rebaseMode ? "a clean rebase runs no session" : "a new run" };
  await progress(`re-entry: ${reentry.resumed ? `resumed session ${restored.id.slice(0, 8)} from ${reentry.from}` : `fresh (${reentry.reason})`}`);
  const budgetLeft = () => (inputs.maxUsd > 0 ? Math.max(0, inputs.maxUsd - sumSpend(records)) : 0);
  let died = 0;
  let rec = null;
  // Whether the work run has been recorded as reading the decisions. Only the work run is told to apply them: a
  // conflict pass is told only to rebase (even with the full card), and a fix pass only to make validation green.
  let fedDecisions = false;
  // The plan.md the mid-run stop read (the hand-off tick), when it stopped the harness.
  let stoppedPlan = null;
  const conflictPrompt = conflictPassPrompt({ prompt, branch, defaultBranch });
  if (rebaseMode && !rebaseConflict) rec = { ok: true, timedOut: false, budgetExceeded: false, error: null, finalText: "", usd: null, tokens: { input: null, output: null, cached: null }, basis: "no harness run: clean rebase", harness: inputs.harness, model: inputs.model };
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
        if (planStop.signal.aborted || !needsOf(plan, new Set([...answered, ...replied])).reason) return;
        log("plan-time Question: the plan needs another repository; stopping the harness");
        stoppedPlan = plan;
        planStop.abort();
      });
    const live = liveActivity(progress, { harness: inputs.harness, model: inputs.model, tick, drift: drift?.watch({ stage: `work-${attempt}`, goal: GOALS.work, root: checkout, plan: io.plan }) });
    const full = !(attempt === 1 && restored?.id) && (attempt === 1 || !session.id);
    // Recorded before the run: a comment posted while it works is unread, and the review's answer pass applies it.
    // Only the decisions that fit the card are recorded; those cut for length stay unread.
    if (full && !rebaseConflict && !fedDecisions) {
      await progress.decisionsRead(decisionsRead(decisionsShown(decisions)));
      fedDecisions = true;
    }
    rec = await runHarness({
      onLine: live.onLine,
      onResume: live.onResume,
      harness: inputs.harness,
      model: inputs.model,
      effort: inputs.effort,
      prompt: attempt === 1 && restored?.id ? conflictPrompt.split("\n\n---\n\n").at(-1) : full ? (rebaseConflict ? conflictPrompt : prompt) : "Your previous process died. Continue the Objective from where the branch and $FACTORY_OUT/plan.md stand; do not redo finished items.",
      maxUsd: attempt === 1 ? inputs.maxUsd : budgetLeft(),
      resume: (attempt > 1 || restored?.id) && session.canResume ? session.id : null,
      cwd: checkout,
      env: harnessEnv,
      timeoutMs: remainingMs(deadlineAt),
      eventsFile,
      label: `work-${attempt}`,
      signal: planStop.signal,
    });
    live.finish();
    records.push(rec);
    if (rec.sessionId) session.id = rec.sessionId;
    // Claude enforces max_usd inside the run; Codex and Copilot are checked here after it. A Copilot run that reported
    // no priced credits leaves the cap unenforceable, so nothing more runs.
    if (inputs.maxUsd > 0 && sumSpend(records) >= inputs.maxUsd) rec.budgetExceeded = true;
    // A Copilot run Factory stopped at its plan writes no usage file: unmetered, but nothing more runs after it (the plan-time
    // Question skips every later pass), so it is no cap reached and the exit stays the Question.
    if (inputs.maxUsd > 0 && unmeteredRun(rec)) Object.assign(rec, rec.stopped ? { unmetered: true } : { budgetExceeded: true, unmetered: true });
    if (rec.budgetExceeded || !crashed(rec)) break;
    // A resumed session the CLI could not continue falls back to a fresh run with the full prompt.
    if (attempt === 1 && restored?.id) {
      log(`resumed session ${restored.id.slice(0, 8)} failed (${rec.error}); running fresh`);
      await progress("re-entry: resume failed; running fresh");
      restored = { ...restored, id: null, reason: "resume failed" };
      reentry = { resumed: false, from: restored.from ?? null, reason: "resume failed" };
      session.id = null;
    }
    died += 1;
    log(`harness process died (${rec.error}); ${died < 2 ? "retrying once" : "second death"}`);
    if (died >= 2) break;
  }

  // 6. What the run left behind: the hand-off files, commits, protected paths, the PR. Factory pushes and opens the PR;
  // pushes carry no model secret.
  await io.collect();
  // A plan that needs a change in another repository (its Needs-Repository line, objective-plan) is a Question at plan
  // time (lib/one-repo.mjs): the harness stops after its plan, and Factory runs no validation, fix pass or exit-record
  // call for it. Whatever it committed anyway still goes up, as a draft. A rebase send-back changes no plan.
  const ignoredNeeds = plannedRepos(io.plan()).ignored;
  if (ignoredNeeds) log(`plan: ${ignoredNeeds} Needs-Repository line(s) name no OWNER/NAME (a placeholder): no need`);
  // A harness stopped at its plan is asked about that plan, even if it rewrote plan.md as it was stopped.
  const needs = needsOf(io.plan()).reason || !stoppedPlan ? needsOf(io.plan()) : needsOf(stoppedPlan);
  const planNeeds = needs.reason || "";
  if (planNeeds) log(`plan-time Question: ${planNeeds}`);
  let pushed = await outbox.push();
  // The default branch changed a workflow file during the run and the new branch conflicts with Factory's merge of it
  // (outbox.mjs catchUp): GitHub would refuse the branch as it is, so the harness resolves the conflict once, as a
  // send-back's conflict pass does, and Factory pushes again. A second conflict is refused there. A plan-time Question
  // spends nothing on it: its draft just does not go up.
  const catchConflict = () => !pushed && !!outbox.conflict && !outbox.failed;
  if (catchConflict() && remainingMs(deadlineAt) <= 0) rec.timedOut = true;
  if (catchConflict() && !planNeeds && !rec.budgetExceeded && !rec.timedOut) {
    log(`${defaultBranch} changed ${outbox.conflict.paths.join(", ")} during the run and ${branch} conflicts with it; the harness resolves the conflict`);
    await progress(`conflict with ${defaultBranch}: harness ${inputs.harness} resolves it`);
    await outbox.feed();
    const catchPrompt = conflictPassPrompt({ prompt, branch, defaultBranch, cause: `because ${defaultBranch} changed ${outbox.conflict.paths.join(", ")} during the run` });
    const resume = session.canResume ? session.id : null;
    const live = liveActivity(progress, { harness: inputs.harness, model: inputs.model, tick: () => io.tick() });
    const pass = await runHarness({ onLine: live.onLine, onResume: live.onResume, harness: inputs.harness, model: inputs.model, effort: inputs.effort, prompt: resume ? catchPrompt.split("\n\n---\n\n").at(-1) : catchPrompt, maxUsd: budgetLeft(), resume, cwd: checkout, env: harnessEnv, timeoutMs: remainingMs(deadlineAt), eventsFile, label: "conflict" });
    live.finish();
    records.push(pass);
    if (pass.sessionId) session.id = pass.sessionId;
    // The pass answers for the branch like the work pass: a cap it reached Blocks with that cap, a death or a rebase or
    // merge it left in progress Blocks unpushed (the checkout's HEAD is then part of the work, not the branch).
    if (pass.timedOut) rec.timedOut = true;
    if (pass.budgetExceeded || (inputs.maxUsd > 0 && sumSpend(records) >= inputs.maxUsd)) rec.budgetExceeded = true;
    if (inputs.maxUsd > 0 && unmeteredRun(pass)) Object.assign(rec, { budgetExceeded: true, unmetered: true });
    await io.collect();
    const busy = rec.timedOut || rec.budgetExceeded || crashed(pass) ? { ops: [] } : await outbox.inProgress();
    if (rec.timedOut || rec.budgetExceeded) log(`the conflict pass reached the ${rec.timedOut ? "time" : "dollar"} cap; ${branch} is not pushed`);
    else if (crashed(pass)) outbox.block(`the harness died resolving ${branch}'s conflict with ${defaultBranch} (exit ${pass.exitCode ?? "none"}${pass.signal ? `, ${pass.signal}` : ""}); nothing was pushed`);
    else if (busy.code !== undefined) outbox.block(`after the conflict pass Factory could not check the checkout for a rebase or merge left in progress (exit ${busy.code}); ${branch} was not pushed`);
    else if (busy.ops.length) outbox.block(`the conflict pass left a ${busy.ops.join(" and ")} in progress in the checkout; ${branch} was not pushed`);
    else pushed = await outbox.push();
  }
  // A conflict no pass resolved, and no cap or plan-time Question to name: Blocked with it, not as a run that left no commits.
  if (catchConflict() && !planNeeds && !rec.timedOut && !rec.budgetExceeded) outbox.block(outbox.error);
  if (!pushed) log(`push refused: ${outbox.error}${outbox.detail ? ` (GitHub: ${outbox.detail})` : ""}`);
  else if (outbox.merged) log(`${defaultBranch} changed ${outbox.merged.paths.join(", ")} since the branch's base: Factory merged ${defaultBranch}@${outbox.merged.default.slice(0, 7)} into ${branch} before pushing${outbox.synced ? "" : " (the checkout could not take the merge; the next push builds on it)"}`);
  let { pr: found, delta } = await observe(repo, outbox, { branch }, token);
  const hits = protectedTouched(delta.files, protectedList);
  // A split part's PR says `Refs #N`, every other one `Closes #N`. The exit record's `part` decides when the pass wrote
  // one; a pass that wrote none (a clean rebase, a conflict or fix pass) keeps the part Factory recorded.
  const priorParts = await partsRecord(repo, issue, token).catch(() => null);
  const partLeft = (record) => (record?.part ? record.part.remaining.length : (pr || found) && isSplitPart(priorParts, (pr || found).number) ? priorParts.remaining : 0);
  const splitNow = () => partLeft(exitFromOut(io.files())) > 0;
  // A PR GitHub would read as closing anything but this Objective's issue Blocks the stage (handoff.mjs closingChecked).
  let publishRefused = "";
  const publish = (current) =>
    publishPr(repo, { branch, base: defaultBranch, issue, issueTitle: issueData.title, prText: io.files()["pr.md"], fallbackBody: lastMessage(inputs.harness, rec), splitPart: splitNow(), pr: current }, token).catch((e) => {
      log(`PR could not be ${current ? "updated" : "opened"}: ${e.message.slice(0, 200)}`);
      if (e.code === "closing-refs") publishRefused = e.message;
      return e.pr || current;
    });
  if (found || (delta.count > 0 && !hits.length && !outbox.failed)) found = await publish(found);
  pr = found;
  if (pr) io.set({ prNumber: pr.number });
  if (pr?.html_url) progress.link(`PR #${pr.number}`, pr.html_url);


  // 7. Factory's own validation passes (validationLoop caps them), failures back to the harness.
  let validation = null;
  // Hard stops only; a harness that errored but left commits still gets Factory's validation pass.
  const early = decideExit({ harness: { ok: true, died, timedOut: rec.timedOut, budgetExceeded: rec.budgetExceeded, unmetered: rec.unmetered }, pr: pr ? { exists: true, draft: pr.draft, body: pr.body } : null, commits: delta.count, protectedHits: hits, sessionCap: sessionCapNote(process.env.FACTORY_STAGE_SESSION_CAP) });
  if (early.exit !== "blocked" && !planNeeds) {
    validation = await validationLoop({
      onPhase: progress,
      progress,
      checks: inputs.ciChecks.length && pr ? { repo, issue, prNumber: pr.number, names: inputs.ciChecks, token: token.token, actionsToken: inputs.githubToken || token.token } : null,
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
      // Red-check triage (lib/triage.mjs): off without an AI Gateway key. Jobs are read and rerun with the job token on
      // Actions (actions: write), the repository token locally.
      triage: pr ? openTriage({ inputs, repo, issue, prNumber: pr.number, token: token.token, actionsToken: inputs.githubToken || token.token, progress }) : null,
      drift,
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
  // a run that had no harness (clean rebase) delivered by construction.
  const asked = rebaseMode && !rebaseConflict ? { record: { exit: "delivered", reason: "", questions: [] }, usage: [] } : planNeeds ? { record: exitFromOut(io.files()), usage: [] } : await exitRecord({ text: io.files()["exit.json"], harness: inputs.harness, model: inputs.model, effort: inputs.effort, session, cwd: checkout, env: harnessEnv, eventsFile, deadlineAt, maxUsd: inputs.maxUsd, spentUsd: sumSpend(records), unmetered: !!(rec?.unmetered || validation?.harness?.unmetered) });
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
  const decision = decideExit({
    harness: { ...rec, ok: rec.ok || evidenceOk, died, timedOut: rec.timedOut || validation?.harness?.timedOut, budgetExceeded: rec.budgetExceeded || validation?.harness?.budgetExceeded, unmetered: rec.unmetered || validation?.harness?.unmetered },
    pr: pr ? { exists: true, draft: pr.draft, body: pr.body } : null,
    commits: delta.count,
    validation: validation && !validation.died && !validation.harness && !validation.question && !conflict ? { passes: validation.passes, green: validation.green, lastOutput: validation.lastOutput, command: validation.command, baseFailure: validation.baseFailure, notStarted: validation.notStarted, scope: validation.scope } : undefined,
    protectedHits: protectedTouched(delta.files, protectedList),
    record: asked.record,
    // Every push went through the outbox, which refuses plain blobs LFS should hold and media over the cap.
    pushRejected: outbox.failed ? outbox.error : "",
    lfsRefused: outbox.lfsRefused,
    planNeeds,
    sessionCap: sessionCapNote(process.env.FACTORY_STAGE_SESSION_CAP),
  });
  if (publishRefused && decision.exit !== "blocked") Object.assign(decision, { exit: "blocked", reason: publishRefused });
  // The harness's account of what blocked it, posted on the issue.
  await postNote(repo, issue, io.files()["note.md"], token).catch((e) => log(`note: ${e.message.slice(0, 120)}`));
  if (decision.exit === "delivered" && pr) {
    // A split Objective: this part's PR joins the record, with the items left for the next part (none for the last).
    const remaining = partLeft(asked.record);
    try {
      const rec = await recordPart(repo, issue, pr.number, remaining, token);
      pr = await publishPr(repo, { branch, base: defaultBranch, issue, prText: null, splitPart: isSplitPart(rec, pr.number), pr }, token);
      if (rec) log(remaining ? `split: PR #${pr.number} is part ${rec.prs.length}; ${remaining} item(s) remain for the next part` : `split: PR #${pr.number} is the last of ${rec.prs.length} part(s)`);
    } catch (e) {
      decision.exit = "blocked";
      decision.reason = `the split record could not be written: ${e.message.slice(0, 160)}`;
    }
  }
  if (decision.exit === "delivered" && pr && conflict) {
    // Ready, unvalidated and unlabelled: the dispatcher sends a ready In-review PR that conflicts back to a worker.
    if (pr.draft) await setDraft(repo, pr.number, false, token);
    decision.reason = `PR #${pr.number} conflicts with ${defaultBranch} after a sibling merged; the dispatcher sends it back for a rebase`;
    log(decision.reason);
  } else if (decision.exit === "delivered" && pr) {
    // Delivered means an open, non-draft PR (Factory opens it as a draft until its own validation is green);
    // the review label goes on first, because the App applying it is what fires the review job.
    const head = (await observe(repo, outbox, { branch, prNumber: pr.number }, token)).pr.head.sha;
    await postValidated(repo, pr.number, issue, head, token);
    if (pr.draft) await setDraft(repo, pr.number, false, token);
    // A conflicting PR gets no pull_request runs at all (GitHub cannot build its merge ref), so it may reach
    // rebase mode without a review pass. Reviewed already: the rebased head Factory pushed is recorded as mergeable, and
    // it merges once its required checks are green (the dispatcher's next tick). Not yet reviewed: relabel (remove,
    // then add) so the review job fires now.
    // Only Factory's own clean rebase keeps the review: a head the harness made (a conflict resolved, a validation fix)
    // goes back to the reviewer, and nothing of it is recorded mergeable.
    let reviewed = rebaseMode && rebasedTo && outbox.expected() === rebasedTo ? (await rest(`repos/${repo.full}/pulls/${pr.number}/reviews?per_page=100`, { ...token, paginate: true }).catch(() => [])).some((r) => trustedAuthor(r) && (r.body || "").includes(marker(issue, "review"))) : false;
    // A maintainer's comment no pass has read (a change asked for after the review) has not reached the code: no merge.
    // The review job runs instead (relabel below) and its answer pass applies it. Unreadable comments Block.
    if (rebaseMode && reviewed) {
      try {
        const { unread } = await unreadNow(repo, { issue, prNumber: pr.number, self: await progress.self() }, token);
        if (unread.length) {
          log(`${unread.length} maintainer decision(s) no pass has read; the review job applies them before any merge`);
          reviewed = false;
        }
      } catch (e) {
        decision.exit = "blocked";
        decision.reason = `the maintainers' comments could not be read before the merge: ${e.message.slice(0, 160)}`;
      }
    }
    if (decision.exit === "delivered" && rebaseMode && reviewed && inputs.autoMerge) {
      try {
        await recordMergeable(repo, pr.number, issue, rebasedTo, token);
        log(`PR #${pr.number} rebased onto ${defaultBranch} as ${outbox.expected().slice(0, 7)}; it merges once its required checks are green`);
      } catch (e) {
        decision.exit = "blocked";
        decision.reason = `the rebased head could not be recorded for the merge: ${String(e.stderr || e.message).slice(0, 160)}`;
      }
    }
    // Remove, then add: a label already present (a harness applied it early) fires no labeled event.
    if (decision.exit === "delivered") {
      if (!(rebaseMode && reviewed)) await removeLabel(repo, pr.number, REVIEW_LABEL, token).catch(() => {});
      try {
        await addLabels(repo, pr.number, [REVIEW_LABEL], token);
      } catch (e) {
        decision.exit = "blocked";
        decision.reason = `the review label could not be applied, so no review job would run: ${e.message.slice(0, 160)}`;
      }
    }
  }
  const askedAtPlan = decision.exit === "question" && !!planNeeds;
  // Recorded with the ask, so the rerun knows which answer is to it (one-repo.mjs answeredRepos).
  if (askedAtPlan) await progress.planAsked(needs.repos);
  // Hosts the worker's sandbox denied: the backend names the operator's fix (local mode: FACTORY_LOCAL_DOMAINS).
  const fix = decision.exit === "blocked" && decision.deniedHosts ? backend().sandbox.deniedFix(decision.deniedHosts) : null;
  await applyExit(repo, { issue, pr, exit: decision.exit, reason: decision.reason, detail: decision.exit === "blocked" ? validation?.lastOutput : "", notify: inputs.notify, stage: "work", askOnIssue: askedAtPlan, fix }, token);
  await finish(decision.exit, decision.reason);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    process.stderr.write(`[factory] worker failed: ${e.message}\n`);
    process.exit(1);
  });
}
