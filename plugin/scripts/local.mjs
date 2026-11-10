#!/usr/bin/env node
// Factory local mode: the same worker and reviewer the Action runs, on a developer's own box.
//   node scripts/local.mjs run <issue> [--repo OWNER/NAME] [--dir CLONE] [--wait]
//   node scripts/local.mjs review <pr> [--wait]      (a review re-run, as re-applying factory:review does on Actions)
//   node scripts/local.mjs serve [--repo OWNER/NAME] [--dir CLONE] [--once] [--all] [--interval SECONDS (30)]
//   node scripts/local.mjs issue <issue> | deliver <issue> | post-review <pr> <findings.json>   (a session's route)
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
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, homedir, hostname, platform, totalmem, uptime } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { dispatch } from "./dispatch.mjs";
import { PLUGIN_ROOT } from "./lib/checkout.mjs";
import { activeWorkIssues, addLabels, ensureLabel, hasMergeQueue, findPr, findProject, getIssue, getPr, getPrSettled, listComments, listIssuesByLabel, moveCard, postReview, prComment, prDiff, primeSelf, primeWriters, removeLabel, repoOf, rest, setDraft, setStateLabel, transientError } from "./lib/github.mjs";
import { log, resolveInputs } from "./lib/inputs.mjs";
import { exec, whichSync } from "./lib/proc.mjs";
import { HEARTBEAT_MS, LOCAL_DOMAINS, LOCAL_LABEL, claudeProjectLink, codexLocalConfig, copilotHomeFiles, copilotLocalSettings, dropClaim, dropClaudeProjectLink, ensureHarnessHomes, gitDirChanged, gitIdentityKey, gitIdentityReason, gitPinFile, pinGitDir, readGitPin, harnessInstall, gitGuardScript, harnessOuterSettings, outerProbe, gatewayKeyProblem, localApp, localBaseEnv, localClaim, prepareClone, readWorkflowEnv, stageTemp, sandboxStartProblems, srtSettings, stopHold, workflowEnv, writeBwrapTun, writeClaim } from "./lib/local.mjs";
import { REVIEW_LABEL, acceptanceEntries, parseReview, planAskedOf, protectedPaths, questionCheckPrompt, selfLogin } from "./lib/logic.mjs";
import { MAX_PARTS, currentPlan, exitFromOut, inFiles, isSplitPart, nextPart, partsRecord, planSync, postNote, postReplies, publishPr, readOut, recordPart, reviewMissed, reviewPost } from "./lib/handoff.mjs";
import { applyExit, commitAuthor, gitIdentity, mergeBlockReason, mergeReadyOne, queueBoundMs, mirrorDiff, objectiveDecisions, progressReporter, rebaseMarkers, rebaseNotice, rebasedTwiceBlock, unaddressedReviewComments } from "./lib/session.mjs";
import { openOutbox, scratchHistory } from "./lib/outbox.mjs";
import { appendOwn, dropOwned, privateTmp } from "./lib/fsafe.mjs";
import { git as gitIn } from "./lib/proc.mjs";
import { BACKENDS } from "./lib/backend.mjs";
import { noticeMinter, serveNotices } from "./lib/app-token.mjs";
import { answeredRepos, declaredQuestion, planNeeds as planNeedsOf } from "./lib/one-repo.mjs";
import { localDatabaseChecks, noticeAppCheck } from "./doctor.mjs";
import { lfsPinEnv } from "./lib/lfs.mjs";
import { authorGate, trustedIssue } from "./lib/objective-trust.mjs";

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
const onPath = (bin) => whichSync(bin) !== null;
/** The harnesses this process has said run without the outer sandbox. */
const OUTER_SAID = new Set();
export const COPILOT_OUTER_OFF = "local mode runs Copilot only inside the outer sandbox, which does not start on this host";
/** The Blocked reason when Copilot's outer sandbox stopped starting after serve began: fixed text, no probe output. */
export const copilotOuterReason = "local mode: Copilot runs locally only inside the outer sandbox, which no longer starts on this machine (outer-sandbox); the local loop's log says why; run the Objective with FACTORY_HARNESS=claude or codex, or on the Action";
const list = (v) => String(v || "").split(/[\s,]+/).filter(Boolean);

function parse(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[key] = next;
        i += 1;
      } else out[key] = true;
    } else out._.push(a);
  }
  return out;
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
 */
