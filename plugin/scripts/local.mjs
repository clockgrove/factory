#!/usr/bin/env node
// Factory local mode: the same worker and reviewer the Action runs, on a developer's own box.
//   node scripts/local.mjs run <issue> [--repo OWNER/NAME] [--dir CLONE] [--wait]
//   node scripts/local.mjs review <pr> [--wait]      (a review re-run, as re-applying factory:review does on Actions)
//   node scripts/local.mjs serve [--repo OWNER/NAME] [--dir CLONE] [--once] [--all] [--interval SECONDS (30)]
//   node scripts/local.mjs issue <issue> | deliver <issue> | post-review <pr> <findings.json>   (a session's route)
//   node scripts/local.mjs handover <issue> [--push] [--app ID]   (a person applies Factory's workflow hand-over: read it, then --push)
// Routing: an Objective labelled factory:local is the local loop's and the Actions path leaves it alone;
// serve takes only those unless --all (FACTORY_LOCAL_ALL=1). A claim comment with a heartbeat marks one in flight.
// Needs git, gh, the harness CLI (claude or codex logged in; copilot with a Copilot Requests token in
// COPILOT_GITHUB_TOKEN or ~/.config/factory/copilot-token, plus slirp4netns and iptables on Linux), srt
// (npm i -g @anthropic-ai/sandbox-runtime), ripgrep and, on Linux and WSL2, bubblewrap and socat; and a
// fine-grained token for this one repository, in FACTORY_LOCAL_TOKEN or ~/.config/factory/tokens/<owner>/<name>
// (contents, issues and pull requests read and write; actions read). That token is all the GitHub reach the
// model gets. No App needed (one in FACTORY_LOCAL_APP_ID posts the notices), no vendor, no API key; GitHub holds
// every piece of state, and the box holds one clone per Objective under <clone>/.factory/<issue>/. Factory's own setup, install and validation commands run in the
// same sandbox as the harness, since they run on a tree the model edited. A sandbox has no route to the box's
// services: with FACTORY_LOCAL_DB=1 every validation command runs through plugin/bin/factory-db, which starts a fresh
// Postgres inside the sandbox (init step: FACTORY_LOCAL_DB_INIT), and the task card tells the model to do the same.
import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, constants as osConstants, homedir, hostname, platform, tmpdir, totalmem, uptime } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { dispatch } from "./dispatch.mjs";
import { OUTAGE, minutesText, probe as probeHost, waitOutages } from "./lib/network.mjs";
import { PLUGIN_ROOT } from "./lib/checkout.mjs";
import { activeWorkIssues, addLabels, collaboratorPermission, ensureLabel, hasMergeQueue, findPr, findProject, getIssue, getPr, getPrSettled, listComments, listIssuesByLabel, moveCard, postReview, prComment, prDiff, primeSelf, primeWriters, removeLabel, repoOf, rest, setDraft, setStateLabel, transientError } from "./lib/github.mjs";
import { holdSecrets, input, log, redactSecrets, resolveInputs, workflowDriftLines, workflowSettings } from "./lib/inputs.mjs";
import { localSecretValues, parseSecretValues, parseWorkerSecrets } from "./lib/worker-secrets.mjs";
import { RELAY_SOCKET_DIR_ENV, dropSocketDir, handSocketDir, localRelayDir, readSocketDirRecord } from "./lib/worker-relay.mjs";
import { RELAYED_NAME } from "./lib/gateway-relay.mjs";
import { localCopilotRelayShim } from "./lib/relay-shim.mjs";
import { GROUP_RECORD, STOP_SIGNALS, exec, processRecord, reapRecorded, sameProcess, whichSync } from "./lib/proc.mjs";
import { HEARTBEAT_MS, LOCAL_DOMAINS, LOCAL_LABEL, claudeProjectLink, codexLocalConfig, copilotHomeFiles, copilotLocalSettings, copilotPrivateTmp, dropClaim, dropClaudeProjectLink, ensureHarnessHomes, gitDirChanged, gitIdentityKey, gitIdentityReason, gitPinFile, pinGitDir, readGitPin, harnessInstall, writeNestedGitScan, gitGuardScript, harnessOuterSettings, outerProbe, sandboxDroppedHosts, gatewayKeyProblem, localApp, localBaseEnv, localClaim, prepareClone, committedWorkflowEnv, readWorkflowEnv, staleGitLocks, stageTemp, sandboxStartProblems, srtSettings, stopHold, workflowEnv, writeBwrapTun, writeClaim } from "./lib/local.mjs";
import { REVIEW_LABEL, acceptanceEntries, clip, decideExit, parseReview, planAskedOf, protectedPaths, questionCheckPrompt, selfLogin } from "./lib/logic.mjs";
import { HANDOVER_WRITERS, MAX_PARTS, currentPlan, exitFromOut, handoverChecker, handoverOnIssue, inFiles, isSplitPart, nextPart, partsRecord, planSync, postNote, postReplies, publishPr, readOut, recordPart, reviewMissed, reviewPost } from "./lib/handoff.mjs";
import { applyExit, commitAuthor, gitIdentity, mergeBlockCause, mergeBlockReason, mergeReadyOne, queueBoundMs, mirrorDiff, objectiveDecisions, progressReporter, rebaseMarkers, rebaseNotice, rebasedTwiceBlock, unaddressedReviewComments } from "./lib/session.mjs";
import { checkHandover, openOutbox, scratchHistory } from "./lib/outbox.mjs";
import { HANDOVER_LABEL, WORKFLOWS_DIR, handoverBranch, handoverMarker, handoverOf, workflowName } from "./lib/handover.mjs";
import { appendOwn, dropOwned, privateTmp } from "./lib/fsafe.mjs";
import { git as gitIn } from "./lib/proc.mjs";
import { BACKENDS } from "./lib/backend.mjs";
import { bwrapShim, claudeEnvText, localTools } from "./lib/copilot-runner.mjs";
import { noticeMinter, serveNotices } from "./lib/app-token.mjs";
import { answeredRepos, declaredQuestion, planNeeds as planNeedsOf } from "./lib/one-repo.mjs";
import { localDatabaseChecks, noticeAppCheck } from "./doctor.mjs";
import { SKIP_SMUDGE_ENV, lfsPinEnv } from "./lib/lfs.mjs";
import { EDITED_REASON, authorGate, objectiveInputs, planStateNow, settled, startedAt, trustedIssue } from "./lib/objective-trust.mjs";
import { DRAFT_LABEL, isDraft, stopCause } from "./lib/stop.mjs";

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
const onPath = (bin) => whichSync(bin) !== null;
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
export const sandboxScanReason = "local mode: the sandboxes' scan for protected paths (ripgrep, sandbox-scan) failed its check on this machine; the local loop's log says why; check that `rg` on PATH runs";
const list = (v) => String(v || "").split(/[\s,]+/).filter(Boolean);

