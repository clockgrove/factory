#!/usr/bin/env node
// Factory local mode: the same worker and reviewer the Action runs, on a developer's own box.
//   node scripts/local.mjs run <issue> [--repo OWNER/NAME] [--checkout CLONE] [--wait]
//   node scripts/local.mjs review <pr> [--wait]      (a review re-run, as re-applying factory:review does on Actions)
//   node scripts/local.mjs serve [--repo OWNER/NAME] [--checkout CLONE] [--once] [--all] [--interval SECONDS (30)]
//   node scripts/local.mjs issue <issue> | deliver <issue> | post-review <pr> <findings.json>   (a session's route)
//   node scripts/local.mjs handover <issue> [--push] [--app ID]   (a person applies Factory's workflow hand-over: read it, then --push)
//   node scripts/local.mjs wait [<issue>...] [--since CURSOR] [--on KINDS] [--follow] [--interval S] [--timeout S]   (an orchestrator waits on the queue)
// Routing: an Objective labelled factory:local is the local loop's and the Actions path leaves it alone;
// serve takes only those unless --all (FACTORY_LOCAL_ALL=1). A claim comment with a heartbeat marks one in flight.
// Needs git, gh, the harness CLI (claude or codex logged in; copilot with a Copilot Requests token in
// COPILOT_GITHUB_TOKEN or ~/.config/factory/copilot-token, plus slirp4netns and iptables on Linux), srt
// (npm i -g @anthropic-ai/sandbox-runtime), ripgrep and, on Linux and WSL2, bubblewrap and socat; and a
// fine-grained token for this one repository, in FACTORY_LOCAL_TOKEN or ~/.config/factory/tokens/<owner>/<name>
// (contents, issues and pull requests read and write; actions and variables read). That token is all the GitHub reach the
// model gets. No App needed (one in FACTORY_LOCAL_APP_ID posts the notices), no vendor, no API key; GitHub holds
// every piece of state, and the box holds one clone per Objective under <clone>/.factory/<issue>/. Factory's own setup, install and validation commands run in the
// same sandbox as the harness, since they run on a tree the model edited. A sandbox has no route to the box's
// services: with FACTORY_LOCAL_DB=1 every validation command runs through plugin/bin/factory-db, which starts a fresh
// Postgres inside the sandbox (init step: FACTORY_LOCAL_DB_INIT), and the task card tells the model to do the same.
import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { constants as osConstants, homedir, hostname, platform, tmpdir, uptime } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { dispatch } from "./dispatch.mjs";
import { OUTAGE, lostText, minutesText, probe as probeHost, serverDown, waitOutages } from "./lib/network.mjs";

/** The wait before serve resumes an Objective after its `pauses`th pause on GitHub's 5xx: 1, 2, 4… minutes, up to OUTAGE.serverResumeMaxMs. */
const serverWait = (pauses) => Math.min(OUTAGE.serverResumeMaxMs, OUTAGE.serverResumeMs * 2 ** Math.max(0, pauses - 1));
import { PLUGIN_ROOT } from "./lib/checkout.mjs";
import { activeWorkIssues, addLabels, collaboratorPermission, ensureLabel, hasMergeQueue, findPr, findProject, getIssue, getPr, getPrSettled, listComments, listIssuesByLabel, markReady, objectiveLabeledAt, moveCard, postReview, prComment, prDiff, primeSelf, primeWriters, removeLabel, repoOf, rest, setStateLabel, transientError, upsertComment, organizationVariableNames, repositoryVariables } from "./lib/github.mjs";
import { holdSecrets, input, log, logTo, postedError, readFlags, redactSecrets, resolveInputs, workflowDriftLines, workflowSettings, MACHINE_SETTINGS, MODEL_SETTINGS, ignoredLines, layerLines, machineSettings, organizationVariablesLine, settingLayers } from "./lib/inputs.mjs";
import { localSecretValues, parseSecretValues, parseWorkerSecrets } from "./lib/worker-secrets.mjs";
import { RELAY_SOCKET_DIR_ENV, dropSocketDir, handSocketDir, localRelayDir, readSocketDirRecord } from "./lib/worker-relay.mjs";
import { RELAYED_NAME } from "./lib/gateway-relay.mjs";
import { localCopilotRelayShim } from "./lib/relay-shim.mjs";
import { GROUP_RECORD, STOP_SIGNALS, exec, processRecord, reapRecorded, sameProcess, whichSync } from "./lib/proc.mjs";
import { HEARTBEAT_MS, parseClaim, LOCAL_DOMAINS, LOCAL_LABEL, isSandboxHost, claudeProjectLink, codexLocalConfig, credentialPaths, harnessLogins, ownLoginProblems, stageLogin, copilotHomeFiles, copilotLocalSettings, copilotPrivateTmp, dropClaim, dropClaudeProjectLink, ensureHarnessHomes, gitDirChanged, gitIdentityKey, gitIdentityReason, gitPinFile, pinGitDir, readGitPin, harnessInstall, writeNestedGitScan, gitGuardScript, harnessOuterSettings, outerProbe, sandboxDroppedHosts, gatewayKeyProblem, localApp, localBaseEnv, localClaim, LOCAL_TOKEN_PERMISSIONS, localToken, prepareClone, tokenFile, variablesRefusedLine, committedWorkflowEnv, committedWorkflowNow, readWorkflowEnv, staleGitLocks, stageTemp, sandboxStartProblems, srtSettings, stopHold, workflowEnv, writeBwrapTun, writeClaim } from "./lib/local.mjs";
import { REVIEW_LABEL, acceptanceEntries, clip, decideExit, parseReview, planAskedOf, protectedPaths, questionCheckPrompt, reviewOfValue, selfLogin, staleDecision, marker } from "./lib/logic.mjs";
import { HANDOVER_WRITERS, MAX_PARTS, currentPlan, exitFromOut, handoverChecker, handoverOnIssue, inFiles, isSplitPart, nextPart, partsRecord, planSync, postNote, postReplies, publishPr, readOut, recordPart, reviewMissed, reviewPost } from "./lib/handoff.mjs";
import { applyExit, commitAuthor, gitIdentity, mergeBlockCause, mergeBlockReason, mergeReadyOne, queueBoundMs, mirrorDiff, objectiveDecisions, progressReporter, rebaseMarkers, rebaseNotice, rebaseBlock, unaddressedReviewComments } from "./lib/session.mjs";
import { checkHandover, openOutbox, scratchHistory } from "./lib/outbox.mjs";
import { HANDOVER_LABEL, WORKFLOWS_DIR, handoverBranch, handoverMarker, handoverOf, workflowName } from "./lib/handover.mjs";
import { appendOwn, dropOwned, privateTmp } from "./lib/fsafe.mjs";
import { git as gitIn } from "./lib/proc.mjs";
import { BACKENDS } from "./lib/backend.mjs";
import { scrubbedEnv } from "./lib/harness.mjs";
import { choiceOf } from "./lib/choice.mjs";
import { bwrapShim, claudeEnvText, localTools } from "./lib/copilot-runner.mjs";
import { noticeMinter, serveNotices } from "./lib/app-token.mjs";
import { answeredRepos, declaredQuestion, planNeeds as planNeedsOf } from "./lib/one-repo.mjs";
import { localDatabaseChecks, noticeAppCheck, pluginVersionCheck } from "./doctor.mjs";
import { RELEASES_URL, checkoutProblem, markInUse, pinDecision, releaseCheckout, runningFactory, runningName, startProblem } from "./lib/release.mjs";
import { SKIP_SMUDGE_ENV, lfsPinEnv } from "./lib/lfs.mjs";
import { EDITED_REASON, authorGate, foundationTrusted, labelsVouched, objectiveInputs, planStateNow, settled, startedAt, trustedIssue } from "./lib/objective-trust.mjs";
import { DRAFT_LABEL, isDraft, stopCause } from "./lib/stop.mjs";
import { loopCap, machineBudget, machineRoom, readPressure, slotHolders, slotsDir, takeSlot } from "./lib/machine.mjs";
import { THIRD_PARTY_POLL_MS, waitOf, waitState } from "./lib/third-party-review.mjs";
import { reviewNow, reviewWaitOf } from "./lib/overlap.mjs";
import { runningStint, timelineOf } from "./lib/relaunch.mjs";
import { AUTO_ACCOUNT_ENV, HARNESS_NAMES, STAGE_AUTO_ENV, accountEnv, accountLabels, accountPin, accountReason, accountToken, autoAccountSetting, chooseAccount, defaultAccount, harnessAccounts, implicitAccount, loadAccounts, pinLabelText, pinnedAccount, sandboxRoots, validAccountName } from "./lib/accounts.mjs";
import { lastStage } from "./lib/continue.mjs";
import { accountHolds, holdsDir, windowOf } from "./lib/holds.mjs";
import { personHolds, releaseRouteHold } from "./lib/route-holds.mjs";
import { WAIT_KINDS, WAIT_POLL_MS, WAIT_TIMEOUT_EXIT, jsonLine, parseCursor, parseKinds, waitQueue } from "./lib/wait.mjs";

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
const onPath = (bin) => whichSync(bin) !== null;
/** An account's key in the readiness checks (Local.harnessReady, Local.accountReady): its harness, name and login. */
const readyKey = (a) => `${a.harness}:${a.name}:${a.home || a.tokenFile || ""}`;
/** How long automatic account choice passes over an account whose harness checks failed before it checks it again. */
export const UNREADY_RETRY_MS = 10 * 60_000;
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
      ? `Free now: ${free.map((n) => `\`${n}\``).join(", ")}. This machine chooses accounts by itself, so \`factory serve\` here resumes this Objective on a free one at its next tick, with no label; a \`factory:account:<name>\` label still pins it to one account.`
      : `No other ${h} account on this machine is free now. This machine chooses accounts by itself, so \`factory serve\` here resumes this Objective on the first ${h} account that comes free.`
    : free.length
      ? `Free now: ${free.map((n) => `\`${n}\` (apply \`factory:account:${n}\`)`).join(", ")}. Applying one moves this Objective to that account: \`factory serve\` on this machine starts its stage there at once, and every later stage runs there while the label stays.`
      : `No other ${h} account on this machine is free now.`;
  const head = guessed
    ? free.length
      ? `Factory: the ${stage} stage paused on a usage limit. ${who} reached its limit with no reset reported, and is passed over until about ${new Date(reset).toISOString()}, an estimate.`
      : `Factory: the ${stage} stage paused on a usage limit. Every ${h} account on this machine is held; ${who} reached its limit with no reset reported, and is passed over until about ${new Date(reset).toISOString()}, an estimate. Factory resumes this Objective on this machine then, or sooner on an account that comes free.`
    : `Factory: the ${stage} stage paused on a usage limit. ${who} reached it${named ? ` (window \`${named}\`)` : " (its window was not reported)"}, which resets at ${new Date(reset).toISOString()}; Factory resumes this Objective on this machine after then.`;
  return [head, "", moves, ...(note ? ["", note] : [])].join("\n");
}

/**
 * How often a loop writes again the claim of an Objective it holds paused (Local.beatPaused): well inside the dispatcher's
 * day for a claim gone quiet (lib/local.mjs CLAIM_PAUSE_MS), at one write an hour (the API quota is shared).
 */
export const PAUSED_BEAT_MS = 60 * 60_000;

/** The line for an Objective with more than one account label (#265): it moves nowhere and waits. */
const twoPinsLine = (labels) => `${labels.map(pinLabelText).join(", ")}: more than one account label moves nothing, so the Objective waits, on no account, until one is left`;

/** What a Blocked notice tells a person to do about an account label this machine cannot act on (#265). */
const PIN_FIX = "Apply one `factory:account:<name>` naming an account of this Objective's harness that this machine declares (~/.config/factory/accounts.json; doctor.mjs --local lists them), as a person who can push, or remove the label to run on the harness's default account; then re-apply `factory:objective`.";
/** Whether a stage's result.json shows a pass its provider served (output or credits), with no usage limit ending it. */
/** A usage limit or quota that Blocked it with no reset reported (`limitRefused`) is a refusal too, never a served pass. */
const servedPass = (r) => !r.usageLimit && !r.limitRefused && [r.tokens?.output, r.aiCredits, r.premiumRequests].some((v) => Number(v) > 0);
/** A pinned release serve could not fetch or start is tried again after this long (followPin). */
export const PIN_RETRY_MS = 10 * 60_000;
/** The least time between two switches to a new pinned release (followPin), so a pin that keeps moving cannot hold the loop. */
export const SWITCH_GAP_MS = 30 * 60_000;
/** The env name a serve that started again on a new release (restartOn) learns when it last switched from. */
const SWITCHED_ENV = "FACTORY_SERVE_SWITCHED_AT";
/** The env name that tells a serve started again on a new release where it came from, for a failure at its start (main). */
const SWITCHED_FROM_ENV = "FACTORY_SERVE_SWITCHED_FROM";
const SWITCHED_FROM = process.env[SWITCHED_FROM_ENV] || "";
delete process.env[SWITCHED_FROM_ENV];
/** The first wait before the start's read of the repository's variables is tried again (Local.startVariables). */
export const START_VARIABLES_MS = 15_000;
/** How often a running serve fetches the default branch's workflow (refreshSettings); every tick uses the last read. */
export const SETTINGS_EVERY_MS = 3 * 60_000;

/** The harnesses this process has said run without the outer sandbox. */
const OUTER_SAID = new Set();
/** After a failed start, this loop holds the Objective this long, doubling per failure up to the cap (Local.unstart). */
export const START_BACKOFF_MS = 5 * 60_000;
export const START_BACKOFF_MAX_MS = 60 * 60_000;
/** The failed starts in a row of one Objective on one loop that Block it, with the error, rather than un-mark it again. */
export const START_FAILURES_BLOCK = 3;
export const COPILOT_OUTER_OFF = "local mode runs Copilot only inside the outer sandbox, which does not start on this host";
/** The Blocked reason when Copilot's outer sandbox stopped starting after serve began: fixed text, no probe output. */
export const copilotOuterReason = "local mode: Copilot runs locally only inside the outer sandbox, which no longer starts on this machine (outer-sandbox); the local loop's log says why; run the Objective with FACTORY_HARNESS=claude or codex, or on the Action";
/** The Blocked reason when the sandboxes' scan for protected paths fails its check at a stage's start (lib/local.mjs writeNestedGitScan). */
export const loginLinkReason = "local mode: a login file of the harness login this stage runs on links into another harness login on this machine (login-link), which the stage's harness would then read; the local loop's log names the path; make that login's files its own";
/** The Blocked reason when a harness-state path Factory makes before a stage leads where it may not make it (lib/local.mjs homePlaces). */
export const homeLinkReason = "local mode: a path Factory makes in the harness's state folder before each stage leads, through a link, outside the folders this stage's login may write or into a login or credential store, passes a file or a loop of links, or is a file where the harness keeps a folder (home-link); the local loop's log names the path; create it yourself or remove the link";
export const sandboxScanReason = "local mode: the sandboxes' scan for protected paths (ripgrep, sandbox-scan) failed its check on this machine; the local loop's log says why; check that `rg` on PATH runs";
const list = (v) => String(v || "").split(/[\s,]+/).filter(Boolean);

/**
 * Each command's arguments and flags: a flag is `bool` (takes no value), or takes one value named as usage shows it, a
 * positive number where `number` is set. An argument named `issue` or `pr` is a positive whole number.
 */
const WHERE = { repo: { value: "OWNER/NAME" }, checkout: { value: "CLONE" } };
export const COMMANDS = {
  run: { args: ["issue"], flags: { ...WHERE, wait: "bool" }, about: "one Objective, from the stage its state calls for (with --wait, to merged)" },
  serve: { args: [], flags: { ...WHERE, once: "bool", all: "bool", interval: { value: "SECONDS", number: true } }, about: "a loop: the dispatcher's rules every --interval seconds (30)" },
  review: { args: ["pr"], flags: { ...WHERE, wait: "bool" }, about: "a review re-run" },
  issue: { args: ["issue"], flags: { ...WHERE, out: { value: "PATH" } }, about: "the issue as a session reads it" },
  deliver: { args: ["issue"], flags: { ...WHERE, out: { value: "PATH" } }, about: "Factory's half of an Objective worked in a session" },
  "post-review": { args: ["pr", "findings.json"], flags: WHERE, about: "post a session's reviewer pass" },
  handover: { args: ["issue"], flags: { ...WHERE, push: "bool", app: { value: "ID", number: true } }, about: "put Factory's workflow hand-over on a new branch and show it, then stop for you to read it (--push: commit, push and open its pull request)" },
  wait: {
    args: [],
    more: "issue",
    flags: { ...WHERE, since: { value: "CURSOR" }, on: { value: "KINDS" }, follow: "bool", interval: { value: "SECONDS", number: true }, timeout: { value: "SECONDS", number: true } },
    check: (f) => (f.since !== undefined && !parseCursor(f.since) ? `--since needs a cursor a line printed or a time with its zone, not ${JSON.stringify(f.since)}` : f.on !== undefined && !parseKinds(f.on) ? `--on takes ${WAIT_KINDS.join(", ")}, not ${JSON.stringify(f.on)}` : null),
    about: `one JSON line per event on the queue (or the issues named): ${WAIT_KINDS.join(", ")}; exits 0 after the first, ${WAIT_TIMEOUT_EXIT} at --timeout (with --follow, keeps going)`,
  },
  hold: {
    args: ["list|release"],
    more: "account",
    flags: { repo: WHERE.repo },
    usage: "factory hold list [--repo OWNER/NAME] | factory hold release <account> [--repo OWNER/NAME]",
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
const usageOf = (cmd) => COMMANDS[cmd].usage ?? `factory ${cmd} ${[...COMMANDS[cmd].args.map((a) => `<${a}>`), ...(COMMANDS[cmd].more ? [`[<${COMMANDS[cmd].more}>...]`] : []), ...Object.entries(COMMANDS[cmd].flags).map(([k, t]) => `[--${k}${t === "bool" ? "" : ` ${t.value}`}]`)].join(" ")}`;
/** The usage text: one command's, or every command's. */
export const usage = (cmd = null) => (cmd ? `usage: ${usageOf(cmd)}\n  ${COMMANDS[cmd].about}\n` : `usage:\n${Object.keys(COMMANDS).map((c) => `  ${usageOf(c)}\n      ${COMMANDS[c].about}\n`).join("")}`);

/**
 * The command line, checked before anything runs: {help, cmd} for --help or -h anywhere, else {cmd, flags, _}. Throws an
 * error with `usage` set for an unknown command or flag, a flag's missing or non-numeric value, a value given to a flag
 * that takes none, or a missing, extra or non-numeric argument.
 */
export function parseArgs(argv) {
  const cmd = Object.hasOwn(COMMANDS, argv[0] ?? "") ? argv[0] : null;
  if (argv.some((a) => a === "--help" || a === "-h")) return { help: true, cmd };
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

/**
 * Who this machine is and which boot it is on, for claim holders: a host name alone is not unique (a devcontainer on
 * host networking, two laptops called the same), and a pid is only meaningful within one boot. Linux gives both ids;
 * elsewhere the machine is its host name and the boot its start minute.
 */
export function machineIdentity() {
  const machine = readId("/etc/machine-id") || readId("/var/lib/dbus/machine-id");
  const boot = readId("/proc/sys/kernel/random/boot_id") || String(Math.round((Date.now() / 1000 - uptime()) / 60));
  return { host: hostname(), machine, boot };
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
 * validation runs, how a session resumes and its cache, and whether hand-offs wait for siblings. One this shell sets (inputs.mjs machineSettings) keeps the
 * shell's value whatever the repository says. What a stage may reach or receive, spend, protect or be set up with, and
 * the harness, are taken only when serve starts.
 */
export const HOT_SETTINGS = ["FACTORY_MAX_CONCURRENT", "FACTORY_LOCAL_MAX_CONCURRENT", "FACTORY_MODEL", "FACTORY_SUBAGENT_MODEL", "FACTORY_REVIEWER_MODEL", "FACTORY_EFFORT", "FACTORY_REVIEWER_EFFORT", "FACTORY_VALIDATION", "FACTORY_LOCAL_VALIDATION", "FACTORY_RESUME_POLICY", "FACTORY_PROMPT_CACHE_TTL", "FACTORY_SIBLING_HOLD"];

/**
 * What changed between two sets of the repository's settings (settingLayers's values), one `NAME: old → new` each, in
 * name order, with the layer the new value comes from when `layers` (settingLayers's `from`) is given; one this shell
 * sets (inputs.mjs machineSettings: a FACTORY_LOCAL_* name, the harness, models and session settings) says that the
 * shell's value still wins, as in baseEnv. Values are the workflow's or a variable's own (no secret is ever one: `${{ }}`
 * values are not read), cut at 80 characters.
 */
export function settingsChanges(before = {}, after = {}, env = process.env, layers = null) {
  const shell = machineSettings(env);
  const show = (v) => (v === undefined ? "unset" : JSON.stringify(v.length > 80 ? `${v.slice(0, 77)}...` : v));
  const layer = (k) => (!layers ? "" : after[k] === undefined ? " (Factory's default)" : layers[k] === "variable" ? " (repository variable)" : " (workflow)");
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((k) => before[k] !== after[k])
    .sort()
    .map((k) => `${k}: ${show(before[k])} → ${show(after[k])}${layer(k)}${k in shell ? " (this shell sets it, and its value wins)" : ""}`);
}

/** OWNER/NAME from the clone's origin remote. */
export function repoFromRemote(url) {
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(\.git)?\/?$/.exec(url || "");
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * Why local mode cannot start here, one line each. `outer` is lib/local.mjs outerProbe: Copilot runs locally only inside
 * the outer sandbox, since its own sandbox applies its file policy only best-effort, so on a host where that does not
 * start (macOS, or Linux without what its sandbox's network needs) local Copilot is refused before any claim.
 * `wf` is the workflow's settings and `env` this shell's, which wins (as in baseEnv); `os` is the platform; `account` the
 * one the loop starts on (lib/accounts.mjs), whose probe result outerProbe keeps apart from every other account's.
 */
export function preflight(harness, repoFull, token, copilotToken, { outer = outerProbe, wf = {}, env = process.env, os = platform(), account = null } = {}) {
  const problems = [];
  for (const bin of ["git", "gh"]) if (!onPath(bin)) problems.push(`${bin} is not on PATH`);
  if (!onPath("srt")) problems.push("srt is not on PATH; Factory's own commands run in it (npm i -g @anthropic-ai/sandbox-runtime)");
  if (!onPath("rg")) problems.push("rg (ripgrep) is not on PATH; the sandbox needs it");
  if (platform() === "linux") for (const bin of ["bwrap", "socat"]) if (!onPath(bin)) problems.push(`${bin} is not on PATH; the sandbox needs it (sudo apt-get install -y bubblewrap socat)`);
  const startProblems = platform() === "linux" && onPath("srt") && onPath("bwrap") ? sandboxStartProblems() : [];
  problems.push(...startProblems);
  if (platform() === "win32") problems.push("native Windows has no sandbox for the harness; run local mode inside WSL2");
  // macOS's sandbox has no network namespace of its own: a throwaway Postgres there would listen on the box's loopback.
  // Whichever source set it: the shell's value, else the workflow's (baseEnv), which every stage then runs with.
  if (os === "darwin" && (env.FACTORY_LOCAL_DB ?? wf.FACTORY_LOCAL_DB ?? "") === "1") problems.push("FACTORY_LOCAL_DB runs on Linux and WSL2 only: macOS's sandbox shares the box's loopback, so a throwaway database would be reachable from outside it");
  problems.push(...harnessProblems(harness, copilotToken, { outer, sandboxStarts: !startProblems.length, account, env: account ? accountEnv(env, account) : env }));
  if (!token) problems.push(`no token for ${repoFull}: create a fine-grained token for this one repository (${LOCAL_TOKEN_PERMISSIONS}) and save it to ${tokenFile(repoFull)} (chmod 600) or export FACTORY_LOCAL_TOKEN`);
  return problems;
}

/**
 * Why one harness cannot run here, one line each: the loop's own at its start (preflight), and another an Objective's
 * harness label names before its first stage on this machine (Local.harnessFor). `sandboxStarts`: whether srt's sandbox
 * starts here (preflight's own check), without which Copilot's outer sandbox is not probed. `account`: the one the
 * harness runs on, for outerProbe; `env` that account's (lib/accounts.mjs accountEnv), which the probe runs on.
 */
export function harnessProblems(harness, copilotToken, { outer = outerProbe, sandboxStarts = true, account = null, env: given = process.env } = {}) {
  const problems = [];
  if (!["claude", "codex", "copilot"].includes(harness)) return [`unknown harness ${harness}`];
  if (!onPath(harness)) problems.push(`${harness} is not on PATH`);
  if (harness === "copilot") {
    // Copilot's sandbox reads its policy from its own home, so the developer's `copilot login` is not used there.
    if (!copilotToken) problems.push(`no Copilot token: create a fine-grained token with the Copilot Requests permission and save it to ${copilotTokenFile()} (chmod 600) or export COPILOT_GITHUB_TOKEN`);
    // Without these Copilot's sandbox cannot start, and every command fails while the run still exits 0.
    if (platform() === "linux") for (const bin of ["slirp4netns", "iptables", "iptables-restore", "ip6tables", "ip6tables-restore"]) if (!onPath(bin)) problems.push(`${bin} is not on PATH; Copilot's sandbox needs it (sudo apt-get install -y slirp4netns iptables)`);
    // Probed only where it can start at all; off Linux outerProbe answers without starting anything.
    if (platform() !== "linux" || (["srt", "bwrap", "copilot"].every(onPath) && sandboxStarts)) {
      // Without the developer's own COPILOT_HOME: the probe makes and seeds the home it is given, and Factory leaves theirs alone.
      const { COPILOT_HOME: _own, ...env } = given;
      const o = outer("copilot", { env, account });
      if (!o.on) problems.push(`${COPILOT_OUTER_OFF}: ${o.why}; use FACTORY_HARNESS=claude or codex locally, or run Copilot Objectives on the Action${o.cacheFile ? ` (a yes is kept in ${o.cacheFile})` : ""}`);
    }
  }
  return problems;
}

