// The Factory release a repository's workflow pins (`uses: clockgrove/factory@<ref>`), for a running `factory serve` to
// take at a stage boundary instead of a restart (#276): which checkout of Factory this process runs, whether a pin is
// one serve follows, and a verified checkout of that release to run from.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FACTORY_VERSION } from "./inputs.mjs";
import { exec } from "./proc.mjs";

/** Factory's own repository: the only place serve fetches a release from, whatever else the workflow names. */
export const RELEASES_URL = "https://github.com/clockgrove/factory.git";
const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;
const COMMIT = /^[0-9a-f]{40}$/;

/** The checkout this process runs from: <root>/plugin/scripts/local.mjs is its loop. */
const OWN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
/** Where serve keeps the releases it fetched, a fresh checkout per switch (Factory's cache, read-only in every sandbox). */
export const releasesDir = (home = homedir()) => join(home, ".cache", "factory", "releases");

/**
 * This process's Factory: the release its plugin.json names; its commit when its root is a git checkout of its own (a
 * repository that vendors Factory has no commit of Factory's); and whether it is a release, which serve keeps current
 * with the workflow's pin (Local.followPin): a checkout serve fetched (releasesDir), or one at its own release's tag with
 * no tracked file changed. A branch, a commit between releases or a change of the developer's own is not.
 * {version, commit, root, release}.
 */
export function runningFactory(root = OWN_ROOT, version = FACTORY_VERSION, home = homedir()) {
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
  const atTag = !!commit && git(["rev-parse", "--verify", "-q", `refs/tags/v${version}^{commit}`]) === commit && git(["status", "--porcelain", "--untracked-files=no"]) === "";
  return { version, commit, root, release: !!commit && (fetched || atTag) };
}

/** How this Factory names itself in serve's log: its release, and its commit when known. */
export const runningName = (running) => `v${running.version}${running.commit ? ` (${running.commit.slice(0, 7)})` : ""}`;

/** A release tag's version as numbers, for order. */
const versionOf = (v) => String(v).replace(/^v/, "").split(".").map(Number);
/** Whether release `a` is older than release `b` (both X.Y.Z, with or without the v). */
export const olderRelease = (a, b) => {
  const [x, y] = [versionOf(a), versionOf(b)];
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
};

/** What serve says of a pin to an older Factory, which it never takes by itself. */
export const DOWNGRADE_LINE = "the pin is older than what serve runs; start serve from it yourself to downgrade";

/**
 * What serve does with the workflow's Factory pins (lib/local.mjs workflowPins) against the Factory it runs:
 * `{same: true}` (nothing to take: the same release or commit, or no pin), `{follow: true, ref}` (a later release tag
 * vX.Y.Z, or a full commit SHA, which releaseCheckout takes only when it comes after the running commit), or
 * `{follow: false, ref, why}` (a pin serve runs no code from: a branch, a short SHA, a moving tag, steps that disagree,
 * or an older release: a release before this one would never follow a pin again, and lacks this one's fixes).
 */
