// The Pendulum release a repository's workflow pins (`uses: clockgrove/pendulum@<ref>`), for a running `pendulum serve` to
// take at a stage boundary instead of a restart (#276): which checkout of Pendulum this process runs, whether a pin is
// one serve follows, and a verified checkout of that release to run from.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PENDULUM_VERSION } from "./inputs.mjs";
import { exec } from "./proc.mjs";

/** Pendulum's own repository: the only place serve fetches a release from, whatever else the workflow names. */
export const RELEASES_URL = "https://github.com/clockgrove/pendulum.git";
const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;
const COMMIT = /^[0-9a-f]{40}$/;

/** The checkout this process runs from: <root>/plugin/scripts/local.mjs is its loop. */
const OWN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
/** Where serve keeps the releases it fetched, a fresh checkout per switch (Pendulum's cache, read-only in every sandbox). */
export const releasesDir = (home = homedir()) => join(home, ".cache", "pendulum", "releases");

/**
 * This process's Pendulum: the release its plugin.json names; its commit when its root is a git checkout of its own (a
 * repository that vendors Pendulum has no commit of Pendulum's); and whether it is a release, which serve keeps current
 * with the workflow's pin (Local.followPin): a checkout serve fetched (releasesDir), or one at its own release's tag with
 * no tracked file changed. A branch, a commit between releases or a change of the developer's own is not.
 * {version, commit, root, release, dirty}: `dirty`, a tracked file changed in its own checkout.
 */
