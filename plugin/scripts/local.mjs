#!/usr/bin/env node
// Factory local mode: the same worker and reviewer the Action runs, on a developer's own box.
//   node scripts/local.mjs run <issue> [--repo OWNER/NAME] [--dir CLONE] [--wait]
//   node scripts/local.mjs review <pr> [--wait]      (a review re-run, as re-applying factory:review does on Actions)
//   node scripts/local.mjs serve [--repo OWNER/NAME] [--dir CLONE] [--once] [--all] [--interval SECONDS (30)]
// Routing: an Objective labelled factory:local is the local loop's and the Actions path leaves it alone;
// serve takes only those unless --all (FACTORY_LOCAL_ALL=1). A claim comment with a heartbeat marks one in flight.
// Needs git, gh, the harness CLI (claude or codex logged in; copilot with a Copilot Requests token in
// COPILOT_GITHUB_TOKEN or ~/.config/factory/copilot-token, plus slirp4netns and iptables on Linux), srt
// (npm i -g @anthropic-ai/sandbox-runtime), ripgrep and, on Linux and WSL2, bubblewrap and socat; and a
// fine-grained token for this one repository, in FACTORY_LOCAL_TOKEN or ~/.config/factory/tokens/<owner>/<name>
// (contents, issues and pull requests read and write; actions read). That token is all the GitHub reach the
// model gets. No App, no vendor, no API key; GitHub holds every piece of state, and the box holds one clone per
// Objective under <clone>/.factory/<issue>/. Factory's own setup, install and validation commands run in the
// same sandbox as the harness, since they run on a tree the model edited. A sandbox has no route to the box's
// services: with FACTORY_LOCAL_DB=1 every validation command runs through plugin/bin/factory-db, which starts a fresh
// Postgres inside the sandbox (init step: FACTORY_LOCAL_DB_INIT), and the task card tells the model to do the same.
import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname, platform, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { dispatch } from "./dispatch.mjs";
import { PLUGIN_ROOT } from "./lib/checkout.mjs";
import { activeWorkIssues, ensureLabel, findPr, findProject, getIssue, getPr, moveCard, repoOf, rest, setStateLabel } from "./lib/github.mjs";
import { log, resolveInputs } from "./lib/inputs.mjs";
import { HEARTBEAT_MS, LOCAL_DOMAINS, LOCAL_LABEL, codexLocalConfig, copilotLocalSettings, dropClaim, localBaseEnv, localClaim, readWorkflowEnv, routedHere, srtSettings, writeClaim } from "./lib/local.mjs";
import { REVIEW_LABEL } from "./lib/logic.mjs";

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
const onPath = (bin) => !!sh("sh", ["-c", `command -v ${bin} || true`]);
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
export function repoFromRemote(url) {
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(\.git)?\/?$/.exec(url || "");
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Today's local spend, from the spend lines each stage appends; the dispatcher adds it to the artifacts' sum. */
export function localSpentToday(dev, day = new Date().toISOString().slice(0, 10)) {
  const root = join(dev, ".factory");
  if (!existsSync(root)) return 0;
  let usd = 0;
  for (const d of readdirSync(root)) {
    const f = join(root, d, "spend.jsonl");
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, "utf8").split("\n")) {
      try {
        const r = JSON.parse(line);
        if (String(r.at).startsWith(day) && Number.isFinite(r.usd)) usd += r.usd;
      } catch {
        // a partial line
      }
    }
  }
  return usd;
}

