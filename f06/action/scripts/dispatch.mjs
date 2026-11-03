#!/usr/bin/env node
// Factory dispatcher: the one piece of scheduling logic.
//   node scripts/dispatch.mjs --repo OWNER/NAME [--issue N] [--json] [--dry-run]
// With the App token (FACTORY_APP_TOKEN, or app_id + app_private_key to mint one):
// list open issues labelled factory:objective; drop those blocked by an open issue
// (GitHub's blocked-by relations via REST when the endpoint answers, else
// "Blocked by #N" lines in the body); drop Running, Blocked, Question and In review
// (Project card Status, falling back to the factory:* labels the worker also sets);
// order P0, P1, P2, then number; cap at max_concurrent minus running; start
// nothing when today's spend (usage artifacts uploaded today) has reached
// daily_usd. Prints the matrix JSON and writes it to $GITHUB_OUTPUT as `issues`.
import { mintInstallationToken } from "./lib/app-token.mjs";
import { blockedByRelations, findProject, listIssuesByLabel, moveCard, projectStatuses, recentlyClosedByLabel, relabeledAfter, repoOf, setStateLabel, todaysUsage } from "./lib/github.mjs";
import { log, mask, parseArgs, resolveInputs, setOutput } from "./lib/inputs.mjs";
import { selectReady, stateOf, sumSpend } from "./lib/logic.mjs";

export async function appToken(inputs) {
  if (inputs.appToken) return inputs.appToken;
  const repo = repoOf(inputs.repo);
  const minted = await mintInstallationToken({ appId: inputs.appId, privateKey: inputs.appPrivateKey, owner: repo.owner, repo: repo.name });
  mask(minted.token);
  return minted.token;
}

