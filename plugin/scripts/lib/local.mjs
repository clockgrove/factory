// Local mode: Pendulum on a developer's own box. The claim that keeps the Actions path and a
// local loop off each other's Objectives, the sandbox the harness and Pendulum's own shell
// commands run in, the env a child may see, and the adopter's workflow env block read as the
// local configuration. GitHub stays the only state.
import { appendFileSync, chmodSync, closeSync, constants as fsConstants, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { homedir, platform as osPlatform, uptime } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { dropOwned, ownedTemp, sweepOwned } from "./fsafe.mjs";
import { addLabels, listComments, primeSelf, primeWriters, prComment, rest, upsertComment } from "./github.mjs";
import { isSelf, knownWriter, marker, pinnedMaintainer, selfLogin, trustedAuthor } from "./logic.mjs";
import { PENDULUM_CONTROL_KEYS, commandFailed, isPendulumSecret } from "./inputs.mjs";
import { parseWorkerSecrets } from "./worker-secrets.mjs";
import { SKIP_SMUDGE_ENV } from "./lfs.mjs";
import { exec } from "./proc.mjs";
import { parseYaml } from "./yaml.mjs";
import { releasesDir } from "./release.mjs";
import { declaredLogins } from "./accounts.mjs";
import { holdsDir } from "./holds.mjs";

/** A claim whose heartbeat is older than this is stale: the box went away (asleep, off, or serve stopped). */
export const CLAIM_FRESH_MS = 15 * 60_000;
/**
 * A stale claim pauses its Objective this long, for the same machine's serve to resume it; past it, Blocked. The default
 * of the repository's claim_pause_hours (inputs.mjs resolveInputs `claimPauseMs`).
 */
export const CLAIM_PAUSE_MS = 24 * 60 * 60_000;
export const HEARTBEAT_MS = 2 * 60_000;
/** A heartbeat this far ahead of now is a forgery or a broken clock, never fresh. */
const CLAIM_SKEW_MS = 2 * 60_000;
export const claimMarker = (issue) => marker(issue, "local");

/**
 * Pendulum's own code on this machine that a serve may run (lib/release.mjs releasesDir): no sandbox may write it. Every
 * sandbox only writes where it is told to, so this is already out of reach; it is named in each one's write denials too,
 * so a later widening of what a sandbox may write cannot take it in. Named only when it is there: a sandbox cannot bind
 * a path that does not exist, and none can create it (none may write ~/.cache/pendulum).
 */
export const pendulumCodeDirs = (home = homedir()) => [releasesDir(home)].filter((d) => existsSync(d));

/** The routing label: an Objective carrying it belongs to a developer's local loop, and the Actions path leaves it alone. */
export const LOCAL_LABEL = "pendulum:local";
const issueTimeline = (repo, n, opts) => rest(`repos/${repo.full}/issues/${n}/timeline?per_page=100`, { ...opts, paginate: true });
/** The marker of Pendulum's mark of the `labeled pendulum:local` event `id` on issue `n` (localRouteEvent, markLocalRoute). */
export const localRouteMarker = (n, id) => marker(n, "local-route", String(id));

/**
 * The `labeled pendulum:local` event that put the label on an issue as it is now, from its timeline `events`: the last
 * such event with no `unlabeled pendulum:local` after it, as {id, mine} (`mine`: Pendulum's own login, selfLogin, made it;
 * `id` null when the event carries none). Null when the timeline shows no such label on.
 */
export function localRouteEvent(events) {
  let current = null;
  for (const e of events || []) {
    if (e?.label?.name !== LOCAL_LABEL) continue;
    if (e.event === "labeled") current = e;
    else if (e.event === "unlabeled") current = null;
  }
  return current ? { id: /^\d+$/.test(String(current.id ?? "")) ? String(current.id) : null, mine: isSelf({ user: current.actor }) } : null;
}

/**
 * Pendulum's mark of the pendulum:local label a local loop put on Objective `n` (#455): one comment whose marker names
 * that exact label event (localRouteMarker), which the scorer reads (bench/lib/objective.mjs localPendulumActions) so the
 * label counts as Pendulum's, not a person's. The event is read from the issue's timeline (localRouteEvent), by Pendulum's
 * own login (read once if unknown; unreadable, no mark). `check`: read the comments first and write nothing when this
 * login's mark of that event is there (a later tick's backfill). Never throws: {id, marked, why, person}, `marked` true
 * when the mark is written or already there, false with the cause otherwise (no such event yet, a failed read or write);
 * `person` when the label on now is another login's, which no mark may claim.
 */
export async function markLocalRoute(repo, n, opts, { check = false, timeline = issueTimeline } = {}) {
  if (!selfLogin()) await primeSelf(opts).catch(() => null);
  if (!selfLogin()) return { id: null, marked: false, why: "Pendulum's own login could not be read" };
  const events = await timeline(repo, n, opts).catch((e) => ({ failed: e }));
  if (events?.failed) return { id: null, marked: false, why: `the timeline could not be read (${String(events.failed?.message || events.failed).slice(0, 120)})` };
  const ev = localRouteEvent(events);
  if (ev && !ev.mine) return { id: null, marked: false, why: "a person put the pendulum:local label on", person: true };
  if (!ev?.id) return { id: null, marked: false, why: "the timeline does not show this login's pendulum:local label event yet" };
  const id = ev.id;
  const mark = localRouteMarker(n, id);
  if (check) {
    const comments = await listComments(repo, n, opts).catch(() => null);
    if (!comments) return { id, marked: false, why: "the comments could not be read" };
    if (comments.some((c) => isSelf(c) && String(c.body || "").startsWith(mark))) return { id, marked: true, why: null };
  }
  return prComment(repo, n, `${mark}\nPendulum: no Action runs Objectives in this repository, so a local loop took this Objective and labelled it \`${LOCAL_LABEL}\`; it stays that machine's.`, opts).then(
    () => ({ id, marked: true, why: null }),
    (e) => ({ id, marked: false, why: `the mark could not be posted (${String(e?.message || e).slice(0, 120)})` }),
  );
}

/**
 * Labels Objective `n` pendulum:local for a local loop where no Action runs (#455), then marks that label event as
 * Pendulum's (markLocalRoute). Throws only when the label write fails; a mark that could not be written is {marked: false,
 * why}, for a later tick to write (Local.backfillMark).
 */
export async function adoptLocal(repo, n, opts, { timeline = issueTimeline } = {}) {
  await addLabels(repo, n, [LOCAL_LABEL], opts);
  return markLocalRoute(repo, n, opts, { timeline });
}

export const hasLocalLabel = (issue) => (issue?.labels || []).some((l) => (typeof l === "string" ? l : l.name) === LOCAL_LABEL);

/** True when this process is the local backend (pendulum run / serve set it). */
export const isLocal = (env = process.env) => env.PENDULUM_LOCAL === "1";


/** The claim comment Pendulum writes, read back by structure: which loop holds it and its last heartbeat. */
export const claimBody = (holder, at = new Date()) => `Running in local mode (${holder}).\nholder: ${holder}\nheartbeat: ${at.toISOString()}`;

/**
 * A claim body read by structure. Its age is GitHub's `updatedAt` for the comment when given (a heartbeat rewrites
 * it), so a machine whose clock is off never reads as stale or fresh by its own clock; else the heartbeat line.
 */
export function parseClaim(body, now = Date.now(), updatedAt = null) {
  const written = /^heartbeat: (\S+)$/m.exec(body || "")?.[1];
  if (Number.isNaN(written ? Date.parse(written) : NaN)) return null;
  const at = updatedAt && !Number.isNaN(Date.parse(updatedAt)) ? updatedAt : written;
  const t = Date.parse(at);
  const holder = /^holder: (\S+)$/m.exec(body)?.[1] ?? null;
  // GitHub's own time cannot be forged; one a little ahead of this reader's clock is this reader's skew.
  const ahead = at === updatedAt ? false : t - now >= CLAIM_SKEW_MS;
  return { holder, heartbeat: at, fresh: now - t < CLAIM_FRESH_MS && !ahead };
}

/**
 * A claim that could not be read or verified this time: no answer, never "no claim" (it only delays a Block). `marked`:
 * a marked comment was seen and only its author could not be checked (else the comments read failed). `updatedAt`:
 * GitHub's last update of the newest such comment by Pendulum's own login or by a person GitHub shows with push access
 * (an outsider's look-alike never delays a Block), or null.
 */
export class ClaimUnread extends Error {
  constructor(message, { cause = null, marked = false, updatedAt = null } = {}) {
    super(message);
    this.code = "claim-unread";
    this.cause = cause;
    this.marked = marked;
    this.updatedAt = updatedAt;
  }
}

/**
 * The issue's local claim, or null; `fresh` says whether its loop is alive. A local loop writes it as its developer, so
 * only Pendulum's own login or a person whose push access is known (the writer list, a pinned maintainer) counts, never
 * an author association, and only with the marker on the comment's first line. Throws ClaimUnread when the comments
 * cannot be read, or when a marked comment's author cannot be checked because the writer list or Pendulum's own login
 * is unknown: as the live-job listing (github.mjs activeWorkIssues), no read is ever taken for "none".
 */
export async function localClaim(repo, issue, opts, now = Date.now()) {
  const mark = claimMarker(issue);
  const writersKnown = await primeWriters(repo, opts);
  const verified = (x) => isSelf(x) || knownWriter(x?.user?.login) === true || pinnedMaintainer(x?.user);
  let comments;
  try {
    comments = await listComments(repo, issue, opts);
  } catch (e) {
    throw new ClaimUnread(`#${issue}'s comments could not be read (${e.status || String(e.message).slice(0, 80)})`, { cause: e });
  }
  const marked = comments.filter((x) => (x.body || "").startsWith(mark) && x?.user?.type !== "Bot");
  const c = marked.find(verified);
  if (!c) {
    if (marked.length && (!writersKnown || !selfLogin())) {
      const updatedAt = marked.filter(trustedAuthor).map((x) => x.updated_at).filter((t) => !Number.isNaN(Date.parse(t))).sort().at(-1) ?? null;
      throw new ClaimUnread(`#${issue}'s claim author could not be checked (the writer list or Pendulum's own login is unread)`, { marked: true, updatedAt });
    }
    return null;
  }
  const parsed = parseClaim(c.body, now, c.updated_at);
  return parsed ? { ...parsed, commentId: c.id } : null;
}

export const writeClaim = (repo, issue, holder, opts) => upsertComment(repo, issue, claimMarker(issue), claimBody(holder), opts);

/** A heartbeat on the claim comment `commentId` this loop holds (localClaim read it): the same text writeClaim writes. */
export const beatClaim = (repo, issue, commentId, holder, opts) => rest(`repos/${repo.full}/issues/comments/${commentId}`, { ...opts, method: "PATCH", body: { body: `${claimMarker(issue)}\n${claimBody(holder)}` } });

/** Drop the claim only when this loop holds it: another loop's claim is not ours to clear. */
export async function dropClaim(repo, issue, holder, opts) {
  const c = await localClaim(repo, issue, opts).catch(() => null);
  if (c && c.holder === holder) await rest(`repos/${repo.full}/issues/comments/${c.commentId}`, { ...opts, method: "DELETE" }).catch(() => {});
}

/** ~/.config/pendulum: the literal path every sandbox denies, where local mode's key files sit. */
export const pendulumKeyDir = (home = homedir()) => join(home, ".config", "pendulum");

// The product's previous name (clockgrove/pendulum#465), kept only to refuse its key folder (previousKeyDirProblem).
export const PREVIOUS_NAME = "factory";

/**
 * Why local mode cannot start, or null: the key folder under the previous name, ~/.config/<previous>, is still there.
 * No sandbox denies it, so the App key, the AI Gateway key and the tokens a copy left in it are readable by every stage.
 * serve, run and doctor refuse until it is moved to ~/.config/pendulum (moved, not copied). lstat: a link counts.
 */
export function previousKeyDirProblem(home = homedir()) {
  const old = join(home, ".config", PREVIOUS_NAME);
  if (!lstatSync(old, { throwIfNoEntry: false })) return null;
  return `${old} exists and no sandbox denies it, so any key or token in it is readable by every stage; move it, never copy it: mv ${old} ${pendulumKeyDir(home)} (with ${pendulumKeyDir(home)} already there, move each file across, then remove ${old})`;
}

/** The AI Gateway key's file in local mode (the decision calls, decider.mjs deciderKeyState). */
export const gatewayKeyFile = (home = homedir()) => join(pendulumKeyDir(home), "ai-gateway-key");

/**
 * The `harness` home, or any harness login folder on the machine (harnessLogins: a stage may run on any of them), that
 * equals or holds ~/.config/pendulum, or null. The outer sandbox leaves the harness's own homes readable (#2551), so such
 * a home would expose every key file there: the App's key (localApp) and the AI Gateway key (decider.mjs
 * deciderKeyState, and serve's start).
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
  const literal = pendulumKeyDir(home);
  const holds = (h) => literal === h || literal.startsWith(`${h}/`);
  return [...harnessHomes(harness, env, home), ...harnessLogins(home, env).map((l) => l.dir)].find((h) => holds(h) || holds(real(h))) || null;
}

/**
 * Why serve cannot start with the AI Gateway key file in place, or null: a `harness` home that holds ~/.config/pendulum
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
  return exposed ? `${file}: ${pendulumKeyDir(home)} is inside the ${harness} harness's home ${exposed}, which its sandbox can read; point that home elsewhere` : null;
}

/**
 * The Pendulum App local notices post with (#2522), from PENDULUM_LOCAL_APP_ID and PENDULUM_LOCAL_APP_KEY (the path of its
 * private key). The key must sit under ~/.config/pendulum, which every sandbox denies by that literal path, so no stage
 * can read it: the check is on the key's real path, and ~/.config/pendulum must be no symlink itself, since a deny list
 * names the literal path. A second hard link would be a path to the key outside it, so one is refused, and so are
 * group or world permission bits, and so is a `harness` home (readable in the outer sandbox) that holds
 * ~/.config/pendulum. Returns {app: {id, key}}, {app: null} when neither is set, or {problem}. The key's text is never
 * in a message.
 */
export function localApp(env = process.env, home = homedir(), harness = null) {
  const id = String(env.PENDULUM_LOCAL_APP_ID || "").trim();
  const path = String(env.PENDULUM_LOCAL_APP_KEY || "").trim().replace(/^~(?=\/)/, home);
  if (!id && !path) return { app: null };
  if (!/^\d+$/.test(id) || !path) return { problem: "set both PENDULUM_LOCAL_APP_ID (the Pendulum App's numeric id) and PENDULUM_LOCAL_APP_KEY (the path of its private key), or neither" };
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return null;
    }
  };
  const key = real(path);
  if (!key) return { problem: `PENDULUM_LOCAL_APP_KEY: no file at ${path}` };
  const literal = pendulumKeyDir(home);
  const root = real(literal);
  if (root !== literal) return { problem: `PENDULUM_LOCAL_APP_KEY: ${literal} must be a real directory, not a symlink (it resolves to ${root || "nothing"}): the sandboxes deny that literal path` };
  if (!key.startsWith(`${root}/`)) return { problem: `PENDULUM_LOCAL_APP_KEY: the App's private key must sit under ${literal}, which no sandbox can read (it is at ${key}); move it there, don't copy it` };
  const exposed = keyDirExposedBy(harness, env, home);
  if (exposed) return { problem: `PENDULUM_LOCAL_APP_KEY: ${literal} is inside the ${harness} harness's home ${exposed}, which its sandbox can read; point that home elsewhere` };
  const st = statSync(key);
  if (!st.isFile()) return { problem: `PENDULUM_LOCAL_APP_KEY: ${key} is not a file` };
  if (st.nlink > 1) return { problem: `PENDULUM_LOCAL_APP_KEY: ${key} has ${st.nlink} hard links, so it is reachable outside ${literal}; keep one copy (move it, don't link it)` };
  if (st.mode & 0o077) return { problem: `PENDULUM_LOCAL_APP_KEY: ${key} is readable or writable by others (mode ${(st.mode & 0o777).toString(8)}); chmod 600 ${key}` };
  return { app: { id, key: readFileSync(key, "utf8") } };
}