export const copilotTokenFile = (home = homedir()) => join(home, ".config", "factory", "copilot-token");
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
const HOST_ONLY = ["FACTORY_LOCAL_TOKEN", "FACTORY_LOCAL_APP_ID", "FACTORY_LOCAL_APP_KEY", AUTO_ACCOUNT_ENV];

/** How often serve tries a refused local token again (a 401 GitHub gave for a moment); tests lower it. */
export const REFUSED_PROBE = { ms: 60_000 };

/** Where the local token comes from, to name in a log line: the variable or the file, never the value. */
const tokenSource = (repoFull) => (process.env.FACTORY_LOCAL_TOKEN ? "FACTORY_LOCAL_TOKEN (then start serve again)" : tokenFile(repoFull));

/**
 * The token can write to this repository and nothing else. A fine-grained token lists every public repository it
 * may read, and the listed permissions are the person's, not the token's, so write reach is probed instead: an
 * issue with no title is refused before anything is created, with 422 where the token may write and 403 or 404
 * where it may not.
 */
async function checkToken(repoFull, token) {
  if (!token.startsWith("github_pat_")) throw new Error("the local token must be a fine-grained token limited to this repository; a classic token or a gh login reaches every repository you can");
  const reach = (await rest("user/repos?per_page=100", { token, paginate: true }).catch(() => [])) || [];
  const others = reach.map((r) => r.full_name).filter((n) => n.toLowerCase() !== repoFull.toLowerCase()).slice(0, 20);
  const writable = [];
  for (const name of others) {
    const status = await rest(`repos/${name}/issues`, { token, method: "POST", body: {} }).then(() => 201, (e) => e.status || 0);
    if (status === 422 || status === 201) writable.push(name);
  }
  if (writable.length) throw new Error(`the local token can write to ${writable.length} other repositor${writable.length === 1 ? "y" : "ies"} (${writable.slice(0, 3).join(", ")}${writable.length > 3 ? ", ..." : ""}); limit it to ${repoFull}`);
}

/** The issue a PR is a review trigger for: on factory/<issue>, labelled factory:review, not a draft; else 0. */
export const reviewIssue = (pr) => (pr?.draft || !(pr?.labels || []).some((l) => l.name === REVIEW_LABEL) ? 0 : Number(/^factory\/(\d+)$/.exec(pr?.head?.ref || "")?.[1]) || 0);
/**
 * The issue a PR may be an answered Question's review cue for (#339): on factory/<issue>, open, out of draft and not
 * labelled for review (that is reviewIssue's); else 0. pendingReviews checks the issue is a Question and a ready mark.
 */
export const readyIssue = (pr) => (!pr || pr.draft || pr.state === "closed" || labelled(pr, REVIEW_LABEL) ? 0 : Number(/^factory\/(\d+)$/.exec(pr.head?.ref || "")?.[1]) || 0);
/**
 * Whether the PR was marked ready after the issue last became a Question (`askedAt`, its last factory:question label):
 * a Question's exit drafts the PR before it labels the issue, so a PR GitHub kept out of draft then has no mark after it.
 */
export const readyAfter = (prEvents, askedAt) => !!askedAt && (prEvents || []).some((e) => e?.event === "ready_for_review" && Date.parse(e.created_at) > Date.parse(askedAt));
/** An issue labelled factory:blocked. */
export const isBlocked = (issue) => (issue?.labels || []).some((l) => (typeof l === "string" ? l : l.name) === "factory:blocked");
const labelled = (item, name) => (item?.labels || []).some((l) => (typeof l === "string" ? l : l.name) === name);

/**
 * The stage an Objective's state calls for when a loop takes it up (serve's resume, `factory run`): "review" for its open,
 * non-draft PR labelled for review; "work" while the issue is Running; "merge" while it is In review with an open,
 * non-draft PR (reviewed, waiting for its merge); else null. `pr` is the open PR on factory/<issue>, or null.
 */
