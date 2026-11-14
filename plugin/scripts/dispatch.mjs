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
import { imageOwedNow } from "./lib/image.mjs";
import { activeFactoryJobs, activeWorkIssues, blockedByRelations, checksOn, findPr, findProject, collaboratorPermission, getIssue, getRepo, getPrSettled, hasMergeQueue, labelRemovedAt, labeledBy, listComments, listIssuesByLabel, localSpendToday, moveCard, objectiveLabeledAt, prComment, primeWriters, projectStatuses, recentlyClosedByLabel, relabeledAfter, removeLabel, repoOf, requiredCheckSpecs, requiredChecks, rest, runningSince, setStateLabel, todaysUsage, updatePrBranch, upsertComment } from "./lib/github.mjs";
import { log, mask, parseArgs, resolveInputs, setOutput } from "./lib/inputs.mjs";
import { listLocks, lockBase, sweepLocks } from "./lib/lock.mjs";
import { writeSandboxRecord } from "./launch.mjs";
import { KEEP_LAUNCHES, NOT_READY_STATUSES, RETRY_WAKE_MS, START_LOST_MS, REVIEW_LABEL, SWEEP_WAKE_KINDS, WAKE_SLACK_MS, wakeKinds, checksResume, doneRecord, doneTidies, launchedSince, marker, missedAnswer, nextUtcMidnight, nextWake, parseBlockedBy, parseWake, pooled, quotaWaiting, sandboxRecord, isSelf, selectReady, selfLogin, setSelf, trustedAuthor, stageHolds, startRetryAt, staleDecision, transientHold, inFlightUntil, knownWriter, pinnedMaintainer, stateOf, stopwatch, sumSpend, timingLine } from "./lib/logic.mjs";
import { CLAIM_PAUSE_MS, hasLocalLabel } from "./lib/local.mjs";
import { MAX_PARTS, nextPart } from "./lib/handoff.mjs";
import { applyExit, hungChecks, mergeBlockCause, mergeBlockReason, mergeReadyOne, objectiveDecisions, queueBoundMs, queueEntryState, rebaseMarkers, rebaseNotice, rebaseBlock } from "./lib/session.mjs";
import { backend } from "./lib/backend.mjs";
import { DRAFT_LABEL, RESTART_LABEL, STOP_GRACE_MS, applyStop, restartObjective, stopCause } from "./lib/stop.mjs";

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

/** What a person does about a factory:local Objective no loop came back to for a day. */
const SERVE_FIX = "start `factory serve` on the machine that runs it, then re-apply the label";

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

/** A tick that named one issue it does not dispatch (a draft, no Objective): every list main() reports, empty. */
const nothingDispatched = () => ({ ready: [], skipped: [], running: 0, spentToday: 0, relaunch: [], reset: [], answered: [], released: [], done: [], stopped: [], restarted: [], vanished: [], paused: [], sentBack: [], nextParts: [], merged: [], updated: [], queueWatch: [], deadlines: [], relationSource: null, project: null, queue: null });

