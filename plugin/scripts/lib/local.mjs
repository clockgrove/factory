// Local mode: Factory on a developer's own box. The claim that keeps the Actions path and a
// local loop off each other's Objectives, the sandbox the harness and Factory's own shell
// commands run in, the env a child may see, and the adopter's workflow env block read as the
// local configuration. GitHub stays the only state.
import { appendFileSync, chmodSync, closeSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { homedir, platform as osPlatform, uptime } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { dropOwned, ownedTemp, sweepOwned } from "./fsafe.mjs";
import { listComments, primeWriters, rest, upsertComment } from "./github.mjs";
import { isSelf, knownWriter, marker, pinnedMaintainer } from "./logic.mjs";
import { isFactorySecret } from "./inputs.mjs";
import { parseWorkerSecrets } from "./worker-secrets.mjs";
import { SKIP_SMUDGE_ENV } from "./lfs.mjs";

/** A claim whose heartbeat is older than this is stale: the box went away (asleep, off, or serve stopped). */
export const CLAIM_FRESH_MS = 15 * 60_000;
/** A stale claim pauses its Objective this long, for the same machine's serve to resume it; past it, Blocked. */
export const CLAIM_PAUSE_MS = 24 * 60 * 60_000;
export const HEARTBEAT_MS = 2 * 60_000;
/** A heartbeat this far ahead of now is a forgery or a broken clock, never fresh. */
const CLAIM_SKEW_MS = 2 * 60_000;
export const claimMarker = (issue) => marker(issue, "local");

/** The routing label: an Objective carrying it belongs to a developer's local loop, and the Actions path leaves it alone. */
export const LOCAL_LABEL = "factory:local";
export const hasLocalLabel = (issue) => (issue?.labels || []).some((l) => (typeof l === "string" ? l : l.name) === LOCAL_LABEL);

/** True when this process is the local backend (factory run / serve set it). */
export const isLocal = (env = process.env) => env.FACTORY_LOCAL === "1";


/** The claim comment Factory writes, read back by structure: which loop holds it and its last heartbeat. */
export const claimBody = (holder, at = new Date()) => `Running in local mode (${holder}).\nholder: ${holder}\nheartbeat: ${at.toISOString()}`;

export function parseClaim(body, now = Date.now()) {
  const at = /^heartbeat: (\S+)$/m.exec(body || "")?.[1];
  const t = at ? Date.parse(at) : NaN;
  if (Number.isNaN(t)) return null;
  const holder = /^holder: (\S+)$/m.exec(body)?.[1] ?? null;
  return { holder, heartbeat: at, fresh: now - t < CLAIM_FRESH_MS && t - now < CLAIM_SKEW_MS };
}

/**
 * The issue's local claim, or null; `fresh` says whether its loop is alive. A local loop writes it as its developer, so
 * only Factory's own login or a person whose push access is known (the writer list, a pinned maintainer) counts, never
 * an author association, and only with the marker on the comment's first line.
 */
export async function localClaim(repo, issue, opts, now = Date.now()) {
  const mark = claimMarker(issue);
  await primeWriters(repo, opts);
  const verified = (x) => isSelf(x) || knownWriter(x?.user?.login) === true || pinnedMaintainer(x?.user);
  const c = (await listComments(repo, issue, opts)).find((x) => (x.body || "").startsWith(mark) && x?.user?.type !== "Bot" && verified(x));
  if (!c) return null;
  const parsed = parseClaim(c.body, now);
  return parsed ? { ...parsed, commentId: c.id } : null;
}

export const writeClaim = (repo, issue, holder, opts) => upsertComment(repo, issue, claimMarker(issue), claimBody(holder), opts);

/** Drop the claim only when this loop holds it: another loop's claim is not ours to clear. */
export async function dropClaim(repo, issue, holder, opts) {
  const c = await localClaim(repo, issue, opts).catch(() => null);
  if (c && c.holder === holder) await rest(`repos/${repo.full}/issues/comments/${c.commentId}`, { ...opts, method: "DELETE" }).catch(() => {});
}

/** ~/.config/factory: the literal path every sandbox denies, where local mode's key files sit. */
export const factoryKeyDir = (home = homedir()) => join(home, ".config", "factory");

/** The AI Gateway key's file in local mode (red-check triage, triage.mjs triageKeyState). */
export const gatewayKeyFile = (home = homedir()) => join(factoryKeyDir(home), "ai-gateway-key");

/**
 * The `harness` home that equals or holds ~/.config/factory, or null. The outer sandbox leaves the harness's own homes
 * readable (#2551), so such a home would expose every key file there: the App's key (localApp) and the AI Gateway key
 * (triage.mjs triageKeyState, and serve's start).
 */
export function keyDirExposedBy(harness, env = process.env, home = homedir()) {
  if (!harness) return null;
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const literal = factoryKeyDir(home);
  const holds = (h) => literal === h || literal.startsWith(`${h}/`);
  return harnessHomes(harness, env, home).find((h) => holds(h) || holds(real(h))) || null;
}

/**
 * Why serve cannot start with the AI Gateway key file in place, or null: a `harness` home that holds ~/.config/factory
 * would leave the file readable in the outer sandbox, as localApp refuses for the App's key. The file's existence is
 * enough (lstat: a symlink counts); its text is never read here.
 */
export function gatewayKeyProblem(env = process.env, home = homedir(), harness = null) {
  const file = gatewayKeyFile(home);
  try {
    lstatSync(file);
  } catch {
    return null;
  }
  const exposed = keyDirExposedBy(harness, env, home);
  return exposed ? `${file}: ${factoryKeyDir(home)} is inside the ${harness} harness's home ${exposed}, which its sandbox can read; point that home elsewhere` : null;
}

/**
 * The Factory App local notices post with (#2522), from FACTORY_LOCAL_APP_ID and FACTORY_LOCAL_APP_KEY (the path of its
 * private key). The key must sit under ~/.config/factory, which every sandbox denies by that literal path, so no stage
 * can read it: the check is on the key's real path, and ~/.config/factory must be no symlink itself, since a deny list
 * names the literal path. A second hard link would be a path to the key outside it, so one is refused, and so are
 * group or world permission bits, and so is a `harness` home (readable in the outer sandbox) that holds
 * ~/.config/factory. Returns {app: {id, key}}, {app: null} when neither is set, or {problem}. The key's text is never
 * in a message.
 */
export function localApp(env = process.env, home = homedir(), harness = null) {
  const id = String(env.FACTORY_LOCAL_APP_ID || "").trim();
  const path = String(env.FACTORY_LOCAL_APP_KEY || "").trim().replace(/^~(?=\/)/, home);
  if (!id && !path) return { app: null };
  if (!/^\d+$/.test(id) || !path) return { problem: "set both FACTORY_LOCAL_APP_ID (the Factory App's numeric id) and FACTORY_LOCAL_APP_KEY (the path of its private key), or neither" };
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return null;
    }
  };
  const key = real(path);
  if (!key) return { problem: `FACTORY_LOCAL_APP_KEY: no file at ${path}` };
  const literal = factoryKeyDir(home);
  const root = real(literal);
  if (root !== literal) return { problem: `FACTORY_LOCAL_APP_KEY: ${literal} must be a real directory, not a symlink (it resolves to ${root || "nothing"}): the sandboxes deny that literal path` };
  if (!key.startsWith(`${root}/`)) return { problem: `FACTORY_LOCAL_APP_KEY: the App's private key must sit under ${literal}, which no sandbox can read (it is at ${key}); move it there, don't copy it` };
  const exposed = keyDirExposedBy(harness, env, home);
  if (exposed) return { problem: `FACTORY_LOCAL_APP_KEY: ${literal} is inside the ${harness} harness's home ${exposed}, which its sandbox can read; point that home elsewhere` };
  const st = statSync(key);
  if (!st.isFile()) return { problem: `FACTORY_LOCAL_APP_KEY: ${key} is not a file` };
  if (st.nlink > 1) return { problem: `FACTORY_LOCAL_APP_KEY: ${key} has ${st.nlink} hard links, so it is reachable outside ${literal}; keep one copy (move it, don't link it)` };
  if (st.mode & 0o077) return { problem: `FACTORY_LOCAL_APP_KEY: ${key} is readable or writable by others (mode ${(st.mode & 0o777).toString(8)}); chmod 600 ${key}` };
  return { app: { id, key: readFileSync(key, "utf8") } };
}

/**
 * The paths srt write-protects in the working directory on its own (its DANGEROUS_FILES and dangerous directories,
 * sandbox-runtime 0.0.81). Where one is absent, srt mounts /dev/null in its place for the command, which a repository
 * check that walks the tree cannot open (nodev: EACCES) or reads as a file where it expects a directory. Factory
 * makes each absent one before any sandbox opens: an empty directory, or an empty file listed in the clone's
 * .git/info/exclude, so srt protects a real, harmless path and git status stays clean.
 */
export const SRT_PROTECTED = {
  dirs: [".vscode", ".idea", ".claude/commands", ".claude/agents"],
  files: [".gitconfig", ".gitmodules", ".bashrc", ".bash_profile", ".zshrc", ".zprofile", ".profile", ".ripgreprc", ".mcp.json"],
};

/**
 * The clone's paths a harness reads as its own configuration: Claude Code's `.claude`, Codex's `.codex`, the `.agents`
 * skills, Copilot's hooks, settings, agents and skills under `.github`, and `.mcp.json`. A sandboxed command could plant
 * a hook there that the next harness start runs outside every sandbox, so no sandbox may write them (Factory's own git
 * profile, which writes the plugin's skills and agents, excepted), and Factory makes each absent directory empty first,
 * as with SRT_PROTECTED. A local harness loads none of the executable ones from the clone anyway (harness.mjs).
 */
export const HARNESS_CONFIG = { dirs: [".claude", ".codex", ".agents", ".github/hooks", ".github/copilot", ".github/agents", ".github/skills"], files: [".mcp.json", ".gitmodules"] };
export const harnessConfigPaths = (clone) => [...HARNESS_CONFIG.dirs, ...HARNESS_CONFIG.files].map((p) => join(clone, p));

/**
 * The harness configuration that can run code on the host (hooks, settings with helpers, MCP servers) and that Factory
 * never writes: before every local harness start, a tracked one is restored from HEAD and anything else there removed
 * (clearHarnessConfig), so nothing planted earlier survives into the start. `.mcp.json` is not here: srt keeps it
 * unwritable in every profile, Factory's git work included.
 */
export const HARNESS_EXEC_CONFIG = [".claude/settings.json", ".claude/settings.local.json", ".claude/hooks", ".codex/config.toml", ".codex/hooks.json", ".github/hooks", ".github/copilot"];

/**
 * Git settings for every local harness process, highest precedence: each harness CLI runs `git status` or `git diff` on
 * the host in the clone as it starts, and a submodule's config (in .git/modules, which sandboxed code can write) would
 * otherwise be read by a `git status` run inside it. No fsmonitor command, and submodules are never entered.
 */
export const HARNESS_GIT_ENV = harnessGitEnv();

/**
 * What in a git directory can point git at another one, beside `commondir`, which Factory keeps as `.` (the clone's own
 * .git) and read-only in every sandbox (gitGuards), since a harness CLI also runs git on the host between tool calls, whose config (filters, an fsmonitor command) the harness CLI's
 * own `git status` or `git diff` on the host would then run: removed from the clone's .git before every harness start.
 */