/**
 * The paths srt write-protects in the working directory on its own (its DANGEROUS_FILES and dangerous directories,
 * sandbox-runtime 0.0.81). Where one is absent, srt mounts /dev/null in its place for the command, which a repository
 * check that walks the tree cannot open (nodev: EACCES) or reads as a file where it expects a directory. Pendulum
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
 * a hook there that the next harness start runs outside every sandbox, so no sandbox may write them (Pendulum's own git
 * profile, which writes the plugin's skills and agents, excepted), and Pendulum makes each absent directory empty first,
 * as with SRT_PROTECTED. A local harness loads none of the executable ones from the clone anyway (harness.mjs).
 */
export const HARNESS_CONFIG = { dirs: [".claude", ".codex", ".agents", ".github/hooks", ".github/copilot", ".github/agents", ".github/skills"], files: [".mcp.json", ".gitmodules"] };
export const harnessConfigPaths = (clone) => [...HARNESS_CONFIG.dirs, ...HARNESS_CONFIG.files].map((p) => join(clone, p));

/**
 * The harness configuration that can run code on the host (hooks, settings with helpers, MCP servers) and that Pendulum
 * never writes: before every local harness start, a tracked one is restored from HEAD and anything else there removed
 * (clearHarnessConfig), so nothing planted earlier survives into the start. `.mcp.json` is not here: srt keeps it
 * unwritable in every profile, Pendulum's git work included.
 */
export const HARNESS_EXEC_CONFIG = [".claude/settings.json", ".claude/settings.local.json", ".claude/hooks", ".codex/config.toml", ".codex/hooks.json", ".github/hooks", ".github/copilot"];

/**
 * Git settings for every local harness process, highest precedence: each harness CLI runs `git status` or `git diff` on
 * the host in the clone as it starts, and a submodule's config (in .git/modules, which sandboxed code can write) would
 * otherwise be read by a `git status` run inside it. No fsmonitor command, and submodules are never entered.
 */
export const HARNESS_GIT_ENV = harnessGitEnv();

/**
 * What in a git directory can point git at another one, beside `commondir`, which Pendulum keeps as `.` (the clone's own
 * .git) and read-only in every sandbox (gitGuards), since a harness CLI also runs git on the host between tool calls, whose config (filters, an fsmonitor command) the harness CLI's
 * own `git status` or `git diff` on the host would then run: removed from the clone's .git before every harness start.
 */
export const GIT_REPOINT = ["gitdir", "config.worktree", "worktrees"];

/**
 * The clone's .git as Pendulum cloned it: its inode and birth time, kept in the Objective's .sandbox directory (no sandbox
 * reaches it) when Pendulum makes the clone, and never read again from the clone itself. A command in a sandbox that lets
 * it rename .git (Copilot's did) could otherwise put a .git of its own in place, whose config every later harness
 * start, and its own git on the host, would trust. Each stage and each harness start refuses when .git is not it.
 * The device number is not part of it: it is not stable across a restart (a WSL2 distro's disk is /dev/sd<x> in the
 * order disks attach; tmpfs and 9p mounts get a fresh one per mount). Instead .git must be on the filesystem the pin file
 * is on, which the clone beside it moves with. The birth time (0 where the filesystem keeps none) tells a new directory
 * that got a freed inode back from the one Pendulum cloned.
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
/** The inode alone, as Pendulum's git guard (gitGuardScript) compares it with `ls -di`. */
export const pinnedInode = (id) => String(id || "").split(":")[0] || "unpinned";
/** Why the clone's .git is not the pinned one ("" when it is). `pinFile`: .git must be on the filesystem it is on. */
export function gitDirChanged(clone, id, pinFile = null) {
  if (!id) return `${clone} has no pinned .git identity`;
  const st = lstatSync(join(clone, ".git"), { throwIfNoEntry: false, bigint: true });
  if (!st || !st.isDirectory()) return `${clone}/.git is not a directory any more`;
  const [ino, born] = id.split(":");
  if (String(st.ino) !== ino || (born !== "0" && String(st.birthtimeNs) !== born)) return `${clone}/.git is not the directory Pendulum cloned (it was replaced)`;
  if (pinFile) {
    const p = lstatSync(pinFile, { throwIfNoEntry: false, bigint: true });
    if (!p || p.dev !== st.dev) return `${clone}/.git is not on the filesystem of the Objective's directory`;
  }
  return "";
}
/** The Blocked reason a stage posts when the clone's .git is not the one Pendulum cloned: fixed text, no local path. */
export const gitIdentityReason = (issue) => `local mode: the clone's .git is not the directory Pendulum cloned (git-identity); remove .pendulum/${issue} in the local clone to start the Objective afresh`;
/** The rule Copilot's runner probe names when a command does not find or run the stage's toolchain (copilot-runner.mjs probeDriver). */
export const TOOLCHAIN_RULE = "the stage's toolchain does not run in a command";
/**
 * The Blocked reason for a harness start Pendulum refused (GitRefusal): fixed text per code, no local path and no command
 * output (both go to the stage log).
 */
export const gitRefusalReason = (code, issue, { path = null, rule = null, harness = "codex", local = false } = {}) =>
  code === "git-identity"
    ? gitIdentityReason(issue)
    : code === "git-state"
      ? "local mode: the clone's .git config, hooks, commondir or info/attributes changed during the stage (git-state); the harness was not started"
      : code === "roots"
        ? `${path ? `\`${path}\`, a directory the harness's sandbox lets commands write,` : "A directory the harness's sandbox lets commands write"} is a link, or has one on its path, that Pendulum cannot replace (roots); the harness was not started. Something the repository's setup, install or validation ran made it: stop it making that link, then re-apply \`pendulum:objective\``
      : code === "sandbox"
        ? path
          ? `Codex's sandbox cannot protect the checkout's \`${path}\`, a link to nothing (sandbox); the harness was not started. Remove the link from the branch, or point it at a path that exists`
          : rule === TOOLCHAIN_RULE
            ? `${harness === "claude" ? "Claude Code" : "Copilot"}'s sandbox started but its commands do not find or cannot run the stage's toolchain (node on the stage's PATH, the npm beside it, the repository's pnpm or yarn) (sandbox); the harness was not started. ${local ? "The stage log on the local machine" : "The work job's log"} names the node`
            : rule
            ? `${harness === "copilot" ? "Copilot" : harness === "claude" ? "Claude Code" : "Codex"}'s sandbox started but does not confine here (${rule}) (sandbox); the harness was not started, so no command ran unconfined. ${local ? "The stage log on the local machine" : "The work job's log"} has the probe's output`
            : local
              ? `${harness === "claude" ? "Claude Code" : "Copilot"}'s sandbox could not start in local mode (sandbox); the harness was not started, so no command ran unsandboxed. The stage log on the local machine has the probe's output`
              : harness === "copilot"
                ? "Copilot's sandbox could not start on this runner (sandbox); the harness was not started, so no command ran unsandboxed. The doctor lines at the top of the work job's log (copilot sandbox: bwrap, slirp4netns, apparmor, start) name what is missing"
                : "Codex's sandbox could not start on this runner (sandbox); the harness was not started, so no command ran unsandboxed. The doctor lines at the top of the work job's log (codex sandbox: bwrap, apparmor, start) name what is missing"
        : code === "relay"
          ? `the gateway relay's forwarder did not come up in ${harness === "copilot" ? "Copilot" : harness === "claude" ? "Claude Code" : "Codex"}'s sandbox (relay); the harness was not started, and the key was never handed over. ${local ? "The stage log on the local machine" : "The work job's log"} has the probe's output`
          : "Pendulum's pre-start check of the checkout's git directory failed (git-clear); the harness was not started";
/**
 * The Blocked comment's marker id for a git-identity Block: the same for every repeat on one clone (a stage that keeps
 * finding it updates its comment rather than adding one), a new one for a fresh clone. The pin is hashed: no inode on GitHub.
 */
export const gitIdentityKey = (stage, id) => `git-identity:${stage}:${createHash("sha256").update(String(id || "none")).digest("hex").slice(0, 12)}`;
/** A harness start Pendulum refused (beforeHarness, a runner's pre-start clear, the relay probe): `code` is git-identity, git-state, git-clear, roots, sandbox or relay; the stage Blocks (gitRefusalReason). */
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
 * share a comment), or null for any other error. `env` is the stage's (its PENDULUM_LOCAL_SANDBOX names the pinned .git).
 */
export function refusalExit(e, { stage, issue, env = process.env }) {
  if (!(e instanceof GitRefusal)) return null;
  let id = null;
  try {
    id = JSON.parse(env.PENDULUM_LOCAL_SANDBOX || "{}").gitId || null;
  } catch {
    // no pin to name: one key for the stage
  }
  return { reason: gitRefusalReason(e.code, issue, { path: e.path, rule: e.rule, local: !!e.local, ...(e.harness ? { harness: e.harness } : {}) }), ...(e.code === "git-identity" ? { key: gitIdentityKey(stage, id) } : {}) };
}

/**
 * The git state Pendulum set up for a stage (after its own git work: identity, credential helpers, Git LFS), hashed:
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
  return gitStateHash(clone) === want ? "" : `${clone}/.git's config, hooks, commondir or info/attributes changed since Pendulum set them up`;
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
    if (add.length) appendFileSync(exclude, `${have.length && have.at(-1) !== "" ? "\n" : ""}# Pendulum: srt's protected paths, made empty so the sandbox protects a real path\n${add.join("\n")}\n`);
  }
  return made;
}

// The same, run inside the clone's own sandbox (backend.mjs sandbox.git), so Pendulum's process writes nothing in the
// clone between stages, where the agent may have planted a symlink. CommonJS for `node -e`: argv is the clone, "1" to
// clear first ("fresh" at a stage's start: see below), the stale git locks to remove as JSON (prepareClone), then more
// directories to make (the package caches that live in the clone). Always: .git/commondir is
// `.`, the clone's own .git, and .git/info/attributes exists (made empty where absent). Clearing, before a harness
// starts: the git directory back to the clone's own (GIT_REPOINT removed, gitlinks HEAD lacks dropped, no submodule
// checked out: each gitlink's .git and .git/modules removed, then checked: exit 3 when git would still read another
// directory), HARNESS_EXEC_CONFIG back to HEAD (a tracked file restored, anything else removed, never followed through a
// symlink), and the submodule names .gitmodules gives printed as JSON for the harness's git env. Fresh, at a stage's
// start: the untracked files an earlier stage or run left in this reused clone (never pushed) removed, best effort
// ("fresh-strict", a fresh work stage's: a removal that fails exits 4); ignored ones (dependencies, Pendulum's plugin) and the paths Pendulum makes here stay. Its changes to tracked files are
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
  // No submodule is checked out when a harness starts (Pendulum never initialises one): a git that entered it would read
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
if ((clear === "fresh" || clear === "fresh-strict") && gst && gst.isDirectory()) {
  const keep = [...P.dirs, ...H.dirs, ...P.files, ...H.files].flatMap((p) => ["-e", "/" + p]);
  try { cp.execFileSync("git", ["-C", clone, "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "clean", "-q", "-f", "-d", ...keep], { stdio: ["ignore", "ignore", "pipe"] }); }
  catch (e) {
    process.stderr.write("warning: the clone's leftovers could not all be removed: " + String(e.stderr || e.message).trim().split("\n")[0].slice(0, 200) + "\n");
    if (clear === "fresh-strict") process.exit(4);
  }
}
for (const d of [...P.dirs, ...H.dirs].map((d) => path.join(clone, d)).concat(dirs)) { try { fs.mkdirSync(d, { recursive: true }); } catch {} }
const made = [];
for (const f of P.files) { try { fs.writeFileSync(path.join(clone, f), f === ".mcp.json" ? '{"mcpServers":{}}\n' : "", { flag: "wx" }); made.push(f); } catch {} }
if (made.length) {
  const ex = path.join(clone, ".git", "info", "exclude");
  fs.mkdirSync(path.dirname(ex), { recursive: true });
  const have = fs.existsSync(ex) ? fs.readFileSync(ex, "utf8").split("\n") : [];
  const add = made.map((f) => "/" + f).filter((l) => !have.includes(l));
  if (add.length) fs.appendFileSync(ex, (have.length && have.at(-1) !== "" ? "\n" : "") + "# Pendulum: srt's protected paths, made empty so the sandbox protects a real path\n" + add.join("\n") + "\n");
}
process.stdout.write(JSON.stringify({ submodules: names, locks: removed }));
`;

/**
 * prepareProtectedPaths and the clone's package-cache directories, in the clone's own sandbox (`run` gives the command).
 * `locks`: the stale git locks to remove first (staleGitLocks), each re-checked there as a regular `.lock` file under
 * `.git` with no symlink on its path. Returns {submodules, locks}: the names .gitmodules gives and the locks removed.
 * A failure throws with the exit alone (commandFailed): the output's last line is in the log.
 */