export async function dispatch(inputs, { token, now = new Date(), dryRun = false }) {
  const repo = repoOf(inputs.repo);
  const opts = { token };
  const issues = await listIssuesByLabel(repo, inputs.objectiveLabel, opts);
  const openNumbers = new Set(issues.map((i) => i.number));

  // One explicit issue (workflow_dispatch) still obeys the state and blocking rules, not the caps.
  const wanted = inputs.issue ? issues.filter((i) => i.number === inputs.issue) : issues;
  if (inputs.issue && !wanted.length) {
    log(`issue #${inputs.issue} is not an open ${inputs.objectiveLabel} issue; nothing to dispatch`);
    return { ready: [], skipped: [{ number: inputs.issue, reason: `not open with ${inputs.objectiveLabel}` }], running: 0, spentToday: 0, reason: "not an objective" };
  }

  // Blocking: REST relations when the API answers, else body lines. Recorded per issue.
  let relationSource = "body lines";
  for (const issue of wanted) {
    const rel = await blockedByRelations(repo, issue.number, opts);
    if (rel) {
      issue.blockedBy = rel;
      relationSource = "REST dependencies/blocked_by";
    }
  }

  // State: Project card Status first, labels as the fallback inside stateOf().
  let statuses = {};
  const project = await findProject(repo, opts).catch((e) => {
    log(`project lookup failed (${e.message.slice(0, 120)}); using labels`);
    return null;
  });
  if (project) statuses = await projectStatuses(project, repo, issues.map((i) => i.number), opts);

  // Recovery: a Blocked or Question issue whose factory:objective label was re-applied
  // after it stopped is Queued again (the plan's "re-apply the label"). An explicit
  // --issue from workflow_dispatch is the same human intent.
  const reset = [];
  for (const issue of wanted) {
    const state = stateOf(issue, statuses[issue.number] ?? null);
    if (state !== "Blocked" && state !== "Question") continue;
    const again = inputs.issue === issue.number || (await relabeledAfter(repo, issue.number, inputs.objectiveLabel, ["factory:blocked", "factory:question"], opts).catch(() => false));
    if (!again) continue;
    reset.push(issue.number);
    issue.labels = (issue.labels || []).filter((l) => !/^factory:(blocked|question)$/.test(typeof l === "string" ? l : l.name));
    statuses[issue.number] = "Queued";
    if (!dryRun) {
      await setStateLabel(repo, issue.number, null, opts);
      await moveCard(project, repo, issue.number, "Queued", opts).catch(() => {});
    }
  }

  // Running count comes from every objective, not only the wanted ones.
  const running = issues.filter((i) => stateOf(i, statuses[i.number] ?? null) === "Running").length;

  const records = await todaysUsage(repo, { token, dateIso: now.toISOString().slice(0, 10) });
  const spentToday = sumSpend(records);

  const picked = selectReady({
    issues: wanted,
    statuses,
    openIssues: openNumbers,
    maxConcurrent: inputs.issue ? running + 1 : inputs.maxConcurrent,
    dailyUsd: inputs.dailyUsd,
    spentToday,
  });
  // Done: an issue closed by any route (the merged PR's "Closes #N", or a human) loses its
  // state label and its card moves to Done. No job runs on merge, so the cron does it.
  const done = [];
  if (!dryRun) {
    for (const closed of await recentlyClosedByLabel(repo, inputs.objectiveLabel, 48, opts).catch(() => [])) {
      const names = (closed.labels || []).map((l) => l.name);
      const hasState = names.some((n) => /^factory:(running|in-review|blocked|question)$/.test(n));
      const card = project ? (await projectStatuses(project, repo, [closed.number], opts))[closed.number] : null;
      if (!hasState && (!card || card === "Done")) continue;
      await setStateLabel(repo, closed.number, null, opts);
      await moveCard(project, repo, closed.number, "Done", opts).catch(() => {});
      done.push(closed.number);
    }
  }

  // Mark the picked issues Running now, so the next cron tick does not pick them again
  // before their matrix jobs start; the worker's doctor step re-marks on failure.
  if (!dryRun) {
    for (const n of picked.ready) {
      await setStateLabel(repo, n, "running", opts);
      await moveCard(project, repo, n, "Running", opts).catch((e) => log(`card #${n}: ${e.message.slice(0, 120)}`));
    }
  }
  return { ...picked, running, spentToday, usageRecords: records.length, relationSource, project: project?.title ?? null, reset, done };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputs = resolveInputs({ args });
  if (!inputs.repo) throw new Error("--repo OWNER/NAME (or GITHUB_REPOSITORY) is required");
  const token = await appToken(inputs);
  const result = await dispatch(inputs, { token, dryRun: args.dry_run === "true" });
  const summary = {
    ready: result.ready,
    running: result.running,
    spent_today_usd: Math.round(result.spentToday * 100) / 100,
    daily_usd: inputs.dailyUsd,
    max_concurrent: inputs.maxConcurrent,
    skipped: result.skipped,
    blocking_source: result.relationSource,
    reset: result.reset,
    done: result.done,
    project: result.project,
  };
  if (args.json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  else {
    log(`objectives ready: ${result.ready.length ? result.ready.map((n) => `#${n}`).join(", ") : "none"}${result.reason ? ` (${result.reason})` : ""}`);
    log(`running: ${result.running}, spent today: $${summary.spent_today_usd} of $${inputs.dailyUsd}, blocking from ${result.relationSource}, board: ${result.project ?? "none (labels)"}`);
    for (const s of result.skipped) log(`  skip #${s.number}: ${s.reason}`);
  }
  setOutput("issues", result.ready);
  setOutput("count", String(result.ready.length));
  setOutput("reason", result.reason || "");
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Factory dispatch\n\nReady: ${result.ready.map((n) => `#${n}`).join(", ") || "none"}  \nRunning: ${result.running} · Spent today: $${summary.spent_today_usd} / $${inputs.dailyUsd}\n\n${result.skipped.map((s) => `- #${s.number}: ${s.reason}`).join("\n")}\n`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    process.stderr.write(`[factory] dispatch failed: ${e.message}\n`);
    process.exit(1);
  });
}