export const GIT_REPOINT = ["gitdir", "config.worktree", "worktrees"];

/**
 * The clone's .git as Factory cloned it: its inode and birth time, kept in the Objective's .sandbox directory (no sandbox
 * reaches it) when Factory makes the clone, and never read again from the clone itself. A command in a sandbox that lets
 * it rename .git (Copilot's did) could otherwise put a .git of its own in place, whose config every later harness
 * start, and its own git on the host, would trust. Each stage and each harness start refuses when .git is not it.
 * The device number is not part of it: it is not stable across a restart (a WSL2 distro's disk is /dev/sd<x> in the
 * order disks attach; tmpfs and 9p mounts get a fresh one per mount). Instead .git must be on the filesystem the pin file
 * is on, which the clone beside it moves with. The birth time (0 where the filesystem keeps none) tells a new directory
 * that got a freed inode back from the one Factory cloned.
 */
export const gitPinFile = (ws) => join(ws, ".sandbox", "git-id");
const gitIdOf = (st) => `${st.ino}:${st.birthtimeNs}`;
export function pinGitDir(clone, file) {
  const st = lstatSync(join(clone, ".git"), { bigint: true });
  if (!st.isDirectory()) throw new Error(`${clone}/.git is not a directory`);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${gitIdOf(st)}\n`, { mode: 0o600 });
}
export function readGitPin(file) {
  try {
    const id = readFileSync(file, "utf8").trim();
    return /^\d+:\d+$/.test(id) ? id : null;
  } catch {
    return null;
  }
}
/** The inode alone, as Factory's git guard (gitGuardScript) compares it with `ls -di`. */
export const pinnedInode = (id) => String(id || "").split(":")[0] || "unpinned";
/** Why the clone's .git is not the pinned one ("" when it is). `pinFile`: .git must be on the filesystem it is on. */
export function gitDirChanged(clone, id, pinFile = null) {
  if (!id) return `${clone} has no pinned .git identity`;
  const st = lstatSync(join(clone, ".git"), { throwIfNoEntry: false, bigint: true });
  if (!st || !st.isDirectory()) return `${clone}/.git is not a directory any more`;
  const [ino, born] = id.split(":");
  if (String(st.ino) !== ino || (born !== "0" && String(st.birthtimeNs) !== born)) return `${clone}/.git is not the directory Factory cloned (it was replaced)`;
  if (pinFile) {
    const p = lstatSync(pinFile, { throwIfNoEntry: false, bigint: true });
    if (!p || p.dev !== st.dev) return `${clone}/.git is not on the filesystem of the Objective's directory`;
  }
  return "";
}
/** The Blocked reason a stage posts when the clone's .git is not the one Factory cloned: fixed text, no local path. */
export const gitIdentityReason = (issue) => `local mode: the clone's .git is not the directory Factory cloned (git-identity); remove .factory/${issue} in the local clone to start the Objective afresh`;
/**
 * The Blocked reason for a harness start Factory refused (GitRefusal): fixed text per code, no local path and no command
 * output (both go to the stage log).
 */
export const gitRefusalReason = (code, issue, { path = null, rule = null, harness = "codex", local = false } = {}) =>
  code === "git-identity"
    ? gitIdentityReason(issue)
    : code === "git-state"
      ? "local mode: the clone's .git config, hooks, commondir or info/attributes changed during the stage (git-state); the harness was not started"
      : code === "roots"
        ? `${path ? `\`${path}\`, a directory the harness's sandbox lets commands write,` : "A directory the harness's sandbox lets commands write"} is a link, or has one on its path, that Factory cannot replace (roots); the harness was not started. Something the repository's setup, install or validation ran made it: stop it making that link, then re-apply \`factory:objective\``
      : code === "sandbox"
        ? path
          ? `Codex's sandbox cannot protect the checkout's \`${path}\`, a link to nothing (sandbox); the harness was not started. Remove the link from the branch, or point it at a path that exists`
          : rule
            ? `${harness === "copilot" ? "Copilot" : "Codex"}'s sandbox started but does not confine here (${rule}) (sandbox); the harness was not started, so no command ran unconfined. ${local ? "The stage log on the local machine" : "The work job's log"} has the probe's output`
            : local
              ? "Copilot's sandbox could not start in local mode (sandbox); the harness was not started, so no command ran unsandboxed. The stage log on the local machine has the probe's output"
              : harness === "copilot"
                ? "Copilot's sandbox could not start on this runner (sandbox); the harness was not started, so no command ran unsandboxed. The doctor lines at the top of the work job's log (copilot sandbox: bwrap, slirp4netns, apparmor, start) name what is missing"
                : "Codex's sandbox could not start on this runner (sandbox); the harness was not started, so no command ran unsandboxed. The doctor lines at the top of the work job's log (codex sandbox: bwrap, apparmor, start) name what is missing"
        : "Factory's pre-start check of the checkout's git directory failed (git-clear); the harness was not started";
/**
 * The Blocked comment's marker id for a git-identity Block: the same for every repeat on one clone (a stage that keeps
 * finding it updates its comment rather than adding one), a new one for a fresh clone. The pin is hashed: no inode on GitHub.
 */
export const gitIdentityKey = (stage, id) => `git-identity:${stage}:${createHash("sha256").update(String(id || "none")).digest("hex").slice(0, 12)}`;
/** A harness start Factory refused (beforeHarness, a runner's pre-start clear): `code` is git-identity, git-state, git-clear, roots or sandbox; the stage Blocks (gitRefusalReason). */
export class GitRefusal extends Error {
  /** `path` (checkout-relative), `rule` (a fixed confinement rule), `harness` (whose sandbox) and `local` (local mode's probe): named in the Blocked reason (gitRefusalReason). */
  constructor(code, detail, { path = null, rule = null, harness = null, local = false } = {}) {
    super(`refusing to start the harness: ${detail}`);
    this.code = code;
    this.path = path;
    this.rule = rule;
    this.harness = harness;
    this.local = local;
  }
}
/**
 * The Blocked exit a stage applies for a GitRefusal ({reason, key}; key is set for git-identity, whose repeats on one clone
 * share a comment), or null for any other error. `env` is the stage's (its FACTORY_LOCAL_SANDBOX names the pinned .git).
 */
export function refusalExit(e, { stage, issue, env = process.env }) {
  if (!(e instanceof GitRefusal)) return null;
  let id = null;
  try {
    id = JSON.parse(env.FACTORY_LOCAL_SANDBOX || "{}").gitId || null;
  } catch {
    // no pin to name: one key for the stage
  }
  return { reason: gitRefusalReason(e.code, issue, { path: e.path, rule: e.rule, local: !!e.local, ...(e.harness ? { harness: e.harness } : {}) }), ...(e.code === "git-identity" ? { key: gitIdentityKey(stage, id) } : {}) };
}

/**
 * The git state Factory set up for a stage (after its own git work: identity, credential helpers, Git LFS), hashed:
 * .git/config, .git/commondir, .git/info/attributes and every hook. pinGitState records it in this stage's process,
 * checkGitState compares before each harness start. A file is read only when it is a regular file (never a link).
 */
