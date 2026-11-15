// The Factory release a repository's workflow pins (`uses: clockgrove/factory@<ref>`), for a running `factory serve` to
// take at a stage boundary instead of a restart (#276): which checkout of Factory this process runs, whether a pin is
// one serve follows, and a verified checkout of that release to run from.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
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
/** Where serve keeps the releases it fetched, one checkout per ref (Factory's cache, which no sandbox may write). */
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
    const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "ignore"] });
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

/**
 * What serve does with the workflow's Factory pins (lib/local.mjs workflowPins) against the Factory it runs:
 * `{same: true}` (nothing to take: the same release or commit, or no pin), `{follow: true, ref}` (a release tag vX.Y.Z or a
 * full commit SHA serve can take), or `{follow: false, ref, why}` (a pin serve does not run code from: a branch, a short
 * SHA, a moving tag, or steps that disagree).
 */
export function pinDecision(pins, running) {
  if (!pins?.length) return { same: true };
  if (pins.length > 1) return { follow: false, ref: pins.join(", "), why: `the workflow's steps call clockgrove/factory at more than one ref (${pins.join(", ")})` };
  const [ref] = pins;
  if (RELEASE_TAG.test(ref)) return ref === `v${running.version}` ? { same: true } : { follow: true, ref };
  if (COMMIT.test(ref)) return ref === running.commit ? { same: true } : { follow: true, ref };
  return { follow: false, ref, why: `clockgrove/factory@${ref} is neither a release tag (vX.Y.Z) nor a full commit SHA` };
}

const gitEnv = () => ({ ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" });
const defaultGit = (cwd, args) => exec("git", ["-c", "credential.helper=", ...args], { cwd, env: gitEnv(), timeoutMs: 5 * 60_000 });

/**
 * The checkout at `dir` when it is exactly `ref` of Factory, untouched: HEAD the tag's commit (a tag) or the SHA itself on
 * Factory's main (a SHA), no change to a tracked file and no file added, the loop present, and a tag's plugin.json naming
 * that release. {dir, commit, version} or null.
 */
async function verified(dir, ref, git) {
  const out = async (args) => {
    const r = await git(dir, args).catch(() => null);
    return r?.code === 0 ? String(r.stdout).trim() : null;
  };
  const head = await out(["rev-parse", "HEAD"]);
  if (!head) return null;
  const tag = RELEASE_TAG.test(ref);
  const want = tag ? await out(["rev-parse", "--verify", "-q", `refs/tags/${ref}^{commit}`]) : ref;
  if (head !== want) return null;
  if (!tag && (await git(dir, ["merge-base", "--is-ancestor", ref, "refs/remotes/origin/main"]).catch(() => null))?.code !== 0) return null;
  if ((await out(["status", "--porcelain", "--untracked-files=all"])) !== "") return null;
  if (!existsSync(join(dir, "plugin", "scripts", "local.mjs"))) return null;
  let version = null;
  try {
    version = JSON.parse(readFileSync(join(dir, "plugin", ".claude-plugin", "plugin.json"), "utf8")).version;
  } catch {
    return null;
  }
  if (tag && `v${version}` !== ref) return null;
  return { dir, commit: head, version };
}

/**
 * A checkout of Factory at `ref` (a release tag or a full SHA the workflow names, pinDecision), fetched from Factory's own
 * repository only: a tag's one commit, or for a SHA Factory's main, which must contain it. Kept in releasesDir by ref
 * and verified on every use; one that fails the check is fetched again. Throws with what failed.
 */
export async function releaseCheckout(ref, { home = homedir(), url = RELEASES_URL, git = defaultGit } = {}) {
  const tag = RELEASE_TAG.test(ref);
  if (!tag && !COMMIT.test(ref)) throw new Error(`clockgrove/factory@${ref} is neither a release tag nor a full commit SHA`);
  const root = releasesDir(home);
  const dir = join(root, ref);
  if (existsSync(dir)) {
    const kept = await verified(dir, ref, git);
    if (kept) return kept;
    rmSync(dir, { recursive: true, force: true });
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const part = `${dir}.${randomBytes(4).toString("hex")}.part`;
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
    }
    await must(part, ["-c", "advice.detachedHead=false", "checkout", "-q", "--detach", tag ? `refs/tags/${ref}^{commit}` : ref], `checking out ${ref}`);
    const ok = await verified(part, ref, git);
    if (!ok) throw new Error(`the checkout of ${ref} is not ${tag ? "that release" : "that commit"} (its plugin.json, HEAD or files differ)`);
    try {
      renameSync(part, dir);
    } catch (e) {
      // Another serve on this machine put the same release there first: theirs is used once it checks out the same.
      const theirs = existsSync(dir) ? await verified(dir, ref, git) : null;
      if (theirs) return theirs;
      throw e;
    }
    return { ...ok, dir };
  } finally {
    rmSync(part, { recursive: true, force: true });
  }
}

/** Whether the loop of the checkout at `dir` loads on this Node: its usage, exit 0. A reason, or null. */
export async function startProblem(dir) {
  const r = await exec(process.execPath, [join(dir, "plugin", "scripts", "local.mjs"), "--help"], { timeoutMs: 60_000 }).catch((e) => ({ code: null, stderr: e.message }));
  return r.code === 0 ? null : `its loop does not start on this Node (${String(r.stderr || `exit ${r.code ?? r.signal}`).trim().slice(0, 200)})`;
}