export function stageFor({ pr, issue }) {
  const open = pr && pr.state !== "closed" && !pr.draft;
  if (open && labelled(pr, REVIEW_LABEL)) return "review";
  if (labelled(issue, "factory:running")) return "work";
  if (open && labelled(issue, "factory:in-review")) return "merge";
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
    : `#${issue}: ${live.file} names pid ${live.pid} as a running stage of this Objective, and this machine cannot tell whether it still is; if pid ${live.pid} is no Factory worker, delete that file`;

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

/** The start's line when this plugin, which runs every stage here, is older than the release the committed workflow pins; else null. */
export function pluginLine(committed) {
  const c = committed?.text ? pluginVersionCheck(committed.text) : null;
  return c?.status === "WARN" ? `${c.detail}; ${c.fix}` : null;
}

export class Local {
  constructor(flags) {
    // This process is the local backend: the dispatcher it runs in-process routes factory:local Objectives here.
    process.env.FACTORY_LOCAL = "1";
    if (flags.all) process.env.FACTORY_LOCAL_ALL = "1";
    // Canonical, so every sandbox path derived from it is real (lib/local.mjs refuses one that resolves elsewhere).
    this.dev = realpathSync(sh("git", ["-C", resolve(flags.checkout || process.cwd()), "rev-parse", "--show-toplevel"]));
    this.repoFull = flags.repo || repoFromRemote(sh("git", ["-C", this.dev, "remote", "get-url", "origin"]));
    if (!this.repoFull) throw new Error("no GitHub origin remote; pass --repo OWNER/NAME");
    this.repo = repoOf(this.repoFull);
    // The workflow's settings as committed on the default branch (#122), never this working tree's, whatever branch is
    // checked out: as the Action runs the reviewed workflow. A working tree that differs is named (doctor too).
    const committed = committedWorkflowEnv(this.dev);
    // serve reads the default branch's workflow again at each tick (refreshSettings), and follows its Factory pin (followPin).
    this.settingsBranch = committed.branch;
    this.pins = committed.pins || [];
    if (committed.error) log(`local mode reads its settings from the default branch's .github/workflows/factory.yml: ${committed.error}, so it uses none`);
    for (const line of workflowDriftLines(readWorkflowEnv(this.dev), committed)) log(line);
    const plugin = pluginLine(committed);
    if (plugin) log(plugin);
    // The workflow file is repository content: only its settings reach a stage, never a name Factory reads as its own
    // control (#119). Every other FACTORY_* name in it is dropped and named here (doctor warns too).
    const wf = workflowSettings(committed.wf);
    if (wf.dropped.length) log(`.github/workflows/factory.yml: ${wf.dropped.join(", ")} ${wf.dropped.length === 1 ? "is" : "are"} no Factory setting; left out of every stage`);
    this.workflowWf = wf.kept;
    this.wf = wf.kept;
    this.token = localToken(this.repoFull);
  }

  /**
   * The settings this loop starts with (#284): the workflow's, under the repository's variables (readVariables, read just
   * before), each named with its layer, this machine's own over both; then what they decide: the harness and its account,
   * what must hold before anything starts, and the App that posts the notices.
   */
  takeSettings() {
    this.startSettings();
    this.harness = (process.env.FACTORY_HARNESS || this.wf.FACTORY_HARNESS || "claude").toLowerCase();
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
    const problems = accounts.ok ? [] : accounts.problems.map((p) => `account ${p.account} (~/.config/factory/accounts.json): ${p.why}`);
    problems.push(...preflight(this.harness, this.repoFull, this.token, this.copilotToken, { wf: this.wf, account: this.startAccount }));
    // The Factory App, when configured, posts the notices (#2522). Its key stays in this process: a stage asks for a
    // notice token over its IPC channel (stage()), and nothing else, env or file, carries the key or the token.
    const startEnv = accountEnv(process.env, this.startAccount);
    const { app, problem } = localApp(startEnv, homedir(), this.harness);
    if (problem) problems.push(problem);
    const gateway = gatewayKeyProblem(startEnv, homedir(), this.harness);
    if (gateway) problems.push(gateway);
    if (problems.length) throw new Error(`local mode cannot start:\n- ${problems.join("\n- ")}`);
    this.notice = app ? noticeMinter({ appId: app.id, privateKey: app.key, owner: this.repo.owner, repo: this.repo.name }) : null;
    this.opts = { token: this.token, notice: this.notice };
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

  /**
   * The repository's settings this loop starts with: the workflow's, the repository's variables over them (`variables`,
   * readVariables's), each setting named once with its layer, this machine's own included, and each variable ignored.
   */
  startSettings() {
    const layers = settingLayers({ workflow: this.workflowWf, variables: this.variables || {} });
    this.wf = layers.values;
    this.from = layers.from;
    this.ignoredKey = ignoredLines(layers).join("\n");
    log(`settings, each over the one below (Factory's defaults, the workflow${this.settingsBranch ? ` on origin/${this.settingsBranch}` : ""}, the repository's variables, this machine):`);
    for (const line of layerLines(settingLayers({ workflow: this.workflowWf, variables: this.variables || {}, machine: machineSettings(process.env) }))) log(`  ${line}`);
  }

  /** The settings (takeSettings, after the repository's variables), the token check and the routing label. */
  async init({ serve = false } = {}) {
    await this.startVariables({ serve });
    this.takeSettings();
    await checkToken(this.repoFull, this.token);
    if (this.notice) {
      const minted = await this.notice().catch((e) => {
        throw new Error(`local mode cannot start: the Factory App (FACTORY_LOCAL_APP_ID ${process.env.FACTORY_LOCAL_APP_ID}) gave no token for ${this.repoFull}: ${e.message.slice(0, 200)}; check the id, the key, and that the App is installed on this repository`);
      });
      log(`notices post as ${minted.appSlug}[bot]`);
      const c = noticeAppCheck(minted);
      log(`${c.status} ${c.name}: ${c.detail}`);
    }
    // Before any run: a repository that uses Postgres needs FACTORY_LOCAL_DB=1 here, or its database commands fail (#2601).
    for (const c of localDatabaseChecks({ checkout: this.dev, env: process.env, wf: this.wf })) log(`${c.status} ${c.name}: ${c.detail}${c.status !== "PASS" ? ` — fix: ${c.fix}` : ""}`);
    this.codexSelfTest(this.harness, accountEnv(process.env, this.startAccount));
    await ensureLabel(this.repo, LOCAL_LABEL, "0e8a16", "Factory: run this Objective in a developer's local loop, not on Actions", this.opts).catch((e) => log(`label ${LOCAL_LABEL}: ${e.message.slice(0, 120)}`));
    return this;
  }

  /**
   * Codex reports success even when its sandbox cannot start (the command just never runs), so a local Codex loop
   * first runs one command under the same profile, which must run and must fail to write the home directory.
   */
  codexSelfTest(harness = this.harness, env = process.env) {
    if (harness !== "codex") return;
    const probe = 'f="$HOME/.factory-sandbox-check"; if touch "$f" 2>/dev/null; then rm -f "$f"; exit 9; fi';
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
   * `factory:account:<name>` label pins it to (pinFor, #265; its labeler read afresh at each stage start), else its
   * harness's default (accountFor). A pin this machine cannot act on (an untrusted labeler, a name no account of its
   * harness has) Blocks; two pins start nothing ({ok: false, wait}: the Objective waits, never Blocked). With automatic
   * account choice on (#266) and no pin, the account is chosen (autoAccount, `auto`) among those ready here, preferring
   * the one the Objective's last stage here paused on (pausedOn; `own`, this stage's usage directory, is not that stage);
   * with none of its harness's accounts ready, it Blocks naming them.
   * {ok, harness, hosts, account, pinned, pin, auto} or {ok: false, reason, fix} or {ok: false, wait}.
   */
  async harnessFor(issue, { own = null } = {}) {
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
        const pick = this.autoAccount(harness, { prefer: this.pausedOn(issue, own), pick: true });
        if (pick.account) [account, auto] = [pick.account, true];
        else unready = pick.unready;
      }
    } catch (e) {
      // Only a declaration that cannot be used Blocks, with its fixed reason; any other failure is Factory's own.
      if (e?.code !== "account" || typeof e.reason !== "string") throw e;
      log(`#${issue}: refusing to run: ${e.message}`);
      return { ok: false, reason: e.reason, fix: "Fix those accounts in ~/.config/factory/accounts.json on this machine (doctor.mjs --local names what is wrong with each), then re-apply `factory:objective`." };
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
      return { ok: false, reason: `local mode on this machine cannot run ${h} on any of its accounts (${unready.map((u) => `\`${u.name}\``).join(", ")}); the loop's log names what is missing for each`, fix: "Set those accounts' logins up on this machine (doctor.mjs --local checks each), then re-apply `factory:objective`." };
    }
    if (pin.account) account = pin.account;
    const problems = this.harnessReady(harness, account);
    if (!problems.length) return { ok: true, harness, hosts: chosen.hosts, account, ...(pin.account ? { pinned: true, pin: pin.label } : {}), ...(auto ? { auto } : {}) };
    // What is missing stays in this machine's log: a path or a probe's output never reaches GitHub (block()).
    log(`#${issue}: ${harness} cannot run here: ${problems.join("; ")}`);
    return { ok: false, reason: `local mode on this machine cannot run ${harness}, which this Objective's harness label asks for; the loop's log names what is missing`, fix: "Set that harness up on this machine (doctor.mjs --local with FACTORY_HARNESS set to it names what is missing) and re-apply `factory:objective`, or run the Objective where that harness is set up." };
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
   * chooseAccount): a free one (no hold, limitUntil), `prefer` first when it is free, else the one limited least recently,
   * then the one started on least recently (the machine's round-robin, kept with the holds, and this loop's picks of the
   * last PICK_MS, whose stages are still starting); with every one held, the one whose hold ends first. Held includes a
   * no-reset limit's guess (holds.mjs spent). Of those, the first that is ready here (accountReady); one that is not is
   * passed over. `pick`: a stage starts on it, so this loop counts it as just started meanwhile. {account, unready:
   * [{name, problems}]}, account null when none is ready. Throws as accountFor.
   */
  autoAccount(harness, { prefer = null, pick = false } = {}) {
    const now = (this.clock ?? Date.now)();
    const list = harnessAccounts(this.loadedAccounts(), harness);
    const holds = new Map(list.map((a) => [a, this.holdOf(a)]));
    const picked = (key) => (this.picked?.get(key) > now - PICK_MS ? this.picked.get(key) : -Infinity);
    const opts = {
      until: (a) => this.limitUntil(holds.get(a), { guess: true }),
      limitedAt: (a) => this.holdStore(holds.get(a)).limitedAt(holds.get(a).key, now),
      startedAt: (a) => Math.max(this.holdStore(holds.get(a)).startedAt(holds.get(a).key, now) ?? -Infinity, picked(holds.get(a).key)),
      prefer,
    };
    const left = [...list];
    const unready = [];
    while (left.length) {
      const a = chooseAccount(left, opts);
      const problems = this.accountReady(harness, a);
      if (!problems.length) {
        if (pick) (this.picked ??= new Map()).set(holds.get(a).key, now);
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
    this.picked?.delete(hold.key);
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

  /** This machine's account declaration, read and checked afresh (loadAccounts); throws as accountFor says. */
  loadedAccounts() {
    const loaded = loadAccounts({ home: homedir(), env: process.env, roots: sandboxRoots(this.dev) });
    if (loaded.ok) return loaded;
    const why = loaded.problems.map((p) => `account ${p.account}: ${p.why}`).join("; ");
    throw Object.assign(new Error(`this machine's account declaration cannot be used: ${why}`), { code: "account", reason: accountReason(loaded.problems) });
  }

  /**
   * The account an Objective's `factory:account:<name>` label pins its `harness` stages to (#265), from `names`, the
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
   * Why Factory does not act on account label `label` on `issue` (objective-trust.mjs labelsVouched: its latest
   * labeler, or with `event` "unlabeled" its latest remover, cannot push and is no pinned maintainer), or null. With `at`
   * (the issue's `updated_at` as a listing read it) the answer is kept for that label, event and `at`: any change to the
   * issue's labels moves `at`, so a label removed and applied again is read afresh. With no `at`, always read. A read
   * that fails is not kept, and throws.
   */
  async pinTrust(issue, label, at = null, event = "labeled") {
    const key = `${event}:${label}@${at}`;
    const seen = at ? this.pinTrusts?.get(issue) : null;
    if (seen?.key === key) return seen.refused;
    const refused = await labelsVouched(this.repo, issue, [label], this.opts, {}, event === "labeled" ? "Factory does not move the Objective to that account" : "Factory does not move the Objective off that account", event);
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
    await upsertComment(this.repo, issue, marker(issue, "account-limit"), `Factory: ${line}.`, this.opts).catch((e) => log(`#${issue}: the account note could not be written (${String(e?.message || e).slice(0, 120)})`));
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

  /** <clone>/.factory/ never shows up in the developer's git status. */
  excludeWorkspaces() {
    const file = resolve(this.dev, sh("git", ["-C", this.dev, "rev-parse", "--git-path", "info/exclude"]));
    const current = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (!current.split("\n").includes("/.factory/")) appendFileSync(file, `${current && !current.endsWith("\n") ? "\n" : ""}/.factory/\n`);
  }

  ws(issue) {
    return join(this.dev, ".factory", String(issue));
  }

  /** The Objective label this repository's workflow names (factory:objective by default). */
  objectiveLabel() {
    return resolveInputs({ args: { repo: this.repoFull }, env: this.baseEnv() }).objectiveLabel;
  }

  /**
   * The hosts this machine's sandboxes allow: LOCAL_DOMAINS and FACTORY_LOCAL_DOMAINS for every Objective, plus `hosts`,
   * those one Objective's approved host labels open for its own stage (harnessFor), never another's.
   */
  domains(hosts = []) {
    return [...new Set([...LOCAL_DOMAINS, ...list(process.env.FACTORY_LOCAL_DOMAINS || this.wf.FACTORY_LOCAL_DOMAINS), ...hosts.filter(isSandboxHost)])];
  }

  /** One clone per Objective, kept between stages so the dependencies and the transcript wait for the next one. Cloned without blocking heartbeats. */
  async ensureClone(issue) {
    const dir = join(this.ws(issue), "repo");
    const pin = gitPinFile(this.ws(issue));
    if (existsSync(join(dir, ".git"))) {
      if (readGitPin(pin)) return dir;
      // A clone made before Factory pinned its .git cannot be trusted to hold the .git it cloned: made afresh.
      log(`#${issue}: the clone has no pinned .git identity; cloning it again`);
      rmSync(dir, { recursive: true, force: true });
    }
    mkdirSync(this.ws(issue), { recursive: true });
    const started = Date.now();
    const helper = "!f() { echo username=x-access-token; echo \"password=$FACTORY_LOCAL_TOKEN\"; }; f";
    const code = await new Promise((done) => {
      // The token goes to https://github.com only (the empty entry clears every inherited helper, for any host).
      const child = spawn("git", ["-c", "credential.helper=", "-c", `credential.https://github.com.helper=${helper}`, "clone", "-q", "--reference-if-able", this.dev, "--dissociate", `https://github.com/${this.repoFull}.git`, dir], { env: { ...localBaseEnv(process.env), FACTORY_LOCAL_TOKEN: this.token, ...SKIP_SMUDGE_ENV }, stdio: ["ignore", "inherit", "inherit"] });
      child.on("close", done);
    });
    if (code !== 0) throw new Error(`git clone of ${this.repoFull} failed (exit ${code})`);
    pinGitDir(dir, pin);
    // The Objective's first stage on this machine pays for this clone and a cold install: reported apart (worker.mjs).
    this.firstSetup.set(issue, Date.now() - started);
    return dir;
  }

  /** The env every child starts from: an allow-list plus the repository's FACTORY_* settings, never the whole shell. */
  baseEnv() {
    const wf = { ...this.wf };
    // Host-only settings stay out of a stage's env from the workflow too, not only from this shell.
    for (const k of HOST_ONLY) delete wf[k];
    // The workflow's models belong to its harness: a developer who picks another one locally gets that one's defaults.
    if ((wf.FACTORY_HARNESS || "claude").toLowerCase() !== this.harness) for (const k of MODEL_SETTINGS) delete wf[k];
    // The developer's own harness, model and session settings win over the repository's (inputs.mjs MACHINE_SETTINGS).
    for (const k of MACHINE_SETTINGS) if (k !== "FACTORY_HARNESS" && process.env[k]) wf[k] = process.env[k];
    // A worker secret's NAME or SOURCE never joins every stage's env through FACTORY_LOCAL_ENV (lib/local.mjs localBaseEnv).
    const env = { ...localBaseEnv(process.env, list(process.env.FACTORY_LOCAL_ENV || this.wf.FACTORY_LOCAL_ENV), { workerSecrets: wf.FACTORY_WORKER_SECRETS || "" }), ...wf };
    // The developer's own FACTORY_LOCAL_* settings win over the workflow's.
    for (const [k, v] of Object.entries(process.env)) if (k.startsWith("FACTORY_LOCAL_") && !HOST_ONLY.includes(k)) env[k] = v;
    return { ...env, FACTORY_HARNESS: this.harness, FACTORY_LOCAL: "1", FACTORY_LOCAL_ALL: process.env.FACTORY_LOCAL_ALL || "" };
  }

  /**
   * One stage's env: the base, the scoped token, and the sandbox both the harness and Factory's own commands run in.
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
    // The caches outside the clone are Factory's; the two inside it, and srt's protected paths, are made in the clone's
    // own sandbox before the stage starts (stage(): prepareClone), never by this process.
    for (const d of caches) mkdirSync(d, { recursive: true });
    // The settings Factory's own commands run under sit outside every writable directory: in the usage directory
    // the model could loosen the sandbox its own validation runs in.
    const sandboxDir = join(ws, ".sandbox");
    mkdirSync(sandboxDir, { recursive: true });
    const srtFile = join(sandboxDir, `srt-${basename(usageDir)}.json`);
    // The stage's usage directory is Factory's (its record, the event log, the transcript copy): every sandbox may read
    // it (factory-db is in its bin), none may write it.
    // Linux: the ripgrep srt and Claude Code's sandbox scan with, which leaves a nested checkout's .git writable, so a resumed
    // stage can replace one (lib/local.mjs nestedGitScanScript). In the usage directory, which no sandbox may write: srt and
    // Claude Code run it outside their sandboxes. Checked as it is written; a failed check Blocks (sandboxScanReason).
    // An rg in or linked into a directory a sandbox may write is refused (the stage Blocks).
    const ripgrep = platform() === "linux" ? writeNestedGitScan(join(usageDir, "scan"), undefined, { writable: [clone, ...caches, stageTmp, join(usageDir, "harness")] }) : null;
    // Every harness login on this machine, the one this stage runs on denied by its login files only (lib/local.mjs
    // credentialPaths): one list for Factory's commands and, through FACTORY_LOCAL_SANDBOX, the harness's own sandbox. A
    // Copilot stage runs on a home Factory makes, which holds no login.
    // A login file of the stage's own that really is another login's (a link planted in its folder) would be read by its
    // harness: the stage refuses, naming the path in this machine's log only.
    const linked = harness === "copilot" ? [] : ownLoginProblems(harness, host);
    if (linked.length) throw Object.assign(new Error(`the ${harness} login this stage runs on leads into another login: ${linked.map((l) => `${l.path} -> ${l.real}`).join(", ")}`), { code: "login-link" });
    const credentials = credentialPaths(homedir(), host, { own: harness === "copilot" ? null : stageLogin(harness, host) });
    writeFileSync(srtFile, JSON.stringify(srtSettings({ domains, writable: [clone, ...caches, stageTmp], clone, credentials, readOnly: [usageDir], ripgrep }), null, 2));
    // Factory's own git work on the clone (backend.mjs sandbox.git): the clone writable, its .git included; no network.
    const srtGitFile = join(sandboxDir, `srt-git-${basename(usageDir)}.json`);
    writeFileSync(srtGitFile, JSON.stringify(srtSettings({ domains: [], writable: [clone, stageTmp], credentials, readOnly: [usageDir] }), null, 2));
    // Factory's helpers (factory-db) are copied into the stage's usage directory and lead PATH: Claude Code's sandbox
    // shows nothing under the home directory beyond the working and added directories, so plugin/bin is out of its sight.
    const binDir = join(usageDir, "bin");
    mkdirSync(binDir, { recursive: true });
    // Only the sandbox's own helpers: the `factory` front end (local mode itself) has no business inside a stage.
    for (const tool of readdirSync(join(PLUGIN_ROOT, "bin")).filter((t) => t !== "factory")) {
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
    // Linux: the stage's node (#111) and the repository's package manager (#137) for Claude Code's and Copilot's commands,
    // read-only: their sandboxes show nothing of the home but what their settings name. Never in or above what a sandbox
    // may write (this repository's Objectives, the stages' temp directories), the home or a credential store. Codex's
    // sandbox reads the whole system but the credential stores, so its commands find both as the developer does.
    const tools = localTools({ harness, clone, path: base.PATH, off: [this.dev, join(this.dev, ".factory"), dirname(stageTmp)], usageDir });
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
    if (dropped.length) log(`FACTORY_LOCAL_DOMAINS: ${dropped.map((d) => JSON.stringify(d)).join(", ")} left out of ${harness === "codex" ? "Codex's" : "Copilot's"} sandbox: not host names (a port or an address it cannot enforce as written)`);
    // Copilot never runs without it (preflight refuses such a host): here it stopped starting after serve began, for
    // example a new Copilot, bubblewrap or slirp4netns version probed again. The stage refuses; stage() Blocks.
    if (!outerOn && harness === "copilot") throw Object.assign(new Error(`${COPILOT_OUTER_OFF}: ${outer.why}${outer.cacheFile ? ` (probe cache: ${outer.cacheFile})` : ""}`), { code: "outer-sandbox" });
    if (!outerOn && !OUTER_SAID.has(harness)) {
      OUTER_SAID.add(harness);
      log(`local: ${harness} runs without the outer sandbox on this host: ${outer.why}. What it runs on the host itself relies on the file-level guards and Factory's git guard.`);
    }
    if (outerOn) {
      mkdirSync(join(usageDir, "harness"), { recursive: true });
      ensureHarnessHomes(harness, { ...host, ...extra });
      // Claude Code's projects are read-only in it; the clone's own project links to a directory of the Objective's.
      const projectDir = harness === "claude" ? claudeProjectLink(clone, join(ws, "claude-project"), { ...host, ...extra }) : null;
      // Copilot's outer sandbox runs bwrap through Factory's wrapper (lib/local.mjs bwrapTunScript), in the usage directory,
      // which no sandbox may write: srt runs it on the host.
      const bwrapPath = harness === "copilot" ? writeBwrapTun(join(usageDir, "outer")) : null;
      writeFileSync(outerFile, JSON.stringify(harnessOuterSettings({ harness, domains, writable: [clone, ...addDirs, join(usageDir, "harness")], clone, env: { ...host, ...extra }, credentials, install: harnessInstall(whichSync(harness)), projectDir, bwrapPath, relaySocketDir: socketDir, ripgrep }), null, 2));
    }
    // Last on PATH, so nothing there can ever stand in for git, gh, srt or claude in Factory's own unsandboxed calls;
    // and neither sandbox may write it (FACTORY_LOCAL_SANDBOX.readOnly, srt denyWrite), so nothing can be planted.
    base.PATH = `${base.PATH || ""}:${binDir}`;
    // The harness's own `git`, first on its PATH only (lib/harness.mjs): refused once the clone's .git was replaced.
    const gitBin = join(usageDir, "gitbin");
    mkdirSync(gitBin, { recursive: true });
    writeFileSync(join(gitBin, "git"), gitGuardScript(realpathSync(whichSync("git"))), { mode: 0o755 });
    // Linux: Copilot's own `bwrap`, first on its PATH only (lib/harness.mjs): Copilot starts its sandbox's bubblewrap with
    // its whole environment, the token included, and bubblewrap stays as every command's pid 1, readable to each (#100).
    // Factory's starts the real one with none (lib/copilot-runner.mjs bwrapShim). In the usage directory, which no
    // sandbox may write; harness.mjs copilotLocalCheck proves it before every start.
    // It also gives each command the stage's temp directory as its TMPDIR: Copilot itself runs with its own
    // (lib/local.mjs copilotPrivateTmp), where it writes each command's network rules.
    const bwrapBin = outerOn && harness === "copilot" ? join(usageDir, "bwrapbin") : null;
    if (bwrapBin) {
      mkdirSync(bwrapBin, { recursive: true });
      // Each command's PATH led by the stage's node where it is bound (after Factory's git): a version manager's shim
      // before it on PATH is outside the sandbox.
      writeFileSync(join(bwrapBin, "bwrap"), bwrapShim(realpathSync(whichSync("bwrap")), null, stageTmp, lead.length ? [gitBin, ...lead].join(":") : null, localCopilotRelayShim(localRelayDir(usageDir))), { mode: 0o755 });
    }
    // Claude Code sources this before each command, inside its sandbox (CLAUDE_ENV_FILE): the same PATH lead. In the
    // usage directory, which no sandbox may write.
    const claudeEnv = harness === "claude" && lead.length ? join(usageDir, "claude-env.sh") : null;
    if (claudeEnv) writeFileSync(claudeEnv, claudeEnvText([gitBin, ...lead]), { mode: 0o644 });
    return {
      ...base,
      FACTORY_CREDENTIAL: "login",
      // The workflow's setup assumes a runner (sudo, a fresh VM); on a box the toolchain is the box's own.
      FACTORY_SETUP: process.env.FACTORY_LOCAL_SETUP ?? this.wf.FACTORY_LOCAL_SETUP ?? "",
      // The commands that can run in this machine's sandboxes, when not all can (a suite that needs a unix socket):
      // the task card names these, and the repository's required checks on GitHub still run the full set.
      ...((process.env.FACTORY_LOCAL_VALIDATION ?? this.wf.FACTORY_LOCAL_VALIDATION) ? { FACTORY_VALIDATION: process.env.FACTORY_LOCAL_VALIDATION ?? this.wf.FACTORY_LOCAL_VALIDATION } : {}),
      FACTORY_PLUGIN_ROOT: PLUGIN_ROOT,
      FACTORY_USAGE_DIR: usageDir,
      // Factory's own temp directory (its mirror and bundles) under the Objective's directory, which no sandbox may write
      // (fsafe.mjs privateTmp).
      FACTORY_PRIVATE_DIR: join(ws, ".private"),
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
      FACTORY_LOCAL_SRT: srtFile,
      FACTORY_LOCAL_SRT_GIT: srtGitFile,
      ...(outerOn ? { FACTORY_LOCAL_SRT_HARNESS: outerFile } : {}),
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
      FACTORY_LOCAL_SANDBOX: JSON.stringify({ gitId: readGitPin(gitPinFile(ws)), gitPin: gitPinFile(ws), gitBin, ...(bwrapBin ? { bwrapBin, copilotTmp: copilotPrivateTmp(usageDir) } : {}), ...(tools.probe ? { toolchain: tools.probe } : {}), ...(claudeEnv ? { claudeEnv, readable: tools.readable } : {}), ...(ripgrep ? { ripgrep } : {}), addDirs, cacheDirs: caches, readDirs: [usageDir], domains, clone, readOnly: [usageDir], claudeDir: join(usageDir, "claude"), credentials }),
      // Every git-lfs transfer of Factory's own host-side git (lfs pull, checkout, rebase, push) goes to the repository's
      // own endpoint, whatever .lfsconfig the model wrote (env config outranks that file), over the real history (no
      // refs/replace). scrubbedEnv drops both (with FACTORY_LFS_PIN) from every child: the harness and the repository's
      // commands never see them.
      ...lfsPinEnv(`https://github.com/${this.repoFull}.git`),
      GIT_NO_REPLACE_OBJECTS: "1",
      FACTORY_LFS_PIN: "1",
      // The harness this sandbox is set up for: a stage whose labels name another by the time it runs Blocks (choiceGate).
      FACTORY_STAGE_HARNESS: harness,
      // The hosts this Objective's host labels opened in these sandboxes: a stage whose labels name others by the time it
      // runs Blocks (choiceGate).
      FACTORY_STAGE_HOSTS: [...new Set(hosts.filter(isSandboxHost))].sort().join(","),
      // The account it runs on, by name only: its result.json, progress comment and the scorecard record it.
      FACTORY_STAGE_ACCOUNT: account.name,
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
    // Its policy, config and MCP servers, as Factory's own: whatever an earlier run left there (a link included) is replaced.
    // Linux: Copilot's own TMPDIR (its commands' network rules), denied to its commands.
    // The stage's node and package manager (stageEnv) read-only, its global npmrc denied.
    const alsoDenied = platform() === "linux" ? [copilotPrivateTmp(usageDir), ...(tools?.denied || [])] : [];
    const files = { "settings.json": JSON.stringify(copilotLocalSettings({ domains, clone, addDirs, readOnly: [usageDir], readable: tools?.readable || [], alsoDenied }), null, 2), ...copilotHomeFiles() };
    for (const [f, text] of Object.entries(files)) {
      // A directory an earlier run left under the name too.
      rmSync(join(home, f), { force: true, recursive: true });
      writeFileSync(join(home, f), text, { mode: 0o600, flag: "wx" });
    }
    // On macOS Copilot's sandbox cannot read ~/.gitconfig and git then refuses to run; the clone's own config carries
    // Factory's identity and credential helper, so git skips the global file (which may hold credentials anyway).
    // The stage's account's token, read now: a declared account's from its own file (none from serve's environment
    // then), the implicit one's from where it always came (never a declared account's token kept from serve's start).
    const token = account ? copilotTokenOf(account) : this.copilotToken || copilotToken();
    return { COPILOT_HOME: home, COPILOT_GITHUB_TOKEN: token, GIT_CONFIG_GLOBAL: "/dev/null" };
  }

  /**
   * Run worker.mjs or review.mjs as a child; its lines are echoed with the issue and stage. A failure before its process
   * starts is marked as Factory's own set-up of stage `name` failing (`stageSetup`), which lapse names: never the work's,
   * and never another stage's. Under `factory run` or `review` (`solo`: the command), the stage holds one slot of the
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
    // Every stage: the clone's .git is the one Factory cloned, or nothing runs in it. The Objective is Blocked rather than
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
    const runs = script === "worker.mjs" || script === "review.mjs" ? await this.harnessFor(issue, { own: usageDir }) : { ok: true, harness: this.harness };
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
    // Factory's teardown: a failure here is logged, never the stage's end.
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
      const prepared = await prepareClone(clone, [env.pnpm_config_store_dir, env.BUN_INSTALL_CACHE_DIR], (inner) => exec(...BACKENDS.local.sandbox.git(inner, gitEnv), { env: gitEnv }), { fresh: script !== "worker.mjs", locks: locks.stale });
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
    if (this.stopping) {
      dropStage();
      return { code: null, exit: null, usd: null, usageDir };
    }
    // With automatic account choice on, the round-robin counts this start (a pinned one too): its process runs now.
    if (this.auto && runs.account) this.startedOn(runs.account);
    return new Promise((done) => {
      if (this.firstSetup.has(issue)) {
        env.FACTORY_LOCAL_FIRST_SETUP_MS = String(this.firstSetup.get(issue));
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
      const child = spawn(process.execPath, [join(PLUGIN_ROOT, "scripts", script), "--repo", this.repoFull, ...args, "--checkout", clone, "--usage-dir", usageDir, "--token-fd", "3", ...notice], { env: values ? { ...env, FACTORY_INPUT_WORKER_SECRET_VALUES: values } : env, stdio: ["ignore", "pipe", "pipe", "pipe", ...(this.notice ? ["ipc"] : [])] });
      // Its process started: a failure from here on is no failure of its set-up (stage(): `stageStarted`).
      try {
        // Named while it runs, so a later start on this machine never runs a second stage beside it (liveStage).
        if (child.pid) writeFileSync(join(usageDir, STAGE_RECORD), JSON.stringify(processRecord(child.pid)), { mode: 0o600 });
        child.stdio[3].on("error", () => {});
        child.stdio[3].end(this.token);
        if (this.notice) serveNotices(child, this.notice);
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
          // Blocked on its usage limit with no reset reported (session.mjs writeUsage `limitRefused`): automatic account
          // choice, in this serve and any other here that has it on, passes the account over for a while (holds.mjs spent);
          // nothing else holds on it, and a serve with it off writes no guess.
          if (this.auto && runs.account && result?.exit === "blocked" && result.limitRefused) {
            const end = this.holdStore(hold).spent({ harness: runs.harness, account: hold.key, now: (this.clock ?? Date.now)(), window: result.limitRefused.limitType ?? null });
            log(`#${issue}: ${limitName(runs.harness, account)} reached its usage limit with no reset reported; automatic account choice passes it over until ${new Date(end).toISOString()}`);
          }
          done({ code, signal, exit: result?.exit ?? null, usd: result?.usd ?? null, usageDir, stage: name, log: logFile, ...(runs.account ? { account, hold, pinned: !!runs.pinned, pin: runs.pin ?? null } : {}), ...(result?.exit === "paused" && result.outage ? { outage: result.outage } : {}), ...(result?.exit === "paused" && result.usageLimit ? { usageLimit: result.usageLimit } : {}) });
        });
      } catch (e) {
        throw Object.assign(e instanceof Error ? e : new Error(String(e)), { stageStarted: true });
      }
    });
  }

  /**
   * Block the Objective whose clone's .git is not the one Factory cloned: a fixed reason, no local path. A repeat on the
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
    const pr = await gh.findPr(this.repo, `factory/${issue}`, this.opts).catch(() => null);
    if (pr) await gh.removeLabel(this.repo, pr.number, REVIEW_LABEL, this.opts).catch((e) => log(`#${issue} review label: ${e.message.slice(0, 120)}`));
    await gh.applyExit(this.repo, { issue, pr, exit: "blocked", reason, key, cause, ...(fix ? { fix } : {}), notify: inputs.notify, stage: name }, this.opts);
  }

  /**
   * SIGINT, SIGTERM or SIGHUP to `run`, `review` or `serve`: stop. Nothing new starts, every stage process gets SIGTERM
   * (it stops its harness's process group before it exits: proc.mjs stopGroups), and the claims stay, so the Objectives
   * pause and this machine's next `factory run` or `factory serve` takes them up again. A start that has written no claim
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
      log(`stopping (${sig}): ending ${this.children.size} stage process(es); their Objectives stay Running, paused, and the next factory run or serve on this machine takes them up (the dispatcher Blocks one only after a day away); a start with no claim yet goes back to Queued; signal again to exit at once`);
      for (const child of this.children) child.kill("SIGTERM");
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
    // Two loops writing at once: the comment's last writer holds it, and the other steps aside. A short random wait
    // lets both writes land before either reads back, so both cannot read their own.
    await new Promise((r) => setTimeout(r, this.claimSettleMs ?? 1500 + Math.floor(Math.random() * 1500)));
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
    // One heartbeat at a time: while this machine's network is down a write waits for it (lib/network.mjs), and the
    // beats due meanwhile are skipped rather than queued behind it.
    let beating = null;
    const beat = setInterval(() => {
      if (beating) return;
      beating = writeClaim(this.repo, issue, this.holder, this.opts)
        .catch((e) => log(`#${issue} heartbeat: ${e.message.slice(0, 120)}`))
        .finally(() => {
          beating = null;
        });
    }, HEARTBEAT_MS);
    let result = null;
    let failure = null;
    try {
      result = await fn();
      return result;
    } catch (e) {
      failure = e;
      throw e;
    } finally {
      clearInterval(beat);
      // Stopping serve pauses its work: the claim stays, goes stale, and this machine's next serve resumes it. A failed
      // start is unstart's to settle.
      if (!this.stopping && !failure?.startFailed) {
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
   * stays and pausedHere resumes it once; a second in a row Blocks it here (cause `factory`), naming the stage, its exit
   * code or signal and its log on this machine, so the cause reaches GitHub and nothing retries forever. A throw names
   * what threw: Factory's set-up of a stage (`stageSetup`, stage()), or else the local loop itself; never the work; and
   * the error as postedError has it. The count is this loop's memory: another serve on the machine resumes the
   * Objective afresh.
   */
  async lapse(issue, result, failure) {
    const stage = result?.stage || failure?.stageSetup || "local";
    // This machine's log gets the whole error; GitHub gets it as postedError has it.
    const said = (error) => (!failure ? `the ${stage} stage ended with no exit record (${result?.signal ? `signal ${result.signal}` : `exit code ${result?.code ?? "none"}`})` : failure.stageSetup ? `Factory's set-up of the ${stage} stage failed (${error})` : `Factory's local loop threw (${error})`);
    const what = said(String(failure?.message || failure).slice(0, 200));
    const where = result?.log ? `; its log on this machine: ${result.log}` : "";
    const lapsed = (this.lapsed ??= new Map());
    if (!lapsed.has(issue)) {
      lapsed.set(issue, 1);
      log(`#${issue}: ${what}; the claim stays and this loop resumes it once${where}`);
      return;
    }
    lapsed.delete(issue);
    log(`#${issue}: ${what} again; Blocking it${where}`);
    try {
      await this.block(issue, stage, `${said(postedError(failure))} twice in a row on this machine${where}`.replaceAll(homedir(), "~"), { cause: "factory", ...(failure ? { fix: "Fix it on this machine (the local loop's log has the failure), then re-apply `factory:objective`." } : {}) });
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
   * long the run between them lasted, so repeated quota pauses stay within OUTAGE.blockMs too. A pause on GitHub answering
   * 5xx past the client's retries (network.mjs serverDown) is counted in `server` ({since, pauses, at}) across every
   * pause of the Objective however far apart, until a stage ends any other way (withClaim): a probe of the host answers
   * while one endpoint fails, so pausedHere resumes it after a doubling wait instead (serverWait), and resume Blocks it
   * past OUTAGE.serverResumes resumes or OUTAGE.blockMs from the first. No lapse is counted; the claim stays. The memory
   * is this loop's: another serve on the machine resumes the Objective with the bound counted afresh.
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
    const same = earlier && (quotaAgain || (Number.isFinite(earlier.resumedAt) && own - earlier.resumedAt < OUTAGE.stageWaitMs));
    const since = same ? Math.min(own, earlier.since) : own;
    const now = (this.clock ?? Date.now)();
    const before = earlier?.harness ? null : (earlier?.server ?? null);
    const server = serverDown(o.code) ? { since: Math.min(own, before?.since ?? own), pauses: (before?.pauses ?? 0) + 1, at: now } : before;
    (this.offline ??= new Map()).set(issue, { since: serverDown(o.code) ? server.since : since, stage: result?.stage || "work", origin: o.origin ?? null, host: o.host || "the network", code: o.code || "no answer", ...(o.endpoint ? { endpoint: o.endpoint } : {}), ...(Number.isFinite(reset) ? { reset } : {}), ...(server ? { server } : {}) });
    this.lapsed?.delete(issue);
    const what = Number.isFinite(reset)
      ? `GitHub's ${o.quota || "core"} API rate limit on ${o.host || "GitHub"} is spent until ${o.reset}; the claim stays and this loop resumes it after the reset`
      : serverDown(o.code)
        ? `${lostText(o.host || "GitHub", o.code, o.endpoint)} since ${new Date(server.since).toISOString()}; the claim stays and this loop resumes it in ${minutesText(serverWait(server.pauses))} (pause ${server.pauses}; Blocked after ${OUTAGE.serverResumes} resumes)`
        : `${lostText(o.host || "the network", o.code || "no answer")} since ${new Date(since).toISOString()}; the claim stays and this loop resumes it once that host answers`;
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
    const until = l.guessed ? `is passed over until about ${new Date(reset).toISOString()} (no reset was reported)` : `is spent until ${new Date(reset).toISOString()}${reset !== stated ? ` (the provider stated ${l.reset})` : ""}`;
    log(`#${issue}: the ${result?.stage || "work"} stage paused: ${limitName(l.harness, account)}'s usage limit ${until}; the claim stays and this loop resumes it after then`);
    if (l.harness) await this.pauseNotice(issue, { stage: result?.stage || "work", harness: l.harness, account, hold: hold.key, reset, window: l.limitType ?? this.holdStore(hold).window(hold.key, now) ?? null, pinned: !!result.pinned, ...(l.guessed ? { guessed: true } : {}) });
  }

  /**
   * A stage whose account automatic choice picked that ended `paused` on a usage limit or quota with no reset reported
   * (session.mjs usageLimitExit `noReset`, #332): the account is passed over for a guessed while (holds.mjs spent), in
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
    const end = this.auto ? this.holdStore(hold).spent({ harness: l.harness, account: hold.key, now, window: l.limitType ?? null }) : null;
    if (end !== null) log(`#${issue}: ${limitName(l.harness, account)} reached its usage limit or quota with no reset reported; automatic account choice passes it over until ${new Date(end).toISOString()}`);
    if (end !== null && !result.pinned && this.freeAccounts(l.harness, hold.key).length) return this.limitPaused(issue, { ...result, usageLimit: { ...l, noReset: false, reset: new Date(end).toISOString(), held: true, guessed: true } });
    const h = HARNESS_NAMES[l.harness] || l.harness;
    const states = this.accountStates(l.harness);
    const reason = `${h} account \`${account}\` reached its usage limit or quota with no reset reported, and no other ${h} account on this machine is free${states.length ? `: ${states.join("; ")}` : ""}.`;
    this.offline?.delete(issue);
    this.lapsed?.delete(issue);
    log(`#${issue}: Blocking it: ${reason}`);
    try {
      await this.block(issue, result?.stage || "work", reason, { cause: "provider-quota", fix: `Re-apply \`factory:objective\` once a ${h} account is free again.` });
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
      if (any !== null && any !== hard) return `\`${a.name}\` passed over until about ${new Date(any).toISOString()} (no reset reported)`;
      if (hard !== null) return `\`${a.name}\` held until ${new Date(hard).toISOString()}`;
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
    await upsertComment(this.repo, issue, marker(issue, "account-limit"), "Factory: one account label or none is left, so the Objective goes on.", this.opts).catch((e) => log(`#${issue}: the account note could not be written (${String(e?.message || e).slice(0, 120)})`));
  }

  /** A note write from a path that cannot wait on it (limitHold): kept in `notesInFlight` until it settles. */
  noting(p) {
    const set = (this.notesInFlight ??= new Set());
    const kept = p.finally(() => set.delete(kept));
    set.add(kept);
  }

  /**
   * A claim this loop holds on an Objective it keeps paused (a usage limit's reset, its account labels: pausedHere),
   * written again once its comment is PAUSED_BEAT_MS old (`claim`, localClaim's read: its heartbeat is GitHub's update
   * time). No stage runs to heartbeat it, and a claim a day old is a loop gone away, which the dispatcher Blocks. A
   * write that fails is logged; the next tick tries again.
   */
  async beatPaused(issue, claim) {
    if (!claim?.heartbeat || (this.clock ?? Date.now)() - Date.parse(claim.heartbeat) < PAUSED_BEAT_MS) return;
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
   * (#265): the one its single `factory:account:` label pins, read through the kept labeler check (pinTrust); with none,
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
   * there), so a person's release (`factory hold release`, holds.mjs release), the folder cleared by hand, or any other
   * end of the hold resumes it at the next tick, on that account. Said once, as it resumes.
   */
  heldNoMore(issue, off, now) {
    const stores = [this.holdStore(), this.ownHolds].filter(Boolean);
    if (stores.some((st) => st.avoidUntil(off.hold, now) !== null)) return false;
    const at = this.holdStore().releasedAt?.(off.hold, now) ?? null;
    const how = at !== null && at > off.since ? `was released (factory hold release) at ${new Date(at).toISOString()}` : "is no longer held on this machine";
    log(`#${issue}: ${limitName(off.harness, off.account)} ${how}; resuming it now, before the reset it paused for`);
    return true;
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
   * CODEX_HOME else ~/.codex, ~/.config/factory/copilot-token), never of a secret: so two serves on two logins never
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
   * loop's; the account its one `factory:account:<name>` label names when its labeler is known to be trusted, else that
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
      const h = HARNESS_NAMES[harness] || harness;
      // The first to end may be a guess (no reset reported): an estimate, said as one.
      const at = `${first.until !== this.limitUntil(first.hold) ? "about " : ""}${new Date(first.until).toISOString()}`;
      if (every.length === 1) return `${limitName(harness, first.a.name)}'s usage limit is spent until ${at}`;
      return held.length === every.length ? `every ${h} account on this machine has its usage limit spent; the first, ${limitName(harness, first.a.name)}, resets at ${at}` : `every ${h} account on this machine has its usage limit spent or cannot run here; the first to reset, ${limitName(harness, first.a.name)}, resets at ${at}`;
    }
    const hold = this.holdOf(account);
    const until = this.limitUntil(hold);
    if (until === null) return null;
    this.saidLimit(harness, account.name, hold, until);
    return `${limitName(harness, account.name)}'s usage limit is spent until ${new Date(until).toISOString()}`;
  }

  /** The log line that no stage starts on `account` until its usage limit's reset (`until`, ms): once per reset. */
  saidLimit(harness, account, hold, until, guessed = false) {
    const key = `${hold.key}@${until}`;
    if ((this.limitSaid ??= new Set()).has(key)) return;
    this.limitSaid.add(key);
    const who = limitName(harness, account);
    if (guessed) log(`${who} reached its usage limit with no reset reported; automatic account choice passes it over until about ${new Date(until).toISOString()}`);
    else log(`${who}'s usage limit is spent until ${new Date(until).toISOString()}; no stage starts on ${who} until then`);
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
    for (const label of ["factory:running", "factory:in-review"]) issues.push(...(await listIssuesByLabel(this.repo, label, this.opts).catch(() => [])));
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
      // Paused on the network: resumed once the host it could not reach answers a probe (GitHub answered these reads),
      // and taken up past OUTAGE.blockMs whatever the probe says, so resume Blocks it (a provider unreachable while GitHub
      // answers would otherwise leave it Running with no notice). Paused on GitHub's spent rate limit: resumed once its
      // reset has passed, with no probe (GitHub answers while the limit is spent).
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
        // Paused on GitHub's 5xx: resumed after its doubling wait (serverWait), not on a probe, which answers while one
        // endpoint fails; taken up at once past OUTAGE.serverResumes resumes, so resume Blocks it.
        const server = serverDown(off.code) && off.server ? off.server.pauses > OUTAGE.serverResumes || now - off.since >= OUTAGE.blockMs || now >= off.server.at + serverWait(off.server.pauses) : null;
        const due = off.pinWait || (Number.isFinite(off.reset) ? now >= off.reset || (!!off.harness && !!off.hold && (this.heldNoMore(issue.number, off, now) || (await this.movesEarly(issue.number, off, names, issue.updated_at ?? null)))) : server !== null ? server : !off.origin || now - off.since >= OUTAGE.blockMs || (await probeHost(off.origin)) === null);
        if (due) out.push(issue.number);
        // Waiting on a usage limit's reset, on its account labels or on GitHub's 5xx: its claim kept alive while this loop is.
        else if (off.harness || server !== null) await this.beatPaused(issue.number, c);
        continue;
      }
      if (c.holder === this.holder ? !!this.lapsed?.has(issue.number) || !c.fresh : !c.fresh || deadHereHolder(c.holder, { own: this.holder })) out.push(issue.number);
    }
    return out;
  }

  /**
   * Remove the Objective directories (clone, caches, stage logs and sessions) of Objectives that are closed: done or
   * abandoned, nothing will resume them. Open ones stay, Blocked included, for a human re-label to pick up where they
   * stood. Not while running here, and never on a failed lookup.
   */
  async cleanup(running) {
    const root = join(this.dev, ".factory");
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
      // Of .factory only <issue>/claude-project is writable from a sandbox (claudeProjectLink); rmSync removes a link, never its target, so nothing planted there is followed.
      rmSync(join(root, name), { recursive: true, force: true });
      // And the link to its Claude Code project, if a stage made one (lib/local.mjs claudeProjectLink).
      // In every Claude Code folder on the machine: a stage may have run on any of them.
      for (const l of harnessLogins(homedir(), process.env).filter((x) => x.harness === "claude")) dropClaudeProjectLink(join(root, name, "repo"), { CLAUDE_CONFIG_DIR: l.dir });
      log(`#${issue}: closed; removed its local directory .factory/${name}`);
    }
  }

  /**
   * Pick a paused Objective up where it stands: its open PR's review, else its work from the clone and saved sessions.
   * One paused on this machine's network for OUTAGE.blockMs or more is Blocked instead, with the External cause
   * `outage`, naming the host and since when; so is one paused on GitHub's 5xx past OUTAGE.serverResumes resumes, naming
   * the request and the status.
   */
  async resume(issue) {
    const off = this.offline?.get(issue);
    const now = (this.clock ?? Date.now)();
    const serverOver = !!off && serverDown(off.code) && !!off.server && off.server.pauses > OUTAGE.serverResumes;
    if (off && !off.harness && !off.pinWait && (serverOver || now - off.since >= OUTAGE.blockMs)) {
      // GitHub answers here; the host the stage could not reach may still not (a provider), and the notice says which.
      const back = serverDown(off.code) || !off.origin || (await probeHost(off.origin)) === null;
      const reason = serverDown(off.code)
        ? `${lostText(off.host, off.code, off.endpoint)} from ${new Date(off.since).toISOString()}, through ${off.server?.pauses ?? 1} pauses over ${minutesText(now - off.since)}, past Factory's bound of ${OUTAGE.serverResumes} resumes or ${minutesText(OUTAGE.blockMs)} for GitHub failing. Re-apply the label to run it again once GitHub answers that request.`
        : `${lostText(off.host, off.code)} from ${new Date(off.since).toISOString()} for ${minutesText(now - off.since)}, past Factory's ${minutesText(OUTAGE.blockMs)} bound for an outage. ${back ? `${serverDown(off.code) ? off.host : "The network"} is back: re-apply the label to run it again.` : `${off.host} is still unreachable from this machine: re-apply the label once it answers.`}`;
      log(`#${issue}: ${reason}`);
      try {
        await this.block(issue, off.stage || "work", reason, { cause: "outage" });
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
      pr = await findPr(this.repo, `factory/${issue}`, this.opts);
      data = await getIssue(this.repo, issue, this.opts);
    } catch (e) {
      log(`#${issue}: its PR or issue could not be read (${String(e.message).slice(0, 120)}); the claim stays and the next tick tries again`);
      return { exit: "skipped" };
    }
    // A PR still waiting for its review pass goes to review (as pendingReviews); Running work (a first run, or a
    // send-back rebase) runs again; anything else (reviewed, waiting in the merge queue) needs nothing here.
    const next = stageFor({ pr, issue: data });
    if (next === "review") return this.withClaim(issue, () => this.review(issue, pr.number));
    if (next === "work") return this.runObjective(issue);
    // A review this loop holds paused after its label came off (an outage met on its merge path: session.mjs outageFirst)
    // ends nothing by the label: the review runs again, and its exit or merge follows.
    if (next === "merge" && off?.stage === "review") return this.withClaim(issue, () => this.review(issue, pr.number));
    log(`#${issue}: nothing left to run here (its PR is reviewed or gone); releasing the claim`);
    const held = await localClaim(this.repo, issue, this.opts).catch(() => null);
    if (held?.commentId && sameMachineHolder(held.holder)) await rest(`repos/${this.repo.full}/issues/comments/${held.commentId}`, { ...this.opts, method: "DELETE" }).catch(() => {});
    this.lapsed?.delete(issue);
    return { exit: "skipped" };
  }

  async review(issue, prNumber, { wait = false, reruns = 0 } = {}) {
    const review = await this.stage(issue, "review", "review.mjs", ["--pr", String(prNumber)]);
    log(`#${issue} review of PR #${prNumber}: ${review.exit ?? `no exit record (code ${review.code})`}${review.usd != null ? `, $${review.usd.toFixed(2)}` : ""}`);
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
        return review;
      }
      if ((await this.followMerge(issue, prNumber)) === "next") return { ...review, next: true };
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
   * One Objective, start to delivered review (and, with `wait`, to merged). `named`: a person named it (`factory run`),
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
   */
  startHolds(now = (this.clock ?? Date.now)()) {
    const out = {};
    for (const [n, f] of this.startFailures ?? []) if (now < f.retryAt) out[n] = `its last start here failed (${f.count} in a row); tried again after ${new Date(f.retryAt).toISOString()}`;
    return out;
  }

  /**
   * A start that failed before its work stage ran (the claim, the clone, prepareClone, a directory): the real error is
   * logged and the Objective goes back to Queued, its claim dropped, rather than sitting Running for the dispatcher to
   * Block with no cause. This loop then holds it for a backoff (START_BACKOFF_MS, doubling to START_BACKOFF_MAX_MS), so a
   * machine-level fault (disk full, a broken sandbox) neither Blocks every queued Objective in turn nor relabels them
   * every tick; the third failed start of the same Objective in a row Blocks it once, with the error as postedError has it
   * (cause `setup`).
   * When the claim could not be read, or was another loop's, who holds it is unknown: nothing changes now, and after the
   * backoff this loop reads the claim again (recheckStarts). Only an Objective still labelled Running is un-marked or
   * Blocked; otherwise, or on a failed read, the claim stays, goes stale and this loop resumes it (pausedHere).
   */
  async unstart(issue, e) {
    const out = { code: null, exit: null, usd: null, usageDir: null, startFailed: e.startFailed };
    log(`#${issue}: could not start (${e.startFailed}): ${String(e?.message || e).slice(0, 300)}`);
    const error = postedError(e).slice(0, 300);
    const failures = (this.startFailures ??= new Map());
    const count = (failures.get(issue)?.count ?? 0) + 1;
    const unknown = e.startFailed === "claim-read" || !!e.othersClaim;
    const backoff = (recheck = unknown) => {
      const retryAt = (this.clock ?? Date.now)() + Math.min(START_BACKOFF_MS * 2 ** (count - 1), START_BACKOFF_MAX_MS);
      failures.set(issue, { count, retryAt, recheck });
      return new Date(retryAt).toISOString();
    };
    try {
      const data = await getIssue(this.repo, issue, this.opts);
      if (!(data?.labels || []).some((l) => (typeof l === "string" ? l : l.name) === "factory:running")) {
        // No longer Running (a person moved it): nothing of this loop's to undo or read again.
        failures.delete(issue);
      } else if (count >= START_FAILURES_BLOCK) {
        await this.block(issue, "work", `could not start on this machine ${count} times in a row (${e.startFailed}${e.code ? `, ${e.code}` : ""}): ${error}. Fix the machine (disk space, the sandbox, the harness login), then re-apply the label.`);
        failures.delete(issue);
        if (!unknown) await dropClaim(this.repo, issue, this.holder, this.opts);
        this.lapsed?.delete(issue);
        return { ...out, exit: "blocked" };
      } else if (unknown) log(`#${issue}: who holds it is unknown here, so it stays as it is; this loop reads its claim again after ${backoff()}`);
      else {
        await this.requeue(issue);
        log(`#${issue}: back to Queued; this loop starts it again after ${backoff()}`);
      }
    } catch (x) {
      // GitHub failed here too (the issue read, the requeue or the Block): the Objective may still be Running, so this
      // loop reads its claim again after the backoff and settles it then (recheckStarts).
      log(`#${issue}: could not settle the failed start (${String(x?.message || x).slice(0, 120)}); this loop reads it again after ${backoff(true)}`);
    }
    this.lapsed?.delete(issue);
    return out;
  }

  /** Back to Queued: the Running label off, the card to Queued, this loop's claim dropped. */
  async requeue(issue) {
    await setStateLabel(this.repo, issue, null, this.opts);
    const project = await findProject(this.repo, this.opts).catch(() => null);
    if (project) await moveCard(project, this.repo, issue, "Queued", this.opts).catch(() => {});
    await dropClaim(this.repo, issue, this.holder, this.opts);
  }

  /** A pick this loop marked and never started, back to Queued: only factory:running comes off, and the card to Queued. */
  async unpick(issue) {
    await removeLabel(this.repo, issue, "factory:running", this.opts);
    const project = await findProject(this.repo, this.opts).catch(() => null);
    if (project) await moveCard(project, this.repo, issue, "Queued", this.opts).catch(() => {});
  }

  /**
   * A work start told to stop before it wrote its claim, with no claim on the issue: an Objective labelled Running (serve's
   * dispatch marked it) goes back to Queued, so it is never left Running with nothing to resume it. Any other state stays.
   */
  async unpickStopped(issue) {
    const data = await getIssue(this.repo, issue, this.opts);
    if (!(data?.labels || []).some((l) => (typeof l === "string" ? l : l.name) === "factory:running")) return;
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
        if ((data?.labels || []).some((l) => (typeof l === "string" ? l : l.name) === "factory:running")) {
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
   * `factory run <issue>`: the stage the Objective's state calls for (stageFor, as serve's resume): its review, its merge
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
    const pr = await retried(`reading the open PR of factory/${issue}`, () => gh.findPr(this.repo, `factory/${issue}`, this.opts), { waitMs });
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
      return this.withClaim(issue, async () => {
        const merged = await this.followMerge(issue, pr.number);
        return { exit: merged ? "delivered" : null, next: merged === "next" };
      });
    }
    return this.runObjective(issue, { wait, named: true });
  }

  /**
   * The last line when this loop stops following an Objective whose PR is not merged yet: who tends it now and, for a
   * local Objective, the fix. Null when its PR is merged or gone.
   */
  async pendingMergeLine(issue) {
    const pr = await findPr(this.repo, `factory/${issue}`, this.opts).catch(() => null);
    if (!pr) return null;
    const data = await getIssue(this.repo, issue, this.opts).catch(() => null);
    const local = !data || BACKENDS.local.trigger.routes(data, this.baseEnv());
    return `#${issue}: PR #${pr.number} is not merged yet; ${local ? `nothing tends a local Objective while no factory serve runs for this repository: start \`factory serve\` (or \`factory run ${issue} --wait\`) to merge it` : "the Action's dispatcher tends its merge"}`;
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
    log(`#${issue} work: ${work.exit ?? `no exit record (code ${work.code})`}${work.usd != null ? `, $${work.usd.toFixed(2)}` : ""}`);
    if (work.exit !== "delivered") return work;
    const pr = await findPr(this.repo, `factory/${issue}`, this.opts).catch(() => null);
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
      const why = staleDecision({ pr, rebases: seen.recent, stuck: seen.stuck, queue: true });
      if (why === "stuck" || why === "limit") {
        await gh.applyExit(this.repo, rebaseBlock({ issue, pr, why, record: seen.stuck || seen.record, since: seen.since, notify: inputs.notify, stage: "merge" }), this.opts);
        return false;
      }
      if (!seen.already) await gh.prComment(this.repo, prNumber, rebaseNotice(issue, pr, seen.recent), this.opts);
    } catch (e) {
      return this.sendBackFailed(issue, pr, e, inputs, gh);
    }
    log(`#${issue}: PR #${prNumber} conflicts with ${pr.base?.ref || "the default branch"} after other PRs merged; sending it back to the worker to rebase`);
    const r = await this.work(issue, { wait: true });
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
    await gh.applyExit(this.repo, { issue, pr, exit: "blocked", reason, cause: "factory", notify: inputs.notify, stage: "merge" }, this.opts).catch((x) => log(`#${issue} Block: ${String(x?.message || x).slice(0, 160)}`));
    return false;
  }

  /** A review re-run on its own (a human re-applied factory:review), in the Objective's clone. */
  async runReview(prNumber, { wait = false } = {}) {
    const pr = await getPr(this.repo, prNumber, this.opts);
    const issue = Number(/^factory\/(\d+)$/.exec(pr.head?.ref || "")?.[1]);
    if (!issue) throw new Error(`PR #${prNumber} is not on a factory/<issue> branch`);
    return this.withClaim(issue, () => this.review(issue, prNumber, { wait }));
  }

  /**
   * Open PRs labelled factory:review whose Objective is routed here and held by no loop: the label is the review trigger,
   * as on Actions. Not a draft PR (a Question or a Block: the reviewer waits for a person) nor a Blocked Objective's.
   * A Question's PR a person marked ready (#339) is one too, as the Action's ready_for_review event makes it: out of
   * draft, its issue still a Question, marked ready after the Question was asked (readyAfter). The review applies the
   * answer; with none since the Question, a body still asking a `QUESTION:` makes it a Question again (review.mjs readyMark).
   */
  async pendingReviews() {
    const prs = (await rest(`repos/${this.repo.full}/pulls?state=open&per_page=100`, { ...this.opts, paginate: true }).catch(() => [])) || [];
    // Conditional reads (a 304 for an unchanged page is not counted): the Questions, only when a PR may be one's.
    const cached = { ...this.opts, cache: (this.timelines ??= new Map()) };
    const questions = prs.some(readyIssue) ? new Map(((await listIssuesByLabel(this.repo, "factory:question", cached).catch(() => [])) || []).map((i) => [i.number, i])) : new Map();
    const out = [];
    for (const pr of prs) {
      const asked = questions.get(readyIssue(pr)) ?? null;
      const issue = reviewIssue(pr) || asked?.number || 0;
      if (!issue) continue;
      const data = asked ?? (await getIssue(this.repo, issue, this.opts).catch(() => null));
      // A stopped Objective (its label removed, its issue closed: stop.mjs) gets no review.
      if (!data || isBlocked(data) || stopCause(data, this.objectiveLabel()) || !BACKENDS.local.trigger.routes(data, this.baseEnv())) continue;
      if (asked) {
        const askedAt = await objectiveLabeledAt(this.repo, issue, "factory:question", cached).catch(() => null);
        if (!readyAfter(askedAt ? await timelineOf(this.repo, pr.number, cached).catch(() => []) : [], askedAt)) continue;
      }
      if ((await localClaim(this.repo, issue, this.opts).catch(() => null))?.fresh) continue;
      out.push({ issue, pr: pr.number, labels: data.labels || [], updatedAt: data.updated_at ?? null });
    }
    return out;
  }

  /** --wait: follow the PR through the merge queue, then do the bookkeeping the dispatcher does on a merge. */
  async followMerge(issue, prNumber, { timeoutMs = 120 * 60_000, pollMs = 60_000 } = {}) {
    const until = Date.now() + timeoutMs;
    const inputs = resolveInputs({ args: { repo: this.repoFull }, env: this.baseEnv() });
    const queue = await hasMergeQueue(this.repo, this.opts).catch(() => true);
    // The hung-check bound, read once for this follow rather than every poll; with no Actions token here (the local
    // App has no Actions permission), the merge pass judges a queue check by that time bound only (session.mjs hangsOn).
    const hungMs = queue ? await queueBoundMs(this.repo, this.opts) : null;
    const cache = {};
    while (Date.now() < until && !this.stopping) {
      // The merge pass the dispatcher runs (session.mjs mergeReadyOne): this loop holds the Objective, so it runs it.
      if (inputs.autoMerge) {
        const report = {};
        const how = await mergeReadyOne(this.repo, { issue, prNumber, queue, checkNames: inputs.ciChecks, report, hungMs, cache, objectiveLabel: inputs.objectiveLabel, thirdParty: inputs.thirdPartyReviewers }, this.opts).catch((e) => log(`#${issue} merge: ${e.message.slice(0, 160)}`));
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
          log(`#${issue}: a person took PR #${prNumber} out of the merge queue; Factory leaves it to them`);
          return false;
        }
        if (how === "re-review" || how === "unread" || how === "code-scanning" || how === "queue-red") return this.review(issue, prNumber, { wait: true }).then((r) => (r.next ? "next" : r.exit === "delivered"));
        if (how === "conflict") {
          const sent = await this.sendBack(issue, prNumber, inputs);
          if (sent !== "retry") return sent;
        }
      }
      const pr = await getPr(this.repo, prNumber, this.opts).catch(() => null);
      if (pr?.merged_at) {
        const project = await findProject(this.repo, this.opts).catch(() => null);
        // A split part: the issue stays open and the next part starts from the default branch (handoff.mjs nextPart).
        const next = await nextPart(this.repo, issue, this.opts).catch(() => null);
        await setStateLabel(this.repo, issue, next === "cap" ? "blocked" : null, this.opts).catch(() => {});
        if (project) await moveCard(project, this.repo, issue, next === "next" ? "Queued" : next === "cap" ? "Blocked" : "Done", this.opts).catch(() => {});
        log(`#${issue}: PR #${prNumber} merged; ${next === "next" ? "the next part is queued" : next === "cap" ? `split into ${MAX_PARTS} PRs with work left: Blocked` : "card Done"}`);
        return next === "next" ? "next" : true;
      }
      if (pr?.state === "closed") {
        log(`#${issue}: PR #${prNumber} closed without a merge`);
        return false;
      }
      await this.pause(pollMs);
    }
    if (this.stopping) return false;
    log(`#${issue}: stopped following PR #${prNumber} after ${Math.round(timeoutMs / 60000)} min`);
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
   * with nothing started. A read that gets through also names the organization FACTORY_* variables shared with the
   * repository, which Factory does not take (inputs.mjs organizationVariablesLine).
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
      this.token = localToken(this.repoFull) || this.token;
      state = await this.readVariables();
    }
    if (state !== "read") return;
    const org = organizationVariablesLine(await organizationVariableNames(this.repo, { token: this.token }));
    if (org) log(org);
  }

  /**
   * The repository's settings as they are now, read at each serve tick (#276, #284): the default branch's workflow and
   * the repository's variables over it (readVariables). Only HOT_SETTINGS (caps, models and effort, validation, resume
   * policy, cache TTL) apply while serve runs: from that tick, to this loop's limit, the dispatcher's caps and every stage
   * that starts from then on, never to a stage in flight or being set up, and said once, by name, with the layer each
   * comes from when a variable is involved. Every other setting (what a stage may reach or receive, budgets, maintainers,
   * protected paths, the harness, setup) keeps its value from serve's start until serve starts again, said once. The
   * read also brings the workflow's Factory pin (followPin).
   */
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
    const harnessOf = (wf) => String(wf.FACTORY_HARNESS || "claude").trim().toLowerCase();
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
    this.from = hotFrom;
  }

  /**
   * The workflow's Factory pin against the Factory this serve runs (#276), at each tick. A new release tag or commit
   * SHA there is taken at a stage boundary: serve fetches it from Factory's own repository (lib/release.mjs), starts no
   * new stage meanwhile, and once no stage runs here starts again on it in this same process (restartOn), which resumes
   * this loop's paused work. Only a serve that runs a release follows it (a checkout at its own release tag, or one serve
   * fetched): one started from any other checkout, a branch or a change of your own, keeps running what you started, and
   * says the pin differs. Never an older release (pinDecision, releaseCheckout). A switch starts at most once in
   * SWITCH_GAP_MS. Said once per pin. Returns true while new stages wait for the switch.
   */
  async followPin(inFlight, { once = false } = {}) {
    this.factory ??= runningFactory();
    const name = runningName(this.factory);
    const d = pinDecision(this.pins, this.factory);
    const ref = d.follow ? d.ref : null;
    if (this.repin && this.repin.ref !== ref) {
      log(`clockgrove/factory@${this.repin.ref} is no longer the workflow's pin: serve stays on ${name}`);
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
    if (once) return note(`the workflow on ${where} pins clockgrove/factory@${ref}; this serve runs ${name}; a serve that keeps running takes the pin, --once does not`);
    if (!this.factory.release) return note(`the workflow on ${where} pins clockgrove/factory@${ref}; this serve runs ${name} from ${this.factory.root}, which is not a release checkout, so it keeps running that: start serve from ${ref} to run it`);
    if (this.repin?.state === "failed" && Date.now() >= this.repin.retryAt) this.repin = null;
    // Counted from the last switch this process made (restartOn), never from a try that did not switch.
    if (!this.repin && Date.now() - (this.switchedAt || 0) < SWITCH_GAP_MS) return note(`the workflow on ${where} pins clockgrove/factory@${ref}; serve switched releases less than ${Math.round(SWITCH_GAP_MS / 60_000)} minutes ago, so it takes this pin from ${new Date(this.switchedAt + SWITCH_GAP_MS).toISOString()} and runs ${name} until then`);
    if (!this.repin) {
      log(`the workflow on ${where} pins clockgrove/factory@${ref}; this serve runs ${name}. It fetches ${ref} from ${RELEASES_URL} and starts no new stage meanwhile; ${inFlight ? `once the ${inFlight} stage(s) in flight here end` : "once fetched"}, serve runs on ${ref}`);
      const r = (this.repin = { ref, state: "fetching" });
      r.fetch = releaseCheckout(ref, { ...this.releaseOpts, running: this.factory })
        .then(async (c) => {
          const problem = await startProblem(c.dir);
          if (problem) throw new Error(problem);
          r.checkout = c;
          r.state = "ready";
        })
        .catch((e) => {
          // An older commit than this one, or a SHA not on Factory's main: never tried again until the pin changes.
          r.state = e?.code === "older" || e?.code === "refused" ? "refused" : "failed";
          r.retryAt = Date.now() + PIN_RETRY_MS;
          if (this.repin !== r) return;
          if (r.state === "refused") log(`${String(e.message).slice(0, 300)}; serve keeps running ${name}`);
          else log(`clockgrove/factory@${ref} could not be taken (${String(e?.message || e).slice(0, 300)}); serve goes on with ${name} and tries again in ${Math.round(PIN_RETRY_MS / 60_000)} minutes`);
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
      log(`this Node (${process.version}) cannot start serve again in its own process (process.execve needs Node 22.15 or newer): serve goes on with ${runningName(this.factory)}; restart it with ${join(r.checkout.dir, "plugin", "bin", "factory")} serve to run clockgrove/factory@${r.ref}`);
      return false;
    }
    const problem = checkoutProblem(r.checkout);
    if (problem) {
      r.state = "failed";
      r.retryAt = Date.now() + PIN_RETRY_MS;
      log(`the checkout of clockgrove/factory@${r.ref} at ${r.checkout.dir} changed since serve fetched it (${problem}); serve does not run it, goes on with ${runningName(this.factory)} and fetches it afresh in ${Math.round(PIN_RETRY_MS / 60_000)} minutes`);
      return false;
    }
    log(`no stage runs here: serve starts again on clockgrove/factory@${r.ref} from ${r.checkout.dir}, in this process; it resumes the Objectives this loop holds paused`);
    const env = { ...process.env, [SWITCHED_ENV]: String(Date.now()), [SWITCHED_FROM_ENV]: this.factory?.root || "" };
    // The new release's skills and agents, from beside its own scripts.
    delete env.FACTORY_PLUGIN_ROOT;
    try {
      (this.execve ?? process.execve)(process.execPath, [process.execPath, ...process.execArgv, script, ...process.argv.slice(2)], env);
    } catch (e) {
      r.state = "manual";
      log(`serve could not start again on clockgrove/factory@${r.ref} (${String(e?.message || e).slice(0, 200)}): it goes on with ${runningName(this.factory)}; restart it with ${join(r.checkout.dir, "plugin", "bin", "factory")} serve`);
    }
    return false;
  }

  /** Where this loop reads the machine's budget, slots and load: the user's home and /proc, or a test's own. */
  machinePlaces() {
    const home = this.machine?.home ?? homedir();
    return { home, dir: slotsDir(home), proc: this.machine?.proc ?? "/proc" };
  }

  /**
   * The machine's room for this loop's new starts now (lib/machine.mjs machineRoom), with its cap: FACTORY_LOCAL_MAX_CONCURRENT,
   * else the machine's budget. A budget setting that cannot be used is said once.
   */
  machineBox(running) {
    const { home, dir, proc } = this.machinePlaces();
    const budget = machineBudget({ home });
    if (budget.problem && budget.problem !== this.saidBudget) log(`machine budget: ${budget.problem}; using ${budget.stages}, from this machine's size`);
    this.saidBudget = budget.problem;
    const cap = loopCap(process.env.FACTORY_LOCAL_MAX_CONCURRENT ?? this.wf.FACTORY_LOCAL_MAX_CONCURRENT, budget.stages);
    let held = 0;
    try {
      held = slotHolders(dir).length;
    } catch (e) {
      this.slotTrouble(e);
    }
    return { ...machineRoom({ running, cap, budget: budget.stages, held, pressure: readPressure({ root: proc }) }), cap, from: budget.from, file: budget.file, dir };
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
   * The slot of a stage of `factory run` or `review` (stage()): such a loop holds no other, so it takes one whatever the
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
  async serve({ once = false, intervalMs = 30_000 } = {}) {
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
    log(`machine budget: ${first.budget} Objective stage(s) at once on this machine, shared by every Factory loop here (${first.from === "setting" ? first.file : "from its CPU threads and memory"}); this loop: at most ${Math.min(first.cap, first.budget)}${first.cap > first.budget ? `, the budget (FACTORY_LOCAL_MAX_CONCURRENT ${first.cap} is above it)` : " (FACTORY_LOCAL_MAX_CONCURRENT)"}`);
    this.factory ??= runningFactory();
    log(`serve runs Factory ${runningName(this.factory)} from ${this.factory.root}`);
    // A release checkout serve fetched stays while this process runs from it: no serve on this machine prunes it.
    markInUse(this.factory.root, this.releaseOpts);
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
    while (!this.stopping) {
      if (refused !== null) {
        const now = localToken(this.repoFull);
        let fresh = now && now !== refused && now !== tried ? await checkToken(this.repoFull, now).then(() => true, (e) => log(`the new token in ${tokenSource(this.repoFull)} is not taken: ${e.message.slice(0, 200)}`)) : false;
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
      // The workflow as the default branch has it now: its settings, and its Factory pin, taken at this stage boundary.
      await this.refreshSettings().catch((e) => log(`settings: ${e.message.slice(0, 160)}`));
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
      const inputs = resolveInputs({ args: { repo: this.repoFull }, env: { ...this.baseEnv(), FACTORY_INPUT_GITHUB_TOKEN: this.token } });
      // Failed starts whose holder was unknown: read their claims again once their backoff ends.
      await this.recheckStarts(running).catch((e) => log(`start recheck: ${e.message.slice(0, 160)}`));
      // The machine's room for new starts (machineBox): its budget, shared by every loop here, this loop's cap and the
      // machine's load. Each start takes its slot of the budget just before it is started or picked (takeSlots), and
      // holds it while it runs.
      const box = this.machineBox(running.size);
      // This loop's cap, read again at each tick from the settings as they are then (refreshSettings), said when it changes.
      const capNow = Math.min(box.cap, box.budget);
      if (capNow !== shownCap) log(`this loop: at most ${capNow} Objective stage(s) at once on this machine (${box.cap >= box.budget ? `the machine's budget${box.cap > box.budget ? `; FACTORY_LOCAL_MAX_CONCURRENT ${box.cap} is above it` : ""}` : "FACTORY_LOCAL_MAX_CONCURRENT"})`);
      shownCap = capNow;
      const slots = this.takeSlots(box, running);
      // This machine's paused work resumes first, then reviews (they finish work in flight); new work gets the rest.
      const waitLine = switching ? `no new stage until serve runs on clockgrove/factory@${this.repin?.ref}` : null;
      const paused = switching ? [] : await this.pausedHere(running);
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
      const reviews = switching ? [] : free.slice(0, slots.take(free.length));
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
      this.dispatching = dispatch(inputs, { token: this.token, notice: this.notice, localSlots: switching ? 0 : slots.left(), localTake: slots.take, localFull: waitLine || box.why || "this loop is at FACTORY_LOCAL_MAX_CONCURRENT", localHeld, localHold: (issue) => this.limitHold(issue.labels, issue.number, issue.updated_at ?? null), localStopped, localLive: (n) => !!liveStage(this.ws(n)), localStopping: () => !!this.stopping, localMarked: (n) => marked.push(n), thirdPartyReads: (this.thirdPartyReads ??= new Map()), readCache: (this.timelines ??= new Map()) }).catch(async (e) => {
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
      if (free.length > reviews.length && !switching) log(`${free.length - reviews.length} review(s) wait for a free slot on this machine`);
      // What holds new starts on this machine, said once: here, unless the dispatcher's reason (localFull) says it already.
      const hold = box.why && result.reason !== box.why ? `; holding new starts: ${box.why}` : "";
      log(`tick: ${picks.length ? `starting ${picks.map((n) => `#${n}`).join(", ")}` : "nothing ready"}${holding.length ? `; holding ${holding.map((s) => `#${s.number} (${s.reason})`).join(", ")}` : ""}${reviews.length ? `; reviewing ${reviews.map((r) => `PR #${r.pr}`).join(", ")}` : ""}${result.reason ? ` (${result.reason})` : ""}${waitLine && result.reason !== waitLine ? `; ${waitLine}` : ""}${hold}; ${running.size} in flight here, $${Number.isFinite(result.spentToday) ? result.spentToday.toFixed(2) : "?"} spent today`);
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

/** One account's holds as `factory hold` says them (holds.mjs list's entry), at `now`: `state` alone, its state's words. */
export function holdText(h, now, { state = false } = {}) {
  const iso = (ms) => new Date(ms).toISOString();
  const parts = [];
  if (h.until !== null) parts.push(`${h.until > now ? `held until ${iso(h.until)}${h.window ? ` (${h.window})` : ""}` : `hold ended ${iso(h.until)}`}, back-off count ${h.streak}`);
  if (h.guess) parts.push(`${h.guess.until > now ? `passed over until about ${iso(h.guess.until)}` : `guess ended ${iso(h.guess.until)}`} (no reset reported), ${h.guess.streak} in a row`);
  return state ? parts.join("; ") : `${h.account} (${HARNESS_NAMES[h.harness] || h.harness}): ${parts.join("; ")}`;
}

/**
 * `factory hold list | release <account> [--repo OWNER/NAME]` (#376): the usage-limit holds this machine's serves share
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
      err(`factory: the release could not be written to ${holdsDir(home)} (${String(failed?.message || failed).slice(0, 160)}); nothing was released\n`);
      return 1;
    }
  }
  if (!released) {
    err(`factory: nothing is held or passed over for ${JSON.stringify(account)} ${where}; ${known.length ? `the accounts that are: ${known.join(", ")}` : "no account is"}\n`);
    return 1;
  }
  if (refused) {
    err(`factory: the release of ${account} was posted on ${repo.full}#${issue}, Factory's holds issue, but it will not count: ${refused}; delete that comment, and release it again with a token of a person who can push\n`);
    return 1;
  }
  out(`released ${released.account} (${HARNESS_NAMES[released.harness] || released.harness}), which was ${holdText(released, now, { state: true })}\n${repo ? "the next stage on GitHub Actions or the cloud sandbox may start on it, when its workflow pins this Factory release or later; a job on an earlier release still holds it until its reset" : `every serve on this Factory release or later on this machine may start on it at its next tick, and an Objective paused on it resumes then; a serve on an earlier release still holds it until its reset: restart that serve on this release for it to see the release`}\n`);
  return 0;
}

/**
 * The token for Factory's own writes from a session (`deliver`, `post-review`): the local token when set up, else the
 * developer's gh login. These commands run no model, so the writes are Factory's, made on the developer's behalf.
 */
function sessionToken(repoFull) {
  const t = localToken(repoFull);
  if (t) return t;
  try {
    return sh("gh", ["auth", "token"]);
  } catch {
    throw new Error(`no token: save one for local mode (${tokenFile(repoFull)}) or log in with gh`);
  }
}

/** The clone a session command (`issue`, `deliver`, `post-review`) runs in: its top directory, repository and token. */
function sessionClone(flags) {
  const dir = realpathSync(sh("git", ["-C", resolve(flags.checkout || process.cwd()), "rev-parse", "--show-toplevel"]));
  const repoFull = flags.repo || repoFromRemote(sh("git", ["-C", dir, "remote", "get-url", "origin"]));
  if (!repoFull) throw new Error("no GitHub origin remote; pass --repo OWNER/NAME");
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
  const committed = await gitIn(dir, ["show", `origin/${defaultBranch}:.github/workflows/factory.yml`]).then((r) => workflowSettings(workflowEnv(r.stdout)).kept, () => ({}));
  const inputs = resolveInputs({ args: { repo: repoFull }, env: { ...process.env, ...committed } });
  await primeWriters(repo, opts, { maintainers: inputs.maintainers });
  return { defaultBranch, inputs };
}

/** Where `factory issue` writes the issue for a session by default, and where `deliver` reads what the session was given. */
const sessionIssueFile = (dir) => join(process.env.FACTORY_IN || resolve(dir, sh("git", ["-C", dir, "rev-parse", "--git-dir"]), "factory-in"), "issue.md");

/** A session's refusal of an issue whose author or last editor cannot vouch for it: the Blocked notice's words. */
const untrustedRefusal = (t, what) => new Error(`${what}: ${t.reason}. ${t.fix}`);
/** A draft (factory:draft) is run on no route, a session's included (lib/stop.mjs stopCause): the refusal and its fix. */
const draftRefusal = (issue, what) => new Error(`${what}: #${issue} is a draft (${DRAFT_LABEL}), which Factory never runs; start it first (take ${DRAFT_LABEL} off and apply the Objective label, or ask "Start Clockgrove Factory Objective ${issue}")`);

/**
 * `factory issue <issue> [--out FILE]`: the issue as a session reads it (/factory:factory-run --here, /factory:factory-review), written
 * to --out (default $FACTORY_IN/issue.md, else <git dir>/factory-in/issue.md) as the worker writes it: the title and
 * body read with their author and last editor, only when both can push or are pinned maintainers. Otherwise nothing is
 * written, the reason and its fix go to stderr, and the exit code is 1: the body never reaches the session. Without
 * --out, also plan.md beside it: the plan comment, only when the plan was made from this text (else none, and an
 * earlier one is removed). Writes nothing to GitHub.
 */
async function issueForSession(issue, flags) {
  const clone = sessionClone(flags);
  await sessionInputs(clone);
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
  const { posted, state } = planFile ? await planStateNow(clone.repo, issue, t, clone.opts) : {};
  mkdirSync(resolve(file, ".."), { recursive: true });
  writeFileSync(file, inFiles({ issue, issueTitle: t.issueData.title, issueBody: t.issueData.body })["issue.md"]);
  log(`#${issue}: written by ${t.people.map(([role, login]) => `${role} ${login}`).join(", ")}; ${file}`);
  // A foundation Objective (`factory:foundation`, vouched for as the review job vouches for it): its review has two passes.
  const found = await foundationTrusted(clone.repo, issue, t.labels, clone.opts);
  if (!found.ok) log(`#${issue}: ${found.reason}. ${found.fix} Until then post-review posts no review for it.`);
  else if (found.foundation) log(`#${issue}: a foundation Objective (factory:foundation): its review runs the foundation pass too`);
  if (!planFile) return 0;
  const plan = state === "same" ? (posted.text ?? null) : null;
  if (plan !== null) writeFileSync(planFile, plan);
  log(plan !== null ? `#${issue}: its plan in ${planFile}` : state === "unplanned" ? `#${issue}: no plan yet` : `#${issue}: the plan comment was not made from this text, so no plan.md: plan from the issue`);
  return 0;
}

/**
 * `factory deliver <issue>`: Factory's half of an Objective worked in a session (/factory:factory-run --here). The session
 * committed on factory/<issue> in this clone and left its hand-off files in --out (default <git dir>/factory-out);
 * Factory checks the issue's author and last editor (objective-trust.mjs: a Block, nothing pushed, when either cannot
 * vouch for it), checks the protected paths, pushes, opens or updates the PR from pr.md, posts the plan comment, the
 * replies and the note, and applies the exit record. Returns the process exit code.
 */
async function deliver(issue, flags) {
  const clone = sessionClone(flags);
  const { dir, repo, opts } = clone;
  const branch = `factory/${issue}`;
  const current = sh("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"]);
  if (current !== branch) throw new Error(`the clone is on ${current}; deliver runs on ${branch}`);
  // Run from a session (/factory:factory-run --here), so the App's key is not read here: notices post with this token.
  if (process.env.FACTORY_LOCAL_APP_ID) log("notices post with your own token here, so their @mention notifies no one; the App posts them only for serve and run");
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
  // The text the session planned from is the issue.md `factory issue` gave it: changed since, nothing is delivered, and
  // the session reads the issue again. That text is the plan's record (objective-trust.mjs planGate); with no issue.md
  // here (written elsewhere with --out), the plan comment keeps the record it has (handoff.mjs planSync).
  const given = (() => {
    try {
      return readFileSync(sessionIssueFile(dir), "utf8");
    } catch {
      return null;
    }
  })();
  if (given !== null && settled(given) !== settled(inFiles({ issue, issueTitle: issueData.title, issueBody: issueData.body })["issue.md"])) throw new Error(`nothing was delivered: the Objective's title or body changed after this session read it; run \`factory issue ${issue}\` again and make the plan again from the new text`);
  const planRecord = given === null ? null : { sha256: trusted.sha, label: labeledAt };
  const out = resolve(flags.out || process.env.FACTORY_OUT || resolve(dir, sh("git", ["-C", dir, "rev-parse", "--git-dir"]), "factory-out"));
  const { files, refused } = await readOut({ out }, process.env);
  if (refused.length) log(`hand-off files refused: ${refused.join(", ")}`);
  const record = exitFromOut(files) || { exit: "blocked", reason: "the session left no exit record ($FACTORY_OUT/exit.json)", questions: [] };
  // An issue body or a plan that needs another repository is the owner's Question (one-repo.mjs): the plan comment and
  // the Question go up, and nothing is pushed. As in the worker, a repository a maintainer has answered about since
  // Factory asked (its own progress record, written as this token's login) is not asked again, and the ask is recorded
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
    // A `--here` run is unmetered (skills/factory-score): its comment carries no spend line.
    if (needs.repos.length) await progressReporter(repo, issue, opts, { stage: "work", soFar: null }).planAsked(needs.repos);
    log(`#${issue}: question at plan time (${planNeeds}); nothing pushed`);
    return 1;
  }
  // A Question that names no test of the Question rule is checked in the session before anything is delivered.
  if (record.unfounded?.length) throw new Error(`nothing was delivered: ${questionCheckPrompt(record, { file: true })} Then run deliver again.`);
  // Factory's push (lib/outbox.mjs): checked in its own mirror (protected paths, Git LFS), leased, read back.
  const tmp = privateTmp({ ...process.env });
  // The session's workflow hand-over (handoff.mjs handoverChecker), checked in Factory's mirror once the branch is up.
  let handover;
  let ahead = 0;
  try {
    const outbox = await openOutbox({ branch, defaultBranch, checkout: dir, remote: `https://github.com/${repo.full}.git`, token: () => opts.token, agentEnv: process.env, local: true, protectedList: protectedPaths(inputs.protectedAdditions), base: tmp.factory });
    // A merge Factory makes itself here (the default branch's workflow change, an unsynced checkout) carries the
    // identity of the token that pushes it, as on every other route.
    outbox.author = commitAuthor(await gitIdentity(null, opts.token));
    if (!(await outbox.push())) throw new Error(`nothing was delivered: ${outbox.error}`);
    const checker = handoverChecker(() => files, outbox);
    handover = await checker.now();
    if (checker.refused()) throw new Error(`the branch is pushed, nothing else was delivered: ${checker.refused()}; fix it and run deliver again`);
    ahead = (await outbox.delta()).count;
  } finally {
    dropOwned(tmp.factory);
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
  const toAnswer = await unaddressedReviewComments(repo, pr.number, null, { ...opts, reviewIds: null }).catch(() => []);
  const replied = await postReplies(repo, pr.number, issue, files["replies.json"], toAnswer.map((c) => c.id), opts);
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

/** Why pushing a handed-over workflow waits for a person's read. */
export const HANDOVER_RISK = "a workflow runs with the repository's secrets, and one that runs `on: push` runs as soon as its branch is pushed";

/**
 * The body of the pull request `factory handover <issue> --push` opens: it names the Objective (Refs, not Closes: the
 * Objective's own PR closes it), links Factory's hand-over comment, and says the person read the change before pushing.
 */
export function handoverPrBody({ issue, url = "" }) {
  return [
    `Refs #${issue}`,
    "",
    `The workflow change Factory handed over for #${issue}: Factory never pushes a workflow file, so a person applies it. ${url ? `Factory's hand-over comment: ${url}` : `Factory's hand-over comment is on #${issue}.`}`,
    "",
    `The person who pushed this branch reviewed the workflow change before pushing it: \`factory handover ${issue}\` staged and showed it, and \`factory handover ${issue} --push\` committed and pushed it only once the staged change was exactly that hand-over.`,
  ].join("\n");
}

/** The job token's login on Actions: any workflow can post as it, so it never hands a workflow over. */
const JOB_TOKEN_LOGIN = "github-actions[bot]";

/**
 * The hand-over `factory handover` may apply, or a refusal (an Error whose message says why; nothing is changed then).
 * The comment's author is trusted directly, and must also have applied `factory:handover` at some time (another
 * login's labelling, a triager's relabel included, neither adds nor takes away trust). Trusted are only:
 *  - the Factory App this person names (`appId`: --app or FACTORY_LOCAL_APP_ID; it is the repository's
 *    FACTORY_APP_ID), known by GitHub's own `performed_via_github_app` on the comment (that id, and the author being
 *    that App's `<slug>[bot]`). An App's comment is never trusted without the id, and the comment's own App id is never
 *    offered as the value to pass;
 *  - a person (no `[bot]` login) whose repository permission, read from GitHub now, is write, maintain or admin; local
 *    mode's operator, who posts Factory's comments, is one.
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
      if (!id) return { why: `the hand-over comment is from the GitHub App ${app.slug}, not verified: name your Factory App's id with --app ID (or FACTORY_LOCAL_APP_ID); it is the repository's FACTORY_APP_ID, shown on the App's settings page` };
      if (String(app.id) !== id) return { why: `the hand-over comment is from the GitHub App ${app.slug}, not your Factory App (id ${id})` };
      if (login !== `${app.slug}[bot]`) return { why: `the hand-over comment came through your Factory App (id ${id}), but its author ${login} is not that App's bot` };
      return { who: `the Factory App ${login} (id ${id})` };
    }
    if (/\[bot\]$/i.test(login)) return { why: `the hand-over comment is ${login}'s, a bot that is not the Factory App you named` };
    let permission;
    try {
      permission = await collaboratorPermission(repo, login, opts);
    } catch (e) {
      throw refuse(`${login}'s permission on ${repo.full} could not be read (${String(e?.message || e).slice(0, 120)}), so the hand-over comment is not trusted`);
    }
    if (!HANDOVER_WRITERS.has(permission)) return { why: `${login}, who wrote the hand-over comment, cannot write to ${repo.full} (${permission || "no access"}); only Factory's App or someone who can write hands a workflow over` };
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
 * `factory handover <issue> [--push] [--app ID]`: a person applies Factory's workflow hand-over (handover.mjs) in their
 * clone, in two steps. The first takes the hand-over trustedHandover accepts, says whose it is, checks it again here as
 * Factory did (outbox.mjs checkHandover, against the default branch as fetched now), puts git's own result on a new
 * branch `factory-workflow/<issue>` from the default branch (or, when that fails, leaves the clone as it was), shows
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
    process.stderr.write(`factory handover: ${why}\n`);
    return 1;
  };
  const check = async (patch, tree, against) => {
    const scratch = mkdtempSync(join(tmpdir(), "factory-handover-"));
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
    trusted = await trustedHandover(repo, issue, opts, { appId: flags.app ?? process.env.FACTORY_LOCAL_APP_ID ?? "" });
  } catch (e) {
    if (!e.refusal) throw e;
    return fail(`${e.message}; nothing was changed here`);
  }
  log(`#${issue}: the hand-over is ${trusted.who}'s comment${trusted.url ? ` (${trusted.url})` : ""}`);
  if (flags.push) {
    const on = (await git(["symbolic-ref", "--short", "-q", "HEAD"])).stdout.trim();
    if (on !== branch) return fail(`run it on ${branch}, after \`factory handover ${issue}\` put the change there and you read it`);
    // The staged change must be exactly the hand-over as checked on this branch's commit, which step one showed.
    const checked = await check(trusted.patch, "HEAD", branch);
    if (!checked.ok) return fail(`the hand-over ${checked.problem}; nothing was pushed`);
    const staged = await git(["diff-index", "--cached", "-p", "--no-renames", "--no-ext-diff", "--no-textconv", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", "HEAD"]);
    if (staged.code !== 0 || staged.stdout !== checked.patch) return fail(`what is staged on ${branch} is not the hand-over as shown; nothing was pushed. Start again: switch back, delete ${branch} and run \`factory handover ${issue}\``);
    if ((await git(["diff", "--name-only"])).stdout.trim()) return fail(`${branch} has unstaged changes; nothing was pushed`);
    const title = `#${issue}: the workflow change Factory handed over`;
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
  log(`Read the diff above before you push it: ${HANDOVER_RISK}. When you have, run \`factory handover ${issue} --push\` to commit it, push ${branch} and open its pull request.`);
  return 0;
}

/**
 * The review `factory post-review` posts from a findings file's text, or a throw when the file is no reviewer pass: it
 * holds no reviewer JSON, or it judges none of the issue's acceptance entries (handoff.mjs reviewMissed). On a foundation
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
  if (reviewMissed({ review, entries })) throw new Error(`${file} judges none of the issue's acceptance entries (${entries.map((e) => e.id).join(", ")}); nothing posted`);
  const pass = whole && typeof whole === "object" && !Array.isArray(whole) ? whole.foundation : undefined;
  if (foundation && !Array.isArray(pass?.comments)) throw new Error(`${file} holds no foundation pass ("foundation": {"comments": [...]}), which #${issue}'s factory:foundation label asks for; nothing posted`);
  if (!foundation && pass !== undefined) throw new Error(`${file} holds a foundation pass, but #${issue} is not a foundation Objective (no trusted factory:foundation label); nothing posted`);
  return reviewPost({ issue, review, diff, entries, foundation: foundation ? { comments: pass.comments, acceptance: null, parsed: true } : null });
}

/**
 * `factory post-review <pr> <findings.json>`: post a reviewer pass made in a session (/factory:factory-review) as Factory's one
 * comment-only review (handoff.mjs reviewPost): the findings fitted to the diff and their text sanitised, a comment for
 * each entry judged not met without one, the judgments in the body, under the review marker.
 */
async function postFindings(prNumber, file, flags) {
  const clone = sessionClone(flags);
  const { dir, repo, opts } = clone;
  const pr = await getPr(repo, prNumber, opts);
  const issue = Number(/^factory\/(\d+)$/.exec(pr.head?.ref || "")?.[1]);
  if (!issue) throw new Error(`PR #${prNumber} is not on a factory/<issue> branch`);
  // The review job's check: a review judged against text no writer vouches for is not posted.
  await sessionInputs(clone);
  const trusted = await trustedIssue(repo, issue, await getIssue(repo, issue, opts), opts);
  if (!trusted.ok) throw untrustedRefusal(trusted, "nothing posted");
  // The review job's second check: a review of code made from earlier text than the Objective's now is not posted.
  if ((await planStateNow(repo, issue, trusted, opts)).state === "changed") throw new Error(`nothing posted: ${EDITED_REASON}`);
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
    const history = await scratchHistory({ remote: `https://github.com/${repo.full}.git`, token: () => opts.token, objects, base: tmp.factory }).catch(() => null);
    const prd = await prDiff(repo, pr, opts, { diffOf: history ? (base, head) => mirrorDiff(history.git, base, head, { mergeBase: true, maxBytes: 256 * 1024 * 1024 }) : null });
    if (prd.source !== "history") log(`PR #${prNumber}'s diff came from GitHub's files API (local history: ${prd.historyError})${prd.unlisted ? `; ${prd.unlisted} file(s) are past the API's listing` : ""}`);
    diff = prd.text;
  } finally {
    dropOwned(tmp.factory);
  }
  const post = reviewPostFor({ issue, text: readFileSync(file, "utf8"), file, diff, entries: acceptanceEntries(trusted.issueData.body), foundation: found.foundation });
  const { comments } = post;
  const posted = await postReview(repo, prNumber, { body: post.body, comments, commitId: pr.head.sha }, opts);
  log(`PR #${prNumber}: review posted with ${comments.length} comment(s)${posted.moved ? `; ${posted.moved} moved to a line GitHub takes` : ""}${posted.inBody ? `; ${posted.inBody} in the review body${posted.retried ? ` (GitHub answered ${posted.retried} to the line comments)` : " (no line GitHub can take)"}` : ""}`);
  return 0;
}

/**
 * `factory wait [<issue>...]` (lib/wait.mjs): one JSON line per event on the queue, read from GitHub, so it tells every
 * route's Objectives with or without `serve`. The repository from --repo, else the clone's origin; the local token,
 * else the gh login (it only reads). A spent rate limit or this machine's network waits, as serve's do, within --timeout.
 * Stdout carries only the events; log lines go to stderr.
 */
async function waitForQueue(flags) {
  const repoFull = flags.repo || repoFromRemote(sh("git", ["-C", resolve(flags.checkout || process.cwd()), "remote", "get-url", "origin"]));
  if (!repoFull) throw new Error("no GitHub origin remote; pass --repo OWNER/NAME");
  // Stdout is the events, one JSON line each; Factory's log lines (a retry, a rate limit's wait) go to stderr.
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

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (e) {
    if (!e.usage) throw e;
    process.stderr.write(`factory: ${e.message}`);
    process.exit(64);
  }
  if (parsed.help) {
    process.stdout.write(usage(parsed.cmd));
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
    task = (async () => {
      let r = await local.runIssue(issue, { wait: !!flags.wait });
      // --wait on a split Objective: each part runs once the one before it merged.
      while (r.next) r = await local.runObjective(issue, { wait: true });
      return r;
    })();
    const r = await task;
    // Delivered, not followed to its merge: the last line says who tends it now.
    if (r.exit === "delivered" && !flags.wait) {
      const line = await local.pendingMergeLine(issue);
      if (line) log(line);
    }
    process.exitCode = r.exit === "delivered" ? 0 : 1;
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
    task = local.runReview(Number(arg), { wait: !!flags.wait });
    process.exitCode = (await task).exit === "delivered" ? 0 : 1;
    return;
  }
  if (cmd === "wait") {
    process.exitCode = await waitForQueue(flags);
    return;
  }
  if (cmd === "hold") {
    process.exitCode = await holdCommand(flags);
    return;
  }
  if (cmd === "serve") await (await new Local(flags).init({ serve: true })).serve({ once: !!flags.once, intervalMs: (flags.interval ?? 30) * 1000 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    process.stderr.write(`[factory] local: ${e.message}\n`);
    // Right after a switch to a new pinned release (restartOn): say so, and how to go back.
    if (SWITCHED_FROM) process.stderr.write(`[factory] local: serve stopped at the start of the release it switched to, ${PLUGIN_ROOT}, from ${SWITCHED_FROM}; start serve from ${join(SWITCHED_FROM, "plugin", "bin", "factory")} to run that one again\n`);
    process.exit(1);
  });
}