export async function prepareClone(clone, dirs, run, { clear = false, fresh = false, strict = false, locks = [] } = {}) {
  const r = await run([process.execPath, "-e", PREPARE_CLONE, clone, clear ? "1" : fresh ? (strict ? "fresh-strict" : "fresh") : "0", JSON.stringify(locks), ...dirs]);
  // `strict` (a fresh work stage, worker.mjs): leftovers that could not all be removed are a failure, code clone-clean.
  // Its output can name a path on this machine (the clone, wherever it is): it goes to the log, never into the error.
  if (r.code === 4) throw commandFailed("the clone's leftovers could not all be removed", r, { code: "clone-clean", exitCode: 4 });
  if (r.code !== 0) throw commandFailed("the clone could not be prepared in its sandbox", r, { exitCode: r.code ?? r.signal ?? null });
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
 * into the repository it works on; Pendulum runs every git with `-C <clone>`). Without /proc (macOS) only the boot rule holds.
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
 * it is under the home. On macOS it is /private/tmp/pnd-<uid>: Claude Code keeps its sockets in
 * `$CLAUDE_CODE_TMPDIR/claude-<uid>`, and when that path is over 44 bytes its commands get the box-wide
 * /tmp/claude-<uid> as TMPDIR instead (on Linux they keep the stage's), and a macOS home path is too long for that.
 */
export const stageTmpBase = (home = homedir(), os = osPlatform()) => {
  if (os !== "darwin") {
    const dir = join(home, ".cache", "pendulum", "s");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    return dir;
  }
  const dir = `/private/tmp/pnd-${process.getuid()}`;
  mkdirSync(dir, { mode: 0o700, recursive: true });
  // Anyone may make a directory in /tmp: one this user does not own, or a link, is refused, not used.
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.uid !== process.getuid()) throw new Error(`${dir} is not a directory of this user's; remove it so local mode can make its own`);
  chmodSync(dir, 0o700);
  return dir;
};

/** The names Pendulum makes under stageTmpBase: a stage's temp directory (`<issue>-XXXXXX`), a probe's and a version check's. */
const STAGE_TMP_NAMES = /^(?:\d+|probe|version|decision)-[A-Za-z0-9]{6}$/;

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

/** srt's and Claude Code's own scratch directory, writable in every one of their sandboxes on the box; Pendulum points nothing there. */
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
export const CREDENTIAL_PATHS = [".ssh", ".aws", ".azure", ".config/gcloud", ".kube", ".docker", ".gnupg", ".netrc", ".npmrc", ".yarnrc", ".yarnrc.yml", ".pypirc", ".cargo/credentials", ".cargo/credentials.toml", ".git-credentials", ".config/gh", ".config/hub", ".claude/.credentials.json", ".claude.json", ".codex", ".copilot", ".config/github-copilot", ".vercel", ".local/share/com.vercel.cli", ".config/com.vercel.cli", ".config/pendulum"];

/** Claude Code's `.claude.json`: in CLAUDE_CONFIG_DIR when that is set, else in the home directory. */
export const claudeJson = (env = {}, home = homedir()) => join(env.CLAUDE_CONFIG_DIR || home, ".claude.json");

const isFolder = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
/** A path's real location, also for an absent file (its folder's real path): what a sandbox that follows links denies. */
export const realish = (p) => {
  try {
    return realpathSync(p);
  } catch {
    try {
      return join(realpathSync(dirname(p)), basename(p));
    } catch {
      return p;
    }
  }
};

/**
 * Every harness login on this machine's disk, as [{harness, dir, files, bearing, standard}]. `files`: its login (Claude
 * Code's `.credentials.json` and `.claude.json`, a Codex or Copilot home whole). `bearing`: what of it holds that login or
 * its traces, denied when the folder cannot go whole: Claude Code's login files with `.claude.json`'s backups
 * (`.claude.json.backup*`, `backups`) and its `sessions`; Codex's `auth.json*` and `sessions`; a Copilot home whole.
 * `standard` marks the default homes. Found by name and existence only (directory listings, lstat), never by reading a
 * file. It covers: the default homes (`~/.claude` with `~/.claude.json`, `~/.codex`, `~/.copilot`,
 * `~/.config/github-copilot`); every `~/.claude-*`, `~/.codex-*` and `~/.copilot-*` folder (a login made there during a
 * stage is hidden too, since the deny is in place before its file exists); and the folders CLAUDE_CONFIG_DIR, CODEX_HOME and COPILOT_HOME name in `env`.
 * That is enough for every login a stage can run on: a stage runs on the home directory and the CLAUDE_CONFIG_DIR or
 * CODEX_HOME of Pendulum's own environment (stageLogin), and Copilot's home is Pendulum's. A login kept elsewhere under
 * another name and named in no variable is out of its reach, and so is one the system keeps outside the disk (Claude
 * Code's on macOS is in the Keychain). The accounts this machine declares (accounts.mjs declaredLogins) are added, and
 * `declared` ([{harness, dir}]) adds more folders.
 */
export function harnessLogins(home = homedir(), env = process.env, { declared = [] } = {}) {
  const byDir = new Map();
  const add = (harness, dir, files, bearing, standard = false) => {
    const d = resolve(dir);
    const l = byDir.get(d) || { harness, dir: d, files: [], bearing: [], standard };
    l.files = [...new Set([...l.files, ...files(d)])];
    l.bearing = [...new Set([...l.bearing, ...l.files, ...bearing(d)])];
    l.standard ||= standard;
    byDir.set(d, l);
  };
  const list = (d) => {
    try {
      return readdirSync(d).sort();
    } catch {
      return [];
    }
  };
  const names = list(home);
  const folders = (prefix) => names.filter((n) => n.startsWith(prefix)).map((n) => join(home, n)).filter(isFolder);
  const named = (d, prefix) => list(d).filter((n) => n.startsWith(prefix)).map((n) => join(d, n));
  const claudeFiles = (d) => [join(d, ".credentials.json"), join(d, ".claude.json")];
  const claudeBearing = (d) => [...named(d, ".claude.json.backup"), join(d, "backups"), join(d, "sessions")];
  const codexBearing = (d) => [...new Set([join(d, "auth.json"), ...named(d, "auth.json")])].concat(join(d, "sessions"));
  const whole = (d) => [d];
  const none = () => [];
  // The default Claude Code login keeps its `.claude.json`, and that file's older backups, in the home directory itself.
  add("claude", join(home, ".claude"), (d) => [join(d, ".credentials.json"), join(home, ".claude.json")], (d) => [...named(home, ".claude.json.backup"), ...claudeBearing(d)], true);
  for (const d of folders(".claude-")) add("claude", d, claudeFiles, claudeBearing);
  if (env.CLAUDE_CONFIG_DIR) add("claude", env.CLAUDE_CONFIG_DIR, claudeFiles, claudeBearing);
  add("codex", join(home, ".codex"), whole, codexBearing, true);
  for (const d of folders(".codex-")) add("codex", d, whole, codexBearing);
  if (env.CODEX_HOME) add("codex", env.CODEX_HOME, whole, codexBearing);
  add("copilot", join(home, ".copilot"), whole, none, true);
  add("copilot", join(home, ".config", "github-copilot"), whole, none, true);
  for (const d of folders(".copilot-")) add("copilot", d, whole, none);
  if (env.COPILOT_HOME) add("copilot", env.COPILOT_HOME, whole, none);
  // The accounts this machine declares (accounts.mjs), and those the caller adds.
  for (const { harness, dir } of [...declaredLogins(home), ...declared]) if (dir && ![...byDir.values()].some((l) => l.harness === harness && sameDir(l.dir, dir))) add(harness, dir, harness === "claude" ? claudeFiles : whole, harness === "claude" ? claudeBearing : harness === "codex" ? codexBearing : none);
  // A Codex login denied file by file is still its `files` (the home) where nothing of it is shared: see credentialPaths.
  for (const l of byDir.values()) if (l.harness === "codex") l.bearing = l.bearing.filter((p) => p !== l.dir);
  return [...byDir.values()];
}

/**
 * The login folder a `harness` stage runs on ({harness, dir}), or null: CLAUDE_CONFIG_DIR, else `~/.claude`; CODEX_HOME,
 * else `~/.codex`; the stage's Copilot home, which Pendulum makes and which holds no login (its token is in its env).
 */
export function stageLogin(harness, env = {}, home = homedir()) {
  const dir = harness === "claude" ? env.CLAUDE_CONFIG_DIR || join(home, ".claude") : harness === "codex" ? env.CODEX_HOME || join(home, ".codex") : harness === "copilot" ? env.COPILOT_HOME || null : null;
  return dir ? { harness, dir: resolve(dir) } : null;
}

const sameDir = (a, b) => resolve(a) === resolve(b) || realish(a) === realish(b);
const within = (p, d) => p === d || p.startsWith(`${d}/`);

/** The links at the top of a folder, as [{link, real}] (lstat, then the real path they lead to). */
const topLinks = (dir) => {
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    // absent until its harness first runs
  }
  return names.map((n) => join(dir, n)).filter((p) => lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink()).map((link) => ({ link, real: realish(link) }));
};

/**
 * The credential stores no sandboxed command and no file tool may read, the one list every sandbox kind denies:
 * CREDENTIAL_PATHS under `home`, and every harness login on the machine (harnessLogins), decided on real paths. `own`
 * ({harness, dir}: the login the stage runs on, stageLogin): what of it bears the login (Claude Code's login files, their
 * backups and sessions; a Codex home), since its harness keeps other state there its commands use; only its own harness
 * process reads it (harnessOuterSettings). Another login folder goes whole, with what bears its login outside it (the
 * default `~/.claude.json`). Two keep their shared state: the default `~/.claude` when the stage is no Claude Code one, or
 * when a Claude Code stage's own folder links its entries to the same names there (a second account sharing the first's
 * settings, skills and projects); then what bears its login is denied. The default Codex and Copilot homes go whole, as
 * they always did. Each path is also denied where it really is, and a link at the top of the stage's own folder (which
 * its outer sandbox reads and writes) that leads to a denied path, or above one, is denied by that name too.
 * Serve makes it once per stage and hands it to the stage (PENDULUM_LOCAL_SANDBOX `credentials`) and to the harness's
 * outer sandbox, so each sandbox kind denies the same list.
 */
export function credentialPaths(home = homedir(), env = process.env, { own = null, declared = [] } = {}) {
  const out = CREDENTIAL_PATHS.map((p) => join(home, p));
  const mine = (l) => !!own && l.harness === own.harness && sameDir(l.dir, own.dir);
  const links = own ? topLinks(own.dir) : [];
  // The second-account layout: a top-level entry of the stage's own folder linking to the same name in the default folder.
  const def = join(home, ".claude");
  const sharesDefault = own?.harness === "claude" && links.some(({ link, real }) => real === realish(join(def, basename(link))));
  const whole = (l) => [l.dir, ...l.bearing.filter((p) => !within(p, l.dir))];
  for (const l of harnessLogins(home, env, { declared: [...declared, ...(own ? [own] : [])] })) {
    let paths;
    if (mine(l)) paths = l.harness === "claude" ? l.bearing : l.files;
    else if (l.harness === "claude" && l.standard) paths = own?.harness === "claude" && !sharesDefault ? whole(l) : l.bearing;
    else paths = l.standard ? l.files : whole(l);
    for (const p of paths) out.push(p, realish(p));
    // A login file that links elsewhere is denied where it really is.
    for (const f of l.files) out.push(realish(f));
  }
  const denied = [...new Set(out)];
  for (const { link, real } of links) {
    for (const d of denied) {
      if (within(real, d)) out.push(link);
      else if (d.startsWith(`${real}/`)) out.push(join(link, relative(real, d)));
    }
  }
  // One entry per tree: a path under another denied one adds nothing.
  const all = [...new Set(out)];
  return all.filter((p) => !all.some((q) => q !== p && p.startsWith(`${q}/`)));
}

/**
 * Codex's own sandbox, for each path in `paths`: the stage's own Codex home (`dir`) by what bears its login (`auth.json*`,
 * `sessions`), since Codex starts a helper kept there; a path holding the release Codex runs from (`release`,
 * codexRelease: its installer puts it in `~/.codex`, and its sandbox execs that binary) by everything in it but that
 * release (codexHomeBut); any other path whole.
 */
export const codexLoginFiles = (paths, dir, release = null) => [
  // A home and its real path give the same list once: the profile is a TOML table, which takes each key once.
  ...new Set(
    paths.flatMap((p) => {
      if (sameDir(p, dir)) return [join(p, "auth.json*"), join(p, "sessions")];
      const real = realish(p);
      const keep = release?.find((k) => k.startsWith(`${real}/`));
      return keep ? codexHomeBut(real, keep) : [p];
    }),
  ),
];