function preflight(harness, repoFull, token, copilotToken) {
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
  if (platform() === "win32") problems.push("native Windows has no sandbox for the harness; run local mode inside WSL2");
  // macOS's sandbox has no network namespace of its own: a throwaway Postgres there would listen on the box's loopback.
  if (platform() === "darwin" && (process.env.FACTORY_LOCAL_DB || "") === "1") problems.push("FACTORY_LOCAL_DB runs on Linux and WSL2 only: macOS's sandbox shares the box's loopback, so a throwaway database would be reachable from outside it");
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

class Local {
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
    if (problems.length) throw new Error(`local mode cannot start:\n- ${problems.join("\n- ")}`);
    this.opts = { token: this.token };
    // One holder id per loop: two loops (two boxes, or run beside serve) never share or clear each other's claim.
    this.holder = `${hostname()}:${process.pid}:${randomBytes(3).toString("hex")}`;
    this.children = new Set();
    this.excludeWorkspaces();
  }

  /** The token check and the routing label; both need the network. */
  async init() {
    await checkToken(this.repoFull, this.token);
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
    if (existsSync(join(dir, ".git"))) return dir;
    mkdirSync(this.ws(issue), { recursive: true });
    const helper = "!f() { echo username=x-access-token; echo \"password=$FACTORY_LOCAL_TOKEN\"; }; f";
    const code = await new Promise((done) => {
      const child = spawn("git", ["-c", "credential.helper=", "-c", `credential.helper=${helper}`, "clone", "-q", "--reference-if-able", this.dev, "--dissociate", `https://github.com/${this.repoFull}.git`, dir], { env: { ...localBaseEnv(process.env), FACTORY_LOCAL_TOKEN: this.token }, stdio: ["ignore", "inherit", "inherit"] });
      child.on("close", done);
    });
    if (code !== 0) throw new Error(`git clone of ${this.repoFull} failed (exit ${code})`);
    return dir;
  }

  /** The env every child starts from: an allow-list plus the repository's FACTORY_* settings, never the whole shell. */
  baseEnv() {
    const wf = { ...this.wf };
    // The workflow's models belong to its harness: a developer who picks another one locally gets that one's defaults.
    if ((wf.FACTORY_HARNESS || "claude").toLowerCase() !== this.harness) for (const k of ["FACTORY_MODEL", "FACTORY_SUBAGENT_MODEL", "FACTORY_REVIEWER_MODEL", "FACTORY_EFFORT"]) delete wf[k];
    // The developer's own harness, model and session settings win over the workflow's.
    for (const k of ["FACTORY_MODEL", "FACTORY_SUBAGENT_MODEL", "FACTORY_REVIEWER_MODEL", "FACTORY_EFFORT", "FACTORY_RESUME_POLICY", "FACTORY_COMPACTION_WINDOW"]) if (process.env[k]) wf[k] = process.env[k];
    const env = { ...localBaseEnv(process.env, list(process.env.FACTORY_LOCAL_ENV || this.wf.FACTORY_LOCAL_ENV)), ...wf };
    // The developer's own FACTORY_LOCAL_* settings win over the workflow's.
    for (const [k, v] of Object.entries(process.env)) if (k.startsWith("FACTORY_LOCAL_") && k !== "FACTORY_LOCAL_TOKEN") env[k] = v;
    return { ...env, FACTORY_HARNESS: this.harness, FACTORY_LOCAL: "1", FACTORY_LOCAL_ALL: process.env.FACTORY_LOCAL_ALL || "" };
  }

  /** One stage's env: the base, the scoped token, and the sandbox both the harness and Factory's own commands run in. */
  stageEnv(issue, usageDir, clone) {
    const ws = this.ws(issue);
    const npmCache = join(ws, "npm-cache");
    mkdirSync(npmCache, { recursive: true });
    // The settings Factory's own commands run under sit outside every writable directory: in the usage directory
    // the model could loosen the sandbox its own validation runs in.
    const sandboxDir = join(ws, ".sandbox");
    mkdirSync(sandboxDir, { recursive: true });
    const srtFile = join(sandboxDir, `srt-${basename(usageDir)}.json`);
    // The stage's own temp directory, short (srt's sockets live there; a socket path has a 108-byte limit) and the
    // only temp space any sandbox may write: with /tmp itself writable, sandboxed code could swap this directory for
    // a symlink into the home directory before the next sandbox opens it. The stage removes it when it ends.
    const stageTmp = mkdtempSync(join(tmpdir(), `factory-${issue}-`));
    writeFileSync(srtFile, JSON.stringify(srtSettings({ domains: this.domains(), writable: [clone, usageDir, npmCache, stageTmp], clone, readOnly: [join(usageDir, "bin")] }), null, 2));
    // Factory's helpers (factory-db) are copied into the stage's usage directory and lead PATH: Claude Code's sandbox
    // shows nothing under the home directory beyond the working and added directories, so plugin/bin is out of its sight.
    const binDir = join(usageDir, "bin");
    mkdirSync(binDir, { recursive: true });
    for (const tool of readdirSync(join(PLUGIN_ROOT, "bin"))) {
      copyFileSync(join(PLUGIN_ROOT, "bin", tool), join(binDir, tool));
      chmodSync(join(binDir, tool), 0o755);
    }
    const base = this.baseEnv();
    const extra = this.harnessEnv(issue, usageDir, npmCache, clone, stageTmp);
    // Last on PATH, so nothing there can ever stand in for git, gh, srt or claude in Factory's own unsandboxed calls;
    // and neither sandbox may write it (FACTORY_LOCAL_SANDBOX.readOnly, srt denyWrite), so nothing can be planted.
    base.PATH = `${base.PATH || ""}:${binDir}`;
    return {
      ...base,
      FACTORY_CREDENTIAL: "login",
      // The workflow's setup assumes a runner (sudo, a fresh VM); on a box the toolchain is the box's own.
      FACTORY_SETUP: process.env.FACTORY_LOCAL_SETUP ?? this.wf.FACTORY_LOCAL_SETUP ?? "",
      FACTORY_APP_TOKEN: this.token,
      GH_TOKEN: this.token,
      FACTORY_INPUT_GITHUB_TOKEN: this.token,
      FACTORY_PLUGIN_ROOT: PLUGIN_ROOT,
      FACTORY_USAGE_DIR: usageDir,
      // gh's config and git's token file sit inside this stage's usage directory: Claude Code's sandbox shows nothing
      // under the home directory beyond the working directory and the added directories.
      FACTORY_AUTH_DIR: join(usageDir, "auth"),
      npm_config_cache: npmCache,
      FACTORY_LOCAL_SRT: srtFile,
      // Writable beyond the clone: this stage's usage directory and the npm cache only (not the spend log).
      TMPDIR: stageTmp,
      FACTORY_LOCAL_SANDBOX: JSON.stringify({ addDirs: [usageDir, npmCache, stageTmp], domains: this.domains(), clone, readOnly: [join(usageDir, "bin")] }),
      ...extra,
    };
  }

  /** What the harness's own sandbox needs beyond the shared env: Copilot its home and token. */
  harnessEnv(issue, usageDir, npmCache, clone, stageTmp) {
    if (this.harness !== "copilot") return {};
    // One Copilot home per Objective, outside every writable directory: it holds the sandbox policy (which the
    // model must not loosen) and the sessions a later stage resumes.
    const home = join(this.ws(issue), ".sandbox", "copilot-home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "settings.json"), JSON.stringify(copilotLocalSettings({ domains: this.domains(), clone, addDirs: [usageDir, npmCache, stageTmp], readOnly: [join(usageDir, "bin")] }), null, 2));
    // On macOS Copilot's sandbox cannot read ~/.gitconfig and git then refuses to run; the clone's own config carries
    // Factory's identity and credential helper, so git skips the global file (which may hold credentials anyway).
    return { COPILOT_HOME: home, COPILOT_GITHUB_TOKEN: this.copilotToken, GIT_CONFIG_GLOBAL: "/dev/null" };
  }

  /** Run worker.mjs or review.mjs as a child; its lines are echoed with the issue and stage. */
  async stage(issue, name, script, args) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const usageDir = join(this.ws(issue), `usage-${name}-${stamp}`);
    mkdirSync(usageDir, { recursive: true });
    const logFile = join(usageDir, "stage.log");
    const clone = await this.ensureClone(issue);
    return new Promise((done) => {
      const env = this.stageEnv(issue, usageDir, clone);
      const child = spawn(process.execPath, [join(PLUGIN_ROOT, "scripts", script), "--repo", this.repoFull, ...args, "--checkout", clone, "--usage-dir", usageDir], { env, stdio: ["ignore", "pipe", "pipe"] });
      this.children.add(child);
      const relay = (chunk) => {
        appendFileSync(logFile, chunk);
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
        if (env.TMPDIR && env.TMPDIR !== process.env.TMPDIR) rmSync(env.TMPDIR, { recursive: true, force: true });
        if (Number.isFinite(result?.usd)) appendFileSync(join(this.ws(issue), "spend.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), stage: name, usd: result.usd })}\n`);
        done({ code, exit: result?.exit ?? null, usd: result?.usd ?? null, usageDir });
      });
    });
  }

  /** Hold the Objective for the length of fn: a claim with a heartbeat the Actions path and other loops respect. */
  async withClaim(issue, fn) {
    const active = await activeWorkIssues(this.repo, this.opts).catch(() => new Set());
    if (active.has(issue)) {
      log(`#${issue}: an Actions worker job is running it; local mode leaves it alone`);
      return { exit: "skipped" };
    }
    const held = await localClaim(this.repo, issue, this.opts).catch(() => null);
    if (held?.fresh && held.holder !== this.holder) {
      log(`#${issue}: another local loop holds it (${held.holder}); leaving it alone`);
      return { exit: "skipped" };
    }
    await writeClaim(this.repo, issue, this.holder, this.opts);
    // Two loops writing at once: the comment's last writer holds it, and the other steps aside.
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
      await dropClaim(this.repo, issue, this.holder, this.opts);
    }
  }

  async review(issue, prNumber, { wait = false } = {}) {
    const review = await this.stage(issue, "review", "review.mjs", ["--pr", String(prNumber)]);
    log(`#${issue} review of PR #${prNumber}: ${review.exit ?? `no exit record (code ${review.code})`}${review.usd != null ? `, $${review.usd.toFixed(2)}` : ""}`);
    if (wait && review.exit === "delivered") await this.followMerge(issue, prNumber);
    return review;
  }

  /** One Objective, start to delivered review (and, with `wait`, to merged). */
  runObjective(issue, { wait = false } = {}) {
    return this.withClaim(issue, async () => {
      const work = await this.stage(issue, "work", "worker.mjs", ["--issue", String(issue)]);
      log(`#${issue} work: ${work.exit ?? `no exit record (code ${work.code})`}${work.usd != null ? `, $${work.usd.toFixed(2)}` : ""}`);
      if (work.exit !== "delivered") return work;
      const pr = await findPr(this.repo, `factory/${issue}`, this.opts).catch(() => null);
      return pr ? this.review(issue, pr.number, { wait }) : work;
    });
  }

  /** A review re-run on its own (a human re-applied factory:review), in the Objective's clone. */
  async runReview(prNumber, { wait = false } = {}) {
    const pr = await getPr(this.repo, prNumber, this.opts);
    const issue = Number(/^factory\/(\d+)$/.exec(pr.head?.ref || "")?.[1]);
    if (!issue) throw new Error(`PR #${prNumber} is not on a factory/<issue> branch`);
    return this.withClaim(issue, () => this.review(issue, prNumber, { wait }));
  }

  /** Open PRs labelled factory:review whose Objective is routed here and held by no loop: the label is the review trigger, as on Actions. */
  async pendingReviews() {
    const prs = (await rest(`repos/${this.repo.full}/pulls?state=open&per_page=100`, { ...this.opts, paginate: true }).catch(() => [])) || [];
    const out = [];
    for (const pr of prs) {
      const issue = Number(/^factory\/(\d+)$/.exec(pr.head?.ref || "")?.[1]);
      if (!issue || !(pr.labels || []).some((l) => l.name === REVIEW_LABEL)) continue;
      const data = await getIssue(this.repo, issue, this.opts).catch(() => null);
      if (!data || !routedHere(data, this.baseEnv())) continue;
      if ((await localClaim(this.repo, issue, this.opts).catch(() => null))?.fresh) continue;
      out.push({ issue, pr: pr.number });
    }
    return out;
  }

  /** --wait: follow the PR through the merge queue, then do the bookkeeping the dispatcher does on a merge. */
  async followMerge(issue, prNumber, { timeoutMs = 120 * 60_000, pollMs = 60_000 } = {}) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const pr = await getPr(this.repo, prNumber, this.opts).catch(() => null);
      if (pr?.merged_at) {
        await setStateLabel(this.repo, issue, null, this.opts).catch(() => {});
        const project = await findProject(this.repo, this.opts).catch(() => null);
        if (project) await moveCard(project, this.repo, issue, "Done", this.opts).catch(() => {});
        log(`#${issue}: PR #${prNumber} merged; card Done`);
        return true;
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

  /** The dispatcher's own rules (caps, order, blocking, send-backs, Done), every interval; picks run here. */
  async serve({ once = false, intervalMs = 30_000 } = {}) {
    const running = new Map();
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      log(`stopping: ending ${this.children.size} stage process(es) and releasing their claims; an Objective left Running is Blocked by the dispatcher after 15 min, and re-applying its label brings it back`);
      for (const child of this.children) child.kill("SIGTERM");
      await Promise.race([Promise.allSettled(running.values()), new Promise((r) => setTimeout(r, 30_000))]);
      process.exit(130);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    for (;;) {
      const inputs = resolveInputs({ args: { repo: this.repoFull }, env: { ...this.baseEnv(), FACTORY_INPUT_GITHUB_TOKEN: this.token } });
      const result = await dispatch(inputs, { token: this.token, localSpentUsd: localSpentToday(this.dev) }).catch((e) => {
        log(`dispatch failed: ${e.message.slice(0, 200)}`);
        return { ready: [] };
      });
      const picks = (result.ready || []).filter((n) => !running.has(n));
      const reviews = (await this.pendingReviews()).filter((r) => !running.has(r.issue) && !picks.includes(r.issue));
      log(`tick: ${picks.length ? `starting ${picks.map((n) => `#${n}`).join(", ")}` : "nothing ready"}${reviews.length ? `; reviewing ${reviews.map((r) => `PR #${r.pr}`).join(", ")}` : ""}${result.reason ? ` (${result.reason})` : ""}; ${running.size} in flight here, $${localSpentToday(this.dev).toFixed(2)} spent locally today`);
      for (const n of picks) running.set(n, this.runObjective(n).catch((e) => log(`#${n} failed: ${e.message.slice(0, 200)}`)).finally(() => running.delete(n)));
      for (const r of reviews) running.set(r.issue, this.withClaim(r.issue, () => this.review(r.issue, r.pr)).catch((e) => log(`PR #${r.pr} review failed: ${e.message.slice(0, 200)}`)).finally(() => running.delete(r.issue)));
      if (once) {
        await Promise.all(running.values());
        return;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}

async function main() {
  const flags = parse(process.argv.slice(2));
  const [cmd, issueArg] = flags._;
  if (cmd === "run") {
    const issue = Number(issueArg);
    if (!Number.isInteger(issue) || issue <= 0) throw new Error("usage: local.mjs run <issue> [--wait]");
    const r = await (await new Local(flags).init()).runObjective(issue, { wait: !!flags.wait });
    process.exitCode = r.exit === "delivered" ? 0 : 1;
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
  throw new Error("usage: local.mjs run <issue> [--wait] | review <pr> [--wait] | serve [--once] [--all]");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    process.stderr.write(`[factory] local: ${e.message}\n`);
    process.exit(1);
  });
}