export async function dispatch(inputs, { token, notice = null, now = new Date(), dryRun = false, localSlots = null, localHeld = {}, localStopped = {}, failedLaunch = null, recordWrites = null }) {
  const repo = repoOf(inputs.repo);
  // Whether this dispatcher is the sandbox route's: a cloud sandbox set (FACTORY_SANDBOX) and a backend whose Objectives
  // run in it. A local loop's (serve) never is: its Objectives run on its box, so it writes no sandbox record, launch
  // entry or lock, and a lost launch never counts against one of them (#235). It reads a record only to see a live lease
  // (stageHolds), so it neither restarts nor Blocks a stage the sandbox still runs. The repository's spend is read as
  // the sandbox setting says either way (todaysSpend), since that is where the Action's stages record it.
  const sandbox = !!inputs.sandbox && backend().trigger.sandboxRoute === true;
  // notice: local mode's App for Blocked notices (session.mjs applyExit); null on Actions, where the App posts everything.
  const opts = { token, notice };
  // Actions reads (live jobs, usage artifacts) use the job token (actions: read), which the App has not.
  const readToken0 = { token: inputs.githubToken || token };
  const watch = stopwatch();
  // Every moment at which only time changes what this dispatcher does (logic.mjs WAKE_KINDS): the wake job sleeps to
  // the earliest of its kinds; the rest are listed so the log shows each wait and whose it is.
  const deadlines = [];
  const due = (issue, kind, ms) => {
    if (Number.isFinite(ms)) deadlines.push({ issue, kind, at: new Date(ms).toISOString() });
  };
  // A read this run could not make: read again soon, once (nextWake arms no retry from a retry's own run).
  // The stage each relaunch names, for its starting marker; the Objectives whose last start the vendor failed (a
  // transient error), which hold this route's new picks.
  const relaunchStage = {};
  const vendorHeld = [];
  // A launch grace for the Objective whose launch job just failed (its tick names it): the grace's end is a wake of
  // its own, not a wait for the cron, since that launch will not come.
  const graceDue = (n, kind, ms) => due(n, n === failedLaunch ? "start-retry" : kind, ms);
  const retry = (what) => {
    if (!deadlines.some((d) => d.kind === "retry")) due(null, "retry", now.getTime() + RETRY_WAKE_MS);
    log(`${what} unread this tick; a retry is due`);
  };
  // Markers and claims written by people are trusted by write access, which their association may not show this token.
  await primeWriters(repo, opts, { maintainers: inputs.maintainers });
  const listed = await listIssuesByLabel(repo, inputs.objectiveLabel, opts);
  // An open Objective blocks the ones that name it, a draft among them: it is not done.
  const openNumbers = new Set(listed.map((i) => i.number));
  // A draft (factory:draft, lib/stop.mjs) is never run, its Objective label on or not: no pass below sees it. A Running
  // or In-review one (a person made a running Objective a draft) is stopped: the stopped pass tidies it.
  const drafts = listed.filter((i) => stopCause(i, inputs.objectiveLabel) === "draft").map((i) => i.number);
  const issues = listed.filter((i) => !drafts.includes(i.number));
  if (drafts.length) log(`drafts (${DRAFT_LABEL}), never run though labelled ${inputs.objectiveLabel}: ${drafts.map((n) => `#${n}`).join(", ")}`);
  const draftSkips = listed.filter((i) => drafts.includes(i.number) && (!inputs.issue || i.number === inputs.issue) && backend().trigger.routes(i)).map(({ number: n }) => ({ number: n, reason: `a draft (${DRAFT_LABEL}): never run; starting it takes the label off` }));
  watch.mark("issues");

  // One explicit issue (workflow_dispatch) still obeys the state and blocking rules, not the caps.
  // Routing first: factory:local Objectives are a local loop's, the rest the Action's (lib/local.mjs).
  const wanted = (inputs.issue ? issues.filter((i) => i.number === inputs.issue) : issues).filter((i) => backend().trigger.routes(i));
  if (inputs.issue && drafts.includes(inputs.issue)) {
    log(`issue #${inputs.issue} is a draft (${DRAFT_LABEL}); nothing to dispatch`);
    return { ...nothingDispatched(), skipped: draftSkips, reason: "a draft" };
  }
  if (inputs.issue && !wanted.length) {
    log(`issue #${inputs.issue} is not an open ${inputs.objectiveLabel} issue; nothing to dispatch`);
    return { ...nothingDispatched(), skipped: [{ number: inputs.issue, reason: `not open with ${inputs.objectiveLabel}` }], reason: "not an objective" };
  }

  // Today's spend is read beside everything below: it decides only the picks at the end. It never rejects.
  const spend = todaysSpend(repo, inputs, { token, now });

  // Blocking: REST relations when the API answers, else body lines. Recorded per issue; a few read at a time, so the
  // reads beside them stay clear of GitHub's secondary rate limit. A rate-limited one leaves its issue unpicked this tick.
  let relationSource = "body lines";
  await pooled(wanted, RELATION_READS, async (issue) => {
    // A rate limit is this tick's to skip (a retry wake follows), not the client's to wait out.
    const rel = await blockedByRelations(repo, issue.number, { ...opts, noRateWait: true }).catch((e) => {
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

  // Restart (`factory:restart`, lib/stop.mjs): an Objective a person asked to restart from its issue's current text, in
  // any state. Only someone who can push (or a maintainer the workflow names) restarts one: anyone else's label comes off
  // with a comment. A stage of it that may still run (an Actions job, a sandbox lease, a local loop's live claim, in any
  // state: a review's answer pass runs on a Question too) stops itself first (its watch on the issue sees the label);
  // until then the Objective is held, never picked, and no merge or send-back touches it. A stage that has not stopped
  // STOP_GRACE_MS after the label is taken for gone. Then the earlier run's PR is closed, its branch deleted and its plan
  // retired, and it is Queued again, picked like any other below. A branch GitHub keeps (a ruleset) Blocks it with the
  // fix. One on a stopped Objective (no factory:objective) waits for the label.
  const restarted = [];
  const restarting = {};
  const restarts = wanted.filter((i) => stopCause(i, inputs.objectiveLabel) === "restart");
  if (restarts.length) {
    let jobs = null;
    // Whether a stage of the Objective may still run. A read that fails is a maybe.
    const mayRun = async (issue) => {
      const n = issue.number;
      if (!sandbox) {
        jobs ??= await activeFactoryJobs(repo, readToken0, { strict: true }).catch(() => ({ failed: true }));
        if (jobs.failed || jobs.work.has(n) || jobs.review.has(n)) return true;
      }
      // A sandbox lease (any route's, when the repository has a sandbox): a local loop sees one left from before the
      // Objective was relabelled factory:local, and waits for it like a job.
      if (inputs.sandbox) {
        const comments = await listComments(repo, n, opts).catch(() => null);
        if (!comments || stageHolds(sandboxRecord(comments, n), Date.now(), inputs.timeoutMinutes * 60_000)) return true;
      }
      const hold = await backend().trigger.localHold(repo, n, opts).catch(() => ({ state: "unread" }));
      return hold?.state === "alive" || hold?.state === "unread";
    };
    // Who may restart: a writer the repository lists, a pinned maintainer, else one whose permission reads write or more.
    // A permission read that fails for now is no answer ("unread": the restart waits for the next tick); only a person
    // GitHub does not know (404) or one below write is refused.
    const mayRestart = async (actor) => {
      if (!actor?.login) return false;
      if (knownWriter(actor.login) === true || pinnedMaintainer(actor)) return true;
      let perm;
      try {
        perm = await collaboratorPermission(repo, actor.login, opts);
      } catch {
        return "unread";
      }
      return ["admin", "maintain", "write"].includes(perm);
    };
    for (const issue of restarts) {
      const n = issue.number;
      const ev = await labeledBy(repo, n, RESTART_LABEL, opts).catch(() => undefined);
      if (ev === undefined) {
        restarting[n] = "restarting: its restart's label event is unread; next tick";
        retry(`#${n}'s restart time`);
        continue;
      }
      const allowed = dryRun || (await mayRestart(ev?.actor));
      if (allowed === "unread") {
        restarting[n] = "restarting: who applied the restart could not be checked; next tick";
        retry(`#${n}'s restart permission`);
        continue;
      }
      if (!allowed) {
        const who = ev?.actor?.login || "someone";
        log(`  #${n}: ${RESTART_LABEL} by ${who}, who cannot push and is no maintainer the workflow names: ignored, the label taken off`);
        await upsertComment(repo, n, marker(n, "restart-refused", String(ev?.at || "").replace(/[^0-9TZ]/g, "")), `Factory: \`${RESTART_LABEL}\` applied by ${who} was ignored: only someone who can push to this repository, or a maintainer the workflow names, can restart an Objective.`, opts).catch((e) => log(`  #${n}: restart refusal note: ${String(e?.message || e).slice(0, 120)}`));
        await removeLabel(repo, n, RESTART_LABEL, opts).catch((e) => log(`  #${n}: ${RESTART_LABEL}: ${String(e?.message || e).slice(0, 120)}`));
        issue.labels = (issue.labels || []).filter((l) => (typeof l === "string" ? l : l.name) !== RESTART_LABEL);
        continue;
      }
      const since = ev?.at || new Date().toISOString();
      if (Date.now() - Date.parse(since) < STOP_GRACE_MS && (await mayRun(issue))) {
        restarting[n] = "restarting: its running stage stops first";
        due(n, "retry", Date.now() + RETRY_WAKE_MS);
        continue;
      }
      if (dryRun) continue;
      try {
        const r = await restartObjective(repo, n, { at: since, by: ev?.actor?.login ?? null, project }, opts);
        if (!r.finished) {
          restarting[n] = "restarted by another loop just now";
          continue;
        }
        restarted.push(n);
        statuses[n] = "Queued";
        issue.labels = (issue.labels || []).filter((l) => !/^factory:(running|blocked|question|in-review|restart)$/.test(typeof l === "string" ? l : l.name));
        log(`  #${n}: restarted from its current text${r.pr ? `; PR #${r.pr} closed` : ""}${r.head ? `; factory/${n} deleted at ${r.head.slice(0, 7)}` : ""}`);
      } catch (e) {
        if (e?.code === "restart-refused") {
          // The branch stays: a Block with the fix, and the label off, so the person re-applies it once fixed.
          restarting[n] = "Blocked: its restart could not delete its branch";
          statuses[n] = "Blocked";
          log(`  #${n}: ${e.message}`);
          const pr = await findPr(repo, `factory/${n}`, opts).catch(() => null);
          await applyExit(repo, { issue: n, pr, exit: "blocked", reason: e.message, fix: e.fix, cause: "setup", notify: inputs.notify, stage: "restart" }, opts).catch((x) => log(`  #${n}: the Block could not be written (${String(x?.message || x).slice(0, 120)})`));
          await removeLabel(repo, n, RESTART_LABEL, opts).catch(() => {});
          continue;
        }
        restarting[n] = "restarting: the restart did not finish; next tick";
        log(`  #${n}: restart: ${String(e?.message || e).slice(0, 160)}; next tick tries again`);
        retry(`#${n}'s restart`);
      }
    }
  }
  watch.mark("restart");

  // Recovery: a Blocked, Question or In-review issue (a PR closed unmerged by a human)
  // whose factory:objective label was re-applied after it stopped is Queued again (the
  // plan's "re-apply the label"). An explicit --issue from workflow_dispatch is the same
  // human intent.
  const reset = [];
  for (const issue of wanted) {
    const state = stateOf(issue, statuses[issue.number] ?? null);
    if (state !== "Blocked" && state !== "Question" && state !== "In review") continue;
    const again = inputs.issue === issue.number || (await relabeledAfter(repo, issue.number, inputs.objectiveLabel, ["factory:blocked", "factory:question", "factory:in-review"], opts, [DRAFT_LABEL]).catch(() => false));
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
  if (sandbox) {
    for (const issue of wanted) {
      if (reset.includes(issue.number)) continue;
      if (stateOf(issue, statuses[issue.number] ?? null) !== "Question") continue;
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
  const relaunch = [];
  // A local loop's hold on an Objective that waits on one (Running, or In review with work owed): "unread" when its
  // claim could not be read or checked (backend.mjs localHold). A claim from before `entered` (left on a Blocked one
  // that a human re-labelled) says nothing now.
  const localWait = async (issue, entered) => {
    const hold = await backend().trigger.localHold(repo, issue.number, opts);
    return hold && hold.state !== "unread" && entered && Date.parse(hold.heartbeat) < Date.parse(entered) ? null : hold;
  };
  // The Block for an Objective no loop came back to: an expired claim names its holder and goes with the Block, so the
  // next stint starts clean.
  const blockLocalWait = async (n, hold, noClaim, cause) => {
    const pr = await findPr(repo, `factory/${n}`, opts).catch(() => null);
    const reason = hold ? `the local loop holding it (${hold.holder}) has been away over a day; ${SERVE_FIX}` : noClaim;
    // A Block that cannot be written (the reads behind an unread claim failing too) is tried again next tick.
    const written = await applyExit(repo, { issue: n, pr, exit: "blocked", reason, cause, notify: inputs.notify, stage: "dispatch" }, opts).then(
      () => true,
      (e) => (log(`  #${n}: the Block could not be written (${String(e?.message || e).slice(0, 120)}); next tick tries again`), retry(`#${n}'s Block`), false),
    );
    if (written && hold?.commentId) await rest(`repos/${repo.full}/issues/comments/${hold.commentId}`, { ...opts, method: "DELETE" }).catch(() => {});
  };
  // An unread claim has a deadline too: past a day from `since` (when the Objective began waiting), and with the newest
  // marked comment read (its author unchecked) also over a day old, no loop can be holding it. Only a read that keeps
  // failing gets here, and its Block names that read (cause `factory`), never a machine.
  // A live local stage keeps writing as Factory (its claim's heartbeat, its progress comment), so a Block also needs the
  // issue to show none of that for the day: no comment created or updated by Factory's login, or carrying a Factory
  // marker by a person GitHub shows with push access (a local loop writes as its developer, not as the Action's App),
  // and no label event by Factory's login. Taken from the issue's timeline; a timeline or a login Factory cannot read is
  // no evidence, so it waits.
  const unreadLapsed = async (n, hold, since) => {
    if (!since || Date.now() - Date.parse(since) <= CLAIM_PAUSE_MS) return false;
    if (hold.updatedAt && Date.now() - Date.parse(hold.updatedAt) <= CLAIM_PAUSE_MS) return false;
    return factoryQuiet(n);
  };
  const factoryQuiet = async (n) => {
    if (!selfLogin()) return false;
    const events = await rest(`repos/${repo.full}/issues/${n}/timeline?per_page=100`, { ...opts, paginate: true }).catch(() => null);
    if (!Array.isArray(events)) return false;
    const after = Date.now() - CLAIM_PAUSE_MS;
    const recent = (...ts) => ts.some((t) => Date.parse(t) > after);
    return !events.some((e) =>
      e.event === "commented"
        ? (isSelf({ user: e.user ?? e.actor }) || ((e.body || "").startsWith("<!-- factory:") && trustedAuthor({ ...e, user: e.user ?? e.actor }))) && recent(e.created_at, e.updated_at)
        : (e.event === "labeled" || e.event === "unlabeled") && isSelf({ user: e.actor }) && recent(e.created_at),
    );
  };
  const unreadReason = (hold, what) => `${what} for over a day and its local claim cannot be read or checked (${hold.reason}); re-apply the label once GitHub answers that read`;
  // In review with its review owed (an open PR, not a draft, labelled factory:review): only a local loop runs that
  // review, so it waits as a Running one does, counted from the later of its entering In review and the PR's last
  // factory:review label (a re-review owes a new one). The issue's own time is read first, so an Objective inside its
  // day costs one read a tick. True when Blocked.
  const reviewLapsed = async (issue) => {
    const n = issue.number;
    const entered = await objectiveLabeledAt(repo, n, "factory:in-review", opts).then((at) => ({ at }), () => null);
    if (!entered) {
      log(`  #${n}: In-review time unread; left alone this tick`);
      retry(`#${n}'s In-review time`);
      return false;
    }
    if (!entered.at) return false;
    if (Date.now() - Date.parse(entered.at) < CLAIM_PAUSE_MS) {
      due(n, "local-pause", Date.parse(entered.at) + CLAIM_PAUSE_MS);
      return false;
    }
    const hold = await localWait(issue, entered.at);
    if (hold?.state === "alive") return false;
    if (hold?.state === "paused") {
      paused.push(n);
      due(n, "local-pause", Date.parse(hold.heartbeat) + CLAIM_PAUSE_MS);
      return false;
    }
    if (hold?.state === "unread" && !(await unreadLapsed(n, hold, entered.at))) {
      log(`  #${n}: local claim unread (${hold.reason}); left alone this tick`);
      retry(`#${n}'s local claim`);
      return false;
    }
    const pr = await findPr(repo, `factory/${n}`, opts).catch(() => null);
    if (!pr || pr.draft || !(pr.labels || []).some((l) => l.name === REVIEW_LABEL)) return false;
    const owed = await objectiveLabeledAt(repo, pr.number, REVIEW_LABEL, opts).then((at) => ({ at }), () => null);
    if (!owed) {
      retry(`PR #${pr.number}'s review label time`);
      return false;
    }
    const since = owed.at && Date.parse(owed.at) > Date.parse(entered.at) ? owed.at : entered.at;
    if (Date.now() - Date.parse(since) < CLAIM_PAUSE_MS || (hold?.state === "unread" && !(await unreadLapsed(n, hold, since)))) {
      due(n, "local-pause", Date.parse(since) + CLAIM_PAUSE_MS);
      return false;
    }
    vanished.push(n);
    statuses[n] = "Blocked";
    if (dryRun) return true;
    if (hold?.state === "unread") await blockLocalWait(n, null, unreadReason(hold, "In review"), "factory");
    else await blockLocalWait(n, hold, `in review with no local loop running its review for over a day (no claim); ${SERVE_FIX}`, "setup");
    return true;
  };
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
        // A local loop on a repository with a sandbox: a live lease holds the Objective (one serve --all routes, or one
        // relabelled factory:local mid-stage). Read for liveness only; the sandbox route's own passes stay its own.
        if (!sandbox && inputs.sandbox) {
          const record = sandboxRecord(await listComments(repo, issue.number, opts).catch(() => []), issue.number);
          if (stageHolds(record, Date.now(), inputs.timeoutMinutes * 60_000)) {
            leaseDue(issue.number, record);
            continue;
          }
        }
        if (sandbox && backend().trigger.routes(issue)) {
          const record = sandboxRecord(await listComments(repo, issue.number, opts).catch(() => []), issue.number);
          if (stageHolds(record, Date.now(), inputs.timeoutMinutes * 60_000)) {
            leaseDue(issue.number, record);
            continue;
          }
          if (record?.waiting === "checks") {
            if (await checksFinished(issue.number, record)) {
              relaunch.push(issue.number);
              relaunchStage[issue.number] = record.stage;
            }
            continue;
          }
          // `since` is GitHub's clock, the record's entries the runners': logic.mjs CLOCK_SKEW_MS.
          const since = await runningSince(repo, issue.number, opts).catch(() => null);
          if (since && !launchedSince(record, "work", since)) {
            // A start that failed in this stint is tried again after its pause (the third failure Blocks, in the
            // launcher); one that never ran gets the grace for its own launch first.
            const again = startRetryAt(record, since);
            const flight = inFlightUntil(record, since);
            if (transientHold(record, since)) vendorHeld.push(issue.number);
            relaunchStage[issue.number] = "work";
            // A launch named less than START_LOST_MS ago is still in flight (its job may wait for a runner, or threw
            // before it could record anything): it is not named again before its marker turns into an outcome.
            if (flight !== null) due(issue.number, "start-retry", flight);
            else if (again !== null) {
              if (Date.now() >= again) relaunch.push(issue.number);
              else due(issue.number, "start-retry", again);
            } else if (Date.now() - Date.parse(since) > RELAUNCH_GRACE_MS) relaunch.push(issue.number);
            else graceDue(issue.number, "launch-grace", Date.parse(since) + RELAUNCH_GRACE_MS + 1000);
            continue;
          }
        }
        // A local loop (factory run / serve) holds it: alive while its heartbeat is fresh, paused while the machine
        // is away (asleep, off, serve stopped) for its serve to resume, Blocked once away for a day. A read that
        // failed (the timeline, the claim or its author's check) is no answer: nothing rests on it, the next tick reads again.
        const read = await runningSince(repo, issue.number, opts).then((at) => ({ at }), () => null);
        const hold = read && (await localWait(issue, read.at));
        if (!read || (hold?.state === "unread" && !(backend().trigger.tends(issue) && (await unreadLapsed(issue.number, hold, read.at))))) {
          log(`  #${issue.number}: ${read ? `local claim unread (${hold.reason})` : "Running time unread"}; left alone this tick`);
          retry(`#${issue.number}'s local claim`);
          continue;
        }
        const since = read.at;
        if (hold?.state === "unread") {
          vanished.push(issue.number);
          statuses[issue.number] = "Blocked";
          issue.labels = [...(issue.labels || []).filter((l) => (typeof l === "string" ? l : l.name) !== "factory:running"), { name: "factory:blocked" }];
          if (!dryRun) await blockLocalWait(issue.number, null, unreadReason(hold, "Running"), "factory");
          continue;
        }
        // Only the Objectives this process tends, or one a local loop claimed this stint: a local loop leaves another
        // route's Running ones to that route (#2668), but still Blocks one a loop that no longer routes it left away.
        if (!hold && !backend().trigger.tends(issue)) continue;
        if (hold?.state === "alive") continue;
        if (hold?.state === "paused") {
          paused.push(issue.number);
          due(issue.number, "local-pause", Date.parse(hold.heartbeat) + CLAIM_PAUSE_MS);
          continue;
        }
        // No claim: a runner job gets 15 minutes to show up. A factory:local Objective waits for a loop on its
        // machine (one that starts, or a start that failed before its claim), so it gets the day a claim gets.
        const local = hasLocalLabel(issue);
        if (!hold && since && Date.now() - Date.parse(since) < (local ? CLAIM_PAUSE_MS : 15 * 60_000)) {
          if (local) due(issue.number, "local-pause", Date.parse(since) + CLAIM_PAUSE_MS);
          continue;
        }
        vanished.push(issue.number);
        statuses[issue.number] = "Blocked";
        issue.labels = [...(issue.labels || []).filter((l) => (typeof l === "string" ? l : l.name) !== "factory:running"), { name: "factory:blocked" }];
        // A machine not running `factory serve` is a setup gap; a runner job that vanished is Factory's own.
        if (!dryRun) await blockLocalWait(issue.number, hold, local ? `Running with no local loop holding it for over a day (no claim); ${SERVE_FIX}` : "worker job vanished: Running with no job in progress", hold || local ? "setup" : "factory");
      }
    }
  }

  watch.mark("running");
  // Integration failures go back to the worker (PLAN.md "Merge"): with a merge queue, a PR the queue evicted as
  // conflicting; without one, a PR that fell behind or conflicts after other PRs merged, which strict required checks
  // refuse and nothing updates. The worker rebases, revalidates and pushes, and records the rebased head as the one to
  // merge. Each new base is a new send-back; it Blocks only when rebasing cannot progress or at the bound
  // (logic.mjs staleDecision). Every other In-review PR gets the merge pass.
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
      // A factory:local Objective in review whose review a local loop owes gets a Running one's day, on any route's tick.
      if (hasLocalLabel(issue) && !localHeld?.[issue.number] && stateOf(issue, statuses[issue.number] ?? null) === "In review" && (await reviewLapsed(issue))) continue;
      // Send-backs follow routing too: a factory:local PR is its local loop's to rebase, the rest the Action's.
      if (!backend().trigger.routes(issue)) continue;
      // A restart waiting for its stage to stop: nothing merges, updates or sends it back meanwhile.
      if (restarting[issue.number]) continue;
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
          await applyExit(repo, { issue: issue.number, pr: null, exit: "blocked", cause: "work", reason: `split into ${MAX_PARTS} PRs and work still remains; finish it by hand or narrow the issue, then re-apply the label`, notify: inputs.notify, stage: "dispatch" }, opts);
        }
        continue;
      }
      const pr = await getPrSettled(repo, open.number, opts).catch(() => null);
      // A send-back marker names the head it saw. One whose head is still the PR's head produced no push (the
      // worker job never ran, or died), so it is no rebase toward the bound; the issue is sent again.
      // A human recovery (re-applying factory:objective) starts the count over (session.mjs rebaseMarkers).
      const { recent, already, since, record, stuck } = await rebaseMarkers(repo, { issue: issue.number, pr, objectiveLabel: inputs.objectiveLabel }, opts);
      const reviewing = (pr?.labels || []).some((l) => (typeof l === "string" ? l : l.name) === REVIEW_LABEL);
      // A labelled PR with no review start since its label lost its review launch: the sweep names it again.
      if (sandbox && reviewing && !pr.draft) {
        const labelledAt = await objectiveLabeledAt(repo, open.number, REVIEW_LABEL, opts).catch(() => null);
        const record = sandboxRecord(await listComments(repo, issue.number, opts).catch(() => []), issue.number);
        const holds = stageHolds(record, Date.now(), inputs.timeoutMinutes * 60_000);
        if (holds) leaseDue(issue.number, record);
        if (quotaWaiting(record)) due(issue.number, "quota", Date.parse(record.quota.retryAt));
        if (labelledAt && !launchedSince(record, "review", labelledAt) && !holds && !quotaWaiting(record)) {
          const again = startRetryAt(record, labelledAt);
          const flight = inFlightUntil(record, labelledAt);
          if (transientHold(record, labelledAt)) vendorHeld.push(issue.number);
          if (flight !== null) due(issue.number, "start-retry", flight);
          else if (again !== null) {
            if (Date.now() >= again) relaunch.push(issue.number);
            else due(issue.number, "start-retry", again);
          } else if (Date.now() - Date.parse(labelledAt) > RELAUNCH_GRACE_MS) relaunch.push(issue.number);
          else graceDue(issue.number, "review-grace", Date.parse(labelledAt) + RELAUNCH_GRACE_MS + 1000);
          relaunchStage[issue.number] = "review";
        }
      }
      // A fix pass in review that waits on CI for its head: the check event lost, the sweep names it once CI is done.
      if (sandbox && !relaunch.includes(issue.number)) {
        const record = sandboxRecord(await listComments(repo, issue.number, opts).catch(() => []), issue.number);
        const holds = stageHolds(record, Date.now(), inputs.timeoutMinutes * 60_000);
        if (holds) leaseDue(issue.number, record);
        if (record?.waiting === "checks" && !holds && (await checksFinished(issue.number, record))) {
          relaunch.push(issue.number);
          relaunchStage[issue.number] = record.stage;
        }
      }
      // Only a conflicting PR under review needs the live jobs read (once per tick).
      // A failed read counts as "a review may be running" for every PR this tick: a later tick sends it back.
      if (reviewing && pr?.mergeable_state === "dirty" && !liveJobs) {
        liveJobs = await activeFactoryJobs(repo, readToken, { strict: true }).catch((e) => ({ failed: e }));
        if (liveJobs.failed) retry("live jobs");
      }
      const reviewRunning = !!liveJobs && (!!liveJobs.failed || liveJobs.review.has(issue.number));
      if (liveJobs?.failed && reviewing && pr?.mergeable_state === "dirty") log(`#${issue.number}: live jobs unreadable (${String(liveJobs.failed.message).slice(0, 80)}); no send-back this tick`);
      const decision = staleDecision({ pr, rebases: recent, stuck, queue, reviewing, reviewRunning });
      if (decision === "update") {
        // Behind, not conflicting: one API call brings the branch up to date and its checks re-run. No worker, no
        // model; GitHub's signed merge commit is the one new head the merge pass accepts without another review.
        updated.push(issue.number);
        if (!dryRun) {
          try {
            await updatePrBranch(repo, open.number, opts);
            log(`  #${issue.number}: PR #${open.number} was behind ${pr.base?.ref}; branch updated by GitHub`);
          } catch (e) {
            // A worker rebases it instead, under the send-back's rules (staleDecision).
            const instead = staleDecision({ pr: { ...pr, mergeable_state: "dirty" }, rebases: recent, stuck, queue });
            if (instead === "rebase") {
              log(`  #${issue.number}: update-branch failed (${String(e.message).slice(0, 120)}); sending it back to a worker`);
              sentBack.push(issue.number);
              if (!already) await prComment(repo, open.number, `${marker(issue.number, "rebase", pr.head.sha)}\nFactory: the branch is behind \`${pr.base?.ref}\` and GitHub could not update it; a worker rebases it.`, opts);
            } else {
              updated.splice(updated.indexOf(issue.number), 1);
              statuses[issue.number] = "Blocked";
              await applyExit(repo, rebaseBlock({ issue: issue.number, pr, why: instead, record: stuck || record, since, notify: inputs.notify, stage: "dispatch" }), opts);
            }
          }
        }
      } else if (decision === "rebase") {
        sentBack.push(issue.number);
        if (!dryRun && !already) await prComment(repo, open.number, rebaseNotice(issue.number, pr), opts);
      } else if (decision === "stuck" || decision === "limit") {
        statuses[issue.number] = "Blocked";
        if (!dryRun) await applyExit(repo, rebaseBlock({ issue: issue.number, pr, why: decision, record: stuck || record, since, notify: inputs.notify, stage: "dispatch" }), opts);
      } else if (!dryRun && inputs.autoMerge && pr && !reviewing) {
        // The merge: the reviewed, validated head (or GitHub's signed update of it) merges once its required checks are
        // green, with no unread maintainer decision. Nothing is armed between ticks.
        const report = {};
        if (queue) hungMs ??= await queueBoundMs(repo, opts);
        const how = await mergeReadyOne(repo, { issue: issue.number, prNumber: open.number, queue, checkNames: inputs.ciChecks, report, hungMs, actionsToken: backend().name === "local" ? null : inputs.githubToken || null, cache, objectiveLabel: inputs.objectiveLabel, issueData: issue }, opts).catch((e) => {
          log(`  #${issue.number}: merge: ${String(e.message).slice(0, 160)}`);
          return null;
        });
        if (how === "merged" || how === "queued") merged.push(issue.number);
        if (report.watch) queueWatch.push(open.number);
        if (how && !["not-recorded", "pending", "in-queue", "not-open", "held", "stopped"].includes(how)) log(`  #${issue.number}: PR #${open.number} ${how}`);
        const why = mergeBlockReason(how, report);
        if (why) {
          statuses[issue.number] = "Blocked";
          await applyExit(repo, { issue: issue.number, pr, exit: "blocked", reason: why, cause: mergeBlockCause(how, report), notify: inputs.notify, stage: "dispatch" }, opts);
        }
      }
    }
  }

  watch.mark("review");
  // max_concurrent caps the repository as a whole (LOCAL.md): the Running count is every route's Objectives (a local
  // loop's paused ones too, which stay Running), never only the ones this route picks from. Drafts are not in `issues`.
  const running = issues.filter((i) => stateOf(i, statuses[i.number] ?? null) === "Running").length;

  const { spentToday, records, usageError } = await spend;
  if (usageError) retry("today's spend");
  watch.mark("spend");

  const held = { ...restarting };
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
    running,
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
  // The sandbox vendor failing starts (a transient error, its retry pending): nothing new starts on this route until a
  // retry gets through, so the queue is not drained into the outage. The retries themselves still go.
  if (sandbox && vendorHeld.length && !inputs.issue && picked.ready.length) {
    const why = `the ${inputs.sandbox} sandbox is failing starts (#${vendorHeld.join(", #")} waits to retry); new Objectives wait`;
    picked.skipped = [...picked.skipped, ...picked.ready.map((n) => ({ number: n, reason: why }))];
    picked.ready = [];
    picked.reason = why;
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
      // Closing the issue stops its Objective: a PR it left open goes back to a draft without the review label, so the
      // merge queue never merges it (a merged PR is no longer open; a split part's leaves the issue open).
      await applyStop(repo, number, { closed: true, project }, opts);
      done.push(number);
    }
  }

  watch.mark("done");
  // Stopped: an open issue still marked Running or In review whose Objective label a person removed, or that a person made
  // a draft (`factory:draft`, stop.mjs). Its PR goes back to a draft without the review label (no review starts, the
  // merge queue drops it), its state label comes off and its card goes back to Queued, so re-applying the label (or
  // starting the draft) starts it again. A running stage stops itself (its watch on the issue) and tidies the same way; a
  // Running one is tidied here only STOP_GRACE_MS after its stop (the label's removal, the draft label's application),
  // for a stage that died or never saw the stop. A local loop tidies only the Objectives it routes.
  const stopped = [];
  if (!dryRun) {
    const seen = new Set();
    for (const label of ["factory:in-review", "factory:running"]) {
      const list = await listIssuesByLabel(repo, label, opts).catch((e) => {
        retry(`the ${label} issues (${String(e.message).slice(0, 80)})`);
        return [];
      });
      for (const issue of list) {
        const cause = stopCause(issue, inputs.objectiveLabel);
        if (seen.has(issue.number) || (cause !== "unlabeled" && cause !== "draft") || !backend().trigger.tends(issue)) continue;
        seen.add(issue.number);
        if (label === "factory:running") {
          const off = await (cause === "draft" ? labeledBy(repo, issue.number, DRAFT_LABEL, opts).then((e) => e?.at ?? null) : labelRemovedAt(repo, issue.number, inputs.objectiveLabel, opts)).catch(() => undefined);
          if (off === undefined) {
            retry(`#${issue.number}'s stop time`);
            continue;
          }
          if (off && Date.now() - Date.parse(off) < STOP_GRACE_MS) continue;
        }
        await applyStop(repo, issue.number, { project }, opts);
        stopped.push(issue.number);
      }
    }
    if (stopped.length) log(`stopped (the label removed, or made a draft), left a draft PR and Queued: ${stopped.map((n) => `#${n}`).join(", ")}`);
  }

  watch.mark("stopped");
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
  // A starting marker for each stage this run names on the sandbox route, written under the record lock: a launch that
  // never runs its course (its job never starts, fails before it writes, or is cut off) leaves it with no outcome, and
  // past START_LOST_MS it counts as a failed start (logic.mjs startFailures), so the next try waits its pause and three
  // Block, whatever happened to the job.
  const named = [...picked.ready.map((n) => [n, "work"]), ...relaunch.filter((n) => !picked.ready.includes(n)).map((n) => [n, relaunchStage[n] || "work"])];
  if (sandbox && !dryRun && named.length) {
    // `recordWrites`: the record writes' {api, base} (tests); else GitHub's, with the lock's base read once.
    const base = recordWrites?.base ?? (await lockBase(repo, opts).catch(() => null));
    for (const [n, stage] of named) {
      const markedAt = new Date().toISOString();
      const w = base ? await writeSandboxRecord(repo, n, opts, (cur) => startingRecord(cur, { vendor: inputs.sandbox, stage, at: markedAt, run: process.env.GITHUB_RUN_ID || "" }), { base, ...(recordWrites?.api ? { api: recordWrites.api, pauseMs: 0, readBackPauseMs: 0 } : {}) }).catch(() => null) : null;
      if (!w?.ok) log(`  #${n}: no starting marker (${w?.refused ? "a launcher's live claim holds the record" : "not written"}); the wake below and the launch grace catch a lost launch`);
      // This run owns the launch it named: a launcher that exits without a tick, or never runs, is looked at again when
      // its marker turns into an outcome, by a wake of this run's, not the cron.
      due(n, "start-retry", Date.parse(markedAt) + START_LOST_MS + 1000);
    }
  }
  watch.mark("mark");
  return { ...picked, skipped: [...draftSkips, ...picked.skipped], deadlines, relaunch: relaunch.filter((n) => !picked.ready.includes(n)), updated, nextParts, merged, running, spentToday: usageError ? 0 : spentToday, usageError, usageRecords: records.length, relationSource, project: project?.title ?? null, reset, answered, released, done, stopped, restarted, vanished, paused, sentBack, queue, queueWatch, ms: watch.ms };
}

/**
 * The record with the dispatcher's starting marker for `stage` appended (`ok: null`, no code): the launch it names
 * settles it (its claim or its failure drops it, launch.mjs settledLaunches; its skip drops it too, launch.mjs
 * withoutOwnMarker). With no record yet, one that says only this; the record's own time is left as it was, so a later
 * write shows the marker was followed. Null (no marker) over a live claim: a launcher already holds the record, so
 * the launch this run names will skip, and a marker nothing settles would count as a `lost` start.
 */
export function startingRecord(cur, { vendor, stage, at, run }) {
  if (cur?.state === "running" && cur.claim && Date.parse(cur.leaseUntil) > Date.parse(at)) return null;
  const entry = { stage, event: "dispatch", ok: null, run, at };
  const rec = cur ? { ...cur } : { vendor, stage, state: "named", at, launches: [] };
  return { ...rec, launches: [...(rec.launches || []), entry].slice(-KEEP_LAUNCHES) };
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
 * is the wake whose tick started this run, or null. The sweep's wakes are armed the same way (armSweepWake), with their
 * own `kinds`, where only an armed wake of the kinds in `runs` covers a deadline; every wake's tick runs the dispatcher.
 */
export async function armWake(repo, deadlines, { now = Date.now(), firedBy = null, isPublic = false, kinds = wakeKinds(isPublic), runs = null, readJobs }) {
  if (!nextWake(deadlines, { now, firedBy, kinds })) return null;
  const armed = await readJobs().then(
    (j) => j.wakes.filter((w) => !runs || runs.includes(w.kind)),
    (e) => {
      log(`armed wakes could not be listed (${String(e.message).slice(0, 120)}); arming anyway`);
      return [];
    },
  );
  return nextWake(deadlines, { now, firedBy, armed, kinds });
}

/**
 * Arm the sweep's own next run, from the sweep or the image job (workflow-template.yml `sweep-wake`, `image-wake`):
 * logs every wait and the wake armed, and sets the job's `wake_at` and `wake_kind` outputs. Only `sweep` waits, minutes
 * each, so on every repository; only an armed `sweep` wake covers one (every wake's tick runs the dispatcher, but only
 * a `sweep` wake's runs the sweep). A run a `sweep` wake started never arms that same deadline again.
 */
export async function armSweepWake(job, deadlines, { repo, payload, eventName, token, now = Date.now() }) {
  let wake = null;
  try {
    if ((deadlines || []).length) wake = await armWake(repo, deadlines, { now, firedBy: firedByWake(eventName, payload), kinds: SWEEP_WAKE_KINDS, runs: SWEEP_WAKE_KINDS, readJobs: () => activeFactoryJobs(repo, { token }, { strict: true }) });
  } catch (e) {
    log(`${job}: no wake armed (${String(e.message).slice(0, 120)}); events and the cron run the sweep next`);
  }
  for (const d of [...(deadlines || [])].sort((x, y) => Date.parse(x.at) - Date.parse(y.at))) log(`${job}: due ${d.at}: ${d.kind}${d.issue ? ` #${d.issue}` : ""}`);
  if (wake) log(`${job}: wake armed for ${wake.at} (${wake.kind}${wake.issue ? ` #${wake.issue}` : ""})`);
  setOutput("wake_at", wake?.at ?? "");
  setOutput("wake_kind", wake?.kind ?? "");
  return wake;
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

/**
 * Whether a run is worth its reads: every event but an issue closing is. A closed issue is when it was an Objective, or
 * when it blocks one: GitHub's own count in the payload (`issue_dependencies_summary.blocking`), or a "Blocked by #N"
 * line in an open Objective's body (one listing read). A payload with no such count cannot rule a relation out, so the
 * run goes ahead.
 */
export async function closedIssueTicks(eventName, payload, { objectiveLabel, objectives }) {
  if (eventName !== "issues" || payload?.action !== "closed") return true;
  const issue = payload.issue || {};
  if ((issue.labels || []).some((l) => (typeof l === "string" ? l : l?.name) === objectiveLabel)) return true;
  const summary = issue.issue_dependencies_summary;
  if (!summary || typeof summary.blocking !== "number") return true;
  if (summary.blocking > 0) return true;
  const open = await objectives().catch(() => null);
  if (!open) return true;
  return open.some((o) => parseBlockedBy(o.body).includes(issue.number));
}

/** The deadline kinds an event or a local loop owns: listed, never slept to on any repository. */
const WAKE_OWNED = new Set(["launch-grace", "review-grace", "checks-grace", "answer-grace", "local-pause"]);

/** The tick's summary (JSON with `json`, else log lines), as main() reports it; returns the summary. */
export function reportDispatch(result, inputs, { json = false } = {}) {
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
    stopped: result.stopped,
    restarted: result.restarted,
    vanished: result.vanished,
    paused: result.paused,
    sent_back_to_rebase: result.sentBack,
    next_parts: result.nextParts,
    merged: result.merged,
    branches_updated: result.updated,
    merge_queue: result.queue,
    project: result.project,
  };
  if (json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  else {
    log(`objectives ready: ${result.ready.length ? result.ready.map((n) => `#${n}`).join(", ") : "none"}${result.reason ? ` (${result.reason})` : ""}${result.usageError ? ` [usage unreadable: ${result.usageError}]` : ""}`);
    log(`running: ${result.running}, spent today: $${summary.spent_today_usd} of $${inputs.dailyUsd}, blocking from ${result.relationSource}, board: ${result.project ?? "none (labels)"}, merge queue: ${result.queue ? "on (a conflicting PR goes back to the worker once)" : "off (a behind or conflicting PR goes back to the worker once)"}`);
    for (const n of result.vanished) log(`  #${n}: Running with no job alive; Blocked`);
    for (const n of result.paused || []) log(`  #${n}: paused; the local machine holding it is away, and its serve resumes it`);
    for (const n of result.sentBack) log(`  #${n}: behind the default branch; sent back to rebase`);
    for (const s of result.skipped) log(`  skip #${s.number}: ${s.reason}`);
    if (result.ms) log(`dispatch timing: ${timingLine(result.ms)}`);
  }
  return summary;
}

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
  const { readFileSync } = await import("node:fs");
  let payload = {};
  try {
    payload = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")) : {};
  } catch {
    payload = {};
  }
  const eventName = process.env.GITHUB_EVENT_NAME || "";
  if (!(await closedIssueTicks(eventName, payload, { objectiveLabel: inputs.objectiveLabel, objectives: () => listIssuesByLabel(repoOf(inputs.repo), inputs.objectiveLabel, { token }) }))) {
    log(`issue #${payload.issue?.number} closed: not an Objective and blocks none; nothing to do`);
    for (const [k, v] of [["issues", []], ["count", "0"], ["reason", ""], ["queue_watch", ""], ["wake_at", ""], ["wake_kind", ""], ["image_owed", ""]]) setOutput(k, v);
    return;
  }
  const failedLaunch = eventName === "workflow_dispatch" && /^[1-9]\d{0,9}$/.test(String(payload?.inputs?.failed_launch ?? "")) ? Number(payload.inputs.failed_launch) : null;
  const result = await dispatch(inputs, { token, dryRun: args.dry_run === "true", failedLaunch });
  const summary = reportDispatch(result, inputs, { json: !!args.json });
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
    const firedBy = firedByWake(eventName, payload);
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
  // On the sandbox route, an image build an earlier day left owed runs on this tick (the image job's `if:`): the
  // first tick of the UTC day, an event's or a wake's (never a pull request's), not GitHub's nightly cron alone.
  let owed = false;
  if (inputs.sandbox && args.dry_run !== "true" && !inputs.issue && eventName !== "pull_request") {
    owed = await imageOwedNow(repoOf(inputs.repo), { refresh: inputs.imageRefresh, dailyMinutes: inputs.imageDailyMinutes }, { token }).catch((e) => {
      log(`the image record could not be read (${String(e.message).slice(0, 120)}); no owed build this tick`);
      return false;
    });
    if (owed) log("the image is owed a build of the default branch's head (an earlier day left it unbuilt); the image job builds it now");
  }
  setOutput("image_owed", owed ? "true" : "");
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