export function pinDecision(pins, running) {
  if (!pins?.length) return { same: true };
  if (pins.length > 1) return { follow: false, ref: pins.join(", "), why: `the workflow's steps call clockgrove/factory at more than one ref (${pins.join(", ")})` };
  const [ref] = pins;
  if (RELEASE_TAG.test(ref)) {
    if (ref === `v${running.version}`) return { same: true };
    return olderRelease(ref, running.version) ? { follow: false, ref, older: true, why: `clockgrove/factory@${ref}: ${DOWNGRADE_LINE}` } : { follow: true, ref };
  }
  if (COMMIT.test(ref)) return ref === running.commit ? { same: true } : { follow: true, ref };
  return { follow: false, ref, why: `clockgrove/factory@${ref} is neither a release tag (vX.Y.Z) nor a full commit SHA` };
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
const GIT_SAFE = ["-c", "credential.helper=", "-c", "core.fsmonitor=", "-c", "core.hooksPath=/dev/null"];
const defaultGit = (home) => (cwd, args) => exec("git", [...GIT_SAFE, ...args], { cwd, env: releaseGitEnv(home), timeoutMs: 5 * 60_000 });

/**
 * Why the checkout serve fetched for a release (releaseCheckout's {dir, commit, ref}) is no longer exactly that release,
 * or null: HEAD the commit it was fetched at, every tracked file plain (no assume-unchanged or skip-worktree flag that
 * would hide a change), no change to one, no file added (ignored ones included), the loop present, and a tag's
 * plugin.json naming that release. Synchronous: run again right before serve starts on it (Local.restartOn).
 */
export function checkoutProblem({ dir, commit, ref }, { home = homedir() } = {}) {
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

/** Entries of releasesDir serve keeps besides the one it runs: the newest few. */
export const RELEASES_KEPT = 3;

/**
 * Remove the release checkouts in releasesDir past the newest RELEASES_KEPT, never `keep` (the one serve runs, and the one
 * it switches to), nor a fetch under way (a `.part` less than an hour old).
 */
export function pruneReleases(home = homedir(), keep = []) {
  const root = releasesDir(home);
  let names = [];
  try {
    names = readdirSync(root).filter((n) => !n.startsWith("."));
  } catch {
    return;
  }
  const kept = new Set(keep.map((d) => resolve(d)));
  const entries = names.map((n) => ({ dir: join(root, n), part: n.endsWith(".part"), at: statSync(join(root, n), { throwIfNoEntry: false })?.mtimeMs ?? 0 }));
  const done = entries.filter((e) => !e.part).sort((a, b) => b.at - a.at);
  const gone = [...done.slice(RELEASES_KEPT), ...entries.filter((e) => e.part && Date.now() - e.at > 60 * 60_000)];
  for (const e of gone) if (!kept.has(resolve(e.dir))) rmSync(e.dir, { recursive: true, force: true });
}

/**
 * A fresh checkout of Factory at `ref` (a release tag or a full SHA the workflow names, pinDecision), fetched from
 * Factory's own repository only, into a new directory of releasesDir each time: nothing kept from an earlier fetch is
 * trusted. A tag's one commit; for a SHA, Factory's main, which must contain it and the commit serve runs (`running`), so
 * serve never moves back to an earlier one by itself. Throws with what failed (`code` "older" for a downgrade); the
 * checkouts past the newest few go (pruneReleases). {dir, commit, ref, version}.
 */
export async function releaseCheckout(ref, { home = homedir(), url = RELEASES_URL, git = defaultGit(home), running = null } = {}) {
  const tag = RELEASE_TAG.test(ref);
  if (!tag && !COMMIT.test(ref)) throw new Error(`clockgrove/factory@${ref} is neither a release tag nor a full commit SHA`);
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
      if ((await git(part, ["merge-base", "--is-ancestor", ref, "refs/remotes/origin/main"])).code !== 0) throw new Error(`${ref} is not a commit on ${url}'s main`);
      if (!running?.commit || (await git(part, ["merge-base", "--is-ancestor", running.commit, ref])).code !== 0) throw Object.assign(new Error(`clockgrove/factory@${ref}: ${DOWNGRADE_LINE} (it does not come after ${running?.commit ? running.commit.slice(0, 7) : "the commit serve runs"} on Factory's main)`), { code: "older" });
    }
    const commit = String((await must(part, ["rev-parse", "--verify", tag ? `refs/tags/${ref}^{commit}` : `${ref}^{commit}`], `resolving ${ref}`)).stdout).trim();
    await must(part, ["-c", "advice.detachedHead=false", "checkout", "-q", "--detach", commit], `checking out ${ref}`);
    const problem = checkoutProblem({ dir: part, commit, ref }, { home });
    if (problem) throw new Error(`the checkout of ${ref} is not ${tag ? "that release" : "that commit"}: ${problem}`);
    renameSync(part, dir);
    const { version } = JSON.parse(readFileSync(join(dir, "plugin", ".claude-plugin", "plugin.json"), "utf8"));
    pruneReleases(home, [dir, ...(running?.root ? [running.root] : [])]);
    return { dir, commit, ref, version };
  } finally {
    rmSync(part, { recursive: true, force: true });
  }
}

/** Whether the loop of the checkout at `dir` loads on this Node, with nothing of this shell's env: its usage, exit 0. A reason, or null. */
export async function startProblem(dir) {
  const r = await exec(process.execPath, [join(dir, "plugin", "scripts", "local.mjs"), "--help"], { cwd: dir, env: { PATH: process.env.PATH || "" }, timeoutMs: 60_000 }).catch((e) => ({ code: null, stderr: e.message }));
  return r.code === 0 ? null : `its loop does not start on this Node (${String(r.stderr || `exit ${r.code ?? r.signal}`).trim().slice(0, 200)})`;
}
