#!/usr/bin/env node
// Factory local mode: the same worker and reviewer the Action runs, on a developer's own box.
//   node scripts/local.mjs run <issue> [--repo OWNER/NAME] [--dir CLONE] [--wait]
//   node scripts/local.mjs review <pr> [--wait]      (a review re-run, as re-applying factory:review does on Actions)
//   node scripts/local.mjs serve [--repo OWNER/NAME] [--dir CLONE] [--once]
// Routing: an Objective labelled factory:local is the local loop's and the Actions path leaves it alone;
// serve takes only those unless FACTORY_LOCAL_ALL=1. A claim comment with a heartbeat marks one in flight.
// Needs git, gh (logged in), the harness CLI (logged in) and, on Linux and WSL2, bubblewrap and
// socat for Claude Code's sandbox. No App, no vendor, no API key: pushes, PRs and labels go out
// under the developer's own gh login, which triggers the repository's CI. GitHub holds every piece
// of state; the box holds one clone per Objective under <clone>/.factory/<issue>/.
// `run` works one Objective: claim it, run the worker, then the reviewer in the same clone, and
// with --wait follow the PR until it merges. `serve` asks the dispatcher what is ready every
// minute (the repository's caps, order and blocking rules) and runs each pick the same way.
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { hostname, platform } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { dispatch } from "./dispatch.mjs";
import { PLUGIN_ROOT } from "./lib/checkout.mjs";
import { activeWorkIssues, ensureLabel, findPr, findProject, getIssue, getPr, moveCard, repoOf, rest, setStateLabel } from "./lib/github.mjs";
import { log, resolveInputs } from "./lib/inputs.mjs";
import { HEARTBEAT_MS, LOCAL_DOMAINS, LOCAL_LABEL, dropClaim, readWorkflowEnv, routedHere, writeClaim } from "./lib/local.mjs";
import { REVIEW_LABEL } from "./lib/logic.mjs";
import { onPath } from "./lib/proc.mjs";

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();

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