/**
 * Each command's arguments and flags: a flag is `bool` (takes no value), or takes one value named as usage shows it, a
 * positive number where `number` is set. An argument named `issue` or `pr` is a positive whole number.
 */
const WHERE = { repo: { value: "OWNER/NAME" }, dir: { value: "CLONE" } };
export const COMMANDS = {
  run: { args: ["issue"], flags: { ...WHERE, wait: "bool" }, about: "one Objective, from the stage its state calls for (with --wait, to merged)" },
  serve: { args: [], flags: { ...WHERE, once: "bool", all: "bool", interval: { value: "SECONDS", number: true } }, about: "a loop: the dispatcher's rules every --interval seconds (30)" },
  review: { args: ["pr"], flags: { ...WHERE, wait: "bool" }, about: "a review re-run" },
  issue: { args: ["issue"], flags: { ...WHERE, out: { value: "PATH" } }, about: "the issue as a session reads it" },
  deliver: { args: ["issue"], flags: { ...WHERE, out: { value: "PATH" } }, about: "Factory's half of an Objective worked in a session" },
  "post-review": { args: ["pr", "findings.json"], flags: WHERE, about: "post a session's reviewer pass" },
  handover: { args: ["issue"], flags: { ...WHERE, push: "bool", app: { value: "ID", number: true } }, about: "put Factory's workflow hand-over on a new branch and show it, then stop for you to read it (--push: commit, push and open its pull request)" },
};
const usageOf = (cmd) => `factory ${cmd} ${[...COMMANDS[cmd].args.map((a) => `<${a}>`), ...Object.entries(COMMANDS[cmd].flags).map(([k, t]) => `[--${k}${t === "bool" ? "" : ` ${t.value}`}]`)].join(" ")}`;
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
  const flags = { _: [cmd] };
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("-")) {
      flags._.push(a);
      continue;
    }
    const m = /^--([a-z-]+)(?:=(.*))?$/s.exec(a);
    const kind = m && Object.hasOwn(spec.flags, m[1]) ? spec.flags[m[1]] : null;
    if (!kind) throw fail(`unknown flag ${a} for ${cmd}`);
    const key = m[1];
    if (kind === "bool") {
      if (m[2] !== undefined) throw fail(`--${key} takes no value`);
      flags[key] = true;
      continue;
    }
    let value = m[2];
    if (value === undefined) {
      value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) throw fail(`--${key} needs a value`);
      i += 1;
    }
    if (kind.number) {
      const n = Number(value);
      if (!value.trim() || !Number.isFinite(n) || n <= 0) throw fail(`--${key} needs a positive number, not ${JSON.stringify(value)}`);
      flags[key] = n;
    } else flags[key] = value;
  }
  const given = flags._.slice(1);
  if (given.length !== spec.args.length) throw fail(given.length < spec.args.length ? `missing <${spec.args[given.length]}>` : `unexpected argument ${JSON.stringify(given[spec.args.length])}`);
  spec.args.forEach((name, i) => {
    if (name !== "issue" && name !== "pr") return;
    const n = Number(given[i]);
    if (!/^\d+$/.test(given[i]) || !Number.isSafeInteger(n) || n <= 0) throw fail(`<${name}> must be a number, not ${JSON.stringify(given[i])}`);
  });
  return { cmd, flags };
}

/** OWNER/NAME from the clone's origin remote. */
/**
 * How many Objective stages (work or review) this box runs at once: FACTORY_LOCAL_MAX_CONCURRENT, else a quarter of
 * its CPU threads and at most one per 8 GB of memory (each stage runs a harness, validation and maybe Postgres).
 */
export function localMaxConcurrent(setting, { cpus = availableParallelism(), memBytes = totalmem() } = {}) {
  const n = Number.parseInt(setting, 10);
  if (Number.isFinite(n) && n > 0) return n;
  return Math.max(1, Math.min(Math.floor(cpus / 4), Math.floor(memBytes / 8 / 2 ** 30)));
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
export function deadHereHolder(holder, { id = machineIdentity(), self = process.pid } = {}) {
  if (!sameMachineHolder(holder, id)) return false;
  const { pid, boot } = parseHolder(holder);
  if (!Number.isInteger(pid) || pid <= 0 || pid === self) return false;
  // Another boot: every process of that one is gone, whatever pid now runs.
  if (boot && boot !== id.boot) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return e.code === "ESRCH";
  }
}

export function repoFromRemote(url) {
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(\.git)?\/?$/.exec(url || "");
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * Why local mode cannot start here, one line each. `outer` is lib/local.mjs outerProbe: Copilot runs locally only inside
 * the outer sandbox, since its own sandbox applies its file policy only best-effort, so on a host where that does not
 * start (macOS, or Linux without what its sandbox's network needs) local Copilot is refused before any claim.
 * `wf` is the workflow's settings and `env` this shell's, which wins (as in baseEnv); `os` is the platform.
 */
export function preflight(harness, repoFull, token, copilotToken, { outer = outerProbe, wf = {}, env = process.env, os = platform() } = {}) {
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
  problems.push(...harnessProblems(harness, copilotToken, { outer, sandboxStarts: !startProblems.length }));
  if (!token) problems.push(`no token for ${repoFull}: create a fine-grained token for this one repository (contents, issues and pull requests read and write; actions read) and save it to ${tokenFile(repoFull)} (chmod 600) or export FACTORY_LOCAL_TOKEN`);
  return problems;
}

/**
 * Why one harness cannot run here, one line each: the loop's own at its start (preflight), and another an Objective's
 * harness label names before its first stage on this machine (Local.harnessFor). `sandboxStarts`: whether srt's sandbox
 * starts here (preflight's own check), without which Copilot's outer sandbox is not probed.
 */
export function harnessProblems(harness, copilotToken, { outer = outerProbe, sandboxStarts = true } = {}) {
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
      const { COPILOT_HOME: _own, ...env } = process.env;
      const o = outer("copilot", { env });
      if (!o.on) problems.push(`${COPILOT_OUTER_OFF}: ${o.why}; use FACTORY_HARNESS=claude or codex locally, or run Copilot Objectives on the Action${o.cacheFile ? ` (a yes is kept in ${o.cacheFile})` : ""}`);
    }
  }
  return problems;
}