const GIT_STATE = new Map();
const GIT_ATTRIBUTES = join("info", "attributes");
export function gitStateHash(clone) {
  const h = createHash("sha256");
  const add = (rel) => {
    const p = join(clone, ".git", rel);
    const st = lstatSync(p, { throwIfNoEntry: false });
    // An absent info/attributes and the empty one a stage makes (prepareProtectedPaths) say the same to git.
    if (rel === GIT_ATTRIBUTES && (!st || (st.isFile() && st.size === 0))) {
      h.update(`${rel}\0-\0`);
      return;
    }
    h.update(`${rel}\0${st ? (st.isFile() ? "f" : st.isDirectory() ? "d" : "o") : "-"}\0`);
    if (st?.isFile()) {
      const fd = openSync(p, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try {
        h.update(readFileSync(fd));
      } finally {
        closeSync(fd);
      }
    }
    if (st?.isDirectory()) for (const e of readdirSync(p).sort()) add(join(rel, e));
  };
  for (const rel of ["config", "commondir", GIT_ATTRIBUTES, "hooks"]) add(rel);
  return h.digest("hex");
}
export const pinGitState = (clone) => GIT_STATE.set(clone, gitStateHash(clone));
/** "" when the git state is what pinGitState recorded (or nothing was recorded in this process yet), else why not. */
export function checkGitState(clone) {
  const want = GIT_STATE.get(clone);
  if (!want) return "";
  return gitStateHash(clone) === want ? "" : `${clone}/.git's config, hooks, commondir or info/attributes changed since Factory set them up`;
}

/** Make the absent SRT_PROTECTED and HARNESS_CONFIG paths in the clone (host side, before a stage). Never writes through an existing path. */
export function prepareProtectedPaths(clone) {
  const made = [];
  if (lstatSync(join(clone, ".git"), { throwIfNoEntry: false })?.isDirectory()) {
    rmSync(join(clone, ".git", "commondir"), { recursive: true, force: true });
    writeFileSync(join(clone, ".git", "commondir"), ".\n", { flag: "wx" });
    // .git/info/attributes made empty where absent, so every sandbox protects a real file (gitGuards).
    try {
      mkdirSync(join(clone, ".git", "info"), { recursive: true });
      writeFileSync(join(clone, ".git", "info", "attributes"), "", { flag: "wx" });
    } catch {
      // there already (or something else is there: the sandboxes protect it as it is)
    }
  }
  for (const d of [...SRT_PROTECTED.dirs, ...HARNESS_CONFIG.dirs]) {
    try {
      mkdirSync(join(clone, d), { recursive: true });
    } catch {
      // something else is there (a file, a symlink): srt protects it as it is
    }
  }
  for (const f of SRT_PROTECTED.files) {
    try {
      // wx: O_CREAT|O_EXCL, so an existing file or symlink is left alone and never followed.
      writeFileSync(join(clone, f), f === ".mcp.json" ? '{"mcpServers":{}}\n' : "", { flag: "wx" });
      made.push(f);
    } catch {
      // already there
    }
  }
  if (made.length) {
    const exclude = join(clone, ".git", "info", "exclude");
    mkdirSync(join(clone, ".git", "info"), { recursive: true });
    const have = existsSync(exclude) ? readFileSync(exclude, "utf8").split("\n") : [];
    const add = made.map((f) => `/${f}`).filter((l) => !have.includes(l));
    if (add.length) appendFileSync(exclude, `${have.length && have.at(-1) !== "" ? "\n" : ""}# Factory: srt's protected paths, made empty so the sandbox protects a real path\n${add.join("\n")}\n`);
  }
  return made;
}

// The same, run inside the clone's own sandbox (backend.mjs sandbox.git), so Factory's process writes nothing in the
// clone between stages, where the agent may have planted a symlink. CommonJS for `node -e`: argv is the clone, "1" to
// clear first ("fresh" at a stage's start: see below), the stale git locks to remove as JSON (prepareClone), then more
// directories to make (the package caches that live in the clone). Always: .git/commondir is
// `.`, the clone's own .git, and .git/info/attributes exists (made empty where absent). Clearing, before a harness
// starts: the git directory back to the clone's own (GIT_REPOINT removed, gitlinks HEAD lacks dropped, no submodule
// checked out: each gitlink's .git and .git/modules removed, then checked: exit 3 when git would still read another
// directory), HARNESS_EXEC_CONFIG back to HEAD (a tracked file restored, anything else removed, never followed through a
// symlink), and the submodule names .gitmodules gives printed as JSON for the harness's git env. Fresh, at a stage's
// start: the untracked files an earlier stage or run left in this reused clone (never pushed) removed, best effort;
// ignored ones (dependencies, Factory's plugin) and the paths Factory makes here stay. Its changes to tracked files are
// the checkout's to discard (outbox.mjs putOn).
const PREPARE_CLONE = String.raw`
const fs = require("fs"), path = require("path"), cp = require("child_process");
const [clone, clear, lockArg, ...dirs] = process.argv.slice(1);
const P = ${JSON.stringify(SRT_PROTECTED)}, H = ${JSON.stringify(HARNESS_CONFIG)}, X = ${JSON.stringify(HARNESS_EXEC_CONFIG)}, R = ${JSON.stringify(GIT_REPOINT)}, NS = ${JSON.stringify(SKIP_SMUDGE_ENV)};
const refuse = (why) => { process.stderr.write("refusing to start the harness: " + why + "\n"); process.exit(3); };
const dotgit = path.join(clone, ".git");
const gst = fs.lstatSync(dotgit, { throwIfNoEntry: false });
if (gst && gst.isDirectory()) { fs.rmSync(path.join(dotgit, "commondir"), { recursive: true, force: true }); fs.writeFileSync(path.join(dotgit, "commondir"), ".\n", { flag: "wx" }); try { fs.mkdirSync(path.join(dotgit, "info"), { recursive: true }); fs.writeFileSync(path.join(dotgit, "info", "attributes"), "", { flag: "wx" }); } catch {} }
const realParents = (x) => { for (let p = path.dirname(x); p !== "."; p = path.dirname(p)) { const st = fs.lstatSync(path.join(clone, p), { throwIfNoEntry: false }); if (st && !st.isDirectory()) return false; } return true; };
const removed = [];
for (const rel of JSON.parse(lockArg || "[]")) {
  const parts = rel.split("/");
  if (parts[0] !== ".git" || !rel.endsWith(".lock") || parts.some((x) => x === ".." || x === "." || x === "") || !realParents(rel)) continue;
  const st = fs.lstatSync(path.join(clone, rel), { throwIfNoEntry: false });
  if (st && st.isFile()) { fs.rmSync(path.join(clone, rel), { force: true }); removed.push(rel); }
}
let names = [];
if (clear === "1") {
  if (!gst || !gst.isDirectory()) refuse(".git is not the clone's own directory");
  for (const r of R) fs.rmSync(path.join(dotgit, r), { recursive: true, force: true });
  // Its restore of HARNESS_EXEC_CONFIG writes the working tree: no Git LFS smudge (lfs.mjs noSmudge).
  const git = (...a) => cp.execFileSync("git", ["-C", clone, "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "diff.ignoreSubmodules=all", ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...NS } });
  const real = fs.realpathSync(dotgit);
  const at = git("rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir").split("\n").filter(Boolean);
  if (at.length !== 2 || at.some((d) => fs.realpathSync(d) !== real)) refuse("git reads another directory than the clone's .git");
  // Gitlinks: only HEAD's stay in the index, and a submodule's .git file may point only into .git/modules.
  const links = (out) => out.split("\0").filter((l) => l.startsWith("160000 ")).map((l) => l.slice(l.indexOf("\t") + 1));
  let headLinks = [];
  try { headLinks = links(git("ls-tree", "-r", "-z", "HEAD")); } catch {}
  const keep = new Set(headLinks);
  const stray = links(git("ls-files", "-s", "-z")).filter((p) => !keep.has(p));
  if (stray.length) git("update-index", "--force-remove", "--", ...stray);
  // No submodule is checked out when a harness starts (Factory never initialises one): a git that entered it would read
  // its config, which sandboxed code can write.
  for (const p of [...headLinks, ...stray]) if (realParents(path.join(p, ".git"))) fs.rmSync(path.join(clone, p, ".git"), { recursive: true, force: true });
  fs.rmSync(path.join(dotgit, "modules"), { recursive: true, force: true });
  try { names = git("config", "-f", path.join(clone, ".gitmodules"), "--name-only", "--get-regexp", "^submodule\\..*\\.path$").split("\n").filter(Boolean).map((k) => k.slice("submodule.".length, -".path".length)); } catch {}
  let head = [];
  try { head = git("ls-tree", "-r", "-z", "--name-only", "HEAD", "--", ...X).split("\0").filter(Boolean); } catch {}
  const tracked = new Set(head);
  const sweep = (rel) => {
    const st = fs.lstatSync(path.join(clone, rel), { throwIfNoEntry: false });
    if (!st) return;
    if (st.isDirectory()) { for (const e of fs.readdirSync(path.join(clone, rel))) sweep(path.join(rel, e)); return; }
    if (!tracked.has(rel)) fs.rmSync(path.join(clone, rel), { force: true });
  };
  // Never through a parent that is not a real directory (a symlink in place of .claude): nothing is followed.
  for (const x of X) if (realParents(x)) sweep(x);
  if (head.length) git("checkout", "HEAD", "--", ...head);
}
if (clear === "fresh" && gst && gst.isDirectory()) {
  const keep = [...P.dirs, ...H.dirs, ...P.files, ...H.files].flatMap((p) => ["-e", "/" + p]);
  try { cp.execFileSync("git", ["-C", clone, "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "clean", "-q", "-f", "-d", ...keep], { stdio: ["ignore", "ignore", "pipe"] }); }
  catch (e) { process.stderr.write("warning: the clone's leftovers could not all be removed: " + String(e.stderr || e.message).trim().split("\n")[0].slice(0, 200) + "\n"); }
}
for (const d of [...P.dirs, ...H.dirs].map((d) => path.join(clone, d)).concat(dirs)) { try { fs.mkdirSync(d, { recursive: true }); } catch {} }
const made = [];
for (const f of P.files) { try { fs.writeFileSync(path.join(clone, f), f === ".mcp.json" ? '{"mcpServers":{}}\n' : "", { flag: "wx" }); made.push(f); } catch {} }
if (made.length) {
  const ex = path.join(clone, ".git", "info", "exclude");
  fs.mkdirSync(path.dirname(ex), { recursive: true });
  const have = fs.existsSync(ex) ? fs.readFileSync(ex, "utf8").split("\n") : [];
  const add = made.map((f) => "/" + f).filter((l) => !have.includes(l));
  if (add.length) fs.appendFileSync(ex, (have.length && have.at(-1) !== "" ? "\n" : "") + "# Factory: srt's protected paths, made empty so the sandbox protects a real path\n" + add.join("\n") + "\n");
}
process.stdout.write(JSON.stringify({ submodules: names, locks: removed }));
`;

/**
 * prepareProtectedPaths and the clone's package-cache directories, in the clone's own sandbox (`run` gives the command).
 * `locks`: the stale git locks to remove first (staleGitLocks), each re-checked there as a regular `.lock` file under
 * `.git` with no symlink on its path. Returns {submodules, locks}: the names .gitmodules gives and the locks removed.
 */
export async function prepareClone(clone, dirs, run, { clear = false, fresh = false, locks = [] } = {}) {
  const r = await run([process.execPath, "-e", PREPARE_CLONE, clone, clear ? "1" : fresh ? "fresh" : "0", JSON.stringify(locks), ...dirs]);
  if (r.code !== 0) throw new Error(`the clone could not be prepared in its sandbox: ${String(r.stderr).trim().split("\n").at(-1)?.slice(0, 200)}`);
  try {
    return { locks: [], ...JSON.parse(String(r.stdout).trim().split("\n").at(-1)) };
  } catch {
    return { submodules: [], locks: [] };
  }
}

/**
 * True when a process on the box has its working directory or an open file in `clone`, false when none has, null
 * when `proc` cannot be read (no /proc: macOS). Processes of other users are not visible and do not count.
 */
export function cloneInUse(clone, proc = "/proc") {
  let pids;
  try {
    pids = readdirSync(proc).filter((p) => /^\d+$/.test(p));
  } catch {
    return null;
  }
  const roots = new Set([resolve(clone)]);
  try {
    roots.add(realpathSync(clone));
  } catch {
    // gone: the path as given
  }
  const inside = (p) => !!p && [...roots].some((r) => p === r || p.startsWith(`${r}/`));
  const link = (p) => {
    try {
      return readlinkSync(p);
    } catch {
      return "";
    }
  };
  for (const pid of pids) {
    if (inside(link(join(proc, pid, "cwd")))) return true;
    let fds = [];
    try {
      fds = readdirSync(join(proc, pid, "fd"));
    } catch {
      // gone, or another user's
    }
    for (const fd of fds) if (inside(link(join(proc, pid, "fd", fd)))) return true;
  }
  return false;
}

/**
 * The git lock files in the clone a stage may remove before it starts, and those it must leave: an interrupted stage (a
 * reboot, a killed serve) leaves locks behind, and git then refuses the config, index or ref each guards. Candidates are
 * `.git/*.lock` and `.git/refs/**\/*.lock`, read without following a symlink (the clone has no worktree gitdirs: the
 * clear before each harness start removes `.git/worktrees`). Returns {stale, live}, paths relative to the clone.
 *
 * The liveness check: a lock older than the box's last boot has no holder (no process survives a restart). A newer one
 * is stale only where /proc shows no process with its working directory or an open file in the clone. Not the lock file
 * alone: git closes a ref lock between writing it and renaming it into place, but stays in the repository (git chdirs
 * into the repository it works on; Factory runs every git with `-C <clone>`). Without /proc (macOS) only the boot rule holds.
 */
export function staleGitLocks(clone, { proc = "/proc", bootMs = Date.now() - uptime() * 1000 } = {}) {
  const found = [];
  const walk = (rel, deep) => {
    if (!lstatSync(join(clone, rel), { throwIfNoEntry: false })?.isDirectory()) return;
    for (const n of readdirSync(join(clone, rel))) {
      const r = join(rel, n);
      const st = lstatSync(join(clone, r), { throwIfNoEntry: false });
      if (st?.isFile() && n.endsWith(".lock")) found.push({ rel: r, mtimeMs: st.mtimeMs });
      else if (deep && st?.isDirectory()) walk(r, true);
    }
  };
  walk(".git", false);
  walk(join(".git", "refs"), true);
  const newer = found.filter((l) => l.mtimeMs >= bootMs);
  const held = newer.length ? cloneInUse(clone, proc) !== false : false;
  const stale = found.filter((l) => l.mtimeMs < bootMs || !held).map((l) => l.rel);
  return { stale, live: found.map((l) => l.rel).filter((r) => !stale.includes(r)) };
}

/**
 * Before a harness starts: the clone's git directory its own, no submodule checked out, HARNESS_EXEC_CONFIG back to HEAD
 * (anything untracked there removed), the protected paths remade. Returns {submodules}: the names .gitmodules gives.
 */
export const clearHarnessConfig = (clone, run) => prepareClone(clone, [], run, { clear: true });

/**
 * HARNESS_GIT_ENV with `submodule.<name>.ignore=all` for each name: a .gitmodules `ignore` setting would otherwise
 * override diff.ignoreSubmodules for its submodule. Settings in the env outrank .gitmodules.
 */
export function harnessGitEnv(submodules = []) {
  const pairs = [["core.fsmonitor", "false"], ["diff.ignoreSubmodules", "all"], ["status.submoduleSummary", "false"], ["submodule.recurse", "false"], ...submodules.map((n) => [`submodule.${n}.ignore`, "all"])];
  return Object.fromEntries(pairs.flatMap(([k, v], i) => [[`GIT_CONFIG_KEY_${i}`, k], [`GIT_CONFIG_VALUE_${i}`, v]]).concat([["GIT_CONFIG_COUNT", String(pairs.length)]]));
}

/**
 * Where a stage's private temp directory is made: a 700 directory of the user's own, never /tmp itself, which some
 * harness sandboxes mount read-write (Copilot's), so one stage could reach another's temp files and sockets. On Linux
 * it is under the home. On macOS it is /private/tmp/fct-<uid>: Claude Code keeps its sockets in
 * `$CLAUDE_CODE_TMPDIR/claude-<uid>`, and when that path is over 44 bytes its commands get the box-wide
 * /tmp/claude-<uid> as TMPDIR instead (on Linux they keep the stage's), and a macOS home path is too long for that.
 */
export const stageTmpBase = (home = homedir(), os = osPlatform()) => {
  if (os !== "darwin") {
    const dir = join(home, ".cache", "factory", "s");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    return dir;
  }
  const dir = `/private/tmp/fct-${process.getuid()}`;
  mkdirSync(dir, { mode: 0o700, recursive: true });
  // Anyone may make a directory in /tmp: one this user does not own, or a link, is refused, not used.
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.uid !== process.getuid()) throw new Error(`${dir} is not a directory of this user's; remove it so local mode can make its own`);
  chmodSync(dir, 0o700);
  return dir;
};