/** The env the harness children must not inherit from a Claude Code session the developer ran this from. */
export function withoutSessionEnv(env) {
  const out = { ...env };
  for (const k of Object.keys(out)) if (k === "CLAUDECODE" || k === "CLAUDE_PID" || k === "CLAUDE_EFFORT" || (k.startsWith("CLAUDE_CODE_") && k !== "CLAUDE_CODE_OAUTH_TOKEN")) delete out[k];
  return out;
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

function preflight(harness) {
  const problems = [];
  if (harness !== "claude") problems.push(`local mode runs the claude harness in this release (the workflow says ${harness}); codex and copilot follow`);
  for (const bin of ["git", "gh", "claude"]) if (!sh("sh", ["-c", `command -v ${bin} || true`])) problems.push(`${bin} is not on PATH`);
  if (platform() === "linux") for (const bin of ["bwrap", "socat"]) if (!sh("sh", ["-c", `command -v ${bin} || true`])) problems.push(`${bin} is not on PATH; Claude Code's sandbox needs it (sudo apt-get install -y bubblewrap socat)`);
  if (platform() === "win32") problems.push("native Windows has no sandbox for the harness; run local mode inside WSL2");
  return problems;
}

class Local {
  constructor(flags) {
    this.dev = resolve(flags.dir || process.cwd());
    this.dev = sh("git", ["-C", this.dev, "rev-parse", "--show-toplevel"]);
    this.repoFull = flags.repo || repoFromRemote(sh("git", ["-C", this.dev, "remote", "get-url", "origin"]));
    if (!this.repoFull) throw new Error("no GitHub origin remote; pass --repo OWNER/NAME");
    this.repo = repoOf(this.repoFull);
    this.token = sh("gh", ["auth", "token"]);
    this.opts = { token: this.token };
    this.host = hostname();
    this.wf = readWorkflowEnv(this.dev);
    this.harness = (process.env.FACTORY_HARNESS || this.wf.FACTORY_HARNESS || "claude").toLowerCase();
    const problems = preflight(this.harness);
    if (problems.length) throw new Error(`local mode cannot start:\n- ${problems.join("\n- ")}`);
    this.excludeWorkspaces();
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

  /** One clone per Objective, kept between stages so the dependencies and the transcript wait for the next one. */
  ensureClone(issue) {
    const dir = join(this.ws(issue), "repo");
    if (existsSync(join(dir, ".git"))) return dir;
    mkdirSync(this.ws(issue), { recursive: true });
    sh("git", ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential", "clone", "-q", "--reference-if-able", this.dev, "--dissociate", `https://github.com/${this.repoFull}.git`, dir], { stdio: ["ignore", "pipe", "inherit"] });
    return dir;
  }

  /** The child env: the repository's FACTORY_* settings, then what local mode fixes. */
  stageEnv(issue, usageDir) {
    const ws = this.ws(issue);
    const extra = String(process.env.FACTORY_LOCAL_DOMAINS || this.wf.FACTORY_LOCAL_DOMAINS || "").split(/[\s,]+/).filter(Boolean);
    return {
      ...withoutSessionEnv(process.env),
      ...this.wf,
      FACTORY_HARNESS: this.harness,
      FACTORY_LOCAL: "1",
      FACTORY_CREDENTIAL: "login",
      // The workflow's setup assumes a runner (sudo, a fresh VM); on a box the toolchain is the box's own.
      FACTORY_SETUP: process.env.FACTORY_LOCAL_SETUP ?? this.wf.FACTORY_LOCAL_SETUP ?? "",
      FACTORY_APP_TOKEN: this.token,
      GH_TOKEN: this.token,
      FACTORY_INPUT_GITHUB_TOKEN: this.token,
      FACTORY_PLUGIN_ROOT: PLUGIN_ROOT,
      FACTORY_USAGE_DIR: usageDir,
      npm_config_cache: join(ws, "npm-cache"),
      FACTORY_LOCAL_SANDBOX: JSON.stringify({ addDirs: [ws], domains: [...LOCAL_DOMAINS, ...extra] }),
    };
  }

  /** Run worker.mjs or review.mjs as a child; its lines are echoed with the issue and stage. */
  stage(issue, name, script, args) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const usageDir = join(this.ws(issue), `usage-${name}-${stamp}`);
    mkdirSync(usageDir, { recursive: true });
    const logFile = join(usageDir, "stage.log");
    return new Promise((done) => {
      const child = spawn(process.execPath, [join(PLUGIN_ROOT, "scripts", script), "--repo", this.repoFull, ...args, "--checkout", this.ensureClone(issue), "--usage-dir", usageDir], { env: this.stageEnv(issue, usageDir), stdio: ["ignore", "pipe", "pipe"] });
      const relay = (chunk) => {
        appendFileSync(logFile, chunk);
        for (const line of String(chunk).split("\n")) if (line.trim()) process.stdout.write(`[#${issue} ${name}] ${line}\n`);
      };
      child.stdout.on("data", relay);
      child.stderr.on("data", relay);
      child.on("close", (code) => {
        let result = null;
        try {
          result = JSON.parse(readFileSync(join(usageDir, "result.json"), "utf8"));
        } catch {
          // no record: the child failed before writing one
        }
        if (Number.isFinite(result?.usd)) appendFileSync(join(this.ws(issue), "spend.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), stage: name, usd: result.usd })}\n`);
        done({ code, exit: result?.exit ?? null, usd: result?.usd ?? null, usageDir });
      });
    });
  }

  /** The routing label exists, so a developer can send an Objective here by applying it. */
  async init() {
    await ensureLabel(this.repo, LOCAL_LABEL, "0e8a16", "Factory: run this Objective in a developer's local loop, not on Actions", this.opts).catch((e) => log(`label ${LOCAL_LABEL}: ${e.message.slice(0, 120)}`));
    return this;
  }

  /** Hold the Objective for the length of fn: a claim with a heartbeat the Actions path respects. */
  async withClaim(issue, fn) {
    const active = await activeWorkIssues(this.repo, this.opts).catch(() => new Set());
    if (active.has(issue)) {
      log(`#${issue}: an Actions worker job is running it; local mode leaves it alone`);
      return { exit: "skipped" };
    }
    await writeClaim(this.repo, issue, this.host, this.opts);
    const beat = setInterval(() => writeClaim(this.repo, issue, this.host, this.opts).catch((e) => log(`#${issue} heartbeat: ${e.message.slice(0, 120)}`)), HEARTBEAT_MS);
    try {
      return await fn();
    } finally {
      clearInterval(beat);
      await dropClaim(this.repo, issue, this.opts);
    }
  }

  async review(issue, prNumber, { wait = false } = {}) {
    const review = await this.stage(issue, "review", "review.mjs", ["--pr", String(prNumber)]);
    log(`#${issue} review of PR #${prNumber}: ${review.exit ?? `no exit record (code ${review.code})`}${review.usd != null ? `, ${review.usd.toFixed(2)}` : ""}`);
    if (wait && review.exit === "delivered") await this.followMerge(issue, prNumber);
    return review;
  }

  /** One Objective, start to delivered review (and, with `wait`, to merged). */
  runObjective(issue, { wait = false } = {}) {
    return this.withClaim(issue, async () => {
      const work = await this.stage(issue, "work", "worker.mjs", ["--issue", String(issue)]);
      log(`#${issue} work: ${work.exit ?? `no exit record (code ${work.code})`}${work.usd != null ? `, ${work.usd.toFixed(2)}` : ""}`);
      if (work.exit !== "delivered") return work;
      const pr = await findPr(this.repo, `factory/${issue}`, this.opts).catch(() => null);
      return pr ? this.review(issue, pr.number, { wait }) : work;
    });
  }

  /** A review re-run on its own (a human re-applied factory:review), in the Objective's clone. */
  runReview(prNumber, { wait = false } = {}) {
    return getPr(this.repo, prNumber, this.opts).then((pr) => {
      const issue = Number(/^factory\/(\d+)$/.exec(pr.head?.ref || "")?.[1]);
      if (!issue) throw new Error(`PR #${prNumber} is not on a factory/<issue> branch`);
      return this.withClaim(issue, () => this.review(issue, prNumber, { wait }));
    });
  }

  /** Open PRs labelled factory:review whose Objective is routed here: the label is the review trigger, as on Actions. */
  async pendingReviews() {
    const prs = (await rest(`repos/${this.repo.full}/pulls?state=open&per_page=100`, { ...this.opts, paginate: true }).catch(() => [])) || [];
    const out = [];
    for (const pr of prs) {
      const issue = Number(/^factory\/(\d+)$/.exec(pr.head?.ref || "")?.[1]);
      if (!issue || !(pr.labels || []).some((l) => l.name === REVIEW_LABEL)) continue;
      const data = await getIssue(this.repo, issue, this.opts).catch(() => null);
      if (data && routedHere(data, this.stageEnv(0, ""))) out.push({ issue, pr: pr.number });
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
  async serve({ once = false, intervalMs = 60_000 } = {}) {
    const running = new Map();
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      log(`stopping: ${running.size} Objective(s) in flight keep their state; their claims lapse in 15 min`);
      await Promise.all([...running.keys()].map((n) => dropClaim(this.repo, n, this.opts)));
      process.exit(130);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    for (;;) {
      const inputs = resolveInputs({ args: { repo: this.repoFull }, env: this.stageEnv(0, "") });
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
    const local = await new Local(flags).init();
    const r = await local.runObjective(issue, { wait: !!flags.wait });
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
    await (await new Local(flags).init()).serve({ once: !!flags.once, intervalMs: Number(flags.interval || 60) * 1000 });
    return;
  }
  throw new Error("usage: local.mjs run <issue> [--wait] | review <pr> [--wait] | serve [--once]");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    process.stderr.write(`[factory] local: ${e.message}\n`);
    process.exit(1);
  });
}
