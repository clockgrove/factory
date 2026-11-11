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
import { activeFactoryJobs, activeWorkIssues, blockedByRelations, checksOn, findPr, findProject, getIssue, getRepo, getPrSettled, hasMergeQueue, listComments, listIssuesByLabel, localSpendToday, moveCard, objectiveLabeledAt, prComment, primeWriters, projectStatuses, recentlyClosedByLabel, relabeledAfter, repoOf, requiredCheckSpecs, requiredChecks, rest, runningSince, setStateLabel, todaysUsage, updatePrBranch, upsertComment } from "./lib/github.mjs";
import { log, mask, parseArgs, resolveInputs, setOutput } from "./lib/inputs.mjs";
import { listLocks, lockBase, sweepLocks } from "./lib/lock.mjs";
import { NOT_READY_STATUSES, RETRY_WAKE_MS, REVIEW_LABEL, WAKE_SLACK_MS, wakeKinds, checksResume, doneRecord, doneTidies, launchedSince, marker, missedAnswer, nextUtcMidnight, nextWake, parseWake, pooled, quotaWaiting, sandboxRecord, selectReady, setSelf, stageHolds, staleDecision, stateOf, stopwatch, sumSpend, timingLine } from "./lib/logic.mjs";
import { CLAIM_PAUSE_MS } from "./lib/local.mjs";
import { MAX_PARTS, nextPart } from "./lib/handoff.mjs";
import { applyExit, hungChecks, mergeBlockReason, mergeReadyOne, objectiveDecisions, queueBoundMs, queueEntryState, rebaseMarkers, rebaseNotice, rebasedTwiceBlock } from "./lib/session.mjs";
import { backend } from "./lib/backend.mjs";

/** How long a picked Objective, or a labelled PR, may wait for its launch job before the sweep names it again. */
const RELAUNCH_GRACE_MS = 3 * 60_000;

export async function appToken(inputs) {
  if (inputs.appToken) return inputs.appToken;
  const repo = repoOf(inputs.repo);
  const minted = await mintInstallationToken({ appId: inputs.appId, privateKey: inputs.appPrivateKey, owner: repo.owner, repo: repo.name });
  mask(minted.token);
  // Factory's own login is the App's bot, from the App's own record (logic.mjs isSelf).
  if (minted.appSlug) setSelf(`${minted.appSlug}[bot]`);
  return minted.token;
}

/** At most this many blocked-by relation reads at once (GitHub's secondary rate limit counts concurrent requests). */
const RELATION_READS = 6;

/**
 * Today's spend (UTC day) against daily_usd: the usage artifacts of Actions runs plus the spend lines local runs and
 * cloud sandbox stages write in their progress comments. Reading artifacts needs `actions: read`, which the job token
 * has (workflow-template.yml) and the App does not; the App stays at its four permissions. A failed read counts as the
 * cap reached (Infinity), so nothing starts on a sum Factory could not make.
 * With a cloud sandbox (FACTORY_SANDBOX) no artifact is downloaded: every stage's artifact is marked `spendInProgress`
 * and its dollars are its spend line, so the sum is one paged comment read whatever the day's artifact count. Runner
 * jobs' artifacts from earlier on the day a repository switched to the sandbox are not counted.
 */
export async function todaysSpend(repo, inputs, { token, now = new Date() }) {
  let records = [];
  let usageError = null;
  try {
    if (!inputs.sandbox) records = await todaysUsage(repo, { token: inputs.githubToken || token, dateIso: now.toISOString().slice(0, 10) });
  } catch (e) {
    usageError = e.message.slice(0, 200);
    log(`today's usage could not be read (${usageError}); treating daily_usd as reached`);
  }
  // Local runs (any machine) upload no artifacts; each records its dollars in its progress comment instead.
  let localUsd = 0;
  try {
    localUsd = await localSpendToday(repo, { dateIso: now.toISOString().slice(0, 10), token });
  } catch (e) {
    usageError = usageError || e.message.slice(0, 200);
    log(`today's local spend could not be read (${e.message.slice(0, 120)}); treating daily_usd as reached`);
  }
  // A record whose stage also wrote a spend line (a cloud sandbox stage) is counted there, once.
  return { spentToday: usageError ? Number.POSITIVE_INFINITY : sumSpend(records.filter((r) => !r?.spendInProgress)) + localUsd, records, usageError };
}