/** The names Factory makes under stageTmpBase: a stage's temp directory (`<issue>-XXXXXX`), a probe's and a version check's. */
const STAGE_TMP_NAMES = /^(?:\d+|probe|version)-[A-Za-z0-9]{6}$/;

/**
 * A temp directory under stageTmpBase held by this process (fsafe.mjs ownedTemp; remove it with dropOwned), made
 * after clearing what killed processes left there. A directory another live process holds is never touched, whichever
 * repository's loop made it.
 */
export function stageTemp(prefix, home = homedir()) {
  const base = stageTmpBase(home);
  sweepOwned(base, STAGE_TMP_NAMES, { legacy: true });
  return ownedTemp(base, prefix);
}

/**
 * Why srt's sandbox does not start on this Linux box; an empty list when it does. Its seccomp layer, inside Claude
 * Code's sandbox too, makes a user namespace within bubblewrap's and needs capabilities there, which AppArmor can take
 * away (Codex's and Copilot's sandboxes need none, so they can start where these fail). The kernel's list of loaded
 * profiles is root's to read, so one sandboxed `true` is the test, and AppArmor's own files name the likely fix.
 */
export function sandboxStartProblems({ start = () => spawnSync("srt", ["--", "true"], { encoding: "utf8", timeout: 60_000 }), read = readOr, exists = existsSync } = {}) {
  const r = start();
  if (r.status === 0) return [];
  const why = String(r.stderr || r.error?.message || "").trim().split("\n").at(-1)?.slice(0, 200) || `exit ${r.status ?? r.signal}`;
  const out = [`srt's sandbox does not start here (${why})`];
  if (read("/proc/sys/kernel/apparmor_restrict_unprivileged_userns").trim() === "1") out.push("AppArmor restricts unprivileged user namespaces, which the sandbox needs: sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0, and the same in /etc/sysctl.d to keep it");
  if (exists("/etc/apparmor.d/bwrap-userns-restrict")) out.push("AppArmor's bwrap-userns-restrict profile, which Ubuntu 26.04 loads, takes every capability from what bubblewrap starts: unload it with sudo apparmor_parser -R /etc/apparmor.d/bwrap-userns-restrict, and keep it off with sudo ln -s /etc/apparmor.d/bwrap-userns-restrict /etc/apparmor.d/disable/");
  return out;
}
const readOr = (f) => {
  try {
    return readFileSync(f, "utf8");
  } catch {
    return "";
  }
};

/** srt's and Claude Code's own scratch directory, writable in every one of their sandboxes on the box; Factory points nothing there. */
export const SHARED_TMP = ["/tmp/claude", "/private/tmp/claude"];

/**
 * Git LFS's download hosts on GitHub: the batch download a pull makes (github-cloud, seen in a traced pull; the batch
 * API is on github.com) and a repository's LFS file read over HTTPS (media.githubusercontent.com, as raw files are on
 * raw.githubusercontent.com). Local mode reads LFS media and never uploads it, so the upload hosts stay out: one is an
 * S3 hostname through which any bucket is addressable.
 */
export const LFS_DOMAINS = ["github-cloud.githubusercontent.com", "media.githubusercontent.com"];

/** The hosts a sandboxed command may reach: GitHub (Git LFS included) and the npm and Yarn registries, plus the adopter's list. */
export const LOCAL_DOMAINS = ["github.com", "api.github.com", "codeload.github.com", "objects.githubusercontent.com", "raw.githubusercontent.com", ...LFS_DOMAINS, "registry.npmjs.org", "registry.yarnpkg.com", "repo.yarnpkg.com"];

/**
 * Credential stores under the home directory that no sandboxed command and no file tool may read.
 * The harness CLI itself runs outside the sandbox, so its own login keeps working.
 */
export const CREDENTIAL_PATHS = [".ssh", ".aws", ".azure", ".config/gcloud", ".kube", ".docker", ".gnupg", ".netrc", ".npmrc", ".yarnrc", ".yarnrc.yml", ".pypirc", ".git-credentials", ".config/gh", ".config/hub", ".claude/.credentials.json", ".claude.json", ".codex", ".copilot", ".config/github-copilot", ".vercel", ".local/share/com.vercel.cli", ".config/com.vercel.cli", ".config/factory"];
export const credentialPaths = (home = homedir()) => CREDENTIAL_PATHS.map((p) => join(home, p));

/**
 * A clone's git internals Factory itself runs or reads (hooks, config, commondir, info/attributes, whose filters run in
 * Factory's own git): no sandboxed command and no edit may change them.
 */
export const gitGuards = (clone) => [join(clone, ".git", "hooks"), join(clone, ".git", "config"), join(clone, ".git", "commondir"), join(clone, ".git", "info", "attributes")];

/** The model credentials Claude Code's sandbox unsets before every command it runs, on every route (harness.mjs passes all of SHELL_SECRET_KEYS). */
export const CLAUDE_SECRET_ENV = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"];

/**
 * Claude Code's settings for a sandboxed run: shell commands in its sandbox with no unsandboxed
 * escape and the run refused when the sandbox cannot start; network limited to `domains`;
 * credential stores (`secrets`) unreadable by shell and file tools alike; the credentials in
 * `secretEnv` unset in every command's environment (the sandbox's `credentials.envVars`); the
 * clone's git hooks and config unwritable; file edits auto-approved only inside the working
 * directory and `addDirs` (acceptEdits). Local mode, the Actions runner and the cloud sandbox VM
 * use it alike (claudeRunnerSettings).
 */
export function claudeLocalSettings({ domains = LOCAL_DOMAINS, clone = null, home = homedir(), readOnly = [], writable = [], secrets = credentialPaths(home), secretEnv = CLAUDE_SECRET_ENV } = {}) {
  // readOnly: Factory's own helpers inside a writable directory (factory-db in the usage dir): no write, no edit.
  const guards = [...(clone ? [...gitGuards(clone), ...harnessConfigPaths(clone)] : []), ...readOnly];
  return {
    // No hook runs, whatever a skill or agent definition declares: a hook runs outside the sandbox.
    disableAllHooks: true,
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: true,
      network: { allowedDomains: [...new Set(domains)] },
      // /proc: no sandboxed command reads another process's environment or command line.
      // writable: the package caches, for shell commands only (no file tool, and no CLAUDE.md read from them).
      filesystem: { denyRead: [...secrets, "/proc"], ...(writable.length ? { allowWrite: writable } : {}), denyWrite: [...guards, ...SHARED_TMP] },
      // The model's credential (and any other the harness holds) is not in a command's environment.
      credentials: { envVars: [...new Set(secretEnv)].map((name) => ({ name, mode: "deny" })) },
    },
    // Bash is allowed outright: every shell command still runs inside the sandbox (allowUnsandboxedCommands is
    // false), which is what confines it; without the rule, gh writes and commands with variables would need a
    // human approval that a headless run cannot get.
    permissions: {
      allow: ["Bash", "Read", "Glob", "Grep", "Agent", "Task", "TodoWrite", "Skill"],
      deny: [...[...secrets, "/proc"].flatMap((p) => [`Read(/${p})`, `Read(/${p}/**)`]), ...guards.flatMap((p) => [`Edit(/${p})`, `Edit(/${p}/**)`])],
      blockReadsOutsideWorkingDirectories: true,
      blockWritesOutsideWorkingDirectories: true,
    },
  };
}

/**
 * Claude Code's settings on the Actions runner and in a cloud sandbox VM, where it runs as the agent uid (agent.mjs):
 * local mode's bar (claudeLocalSettings), fitted to the runner (lib/claude-runner.mjs). Commands may write only
 * `writable`: the checkout, the agent's temp directory, Claude Code's own command temp directory and the package
 * caches; never the checkout's git hooks, config and harness configuration, `readOnly` (Claude Code's edit-diff
 * directory, which its own git reads outside the sandbox), nor anything else in the agent's home.
 * No credential store is hidden: the agent's home holds only its read-only GitHub token, which is for its commands.
 */
export function claudeRunnerSettings({ domains = LOCAL_DOMAINS, clone, writable, readOnly = [], secretEnv = CLAUDE_SECRET_ENV }) {
  return claudeLocalSettings({ domains, clone, writable, readOnly, secrets: [], secretEnv });
}

/**
 * The hosts a runner's sandboxed commands may reach: LOCAL_DOMAINS plus the `allowed_domains` input (the Actions and
 * cloud sandbox counterpart of FACTORY_LOCAL_DOMAINS), split on commas and white space. An entry is a host name or
 * `*.` and one; anything else is dropped.
 */