export function runningPendulum(root = OWN_ROOT, version = PENDULUM_VERSION, home = homedir()) {
  const git = (args) => {
    // No hook or file monitor a checkout's own config names runs here.
    const r = spawnSync("git", ["-C", root, "-c", "core.fsmonitor=", "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "ignore"] });
    return r.status === 0 ? r.stdout.trim() : null;
  };
  let commit = null;
  let fetched = false;
  try {
    const top = git(["rev-parse", "--show-toplevel"]);
    if (top !== null && realpathSync(top) === realpathSync(root)) commit = git(["rev-parse", "HEAD"]) || null;
    fetched = existsSync(releasesDir(home)) && dirname(realpathSync(root)) === realpathSync(releasesDir(home));
  } catch {
    commit = null;
  }
  // A checkout serve fetched is a release as it stands (checked against its manifest before serve ran it): no `git status`
  // there, which would run a filter its config names in this process.
  const dirty = !fetched && !!commit && git(["status", "--porcelain", "--untracked-files=no"]) !== "";
  const atTag = !fetched && !!commit && git(["rev-parse", "--verify", "-q", `refs/tags/v${version}^{commit}`]) === commit && !dirty;
  return { version, commit, root, release: !!commit && (fetched || atTag), dirty };
}

/**
 * The Pendulum build this process runs, as the records it writes name it (#565): its release version (plugin.json's)
 * when it is that release, else that version with the build it really is as semver build metadata
 * (`0.10.2+1a2b3c4d5e6f`), so a candidate between releases never records itself as the last tag. On GitHub Actions the
 * build is the ref the workflow's `uses:` named, which action.yml passes as PENDULUM_ACTION_REF (`github.action_ref`):
 * the release's tag, or a moving tag of its line (`v0`, `v0.10`), is the release; a commit SHA is its first 12
 * characters (a SHA pin of a release too: a SHA is never taken for a tag); any other ref (a branch) is its name, and
 * none given is `+unknown`. Elsewhere it is runningPendulum's: a release, or a git checkout of Pendulum's own at a
 * commit that is not its release (`+<commit>`, `.dirty` with a tracked file changed). A copy with no git checkout of
 * its own (an installed plugin) is taken as its manifest's release.
 */
export function pendulumBuild({ env = process.env, version = PENDULUM_VERSION, running = null } = {}) {
  const meta = (m) => `${version}+${String(m).replace(/[^A-Za-z0-9.-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 40) || "unknown"}`;
  if (env.GITHUB_ACTIONS) {
    const ref = String(env.PENDULUM_ACTION_REF || "").trim();
    const [major, minor] = version.split(".");
    if (ref === `v${version}` || ref === `v${major}` || ref === `v${major}.${minor}`) return version;
    return meta(!ref ? "unknown" : COMMIT.test(ref) ? ref.slice(0, 12) : ref);
  }
  const r = running ?? (OWN_BUILD.running ??= runningPendulum());
  if (!r?.commit || r.release) return version;
  return meta(`${r.commit.slice(0, 12)}${r.dirty ? ".dirty" : ""}`);
}
const OWN_BUILD = { running: null };

/** How this Pendulum names itself in serve's log: its release, and its commit when known. */
export const runningName = (running) => `v${running.version}${running.commit ? ` (${running.commit.slice(0, 7)})` : ""}`;

/** A release tag's version as numbers, for order. */
const versionOf = (v) => String(v).replace(/^v/, "").split(".").map(Number);
/** Whether release `a` is older than release `b` (both X.Y.Z, with or without the v). */
export const olderRelease = (a, b) => {
  const [x, y] = [versionOf(a), versionOf(b)];
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
};

/** What serve says of a pin to an older Pendulum, which it never takes by itself. */
export const DOWNGRADE_LINE = "the pin is older than what serve runs; start serve from it yourself to downgrade";

/**
 * What serve does with the workflow's Pendulum pins (lib/local.mjs workflowPins) against the Pendulum it runs:
 * `{same: true}` (nothing to take: the same release or commit, or no pin), `{follow: true, ref}` (a later release tag
 * vX.Y.Z, or a full commit SHA, which releaseCheckout takes only when it comes after the running commit), or
 * `{follow: false, ref, why}` (a pin serve runs no code from: a branch, a short SHA, a moving tag, steps that disagree,
 * or an older release: a release before this one would never follow a pin again, and lacks this one's fixes).
 */
export function pinDecision(pins, running) {
  if (!pins?.length) return { same: true };
  if (pins.length > 1) return { follow: false, ref: pins.join(", "), why: `the workflow's steps call clockgrove/pendulum at more than one ref (${pins.join(", ")})` };
  const [ref] = pins;
  if (RELEASE_TAG.test(ref)) {
    if (ref === `v${running.version}`) return { same: true };
    return olderRelease(ref, running.version) ? { follow: false, ref, older: true, why: `clockgrove/pendulum@${ref}: ${DOWNGRADE_LINE}` } : { follow: true, ref };
  }
  if (COMMIT.test(ref)) return ref === running.commit ? { same: true } : { follow: true, ref };
  return { follow: false, ref, why: `clockgrove/pendulum@${ref} is neither a release tag (vX.Y.Z) nor a full commit SHA` };
}

/**
 * Git for a release: none of this machine's git config (no url.insteadOf, credential helper, hook or file monitor), no
 * GIT_* variable from this shell, and a home of its own with no .netrc, so nothing redirects the fetch or sends a token.
 */
function releaseGitEnv(home) {
  const own = join(releasesDir(home), ".home");
  mkdirSync(own, { recursive: true, mode: 0o700 });
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
  return { ...env, HOME: own, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" };
}
/**
 * No helper, hook or file monitor; a transfer slower than a byte a second for a minute ends (http.lowSpeed*), and so does
 * the whole command at its timeout, with every process it started (`group`: git-remote-https keeps the pipe open past
 * git itself), so a stalled fetch fails and is tried again, never hangs.
 */
export const GIT_SAFE = ["-c", "credential.helper=", "-c", "core.fsmonitor=", "-c", "core.hooksPath=/dev/null", "-c", "http.lowSpeedLimit=1", "-c", "http.lowSpeedTime=60"];
const defaultGit =
  (home, timeoutMs = 5 * 60_000) =>
  (cwd, args) =>
    exec("git", [...GIT_SAFE, ...args], { cwd, env: releaseGitEnv(home), timeoutMs, group: true });

/**
 * Why the checkout at `dir`, just fetched, is not exactly `ref` of Pendulum, or null: HEAD the commit fetched, every
 * tracked file plain (no assume-unchanged or skip-worktree flag), none changed, none added (ignored ones included), and a
 * tag's plugin.json naming that release. Run on a checkout serve made a moment ago with a config of its own.
 */
function fetchedProblem({ dir, commit, ref }, home) {
  const git = (args) => spawnSync("git", ["-C", dir, ...GIT_SAFE, ...args], { encoding: "utf8", timeout: 60_000, env: releaseGitEnv(home), stdio: ["ignore", "pipe", "ignore"] });
  const out = (args) => {
    const r = git(args);
    return r.status === 0 ? r.stdout : null;
  };
  if ((out(["rev-parse", "HEAD"]) || "").trim() !== commit) return "its HEAD is not the commit fetched";
  const files = out(["ls-files", "-v"]);
  if (files === null || files.split("\n").some((l) => l && !l.startsWith("H "))) return "a tracked file is flagged to hide its changes";
  if (git(["diff", "--no-ext-diff", "--no-textconv", "--quiet", "HEAD"]).status !== 0) return "a tracked file changed";
  if (out(["status", "--porcelain", "--untracked-files=all", "--ignored"]) !== "") return "a file was added";
  if (!existsSync(join(dir, "plugin", "scripts", "local.mjs"))) return "it has no loop";
  try {
    const { version } = JSON.parse(readFileSync(join(dir, "plugin", ".claude-plugin", "plugin.json"), "utf8"));
    if (RELEASE_TAG.test(ref) && `v${version}` !== ref) return `its plugin.json names v${version}`;
  } catch {
    return "its plugin.json does not read";
  }
  return null;
}

/**
 * Every entry under `dir`, its .git included, by relative path: a file's mode and SHA-256, a link's target, a directory,
 * or another kind. Read with no git, so nothing the checkout's own config names runs.
 */
export function treeManifest(dir) {
  const out = {};
  const walk = (rel) => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      const path = rel ? `${rel}/${name}` : name;
      const st = lstatSync(join(dir, path));
      if (st.isDirectory()) {
        out[path] = "dir";
        walk(path);
      } else if (st.isSymbolicLink()) out[path] = `link ${readlinkSync(join(dir, path))}`;
      else if (st.isFile()) out[path] = `file ${(st.mode & 0o777).toString(8)} ${createHash("sha256").update(readFileSync(join(dir, path))).digest("hex")}`;
      else out[path] = "other";
    }
  };
  walk("");
  return out;
}

/**
 * Why the checkout serve fetched (releaseCheckout's {dir, manifest}) is no longer what it fetched, or null: every entry
 * hashed again and compared with the manifest serve took at its fetch and kept in its own memory, which no sandbox reaches.
 * Run right before serve starts on it (Local.restartOn).
 */
export function checkoutProblem({ dir, manifest }) {
  let now;
  try {
    now = treeManifest(dir);
  } catch (e) {
    return `it cannot be read (${e.code || e.message})`;
  }
  for (const [path, entry] of Object.entries(manifest || {})) if (now[path] !== entry) return `${path} ${now[path] === undefined ? "is gone" : "changed"}`;
  const added = Object.keys(now).find((path) => !(path in (manifest || {})));
  return added ? `${added} was added` : null;
}

/** Where each live serve on this machine names the release checkout it runs from (markInUse), one file per process. */
const inUseDir = (home) => join(releasesDir(home), ".in-use");

/**
 * Name `root` as the checkout this process runs from, when it is one of releasesDir's, so that no serve on this machine
 * prunes it (pruneReleases) while this process lives. Another root is not named.
 */
export function markInUse(root, { home = homedir(), pid = process.pid } = {}) {
  try {
    if (!existsSync(releasesDir(home)) || dirname(realpathSync(root)) !== realpathSync(releasesDir(home))) return;
    mkdirSync(inUseDir(home), { recursive: true, mode: 0o700 });
    writeFileSync(join(inUseDir(home), String(pid)), realpathSync(root));
  } catch {
    // Not named: the newest checkouts are kept all the same.
  }
}

/** The checkouts live serves on this machine run from (markInUse); a dead process's name goes. */
function inUse(home) {
  const roots = [];
  let names = [];
  try {
    names = readdirSync(inUseDir(home));
  } catch {
    return roots;
  }
  for (const n of names) {
    const file = join(inUseDir(home), n);
    let alive = false;
    try {
      process.kill(Number(n), 0);
      alive = /^\d+$/.test(n);
    } catch (e) {
      alive = e.code === "EPERM";
    }
    // Another serve's prune may remove a name as this one reads it: a name that does not read keeps nothing.
    if (!alive) rmSync(file, { force: true });
    else
      try {
        roots.push(readFileSync(file, "utf8").trim());
      } catch {
        // gone meanwhile
      }
  }
  return roots;
}

/** Entries of releasesDir serve keeps besides the ones live serves run: the newest few. */
export const RELEASES_KEPT = 3;

/**
 * Remove the release checkouts in releasesDir past the newest RELEASES_KEPT, never `keep` (the one serve runs, and the one
 * it switches to), one any live serve on this machine runs (markInUse), nor a fetch under way (a `.part` less than an
 * hour old).
 */
export function pruneReleases(home = homedir(), keep = []) {
  const root = releasesDir(home);
  let names = [];
  try {
    names = readdirSync(root).filter((n) => !n.startsWith("."));
  } catch {
    return;
  }
  // Real paths on both sides: a home or ~/.cache behind a link names the same checkouts.
  const real = (d) => {
    try {
      return realpathSync(d);
    } catch {
      return resolve(d);
    }
  };
  const kept = new Set([...keep, ...inUse(home)].map(real));
  const base = real(root);
  const entries = names.map((n) => ({ dir: join(base, n), part: n.endsWith(".part"), at: statSync(join(base, n), { throwIfNoEntry: false })?.mtimeMs ?? 0 }));
  const done = entries.filter((e) => !e.part).sort((a, b) => b.at - a.at);
  const gone = [...done.slice(RELEASES_KEPT), ...entries.filter((e) => e.part && Date.now() - e.at > 60 * 60_000)];
  for (const e of gone) if (!kept.has(real(e.dir))) rmSync(e.dir, { recursive: true, force: true });
}

/**
 * A fresh checkout of Pendulum at `ref` (a release tag or a full SHA the workflow names, pinDecision), fetched from
 * Pendulum's own repository only, into a new directory of releasesDir each time: nothing kept from an earlier fetch is
 * trusted. A tag's one commit; for a SHA, Pendulum's main, which must contain it and the commit serve runs (`running`), so
 * serve never moves back to an earlier one by itself. Throws with what failed (`code` "older" for a downgrade, "refused"
 * for a SHA not on main: neither is tried again until the pin changes); the checkouts past the newest few go
 * (pruneReleases). {dir, commit, ref, version, manifest} (treeManifest, taken once the checkout is verified).
 */
export async function releaseCheckout(ref, { home = homedir(), url = RELEASES_URL, timeoutMs = 5 * 60_000, git = defaultGit(home, timeoutMs), running = null } = {}) {
  const tag = RELEASE_TAG.test(ref);
  if (!tag && !COMMIT.test(ref)) throw new Error(`clockgrove/pendulum@${ref} is neither a release tag nor a full commit SHA`);
  const root = releasesDir(home);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = join(root, `${ref}-${Date.now().toString(36)}${randomBytes(3).toString("hex")}`);
  const part = `${dir}.part`;
  const must = async (cwd, args, what) => {
    const r = await git(cwd, args);
    if (r.code !== 0) throw new Error(`${what}: ${String(r.stderr || "").trim().slice(0, 300) || `git exited ${r.code ?? r.signal}`}`);
    return r;
  };
  try {
    await must(root, ["init", "-q", part], "git init");
    await must(part, ["remote", "add", "origin", url], "git remote add");
    if (tag) await must(part, ["fetch", "-q", "--no-tags", "--depth", "1", "origin", `+refs/tags/${ref}:refs/tags/${ref}`], `fetching ${ref} from ${url}`);
    else {
      await must(part, ["fetch", "-q", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"], `fetching main from ${url}`);
      // Not there at all, or not on main: not taken until the pin changes (a fetch of all of main each time would follow).
      if ((await git(part, ["merge-base", "--is-ancestor", ref, "refs/remotes/origin/main"])).code !== 0) throw Object.assign(new Error(`clockgrove/pendulum@${ref} is not a commit on ${url}'s main`), { code: "refused" });
      if (!running?.commit || (await git(part, ["merge-base", "--is-ancestor", running.commit, ref])).code !== 0) throw Object.assign(new Error(`clockgrove/pendulum@${ref}: ${DOWNGRADE_LINE} (it does not come after ${running?.commit ? running.commit.slice(0, 7) : "the commit serve runs"} on Pendulum's main)`), { code: "older" });
    }
    const commit = String((await must(part, ["rev-parse", "--verify", tag ? `refs/tags/${ref}^{commit}` : `${ref}^{commit}`], `resolving ${ref}`)).stdout).trim();
    await must(part, ["-c", "advice.detachedHead=false", "checkout", "-q", "--detach", commit], `checking out ${ref}`);
    const problem = fetchedProblem({ dir: part, commit, ref }, home);
    if (problem) throw new Error(`the checkout of ${ref} is not ${tag ? "that release" : "that commit"}: ${problem}`);
    renameSync(part, dir);
    const { version } = JSON.parse(readFileSync(join(dir, "plugin", ".claude-plugin", "plugin.json"), "utf8"));
    // Its manifest, kept in this process only: what restartOn checks the checkout against before it runs it.
    const manifest = treeManifest(dir);
    // Tidying the cache never fails a fetch that succeeded.
    try {
      pruneReleases(home, [dir, ...(running?.root ? [running.root] : [])]);
    } catch {
      // left for the next fetch
    }
    return { dir, commit, ref, version, manifest };
  } finally {
    rmSync(part, { recursive: true, force: true });
  }
}

/** Whether the loop of the checkout at `dir` loads on this Node, with nothing of this shell's env: its usage, exit 0. A reason, or null. */
export async function startProblem(dir) {
  const r = await exec(process.execPath, [join(dir, "plugin", "scripts", "local.mjs"), "--help"], { cwd: dir, env: { PATH: process.env.PATH || "" }, timeoutMs: 60_000 }).catch((e) => ({ code: null, stderr: e.message }));
  return r.code === 0 ? null : `its loop does not start on this Node (${String(r.stderr || `exit ${r.code ?? r.signal}`).trim().slice(0, 200)})`;
}