export async function dispatch(inputs, { token, notice = null, now = new Date(), dryRun = false, localSlots = null, localHeld = {}, localStopped = {} }) {
  const repo = repoOf(inputs.repo);
  // notice: local mode's App for Blocked notices (session.mjs applyExit); null on Actions, where the App posts everything.
  const opts = { token, notice };
  const watch = stopwatch();
  // Every moment at which only time changes what this dispatcher does (logic.mjs WAKE_KINDS): the wake job sleeps to
  // the earliest of its kinds; the rest are listed so the log shows each wait and whose it is.
  const deadlines = [];
  const due = (issue, kind, ms) => {
    if (Number.isFinite(ms)) deadlines.push({ issue, kind, at: new Date(ms).toISOString() });
  };
  // A read this run could not make: read again soon, once (nextWake arms no retry from a retry's own run).
  const retry = (what) => {
    if (!deadlines.some((d) => d.kind === "retry")) due(null, "retry", now.getTime() + RETRY_WAKE_MS);
    log(`${what} unread this tick; a retry is due`);
  };
  // Markers and claims written by people are trusted by write access, which their association may not show this token.
  await primeWriters(repo, opts, { maintainers: inputs.maintainers });
  const issues = await listIssuesByLabel(repo, inputs.objectiveLabel, opts);
  const openNumbers = new Set(issues.map((i) => i.number));
  watch.mark("issues");

  // One explicit issue (workflow_dispatch) still obeys the state and blocking rules, not the caps.
  // Routing first: factory:local Objectives are a local loop's, the rest the Action's (lib/local.mjs).
  const wanted = (inputs.issue ? issues.filter((i) => i.number === inputs.issue) : issues).filter((i) => backend().trigger.routes(i));
  if (inputs.issue && !wanted.length) {
    log(`issue #${inputs.issue} is not an open ${inputs.objectiveLabel} issue; nothing to dispatch`);
    return { ready: [], skipped: [{ number: inputs.issue, reason: `not open with ${inputs.objectiveLabel}` }], running: 0, spentToday: 0, reason: "not an objective" };
  }

  // Today's spend is read beside everything below: it decides only the picks at the end. It never rejects.
  const spend = todaysSpend(repo, inputs, { token, now });

  // Blocking: REST relations when the API answers, else body lines. Recorded per issue; a few read at a time, so the
  // reads beside them stay clear of GitHub's secondary rate limit. A rate-limited one leaves its issue unpicked this tick.
  let relationSource = "body lines";
  await pooled(wanted, RELATION_READS, async (issue) => {
    const rel = await blockedByRelations(repo, issue.number, opts).catch((e) => {
      if (!e.rateLimited) throw e;
      issue.relationsUnread = true;
      log(`#${issue.number}: blocked-by relations rate limited (HTTP ${e.status}); not picked this tick`);
      retry(`#${issue.number}'s blocked-by relations`);
      return null;
    });
    if (rel) {
      issue.blockedBy = rel;
      relationSource = "REST dependencies/blocked_by";
    }
  });
  watch.mark("relations");

  // State: Project card Status first, labels as the fallback inside stateOf().
  let statuses = {};
  const project = await findProject(repo, opts).catch((e) => {
    log(`project lookup failed (${e.message.slice(0, 120)}); using labels`);
    return null;
  });
  if (project) statuses = await projectStatuses(project, repo, issues.map((i) => i.number), opts);
  watch.mark("board");

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

  // With a cloud sandbox, a maintainer's answer to a Question requeues it through the launcher (launch.mjs). An answer
  // whose launch was lost (an event GitHub dropped, a pending launcher a newer one replaced) leaves the Question
  // waiting: past a grace for that launch, the sweep requeues it as the launcher would.
  const answered = [];
  if (inputs.sandbox) {
    for (const issue of wanted) {
      if (reset.includes(issue.number)) continue;
      const labels = (issue.labels || []).map((l) => (typeof l === "string" ? l : l.name));
      const state = stateOf(issue, statuses[issue.number] ?? null);
      if (!(state === "Question" || (labels.includes("factory:question") && state === "In review"))) continue;
      const asked = await objectiveLabeledAt(repo, issue.number, "factory:question", opts).catch(() => null);
      if (!asked) continue;
      const pr = await findPr(repo, `factory/${issue.number}`, opts).catch(() => null);
      const decisions = await objectiveDecisions(repo, { issue: issue.number, prNumber: pr?.number ?? null }, opts).catch(() => []);
      if (!missedAnswer(decisions, { questionSince: asked, graceMs: RELAUNCH_GRACE_MS })) {
        // An answer younger than the grace: its own launch is due first; the sweep's turn comes after.
        const answer = decisions.find((d) => Date.parse(d.created_at ?? d.at) > Date.parse(asked));
        if (answer) due(issue.number, "answer-grace", Date.parse(answer.created_at ?? answer.at) + RELAUNCH_GRACE_MS + 1000);
        continue;
      }
      answered.push(issue.number);
      issue.labels = (issue.labels || []).filter((l) => !/^factory:(blocked|question|in-review)$/.test(typeof l === "string" ? l : l.name));
      statuses[issue.number] = "Queued";
      if (!dryRun) {
        await setStateLabel(repo, issue.number, null, opts);
        await moveCard(project, repo, issue.number, "Queued", opts).catch(() => {});
      }
    }
    if (answered.length) log(`answered Questions with no launch since the answer, Queued again: ${answered.map((n) => `#${n}`).join(", ")}`);
  }

  watch.mark("recovery");
  // A stage that stopped to wait for CI on its branch's head is resumed by the check event; when that event is lost,
  // the sweep names the Objective once its checks are done (launch.mjs re-reads the head and the checks).
  let checkNames = null;
  const checksFinished = async (n, record) => {
    if (record?.waiting !== "checks" || !record.head) return false;
    const head = await rest(`repos/${repo.full}/git/ref/heads/factory/${n}`, opts).then((r) => r?.object?.sha ?? null, () => null);
    if (head !== record.head) return false;
    checkNames ??= inputs.ciChecks.length ? inputs.ciChecks : await requiredChecks(repo, opts).catch(() => []);
    if (!checkNames.length) return false;
    const done = (await checksOn(repo, head, checkNames, opts).catch(() => null))?.done;
    const resume = checksResume(record, { headSha: head, checksDone: done, graceMs: RELAUNCH_GRACE_MS });
    // Done within the grace: the check event's own launch is due first.
    if (done && !resume) due(n, "checks-grace", Date.parse(record.at) + RELAUNCH_GRACE_MS + 1000);
    return resume;
  };
  // A stage that holds its sandbox within a lease: a stage that dies silently frees the Objective when the lease ends.
  const leaseDue = (n, record) => {
    if (record?.state === "running" && record.leaseUntil) due(n, "lease", Date.parse(record.leaseUntil) + WAKE_SLACK_MS);
  };

  // Stale Running: a Running issue with no worker job alive (a runner kill past the reserve, a crash the
  // catch could not reach) would hold a slot forever. Past a 15-minute grace for the matrix to start, it
  // is Blocked with the reason, and the human re-applies the label as for any Blocked card.
  const readToken = { token: inputs.githubToken || token };
  const vanished = [];
  const paused = [];
  // With a cloud sandbox (FACTORY_SANDBOX) no work job holds an Objective: its sandbox record does (launch.mjs). A
  // Running Objective with no work start since it became Running lost its launch (an event GitHub dropped, a pending
  // launcher a newer one replaced): past a grace for the launch job to start, the sweep names it again.
  const sandbox = !!inputs.sandbox;
  const relaunch = [];
  const runningIssues = issues.filter((i) => stateOf(i, statuses[i.number] ?? null) === "Running");
  if (runningIssues.length) {
    const alive = sandbox
      ? new Set()
      : await activeWorkIssues(repo, readToken).catch((e) => {
          log(`live jobs could not be listed (${e.message.slice(0, 120)}); stale Running left alone`);
          retry("live jobs");
          return null;
        });
    if (alive) {
      for (const issue of runningIssues) {
        if (alive.has(issue.number)) continue;
        if (sandbox && backend().trigger.routes(issue)) {
          const record = sandboxRecord(await listComments(repo, issue.number, opts).catch(() => []), issue.number);
          if (stageHolds(record, Date.now(), inputs.timeoutMinutes * 60_000)) {
            leaseDue(issue.number, record);
            continue;
          }
          if (record?.waiting === "checks") {
            if (await checksFinished(issue.number, record)) relaunch.push(issue.number);
            continue;
          }
          const since = await runningSince(repo, issue.number, opts).catch(() => null);
          if (since && !launchedSince(record, "work", since)) {
            if (Date.now() - Date.parse(since) > RELAUNCH_GRACE_MS) relaunch.push(issue.number);
            else due(issue.number, "launch-grace", Date.parse(since) + RELAUNCH_GRACE_MS + 1000);
            continue;
          }
        }
        // A local loop (factory run / serve) holds it: alive while its heartbeat is fresh, paused while the machine
        // is away (asleep, off, serve stopped) for its serve to resume, Blocked once away for a day.
        const since = await runningSince(repo, issue.number, opts).catch(() => null);
        let hold = await backend().trigger.localHold(repo, issue.number, opts);
        // A claim from before this Running stint (left on a Blocked one that a human re-labelled) says nothing now.
        if (hold && since && Date.parse(hold.heartbeat) < Date.parse(since)) hold = null;
        // Only the Objectives this process tends, or one a local loop claimed this stint: a local loop leaves another
        // route's Running ones to that route (#2668), but still Blocks one a loop that no longer routes it left away.
        if (!hold && !backend().trigger.tends(issue)) continue;
        if (hold?.state === "alive") continue;
        if (hold?.state === "paused") {
          paused.push(issue.number);
          due(issue.number, "local-pause", Date.parse(hold.heartbeat) + CLAIM_PAUSE_MS);
          continue;
        }
        if (!hold && since && Date.now() - Date.parse(since) < 15 * 60_000) continue;
        vanished.push(issue.number);
        statuses[issue.number] = "Blocked";
        issue.labels = [...(issue.labels || []).filter((l) => (typeof l === "string" ? l : l.name) !== "factory:running"), { name: "factory:blocked" }];
        if (!dryRun) {
          const pr = await findPr(repo, `factory/${issue.number}`, opts).catch(() => null);
          const reason = hold ? `the local loop holding it (${hold.holder}) has been away over a day` : "worker job vanished: Running with no job in progress";
          await applyExit(repo, { issue: issue.number, pr, exit: "blocked", reason, notify: inputs.notify, stage: "dispatch" }, opts);
          // The expired claim goes with the Block, so the next Running stint starts clean.
          if (hold?.commentId) await rest(`repos/${repo.full}/issues/comments/${hold.commentId}`, { ...opts, method: "DELETE" }).catch(() => {});
        }
      }
    }
  }

  watch.mark("running");
  // Integration failures go back to the worker once, then Blocked (PLAN.md "Merge"): with a merge queue, a
  // PR the queue evicted as conflicting; without one, a PR that fell behind or conflicts after a sibling
  // merged, which strict required checks refuse and nothing updates. The worker rebases, revalidates and
  // pushes, and records the rebased head as the one to merge. Every other In-review PR gets the merge pass.
  const sentBack = [];
  const updated = [];
  const nextParts = [];
  const merged = [];
  // PRs the merge pass left in the merge queue: the queue-watch job reads them until each merges or leaves.
  const queueWatch = [];
  const queue = await hasMergeQueue(repo, opts).catch(() => true);
  {
    let liveJobs = null;
    // The fallback bound and the step history, read once for this tick's merge pass (as the queue watch reads them once
    // for its watch). Actions are read with the job token (actions: read), which the App has not.
    let hungMs = null;
    const cache = {};
    for (const issue of issues) {
      // Send-backs follow routing too: a factory:local PR is its local loop's to rebase, the rest the Action's.
      if (!backend().trigger.routes(issue)) continue;
      if (stateOf(issue, statuses[issue.number] ?? null) !== "In review") continue;
      const open = await findPr(repo, `factory/${issue.number}`, opts).catch(() => null);
      if (!open) {
        // A split part merged and the issue stays open: its branch goes and the next part is queued, from the default branch.
        if (dryRun) continue;
        const next = await nextPart(repo, issue.number, opts).catch((e) => {
          log(`  #${issue.number}: next part: ${String(e.message).slice(0, 120)}`);
          return null;
        });
        if (next === "next") {
          nextParts.push(issue.number);
          issue.labels = (issue.labels || []).filter((l) => !/^factory:(blocked|question|in-review)$/.test(typeof l === "string" ? l : l.name));
          statuses[issue.number] = "Queued";
          await setStateLabel(repo, issue.number, null, opts);
          await moveCard(project, repo, issue.number, "Queued", opts).catch(() => {});
          log(`  #${issue.number}: a split part merged; the next part is queued`);
        } else if (next === "cap") {
          statuses[issue.number] = "Blocked";
          await applyExit(repo, { issue: issue.number, pr: null, exit: "blocked", reason: `split into ${MAX_PARTS} PRs and work still remains; finish it by hand or narrow the issue, then re-apply the label`, notify: inputs.notify, stage: "dispatch" }, opts);
        }
        continue;
      }
      const pr = await getPrSettled(repo, open.number, opts).catch(() => null);
      // A send-back marker names the head it saw. One whose head is still the PR's head produced no push (the
      // worker job never ran, or died), so it does not count as the one rebase allowed; the issue is sent again.
      // A human recovery (re-applying factory:objective) starts the count over (session.mjs rebaseMarkers).
      const { effective, already, since } = await rebaseMarkers(repo, { issue: issue.number, pr, objectiveLabel: inputs.objectiveLabel }, opts);
      const reviewing = (pr?.labels || []).some((l) => (typeof l === "string" ? l : l.name) === REVIEW_LABEL);
      // A labelled PR with no review start since its label lost its review launch: the sweep names it again.
      if (sandbox && reviewing && !pr.draft) {
        const labelledAt = await objectiveLabeledAt(repo, open.number, REVIEW_LABEL, opts).catch(() => null);
        const record = sandboxRecord(await listComments(repo, issue.number, opts).catch(() => []), issue.number);
        const holds = stageHolds(record, Date.now(), inputs.timeoutMinutes * 60_000);
        if (holds) leaseDue(issue.number, record);
        if (quotaWaiting(record)) due(issue.number, "quota", Date.parse(record.quota.retryAt));
        if (labelledAt && !launchedSince(record, "review", labelledAt) && !holds && !quotaWaiting(record)) {
          if (Date.now() - Date.parse(labelledAt) > RELAUNCH_GRACE_MS) relaunch.push(issue.number);
          else due(issue.number, "review-grace", Date.parse(labelledAt) + RELAUNCH_GRACE_MS + 1000);
        }
      }
      // A fix pass in review that waits on CI for its head: the check event lost, the sweep names it once CI is done.
      if (sandbox && !relaunch.includes(issue.number)) {
        const record = sandboxRecord(await listComments(repo, issue.number, opts).catch(() => []), issue.number);
        const holds = stageHolds(record, Date.now(), inputs.timeoutMinutes * 60_000);
        if (holds) leaseDue(issue.number, record);
        if (record?.waiting === "checks" && !holds && (await checksFinished(issue.number, record))) relaunch.push(issue.number);
      }
      // Only a conflicting PR under review needs the live jobs read (once per tick).
      // A failed read counts as "a review may be running" for every PR this tick: a later tick sends it back.
      if (reviewing && pr?.mergeable_state === "dirty" && !liveJobs) {
        liveJobs = await activeFactoryJobs(repo, readToken, { strict: true }).catch((e) => ({ failed: e }));
        if (liveJobs.failed) retry("live jobs");
      }
      const reviewRunning = !!liveJobs && (!!liveJobs.failed || liveJobs.review.has(issue.number));
      if (liveJobs?.failed && reviewing && pr?.mergeable_state === "dirty") log(`#${issue.number}: live jobs unreadable (${String(liveJobs.failed.message).slice(0, 80)}); no send-back this tick`);
      const decision = staleDecision({ pr, rebaseMarkers: effective, queue, reviewing, reviewRunning });
      if (decision === "update") {
        // Behind, not conflicting: one API call brings the branch up to date and its checks re-run. No worker, no
        // model; GitHub's signed merge commit is the one new head the merge pass accepts without another review.
        updated.push(issue.number);
        if (!dryRun) {
          try {
            await updatePrBranch(repo, open.number, opts);
            log(`  #${issue.number}: PR #${open.number} was behind ${pr.base?.ref}; branch updated by GitHub`);
          } catch (e) {
            log(`  #${issue.number}: update-branch failed (${String(e.message).slice(0, 120)}); sending it back to a worker`);
            sentBack.push(issue.number);
            if (!already) await prComment(repo, open.number, `${marker(issue.number, "rebase", pr.head.sha)}\nFactory: the branch is behind \`${pr.base?.ref}\` and GitHub could not update it; a worker rebases it.`, opts);
          }
        }
      } else if (decision === "rebase") {
        sentBack.push(issue.number);
        if (!dryRun && !already) await prComment(repo, open.number, rebaseNotice(issue.number, pr), opts);
      } else if (decision === "blocked") {
        statuses[issue.number] = "Blocked";
        if (!dryRun) await applyExit(repo, rebasedTwiceBlock({ issue: issue.number, pr, since, notify: inputs.notify, stage: "dispatch" }), opts);
      } else if (!dryRun && inputs.autoMerge && pr && !reviewing) {
        // The merge: the reviewed, validated head (or GitHub's signed update of it) merges once its required checks are
        // green, with no unread maintainer decision. Nothing is armed between ticks.
        const report = {};
        if (queue) hungMs ??= await queueBoundMs(repo, opts);
        const how = await mergeReadyOne(repo, { issue: issue.number, prNumber: open.number, queue, checkNames: inputs.ciChecks, report, hungMs, actionsToken: backend().name === "local" ? null : inputs.githubToken || null, cache, objectiveLabel: inputs.objectiveLabel }, opts).catch((e) => {
          log(`  #${issue.number}: merge: ${String(e.message).slice(0, 160)}`);
          return null;
        });
        if (how === "merged" || how === "queued") merged.push(issue.number);
        if (report.watch) queueWatch.push(open.number);
        if (how && !["not-recorded", "pending", "in-queue", "not-open", "held"].includes(how)) log(`  #${issue.number}: PR #${open.number} ${how}`);
        const why = mergeBlockReason(how, report);
        if (why) {
          statuses[issue.number] = "Blocked";
          await applyExit(repo, { issue: issue.number, pr, exit: "blocked", reason: why, notify: inputs.notify, stage: "dispatch" }, opts);
        }
      }
    }
  }

  watch.mark("review");
  // Running count comes from every objective, not only the wanted ones.
  const running = issues.filter((i) => stateOf(i, statuses[i.number] ?? null) === "Running").length;

  const { spentToday, records, usageError } = await spend;
  if (usageError) retry("today's spend");
  watch.mark("spend");

  const held = {};
  // A local loop's own holds (local.mjs serve, #2667). localHeld: Objectives whose stage runs on its box, never picked
  // while a read still shows them Queued. localStopped: ones whose stage there ended with a Question or a Block, after
  // its exit labels were written. A listing can be older than that write, so a stop that reads Queued is held unless a
  // fresh read of the issue agrees it is Queued (the stop never reached GitHub, or a person cleared it). A stop is
  // released only by that read, a trusted answer above, or the issue leaving the Objectives; any other state keeps it.
  const released = [];
  for (const key of Object.keys(localHeld || {})) held[Number(key)] ??= localHeld[key];
  for (const [key, reason] of Object.entries(localStopped || {})) {
    const n = Number(key);
    const issue = wanted.find((i) => i.number === n);
    if (!issue || reset.includes(n) || answered.includes(n)) released.push(n);
    else if (stateOf(issue, statuses[n] ?? null) === "Queued") {
      const fresh = await getIssue(repo, n, opts).catch(() => null);
      if (fresh && stateOf(fresh, statuses[n] ?? null) === "Queued") {
        released.push(n);
        log(`#${n}: its stop here is not on GitHub (a fresh read shows it Queued); it can run again`);
      } else held[n] ??= reason;
    }
  }
  // A Queued Objective whose last start the vendor refused for its quota waits out the backoff its record names
  // (launch.mjs). One named by hand (workflow_dispatch with an issue) does not wait.
  const deferred = {};
  // Read a few at a time, like the relations above.
  if (sandbox && !inputs.issue) {
    await pooled(wanted, RELATION_READS, async (issue) => {
      if (NOT_READY_STATUSES.has(stateOf(issue, statuses[issue.number] ?? null))) return;
      const record = sandboxRecord(await listComments(repo, issue.number, opts).catch(() => []), issue.number);
      if (quotaWaiting(record, now.getTime())) {
        deferred[issue.number] = `the sandbox vendor's quota refused its last start; next try after ${new Date(Date.parse(record.quota.retryAt)).toISOString().slice(11, 16)}Z`;
        due(issue.number, "quota", Date.parse(record.quota.retryAt));
      }
    });
    watch.mark("quota");
  }

  const picked = selectReady({
    deferred,
    issues: wanted,
    held,
    statuses,
    openIssues: openNumbers,
    maxConcurrent: inputs.issue ? running + 1 : inputs.maxConcurrent,
    dailyUsd: inputs.dailyUsd,
    spentToday,
  });
  // Queued work daily_usd held back starts when the UTC day turns (a spend that could not be read is a retry, above).
  if (picked.reason === "daily_usd reached" && !usageError && picked.skipped.some((x) => /^daily_usd reached/.test(x.reason))) due(null, "daily-cap", nextUtcMidnight(now.getTime()));
  // A PR sent back to rebase is nearest to merged: it takes a slot before new work.
  if (sentBack.length && !inputs.issue) {
    const slots = Math.max(0, inputs.maxConcurrent - running);
    picked.ready = [...sentBack, ...picked.ready.filter((n) => !sentBack.includes(n))].slice(0, slots);
  }
  // A local loop's own capacity (local.mjs serve): it starts no more than the box runs, so none is labelled Running idle.
  if (Number.isFinite(localSlots) && picked.ready.length > localSlots) {
    picked.ready = picked.ready.slice(0, Math.max(0, localSlots));
    picked.reason = picked.reason || `this box is full (FACTORY_LOCAL_MAX_CONCURRENT)`;
  }
  // Done: an issue closed by any route (the merged PR's "Closes #N", or a human) loses its
  // state label and its card moves to Done. No job runs on merge, so the cron does it. A local loop does it only for
  // the Objectives it routes, and records its removals as Factory's first (#2668).
  const done = [];
  if (!dryRun) {
    const recent = await recentlyClosedByLabel(repo, inputs.objectiveLabel, 48, opts).catch(() => []);
    // Every closed one's card in one read, not one read each.
    const cards = project && recent.length ? await projectStatuses(project, repo, recent.map((c) => c.number), opts) : {};
    for (const { number, labels } of doneTidies(recent, { cards, project: !!project, tends: (i) => backend().trigger.tends(i) })) {
      // Under a person's login, the removal is recorded as Factory's before it is made, or waits for the next tick.
      if (labels.length && backend().trigger.asPerson) {
        const recorded = await upsertComment(repo, number, marker(number, "done"), doneRecord(labels), opts).then(
          () => true,
          (e) => {
            log(`  #${number}: Done record: ${String(e.message).slice(0, 120)}; its labels wait for the next tick`);
            return false;
          },
        );
        if (!recorded) continue;
      }
      await setStateLabel(repo, number, null, opts);
      await moveCard(project, repo, number, "Done", opts).catch(() => {});
      done.push(number);
    }
  }

  watch.mark("done");
  // The launch locks (lib/lock.mjs) a launcher left behind (a job cut off mid-call) or someone else made: released here,
  // compare-and-swap on what was read, so a live holder's lock is never dropped.
  if (sandbox && !dryRun) {
    const found = await listLocks(repo, opts).catch(() => []);
    if (found.length) {
      const base = await lockBase(repo, opts).catch(() => null);
      for (const r of base ? await sweepLocks(repo, { ...opts, base, locks: found }).catch(() => []) : []) if (r.action !== "kept") log(`  lock ${r.ref.replace(/^refs\//, "")}: ${r.action} (${r.reason})`);
    }
  }

  watch.mark("locks");
  // Mark the picked issues Running now, so the next cron tick does not pick them again
  // before their matrix jobs start; the worker's doctor step re-marks on failure.
  if (!dryRun) {
    for (const n of picked.ready) {
      await setStateLabel(repo, n, "running", opts);
      await moveCard(project, repo, n, "Running", opts).catch((e) => log(`card #${n}: ${e.message.slice(0, 120)}`));
    }
  }
  watch.mark("mark");
  return { ...picked, deadlines, relaunch: relaunch.filter((n) => !picked.ready.includes(n)), updated, nextParts, merged, running, spentToday: usageError ? 0 : spentToday, usageError, usageRecords: records.length, relationSource, project: project?.title ?? null, reset, answered, released, done, vanished, paused, sentBack, queue, queueWatch, ms: watch.ms };
}

/** How often the queue watch reads the queue, and the longest it watches (under its job's timeout). */
export const WATCH_POLL_MS = 30_000;
export const WATCH_MAX_MS = 12 * 60_000;

/** The dispatcher's `queue_watch` output: its PR numbers once each, as JSON; "" for none. */
export const watchOutput = (list) => (list?.length ? JSON.stringify([...new Set(list)]) : "");

/**
 * The queue watch (workflow-template.yml queue-watch): the PRs the dispatcher left in the merge queue (`prs`), read every
 * WATCH_POLL_MS for as long as each stays there. Returns `{tick: true, pr, left: true}` as soon as one leaves the queue,
 * merged or dropped (the dispatcher's merge pass then re-enqueues a drop once, or Blocks, #2683), and
 * `{tick: true, pr, stalled: true}` as soon as one's entry is stalled: no CI began on its queue commit in
 * QUEUE_STALL_MS, or a required check made no progress (session.mjs hangsOn, logic.mjs queueHangs; the
 * merge pass takes it out and puts it back once, or Blocks). The tick is the job's own workflow_dispatch, which GitHub
 * never holds for approval, unlike the `dequeued` event's run when the queue's bot counts as an outside contributor;
 * that run stays a faster path where it runs. A failed read keeps the PR watched. Past `maxMs` with a PR
 * still in the queue it ticks anyway (`pr: null`): the merge pass reads every PR again and has it watched again.
 * Returns `{tick: false}` only with nothing to watch.
 */
export async function watchQueue(repo, prs, opts, { now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pollMs = WATCH_POLL_MS, maxMs = WATCH_MAX_MS, actionsToken = null } = {}) {
  const watched = new Set(prs.map(Number).filter((n) => Number.isInteger(n) && n > 0));
  if (!watched.size) return { tick: false };
  // The required checks and their integration: code scanning's runs on the queue's commit are not the gate starting.
  const gate = await requiredCheckSpecs(repo, opts).catch(() => []);
  // The bound for a running check, from the queue's own timeout, read once for the whole watch (as the merge pass does).
  const hungMs = await queueBoundMs(repo, opts);
  // One cache of step history for the whole watch: a step's normal duration is read once.
  const cache = {};
  const start = now();
  const seen = new Set();
  for (;;) {
    let wait = pollMs;
    for (const pr of watched) {
      const st = await queueEntryState(repo, pr, opts, now(), gate, { hungMs, actionsToken, cache }).catch((e) => {
        log(`queue watch: PR #${pr}: unreadable (${Number.isInteger(e?.status) && e.status > 0 ? `HTTP ${e.status}` : "error"}); read again`);
        return { unread: true };
      });
      if (st?.unread) continue;
      if (!st) {
        log(`queue watch: PR #${pr}: out of the merge queue; the dispatcher's merge pass runs`);
        return { tick: true, pr, left: true };
      }
      if (st.stalled) {
        log(`queue watch: PR #${pr}: its queue commit ${String(st.head).slice(0, 7)} ${st.hung ? `has ${hungChecks(st.hung)}, with no progress` : "started no check run"}; the dispatcher's merge pass runs`);
        return { tick: true, pr, stalled: true };
      }
      const what = st.state === "AWAITING_CHECKS" ? (st.waitMs ? "waits on checks" : "has its checks done") : `is ${String(st.state).toLowerCase()}`;
      if (!seen.has(`${pr}:${what}`)) log(`queue watch: PR #${pr}: its entry ${what}; watched until it leaves the queue`);
      seen.add(`${pr}:${what}`);
      if (st.waitMs) wait = Math.min(wait, st.waitMs + 1000);
    }
    // A watch that outlives its bound ticks anyway: the merge pass reads every PR again and has them watched again.
    if (now() - start >= maxMs) return { tick: true, pr: null };
    await sleep(Math.max(1000, wait));
  }
}

/**
 * The wake this dispatcher run arms (workflow-template.yml `wake`): the earliest deadline of the kinds the repository's
 * visibility arms (`isPublic`, logic.mjs wakeKinds) still ahead, unless a wake already queued or sleeping covers it
 * (read from the live jobs' names; an unreadable list arms anyway, since a second sleeper only ticks twice). `firedBy`
 * is the wake whose tick started this run, or null.
 */
export async function armWake(repo, deadlines, { now = Date.now(), firedBy = null, isPublic = false, readJobs }) {
  const kinds = wakeKinds(isPublic);
  if (!nextWake(deadlines, { now, firedBy, kinds })) return null;
  const armed = await readJobs().then(
    (j) => j.wakes,
    (e) => {
      log(`armed wakes could not be listed (${String(e.message).slice(0, 120)}); arming anyway`);
      return [];
    },
  );
  return nextWake(deadlines, { now, firedBy, armed, kinds });
}

/**
 * Whether the repository is public: from the event's own repository payload (every Actions event but a schedule carries
 * one), else one read of the repository, made only when a lease or daily-cap deadline would need the answer. Unknown
 * counts as private, which arms only the short kinds.
 */
export async function repoIsPublic(payload, deadlines, readRepo) {
  const known = payload?.repository && typeof payload.repository.private === "boolean" ? !payload.repository.private : null;
  if (known !== null) return known;
  if (!(deadlines || []).some((d) => d.kind === "lease" || d.kind === "daily-cap")) return false;
  return readRepo().then(
    (r) => r?.private === false,
    () => false,
  );
}

/** The wake that started this run: a `workflow_dispatch` whose `wake` input the wake job set; else null. */
export function firedByWake(eventName, payload) {
  return eventName === "workflow_dispatch" ? parseWake(payload?.inputs?.wake) : null;
}

/** The deadline kinds an event or a local loop owns: listed, never slept to on any repository. */
const WAKE_OWNED = new Set(["launch-grace", "review-grace", "checks-grace", "answer-grace", "local-pause"]);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputs = resolveInputs({ args });
  if (!inputs.repo) throw new Error("--repo OWNER/NAME (or GITHUB_REPOSITORY) is required");
  const token = await appToken(inputs);
  if (args.watch !== undefined) {
    let prs = [];
    try {
      prs = JSON.parse(String(args.watch || "[]"));
    } catch {
      prs = [];
    }
    const r = await watchQueue(repoOf(inputs.repo), Array.isArray(prs) ? prs : [], { token }, { actionsToken: inputs.githubToken || null });
    setOutput("tick", r.tick ? "true" : "false");
    return;
  }
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
    paused: result.paused,
    sent_back_to_rebase: result.sentBack,
    next_parts: result.nextParts,
    merged: result.merged,
    branches_updated: result.updated,
    merge_queue: result.queue,
    project: result.project,
  };
  if (args.json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  else {
    log(`objectives ready: ${result.ready.length ? result.ready.map((n) => `#${n}`).join(", ") : "none"}${result.reason ? ` (${result.reason})` : ""}${result.usageError ? ` [usage unreadable: ${result.usageError}]` : ""}`);
    log(`running: ${result.running}, spent today: $${summary.spent_today_usd} of $${inputs.dailyUsd}, blocking from ${result.relationSource}, board: ${result.project ?? "none (labels)"}, merge queue: ${result.queue ? "on (a conflicting PR goes back to the worker once)" : "off (a behind or conflicting PR goes back to the worker once)"}`);
    for (const n of result.vanished) log(`  #${n}: Running with no job alive; Blocked`);
    for (const n of result.paused || []) log(`  #${n}: paused; the local machine holding it is away, and its serve resumes it`);
    for (const n of result.sentBack) log(`  #${n}: behind the default branch; sent back to rebase`);
    for (const s of result.skipped) log(`  skip #${s.number}: ${s.reason}`);
    if (result.ms) log(`dispatch timing: ${timingLine(result.ms)}`);
  }
  // With a cloud sandbox the matrix also carries the sweep's re-launches; the launcher decides each one's stage.
  const named = [...result.ready, ...(result.relaunch || [])];
  for (const n of result.relaunch || []) log(`  #${n}: its launch was lost; launching again`);
  setOutput("issues", named);
  setOutput("count", String(named.length));
  setOutput("reason", result.reason || "");
  setOutput("queue_watch", watchOutput(result.queueWatch));
  // The dispatcher's own next tick: never from a dry run or a run named for one issue (it saw only that issue).
  const waits = result.deadlines || [];
  let wake = null;
  let kinds = null;
  if (args.dry_run !== "true" && !inputs.issue && waits.length) {
    const { readFileSync } = await import("node:fs");
    let payload = {};
    try {
      payload = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")) : {};
    } catch {
      payload = {};
    }
    const firedBy = firedByWake(process.env.GITHUB_EVENT_NAME || "", payload);
    const isPublic = await repoIsPublic(payload, waits, () => getRepo(repoOf(inputs.repo), { token }));
    kinds = wakeKinds(isPublic);
    wake = await armWake(repoOf(inputs.repo), waits, { firedBy, isPublic, readJobs: () => activeFactoryJobs(repoOf(inputs.repo), { token: inputs.githubToken || token }, { strict: true }) });
  }
  // Every wait, and whose it is: a wake's, its owner's (an event, a local loop), or on a private repository the cron's.
  const whose = (d) => (WAKE_OWNED.has(d.kind) ? " (its owner's; the cron is the backstop)" : kinds && !kinds.includes(d.kind) ? " (a long wait on a private repository: events and the cron)" : "");
  for (const d of [...waits].sort((x, y) => Date.parse(x.at) - Date.parse(y.at))) log(`  due ${d.at}: ${d.kind}${d.issue ? ` #${d.issue}` : ""}${whose(d)}`);
  if (wake) log(`wake armed for ${wake.at} (${wake.kind}${wake.issue ? ` #${wake.issue}` : ""})`);
  setOutput("wake_at", wake?.at ?? "");
  setOutput("wake_kind", wake?.kind ?? "");
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
