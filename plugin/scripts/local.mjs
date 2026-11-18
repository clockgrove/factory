#!/usr/bin/env node
// Pendulum local mode: the same worker and reviewer the Action runs, on a developer's own box.
//   node scripts/local.mjs run <issue> [--repo OWNER/NAME] [--checkout CLONE] [--wait]
//   node scripts/local.mjs review <pr> [--wait]      (a review re-run, as re-applying pendulum:review does on Actions)
//   node scripts/local.mjs serve [--repo OWNER/NAME] [--checkout CLONE] [--once] [--all] [--interval SECONDS (30)]
//   node scripts/local.mjs issue <issue> | deliver <issue> | post-review <pr> <findings.json>   (a session's route)
//   node scripts/local.mjs handover <issue> [--push] [--app ID]   (a person applies Pendulum's workflow hand-over: read it, then --push)
//   node scripts/local.mjs wait [<issue>...] [--since CURSOR] [--on KINDS] [--follow] [--interval S] [--timeout S]   (an orchestrator waits on the queue)
//   node scripts/local.mjs doctor [--json] [--probe] [--verbose] | token set | --version   (readiness check, saving the local token, the release)
// Without --repo, the repository is the clone's origin remote (lib/local.mjs cloneRepo).
// Routing: an Objective labelled pendulum:local is the local loop's and the Actions path leaves it alone;
// serve takes only those unless --all (PENDULUM_LOCAL_ALL=1). Where no Action runs (GitHub lists no active pendulum.yml
// workflow), serve labels each Objective it picks pendulum:local first. A claim comment with a heartbeat marks one in flight.
// Needs git, gh, the harness CLI (claude or codex logged in; copilot with a Copilot Requests token in
// COPILOT_GITHUB_TOKEN or ~/.config/pendulum/copilot-token, plus slirp4netns and iptables on Linux), srt
// (npm i -g @anthropic-ai/sandbox-runtime), ripgrep and, on Linux and WSL2, bubblewrap and socat; and a
// fine-grained token for this one repository, in PENDULUM_LOCAL_TOKEN or ~/.config/pendulum/tokens/<owner>/<name>
// (contents, issues and pull requests read and write; actions and variables read). That token is all the GitHub reach the
// model gets. No App needed (one in PENDULUM_LOCAL_APP_ID posts the notices), no vendor, no API key; GitHub holds
// every piece of state, and the box holds one clone per Objective under <clone>/.pendulum/<issue>/. Pendulum's own setup, install and validation commands run in the
// same sandbox as the harness, since they run on a tree the model edited. A sandbox has no route to the box's
// services: with PENDULUM_LOCAL_DB=1 every validation command runs through plugin/bin/pendulum-db, which starts a fresh
// Postgres inside the sandbox (init step: PENDULUM_LOCAL_DB_INIT), and the task card tells the model to do the same.
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { constants as osConstants, homedir, hostname, platform, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { dispatch } from "./dispatch.mjs";
import { OUTAGE, causeCode, githubOrigin, lostText, minutesText, probe as probeHost, serverDown, serverWait, waitOutages } from "./lib/network.mjs";
import { githubStatus } from "./lib/adapters/github-status.mjs";

/** A paused stage's failed request as serve tells its 5xx pauses apart: the request (`endpoint`) and its host. */
const requestKey = (o) => `${o.origin ?? o.host ?? ""} ${o.endpoint ?? ""}`;
const pausesText = (n) => `${n} pause${n === 1 ? "" : "s"}`;
import { PLUGIN_ROOT, installCommand } from "./lib/checkout.mjs";
import { DEFAULT_DAYS, DEFAULT_MAX_CALLS, PARTIAL_CODES, REPORT_SCHEMA, STOPPED_EXIT, buildReport, readReport, renderReport, reportCheck, reportModels, reportScope } from "./lib/report.mjs";
import { ghLoginToken, activeWorkIssues, addLabels, collaboratorPermission, ensureLabel, hasMergeQueue, findPr, mergeQueueEntry, mergeQueueHeads, findProject, getIssue, getPr, getPrSettled, labeledAtIn, listComments, listIssuesByLabel, markReady, moveCard, postReview, prComment, prDiff, primeSelf, primeWriters, removeLabel, repoOf, rest, setStateLabel, transientError, upsertComment, organizationVariableNames, repositoryVariables } from "./lib/github.mjs";
import { PENDULUM_VERSION, LOCAL_BOUNDS, holdSecrets, input, timeZoneName, localBound, localLimits, log, logTo, postedError, readFlags, redactSecrets, resolveInputs, workflowDriftLines, workflowSettings, MACHINE_FALLBACK_SETTINGS, MACHINE_SETTINGS, MODEL_SETTINGS, ignoredLines, layerLines, machineSettings, organizationVariablesLine, settingLayers } from "./lib/inputs.mjs";
import { logTime, machineZone, whenText, zoneMarker } from "./lib/clock.mjs";
import { localSecretValues, parseSecretValues, parseWorkerSecrets } from "./lib/worker-secrets.mjs";
import { RELAY_SOCKET_DIR_ENV, dropSocketDir, handSocketDir, localRelayDir, readSocketDirRecord } from "./lib/worker-relay.mjs";
import { RELAYED_NAME } from "./lib/gateway-relay.mjs";
import { localCopilotRelayShim } from "./lib/relay-shim.mjs";
import { GROUP_RECORD, STOP_SIGNALS, bootId, exec, processRecord, reapRecorded, sameProcess, whichSync } from "./lib/proc.mjs";
import { HEARTBEAT_MS, parseClaim, LOCAL_DOMAINS, LOCAL_LABEL, adoptLocal, hasLocalLabel, markLocalRoute, isSandboxHost, claudeProjectLink, codexLocalConfig, credentialPaths, harnessLogins, ownLoginProblems, stageLogin, copilotHomeFiles, copilotLocalSettings, copilotPrivateTmp, dropClaim, dropClaudeProjectLink, ensureHarnessHomes, gitDirChanged, gitIdentityKey, gitIdentityReason, gitPinFile, pinGitDir, readGitPin, harnessInstall, writeNestedGitScan, gitGuardScript, harnessOuterSettings, outerProbe, sandboxDroppedHosts, gatewayKeyProblem, localApp, localBaseEnv, previousKeyDirProblem, localClaim, LOCAL_TOKEN_PERMISSIONS, cloneRepo, cloneTop, localToken, prepareClone, tokenFile, variablesRefusedLine, committedWorkflowEnv, committedWorkflowNow, readWorkflowEnv, staleGitLocks, stageTemp, sandboxStartProblems, srtSettings, stopHold, workflowEnv, writeBwrapTun, writeClaim, beatClaim, noTokenLine, repoFromRemote, saveLocalToken } from "./lib/local.mjs";
import { JOB_TOKEN_LOGIN, REVIEW_LABEL, SETUP_QUEUE_TIMEOUT_MIN, spendText, queueHungMs, acceptanceEntries, clip, decideExit, parseReview, planAskedOf, protectedPaths, questionCheckPrompt, reviewOfValue, selfLogin, staleDecision, marker } from "./lib/logic.mjs";
import { HANDOVER_WRITERS, currentPlan, exitFromOut, handoverChecker, handoverOnIssue, inFiles, isSplitPart, nextPart, partsRecord, planSync, postNote, postReplies, publishPr, readOut, recordPart, reviewMissed, reviewPost } from "./lib/handoff.mjs";
import { applyExit, servedSilent, commitAuthor, gitIdentity, mergeBlockCause, mergeBlockReason, mergeReadyOne, queueState, queueTimeoutMin, mirrorDiff, objectiveDecisions, progressReporter, rebaseMarkers, rebaseNotice, rebaseBlock, ownReviewIds, unaddressedReviewComments } from "./lib/session.mjs";
import { checkHandover, openOutbox, scratchHistory } from "./lib/outbox.mjs";
import { HANDOVER_LABEL, WORKFLOWS_DIR, handoverBranch, handoverMarker, handoverOf, shellQuote, workflowName } from "./lib/handover.mjs";
import { appendOwn, dropOwned, privateTmp } from "./lib/fsafe.mjs";
import { git as gitIn } from "./lib/proc.mjs";
import { BACKENDS } from "./lib/backend.mjs";
import { childBilling, runDecision, scrubbedEnv } from "./lib/harness.mjs";
import { modelFamily, passBilling, refusalCause, refusalFields, unknownOf, windowFamily } from "./lib/usage.mjs";
import { choiceOf } from "./lib/choice.mjs";
import { bwrapShim, claudeEnvText, localTools, stageCommands } from "./lib/copilot-runner.mjs";
import { noticeMinter, serveNotices } from "./lib/app-token.mjs";
import { appIdSetLine, appIdWhyText, learnAppId, readLocalAppId } from "./lib/app-id.mjs";
import { answeredRepos, declaredQuestion, planNeeds as planNeedsOf } from "./lib/one-repo.mjs";
import { localDatabaseChecks, noticeAppCheck, pluginVersionCheck } from "./doctor.mjs";
import { RELEASES_URL, checkoutProblem, markInUse, pinDecision, releaseCheckout, runningPendulum, runningName, startProblem } from "./lib/release.mjs";
import { SKIP_SMUDGE_ENV, lfsPinEnv } from "./lib/lfs.mjs";
import { EDITED_REASON, authorGate, foundationTrusted, labelsVouched, objectiveInputs, planStateNow, recordText, settled, startedAt, trustedIssue } from "./lib/objective-trust.mjs";
import { openEditCheck } from "./lib/edit-check.mjs";
import { openCommentCheck } from "./lib/comment-check.mjs";
import { DRAFT_LABEL, goTrust, isDraft, labelTrust, requeuedIn, stopCause } from "./lib/stop.mjs";
import { loopCap, machineBudget, machineLimits, machineRoom, readPressure, slotHolders, slotsDir, takeSlot } from "./lib/machine.mjs";
import { lapseFacts, lapseInput, openLapseCheck } from "./lib/lapse-check.mjs";
import { flushDecisionSpend } from "./lib/decision-spend.mjs";
import { THIRD_PARTY_POLL_MS, waitOf, waitState } from "./lib/third-party-review.mjs";
import { reviewNow, reviewWaitOf } from "./lib/overlap.mjs";
import { runningStint, timelineOf } from "./lib/relaunch.mjs";
import { AUTO_ACCOUNT_ENV, HARNESS_NAMES, STAGE_AUTO_ENV, accountEnv, accountLabels, accountPin, accountReason, accountToken, autoAccountSetting, chooseAccount, defaultAccount, harnessAccounts, implicitAccount, loadAccounts, pinLabelText, pinnedAccount, sandboxRoots, validAccountName } from "./lib/accounts.mjs";
import { lastStage } from "./lib/continue.mjs";
import { PROBE_EVERY_MS, accountHolds, holdsDir, windowOf } from "./lib/holds.mjs";
import { personHolds, releaseRouteHold } from "./lib/route-holds.mjs";
import { WAIT_KINDS, WAIT_POLL_MS, WAIT_TIMEOUT_EXIT, jsonLine, parseCursor, parseKinds, waitQueue } from "./lib/wait.mjs";

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
const onPath = (bin) => whichSync(bin) !== null;
/** An account's key in the readiness checks (Local.harnessReady, Local.accountReady): its harness, name and login. */
const readyKey = (a) => `${a.harness}:${a.name}:${a.home || a.tokenFile || ""}`;
/** How long automatic account choice passes over an account whose harness checks failed before it checks it again. */

/** A finished stage's dollars from its result.json (session.mjs writeUsage): the known figure, its runs of unknown cost and how they are billed. */
export const stageSpendOf = (result) => ({ usd: result?.usd ?? null, usdUnknown: Number.isInteger(result?.usdUnknown) ? result.usdUnknown : 0, usdByBilling: result?.usdByBilling ?? null });

/** The serve log's words on a finished stage (`r`: its exit, code and stageSpendOf): "delivered, $1.20 API-equivalent at list prices, on the subscription". */
export const stageEndText = (r) => `${r.exit ?? `no exit record (code ${r.code})`}${r.usd != null || r.usdUnknown ? `, ${spendText({ usd: r.usd, unknown: r.usdUnknown ?? 0, byBilling: r.usdByBilling })}` : ""}`;

export const UNREADY_RETRY_MS = 10 * 60_000;
/**
 * The models a `stage` runs (objective-trust.mjs objectiveInputs' inputs), whose quota windows automatic choice weighs
 * (usage.mjs quotaWindowApplies): a work stage's worker and sub-agent models; a review stage's reviewer and, for its fix
 * passes, the worker's.
 */
export const stageModels = (inputs, stage) => (stage === "review" ? [inputs?.reviewerModel, inputs?.model] : [inputs?.model, inputs?.subagentModel]).map((m) => m || null);

/** How long an account automatic choice picked counts as just started in this loop before its stage's start is recorded. */
const PICK_MS = 60_000;
/** An account in a hold's log line and reason: the harness alone for the one named after it (none declared). */
const limitName = (harness, account) => (account === harness ? harness : `${harness} account ${account}`);
/**
 * The pause notice's text (Local.pauseNotice, #265): the account a usage limit paused the Objective on (`account`, its
 * name; the harness's own name with none declared), its reset (`reset`, ms) and window (`window`, as the harness named
 * it, or null), and `free`, the names of the harness's other accounts free now, each with its label. `note`: a line
 * about the issue's account labels. `auto`: automatic account choice is on (#266), so the loop moves the Objective to a
 * free account itself. `guessed`: `reset` is the end of a no-reset limit's guess (holds.mjs spent), an estimate, never
 * called a reset: the account's own (#332), or, with none free, the first of every held account's to end. Account names
 * only: no path, no login, no @mention.
 */
export function pauseNoticeBody({ stage = "work", harness, account, reset, window = null, free = [], note = null, auto = false, guessed = false }) {
  const h = HARNESS_NAMES[harness] || harness;
  const who = account === harness ? `${h} (this machine's one ${h} login)` : `${h} account \`${account}\``;
  // The window as the harness named it, only in its own form: harness output never reaches the issue as it is.
  const named = windowOf(window);
  const moves = auto
    ? free.length
      ? `Free now: ${free.map((n) => `\`${n}\``).join(", ")}. This machine chooses accounts by itself, so \`pendulum serve\` here resumes this Objective on a free one at its next tick, with no label; a \`pendulum:account:<name>\` label still pins it to one account.`
      : `No other ${h} account on this machine is free now. This machine chooses accounts by itself, so \`pendulum serve\` here resumes this Objective on the first ${h} account that comes free.`
    : free.length
      ? `Free now: ${free.map((n) => `\`${n}\` (apply \`pendulum:account:${n}\`)`).join(", ")}. Applying one moves this Objective to that account: \`pendulum serve\` on this machine starts its stage there at once, and every later stage runs there while the label stays.`
      : `No other ${h} account on this machine is free now.`;
  const head = guessed
    ? free.length
      ? `Pendulum: the ${stage} stage paused on a usage limit. ${who} reached its limit with no reset reported, and is passed over until about ${whenText(reset)}, an estimate.`
      : `Pendulum: the ${stage} stage paused on a usage limit. Every ${h} account on this machine is held; ${who} reached its limit with no reset reported, and is passed over until about ${whenText(reset)}, an estimate. Pendulum resumes this Objective on this machine then, or sooner on an account that comes free.`
    : `Pendulum: the ${stage} stage paused on a usage limit. ${who} reached it${named ? ` (window \`${named}\`)` : " (its window was not reported)"}, which resets at ${whenText(reset)}; Pendulum resumes this Objective on this machine after then.`;
  return [head, "", moves, ...(note ? ["", note] : [])].join("\n");
}

/**
 * How often a loop writes again the claim of an Objective it holds paused (Local.beatPaused): well inside the dispatcher's
 * bound for a claim gone quiet (claim_pause_hours, at least two hours), at one write an hour (the API quota is shared).
 */
export const PAUSED_BEAT_MS = 60 * 60_000;

/** How often `run --wait` asks whether a stage paused on an outage may resume (waitPaused): serve's default tick. */
export const RESUME_POLL_MS = 30_000;

/**
 * `pendulum run`'s exit status when its Objective is left paused, resumable (runToEnd): EX_TEMPFAIL of sysexits.h, a
 * temporary failure to retry. 0 is delivered (merged, with --wait), 1 any other end.
 */
export const PAUSED_EXIT = 75;

/** A word of a command line as a shell reads it back: as it is, or quoted when it holds anything else. */
const shellWord = (w) => (/^[\w./:@%+=,-]+$/.test(String(w)) ? String(w) : shellQuote(w));

/** The `--repo` and `--checkout` a command was given, as the resume command repeats them (Local.toEnd). */
const whereFlags = (flags, local) => [flags.repo ? ` --repo ${shellWord(flags.repo)}` : "", flags.checkout ? ` --checkout ${shellWord(local.dev)}` : ""].join("");

/** `pendulum run`'s and `pendulum review`'s exit status for the end `r` (Local.toEnd). */
export const runExit = (r) => (r?.exit === "delivered" ? 0 : r?.exit === "paused" ? PAUSED_EXIT : 1);

/** The line for an Objective with more than one account label (#265): it moves nowhere and waits. */
const twoPinsLine = (labels) => `${labels.map(pinLabelText).join(", ")}: more than one account label moves nothing, so the Objective waits, on no account, until one is left`;

/** What a Blocked notice tells a person to do about an account label this machine cannot act on (#265). */
const PIN_FIX = "Apply one `pendulum:account:<name>` naming an account of this Objective's harness that this machine declares (~/.config/pendulum/accounts.json; doctor.mjs --local lists them), as a person who can push, or remove the label to run on the harness's default account; then re-apply `pendulum:objective`.";
/** Whether a stage's result.json shows a pass its provider served (output or credits), with no usage limit ending it. */
/** A usage limit or quota that Blocked it with no reset reported (`limitRefused`) is a refusal too, never a served pass. */
const servedPass = (r) => !r.usageLimit && !r.limitRefused && [r.tokens?.output, r.aiCredits, r.premiumRequests].some((v) => Number(v) > 0);
/**
 * Whether a probe's record (harness.mjs runDecision) shows an answer its provider served: the harness exited clean
 * with a result of its own (Claude Code's `result` event, read as `subtype`: a stream with none takes its last line
 * for one), not ended by Pendulum, and with output or credits (servedPass: a synthetic result reports none).
 */
const probeServed = (rec) => !!rec && rec.ok === true && !rec.noRun && !rec.timedOut && !rec.stopped && rec.exitCode === 0 && (rec.harness !== "claude" || rec.subtype === "success") && servedPass(rec);
/** A pinned release serve could not fetch or start is tried again after this long (followPin). */
export const PIN_RETRY_MS = 10 * 60_000;
/** The least time between two switches to a new pinned release (followPin), so a pin that keeps moving cannot hold the loop. */
export const SWITCH_GAP_MS = 30 * 60_000;
/** The env name a serve that started again on a new release (restartOn) learns when it last switched from. */
const SWITCHED_ENV = "PENDULUM_SERVE_SWITCHED_AT";
/** The env name that tells a serve started again on a new release where it came from, for a failure at its start (main). */
const SWITCHED_FROM_ENV = "PENDULUM_SERVE_SWITCHED_FROM";
const SWITCHED_FROM = process.env[SWITCHED_FROM_ENV] || "";
delete process.env[SWITCHED_FROM_ENV];
/** The first wait before the start's read of the repository's variables is tried again (Local.startVariables). */
export const START_VARIABLES_MS = 15_000;
/** How long serve's start waits on the gh login's read of Pendulum's App id (keepAppId): no rate-limit wait, then on. */
export const APP_ID_READ_MS = 15_000;
/** How many times backfillMark tries to write the mark of a pendulum:local label this process put on. */
const MARK_TRIES = 5;
/** How often a running serve fetches the default branch's workflow (refreshSettings); every tick uses the last read. */
export const SETTINGS_EVERY_MS = 3 * 60_000;

/** The harnesses this process has said run without the outer sandbox. */
const OUTER_SAID = new Set();
/** The repository's command words already named as not visible to the harness's commands (stageEnv, #371): once per loop. */
const TOOLS_SAID = new Set();
/** After a failed start, this loop holds the Objective this long, doubling per failure up to the cap (Local.unstart). */
export const START_BACKOFF_MS = 5 * 60_000;
export const START_BACKOFF_MAX_MS = 60 * 60_000;
/** The failed starts in a row of one Objective on one loop that Block it, with the error, rather than un-mark it again. */
export const START_FAILURES_BLOCK = 3;
/** The free disk space a machine hold on a full disk waits for before new starts resume (Local.machineProbe). */
export const START_DISK_FLOOR = 2 * 1024 ** 3;
/** The system codes of a full disk or a spent disk quota. */
const DISK_CODES = new Set(["ENOSPC", "EDQUOT"]);

/**
 * A failed start's cause, on structure only. `kind`: the claim's read or write (`claim-read`, `claim`), else the step of
 * the stage's set-up that failed (`clone`, `prepare`: the clone's preparation in its sandbox, `setup`: any other).
 * `code`: a system or network code (ENOSPC, ECONNREFUSED), GitHub's HTTP status, a command's exit, or Pendulum's own
 * code; null when the error carries none, and such a failure is never put down to the machine.
 */
export function startCause(e) {
  const kind = e?.startFailed === "work" || !e?.startFailed ? e?.startStep ?? "setup" : e.startFailed;
  const code = causeCode(e) || (Number.isInteger(e?.status) && e.status > 0 ? `HTTP ${e.status}` : "") || (e?.exitCode != null ? `exit ${e.exitCode}` : "") || (typeof e?.code === "string" && /^[a-z][a-z0-9-]*$/.test(e.code) ? e.code : "");
  return { kind, code: code || null };
}

/**
 * What tells that a machine's start fault is gone (Local.machineProbe), by its cause: free disk space for a full disk,
 * the repository read with the local token for a clone (git) or a claim (the API), the sandbox starting for the clone's
 * preparation; with no probe of its own (`retry`), one start is tried again once the backoff ends.
 */
const probesOf = ({ kind, code }) => (DISK_CODES.has(code) ? ["disk"] : kind === "clone" ? ["clone", "disk"] : kind === "prepare" ? ["sandbox", "disk"] : kind === "claim-read" || kind === "claim" ? ["api"] : ["retry"]);
const PROBE_FIX = {
  disk: "free disk space on this machine (the error above names the path)",
  clone: "check this machine's network to github.com, and that the local token still reads the repository",
  api: "check this machine's network to GitHub's API, GitHub's status, and that the local token still reads the repository",
  sandbox: "make the sandbox start again (`pendulum doctor` names what fails)",
  retry: "fix the error above",
};
const PROBE_WAIT = { disk: `${START_DISK_FLOOR / 1024 ** 3} GB free on its disk`, clone: "`git ls-remote` of the repository passing with the local token", api: "GitHub's API reading the repository with the local token", sandbox: "the sandbox starting", retry: "one start tried again after the backoff" };
const gb = (n) => `${(n / 1024 ** 3).toFixed(1)} GB`;
/** How often a machine hold's probe runs at most (Local.machineWait): the sandbox's can take up to a minute. */
export const MACHINE_PROBE_EVERY_MS = 60_000;
/** sandboxStartProblems on one sandboxed `true`, run without blocking the loop (at most a minute). */
const sandboxProblemsNow = async () => {
  const r = await exec("srt", ["--", "true"], { timeoutMs: 60_000 }).catch((error) => ({ code: null, error }));
  return sandboxStartProblems({ start: () => ({ status: r.code, signal: r.signal, stderr: r.stderr, error: r.error }) });
};
export const COPILOT_OUTER_OFF = "local mode runs Copilot only inside the outer sandbox, which does not start on this host";
/** The Blocked reason when Copilot's outer sandbox stopped starting after serve began: fixed text, no probe output. */
export const copilotOuterReason = "local mode: Copilot runs locally only inside the outer sandbox, which no longer starts on this machine (outer-sandbox); the local loop's log says why; run the Objective with PENDULUM_HARNESS=claude or codex, or on the Action";
/** The Blocked reason when the sandboxes' scan for protected paths fails its check at a stage's start (lib/local.mjs writeNestedGitScan). */
export const loginLinkReason = "local mode: a login file of the harness login this stage runs on links into another harness login on this machine (login-link), which the stage's harness would then read; the local loop's log names the path; make that login's files its own";
/** The Blocked reason when a harness-state path Pendulum makes before a stage leads where it may not make it (lib/local.mjs homePlaces). */
export const homeLinkReason = "local mode: a path Pendulum makes in the harness's state folder before each stage leads, through a link, outside the folders this stage's login may write or into a login or credential store, passes a file or a loop of links, or is a file where the harness keeps a folder (home-link); the local loop's log names the path; create it yourself or remove the link";
export const sandboxScanReason = "local mode: the sandboxes' scan for protected paths (ripgrep, sandbox-scan) failed its check on this machine; the local loop's log says why; check that `rg` on PATH runs";
const list = (v) => String(v || "").split(/[\s,]+/).filter(Boolean);

/**
 * Each command's arguments and flags: a flag is `bool` (takes no value), or takes one value named as usage shows it, a
 * positive number where `number` is set. An argument named `issue` or `pr` is a positive whole number.
 */
const WHERE = { repo: { value: "OWNER/NAME" }, checkout: { value: "CLONE" } };
export const COMMANDS = {
  run: { args: ["issue"], flags: { ...WHERE, wait: "bool", verbose: "bool" }, about: `one Objective, from the stage its state calls for (with --wait, to merged, waiting out a network pause as serve does); exits 0 delivered (with --wait, merged), ${PAUSED_EXIT} paused and resumable (its last line names the command), 1 otherwise` },
  serve: { args: [], flags: { ...WHERE, once: "bool", all: "bool", interval: { value: "SECONDS", number: true }, verbose: "bool" }, about: "a loop: the dispatcher's rules every --interval seconds (30); --verbose also names every setting left at Pendulum's defaults" },
  review: { args: ["pr"], flags: { ...WHERE, wait: "bool", verbose: "bool" }, about: `a review re-run (with --wait, to merged, waiting out a network pause as serve does); exits as run does` },
  doctor: { args: [], flags: { ...WHERE, json: "bool", probe: "bool", "run-setup": "bool", verbose: "bool" }, about: "whether this clone, its repository and this machine are ready for local mode, each check PASS, WARN or FAIL with its fix (doctor.mjs --local); exits 1 on a FAIL" },
  token: {
    args: ["set"],
    flags: WHERE,
    usage: "pendulum token set [--repo OWNER/NAME] [--checkout CLONE]",
    check: (f) => (f._[1] !== "set" ? `token takes set, not ${JSON.stringify(f._[1])}` : null),
    about: "save the repository's local token where local mode reads it, owner-only: asked for without echo, or read from stdin; never printed",
  },
  issue: { args: ["issue"], flags: { ...WHERE, out: { value: "PATH" } }, about: "the issue as a session reads it" },
  deliver: { args: ["issue"], flags: { ...WHERE, out: { value: "PATH" } }, about: "Pendulum's half of an Objective worked in a session" },
  "post-review": { args: ["pr", "findings.json"], flags: WHERE, about: "post a session's reviewer pass" },
  handover: { args: ["issue"], flags: { ...WHERE, push: "bool", app: { value: "ID", number: true } }, about: "put Pendulum's workflow hand-over on a new branch and show it, then stop for you to read it (--push: commit, push and open its pull request)" },
  wait: {
    args: [],
    more: "issue",
    flags: { ...WHERE, since: { value: "CURSOR" }, on: { value: "KINDS" }, follow: "bool", interval: { value: "SECONDS", number: true }, timeout: { value: "SECONDS", number: true } },
    check: (f) => (f.since !== undefined && !parseCursor(f.since) ? `--since needs a cursor a line printed or a time with its zone, not ${JSON.stringify(f.since)}` : f.on !== undefined && !parseKinds(f.on) ? `--on takes ${WAIT_KINDS.join(", ")}, not ${JSON.stringify(f.on)}` : null),
    about: `one JSON line per event on the queue (or the issues named): ${WAIT_KINDS.join(", ")}; exits 0 after the first, ${WAIT_TIMEOUT_EXIT} at --timeout (with --follow, keeps going)`,
  },
  report: {
    args: [],
    flags: { ...WHERE, since: { value: "DATE" }, until: { value: "DATE" }, issue: { value: "N[,N...]", many: true }, label: { value: "NAME" }, parent: { value: "N", number: true }, compare: { value: "NAME[,NAME]", many: true }, "compare-label": { value: "LABEL", many: true }, json: "bool", "max-calls": { value: "N", number: true }, by: { value: "account" }, rates: { value: "MODEL[,MODEL...]", many: true }, app: { value: "ID", number: true }, self: { value: "LOGIN", many: true } },
    check: reportCheck,
    about: `cost and token use of a period (--since, --until; the ${DEFAULT_DAYS} days before --until or now, from UTC midnight, by default) or a set of Objectives (--issue, --label, --parent), or two experiment arms side by side (--compare A,B: the pendulum:experiment:<name> labels; --compare-label for any two labels), every figure precomputed (--rates: the ratio of each named model's published rates to each recorded model's of one vendor, on its recorded token mix, no dollar unit): --json for the documented schema (${REPORT_SCHEMA}), else Markdown; prints its planned GitHub calls first and stops at --max-calls (${DEFAULT_MAX_CALLS}), exiting ${STOPPED_EXIT} with what it read`,
  },
  zone: { args: [], flags: {}, about: "this machine's time zone as the hidden line an Objective's body starts with (<!-- pendulum:tz NAME -->), so the times its stages write read in its filer's zone; pendulum-file adds it" },
  hold: {
    args: ["list|release"],
    more: "account",
    flags: { repo: WHERE.repo },
    usage: "pendulum hold list [--repo OWNER/NAME] | pendulum hold release <account> [--repo OWNER/NAME]",
    check: (f) => {
      const [, what, ...others] = f._;
      if (what !== "list" && what !== "release") return `hold takes list or release, not ${JSON.stringify(what)}`;
      if (what === "list" && others.length) return `unexpected argument ${JSON.stringify(others[0])}`;
      if (what === "release" && others.length !== 1) return others.length ? `unexpected argument ${JSON.stringify(others[1])}` : "missing <account>";
      return null;
    },
    about: "the usage-limit holds of this machine's accounts (with --repo, of GitHub Actions and the cloud sandbox), or release one account's: every serve may start on it again at its next tick",
  },
};
const usageOf = (cmd) => COMMANDS[cmd].usage ?? `pendulum ${cmd} ${[...COMMANDS[cmd].args.map((a) => `<${a}>`), ...(COMMANDS[cmd].more ? [`[<${COMMANDS[cmd].more}>...]`] : []), ...Object.entries(COMMANDS[cmd].flags).map(([k, t]) => `[--${k}${t === "bool" ? "" : ` ${t.value}`}]`)].join(" ")}`;
/** The usage text: one command's, or every command's. */
export const usage = (cmd = null) =>
  cmd
    ? `usage: ${usageOf(cmd)}\n  ${COMMANDS[cmd].about}\n`
    : `usage:\n${Object.keys(COMMANDS).map((c) => `  ${usageOf(c)}\n      ${COMMANDS[c].about}\n`).join("")}  pendulum --version\n      this Pendulum release's version\nWithout --repo, the repository is the origin remote of the clone (--checkout, else here).\n`;

/**
 * The command line, checked before anything runs: {help, cmd} for --help or -h anywhere, else {cmd, flags, _}. Throws an
 * error with `usage` set for an unknown command or flag, a flag's missing or non-numeric value, a value given to a flag
 * that takes none, or a missing, extra or non-numeric argument.
 */
export function parseArgs(argv) {
  const cmd = Object.hasOwn(COMMANDS, argv[0] ?? "") ? argv[0] : null;
  if (argv.some((a) => a === "--help" || a === "-h")) return { help: true, cmd };
  if (argv[0] === "--version" && argv.length === 1) return { version: true };
  const fail = (why) => Object.assign(new Error(`${why}\n${usage(cmd)}`), { usage: true });
  if (!cmd) throw fail(argv[0] === undefined ? "no command" : `unknown command ${JSON.stringify(argv[0])}`);
  const spec = COMMANDS[cmd];
  const flags = readFlags(argv.slice(1), spec.flags, fail);
  flags._.unshift(cmd);
  const given = flags._.slice(1);
  if (given.length < spec.args.length || (given.length > spec.args.length && !spec.more)) throw fail(given.length < spec.args.length ? `missing <${spec.args[given.length]}>` : `unexpected argument ${JSON.stringify(given[spec.args.length])}`);
  given.forEach((arg, i) => {
    const name = spec.args[i] ?? spec.more;
    if (name !== "issue" && name !== "pr") return;
    const n = Number(arg);
    if (!/^\d+$/.test(arg) || !Number.isSafeInteger(n) || n <= 0) throw fail(`<${name}> must be a number, not ${JSON.stringify(arg)}`);
  });
  const bad = spec.check?.(flags);
  if (bad) throw fail(bad);
  return { cmd, flags };
}

const readId = (file) => {
  try {
    return readFileSync(file, "utf8").trim().replace(/[^A-Za-z0-9]/g, "").slice(0, 12);
  } catch {
    return "";
  }
};

/** This process's boot (proc.mjs bootId), read once: a boot cannot change while the process runs (macOS reads it with a subprocess). */
let bootRead = null;
export const thisBoot = () => (bootRead ??= { id: bootId() }).id;

/**
 * Who this machine is and which boot it is on, for claim holders: a host name alone is not unique (a devcontainer on
 * host networking, two laptops called the same), and a pid is only meaningful within one boot. Linux gives both ids;
 * elsewhere the machine is its host name and the boot is proc.mjs bootId's (macOS: the boot time's exact second, as
 * liveStage and the slots read it), or none where that is unreadable: a holder's pid is then probed alone.
 */
export function machineIdentity({ boot = thisBoot } = {}) {
  const machine = readId("/etc/machine-id") || readId("/var/lib/dbus/machine-id");
  return { host: hostname(), machine, boot: String(boot() ?? "").replace(/[^A-Za-z0-9]/g, "").slice(0, 12) };
}

/** A loop's claim holder: `host:pid:nonce:machine:boot`. */
export const holderId = (id = machineIdentity(), pid = process.pid) => `${id.host}:${pid}:${randomBytes(3).toString("hex")}:${id.machine}:${id.boot}`;

const parseHolder = (holder) => {
  const [host, pid, , machine = "", boot = ""] = String(holder || "").split(":");
  return { host, pid: Number(pid), machine, boot };
};

/** True when the holder is a loop on this machine (same host name and, where known, the same machine id). */
export function sameMachineHolder(holder, id = machineIdentity()) {
  const h = parseHolder(holder);
  return h.host === id.host && h.machine === id.machine;
}

/**
 * A claim left by a loop on this machine whose process is gone (serve stopped, crashed, the machine restarted): its
 * Objective is this machine's to resume at once, fresh heartbeat or not.
 */
export function deadHereHolder(holder, { id = machineIdentity(), self = process.pid, own = null } = {}) {
  if (!sameMachineHolder(holder, id)) return false;
  const { pid, boot } = parseHolder(holder);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  // This process's pid: its own loop (`own`) is alive; any other holder with it was the loop this process ran before it
  // started again on a new pinned release (Local.restartOn), whose image is gone.
  if (pid === self) return !!own && holder !== own;
  // Another boot: every process of that one is gone, whatever pid now runs.
  if (boot && boot !== id.boot) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return e.code === "ESRCH";
  }
}

/**
 * The repository's settings (the default branch's workflow and the repository's variables) a running serve takes at its
 * next tick (refreshSettings): how many run, on which models and effort (held with the harness when it changes), what
 * validation runs, how a session resumes and its cache, whether hand-offs wait for siblings, how many rebases a PR
 * gets, how long a usage limit with no reset passes its account over and the zone visible times are written in. One this shell sets (inputs.mjs
 * machineSettings) keeps the shell's value whatever the repository says. What a stage may reach or receive, spend, protect or be set up with, and
 * the harness, are taken only when serve starts.
 */
export const HOT_SETTINGS = ["PENDULUM_MAX_CONCURRENT", "PENDULUM_LOCAL_MAX_CONCURRENT", "PENDULUM_MODEL", "PENDULUM_SUBAGENT_MODEL", "PENDULUM_REVIEWER_MODEL", "PENDULUM_EFFORT", "PENDULUM_REVIEWER_EFFORT", "PENDULUM_VALIDATION", "PENDULUM_LOCAL_VALIDATION", "PENDULUM_RESUME_POLICY", "PENDULUM_PROMPT_CACHE_TTL", "PENDULUM_SIBLING_HOLD", "PENDULUM_REBASE_LIMIT", "PENDULUM_GUESS_HOURS", "PENDULUM_TIME_ZONE"];

// The zone this shell set when serve started (inputs.mjs MACHINE_FALLBACK_SETTINGS), before takeZone wrote the repository's.
const SHELL_ZONE = process.env.PENDULUM_TIME_ZONE;
/**
 * Serve's own visible times (its log, the notices it posts) in the zone its stages write theirs in (lib/clock.mjs
 * timeZone reads PENDULUM_TIME_ZONE from this process's env): the repository's settings in force (`wf`), else this
 * shell's own (`shell`), else none.
 */
export function takeZone(wf, env = process.env, shell = SHELL_ZONE) {
  const zone = wf?.PENDULUM_TIME_ZONE || shell;
  if (zone) env.PENDULUM_TIME_ZONE = zone;
  else delete env.PENDULUM_TIME_ZONE;
}

/**
 * What changed between two sets of the repository's settings (settingLayers's values), one `NAME: old → new` each, in
 * name order, with the layer the new value comes from when `layers` (settingLayers's `from`) is given; one this shell
 * sets (inputs.mjs machineSettings: a PENDULUM_LOCAL_* name, the harness, models and session settings) says that the
 * shell's value still wins, as in baseEnv. Values are the workflow's or a variable's own (no secret is ever one: `${{ }}`
 * values are not read), cut at 80 characters.
 */
export function settingsChanges(before = {}, after = {}, env = process.env, layers = null) {
  const shell = machineSettings(env, after);
  const show = (v) => (v === undefined ? "unset" : JSON.stringify(v.length > 80 ? `${v.slice(0, 77)}...` : v));
  const layer = (k) => (!layers ? "" : after[k] === undefined ? " (Pendulum's default)" : layers[k] === "variable" ? " (repository variable)" : " (workflow)");
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((k) => before[k] !== after[k])
    .sort()
    .map((k) => `${k}: ${show(before[k])} → ${show(after[k])}${layer(k)}${k in shell ? " (this shell sets it, and its value wins)" : ""}`);
}

export { repoFromRemote };

/**
 * Why local mode cannot start here, one line each. `outer` is lib/local.mjs outerProbe: Copilot runs locally only inside
 * the outer sandbox, since its own sandbox applies its file policy only best-effort, so on a host where that does not
 * start (macOS, or Linux without what its sandbox's network needs) local Copilot is refused before any claim.
 * `wf` is the workflow's settings and `env` this shell's, which wins (as in baseEnv); `os` is the platform; `account` the
 * one the loop starts on (lib/accounts.mjs), whose probe result outerProbe keeps apart from every other account's.
 */
export function preflight(harness, repoFull, token, copilotToken, { outer = outerProbe, wf = {}, env = process.env, os = platform(), account = null } = {}) {
  const problems = [];
  if (!onPath("git")) problems.push("git is not on PATH; install git (https://git-scm.com/downloads)");
  if (!onPath("gh")) problems.push("gh is not on PATH; install the GitHub CLI (https://cli.github.com)");
  if (!onPath("srt")) problems.push("srt is not on PATH; Pendulum's own commands run in it (npm i -g @anthropic-ai/sandbox-runtime)");
  if (!onPath("rg")) problems.push("rg (ripgrep) is not on PATH; the sandbox needs it");
  if (platform() === "linux") for (const bin of ["bwrap", "socat"]) if (!onPath(bin)) problems.push(`${bin} is not on PATH; the sandbox needs it (sudo apt-get install -y bubblewrap socat)`);
  const startProblems = platform() === "linux" && onPath("srt") && onPath("bwrap") ? sandboxStartProblems() : [];
  problems.push(...startProblems);
  if (platform() === "win32") problems.push("native Windows has no sandbox for the harness; run local mode inside WSL2");
  // macOS's sandbox has no network namespace of its own: a throwaway Postgres there would listen on the box's loopback.
  // Whichever source set it: the shell's value, else the workflow's (baseEnv), which every stage then runs with.
  if (os === "darwin" && (env.PENDULUM_LOCAL_DB ?? wf.PENDULUM_LOCAL_DB ?? "") === "1") problems.push("PENDULUM_LOCAL_DB runs on Linux and WSL2 only: macOS's sandbox shares the box's loopback, so a throwaway database would be reachable from outside it");
  problems.push(...harnessProblems(harness, copilotToken, { outer, sandboxStarts: !startProblems.length, account, env: account ? accountEnv(env, account) : env }));
  if (!token) problems.push(noTokenLine(repoFull));
  return problems;
}

/** How to put each harness's CLI on PATH, for the line that says it is missing. */
const HARNESS_INSTALL = {
  claude: "install Claude Code (npm i -g @anthropic-ai/claude-code) and log in (claude, then /login)",
  codex: "install Codex (npm i -g @openai/codex) and log in (codex login)",
  copilot: "install GitHub Copilot CLI (npm i -g @github/copilot)",
};

/**
 * Why one harness cannot run here, one line each: the loop's own at its start (preflight), and another an Objective's
 * harness label names before its first stage on this machine (Local.harnessFor). `sandboxStarts`: whether srt's sandbox
 * starts here (preflight's own check), without which Copilot's outer sandbox is not probed. `account`: the one the
 * harness runs on, for outerProbe; `env` that account's (lib/accounts.mjs accountEnv), which the probe runs on.
 */
export function harnessProblems(harness, copilotToken, { outer = outerProbe, sandboxStarts = true, account = null, env: given = process.env } = {}) {
  const problems = [];
  if (!["claude", "codex", "copilot"].includes(harness)) return [`unknown harness ${harness}`];
  if (!onPath(harness)) problems.push(`${harness} is not on PATH; ${HARNESS_INSTALL[harness]}`);
  if (harness === "copilot") {
    // Copilot's sandbox reads its policy from its own home, so the developer's `copilot login` is not used there.
    if (!copilotToken) problems.push(`no Copilot token: create a fine-grained token with the Copilot Requests permission and save it to ${copilotTokenFile()} (chmod 600) or export COPILOT_GITHUB_TOKEN`);
    // Without these Copilot's sandbox cannot start, and every command fails while the run still exits 0.
    if (platform() === "linux") for (const bin of ["slirp4netns", "iptables", "iptables-restore", "ip6tables", "ip6tables-restore"]) if (!onPath(bin)) problems.push(`${bin} is not on PATH; Copilot's sandbox needs it (sudo apt-get install -y slirp4netns iptables)`);
    // Probed only where it can start at all; off Linux outerProbe answers without starting anything.
    if (platform() !== "linux" || (["srt", "bwrap", "copilot"].every(onPath) && sandboxStarts)) {
      // Without the developer's own COPILOT_HOME: the probe makes and seeds the home it is given, and Pendulum leaves theirs alone.
      const { COPILOT_HOME: _own, ...env } = given;
      const o = outer("copilot", { env, account });
      if (!o.on) problems.push(`${COPILOT_OUTER_OFF}: ${o.why}; use PENDULUM_HARNESS=claude or codex locally, or run Copilot Objectives on the Action${o.cacheFile ? ` (a yes is kept in ${o.cacheFile})` : ""}`);
    }
  }
  return problems;
}

export const copilotTokenFile = (home = homedir()) => join(home, ".config", "pendulum", "copilot-token");
function copilotToken() {
  if (process.env.COPILOT_GITHUB_TOKEN) return process.env.COPILOT_GITHUB_TOKEN.trim();
  const f = copilotTokenFile();
  return existsSync(f) ? readFileSync(f, "utf8").trim() : "";
}
/** The Copilot token a stage on `account` runs on: a declared account's file alone, else copilotToken(). */
const copilotTokenOf = (account) => (account?.declared ? accountToken(account) : copilotToken());
/**
 * A stage's output, relayed line by line to its log file and this terminal, with every held secret (inputs.mjs
 * holdSecrets: the worker secrets' values) redacted. Whole lines only: a value split across two chunks is redacted
 * once its line is complete. `end()` relays a last line with no newline.
 */
export function stageRelay({ logFile, prefix, write = (s) => process.stdout.write(s) }) {
  let partial = "";
  const emit = (raw) => {
    const line = redactSecrets(raw);
    appendOwn(logFile, `${line}\n`);
    if (line.trim()) write(`${prefix} ${line}\n`);
  };
  return {
    push: (chunk) => {
      const parts = `${partial}${chunk}`.split("\n");
      partial = parts.pop();
      for (const p of parts) emit(p);
    },
    end: () => {
      if (partial) emit(partial);
      partial = "";
    },
  };
}

/** Local settings for this process only, never copied into a stage's env: the token, where the App's key is, and automatic account choice. */
const HOST_ONLY = ["PENDULUM_LOCAL_TOKEN", "PENDULUM_LOCAL_APP_ID", "PENDULUM_LOCAL_APP_KEY", AUTO_ACCOUNT_ENV];

/** How often serve tries a refused local token again (a 401 GitHub gave for a moment); tests lower it. */
export const REFUSED_PROBE = { ms: 60_000 };

/** Where the local token comes from, to name in a log line: the variable or the file, never the value. */
const tokenSource = (repoFull) => (process.env.PENDULUM_LOCAL_TOKEN ? "PENDULUM_LOCAL_TOKEN (then start serve again)" : tokenFile(repoFull));

/** Whether a listed repository's `permissions` (its person's, as GitHub lists them) let that person push to it. */
const personPushes = (p) => !!(p.push || p.maintain || p.admin);

/**
 * The token can write to this repository and nothing else. A fine-grained token lists another private repository only
 * when it was granted it, so any listed private one but this refuses it outright, with no probe. It also lists every
 * public repository it may read, with its person's permissions on each, not the token's. The token can push only where
 * its person can, and can open issues on a public repository only when it was granted it, which needs that repository
 * to share its resource owner with this one. So a listed public repository is probed when its person can push to it
 * (push, maintain or admin), when this repository's owner owns it, or when it is listed with no permissions; others are
 * out of its write reach. A probe is an issue with no title, refused before anything is created, with 422 where the token
 * may write and 403 or 404 where it may not. A listing that fails, more than `max` repositories to probe
 * (PENDULUM_LOCAL_TOKEN_PROBE_MAX), or a probe that gets any other answer refuses the token, since its reach is then
 * unknown; that error carries `again`, as a check worth making again later. GitHub's rate limit on a probe ends the
 * check there: one probe at a time, each thrown at once rather than waited out, and no probe after it.
 */
export async function checkToken(repoFull, token, { max = LOCAL_BOUNDS.PENDULUM_LOCAL_TOKEN_PROBE_MAX.fallback } = {}) {
  if (!token.startsWith("github_pat_")) throw new Error("the local token must be a fine-grained token limited to this repository; a classic token or a gh login reaches every repository you can");
  const unknownReach = (message) => Object.assign(new Error(message), { again: true });
  let reach;
  try {
    reach = await rest("user/repos?per_page=100", { token, paginate: true });
  } catch (e) {
    throw unknownReach(`the repositories the local token can reach could not be listed (${e.rateLimited ? "GitHub's rate limit" : e.status || String(e.message).slice(0, 80)}), so its reach is not verified`);
  }
  const others = (Array.isArray(reach) ? reach : []).filter((r) => String(r?.full_name || "").toLowerCase() !== repoFull.toLowerCase());
  const secret = others.filter((r) => r.private === true).map((r) => r.full_name);
  if (secret.length) throw new Error(`the local token can reach ${secret.length} other private repositor${secret.length === 1 ? "y" : "ies"} (${secret.slice(0, 3).join(", ")}${secret.length > 3 ? ", ..." : ""}); limit it to ${repoFull}`);
  const owner = repoFull.split("/")[0].toLowerCase();
  const sameOwner = (r) => String(r.full_name).split("/")[0].toLowerCase() === owner;
  const toProbe = others.filter((r) => !r.permissions || typeof r.permissions !== "object" || personPushes(r.permissions) || sameOwner(r)).map((r) => r.full_name);
  if (toProbe.length > max) throw new Error(`the local token lists ${toProbe.length} other repositories it could write to, more than the ${max} Pendulum probes for write access (PENDULUM_LOCAL_TOKEN_PROBE_MAX); make a token whose repository access is limited to ${repoFull}, or raise the setting`);
  const writable = [];
  const unknown = [];
  for (const name of toProbe) {
    const status = await rest(`repos/${name}/issues`, { token, method: "POST", body: {}, noRateWait: true }).then(
      () => 201,
      (e) => (e.rateLimited ? "rate limited" : e.status || 0),
    );
    if (status === 422 || status === 201) writable.push(name);
    else if (status !== 403 && status !== 404) unknown.push(`${name}: ${status || "no answer"}`);
    if (status === "rate limited") break;
  }
  if (writable.length) throw new Error(`the local token can write to ${writable.length} other repositor${writable.length === 1 ? "y" : "ies"} (${writable.slice(0, 3).join(", ")}${writable.length > 3 ? ", ..." : ""}); limit it to ${repoFull}`);
  if (unknown.length) throw unknownReach(`the local token's write access to ${unknown.length} other repositor${unknown.length === 1 ? "y" : "ies"} could not be probed (${unknown.slice(0, 3).join(", ")}${unknown.length > 3 ? ", ..." : ""}); try again`);
}

/** The issue a PR is a review trigger for: on pendulum/<issue>, labelled pendulum:review, not a draft; else 0. */
export const reviewIssue = (pr) => (pr?.draft || !(pr?.labels || []).some((l) => l.name === REVIEW_LABEL) ? 0 : Number(/^pendulum\/(\d+)$/.exec(pr?.head?.ref || "")?.[1]) || 0);
/**
 * The issue a PR may be an answered Question's review cue for (#339): on pendulum/<issue>, open, out of draft and not
 * labelled for review (that is reviewIssue's); else 0. pendingReviews checks the issue is a Question and a ready mark.
 */
export const readyIssue = (pr) => (!pr || pr.draft || pr.state === "closed" || labelled(pr, REVIEW_LABEL) ? 0 : Number(/^pendulum\/(\d+)$/.exec(pr.head?.ref || "")?.[1]) || 0);
/**
 * Whether the PR was marked ready after the issue last became a Question (`askedAt`, its last pendulum:question label):
 * a Question's exit drafts the PR before it labels the issue, so a PR GitHub kept out of draft then has no mark after it.
 */
export const readyAfter = (prEvents, askedAt) => !!askedAt && (prEvents || []).some((e) => e?.event === "ready_for_review" && Date.parse(e.created_at) > Date.parse(askedAt));
/** An issue labelled pendulum:blocked. */
export const isBlocked = (issue) => (issue?.labels || []).some((l) => (typeof l === "string" ? l : l.name) === "pendulum:blocked");
const labelled = (item, name) => (item?.labels || []).some((l) => (typeof l === "string" ? l : l.name) === name);

/**
 * The stage an Objective's state calls for when a loop takes it up (serve's resume, `pendulum run`): "review" for its open,
 * non-draft PR labelled for review; "work" while the issue is Running; "merge" while it is In review with an open,
 * non-draft PR (reviewed, waiting for its merge); else null. `pr` is the open PR on pendulum/<issue>, or null.
 */
export function stageFor({ pr, issue }) {
  const open = pr && pr.state !== "closed" && !pr.draft;
  if (open && labelled(pr, REVIEW_LABEL)) return "review";
  if (labelled(issue, "pendulum:running")) return "work";
  if (open && labelled(issue, "pendulum:in-review")) return "merge";
  return null;
}

/**
 * Stop the harness runs a dead stage of this Objective left on this machine (proc.mjs reapRecorded: each named in a
 * file in its stage's usage directory, verified before any signal). Returns how many were stopped.
 */
export function reapLeftRuns(ws) {
  let n = 0;
  let dirs = [];
  try {
    dirs = readdirSync(ws).filter((d) => d.startsWith("usage-"));
  } catch {
    return 0;
  }
  for (const d of dirs) {
    let files = [];
    try {
      files = readdirSync(join(ws, d)).filter((f) => GROUP_RECORD.test(f));
    } catch {
      continue;
    }
    for (const f of files) if (reapRecorded(join(ws, d, f))) n += 1;
  }
  return n;
}

/** The file in a stage's usage directory that names its process while it runs (proc.mjs processRecord). */
export const STAGE_RECORD = "stage-process.json";

/** Whether a stage running `script` with this env relays the gateway key: the work and review stages that opt it in. */
export const relaysGatewayKey = (script, env) => (script === "worker.mjs" || script === "review.mjs") && parseWorkerSecrets(input("worker_secrets", { env })).entries.some((e) => e.name === RELAYED_NAME);

/**
 * Remove the gateway relay socket directories dead stages of this Objective left (lib/worker-relay.mjs handSocketDir's
 * record in each usage directory): a stage whose process (STAGE_RECORD) is gone, or, where it never started, whose loop is.
 * A live one, or one whose process cannot be told, is left. Returns how many were removed.
 */
export function reapSocketDirs(ws, opts = {}) {
  let n = 0;
  let dirs = [];
  try {
    dirs = readdirSync(ws).filter((d) => d.startsWith("usage-"));
  } catch {
    return 0;
  }
  for (const d of dirs) {
    const usageDir = join(ws, d);
    const rec = readSocketDirRecord(usageDir);
    if (!rec) continue;
    let stage = null;
    try {
      stage = JSON.parse(readFileSync(join(usageDir, STAGE_RECORD), "utf8"));
    } catch {
      // never started, or ended
    }
    if (sameProcess(stage ?? rec.owner) !== false) continue;
    if (dropSocketDir(usageDir, opts)) n += 1;
  }
  return n;
}

/**
 * A stage of this Objective still running on this machine (this loop's own, or one whose loop died), as {pid, file,
 * sure}, or null. A stage counts as running when its record's process is still that process (`sure`), or cannot be told
 * apart from it (its start time unread or unrecorded): two stages on one clone is worse than a refusal. A record is
 * removed only when its process is known gone.
 */
export function liveStage(ws) {
  let dirs = [];
  try {
    dirs = readdirSync(ws).filter((d) => d.startsWith("usage-"));
  } catch {
    return null;
  }
  for (const d of dirs) {
    const file = join(ws, d, STAGE_RECORD);
    let rec = null;
    try {
      rec = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    const same = sameProcess(rec);
    if (same !== false) return { pid: rec?.pid, file, sure: same === true };
    rmSync(file, { force: true });
  }
  return null;
}

/** What a start says when it finds a stage of the Objective running here (liveStage), and how to clear it. */
export const liveStageLine = (issue, live) =>
  live.sure
    ? `#${issue}: a stage of this Objective is running on this machine (pid ${live.pid}); stop it (kill ${live.pid}, which pauses it) or let it end`
    : `#${issue}: ${live.file} names pid ${live.pid} as a running stage of this Objective, and this machine cannot tell whether it still is; if pid ${live.pid} is no Pendulum worker, delete that file`;

/** A GitHub read, tried `tries` times with a growing wait; then an error that names it and says nothing was started. */
async function retried(what, fn, { tries = 3, waitMs = 2_000 } = {}) {
  for (let i = 1; ; i += 1) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries) throw new Error(`${what} failed ${tries} times (${String(e?.message || e).slice(0, 160)}); nothing was started, run it again`);
      await new Promise((r) => setTimeout(r, waitMs * i));
    }
  }
}

/**
 * serve's line for the Queued Objectives it does not take because they lack pendulum:local (dispatch's `unrouted`): how
 * many, which, and what to do. `action`: actionState's answer, "live" (the Action takes them) or null (unread).
 */
export function unroutedLine(numbers, action) {
  const n = numbers.length;
  const shown = numbers.slice(0, 10).map((x) => `#${x}`).join(", ") + (n > 10 ? ` and ${n - 10} more` : "");
  const head = `${n} queued Objective${n === 1 ? "" : "s"} without ${LOCAL_LABEL} (${shown})`;
  if (action !== "live") return `${head}: this loop takes only Objectives labelled ${LOCAL_LABEL}, and whether an Action runs them could not be read; add ${LOCAL_LABEL} to one to run it on this machine`;
  return `${head} ${n === 1 ? "is" : "are"} the Action's: its pendulum.yml workflow is active. To run one on this machine instead, add ${LOCAL_LABEL} to it. (serve --all is for a repository whose Action should not run Objectives: with the Action active, both would race for every Objective without ${LOCAL_LABEL})`;
}

/**
 * Whether GitHub's Action runs Objectives in `repo` (#455), from the repository's workflow list (one read): "live" when
 * it lists .github/workflows/pendulum.yml as active, "none" when it lists it disabled or deleted, or answers with the
 * whole list and no such workflow; null for anything else (a failed read, a 404 or 403 a token without Actions read
 * gets, a list cut short, an unknown state): unknown, which changes nothing.
 */
export async function readActionState(repo, opts) {
  const list = await rest(`repos/${repo.full}/actions/workflows?per_page=100`, { ...opts, noRateWait: true }).catch(() => null);
  if (!list || !Array.isArray(list.workflows)) return null;
  const w = list.workflows.find((x) => x?.path === ".github/workflows/pendulum.yml");
  if (!w) return Number(list.total_count) === list.workflows.length ? "none" : null;
  return w.state === "active" ? "live" : /^(disabled_\w+|deleted)$/.test(w.state ?? "") ? "none" : null;
}

/** The start's line when this plugin, which runs every stage here, is older than the release the committed workflow pins; else null. */
export function pluginLine(committed) {
  const c = committed?.text ? pluginVersionCheck(committed.text) : null;
  return c?.status === "WARN" ? `${c.detail}; ${c.fix}` : null;
}

export class Local {
  constructor(flags) {
    // This process is the local backend: the dispatcher it runs in-process routes pendulum:local Objectives here.
    process.env.PENDULUM_LOCAL = "1";
    if (flags.all) process.env.PENDULUM_LOCAL_ALL = "1";
    // Canonical, so every sandbox path derived from it is real (lib/local.mjs refuses one that resolves elsewhere).
    this.dev = cloneTop(resolve(flags.checkout || process.cwd()));
    this.repoFull = cloneRepo(this.dev, flags.repo);
    this.verbose = !!flags.verbose;
    this.repo = repoOf(this.repoFull);
    // The workflow's settings as committed on the default branch (#122), never this working tree's, whatever branch is
    // checked out: as the Action runs the reviewed workflow. A working tree that differs is named (doctor too).
    const committed = committedWorkflowEnv(this.dev);
    // serve reads the default branch's workflow again at each tick (refreshSettings), and follows its Pendulum pin (followPin).
    this.settingsBranch = committed.branch;
    this.pins = committed.pins || [];
    // A workflow that does not parse holds settings no one can read (protected paths, maintainers, caps): nothing starts.
    if (committed.parseError) throw new Error(`local mode reads its settings from the default branch's .github/workflows/pendulum.yml: ${committed.error}; fix the file on ${committed.branch} and start again`);
    if (committed.error) log(`local mode reads its settings from the default branch's .github/workflows/pendulum.yml: ${committed.error}, so it uses none`);
    for (const line of workflowDriftLines(readWorkflowEnv(this.dev), committed)) log(line);
    const plugin = pluginLine(committed);
    if (plugin) log(plugin);
    // The workflow file is repository content: only its settings reach a stage, never a name Pendulum reads as its own
    // control (#119). Every other PENDULUM_* name in it is dropped and named here (doctor warns too).
    const wf = workflowSettings(committed.wf);
    if (wf.dropped.length) log(`.github/workflows/pendulum.yml: ${wf.dropped.join(", ")} ${wf.dropped.length === 1 ? "is" : "are"} no Pendulum setting; left out of every stage`);
    this.workflowWf = wf.kept;
    this.wf = wf.kept;
    takeZone(this.wf);
    this.token = localToken(this.repoFull);
  }

  /**
   * Whether the Action runs Objectives here (readActionState, for this loop's repository, --repo's when given), read at
   * most once per settings interval (SETTINGS_EVERY_MS) and kept across an unknown read. Said when it is first known and
   * when it changes: with none, the Objectives this loop picks without pendulum:local get the label (dispatch `adopt`).
   */
  async actionState() {
    const every = this.settingsEveryMs ?? SETTINGS_EVERY_MS;
    if (this.actionReadAt !== undefined && Date.now() - this.actionReadAt < every) return this.action ?? null;
    this.actionReadAt = Date.now();
    const now = await readActionState(this.repo, this.opts ?? { token: this.token });
    if (now === null) {
      if (this.action === undefined && !this.actionUnreadSaid) log(`whether GitHub's Action runs Objectives in ${this.repoFull} could not be read (its pendulum.yml workflow): this loop takes only those labelled ${LOCAL_LABEL} until it can`);
      this.actionUnreadSaid = true;
      return this.action ?? null;
    }
    if (now !== this.action) {
      if (now === "none") log(`no Action runs Objectives in ${this.repoFull} (no active pendulum.yml workflow): this loop takes the Objectives without ${LOCAL_LABEL} too, and labels each ${LOCAL_LABEL} as it picks it`);
      else if (this.action === "none") log(`GitHub's Action runs Objectives in ${this.repoFull} now (its pendulum.yml workflow is active): it takes the Objectives without ${LOCAL_LABEL}; those labelled ${LOCAL_LABEL} stay this machine's`);
    }
    this.action = now;
    return now;
  }

  /**
   * Pendulum's mark of the pendulum:local label this process itself put on `issue` (serve's pick or `pendulum run`, left in
   * `unmarked` when its own write could not be made: a failed post, a timeline that did not show the event yet), written
   * at the claim's start and its heartbeats (lib/local.mjs markLocalRoute), so the scorer counts the label as Pendulum's.
   * Only those: Pendulum posts as the developer here, so any other pendulum:local label of this login may be their own,
   * and stays a person's action. Ends when the mark is there, a person put the label on now, or after MARK_TRIES reads
   * that show no such label event; an adoption whose loop stopped first stays unmarked, a person's action in the score.
   */
  async backfillMark(issue) {
    if (!this.unmarked?.has(issue)) return;
    const tries = (this.markTries ??= new Map());
    const r = await markLocalRoute(this.repo, issue, this.opts ?? { token: this.token }, { check: true, timeline: (repo, n, opts) => timelineOf(repo, n, { ...opts, cache: (this.timelines ??= new Map()) }) });
    const tried = (tries.get(issue) ?? 0) + 1;
    tries.set(issue, tried);
    if (r.marked || r.person || tried >= MARK_TRIES) {
      this.unmarked.delete(issue);
      if (!r.marked && !r.person) log(`#${issue}: Pendulum's mark of its ${LOCAL_LABEL} label is still not written after ${tried} tries (${r.why}); the label counts as a person's action`);
      return;
    }
    if (tried === 1) log(`#${issue}: Pendulum's mark of its ${LOCAL_LABEL} label is not written yet (${r.why}); tried again at the next heartbeat, up to ${MARK_TRIES} times`);
  }

  /** Labels `issue` pendulum:local, said once, when no Action runs here: `pendulum run` on it, as serve's pick does (#455). */
  async adoptForRun(issue, data) {
    if (hasLocalLabel(data) || (await this.actionState()) !== "none") return;
    await adoptLocal(this.repo, issue, this.opts ?? { token: this.token }).then(
      (m) => {
        if (!m.marked) (this.unmarked ??= new Set()).add(issue);
        log(`#${issue}: labelled ${LOCAL_LABEL}, since no Action runs Objectives here: this machine's loop tends it${m.marked ? "" : `; Pendulum's mark of that label is not written yet (${m.why}), so a later tick of the loop that holds it writes it`}`);
      },
      (e) => log(`#${issue}: ${LOCAL_LABEL} could not be added (${String(e?.message || e).slice(0, 120)}); add it, or no loop tends this Objective's merge while none runs here`),
    );
  }

  /**
   * The settings this loop starts with (#284): the workflow's, under the repository's variables (readVariables, read just
   * before), each named with its layer, this machine's own over both; then what they decide: the harness and its account,
   * what must hold before anything starts, and the App that posts the notices.
   */
  takeSettings() {
    this.startSettings();
    this.harness = (process.env.PENDULUM_HARNESS || this.wf.PENDULUM_HARNESS || "claude").toLowerCase();
    // This machine's declared accounts (lib/accounts.mjs): the loop's harness starts on its default one, checked here as
    // every stage checks them again; a declaration that cannot be used starts nothing, naming the accounts only.
    const accounts = loadAccounts({ home: homedir(), env: process.env, roots: sandboxRoots(this.dev) });
    this.startAccount = accounts.ok ? defaultAccount(accounts, this.harness) : implicitAccount(this.harness);
    // Automatic account choice (#266): this shell's setting only, read once; off, every stage runs on its pin or default.
    const auto = autoAccountSetting(process.env);
    this.auto = auto.on;
    if (auto.problem) log(auto.problem);
    if (auto.on) log(`${AUTO_ACCOUNT_ENV}=1: a stage with no account label starts on a free account of its harness, the one limited least recently, then in turn`);
    this.copilotToken = this.harness === "copilot" ? copilotTokenOf(this.startAccount) : "";
    const problems = accounts.ok ? [] : accounts.problems.map((p) => `account ${p.account} (~/.config/pendulum/accounts.json): ${p.why}`);
    problems.push(...preflight(this.harness, this.repoFull, this.token, this.copilotToken, { wf: this.wf, account: this.startAccount }));
    // The Pendulum App, when configured, posts the notices (#2522). Its key stays in this process: a stage asks for a
    // notice token over its IPC channel (stage()), and nothing else, env or file, carries the key or the token.
    const startEnv = accountEnv(process.env, this.startAccount);
    const { app, problem } = localApp(startEnv, homedir(), this.harness);
    if (problem) problems.push(problem);
    const gateway = gatewayKeyProblem(startEnv, homedir(), this.harness);
    if (gateway) problems.push(gateway);
    const previous = previousKeyDirProblem(homedir());
    if (previous) problems.push(previous);
    if (problems.length) throw new Error(`local mode cannot start:\n- ${problems.join("\n- ")}`);
    this.logSettings();
    this.notice = app ? noticeMinter({ appId: app.id, privateKey: app.key, owner: this.repo.owner, repo: this.repo.name }) : null;
    // `project`: the board's node id from the repository's settings (github.mjs findProject), read when a call is made.
    const settings = () => this.wf || {};
    this.opts = {
      token: this.token,
      notice: this.notice,
      get project() {
        return settings().PENDULUM_PROJECT || "";
      },
    };
    // One holder id per loop: two loops (two boxes, or run beside serve) never share or clear each other's claim. A serve
    // that started again on its workflow's pinned release, in its own process, gets a new one: the claims of the loop it
    // was are a dead loop's (deadHereHolder), resumed at once as after any restart.
    this.holder = holderId();
    // This machine's usage-limit holds, per account (lib/holds.mjs): shared with every serve here and kept across restarts.
    this.holds = accountHolds({ dir: holdsDir(homedir()), onError: (e) => log(`a usage-limit hold could not be kept in ${holdsDir(homedir())} for the machine's other serves (${String(e?.message || e).slice(0, 160)}); this loop still holds it`) });
    // When this process last switched releases (restartOn), if it did, within the last day: the next switch waits SWITCH_GAP_MS.
    const switched = Number(process.env[SWITCHED_ENV]);
    this.switchedAt = Number.isFinite(switched) && switched <= Date.now() && Date.now() - switched < 24 * 60 * 60_000 ? switched : 0;
    delete process.env[SWITCHED_ENV];
    this.firstSetup = new Map();
    this.children = new Set();
    // Where the machine's stage budget, its slots and its load are read (lib/machine.mjs): shared by every loop here.
    this.machine = { home: homedir(), proc: "/proc" };
    this.excludeWorkspaces();
  }

  /** The repository's settings this loop starts with: the workflow's, the repository's variables over them (`variables`, readVariables's). */
  startSettings() {
    const layers = settingLayers({ workflow: this.workflowWf, variables: this.variables || {} });
    this.wf = layers.values;
    takeZone(this.wf);
    this.from = layers.from;
    this.ignoredKey = ignoredLines(layers).join("\n");
  }

  /**
   * The start's settings, logged once nothing stops the start (takeSettings): each one set, named once with its layer,
   * this machine's own included, and each variable ignored. Every setting left at Pendulum's default is named only with
   * --verbose (`verbose`); with none set and none ignored, nothing is said.
   */
  logSettings(verbose = this.verbose) {
    const lines = layerLines(settingLayers({ workflow: this.workflowWf, variables: this.variables || {}, machine: machineSettings(process.env) }), { defaults: !!verbose });
    if (!lines.length) return;
    log(`settings, each over the one below (Pendulum's defaults, the workflow${this.settingsBranch ? ` on origin/${this.settingsBranch}` : ""}, the repository's variables, this machine)${verbose ? "" : "; --verbose names the ones left at Pendulum's defaults too"}:`);
    for (const line of lines) log(`  ${line}`);
  }

  /**
   * A bounded local setting (inputs.mjs LOCAL_BOUNDS) as this loop takes it now: this machine's environment over the
   * repository's settings; a value it cannot take is its default, logged once.
   */
  bounded(name) {
    const r = localBound(name, process.env[name] ?? this.wf?.[name]);
    if (r.problem && !(this.boundSaid ??= new Set()).has(r.problem)) {
      this.boundSaid.add(r.problem);
      log(r.problem);
    }
    return r.value;
  }

  /**
   * The local token as its source holds it now, for a running loop: "" (with the reason logged, once per reason) when
   * its file is reached through a symbolic link (lib/local.mjs tokenPlaceProblem), so the loop keeps the token it has.
   */
  tokenNow() {
    try {
      const token = localToken(this.repoFull);
      // Read cleanly: a link that comes back later is said again.
      this.tokenPlaceSaid = null;
      return token;
    } catch (e) {
      if (this.tokenPlaceSaid !== e.message) log(`the local token is not read again: ${e.message}`);
      this.tokenPlaceSaid = e.message;
      return "";
    }
  }

  /**
   * The settings (takeSettings, after the repository's variables), the token check, `serve`'s App id copy (keepAppId)
   * and the routing label.
   */
  async init({ serve = false } = {}) {
    await this.startVariables({ serve });
    this.takeSettings();
    await checkToken(this.repoFull, this.token, { max: this.bounded("PENDULUM_LOCAL_TOKEN_PROBE_MAX") });
    if (serve) await this.keepAppId();
    if (this.notice) {
      const minted = await this.notice().catch((e) => {
        throw new Error(`local mode cannot start: the Pendulum App (PENDULUM_LOCAL_APP_ID ${process.env.PENDULUM_LOCAL_APP_ID}) gave no token for ${this.repoFull}: ${e.message.slice(0, 200)}; check the id, the key, and that the App is installed on this repository`);
      });
      log(`notices post as ${minted.appSlug}[bot]`);
      const c = noticeAppCheck(minted);
      log(`${c.status} ${c.name}: ${c.detail}`);
    }
    // Before any run: a repository that uses Postgres needs PENDULUM_LOCAL_DB=1 here, or its database commands fail (#2601).
    for (const c of localDatabaseChecks({ checkout: this.dev, env: process.env, wf: this.wf })) log(`${c.status} ${c.name}: ${c.detail}${c.status !== "PASS" ? ` — fix: ${c.fix}` : ""}`);
    this.codexSelfTest(this.harness, accountEnv(process.env, this.startAccount));
    await ensureLabel(this.repo, LOCAL_LABEL, "0e8a16", "Pendulum: run this Objective in a developer's local loop, not on Actions", this.opts).catch((e) => log(`label ${LOCAL_LABEL}: ${e.message.slice(0, 120)}`));
    return this;
  }

  /**
   * Codex reports success even when its sandbox cannot start (the command just never runs), so a local Codex loop
   * first runs one command under the same profile, which must run and must fail to write the home directory.
   */
  codexSelfTest(harness = this.harness, env = process.env) {
    if (harness !== "codex") return;
    const probe = 'f="$HOME/.pendulum-sandbox-check"; if touch "$f" 2>/dev/null; then rm -f "$f"; exit 9; fi';
    try {
      execFileSync("codex", ["sandbox", ...codexLocalConfig({ domains: this.domains(), clone: this.dev, env }), "--", "sh", "-c", probe], { cwd: this.dev, env, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
    } catch (e) {
      const why = e.status === 9 ? "a command in it could write the home directory" : `it does not run here (${String(e.stderr || e.message).trim().slice(0, 200)})`;
      throw new Error(`local mode cannot start: Codex's sandbox is not confining: ${why}`);
    }
  }

  /**
   * The harness an Objective's stage runs on here (objective-trust.mjs objectiveInputs): its harness and model labels
   * over this loop's settings, read before the stage's sandbox is set up for it, and the hosts its approved host labels
   * open (`hosts`: stageEnv sets this stage's sandboxes up with them). Another harness than the loop's is checked on this
   * machine as the loop's own was at its start (harnessReady), on the account the stage runs on: the one its
   * `pendulum:account:<name>` label pins it to (pinFor, #265; its labeler read afresh at each stage start), else its
   * harness's default (accountFor). A pin this machine cannot act on (an untrusted labeler, a name no account of its
   * harness has) Blocks; two pins start nothing ({ok: false, wait}: the Objective waits, never Blocked). With automatic
   * account choice on (#266) and no pin, the account is chosen (autoAccount, `auto`) among those ready here, preferring
   * the one the Objective's last stage here paused on (pausedOn; `own`, this stage's usage directory, is not that stage),
   * then the one its last stage here ran on while that stage's prompt cache is warm (warmOn), its quota ranked for the
   * models `stage` runs (stageModels);
   * with none of its harness's accounts ready, it Blocks naming them.
   * {ok, harness, hosts, account, pinned, pin, auto} or {ok: false, reason, fix} or {ok: false, wait}.
   */
  async harnessFor(issue, { own = null, stage = "work" } = {}) {
    const env = this.baseEnv();
    const args = { repo: this.repoFull };
    await primeWriters(this.repo, this.opts, { maintainers: resolveInputs({ args, env }).maintainers });
    const chosen = await objectiveInputs({ repo: this.repo, issue, args, env, opts: this.opts });
    if (!chosen.ok) return chosen;
    const harness = chosen.inputs.harness;
    let account;
    let pin;
    let auto = false;
    let unready = null;
    try {
      account = this.accountFor(harness);
      pin = await this.pinFor(issue, chosen.names, harness);
      if (this.auto && !pin.account && !pin.problem && !pin.two) {
        const pick = this.autoAccount(harness, { prefer: this.pausedOn(issue, own), warm: this.warmOn(issue, own), models: stageModels(chosen.inputs, stage), pick: true });
        if (pick.account) [account, auto] = [pick.account, true];
        else unready = pick.unready;
      }
    } catch (e) {
      // Only a declaration that cannot be used Blocks, with its fixed reason; any other failure is Pendulum's own.
      if (e?.code !== "account" || typeof e.reason !== "string") throw e;
      log(`#${issue}: refusing to run: ${e.message}`);
      return { ok: false, reason: e.reason, fix: "Fix those accounts in ~/.config/pendulum/accounts.json on this machine (doctor.mjs --local names what is wrong with each), then re-apply `pendulum:objective`." };
    }
    if (pin.problem) {
      // A Block: the kept labeler check goes with it, so whatever is applied next is read afresh.
      this.pinTrusts?.delete(issue);
      return { ok: false, reason: `local mode: ${pin.problem}, so no stage of it starts`, fix: PIN_FIX };
    }
    // Two account labels: no move, to the default or anywhere else. The stage does not start; the Objective waits.
    if (pin.two) return { ok: false, wait: twoPinsLine(pin.two) };
    this.pinClear(issue);
    if (unready) {
      // Each account's problems are in this machine's log already (accountReady); GitHub gets the names alone.
      const h = HARNESS_NAMES[harness] || harness;
      log(`#${issue}: no ${h} account can run here: ${unready.map((u) => u.name).join(", ")}`);
      return { ok: false, reason: `local mode on this machine cannot run ${h} on any of its accounts (${unready.map((u) => `\`${u.name}\``).join(", ")}); the loop's log names what is missing for each`, fix: "Set those accounts' logins up on this machine (doctor.mjs --local checks each), then re-apply `pendulum:objective`." };
    }
    if (pin.account) account = pin.account;
    const problems = this.harnessReady(harness, account);
    if (!problems.length) return { ok: true, harness, hosts: chosen.hosts, account, ...(pin.account ? { pinned: true, pin: pin.label } : {}), ...(auto ? { auto } : {}) };
    // What is missing stays in this machine's log: a path or a probe's output never reaches GitHub (block()).
    log(`#${issue}: ${harness} cannot run here: ${problems.join("; ")}`);
    return { ok: false, reason: `local mode on this machine cannot run ${harness}, which this Objective's harness label asks for; the loop's log names what is missing`, fix: "Set that harness up on this machine (doctor.mjs --local with PENDULUM_HARNESS set to it names what is missing) and re-apply `pendulum:objective`, or run the Objective where that harness is set up." };
  }

  /**
   * The account a `harness` stage runs on (lib/accounts.mjs): its default, from this machine's declaration read and
   * checked afresh. Throws (code `account`, `reason` the Blocked reason naming the accounts alone) when any declared
   * account cannot be used; the why, which names no path either, goes to this machine's log.
   */
  accountFor(harness) {
    return defaultAccount(this.loadedAccounts(), harness);
  }

  /**
   * The account a `harness` stage with no account label runs on with automatic choice on (#266; lib/accounts.mjs
   * chooseAccount): a free one (no hold, limitUntil), `prefer` first when it is free, then `warm` (warmOn), else by the
   * readings kept with the holds (#391): one never measured, then one with a reading, then one that reports nothing
   * (holds.mjs reportsNothing); within each, the fewest stages started since its reading (holds.mjs startsSince, and this
   * loop's picks of the last PICK_MS, whose stages are still starting), then the most quota left for `models` (holds.mjs
   * left); then the one limited least recently, then the one started on least recently (the machine's round-robin, kept
   * with the holds, and those picks); with every one held, the one whose hold ends first. Held includes a
   * no-reset limit's guess (holds.mjs spent). Of those, the first that is ready here (accountReady); one that is not is
   * passed over. `pick`: a stage starts on it, so this loop counts it as just started meanwhile. {account, unready:
   * [{name, problems}]}, account null when none is ready. Throws as accountFor.
   */
  autoAccount(harness, { prefer = null, warm = null, models = [], pick = false } = {}) {
    const now = (this.clock ?? Date.now)();
    const list = harnessAccounts(this.loadedAccounts(), harness);
    const holds = new Map(list.map((a) => [a, this.holdOf(a)]));
    // This loop's picks whose stages have not started yet (startedOn takes one off), of the last PICK_MS.
    const pending = (key) => (this.picked?.get(key) || []).filter((t) => t > now - PICK_MS);
    const store = (a) => this.holdStore(holds.get(a));
    const opts = {
      until: (a) => this.limitUntil(holds.get(a), { guess: true }),
      left: (a) => store(a).left(holds.get(a).key, now, models),
      silent: (a) => store(a).reportsNothing(holds.get(a).key, now),
      startsSince: (a) => store(a).startsSince(holds.get(a).key, now) + pending(holds.get(a).key).length,
      limitedAt: (a) => store(a).limitedAt(holds.get(a).key, now),
      startedAt: (a) => Math.max(store(a).startedAt(holds.get(a).key, now) ?? -Infinity, ...pending(holds.get(a).key)),
      prefer,
      warm,
    };
    const left = [...list];
    const unready = [];
    while (left.length) {
      const a = chooseAccount(left, opts);
      const problems = this.accountReady(harness, a);
      if (!problems.length) {
        if (pick) (this.picked ??= new Map()).set(holds.get(a).key, [...pending(holds.get(a).key), now]);
        return { account: a, unready };
      }
      unready.push({ name: a.name, problems });
      left.splice(left.indexOf(a), 1);
    }
    return { account: null, unready: list.map((a) => unready.find((u) => u.name === a.name)).filter(Boolean) };
  }

  /**
   * Why `account` cannot run a `harness` stage here (harnessReady), for automatic choice: a failure is kept for
   * UNREADY_RETRY_MS, so a broken login is not probed at every start, and logged once until it changes or clears.
   */
  accountReady(harness, account) {
    const key = readyKey(account);
    const now = (this.clock ?? Date.now)();
    const seen = this.unready?.get(key);
    if (seen && now < seen.until) return seen.problems;
    const problems = this.harnessReady(harness, account);
    if (!problems.length) {
      this.unready?.delete(key);
      return [];
    }
    const text = problems.join("; ");
    if (seen?.text !== text) log(`${limitName(harness, account.name)} cannot run here: ${text}; automatic account choice passes it over, and checks it again in ${minutesText(UNREADY_RETRY_MS)}`);
    (this.unready ??= new Map()).set(key, { until: now + UNREADY_RETRY_MS, problems, text });
    return problems;
  }

  /** Whether automatic choice passes `account` over now: its harness checks failed within UNREADY_RETRY_MS (accountReady). */
  knownUnready(account) {
    return (this.unready?.get(readyKey(account))?.until ?? 0) > (this.clock ?? Date.now)();
  }

  /**
   * A stage starts on `account` now (its process is about to run): the round-robin automatic choice reads (autoAccount),
   * kept with the holds. The start records of names this machine no longer declares go.
   */
  startedOn(account) {
    const hold = this.holdOf(account);
    const store = this.holdStore(hold);
    store.started({ harness: account.harness, account: hold.key, now: (this.clock ?? Date.now)() });
    // One of this loop's picks of it has started: it counts in the start record from here on.
    const left = (this.picked?.get(hold.key) || []).slice(1);
    if (left.length) this.picked.set(hold.key, left);
    else this.picked?.delete(hold.key);
    try {
      store.forgetStarts(Object.values(this.loadedAccounts().accounts).flat().map((a) => a.name));
    } catch {
      // a declaration that cannot be used: kept until it can be read
    }
  }

  /**
   * The name of the account the Objective's newest earlier stage on this machine (continue.mjs lastStage; `own` is the
   * stage starting now) ran on when that stage ended paused on its usage limit, else null: automatic choice resumes it
   * there when that account is free, where its harness session carries over (a Codex thread does nowhere else).
   */
  pausedOn(issue, own = null) {
    const r = lastStage(this.ws(issue), own)?.result;
    return r?.exit === "paused" && r.usageLimit && typeof r.account === "string" ? r.account : null;
  }

  /**
   * The name of the account the Objective's newest earlier stage on this machine ran on while that stage's prompt cache
   * is still warm (its `result.json` `cacheWarmUntil`, session.mjs cacheWarmUntil: its last pass's end plus the cache
   * lifetime Pendulum sets), else null: automatic choice keeps the Objective there while it is free (#391).
   */
  warmOn(issue, own = null) {
    const r = lastStage(this.ws(issue), own)?.result;
    return typeof r?.account === "string" && Number.isSafeInteger(r.cacheWarmUntil) && r.cacheWarmUntil > (this.clock ?? Date.now)() ? r.account : null;
  }

  /** This machine's account declaration, read and checked afresh (loadAccounts); throws as accountFor says. */
  loadedAccounts() {
    const loaded = loadAccounts({ home: homedir(), env: process.env, roots: sandboxRoots(this.dev) });
    if (loaded.ok) return loaded;
    const why = loaded.problems.map((p) => `account ${p.account}: ${p.why}`).join("; ");
    throw Object.assign(new Error(`this machine's account declaration cannot be used: ${why}`), { code: "account", reason: accountReason(loaded.problems) });
  }

  /**
   * The account an Objective's `pendulum:account:<name>` label pins its `harness` stages to (#265), from `names`, the
   * issue's labels as last read: {account} (null with no label: the harness's default), {account: null, two} (more than
   * one label: no move, the Objective waits) or {account: null, problem} (a fixed line naming the label: one whose latest
   * labeler cannot push, or a name that is no account of this harness on this machine). The labeler is read from the
   * timeline before any account is named. `at`: the issue's `updated_at` from the read `names` came from, which keys the
   * kept labeler check (pinTrust, the per-tick paths); with none (a stage start) it is read afresh. Throws as accountFor
   * does on a declaration that cannot be used, and on a failed read.
   */
  async pinFor(issue, names, harness, at = null) {
    const pin = accountPin(names);
    if (pin.two) return { account: null, two: pin.two };
    if (!pin.label) return { account: null };
    // A name that is no account name: no read, and nothing of the label echoed.
    if (!validAccountName(pin.name)) return { account: null, problem: `${pinLabelText(pin.label)} names no account` };
    const untrusted = await this.pinTrust(issue, pin.label, at);
    if (untrusted) return { account: null, problem: untrusted };
    const r = pinnedAccount(this.loadedAccounts(), harness, pin.name);
    return r.problem ? { account: null, problem: r.problem } : { account: r.account, label: pin.label };
  }

  /**
   * Why Pendulum does not act on account label `label` on `issue` (objective-trust.mjs labelsVouched: its latest
   * labeler, or with `event` "unlabeled" its latest remover, cannot push and is no pinned maintainer), or null. With `at`
   * (the issue's `updated_at` as a listing read it) the answer is kept for that label, event and `at`: any change to the
   * issue's labels moves `at`, so a label removed and applied again is read afresh. With no `at`, always read. A read
   * that fails is not kept, and throws.
   */
  async pinTrust(issue, label, at = null, event = "labeled") {
    const key = `${event}:${label}@${at}`;
    const seen = at ? this.pinTrusts?.get(issue) : null;
    if (seen?.key === key) return seen.refused;
    const refused = await labelsVouched(this.repo, issue, [label], this.opts, {}, event === "labeled" ? "Pendulum does not move the Objective to that account" : "Pendulum does not move the Objective off that account", event);
    if (at) (this.pinTrusts ??= new Map()).set(issue, { key, label, event, refused });
    return refused;
  }

  /**
   * The kept answer for account label `label` on `issue` at `at` (pinTrust), or, with none, a read started in the
   * background (once at a time per issue; `pinReading` holds it) for the next tick, and undefined meanwhile.
   */
  pinTrustKept(issue, label, at) {
    const seen = this.pinTrusts?.get(issue);
    if (at && seen?.key === `labeled:${label}@${at}`) return seen.refused;
    if (!at || !this.repo || this.pinReading?.has(issue)) return undefined;
    const read = this.pinTrust(issue, label, at).catch((e) => log(`#${issue}: who applied \`${label}\` could not be read (${String(e?.message || e).slice(0, 120)}); read again next tick`));
    (this.pinReading ??= new Map()).set(issue, read.finally(() => this.pinReading.delete(issue)));
    return undefined;
  }

  /**
   * A line about an Objective's account labels in this loop's log, once while it holds (pinClear forgets it), and on
   * the issue (pinNote) when `note`. Returns whether it was said now.
   */
  async saidPin(issue, line, { note = false } = {}) {
    const said = (this.pinSaid ??= new Map()).get(issue) ?? new Set();
    if (said.has(line)) return false;
    said.add(line);
    this.pinSaid.set(issue, said);
    log(`#${issue}: ${line}`);
    if (note) await this.pinNote(issue, line);
    return true;
  }

  /** The Objective's account labels are fine again: a problem said before is said again if it comes back. */
  pinClear(issue) {
    this.pinSaid?.delete(issue);
  }

  /**
   * A line about the issue's account labels on the issue: on the pause notice while the Objective is paused on a usage
   * limit here, else as that comment's only text. A write that fails is logged.
   */
  async pinNote(issue, line) {
    const pause = this.offline?.get(issue)?.harness ? this.pauses?.get(issue) : null;
    if (pause) return this.pauseNotice(issue, { ...pause, note: line });
    if (!this.repo) return;
    this.pauseBodies?.delete(issue);
    await upsertComment(this.repo, issue, marker(issue, "account-limit"), `Pendulum: ${line}.`, this.opts).catch((e) => log(`#${issue}: the account note could not be written (${String(e?.message || e).slice(0, 120)})`));
  }

  /**
   * Why `harness` cannot run on this machine on `account` (local.mjs harnessProblems, the App key, the gateway key,
   * Codex's sandbox), each checked with that account's login; a yes is kept per account.
   */
  harnessReady(harness, account = implicitAccount(harness)) {
    const key = readyKey;
    this.ready ??= new Set([key(this.startAccount ?? implicitAccount(this.harness))]);
    if (this.ready.has(key(account))) return [];
    const env = accountEnv(process.env, account);
    const problems = harnessProblems(harness, harness === "copilot" ? copilotTokenOf(account) : "", { account, env });
    const app = localApp(env, homedir(), harness).problem;
    const gateway = gatewayKeyProblem(env, homedir(), harness);
    for (const p of [app, gateway]) if (p) problems.push(p);
    if (!problems.length && harness === "codex") {
      try {
        this.codexSelfTest(harness, env);
      } catch (e) {
        problems.push(e.message.replace(/^local mode cannot start: /, ""));
      }
    }
    if (!problems.length) this.ready.add(key(account));
    return problems;
  }

  /** <clone>/.pendulum/ never shows up in the developer's git status. */
  excludeWorkspaces() {
    const file = resolve(this.dev, sh("git", ["-C", this.dev, "rev-parse", "--git-path", "info/exclude"]));
    const current = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (!current.split("\n").includes("/.pendulum/")) appendFileSync(file, `${current && !current.endsWith("\n") ? "\n" : ""}/.pendulum/\n`);
  }

  ws(issue) {
    return join(this.dev, ".pendulum", String(issue));
  }

  /** The Objective label this repository's workflow names (pendulum:objective by default). */
  objectiveLabel() {
    return resolveInputs({ args: { repo: this.repoFull }, env: this.baseEnv() }).objectiveLabel;
  }

  /**
   * The hosts this machine's sandboxes allow: LOCAL_DOMAINS and PENDULUM_LOCAL_DOMAINS for every Objective, plus `hosts`,
   * those one Objective's approved host labels open for its own stage (harnessFor), never another's.
   */
  domains(hosts = []) {
    return [...new Set([...LOCAL_DOMAINS, ...list(process.env.PENDULUM_LOCAL_DOMAINS || this.wf.PENDULUM_LOCAL_DOMAINS), ...hosts.filter(isSandboxHost)])];
  }

  /** One clone per Objective, kept between stages so the dependencies and the transcript wait for the next one. Cloned without blocking heartbeats. */
  async ensureClone(issue) {
    const dir = join(this.ws(issue), "repo");
    const pin = gitPinFile(this.ws(issue));
    if (existsSync(join(dir, ".git"))) {
      if (readGitPin(pin)) return dir;
      // A clone made before Pendulum pinned its .git cannot be trusted to hold the .git it cloned: made afresh.
      log(`#${issue}: the clone has no pinned .git identity; cloning it again`);
      rmSync(dir, { recursive: true, force: true });
    }
    mkdirSync(this.ws(issue), { recursive: true });
    const started = Date.now();
    const helper = "!f() { echo username=x-access-token; echo \"password=$PENDULUM_LOCAL_TOKEN\"; }; f";
    const code = await new Promise((done) => {
      // The token goes to https://github.com only (the empty entry clears every inherited helper, for any host).
      const child = spawn("git", ["-c", "credential.helper=", "-c", `credential.https://github.com.helper=${helper}`, "clone", "-q", "--reference-if-able", this.dev, "--dissociate", `https://github.com/${this.repoFull}.git`, dir], { env: { ...localBaseEnv(process.env), PENDULUM_LOCAL_TOKEN: this.token, ...SKIP_SMUDGE_ENV }, stdio: ["ignore", "inherit", "inherit"] });
      child.on("close", done);
    });
    if (code !== 0) throw Object.assign(new Error(`git clone of ${this.repoFull} failed (exit ${code})`), { startStep: "clone", exitCode: code });
    pinGitDir(dir, pin);
    // The Objective's first stage on this machine pays for this clone and a cold install: reported apart (worker.mjs).
    this.firstSetup.set(issue, Date.now() - started);
    return dir;
  }

  /** The env every child starts from: an allow-list plus the repository's PENDULUM_* settings, never the whole shell. */
  baseEnv() {
    const wf = { ...this.wf };
    // Host-only settings stay out of a stage's env from the workflow too, not only from this shell.
    for (const k of HOST_ONLY) delete wf[k];
    // The workflow's models belong to its harness: a developer who picks another one locally gets that one's defaults.
    if ((wf.PENDULUM_HARNESS || "claude").toLowerCase() !== this.harness) for (const k of MODEL_SETTINGS) delete wf[k];
    // The developer's own harness, model and session settings win over the repository's (inputs.mjs MACHINE_SETTINGS).
    // The zone visible times are written in is the shell's only where the repository's names none (MACHINE_FALLBACK_SETTINGS).
    for (const k of MACHINE_SETTINGS) if (k !== "PENDULUM_HARNESS" && process.env[k] && !(wf[k] && MACHINE_FALLBACK_SETTINGS.includes(k))) wf[k] = process.env[k];
    // A worker secret's NAME or SOURCE never joins every stage's env through PENDULUM_LOCAL_ENV (lib/local.mjs localBaseEnv).
    const env = { ...localBaseEnv(process.env, list(process.env.PENDULUM_LOCAL_ENV || this.wf.PENDULUM_LOCAL_ENV), { workerSecrets: wf.PENDULUM_WORKER_SECRETS || "" }), ...wf };
    // The developer's own PENDULUM_LOCAL_* settings win over the workflow's.
    for (const [k, v] of Object.entries(process.env)) if (k.startsWith("PENDULUM_LOCAL_") && !HOST_ONLY.includes(k)) env[k] = v;
    // The Pendulum App's id alone (never its key), so a stage knows the notices its App posted (answer-check.mjs pendulumNotice).
    const appId = String(process.env.PENDULUM_LOCAL_APP_ID || "").trim();
    return { ...env, ...(/^\d+$/.test(appId) ? { PENDULUM_NOTICE_APP_ID: appId } : {}), PENDULUM_HARNESS: this.harness, PENDULUM_LOCAL: "1", PENDULUM_LOCAL_ALL: process.env.PENDULUM_LOCAL_ALL || "" };
  }

  /**
   * One stage's env: the base, the scoped token, and the sandbox both the harness and Pendulum's own commands run in.
   * `stageTmp` is the stage's own temp directory (stage() makes it and removes it on every path). `script`: the stage's.
   * `account`: the one it runs on (harnessFor), else its harness's default (accountFor, which throws code `account`).
   */
  stageEnv(issue, usageDir, clone, stageTmp, script = null, harness = this.harness, hosts = [], account = null) {
    account ??= this.accountFor(harness);
    // This machine's env with the account's login set explicitly (lib/accounts.mjs accountEnv): every check and setting
    // below is made for that login, and serve's own environment never picks it.
    const host = accountEnv(process.env, account);
    const ws = this.ws(issue);
    // The hosts this machine's sandboxes allow, with the ones this Objective's approved host labels open (harnessFor).
    const domains = this.domains(hosts);
    // The package managers' caches, one set per Objective: the sandboxes cannot write the developer's own (pnpm's
    // store sits in the home directory), and a cache shared between Objectives would let one plant code in another.
    // pnpm and Bun hardlink from theirs, which only works on the clone's own mount (each writable directory is a
    // separate mount in the sandboxes): those two live in the clone's node_modules, which every tool already skips.
    const npmCache = join(ws, "npm-cache");
    const yarnCache = join(ws, "yarn-cache");
    // Corepack keeps the package-manager versions a repository pins (packageManager) in ~/.cache/node/corepack, which no
    // sandbox may write: a version not already there failed every install. Each Objective gets its own, filled from the registry.
    const corepackHome = join(ws, "corepack");
    const pnpmStore = join(clone, "node_modules", ".pnpm-store");
    const bunCache = join(clone, "node_modules", ".bun-cache");
    const caches = [npmCache, yarnCache, corepackHome];
    // The caches outside the clone are Pendulum's; the two inside it, and srt's protected paths, are made in the clone's
    // own sandbox before the stage starts (stage(): prepareClone), never by this process.
    for (const d of caches) mkdirSync(d, { recursive: true });
    // The settings Pendulum's own commands run under sit outside every writable directory: in the usage directory
    // the model could loosen the sandbox its own validation runs in.
    const sandboxDir = join(ws, ".sandbox");
    mkdirSync(sandboxDir, { recursive: true });
    const srtFile = join(sandboxDir, `srt-${basename(usageDir)}.json`);
    // The stage's usage directory is Pendulum's (its record, the event log, the transcript copy): every sandbox may read
    // it (pendulum-db is in its bin), none may write it.
    // Linux: the ripgrep srt and Claude Code's sandbox scan with, which leaves a nested checkout's .git writable, so a resumed
    // stage can replace one (lib/local.mjs nestedGitScanScript). In the usage directory, which no sandbox may write: srt and
    // Claude Code run it outside their sandboxes. Checked as it is written; a failed check Blocks (sandboxScanReason).
    // An rg in or linked into a directory a sandbox may write is refused (the stage Blocks).
    const ripgrep = platform() === "linux" ? writeNestedGitScan(join(usageDir, "scan"), undefined, { writable: [clone, ...caches, stageTmp, join(usageDir, "harness")] }) : null;
    // Every harness login on this machine, the one this stage runs on denied by its login files only (lib/local.mjs
    // credentialPaths): one list for Pendulum's commands and, through PENDULUM_LOCAL_SANDBOX, the harness's own sandbox. A
    // Copilot stage runs on a home Pendulum makes, which holds no login.
    // A login file of the stage's own that really is another login's (a link planted in its folder) would be read by its
    // harness: the stage refuses, naming the path in this machine's log only.
    const linked = harness === "copilot" ? [] : ownLoginProblems(harness, host);
    if (linked.length) throw Object.assign(new Error(`the ${harness} login this stage runs on leads into another login: ${linked.map((l) => `${l.path} -> ${l.real}`).join(", ")}`), { code: "login-link" });
    const credentials = credentialPaths(homedir(), host, { own: harness === "copilot" ? null : stageLogin(harness, host) });
    writeFileSync(srtFile, JSON.stringify(srtSettings({ domains, writable: [clone, ...caches, stageTmp], clone, credentials, readOnly: [usageDir], ripgrep }), null, 2));
    // Pendulum's own git work on the clone (backend.mjs sandbox.git): the clone writable, its .git included; no network.
    const srtGitFile = join(sandboxDir, `srt-git-${basename(usageDir)}.json`);
    writeFileSync(srtGitFile, JSON.stringify(srtSettings({ domains: [], writable: [clone, stageTmp], credentials, readOnly: [usageDir] }), null, 2));
    // Pendulum's helpers (pendulum-db) are copied into the stage's usage directory and lead PATH: Claude Code's sandbox
    // shows nothing under the home directory beyond the working and added directories, so plugin/bin is out of its sight.
    const binDir = join(usageDir, "bin");
    mkdirSync(binDir, { recursive: true });
    // Only the sandbox's own helpers: the `pendulum` front end (local mode itself) has no business inside a stage.
    for (const tool of readdirSync(join(PLUGIN_ROOT, "bin")).filter((t) => t !== "pendulum")) {
      copyFileSync(join(PLUGIN_ROOT, "bin", tool), join(binDir, tool));
      chmodSync(join(binDir, tool), 0o755);
    }
    // git-lfs installed under the home directory (~/.local/bin, a version manager) is out of the harness sandboxes' sight,
    // and git runs it for every commit and push of a repository that uses LFS: the stage gets its own copy.
    const lfs = whichSync("git-lfs");
    if (lfs && realpathSync(lfs).startsWith(`${homedir()}/`)) {
      copyFileSync(lfs, join(binDir, "git-lfs"));
      chmodSync(join(binDir, "git-lfs"), 0o755);
    }
    const base = accountEnv(this.baseEnv(), account);
    // The stage runs on its own harness's login folder alone (lib/local.mjs stageLogin): the other harness's variable stays out.
    for (const [h, k] of [["claude", "CLAUDE_CONFIG_DIR"], ["codex", "CODEX_HOME"]]) if (h !== harness) delete base[k];
    // A stage that relays the gateway key (lib/worker-relay.mjs): its socket's directory, made here so the outer sandbox
    // written below names it, and handed to the stage, from this loop alone. A private one when the per-user directory is
    // refused; none when /tmp itself is refused, and the stage then Blocks naming why. Removed when the stage ends
    // (stage()), or by a later loop's reap when this one dies with it (reapSocketDirs).
    delete base[RELAY_SOCKET_DIR_ENV];
    let socketDir = null;
    if (relaysGatewayKey(script, base)) {
      try {
        const m = handSocketDir(usageDir);
        socketDir = base[RELAY_SOCKET_DIR_ENV] = m.dir;
        if (m.refused) log(`#${issue}: the gateway relay's socket goes in a private directory: ${m.refused}`);
      } catch (e) {
        log(`#${issue}: no directory for the gateway relay's socket: ${String(e?.message || e).slice(0, 200)}`);
      }
    }
    const addDirs = [...caches, stageTmp];
    // Linux: the stage's node (#111), the repository's package manager (#137) and the tools its own commands run (#371) for
    // Claude Code's and Copilot's commands, read-only: their sandboxes show nothing of the home but what their settings
    // name. Never in or above what a sandbox may write (this repository's Objectives, the stages' temp directories), the
    // home or a credential store. Codex's sandbox reads the whole system but the credential stores, so its commands find
    // them as the developer does. A command word not made visible is named once per loop.
    const commands = stageCommands(base);
    const tools = localTools({ harness, clone, commands: { ...commands, install: installCommand(clone, commands.install) }, path: base.PATH, off: [this.dev, join(this.dev, ".pendulum"), dirname(stageTmp)], usageDir });
    for (const u of tools.unresolved) {
      if (TOOLS_SAID.has(u.word)) continue;
      TOOLS_SAID.add(u.word);
      log(`local: \`${u.word}\` (${u.from}) is not visible to ${harness === "claude" ? "Claude Code's" : "Copilot's"} commands: ${u.why}`);
    }
    const lead = tools.lead;
    const extra = this.harnessEnv(issue, addDirs, clone, usageDir, tools, harness, domains, account);
    // Linux: the harness process itself runs in srt too (lib/local.mjs harnessOuterSettings), writing only the clone, the
    // stage's directories, its own state and the usage directory's `harness` folder (Copilot's usage file).
    const outerFile = join(sandboxDir, `srt-harness-${basename(usageDir)}.json`);
    // Whether the harness runs in it on this host: Claude Code on Linux, Codex where its own sandbox starts inside it (probed
    // once per host and version, lib/local.mjs outerProbe), Copilot where its sandbox's network starts inside it (probed the
    // same way). Said once when it does not.
    const outer = outerProbe(harness, { domains, env: { ...host, ...extra }, account });
    const outerOn = outer.on;
    // Entries Codex's and Copilot's sandboxes cannot enforce as written (a loopback name, an IP address, host:port) are left
    // out of their policies (lib/local.mjs sandboxHosts: #106, #108).
    const dropped = ["codex", "copilot"].includes(harness) ? sandboxDroppedHosts(domains) : [];
    if (dropped.length) log(`PENDULUM_LOCAL_DOMAINS: ${dropped.map((d) => JSON.stringify(d)).join(", ")} left out of ${harness === "codex" ? "Codex's" : "Copilot's"} sandbox: not host names (a port or an address it cannot enforce as written)`);
    // Copilot never runs without it (preflight refuses such a host): here it stopped starting after serve began, for
    // example a new Copilot, bubblewrap or slirp4netns version probed again. The stage refuses; stage() Blocks.
    if (!outerOn && harness === "copilot") throw Object.assign(new Error(`${COPILOT_OUTER_OFF}: ${outer.why}${outer.cacheFile ? ` (probe cache: ${outer.cacheFile})` : ""}`), { code: "outer-sandbox" });
    if (!outerOn && !OUTER_SAID.has(harness)) {
      OUTER_SAID.add(harness);
      log(`local: ${harness} runs without the outer sandbox on this host: ${outer.why}. What it runs on the host itself relies on the file-level guards and Pendulum's git guard.`);
    }
    if (outerOn) {
      mkdirSync(join(usageDir, "harness"), { recursive: true });
      ensureHarnessHomes(harness, { ...host, ...extra });
      // Claude Code's projects are read-only in it; the clone's own project links to a directory of the Objective's.
      const projectDir = harness === "claude" ? claudeProjectLink(clone, join(ws, "claude-project"), { ...host, ...extra }) : null;
      // Copilot's outer sandbox runs bwrap through Pendulum's wrapper (lib/local.mjs bwrapTunScript), in the usage directory,
      // which no sandbox may write: srt runs it on the host.
      const bwrapPath = harness === "copilot" ? writeBwrapTun(join(usageDir, "outer")) : null;
      writeFileSync(outerFile, JSON.stringify(harnessOuterSettings({ harness, domains, writable: [clone, ...addDirs, join(usageDir, "harness")], clone, env: { ...host, ...extra }, credentials, install: harnessInstall(whichSync(harness)), projectDir, bwrapPath, relaySocketDir: socketDir, ripgrep }), null, 2));
    }
    // Last on PATH, so nothing there can ever stand in for git, gh, srt or claude in Pendulum's own unsandboxed calls;
    // and neither sandbox may write it (PENDULUM_LOCAL_SANDBOX.readOnly, srt denyWrite), so nothing can be planted.
    base.PATH = `${base.PATH || ""}:${binDir}`;
    // The harness's own `git`, first on its PATH only (lib/harness.mjs): refused once the clone's .git was replaced.
    const gitBin = join(usageDir, "gitbin");
    mkdirSync(gitBin, { recursive: true });
    writeFileSync(join(gitBin, "git"), gitGuardScript(realpathSync(whichSync("git"))), { mode: 0o755 });
    // Linux: Copilot's own `bwrap`, first on its PATH only (lib/harness.mjs): Copilot starts its sandbox's bubblewrap with
    // its whole environment, the token included, and bubblewrap stays as every command's pid 1, readable to each (#100).
    // Pendulum's starts the real one with none (lib/copilot-runner.mjs bwrapShim). In the usage directory, which no
    // sandbox may write; harness.mjs copilotLocalCheck proves it before every start.
    // It also gives each command the stage's temp directory as its TMPDIR: Copilot itself runs with its own
    // (lib/local.mjs copilotPrivateTmp), where it writes each command's network rules.
    const bwrapBin = outerOn && harness === "copilot" ? join(usageDir, "bwrapbin") : null;
    if (bwrapBin) {
      mkdirSync(bwrapBin, { recursive: true });
      // Each command's PATH led by the stage's node where it is bound (after Pendulum's git): a version manager's shim
      // before it on PATH is outside the sandbox.
      writeFileSync(join(bwrapBin, "bwrap"), bwrapShim(realpathSync(whichSync("bwrap")), null, stageTmp, lead.length ? [gitBin, ...lead].join(":") : null, localCopilotRelayShim(localRelayDir(usageDir))), { mode: 0o755 });
    }
    // Claude Code sources this before each command, inside its sandbox (CLAUDE_ENV_FILE): the same PATH lead. In the
    // usage directory, which no sandbox may write.
    const claudeEnv = harness === "claude" && lead.length ? join(usageDir, "claude-env.sh") : null;
    if (claudeEnv) writeFileSync(claudeEnv, claudeEnvText([gitBin, ...lead]), { mode: 0o644 });
    return {
      ...base,
      PENDULUM_CREDENTIAL: "login",
      // The workflow's setup assumes a runner (sudo, a fresh VM); on a box the toolchain is the box's own.
      PENDULUM_SETUP: process.env.PENDULUM_LOCAL_SETUP ?? this.wf.PENDULUM_LOCAL_SETUP ?? "",
      // The commands that can run in this machine's sandboxes, when not all can (a suite that needs a unix socket):
      // the task card names these, and the repository's required checks on GitHub still run the full set.
      ...((process.env.PENDULUM_LOCAL_VALIDATION ?? this.wf.PENDULUM_LOCAL_VALIDATION) ? { PENDULUM_VALIDATION: process.env.PENDULUM_LOCAL_VALIDATION ?? this.wf.PENDULUM_LOCAL_VALIDATION } : {}),
      PENDULUM_PLUGIN_ROOT: PLUGIN_ROOT,
      PENDULUM_USAGE_DIR: usageDir,
      // Pendulum's own temp directory (its mirror and bundles) under the Objective's directory, which no sandbox may write
      // (fsafe.mjs privateTmp).
      PENDULUM_PRIVATE_DIR: join(ws, ".private"),
      npm_config_cache: npmCache,
      // pnpm 12 reads pnpm_config_* (npm_config_store_dir would make npm warn on every command).
      pnpm_config_store_dir: pnpmStore,
      BUN_INSTALL_CACHE_DIR: bunCache,
      YARN_CACHE_FOLDER: yarnCache,
      COREPACK_HOME: corepackHome,
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
      // The sandboxes reach the network only through their proxy; Node's own fetch (Corepack, scripts) ignores
      // HTTPS_PROXY unless told, and failed DNS. NO_PROXY still keeps loopback direct.
      NODE_USE_ENV_PROXY: "1",
      PENDULUM_LOCAL_SRT: srtFile,
      PENDULUM_LOCAL_SRT_GIT: srtGitFile,
      ...(outerOn ? { PENDULUM_LOCAL_SRT_HARNESS: outerFile } : {}),
      // Writable beyond the clone: this stage's usage directory, the package caches and its temp directory (not the spend log).
      TMPDIR: stageTmp,
      // pnpm 12 locks its stores in $XDG_RUNTIME_DIR (else /tmp) and chmods that directory: both are read-only in the
      // sandboxes, so every pnpm command failed there. The stage's own temp directory is writable and owner-only.
      XDG_RUNTIME_DIR: stageTmp,
      // Claude Code points its sandboxed commands' TMPDIR at /tmp/claude, shared by every sandbox on the box, unless told.
      CLAUDE_CODE_TMPDIR: stageTmp,
      // claudeDir: Claude Code's skills and agents for this stage, copied out of the clone into the usage directory, which
      // no sandbox may write (checkout.mjs claudePlugin).
      // cacheDirs: writable to commands, but no harness's added directory (Claude Code would read a CLAUDE.md there,
      // Copilot .github/agents and skills).
      PENDULUM_LOCAL_SANDBOX: JSON.stringify({ gitId: readGitPin(gitPinFile(ws)), gitPin: gitPinFile(ws), gitBin, ...(bwrapBin ? { bwrapBin, copilotTmp: copilotPrivateTmp(usageDir) } : {}), ...(tools.probe ? { toolchain: tools.probe } : {}), ...(claudeEnv ? { claudeEnv } : {}), ...(tools.readable.length ? { readable: tools.readable } : {}), ...(ripgrep ? { ripgrep } : {}), addDirs, cacheDirs: caches, readDirs: [usageDir], domains, clone, readOnly: [usageDir], claudeDir: join(usageDir, "claude"), credentials }),
      // Every git-lfs transfer of Pendulum's own host-side git (lfs pull, checkout, rebase, push) goes to the repository's
      // own endpoint, whatever .lfsconfig the model wrote (env config outranks that file), over the real history (no
      // refs/replace). scrubbedEnv drops both (with PENDULUM_LFS_PIN) from every child: the harness and the repository's
      // commands never see them.
      ...lfsPinEnv(`https://github.com/${this.repoFull}.git`),
      GIT_NO_REPLACE_OBJECTS: "1",
      PENDULUM_LFS_PIN: "1",
      // The harness this sandbox is set up for: a stage whose labels name another by the time it runs Blocks (choiceGate).
      PENDULUM_STAGE_HARNESS: harness,
      // The hosts this Objective's host labels opened in these sandboxes: a stage whose labels name others by the time it
      // runs Blocks (choiceGate).
      PENDULUM_STAGE_HOSTS: [...new Set(hosts.filter(isSandboxHost))].sort().join(","),
      // The account it runs on, by name only: its result.json, progress comment and the scorecard record it.
      PENDULUM_STAGE_ACCOUNT: account.name,
      ...extra,
    };
  }

  /** What the harness's own sandbox needs beyond the shared env: Copilot its home and its account's token. */
  harnessEnv(issue, addDirs, clone, usageDir, tools = null, harness = this.harness, domains = this.domains(), account = null) {
    if (harness !== "copilot") return {};
    // One Copilot home per Objective, outside every writable directory: it holds the sandbox policy (which the
    // model must not loosen) and the sessions a later stage resumes.
    const home = join(this.ws(issue), ".sandbox", "copilot-home");
    mkdirSync(home, { recursive: true });
    // Its policy, config and MCP servers, as Pendulum's own: whatever an earlier run left there (a link included) is replaced.
    // Linux: Copilot's own TMPDIR (its commands' network rules), denied to its commands.
    // The stage's node, package manager and repository tools (stageEnv) read-only, its global npmrc denied.
    const alsoDenied = platform() === "linux" ? [copilotPrivateTmp(usageDir), ...(tools?.denied || [])] : [];
    const files = { "settings.json": JSON.stringify(copilotLocalSettings({ domains, clone, addDirs, readOnly: [usageDir], readable: tools?.readable || [], alsoDenied }), null, 2), ...copilotHomeFiles() };
    for (const [f, text] of Object.entries(files)) {
      // A directory an earlier run left under the name too.
      rmSync(join(home, f), { force: true, recursive: true });
      writeFileSync(join(home, f), text, { mode: 0o600, flag: "wx" });
    }
    // On macOS Copilot's sandbox cannot read ~/.gitconfig and git then refuses to run; the clone's own config carries
    // Pendulum's identity and credential helper, so git skips the global file (which may hold credentials anyway).
    // The stage's account's token, read now: a declared account's from its own file (none from serve's environment
    // then), the implicit one's from where it always came (never a declared account's token kept from serve's start).
    const token = account ? copilotTokenOf(account) : this.copilotToken || copilotToken();
    return { COPILOT_HOME: home, COPILOT_GITHUB_TOKEN: token, GIT_CONFIG_GLOBAL: "/dev/null" };
  }

  /**
   * Run worker.mjs or review.mjs as a child; its lines are echoed with the issue and stage. A failure before its process
   * starts is marked as Pendulum's own set-up of stage `name` failing (`stageSetup`), which lapse names: never the work's,
   * and never another stage's. Under `pendulum run` or `review` (`solo`: the command), the stage holds one slot of the
   * machine's budget while it runs and none between stages, so following a PR to its merge holds none (serve's own
   * stages hold the slot serve took for them).
   */
  async stage(issue, name, script, args) {
    const slot = this.solo ? this.holdSlot({ issue, stage: name, cmd: this.solo }) : null;
    // A stage is set up with one set of settings: from its harness's choice to its env. A change the workflow brings
    // meanwhile waits for every set-up under way to end (refreshSettings).
    this.settingUp = (this.settingUp || 0) + 1;
    let settingUp = true;
    const setUp = () => {
      if (settingUp) this.settingUp -= 1;
      settingUp = false;
    };
    try {
      return await this.startStage(issue, name, script, args, setUp);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      throw err.stageStarted ? err : Object.assign(err, { stageSetup: name });
    } finally {
      setUp();
      slot?.release();
    }
  }

  async startStage(issue, name, script, args, setUp = () => {}) {
    // Stopping: nothing new starts (the claim stays and this machine's next serve resumes the Objective).
    if (this.stopping) return { code: null, exit: null, usd: null, usageDir: null };
    // A harness a dead stage of this Objective left running (a killed loop, a SIGKILL) goes before a new one starts.
    this.reapHere(issue);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const usageDir = join(this.ws(issue), `usage-${name}-${stamp}`);
    mkdirSync(usageDir, { recursive: true });
    const logFile = join(usageDir, "stage.log");
    const clone = await this.ensureClone(issue);
    // Every stage: the clone's .git is the one Pendulum cloned, or nothing runs in it. The Objective is Blocked rather than
    // the stage failing, which serve would pick up again every tick.
    const pin = gitPinFile(this.ws(issue));
    const moved = gitDirChanged(clone, readGitPin(pin), pin);
    if (moved) {
      log(`#${issue}: refusing to run: ${moved}; remove ${this.ws(issue)} to start the Objective from a fresh clone`);
      await this.blockForClone(issue, name);
      return { code: null, exit: "blocked", usd: null, usageDir };
    }
    // The harness this Objective runs on here (harnessFor): a label no writer applied, a model its harness cannot run or a
    // harness this machine cannot run Blocks before anything is set up for it.
    const runs = script === "worker.mjs" || script === "review.mjs" ? await this.harnessFor(issue, { own: usageDir, stage: script === "review.mjs" ? "review" : "work" }) : { ok: true, harness: this.harness };
    // Two account labels (#265): nothing starts and nothing Blocks; the Objective waits here for one to be left (pinWaiting).
    if (runs.wait) {
      rmSync(usageDir, { recursive: true, force: true });
      return { code: null, exit: "paused", usd: null, usageDir: null, stage: name, pinWait: runs.wait };
    }
    if (!runs.ok) {
      log(`#${issue}: refusing to run: ${runs.reason}`);
      await this.block(issue, name, runs.reason, { fix: runs.fix });
      return { code: null, exit: "blocked", usd: null, usageDir };
    }
    // The account it runs on has its usage limit spent (a stage on this machine met it, limitPaused, in any serve): no
    // stage starts on it until the reset. The Objective pauses as that stage did, and pausedHere resumes it after the reset.
    const account = runs.account?.name ?? runs.harness;
    const hold = this.holdOf(runs.account ?? implicitAccount(runs.harness));
    // An account automatic choice picked is held by a no-reset limit's guess too (it was the first to end).
    const until = runs.harness && (script === "worker.mjs" || script === "review.mjs") ? this.limitUntil(hold, { guess: !!runs.auto }) : null;
    if (until !== null) {
      rmSync(usageDir, { recursive: true, force: true });
      // A guess's end (no reset was reported: holds.mjs spent) is no reset, and is said as an estimate.
      const guessed = until !== this.limitUntil(hold);
      this.saidLimit(runs.harness, account, hold, until, guessed);
      return { code: null, exit: "paused", usd: null, usageDir: null, stage: name, account, hold, pinned: !!runs.pinned, pin: runs.pin ?? null, usageLimit: { harness: runs.harness, reset: new Date(until).toISOString(), since: new Date((this.clock ?? Date.now)()).toISOString(), held: true, ...(guessed ? { guessed: true } : {}) } };
    }
    if (runs.auto) log(`#${issue}: the ${name} stage runs on ${limitName(runs.harness, account)}, chosen automatically`);
    // The stage's own temp directory, short (srt's sockets live there; a socket path has a 108-byte limit) and the
    // only temp space any sandbox may write: with /tmp itself writable, sandboxed code could swap this directory for
    // a symlink into the home directory before the next sandbox opens it. Removed when the stage ends or fails to
    // start; one a killed loop left is cleared when the next stage on this machine makes its own (lib/local.mjs stageTemp).
    const stageTmp = stageTemp(`${issue}-`);
    // The gateway relay's socket directory, when stageEnv made one (handSocketDir's record): removed with the stage.
    // Pendulum's teardown: a failure here is logged, never the stage's end.
    const dropStage = () => {
      try {
        dropOwned(stageTmp);
        dropSocketDir(usageDir);
      } catch (e) {
        log(`#${issue}: the ${name} stage's temp or relay socket directory could not be removed (${String(e?.message || e).slice(0, 160)}); left in place`);
      }
    };
    let env;
    try {
      env = this.stageEnv(issue, usageDir, clone, stageTmp, script, runs.harness, runs.hosts || [], runs.account ?? null);
      // Its account chosen automatically (no pin): a usage limit or quota with no reset pauses the stage for this loop to
      // move the Objective (limitPaused), where it would otherwise Block (#332).
      if (runs.auto) env[STAGE_AUTO_ENV] = "1";
      // Git locks an interrupted stage left (a reboot, a killed serve) go first, unless a live process may hold them
      // (lib/local.mjs staleGitLocks); then, fresh: what an earlier stage or run left untracked in this reused clone
      // (prepareClone). Not for a work stage: it may continue the pass its usage limit paused on this clone, and decides
      // that itself, cleaning when it starts fresh (lib/continue.mjs enterStage).
      const locks = staleGitLocks(clone);
      for (const l of locks.live) log(`#${issue}: leaving git lock ${l}: a process on this machine has the clone open`);
      // That git runs on the model's clone: with no secret in its env (scrubbedEnv), as every other git there.
      const gitEnv = scrubbedEnv(env);
      const prepared = await prepareClone(clone, [env.pnpm_config_store_dir, env.BUN_INSTALL_CACHE_DIR], (inner) => exec(...BACKENDS.local.sandbox.git(inner, gitEnv), { env: gitEnv }), { fresh: script !== "worker.mjs", locks: locks.stale }).catch((e) => {
        // A failed start's step (unstart: startCause), which says what probe tells a machine's fault is gone.
        throw Object.assign(e instanceof Error ? e : new Error(String(e)), { startStep: "prepare" });
      });
      for (const l of prepared.locks) log(`#${issue}: removed stale git lock ${l} (no live process holds it)`);
    } catch (e) {
      dropStage();
      const reason = { "outer-sandbox": copilotOuterReason, "sandbox-scan": sandboxScanReason, "login-link": loginLinkReason, "home-link": homeLinkReason, account: e.reason }[e.code];
      if (!reason) throw e;
      log(`#${issue}: refusing to run: ${e.message}`);
      await this.block(issue, name, reason);
      return { code: null, exit: "blocked", usd: null, usageDir };
    }
    // Its env is made: the settings may change from here on.
    setUp();
    // Stopping, or another loop took the claim meanwhile (withClaim's heartbeat): no process starts.
    if (this.stopping || this.lost?.has(issue)) {
      // Refused for the lost claim: withClaim reports the stage as ended for it.
      if (this.lost?.has(issue)) this.lost.get(issue).ended = true;
      dropStage();
      return { code: null, exit: null, usd: null, usageDir };
    }
    // With automatic account choice on, the round-robin counts this start (a pinned one too): its process runs now.
    if (this.auto && runs.account) this.startedOn(runs.account);
    return new Promise((done) => {
      if (this.firstSetup.has(issue)) {
        env.PENDULUM_LOCAL_FIRST_SETUP_MS = String(this.firstSetup.get(issue));
        this.firstSetup.delete(issue);
      }
      // The token goes to the stage on a pipe (fd 3) that it reads once and closes: never in its env, where every process
      // it starts would inherit it, nor in a file. With an App, the stage asks this process for each notice token over
      // Node's IPC channel (fd 4), which Node keeps from everything the stage starts (app-token.mjs serveNotices).
      const notice = this.notice ? ["--notice", "ipc"] : [];
      // The work and review stages: the worker secrets' values from this shell (lib/worker-secrets.mjs), which the worker
      // carries to its harness only and the review stage to its fix and answer passes only (never the reviewer), as the
      // workflow's `worker_secret_values` reaches a runner's; nothing before the stage gets them.
      const values = script === "worker.mjs" || script === "review.mjs" ? localSecretValues(input("worker_secrets", { env }), process.env) : "";
      // This process posts what the stage leaves too: none of those values.
      holdSecrets([...parseSecretValues(values).values()]);
      const started = (this.clock ?? Date.now)();
      const child = spawn(process.execPath, [join(PLUGIN_ROOT, "scripts", script), "--repo", this.repoFull, ...args, "--checkout", clone, "--usage-dir", usageDir, "--token-fd", "3", ...notice], { env: values ? { ...env, PENDULUM_INPUT_WORKER_SECRET_VALUES: values } : env, stdio: ["ignore", "pipe", "pipe", "pipe", ...(this.notice ? ["ipc"] : [])] });
      // Its process started: a failure from here on is no failure of its set-up (stage(): `stageStarted`).
      try {
        // Named while it runs, so a later start on this machine never runs a second stage beside it (liveStage).
        if (child.pid) writeFileSync(join(usageDir, STAGE_RECORD), JSON.stringify(processRecord(child.pid)), { mode: 0o600 });
        // The one more try resume granted a 5xx (serverVerdict) is made now, its stage's process started; never before.
        if (child.pid) this.tryStarted(issue);
        child.stdio[3].on("error", () => {});
        child.stdio[3].end(this.token);
        if (this.notice) serveNotices(child, this.notice);
        // By its Objective, for withClaim's heartbeat to end it when another loop holds the claim.
        child.issue = issue;
        this.children.add(child);
        // One relay per stream, whole lines only, so no value split across two chunks escapes the redaction.
        const relays = [child.stdout, child.stderr].map((stream) => {
          const r = stageRelay({ logFile, prefix: `[#${issue} ${name}]` });
          stream.on("data", r.push);
          return r;
        });
        child.on("close", (code, signal) => {
          for (const r of relays) r.end();
          this.children.delete(child);
          try {
            rmSync(join(usageDir, STAGE_RECORD), { force: true });
          } catch {
            // left: liveStage finds its process gone
          }
          let result = null;
          try {
            result = JSON.parse(readFileSync(join(usageDir, "result.json"), "utf8"));
          } catch {
            // no record: the child failed before writing one
          }
          dropStage();
          // A pass on its account completed (the provider served it, and no usage limit ended it): its back-off streak ends,
          // when the stage started after the newest limit met there (holds.mjs served).
          if (runs.account && result && servedPass(result)) this.holdStore(hold).served({ harness: runs.harness, account: hold.key, now: (this.clock ?? Date.now)(), started });
          // The provider's quota reading for the account (session.mjs writeUsage `quota`): kept with the machine's holds,
          // for every serve's automatic account choice (#391); only the stage's own harness's.
          if (runs.account && result?.quota?.windows && result.quota.harness === runs.harness) this.holdStore(hold).reading({ harness: runs.harness, account: hold.key, now: (this.clock ?? Date.now)(), windows: result.quota.windows });
          // A served stage that reported none: the account reports nothing (an API key, Copilot), kept as a fact.
          else if (runs.account && servedSilent(result)) this.holdStore(hold).silent({ harness: runs.harness, account: hold.key, now: (this.clock ?? Date.now)() });
          // Blocked on its usage limit with no reset reported (session.mjs writeUsage `limitRefused`): automatic account
          // choice, in this serve and any other here that has it on, passes the account over for a while (holds.mjs spent);
          // nothing else holds on it, and a serve with it off writes no guess.
          if (this.auto && runs.account && result?.exit === "blocked" && result.limitRefused) {
            const end = this.holdStore(hold).spent({ harness: runs.harness, account: hold.key, now: (this.clock ?? Date.now)(), window: result.limitRefused.limitType ?? null, steps: this.guessSteps() });
            log(`#${issue}: ${limitName(runs.harness, account)} reached its usage limit with no reset reported; automatic account choice passes it over until ${logTime(end)}`);
          }
          // `served`: a harness pass the provider served in this stage (writeUsage's servedPasses, which leaves the stage's
          // decision calls out), the progress outagePaused reads between pauses.
          done({ code, signal, exit: result?.exit ?? null, ...stageSpendOf(result), usageDir, stage: name, log: logFile, served: Number(result?.servedPasses) > 0, ...(runs.account ? { account, hold, pinned: !!runs.pinned, pin: runs.pin ?? null } : {}), ...(result?.exit === "paused" && result.outage ? { outage: result.outage } : {}), ...(result?.exit === "paused" && result.usageLimit ? { usageLimit: result.usageLimit } : {}) });
        });
      } catch (e) {
        throw Object.assign(e instanceof Error ? e : new Error(String(e)), { stageStarted: true });
      }
    });
  }

  /**
   * Block the Objective whose clone's .git is not the one Pendulum cloned: a fixed reason, no local path. A repeat on the
   * same clone updates its Blocked comment rather than adding one. `gh`: the GitHub calls (a test's own).
   */
  async blockForClone(issue, name, gh = { findPr, removeLabel, applyExit }) {
    await this.block(issue, name, gitIdentityReason(issue), { key: gitIdentityKey(name, readGitPin(gitPinFile(this.ws(issue)))), gh });
  }

  /**
   * Block the Objective with a fixed reason (never probe or harness output). Its PR loses the review label (the reviewer,
   * which drops it on every exit, never starts here), so serve does not pick it again. `key`: the Blocked comment a
   * repeat of the same condition updates.
   */
  async block(issue, name, reason, { key = null, cause = "setup", fix = null, gh = { findPr, removeLabel, applyExit } } = {}) {
    const inputs = resolveInputs({ args: { repo: this.repoFull }, env: this.baseEnv() });
    const pr = await gh.findPr(this.repo, `pendulum/${issue}`, this.opts).catch(() => null);
    if (pr) await gh.removeLabel(this.repo, pr.number, REVIEW_LABEL, this.opts).catch((e) => log(`#${issue} review label: ${e.message.slice(0, 120)}`));
    await gh.applyExit(this.repo, { issue, pr, exit: "blocked", reason, key, cause, ...(fix ? { fix } : {}), notify: inputs.notify, stage: name }, this.opts);
  }

  /**
   * SIGINT, SIGTERM or SIGHUP to `run`, `review` or `serve`: stop. Nothing new starts, every stage process gets SIGTERM
   * (it stops its harness's process group before it exits: proc.mjs stopGroups), and the claims stay, so the Objectives
   * pause and this machine's next `pendulum run` or `pendulum serve` takes them up again. A start that has written no claim
   * yet writes none and puts its Objective back to Queued (withClaim's `onStop`, serve's unpick), so none is left Running
   * with no claim. Exits once `whenSettled()` resolves (the work in flight, wound down) or 30 s pass.
   */
  stopOnSignals(whenSettled) {
    let stoppedAt = 0;
    const stop = async (sig) => {
      const code = 128 + (osConstants.signals[sig] || 2);
      // A second signal, not the echo of the first (Ctrl-C reaches the front end and this process at once), ends it now.
      if (stoppedAt) {
        if (Date.now() - stoppedAt > 1_000) process.exit(code);
        return;
      }
      stoppedAt = Date.now();
      this.stopping = true;
      for (const wake of this.wakers || []) wake();
      log(`stopping (${sig}): ending ${this.children.size} stage process(es); their Objectives stay Running, paused, and the next pendulum run or serve on this machine takes them up (the dispatcher Blocks one only after the claim pause away, claim_pause_hours, a day by default); a start with no claim yet goes back to Queued; signal again to exit at once`);
      for (const child of this.children) child.kill("SIGTERM");
      // A probe of a held account under way (probeHold) ends with the loop.
      this.probeStop?.abort();
      await Promise.race([Promise.resolve(whenSettled()).catch(() => {}), new Promise((r) => setTimeout(r, 30_000))]);
      process.exit(code);
    };
    for (const s of STOP_SIGNALS) process.on(s, () => void stop(s));
  }

  /** Wait `ms`, or less when this loop is told to stop. */
  pause(ms) {
    if (this.stopping) return Promise.resolve();
    this.wakers ??= new Set();
    return new Promise((r) => {
      const done = () => {
        clearTimeout(t);
        this.wakers.delete(done);
        r();
      };
      const t = setTimeout(done, ms);
      this.wakers.add(done);
    });
  }

  /** Stop the harness runs a dead stage of the Objective left on this machine (reapLeftRuns), and say so. */
  reapHere(issue) {
    const reaped = reapLeftRuns(this.ws(issue));
    if (reaped) log(`#${issue}: stopped ${reaped} harness run(s) an earlier stage left running on this machine`);
    const dirs = reapSocketDirs(this.ws(issue));
    if (dirs) log(`#${issue}: removed ${dirs} gateway relay socket director${dirs === 1 ? "y" : "ies"} a dead stage left`);
  }

  /**
   * This issue's claim, read up to `tries` times: a read that fails or cannot check its author (lib/local.mjs ClaimUnread)
   * is read again after a pause, never taken for "no claim". Throws the last ClaimUnread when every read failed.
   */
  async readClaim(issue, tries = 3) {
    for (let i = 1; ; i += 1) {
      try {
        return await localClaim(this.repo, issue, this.opts);
      } catch (e) {
        if (i >= tries) throw e;
        await new Promise((r) => setTimeout(r, this.claimRetryMs ?? 2000));
      }
    }
  }

  /**
   * Hold the Objective for the length of fn: a claim with a heartbeat the Actions path and other loops respect. A stage
   * that ends with an exit record drops it. One that ends without (killed, crashed, threw) keeps it and this loop
   * resumes it once (pausedHere); a second such end in a row Blocks it here with the stage's exit and log (lapse). A
   * claim that cannot be read or written is a failed start (`startFailed`, runObjective's unstart).
   *
   * `stint` (a work start): the Objective's Running stint (relaunch.mjs runningStint) is read first, and again before and
   * after the claim is written. A start that waited long enough for another loop to put the Objective back to Queued, or
   * to pick it again (serve's sweep of a Running one with no claim, the dispatcher's), sees the stint change and steps
   * aside: it writes no claim, or takes back the one it wrote.
   *
   * Two loops that write at once can each read their own name back. The heartbeat settles it: each beat reads the claim
   * before it writes, and one that names another live loop (fresh, and not a dead loop of this machine) ends this loop's
   * stage of the Objective instead of overwriting it (`lost`): no lapse, the claim stays that loop's, and this loop never
   * resumes the Objective from it.
   */
  async withClaim(issue, fn, { onStop = null, stint = false } = {}) {
    const stintNow = async () => {
      try {
        // Conditional reads: a timeline page unchanged since this loop last read it is a 304, which the rate limit does not count.
        return runningStint(await timelineOf(this.repo, issue, { ...this.opts, cache: (this.timelines ??= new Map()) })).key;
      } catch (e) {
        throw Object.assign(e, { startFailed: "claim-read" });
      }
    };
    const picked = stint ? await stintNow() : null;
    const active = await activeWorkIssues(this.repo, this.opts).catch(() => new Set());
    if (active.has(issue)) {
      log(`#${issue}: an Actions worker job is running it; local mode leaves it alone`);
      return { exit: "skipped" };
    }
    let held;
    try {
      held = await this.readClaim(issue);
    } catch (e) {
      // Who holds it is unknown: nothing about the Objective may change on this (unstart).
      throw Object.assign(e, { startFailed: "claim-read" });
    }
    const others = !!held && held.holder !== this.holder && !deadHereHolder(held.holder, { own: this.holder });
    if (others && held.fresh) {
      log(`#${issue}: another local loop holds it (${held.holder}); leaving it alone`);
      return { exit: "skipped" };
    }
    // Told to stop before the claim: none is written. With no claim on the issue at all, `onStop` settles it (a work
    // start puts a Running Objective back to Queued); a claim already there stays, for the loop that resumes it.
    if (this.stopping) {
      if (!held && onStop) await onStop().catch((e) => log(`#${issue}: stopping before its claim, it could not be put back to Queued (${String(e?.message || e).slice(0, 120)}); the next serve's tick does it`));
      return { exit: "skipped" };
    }
    if (stint && (await stintNow()) !== picked) {
      log(`#${issue}: its Running stint changed while this start waited (another loop queued or picked it again); leaving it alone, no claim written`);
      return { exit: "skipped" };
    }
    let wrote;
    try {
      wrote = await writeClaim(this.repo, issue, this.holder, this.opts);
    } catch (e) {
      throw Object.assign(e, { startFailed: "claim", othersClaim: others });
    }
    // Two loops writing at once: the comment's last writer holds it, and the other steps aside, here or at its next
    // heartbeat (below), whichever first reads the other's name.
    let mine;
    try {
      mine = await this.readClaim(issue);
    } catch (e) {
      // Unread is no answer: the claim written carries this loop's id, so it stays, goes stale, and pausedHere resumes it.
      log(`#${issue}: the claim could not be read back (${String(e.message).slice(0, 160)}); it stays, and this loop resumes the Objective once it is stale`);
      return { exit: "skipped" };
    }
    const after = mine?.holder === this.holder && stint ? await stintNow().catch(() => undefined) : picked;
    if (after === undefined) {
      // Unread is no answer, as a failed read-back: the claim stays, goes stale, and pausedHere resumes it.
      log(`#${issue}: its Running stint could not be read back; the claim stays, and this loop resumes the Objective once it is stale`);
      return { exit: "skipped" };
    }
    const aside = mine?.holder !== this.holder ? "another local loop claimed it first" : after !== picked ? "its Running stint changed while this start claimed it (another loop queued or picked it again)" : null;
    if (aside) {
      log(`#${issue}: ${aside}; leaving it alone`);
      // The comment this write updated was this machine's own claim (a resume): no other loop's name to wait for.
      await this.cede(issue, wrote, { own: !!held && (held.holder === this.holder || deadHereHolder(held.holder)) });
      return { exit: "skipped" };
    }
    this.ceded?.delete(issue);
    // Pendulum's mark of the pendulum:local label this process put on it, when the pick could not write it (backfillMark).
    await this.backfillMark(issue).catch((e) => log(`#${issue}: local-route mark: ${String(e?.message || e).slice(0, 120)}`));
    // One heartbeat at a time: while this machine's network is down a write waits for it (lib/network.mjs), and the
    // beats due meanwhile are skipped rather than queued behind it. Each reads who holds the claim first: a claim it
    // cannot read is written as before (no answer is no other holder).
    let beating = null;
    let lost = null;
    const heartbeat = async () => {
      const now = await localClaim(this.repo, issue, this.opts).catch(() => undefined);
      if (now && now.holder !== this.holder && now.fresh && !deadHereHolder(now.holder, { own: this.holder })) {
        lost = now.holder;
        clearInterval(beat);
        log(`#${issue}: another local loop holds it now (${now.holder}); ending this loop's stage of it`);
        // `ended`: a stage of it ended here for the lost claim (a process killed, or stage() refusing to start one).
        const mark = { ended: false };
        (this.lost ??= new Map()).set(issue, mark);
        for (const child of this.children || []) {
          if (child.issue !== issue) continue;
          child.kill("SIGTERM");
          mark.ended = true;
        }
        return;
      }
      // This loop's own claim read: rewritten in place, with no second read.
      if (now?.holder === this.holder && now.commentId) await beatClaim(this.repo, issue, now.commentId, this.holder, this.opts);
      else await writeClaim(this.repo, issue, this.holder, this.opts);
      await this.backfillMark(issue);
    };
    const beat = setInterval(() => {
      if (beating || lost) return;
      beating = heartbeat()
        .catch((e) => log(`#${issue} heartbeat: ${e.message.slice(0, 120)}`))
        .finally(() => {
          beating = null;
        });
    }, this.heartbeatMs ?? HEARTBEAT_MS);
    let result = null;
    let failure = null;
    try {
      result = await fn();
      // A stage ended for the lost claim is skipped; anything else the body did (a merge it followed to the end) stands.
      return lost && this.lost?.get(issue)?.ended ? { exit: "skipped" } : result;
    } catch (e) {
      failure = e;
      throw e;
    } finally {
      clearInterval(beat);
      this.lost?.delete(issue);
      // The claim went to another live loop (the heartbeat): its stage is that loop's, and so is the claim.
      if (lost) {
        (this.ceded ??= new Set()).add(issue);
        this.lapsed?.delete(issue);
        this.offline?.delete(issue);
      }
      // Stopping serve pauses its work: the claim stays, goes stale, and this machine's next serve resumes it. A failed
      // start is unstart's to settle.
      else if (!this.stopping && !failure?.startFailed) {
        // A stage this machine's network ended (`paused`): no lapse, the claim stays, and pausedHere resumes it once
        // the host answers again (outagePaused).
        if (result?.exit === "paused") await this.outagePaused(issue, result);
        // Only a stage's own end (or a throw) without an exit record lapses; anything else that ends (a merge followed
        // and not merged yet) releases the claim as an exit does.
        else if (!result?.exit && (failure || result?.stage)) {
          this.offline?.delete(issue);
          await this.lapse(issue, result, failure);
        } else {
          this.lapsed?.delete(issue);
          this.offline?.delete(issue);
          await dropClaim(this.repo, issue, this.holder, this.opts);
        }
      }
    }
  }

  /**
   * Take back a claim this loop wrote and then stepped aside from (withClaim). A comment its write created that still names
   * this loop goes (with different logins, each loop's claim is a comment of its own, never left beside the live one). A
   * comment it updated was another loop's under the same login: it stays for that loop's next heartbeat to write its own
   * name back, and this loop never resumes the Objective from it (pausedHere). One that was this machine's own claim
   * (`own`: a resume's) stays as any paused claim does, for pausedHere to resume once stale, unless another loop's
   * heartbeat names that loop first.
   */
  async cede(issue, wrote, { own = false } = {}) {
    // GitHub gives a comment it creates the same created and updated time; an update moves the updated one on.
    if (!own) (this.ceded ??= new Set()).add(issue);
    if (!wrote?.id || wrote.created_at !== wrote.updated_at) return;
    const now = await listComments(this.repo, issue, this.opts).catch(() => null);
    const c = now?.find((x) => x.id === wrote.id);
    if (c && parseClaim(c.body)?.holder === this.holder) await rest(`repos/${this.repo.full}/issues/comments/${c.id}`, { ...this.opts, method: "DELETE" }).catch(() => {});
  }

  /**
   * A stage that ended with no exit record under this loop (`result` its stage's end, or `failure` what threw): the claim
   * stays and pausedHere resumes it, or it Blocks here (cause `pendulum`), naming the stage, its exit code or signal and
   * its log on this machine, so the cause reaches GitHub and nothing retries forever. Whether to start it again is the
   * lapse check's (lib/lapse-check.mjs, a decision call on the AI Gateway): given this end and the one before it, would
   * the same stage started again end the same way? `same_again` Blocks at once; `transient` resumes it, and the
   * PENDULUM_LOCAL_LAPSE_MAX-th lapse in a row (3 by default) Blocks. With no verdict (no key, no answer, a lower confidence) it is resumed
   * once and a second lapse in a row Blocks. A throw names what threw: Pendulum's set-up of a stage (`stageSetup`, stage()), or else
   * the local loop itself; never the work; and the error as postedError has it. The count is this loop's memory:
   * another serve on the machine resumes the Objective afresh.
   */
  async lapse(issue, result, failure) {
    const stage = result?.stage || failure?.stageSetup || "local";
    // This machine's log gets the whole error; GitHub gets it as postedError has it.
    const said = (error) => (!failure ? `the ${stage} stage ended with no exit record (${result?.signal ? `signal ${result.signal}` : `exit code ${result?.code ?? "none"}`})` : failure.stageSetup ? `Pendulum's set-up of the ${stage} stage failed (${error})` : `Pendulum's local loop threw (${error})`);
    const what = said(String(failure?.message || failure).slice(0, 200));
    const where = result?.log ? `; its log on this machine: ${result.log}` : "";
    const lapsed = (this.lapsed ??= new Map());
    const before = lapsed.get(issue) ?? null;
    let pressure = null;
    try {
      pressure = readPressure({ root: this.machinePlaces().proc });
    } catch {
      // unknown: the check is told so
    }
    const facts = lapseFacts({ result, failure, pressure });
    // Opened for each lapse, so a key file or decision route set since serve started is read (`lapseCheck`: a test's own).
    const check = this.lapseCheck ?? openLapseCheck({ inputs: resolveInputs({ args: { repo: this.repoFull }, env: this.baseEnv() }), env: this.baseEnv() });
    const verdict = await check.judge(lapseInput(facts, before?.facts ?? null), { issue, repo: this.repoFull }).catch(() => null);
    // The call's cost, outside any stage: written now on the Objective's issue (decision-spend.mjs).
    await flushDecisionSpend(this.repo, this.opts, { role: "serve" });
    const count = (before?.count ?? 0) + 1;
    const judged = verdict ? `; the lapse check (${check.asked()?.model ?? "the AI Gateway"}) judged it ${verdict === "same_again" ? "likely to end the same way again" : "transient"}` : "";
    const resume = verdict === "same_again" ? false : verdict === "transient" ? count < this.bounded("PENDULUM_LOCAL_LAPSE_MAX") : count < 2;
    if (resume) {
      lapsed.set(issue, { count, facts });
      log(`#${issue}: ${what}${judged}; the claim stays and this loop resumes it (lapse ${count} in a row)${where}`);
      return;
    }
    lapsed.delete(issue);
    const times = count === 1 ? "" : count === 2 ? " twice in a row" : ` ${count} times in a row`;
    log(`#${issue}: ${what}${times ? " again" : ""}${judged}; Blocking it${where}`);
    try {
      await this.block(issue, stage, `${said(postedError(failure))}${times} on this machine${judged}${where}`.replaceAll(homedir(), "~"), { cause: "pendulum", ...(failure ? { fix: "Fix it on this machine (the local loop's log has the failure), then re-apply `pendulum:objective`." } : {}) });
      await dropClaim(this.repo, issue, this.holder, this.opts);
    } catch (e) {
      log(`#${issue}: the Block could not be written (${String(e?.message || e).slice(0, 120)}); the claim stays`);
    }
  }

  /**
   * A stage that ended `paused` on this machine's network (session.mjs outageExit): the outage it names (`result.outage`:
   * host, origin, code, since, and `reset` for GitHub's spent rate limit) is kept in this loop's memory. A pause that
   * comes within OUTAGE.stageWaitMs of this loop resuming the Objective from an earlier one is the same outage (a network
   * that comes and goes): its `since` stays the earlier one, so OUTAGE.blockMs counts from when the Objective first lost
   * the network. A pause on GitHub's spent rate limit after an earlier one, with no other end between, is the same however
   * long the run between them lasted, so repeated quota pauses stay within OUTAGE.blockMs too. Either holds only while
   * nothing was done between them: a stage that paused after its provider served a harness pass (`result.served`,
   * result.json's servedPasses; a decision call is none) made progress since the earlier pause, so its pause counts
   * afresh from its own `since`. A pause on GitHub answering
   * 5xx past the client's retries (network.mjs serverDown) is counted in `server` ({since, pauses, at, request,
   * requestSince, tried}: the request that failed, its first failure and whether its one more try was made) across
   * every pause of the Objective however far apart, until a stage ends any other way (withClaim): a probe of the host
   * answers while one endpoint fails, so pausedHere resumes it after a doubling wait instead (serverWait), and resume
   * asks GitHub's status page whether to go on (serverVerdict), Blocking it at OUTAGE.blockMs from the first whatever the
   * page says. No lapse is counted; the claim stays. The memory is this loop's: another serve on the machine resumes the
   * Objective with the bound counted afresh.
   */
  outagePaused(issue, result) {
    if (result?.usageLimit) return this.limitPaused(issue, result);
    if (result?.pinWait) return this.pinWaiting(issue, result);
    const o = result?.outage || {};
    const at = Date.parse(o.since);
    const own = Number.isFinite(at) ? at : (this.clock ?? Date.now)();
    const earlier = this.offline?.get(issue);
    const reset = Date.parse(o.reset);
    const quotaAgain = Number.isFinite(reset) && Number.isFinite(earlier?.reset) && !earlier?.harness;
    const same = earlier && !result?.served && (quotaAgain || (Number.isFinite(earlier.resumedAt) && own - earlier.resumedAt < OUTAGE.stageWaitMs));
    const since = same ? Math.min(own, earlier.since) : own;
    const now = (this.clock ?? Date.now)();
    const before = earlier?.harness ? null : (earlier?.server ?? null);
    // The one more try (`tried`) and its request's first failure (`requestSince`) belong to the request that failed: a
    // 5xx on another request, or a pause on anything but a 5xx, starts them afresh.
    const sameRequest = !!before && serverDown(o.code) && before.request === requestKey(o);
    const server = serverDown(o.code)
      ? { since: Math.min(own, before?.since ?? own), pauses: (before?.pauses ?? 0) + 1, at: now, request: requestKey(o), requestSince: sameRequest ? before.requestSince : own, tried: sameRequest && !!before.tried }
      : before && { since: before.since, pauses: before.pauses, at: before.at };
    (this.offline ??= new Map()).set(issue, { since: serverDown(o.code) ? server.since : since, stage: result?.stage || "work", origin: o.origin ?? null, host: o.host || "the network", code: o.code || "no answer", ...(o.endpoint ? { endpoint: o.endpoint } : {}), ...(Number.isFinite(reset) ? { reset } : {}), ...(server ? { server } : {}) });
    this.lapsed?.delete(issue);
    const what = Number.isFinite(reset)
      ? `GitHub's ${o.quota || "core"} API rate limit on ${o.host || "GitHub"} is spent until ${whenText(reset)}; the claim stays and this loop resumes it after the reset`
      : serverDown(o.code)
        ? `${lostText(o.host || "GitHub", o.code, o.endpoint)} since ${whenText(server.since)}; the claim stays and this loop resumes it in ${minutesText(serverWait(server.pauses))} (pause ${server.pauses})${o.origin === githubOrigin() ? ", going by GitHub's status page" : ""}`
        : `${lostText(o.host || "the network", o.code || "no answer")} since ${whenText(since)}; the claim stays and this loop resumes it once that host answers`;
    log(`#${issue}: the ${result?.stage || "work"} stage paused: ${what}`);
  }

  /**
   * A stage that ended `paused` on its usage limit (session.mjs usageLimitExit): the reset it names (`result.usageLimit`:
   * harness, reset, since) holds the account the stage ran on (`result.hold`, holdOf; else its harness's login) in
   * this machine's holds (lib/holds.mjs), which every serve here reads: no stage starts on that account
   * until then (startStage, limitHold), in this loop or another, now or after a restart. The Objective is kept in this
   * loop's memory, and pausedHere resumes it after the reset, with no bound: the reset is known. No lapse is counted; the
   * claim stays. A provider that refuses again past the reset it stated is held at least 2, 5, 10, then 15 minutes per
   * such pause in a row on that account (lib/holds.mjs accountHolds.limit). A stage held before it ran (`held`) adds no
   * hold and counts nothing. Either way the issue gets the pause notice (pauseNotice), which says which other accounts
   * of the harness are free to move the Objective to (#265); pausedHere resumes it early on the one its label then names.
   */
  async limitPaused(issue, result) {
    const l = result.usageLimit;
    if (l.noReset) return this.spentPaused(issue, result);
    const now = (this.clock ?? Date.now)();
    const stated = Date.parse(l.reset);
    const since = Date.parse(l.since);
    const account = result.account || l.harness;
    const hold = result.hold ?? this.holdOf(implicitAccount(l.harness));
    let reset = Number.isFinite(stated) ? stated : now;
    if (!l.held && l.harness) reset = this.holdStore(hold).limit({ harness: l.harness, account: hold.key, reset, now, window: l.limitType ?? null });
    (this.offline ??= new Map()).set(issue, { since: Number.isFinite(since) ? since : now, stage: result?.stage || "work", origin: null, host: l.harness, code: "usage limit", harness: l.harness, reset, hold: hold.key, account, pinned: !!result.pinned, pin: result.pin ?? null });
    this.lapsed?.delete(issue);
    const until = l.guessed ? `is passed over until about ${whenText(reset)} (no reset was reported)` : `is spent until ${whenText(reset)}${reset !== stated ? ` (the provider stated ${l.reset})` : ""}`;
    log(`#${issue}: the ${result?.stage || "work"} stage paused: ${limitName(l.harness, account)}'s usage limit ${until}; the claim stays and this loop resumes it after then`);
    if (l.harness) await this.pauseNotice(issue, { stage: result?.stage || "work", harness: l.harness, account, hold: hold.key, reset, window: l.limitType ?? this.holdStore(hold).window(hold.key, now) ?? null, pinned: !!result.pinned, ...(l.guessed ? { guessed: true } : {}) });
  }

  /**
   * A stage whose account automatic choice picked that ended `paused` on a usage limit or quota with no reset reported
   * (session.mjs usageLimitExit `noReset`, #332): the account is passed over for a guessed while (holds.mjs spent, by machine.json's guess_hours), in
   * every serve here. With another account of the harness free (freeAccounts), the Objective stays paused as on a known
   * reset, until the guess's end, and pausedHere moves it to a free one at the next tick (movesEarly): never back to the
   * account it left, which the guess holds. Each stage makes one such move at most, and each move holds the account it
   * leaves, so an Objective's moves end once every account is held: with none free, it Blocks once (`provider-quota`)
   * naming each account's state, and the claim goes.
   */
  async spentPaused(issue, result) {
    const l = result.usageLimit;
    const now = (this.clock ?? Date.now)();
    const account = result.account || l.harness;
    const hold = result.hold ?? this.holdOf(implicitAccount(l.harness));
    // Only a serve with automatic choice on keeps a guess (a stage this serve did not pick for cannot end here: its env
    // never says so, accounts.mjs STAGE_AUTO_ENV); one with it off Blocks the stage as on any no-reset limit.
    const end = this.auto ? this.holdStore(hold).spent({ harness: l.harness, account: hold.key, now, window: l.limitType ?? null, steps: this.guessSteps() }) : null;
    if (end !== null) log(`#${issue}: ${limitName(l.harness, account)} reached its usage limit or quota with no reset reported; automatic account choice passes it over until ${logTime(end)}`);
    if (end !== null && !result.pinned && this.freeAccounts(l.harness, hold.key).length) return this.limitPaused(issue, { ...result, usageLimit: { ...l, noReset: false, reset: new Date(end).toISOString(), held: true, guessed: true } });
    const h = HARNESS_NAMES[l.harness] || l.harness;
    const states = this.accountStates(l.harness);
    const reason = `${h} account \`${account}\` reached its usage limit or quota with no reset reported, and no other ${h} account on this machine is free${states.length ? `: ${states.join("; ")}` : ""}.`;
    this.offline?.delete(issue);
    this.lapsed?.delete(issue);
    log(`#${issue}: Blocking it: ${reason}`);
    try {
      await this.block(issue, result?.stage || "work", reason, { cause: "provider-quota", fix: `Re-apply \`pendulum:objective\` once a ${h} account is free again.` });
      await dropClaim(this.repo, issue, this.holder, this.opts);
    } catch (e) {
      log(`#${issue}: the Block could not be written (${String(e?.message || e).slice(0, 120)}); the claim stays`);
    }
  }

  /** Each declared account of `harness` as a Block names it: held until its reset, passed over until a guess's end, unready here, or free. */
  accountStates(harness) {
    let list;
    try {
      list = harnessAccounts(this.loadedAccounts(), harness);
    } catch {
      return [];
    }
    return list.map((a) => {
      const hold = this.holdOf(a);
      const hard = this.limitUntil(hold);
      const any = this.limitUntil(hold, { guess: true });
      if (any !== null && any !== hard) return `\`${a.name}\` passed over until about ${whenText(any)} (no reset reported)`;
      if (hard !== null) return `\`${a.name}\` held until ${whenText(hard)}`;
      return this.knownUnready(a) ? `\`${a.name}\` cannot run here` : `\`${a.name}\` free`;
    });
  }

  /**
   * A stage that did not start because the Objective has more than one account label (harnessFor `wait`, #265): it is
   * kept in this loop's memory as paused, its claim kept, never Blocked and with no bound; pausedHere resumes it once
   * the issue shows at most one. Said once, in the log and on the issue.
   */
  async pinWaiting(issue, result) {
    (this.offline ??= new Map()).set(issue, { since: (this.clock ?? Date.now)(), stage: result?.stage || "work", origin: null, host: "its account labels", code: "two account labels", pinWait: true });
    this.lapsed?.delete(issue);
    (this.twoNoted ??= new Set()).add(issue);
    await this.saidPin(issue, result.pinWait, { note: true });
  }

  /** The two-label line (twoPinsLine) for `issue`, said once in the log and on the issue; twoCleared takes it back. */
  async sayTwo(issue, labels) {
    (this.twoNoted ??= new Set()).add(issue);
    await this.saidPin(issue, twoPinsLine(labels), { note: true });
  }

  /**
   * The issue's account labels are down to one or none after the two-label line was said: the issue's note says the
   * Objective goes on (the pause notice without that line, while it is paused on a usage limit), and the line would be
   * said again if it came back. Nothing written when no such line was said.
   */
  async twoCleared(issue) {
    if (!this.twoNoted?.delete(issue)) return;
    this.pinClear(issue);
    const pause = this.offline?.get(issue)?.harness ? this.pauses?.get(issue) : null;
    if (pause) {
      const { note: _note, ...plain } = pause;
      return this.pauseNotice(issue, plain);
    }
    if (!this.repo) return;
    await upsertComment(this.repo, issue, marker(issue, "account-limit"), "Pendulum: one account label or none is left, so the Objective goes on.", this.opts).catch((e) => log(`#${issue}: the account note could not be written (${String(e?.message || e).slice(0, 120)})`));
  }

  /** A note write from a path that cannot wait on it (limitHold): kept in `notesInFlight` until it settles. */
  noting(p) {
    const set = (this.notesInFlight ??= new Set());
    const kept = p.finally(() => set.delete(kept));
    set.add(kept);
  }

  /**
   * A claim this loop holds on an Objective it keeps paused (a usage limit's reset, its account labels: pausedHere),
   * written again once its comment is PAUSED_BEAT_MS old (`everyMs`: `run --wait` beats as a stage does, waitPaused;
   * `claim`, localClaim's read: its heartbeat is GitHub's update
   * time). No stage runs to heartbeat it, and a claim a day old is a loop gone away, which the dispatcher Blocks. A
   * write that fails is logged; the next tick tries again.
   */
  async beatPaused(issue, claim, everyMs = PAUSED_BEAT_MS) {
    if (!claim?.heartbeat || (this.clock ?? Date.now)() - Date.parse(claim.heartbeat) < everyMs) return;
    await writeClaim(this.repo, issue, this.holder, this.opts).catch((e) => log(`#${issue}: the paused claim's heartbeat could not be written (${String(e?.message || e).slice(0, 120)}); next tick tries again`));
  }

  /**
   * The pause notice (#265): one comment on the issue, updated in place, with no @mention. It names the account whose
   * usage limit paused the Objective, its reset and window, and the other accounts of that harness this machine declares
   * that are free now, each with the label that moves the Objective to it; `note` is a line about the issue's account
   * labels (pausedHere). Written only when its text changes; a write that fails is logged, never the pause's end. A
   * loop made without the constructor (a test's) writes none.
   */
  async pauseNotice(issue, pause) {
    if (!this.repo) return;
    (this.pauses ??= new Map()).set(issue, pause);
    const body = pauseNoticeBody({ ...pause, free: this.freeAccounts(pause.harness, pause.hold), auto: !!this.auto && !pause.pinned });
    if ((this.pauseBodies ??= new Map()).get(issue) === body) return;
    await upsertComment(this.repo, issue, marker(issue, "account-limit"), body, this.opts).then(
      () => this.pauseBodies.set(issue, body),
      (e) => log(`#${issue}: the pause notice could not be written (${String(e?.message || e).slice(0, 120)}); the pause stands`),
    );
  }

  /** The pause notice of an Objective paused on a pin that is gone (movesEarly), said again as automatic choice words it. */
  async unpinnedNotice(issue) {
    const pause = this.offline?.get(issue)?.harness ? this.pauses?.get(issue) : null;
    if (pause?.pinned) await this.pauseNotice(issue, { ...pause, pinned: false });
  }

  /**
   * The names of `harness`'s declared accounts free now (no hold), but the one held under `heldKey`; none on a bad
   * declaration. With automatic choice on, the ones it would choose: no guess holds them and none is known unready.
   */
  freeAccounts(harness, heldKey) {
    let loaded;
    try {
      loaded = this.loadedAccounts();
    } catch {
      return [];
    }
    return (loaded.accounts?.[harness] || []).filter((a) => {
      const hold = this.holdOf(a);
      return hold.key !== heldKey && this.limitUntil(hold, { guess: !!this.auto }) === null && !(this.auto && this.knownUnready(a));
    }).map((a) => a.name);
  }

  /**
   * Whether an Objective paused on a usage limit here (`off`, limitPaused) resumes before that limit's reset, on the
   * account its labels (`names`, the issue's as pausedHere's listing read them at `at`, its `updated_at`) now name
   * (#265): the one its single `pendulum:account:` label pins, read through the kept labeler check (pinTrust); with none,
   * after a pin came off, its harness's default, but only when the person who removed it can push (a removal anyone
   * else made moves nothing). Yes when that account is another than the one it paused on and is not held; a pinned
   * account that is held waits for its own reset. A label this machine cannot act on (pinFor) keeps it paused, said once
   * in the log and on the pause notice; at the reset the stage starts and Blocks on it (harnessFor). A failed read keeps
   * it paused for the next tick. More than one account label is pausedHere's to hold. With automatic account choice on
   * (#266), no label moves it to a free account by itself (autoAccount), where it would otherwise wait for the default.
   */
  async movesEarly(issue, off, names, at) {
    let to;
    try {
      if (!accountLabels(names).length) {
        if (!off.pinned || !off.pin) {
          // Paused on no label: with automatic choice, on whichever account is free; else nothing to move to, and nothing read.
          if (!this.auto) return false;
          try {
            to = this.autoAccount(off.harness, { prefer: this.pausedOn(issue) }).account;
          } catch {
            // A declaration that cannot be used Blocks the stage at its start, after the reset (harnessFor).
            return false;
          }
          if (!to) return false;
        } else {
          const refused = await this.pinTrust(issue, off.pin, at, "unlabeled");
          if (refused) {
            await this.saidPin(issue, `${refused}, so it stays paused`, { note: true });
            return false;
          }
          if (this.auto) {
            // The pin is gone: the loop moves it itself now, which its notice says.
            await this.unpinnedNotice(issue);
            to = this.autoAccount(off.harness, { prefer: this.pausedOn(issue) }).account;
            if (!to) return false;
          } else to = this.accountFor(off.harness);
        }
      } else {
        const pin = await this.pinFor(issue, names, off.harness, at);
        if (pin.problem) {
          await this.saidPin(issue, `${pin.problem}, so it stays paused`, { note: true });
          return false;
        }
        if (!pin.account) return false;
        to = pin.account;
      }
    } catch (e) {
      await this.saidPin(issue, `its account label could not be checked (${String(e?.message || e).slice(0, 120)}); it stays paused, and the next tick checks again`);
      return false;
    }
    this.pinClear(issue);
    const hold = this.holdOf(to);
    if (hold.key === off.hold || this.limitUntil(hold, { guess: this.auto && !accountLabels(names).length }) !== null) return false;
    log(`#${issue}: moving to ${limitName(off.harness, to.name)}, which is free, before ${limitName(off.harness, off.account)}'s reset${this.auto && !accountLabels(names).length ? " (chosen automatically)" : ""}`);
    return true;
  }

  /**
   * Whether the account an Objective paused on (`off`, limitPaused) is no longer held before the reset the pause kept: its
   * hold and guess are read again from the store each tick (this machine's files, or this loop's memory for a hold kept
   * there), so a person's release (`pendulum hold release`, holds.mjs release), the folder cleared by hand, or any other
   * end of the hold resumes it at the next tick, on that account. Said once, as it resumes.
   */
  heldNoMore(issue, off, now) {
    const stores = [this.holdStore(), this.ownHolds].filter(Boolean);
    if (stores.some((st) => st.avoidUntil(off.hold, now) !== null)) return false;
    const at = this.holdStore().releasedAt?.(off.hold, now) ?? null;
    const probe = this.holdStore().probe?.(off.hold, now) ?? null;
    // A release a probe made (probeHold) is said as one: a serve's, not a person's.
    const by = at !== null && probe?.released === at ? "answered a serve's probe and was released" : "was released (pendulum hold release)";
    const how = at !== null && at > off.since ? `${by} at ${whenText(at)}` : "is no longer held on this machine";
    log(`#${issue}: ${limitName(off.harness, off.account)} ${how}; resuming it now, before the reset it paused for`);
    return true;
  }

  /**
   * A hold work of this loop waits on at this tick (limitHold: a review or new work it holds; pausedHere: an Objective
   * paused on it): the ones probeHolds weighs, so a hold nothing waits on is never probed.
   */
  wantHold(harness, key) {
    (this.holdWants ??= new Map()).set(key, harness);
  }

  /**
   * The re-check of usage-limit holds (#613): a provider may lift a limit before the reset it named (a reset on the
   * account, a plan change), and nothing else would find out before that reset, days away on a weekly window. For each
   * hold work of this loop waited on this tick (wantHold), on Claude Code or Codex (Copilot reports no reset, so nothing
   * of its is held to one), whose reset is more than PROBE_NEAR_MS ahead and that no serve on this machine probed within
   * PROBE_EVERY_MS (holds.mjs probeDue), it takes the turn in the machine's holds (so another serve here probes nothing
   * meanwhile) and starts one probe (probeHold), without waiting for it: the tick goes on, and a hold the probe releases
   * is read at the next one (heldNoMore, limitHold). One probe per account at a time in this loop. The turn is a record
   * read and then replaced, with no lock: two serves that read it in the same moment may each probe once. A hold of a
   * per-model window this loop runs no model of is not probed (said once per hold). Returns the
   * probes it started, settled together (a test's wait).
   */
  probeHolds() {
    const wants = this.holdWants ?? new Map();
    this.holdWants = new Map();
    const started = [];
    for (const [key, harness] of wants) {
      if (harness === "copilot" || this.probing?.has(key) || this.stopping) continue;
      let found = null;
      try {
        const account = harnessAccounts(this.loadedAccounts(), harness).find((a) => this.holdOf(a).key === key);
        if (account) found = { account, hold: this.holdOf(account) };
      } catch {
        // A declaration that cannot be used: nothing to probe on.
      }
      if (!found) continue;
      const now = (this.clock ?? Date.now)();
      const store = this.holdStore(found.hold);
      if (!store.probeDue(key, now)) continue;
      const who = limitName(harness, found.account.name);
      // A per-model window (usage.mjs windowFamily) that none of this loop's models is of: no probe of this loop's
      // could release it (probeHold), so none is made and nothing is spent. Said once per hold.
      const window = store.window(key, now);
      const family = windowFamily(window);
      if (family && harness === this.harness && modelFamily(this.probeModel(harness, accountEnv(this.baseEnv(), found.account), family)) !== family) {
        const said = `${key}@${store.until(key, now)}`;
        if (!(this.probeSkipSaid ??= new Set()).has(said)) {
          this.probeSkipSaid.add(said);
          log(`${who}: its usage limit is of the ${window} window, and this loop runs no ${family} model to check it with, so it is not probed: the hold stands until its reset (${logTime(store.until(key, now))}) or \`pendulum hold release ${key}\``);
        }
        continue;
      }
      store.probed({ harness, account: key, now });
      const p = this.probeHold(harness, found.account, found.hold, now)
        .catch((e) => log(`${who}: the probe of its usage limit failed (${String(e?.message || e).slice(0, 160)}); the hold stands`))
        .finally(() => this.probing.delete(key));
      (this.probing ??= new Map()).set(key, p);
      started.push(p);
    }
    return Promise.all(started);
  }

  /**
   * The model a probe of `harness` runs on, for a hold whose window limits `family` (usage.mjs windowFamily; null: a
   * window of every model): of the models this loop's stages run when the harness is the loop's (worker, reviewer,
   * sub-agent), the first of that family, else the worker's; the harness's default for another harness's account.
   */
  probeModel(harness, env, family) {
    if (harness !== this.harness) return null;
    const inputs = resolveInputs({ args: { repo: this.repoFull }, env });
    const models = [inputs.model, inputs.reviewerModel, inputs.subagentModel].filter(Boolean);
    return (family ? models.find((m) => modelFamily(m) === family) : null) ?? models[0] ?? null;
  }

  /**
   * One probe of a held account (probeHolds): a single decision-free call through the account's own harness and login
   * (harness.mjs runDecision: a fixed prompt, no tool, no file write, no session kept, one turn, under its dollar and
   * time cap). It is no stage's and no Objective's: nothing of it is a stage's work, spend or record.
   * - Its model is one the hold's window limits (probeModel): a hold kept for a per-model window (`seven_day_opus`) is
   *   probed on a model of that family, since another model's answer says nothing of that window.
   * - Answered (probeServed: a real result the provider served, with output; and, for a per-model window, by a model of
   *   its family): the hold is released as `pendulum hold release` does (holds.mjs release: one release record, for
   *   every serve here), so the Objectives paused on it resume at the next tick and new stages start on it.
   * - Refused for the usage limit or quota: the hold stands, and the next probe is PROBE_EVERY_MS on.
   * - Anything else (no answer, another refusal, a harness that did not start, the time cap): the hold stands, the same.
   * Its cost is kept with the account's last probe in the machine's holds (holds.mjs probed: with `released`, when it
   * released the hold) and said in the log, as its harness reported it: dollars, or a run of unknown cost with its
   * reason (usage.mjs UNKNOWN_WHY), never an estimate.
   * `tookAt`: when probeHolds took the turn.
   */
  async probeHold(harness, account, hold, tookAt) {
    const who = limitName(harness, account.name);
    const store = this.holdStore(hold);
    // The probe runs on its own harness's login folder alone, as a stage does (stageEnv).
    const env = { ...accountEnv(this.baseEnv(), account) };
    for (const [h, k] of [["claude", "CLAUDE_CONFIG_DIR"], ["codex", "CODEX_HOME"]]) if (h !== harness) delete env[k];
    const window = store.window(hold.key, tookAt);
    const family = windowFamily(window);
    const model = this.probeModel(harness, env, family);
    // runDecision is a stage's call, run here in serve's own process: it meters into harness.mjs's STAGE_SPEND, which
    // serve never reads or writes anywhere (a stage's spend is its worker process's), and it ends on stageStopSignal,
    // which nothing in serve raises; serve's own stop ends it through `probeStop`.
    const rec = await runDecision({ harness, model, prompt: "Reply with the single word ok.", env, label: "limit probe", signal: (this.probeStop ??= new AbortController()).signal });
    // The models that answered, as the harness reported them; a per-model window is lifted only by one of its family.
    const answeredBy = rec.models && Object.keys(rec.models).length ? Object.keys(rec.models) : [rec.model ?? model];
    const onWindow = !family || answeredBy.some((m) => modelFamily(m) === family);
    const outcome = rec.refusal ? (refusalCause(rec.refusal) === "provider-quota" ? "limited" : "failed") : probeServed(rec) && onWindow ? "answered" : "failed";
    const now = (this.clock ?? Date.now)();
    const cost = { usd: typeof rec.usd === "number" && Number.isFinite(rec.usd) ? rec.usd : null, ...unknownOf([rec]) };
    const record = { harness, account: hold.key, now: tookAt, outcome, ...cost, billing: passBilling(childBilling(harness, env), rec), model: rec.model ?? model };
    const spent = `${cost.usd !== null ? `$${cost.usd.toFixed(4)}` : "no cost reported"}${cost.usdUnknown ? `, of unknown cost (${cost.usdUnknownWhy.join(", ") || "unreported"})` : ""}`;
    const until = store.until(hold.key, now);
    if (outcome !== "answered") {
      store.probed(record);
      const why = outcome === "limited" ? "its usage limit still refuses it" : rec.refusal ? `the provider refused it (${refusalFields(rec.refusal) || "no status"})` : probeServed(rec) ? `it was answered by ${answeredBy.filter(Boolean).join(", ") || "a model it did not name"}, which its ${window} window does not limit` : `it got no answer (${String(rec.error || "no result the provider served").slice(0, 120)})`;
      log(`${who}: probed before its usage limit's reset${until !== null ? ` (${logTime(until)})` : ""}: ${why}; the hold stands, and it is probed again in ${minutesText(PROBE_EVERY_MS)} at the soonest (the probe: ${spent})`);
      return outcome;
    }
    // Released only while the hold the probe was started for still stands: a limit met since is a later fact.
    if (until === null || store.limitedAt(hold.key, now) > tookAt) {
      store.probed(record);
      log(`${who}: answered a probe (${spent}); ${until === null ? "its hold had ended already" : "a stage met its usage limit again meanwhile, so the hold stands"}`);
      return outcome;
    }
    // Checked, then written, with no lock: a limit another serve's stage meets between the two is ended by this release
    // too. That stage's Objective then resumes, meets the limit again and holds the account again: one start, no more.
    store.release({ account: hold.key, now });
    store.probed({ ...record, released: now });
    // Answered on paid extra usage (usage.mjs `overage`): the plan's own limit may still stand, and stages would run on it.
    const overage = rec.overage === true ? "; the answer ran on paid extra usage past the plan's limit, so stages on it may too" : "";
    log(`${who}: answered a probe before its usage limit's reset (${logTime(until)}): the limit was lifted early, so its hold is released, as \`pendulum hold release ${hold.key}\` does; stages start on it again at the next tick${overage} (the probe: ${spent})`);
    return outcome;
  }

  /**
   * Where `hold`'s record is kept (holdOf): this machine's holds (lib/holds.mjs), else this loop's memory. A loop made
   * without the constructor (a test's) keeps all of them in its memory.
   */
  holdStore(hold = { shared: true }) {
    return hold.shared ? (this.holds ??= accountHolds()) : (this.ownHolds ??= accountHolds());
  }

  /**
   * The hold an account's usage limit is kept under, {key, shared}: a declared account's name; for the one a harness
   * has with none declared, its login, as `<harness>@<hash>` of the login's real path (CLAUDE_CONFIG_DIR else ~/.claude,
   * CODEX_HOME else ~/.codex, ~/.config/pendulum/copilot-token), never of a secret: so two serves on two logins never
   * hold each other. A Copilot token from serve's environment (COPILOT_GITHUB_TOKEN) names no login: its hold stays in
   * this loop's memory (`shared` false).
   */
  holdOf(account) {
    if (account.declared) return { key: account.name, shared: true };
    const home = homedir();
    if (account.harness === "copilot" && process.env.COPILOT_GITHUB_TOKEN) return { key: "copilot@env", shared: false };
    const path = account.harness === "copilot" ? copilotTokenFile(home) : stageLogin(account.harness, process.env, home)?.dir;
    if (!path) return { key: `${account.harness}@env`, shared: false };
    let at = resolve(path);
    try {
      at = realpathSync(at);
    } catch {
      // not made yet: its path as named
    }
    return { key: `${account.harness}@${createHash("sha256").update(at).digest("hex").slice(0, 12)}`, shared: true };
  }

  /**
   * The reset (ms) of `hold`'s usage limit (holdOf) when a stage on this machine met it and it is still ahead, else null.
   * With `guess`, for automatic account choice, a no-reset limit's guess too (holds.mjs avoidUntil).
   */
  limitUntil(hold, { guess = false } = {}) {
    const now = (this.clock ?? Date.now)();
    return guess ? this.holdStore(hold).avoidUntil(hold.key, now) : this.holdStore(hold).until(hold.key, now);
  }

  /**
   * Why an Objective with these labels starts nothing now, or null: more than one account label (#265: it waits on no
   * account, said once), or the account it runs on (its harness, from its harness label, choice.mjs choiceOf, else the
   * loop's; the account its one `pendulum:account:<name>` label names when its labeler is known to be trusted, else that
   * harness's default, accountFor) has its usage limit spent (limitUntil). Read on labels the caller already holds (the
   * dispatcher's listing, pendingReviews' read; `issue` and `at`, its number and `updated_at` there), never a read in its
   * own path: an account label's labeler is the kept check (pinTrustKept), read in the background for the next tick, and
   * until it is known (or when it is refused) the default account is the one weighed. A pin this machine cannot act on
   * starts, and Blocks at the start (harnessFor). The account declaration is read only while an account of that
   * harness is held. Each hold is said once. With automatic account choice on (#266), an Objective the pin does not
   * place is held only while every account of its harness is held, until the first of them resets.
   */
  limitHold(labels, issue = null, at = null) {
    const c = choiceOf(labels || []);
    const harness = (c.ok && c.choice.harness) || this.harness;
    const pin = accountPin(labels);
    if (pin.two) {
      if (issue !== null) this.noting(this.sayTwo(issue, pin.two));
      return twoPinsLine(pin.two);
    }
    if (issue !== null && this.twoNoted?.has(issue)) this.noting(this.twoCleared(issue));
    const now = (this.clock ?? Date.now)();
    if (!this.holdStore().held(harness, now, !!this.auto) && !this.ownHolds?.held(harness, now, !!this.auto)) return null;
    let account;
    let every = null;
    try {
      const loaded = this.loadedAccounts();
      account = defaultAccount(loaded, harness);
      if (pin.label && validAccountName(pin.name) && issue !== null && this.pinTrustKept(issue, pin.label, at) === null) {
        const r = pinnedAccount(loaded, harness, pin.name);
        // A name this machine cannot run the Objective on Blocks its stage at the start (harnessFor): not a hold.
        if (r.problem) return null;
        account = r.account;
      } else if (this.auto) every = harnessAccounts(loaded, harness);
    } catch {
      // A declaration that cannot be used Blocks the stage at its start (harnessFor): not a hold.
      return null;
    }
    if (every) {
      const ends = every.map((a) => ({ a, hold: this.holdOf(a), until: this.limitUntil(this.holdOf(a), { guess: true }) }));
      // One free and not known unready: it starts. None held (each unready): the start Blocks, naming them (harnessFor).
      if (ends.some((e) => e.until === null && !this.knownUnready(e.a))) return null;
      const held = ends.filter((e) => e.until !== null);
      if (!held.length) return null;
      const first = held.reduce((x, y) => (y.until < x.until ? y : x));
      for (const e of held) this.saidLimit(harness, e.a.name, e.hold, e.until, e.until !== this.limitUntil(e.hold));
      for (const e of held) this.wantHold(harness, e.hold.key);
      const h = HARNESS_NAMES[harness] || harness;
      // The first to end may be a guess (no reset reported): an estimate, said as one.
      const at = `${first.until !== this.limitUntil(first.hold) ? "about " : ""}${whenText(first.until)}`;
      if (every.length === 1) return `${limitName(harness, first.a.name)}'s usage limit is spent until ${at}`;
      return held.length === every.length ? `every ${h} account on this machine has its usage limit spent; the first, ${limitName(harness, first.a.name)}, resets at ${at}` : `every ${h} account on this machine has its usage limit spent or cannot run here; the first to reset, ${limitName(harness, first.a.name)}, resets at ${at}`;
    }
    const hold = this.holdOf(account);
    const until = this.limitUntil(hold);
    if (until === null) return null;
    this.saidLimit(harness, account.name, hold, until);
    this.wantHold(harness, hold.key);
    return `${limitName(harness, account.name)}'s usage limit is spent until ${whenText(until)}`;
  }

  /** The log line that no stage starts on `account` until its usage limit's reset (`until`, ms): once per reset. */
  saidLimit(harness, account, hold, until, guessed = false) {
    const key = `${hold.key}@${until}`;
    if ((this.limitSaid ??= new Set()).has(key)) return;
    this.limitSaid.add(key);
    const who = limitName(harness, account);
    if (guessed) log(`${who} reached its usage limit with no reset reported; automatic account choice passes it over until about ${logTime(until)}`);
    else log(`${who}'s usage limit is spent until ${logTime(until)}; no stage starts on ${who} until then`);
  }

  /**
   * Running or In-review Objectives a loop on this machine held when it went away (serve stopped, the machine slept or
   * restarted): ours to resume, at once when that loop's process is gone, else once its heartbeat is stale. One of this
   * loop's own counts too: at once when its stage ended here with no exit record (its one resume, lapse), else once
   * stale (its read-back after claiming failed).
   */
  async pausedHere(running) {
    const out = [];
    const issues = [];
    for (const label of ["pendulum:running", "pendulum:in-review"]) issues.push(...(await listIssuesByLabel(this.repo, label, this.opts).catch(() => [])));
    for (const issue of issues) {
      if (running.has(issue.number) || out.includes(issue.number)) continue;
      if (!BACKENDS.local.trigger.routes(issue, this.baseEnv())) continue;
      // A stopped Objective (its label removed: stop.mjs) is not resumed; the dispatcher's stopped pass tidies it. Its
      // outage pause, if it had one, is over with it.
      if (stopCause(issue, this.objectiveLabel())) {
        this.offline?.delete(issue.number);
        continue;
      }
      const c = await localClaim(this.repo, issue.number, this.opts).catch(() => null);
      if (!c || !sameMachineHolder(c.holder)) continue;
      // A claim this loop stepped aside from (cede): another loop's under its name until that loop's next heartbeat.
      if (c.holder === this.holder && this.ceded?.has(issue.number)) continue;
      // Paused on an outage: resumed once outageDue says so (GitHub answered these reads).
      const off = c.holder === this.holder ? this.offline?.get(issue.number) : null;
      if (off) {
        // Paused on a usage limit (limitPaused: its hold, the backoff floor included) or GitHub's spent rate limit:
        // resumed once its reset has passed, with no probe; on a usage limit, sooner on another account that is free
        // (movesEarly: its account label moved it, or came off).
        const now = (this.clock ?? Date.now)();
        const names = (issue.labels || []).map((l) => (typeof l === "string" ? l : l?.name));
        // More than one account label (#265): a stage that waited on them, or a usage-limit pause, waits on, past its
        // reset too, until one is left; said once. Never Blocked for it.
        const two = accountPin(names).two;
        if (two && (off.pinWait || off.harness)) {
          await this.sayTwo(issue.number, two);
          await this.beatPaused(issue.number, c);
          continue;
        }
        await this.twoCleared(issue.number);
        const due = off.pinWait || (off.harness && Number.isFinite(off.reset) ? now >= off.reset || (!!off.hold && (this.heldNoMore(issue.number, off, now) || (await this.movesEarly(issue.number, off, names, issue.updated_at ?? null)))) : await this.outageDue(off, now));
        if (due) out.push(issue.number);
        // Waiting on a usage limit's reset, on its account labels or on GitHub's 5xx: its claim kept alive while this loop is.
        else if (off.harness || (serverDown(off.code) && off.server)) await this.beatPaused(issue.number, c);
        // Still waiting on its account's hold: one of the holds this tick's probe pass weighs (probeHolds).
        if (!due && off.harness && off.hold) this.wantHold(off.harness, off.hold);
        continue;
      }
      if (c.holder === this.holder ? !!this.lapsed?.has(issue.number) || !c.fresh : !c.fresh || deadHereHolder(c.holder, { own: this.holder })) out.push(issue.number);
    }
    return out;
  }

  /**
   * Whether an Objective this loop holds paused on an outage (`off`, its outagePaused record) is due to resume at `now`,
   * as serve's tick decides it (pausedHere) and `run --wait` in place (waitPaused). Paused on GitHub's spent rate limit:
   * once its reset has passed, with no probe (GitHub answers while the limit is spent). Paused on GitHub's 5xx or a
   * provider's busy answer: after its doubling wait (serverWait), not on a probe, which answers while one endpoint fails.
   * Paused on this machine's network: once the host it could not reach answers a probe. Either of the last two at once
   * past OUTAGE.blockMs, so resume Blocks it (a provider unreachable while GitHub answers would otherwise stay Running
   * with no notice).
   */
  async outageDue(off, now) {
    if (Number.isFinite(off.reset)) return now >= off.reset;
    if (serverDown(off.code) && off.server) return now - off.since >= OUTAGE.blockMs || now >= off.server.at + serverWait(off.server.pauses);
    return !off.origin || now - off.since >= OUTAGE.blockMs || (await probeHost(off.origin)) === null;
  }

  /**
   * Remove the Objective directories (clone, caches, stage logs and sessions) of Objectives that are closed: done or
   * abandoned, nothing will resume them. Open ones stay, Blocked included, for a human re-label to pick up where they
   * stood. Not while running here, and never on a failed lookup.
   */
  async cleanup(running) {
    const root = join(this.dev, ".pendulum");
    let names = [];
    try {
      names = readdirSync(root).filter((n) => /^\d+$/.test(n));
    } catch {
      return;
    }
    for (const name of names) {
      const issue = Number(name);
      if (running.has(issue)) continue;
      const data = await getIssue(this.repo, issue, this.opts).catch(() => null);
      if (data?.state !== "closed") continue;
      // A harness a dead stage left goes first: its record is in the directory removed below. A stage still running is left.
      this.reapHere(issue);
      const live = liveStage(join(root, name));
      if (live) {
        log(`${liveStageLine(issue, live)}; the closed Objective's directory stays until then`);
        continue;
      }
      // Of .pendulum only <issue>/claude-project is writable from a sandbox (claudeProjectLink); rmSync removes a link, never its target, so nothing planted there is followed.
      rmSync(join(root, name), { recursive: true, force: true });
      // And the link to its Claude Code project, if a stage made one (lib/local.mjs claudeProjectLink).
      // In every Claude Code folder on the machine: a stage may have run on any of them.
      for (const l of harnessLogins(homedir(), process.env).filter((x) => x.harness === "claude")) dropClaudeProjectLink(join(root, name, "repo"), { CLAUDE_CONFIG_DIR: l.dir });
      log(`#${issue}: closed; removed its local directory .pendulum/${name}`);
    }
  }

  /**
   * What an Objective paused on GitHub's 5xx (`off`, its outagePaused record) does once its doubling wait is over,
   * decided by GitHub's own status page (lib/adapters/github-status.mjs): {block: what the page said} | {once: true} |
   * null (wait on). A part of GitHub its requests use degraded, an unresolved incident, a maintenance in progress, or the
   * page not readable (no answer, or no page for this GitHub host): an incident, so it is resumed and waits on, up to
   * OUTAGE.blockMs from its first pause, and an earlier one more try counts no more. All operational: the 5xx is the
   * request's own, so it gets one more try (`once`: resume grants it, and tryStarted marks it made once the stage's
   * process has started); when that try
   * pauses on a 5xx of the same request again with the page still operational, `block`. Logged once per pause.
   */
  async serverVerdict(issue, off) {
    const s = await githubStatus();
    const parts = [...s.components.map((c) => `${c.name} ${c.status}`), ...s.incidents.map((n) => `incident "${n}"`), ...s.maintenances.map((n) => `maintenance "${n}" in progress`)].join(", ");
    const missing = /^missing /.test(s.error ?? "") ? s.error.slice("missing ".length) : null;
    const said = missing
      ? `GitHub's status page no longer lists its "${missing}" component: Pendulum's contract with the page (lib/adapters/github-status.mjs) is broken`
      : s.state === null
        ? `GitHub's status page could not be read (${s.error})`
        : `GitHub's status page reported ${parts}`;
    if (s.state === "operational" && off.server.tried) return { block: said };
    off.server.tryGranted = false;
    if (s.state !== "operational") off.server.tried = false;
    const line = `${said}; ${s.state === "operational" ? "the 5xx is this request's: one more try" : `waiting it out as an incident, up to ${minutesText(OUTAGE.blockMs)} from ${whenText(off.since)}`}`;
    if (off.server.said !== `${off.server.pauses} ${line}`) log(`#${issue}: ${line}`);
    off.server.said = `${off.server.pauses} ${line}`;
    return s.state === "operational" ? { once: true } : null;
  }

  /**
   * A stage of `issue` has started its process (stage()): the one more try resume granted its 5xx (serverVerdict) is
   * made now, so it is not made again.
   */
  tryStarted(issue) {
    const server = this.offline?.get(issue)?.server;
    if (server?.tryGranted) Object.assign(server, { tried: true, tryGranted: false });
  }

  /**
   * Pick a paused Objective up where it stands: its open PR's review, else its work from the clone and saved sessions.
   * One paused on this machine's network for OUTAGE.blockMs or more is Blocked instead, with the External cause
   * `outage`, naming the host and since when; so is one paused on GitHub's 5xx for as long, naming the request and the
   * status. One paused on GitHub's 5xx while GitHub's status page reports its parts operational is Blocked naming the
   * request after one more try (serverVerdict), with the cause `pendulum`: GitHub has no incident, so the request fails
   * on its own. `wait` (`run --wait`): the stage resumed follows its PR to the merge, as the run would have.
   */
  async resume(issue, { wait = false, now: at = null } = {}) {
    const off = this.offline?.get(issue);
    // `now`: the moment the caller judged the pause by (waitPaused), so the bound is read at the same time.
    const now = at ?? (this.clock ?? Date.now)();
    const paused = !!off && !off.harness && !off.pinWait;
    // Only GitHub's own 5xx is GitHub's status page's to judge: a pause on another host waits on, within the bound.
    const verdict = paused && serverDown(off.code) && !!off.server && off.origin === githubOrigin() && now - off.since < OUTAGE.blockMs ? await this.serverVerdict(issue, off) : null;
    const own = verdict?.block ?? null;
    if (paused && (own || now - off.since >= OUTAGE.blockMs)) {
      // GitHub answers here; the host the stage could not reach may still not (a provider), and the notice says which.
      const back = serverDown(off.code) || !off.origin || (await probeHost(off.origin)) === null;
      const reason = own
        ? `${lostText(off.host, off.code, off.endpoint)} from ${whenText(off.server.requestSince ?? off.since)}; ${own}, before and after one more try, so the failure is this request's, not a GitHub incident. Re-apply the label to run it again once that request is fixed.`
        : serverDown(off.code)
          ? `${lostText(off.host, off.code, off.endpoint)} from ${whenText(off.since)}, through ${pausesText(off.server?.pauses ?? 1)} over ${minutesText(now - off.since)}, past Pendulum's ${minutesText(OUTAGE.blockMs)} bound for ${off.host} failing. Re-apply the label to run it again once ${off.host} answers that request.`
          : `${lostText(off.host, off.code)} from ${whenText(off.since)} for ${minutesText(now - off.since)}, past Pendulum's ${minutesText(OUTAGE.blockMs)} bound for an outage. ${back ? "The network is back: re-apply the label to run it again." : `${off.host} is still unreachable from this machine: re-apply the label once it answers.`}`;
      log(`#${issue}: ${reason}`);
      try {
        await this.block(issue, off.stage || "work", reason, { cause: own ? "pendulum" : "outage" });
        await dropClaim(this.repo, issue, this.holder, this.opts);
        this.offline.delete(issue);
        return { exit: "blocked" };
      } catch (e) {
        log(`#${issue}: the outage's Block could not be written (${String(e?.message || e).slice(0, 120)}); the next tick tries again`);
        return { exit: "skipped" };
      }
    }
    if (off) off.resumedAt = now;
    this.reapHere(issue);
    const live = liveStage(this.ws(issue));
    if (live) {
      // Once per stage process, not every tick.
      this.saidLive ??= new Set();
      if (!this.saidLive.has(`${issue}:${live.pid}`)) log(`${liveStageLine(issue, live)}; not resuming beside it`);
      this.saidLive.add(`${issue}:${live.pid}`);
      return { exit: "skipped" };
    }
    // Both reads answer, or nothing changes: a failed one is no "nothing left", so the claim stays for the next tick.
    let pr;
    let data;
    try {
      pr = await findPr(this.repo, `pendulum/${issue}`, this.opts);
      data = await getIssue(this.repo, issue, this.opts);
    } catch (e) {
      log(`#${issue}: its PR or issue could not be read (${String(e.message).slice(0, 120)}); the claim stays and the next tick tries again`);
      return { exit: "skipped" };
    }
    // A PR still waiting for its review pass goes to review (as pendingReviews); Running work (a first run, or a
    // send-back rebase) runs again; anything else (reviewed, waiting in the merge queue) needs nothing here.
    const next = stageFor({ pr, issue: data });
    // The one more try a 5xx got (serverVerdict) is only granted here: it is made when the stage's process starts
    // (tryStarted), so a resume skipped above, a claim that cannot be read or written, or a start that fails makes none.
    if (verdict?.once) off.server.tryGranted = true;
    if (next === "review") return this.withClaim(issue, () => this.review(issue, pr.number, { wait }));
    if (next === "work") return this.runObjective(issue, { wait });
    // A review this loop holds paused after its label came off (an outage met on its merge path: session.mjs outageFirst)
    // ends nothing by the label: the review runs again, and its exit or merge follows.
    if (next === "merge" && off?.stage === "review") return this.withClaim(issue, () => this.review(issue, pr.number, { wait }));
    // `run --wait` paused on its merge path (a send-back's rebase): following the merge goes on, as the run did.
    if (next === "merge" && wait) return this.withClaim(issue, () => this.followToMerge(issue, pr.number));
    log(`#${issue}: nothing left to run here (its PR is reviewed or gone); releasing the claim`);
    const held = await localClaim(this.repo, issue, this.opts).catch(() => null);
    if (held?.commentId && sameMachineHolder(held.holder)) await rest(`repos/${this.repo.full}/issues/comments/${held.commentId}`, { ...this.opts, method: "DELETE" }).catch(() => {});
    this.lapsed?.delete(issue);
    return { exit: "skipped" };
  }

  async review(issue, prNumber, { wait = false, reruns = 0 } = {}) {
    const review = await this.stage(issue, "review", "review.mjs", ["--pr", String(prNumber)]);
    log(`#${issue} review of PR #${prNumber}: ${stageEndText(review)}`);
    // Waiting for a third-party reviewer (third-party-review.mjs): serve's dispatcher ticks put the label back. `run` and
    // `review`, which may have no serve behind them, do the same here, so the label is never left off with nothing to
    // put it back, and then review again.
    if (!this.serving && review.exit === "waiting") return (await this.thirdPartyWait(issue, prNumber)) ? this.review(issue, prNumber, { wait, reruns }) : review;
    if (wait && review.exit === "delivered") {
      // A maintainer commented during the review: it re-applied the label instead of arming the merge. Run it again,
      // at most twice here; after that the label stays and the next serve tick (or a `review` run) takes it.
      const pr = await getPr(this.repo, prNumber, this.opts).catch(() => null);
      if ((pr?.labels || []).some((l) => l.name === REVIEW_LABEL)) {
        if (reruns < 2) return this.review(issue, prNumber, { wait, reruns: reruns + 1 });
        log(`#${issue}: PR #${prNumber} still has comments arriving after ${reruns} review re-runs; left labelled ${REVIEW_LABEL} for the next serve tick`);
        // With --wait, delivered is merged: this one is not.
        return { exit: null };
      }
      // Delivered only once merged (followToMerge): a stage of its merge path that ended paused (a review again, a
      // send-back's rebase) is this end, so the claim stays for its resume; any other end of the follow (Blocked at the
      // merge, stopped, held, closed, the follow's bound) is none.
      const merged = await this.followToMerge(issue, prNumber);
      if (merged.exit !== "delivered") return merged;
      if (merged.next) return { ...review, next: true };
    }
    return review;
  }

  /**
   * `run` or `review` (not serve), a review stage that ended waiting for a third-party reviewer: what serve's dispatcher
   * does for it (third-party-review.mjs waitState), read once a minute: true once the review label is back on (put back
   * here, that review of the head existing, the bound passed or the head moved, or by another loop or the Action), false
   * when there is nothing to wait for (no record, the PR closed, a review asked for since) or this loop is stopping.
   * `gh` is for tests.
   */
  async thirdPartyWait(issue, prNumber, { pollMs = THIRD_PARTY_POLL_MS, gh = { getPr, listComments, addLabels } } = {}) {
    const reads = new Map();
    while (!this.stopping) {
      const pr = await gh.getPr(this.repo, prNumber, this.opts).catch(() => null);
      const comments = pr ? await gh.listComments(this.repo, prNumber, this.opts).catch(() => null) : null;
      if (pr && (pr.labels || []).some((l) => (typeof l === "string" ? l : l.name) === REVIEW_LABEL)) return true;
      if (pr && comments) {
        const state = await waitState({ repo: this.repo, issue, pr, wait: waitOf(comments, issue), opts: this.opts, now: (this.clock ?? Date.now)(), reads });
        if (!state || state.stale) return false;
        if (state.resume) {
          const back = await gh.addLabels(this.repo, prNumber, [REVIEW_LABEL], this.opts).then(() => true, (e) => log(`#${issue}: the review label could not be put back (${String(e?.message || e).slice(0, 120)}); trying again`));
          if (back) {
            log(`#${issue}: PR #${prNumber}: the third-party wait is over (${state.resume}); the review goes on`);
            return true;
          }
        }
      }
      await this.pause(pollMs);
    }
    return false;
  }

  /**
   * One Objective, start to delivered review (and, with `wait`, to merged). `named`: a person named it (`pendulum run`),
   * so its hand-off to review never waits for a sibling (work).
   */
  async runObjective(issue, { wait = false, named = false } = {}) {
    // A stage of this Objective still running on this machine (an earlier serve's, orphaned): never a second beside it,
    // and its claim stays as it is.
    this.reapHere(issue);
    const live = liveStage(this.ws(issue));
    if (live) {
      log(`${liveStageLine(issue, live)}; not starting beside it`);
      return { exit: "skipped" };
    }
    try {
      return await this.withClaim(issue, () => this.work(issue, { wait, named }), { onStop: () => this.unpickStopped(issue), stint: true });
    } catch (e) {
      if (!e?.startFailed) throw e;
      return this.unstart(issue, e);
    }
  }

  /**
   * The Objectives whose last start on this loop failed, still in their backoff: issue -> the reason serve's dispatch
   * holds it with (localHeld), so it is not picked, nor marked Running, before its backoff ends. This loop's memory only.
   * One with no failed start counted (it failed only during a machine hold) is held only while its claim waits to be
   * read again: the machine hold (machineWait) holds new starts meanwhile.
   */
  startHolds(now = (this.clock ?? Date.now)()) {
    const out = {};
    for (const [n, f] of this.startFailures ?? []) {
      if (now >= f.retryAt || (f.count === 0 && !f.recheck)) continue;
      out[n] = f.count === 0 ? `its start here failed on a fault of this machine; its claim is read again after ${whenText(f.retryAt)}` : `its last start here failed (${f.count} in a row); tried again after ${whenText(f.retryAt)}`;
    }
    return out;
  }

  /**
   * A start that failed before its work stage ran (the claim, the clone, prepareClone, a directory): the real error is
   * logged and the Objective goes back to Queued, its claim dropped, rather than sitting Running for the dispatcher to
   * Block with no cause. This loop then holds it for a backoff (START_BACKOFF_MS, doubling to START_BACKOFF_MAX_MS).
   * The same cause (startCause: its kind and code) on two or more Objectives within START_BACKOFF_MS is the machine's (a
   * full disk, a broken sandbox, GitHub out of reach): this loop holds new starts until a probe of that cause passes, and
   * no failed start is counted while the hold lasts (machineFault, machineWait). A cause seen on one Objective alone, or
   * again after its probe passed, is counted: the third failed start of an Objective in a row Blocks it once, with the
   * error as postedError has it (cause `setup`).
   * When the claim could not be read, or was another loop's, who holds it is unknown: nothing changes now, and after the
   * backoff this loop reads the claim again (recheckStarts). Only an Objective still labelled Running is un-marked or
   * Blocked; otherwise, or on a failed read, the claim stays, goes stale and this loop resumes it (pausedHere).
   */
  async unstart(issue, e) {
    const out = { code: null, exit: null, usd: null, usageDir: null, startFailed: e.startFailed };
    log(`#${issue}: could not start (${e.startFailed}): ${String(e?.message || e).slice(0, 300)}`);
    const error = postedError(e).slice(0, 300);
    const failures = (this.startFailures ??= new Map());
    const cause = startCause(e);
    const machine = this.machineFault(issue, cause, e);
    // While the machine's hold lasts, a failed start charges no Objective: its count stays as it is.
    const count = (failures.get(issue)?.count ?? 0) + (machine ? 0 : 1);
    const unknown = e.startFailed === "claim-read" || !!e.othersClaim;
    const backoff = (recheck = unknown) => {
      const retryAt = (this.clock ?? Date.now)() + Math.min(START_BACKOFF_MS * 2 ** (Math.max(count, 1) - 1), START_BACKOFF_MAX_MS);
      failures.set(issue, { count, retryAt, recheck });
      return logTime(retryAt);
    };
    // Only serve reads its failed starts again (recheckStarts); `run --wait` waiting a pause out polls again (waitPaused).
    const readAgain = (at) => (this.serving ? `this loop reads its claim again after ${at}` : this.waitingOn === issue ? `this run reads it again after ${at}` : "a later `pendulum run` or serve on this machine reads it again");
    try {
      const data = await getIssue(this.repo, issue, this.opts);
      if (!(data?.labels || []).some((l) => (typeof l === "string" ? l : l.name) === "pendulum:running")) {
        // No longer Running (a person moved it): nothing of this loop's to undo or read again.
        failures.delete(issue);
      } else if (count >= START_FAILURES_BLOCK) {
        await this.block(issue, "work", `could not start on this machine ${count} times in a row (${e.startFailed}${e.code ? `, ${e.code}` : ""}): ${error}. Fix the machine (disk space, the sandbox, the harness login), then re-apply the label.`);
        failures.delete(issue);
        if (!unknown) await dropClaim(this.repo, issue, this.holder, this.opts);
        this.lapsed?.delete(issue);
        return { ...out, exit: "blocked" };
      } else if (unknown) log(`#${issue}: who holds it is unknown here, so it stays as it is; ${readAgain(backoff())}`);
      else {
        await this.requeue(issue);
        if (machine) {
          backoff();
          log(`#${issue}: back to Queued; it waits with every new start here for this machine's fault to clear`);
        } else log(`#${issue}: back to Queued; ${this.serving ? `this loop starts it again after ${backoff()}` : (backoff(), "the next pick starts it again (a serve's, or a `pendulum run`)")}`);
      }
    } catch (x) {
      // GitHub failed here too (the issue read, the requeue or the Block): the Objective may still be Running, so this
      // loop reads its claim again after the backoff and settles it then (recheckStarts).
      log(`#${issue}: could not settle the failed start (${String(x?.message || x).slice(0, 120)}); ${readAgain(backoff(true))}`);
    }
    this.lapsed?.delete(issue);
    return out;
  }

  /**
   * Whether this failed start's cause is the machine's: a machine hold on that cause is on, or another Objective's start
   * failed here with the same kind and code within the last START_BACKOFF_MS. Each failed start is recorded here, before
   * anything is awaited, so two starts that fail at once see each other. The hold starts said once in this log, with the
   * cause, what to fix and what new starts wait for. A cause with no code is never the machine's, and neither is one
   * that failed again within an hour of its hold's probe passing: that probe did not explain it, so each Objective is
   * charged and Blocks on its own count (one hold per cause an hour).
   */
  machineFault(issue, cause, e) {
    if (!cause.code) return false;
    const now = (this.clock ?? Date.now)();
    this.startLog = [...(this.startLog ?? []).filter((f) => f.at > now - START_BACKOFF_MS), { issue, kind: cause.kind, code: cause.code, at: now }];
    const key = `${cause.kind} ${cause.code}`;
    const holds = (this.machineHolds ??= new Map());
    const held = holds.get(key);
    if (held) {
      held.issues.add(issue);
      return true;
    }
    const lifted = (this.machineLifts ??= new Map()).get(key);
    if (lifted && now - lifted.at < START_BACKOFF_MAX_MS) {
      if (!lifted.said) log(`#${issue} failed to start the same way (${cause.kind}, ${cause.code}) after this machine's probe for it passed, so the probe does not explain it: each Objective that fails so is charged for it, and Blocks on its own count`);
      lifted.said = true;
      return false;
    }
    const others = [...new Set(this.startLog.filter((f) => f.issue !== issue && f.kind === cause.kind && f.code === cause.code).map((f) => f.issue))];
    if (!others.length) return false;
    const probes = probesOf(cause);
    // The disk the start failed on: the path a system error names, else this repository's Objective directories.
    const path = typeof e?.path === "string" && e.path.startsWith("/") ? e.path : join(this.dev, ".pendulum");
    const issues = new Set([...others, issue]);
    // A clone's fault holds new work only: a resume or a review runs in the clone its work made.
    const all = cause.kind !== "clone";
    holds.set(key, { ...cause, key, probes, path, issues, all, since: now, retryAt: now + START_BACKOFF_MS });
    const list = [...issues].sort((a, b) => a - b).map((n) => `#${n}`).join(", ");
    log(`holding every new ${all ? "stage" : "work start"} on this machine: ${list} failed to start the same way (${cause.kind}, ${cause.code}), which is this machine's fault, not theirs; no Objective is charged for it while the hold lasts. Fix: ${probes.map((p) => PROBE_FIX[p]).join("; ")}. New starts resume once the probe passes: ${probes.map((p) => PROBE_WAIT[p]).join(" and ")}.`);
    return true;
  }

  /**
   * Each tick: the machine holds' probes (machineProbe), each at most once every MACHINE_PROBE_EVERY_MS. A hold whose
   * probe passes ends, said once, and the Objectives it held are free to pick again. Returns what the holds still on
   * hold: `work`, the reason no new work starts (serve's dispatch), and `all`, the reason no resume or review starts
   * either (any hold but a clone's); each null with none.
   */
  async machineWait() {
    const out = { work: null, all: null };
    for (const [key, h] of [...(this.machineHolds ?? [])]) {
      const now = (this.clock ?? Date.now)();
      if (h.probedAt === undefined || now - h.probedAt >= (this.machineProbeEveryMs ?? MACHINE_PROBE_EVERY_MS)) {
        h.problem = await this.machineProbe(h);
        h.probedAt = now;
      }
      if (h.problem === null) {
        this.machineHolds.delete(key);
        (this.machineLifts ??= new Map()).set(key, { at: now, said: false });
        log(`this machine's start fault (${h.kind}, ${h.code}) is gone (${h.probes.map((p) => PROBE_WAIT[p]).join(" and ")}): new starts resume`);
        continue;
      }
      const why = `this machine's starts fail (${h.kind}, ${h.code}): ${h.problem}`;
      out.work ??= why;
      if (h.all) out.all ??= why;
    }
    return out;
  }

  /**
   * Null when every probe of a machine hold's cause passes, else what still fails: the disk's free space against
   * START_DISK_FLOOR (statfs on the failed path, or its nearest folder that exists); `git ls-remote` of the repository
   * with the local token; GitHub's API reading the repository with the local token (a 2xx); srt's sandbox starting
   * (lib/local.mjs sandboxStartProblems on one sandboxed `true`); or, with no probe of its own, the backoff since the
   * hold began. `machineProbes`: a test's own statfs, lsRemote or sandbox.
   */
  async machineProbe(h) {
    const p = { statfs: statfsSync, lsRemote: () => this.lsRemote(), sandbox: () => sandboxProblemsNow(), ...this.machineProbes };
    for (const what of h.probes) {
      if (what === "disk") {
        let free = null;
        for (let dir = h.path; free === null; dir = dirname(dir)) {
          try {
            const s = p.statfs(dir);
            free = Number(s.bavail) * Number(s.bsize);
          } catch {
            if (dir === dirname(dir)) break;
          }
        }
        if (free !== null && free < START_DISK_FLOOR) return `${gb(free)} free on its disk, under the ${PROBE_WAIT.disk} it waits for`;
      } else if (what === "clone") {
        const code = await p.lsRemote();
        if (code !== 0) return `git ls-remote of ${this.repoFull} with the local token failed (exit ${code})`;
      } else if (what === "api") {
        const api = (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");
        try {
          const r = await fetch(`${api}/repos/${this.repoFull}`, { headers: { authorization: `Bearer ${this.token ?? this.opts?.token}`, accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(OUTAGE.probeTimeoutMs) });
          await r.body?.cancel?.().catch(() => {});
          if (!r.ok) return `GitHub's API answered HTTP ${r.status} to reading ${this.repoFull} with the local token`;
        } catch (e) {
          return `GitHub's API does not answer (${causeCode(e) || "no answer"})`;
        }
      } else if (what === "sandbox") {
        const problems = await p.sandbox();
        if (problems.length) return problems[0];
      } else if ((this.clock ?? Date.now)() < h.retryAt) return `one start is tried again after ${whenText(h.retryAt)}`;
    }
    return null;
  }

  /** `git ls-remote` of this repository with the local token, as ensureClone clones it: its exit code. */
  async lsRemote() {
    const helper = "!f() { echo username=x-access-token; echo \"password=$PENDULUM_LOCAL_TOKEN\"; }; f";
    const r = await exec("git", ["-c", "credential.helper=", "-c", `credential.https://github.com.helper=${helper}`, "ls-remote", "-q", `https://github.com/${this.repoFull}.git`, "HEAD"], { env: { ...localBaseEnv(process.env), PENDULUM_LOCAL_TOKEN: this.token, GIT_TERMINAL_PROMPT: "0" }, timeoutMs: 60_000 }).catch(() => ({ code: null }));
    return r.code;
  }

  /** Back to Queued: the Running label off, the card to Queued, this loop's claim dropped. */
  async requeue(issue) {
    await setStateLabel(this.repo, issue, null, this.opts);
    const project = await findProject(this.repo, this.opts).catch(() => null);
    if (project) await moveCard(project, this.repo, issue, "Queued", this.opts).catch(() => {});
    await dropClaim(this.repo, issue, this.holder, this.opts);
  }

  /** A pick this loop marked and never started, back to Queued: only pendulum:running comes off, and the card to Queued. */
  async unpick(issue) {
    await removeLabel(this.repo, issue, "pendulum:running", this.opts);
    const project = await findProject(this.repo, this.opts).catch(() => null);
    if (project) await moveCard(project, this.repo, issue, "Queued", this.opts).catch(() => {});
  }

  /**
   * A work start told to stop before it wrote its claim, with no claim on the issue: an Objective labelled Running (serve's
   * dispatch marked it) goes back to Queued, so it is never left Running with nothing to resume it. Any other state stays.
   */
  async unpickStopped(issue) {
    const data = await getIssue(this.repo, issue, this.opts);
    if (!(data?.labels || []).some((l) => (typeof l === "string" ? l : l.name) === "pendulum:running")) return;
    await this.unpick(issue);
    log(`#${issue}: stopping before its claim was written; back to Queued`);
  }

  /**
   * Each tick: the Objectives whose start failed on a claim this loop could not read, or another loop's, read again once
   * their backoff ends. No live claim of another loop's: back to Queued, for the next pick. A fresh one: that loop has
   * it, and this loop lets it go. Unread again: another failed start (the count goes up; the third Blocks).
   */
  async recheckStarts(running) {
    const now = (this.clock ?? Date.now)();
    for (const [n, f] of [...(this.startFailures ?? [])]) {
      if (!f.recheck || now < f.retryAt || running.has(n)) continue;
      let c;
      try {
        c = await this.readClaim(n);
      } catch (e) {
        await this.unstart(n, Object.assign(e, { startFailed: "claim-read" }));
        continue;
      }
      if (c?.fresh && c.holder !== this.holder && !deadHereHolder(c.holder, { own: this.holder })) {
        this.startFailures.delete(n);
        log(`#${n}: another local loop holds it (${c.holder}); leaving it alone`);
        continue;
      }
      f.recheck = false;
      try {
        const data = await getIssue(this.repo, n, this.opts);
        if ((data?.labels || []).some((l) => (typeof l === "string" ? l : l.name) === "pendulum:running")) {
          await this.requeue(n);
          log(`#${n}: its claim reads free now; back to Queued for the next pick`);
        }
      } catch (x) {
        f.recheck = true;
        log(`#${n}: could not put it back to Queued (${String(x?.message || x).slice(0, 120)}); tried again next tick`);
      }
    }
  }

  /**
   * `pendulum run <issue>`: the stage the Objective's state calls for (stageFor, as serve's resume): its review, its merge
   * (followed with `wait`, else named), or else its work. Refused, with nothing started, for a closed issue, a stage of
   * it still running on this machine, or a GitHub read that keeps failing (retried first): never a work pass on a branch
   * whose state could not be read. `gh`: the GitHub reads, `waitMs` the retry wait (a test's own).
   */
  async runIssue(issue, { wait = false, gh: given = {}, waitMs = 2_000 } = {}) {
    const gh = { findPr, getIssue, listComments, ...given };
    this.reapHere(issue);
    const live = liveStage(this.ws(issue));
    if (live) throw new Error(`${liveStageLine(issue, live)}, then run again`);
    const data = await retried(`reading issue #${issue}`, () => gh.getIssue(this.repo, issue, this.opts), { waitMs });
    if (data?.state === "closed") throw new Error(`#${issue} is closed; nothing to run`);
    // Before any claim: a draft is never run (lib/stop.mjs).
    if (isDraft(data)) throw draftRefusal(issue, "nothing to run");
    await this.adoptForRun(issue, data);
    const pr = await retried(`reading the open PR of pendulum/${issue}`, () => gh.findPr(this.repo, `pendulum/${issue}`, this.opts), { waitMs });
    const next = stageFor({ pr, issue: data }) ?? "work";
    if (next === "review") log(`#${issue}: PR #${pr.number} waits for its review; starting there`);
    if (next === "merge") log(`#${issue}: PR #${pr.number} has no review pending (reviewed, or waiting for its rebase); ${wait ? "following it to its merge" : "nothing to run here"}`);
    if (next === "review") return this.withClaim(issue, () => this.review(issue, pr.number, { wait }));
    if (next === "merge") {
      // Its review ended waiting for a third-party reviewer (a run stopped meanwhile, or a serve's): taken up here, the
      // label put back once the wait is over, then the review.
      const prComments = await gh.listComments(this.repo, pr.number, this.opts).catch(() => []);
      if (waitOf(prComments, issue)) {
        log(`#${issue}: PR #${pr.number}'s review waits for a third-party reviewer; waiting here, then reviewing`);
        const resumed = await this.withClaim(issue, async () => ((await this.thirdPartyWait(issue, pr.number)) ? this.review(issue, pr.number, { wait }) : null));
        if (resumed) return resumed;
      }
      // Its hand-off to review waits for a sibling on the same files (overlap.mjs reviewHold): a run named by hand reviews now.
      const held = reviewWaitOf(prComments, issue);
      if (held && !held.released) {
        log(`#${issue}: PR #${pr.number}'s review waits for #${held.on}; a run named by hand reviews it now`);
        return this.withClaim(issue, async () => {
          await reviewNow(this.repo, { issue, prNumber: pr.number, wait: held }, this.opts);
          return this.review(issue, pr.number, { wait });
        });
      }
      if (!wait) return { exit: "delivered" };
      return this.withClaim(issue, () => this.followToMerge(issue, pr.number));
    }
    return this.runObjective(issue, { wait, named: true });
  }

  /**
   * --wait on a reviewed PR: followMerge's answer as a stage's end. A stage of the merge path that ended paused is that
   * end; else delivered once merged (`next`: a split Objective's next part is queued), none otherwise.
   */
  async followToMerge(issue, prNumber) {
    const merged = await this.followMerge(issue, prNumber);
    return merged?.exit ? merged : { exit: merged ? "delivered" : null, next: merged === "next" };
  }

  /**
   * `pendulum run <issue>` to its end: runIssue, then with `wait` each part of a split Objective once the one before it
   * merged, and each stage that ends paused on an outage waited out in place and resumed as serve resumes it
   * (waitPaused). A run that ends paused (an outage past the bound, a usage limit, a stage without --wait) logs the
   * command that resumes it; runExit gives it PAUSED_EXIT. `resumeWith`: that command's flags after `--wait`.
   */
  async runToEnd(issue, { wait = false, resumeWith = "", ...given } = {}) {
    return this.toEnd(issue, await this.runIssue(issue, { wait, ...given }), { wait, resumeWith, parts: true });
  }

  /**
   * `pendulum review <pr>` to its end: a review re-run on its own (as a person re-applying pendulum:review), in the
   * Objective's clone under its claim, and with `wait` a stage that ends paused on an outage
   * waited out in place and resumed (waitPaused), as runToEnd does; its split parts are left to the loop or a run.
   */
  async reviewToEnd(prNumber, { wait = false, resumeWith = "" } = {}) {
    const issue = await this.reviewIssueOf(prNumber);
    return this.toEnd(issue, await this.withClaim(issue, () => this.review(issue, prNumber, { wait })), { wait, resumeWith, parts: false });
  }

  /**
   * The end `r` of a run or review of `issue`, carried on: with `wait`, a pause waited out in place (waitPaused), and
   * with `parts` each next part of a split Objective run once the one before it merged. One that ends paused logs the
   * command that resumes it (`pendulum run <issue> --wait`, then `resumeWith`), and runExit gives it PAUSED_EXIT.
   */
  async toEnd(issue, r, { wait = false, resumeWith = "", parts = true } = {}) {
    for (;;) {
      if (wait && r?.exit === "paused") r = await this.waitPaused(issue, r);
      if (!parts || !r?.next) break;
      r = await this.runObjective(issue, { wait: true });
    }
    // With --wait, delivered is merged: work delivered with its PR conflicting, left to the send-back, is not.
    if (wait && r?.exit === "delivered" && r.unreviewed) {
      log((await this.pendingMergeLine(issue)) || `#${issue}: its PR is not merged`);
      r = { ...r, exit: null };
    }
    if (r?.exit === "paused" && !this.stopping) {
      const resume = `\`pendulum run ${issue} --wait${resumeWith}\``;
      // A claim another local loop took over while the stage ran (withClaim's heartbeat): that loop resumes it.
      if (this.ceded?.has(issue)) log(`#${issue}: paused, resumable (exit ${PAUSED_EXIT}): another local loop holds its claim now and resumes it; ${resume} takes it up once that loop is gone`);
      else log(`#${issue}: paused, resumable (exit ${PAUSED_EXIT}): its claim stays on this machine; ${resume} resumes it here, as does a \`pendulum serve\` of this repository on this machine`);
    }
    return r;
  }

  /**
   * `run --wait` or `review --wait`, a stage that ended paused on an outage (`r`; outagePaused keeps its record): what
   * serve's tick does for it, in place. Every RESUME_POLL_MS (serve's tick) it asks outageDue, under the same bound as
   * serve (OUTAGE.blockMs, PENDULUM_LOCAL_OUTAGE_HOURS, from the first loss), and once due, or once the claim's
   * heartbeat is due (HEARTBEAT_MS, so no loop takes the claim for a loop gone away: CLAIM_FRESH_MS), reads the issue and
   * its claim as serve's tick does. A stopped Objective is not resumed and its claim goes, as a stage stopped under
   * withClaim drops it; a claim no longer this run's is left to its holder; one still this run's is written again when
   * its heartbeat is due (beatPaused, on any poll that resumes nothing), and resumed when the pause is (resume, judged at
   * the same moment) and no failed start's backoff holds it (unstart's retryAt, as serve's tick). A resume that starts
   * nothing (a read that fails, a claim it cannot read, a stage of it still running here) leaves the pause as it stands,
   * for the next poll, as serve's next tick; a stage that pauses again is waited out the same way. Past the
   * bound it stops waiting and returns the paused end: where serve Blocks it with the cause `outage`, a run leaves its
   * claim for the command that resumes it (toEnd). A pause on a usage limit or on account labels is returned as it is.
   */
  async waitPaused(issue, r) {
    const clock = this.clock ?? Date.now;
    const beatEvery = this.heartbeatMs ?? HEARTBEAT_MS;
    let said = false;
    let heldSaid = null;
    let beatAt = clock();
    this.waitingOn = issue;
    try {
      while (r?.exit === "paused" && !this.stopping) {
        this.applyLocalLimits();
        const off = this.offline?.get(issue);
        if (!off || off.harness || off.pinWait) return r;
        const now = clock();
        if (now - off.since >= OUTAGE.blockMs) {
          log(`#${issue}: still paused on ${lostText(off.host, off.code, off.endpoint)} from ${logTime(off.since)}, past Pendulum's ${minutesText(OUTAGE.blockMs)} bound for an outage; this run stops waiting`);
          return r;
        }
        if (!said) log(`#${issue}: waiting here for ${off.host} to answer, as serve would, up to ${minutesText(OUTAGE.blockMs)} from ${logTime(off.since)}`);
        said = true;
        const due = await this.outageDue(off, now);
        if (due || now - beatAt >= beatEvery) {
          const data = await getIssue(this.repo, issue, this.opts).catch(() => null);
          let c = data ? await localClaim(this.repo, issue, this.opts).catch(() => undefined) : undefined;
          if (data && stopCause(data, this.objectiveLabel())) {
            this.offline.delete(issue);
            if (c?.holder === this.holder) await dropClaim(this.repo, issue, this.holder, this.opts).catch((e) => log(`#${issue}: its claim could not be dropped (${String(e?.message || e).slice(0, 120)})`));
            log(`#${issue}: stopped while paused; not resuming it`);
            return { exit: "stopped" };
          }
          if (c !== undefined && c?.holder !== this.holder) {
            this.offline.delete(issue);
            log(`#${issue}: its claim is no longer this run's (${c?.holder ?? "none"}); not resuming it`);
            return { exit: "skipped" };
          }
          // A failed start's backoff (unstart's retryAt, which serve's tick honours too): no resume before it.
          const held = this.startFailures?.get(issue);
          const backoff = !!held && Number.isFinite(held.retryAt) && now < held.retryAt;
          if (due && backoff && heldSaid !== held.retryAt) {
            heldSaid = held.retryAt;
            log(`#${issue}: its last resume could not start; the next waits for its backoff, until ${new Date(held.retryAt).toISOString()}`);
          }
          if (c !== undefined && due && !backoff) {
            log(`#${issue}: resuming (${off.host} answers again)`);
            const was = r;
            try {
              r = await this.resume(issue, { wait: true, now });
            } catch (e) {
              // A start that threw before its stage (a claim it could not read: startFailed) leaves the pause standing.
              if (!e?.startFailed || !this.offline?.has(issue)) throw e;
              log(`#${issue}: the resume could not start (${e.startFailed}: ${String(e?.message || e).slice(0, 160)}); the pause stands and this run tries again at its next poll`);
              r = { exit: "skipped" };
            }
            // Nothing started (a read that failed, a claim it could not read, a stage of it still running here): the
            // pause stands, and the next poll tries again, as serve's next tick does.
            const none = r?.exit === "skipped" || (!!r?.startFailed && !r?.exit);
            if (!none || !this.offline?.has(issue)) {
              said = false;
              beatAt = clock();
              continue;
            }
            r = was;
            // Read again: a start that failed may have put it back to Queued, its claim dropped (unstart), and that
            // claim is not written back here.
            c = await localClaim(this.repo, issue, this.opts).catch(() => undefined);
            if (c && c.holder !== this.holder) c = undefined;
          }
          // Waiting on (not due, held for a backoff, or a resume that started nothing): the claim's heartbeat, when due.
          if (c !== undefined) {
            beatAt = now;
            await this.beatPaused(issue, c, beatEvery);
          }
        }
        await this.pause(this.resumePollMs ?? RESUME_POLL_MS);
      }
      return r;
    } finally {
      this.waitingOn = null;
    }
  }

  /**
   * The last line when this loop stops following an Objective whose PR is not merged yet: who tends it now and, for a
   * local Objective, the fix. Null when its PR is merged or gone.
   */
  async pendingMergeLine(issue) {
    const pr = await findPr(this.repo, `pendulum/${issue}`, this.opts).catch(() => null);
    if (!pr) return null;
    const data = await getIssue(this.repo, issue, this.opts).catch(() => null);
    const local = !data || BACKENDS.local.trigger.routes(data, this.baseEnv());
    return `#${issue}: PR #${pr.number} is not merged yet; ${local ? `nothing tends a local Objective while no pendulum serve runs for this repository: start \`pendulum serve\` (or \`pendulum run ${issue} --wait\`) to merge it` : "the Action's dispatcher tends its merge"}`;
  }

  /**
   * The work stage, then its review: in a claim this loop holds. `named` (or `wait`): a run a person named, whose review
   * starts now even when its hand-off waits for a sibling on the same files (overlap.mjs reviewHold, reviewNow).
   */
  async work(issue, { wait = false, named = false } = {}) {
    // The stage only rejects before its process starts: a failed start (runObjective).
    const work = await this.stage(issue, "work", "worker.mjs", ["--issue", String(issue)]).catch((e) => {
      throw Object.assign(e instanceof Error ? e : new Error(String(e)), { startFailed: "work" });
    });
    // The stage started: this loop's count of failed starts for it is over.
    this.startFailures?.delete(issue);
    log(`#${issue} work: ${stageEndText(work)}`);
    if (work.exit !== "delivered") return work;
    const pr = await findPr(this.repo, `pendulum/${issue}`, this.opts).catch(() => null);
    if (pr && (pr.labels || []).some((l) => l.name === REVIEW_LABEL)) return this.review(issue, pr.number, { wait });
    // A delivered PR without the review label conflicts with the default branch, so the dispatcher's send-back takes it
    // (`unreviewed` tells sendBack it conflicts again after its rebase), or its review waits for a sibling on the same
    // files, which the dispatcher ends; a run a person named reviews now.
    const held = pr && (named || wait) ? reviewWaitOf(await listComments(this.repo, pr.number, this.opts).catch(() => []), issue) : null;
    if (held && !held.released) {
      log(`#${issue}: PR #${pr.number}'s review waits for #${held.on}; a run named by hand reviews it now`);
      const now = await reviewNow(this.repo, { issue, prNumber: pr.number, wait: held }, this.opts).then(
        () => true,
        (e) => log(`#${issue}: its review could not be started (${String(e?.message || e).slice(0, 120)}); it waits for the dispatcher`),
      );
      if (now) return this.review(issue, pr.number, { wait });
    }
    return { ...work, unreviewed: true };
  }

  /**
   * --wait, a PR that conflicts with the default branch at its merge (a sibling merged first, #2647): the dispatcher's
   * send-back, here, since this loop holds the Objective: its notice on the PR and a worker rebase, then the review
   * again, each time other PRs merged since its last rebase; Blocked when rebasing cannot progress or at the bound
   * (logic.mjs staleDecision), as the dispatcher Blocks it. Returns followMerge's answer, or "retry": the PR no longer
   * conflicts, its rebase's worker run ended delivered with the PR conflicting again (another sibling landed meanwhile),
   * its send-backs could not be counted, or GitHub failed for now, so followMerge's next poll decides again. `gh` is for tests.
   */
  async sendBack(issue, prNumber, inputs, { gh = { getPrSettled, rebaseMarkers, prComment, applyExit } } = {}) {
    const conflicting = (pr) => pr?.state === "open" && !pr.merged && pr.mergeable_state === "dirty";
    let pr = null;
    try {
      pr = await gh.getPrSettled(this.repo, prNumber, this.opts);
      if (!conflicting(pr)) {
        log(`#${issue}: PR #${prNumber} no longer conflicts (${pr?.state}, ${pr?.mergeable_state}); the merge pass reads it again`);
        return "retry";
      }
      const seen = await gh.rebaseMarkers(this.repo, { issue, pr, objectiveLabel: inputs.objectiveLabel }, this.opts);
      // The send-backs could not be counted: followMerge's next poll reads them again.
      if (seen.unread) return "retry";
      const why = staleDecision({ pr, rebases: seen.recent, stuck: seen.stuck, queue: true, limit: inputs.rebaseLimit });
      if (why === "stuck" || why === "limit") {
        await gh.applyExit(this.repo, rebaseBlock({ issue, pr, why, record: seen.stuck || seen.record, since: seen.since, notify: inputs.notify, stage: "merge", limit: inputs.rebaseLimit }), this.opts);
        return false;
      }
      if (!seen.already) await gh.prComment(this.repo, prNumber, rebaseNotice(issue, pr, seen.recent, inputs.rebaseLimit), this.opts);
    } catch (e) {
      return this.sendBackFailed(issue, pr, e, inputs, gh);
    }
    log(`#${issue}: PR #${prNumber} conflicts with ${pr.base?.ref || "the default branch"} after other PRs merged; sending it back to the worker to rebase`);
    const r = await this.work(issue, { wait: true });
    // Its rebase paused (an outage, a usage limit): followMerge ends on that pause.
    if (r.exit === "paused") return r;
    if (r.next) return "next";
    if (r.exit !== "delivered") return false;
    // Delivered without the review label: its rebase conflicts again, so the next poll sends it back under the same rules.
    return r.unreviewed ? "retry" : true;
  }

  /** A GitHub error in sendBack: a transient one waits for followMerge's next poll; any other Blocks with its reason. */
  async sendBackFailed(issue, pr, e, inputs, gh) {
    const code = Number.isInteger(e?.status) && e.status > 0 ? `HTTP ${e.status}` : e?.transport ? "network" : "error";
    log(`#${issue} send-back: ${String(e?.message || e).slice(0, 160)}`);
    if (transientError(e)) return "retry";
    const reason = `the send-back of the conflicting PR for its rebase failed (${code}); the run log has GitHub's answer`;
    await gh.applyExit(this.repo, { issue, pr, exit: "blocked", reason, cause: "pendulum", notify: inputs.notify, stage: "merge" }, this.opts).catch((x) => log(`#${issue} Block: ${String(x?.message || x).slice(0, 160)}`));
    return false;
  }

  /** The Objective of a PR on a pendulum/<issue> branch; throws for any other PR. */
  async reviewIssueOf(prNumber) {
    const pr = await getPr(this.repo, prNumber, this.opts);
    const issue = Number(/^pendulum\/(\d+)$/.exec(pr.head?.ref || "")?.[1]);
    if (!issue) throw new Error(`PR #${prNumber} is not on a pendulum/<issue> branch`);
    return issue;
  }

  /**
   * Open PRs labelled pendulum:review whose Objective is routed here and held by no loop: the label is the review trigger,
   * as on Actions. Not a draft PR (a Question or a Block: the reviewer waits for a person) nor a Blocked Objective's.
   * A Question's PR a person marked ready (#339) is one too, as the Action's ready_for_review event makes it: out of
   * draft, its issue still a Question, marked ready after the Question was asked (readyAfter), and its Objective label
   * not re-applied since by a person who can push (that reruns its work stage instead: the dispatcher's recovery). The review applies the answer;
   * with none since the Question, a body still asking a `QUESTION:` makes it a Question again (review.mjs readyMark).
   */
  async pendingReviews() {
    const prs = (await rest(`repos/${this.repo.full}/pulls?state=open&per_page=100`, { ...this.opts, paginate: true }).catch(() => [])) || [];
    // Conditional reads (a 304 for an unchanged page is not counted): the Questions, only when a PR may be one's.
    const cached = { ...this.opts, cache: (this.timelines ??= new Map()) };
    const questions = prs.some(readyIssue) ? new Map(((await listIssuesByLabel(this.repo, "pendulum:question", cached).catch(() => [])) || []).map((i) => [i.number, i])) : new Map();
    const out = [];
    for (const pr of prs) {
      const asked = questions.get(readyIssue(pr)) ?? null;
      const issue = reviewIssue(pr) || asked?.number || 0;
      if (!issue) continue;
      const data = asked ?? (await getIssue(this.repo, issue, this.opts).catch(() => null));
      // A stopped Objective (its label removed, its issue closed: stop.mjs) gets no review.
      if (!data || isBlocked(data) || stopCause(data, this.objectiveLabel()) || !BACKENDS.local.trigger.routes(data, this.baseEnv())) continue;
      if (asked) {
        const events = await timelineOf(this.repo, issue, cached).catch(() => null);
        // The Objective label re-applied since the Question by a person who can push (requeuedIn) is the go to run its
        // work stage again: this tick's dispatch puts it back to Queued and picks it, so a ready mark beside it starts
        // no review. A re-apply whose actor is unread waits with the dispatcher; anyone else's changes nothing.
        const go = events ? await requeuedIn(events, this.objectiveLabel(), goTrust(events, issue, labelTrust(this.repo, this.opts))) : null;
        if (!go || go.requeued || go.unread) continue;
        const askedAt = labeledAtIn(events, "pendulum:question");
        if (!readyAfter(askedAt ? await timelineOf(this.repo, pr.number, cached).catch(() => []) : [], askedAt)) continue;
      }
      if ((await localClaim(this.repo, issue, this.opts).catch(() => null))?.fresh) continue;
      out.push({ issue, pr: pr.number, labels: data.labels || [], updatedAt: data.updated_at ?? null });
    }
    return out;
  }

  /**
   * --wait: follow the PR through the merge queue, then do the bookkeeping the dispatcher does on a merge. The follow's
   * bounds are the repository's own, from the merge queue's check timeout (setup's default when unread), with `hungMs`
   * the bound past which the queue calls a running required check hung (logic.mjs queueHungMs). In the queue, it follows
   * while the entry makes progress (its state, merge_group commit or place changes), and stops once it has not for the
   * check timeout plus `hungMs`; waiting for the queue ahead of it (queue-wait), it follows while that queue changes (the
   * default branch's head or any entry ahead: session.mjs queueState, one read per poll) and stops once it has not for
   * the same bound. Out of the queue (its own checks, or a person's merge with auto_merge off), it stops once it has
   * waited `hungMs`, counted from its start or from when it last saw the PR in the queue. With auto_merge off, one read of
   * the PR's queue entry per poll tells whether a person put it in the queue. It logs where the PR is whenever that
   * changes, and its stop line names the bound and what is still pending.
   */
  async followMerge(issue, prNumber, { pollMs = 60_000 } = {}) {
    const now = () => (this.clock ?? Date.now)();
    const inputs = resolveInputs({ args: { repo: this.repoFull }, env: this.baseEnv() });
    const queue = await hasMergeQueue(this.repo, this.opts).catch(() => true);
    // The queue's check timeout and the hung-check bound from it, read once for this follow rather than every poll; with
    // no Actions token here (the local App has no Actions permission), the merge pass judges a queue check by that time
    // bound only (session.mjs hangsOn).
    const queueTimeout = queue ? await queueTimeoutMin(this.repo, this.opts) : null;
    const hungMs = queueHungMs(queueTimeout);
    const minutes = (ms) => Math.round(ms / 60_000);
    const timeoutText = queueTimeout ? `the merge queue's ${queueTimeout}-min check timeout` : `setup's default ${SETUP_QUEUE_TIMEOUT_MIN}-min check timeout`;
    // How long the PR may stay in the queue with no change of its entry, or wait for a queue ahead of it that does not
    // change: the queue's check timeout plus the hung bound, past which the queue itself would have dropped its head.
    const stillMs = { queue: (queueTimeout || SETUP_QUEUE_TIMEOUT_MIN) * 60_000 + hungMs };
    stillMs.wait = stillMs.queue;
    const inQueue = (entry) => {
      if (entry === "queued") return { kind: "queue", key: "queued", desc: "just enqueued", text: "put in the merge queue" };
      const desc = entry ? [entry.state, entry.position && `position ${entry.position}`, entry.head && `merge_group commit ${entry.head.slice(0, 7)}`].filter(Boolean).join(", ") : "unread";
      return { kind: "queue", key: entry ? `${entry.state}:${entry.position}:${entry.head}` : "unread", desc, text: `in the merge queue (entry ${desc})` };
    };
    const cache = {};
    // When this wait outside the merge queue began (null while the PR is in it, or waits for the queue ahead), and
    // since when the PR has been in the queue (or waited for it) with nothing changed.
    let outSince = now();
    let still = null;
    let said = null;
    let pending = "";
    let stop = null;
    while (!this.stopping) {
      let phase;
      // The merge pass the dispatcher runs (session.mjs mergeReadyOne): this loop holds the Objective, so it runs it.
      if (inputs.autoMerge) {
        const report = {};
        const how = await mergeReadyOne(this.repo, { issue, prNumber, queue, checkNames: inputs.ciChecks, report, hungMs, queueTimeout, cache, stall: inputs.stall, objectiveLabel: inputs.objectiveLabel, thirdParty: inputs.thirdPartyReviewers, editCheck: () => openEditCheck({ inputs }), commentCheck: () => openCommentCheck({ inputs }) }, this.opts).catch((e) => log(`#${issue} merge: ${e.message.slice(0, 160)}`));
        // Its edit and comment checks outside a stage that no record carried: this loop's decisions comment.
        await flushDecisionSpend(this.repo, this.opts, { role: "serve" });
        const why = mergeBlockReason(how, report);
        if (why) {
          await applyExit(this.repo, { issue, pr: await getPr(this.repo, prNumber, this.opts).catch(() => null), exit: "blocked", reason: why, cause: mergeBlockCause(how, report), notify: inputs.notify, stage: "merge" }, this.opts);
          return false;
        }
        if (how === "stopped") {
          log(`#${issue}: the Objective was stopped; PR #${prNumber} is not merged`);
          return false;
        }
        if (how === "held") {
          log(`#${issue}: a person took PR #${prNumber} out of the merge queue; Pendulum leaves it to them`);
          return false;
        }
        if (how === "re-review" || how === "unread" || how === "answer-threads" || how === "queue-red" || how === "text-edit") return this.review(issue, prNumber, { wait: true }).then((r) => (r.exit === "paused" ? r : r.next ? "next" : r.exit === "delivered"));
        if (how === "conflict") {
          const sent = await this.sendBack(issue, prNumber, inputs);
          if (sent !== "retry") return sent;
        }
        if (how === "queue-wait") phase = { kind: "wait", text: "out of the merge queue, waiting for the queue ahead of it to move" };
        else if (how === "queued" || how === "in-queue") phase = inQueue(how === "queued" ? "queued" : report.entry);
        else {
          const checks = report.checks;
          pending = checks ? `its required checks on ${checks.sha.slice(0, 7)} (${[...checks.pending.map((n) => `${n} running`), ...checks.missing.map((n) => `${n} not reported`)].join(", ")})` : `the merge pass (${how ?? "unread"})`;
          phase = { kind: "out", text: `${queue ? "out of the merge queue, " : ""}waiting on ${pending}` };
        }
      } else {
        // auto_merge off: a person merges it or puts it in the queue; one read of its queue entry tells which.
        const entry = queue ? await mergeQueueEntry(this.repo, prNumber, this.opts).catch(() => null) : null;
        phase = entry ? inQueue(entry) : { kind: "out", text: `waiting for a person to merge it${queue ? " or put it in the merge queue" : ""} (auto_merge is off)` };
      }
      if (phase.text !== said) log(`#${issue}: following PR #${prNumber}: ${(said = phase.text)}`);
      const pr = await getPr(this.repo, prNumber, this.opts).catch(() => null);
      if (pr?.merged_at) {
        const project = await findProject(this.repo, this.opts).catch(() => null);
        // A split part: the issue stays open and the next part starts from the default branch (handoff.mjs nextPart).
        const next = await nextPart(this.repo, issue, this.opts, { maxParts: inputs.maxParts }).catch(() => null);
        await setStateLabel(this.repo, issue, next === "cap" ? "blocked" : null, this.opts).catch(() => {});
        if (project) await moveCard(project, this.repo, issue, next === "next" ? "Queued" : next === "cap" ? "Blocked" : "Done", this.opts).catch(() => {});
        log(`#${issue}: PR #${prNumber} merged; ${next === "next" ? "the next part is queued" : next === "cap" ? `split into ${inputs.maxParts} PRs with work left: Blocked` : "card Done"}`);
        return next === "next" ? "next" : true;
      }
      if (pr?.state === "closed") {
        log(`#${issue}: PR #${prNumber} closed without a merge`);
        return false;
      }
      if (phase.kind === "wait") {
        // The queue ahead of it as it stands (session.mjs queueState): any change there is progress for this wait.
        const ahead = pr ? await mergeQueueHeads(this.repo, pr.base?.ref || "main", this.opts).catch(() => null) : null;
        const entries = ahead?.entries.filter((e) => e.pr !== prNumber) ?? [];
        phase.key = ahead ? queueState({ base: ahead.base, entries }) : "unread";
        phase.desc = ahead ? (entries.length ? entries.map((e) => `#${e.pr}`).join(", ") : "empty") : "unread";
      }
      if (phase.kind === "out") {
        still = null;
        outSince ??= now();
      } else {
        outSince = null;
        if (still?.key !== phase.key) still = { kind: phase.kind, key: phase.key, since: now() };
        still.desc = phase.desc;
      }
      if (outSince !== null && now() - outSince >= hungMs) {
        stop = inputs.autoMerge
          ? ` after ${minutes(hungMs)} min ${queue ? "out of the merge queue" : "waiting for its merge"}, the bound for a hung required check (from ${timeoutText}); still pending: ${pending}`
          : ` after ${minutes(hungMs)} min with no person merging it${queue ? " or putting it in the merge queue" : ""} (auto_merge is off)`;
        break;
      }
      if (still && now() - still.since >= stillMs[still.kind]) {
        stop =
          still.kind === "queue"
            ? `: its merge queue entry (${still.desc}) made no progress in ${minutes(stillMs.queue)} min, past ${timeoutText} plus the bound for a hung required check (${minutes(hungMs)} min)`
            : ` after ${minutes(stillMs.wait)} min waiting for the merge queue ahead of it (${still.desc}), which did not change, past ${timeoutText} plus the bound for a hung required check (${minutes(hungMs)} min)`;
        break;
      }
      await this.pause(pollMs);
    }
    if (this.stopping) return false;
    log(`#${issue}: stopped following PR #${prNumber}${stop}`);
    log((await this.pendingMergeLine(issue)) || `#${issue}: PR #${prNumber} is merged or closed`);
    return false;
  }

  /**
   * The repository's variables (#284), the layer of its settings over the workflow's: one conditional list call with
   * the local token (an unchanged list costs no rate limit), at the start and with each settings read
   * (refreshSettings). A token without Variables: read (403, 404) is said once, with the fix, and the workflow's values
   * stand until a read gets through; any other failure is said once and keeps the last read. Returns `read`, `refused`,
   * `failed` (the error in `variablesError`) or `none` (no repository or token to read with).
   */
  async readVariables() {
    if (!this.repo || !this.token) return "none";
    this.variablesCache ??= new Map();
    let r;
    try {
      r = await repositoryVariables(this.repo, { token: this.token, cache: this.variablesCache });
    } catch (e) {
      if (!this.variablesFailed) log(`the repository's variables could not be read (${String(e?.message || e).slice(0, 160)}); serve keeps the ones it has`);
      this.variablesFailed = true;
      this.variablesError = e;
      return "failed";
    }
    this.variablesFailed = false;
    if (r.refused) {
      if (this.variablesRefused !== r.refused) log(variablesRefusedLine(r.refused));
      this.variablesRefused = r.refused;
      this.variables = {};
      return "refused";
    }
    if (this.variablesRefused) log("the local token reads the repository's variables now: they apply over the workflow's settings");
    this.variablesRefused = null;
    this.variables = r.vars;
    return "read";
  }

  /**
   * The start's read of the repository's variables (#284), which fails closed: a variable may lower a cap, so nothing
   * starts on the workflow's values alone after a failed read. `serve` waits outages out (lib/network.mjs) and tries
   * again, every START_VARIABLES_MS doubling to five minutes, until a read gets through or GitHub says the token may not
   * read them (403, 404: the workflow's values, as readVariables says); a refused token (401) is named every third wait,
 * and one replaced in its source is taken at the next try; `run` and `review` try three times, then stop
   * with nothing started. A read that gets through also names the organization PENDULUM_* variables shared with the
   * repository, which Pendulum does not take (inputs.mjs organizationVariablesLine).
   */
  async startVariables({ serve = false } = {}) {
    if (serve) waitOutages();
    let state = await this.readVariables();
    for (let i = 0; state === "failed"; i += 1) {
      if (!serve && i >= 2) throw new Error(`reading the repository's variables failed 3 times (${String(this.variablesError?.message || this.variablesError).slice(0, 160)}); nothing was started, run it again`);
      // A refused token never falls back to the workflow's values: said again every third wait, so the log shows it.
      if (this.variablesError?.status === 401) {
        if (i % 3 === 0) log(`the local token was refused (401): replace it in ${tokenSource(this.repoFull)}; no stage starts until a read gets through`);
      } else if (i === 0) log(serve ? "serve starts no stage until it reads the repository's variables, or GitHub says the token may not" : "trying again before anything starts");
      await new Promise((r) => setTimeout(r, Math.min((this.startVariablesMs ?? START_VARIABLES_MS) * 2 ** i, 5 * 60_000)));
      // A token replaced in its source meanwhile is the one read with.
      this.token = this.tokenNow() || this.token;
      state = await this.readVariables();
    }
    if (state !== "read") return;
    const org = organizationVariablesLine(await organizationVariableNames(this.repo, { token: this.token }));
    if (org) log(org);
  }

  /**
   * serve's start (#564): Pendulum's App id from the repository variable as the start's list read it, or, when the list
   * was refused, read alone with the gh login's token (unless it is the local token), so a copy of a replaced App is
   * brought up to date; saved as its local copy for `pendulum report` (lib/app-id.mjs learnAppId). A variable that is not
   * set is said with the line that sets it. Nothing here stops serve, nor holds its start: the gh login's read takes no
   * rate-limit wait and ends after APP_ID_READ_MS (`appIdReadMs`), and then `pendulum report` reads the id itself.
   */
  async keepAppId({ fallback = ghLoginToken } = {}) {
    if (!this.repo || (!this.variables && !this.variablesRefused)) return null;
    const listed = this.variablesRefused ? { refused: this.variablesRefused } : { vars: this.variables };
    try {
      const ms = this.appIdReadMs ?? APP_ID_READ_MS;
      const r = await learnAppId(this.repo, { listed, token: this.token, fallback, read: { noRateWait: true, deadlineAt: Date.now() + ms, signal: AbortSignal.timeout(ms) } });
      if (r.saved) log(`saved Pendulum's App id ${r.id} (the repository variable ${r.from === "variable-gh" ? "as the gh login reads it" : "PENDULUM_APP_ID"}) for \`pendulum report\` to ${r.file}`);
      if (r.problem) log(`the local copy of Pendulum's App id for \`pendulum report\`: ${r.problem}`);
      if (r.from === "unset") log(`the repository variable PENDULUM_APP_ID ${appIdWhyText(r)}, so \`pendulum report\` cannot tell Pendulum's App's comments from another App's${r.copy ? ` (it takes the local copy, ${r.copy}, meanwhile)` : ""}; set it once: ${appIdSetLine(this.repoFull)}`);
      if (r.from === "forbidden") log(`the repository variable PENDULUM_APP_ID could not be read (the local token may not read variables, and no gh login could either), so ${r.copy ? `\`pendulum report\` takes the local copy, ${r.copy}, unverified` : "no local copy of Pendulum's App id was saved for `pendulum report`"}; log in with gh, or give the token Variables: read`);
      return r;
    } catch (e) {
      log(`Pendulum's App id was not read (${String(e?.message || e).slice(0, 160)}); \`pendulum report\` reads it itself`);
      return null;
    }
  }

  /**
   * The repository's settings as they are now, read at each serve tick (#276, #284): the default branch's workflow and
   * the repository's variables over it (readVariables). Only HOT_SETTINGS (caps, models and effort, validation, resume
   * policy, cache TTL) apply while serve runs: from that tick, to this loop's limit, the dispatcher's caps and every stage
   * that starts from then on, never to a stage in flight or being set up, and said once, by name, with the layer each
   * comes from when a variable is involved. Every other setting (what a stage may reach or receive, budgets, maintainers,
   * protected paths, the harness, setup) keeps its value from serve's start until serve starts again, said once. The
   * read also brings the workflow's Pendulum pin (followPin).
   */
  /**
   * Serve's own outage bounds as now set (localLimits over baseEnv, each its default when unset): how long an Objective
   * stays paused on one outage before it Blocks (PENDULUM_LOCAL_OUTAGE_HOURS, OUTAGE.blockMs), and the window in which a
   * new outage after a resume is the same one (PENDULUM_LOCAL_WAIT_MINUTES, OUTAGE.stageWaitMs). Taken each tick.
   */
  applyLocalLimits() {
    const { waitMs, outageMs } = localLimits(this.baseEnv());
    OUTAGE.blockMs = outageMs;
    OUTAGE.stageWaitMs = waitMs;
  }

  async refreshSettings() {
    if (!this.settingsBranch) return;
    // Fetched every SETTINGS_EVERY_MS; each tick between takes what the last read brought.
    if (Date.now() - (this.settingsReadAt ?? 0) >= (this.settingsEveryMs ?? SETTINGS_EVERY_MS)) {
      this.settingsReadAt = Date.now();
      const read = await committedWorkflowNow(this.dev, this.settingsBranch, { token: this.token });
      // Offline: nothing read, nothing changes (lib/network.mjs says when the network goes and comes back).
      if (!read.unfetched) this.settingsRead = read;
      await this.readVariables();
    }
    const now = this.settingsRead;
    if (!now) return;
    if (now.error) {
      if (now.error !== this.settingsError) log(`${now.error}: serve keeps the settings it has`);
      this.settingsError = now.error;
      return;
    }
    this.settingsError = null;
    this.pins = now.pins;
    // A stage being set up keeps the settings it started with (stage()): the change is taken at a later tick.
    if (this.settingUp > 0) return;
    const layers = settingLayers({ workflow: workflowSettings(now.wf).kept, variables: this.variables || {} });
    const ignored = ignoredLines(layers);
    if (ignored.join("\n") !== (this.ignoredKey ?? "")) {
      for (const line of ignored) log(line);
      this.ignoredKey = ignored.join("\n");
    }
    const next = layers.values;
    const from = this.from || {};
    const hot = { ...this.wf };
    const hotFrom = { ...from };
    // The models and effort belong to their harness, which waits for a restart: a change of harness holds them too.
    const harnessOf = (wf) => String(wf.PENDULUM_HARNESS || "claude").trim().toLowerCase();
    const live = harnessOf(next) === harnessOf(this.wf) ? HOT_SETTINGS : HOT_SETTINGS.filter((k) => !MODEL_SETTINGS.includes(k));
    for (const k of live) {
      if (next[k] === undefined) {
        delete hot[k];
        delete hotFrom[k];
      } else {
        hot[k] = next[k];
        hotFrom[k] = layers.from[k];
      }
    }
    // A variable on either side of a change: the lead names both layers, and each change the layer it comes from now.
    const lead = (after, layerOf) => {
      const changed = Object.keys({ ...this.wf, ...after }).filter((k) => this.wf[k] !== after[k]);
      const viaVariable = changed.some((k) => from[k] === "variable" || layerOf[k] === "variable");
      return viaVariable ? { text: `the repository's settings (the workflow on origin/${this.settingsBranch} and its variables) changed`, layers: layerOf } : { text: `the workflow's settings on origin/${this.settingsBranch} changed`, layers: null };
    };
    const hotLead = lead(hot, hotFrom);
    const changes = settingsChanges(this.wf, hot, process.env, hotLead.layers);
    // The rest, against what serve started with: said once for each set of differences.
    const heldTo = { ...next, ...Object.fromEntries(live.map((k) => [k, this.wf[k]])) };
    const heldLead = lead(heldTo, layers.from);
    const held = settingsChanges(this.wf, heldTo, process.env, heldLead.layers);
    const heldKey = held.join("\n");
    if (heldKey !== (this.settingsHeld ?? "")) {
      if (held.length) log(`${heldLead.text}; these take effect when serve restarts, and until then serve keeps the values it started with: ${held.join("; ")}`);
      this.settingsHeld = heldKey;
    }
    if (!changes.length) return;
    log(`${hotLead.text}; each stage that starts from now on runs with them, and stages in flight keep theirs: ${changes.join("; ")}`);
    this.wf = hot;
    takeZone(this.wf);
    this.from = hotFrom;
  }

  /**
   * The workflow's Pendulum pin against the Pendulum this serve runs (#276), at each tick. A new release tag or commit
   * SHA there is taken at a stage boundary: serve fetches it from Pendulum's own repository (lib/release.mjs), starts no
   * new stage meanwhile, and once no stage runs here starts again on it in this same process (restartOn), which resumes
   * this loop's paused work. Only a serve that runs a release follows it (a checkout at its own release tag, or one serve
   * fetched): one started from any other checkout, a branch or a change of your own, keeps running what you started, and
   * says the pin differs. Never an older release (pinDecision, releaseCheckout). A switch starts at most once in
   * SWITCH_GAP_MS. Said once per pin. Returns true while new stages wait for the switch.
   */
  async followPin(inFlight, { once = false } = {}) {
    this.pendulum ??= runningPendulum();
    const name = runningName(this.pendulum);
    const d = pinDecision(this.pins, this.pendulum);
    const ref = d.follow ? d.ref : null;
    if (this.repin && this.repin.ref !== ref) {
      log(`clockgrove/pendulum@${this.repin.ref} is no longer the workflow's pin: serve stays on ${name}`);
      this.repin = null;
    }
    if (d.same) {
      this.pinNoted = null;
      return false;
    }
    const where = `origin/${this.settingsBranch}`;
    const note = (line) => {
      if (this.pinNoted !== d.ref) log(line);
      this.pinNoted = d.ref;
      return false;
    };
    if (!d.follow) return note(`the workflow on ${where} pins ${d.why}; serve runs no code from it and keeps running ${name}`);
    if (once) return note(`the workflow on ${where} pins clockgrove/pendulum@${ref}; this serve runs ${name}; a serve that keeps running takes the pin, --once does not`);
    if (!this.pendulum.release) return note(`the workflow on ${where} pins clockgrove/pendulum@${ref}; this serve runs ${name} from ${this.pendulum.root}, which is not a release checkout, so it keeps running that: start serve from ${ref} to run it`);
    if (this.repin?.state === "failed" && Date.now() >= this.repin.retryAt) this.repin = null;
    // Counted from the last switch this process made (restartOn), never from a try that did not switch.
    if (!this.repin && Date.now() - (this.switchedAt || 0) < SWITCH_GAP_MS) return note(`the workflow on ${where} pins clockgrove/pendulum@${ref}; serve switched releases less than ${Math.round(SWITCH_GAP_MS / 60_000)} minutes ago, so it takes this pin from ${whenText(this.switchedAt + SWITCH_GAP_MS)} and runs ${name} until then`);
    if (!this.repin) {
      log(`the workflow on ${where} pins clockgrove/pendulum@${ref}; this serve runs ${name}. It fetches ${ref} from ${RELEASES_URL} and starts no new stage meanwhile; ${inFlight ? `once the ${inFlight} stage(s) in flight here end` : "once fetched"}, serve runs on ${ref}`);
      const r = (this.repin = { ref, state: "fetching" });
      r.fetch = releaseCheckout(ref, { ...this.releaseOpts, running: this.pendulum })
        .then(async (c) => {
          const problem = await startProblem(c.dir);
          if (problem) throw new Error(problem);
          r.checkout = c;
          r.state = "ready";
        })
        .catch((e) => {
          // An older commit than this one, or a SHA not on Pendulum's main: never tried again until the pin changes.
          r.state = e?.code === "older" || e?.code === "refused" ? "refused" : "failed";
          r.retryAt = Date.now() + PIN_RETRY_MS;
          if (this.repin !== r) return;
          if (r.state === "refused") log(`${String(e.message).slice(0, 300)}; serve keeps running ${name}`);
          else log(`clockgrove/pendulum@${ref} could not be taken (${String(e?.message || e).slice(0, 300)}); serve goes on with ${name} and tries again in ${Math.round(PIN_RETRY_MS / 60_000)} minutes`);
        });
    }
    const r = this.repin;
    if (r.state === "fetching") return true;
    if (r.state !== "ready") return false;
    if (inFlight) return true;
    if (this.stopping) return false;
    return this.restartOn(r);
  }

  /**
   * Start serve again on the release `r` names, in this same process (process.execve): its pid, its terminal and its
   * front end stay. The new loop takes up the claims this one leaves (paused work, a stage that lapsed) at once, as a
   * dead loop's on this machine (deadHereHolder). Called only when no stage of this loop runs. The checkout is checked
   * once more first, without git (checkoutProblem: every file's SHA-256 against the manifest taken at its fetch): one
   * changed since is not run, and is fetched afresh later. If the new release fails at its start, it says it switched
   * from here (main). Where the
   * process cannot be replaced, says how to restart instead and goes on with the release it runs. Returns false when it
   * did not restart.
   */
  restartOn(r) {
    const script = join(r.checkout.dir, "plugin", "scripts", "local.mjs");
    if (typeof process.execve !== "function") {
      r.state = "manual";
      log(`this Node (${process.version}) cannot start serve again in its own process (process.execve needs Node 22.15 or newer): serve goes on with ${runningName(this.pendulum)}; restart it with ${join(r.checkout.dir, "plugin", "bin", "pendulum")} serve to run clockgrove/pendulum@${r.ref}`);
      return false;
    }
    const problem = checkoutProblem(r.checkout);
    if (problem) {
      r.state = "failed";
      r.retryAt = Date.now() + PIN_RETRY_MS;
      log(`the checkout of clockgrove/pendulum@${r.ref} at ${r.checkout.dir} changed since serve fetched it (${problem}); serve does not run it, goes on with ${runningName(this.pendulum)} and fetches it afresh in ${Math.round(PIN_RETRY_MS / 60_000)} minutes`);
      return false;
    }
    log(`no stage runs here: serve starts again on clockgrove/pendulum@${r.ref} from ${r.checkout.dir}, in this process; it resumes the Objectives this loop holds paused`);
    const env = { ...process.env, [SWITCHED_ENV]: String(Date.now()), [SWITCHED_FROM_ENV]: this.pendulum?.root || "" };
    // The new release's skills and agents, from beside its own scripts.
    delete env.PENDULUM_PLUGIN_ROOT;
    try {
      (this.execve ?? process.execve)(process.execPath, [process.execPath, ...process.execArgv, script, ...process.argv.slice(2)], env);
    } catch (e) {
      r.state = "manual";
      log(`serve could not start again on clockgrove/pendulum@${r.ref} (${String(e?.message || e).slice(0, 200)}): it goes on with ${runningName(this.pendulum)}; restart it with ${join(r.checkout.dir, "plugin", "bin", "pendulum")} serve`);
    }
    return false;
  }

  /**
   * How long a usage limit with no reset passes its account over, by how many in a row: machine.json's guess_hours, this
   * machine's own, else the repository's (the guess_hours setting).
   */
  guessSteps() {
    const machine = machineLimits({ home: this.machinePlaces().home });
    return machine.from.guess === "setting" ? machine.guessMs : resolveInputs({ args: { repo: this.repoFull }, env: this.baseEnv() }).guessMs;
  }

  /** Where this loop reads the machine's budget, slots and load: the user's home and /proc, or a test's own. */
  machinePlaces() {
    const home = this.machine?.home ?? homedir();
    return { home, dir: slotsDir(home), proc: this.machine?.proc ?? "/proc" };
  }

  /**
   * The machine's room for this loop's new starts now (lib/machine.mjs machineRoom), with its cap: PENDULUM_LOCAL_MAX_CONCURRENT,
   * else the machine's budget, and its saturation limits (machineLimits). A budget or limit that cannot be used is said once.
   */
  machineBox(running) {
    const { home, dir, proc } = this.machinePlaces();
    const budget = machineBudget({ home });
    if (budget.problem && budget.problem !== this.saidBudget) log(`machine budget: ${budget.problem}; using ${budget.stages}, from this machine's size`);
    this.saidBudget = budget.problem;
    const limits = machineLimits({ home });
    const problems = limits.problems.filter((p) => p !== budget.problem).join("; ");
    if (problems && problems !== this.saidLimits) log(`machine limits: ${problems}; Pendulum's defaults stand for those`);
    this.saidLimits = problems;
    const cap = loopCap(process.env.PENDULUM_LOCAL_MAX_CONCURRENT ?? this.wf.PENDULUM_LOCAL_MAX_CONCURRENT, budget.stages);
    let held = 0;
    try {
      held = slotHolders(dir).length;
    } catch (e) {
      this.slotTrouble(e);
    }
    return { ...machineRoom({ running, cap, budget: budget.stages, held, pressure: readPressure({ root: proc }), limits: limits.pressure }), cap, from: budget.from, file: budget.file, dir };
  }

  /** A slot directory this loop cannot use: said once per cause; its stages then start uncounted, as the room allows. */
  slotTrouble(e) {
    const why = String(e?.code || e?.message || e).slice(0, 160);
    if (why !== this.saidSlots) log(`machine slots: ${this.machinePlaces().dir} cannot be used (${why}); this loop's stages run without a slot there`);
    this.saidSlots = why;
    return { assign() {}, release() {} };
  }

  /** One slot of the machine's budget, held while a stage runs; a slot directory that cannot be used gives a slot of none. */
  slotFor(box, force, holder) {
    try {
      return takeSlot({ dir: box.dir, budget: box.budget, force, holder: { repo: this.repoFull, ...holder } });
    } catch (e) {
      return this.slotTrouble(e);
    }
  }

  /**
   * One tick's slots, up to `box.room`, for the stages it starts into `running`: `take(n)` takes up to n more now and
   * answers how many it got (fewer when another loop on this machine took the last ones first; the first one is taken
   * whatever the count when this loop holds none, so no loop starves); `left()` is the room not yet taken; `start(n, stage, task)` runs task on
   * the next slot taken, which it holds until the task ends; `spare()` lets go of the slots no start took.
   */
  takeSlots(box, running) {
    let left = box.room;
    let force = running.size === 0;
    const held = [];
    const take = (n) => {
      let got = 0;
      while (got < n && left > 0) {
        const slot = this.slotFor(box, force, { cmd: "serve" });
        if (!slot) {
          left = 0;
          break;
        }
        force = false;
        left -= 1;
        got += 1;
        held.push(slot);
      }
      return got;
    };
    const start = (n, stage, task) => {
      // A start without a slot taken for it would be a bug in the counts above: it then holds none rather than fail.
      const slot = held.shift() ?? { assign() {}, release() {} };
      slot.assign({ issue: n, stage });
      running.set(
        n,
        task().finally(() => {
          running.delete(n);
          slot.release();
        }),
      );
    };
    const spare = () => {
      for (const slot of held.splice(0)) slot.release();
    };
    return { take, left: () => left, start, spare };
  }

  /**
   * The slot of a stage of `pendulum run` or `review` (stage()): such a loop holds no other, so it takes one whatever the
   * machine holds, and says what would otherwise hold it.
   */
  holdSlot(holder) {
    const box = this.machineBox(0);
    if (box.why) log(`${holder.pr ? `PR #${holder.pr}` : `#${holder.issue}`}: ${box.why}`);
    return this.slotFor(box, true, holder);
  }

  /**
   * The dispatcher's own rules (caps, order, blocking, send-backs, Done), every interval; picks run here, as many as the
   * machine's room allows (machineBox), each holding one slot of the machine's budget while it runs.
   */
  async serve({ once = false, intervalMs = RESUME_POLL_MS } = {}) {
    // A review that ends waiting for a third-party reviewer is resumed by this loop's dispatcher ticks, not in its slot.
    this.serving = true;
    const running = new Map();
    // Objectives whose stage here ended with a Question or a Block: held until a trusted answer re-queues one or a
    // fresh read shows it Queued (dispatch.mjs localStopped), so a read from before the exit landed never re-claims one.
    // Each entry is its own object: a dispatch releases only the entries it was given, never a stop recorded during it.
    const stopped = new Map();
    const track = (n, p) =>
      p.then((r) => {
        const why = stopHold(r);
        if (why) stopped.set(n, { why });
      });
    const first = this.machineBox(0);
    let shownCap = Math.min(first.cap, first.budget);
    log(`machine budget: ${first.budget} Objective stage(s) at once on this machine, shared by every Pendulum loop here (${first.from === "setting" ? first.file : "from its CPU threads and memory"}); this loop: at most ${Math.min(first.cap, first.budget)}${first.cap > first.budget ? `, the budget (PENDULUM_LOCAL_MAX_CONCURRENT ${first.cap} is above it)` : " (PENDULUM_LOCAL_MAX_CONCURRENT)"}`);
    this.pendulum ??= runningPendulum();
    log(`serve runs Pendulum ${runningName(this.pendulum)} from ${this.pendulum.root}`);
    // A release checkout serve fetched stays while this process runs from it: no serve on this machine prunes it.
    markInUse(this.pendulum.root, this.releaseOpts);
    // This machine's network (lib/network.mjs): serve's own GitHub calls wait for it to come back, with no bound, one log
    // line when it is lost and one when it answers; its stages wait in place for fifteen minutes and then pause. GitHub's
    // primary rate limit spent is waited out the same way, to its reset: no tick reads, resumes or starts anything until
    // then, said once.
    waitOutages();
    // The stop waits for the dispatch under way (it may be marking picks Running), then for every start and stage,
    // those started after the signal included.
    this.stopOnSignals(async () => {
      await this.dispatching;
      while (running.size) await Promise.allSettled(running.values());
    });
    let cleaned = 0;
    // The token GitHub refused (401: expired or revoked), or null. While set, nothing new starts; each tick reads the
    // token's source again and takes a new token once it passes the start's own check (checkToken), and once a minute
    // the refused token is tried again, so a 401 GitHub gave for a moment does not stop the loop for good.
    let refused = null;
    let tried = null;
    let probeAt = 0;
    // When a new token whose check could not tell its reach (checkToken's `again`: a rate limit, a failed listing) is
    // checked again; a token the check refused is not, until its source changes.
    let againAt = Infinity;
    while (!this.stopping) {
      if (refused !== null) {
        const now = this.tokenNow();
        const check = () =>
          checkToken(this.repoFull, now, { max: this.bounded("PENDULUM_LOCAL_TOKEN_PROBE_MAX") }).then(
            () => true,
            (e) => {
              againAt = e.again ? Date.now() + REFUSED_PROBE.ms : Infinity;
              log(`the new token in ${tokenSource(this.repoFull)} is not taken: ${e.message.slice(0, 200)}${e.again ? "; it is checked again in a minute" : ""}`);
              return false;
            },
          );
        let fresh = now && now !== refused && (now !== tried || Date.now() >= againAt) ? await check() : false;
        if (!fresh && now === refused && Date.now() >= probeAt) {
          probeAt = Date.now() + REFUSED_PROBE.ms;
          fresh = await rest(`repos/${this.repo.full}`, { token: refused, noRateWait: true }).then(() => true, () => false);
          if (fresh) log("GitHub takes the local token again: taking work again");
        }
        if (!fresh) {
          if (now !== refused) tried = now;
          if (once) return void (await Promise.all(running.values()));
          await new Promise((r) => setTimeout(r, intervalMs));
          continue;
        }
        if (now !== refused) log(`a new token in ${tokenSource(this.repoFull)}: taking work again`);
        this.token = now;
        this.opts.token = now;
        refused = null;
      }
      // The workflow as the default branch has it now: its settings, and its Pendulum pin, taken at this stage boundary.
      await this.refreshSettings().catch((e) => log(`settings: ${e.message.slice(0, 160)}`));
      this.applyLocalLimits();
      // A new pinned release: no new stage starts here until serve runs on it (followPin); stages in flight end as they are.
      const switching = await this.followPin(running.size, { once }).catch((e) => {
        log(`pin: ${e.message.slice(0, 160)}`);
        return false;
      });
      // Every 10 minutes, and at start: closed Objectives' directories go.
      if (Date.now() - cleaned > 10 * 60_000) {
        cleaned = Date.now();
        await this.cleanup(running).catch((e) => log(`cleanup: ${e.message.slice(0, 160)}`));
      }
      const inputs = resolveInputs({ args: { repo: this.repoFull }, env: { ...this.baseEnv(), PENDULUM_INPUT_GITHUB_TOKEN: this.token } });
      // Failed starts whose holder was unknown: read their claims again once their backoff ends.
      await this.recheckStarts(running).catch((e) => log(`start recheck: ${e.message.slice(0, 160)}`));
      // The machine's room for new starts (machineBox): its budget, shared by every loop here, this loop's cap and the
      // machine's load. Each start takes its slot of the budget just before it is started or picked (takeSlots), and
      // holds it while it runs.
      const box = this.machineBox(running.size);
      // This loop's cap, read again at each tick from the settings as they are then (refreshSettings), said when it changes.
      const capNow = Math.min(box.cap, box.budget);
      if (capNow !== shownCap) log(`this loop: at most ${capNow} Objective stage(s) at once on this machine (${box.cap >= box.budget ? `the machine's budget${box.cap > box.budget ? `; PENDULUM_LOCAL_MAX_CONCURRENT ${box.cap} is above it` : ""}` : "PENDULUM_LOCAL_MAX_CONCURRENT"})`);
      shownCap = capNow;
      const slots = this.takeSlots(box, running);
      // This machine's paused work resumes first, then reviews (they finish work in flight); new work gets the rest.
      // A fault of this machine that failed the starts of two Objectives or more (machineFault): no new stage starts here
      // until its probe passes, so none is charged for it.
      const machine = switching ? {} : await this.machineWait().catch((e) => (log(`machine probe: ${String(e?.message || e).slice(0, 160)}`), {}));
      const waitLine = switching ? `no new stage until serve runs on clockgrove/pendulum@${this.repin?.ref}` : machine.work;
      // Resumes and reviews too, unless the hold is a clone's (they run in the clone their work made).
      const holdAll = switching || !!machine.all;
      const paused = holdAll ? [] : await this.pausedHere(running);
      const resumes = paused.slice(0, slots.take(paused.length));
      for (const n of resumes) {
        log(`#${n}: resuming (this machine held it when it went away)`);
        slots.start(n, "resume", () => track(n, this.resume(n)).catch((e) => log(`#${n} resume failed: ${e.message.slice(0, 200)}`)));
      }
      const pending = (await this.pendingReviews()).filter((r) => !running.has(r.issue));
      // An account whose usage limit is spent (limitPaused, in any serve on this machine): no review and no new work on
      // it starts until its reset, said once; work on any other account goes on (limitHold names each Objective's).
      const free = pending.filter((r) => !this.limitHold(r.labels, r.issue, r.updatedAt ?? null));
      // Each review starts as soon as its slot is taken, as resumes do: never a slot held idle through the dispatch.
      const reviews = holdAll ? [] : free.slice(0, slots.take(free.length));
      for (const r of reviews) slots.start(r.issue, "review", () => track(r.issue, this.withClaim(r.issue, () => this.review(r.issue, r.pr))).catch((e) => log(`PR #${r.pr} review failed: ${e.message.slice(0, 200)}`)));
      // Held from this tick's dispatch: a failed start's backoff, a stage running here, and every review this loop owes
      // (starting now or waiting for a slot), so the dispatcher never Blocks one this live loop is about to run.
      const localHeld = { ...this.startHolds(), ...Object.fromEntries(pending.map((r) => [r.issue, "its review runs on this box"])), ...Object.fromEntries([...running.keys()].map((n) => [n, "its stage runs on this box"])) };
      const given = new Map(stopped);
      const localStopped = Object.fromEntries([...given].map(([n, s]) => [n, s.why]));
      // Stopping: no dispatch starts (it would mark picks Running).
      if (this.stopping) {
        slots.spare();
        break;
      }
      // localLive: a stage of the Objective runs on this machine (an earlier serve's), so the dispatcher never takes a
      // Running one with no claim for a start that never wrote it. localStopping: a stop mid-dispatch marks no more picks.
      // localMarked: each pick the dispatch marks Running, named before its write, so a stop puts back even those of a
      // dispatch that threw midway.
      const marked = [];
      // No Action runs here (actionState): this loop picks the Objectives without pendulum:local too, labelling each first.
      const adopt = (await this.actionState().catch(() => null)) === "none";
      this.dispatching = dispatch(inputs, { token: this.token, decisionRole: "serve", adopt, notice: this.notice, localSlots: waitLine ? 0 : slots.left(), localTake: slots.take, localFull: waitLine || box.why || "this loop is at PENDULUM_LOCAL_MAX_CONCURRENT", localHeld, localHold: (issue) => this.limitHold(issue.labels, issue.number, issue.updated_at ?? null), localStopped, localLive: (n) => !!liveStage(this.ws(n)), localStopping: () => !!this.stopping, localMarked: (n) => marked.push(n), thirdPartyReads: (this.thirdPartyReads ??= new Map()), readCache: (this.timelines ??= new Map()) }).catch(async (e) => {
        // A 401 the local token itself gets again (not the notice App's): GitHub no longer takes it. Said once, by source.
        if (e?.status === 401 && (await rest(`repos/${this.repo.full}`, { token: this.token }).then(() => false, (x) => x?.status === 401))) {
          refused = this.token;
          probeAt = Date.now() + REFUSED_PROBE.ms;
          log(`GitHub refused the local token (HTTP 401: expired or revoked): no new work starts on this box until it is renewed in ${tokenSource(this.repoFull)}; stages already running end as they can`);
          return { ready: [], refused: true };
        }
        log(`dispatch failed: ${e.message.slice(0, 200)}`);
        return { ready: [] };
      }).then(async (r) => {
        // The tick's decision calls outside a stage that no record carried: this loop's decisions comment (decision-spend.mjs).
        await flushDecisionSpend(this.repo, this.opts, { role: "serve" });
        // A stop that came while it ran: the picks it marked Running start nothing and go back to Queued, before the exit,
        // unless a claim is on the issue now (another loop picked it too and holds it) or cannot be read: those stay.
        if (!this.stopping) return r;
        for (const n of [...new Set(marked)].filter((x) => !running.has(x))) {
          const c = await localClaim(this.repo, n, this.opts).then((x) => ({ x }), () => null);
          if (!c || c.x) {
            log(`#${n}: stopping before it started; ${c ? `a claim is on it (${c.x.holder}), so it stays as it is` : "its claim could not be read, so it stays as it is; the next serve's tick settles it"}`);
            continue;
          }
          await this.unpick(n).then(
            () => log(`#${n}: stopping before it started; back to Queued`),
            (e) => log(`#${n}: stopping before it started, it could not be put back to Queued (${String(e?.message || e).slice(0, 120)}); the next serve's tick does it`),
          );
        }
        return { ...r, ready: [], halted: true };
      });
      const result = await this.dispatching;
      if (result.halted) {
        slots.spare();
        break;
      }
      // The usage-limit holds this tick's work waited on (pausedHere, limitHold), re-checked when due: never waited for.
      if (!once) void this.probeHolds();
      // Picks labelled pendulum:local whose mark is not written yet: their claim's start writes it (backfillMark).
      for (const n of result.unmarked || []) (this.unmarked ??= new Set()).add(n);
      // Queued Objectives this loop does not take only for want of pendulum:local: said once per start (#455).
      if (result.unrouted?.length && !this.unroutedSaid) {
        this.unroutedSaid = true;
        log(unroutedLine(result.unrouted, this.action ?? null));
      }
      if (result.refused) {
        slots.spare();
        if (once) return void (await Promise.all(running.values()));
        await new Promise((r) => setTimeout(r, intervalMs));
        continue;
      }
      for (const n of result.released || []) if (stopped.get(n) === given.get(n)) stopped.delete(n);
      // A restarted Objective starts over here too: no failed start or lapse of its earlier run counts against it.
      for (const n of result.restarted || []) {
        this.startFailures?.delete(n);
        this.lapsed?.delete(n);
        this.offline?.delete(n);
      }
      const holding = (result.skipped || []).filter((s) => given.get(s.number)?.why === s.reason);
      const picks = (result.ready || []).filter((n) => !running.has(n) && !reviews.some((r) => r.issue === n));
      if (free.length > reviews.length && !holdAll) log(`${free.length - reviews.length} review(s) wait for a free slot on this machine`);
      // What holds new starts on this machine, said once: here, unless the dispatcher's reason (localFull) says it already.
      const hold = box.why && result.reason !== box.why ? `; holding new starts: ${box.why}` : "";
      log(`tick: ${picks.length ? `starting ${picks.map((n) => `#${n}`).join(", ")}` : "nothing ready"}${holding.length ? `; holding ${holding.map((s) => `#${s.number} (${s.reason})`).join(", ")}` : ""}${reviews.length ? `; reviewing ${reviews.map((r) => `PR #${r.pr}`).join(", ")}` : ""}${result.reason ? ` (${result.reason})` : ""}${waitLine && result.reason !== waitLine ? `; ${waitLine}` : ""}${hold}; ${running.size} in flight here, ${Number.isFinite(result.spentToday) ? spendText({ usd: result.spentToday, unknown: result.unknownToday ?? 0, byBilling: result.billingToday }) : "?"} spent today`);
      for (const n of picks) slots.start(n, "work", () => track(n, this.runObjective(n)).catch((e) => log(`#${n} failed: ${e.message.slice(0, 200)}`)));
      slots.spare();
      if (once) {
        await Promise.all(running.values());
        return;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}

/** One account's holds as `pendulum hold` says them (holds.mjs list's entry), at `now`: `state` alone, its state's words. */
export function holdText(h, now, { state = false } = {}) {
  const parts = [];
  if (h.until !== null) parts.push(`${h.until > now ? `held until ${whenText(h.until)}${h.window ? ` (${h.window})` : ""}` : `hold ended ${whenText(h.until)}`}, back-off count ${h.streak}`);
  if (h.guess) parts.push(`${h.guess.until > now ? `passed over until about ${whenText(h.guess.until)}` : `guess ended ${whenText(h.guess.until)}`} (no reset reported), ${h.guess.streak} in a row`);
  return state ? parts.join("; ") : `${h.account} (${HARNESS_NAMES[h.harness] || h.harness}): ${parts.join("; ")}`;
}

/**
 * `pendulum hold list | release <account> [--repo OWNER/NAME]` (#376): the usage-limit holds this machine's serves share
 * (lib/holds.mjs, read with the same checks as serve), or with --repo those of GitHub Actions and the cloud sandbox
 * (lib/route-holds.mjs, read and written with the person's own token: local mode's, else their gh login). `release`
 * writes one release record for the account named exactly as `list` shows it, which ends its holds and guesses and its
 * back-off count for every reader at once; it removes no file and changes no other account. A name with nothing held
 * is refused (exit 1), naming the ones that are. `home`, `now` and `out`/`err` are a test's own.
 */
export async function holdCommand(flags, { home = homedir(), now = Date.now(), out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s) } = {}) {
  const [, what, account] = flags._;
  const repo = flags.repo ? repoOf(flags.repo) : null;
  const where = repo ? `on ${repo.full}'s holds issue (GitHub Actions and the cloud sandbox)` : `on this machine (${holdsDir(home)})`;
  const opts = repo ? { token: sessionToken(repo.full) } : null;
  if (what === "list") {
    const list = repo ? (await personHolds(repo, opts, { now })).store.list(now) : accountHolds({ dir: holdsDir(home), onError: () => {} }).list(now);
    out(list.length ? `${list.map((h) => holdText(h, now)).join("\n")}\n` : `no account is held or passed over ${where}\n`);
    return 0;
  }
  let released;
  let known;
  let refused = null;
  let issue = null;
  if (repo) ({ released, known, refused, issue } = await releaseRouteHold(repo, account, opts, { now }));
  else {
    let failed = null;
    const store = accountHolds({ dir: holdsDir(home), onError: (e) => (failed = e) });
    known = store.list(now).map((h) => h.account);
    released = store.release({ account, now });
    // A record that could not be written to the folder is kept in this process alone, which ends with it: nothing released.
    if (failed) {
      err(`pendulum: the release could not be written to ${holdsDir(home)} (${String(failed?.message || failed).slice(0, 160)}); nothing was released\n`);
      return 1;
    }
  }
  if (!released) {
    err(`pendulum: nothing is held or passed over for ${JSON.stringify(account)} ${where}; ${known.length ? `the accounts that are: ${known.join(", ")}` : "no account is"}\n`);
    return 1;
  }
  if (refused) {
    err(`pendulum: the release of ${account} was posted on ${repo.full}#${issue}, Pendulum's holds issue, but it will not count: ${refused}; delete that comment, and release it again with a token of a person who can push\n`);
    return 1;
  }
  out(`released ${released.account} (${HARNESS_NAMES[released.harness] || released.harness}), which was ${holdText(released, now, { state: true })}\n${repo ? "the next stage on GitHub Actions or the cloud sandbox may start on it, when its workflow pins this Pendulum release or later; a job on an earlier release still holds it until its reset" : `every serve on this Pendulum release or later on this machine may start on it at its next tick, and an Objective paused on it resumes then; a serve on an earlier release still holds it until its reset: restart that serve on this release for it to see the release`}\n`);
  return 0;
}

/**
 * The token for Pendulum's own writes from a session (`deliver`, `post-review`): the local token when set up, else the
 * developer's gh login. These commands run no model, so the writes are Pendulum's, made on the developer's behalf.
 */
function sessionToken(repoFull) {
  const t = localToken(repoFull) || ghLoginToken();
  if (t) return t;
  throw new Error(`no token: save one for local mode with \`pendulum token set\` (${tokenFile(repoFull)}), or log in with gh`);
}

/** The clone a session command (`issue`, `deliver`, `post-review`) runs in: its top directory, repository and token. */
function sessionClone(flags) {
  const dir = cloneTop(resolve(flags.checkout || process.cwd()));
  const repoFull = cloneRepo(dir, flags.repo);
  return { dir, repoFull, repo: repoOf(repoFull), opts: { token: sessionToken(repoFull) } };
}

/**
 * A session command's inputs: the workflow as committed on the default branch (never the working tree), so its
 * maintainers and protected paths are the repository's, with the writers and pinned maintainers primed for the check of
 * who wrote the issue (objective-trust.mjs).
 */
async function sessionInputs({ dir, repoFull, repo, opts }) {
  const defaultBranch = (await rest(`repos/${repo.full}`, opts)).default_branch;
  await gitIn(dir, ["fetch", "-q", "origin", defaultBranch]);
  const committed = await gitIn(dir, ["show", `origin/${defaultBranch}:.github/workflows/pendulum.yml`]).then((r) => workflowSettings(workflowEnv(r.stdout)).kept, () => ({}));
  const inputs = resolveInputs({ args: { repo: repoFull }, env: { ...process.env, ...committed } });
  await primeWriters(repo, opts, { maintainers: inputs.maintainers });
  return { defaultBranch, inputs };
}

/** Where `pendulum issue` writes the issue for a session by default, and where `deliver` reads what the session was given. */
const sessionIssueFile = (dir) => join(process.env.PENDULUM_IN || resolve(dir, sh("git", ["-C", dir, "rev-parse", "--git-dir"]), "pendulum-in"), "issue.md");

/** A session's refusal of an issue whose author, last editor or latest title renamer cannot vouch for it: the Blocked notice's words. */
const untrustedRefusal = (t, what) => new Error(`${what}: ${t.reason}. ${t.fix}`);
/** A draft (pendulum:draft) is run on no route, a session's included (lib/stop.mjs stopCause): the refusal and its fix. */
const draftRefusal = (issue, what) => new Error(`${what}: #${issue} is a draft (${DRAFT_LABEL}), which Pendulum never runs; start it first (take ${DRAFT_LABEL} off and apply the Objective label, or ask "Start Pendulum Objective ${issue}")`);

/**
 * `pendulum issue <issue> [--out FILE]`: the issue as a session reads it (/pendulum:pendulum-run --here, /pendulum:pendulum-review-here), written
 * to --out (default $PENDULUM_IN/issue.md, else <git dir>/pendulum-in/issue.md) as the worker writes it: the title and
 * body read with their author, last editor and latest title renamer, only when each can push or is a pinned maintainer. Otherwise nothing is
 * written, the reason and its fix go to stderr, and the exit code is 1: the body never reaches the session. Without
 * --out, also plan.md beside it: the plan comment, only when the plan was made from this text (else none, and an
 * earlier one is removed). Writes nothing to GitHub.
 */
async function issueForSession(issue, flags) {
  const clone = sessionClone(flags);
  const { inputs } = await sessionInputs(clone);
  const data = await getIssue(clone.repo, issue, clone.opts);
  if (isDraft(data)) throw draftRefusal(issue, `#${issue} is not given to this session`);
  const t = await trustedIssue(clone.repo, issue, data, clone.opts);
  if (!t.ok) throw untrustedRefusal(t, `#${issue} is not given to this session`);
  const file = resolve(flags.out || sessionIssueFile(clone.dir));
  // In the session's hand-off directory, the plan beside the issue, only when it was made from this text
  // (objective-trust.mjs planTextState, as a work stage hands its harness): after an edit the session plans again from
  // the new text. No plan.md from an earlier run stays, even when the plan cannot be read: it goes before anything else.
  const planFile = flags.out ? null : join(dirname(file), "plan.md");
  if (planFile) rmSync(planFile, { force: true });
  // An edit since the plan is judged by the edit check on the AI Gateway alone (a session has no stage harness here).
  const { posted, state } = planFile ? await planStateNow(clone.repo, issue, t, clone.opts, {}, () => openEditCheck({ inputs })) : {};
  // The edit check's call, outside any stage: the CLI's decisions comment (decision-spend.mjs).
  await flushDecisionSpend(clone.repo, clone.opts, { role: "cli" });
  mkdirSync(resolve(file, ".."), { recursive: true });
  writeFileSync(file, inFiles({ issue, issueTitle: t.issueData.title, issueBody: t.issueData.body })["issue.md"]);
  log(`#${issue}: written by ${t.people.map(([role, login]) => `${role} ${login}`).join(", ")}; ${file}`);
  // A foundation Objective (`pendulum:foundation`, vouched for as the review job vouches for it): its review has two passes.
  const found = await foundationTrusted(clone.repo, issue, t.labels, clone.opts);
  if (!found.ok) log(`#${issue}: ${found.reason}. ${found.fix} Until then post-review posts no review for it.`);
  else if (found.foundation) log(`#${issue}: a foundation Objective (pendulum:foundation): its review runs the foundation pass too`);
  if (!planFile) return 0;
  const plan = state === "same" ? (posted.text ?? null) : null;
  if (plan !== null) writeFileSync(planFile, plan);
  log(plan !== null ? `#${issue}: its plan in ${planFile}` : state === "unplanned" ? `#${issue}: no plan yet` : `#${issue}: the plan comment was not made from this text, so no plan.md: plan from the issue`);
  return 0;
}

/**
 * `pendulum deliver <issue>`: Pendulum's half of an Objective worked in a session (/pendulum:pendulum-run --here). The session
 * committed on pendulum/<issue> in this clone and left its hand-off files in --out (default <git dir>/pendulum-out);
 * Pendulum checks the issue's author, last editor and latest title renamer (objective-trust.mjs: a Block, nothing pushed,
 * when one cannot vouch for it), checks the protected paths, pushes, opens or updates the PR from pr.md, posts the plan comment, the
 * replies and the note, and applies the exit record. Returns the process exit code.
 */
async function deliver(issue, flags) {
  const clone = sessionClone(flags);
  const { dir, repo, opts } = clone;
  const branch = `pendulum/${issue}`;
  const current = sh("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"]);
  if (current !== branch) throw new Error(`the clone is on ${current}; deliver runs on ${branch}`);
  // Run from a session (/pendulum:pendulum-run --here), so the App's key is not read here: notices post with this token.
  if (process.env.PENDULUM_LOCAL_APP_ID) log("notices post with your own token here, so their @mention notifies no one; the App posts them only for serve and run");
  const { defaultBranch, inputs } = await sessionInputs(clone);
  // When the Objective was last started, read before the text, as the worker does (objective-trust.mjs startedAt, planGate).
  const labeledAt = await startedAt(repo, issue, inputs.objectiveLabel, opts);
  const issueNow = await getIssue(repo, issue, opts);
  if (isDraft(issueNow)) throw draftRefusal(issue, "nothing was delivered");
  // The worker's check, made again here: the body the session read may have been edited since by someone who cannot push.
  const trusted = await authorGate({ repo, issue, issueData: issueNow, notify: inputs.notify, opts, apply: applyExit });
  if (!trusted.ok) {
    log(`#${issue}: blocked, nothing pushed: ${trusted.reason}`);
    return 1;
  }
  const { issueData } = trusted;
  // The text the session planned from is the issue.md `pendulum issue` gave it: changed since, nothing is delivered, and
  // the session reads the issue again. That text is the plan's record (objective-trust.mjs planGate); with no issue.md
  // here (written elsewhere with --out), the plan comment keeps the record it has (handoff.mjs planSync).
  const given = (() => {
    try {
      return readFileSync(sessionIssueFile(dir), "utf8");
    } catch {
      return null;
    }
  })();
  if (given !== null && settled(given) !== settled(inFiles({ issue, issueTitle: issueData.title, issueBody: issueData.body })["issue.md"])) throw new Error(`nothing was delivered: the Objective's title or body changed after this session read it; run \`pendulum issue ${issue}\` again and make the plan again from the new text`);
  // An edit since the plan the edit check keeps (as `pendulum issue` judged it, on the gateway alone) keeps the plan's own
  // record, its text the baseline the next edit is judged against; else the text the session was given.
  const kept = given === null ? null : await planStateNow(repo, issue, trusted, opts, {}, () => openEditCheck({ inputs }));
  await flushDecisionSpend(repo, opts, { role: "cli" });
  const planRecord = given === null ? null : kept.state === "same" && kept.record && kept.record.sha256 !== trusted.sha ? { ...kept.record, label: labeledAt } : { sha256: trusted.sha, label: labeledAt, text: recordText({ ...issueData, labels: trusted.labels }) };
  const out = resolve(flags.out || process.env.PENDULUM_OUT || resolve(dir, sh("git", ["-C", dir, "rev-parse", "--git-dir"]), "pendulum-out"));
  const { files, refused } = await readOut({ out }, process.env);
  if (refused.length) log(`hand-off files refused: ${refused.join(", ")}`);
  const record = exitFromOut(files) || { exit: "blocked", reason: "the session left no exit record ($PENDULUM_OUT/exit.json)", questions: [] };
  // An issue body or a plan that needs another repository is the owner's Question (one-repo.mjs): the plan comment and
  // the Question go up, and nothing is pushed. As in the worker, a repository a maintainer has answered about since
  // Pendulum asked (its own progress record, written as this token's login) is not asked again, and the ask is recorded
  // for the next run.
  const planText = typeof files["plan.md"] === "string" ? files["plan.md"] : await currentPlan(repo, issue, opts).catch(() => null);
  const asking = await findPr(repo, branch, opts).catch(() => null);
  await primeSelf(opts);
  const askedAt = planAskedOf(await listComments(repo, issue, opts).catch(() => []), { issue, self: selfLogin() });
  const answered = answeredRepos(askedAt, await objectiveDecisions(repo, { issue, prNumber: asking?.number ?? null }, opts).catch(() => []));
  const named = declaredQuestion(issueData.body, { source: repo, label: inputs.objectiveLabel });
  const needs = named ? { reason: named, repos: [] } : planNeedsOf(planText, { source: repo, label: inputs.objectiveLabel, answered });
  const planNeeds = needs.reason || "";
  if (planNeeds) {
    await planSync(repo, issue, opts, planRecord)(files["plan.md"]);
    await postNote(repo, issue, files["note.md"], opts);
    await applyExit(repo, { issue, pr: asking, exit: "question", reason: planNeeds, notify: inputs.notify, stage: "work", askOnIssue: true }, opts);
    // A `--here` run is not counted (skills/pendulum-score): its comment carries no spend line.
    if (needs.repos.length) await progressReporter(repo, issue, opts, { stage: "work", soFar: null }).planAsked(needs.repos);
    log(`#${issue}: question at plan time (${planNeeds}); nothing pushed`);
    return 1;
  }
  // A Question that names no test of the Question rule is checked in the session before anything is delivered.
  if (record.unfounded?.length) throw new Error(`nothing was delivered: ${questionCheckPrompt(record, { file: true })} Then run deliver again.`);
  // Pendulum's push (lib/outbox.mjs): checked in its own mirror (protected paths, Git LFS), leased, read back.
  const tmp = privateTmp({ ...process.env });
  // The session's workflow hand-over (handoff.mjs handoverChecker), checked in Pendulum's mirror once the branch is up.
  let handover;
  let ahead = 0;
  try {
    const outbox = await openOutbox({ branch, defaultBranch, checkout: dir, remote: `https://github.com/${repo.full}.git`, token: () => opts.token, agentEnv: process.env, local: true, protectedList: protectedPaths(inputs.protectedAdditions), setup: inputs.setup, setupContext: { env: process.env, roots: [dir] }, base: tmp.pendulum });
    // A merge Pendulum makes itself here (the default branch's workflow change, an unsynced checkout) carries the
    // identity of the token that pushes it, as on every other route.
    outbox.author = commitAuthor(await gitIdentity(null, opts.token));
    if (!(await outbox.push())) throw new Error(`nothing was delivered: ${outbox.error}`);
    const checker = handoverChecker(() => files, outbox);
    handover = await checker.now();
    if (checker.refused()) throw new Error(`the branch is pushed, nothing else was delivered: ${checker.refused()}; fix it and run deliver again`);
    ahead = (await outbox.delta()).count;
  } finally {
    dropOwned(tmp.pendulum);
  }
  // Nothing pushed but a hand-over: no PR can carry it, so it goes on the issue and the Objective Blocks, as on every route.
  const openNow = await findPr(repo, branch, opts).catch(() => null);
  const only = !ahead && !openNow && handover ? decideExit({ harness: { ok: true }, pr: null, commits: 0, record, handoverOnly: true }) : null;
  if (only?.handoverOnly) {
    await planSync(repo, issue, opts, planRecord)(files["plan.md"]);
    await handoverOnIssue(repo, { issue, handover, defaultBranch }, opts);
    await applyExit(repo, { issue, pr: null, exit: only.exit, reason: only.reason, cause: only.cause, notify: inputs.notify, stage: "work" }, opts);
    log(`#${issue}: blocked: ${only.reason}`);
    return 1;
  }
  await planSync(repo, issue, opts, planRecord)(files["plan.md"]);
  const prior = await partsRecord(repo, issue, opts).catch(() => null);
  const open = await findPr(repo, branch, opts).catch(() => null);
  const left = record.part ? record.part.remaining.length : open && isSplitPart(prior, open.number) ? prior.remaining : 0;
  let pr = await publishPr(repo, { branch, base: defaultBranch, issue, issueTitle: issueData.title, prText: files["pr.md"], splitPart: left > 0, pr: open, handover }, opts);
  const replied = await deliverReplies(repo, pr.number, issue, files["replies.json"], opts);
  await postNote(repo, issue, files["note.md"], opts);
  if (record.exit === "delivered") {
    const rec = await recordPart(repo, issue, pr.number, left, opts);
    pr = await publishPr(repo, { branch, base: defaultBranch, issue, prText: null, splitPart: isSplitPart(rec, pr.number), pr }, opts);
    pr = await markReady(repo, pr, opts);
    // The label from a person's token fires the Action's review job, as the App's does.
    await removeLabel(repo, pr.number, REVIEW_LABEL, opts).catch(() => {});
    await addLabels(repo, pr.number, [REVIEW_LABEL], opts);
  }
  await applyExit(repo, { issue, pr, exit: record.exit, reason: record.exit === "question" ? `question: ${clip(record.questions[0] || "")}` : record.reason, cause: "work", notify: inputs.notify, stage: "work" }, opts);
  log(`#${issue}: ${record.exit}; PR #${pr.number} ${pr.html_url}${replied ? `; ${replied} repl${replied === 1 ? "y" : "ies"} posted` : ""}`);
  return record.exit === "delivered" ? 0 : 1;
}

/**
 * The session's replies (replies.json) on delivery, posted as the review stage's answer pass posts them: only to the open
 * findings of Pendulum's own reviews on the PR (session.mjs ownReviewIds, unaddressedReviewComments). A reply to any
 * other comment is not posted, and the log says how many and which: a stranger's comment, a finding already answered,
 * or a review by an App this login cannot tell is Pendulum's (the Action's own App, say); every reply, when the PR's
 * review comments cannot be read. Returns how many were posted.
 */
export async function deliverReplies(repo, prNumber, issue, text, opts) {
  let open;
  let unread = null;
  try {
    open = await unaddressedReviewComments(repo, prNumber, null, { ...opts, reviewIds: await ownReviewIds(repo, prNumber, issue, opts) });
  } catch (e) {
    open = [];
    unread = String(e?.message || e).slice(0, 120);
  }
  const allowed = open.map((c) => c.id);
  const named = (() => {
    try {
      const list = JSON.parse(String(text ?? ""));
      return Array.isArray(list) ? [...new Set(list.map((r) => String(r?.id ?? "")).filter(Boolean))] : [];
    } catch {
      return [];
    }
  })();
  const dropped = named.filter((id) => !allowed.some((a) => String(a) === id));
  if (dropped.length) {
    const which = `${dropped.slice(0, 10).map((id) => id.slice(0, 40)).join(", ")}${dropped.length > 10 ? ", …" : ""}`;
    const why = unread ? `the PR's review comments could not be read (${unread})` : "not an open finding of a review this login can tell is Pendulum's own";
    log(`PR #${prNumber}: ${dropped.length} repl${dropped.length === 1 ? "y" : "ies"} not posted (${which}): ${why}`);
  }
  return postReplies(repo, prNumber, issue, text, allowed, opts);
}

/** Why pushing a handed-over workflow waits for a person's read. */
export const HANDOVER_RISK = "a workflow runs with the repository's secrets, and one that runs `on: push` runs as soon as its branch is pushed";

/**
 * The body of the pull request `pendulum handover <issue> --push` opens: it names the Objective (Refs, not Closes: the
 * Objective's own PR closes it), links Pendulum's hand-over comment, and says the person read the change before pushing.
 */
export function handoverPrBody({ issue, url = "" }) {
  return [
    `Refs #${issue}`,
    "",
    `The workflow change Pendulum handed over for #${issue}: Pendulum never pushes a workflow file, so a person applies it. ${url ? `Pendulum's hand-over comment: ${url}` : `Pendulum's hand-over comment is on #${issue}.`}`,
    "",
    `The person who pushed this branch reviewed the workflow change before pushing it: \`pendulum handover ${issue}\` staged and showed it, and \`pendulum handover ${issue} --push\` committed and pushed it only once the staged change was exactly that hand-over.`,
  ].join("\n");
}

/**
 * The hand-over `pendulum handover` may apply, or a refusal (an Error whose message says why; nothing is changed then).
 * The comment's author is trusted directly, and must also have applied `pendulum:handover` at some time (another
 * login's labelling, a triager's relabel included, neither adds nor takes away trust). Trusted are only:
 *  - the Pendulum App this person names (`appId`: --app or PENDULUM_LOCAL_APP_ID; it is the repository's
 *    PENDULUM_APP_ID), known by GitHub's own `performed_via_github_app` on the comment (that id, and the author being
 *    that App's `<slug>[bot]`). An App's comment is never trusted without the id, and the comment's own App id is never
 *    offered as the value to pass;
 *  - a person (no `[bot]` login) whose repository permission, read from GitHub now, is write, maintain or admin; local
 *    mode's operator, who posts Pendulum's comments, is one.
 * `github-actions[bot]` (the job token, which any workflow can post as) is refused outright, and so is a permission
 * that cannot be read: there is no fallback. The newest trusted comment wins; with none, the newest one's refusal is
 * given. Returns {patch, who, url}.
 */
export async function trustedHandover(repo, issue, opts, { appId = "" } = {}) {
  const refuse = (why) => Object.assign(new Error(why), { refusal: true });
  const id = String(appId ?? "").trim();
  let events;
  try {
    events = (await rest(`repos/${repo.full}/issues/${issue}/timeline?per_page=100`, { ...opts, paginate: true })) || [];
  } catch (e) {
    throw refuse(`#${issue}'s timeline could not be read (${String(e?.message || e).slice(0, 120)}), so who applied ${HANDOVER_LABEL} is unknown`);
  }
  const labelers = new Set(events.filter((e) => e.event === "labeled" && e.label?.name === HANDOVER_LABEL).map((e) => e.actor?.login).filter(Boolean));
  if (!labelers.size) throw refuse(`#${issue} carries no workflow hand-over (nobody applied ${HANDOVER_LABEL})`);
  const mark = `${handoverMarker(issue)}\n`;
  const candidates = (await listComments(repo, issue, opts)).filter((c) => (c.body || "").startsWith(mark) && labelers.has(c.user?.login)).reverse();
  if (!candidates.length) throw refuse(`#${issue} has no hand-over comment from anyone who applied ${HANDOVER_LABEL}`);
  const verdict = async (c) => {
    const login = c.user?.login ?? "";
    const app = c.performed_via_github_app;
    if (login === JOB_TOKEN_LOGIN || app?.slug === "github-actions") return { why: `the hand-over comment is ${JOB_TOKEN_LOGIN}'s, which any workflow can post as; it never hands a workflow over` };
    if (app) {
      if (!id) return { why: `the hand-over comment is from the GitHub App ${app.slug}, not verified: name your Pendulum App's id with --app ID (or PENDULUM_LOCAL_APP_ID); it is the repository's PENDULUM_APP_ID, shown on the App's settings page` };
      if (String(app.id) !== id) return { why: `the hand-over comment is from the GitHub App ${app.slug}, not your Pendulum App (id ${id})` };
      if (login !== `${app.slug}[bot]`) return { why: `the hand-over comment came through your Pendulum App (id ${id}), but its author ${login} is not that App's bot` };
      return { who: `the Pendulum App ${login} (id ${id})` };
    }
    if (/\[bot\]$/i.test(login)) return { why: `the hand-over comment is ${login}'s, a bot that is not the Pendulum App you named` };
    let permission;
    try {
      permission = await collaboratorPermission(repo, login, opts);
    } catch (e) {
      throw refuse(`${login}'s permission on ${repo.full} could not be read (${String(e?.message || e).slice(0, 120)}), so the hand-over comment is not trusted`);
    }
    if (!HANDOVER_WRITERS.has(permission)) return { why: `${login}, who wrote the hand-over comment, cannot write to ${repo.full} (${permission || "no access"}); only Pendulum's App or someone who can write hands a workflow over` };
    return { who: `${login} (${permission} permission)` };
  };
  let first = null;
  for (const c of candidates) {
    const v = await verdict(c);
    if (!v.who) {
      first ??= v.why;
      continue;
    }
    const patch = handoverOf(c.body.slice(mark.length));
    if (!patch) throw refuse(`${c.user.login}'s hand-over comment on #${issue} carries no patch`);
    return { patch, who: v.who, url: c.html_url ?? "" };
  }
  throw refuse(first);
}

/**
 * `pendulum handover <issue> [--push] [--app ID]`: a person applies Pendulum's workflow hand-over (handover.mjs) in their
 * clone, in two steps. The first takes the hand-over trustedHandover accepts, says whose it is, checks it again here as
 * Pendulum did (outbox.mjs checkHandover, against the default branch as fetched now), puts git's own result on a new
 * branch `pendulum-workflow/<issue>` from the default branch (or, when that fails, leaves the clone as it was), shows
 * `git diff --cached` and stops: nothing is committed or pushed, because pushing a workflow can run it. The second,
 * `--push`, on that branch, takes and checks the hand-over again and goes on only when the staged change is exactly
 * that, then commits (hooks off, as in step one), pushes the branch and opens its pull request with `gh`. Nothing here
 * runs a shell: every value goes to git or gh as one argument. Returns the exit code.
 */
async function handoverForPerson(issue, flags) {
  const clone = sessionClone(flags);
  const { dir, repo, opts } = clone;
  const branch = handoverBranch(issue);
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  const git = (args, o = {}) => exec("git", ["-C", dir, "-c", "core.hooksPath=/dev/null", ...args], { env: o.env ?? env, input: o.input, maxBytes: 64 * 1024 * 1024 });
  git.env = () => env;
  const fail = (why) => {
    process.stderr.write(`pendulum handover: ${why}\n`);
    return 1;
  };
  const check = async (patch, tree, against) => {
    const scratch = mkdtempSync(join(tmpdir(), "pendulum-handover-"));
    try {
      return await checkHandover(git, { patch, tree, index: join(scratch, "index"), against });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  };
  const defaultBranch = (await rest(`repos/${repo.full}`, opts)).default_branch;
  if ((await exec("git", ["check-ref-format", "--branch", String(defaultBranch)], { env })).code !== 0) return fail(`GitHub's default branch name ${JSON.stringify(defaultBranch)} is no branch name git takes`);
  let trusted;
  try {
    trusted = await trustedHandover(repo, issue, opts, { appId: flags.app ?? process.env.PENDULUM_LOCAL_APP_ID ?? "" });
  } catch (e) {
    if (!e.refusal) throw e;
    return fail(`${e.message}; nothing was changed here`);
  }
  log(`#${issue}: the hand-over is ${trusted.who}'s comment${trusted.url ? ` (${trusted.url})` : ""}`);
  if (flags.push) {
    const on = (await git(["symbolic-ref", "--short", "-q", "HEAD"])).stdout.trim();
    if (on !== branch) return fail(`run it on ${branch}, after \`pendulum handover ${issue}\` put the change there and you read it`);
    // The staged change must be exactly the hand-over as checked on this branch's commit, which step one showed.
    const checked = await check(trusted.patch, "HEAD", branch);
    if (!checked.ok) return fail(`the hand-over ${checked.problem}; nothing was pushed`);
    const staged = await git(["diff-index", "--cached", "-p", "--no-renames", "--no-ext-diff", "--no-textconv", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", "HEAD"]);
    if (staged.code !== 0 || staged.stdout !== checked.patch) return fail(`what is staged on ${branch} is not the hand-over as shown; nothing was pushed. Start again: switch back, delete ${branch} and run \`pendulum handover ${issue}\``);
    if ((await git(["diff", "--name-only"])).stdout.trim()) return fail(`${branch} has unstaged changes; nothing was pushed`);
    const title = `#${issue}: the workflow change Pendulum handed over`;
    const steps = [
      ["git", ["-C", dir, "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", title]],
      ["git", ["-C", dir, "push", "-u", "origin", `HEAD:refs/heads/${branch}`]],
      ["gh", ["pr", "create", "--repo", repo.full, "--base", defaultBranch, "--head", branch, "--title", title, "--body", handoverPrBody({ issue, url: trusted.url })]],
    ];
    for (const [cmd, args] of steps) {
      const r = await exec(cmd, args, { env, cwd: dir });
      if (r.code !== 0) return fail(`${cmd} ${cmd === "gh" ? "pr create" : args.find((a) => a === "commit" || a === "push")} failed: ${String(r.stderr || r.stdout).trim().split("\n").at(-1)?.slice(0, 200)}`);
      if (cmd === "gh") process.stdout.write(`${String(r.stdout).trim()}\n`);
    }
    log(`#${issue}: the workflow hand-over is on ${branch} and in a pull request; remove the ${HANDOVER_LABEL} label from #${issue} once it merges`);
    return 0;
  }
  if ((await git(["status", "--porcelain", "--untracked-files=no"])).stdout.trim()) return fail("this clone has uncommitted changes; commit or stash them first");
  if ((await git(["rev-parse", "--verify", "-q", `refs/heads/${branch}`])).code === 0) return fail(`${branch} exists already; finish it with --push, or delete it to start again`);
  const fetched = await git(["fetch", "-q", "--no-tags", "origin", `+refs/heads/${defaultBranch}:refs/remotes/origin/${defaultBranch}`]);
  if (fetched.code !== 0) return fail(`git fetch failed: ${String(fetched.stderr).trim().split("\n").at(-1)?.slice(0, 200)}`);
  const base = (await git(["rev-parse", "--verify", `refs/remotes/origin/${defaultBranch}^{commit}`])).stdout.trim();
  const checked = await check(trusted.patch, base, defaultBranch);
  if (!checked.ok) return fail(`the hand-over ${checked.problem}; nothing was changed here`);
  // Where the clone was, to go back to when the branch cannot take the change.
  const was = (await git(["symbolic-ref", "--short", "-q", "HEAD"])).stdout.trim() || (await git(["rev-parse", "HEAD"])).stdout.trim();
  if ((await git(["switch", "-q", "--no-track", "-c", branch, base])).code !== 0) return fail(`git could not make ${branch} from ${defaultBranch}`);
  const applied = await git(["apply", "--index", "-"], { input: checked.patch });
  if (applied.code !== 0) {
    await git(["reset", "-q", "--hard"]);
    await git(["switch", "-q", ...(/^[0-9a-f]{40,64}$/.test(was) ? ["--detach"] : []), was]);
    await git(["branch", "-q", "-D", branch]);
    return fail(`git could not apply the hand-over on ${branch} (${String(applied.stderr).trim().split("\n").at(-1)?.slice(0, 200)}); the clone is back on ${was} and ${branch} is deleted`);
  }
  const shown = await git(["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-color"]);
  process.stdout.write(shown.stdout);
  log(`#${issue}: the workflow hand-over (${trusted.who}'s) is staged on ${branch}, from ${defaultBranch}; nothing is committed or pushed.`);
  log(`Read the diff above before you push it: ${HANDOVER_RISK}. When you have, run \`pendulum handover ${issue} --push\` to commit it, push ${branch} and open its pull request.`);
  return 0;
}

/**
 * The review `pendulum post-review` posts from a findings file's text, or a throw when the file is no reviewer pass: it
 * holds no reviewer JSON, or it judges no acceptance entry (handoff.mjs reviewMissed). On a foundation
 * Objective (`foundation`, foundationTrusted) the file also holds the foundation pass, `"foundation": {"comments": [...]}`,
 * posted as the review job posts it; a file without it, or with it on any other Objective, is refused. Nothing is
 * posted then, so the user fixes the file and runs the command again; a review carrying the marker would stop the
 * Action's own reviewer pass.
 */
export function reviewPostFor({ issue, text, file, diff, entries, foundation = false }) {
  // The file as one JSON object, read once, each pass taken from it by its key in any order; text that is not one JSON
  // value (a fenced block, prose around it) is read as the review job reads an answer, and holds no foundation pass.
  let whole;
  try {
    whole = JSON.parse(String(text).trim());
  } catch {
    whole = undefined;
  }
  const review = whole === undefined ? parseReview(text) : reviewOfValue(whole);
  if (!review.parsed) throw new Error(`${file} holds no reviewer JSON; nothing posted`);
  if (reviewMissed({ review, entries })) throw new Error(entries.length ? `${file} judges none of the issue's acceptance entries (${entries.map((e) => e.id).join(", ")}); nothing posted` : `${file} judges no acceptance entry (its "acceptance" list is empty); nothing posted`);
  const pass = whole && typeof whole === "object" && !Array.isArray(whole) ? whole.foundation : undefined;
  if (foundation && !Array.isArray(pass?.comments)) throw new Error(`${file} holds no foundation pass ("foundation": {"comments": [...]}), which #${issue}'s pendulum:foundation label asks for; nothing posted`);
  if (!foundation && pass !== undefined) throw new Error(`${file} holds a foundation pass, but #${issue} is not a foundation Objective (no trusted pendulum:foundation label); nothing posted`);
  return reviewPost({ issue, review, diff, entries, foundation: foundation ? { comments: pass.comments, acceptance: null, parsed: true } : null });
}

/**
 * `pendulum post-review <pr> <findings.json>`: post a reviewer pass made in a session (/pendulum:pendulum-review-here) as Pendulum's one
 * comment-only review (handoff.mjs reviewPost): the findings fitted to the diff and their text sanitised, a comment for
 * each entry judged not met without one, the judgments in the body, under the review marker.
 */
async function postFindings(prNumber, file, flags) {
  const clone = sessionClone(flags);
  const { dir, repo, opts } = clone;
  const pr = await getPr(repo, prNumber, opts);
  const issue = Number(/^pendulum\/(\d+)$/.exec(pr.head?.ref || "")?.[1]);
  if (!issue) throw new Error(`PR #${prNumber} is not on a pendulum/<issue> branch`);
  // The review job's check: a review judged against text no writer vouches for is not posted.
  const { inputs } = await sessionInputs(clone);
  const trusted = await trustedIssue(repo, issue, await getIssue(repo, issue, opts), opts);
  if (!trusted.ok) throw untrustedRefusal(trusted, "nothing posted");
  // The review job's second check: a review of code made from earlier text than the Objective's now is not posted. An
  // edit since the plan is judged by the edit check on the AI Gateway alone (a session has no stage harness here).
  const textState = (await planStateNow(repo, issue, trusted, opts, {}, () => openEditCheck({ inputs }))).state;
  await flushDecisionSpend(repo, opts, { role: "cli" });
  if (textState === "changed") throw new Error(`nothing posted: ${EDITED_REASON}`);
  // The review job's third: a foundation label it would Block on is refused here; a trusted one asks for both passes.
  const found = await foundationTrusted(repo, issue, trusted.labels, opts);
  if (!found.ok) throw new Error(`nothing posted: ${found.reason}. ${found.fix}`);
  // The diff from this clone's history in a scratch repository (no file limit), GitHub's files API when that fails.
  const tmp = privateTmp({ ...process.env });
  let diff;
  try {
    let objects = null;
    try {
      objects = realpathSync(resolve(dir, sh("git", ["-C", dir, "rev-parse", "--git-common-dir"]), "objects"));
    } catch {
      // no object store to borrow: the scratch repository fetches what it needs
    }
    const history = await scratchHistory({ remote: `https://github.com/${repo.full}.git`, token: () => opts.token, objects, base: tmp.pendulum }).catch(() => null);
    const prd = await prDiff(repo, pr, opts, { diffOf: history ? (base, head) => mirrorDiff(history.git, base, head, { mergeBase: true, maxBytes: 256 * 1024 * 1024 }) : null });
    if (prd.source !== "history") log(`PR #${prNumber}'s diff came from GitHub's files API (local history: ${prd.historyError})${prd.unlisted ? `; ${prd.unlisted} file(s) are past the API's listing` : ""}`);
    diff = prd.text;
  } finally {
    dropOwned(tmp.pendulum);
  }
  const post = reviewPostFor({ issue, text: readFileSync(file, "utf8"), file, diff, entries: acceptanceEntries(trusted.issueData.body), foundation: found.foundation });
  const { comments } = post;
  const posted = await postReview(repo, prNumber, { body: post.body, comments, commitId: pr.head.sha }, opts);
  log(`PR #${prNumber}: review posted with ${comments.length} comment(s)${posted.moved ? `; ${posted.moved} moved to a line GitHub takes` : ""}${posted.inBody ? `; ${posted.inBody} in the review body${posted.retried ? ` (GitHub answered ${posted.retried} to the line comments)` : " (no line GitHub can take)"}` : ""}`);
  return 0;
}

/**
 * `pendulum wait [<issue>...]` (lib/wait.mjs): one JSON line per event on the queue, read from GitHub, so it tells every
 * route's Objectives with or without `serve`. The repository from --repo, else the clone's origin; the local token,
 * else the gh login (it only reads). A spent rate limit or this machine's network waits, as serve's do, within --timeout.
 * Stdout carries only the events; log lines go to stderr.
 */
async function waitForQueue(flags) {
  const repoFull = cloneRepo(resolve(flags.checkout || process.cwd()), flags.repo);
  // Stdout is the events, one JSON line each; Pendulum's log lines (a retry, a rate limit's wait) go to stderr.
  logTo(process.stderr);
  const timeoutMs = flags.timeout ? flags.timeout * 1000 : null;
  const deadline = timeoutMs ? Date.now() + timeoutMs : Infinity;
  waitOutages({ until: () => deadline });
  const { objectiveLabel } = resolveInputs({ args: { repo: repoFull }, env: process.env });
  const r = await waitQueue(repoOf(repoFull), {
    // At --timeout a read in flight is ended, not waited for (lib/wait.mjs: the timeout line, exit 3).
    opts: { token: sessionToken(repoFull), deadlineAt: deadline, ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}) },
    objectiveLabel,
    issues: flags._.slice(1).map(Number),
    kinds: parseKinds(flags.on),
    since: flags.since !== undefined ? parseCursor(flags.since) : null,
    follow: !!flags.follow,
    intervalMs: flags.interval ? flags.interval * 1000 : WAIT_POLL_MS,
    timeoutMs,
    emit: (line) => process.stdout.write(`${jsonLine(line)}\n`),
  });
  return r.code;
}

/**
 * `pendulum report`: the cost and token report of the repository (--repo, else the clone's origin; with --repo it runs
 * outside a clone too) for the scope its flags name (report.mjs), read with the local token, else the gh login. The
 * planned calls go to stderr first; the report to stdout, as JSON with --json, else Markdown. Returns 0, or STOPPED_EXIT
 * when the call budget stopped the reads (the report printed is partial).
 */
export async function reportCommand(flags, { out = (t) => process.stdout.write(t), err = (t) => process.stderr.write(t), token = null, download = undefined, env = process.env, now = Date.now() } = {}) {
  const here = resolve(flags.checkout || process.cwd());
  let checkout = null;
  try {
    checkout = cloneTop(here, "--repo OWNER/NAME");
  } catch (e) {
    if (!flags.repo) throw e;
  }
  const repoFull = cloneRepo(checkout ?? here, flags.repo);
  // Pendulum's App: --app, else the repository variable PENDULUM_APP_ID (readReport; on a 403, read again with the gh
  // login's token), else its local copy beside the local token (lib/app-id.mjs), else local mode's notice App.
  const envAppId = /^\d+$/.test(String(env.PENDULUM_LOCAL_APP_ID ?? "").trim()) ? Number(env.PENDULUM_LOCAL_APP_ID) : null;
  const main = token ?? sessionToken(repoFull);
  const fallback = () => {
    const gh = ghLoginToken();
    return gh && gh !== main ? gh : null;
  };
  const read = await readReport(repoOf(repoFull), reportScope(flags, now), { token: main, fallback, localCopy: flags.app ? null : readLocalAppId(repoFull), maxCalls: flags["max-calls"] ?? DEFAULT_MAX_CALLS, appId: flags.app ?? null, envAppId, self: flags.self ?? [], by: flags.by ? [flags.by] : [], stages: !!flags.rates, checkout, log: (line) => err(`${line}\n`), ...(download ? { download } : {}) });
  const report = buildReport(read, { by: flags.by ? [flags.by] : [], rates: flags.rates ? reportModels(flags.rates) : null, now: new Date(now).toISOString() });
  out(flags.json ? `${JSON.stringify(report, null, 2)}\n` : renderReport(report));
  // A partial report says why on stderr; only a call budget stop exits STOPPED_EXIT (stages from before the rename, unread,
  // are no stop: a narrower scope or a higher --max-calls reads them no more).
  for (const m of report.source.missing.filter((x) => PARTIAL_CODES.includes(x.code))) err(`pendulum report: ${m.text}\n`);
  return report.source.stoppedAt === null ? 0 : STOPPED_EXIT;
}

/**
 * `pendulum doctor`: doctor.mjs --local on the clone (its top directory) and its repository, --repo else the clone's
 * origin (cloneRepo); with --repo, it runs outside a clone too. Returns doctor's exit code.
 */
function doctorCommand(flags) {
  const here = resolve(flags.checkout || process.cwd());
  let checkout = here;
  try {
    checkout = cloneTop(here, "--repo OWNER/NAME");
  } catch (e) {
    if (!flags.repo) throw e;
  }
  const repoFull = cloneRepo(checkout, flags.repo);
  const pass = ["json", "probe", "run-setup", "verbose"].filter((k) => flags[k]).map((k) => `--${k}`);
  const r = spawnSync(process.execPath, [join(PLUGIN_ROOT, "scripts", "doctor.mjs"), "--repo", repoFull, "--checkout", checkout, "--local", ...pass], { stdio: "inherit" });
  if (r.error) throw new Error(`doctor did not start: ${r.error.message}`);
  return r.status ?? 1;
}

/**
 * A secret typed at the terminal, never echoed: readline over the terminal (`stdin`, in raw mode) with its echo written
 * nowhere, the prompt on stderr once the echo is off. From a pipe or a file, every byte of stdin. Ctrl-C or Ctrl-Z refuses.
 */
export function readSecret(prompt, { stdin = process.stdin, err = process.stderr } = {}) {
  if (!stdin.isTTY)
    return new Promise((res, rej) => {
      const chunks = [];
      stdin.on("data", (c) => chunks.push(c));
      stdin.on("end", () => res(Buffer.concat(chunks).toString("utf8")));
      stdin.on("error", rej);
    });
  // The terminal's echo is off (readline's raw mode) before the prompt shows: nothing typed after it is echoed.
  const rl = createInterface({ input: stdin, output: new Writable({ write: (_c, _e, done) => done() }), terminal: true });
  err.write(prompt);
  return new Promise((res, rej) => {
    let answered = false;
    const end = (fn) => {
      answered = true;
      rl.close();
      err.write("\n");
      fn();
    };
    rl.on("line", (line) => end(() => res(line)));
    // Ctrl-C, and Ctrl-Z: a stop would turn the echo back on with the prompt still reading, and leave the front waiting.
    for (const key of ["SIGINT", "SIGTSTP"]) rl.on(key, () => end(() => rej(new Error("cancelled; nothing saved"))));
    rl.on("close", () => {
      if (!answered) end(() => res(""));
    });
  });
}

/**
 * `pendulum token set`: the repository's local token (--repo, else the clone's origin, cloneRepo) read without echo
 * (readSecret) and saved where localToken reads it (saveLocalToken). Prints the file, never the token. Returns 0.
 */
async function tokenSet(flags, { out = (t) => process.stdout.write(t), err = (t) => process.stderr.write(t) } = {}) {
  const repoFull = cloneRepo(resolve(flags.checkout || process.cwd()), flags.repo);
  const token = await readSecret(`fine-grained token for ${repoFull} (${LOCAL_TOKEN_PERMISSIONS}): `);
  const file = saveLocalToken(repoFull, token);
  out(`saved the local token for ${repoFull} to ${file} (owner-only)\n`);
  if (process.env.PENDULUM_LOCAL_TOKEN) err(`pendulum: PENDULUM_LOCAL_TOKEN is set in this shell, and local mode takes it over the saved file; unset it for the saved token to apply\n`);
  return 0;
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (e) {
    if (!e.usage) throw e;
    process.stderr.write(`pendulum: ${e.message}`);
    process.exit(64);
  }
  if (parsed.help) {
    process.stdout.write(usage(parsed.cmd));
    return;
  }
  if (parsed.version) {
    process.stdout.write(`pendulum ${PENDULUM_VERSION}\n`);
    return;
  }
  const { cmd, flags } = parsed;
  const [, arg, file] = flags._;
  if (cmd === "run") {
    const issue = Number(arg);
    const local = await new Local(flags).init();
    // Each stage holds one slot of the machine's budget while it runs (stage()); following the PR to its merge holds none.
    local.solo = "run";
    let task = null;
    local.stopOnSignals(() => task);
    task = local.runToEnd(issue, { wait: !!flags.wait, resumeWith: whereFlags(flags, local) });
    const r = await task;
    // Delivered, not followed to its merge: the last line says who tends it now.
    if (r.exit === "delivered" && !flags.wait) {
      const line = await local.pendingMergeLine(issue);
      if (line) log(line);
    }
    process.exitCode = runExit(r);
    return;
  }
  if (cmd === "issue") {
    process.exitCode = await issueForSession(Number(arg), flags);
    return;
  }
  if (cmd === "deliver") {
    process.exitCode = await deliver(Number(arg), flags);
    return;
  }
  if (cmd === "handover") {
    process.exitCode = await handoverForPerson(Number(arg), flags);
    return;
  }
  if (cmd === "post-review") {
    process.exitCode = await postFindings(Number(arg), file, flags);
    return;
  }
  if (cmd === "review") {
    const local = await new Local(flags).init();
    local.solo = "review";
    let task = null;
    local.stopOnSignals(() => task);
    task = local.reviewToEnd(Number(arg), { wait: !!flags.wait, resumeWith: whereFlags(flags, local) });
    process.exitCode = runExit(await task);
    return;
  }
  if (cmd === "wait") {
    process.exitCode = await waitForQueue(flags);
    return;
  }
  if (cmd === "report") {
    process.exitCode = await reportCommand(flags);
    return;
  }
  if (cmd === "zone") {
    process.stdout.write(`${zoneMarker(timeZoneName(machineZone()) ?? "UTC")}\n`);
    return;
  }
  if (cmd === "hold") {
    process.exitCode = await holdCommand(flags);
    return;
  }
  if (cmd === "doctor") {
    process.exitCode = doctorCommand(flags);
    return;
  }
  if (cmd === "token") {
    process.exitCode = await tokenSet(flags);
    return;
  }
  if (cmd === "serve") await (await new Local(flags).init({ serve: true })).serve({ once: !!flags.once, intervalMs: (flags.interval ?? 30) * 1000 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    process.stderr.write(`[pendulum] local: ${e.message}\n`);
    // Right after a switch to a new pinned release (restartOn): say so, and how to go back.
    if (SWITCHED_FROM) process.stderr.write(`[pendulum] local: serve stopped at the start of the release it switched to, ${PLUGIN_ROOT}, from ${SWITCHED_FROM}; start serve from ${join(SWITCHED_FROM, "plugin", "bin", "pendulum")} to run that one again\n`);
    process.exit(1);
  });
}