/** FACTORY_LOCAL_TOKEN, else the file ~/.config/factory/tokens/<owner>/<name> (the sandbox hides ~/.config/factory from the model). */
export function tokenFile(repoFull, home = homedir()) {
  const [owner, name] = repoFull.split("/");
  return join(home, ".config", "factory", "tokens", owner, name);
}
export const copilotTokenFile = (home = homedir()) => join(home, ".config", "factory", "copilot-token");
function copilotToken() {
  if (process.env.COPILOT_GITHUB_TOKEN) return process.env.COPILOT_GITHUB_TOKEN.trim();
  const f = copilotTokenFile();
  return existsSync(f) ? readFileSync(f, "utf8").trim() : "";
}
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

/** Local settings for this process only, never copied into a stage's env: the token, and where the App's key is. */
const HOST_ONLY = ["FACTORY_LOCAL_TOKEN", "FACTORY_LOCAL_APP_ID", "FACTORY_LOCAL_APP_KEY"];
function localToken(repoFull) {
  if (process.env.FACTORY_LOCAL_TOKEN) return process.env.FACTORY_LOCAL_TOKEN.trim();
  const f = tokenFile(repoFull);
  return existsSync(f) ? readFileSync(f, "utf8").trim() : "";
}

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

export class Local {
  constructor(flags) {
    // This process is the local backend: the dispatcher it runs in-process routes factory:local Objectives here.
    process.env.FACTORY_LOCAL = "1";
    if (flags.all) process.env.FACTORY_LOCAL_ALL = "1";
    // Canonical, so every sandbox path derived from it is real (lib/local.mjs refuses one that resolves elsewhere).
    this.dev = realpathSync(sh("git", ["-C", resolve(flags.dir || process.cwd()), "rev-parse", "--show-toplevel"]));
    this.repoFull = flags.repo || repoFromRemote(sh("git", ["-C", this.dev, "remote", "get-url", "origin"]));
    if (!this.repoFull) throw new Error("no GitHub origin remote; pass --repo OWNER/NAME");
    this.repo = repoOf(this.repoFull);
    // The workflow's settings as committed on the default branch (#122), never this working tree's, whatever branch is
    // checked out: as the Action runs the reviewed workflow. A working tree that differs is named (doctor too).
    const committed = committedWorkflowEnv(this.dev);
    if (committed.error) log(`local mode reads its settings from the default branch's .github/workflows/factory.yml: ${committed.error}, so it uses none`);
    for (const line of workflowDriftLines(readWorkflowEnv(this.dev), committed)) log(line);
    // The workflow file is repository content: only its settings reach a stage, never a name Factory reads as its own
    // control (#119). Every other FACTORY_* name in it is dropped and named here (doctor warns too).
    const wf = workflowSettings(committed.wf);
    if (wf.dropped.length) log(`.github/workflows/factory.yml: ${wf.dropped.join(", ")} ${wf.dropped.length === 1 ? "is" : "are"} no Factory setting; left out of every stage`);
    this.wf = wf.kept;
    this.harness = (process.env.FACTORY_HARNESS || this.wf.FACTORY_HARNESS || "claude").toLowerCase();
    this.token = localToken(this.repoFull);
    this.copilotToken = this.harness === "copilot" ? copilotToken() : "";
    const problems = preflight(this.harness, this.repoFull, this.token, this.copilotToken, { wf: this.wf });
    // The Factory App, when configured, posts the notices (#2522). Its key stays in this process: a stage asks for a
    // notice token over its IPC channel (stage()), and nothing else, env or file, carries the key or the token.
    const { app, problem } = localApp(process.env, homedir(), this.harness);
    if (problem) problems.push(problem);
    const gateway = gatewayKeyProblem(process.env, homedir(), this.harness);
    if (gateway) problems.push(gateway);
    if (problems.length) throw new Error(`local mode cannot start:\n- ${problems.join("\n- ")}`);
    this.notice = app ? noticeMinter({ appId: app.id, privateKey: app.key, owner: this.repo.owner, repo: this.repo.name }) : null;
    this.opts = { token: this.token, notice: this.notice };
    // One holder id per loop: two loops (two boxes, or run beside serve) never share or clear each other's claim.
    this.holder = holderId();
    this.firstSetup = new Map();
    this.children = new Set();
    this.excludeWorkspaces();
  }

  /** The token check and the routing label; both need the network. */
  async init() {
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
    this.codexSelfTest();
    await ensureLabel(this.repo, LOCAL_LABEL, "0e8a16", "Factory: run this Objective in a developer's local loop, not on Actions", this.opts).catch((e) => log(`label ${LOCAL_LABEL}: ${e.message.slice(0, 120)}`));
    return this;
  }