const DOMAIN_ENTRY = /^(\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;
const domainEntries = (value) => String(value || "").split(/[\s,]+/).map((d) => d.trim().toLowerCase()).filter(Boolean);
export function runnerDomains(value = "") {
  return [...new Set([...LOCAL_DOMAINS, ...domainEntries(value).filter((d) => DOMAIN_ENTRY.test(d))])];
}

/** The `allowed_domains` entries runnerDomains drops (doctor names each). */
export const droppedDomains = (value = "") => domainEntries(value).filter((d) => !DOMAIN_ENTRY.test(d));

const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** A TOML basic string (JSON's escaping is a subset TOML reads the same way). */
const tq = JSON.stringify;

/**
 * Codex's `-c` overrides for a local run: model commands under Codex's own sandbox with a permission profile
 * built on read-only, writes only in the working directory and `addDirs` (the clone's .git writable for commits,
 * its hooks and config not), credential stores unreadable, network through Codex's proxy limited to `domains`,
 * no approval prompts and no escalation, and the model API keys kept out of the commands' environment. Codex's
 * own login stays readable to Codex itself, which runs outside the sandbox: the profile denies the login file,
 * not ~/.codex, where Codex keeps the sandbox helper it starts.
 */
export function codexLocalConfig({ domains = LOCAL_DOMAINS, clone = null, addDirs = [], home = homedir(), readOnly = [], secretEnv = [], secrets = CREDENTIAL_PATHS.map((p) => join(home, p === ".codex" ? ".codex/auth.json*" : p)), exists = (p) => !!lstatSync(p, { throwIfNoEntry: false }), commandEnv = null, denyProc = true } = {}) {
  // /proc: no command reads a process outside Codex's sandbox: each runs in a user namespace of its own without
  // CAP_SYS_PTRACE, so the kernel refuses the read, and where bubblewrap can mount a fresh /proc it has its own PID
  // namespace too. Locally the profile denies /proc as well. On a runner it does not (`denyProc` false): under a systemd
  // unit that deny holds and takes /dev/fd with it (bash's process substitution, /dev/stdin); the runner's confinement
  // probe checks the read refusal with a decoy before every start (codex-runner.mjs).
  const deny = [...secrets.map((p) => `${tq(p)}="deny"`), ...(denyProc ? [`${tq("/proc")}="deny"`] : [])];
  // The clone's harness configuration by absolute path, where present: a path relative to the workspace roots applies to
  // every root, and Codex's sandbox fails to start on an absent one (a stage's temp directory has no .github). Factory makes
  // them all before a harness starts (prepareClone).
  // .git/commondir and .git/info/attributes likewise by absolute path: relative, Codex would make them in every root
  // that has no .git.
  // `exists`: on a runner the checkout is the agent's (700), so what is there is listed as the agent (codex-runner.mjs).
  const ro = [...(clone ? codexReadOnly(clone).filter(exists) : []), ...readOnly].map((p) => `${tq(p)}="read"`);
  const roots = addDirs.map((d) => `${tq(d)}=true`);
  const net = [...new Set(domains)].map((d) => `${tq(d)}="allow"`);
  const profile = `{extends=":read-only",workspace_roots={${roots.join(",")}},filesystem={${[...deny, ...ro, `":workspace_roots"={"."="write",".git"="write",".git/hooks"="read",".git/config"="read"}`].join(",")}},network={enabled=true,mode="full",allow_local_binding=true,domains={${net.join(",")}}}}`;
  // allow_local_binding: the repository's own test servers on 127.0.0.1 (a loopback Postgres). Codex's sandbox has its own
  // network namespace, so the host's loopback services stay out of reach (checked: a host server refused).
  return [
    `default_permissions="factory"`,
    `permissions.factory=${profile}`,
    // Without the proxy feature the domain list is ignored and the network is open.
    `features.network_proxy=true`,
    `approval_policy="never"`,
    // The developer's ChatGPT connectors (GitHub, Stripe, ...) would reach the model as tools that run outside the sandbox.
    `features.apps=false`,
    // A trusted project's .codex/config.toml merges into this profile, and the model writes the clone: never trust it.
    ...(clone ? [`projects={${tq(clone)}={trust_level="untrusted"}}`] : []),
    `approvals_reviewer="user"`,
    codexShellExclude(secretEnv),
    // `commandEnv`: variables every command gets (on a runner the agent's HOME and TMPDIR back, codex-runner.mjs).
    ...(commandEnv ? [`shell_environment_policy.set={${Object.entries(commandEnv).map(([k, v]) => `${k}=${tq(v)}`).join(",")}}`] : []),
  ].flatMap((c) => ["-c", c]);
}

/** The checkout's paths Codex's sandbox keeps read-only where they exist: its harness configuration and git's own. */
// .git/info itself too: a command that could rename it would put an attributes file of its own in its place.
export const codexReadOnly = (clone) => [...harnessConfigPaths(clone), join(clone, ".git", "commondir"), join(clone, ".git", "info"), join(clone, ".git", "info", "attributes")];

/**
 * Codex's `-c` value that drops `names` from the environment of every command its model runs, on every route. Codex's
 * default keeps names containing KEY, SECRET or TOKEN (`shell_environment_policy.ignore_default_excludes` is true).
 */
export const codexShellExclude = (names) => `shell_environment_policy.exclude=[${names.map(tq).join(",")}]`;

/**
 * The settings.json for the COPILOT_HOME Factory gives a local Copilot run (`copilot --sandbox`): commands in
 * Copilot's sandbox with no bypass, writes in the working directory and `addDirs` only, the clone's hooks and
 * config and `readOnly` unwritable, credential stores denied, no gh or git login handed in, and the network
 * limited to `domains`. Copilot reads this policy only from its home directory, so the developer's own
 * ~/.copilot is never touched.
 */
export function copilotLocalSettings({ domains = LOCAL_DOMAINS, clone = null, addDirs = [], home = homedir(), readOnly = [], readable = [], denied = null, platform = osPlatform() } = {}) {
  return {
    sandbox: {
      enabled: true,
      allowBypass: false,
      // On by default, it opens tool configuration such as ~/.npmrc to every command.
      allowDevToolAccess: false,
      addCurrentWorkingDirectory: true,
      sandboxMcpServers: true,
      sandboxLspServers: true,
      sandboxExtensions: true,
      auth: { git: false, gh: false },
      userPolicy: {
        // On Linux a denied file becomes an empty directory, on which libcurl's ~/.netrc reader loops forever and every
        // git fetch hangs; so there only the credential directories are denied (the sandbox's home is an empty tmpfs
        // today, and this does not count on that), and the file tools are kept off the home by path checks (harness.mjs).
        // The clone's .git as a path of its own: on Linux Copilot's sandbox binds it apart from the working directory, and a
        // mount point cannot be renamed, so no command can move .git aside and put one of its own in its place. Seatbelt
        // (macOS) has no bind mounts, so there this changes nothing and the git guard holds.
        // `readable`: paths outside these that a runner's commands read (copilot-runner.mjs: the agent's read-only GitHub
        // login); `denied`: a runner's own list (none there: that login is for its commands).
        filesystem: { readwritePaths: [...addDirs, ...(clone ? [join(clone, ".git")] : [])], readonlyPaths: [...new Set([...(clone ? [...gitGuards(clone), ...harnessConfigPaths(clone)] : []), ...readOnly, ...readable])], deniedPaths: denied ?? (platform === "linux" ? credentialPaths(home).filter(isDir) : credentialPaths(home)) },
        network: { allowOutbound: true, allowLocalNetwork: false, allowedHosts: [...new Set(domains)] },
      },
    },
  };
}

/**
 * The temp directory a local Copilot run must be given. Copilot's sandbox opens the temp directory it is started with
 * (`TMPDIR`, else the host's /tmp) read-write to every command, and gives each command a fresh, empty /tmp otherwise.
 * Only the stage's own temp directory (one of the sandbox's added directories) keeps the host's shared /tmp out of reach.
 */
export function copilotTmpdir(local, env = {}) {
  const t = env.TMPDIR;
  if (!t || !(local?.addDirs || []).includes(t)) throw new Error(`a local Copilot run needs TMPDIR set to its stage's own temp directory (it is ${t || "unset"}): Copilot's sandbox opens TMPDIR, else the host's /tmp, to every command`);
  return t;
}

/** Settings for `srt`, which runs Factory's own shell commands (setup, install, validation) on a model-edited tree. */
export function srtSettings({ domains = LOCAL_DOMAINS, writable = [], clone = null, home = homedir(), readOnly = [] } = {}) {
  return {
    network: { allowedDomains: [...new Set(domains)], deniedDomains: [] },
    filesystem: { denyRead: [...credentialPaths(home), "/proc"], allowWrite: writable, denyWrite: [...(clone ? [...gitGuards(clone), ...harnessConfigPaths(clone)] : []), ...readOnly, ...SHARED_TMP] },
  };
}

/**
 * The `git` a local harness finds first on its PATH (lib/harness.mjs), on the host and in its sandbox: the real one,
 * refused once the clone's .git is not the directory Factory checked before the harness started (FACTORY_GIT_DIR,
 * FACTORY_GIT_ID: its inode). A sandbox that lets a command rename .git (Copilot's) would otherwise let it put a .git
 * of its own in place, whose config the harness's own git on the host then reads between tool calls.
 */
export const gitGuardScript = (realGit) => `#!/bin/sh
if [ -n "$FACTORY_GIT_DIR" ]; then
  id=$(ls -di "$FACTORY_GIT_DIR" 2>/dev/null | awk '{print $1}')
  if [ -L "$FACTORY_GIT_DIR" ] || [ "$id" != "$FACTORY_GIT_ID" ]; then
    echo "factory: $FACTORY_GIT_DIR is not the git directory Factory checked; git refused" >&2
    exit 128
  fi
fi
exec ${JSON.stringify(realGit)} "$@"
`;

/** The hosts each harness CLI itself reaches for its model, sign-in and token refresh, beside the commands' LOCAL_DOMAINS. */
export const HARNESS_API_DOMAINS = {
  claude: ["api.anthropic.com", "statsig.anthropic.com", "console.anthropic.com", "platform.claude.com", "claude.ai"],
  codex: ["api.openai.com", "chatgpt.com", "auth.openai.com", "ai-gateway.vercel.sh"],
  copilot: ["api.githubcopilot.com", "api.individual.githubcopilot.com", "api.business.githubcopilot.com", "api.enterprise.githubcopilot.com", "copilot-proxy.githubusercontent.com", "telemetry.individual.githubcopilot.com"],
};

/** A harness CLI's own state (its login, settings, sessions), which it reads and writes; Copilot's home is Factory's. */
export function harnessHomes(harness, env = {}, home = homedir()) {
  if (harness === "claude") return [env.CLAUDE_CONFIG_DIR || join(home, ".claude"), join(home, ".claude.json")];
  if (harness === "codex") return [env.CODEX_HOME || join(home, ".codex")];
  if (harness === "copilot") return env.COPILOT_HOME ? [env.COPILOT_HOME] : [];
  return [];
}

/**
 * Linux only: srt settings for the whole harness process, so whatever the harness CLI itself runs on the host (its git
 * between tool calls, a hook, a config loader a future version adds) is contained even where a file-level guard misses.
 * Credential stores unreadable but the harness's own state, writes only in `writable` and that state, the network
 * limited to `domains` and the harness's own API hosts. The harness's own sandbox runs inside it, which needs nested
 * user namespaces and unix sockets. Its read-only paths inside writable ones still hold against code that makes a user
 * namespace of its own: srt's mounts are locked there (checked with srt 0.0.81: umount, remount, bind of the parent and
 * hard link all refused; a mount over one only hides it in that namespace).
 */
/**
 * The harnesses that run in it. Claude Code always. Codex where its own sandbox starts inside it, which outerProbe checks
 * once per host and Codex, bubblewrap and srt version: it does on WSL2 (bubblewrap 0.11.1), not on Ubuntu 24.04 and 26.04
 * runners (bubblewrap 0.9.0: "error building bubblewrap command: Read-only file system", Codex 0.167.0). Copilot where
 * its sandbox's network starts inside it (outerProbe, below; bwrapTunScript says why it needs a hand). A harness outside
 * it relies on gitGuardScript and the file-level guards. On Linux no harness's sandbox lets a command rename .git: Codex's
 * refuses, and Copilot's binds the clone's .git as a path of its own (copilotLocalSettings), a mount point no command can
 * move. On macOS (Seatbelt, no bind mounts) Copilot's still allows it; the git guard and the .git pin hold there.
 */
export const OUTER_HARNESSES = ["claude", "codex", "copilot"];
export const OUTER_PROBED = ["codex", "copilot"];

/**
 * Copilot's sandbox on Linux (MXC's bubblewrap backend) gives every command a private network namespace wired by
 * slirp4netns, which opens /dev/net/tun; its commands then reach the network only through Copilot's own proxy, which
 * applies the host allow-list and connects on through the proxy of the sandbox Copilot runs in (srt's, by the env srt
 * sets). srt gives its sandbox a fresh /dev without /dev/net/tun, so slirp4netns failed to start and Copilot's commands
 * had no network. Copilot's outer sandbox therefore runs bwrap through this wrapper (srt's `bwrapPath`), which adds the
 * host's /dev/net/tun after srt's /dev and changes nothing else. A process can make a TUN interface only in a network
 * namespace it owns, so the device opens no route out of the outer sandbox: everything still leaves through srt's proxy.
 * srt runs the wrapper on the host, so it lives where no sandbox can write (the stage's usage directory).
 */
export const bwrapTunScript = (realBwrap, tun = "/dev/net/tun") => `#!/bin/sh
# Factory: bubblewrap for Copilot's outer sandbox, with the host's /dev/net/tun after srt's fresh /dev (local.mjs).
# Only among bubblewrap's own options (before the first --), only once, and only where the host has the device: without
# it bubblewrap would refuse to start, and outerProbe says "no /dev/net/tun" instead.
first=1; prev=""; added=""; [ -c ${JSON.stringify(tun)} ] || added=1
for a do
  if [ "$first" = 1 ]; then set --; first=0; fi
  set -- "$@" "$a"
  [ "$a" = "--" ] && added=1
  if [ -z "$added" ] && [ "$prev" = "--dev" ] && [ "$a" = "/dev" ]; then set -- "$@" --dev-bind ${JSON.stringify(tun)} /dev/net/tun; added=1; fi
  prev=$a
done
exec ${JSON.stringify(realBwrap)} "$@"
`;

/** The wrapper written in `dir` (made owner-only): its path, for harnessOuterSettings `bwrapPath`. */
export function writeBwrapTun(dir, bwrap = whichPath("bwrap", process.env), tun = "/dev/net/tun") {
  if (!bwrap) throw new Error("bwrap is not on PATH");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = join(dir, "bwrap");
  writeFileSync(p, bwrapTunScript(realpathSync(bwrap), tun), { mode: 0o755 });
  return p;
}

/**
 * What Copilot's sandbox needs inside the outer one, checked as it would use it: the TUN device, its tools, and
 * slirp4netns wiring a fresh user and network namespace. Exit 0 and `ok` when all hold, else the first that does not.
 */
export const COPILOT_OUTER_PROBE = `test -c /dev/net/tun || { echo "no /dev/net/tun" >&2; exit 2; }
for b in slirp4netns nsenter unshare ip iptables ip6tables iptables-restore ip6tables-restore; do command -v "$b" >/dev/null || { echo "$b is not on PATH" >&2; exit 3; }; done
unshare --user --net --map-user="$(id -u)" --map-group="$(id -g)" true 2>/dev/null || { echo "unshare cannot make a user and network namespace mapping the user (util-linux 2.36 or later)" >&2; exit 5; }
unshare --user --net --map-user="$(id -u)" --map-group="$(id -g)" --keep-caps sleep 10 & ns=$!
sleep 0.5
slirp4netns --configure --mtu=65520 "$ns" tap0 >/dev/null 2>"$TMPDIR/slirp.err" & sl=$!
ok=""
for i in 1 2 3 4 5 6 7 8 9 10; do
  if nsenter --target "$ns" --user --net --preserve-credentials ip -4 -o address show dev tap0 2>/dev/null | grep -q 10.0.2.100; then ok=1; break; fi
  sleep 0.3
done
kill "$sl" "$ns" 2>/dev/null
[ -n "$ok" ] || { echo "slirp4netns did not configure its interface: $(tail -1 "$TMPDIR/slirp.err" 2>/dev/null)" >&2; exit 4; }
echo ok
`;
const OUTER_PROFILE = "profile-4";

const versionOf = (cmd) => {
  const r = spawnSync(cmd, ["--version"], { encoding: "utf8", timeout: 30_000 });
  return r.status === 0 ? String(r.stdout || r.stderr).trim().split("\n")[0] : null;
};

/**
 * Where Copilot's own binary unpacks the release it carries (`pkg/`) and keeps its caches: read-only in its outer
 * sandbox, so the harness cannot change code it runs at its next start. sandboxedVersion unpacks it, the one place
 * Factory lets Copilot write there.
 */
export const copilotCacheHome = (env = {}, home = homedir(), platform = osPlatform()) => env.COPILOT_CACHE_HOME || (platform === "darwin" ? join(home, "Library", "Caches", "copilot") : join(env.XDG_CACHE_HOME || join(home, ".cache"), "copilot"));
/** sandboxedVersion's srt settings: no network, no writes but Copilot's unpacking, credential stores unreadable. */
export const versionSettings = (harness, env = {}, home = homedir()) => ({
  network: { allowedDomains: [], deniedDomains: [] },
  filesystem: { denyRead: [...credentialPaths(home), "/proc"], allowRead: harnessInstall(whichPath(harness, env) || harness, home), allowWrite: harness === "copilot" ? [copilotCacheHome(env, home)] : [], denyWrite: [] },
});

/**
 * A harness CLI's `--version`, run in srt (no network, no writes, credential stores unreadable but its install): a
 * binary someone replaced must not run on the host to be probed. `settingsDir` holds the settings file.
 */
export function sandboxedVersion(harness, settingsDir, { env = process.env, home = homedir() } = {}) {
  const f = join(settingsDir, "version.json");
  const settings = versionSettings(harness, env, home);
  for (const d of settings.filesystem.allowWrite) mkdirSync(d, { recursive: true, mode: 0o700 });
  writeFileSync(f, JSON.stringify(settings));
  const r = spawnSync("srt", ["-s", f, "--", harness, "--version"], { encoding: "utf8", timeout: 60_000, env });
  return r.status === 0 ? String(r.stdout || r.stderr).trim().split("\n")[0] : null;
}

/**
 * Linux: whether `harness` runs in the outer sandbox on this host ({on, why, cached, cacheFile}). Claude Code: yes. A
 * probed harness (Codex, Copilot): its own sandbox, or what it needs, is started once inside the outer sandbox's profile
 * on a throwaway directory. Only a yes is kept, in ~/.cache/factory/outer-probe.json by harness, bubblewrap and srt
 * version, so the next stage reads it; a no (which a loaded box or a missing tool installed since can cause) is probed
 * again by the next serve start and the next stage.
 */
export function outerProbe(harness, { domains = LOCAL_DOMAINS, env = process.env, home = homedir(), cacheFile = join(home, ".cache", "factory", "outer-probe.json"), keyOf = outerProbeKey, probe = runOuterProbe } = {}) {
  if (osPlatform() !== "linux") return { on: false, why: "not Linux (Seatbelt cannot start inside another sandbox)" };
  if (!OUTER_HARNESSES.includes(harness)) return { on: false, why: "not supported" };
  if (!OUTER_PROBED.includes(harness)) return { on: true, why: "" };
  const key = keyOf(harness, { env, home });
  let cache = {};
  try {
    cache = JSON.parse(readFileSync(cacheFile, "utf8"));
  } catch {
    // none yet
  }
  if (cache[key]?.on === true) return { ...cache[key], cached: true, cacheFile };
  let result = probe(harness, { domains, env, home });
  // Copilot is refused without it (local.mjs preflight and stageEnv): a no is probed once more, so one slow probe (a
  // busy box, slirp4netns late to configure) neither stops serve nor Blocks a stage.
  if (!result.on && harness === "copilot") result = probe(harness, { domains, env, home });
  // A no from an older Factory is dropped with the rewrite.
  const kept = Object.fromEntries(Object.entries(cache).filter(([, v]) => v?.on === true));
  if (result.on || Object.keys(kept).length !== Object.keys(cache).length) {
    try {
      mkdirSync(dirname(cacheFile), { recursive: true, mode: 0o700 });
      writeFileSync(cacheFile, `${JSON.stringify({ ...kept, ...(result.on ? { [key]: { ...result, at: new Date().toISOString() } } : {}) }, null, 2)}\n`, { mode: 0o600 });
    } catch {
      // the probe runs again next time
    }
  }
  return { ...result, cacheFile };
}

/** outerProbe's cache key: the harness's version (started in a sandbox of its own), bubblewrap's, srt's and the profile's. */
export function outerProbeKey(harness, { env = process.env, home = homedir() } = {}) {
  const vdir = realpathSync(stageTemp("probe-", home));
  try {
    // OUTER_PROFILE: a change to harnessOuterSettings probes again.
    return [harness, sandboxedVersion(harness, vdir, { env, home }), versionOf("bwrap"), versionOf("srt"), OUTER_PROFILE, ...(harness === "copilot" ? [versionOf("slirp4netns")] : [])].join("|");
  } finally {
    dropOwned(vdir);
  }
}

/** outerProbe's check itself: the harness's own sandbox (Codex) or what it needs (Copilot), inside the outer profile. */
export function runOuterProbe(harness, { domains = LOCAL_DOMAINS, env = process.env, home = homedir() } = {}) {
  const dir = realpathSync(stageTemp("probe-", home));
  try {
    ensureHarnessHomes(harness, env, home);
    const settings = join(dir, "outer.json");
    // As a stage has it: a prepared clone, and a temp directory beside it.
    const work = join(dir, "w");
    const tmp = join(dir, "t");
    mkdirSync(tmp);
    spawnSync("git", ["init", "-q", work], { stdio: "ignore", timeout: 30_000 });
    prepareProtectedPaths(work);
    // Copilot's own sandbox cannot be started without a model call; what it needs inside the outer one is checked instead.
    const bwrapPath = harness === "copilot" ? writeBwrapTun(join(dir, "bin")) : null;
    writeFileSync(settings, JSON.stringify(harnessOuterSettings({ harness, domains, writable: [work, tmp], clone: work, env, home, install: harnessInstall(whichPath(harness, env) || harness, home), bwrapPath })));
    const inner = harness === "copilot" ? ["sh", "-c", COPILOT_OUTER_PROBE] : ["codex", "sandbox", ...codexLocalConfig({ domains, clone: work, addDirs: [tmp], home }), "--", "sh", "-c", `echo ok > ${JSON.stringify(join(work, "probe"))}`];
    const r = spawnSync("srt", ["-s", settings, "--", "env", `TMPDIR=${tmp}`, ...inner], { cwd: work, env: { ...env, TMPDIR: tmp }, encoding: "utf8", timeout: 120_000 });
    const ok = r.status === 0 && (harness === "copilot" ? /^ok$/m.test(r.stdout || "") : existsSync(join(work, "probe")));
    return { on: ok, why: ok ? "" : `its own sandbox does not start inside it here (${String(r.stderr || r.error?.message || `exit ${r.status}`).trim().split("\n").at(-1)?.slice(0, 200)})` };
  } finally {
    dropOwned(dir);
  }
}

const whichPath = (bin, env) => {
  for (const d of String(env.PATH || "").split(":").filter(Boolean)) {
    const p = join(d, bin);
    if (existsSync(p)) return p;
  }
  return null;
};

/**
 * Where a harness CLI is installed, for harnessOuterSettings `install`: for each hop of its symlink chain, the directory
 * three above it, only where that lies inside a credential store (Codex's installer puts its releases, and the
 * `current` link to one, in ~/.codex).
 */
export const harnessInstall = (bin, home = homedir()) => {
  const hops = [];
  try {
    for (let p = bin, i = 0; p && i < 8; i += 1) {
      hops.push(p);
      if (!lstatSync(p).isSymbolicLink()) break;
      p = resolve(dirname(p), readlinkSync(p));
    }
    hops.push(realpathSync(bin));
  } catch {
    return [];
  }
  const inside = (d) => credentialPaths(home).some((c) => d.startsWith(`${c}/`));
  return [...new Set(hops.map((p) => dirname(dirname(dirname(p)))).filter(inside))];
};

/** srt leaves an absent writable path read-only: the harness's own directories are made before its outer sandbox opens. */
// What an absent guarded file is made with: content the harness reads as nothing set (checked with Codex 0.167.0 and
// Claude Code 2.1.319; Copilot's below). Absent, srt would stand in for it with a file the harness cannot read, and Codex stops on an
// unreadable config.toml. AGENTS.override.md stays absent (empty, it would hide the developer's AGENTS.md; unreadable,
// Codex skips it), and so do ~/.claude.json (a signed-in Claude Code has one) and the files Claude Code reads only in
// an interactive session or its daemon (keybindings.json, scheduled_tasks.json, daemon.json): unreadable, a headless run
// skips them.
const HOME_SEEDS = { "config.toml": "", "managed_config.toml": "", "requirements.toml": "", "hooks.json": '{"hooks":{}}\n', "AGENTS.md": "", "instructions.md": "", "settings.json": "{}\n", "settings.local.json": "{}\n", "CLAUDE.md": "" };
/**
 * Copilot's config.json (where it records trusted folders, which would load a clone's MCP servers and hooks) and its
 * MCP servers, as a local stage writes them on the host before every start: nothing trusted, no servers. Copilot writes
 * config.json only to record its first launch (checked with Copilot 1.0.107), which it finds done here, so both stay
 * read-only in its outer sandbox.
 */
export const copilotHomeFiles = () => ({ "config.json": `${JSON.stringify({ firstLaunchAt: new Date().toISOString() })}\n`, "mcp-config.json": '{"mcpServers":{}}\n' });
export const ensureHarnessHomes = (harness, env = {}, home = homedir()) => {
  // And the guarded directories, which srt would otherwise stand in for with a file the harness cannot read as one.
  for (const d of [...harnessHomes(harness, env, home).filter((p) => !p.endsWith(".json")), ...harnessHomeGuards(harness, env, home, { dirsOnly: true })]) mkdirSync(d, { recursive: true, mode: 0o700 });
  const seeds = { ...HOME_SEEDS, ...(harness === "copilot" ? copilotHomeFiles() : {}) };
  for (const f of harnessHomeGuards(harness, env, home, { staticOnly: true })) {
    const seed = seeds[basename(f)];
    if (seed === undefined) continue;
    try {
      writeFileSync(f, seed, { flag: "wx", mode: 0o600 });
    } catch {
      // there already
    }
  }
};

/**
 * What in a harness's own state runs code or steers a later session, the developer's own included, and must stay
 * read-only in the outer sandbox even where absent: settings, hooks, MCP servers, plugins, skills, instructions and
 * installed releases; and what Claude Code's own file tools refuse to write, since its sessions run it outside every
 * sandbox (session-env and shell-snapshots, sourced ahead of each Bash command; the daemon, its jobs and dev-mods),
 * with scheduled tasks and their locks, keybindings, plans, the release notes and model catalog an interactive Claude
 * Code shows, and Codex's memories and update record. Everything else already in the state directory is read-only
 * too unless HOME_WRITABLE names it (harnessHomeGuards), so a name a later version adds is guarded from the start.
 */
const HOME_GUARDS = {
  claude: {
    files: ["settings.json", "settings.local.json", "CLAUDE.md", "daemon.json", "scheduled_tasks.json", "keybindings.json", "daemon.lock", "scheduled_tasks.lock", join("cache", "changelog.md")],
    dirs: ["hooks", "plugins", "skills", "agents", "commands", "output-styles", "rules", "session-env", "shell-snapshots", "jobs", "daemon", "dev-mods", "sessions", "remote-control", "bridge-spawn", "plans", join("cache", "model-catalog")],
  },
  codex: {
    files: ["config.toml", "managed_config.toml", "requirements.toml", "hooks.json", "AGENTS.md", "AGENTS.override.md", "instructions.md", "version.json"],
    dirs: ["packages", "bin", "skills", "rules", "plugins", "prompts", "memories", "shell_snapshots", "app-server-control", "app-server-daemon"],
  },
  // Copilot: settings.json is also its sandbox's policy (copilotLocalSettings); its own file edits follow that policy
  // only on a best-effort basis, so the outer sandbox is the hard line around it. config.json: its trusted folders.
  // pkg: a release it would run.
  copilot: {
    files: ["settings.json", "config.json", "mcp-config.json", "lsp-config.json", "permissions-config.json", "copilot-instructions.md"],
    dirs: ["hooks", "skills", "agents", "instructions", "extensions", "installed-plugins", "pkg"],
  },
};
/**
 * The names in a harness's state directory its headless run writes (traced with Claude Code 2.1.319, Codex 0.167.0 and Copilot 1.0.107):
 * its login's refresh (written beside it, then renamed), its sessions, caches and logs. Codex stops without its
 * installation id and its state and log databases; its memories, goals, queue and thread history stay read-only. Temp
 * files and `<name>.lock` are new names, which the sandbox lets it make (the lock files HOME_GUARDS names excepted).
 * Claude Code's `projects` is read-only but for the clone's own project (claudeProjectLink), in Codex's `sessions` only
 * the last days' directories and the sessions it starts there (codexSessionGuards).
 */
const HOME_WRITABLE = {
  claude: [".credentials.json", "projects", "cache", "todos", "statsig", "debug", "telemetry", "file-history", "stats-cache.json"],
  codex: ["auth.json", "installation_id", "sessions", "log", "tmp", "cache", "thread-writer-locks", "models_cache.json", /^(logs|state)_\d+\.sqlite(-wal|-shm|-journal)?$/],
  // Copilot (1.0.107): its sessions, which a later stage resumes, and its logs. Its home is the Objective's own.
  copilot: ["session-state", "logs", /^session-store\.db(-wal|-shm|-journal)?$/],
};
const writableName = (harness, name) => /\.lock$|\.tmp\b|^\.tmp/.test(name) || (HOME_WRITABLE[harness] || []).some((w) => (typeof w === "string" ? w === name : w.test(name)));
const harnessStateDir = (harness, env, home) => (harness === "claude" ? env.CLAUDE_CONFIG_DIR || join(home, ".claude") : harness === "codex" ? env.CODEX_HOME || join(home, ".codex") : harness === "copilot" ? env.COPILOT_HOME || null : null);
const entries = (d) => {
  try {
    return readdirSync(d);
  } catch {
    return [];
  }
};
/** Claude Code's project directory name for a working directory (every character but a letter or digit becomes `-`). */
export const claudeProject = (dir) => String(dir).replace(/[^a-zA-Z0-9]/g, "-");
/** Claude Code shortens a longer project name (and adds a hash): such a clone keeps a writable `projects` (harnessHomeGuards). */
const linkableProject = (clone) => claudeProject(clone).length <= 200;
const claudeProjectPath = (clone, env, home) => join(harnessStateDir("claude", env, home), "projects", claudeProject(clone));

/**
 * In the outer sandbox Claude Code's `projects` is read-only, so a run can make no other project (whose memory a later
 * session of the developer's in that directory would read). The clone's own project is a link Factory makes there to
 * `dir`, a directory of the Objective's own that the outer sandbox may write (harnessOuterSettings `projectDir`). A
 * project directory an earlier stage left there moves to `dir` with its sessions (else it goes: each stage's session is
 * also saved in its usage directory). Returns `dir`, or null for a clone whose project name Claude Code shortens.
 */
export function claudeProjectLink(clone, dir, env = {}, home = homedir()) {
  if (!linkableProject(clone)) return null;
  const link = claudeProjectPath(clone, env, home);
  mkdirSync(dirname(link), { recursive: true, mode: 0o700 });
  const st = lstatSync(link, { throwIfNoEntry: false });
  if (st?.isSymbolicLink() && readlinkSync(link) === dir && lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) return dir;
  if (st?.isDirectory() && !lstatSync(dir, { throwIfNoEntry: false })) {
    try {
      mkdirSync(dirname(dir), { recursive: true });
      renameSync(link, dir);
    } catch {
      // another filesystem: the directory goes below
    }
  }
  // rmSync removes a link, never its target, and follows no link inside a directory.
  rmSync(link, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  symlinkSync(dir, link);
  return dir;
}
/** The link claudeProjectLink made for a clone, removed with the Objective's directory (a regular directory is left). */
export function dropClaudeProjectLink(clone, env = {}, home = homedir()) {
  const link = claudeProjectPath(clone, env, home);
  if (lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) rmSync(link, { force: true });
}

/**
 * Codex keeps every session, the developer's included, in sessions/YYYY/MM/DD: the days before yesterday read-only, and
 * in the days since (it may date a session by UTC or local time) each session already there.
 */
function codexSessionGuards(root, now = Date.now()) {
  const recent = new Set([-1, 0, 1].flatMap((k) => {
    const d = new Date(now + k * 86_400_000);
    const p = (n) => String(n).padStart(2, "0");
    return [`${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}`, `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`];
  }));
  const out = [];
  for (const y of entries(root)) {
    for (const m of entries(join(root, y))) {
      for (const d of entries(join(root, y, m))) {
        const day = join(root, y, m, d);
        if (recent.has(`${y}/${m}/${d}`)) out.push(...entries(day).map((f) => join(day, f)));
        else out.push(day);
      }
    }
  }
  return out;
}

/**
 * The paths the outer sandbox keeps read-only in a harness's state: HOME_GUARDS (made where absent: dirsOnly, or with
 * staticOnly the files ensureHarnessHomes seeds), every other name there HOME_WRITABLE does not list, and the developer's
 * own projects and sessions. With `clone`, Claude Code's whole `projects` (the clone's own project is a link out of it:
 * claudeProjectLink); for a clone whose project name Claude Code shortens, every project there but that one.
 */
export function harnessHomeGuards(harness, env = {}, home = homedir(), { dirsOnly = false, staticOnly = false, clone = null, now = Date.now() } = {}) {
  const g = HOME_GUARDS[harness];
  if (!g) return [];
  const d = harnessStateDir(harness, env, home);
  if (!d) return [];
  const fixed = [...g.dirs.map((f) => join(d, f)), ...(dirsOnly ? [] : [...g.files.map((f) => join(d, f)), ...(harness === "claude" ? [join(home, ".claude.json")] : [])])];
  if (dirsOnly || staticOnly) return fixed;
  const named = new Set([...g.dirs, ...g.files]);
  const rest = entries(d).filter((n) => !named.has(n) && !writableName(harness, n)).map((n) => join(d, n));
  if (harness === "claude" && clone && linkableProject(clone)) return [...fixed, ...rest, join(d, "projects")];
  const mine = clone ? claudeProject(clone) : null;
  const own = harness === "claude" ? entries(join(d, "projects")).filter((n) => n !== mine && !(mine?.length > 200 && n.startsWith(mine.slice(0, 200)))).map((n) => join(d, "projects", n)) : harness === "codex" ? codexSessionGuards(join(d, "sessions"), now) : [];
  return [...fixed, ...rest, ...own];
}

/**
 * Unix sockets on the box that lead out of any sandbox: the user's session bus (systemd-run --user starts anything on
 * the host), the system bus, the container daemons, snapd, the X server, WSLg's sockets and WSL's interop sockets (which
 * start a Windows process, outside every Linux sandbox), and the ssh and gpg agents. Unreadable in the outer sandbox,
 * which allows unix sockets for the harness's own nested sandbox (srt keeps an allow-list of socket paths on macOS only);
 * the host's abstract sockets are out of reach already, since it has its own network namespace. A fixed list is never
 * complete, so also: one level under /run, /mnt/wslg and /tmp/.X11-unix, each socket and each directory holding one
 * (a directory this user cannot list too), every socket the kernel lists as bound now (/proc/net/unix), wherever it
 * is (under /run, its top directory), and each ssh, gpg or tmux directory directly under /tmp, socket or not (an agent
 * or a tmux server may bind there later), except under `keep` (the stage's own directories). The harness's own sandbox
 * needs nothing under /run: its runtime directory is the stage's temp directory. The list is made when a stage starts.
 */
export const HOST_SOCKETS = ["/run/dbus", "/var/run/dbus", "/run/docker.sock", "/var/run/docker.sock", "/run/podman", "/run/containerd", "/run/snapd.socket", "/run/snapd-snap.socket", "/run/WSL", "/mnt/wslg", "/tmp/.X11-unix"];
export const SOCKET_ROOTS = ["/run", "/mnt/wslg", "/tmp/.X11-unix"];
/** The directories under /tmp where ssh-agent, gpg-agent and tmux make their sockets. */
export const TMP_SOCKET_DIRS = /^(ssh|gpg|tmux)-/;
/** The bound socket paths in /proc/net/unix's text (its last column, where it is a path). */
export const boundSockets = (text) => String(text || "").split("\n").slice(1).map((l) => /^\s*\S+:\s+(?:\S+\s+){6}(\/.*)$/.exec(l)?.[1]).filter(Boolean);
export function hostSockets(env = {}, uid = process.getuid?.() ?? 0, { roots = SOCKET_ROOTS, bound = () => boundSockets(readOr("/proc/net/unix")), keep = [], tmp = "/tmp" } = {}) {
  const agent = env.SSH_AUTH_SOCK ? [dirname(env.SSH_AUTH_SOCK)] : [];
  const out = [`/run/user/${uid}`, ...HOST_SOCKETS, ...agent.filter((d) => d !== "/tmp" && d !== "/")];
  // A path this user cannot reach (a directory it may not search) is one it cannot connect to either.
  const st = (p) => {
    try {
      return lstatSync(p, { throwIfNoEntry: false });
    } catch {
      return null;
    }
  };
  const real = (p) => {
    try {
      return join(realpathSync(dirname(p)), basename(p));
    } catch {
      return null;
    }
  };
  const top = roots.map((r) => (st(r)?.isDirectory() ? r : null)).filter(Boolean);
  for (const r of top) {
    for (const n of entries(r)) {
      const p = join(r, n);
      const s = st(p);
      if (s?.isSocket()) out.push(p);
      else if (s?.isDirectory()) {
        try {
          if (readdirSync(p).some((c) => st(join(p, c))?.isSocket())) out.push(p);
        } catch {
          out.push(p);
        }
      }
    }
  }
  const kept = (p) => keep.some((k) => p === k || p.startsWith(`${k}/`));
  for (const n of entries(tmp).filter((n) => TMP_SOCKET_DIRS.test(n))) {
    const p = join(tmp, n);
    if (st(p)?.isDirectory() && !kept(p)) out.push(p);
  }
  for (const b of bound()) {
    const p = real(b);
    if (!p || !st(p)?.isSocket() || kept(p)) continue;
    const r = top.find((t) => p.startsWith(`${t}/`));
    out.push(r ? join(r, p.slice(r.length + 1).split("/")[0]) : p);
  }
  // One entry per tree: srt stands an empty directory in for a denied one, under which a nested entry has nothing to hide.
  const uniq = [...new Set(out)];
  return uniq.filter((p) => !uniq.some((q) => q !== p && p.startsWith(`${q}/`)));
}

/**
 * `projectDir`: the directory claudeProjectLink links the clone's Claude Code project to, writable here (Claude Code only).
 * `bwrapPath`: the bubblewrap srt runs (Copilot: writeBwrapTun's wrapper).
 */
export function harnessOuterSettings({ harness, domains = LOCAL_DOMAINS, writable = [], clone = null, home = homedir(), env = {}, readOnly = [], install = [], projectDir = null, bwrapPath = null } = {}) {
  const own = harnessHomes(harness, env, home);
  const isOwn = (p) => own.some((o) => p === o || p.startsWith(`${o}/`));
  // ~/.claude.json holds the developer's MCP servers: read-only, not a writable path.
  const guards = harnessHomeGuards(harness, env, home, { clone });
  const writableOwn = own.filter((p) => !guards.includes(p));
  return {
    network: { allowedDomains: [...new Set([...domains, ...(HARNESS_API_DOMAINS[harness] || [])])], deniedDomains: [], allowAllUnixSockets: true, allowLocalBinding: true },
    // install: the harness's own release directory, readable where a credential store holds it (Codex's installer puts
    // it in ~/.codex, denied when CODEX_HOME is elsewhere).
    filesystem: {
      denyRead: [...credentialPaths(home).filter((p) => !isOwn(p)), ...hostSockets(env, undefined, { keep: writable })],
      ...(install.length ? { allowRead: install } : {}),
      allowWrite: [...writable, ...writableOwn, ...(harness === "claude" && projectDir ? [projectDir] : [])],
      denyWrite: [...(clone ? [...gitGuards(clone), ...harnessConfigPaths(clone)] : []), ...readOnly, ...SHARED_TMP, ...guards, ...install],
    },
    allowNestedUserNamespaces: true,
    // Copilot: bubblewrap with /dev/net/tun for its sandbox's network (bwrapTunScript); srt runs it on the host.
    ...(bwrapPath ? { bwrapPath } : {}),
  };
}

/**
 * The local harness flags, from FACTORY_LOCAL_SANDBOX ({addDirs, domains, clone}) in the child env; null on
 * Actions. A local child without them refuses: it must never fall back to a runner's skipped permissions.
 */
export function localSandbox(env = {}) {
  if (!env.FACTORY_LOCAL_SANDBOX) {
    if (env.FACTORY_LOCAL === "1") throw new Error("local mode without its sandbox settings (FACTORY_LOCAL_SANDBOX); refusing to run the harness unsandboxed");
    return null;
  }
  const s = JSON.parse(env.FACTORY_LOCAL_SANDBOX);
  // Sandboxed code can rename or replace a directory it may write the parent of; a writable path that now resolves
  // elsewhere (a symlink to the home directory) would open that place to the next sandbox. Factory made each one real.
  for (const d of [s.clone, ...(s.addDirs || []), ...(s.readDirs || [])].filter(Boolean)) {
    let real = null;
    try {
      real = realpathSync(d);
    } catch {
      // gone: the sandbox fails on it by itself
    }
    if (real !== null && real !== d) throw new Error(`local sandbox directory ${d} now resolves to ${real}; refusing to run`);
  }
  return { gitId: s.gitId || null, gitPin: s.gitPin || null, gitBin: s.gitBin || null, bwrapBin: s.bwrapBin || null, addDirs: s.addDirs || [], cacheDirs: s.cacheDirs || [], readDirs: s.readDirs || [], domains: s.domains || LOCAL_DOMAINS, clone: s.clone || null, readOnly: s.readOnly || [], claudeDir: s.claudeDir || null };
}

/**
 * The env a local child starts from: an allow-list, not the developer's whole shell, so AWS_*, NPM_TOKEN
 * and the like never reach the harness. `extra` names more variables the adopter's commands need
 * (FACTORY_LOCAL_ENV, such as DATABASE_URL); Factory's own service keys (inputs.mjs FACTORY_SECRET_KEYS) are never
 * among them, since the workflow file that can name them is repository content. Nor is a worker secret's NAME or SOURCE
 * (`workerSecrets`, the worker_secrets setting): that reaches the work stage's harness alone (lib/worker-secrets.mjs),
 * never every stage's every command; doctor warns when FACTORY_LOCAL_ENV names one.
 */
export function localBaseEnv(env = process.env, extra = [], { workerSecrets = "" } = {}) {
  const keep = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_[A-Z]+|TERM|COLORTERM|TMPDIR|TZ|XDG_[A-Z_]+|HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS|MISE_[A-Z_]+|NVM_DIR|VOLTA_HOME|PNPM_HOME|COREPACK_HOME|BUN_INSTALL|CARGO_HOME|RUSTUP_HOME|GOPATH|GOROOT|JAVA_HOME|CLAUDE_CONFIG_DIR|CODEX_HOME)$/;
  const worker = new Set(parseWorkerSecrets(workerSecrets).entries.flatMap((e) => [e.name, e.source]));
  const wanted = new Set(extra.filter((k) => !isFactorySecret(k) && !worker.has(k)));
  const out = {};
  for (const [k, v] of Object.entries(env)) if (keep.test(k) || wanted.has(k)) out[k] = v;
  // Tool telemetry would only hit the sandbox's network allow-list (a Codex sandbox reports each refusal as an error).
  return { TURBO_TELEMETRY_DISABLED: "1", NEXT_TELEMETRY_DISABLED: "1", DO_NOT_TRACK: "1", ...out };
}

/** One YAML scalar from a `KEY: value` line: quoted values unquoted (double quotes JSON-decoded), comments outside quotes dropped. */
export function yamlScalar(raw) {
  const s = raw.trim();
  if (s.startsWith('"')) {
    const m = /^("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/.exec(s);
    if (!m) return null;
    try {
      return JSON.parse(m[1]);
    } catch {
      return null;
    }
  }
  if (s.startsWith("'")) {
    const m = /^'((?:[^']|'')*)'\s*(?:#.*)?$/.exec(s);
    return m ? m[1].replace(/''/g, "'") : null;
  }
  return s.replace(/\s+#.*$/, "").trim();
}

/**
 * The adopter workflow's top-level `env:` block, so a local run uses the repository's own
 * configuration. Only FACTORY_* keys at two-space indent are read; a value that is an Actions
 * expression (`${{ ... }}`) has no meaning off a runner and is left out.
 */
export function workflowEnv(text) {
  const out = {};
  let inEnv = false;
  for (const raw of text.split("\n")) {
    if (/^env:\s*$/.test(raw)) {
      inEnv = true;
      continue;
    }
    if (!inEnv) continue;
    if (/^\S/.test(raw)) break;
    const m = /^ {2}(FACTORY_[A-Z0-9_]+):\s*(.*)$/.exec(raw);
    if (!m) continue;
    const v = yamlScalar(m[2]);
    if (v === null || v.includes("${{")) continue;
    out[m[1]] = v;
  }
  return out;
}

export function readWorkflowEnv(dir) {
  const file = join(dir, ".github", "workflows", "factory.yml");
  return existsSync(file) ? workflowEnv(readFileSync(file, "utf8")) : {};
}

/**
 * Why serve holds an Objective whose stage here returned `result` (#2667): a Question or a Block waits for a human, so
 * no tick re-claims it on a read from before its exit labels landed. Null for any other end.
 */
export function stopHold(result) {
  if (result?.exit === "question") return "its stage here ended with a Question; waiting for an answer";
  if (result?.exit === "blocked") return "its stage here Blocked; waiting for a human";
  return null;
}
