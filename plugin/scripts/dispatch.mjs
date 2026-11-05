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
import { pathToFileURL } from "node:url";
import { mintInstallationToken } from "./lib/app-token.mjs";
import { activeWorkIssues, blockedByRelations, findProject, findPr, getPr, hasMergeQueue, listComments, listIssuesByLabel, moveCard, objectiveLabeledAt, prComment, projectStatuses, recentlyClosedByLabel, relabeledAfter, repoOf, runningSince, setStateLabel, todaysUsage } from "./lib/github.mjs";
import { log, mask, parseArgs, resolveInputs, setOutput } from "./lib/inputs.mjs";
import { REVIEW_LABEL, marker, selectReady, staleDecision, stateOf, sumSpend } from "./lib/logic.mjs";
import { applyExit } from "./lib/session.mjs";

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

  // Recovery: a Blocked, Question or In-review issue (a PR closed unmerged by a human)
  // whose factory:objective label was re-applied after it stopped is Queued again (the
  // plan's "re-apply the label"). An explicit --issue from workflow_dispatch is the same
  // human intent.
  const reset = [];
  for (const issue of wanted) {
    const state = stateOf(issue, statuses[issue.number] ?? null);
    if (state !== "Blocked" && state !== "Question" && state !== "In review") continue;
    const again = inputs.issue === issue.number || (await relabeledAfter(repo, issue.number, inputs.objectiveLabel, ["factory:blocked", "factory:question", "factory:in-review"], opts).catch(() => false));
    if (!again) continue;
    reset.push(issue.number);
    issue.labels = (issue.labels || []).filter((l) => !/^factory:(blocked|question|in-review)$/.test(typeof l === "string" ? l : l.name));
    statuses[issue.number] = "Queued";
    if (!dryRun) {
      await setStateLabel(repo, issue.number, null, opts);
      await moveCard(project, repo, issue.number, "Queued", opts).catch(() => {});
    }
  }

  // Stale Running: a Running issue with no worker job alive (a runner kill past the reserve, a crash the
  // catch could not reach) would hold a slot forever. Past a 15-minute grace for the matrix to start, it
  // is Blocked with the reason, and the human re-applies the label as for any Blocked card.
  const readToken = { token: inputs.githubToken || token };
  const vanished = [];
  const runningIssues = issues.filter((i) => stateOf(i, statuses[i.number] ?? null) === "Running");
  if (runningIssues.length) {
    const alive = await activeWorkIssues(repo, readToken).catch((e) => {
      log(`live jobs could not be listed (${e.message.slice(0, 120)}); stale Running left alone`);
      return null;
    });
    if (alive) {
      for (const issue of runningIssues) {
        if (alive.has(issue.number)) continue;
        const since = await runningSince(repo, issue.number, opts).catch(() => null);
        if (since && Date.now() - Date.parse(since) < 15 * 60_000) continue;
        vanished.push(issue.number);
        statuses[issue.number] = "Blocked";
        issue.labels = [...(issue.labels || []).filter((l) => (typeof l === "string" ? l : l.name) !== "factory:running"), { name: "factory:blocked" }];
        if (!dryRun) {
          const pr = await findPr(repo, `factory/${issue.number}`, opts).catch(() => null);
          await applyExit(repo, { issue: issue.number, pr, exit: "blocked", reason: "worker job vanished: Running with no job in progress", notify: inputs.notify, stage: "dispatch" }, opts);
        }
      }
    }
  }

  // Integration failures go back to the worker once, then Blocked (PLAN.md "Merge"): with a merge queue, a
  // PR the queue evicted as conflicting; without one, a PR that fell behind or conflicts after a sibling
  // merged, which strict required checks refuse and nothing updates. The worker rebases, revalidates,
  // pushes and re-arms auto-merge.
  const sentBack = [];
  const queue = await hasMergeQueue(repo, opts).catch(() => true);
  {
    for (const issue of issues) {
      if (stateOf(issue, statuses[issue.number] ?? null) !== "In review") continue;
      const open = await findPr(repo, `factory/${issue.number}`, opts).catch(() => null);
      if (!open) continue;
      const pr = await getPr(repo, open.number, opts).catch(() => null);
      // A send-back marker names the head it saw. One whose head is still the PR's head produced no push (the
      // worker job never ran, or died), so it does not count as the one rebase allowed; the issue is sent again.
      const prefix = marker(issue.number, "rebase").replace(/ -->$/, "");
      // A human recovery (re-applying factory:objective) starts the count over: only markers newer than
      // the issue's last objective label count.
      const since = await objectiveLabeledAt(repo, issue.number, inputs.objectiveLabel, opts).catch(() => null);
      const markers = (await listComments(repo, open.number, opts).catch(() => [])).filter((c) => (c.body || "").includes(prefix) && (!since || Date.parse(c.created_at) > Date.parse(since)));
      const effective = markers.filter((c) => !(c.body || "").includes(`${prefix}:${pr?.head?.sha} -->`)).length;
      const reviewing = (pr?.labels || []).some((l) => (typeof l === "string" ? l : l.name) === REVIEW_LABEL);
      const decision = staleDecision({ pr, rebaseMarkers: effective, queue, reviewing });
      if (decision === "rebase") {
        sentBack.push(issue.number);
        const already = markers.some((c) => (c.body || "").includes(`${prefix}:${pr?.head?.sha} -->`));
        if (!dryRun && !already) await prComment(repo, open.number, `${marker(issue.number, "rebase", pr.head.sha)}\nFactory: the branch ${pr.mergeable_state === "dirty" ? "conflicts with" : "is behind"} \`${pr.base?.ref || "main"}\` after a sibling merged; sending it back to the worker once to rebase and revalidate.`, opts);
      } else if (decision === "blocked") {
        statuses[issue.number] = "Blocked";
        if (!dryRun) await applyExit(repo, { issue: issue.number, pr, exit: "blocked", reason: "integration failed twice: the branch fell behind again after one rebase", notify: inputs.notify, stage: "dispatch" }, opts);
      }
    }
  }

  // Running count comes from every objective, not only the wanted ones.
  const running = issues.filter((i) => stateOf(i, statuses[i.number] ?? null) === "Running").length;

  // Reading artifacts needs `actions: read`, which the job token has (workflow-template.yml) and
  // the App does not; the App stays at its four permissions. A failed read starts nothing today.
  let records = [];
  let usageError = null;
  try {
    records = await todaysUsage(repo, { token: inputs.githubToken || token, dateIso: now.toISOString().slice(0, 10) });
  } catch (e) {
    usageError = e.message.slice(0, 200);
    log(`today's usage could not be read (${usageError}); treating daily_usd as reached`);
  }
  const spentToday = usageError ? Number.POSITIVE_INFINITY : sumSpend(records);

  const picked = selectReady({
    issues: wanted,
    statuses,
    openIssues: openNumbers,
    maxConcurrent: inputs.issue ? running + 1 : inputs.maxConcurrent,
    dailyUsd: inputs.dailyUsd,
    spentToday,
  });
  // A PR sent back to rebase is nearest to merged: it takes a slot before new work.
  if (sentBack.length && !inputs.issue) {
    const slots = Math.max(0, inputs.maxConcurrent - running);
    picked.ready = [...sentBack, ...picked.ready.filter((n) => !sentBack.includes(n))].slice(0, slots);
  }
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
  return { ...picked, running, spentToday: usageError ? 0 : spentToday, usageError, usageRecords: records.length, relationSource, project: project?.title ?? null, reset, done, vanished, sentBack, queue };
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
    vanished: result.vanished,
    sent_back_to_rebase: result.sentBack,
    merge_queue: result.queue,
    project: result.project,
  };
  if (args.json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  else {
    log(`objectives ready: ${result.ready.length ? result.ready.map((n) => `#${n}`).join(", ") : "none"}${result.reason ? ` (${result.reason})` : ""}${result.usageError ? ` [usage unreadable: ${result.usageError}]` : ""}`);
    log(`running: ${result.running}, spent today: $${summary.spent_today_usd} of $${inputs.dailyUsd}, blocking from ${result.relationSource}, board: ${result.project ?? "none (labels)"}, merge queue: ${result.queue ? "on (a conflicting PR goes back to the worker once)" : "off (a behind or conflicting PR goes back to the worker once)"}`);
    for (const n of result.vanished) log(`  #${n}: Running with no job alive; Blocked`);
    for (const n of result.sentBack) log(`  #${n}: behind the default branch; sent back to rebase`);
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    process.stderr.write(`[factory] dispatch failed: ${e.message}\n`);
    process.exit(1);
  });
}