  /**
   * Codex reports success even when its sandbox cannot start (the command just never runs), so a local Codex loop
   * first runs one command under the same profile, which must run and must fail to write the home directory.
   */
  codexSelfTest(harness = this.harness) {
    if (harness !== "codex") return;
    const probe = 'f="$HOME/.factory-sandbox-check"; if touch "$f" 2>/dev/null; then rm -f "$f"; exit 9; fi';
    try {
      execFileSync("codex", ["sandbox", ...codexLocalConfig({ domains: this.domains(), clone: this.dev }), "--", "sh", "-c", probe], { cwd: this.dev, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
    } catch (e) {
      const why = e.status === 9 ? "a command in it could write the home directory" : `it does not run here (${String(e.stderr || e.message).trim().slice(0, 200)})`;
      throw new Error(`local mode cannot start: Codex's sandbox is not confining: ${why}`);
    }
  }

  /**
   * The harness an Objective's stage runs on here (objective-trust.mjs objectiveInputs): its harness and model labels
   * over this loop's settings, read before the stage's sandbox is set up for it. Another harness than the loop's is
   * checked on this machine as the loop's own was at its start (harnessReady). {ok, harness} or {ok: false, reason, fix}.
   */
  async harnessFor(issue) {
    const env = this.baseEnv();
    const args = { repo: this.repoFull };
    await primeWriters(this.repo, this.opts, { maintainers: resolveInputs({ args, env }).maintainers });
    const chosen = await objectiveInputs({ repo: this.repo, issue, args, env, opts: this.opts });
    if (!chosen.ok) return chosen;
    const harness = chosen.inputs.harness;
    const problems = this.harnessReady(harness);
    if (!problems.length) return { ok: true, harness };
    // What is missing stays in this machine's log: a path or a probe's output never reaches GitHub (block()).
    log(`#${issue}: ${harness} cannot run here: ${problems.join("; ")}`);
    return { ok: false, reason: `local mode on this machine cannot run ${harness}, which this Objective's harness label asks for; the loop's log names what is missing`, fix: "Set that harness up on this machine (doctor.mjs --local with FACTORY_HARNESS set to it names what is missing) and re-apply `factory:objective`, or run the Objective where that harness is set up." };
  }

  /** Why `harness` cannot run on this machine (local.mjs harnessProblems, the App key, the gateway key, Codex's sandbox); a yes is kept. */
  harnessReady(harness) {
    this.ready ??= new Set([this.harness]);
    if (this.ready.has(harness)) return [];
    const problems = harnessProblems(harness, harness === "copilot" ? copilotToken() : "");
    const app = localApp(process.env, homedir(), harness).problem;
    const gateway = gatewayKeyProblem(process.env, homedir(), harness);
    for (const p of [app, gateway]) if (p) problems.push(p);
    if (!problems.length && harness === "codex") {
      try {
        this.codexSelfTest(harness);
      } catch (e) {
        problems.push(e.message.replace(/^local mode cannot start: /, ""));
      }
    }
    if (!problems.length) this.ready.add(harness);
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

  domains() {
    return [...LOCAL_DOMAINS, ...list(process.env.FACTORY_LOCAL_DOMAINS || this.wf.FACTORY_LOCAL_DOMAINS)];
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
    if ((wf.FACTORY_HARNESS || "claude").toLowerCase() !== this.harness) for (const k of ["FACTORY_MODEL", "FACTORY_SUBAGENT_MODEL", "FACTORY_REVIEWER_MODEL", "FACTORY_REVIEWER_EFFORT", "FACTORY_EFFORT"]) delete wf[k];
    // The developer's own harness, model and session settings win over the workflow's.
    for (const k of ["FACTORY_MODEL", "FACTORY_SUBAGENT_MODEL", "FACTORY_REVIEWER_MODEL", "FACTORY_REVIEWER_EFFORT", "FACTORY_EFFORT", "FACTORY_RESUME_POLICY", "FACTORY_COMPACTION_WINDOW", "FACTORY_PROMPT_CACHE_TTL", "FACTORY_TRIAGE_MODEL", "FACTORY_DRIFT_MODEL", "FACTORY_WORKER_SECRETS"]) if (process.env[k]) wf[k] = process.env[k];
    // A worker secret's NAME or SOURCE never joins every stage's env through FACTORY_LOCAL_ENV (lib/local.mjs localBaseEnv).
    const env = { ...localBaseEnv(process.env, list(process.env.FACTORY_LOCAL_ENV || this.wf.FACTORY_LOCAL_ENV), { workerSecrets: wf.FACTORY_WORKER_SECRETS || "" }), ...wf };
    // The developer's own FACTORY_LOCAL_* settings win over the workflow's.
    for (const [k, v] of Object.entries(process.env)) if (k.startsWith("FACTORY_LOCAL_") && !HOST_ONLY.includes(k)) env[k] = v;
    return { ...env, FACTORY_HARNESS: this.harness, FACTORY_LOCAL: "1", FACTORY_LOCAL_ALL: process.env.FACTORY_LOCAL_ALL || "" };
  }

  /**
   * One stage's env: the base, the scoped token, and the sandbox both the harness and Factory's own commands run in.
   * `stageTmp` is the stage's own temp directory (stage() makes it and removes it on every path). `script`: the stage's.
   */
  stageEnv(issue, usageDir, clone, stageTmp, script = null, harness = this.harness) {
    const ws = this.ws(issue);
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
    writeFileSync(srtFile, JSON.stringify(srtSettings({ domains: this.domains(), writable: [clone, ...caches, stageTmp], clone, readOnly: [usageDir], ripgrep }), null, 2));
    // Factory's own git work on the clone (backend.mjs sandbox.git): the clone writable, its .git included; no network.
    const srtGitFile = join(sandboxDir, `srt-git-${basename(usageDir)}.json`);
    writeFileSync(srtGitFile, JSON.stringify(srtSettings({ domains: [], writable: [clone, stageTmp], readOnly: [usageDir] }), null, 2));
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
    const base = this.baseEnv();
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
    const extra = this.harnessEnv(issue, addDirs, clone, usageDir, tools, harness);
    // Linux: the harness process itself runs in srt too (lib/local.mjs harnessOuterSettings), writing only the clone, the
    // stage's directories, its own state and the usage directory's `harness` folder (Copilot's usage file).
    const outerFile = join(sandboxDir, `srt-harness-${basename(usageDir)}.json`);
    // Whether the harness runs in it on this host: Claude Code on Linux, Codex where its own sandbox starts inside it (probed
    // once per host and version, lib/local.mjs outerProbe), Copilot where its sandbox's network starts inside it (probed the
    // same way). Said once when it does not.
    const outer = outerProbe(harness, { domains: this.domains(), env: { ...process.env, ...extra } });
    const outerOn = outer.on;
    // Entries Codex's and Copilot's sandboxes cannot enforce as written (a loopback name, an IP address, host:port) are left
    // out of their policies (lib/local.mjs sandboxHosts: #106, #108).
    const dropped = ["codex", "copilot"].includes(harness) ? sandboxDroppedHosts(this.domains()) : [];
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
      ensureHarnessHomes(harness, { ...process.env, ...extra });
      // Claude Code's projects are read-only in it; the clone's own project links to a directory of the Objective's.
      const projectDir = harness === "claude" ? claudeProjectLink(clone, join(ws, "claude-project"), { ...process.env, ...extra }) : null;
      // Copilot's outer sandbox runs bwrap through Factory's wrapper (lib/local.mjs bwrapTunScript), in the usage directory,
      // which no sandbox may write: srt runs it on the host.
      const bwrapPath = harness === "copilot" ? writeBwrapTun(join(usageDir, "outer")) : null;
      writeFileSync(outerFile, JSON.stringify(harnessOuterSettings({ harness, domains: this.domains(), writable: [clone, ...addDirs, join(usageDir, "harness")], clone, env: { ...process.env, ...extra }, install: harnessInstall(whichSync(harness)), projectDir, bwrapPath, relaySocketDir: socketDir, ripgrep }), null, 2));
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
      FACTORY_LOCAL_SANDBOX: JSON.stringify({ gitId: readGitPin(gitPinFile(ws)), gitPin: gitPinFile(ws), gitBin, ...(bwrapBin ? { bwrapBin, copilotTmp: copilotPrivateTmp(usageDir) } : {}), ...(tools.probe ? { toolchain: tools.probe } : {}), ...(claudeEnv ? { claudeEnv, readable: tools.readable } : {}), ...(ripgrep ? { ripgrep } : {}), addDirs, cacheDirs: caches, readDirs: [usageDir], domains: this.domains(), clone, readOnly: [usageDir], claudeDir: join(usageDir, "claude") }),
      // Every git-lfs transfer of Factory's own host-side git (lfs pull, checkout, rebase, push) goes to the repository's
      // own endpoint, whatever .lfsconfig the model wrote (env config outranks that file), over the real history (no
      // refs/replace). scrubbedEnv drops both (with FACTORY_LFS_PIN) from every child: the harness and the repository's
      // commands never see them.
      ...lfsPinEnv(`https://github.com/${this.repoFull}.git`),
      GIT_NO_REPLACE_OBJECTS: "1",
      FACTORY_LFS_PIN: "1",
      // The harness this sandbox is set up for: a stage whose labels name another by the time it runs Blocks (choiceGate).
      FACTORY_STAGE_HARNESS: harness,
      ...extra,
    };
  }

  /** What the harness's own sandbox needs beyond the shared env: Copilot its home and token. */
  harnessEnv(issue, addDirs, clone, usageDir, tools = null, harness = this.harness) {
    if (harness !== "copilot") return {};
    // One Copilot home per Objective, outside every writable directory: it holds the sandbox policy (which the
    // model must not loosen) and the sessions a later stage resumes.
    const home = join(this.ws(issue), ".sandbox", "copilot-home");
    mkdirSync(home, { recursive: true });
    // Its policy, config and MCP servers, as Factory's own: whatever an earlier run left there (a link included) is replaced.
    // Linux: Copilot's own TMPDIR (its commands' network rules), denied to its commands.
    // The stage's node and package manager (stageEnv) read-only, its global npmrc denied.
    const alsoDenied = platform() === "linux" ? [copilotPrivateTmp(usageDir), ...(tools?.denied || [])] : [];
    const files = { "settings.json": JSON.stringify(copilotLocalSettings({ domains: this.domains(), clone, addDirs, readOnly: [usageDir], readable: tools?.readable || [], alsoDenied }), null, 2), ...copilotHomeFiles() };
    for (const [f, text] of Object.entries(files)) {
      // A directory an earlier run left under the name too.
      rmSync(join(home, f), { force: true, recursive: true });
      writeFileSync(join(home, f), text, { mode: 0o600, flag: "wx" });
    }
    // On macOS Copilot's sandbox cannot read ~/.gitconfig and git then refuses to run; the clone's own config carries
    // Factory's identity and credential helper, so git skips the global file (which may hold credentials anyway).
    return { COPILOT_HOME: home, COPILOT_GITHUB_TOKEN: this.copilotToken || copilotToken(), GIT_CONFIG_GLOBAL: "/dev/null" };
  }

  /** Run worker.mjs or review.mjs as a child; its lines are echoed with the issue and stage. */
  async stage(issue, name, script, args) {
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
    const runs = script === "worker.mjs" || script === "review.mjs" ? await this.harnessFor(issue) : { ok: true, harness: this.harness };
    if (!runs.ok) {
      log(`#${issue}: refusing to run: ${runs.reason}`);
      await this.block(issue, name, runs.reason, { fix: runs.fix });
      return { code: null, exit: "blocked", usd: null, usageDir };
    }
    // The stage's own temp directory, short (srt's sockets live there; a socket path has a 108-byte limit) and the
    // only temp space any sandbox may write: with /tmp itself writable, sandboxed code could swap this directory for
    // a symlink into the home directory before the next sandbox opens it. Removed when the stage ends or fails to
    // start; one a killed loop left is cleared when the next stage on this machine makes its own (lib/local.mjs stageTemp).
    const stageTmp = stageTemp(`${issue}-`);
    // The gateway relay's socket directory, when stageEnv made one (handSocketDir's record): removed with the stage.
    const dropStage = () => {
      dropOwned(stageTmp);
      dropSocketDir(usageDir);
    };
    let env;
    try {
      env = this.stageEnv(issue, usageDir, clone, stageTmp, script, runs.harness);
      // Git locks an interrupted stage left (a reboot, a killed serve) go first, unless a live process may hold them
      // (lib/local.mjs staleGitLocks); then, fresh: what an earlier stage or run left untracked in this reused clone (prepareClone).
      const locks = staleGitLocks(clone);
      for (const l of locks.live) log(`#${issue}: leaving git lock ${l}: a process on this machine has the clone open`);
      const prepared = await prepareClone(clone, [env.pnpm_config_store_dir, env.BUN_INSTALL_CACHE_DIR], (inner) => exec(...BACKENDS.local.sandbox.git(inner, env), { env }), { fresh: true, locks: locks.stale });
      for (const l of prepared.locks) log(`#${issue}: removed stale git lock ${l} (no live process holds it)`);
    } catch (e) {
      dropStage();
      const reason = { "outer-sandbox": copilotOuterReason, "sandbox-scan": sandboxScanReason }[e.code];
      if (!reason) throw e;
      log(`#${issue}: refusing to run: ${e.message}`);
      await this.block(issue, name, reason);
      return { code: null, exit: "blocked", usd: null, usageDir };
    }
    if (this.stopping) {
      dropStage();
      return { code: null, exit: null, usd: null, usageDir };
    }
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
      const child = spawn(process.execPath, [join(PLUGIN_ROOT, "scripts", script), "--repo", this.repoFull, ...args, "--checkout", clone, "--usage-dir", usageDir, "--token-fd", "3", ...notice], { env: values ? { ...env, FACTORY_INPUT_WORKER_SECRET_VALUES: values } : env, stdio: ["ignore", "pipe", "pipe", "pipe", ...(this.notice ? ["ipc"] : [])] });
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
        rmSync(join(usageDir, STAGE_RECORD), { force: true });
        let result = null;
        try {
          result = JSON.parse(readFileSync(join(usageDir, "result.json"), "utf8"));
        } catch {
          // no record: the child failed before writing one
        }
        dropStage();
        done({ code, signal, exit: result?.exit ?? null, usd: result?.usd ?? null, usageDir, stage: name, log: logFile, ...(result?.exit === "paused" && result.outage ? { outage: result.outage } : {}) });
      });
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
   * pause and this machine's next `factory run` or `factory serve` takes them up again. Exits once `whenSettled()` resolves
   * (the work in flight, wound down) or 30 s pass.
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
      log(`stopping (${sig}): ending ${this.children.size} stage process(es); their Objectives stay Running, paused, and the next factory run or serve on this machine takes them up (the dispatcher Blocks one only after a day away); signal again to exit at once`);
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
   */
  async withClaim(issue, fn) {
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
    const others = !!held && held.holder !== this.holder && !deadHereHolder(held.holder);
    if (others && held.fresh) {
      log(`#${issue}: another local loop holds it (${held.holder}); leaving it alone`);
      return { exit: "skipped" };
    }
    try {
      await writeClaim(this.repo, issue, this.holder, this.opts);
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
    if (mine?.holder !== this.holder) {
      log(`#${issue}: another local loop claimed it first; leaving it alone`);
      return { exit: "skipped" };
    }
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
        if (result?.exit === "paused") this.outagePaused(issue, result);
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
   * A stage that ended with no exit record under this loop (`result` its stage's end, or `failure` what threw): the claim
   * stays and pausedHere resumes it once; a second in a row Blocks it here (cause `factory`), naming the stage, its exit
   * code or signal and its log on this machine, so the cause reaches GitHub and nothing retries forever. The count is
   * this loop's memory: another serve on the machine resumes the Objective afresh.
   */
  async lapse(issue, result, failure) {
    const stage = result?.stage || "work";
    const how = failure ? `threw (${String(failure?.message || failure).slice(0, 200)})` : `ended with no exit record (${result?.signal ? `signal ${result.signal}` : `exit code ${result?.code ?? "none"}`})`;
    const where = result?.log ? `; its log on this machine: ${result.log}` : "";
    const lapsed = (this.lapsed ??= new Map());
    if (!lapsed.has(issue)) {
      lapsed.set(issue, 1);
      log(`#${issue}: the ${stage} stage ${how}; the claim stays and this loop resumes it once${where}`);
      return;
    }
    lapsed.delete(issue);
    log(`#${issue}: the ${stage} stage ${how} again; Blocking it${where}`);
    try {
      await this.block(issue, stage, `the ${stage} stage ${how} twice in a row on this machine${where}`.replaceAll(homedir(), "~"), { cause: "factory" });
      await dropClaim(this.repo, issue, this.holder, this.opts);
    } catch (e) {
      log(`#${issue}: the Block could not be written (${String(e?.message || e).slice(0, 120)}); the claim stays`);
    }
  }

  /**
   * A stage that ended `paused` on this machine's network (session.mjs outageExit): the outage it names (`result.outage`:
   * host, origin, code, since) is kept in this loop's memory. A pause that comes within OUTAGE.stageWaitMs of this loop
   * resuming the Objective from an earlier one is the same outage (a network that comes and goes): its `since` stays the
   * earlier one, so OUTAGE.blockMs counts from when the Objective first lost the network. No lapse is counted; the claim
   * stays. The memory is this loop's: another serve on the machine resumes the Objective with the bound counted afresh.
   */
  outagePaused(issue, result) {
    const o = result?.outage || {};
    const at = Date.parse(o.since);
    const own = Number.isFinite(at) ? at : (this.clock ?? Date.now)();
    const earlier = this.offline?.get(issue);
    const same = earlier && Number.isFinite(earlier.resumedAt) && own - earlier.resumedAt < OUTAGE.stageWaitMs;
    const since = same ? Math.min(own, earlier.since) : own;
    (this.offline ??= new Map()).set(issue, { since, stage: result?.stage || "work", origin: o.origin ?? null, host: o.host || "the network", code: o.code || "no answer" });
    this.lapsed?.delete(issue);
    log(`#${issue}: the ${result?.stage || "work"} stage paused: this machine could not reach ${o.host || "the network"} (${o.code || "no answer"}) since ${new Date(since).toISOString()}; the claim stays and this loop resumes it once that host answers`);
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
      // Paused on the network: resumed once the host it could not reach answers a probe (GitHub answered these reads),
      // and taken up past OUTAGE.blockMs whatever the probe says, so resume Blocks it (a provider unreachable while GitHub
      // answers would otherwise leave it Running with no notice).
      const off = c.holder === this.holder ? this.offline?.get(issue.number) : null;
      if (off) {
        if (!off.origin || (this.clock ?? Date.now)() - off.since >= OUTAGE.blockMs || (await probeHost(off.origin)) === null) out.push(issue.number);
        continue;
      }
      if (c.holder === this.holder ? !!this.lapsed?.has(issue.number) || !c.fresh : !c.fresh || deadHereHolder(c.holder)) out.push(issue.number);
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
      dropClaudeProjectLink(join(root, name, "repo"), process.env);
      log(`#${issue}: closed; removed its local directory .factory/${name}`);
    }
  }

  /**
   * Pick a paused Objective up where it stands: its open PR's review, else its work from the clone and saved sessions.
   * One paused on this machine's network for OUTAGE.blockMs or more is Blocked instead, with the External cause
   * `outage`, naming the host and since when.
   */
  async resume(issue) {
    const off = this.offline?.get(issue);
    const now = (this.clock ?? Date.now)();
    if (off && now - off.since >= OUTAGE.blockMs) {
      // GitHub answers here; the host the stage could not reach may still not (a provider), and the notice says which.
      const back = !off.origin || (await probeHost(off.origin)) === null;
      const reason = `this machine could not reach ${off.host} (${off.code}) from ${new Date(off.since).toISOString()} for ${minutesText(now - off.since)}, past Factory's ${minutesText(OUTAGE.blockMs)} bound for an outage. ${back ? "The network is back: re-apply the label to run it again." : `${off.host} is still unreachable from this machine: re-apply the label once it answers.`}`;
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
    log(`#${issue}: nothing left to run here (its PR is reviewed or gone); releasing the claim`);
    const held = await localClaim(this.repo, issue, this.opts).catch(() => null);
    if (held?.commentId && sameMachineHolder(held.holder)) await rest(`repos/${this.repo.full}/issues/comments/${held.commentId}`, { ...this.opts, method: "DELETE" }).catch(() => {});
    this.lapsed?.delete(issue);
    return { exit: "skipped" };
  }

  async review(issue, prNumber, { wait = false, reruns = 0 } = {}) {
    const review = await this.stage(issue, "review", "review.mjs", ["--pr", String(prNumber)]);
    log(`#${issue} review of PR #${prNumber}: ${review.exit ?? `no exit record (code ${review.code})`}${review.usd != null ? `, $${review.usd.toFixed(2)}` : ""}`);
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

  /** One Objective, start to delivered review (and, with `wait`, to merged). */
  async runObjective(issue, { wait = false } = {}) {
    // A stage of this Objective still running on this machine (an earlier serve's, orphaned): never a second beside it,
    // and its claim stays as it is.
    this.reapHere(issue);
    const live = liveStage(this.ws(issue));
    if (live) {
      log(`${liveStageLine(issue, live)}; not starting beside it`);
      return { exit: "skipped" };
    }
    try {
      return await this.withClaim(issue, () => this.work(issue, { wait }));
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
   * every tick; the third failed start of the same Objective in a row Blocks it once, with the error (cause `setup`).
   * When the claim could not be read, or was another loop's, who holds it is unknown: nothing changes now, and after the
   * backoff this loop reads the claim again (recheckStarts). Only an Objective still labelled Running is un-marked or
   * Blocked; otherwise, or on a failed read, the claim stays, goes stale and this loop resumes it (pausedHere).
   */
  async unstart(issue, e) {
    const out = { code: null, exit: null, usd: null, usageDir: null, startFailed: e.startFailed };
    const error = String(e?.message || e).replaceAll(homedir(), "~").slice(0, 300);
    log(`#${issue}: could not start (${e.startFailed}): ${error}`);
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
      if (c?.fresh && c.holder !== this.holder && !deadHereHolder(c.holder)) {
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
  async runIssue(issue, { wait = false, gh = { findPr, getIssue }, waitMs = 2_000 } = {}) {
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
      if (!wait) return { exit: "delivered" };
      return this.withClaim(issue, async () => {
        const merged = await this.followMerge(issue, pr.number);
        return { exit: merged ? "delivered" : null, next: merged === "next" };
      });
    }
    return this.runObjective(issue, { wait });
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

  /** The work stage, then its review: in a claim this loop holds. */
  async work(issue, { wait = false } = {}) {
    // The stage only rejects before its process starts: a failed start (runObjective).
    const work = await this.stage(issue, "work", "worker.mjs", ["--issue", String(issue)]).catch((e) => {
      throw Object.assign(e instanceof Error ? e : new Error(String(e)), { startFailed: "work" });
    });
    // The stage started: this loop's count of failed starts for it is over.
    this.startFailures?.delete(issue);
    log(`#${issue} work: ${work.exit ?? `no exit record (code ${work.code})`}${work.usd != null ? `, $${work.usd.toFixed(2)}` : ""}`);
    if (work.exit !== "delivered") return work;
    const pr = await findPr(this.repo, `factory/${issue}`, this.opts).catch(() => null);
    // A delivered PR without the review label conflicts with the default branch: the dispatcher's send-back takes it
    // (`unreviewed` tells sendBack its rebase did not take).
    return pr && (pr.labels || []).some((l) => l.name === REVIEW_LABEL) ? this.review(issue, pr.number, { wait }) : { ...work, unreviewed: true };
  }

  /**
   * --wait, a PR that conflicts with the default branch at its merge (a sibling merged first, #2647): the dispatcher's
   * send-back, here, since this loop holds the Objective. The first time, its notice on the PR and one worker rebase,
   * then the review again; after one rebase, Blocked (session.mjs REBASED_TWICE), also when the rebase's worker run ends
   * delivered with the PR still conflicting. Returns followMerge's answer, or "retry": the PR no longer conflicts, or
   * GitHub failed for now, so followMerge's next poll decides again. `gh` is for tests.
   */
  async sendBack(issue, prNumber, inputs, { gh = { getPrSettled, rebaseMarkers, prComment, applyExit } } = {}) {
    const conflicting = (pr) => pr?.state === "open" && !pr.merged && pr.mergeable_state === "dirty";
    let pr = null;
    let since = null;
    try {
      pr = await gh.getPrSettled(this.repo, prNumber, this.opts);
      if (!conflicting(pr)) {
        log(`#${issue}: PR #${prNumber} no longer conflicts (${pr?.state}, ${pr?.mergeable_state}); the merge pass reads it again`);
        return "retry";
      }
      const seen = await gh.rebaseMarkers(this.repo, { issue, pr, objectiveLabel: inputs.objectiveLabel }, this.opts);
      since = seen.since;
      if (seen.effective >= 1) {
        await gh.applyExit(this.repo, rebasedTwiceBlock({ issue, pr, since, notify: inputs.notify, stage: "merge" }), this.opts);
        return false;
      }
      if (!seen.already) await gh.prComment(this.repo, prNumber, rebaseNotice(issue, pr), this.opts);
    } catch (e) {
      return this.sendBackFailed(issue, pr, e, inputs, gh);
    }
    log(`#${issue}: PR #${prNumber} conflicts with ${pr.base?.ref || "the default branch"} after a sibling merged; sending it back to the worker once to rebase`);
    const r = await this.work(issue, { wait: true });
    if (r.next) return "next";
    if (r.exit !== "delivered") return false;
    if (!r.unreviewed) return true;
    // The worker delivered without the review label: its rebase still conflicts (another sibling landed meanwhile).
    // That is the second conflict after the one rebase, so it Blocks here rather than leaving the PR dirty In review.
    try {
      const now = await gh.getPrSettled(this.repo, prNumber, this.opts);
      if (!conflicting(now)) return "retry";
      await gh.applyExit(this.repo, rebasedTwiceBlock({ issue, pr: now, since, notify: inputs.notify, stage: "merge" }), this.opts);
      return false;
    } catch (e) {
      return this.sendBackFailed(issue, pr, e, inputs, gh);
    }
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
   */
  async pendingReviews() {
    const prs = (await rest(`repos/${this.repo.full}/pulls?state=open&per_page=100`, { ...this.opts, paginate: true }).catch(() => [])) || [];
    const out = [];
    for (const pr of prs) {
      const issue = reviewIssue(pr);
      if (!issue) continue;
      const data = await getIssue(this.repo, issue, this.opts).catch(() => null);
      // A stopped Objective (its label removed, its issue closed: stop.mjs) gets no review.
      if (!data || isBlocked(data) || stopCause(data, this.objectiveLabel()) || !BACKENDS.local.trigger.routes(data, this.baseEnv())) continue;
      if ((await localClaim(this.repo, issue, this.opts).catch(() => null))?.fresh) continue;
      out.push({ issue, pr: pr.number });
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
        const how = await mergeReadyOne(this.repo, { issue, prNumber, queue, checkNames: inputs.ciChecks, report, hungMs, cache, objectiveLabel: inputs.objectiveLabel }, this.opts).catch((e) => log(`#${issue} merge: ${e.message.slice(0, 160)}`));
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
        if (how === "re-review" || how === "unread") return this.review(issue, prNumber, { wait: true }).then((r) => (r.next ? "next" : r.exit === "delivered"));
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

  /** The dispatcher's own rules (caps, order, blocking, send-backs, Done), every interval; picks run here, up to this box's limit. */
  async serve({ once = false, intervalMs = 30_000 } = {}) {
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
    const limit = localMaxConcurrent(process.env.FACTORY_LOCAL_MAX_CONCURRENT ?? this.wf.FACTORY_LOCAL_MAX_CONCURRENT);
    log(`at most ${limit} Objective stage(s) at once on this box (FACTORY_LOCAL_MAX_CONCURRENT)`);
    // This machine's network (lib/network.mjs): serve's own GitHub calls wait for it to come back, with no bound, one log
    // line when it is lost and one when it answers; its stages wait in place for fifteen minutes and then pause.
    waitOutages();
    this.stopOnSignals(() => Promise.allSettled(running.values()));
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
      // Every 10 minutes, and at start: closed Objectives' directories go.
      if (Date.now() - cleaned > 10 * 60_000) {
        cleaned = Date.now();
        await this.cleanup(running).catch((e) => log(`cleanup: ${e.message.slice(0, 160)}`));
      }
      const inputs = resolveInputs({ args: { repo: this.repoFull }, env: { ...this.baseEnv(), FACTORY_INPUT_GITHUB_TOKEN: this.token } });
      // Failed starts whose holder was unknown: read their claims again once their backoff ends.
      await this.recheckStarts(running).catch((e) => log(`start recheck: ${e.message.slice(0, 160)}`));
      // This machine's paused work resumes first, then reviews (they finish work in flight); new work gets the rest.
      const resumes = (await this.pausedHere(running)).slice(0, Math.max(0, limit - running.size));
      for (const n of resumes) {
        log(`#${n}: resuming (this machine held it when it went away)`);
        running.set(n, track(n, this.resume(n)).catch((e) => log(`#${n} resume failed: ${e.message.slice(0, 200)}`)).finally(() => running.delete(n)));
      }
      const pending = (await this.pendingReviews()).filter((r) => !running.has(r.issue));
      const reviews = pending.slice(0, Math.max(0, limit - running.size));
      // Held from this tick's dispatch: a failed start's backoff, a stage running here, and every review this loop owes
      // (starting now or waiting for a slot), so the dispatcher never Blocks one this live loop is about to run.
      const localHeld = { ...this.startHolds(), ...Object.fromEntries(pending.map((r) => [r.issue, "its review runs on this box"])), ...Object.fromEntries([...running.keys()].map((n) => [n, "its stage runs on this box"])) };
      const given = new Map(stopped);
      const localStopped = Object.fromEntries([...given].map(([n, s]) => [n, s.why]));
      const result = await dispatch(inputs, { token: this.token, notice: this.notice, localSlots: Math.max(0, limit - running.size - reviews.length), localHeld, localStopped }).catch(async (e) => {
        // A 401 the local token itself gets again (not the notice App's): GitHub no longer takes it. Said once, by source.
        if (e?.status === 401 && (await rest(`repos/${this.repo.full}`, { token: this.token }).then(() => false, (x) => x?.status === 401))) {
          refused = this.token;
          probeAt = Date.now() + REFUSED_PROBE.ms;
          log(`GitHub refused the local token (HTTP 401: expired or revoked): no new work starts on this box until it is renewed in ${tokenSource(this.repoFull)}; stages already running end as they can`);
          return { ready: [], refused: true };
        }
        log(`dispatch failed: ${e.message.slice(0, 200)}`);
        return { ready: [] };
      });
      if (result.refused) {
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
      if (pending.length > reviews.length) log(`${pending.length - reviews.length} review(s) wait for a free slot on this box`);
      log(`tick: ${picks.length ? `starting ${picks.map((n) => `#${n}`).join(", ")}` : "nothing ready"}${holding.length ? `; holding ${holding.map((s) => `#${s.number} (${s.reason})`).join(", ")}` : ""}${reviews.length ? `; reviewing ${reviews.map((r) => `PR #${r.pr}`).join(", ")}` : ""}${result.reason ? ` (${result.reason})` : ""}; ${running.size} in flight here, $${Number.isFinite(result.spentToday) ? result.spentToday.toFixed(2) : "?"} spent today`);
      for (const n of picks) running.set(n, track(n, this.runObjective(n)).catch((e) => log(`#${n} failed: ${e.message.slice(0, 200)}`)).finally(() => running.delete(n)));
      for (const r of reviews) running.set(r.issue, track(r.issue, this.withClaim(r.issue, () => this.review(r.issue, r.pr))).catch((e) => log(`PR #${r.pr} review failed: ${e.message.slice(0, 200)}`)).finally(() => running.delete(r.issue)));
      if (once) {
        await Promise.all(running.values());
        return;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
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
  const dir = realpathSync(sh("git", ["-C", resolve(flags.dir || process.cwd()), "rev-parse", "--show-toplevel"]));
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
    if (pr.draft) await setDraft(repo, pr.number, false, opts);
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
 * holds no reviewer JSON, or it judges none of the issue's acceptance entries (handoff.mjs reviewMissed). Nothing is
 * posted then, so the user fixes the file and runs the command again; a review carrying the marker would stop the
 * Action's own reviewer pass.
 */
export function reviewPostFor({ issue, text, file, diff, entries }) {
  const review = parseReview(text);
  if (!review.parsed) throw new Error(`${file} holds no reviewer JSON; nothing posted`);
  if (reviewMissed({ review, entries })) throw new Error(`${file} judges none of the issue's acceptance entries (${entries.map((e) => e.id).join(", ")}); nothing posted`);
  return reviewPost({ issue, review, diff, entries });
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
  const post = reviewPostFor({ issue, text: readFileSync(file, "utf8"), file, diff, entries: acceptanceEntries(trusted.issueData.body) });
  const { comments } = post;
  const posted = await postReview(repo, prNumber, { body: post.body, comments, commitId: pr.head.sha }, opts);
  log(`PR #${prNumber}: review posted with ${comments.length} comment(s)${posted.moved ? `; ${posted.moved} moved to a line GitHub takes` : ""}${posted.inBody ? `; ${posted.inBody} in the review body${posted.retried ? ` (GitHub answered ${posted.retried} to the line comments)` : " (no line GitHub can take)"}` : ""}`);
  return 0;
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
    let task = null;
    local.stopOnSignals(() => task);
    task = local.runReview(Number(arg), { wait: !!flags.wait });
    process.exitCode = (await task).exit === "delivered" ? 0 : 1;
    return;
  }
  if (cmd === "serve") await (await new Local(flags).init()).serve({ once: !!flags.once, intervalMs: (flags.interval ?? 30) * 1000 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    process.stderr.write(`[factory] local: ${e.message}\n`);
    process.exit(1);
  });
}