export function preflight(harness, repoFull, token, copilotToken, { outer = outerProbe } = {}) {
  const problems = [];
  if (!["claude", "codex", "copilot"].includes(harness)) problems.push(`unknown harness ${harness}`);
  for (const bin of ["git", "gh", harness]) if (!onPath(bin)) problems.push(`${bin} is not on PATH`);
  if (harness === "copilot") {
    // Copilot's sandbox reads its policy from its own home, so the developer's `copilot login` is not used there.
    if (!copilotToken) problems.push(`no Copilot token: create a fine-grained token with the Copilot Requests permission and save it to ${copilotTokenFile()} (chmod 600) or export COPILOT_GITHUB_TOKEN`);
    // Without these Copilot's sandbox cannot start, and every command fails while the run still exits 0.
    if (platform() === "linux") for (const bin of ["slirp4netns", "iptables", "iptables-restore", "ip6tables", "ip6tables-restore"]) if (!onPath(bin)) problems.push(`${bin} is not on PATH; Copilot's sandbox needs it (sudo apt-get install -y slirp4netns iptables)`);
  }
  if (!onPath("srt")) problems.push("srt is not on PATH; Factory's own commands run in it (npm i -g @anthropic-ai/sandbox-runtime)");
  if (!onPath("rg")) problems.push("rg (ripgrep) is not on PATH; the sandbox needs it");
  if (platform() === "linux") for (const bin of ["bwrap", "socat"]) if (!onPath(bin)) problems.push(`${bin} is not on PATH; the sandbox needs it (sudo apt-get install -y bubblewrap socat)`);
  const startProblems = platform() === "linux" && onPath("srt") && onPath("bwrap") ? sandboxStartProblems() : [];
  problems.push(...startProblems);
  if (platform() === "win32") problems.push("native Windows has no sandbox for the harness; run local mode inside WSL2");
  // macOS's sandbox has no network namespace of its own: a throwaway Postgres there would listen on the box's loopback.
  if (platform() === "darwin" && (process.env.FACTORY_LOCAL_DB || "") === "1") problems.push("FACTORY_LOCAL_DB runs on Linux and WSL2 only: macOS's sandbox shares the box's loopback, so a throwaway database would be reachable from outside it");
  // Probed only where it can start at all; off Linux outerProbe answers without starting anything.
  if (harness === "copilot" && (platform() !== "linux" || (["srt", "bwrap", "copilot"].every(onPath) && !startProblems.length))) {
    // Without the developer's own COPILOT_HOME: the probe makes and seeds the home it is given, and Factory leaves theirs alone.
    const { COPILOT_HOME: _own, ...env } = process.env;
    const o = outer("copilot", { env });
    if (!o.on) problems.push(`${COPILOT_OUTER_OFF}: ${o.why}; use FACTORY_HARNESS=claude or codex locally, or run Copilot Objectives on the Action${o.cacheFile ? ` (a yes is kept in ${o.cacheFile})` : ""}`);
  }
  if (!token) problems.push(`no token for ${repoFull}: create a fine-grained token for this one repository (contents, issues and pull requests read and write; actions read) and save it to ${tokenFile(repoFull)} (chmod 600) or export FACTORY_LOCAL_TOKEN`);
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
/** Local settings for this process only, never copied into a stage's env: the token, and where the App's key is. */
const HOST_ONLY = ["FACTORY_LOCAL_TOKEN", "FACTORY_LOCAL_APP_ID", "FACTORY_LOCAL_APP_KEY"];
function localToken(repoFull) {
  if (process.env.FACTORY_LOCAL_TOKEN) return process.env.FACTORY_LOCAL_TOKEN.trim();
  const f = tokenFile(repoFull);
  return existsSync(f) ? readFileSync(f, "utf8").trim() : "";
}

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
    this.wf = readWorkflowEnv(this.dev);
    this.harness = (process.env.FACTORY_HARNESS || this.wf.FACTORY_HARNESS || "claude").toLowerCase();
    this.token = localToken(this.repoFull);
    this.copilotToken = this.harness === "copilot" ? copilotToken() : "";
    const problems = preflight(this.harness, this.repoFull, this.token, this.copilotToken);
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
  codexSelfTest() {
    if (this.harness !== "codex") return;
    const probe = 'f="$HOME/.factory-sandbox-check"; if touch "$f" 2>/dev/null; then rm -f "$f"; exit 9; fi';
    try {
      execFileSync("codex", ["sandbox", ...codexLocalConfig({ domains: this.domains(), clone: this.dev }), "--", "sh", "-c", probe], { cwd: this.dev, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
    } catch (e) {
      const why = e.status === 9 ? "a command in it could write the home directory" : `it does not run here (${String(e.stderr || e.message).trim().slice(0, 200)})`;
      throw new Error(`local mode cannot start: Codex's sandbox is not confining: ${why}`);
    }
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
      const child = spawn("git", ["-c", "credential.helper=", "-c", `credential.https://github.com.helper=${helper}`, "clone", "-q", "--reference-if-able", this.dev, "--dissociate", `https://github.com/${this.repoFull}.git`, dir], { env: { ...localBaseEnv(process.env), FACTORY_LOCAL_TOKEN: this.token, GIT_LFS_SKIP_SMUDGE: "1" }, stdio: ["ignore", "inherit", "inherit"] });
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
    for (const k of ["FACTORY_MODEL", "FACTORY_SUBAGENT_MODEL", "FACTORY_REVIEWER_MODEL", "FACTORY_REVIEWER_EFFORT", "FACTORY_EFFORT", "FACTORY_RESUME_POLICY", "FACTORY_COMPACTION_WINDOW", "FACTORY_PROMPT_CACHE_TTL", "FACTORY_TRIAGE_MODEL", "FACTORY_DRIFT_MODEL"]) if (process.env[k]) wf[k] = process.env[k];
    const env = { ...localBaseEnv(process.env, list(process.env.FACTORY_LOCAL_ENV || this.wf.FACTORY_LOCAL_ENV)), ...wf };
    // The developer's own FACTORY_LOCAL_* settings win over the workflow's.
    for (const [k, v] of Object.entries(process.env)) if (k.startsWith("FACTORY_LOCAL_") && !HOST_ONLY.includes(k)) env[k] = v;
    return { ...env, FACTORY_HARNESS: this.harness, FACTORY_LOCAL: "1", FACTORY_LOCAL_ALL: process.env.FACTORY_LOCAL_ALL || "" };
  }

  /**
   * One stage's env: the base, the scoped token, and the sandbox both the harness and Factory's own commands run in.
   * `stageTmp` is the stage's own temp directory (stage() makes it and removes it on every path).
   */
  stageEnv(issue, usageDir, clone, stageTmp) {
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
    writeFileSync(srtFile, JSON.stringify(srtSettings({ domains: this.domains(), writable: [clone, ...caches, stageTmp], clone, readOnly: [usageDir] }), null, 2));
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
    const addDirs = [...caches, stageTmp];
    const extra = this.harnessEnv(issue, addDirs, clone, usageDir);
    // Linux: the harness process itself runs in srt too (lib/local.mjs harnessOuterSettings), writing only the clone, the
    // stage's directories, its own state and the usage directory's `harness` folder (Copilot's usage file).
    const outerFile = join(sandboxDir, `srt-harness-${basename(usageDir)}.json`);
    // Whether the harness runs in it on this host: Claude Code on Linux, Codex where its own sandbox starts inside it (probed
    // once per host and version, lib/local.mjs outerProbe), Copilot where its sandbox's network starts inside it (probed the
    // same way). Said once when it does not.
    const outer = outerProbe(this.harness, { domains: this.domains(), env: { ...process.env, ...extra } });
    const outerOn = outer.on;
    // Copilot never runs without it (preflight refuses such a host): here it stopped starting after serve began, for
    // example a new Copilot, bubblewrap or slirp4netns version probed again. The stage refuses; stage() Blocks.
    if (!outerOn && this.harness === "copilot") throw Object.assign(new Error(`${COPILOT_OUTER_OFF}: ${outer.why}${outer.cacheFile ? ` (probe cache: ${outer.cacheFile})` : ""}`), { code: "outer-sandbox" });
    if (!outerOn && !OUTER_SAID.has(this.harness)) {
      OUTER_SAID.add(this.harness);
      log(`local: ${this.harness} runs without the outer sandbox on this host: ${outer.why}. What it runs on the host itself relies on the file-level guards and Factory's git guard.`);
    }
    if (outerOn) {
      mkdirSync(join(usageDir, "harness"), { recursive: true });
      ensureHarnessHomes(this.harness, { ...process.env, ...extra });
      // Claude Code's projects are read-only in it; the clone's own project links to a directory of the Objective's.
      const projectDir = this.harness === "claude" ? claudeProjectLink(clone, join(ws, "claude-project"), { ...process.env, ...extra }) : null;
      // Copilot's outer sandbox runs bwrap through Factory's wrapper (lib/local.mjs bwrapTunScript), in the usage directory,
      // which no sandbox may write: srt runs it on the host.
      const bwrapPath = this.harness === "copilot" ? writeBwrapTun(join(usageDir, "outer")) : null;
      writeFileSync(outerFile, JSON.stringify(harnessOuterSettings({ harness: this.harness, domains: this.domains(), writable: [clone, ...addDirs, join(usageDir, "harness")], clone, env: { ...process.env, ...extra }, install: harnessInstall(whichSync(this.harness)), projectDir, bwrapPath }), null, 2));
    }
    // Last on PATH, so nothing there can ever stand in for git, gh, srt or claude in Factory's own unsandboxed calls;
    // and neither sandbox may write it (FACTORY_LOCAL_SANDBOX.readOnly, srt denyWrite), so nothing can be planted.
    base.PATH = `${base.PATH || ""}:${binDir}`;
    // The harness's own `git`, first on its PATH only (lib/harness.mjs): refused once the clone's .git was replaced.
    const gitBin = join(usageDir, "gitbin");
    mkdirSync(gitBin, { recursive: true });
    writeFileSync(join(gitBin, "git"), gitGuardScript(realpathSync(whichSync("git"))), { mode: 0o755 });
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
      FACTORY_LOCAL_SANDBOX: JSON.stringify({ gitId: readGitPin(gitPinFile(ws)), gitPin: gitPinFile(ws), gitBin, addDirs, cacheDirs: caches, readDirs: [usageDir], domains: this.domains(), clone, readOnly: [usageDir], claudeDir: join(usageDir, "claude") }),
      // Every git-lfs transfer of Factory's own host-side git (lfs pull, checkout, rebase, push) goes to the repository's
      // own endpoint, whatever .lfsconfig the model wrote (env config outranks that file), over the real history (no
      // refs/replace). scrubbedEnv drops both (with FACTORY_LFS_PIN) from every child: the harness and the repository's
      // commands never see them.
      ...lfsPinEnv(`https://github.com/${this.repoFull}.git`),
      GIT_NO_REPLACE_OBJECTS: "1",
      FACTORY_LFS_PIN: "1",
      ...extra,
    };
  }

  /** What the harness's own sandbox needs beyond the shared env: Copilot its home and token. */
  harnessEnv(issue, addDirs, clone, usageDir) {
    if (this.harness !== "copilot") return {};
    // One Copilot home per Objective, outside every writable directory: it holds the sandbox policy (which the
    // model must not loosen) and the sessions a later stage resumes.
    const home = join(this.ws(issue), ".sandbox", "copilot-home");
    mkdirSync(home, { recursive: true });
    // Its policy, config and MCP servers, as Factory's own: whatever an earlier run left there (a link included) is replaced.
    const files = { "settings.json": JSON.stringify(copilotLocalSettings({ domains: this.domains(), clone, addDirs, readOnly: [usageDir] }), null, 2), ...copilotHomeFiles() };
    for (const [f, text] of Object.entries(files)) {
      // A directory an earlier run left under the name too.
      rmSync(join(home, f), { force: true, recursive: true });
      writeFileSync(join(home, f), text, { mode: 0o600, flag: "wx" });
    }
    // On macOS Copilot's sandbox cannot read ~/.gitconfig and git then refuses to run; the clone's own config carries
    // Factory's identity and credential helper, so git skips the global file (which may hold credentials anyway).
    return { COPILOT_HOME: home, COPILOT_GITHUB_TOKEN: this.copilotToken, GIT_CONFIG_GLOBAL: "/dev/null" };
  }

  /** Run worker.mjs or review.mjs as a child; its lines are echoed with the issue and stage. */
  async stage(issue, name, script, args) {
    // Stopping: nothing new starts (the claim stays and this machine's next serve resumes the Objective).
    if (this.stopping) return { code: null, exit: null, usd: null, usageDir: null };
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
    // The stage's own temp directory, short (srt's sockets live there; a socket path has a 108-byte limit) and the
    // only temp space any sandbox may write: with /tmp itself writable, sandboxed code could swap this directory for
    // a symlink into the home directory before the next sandbox opens it. Removed when the stage ends or fails to
    // start; one a killed loop left is cleared when the next stage on this machine makes its own (lib/local.mjs stageTemp).
    const stageTmp = stageTemp(`${issue}-`);
    let env;
    try {
      env = this.stageEnv(issue, usageDir, clone, stageTmp);
      // Fresh: what an earlier stage or run left untracked in this reused clone goes (lib/local.mjs prepareClone).
      await prepareClone(clone, [env.pnpm_config_store_dir, env.BUN_INSTALL_CACHE_DIR], (inner) => exec(...BACKENDS.local.sandbox.git(inner, env), { env }), { fresh: true });
    } catch (e) {
      dropOwned(stageTmp);
      if (e.code !== "outer-sandbox") throw e;
      log(`#${issue}: refusing to run: ${e.message}`);
      await this.block(issue, name, copilotOuterReason);
      return { code: null, exit: "blocked", usd: null, usageDir };
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
      const child = spawn(process.execPath, [join(PLUGIN_ROOT, "scripts", script), "--repo", this.repoFull, ...args, "--checkout", clone, "--usage-dir", usageDir, "--token-fd", "3", ...notice], { env, stdio: ["ignore", "pipe", "pipe", "pipe", ...(this.notice ? ["ipc"] : [])] });
      child.stdio[3].on("error", () => {});
      child.stdio[3].end(this.token);
      if (this.notice) serveNotices(child, this.notice);
      this.children.add(child);
      const relay = (chunk) => {
        appendOwn(logFile, chunk);
        for (const line of String(chunk).split("\n")) if (line.trim()) process.stdout.write(`[#${issue} ${name}] ${line}\n`);
      };
      child.stdout.on("data", relay);
      child.stderr.on("data", relay);
      child.on("close", (code) => {
        this.children.delete(child);
        let result = null;
        try {
          result = JSON.parse(readFileSync(join(usageDir, "result.json"), "utf8"));
        } catch {
          // no record: the child failed before writing one
        }
        dropOwned(stageTmp);
        done({ code, exit: result?.exit ?? null, usd: result?.usd ?? null, usageDir });
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
  async block(issue, name, reason, { key = null, gh = { findPr, removeLabel, applyExit } } = {}) {
    const inputs = resolveInputs({ args: { repo: this.repoFull }, env: this.baseEnv() });
    const pr = await gh.findPr(this.repo, `factory/${issue}`, this.opts).catch(() => null);
    if (pr) await gh.removeLabel(this.repo, pr.number, REVIEW_LABEL, this.opts).catch((e) => log(`#${issue} review label: ${e.message.slice(0, 120)}`));
    await gh.applyExit(this.repo, { issue, pr, exit: "blocked", reason, key, notify: inputs.notify, stage: name }, this.opts);
  }

  /** Hold the Objective for the length of fn: a claim with a heartbeat the Actions path and other loops respect. */
  async withClaim(issue, fn) {
    const active = await activeWorkIssues(this.repo, this.opts).catch(() => new Set());
    if (active.has(issue)) {
      log(`#${issue}: an Actions worker job is running it; local mode leaves it alone`);
      return { exit: "skipped" };
    }
    const held = await localClaim(this.repo, issue, this.opts).catch(() => null);
    if (held?.fresh && held.holder !== this.holder && !deadHereHolder(held.holder)) {
      log(`#${issue}: another local loop holds it (${held.holder}); leaving it alone`);
      return { exit: "skipped" };
    }
    await writeClaim(this.repo, issue, this.holder, this.opts);
    // Two loops writing at once: the comment's last writer holds it, and the other steps aside. A short random wait
    // lets both writes land before either reads back, so both cannot read their own.
    await new Promise((r) => setTimeout(r, 1500 + Math.floor(Math.random() * 1500)));
    const mine = await localClaim(this.repo, issue, this.opts).catch(() => null);
    if (mine?.holder !== this.holder) {
      log(`#${issue}: another local loop claimed it first; leaving it alone`);
      return { exit: "skipped" };
    }
    const beat = setInterval(() => writeClaim(this.repo, issue, this.holder, this.opts).catch((e) => log(`#${issue} heartbeat: ${e.message.slice(0, 120)}`)), HEARTBEAT_MS);
    try {
      return await fn();
    } finally {
      clearInterval(beat);
      // Stopping serve pauses its work: the claim stays, goes stale, and this machine's next serve resumes it.
      if (!this.stopping) await dropClaim(this.repo, issue, this.holder, this.opts);
    }
  }

  /**
   * Running or In-review Objectives a loop on this machine held when it went away (serve stopped, the machine slept or
   * restarted): ours to resume, at once when that loop's process is gone, else once its heartbeat is stale.
   */
  async pausedHere(running) {
    const out = [];
    const issues = [];
    for (const label of ["factory:running", "factory:in-review"]) issues.push(...(await listIssuesByLabel(this.repo, label, this.opts).catch(() => [])));
    for (const issue of issues) {
      if (running.has(issue.number) || out.includes(issue.number)) continue;
      if (!BACKENDS.local.trigger.routes(issue, this.baseEnv())) continue;
      const c = await localClaim(this.repo, issue.number, this.opts).catch(() => null);
      if (c && sameMachineHolder(c.holder) && c.holder !== this.holder && (!c.fresh || deadHereHolder(c.holder))) out.push(issue.number);
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
      // Of .factory only <issue>/claude-project is writable from a sandbox (claudeProjectLink); rmSync removes a link, never its target, so nothing planted there is followed.
      rmSync(join(root, name), { recursive: true, force: true });
      // And the link to its Claude Code project, if a stage made one (lib/local.mjs claudeProjectLink).
      dropClaudeProjectLink(join(root, name, "repo"), process.env);
      log(`#${issue}: closed; removed its local directory .factory/${name}`);
    }
  }

  /** Pick a paused Objective up where it stands: its open PR's review, else its work from the clone and saved sessions. */
  async resume(issue) {
    const pr = await findPr(this.repo, `factory/${issue}`, this.opts).catch(() => null);
    // A PR still waiting for its review pass goes to review (as pendingReviews); Running work (a first run, or a
    // send-back rebase) runs again; anything else (reviewed, waiting in the merge queue) needs nothing here.
    if (pr && !pr.draft && (pr.labels || []).some((l) => l.name === REVIEW_LABEL)) return this.withClaim(issue, () => this.review(issue, pr.number));
    const data = await getIssue(this.repo, issue, this.opts).catch(() => null);
    if ((data?.labels || []).some((l) => (typeof l === "string" ? l : l.name) === "factory:running")) return this.runObjective(issue);
    log(`#${issue}: nothing left to run here (its PR is reviewed or gone); releasing the claim`);
    const held = await localClaim(this.repo, issue, this.opts).catch(() => null);
    if (held?.commentId && sameMachineHolder(held.holder)) await rest(`repos/${this.repo.full}/issues/comments/${held.commentId}`, { ...this.opts, method: "DELETE" }).catch(() => {});
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
  runObjective(issue, { wait = false } = {}) {
    return this.withClaim(issue, () => this.work(issue, { wait }));
  }

  /** The work stage, then its review: in a claim this loop holds. */
  async work(issue, { wait = false } = {}) {
    const work = await this.stage(issue, "work", "worker.mjs", ["--issue", String(issue)]);
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
    await gh.applyExit(this.repo, { issue, pr, exit: "blocked", reason, notify: inputs.notify, stage: "merge" }, this.opts).catch((x) => log(`#${issue} Block: ${String(x?.message || x).slice(0, 160)}`));
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
      if (!data || isBlocked(data) || !BACKENDS.local.trigger.routes(data, this.baseEnv())) continue;
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
    while (Date.now() < until) {
      // The merge pass the dispatcher runs (session.mjs mergeReadyOne): this loop holds the Objective, so it runs it.
      if (inputs.autoMerge) {
        const report = {};
        const how = await mergeReadyOne(this.repo, { issue, prNumber, queue, checkNames: inputs.ciChecks, report, hungMs, cache }, this.opts).catch((e) => log(`#${issue} merge: ${e.message.slice(0, 160)}`));
        const why = mergeBlockReason(how, report);
        if (why) {
          await applyExit(this.repo, { issue, pr: await getPr(this.repo, prNumber, this.opts).catch(() => null), exit: "blocked", reason: why, notify: inputs.notify, stage: "merge" }, this.opts);
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
      await new Promise((r) => setTimeout(r, pollMs));
    }
    log(`#${issue}: PR #${prNumber} not merged after ${Math.round(timeoutMs / 60000)} min; the dispatcher takes it from here`);
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
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      this.stopping = true;
      log(`stopping: ending ${this.children.size} stage process(es); their Objectives stay Running, paused, and serve on this machine resumes them (the dispatcher Blocks one only after a day away)`);
      for (const child of this.children) child.kill("SIGTERM");
      await Promise.race([Promise.allSettled(running.values()), new Promise((r) => setTimeout(r, 30_000))]);
      process.exit(130);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    let cleaned = 0;
    while (!this.stopping) {
      // Every 10 minutes, and at start: closed Objectives' directories go.
      if (Date.now() - cleaned > 10 * 60_000) {
        cleaned = Date.now();
        await this.cleanup(running).catch((e) => log(`cleanup: ${e.message.slice(0, 160)}`));
      }
      const inputs = resolveInputs({ args: { repo: this.repoFull }, env: { ...this.baseEnv(), FACTORY_INPUT_GITHUB_TOKEN: this.token } });
      // This machine's paused work resumes first, then reviews (they finish work in flight); new work gets the rest.
      const resumes = (await this.pausedHere(running)).slice(0, Math.max(0, limit - running.size));
      for (const n of resumes) {
        log(`#${n}: resuming (this machine held it when it went away)`);
        running.set(n, track(n, this.resume(n)).catch((e) => log(`#${n} resume failed: ${e.message.slice(0, 200)}`)).finally(() => running.delete(n)));
      }
      const pending = (await this.pendingReviews()).filter((r) => !running.has(r.issue));
      const reviews = pending.slice(0, Math.max(0, limit - running.size));
      const localHeld = Object.fromEntries([...running.keys()].map((n) => [n, "its stage runs on this box"]));
      const given = new Map(stopped);
      const localStopped = Object.fromEntries([...given].map(([n, s]) => [n, s.why]));
      const result = await dispatch(inputs, { token: this.token, notice: this.notice, localSlots: Math.max(0, limit - running.size - reviews.length), localHeld, localStopped }).catch((e) => {
        log(`dispatch failed: ${e.message.slice(0, 200)}`);
        return { ready: [] };
      });
      for (const n of result.released || []) if (stopped.get(n) === given.get(n)) stopped.delete(n);
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
  const committed = await gitIn(dir, ["show", `origin/${defaultBranch}:.github/workflows/factory.yml`]).then((r) => workflowEnv(r.stdout), () => ({}));
  const inputs = resolveInputs({ args: { repo: repoFull }, env: { ...process.env, ...committed } });
  await primeWriters(repo, opts, { maintainers: inputs.maintainers });
  return { defaultBranch, inputs };
}

/** A session's refusal of an issue whose author or last editor cannot vouch for it: the Blocked notice's words. */
const untrustedRefusal = (t, what) => new Error(`${what}: ${t.reason}. ${t.fix}`);

/**
 * `factory issue <issue> [--out FILE]`: the issue as a session reads it (/factory:run --here, /factory:review), written
 * to --out (default $FACTORY_IN/issue.md, else <git dir>/factory-in/issue.md) as the worker writes it: the title and
 * body read with their author and last editor, only when both can push or are pinned maintainers. Otherwise nothing is
 * written, the reason and its fix go to stderr, and the exit code is 1: the body never reaches the session. Writes
 * nothing to GitHub.
 */
async function issueForSession(issue, flags) {
  const clone = sessionClone(flags);
  await sessionInputs(clone);
  const t = await trustedIssue(clone.repo, issue, await getIssue(clone.repo, issue, clone.opts), clone.opts);
  if (!t.ok) throw untrustedRefusal(t, `#${issue} is not given to this session`);
  const file = resolve(flags.out || join(process.env.FACTORY_IN || resolve(clone.dir, sh("git", ["-C", clone.dir, "rev-parse", "--git-dir"]), "factory-in"), "issue.md"));
  mkdirSync(resolve(file, ".."), { recursive: true });
  writeFileSync(file, inFiles({ issue, issueTitle: t.issueData.title, issueBody: t.issueData.body })["issue.md"]);
  log(`#${issue}: written by ${t.people.map(([role, login]) => `${role} ${login}`).join(", ")}; ${file}`);
  return 0;
}

/**
 * `factory deliver <issue>`: Factory's half of an Objective worked in a session (/factory:run --here). The session
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
  // Run from a session (/factory:run --here), so the App's key is not read here: notices post with this token.
  if (process.env.FACTORY_LOCAL_APP_ID) log("notices post with your own token here, so their @mention notifies no one; the App posts them only for serve and run");
  const { defaultBranch, inputs } = await sessionInputs(clone);
  // The worker's check, made again here: the body the session read may have been edited since by someone who cannot push.
  const trusted = await authorGate({ repo, issue, issueData: await getIssue(repo, issue, opts), notify: inputs.notify, opts, apply: applyExit });
  if (!trusted.ok) {
    log(`#${issue}: blocked, nothing pushed: ${trusted.reason}`);
    return 1;
  }
  const { issueData } = trusted;
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
    await planSync(repo, issue, opts)(files["plan.md"]);
    await postNote(repo, issue, files["note.md"], opts);
    await applyExit(repo, { issue, pr: asking, exit: "question", reason: planNeeds, notify: inputs.notify, stage: "work", askOnIssue: true }, opts);
    if (needs.repos.length) await progressReporter(repo, issue, opts, { stage: "work" }).planAsked(needs.repos);
    log(`#${issue}: question at plan time (${planNeeds}); nothing pushed`);
    return 1;
  }
  // A Question that names no test of the Question rule is checked in the session before anything is delivered.
  if (record.unfounded?.length) throw new Error(`nothing was delivered: ${questionCheckPrompt(record, { file: true })} Then run deliver again.`);
  // Factory's push (lib/outbox.mjs): checked in its own mirror (protected paths, Git LFS), leased, read back.
  const tmp = privateTmp({ ...process.env });
  try {
    const outbox = await openOutbox({ branch, defaultBranch, checkout: dir, remote: `https://github.com/${repo.full}.git`, token: () => opts.token, agentEnv: process.env, local: true, protectedList: protectedPaths(inputs.protectedAdditions), base: tmp.factory });
    // A merge Factory makes itself here (the default branch's workflow change, an unsynced checkout) carries the
    // identity of the token that pushes it, as on every other route.
    outbox.author = commitAuthor(await gitIdentity(null, opts.token));
    if (!(await outbox.push())) throw new Error(`nothing was delivered: ${outbox.error}`);
  } finally {
    dropOwned(tmp.factory);
  }
  await planSync(repo, issue, opts)(files["plan.md"]);
  const prior = await partsRecord(repo, issue, opts).catch(() => null);
  const open = await findPr(repo, branch, opts).catch(() => null);
  const left = record.part ? record.part.remaining.length : open && isSplitPart(prior, open.number) ? prior.remaining : 0;
  let pr = await publishPr(repo, { branch, base: defaultBranch, issue, issueTitle: issueData.title, prText: files["pr.md"], splitPart: left > 0, pr: open }, opts);
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
  await applyExit(repo, { issue, pr, exit: record.exit, reason: record.exit === "question" ? `question: ${(record.questions[0] || "").slice(0, 200)}` : record.reason, notify: inputs.notify, stage: "work" }, opts);
  log(`#${issue}: ${record.exit}; PR #${pr.number} ${pr.html_url}${replied ? `; ${replied} repl${replied === 1 ? "y" : "ies"} posted` : ""}`);
  return record.exit === "delivered" ? 0 : 1;
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
 * `factory post-review <pr> <findings.json>`: post a reviewer pass made in a session (/factory:review) as Factory's one
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
  const flags = parse(process.argv.slice(2));
  const [cmd, issueArg] = flags._;
  if (cmd === "run") {
    const issue = Number(issueArg);
    if (!Number.isInteger(issue) || issue <= 0) throw new Error("usage: local.mjs run <issue> [--wait]");
    const local = await new Local(flags).init();
    let r = await local.runObjective(issue, { wait: !!flags.wait });
    // --wait on a split Objective: each part runs once the one before it merged.
    while (r.next) r = await local.runObjective(issue, { wait: true });
    process.exitCode = r.exit === "delivered" ? 0 : 1;
    return;
  }
  if (cmd === "issue") {
    const issue = Number(issueArg);
    if (!Number.isInteger(issue) || issue <= 0) throw new Error("usage: local.mjs issue <issue> [--out FILE]");
    process.exitCode = await issueForSession(issue, flags);
    return;
  }
  if (cmd === "deliver") {
    const issue = Number(issueArg);
    if (!Number.isInteger(issue) || issue <= 0) throw new Error("usage: local.mjs deliver <issue> [--out DIR]");
    process.exitCode = await deliver(issue, flags);
    return;
  }
  if (cmd === "post-review") {
    const pr = Number(issueArg);
    if (!Number.isInteger(pr) || pr <= 0 || !flags._[2]) throw new Error("usage: local.mjs post-review <pr> <findings.json>");
    process.exitCode = await postFindings(pr, flags._[2], flags);
    return;
  }
  if (cmd === "review") {
    const pr = Number(issueArg);
    if (!Number.isInteger(pr) || pr <= 0) throw new Error("usage: local.mjs review <pr> [--wait]");
    const r = await (await new Local(flags).init()).runReview(pr, { wait: !!flags.wait });
    process.exitCode = r.exit === "delivered" ? 0 : 1;
    return;
  }
  if (cmd === "serve") {
    await (await new Local(flags).init()).serve({ once: !!flags.once, intervalMs: Number(flags.interval || 30) * 1000 });
    return;
  }
  throw new Error("usage: local.mjs run <issue> [--wait] | review <pr> [--wait] | serve [--once] [--all] | issue <issue> [--out FILE] | deliver <issue> [--out DIR] | post-review <pr> <findings.json>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    process.stderr.write(`[factory] local: ${e.message}\n`);
    process.exit(1);
  });
}