/**
 * Where the Codex binary `bin` runs from, by real path, as the folders that may be kept readable, widest first: its
 * release folder (above `bin/`), its own folder, the binary itself. Null when `bin` is not there.
 */
const codexRelease = (bin) => {
  let real;
  try {
    real = realpathSync(bin);
  } catch {
    return null;
  }
  const own = dirname(real);
  return [...(basename(own) === "bin" ? [dirname(own)] : []), own, real];
};

/**
 * For a Codex stage on another CODEX_HOME while Codex's installer tree is in `~/.codex`: the `codex` on `env`'s PATH when
 * it is a script (`#!`) outside `~/.codex`, as {bin, real}, else null. Codex's sandbox runs the release it execs, which
 * such a wrapper hides from codexLocalConfig, so `~/.codex` is denied whole there and the sandbox cannot start.
 */
export function codexWrapper(env = process.env, home = homedir()) {
  const def = join(home, ".codex");
  if (sameDir(stageLogin("codex", env, home).dir, def) || !existsSync(join(def, "packages"))) return null;
  const bin = whichPath("codex", env);
  const real = codexRelease(bin)?.at(-1);
  if (!real || within(real, realish(def))) return null;
  const head = Buffer.alloc(2);
  try {
    const fd = openSync(real, "r");
    try {
      readSync(fd, head, 0, 2, 0);
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  return head.toString() === "#!" ? { bin, real } : null;
}

/**
 * Everything in the folder `home` but the path down to `keep` (inside it): at each level the other entries, plus the names
 * Codex keeps in its home where absent (CODEX_HOME_NAMES), so one made during the stage is denied too. A link is denied
 * where it leads (linkTarget), not by its own name: Codex's sandbox cannot mount over a link and does not start. One that
 * leads into or above `keep` is left, and so is one whose target another entry already covers. Unlistable: `home` whole.
 * Each path goes out as Codex's profile reads it (codexDenyPath).
 */
function codexHomeBut(home, keep) {
  const out = [];
  const near = (p) => within(p, keep) || keep.startsWith(`${p}/`);
  try {
    for (let at = home; at !== keep; ) {
      const next = join(at, relative(at, keep).split("/")[0]);
      for (const name of readdirSync(at)) {
        const p = join(at, name);
        if (p === next) continue;
        if (!lstatSync(p).isSymbolicLink()) out.push(p);
        else if (!near(linkTarget(p))) out.push(linkTarget(p));
      }
      at = next;
    }
  } catch {
    return [codexDenyPath(home)];
  }
  const kept = [...new Set(out)].filter((p, _, all) => !all.some((q) => q !== p && p.startsWith(`${q}/`)));
  const listed = new Set(kept);
  const absent = CODEX_HOME_NAMES.map((n) => join(home, n)).filter((p) => !listed.has(p) && !lstatSync(p, { throwIfNoEntry: false }));
  return [...kept.map(codexDenyPath), ...absent];
}

/** Where the link `p` leads, by real path, also when it leads to nothing yet (realish of its target). */
const linkTarget = (p) => {
  try {
    return realpathSync(p);
  } catch {
    try {
      return realish(resolve(dirname(p), readlinkSync(p)));
    } catch {
      return p;
    }
  }
};

/**
 * A path as Codex's profile takes it literally. A path with `*`, `?` or `[` in it is a glob there (ripgrep's syntax), so
 * every glob character is escaped and a control character, which Codex never matches literally, becomes `?`; any other
 * path is literal as it is (an escape there would be part of the name).
 */
export const codexDenyPath = (p) => (/[*?[\x00-\x1f\x7f]/.test(p) ? p.replace(/[\\*?[\]{}]/g, "\\$&").replace(/[\x00-\x1f\x7f]/g, "?") : p);

/**
 * The login files a `harness` stage runs on: Claude Code's `.credentials.json` and `.claude.json` (CLAUDE_CONFIG_DIR's,
 * else the default ones), the Codex home, the stage's Copilot home.
 */
export function ownLogin(harness, env = {}, home = homedir()) {
  if (harness === "claude") return [join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), ".credentials.json"), claudeJson(env, home)];
  if (harness === "codex") return [env.CODEX_HOME || join(home, ".codex")];
  if (harness === "copilot") return env.COPILOT_HOME ? [env.COPILOT_HOME] : [];
  return [];
}

/** The real folders and login files of every login but the stage's own: no path of its own login may lead there. */
const otherLogins = (harness, env, home) => {
  const own = stageLogin(harness, env, home);
  const others = harnessLogins(home, env).filter((l) => !(own && l.harness === harness && sameDir(l.dir, own.dir)));
  return { dirs: others.map((l) => realish(l.dir)), files: others.flatMap((l) => l.files.map(realish)) };
};

/**
 * Each login file of the `harness` stage's own that really is another login's (a link from its folder into another login
 * folder, or to another login's file), as [{path, real}]. Its harness process would read that login: serve refuses the
 * stage and doctor --local warns, naming the path on this machine only.
 */
export function ownLoginProblems(harness, env = process.env, home = homedir()) {
  const { dirs, files } = otherLogins(harness, env, home);
  return ownLogin(harness, env, home).map((path) => ({ path, real: realish(path) })).filter(({ path, real }) => real !== resolve(path) && (files.includes(real) || dirs.some((d) => within(real, d))));
}

/**
 * The paths the `harness` stage's own process reads in its outer sandbox: what bears its own login (credentialPaths
 * `own`), by real path, never one that really is another login's (ownLoginProblems).
 */
const ownLoginTest = (harness, env, home) => {
  const own = stageLogin(harness, env, home);
  const l = own && harnessLogins(home, env, { declared: [own] }).find((x) => x.harness === harness && sameDir(x.dir, own.dir));
  const bad = new Set(ownLoginProblems(harness, env, home).map((p) => p.real));
  const set = new Set((l ? (harness === "claude" ? l.bearing : l.files) : []).map(realish).filter((p) => !bad.has(p)));
  return (p) => set.has(realish(p));
};

/**
 * The other harness login folders (harnessLogins) inside a home of the `harness` stage's own (harnessHomes), which its outer
 * sandbox can write and so rename: a deny by path there does not hold. [{path, home}]; doctor --local names each.
 */
export function loginsExposedBy(harness, env = process.env, home = homedir()) {
  const own = stageLogin(harness, env, home);
  if (!own) return [];
  const homes = harnessHomes(harness, env, home).filter((h) => !h.endsWith(".json")).flatMap((h) => [...new Set([resolve(h), realish(h)])]);
  const out = [];
  for (const l of harnessLogins(home, env)) {
    if (l.harness === harness && sameDir(l.dir, own.dir)) continue;
    const h = homes.find((d) => within(l.dir, d) || within(realish(l.dir), d));
    if (h) out.push({ path: l.dir, home: h });
  }
  return out;
}

/**
 * A clone's git internals Pendulum itself runs or reads (hooks, config, commondir, info/attributes, whose filters run in
 * Pendulum's own git): no sandboxed command and no edit may change them.
 */
export const gitGuards = (clone) => [join(clone, ".git", "hooks"), join(clone, ".git", "config"), join(clone, ".git", "commondir"), join(clone, ".git", "info", "attributes")];

/**
 * Linux: the ripgrep srt and Claude Code's sandbox run to find the names they write-protect below the working directory
 * (their `ripgrep` setting, #154). It runs the real one and leaves out the lines whose first protected name, as the
 * sandbox reads it, is a nested repository's .git (`.git`, exactly, below the top level), so a nested checkout's hooks and
 * config are not bound read-only and a resumed stage can remove and replace the checkout. Those binds guarded nothing:
 * they cover only a repository that exists when a command starts, and only one directly in the working directory, so a
 * command could always make a new one, hooks and all. Nothing outside a sandbox runs git in a nested repository
 * (Pendulum's git and every harness's run in the clone, with no fsmonitor and no submodule entered: harnessGitEnv), and
 * the clone's own git internals stay unwritable by gitGuards. Every other name the scan finds stays protected.
 * It fails closed: whenever ripgrep fails or the filter cannot finish (an error, a timeout's TERM), it prints ripgrep's
 * whole list unfiltered and exits non-zero, so the sandbox binds everything listed, nested .git included; a shortened
 * list never goes out. ripgrep's stderr passes through (srt denies the directories it could not read).
 */
// srt's names that end a path's search for its protected name (sandbox-runtime 0.0.81 linuxGetMandatoryDenyPaths),
// matched as it does: by path component, case-folded with toLowerCase.
const SCAN_DIR_NAMES = [".vscode", ".idea", ".claude/commands", ".claude/agents", ".git/hooks", ".git/config", ".git/HEAD"].map((n) => n.toLowerCase().split("/"));
/** Whether the scan leaves `line` out: below `root`, a plain path whose first protected name is `.git` below the top. */
export function nestedGitLine(line, root) {
  if (!line.startsWith(`${root}/`)) return false;
  const seg = line.slice(root.length + 1).split("/");
  if (seg.some((x) => x === "" || x === "." || x === "..")) return false;
  const lower = seg.map((x) => x.toLowerCase());
  for (let i = 0; i < seg.length; i++) for (const name of SCAN_DIR_NAMES) if (name.every((c, k) => lower[i + k] === c)) return i >= 1 && seg[i] === ".git";
  return false;
}
export const nestedGitScanScript = (realRg) => `"use strict";
// Pendulum: ripgrep for the sandboxes' scan of protected names (lib/local.mjs nestedGitScanScript). Fails closed: on any
// failure, ripgrep's whole list unfiltered and a non-zero exit, which the sandbox reads as a failed scan and still binds.
const { spawn } = require("child_process");
const { writeSync } = require("fs");
const { isAbsolute } = require("path");
const SCAN_DIR_NAMES = ${JSON.stringify(SCAN_DIR_NAMES)};
${nestedGitLine.toString()}
const args = process.argv.slice(2);
const root = args[args.length - 1] || "";
const chunks = [];
let over = false;
let said = false;
const put = (fd, text) => {
  const buf = Buffer.isBuffer(text) ? text : Buffer.from(text || "");
  for (let off = 0; off < buf.length; ) {
    try { off += writeSync(fd, buf, off); } catch (e) { if (e.code !== "EAGAIN") throw e; }
  }
};
const out = (text, code) => {
  if (over) return;
  over = true;
  try { put(1, text); } catch { code = 2; }
  process.exit(code);
};
const raw = () => Buffer.concat(chunks).toString("utf8");
// Node exits 1 on an uncaught error, which the sandbox would read as "none found": any error is a failed scan instead.
process.on("uncaughtException", () => out(raw(), 2));
// ripgrep in a process group of its own, so what it started goes with it; in this script's directory, which no sandbox
// may write, never the scanned one: a version manager's shim reads its tool versions from its working directory.
const child = spawn(${JSON.stringify(realRg)}, args, { cwd: isAbsolute(root) ? __dirname : undefined, stdio: ["ignore", "pipe", "pipe"], detached: true });
// Killed (the sandbox's scan timeout): ripgrep goes too, and the whole lines it gave so far go out unfiltered.
const stop = () => { try { process.kill(-child.pid, "SIGKILL"); } catch {} const t = raw(); out(t.slice(0, t.lastIndexOf("\\n") + 1), 2); };
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, stop);
child.stdout.on("data", (c) => chunks.push(c));
// ripgrep's stderr passes through (srt denies the directories it could not read); any of it makes a "none found" a failure.
child.stderr.on("data", (c) => { said = true; try { put(2, c); } catch {} });
child.on("error", () => out(raw(), 2));
child.on("close", (code) => {
  if (code === 1 && !said) return out("", 1);
  if (code !== 0) return out(raw(), 2);
  let kept;
  try {
    const t = raw();
    kept = t.split("\\n").filter((l, i, a) => (i === a.length - 1 ? l !== "" : true) && !nestedGitLine(l, root)).map((l) => l + "\\n").join("");
  } catch { return out(raw(), 2); }
  out(kept, 0);
});
`;

/**
 * The wrapper the sandboxes run: from the scan's own directory when the scanned one is absolute (as srt and Claude Code
 * give it), node on scan.cjs; the real ripgrep, unfiltered, when that node can no longer run (a version manager removed
 * it mid-stage), so every name stays protected.
 */
export const nestedGitScanWrapper = (dir, node, js, realRg) => `#!/bin/sh
# Pendulum: the sandboxes' scan (lib/local.mjs nestedGitScanScript), or the real ripgrep unfiltered when node cannot run.
for t do :; done
case "$t" in /*) cd ${shq(dir)} 2>/dev/null ;; esac
[ -x ${shq(node)} ] && [ -r ${shq(js)} ] && exec ${shq(node)} ${shq(js)} "$@"
exec ${shq(realRg)} "$@"
`;

/** A shell word for `x`: single-quoted. */
const shq = (x) => `'${String(x).replace(/'/g, "'\\''")}'`;
/** Whether `p` is one of `dirs` or lies under one, by path; no link followed. */
const under = (p, dirs) => dirs.some((d) => p === d || p.startsWith(`${d}/`));

/**
 * The `rg` a PATH lookup finds, as an absolute path whose links are not followed (a version manager's shim picks the tool
 * by the name it is called with): a relative PATH entry is taken from `cwd`. Null when none.
 */
export function ripgrepOnPath(env = process.env, cwd = process.cwd()) {
  for (const d of String(env.PATH || "").split(":").filter(Boolean)) {
    const p = resolve(cwd, d, "rg");
    const st = statSync(p, { throwIfNoEntry: false });
    if (st?.isFile() && st.mode & 0o111) return p;
  }
  return null;
}

/**
 * nestedGitScanScript and its wrapper written in `dir` (made owner-only), then the wrapper run once over a throwaway tree,
 * from a directory whose `.tool-versions` names a ripgrep that does not exist: the wrapper's path, for the `ripgrep`
 * setting of srt and Claude Code. `rg` is never resolved through its links, and is refused when it, or what it links
 * to, lies in one of `writable` (the clone and every directory a sandbox may write). Throws (code "sandbox-scan") unless
 * the scan returns a nested rc file and the top-level .git, and none of a nested repository's .git, exit 0.
 */
export function writeNestedGitScan(dir, rg = ripgrepOnPath(), { node = process.execPath, writable = [] } = {}) {
  const fail = (why) => Object.assign(new Error(`the sandbox's scan for protected paths does not work here: ${why}`), { code: "sandbox-scan" });
  if (!rg) throw fail("rg (ripgrep) is not on PATH");
  if (!isAbsolute(rg)) throw fail(`rg is not an absolute path: ${rg}`);
  let real = rg;
  try {
    real = realpathSync(rg);
  } catch {
    // checked by running it, below
  }
  if (under(rg, writable) || under(real, writable)) throw fail(`${rg} lies where a sandbox may write`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const js = join(dir, "scan.cjs");
  writeFileSync(js, nestedGitScanScript(rg), { mode: 0o644 });
  chmodSync(js, 0o644);
  const p = join(dir, "rg");
  writeFileSync(p, nestedGitScanWrapper(dir, node, js, rg), { mode: 0o755 });
  chmodSync(p, 0o755);
  // The test tree in `dir`, which no sandbox may write; the wrapper started there, beside a `.tool-versions` that a shim
  // reading its working directory would fail on.
  const t = mkdtempSync(join(dir, "check-"));
  try {
    for (const f of [".git/HEAD", "sub/.bashrc", "dep/.git/HEAD", "dep/.git/config", "dep/.git/hooks/pre-commit"]) {
      mkdirSync(dirname(join(t, f)), { recursive: true });
      writeFileSync(join(t, f), "");
    }
    writeFileSync(join(t, ".tool-versions"), "ripgrep 0.0.0-pendulum-absent\n");
    // As srt starts it: the wrapper itself (/bin/sh runs it, as its first line says), with the scanned directory last.
    const r = spawnSync("/bin/sh", [p, "--files", "--hidden", "--no-ignore", "--no-config", "--max-depth", "4", "--iglob", ".bashrc", "--iglob", "**/.git/hooks/**", "--iglob", "**/.git/HEAD", "--iglob", "**/.git/config", t], { cwd: t, encoding: "utf8", timeout: 30_000 });
    const got = String(r.stdout || "").split("\n").filter(Boolean).sort();
    const want = [join(t, ".git", "HEAD"), join(t, "sub", ".bashrc")];
    if (r.status !== 0 || want.some((w) => !got.includes(w)) || got.some((g) => g.startsWith(`${join(t, "dep", ".git")}/`))) throw fail(`a check over a test tree gave exit ${r.status ?? r.signal}, ${got.length} paths (${String(r.stderr || "").trim().split("\n").at(-1)?.slice(0, 200) || "no error"})`);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
  return p;
}

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
export function claudeLocalSettings({ domains = LOCAL_DOMAINS, clone = null, home = homedir(), env = process.env, credentials = null, readOnly = [], writable = [], readable = [], secrets = credentials ?? credentialPaths(home, env, { own: stageLogin("claude", env, home) }), secretEnv = CLAUDE_SECRET_ENV, ripgrep = null } = {}) {
  // readOnly: Pendulum's own helpers inside a writable directory (pendulum-db in the usage dir): no write, no edit.
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
      // readable: the stage's node, package manager and repository tools, read-only (local.mjs stageEnv, #137, #371): its sandbox shows nothing of
      // the home but these, the working and added directories.
      filesystem: { denyRead: [...secrets, "/proc"], ...(readable.length ? { allowRead: readable } : {}), ...(writable.length ? { allowWrite: writable } : {}), denyWrite: [...guards, ...SHARED_TMP, ...pendulumCodeDirs(home)] },
      // The model's credential (and any other the harness holds) is not in a command's environment.
      credentials: { envVars: [...new Set(secretEnv)].map((name) => ({ name, mode: "deny" })) },
      // Linux: the scan that leaves a nested checkout's .git writable (nestedGitScanScript).
      ...(ripgrep ? { ripgrep: { command: ripgrep } } : {}),
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
 * cloud sandbox counterpart of PENDULUM_LOCAL_DOMAINS), split on commas and white space, plus `hosts`, the stage's
 * Objective's own (openedStageHosts). An entry is a host name or `*.` and one; anything else is dropped.
 */
const DOMAIN_ENTRY = /^(\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;
const domainEntries = (value) => String(value || "").split(/[\s,]+/).map((d) => d.trim().toLowerCase()).filter(Boolean);
/**
 * A host entry a harness's sandbox enforces as written: a host name or `*.` and one, never a loopback name (`localhost`,
 * `*.localhost`, which Codex's proxy resolves to loopback itself), an IP address or `host:port` (Codex's proxy ignores
 * the port and admits every port of the host; Copilot's sandbox drops its whole network policy for one).
 */
const hostEntry = (d) => DOMAIN_ENTRY.test(d) && !/(^|\.)localhost$/.test(d);
// The Public Suffix List, through the tldts library (vendored: plugin/vendor/tldts, pinned in tools/deps), its ICANN and
// private sections both: `github.io` and `vercel.app` are suffixes anyone can register a site under, as `co.uk` is.
const requireVendor = createRequire(import.meta.url);
const { getPublicSuffix } = requireVendor("../../vendor/tldts/dist/index.cjs.min.js");
/** Whether `name` is itself a public suffix (the Public Suffix List, both sections): anyone can have a site under it. */
export const publicSuffix = (name) => getPublicSuffix(name, { allowPrivateDomains: true }) === name;
/**
 * The list's rules as tldts publishes them (dist/cjs/src/data/trie.js: a trie of labels, right to left; a node's flags
 * say a rule of either section ends there), read once; null when the file does not have that shape, so the check that
 * reads it fails closed. tldts's API answers for one name only, never what lies below one.
 */
let pslTrie;
const suffixTrie = () => {
  if (pslTrie !== undefined) return pslTrie;
  try {
    const t = requireVendor("../../vendor/tldts/dist/cjs/src/data/trie.js");
    const ok = t.nodeFlags instanceof Uint8Array && t.edgeStart?.length === t.nodeFlags.length + 1 && t.edgeLength?.length === t.edgeChild?.length && typeof t.labelText === "string" && Number.isInteger(t.rulesRoot);
    const offset = ok ? new Uint32Array(t.edgeLength.length) : null;
    for (let node = 0, at = 0; ok && node < t.nodeFlags.length; node += 1) {
      for (let e = t.edgeStart[node]; e < t.edgeStart[node + 1]; e += 1) {
        offset[e] = at;
        at += t.edgeLength[e];
      }
    }
    pslTrie = ok ? { ...t, label: (e) => t.labelText.slice(offset[e], offset[e] + t.edgeLength[e]) } : null;
  } catch {
    pslTrie = null;
  }
  return pslTrie;
};
/**
 * A Public Suffix List rule (both sections) at `name` or below it: the first one found, as the list writes it (`*.` for
 * a wildcard rule), or null with none. A `*.name` wildcard covers every site under `name`, so a rule anywhere below it
 * (`s3.amazonaws.com` under `amazonaws.com`) is a public suffix it would open. Returns `name` itself when the list
 * cannot be read: no wildcard passes unchecked.
 */
export function suffixRuleUnder(name) {
  const t = suffixTrie();
  if (!t) return name;
  const edges = (node) => Array.from({ length: t.edgeStart[node + 1] - t.edgeStart[node] }, (_, i) => t.edgeStart[node] + i);
  const child = (node, label) => {
    const e = edges(node).find((x) => t.label(x) === label);
    return e === undefined ? -1 : t.edgeChild[e];
  };
  const labels = name.split(".").reverse();
  // An exception rule for `name` itself (`!city.kawasaki.jp`): the wildcard rule over it does not make it a suffix.
  let ex = Number.isInteger(t.exceptionsRoot) ? t.exceptionsRoot : -1;
  for (const label of labels) ex = ex < 0 ? -1 : child(ex, label);
  const excepted = ex >= 0 && (t.nodeFlags[ex] & 3) !== 0;
  // The nodes `name`'s labels reach, right to left, each label by its own edge or a wildcard rule's `*`.
  let reached = [{ node: t.rulesRoot, path: [], star: false }];
  for (const label of labels) {
    reached = reached.flatMap(({ node, path }) => edges(node).filter((e) => t.label(e) === label || t.label(e) === "*").map((e) => ({ node: t.edgeChild[e], path: [t.label(e), ...path], star: t.label(e) === "*" })));
    if (!reached.length) return null;
  }
  // Any rule that ends there or deeper (the trie shares its nodes: each is looked at once).
  const seen = new Set();
  const below = (node, path, self = true) => {
    if (self && t.nodeFlags[node] & 3) return path.join(".");
    if (seen.has(node)) return null;
    seen.add(node);
    for (const e of edges(node)) {
      const hit = below(t.edgeChild[e], [t.label(e), ...path]);
      if (hit) return hit;
    }
    return null;
  };
  for (const { node, path, star } of reached) {
    const hit = below(node, path, !(star && excepted));
    if (hit) return hit;
  }
  return null;
}
/**
 * Why a `*.name` wildcard may not be opened, or null when it may: a Public Suffix List rule at `name` or below it
 * (suffixRuleUnder: `*.github.io`, `*.amazonaws.com`, where `s3.amazonaws.com` is a suffix anyone can have a bucket
 * under), as `{rule}`. A wildcard over a top-level name alone (`*.com`, `*.internal`) is no host entry at all (hostEntry).
 */
export function wildcardRefusal(name) {
  const rule = suffixRuleUnder(name);
  return rule ? { rule } : null;
}
/**
 * Whether `host` (lower case, trimmed) is an entry every harness's sandbox enforces as written (hostEntry) that an
 * Objective's label may open: a wildcard only over a name with no public suffix at or below it (wildcardRefusal),
 * never one that would open sites anyone can register.
 */
export const isSandboxHost = (host) => typeof host === "string" && hostEntry(host) && !(host.startsWith("*.") && wildcardRefusal(host.slice(2)));
export function runnerDomains(value = "", hosts = []) {
  return [...new Set([...LOCAL_DOMAINS, ...domainEntries(value).filter(hostEntry), ...hosts.filter(isSandboxHost)])];
}

/**
 * The hosts this stage's Objective opens with its `pendulum:host:` labels (choice.mjs hostsOf), once the stage's choice
 * check has passed (worker.mjs, review.mjs: openStageHosts). A runner's sandboxes add them to `allowed_domains`
 * (harness.mjs claudeRunner, codexRunner, copilotRunner); a stage process works one Objective, and nothing else sets
 * them, so no other Objective's sandbox ever gets them. Local mode's loop opens them itself (Local.stageEnv).
 */
let stageHosts = [];
export const openStageHosts = (hosts = []) => {
  stageHosts = [...new Set(hosts.filter(isSandboxHost))];
};
export const openedStageHosts = () => stageHosts;

/** The `allowed_domains` entries runnerDomains drops (doctor names each). */
export const droppedDomains = (value = "") => domainEntries(value).filter((d) => !hostEntry(d));

/**
 * Codex's `domains` and Copilot's `allowedHosts` from `domains`: the entries their sandboxes enforce as written (hostEntry,
 * as runnerDomains keeps). Copilot 1.0.109's sandbox drops its proxy, and with it every host rule, for a `host:port`
 * entry (#106); Codex 0.167's proxy ignores the port and admits every port of a loopback name or address (#108). Local
 * mode's PENDULUM_LOCAL_DOMAINS can come from the workflow file, so no such entry reaches either; serve logs and doctor
 * names each one dropped (sandboxDroppedHosts).
 */
export const sandboxHosts = (domains = []) => [...new Set(domainEntries(domains.join(" ")).filter(hostEntry))];
/** The `domains` entries sandboxHosts drops. */
export const sandboxDroppedHosts = (domains = []) => droppedDomains(domains.join(" "));

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
 * not its home, where Codex keeps the sandbox helper it starts. Any other Codex home is denied whole but the release
 * the `codex` on `env`'s PATH runs from, which the sandbox execs (codexLoginFiles).
 */
export function codexLocalConfig({ domains = LOCAL_DOMAINS, clone = null, addDirs = [], home = homedir(), env = process.env, credentials = null, readOnly = [], secretEnv = [], secrets = codexLoginFiles(credentials ?? credentialPaths(home, env, { own: stageLogin("codex", env, home) }), stageLogin("codex", env, home).dir, codexRelease(whichPath("codex", env))), exists = (p) => !!lstatSync(p, { throwIfNoEntry: false }), commandEnv = null, denyProc = true } = {}) {
  // /proc: no command reads a process outside Codex's sandbox: each runs in a user namespace of its own without
  // CAP_SYS_PTRACE, so the kernel refuses the read, and where bubblewrap can mount a fresh /proc it has its own PID
  // namespace too. Locally the profile denies /proc as well. On a runner it does not (`denyProc` false): under a systemd
  // unit that deny holds and takes /dev/fd with it (bash's process substitution, /dev/stdin); the runner's confinement
  // probe checks the read refusal with a decoy before every start (codex-runner.mjs).
  const deny = [...secrets.map((p) => `${tq(p)}="deny"`), ...(denyProc ? [`${tq("/proc")}="deny"`] : [])];
  // The clone's harness configuration by absolute path, where present: a path relative to the workspace roots applies to
  // every root, and Codex's sandbox fails to start on an absent one (a stage's temp directory has no .github). Pendulum makes
  // them all before a harness starts (prepareClone).
  // .git/commondir and .git/info/attributes likewise by absolute path: relative, Codex would make them in every root
  // that has no .git.
  // `exists`: on a runner the checkout is the agent's (700), so what is there is listed as the agent (codex-runner.mjs).
  const ro = [...(clone ? codexReadOnly(clone).filter(exists) : []), ...readOnly, ...pendulumCodeDirs(home)].map((p) => `${tq(p)}="read"`);
  const roots = addDirs.map((d) => `${tq(d)}=true`);
  // Host names only (sandboxHosts): Codex's proxy ignores an entry's port, so `127.0.0.1:N` would admit every port (#108).
  const net = sandboxHosts(domains).map((d) => `${tq(d)}="allow"`);
  const profile = `{extends=":read-only",workspace_roots={${roots.join(",")}},filesystem={${[...deny, ...ro, `":workspace_roots"={"."="write",".git"="write",".git/hooks"="read",".git/config"="read"}`].join(",")}},network={enabled=true,mode="full",allow_local_binding=true,domains={${net.join(",")}}}}`;
  // allow_local_binding: the repository's own test servers on 127.0.0.1 (a loopback Postgres). Codex's sandbox has its own
  // network namespace, so the host's loopback services stay out of reach (checked: a host server refused).
  return [
    `default_permissions="pendulum"`,
    `permissions.pendulum=${profile}`,
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
 * The settings.json for the COPILOT_HOME Pendulum gives a local Copilot run (`copilot --sandbox`): commands in
 * Copilot's sandbox with no bypass, writes in the working directory and `addDirs` only, the clone's hooks and
 * config and `readOnly` unwritable, credential stores denied, no gh or git login handed in, and the network
 * limited to `domains`. Copilot reads this policy only from its home directory, so the developer's own
 * ~/.copilot is never touched.
 */
export function copilotLocalSettings({ domains = LOCAL_DOMAINS, clone = null, addDirs = [], home = homedir(), env = process.env, readOnly = [], readable = [], denied = null, alsoDenied = [], platform = osPlatform() } = {}) {
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
        // login); `denied`: a runner's own list (none there: that login is for its commands); `alsoDenied`: more paths beside
        // the credential stores (local mode on Linux: Copilot's own TMPDIR, copilotPrivateTmp).
        filesystem: { readwritePaths: [...addDirs, ...(clone ? [join(clone, ".git")] : [])], readonlyPaths: [...new Set([...(clone ? [...gitGuards(clone), ...harnessConfigPaths(clone)] : []), ...readOnly, ...readable, ...pendulumCodeDirs(home)])], deniedPaths: [...(denied ?? (platform === "linux" ? credentialPaths(home, env).filter(isDir) : credentialPaths(home, env))), ...alsoDenied] },
        network: { allowOutbound: true, allowLocalNetwork: false, allowedHosts: sandboxHosts(domains) },
      },
    },
  };
}

/**
 * Linux: Copilot's own TMPDIR in local mode, apart from its commands'. Copilot binds its TMPDIR into every command's
 * sandbox and writes each command's network rules there before it loads them, so with the commands' own temp directory a
 * command could rewrite the next command's rules and reach past Copilot's proxy (#99's review; reproduced inside srt:
 * srt's own proxy, whose list adds Copilot's API hosts). This directory is in the usage directory's `harness` folder,
 * which only the harness process may write, is made afresh before every start (harness.mjs) and is denied to commands
 * (copilotLocalSettings `alsoDenied`); Pendulum's bwrap gives each command the stage's temp directory as its TMPDIR.
 */
export const copilotPrivateTmp = (usageDir) => join(usageDir, "harness", "copilot-tmp");

/**
 * The temp directory a local Copilot run's commands must be given. Copilot's sandbox opens the temp directory it is
 * started with (`TMPDIR`, else the host's /tmp) read-write to every command, and gives each command a fresh, empty /tmp
 * otherwise. Only the stage's own temp directory (one of the sandbox's added directories) keeps the host's shared /tmp
 * out of reach. On Linux Copilot itself starts with copilotPrivateTmp instead, and Pendulum's bwrap hands its commands
 * this one.
 */
export function copilotTmpdir(local, env = {}) {
  const t = env.TMPDIR;
  if (!t || !(local?.addDirs || []).includes(t)) throw new Error(`a local Copilot run needs TMPDIR set to its stage's own temp directory (it is ${t || "unset"}): Copilot's sandbox opens TMPDIR, else the host's /tmp, to every command`);
  return t;
}

/** Settings for `srt`, which runs Pendulum's own shell commands (setup, install, validation) on a model-edited tree. */
export function srtSettings({ domains = LOCAL_DOMAINS, writable = [], clone = null, home = homedir(), env = process.env, credentials = credentialPaths(home, env), readOnly = [], ripgrep = null } = {}) {
  return {
    network: { allowedDomains: [...new Set(domains)], deniedDomains: [] },
    filesystem: { denyRead: [...credentials, "/proc"], allowWrite: writable, denyWrite: [...(clone ? [...gitGuards(clone), ...harnessConfigPaths(clone)] : []), ...readOnly, ...SHARED_TMP, ...pendulumCodeDirs(home)] },
    // Linux: the scan that leaves a nested checkout's .git writable (nestedGitScanScript).
    ...(ripgrep ? { ripgrep: { command: ripgrep } } : {}),
  };
}

/**
 * The `git` a local harness finds first on its PATH (lib/harness.mjs), on the host and in its sandbox: the real one,
 * refused once the clone's .git is not the directory Pendulum checked before the harness started (PENDULUM_GIT_DIR,
 * PENDULUM_GIT_ID: its inode). A sandbox that lets a command rename .git (Copilot's) would otherwise let it put a .git
 * of its own in place, whose config the harness's own git on the host then reads between tool calls.
 */
export const gitGuardScript = (realGit) => `#!/bin/sh
if [ -n "$PENDULUM_GIT_DIR" ]; then
  id=$(ls -di "$PENDULUM_GIT_DIR" 2>/dev/null | awk '{print $1}')
  if [ -L "$PENDULUM_GIT_DIR" ] || [ "$id" != "$PENDULUM_GIT_ID" ]; then
    echo "pendulum: $PENDULUM_GIT_DIR is not the git directory Pendulum checked; git refused" >&2
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

/** A harness CLI's own state (its login, settings, sessions), which it reads and writes; Copilot's home is Pendulum's. */
export function harnessHomes(harness, env = {}, home = homedir()) {
  if (harness === "claude") return [env.CLAUDE_CONFIG_DIR || join(home, ".claude"), claudeJson(env, home)];
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
# Pendulum: bubblewrap for Copilot's outer sandbox, with the host's /dev/net/tun after srt's fresh /dev (local.mjs).
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
 * Each step waits on the answer itself, never a clock: the namespace's process says on a pipe that it is inside it, and
 * slirp4netns writes its --ready-fd once the interface is configured (or exits, closing it, when it cannot). Each wait
 * is bounded (OUTER_PROBE_WAIT_S, through `timeout`): one that hangs is a no then, well inside runOuterProbe's own limit,
 * since the probe blocks the loop that runs it.
 */
export const OUTER_PROBE_WAIT_S = 30;
export const COPILOT_OUTER_PROBE = `test -c /dev/net/tun || { echo "no /dev/net/tun" >&2; exit 2; }
for b in slirp4netns nsenter unshare ip iptables ip6tables iptables-restore ip6tables-restore mkfifo timeout; do command -v "$b" >/dev/null || { echo "$b is not on PATH" >&2; exit 3; }; done
unshare --user --net --map-user="$(id -u)" --map-group="$(id -g)" true 2>/dev/null || { echo "unshare cannot make a user and network namespace mapping the user (util-linux 2.36 or later)" >&2; exit 5; }
mkfifo "$TMPDIR/ns.ready" "$TMPDIR/slirp.ready" || { echo "mkfifo cannot make a pipe in $TMPDIR" >&2; exit 6; }
unshare --user --net --map-user="$(id -u)" --map-group="$(id -g)" --keep-caps sh -c 'echo in >&3; exec 3>&-; exec sleep 120' 3>"$TMPDIR/ns.ready" & ns=$!
[ "$(timeout ${OUTER_PROBE_WAIT_S} cat "$TMPDIR/ns.ready")" = in ] || { kill "$ns" 2>/dev/null; echo "unshare did not start its namespace's process" >&2; exit 5; }
slirp4netns --configure --mtu=65520 --ready-fd=3 "$ns" tap0 3>"$TMPDIR/slirp.ready" >/dev/null 2>"$TMPDIR/slirp.err" & sl=$!
ok=""
if [ "$(timeout ${OUTER_PROBE_WAIT_S} cat "$TMPDIR/slirp.ready")" = 1 ] && nsenter --target "$ns" --user --net --preserve-credentials ip -4 -o address show dev tap0 2>/dev/null | grep -q 10.0.2.100; then ok=1; fi
kill "$sl" "$ns" 2>/dev/null
[ -n "$ok" ] || { echo "slirp4netns did not configure its interface: $(tail -1 "$TMPDIR/slirp.err" 2>/dev/null)" >&2; exit 4; }
echo ok
`;
const OUTER_PROFILE = "profile-5";

const versionOf = (cmd) => {
  const r = spawnSync(cmd, ["--version"], { encoding: "utf8", timeout: 30_000 });
  return r.status === 0 ? String(r.stdout || r.stderr).trim().split("\n")[0] : null;
};

/**
 * Where Copilot's own binary unpacks the release it carries (`pkg/`) and keeps its caches: read-only in its outer
 * sandbox, so the harness cannot change code it runs at its next start. sandboxedVersion unpacks it, the one place
 * Pendulum lets Copilot write there.
 */
export const copilotCacheHome = (env = {}, home = homedir(), platform = osPlatform()) => env.COPILOT_CACHE_HOME || (platform === "darwin" ? join(home, "Library", "Caches", "copilot") : join(env.XDG_CACHE_HOME || join(home, ".cache"), "copilot"));
/**
 * sandboxedVersion's srt settings: no network, no writes but Copilot's unpacking, credential stores unreadable. Copilot's
 * home (COPILOT_HOME) is the stage's, which Pendulum makes and which holds no login (its token is in its environment).
 */
export const versionSettings = (harness, env = {}, home = homedir()) => ({
  network: { allowedDomains: [], deniedDomains: [] },
  filesystem: { denyRead: [...credentialPaths(home, harness === "copilot" ? { ...env, COPILOT_HOME: "" } : env), "/proc"], allowRead: harnessInstall(whichPath(harness, env) || harness, home), allowWrite: harness === "copilot" ? [copilotCacheHome(env, home)] : [], denyWrite: pendulumCodeDirs(home) },
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
 * on a throwaway directory. Only a yes is kept, in ~/.cache/pendulum/outer-probe.json by harness, bubblewrap and srt
 * version and by the account it was made on (`account`, lib/accounts.mjs: its name and its login folder or token file;
 * none, the implicit one), so the next stage on that account reads it; a no (which a loaded box or a missing tool
 * installed since can cause) is probed again by the next serve start and the next stage.
 */
export function outerProbe(harness, { domains = LOCAL_DOMAINS, env = process.env, home = homedir(), account = null, cacheFile = join(home, ".cache", "pendulum", "outer-probe.json"), keyOf = outerProbeKey, probe = runOuterProbe } = {}) {
  if (osPlatform() !== "linux") return { on: false, why: "not Linux (Seatbelt cannot start inside another sandbox)" };
  if (!OUTER_HARNESSES.includes(harness)) return { on: false, why: "not supported" };
  if (!OUTER_PROBED.includes(harness)) return { on: true, why: "" };
  const key = `${keyOf(harness, { env, home })}|${account?.declared ? `${account.name}:${account.home || account.tokenFile || ""}` : harness}`;
  let cache = {};
  try {
    cache = JSON.parse(readFileSync(cacheFile, "utf8"));
  } catch {
    // none yet
  }
  if (cache[key]?.on === true) return { ...cache[key], cached: true, cacheFile };
  const result = probe(harness, { domains, env, home });
  // A no from an older Pendulum is dropped with the rewrite.
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

/**
 * outerProbe's check itself: the harness's own sandbox (Codex) or what it needs (Copilot), inside the outer profile. All
 * of it on `env`, the stage's (its account's login, local.mjs stageEnv): Codex's profile denies what a stage on that
 * login denies.
 */
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
    const inner = harness === "copilot" ? ["sh", "-c", COPILOT_OUTER_PROBE] : ["codex", "sandbox", ...codexLocalConfig({ domains, clone: work, addDirs: [tmp], home, env }), "--", "sh", "-c", `echo ok > ${JSON.stringify(join(work, "probe"))}`];
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
  const place = homePlaces(harness, env, home);
  // And the guarded directories, which srt would otherwise stand in for with a file the harness cannot read as one.
  for (const d of [...harnessHomes(harness, env, home).filter((p) => !p.endsWith(".json")), ...harnessHomeGuards(harness, env, home, { dirsOnly: true })]) ensureStateDir(d, place);
  const seeds = { ...HOME_SEEDS, ...(harness === "copilot" ? copilotHomeFiles() : {}) };
  for (const f of harnessHomeGuards(harness, env, home, { staticOnly: true })) {
    const seed = seeds[basename(f)];
    if (seed === undefined) continue;
    let at = f;
    walking(at, () => {
      for (let hops = 0; lstatSync(at, { throwIfNoEntry: false })?.isSymbolicLink() && !resolves(at); hops += 1) at = danglingTarget(at, place, hops);
    });
    if (at !== f) ensureStateDir(dirname(at), place);
    place.check(at);
    try {
      writeFileSync(at, seed, { flag: "wx", mode: 0o600 });
    } catch {
      // there already
    }
  }
};

/**
 * Where ensureHarnessHomes may make a directory or a file, by real path: inside the stage's own login folder (stageLogin)
 * and, for a Claude Code stage, the default `~/.claude` (a second account's folder that links its entries there); never
 * at or under a credential store or another login (credentialPaths, and every other login's files, one nested in the
 * stage's own folder included), nor on the stage's own login files; the rest of its own folder is its harness's state. A
 * link to nothing on the way has its target made there; one that leads anywhere else, a directory on the way that really
 * lies elsewhere, a file or a loop of links on the way, or a file where a directory belongs, refuses the stage
 * (`home-link`), naming the path for this machine's log only (local.mjs homeLinkReason is GitHub's).
 */
export function homePlaces(harness, env = {}, home = homedir()) {
  const own = stageLogin(harness, env, home);
  const roots = [...new Set([...(own ? [own.dir] : []), ...(harness === "claude" ? [join(home, ".claude")] : [])].map(realPlace))];
  // The stage's own login's entries (credentialPaths `own`: what bears it, or a Codex or Copilot home whole) leave the
  // refused list, its login files excepted; every other login's stay, one nested in the stage's own folder included.
  // Every name of it: a default home linked to the folder CLAUDE_CONFIG_DIR or CODEX_HOME names is one login, listed twice.
  const logins = harnessLogins(home, env, { declared: own ? [own] : [] });
  const isMine = (l) => !!own && l.harness === own.harness && sameDir(l.dir, own.dir);
  const ownEntries = new Set(logins.filter(isMine).flatMap((l) => (l.harness === "claude" ? l.bearing : l.files)).map(realPlace));
  const ownFiles = harness === "claude" ? ownLogin("claude", env, home) : harness === "codex" && own ? [join(own.dir, "auth.json")] : [];
  const others = logins.filter((l) => !isMine(l)).flatMap((l) => [...l.files, ...l.bearing]);
  const denied = [...new Set([...credentialPaths(home, env, { own }).map(realPlace).filter((c) => !ownEntries.has(c)), ...others.map(realPlace), ...ownFiles.map(realPlace)])];
  const where = (real) => (denied.some((c) => within(real, c)) ? "in a credential store or another harness login" : roots.some((r) => within(real, r) || r.startsWith(`${real}/`)) ? null : "outside the harness homes this stage may write");
  return {
    // Refused unless `p` really lies where Pendulum may make it (an ancestor of a home not made yet included). `link`: the
    // link to nothing whose target `p` is.
    check(p, link = null) {
      const real = realPlace(p);
      const bad = where(real);
      if (!bad) return;
      const what = link ? `${link} is a link to ${p}, which does not exist and` : `${p}${real !== resolve(p) ? ` (really ${real})` : ""}`;
      throw homeLinkError(link || p, link ? p : real, `${what} lies ${bad}; Pendulum makes nothing there: create it yourself or remove the link`);
    },
  };
}
const homeLinkError = (link, target, message) => Object.assign(new Error(message), { code: "home-link", link, target });
/** The links a chain to nothing may take before the stage refuses it (a loop of links never resolves). */
const HOME_LINK_HOPS = 8;
const resolves = (p) => {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
};
/** Where `p` really is: its nearest ancestor that resolves, at its real path, and the rest as written (realish goes one up). */
const realPlace = (p) => {
  const tail = [];
  for (let q = resolve(p); ; q = dirname(q)) {
    try {
      return join(realpathSync(q), ...tail);
    } catch {
      if (q === dirname(q)) return resolve(p);
      tail.unshift(basename(q));
    }
  }
};
/** `fn` on the path walk at `p`: a file or a loop of links on the way (ENOTDIR, ELOOP) refuses the stage (`home-link`). */
const walking = (p, fn) => {
  try {
    return fn();
  } catch (e) {
    if (e?.code === "ENOTDIR" || e?.code === "ELOOP") throw homeLinkError(p, p, `${p} cannot be made: a path on the way is a file or a loop of links (${e.code}); remove it`);
    throw e;
  }
};
/** The target of `link`, a link to nothing, where homePlaces allows it. */
function danglingTarget(link, place, hops) {
  const target = resolve(dirname(link), readlinkSync(link));
  if (hops >= HOME_LINK_HOPS) throw homeLinkError(link, target, `${link} is a link to ${target}, a chain of links that never resolves; remove it`);
  place.check(target, link);
  return target;
}
/** Make the directory `p` and its parents, each checked where it really lies; a link to nothing on the way has its target made (danglingTarget). */
function ensureStateDir(p, place, hops = 0) {
  walking(p, () => {
    const st = lstatSync(p, { throwIfNoEntry: false });
    if (st?.isSymbolicLink() && !resolves(p)) {
      ensureStateDir(danglingTarget(p, place, hops), place, hops + 1);
      return;
    }
    // There already: a directory, or a link to one. A file there would leave the harness a state folder it cannot use.
    if (st) {
      if (!statSync(p).isDirectory()) throw homeLinkError(p, realPlace(p), `${p}${st.isSymbolicLink() ? ` (a link to ${realPlace(p)})` : ""} is no directory, where the harness keeps one; remove it`);
      return;
    }
    if (dirname(p) !== p) ensureStateDir(dirname(p), place, hops);
    place.check(p);
    try {
      mkdirSync(p, { mode: 0o700 });
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
  });
}

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
/** The names Codex keeps in its home, its login (`auth.json*`) and prompt history (`history.jsonl`) with them. */
const CODEX_HOME_NAMES = [...HOME_GUARDS.codex.files, ...HOME_GUARDS.codex.dirs, ...HOME_WRITABLE.codex.filter((n) => typeof n === "string"), "auth.json*", "history.jsonl"];
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
 * session of the developer's in that directory would read). The clone's own project is a link Pendulum makes there to
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
  const fixed = [...g.dirs.map((f) => join(d, f)), ...(dirsOnly ? [] : [...g.files.map((f) => join(d, f)), ...(harness === "claude" ? [claudeJson(env, home)] : [])])];
  if (dirsOnly || staticOnly) return fixed;
  const named = new Set([...g.dirs, ...g.files]);
  const others = entries(d).filter((n) => !named.has(n) && !writableName(harness, n)).map((n) => join(d, n)).filter((p) => !fixed.includes(p));
  if (harness === "claude" && clone && linkableProject(clone)) return [...fixed, ...others, join(d, "projects")];
  const mine = clone ? claudeProject(clone) : null;
  const own = harness === "claude" ? entries(join(d, "projects")).filter((n) => n !== mine && !(mine?.length > 200 && n.startsWith(mine.slice(0, 200)))).map((n) => join(d, "projects", n)) : harness === "codex" ? codexSessionGuards(join(d, "sessions"), now) : [];
  return [...fixed, ...others, ...own];
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
 * `ripgrep`: nestedGitScanScript's path (writeNestedGitScan).
 * `credentials`: the list serve made for the stage (credentialPaths), less the stage's own login, which its harness reads;
 * without it, made here from `env`.
 * `relaySocketDir`: the directory of the stage's gateway relay socket, as serve made it (worker-relay.mjs handSocketDir;
 * null for a stage that relays nothing, which then reaches no socket directory at all): the one socket directory that
 * stays reachable inside, for the forwarder Pendulum's bwrap shim starts in each command's sandbox
 * (relay-shim.mjs); never writable.
 */
export function harnessOuterSettings({ harness, domains = LOCAL_DOMAINS, writable = [], clone = null, home = homedir(), env = {}, credentials = null, readOnly = [], install = [], projectDir = null, bwrapPath = null, relaySocketDir = null, ripgrep = null } = {}) {
  const own = harnessHomes(harness, env, home);
  // Every login on the machine is denied but the one this stage runs on (ownLogin), which its harness reads and refreshes.
  const isOwn = ownLoginTest(harness, env, home);
  // .claude.json holds the developer's MCP servers: read-only, not a writable path.
  const guards = harnessHomeGuards(harness, env, home, { clone });
  const writableOwn = own.filter((p) => !guards.includes(p));
  return {
    network: { allowedDomains: [...new Set([...domains, ...(HARNESS_API_DOMAINS[harness] || [])])], deniedDomains: [], allowAllUnixSockets: true, allowLocalBinding: true },
    // install: the harness's own release directory, readable where a credential store holds it (Codex's installer puts
    // it in ~/.codex, denied when CODEX_HOME is elsewhere).
    filesystem: {
      denyRead: [...(credentials ?? credentialPaths(home, env, { own: stageLogin(harness, env, home) })).filter((p) => !isOwn(p)), ...hostSockets(env, undefined, { keep: [...writable, ...(relaySocketDir ? [relaySocketDir] : [])] })],
      ...(install.length ? { allowRead: install } : {}),
      allowWrite: [...writable, ...writableOwn, ...(harness === "claude" && projectDir ? [projectDir] : [])],
      // This machine's usage-limit holds (holds.mjs): never in a writable path, and read-only even under a harness home around them.
      denyWrite: [...(clone ? [...gitGuards(clone), ...harnessConfigPaths(clone)] : []), ...readOnly, ...SHARED_TMP, ...guards, ...install, ...pendulumCodeDirs(home), holdsDir(home)],
    },
    allowNestedUserNamespaces: true,
    // Copilot: bubblewrap with /dev/net/tun for its sandbox's network (bwrapTunScript); srt runs it on the host.
    ...(bwrapPath ? { bwrapPath } : {}),
    // The scan that leaves a nested checkout's .git writable (nestedGitScanScript).
    ...(ripgrep ? { ripgrep: { command: ripgrep } } : {}),
  };
}

/**
 * The local harness flags, from PENDULUM_LOCAL_SANDBOX ({addDirs, domains, clone}) in the child env; null on
 * Actions. A local child without them refuses: it must never fall back to a runner's skipped permissions.
 */
export function localSandbox(env = {}) {
  if (!env.PENDULUM_LOCAL_SANDBOX) {
    if (env.PENDULUM_LOCAL === "1") throw new Error("local mode without its sandbox settings (PENDULUM_LOCAL_SANDBOX); refusing to run the harness unsandboxed");
    return null;
  }
  const s = JSON.parse(env.PENDULUM_LOCAL_SANDBOX);
  // Sandboxed code can rename or replace a directory it may write the parent of; a writable path that now resolves
  // elsewhere (a symlink to the home directory) would open that place to the next sandbox. Pendulum made each one real.
  for (const d of [s.clone, ...(s.addDirs || []), ...(s.readDirs || [])].filter(Boolean)) {
    let real = null;
    try {
      real = realpathSync(d);
    } catch {
      // gone: the sandbox fails on it by itself
    }
    if (real !== null && real !== d) throw new Error(`local sandbox directory ${d} now resolves to ${real}; refusing to run`);
  }
  return { gitId: s.gitId || null, gitPin: s.gitPin || null, gitBin: s.gitBin || null, bwrapBin: s.bwrapBin || null, copilotTmp: s.copilotTmp || null, toolchain: s.toolchain || null, claudeEnv: s.claudeEnv || null, ripgrep: s.ripgrep || null, readable: s.readable || [], addDirs: s.addDirs || [], cacheDirs: s.cacheDirs || [], readDirs: s.readDirs || [], domains: s.domains || LOCAL_DOMAINS, clone: s.clone || null, readOnly: s.readOnly || [], claudeDir: s.claudeDir || null, credentials: Array.isArray(s.credentials) ? s.credentials : null };
}

/**
 * The env a local child starts from: an allow-list, not the developer's whole shell, so AWS_*, NPM_TOKEN
 * and the like never reach the harness. `extra` names more variables the adopter's commands need
 * (PENDULUM_LOCAL_ENV, such as DATABASE_URL); Pendulum's own service keys (inputs.mjs PENDULUM_SECRET_KEYS) are never
 * among them, since the workflow file that can name them is repository content, nor any of its control variables
 * (inputs.mjs PENDULUM_CONTROL_KEYS: a stage's own, which serve alone sets). Nor is a worker secret's NAME or SOURCE
 * (`workerSecrets`, the worker_secrets setting): that reaches the work lineage's harness alone (lib/worker-secrets.mjs),
 * never every stage's every command; doctor warns when PENDULUM_LOCAL_ENV names one.
 */
export function localBaseEnv(env = process.env, extra = [], { workerSecrets = "" } = {}) {
  const keep = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_[A-Z]+|TERM|COLORTERM|TMPDIR|TZ|XDG_[A-Z_]+|HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS|MISE_[A-Z_]+|NVM_DIR|VOLTA_HOME|PNPM_HOME|COREPACK_HOME|BUN_INSTALL|CARGO_HOME|RUSTUP_HOME|GOPATH|GOROOT|JAVA_HOME|CLAUDE_CONFIG_DIR|CODEX_HOME)$/;
  const worker = new Set(parseWorkerSecrets(workerSecrets).entries.flatMap((e) => [e.name, e.source]));
  const wanted = new Set(extra.filter((k) => !isPendulumSecret(k) && !PENDULUM_CONTROL_KEYS.includes(k) && !worker.has(k)));
  const out = {};
  for (const [k, v] of Object.entries(env)) if (keep.test(k) || wanted.has(k)) out[k] = v;
  // Tool telemetry would only hit the sandbox's network allow-list (a Codex sandbox reports each refusal as an error).
  return { TURBO_TELEMETRY_DISABLED: "1", NEXT_TELEMETRY_DISABLED: "1", DO_NOT_TRACK: "1", ...out };
}

/** Where local mode's token for a repository lives: ~/.config/pendulum/tokens/<owner>/<name> (the sandboxes hide ~/.config/pendulum). */
export function tokenFile(repoFull, home = homedir()) {
  const [owner, name] = repoFull.split("/");
  return join(home, ".config", "pendulum", "tokens", owner, name);
}
/** The fix for a token reached through a symbolic link (tokenPlaceProblem), as every message and doctor's row name it. */
export const TOKEN_LINK_FIX = "replace the link with a real folder (or file) of your own, then save the token with `pendulum token set`";
/** What is wrong with a token place reached through the symbolic link at `at`, without the fix. */
export const tokenLinkDetail = (at) => `${at} is a symbolic link; local mode keeps its token only under a real ~/.config/pendulum, which every sandbox hides by that path`;
/**
 * Why local mode's token file for a repository may not be read or written, else null: a symbolic link at
 * ~/.config/pendulum, its `tokens` folder, the owner's folder or the file itself. The sandboxes hide ~/.config/pendulum by
 * that path alone, so a token behind a link could sit where a stage reads it. `{at, line}`: the link, and the line to say.
 */
export function tokenPlaceProblem(repoFull, home = homedir()) {
  const file = tokenFile(repoFull, home);
  const base = join(home, ".config", "pendulum");
  for (const at of [base, join(base, "tokens"), dirname(file), file]) {
    let st;
    try {
      st = lstatSync(at);
    } catch {
      return null;
    }
    if (st.isSymbolicLink()) return { at, line: `${tokenLinkDetail(at)}: ${TOKEN_LINK_FIX}` };
  }
  return null;
}
/**
 * Local mode's token for a repository: PENDULUM_LOCAL_TOKEN, else its tokenFile; "" when neither is set, or when no
 * token file is there to read (a linked ~/.config/pendulum with no token behind it leaves the callers' own fallbacks).
 * Throws tokenPlaceProblem's line, with `link` set to the link's path, when a token file is reached through a link.
 */
export function localToken(repoFull, env = process.env) {
  if (env.PENDULUM_LOCAL_TOKEN) return env.PENDULUM_LOCAL_TOKEN.trim();
  const f = tokenFile(repoFull);
  if (!existsSync(f)) return "";
  const problem = tokenPlaceProblem(repoFull);
  if (problem) throw Object.assign(new Error(problem.line), { link: problem.at });
  return readFileSync(f, "utf8").trim();
}
/**
 * Saves local mode's token for a repository where localToken reads it (tokenFile): a new file, owner-only (0600),
 * synced and put in place by rename, so a file of other mode there is replaced whole and no reader sees half a token;
 * the `tokens` and owner's folders are made owner-only (0700). Returns the file's path. Refuses a repository that is
 * not OWNER/NAME, a token that is empty or holds anything but letters, digits and underscores (every GitHub token's
 * characters), and a place behind a symbolic link (tokenPlaceProblem).
 */
export function saveLocalToken(repoFull, token, home = homedir()) {
  // A repository's two names as GitHub allows them, so the file lands under tokens/ and nowhere else.
  const parts = String(repoFull).split("/");
  if (parts.length !== 2 || parts.some((p) => !/^[A-Za-z0-9_.-]+$/.test(p) || p === "." || p === "..")) throw new Error(`--repo must be OWNER/NAME, not ${JSON.stringify(repoFull)}; nothing saved`);
  const t = String(token ?? "").trim();
  if (!t) throw new Error("no token given; nothing saved");
  if (!/^[A-Za-z0-9_]+$/.test(t)) throw new Error("the token holds characters no GitHub token has (only letters, digits and underscores); paste the one token GitHub showed. Nothing saved");
  const placed = () => {
    const problem = tokenPlaceProblem(repoFull, home);
    if (problem) throw new Error(`${problem.line}. Nothing saved`);
  };
  placed();
  const file = tokenFile(repoFull, home);
  const owner = dirname(file);
  mkdirSync(owner, { recursive: true, mode: 0o700 });
  placed();
  for (const d of [dirname(owner), owner]) chmodSync(d, 0o700);
  const temp = join(owner, `.${basename(file)}.${process.pid}.tmp`);
  rmSync(temp, { force: true });
  try {
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeSync(fd, t);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(temp, 0o600);
    renameSync(temp, file);
  } catch (e) {
    rmSync(temp, { force: true });
    throw e;
  }
  return file;
}
/** The line that says local mode has no token for a repository, and the fix. */
export const noTokenLine = (repoFull) => `no token for ${repoFull}: create a fine-grained token for this one repository (${LOCAL_TOKEN_PERMISSIONS}) and save it with \`pendulum token set\` in the clone (it asks for the token and writes ${tokenFile(repoFull)}), or export PENDULUM_LOCAL_TOKEN`;

const gitTry = (args) => spawnSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
/** Throws the plain line for git missing from PATH (spawn's ENOENT) or a git that did not start; else returns its result. */
const gitRan = (r) => {
  if (r.error?.code === "ENOENT") throw new Error("git is not on PATH; install git (https://git-scm.com/downloads) and start again");
  if (r.error) throw new Error(`git did not run (${r.error.code || r.error.message}); check the git on PATH`);
  return r;
};

/** OWNER/NAME from a GitHub remote's URL (https, ssh or scp form), else null. */
export function repoFromRemote(url) {
  const m = /(?:^|[@/])github\.com[:/]([^/]+)\/([^/]+?)(\.git)?\/?$/.exec(url || "");
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * The top directory of the clone `dir` is in, its real path. A missing git, or a directory in no clone, throws one plain
 * line naming the fix, never git's own failure: a clone, or `instead` (the flag the command takes in its place).
 */
export function cloneTop(dir, instead = "--checkout CLONE") {
  const r = gitRan(gitTry(["-C", dir, "rev-parse", "--show-toplevel"]));
  if (r.status !== 0) {
    const said = String(r.stderr || "").trim().split("\n")[0];
    throw new Error(`${dir} is not in a git clone${said ? ` (git: ${said})` : ""}; run this in a clone of the repository, or pass ${instead}`);
  }
  return realpathSync(r.stdout.trim());
}

/**
 * The repository a command acts on: `repo` (--repo OWNER/NAME) when given, else the one the clone at `dir` has as its
 * origin remote, as `serve` finds it. A clone with no remote named origin, or an origin that is no GitHub repository,
 * throws one plain line naming the fix.
 */
export function cloneRepo(dir, repo = null) {
  if (repo) return repo;
  const top = cloneTop(dir, "--repo OWNER/NAME");
  const remotes = gitRan(gitTry(["-C", top, "remote"]));
  if (remotes.status !== 0 || !remotes.stdout.split("\n").includes("origin")) throw new Error(`the clone at ${top} has no remote named origin; add the GitHub repository as origin (git remote add origin https://github.com/OWNER/NAME.git), or pass --repo OWNER/NAME`);
  const url = gitRan(gitTry(["-C", top, "remote", "get-url", "origin"]));
  const full = url.status === 0 ? repoFromRemote(url.stdout.trim()) : null;
  if (!full) throw new Error(`the origin remote of the clone at ${top} is no github.com repository; pass --repo OWNER/NAME`);
  return full;
}
/** The permissions local mode's token needs, as the set-up and every message that asks for them name them. */
export const LOCAL_TOKEN_PERMISSIONS = "Contents, Issues and Pull requests read and write; Actions and Variables read";
/**
 * What local mode says when its token cannot list the repository's variables (HTTP `status`, 403 or 404): the variable
 * layer of its settings (inputs.mjs settingLayers) is off on this machine and the workflow's values stand.
 */
export const variablesRefusedLine = (status) => `the local token cannot read this repository's variables (HTTP ${status}), so its PENDULUM_* repository variables do not apply on this machine and the workflow's values stand; give the token Variables: read (docs/LOCAL.md, Set it up)`;

const workflowWarned = new Set();
/**
 * The adopter workflow's top-level `env:` block, so a local run uses the repository's own configuration, read from the
 * parsed file (yaml.mjs parseYaml): each PENDULUM_* key whose value is text. An empty value reads as "", as Actions sets
 * it; a plain number or boolean reads as written in the file (`25`, `true`), where Actions may write a number its own
 * way (`1.0` as `1`), so quote one to be sure. A value that is an Actions expression (`${{ ... }}`) has no meaning off a
 * runner and is left out, and so is a mapping or a list. A file that does not parse throws (code `WORKFLOW_PARSE`);
 * one with no env mapping to read is said through `warn`.
 */
export function workflowEnv(text, { warn = (line) => workflowWarned.has(line) || (workflowWarned.add(line), process.stderr.write(`${line}\n`)) } = {}) {
  let doc;
  try {
    doc = parseYaml(text);
  } catch (e) {
    throw Object.assign(new Error(`.github/workflows/pendulum.yml does not parse (${e.message})`), { code: "WORKFLOW_PARSE" });
  }
  const mapping = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  // An empty file, a scalar, or an `env:` that is no mapping holds no settings: said, never read silently as none.
  if (!mapping(doc) || !mapping(doc.env)) warn(`.github/workflows/pendulum.yml ${!mapping(doc) ? "is no mapping" : doc.env === undefined ? "has no top-level env block" : "has an env: that is no mapping"}: no settings read from it`);
  const env = mapping(doc) && mapping(doc.env) ? doc.env : {};
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (!/^PENDULUM_[A-Z0-9_]+$/.test(k)) continue;
    const value = v === null ? "" : v;
    if (typeof value === "string" && !value.includes("${{")) out[k] = value;
  }
  return out;
}

/** The working tree's workflow env block (workflowEnv); none when the file is absent, or does not parse (said once per process, on stderr). */
export function readWorkflowEnv(dir, { warn = (line) => workflowWarned.has(line) || (workflowWarned.add(line), process.stderr.write(`${line}\n`)) } = {}) {
  const file = join(dir, ".github", "workflows", "pendulum.yml");
  if (!existsSync(file)) return {};
  try {
    return workflowEnv(readFileSync(file, "utf8"));
  } catch (e) {
    warn(`warning: ${dir}'s ${e.message}; its settings are not read`);
    return {};
  }
}

/**
 * The workflow's env block as committed on the default branch (#122), which local mode reads its settings from: never
 * the working tree, whatever branch is checked out there, as the Action runs the reviewed workflow. The default branch is
 * origin's HEAD (else the remote's last known one), fetched first; offline, the last fetched commit. {wf, branch, error,
 * text}: `error` says why there is none (no default branch, no workflow file there), with `wf` empty and no `text`.
 */
export function committedWorkflowEnv(dir, { git = (args) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] }) } = {}) {
  const ok = (r) => (r.status === 0 ? String(r.stdout) : null);
  // No clone here (doctor run with --repo only): nothing to read the default branch from, which says nothing about serve.
  if (ok(git(["rev-parse", "--git-dir"])) === null) return { wf: {}, pins: [], branch: null, error: "no git clone here", noClone: true };
  const branch = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(ok(git(["ls-remote", "--symref", "origin", "HEAD"])) || "")?.[1] || (ok(git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])) || "").trim().replace(/^origin\//, "") || null;
  if (!branch) return { wf: {}, pins: [], branch: null, error: "origin's default branch could not be read" };
  git(["fetch", "-q", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  return committedWorkflow(ok(git(["show", `refs/remotes/origin/${branch}:.github/workflows/pendulum.yml`])), branch);
}

/**
 * committedWorkflowEnv's answer for the workflow file's text on origin/<branch> (null: no such file; one that does not
 * parse is the `error`, with `parseError`, and no settings: `serve`, `run` and `review` do not start on it).
 */
function committedWorkflow(text, branch) {
  if (text === null) return { wf: {}, pins: [], branch, error: `origin/${branch} has no .github/workflows/pendulum.yml` };
  try {
    return { wf: workflowEnv(text), pins: workflowPins(text), branch, error: null, text };
  } catch (e) {
    return { wf: {}, pins: [], branch, error: `origin/${branch}'s ${e.message}`, parseError: true };
  }
}

/**
 * The same read for a running `serve`, every few minutes (#276): the default branch serve found at its start, fetched now,
 * without blocking the loop's event loop while git talks to GitHub. A fetch that fails (offline) reads nothing:
 * `unfetched`, and serve keeps the settings it has, never an older commit's. The developer works in this clone
 * meanwhile, so the fetch writes only a ref of serve's own (refs/pendulum/serve/<branch>; --refmap= keeps git from
 * moving origin's ref with it) and no FETCH_HEAD: their own fetch never meets serve's lock on origin's ref, and their
 * `git pull` never merges what serve fetched. `git(args)` resolves to {code, stdout}.
 */
export async function committedWorkflowNow(dir, branch, { token = "", timeoutMs = 60_000, git = (args) => exec("git", ["-C", dir, ...args], { env: { ...localBaseEnv(process.env), PENDULUM_LOCAL_TOKEN: token, GIT_TERMINAL_PROMPT: "0" }, timeoutMs, group: true }) } = {}) {
  const own = `refs/pendulum/serve/${branch}`;
  // serve's own token for GitHub, never the developer's credential helper; no maintenance run in their clone; a stalled
  // transfer ends (http.lowSpeed*), and at the timeout the whole command does, every process it started included.
  const helper = '!f() { echo username=x-access-token; echo "password=$PENDULUM_LOCAL_TOKEN"; }; f';
  const safe = ["-c", "credential.helper=", "-c", `credential.https://github.com.helper=${helper}`, "-c", "core.fsmonitor=", "-c", "core.hooksPath=/dev/null", "-c", "http.lowSpeedLimit=1", "-c", "http.lowSpeedTime=60"];
  const fetched = await git([...safe, "fetch", "-q", "--no-tags", "--no-auto-maintenance", "--no-write-fetch-head", "--refmap=", "origin", `+refs/heads/${branch}:${own}`]).catch(() => null);
  if (fetched?.code !== 0) return { wf: {}, pins: [], branch, error: `origin/${branch} could not be fetched`, unfetched: true };
  const r = await git(["-c", "core.fsmonitor=", "show", `${own}:.github/workflows/pendulum.yml`]).catch(() => null);
  return committedWorkflow(r?.code === 0 ? String(r.stdout) : null, branch);
}

/**
 * The Pendulum refs a workflow's steps call (`uses: clockgrove/pendulum@<ref>` in jobs.<job>.steps), each once, in order of
 * first use: the release a repository pins. A workflow that does not parse pins nothing serve can follow.
 */
export function workflowPins(text) {
  let doc;
  try {
    doc = parseYaml(text);
  } catch {
    return [];
  }
  const refs = [];
  for (const job of Object.values(doc?.jobs && typeof doc.jobs === "object" ? doc.jobs : {})) {
    for (const step of Array.isArray(job?.steps) ? job.steps : []) {
      const ref = typeof step?.uses === "string" ? /^clockgrove\/pendulum@(\S+)$/.exec(step.uses.trim())?.[1] : null;
      if (ref && !refs.includes(ref)) refs.push(ref);
    }
  }
  return refs;
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
