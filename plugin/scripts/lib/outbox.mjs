// Factory's push. The harness commits in its own checkout and pushes nothing. Factory takes the branch as a git bundle
// the agent writes to a pipe (in the agent's own sandbox), fetches it into a bare mirror only Factory can write (made
// with mkdtemp under Factory's private temp directory, transfer.fsckObjects on), checks it there (protected paths, Git
// LFS pointers and media), pushes it to refs/heads/factory/<issue> with an explicit lease on the head Factory last
// saw, and reads GitHub's head back. A refused or rejected push, or a head that is not the one pushed, is sticky: the
// stage Blocks. Factory runs no git command of its own in the agent's checkout for this.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants as C, createReadStream, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backend } from "./backend.mjs";
import { stageChanges } from "./checkout.mjs";
import { LEGACY_POINTER_HEAD, lfsEndpoint, lfsPinArgs, lfsQuotaLine, lfsVersion, localMediaCapMb, noReplace, noSmudge, plainLfsBlobs, POINTER_HEAD } from "./lfs.mjs";
import { WORKSPACE_FILES, fixScopeReason, fixScopeRefused, membershipOnly, protectedTouched, pushRefusal, settingsFile, workflowScopeReason, workflowScopeRefused, workspaceDeclarations, workspaceLockDirs } from "./logic.mjs";
import { agentUser, exec, runnerCommand, sudoEnv } from "./proc.mjs";
import { heldSecrets, secretForms } from "./inputs.mjs";

/** Why a push that carries a held secret is refused: Factory's own words, never the value. */
export const SECRET_PUSH_REASON = "the branch carries a worker secret's value (in a commit's change or message), so nothing was pushed: remove it from the branch's history and rotate the key (docs/PLAN.md, Worker secrets)";

/** Whether `text` (a branch's patches and commit messages) carries any form of a held secret (inputs.mjs secretForms). */
export function carriesSecret(text, values = heldSecrets()) {
  const t = String(text || "");
  return values.flatMap(secretForms).some((f) => t.includes(f));
}

/** The most of `git log -p` the scan reads: a little below V8's longest string (536,870,888 bytes). */
export const SECRET_SCAN_MAX_BYTES = 536_000_000;

/**
 * Why the commits in `range` may not be pushed for the held secrets, or null: every commit's change and message, a merge
 * commit's against its first parent (where a value its resolution adds would show). It fails closed: an unreadable or
 * truncated log refuses too. `git(args, opts)` runs git in Factory's mirror.
 */
export async function secretScan(git, range, held = heldSecrets(), maxBytes = SECRET_SCAN_MAX_BYTES) {
  if (!held.length) return null;
  const patches = await git(["log", "-p", "--diff-merges=first-parent", "-U0", "--no-color", "--no-ext-diff", "--text", "--format=%B", range], { maxBytes });
  if (patches.code !== 0 || patches.truncated) return "the branch's commits could not be read whole for worker secrets, so nothing was pushed";
  return carriesSecret(patches.stdout, held) ? SECRET_PUSH_REASON : null;
}

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * What a failed git command said, for a log line or a Blocked reason: each `error:` or `fatal:` line with the paths git
 * lists under it (five at most), not its closing line ("Aborting" names no cause). A line with none of those: the first
 * line. Credentials in a URL and GitHub tokens are masked; at most 300 characters.
 */
export function gitError(stderr) {
  const lines = String(stderr ?? "").split("\n").map((l) => l.replace(/\s+$/, "")).filter(Boolean);
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^(error|fatal): /.test(lines[i])) continue;
    const head = lines[i];
    const paths = [];
    while (i + 1 < lines.length && /^\s/.test(lines[i + 1])) paths.push(lines[++i].trim());
    const shown = paths.slice(0, 5).join(", ") + (paths.length > 5 ? ` (+${paths.length - 5} more)` : "");
    blocks.push(shown ? `${head} ${shown}` : head);
  }
  const text = (blocks.length ? blocks.join("; ") : lines[0] ?? "").replace(/(\w+:\/\/)[^\s/@'"]+@/g, "$1***@").replace(/\b(gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,})/g, "***");
  return text.slice(0, 300);
}
/** Where GitHub reads workflows from: a token without the Workflows permission may not create or update a file here. */
const WORKFLOWS = ".github/workflows/";

/**
 * Run `cmd` and stream its stdout into a new file (O_EXCL, O_NOFOLLOW), at most `cap` bytes. Resolves
 * {code, stderr, bytes, over}. The bundle and LFS objects come through here: read as the agent, written as Factory.
 */
export function pipeToFile(cmd, args, { cwd, env, file, cap }) {
  return new Promise((resolve, reject) => {
    const fd = openSync(file, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);
    const isSudo = cmd === "sudo" || cmd === "/usr/bin/sudo";
    if (!isSudo && agentUser() && !cmd.includes("/")) [cmd, env] = runnerCommand(cmd, env);
    const child = spawn(cmd, args, { cwd, env: isSudo ? sudoEnv(args, env) : env, stdio: ["ignore", "pipe", "pipe"] });
    let bytes = 0;
    let over = false;
    const err = [];
    child.stdout.on("data", (chunk) => {
      if (over) return;
      bytes += chunk.length;
      if (bytes > cap) {
        over = true;
        child.kill("SIGKILL");
        return;
      }
      writeSync(fd, chunk);
    });
    child.stderr.on("data", (c) => err.push(c));
    child.on("error", (e) => {
      closeSync(fd);
      reject(e);
    });
    child.on("close", (code) => {
      closeSync(fd);
      resolve({ code, stderr: Buffer.concat(err).toString("utf8"), bytes, over });
    });
  });
}

/** sha256 and size of a file Factory owns. */
function digest(file) {
  const fd = openSync(file, C.O_RDONLY | C.O_NOFOLLOW);
  try {
    const h = createHash("sha256");
    const buf = Buffer.alloc(1 << 20);
    let n;
    while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
    return { sha256: h.digest("hex"), size: fstatSync(fd).size };
  } finally {
    closeSync(fd);
  }
}

/** A Git LFS pointer's {oid, size}, from a blob's text, or null (both spec versions git-lfs reads). */
export function parsePointer(text) {
  const lines = String(text).split("\n");
  if (lines[0] !== POINTER_HEAD && lines[0] !== LEGACY_POINTER_HEAD) return null;
  const oid = /^oid sha256:([0-9a-f]{64})$/m.exec(text)?.[1];
  const size = Number(/^size (\d+)$/m.exec(text)?.[1]);
  return oid && Number.isFinite(size) ? { oid, size } : null;
}

/**
 * The git credential helper for Factory's own network calls, as env config (so every git and git-lfs process in the
 * mirror has it, and nothing on disk does): no inherited helper, and for https://github.com only, the token from that
 * one process's env.
 */
const HELPER = "!f() { echo username=x-access-token; echo \"password=$FACTORY_GIT_TOKEN\"; }; f";
/** Add [key, value] pairs to an env's GIT_CONFIG_* list. */
export function addConfig(env, pairs) {
  let n = Number(env.GIT_CONFIG_COUNT) || 0;
  const out = { ...env };
  for (const [k, v] of pairs) {
    out[`GIT_CONFIG_KEY_${n}`] = k;
    out[`GIT_CONFIG_VALUE_${n}`] = v;
    n += 1;
  }
  out.GIT_CONFIG_COUNT = String(n);
  return out;
}

export const credentialEnv = (token) => ({ GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "", GIT_CONFIG_KEY_1: "credential.https://github.com.helper", GIT_CONFIG_VALUE_1: HELPER, ...(token ? { FACTORY_GIT_TOKEN: token } : {}) });

/**
 * The pack inside a bundle, indexed into `mirror` with `git index-pack --strict` (every object fsck-checked, whatever
 * the git version), its prerequisites checked against what the mirror has, and its objects checked complete. Returns
 * the bundle's one ref's commit. The bundle is the agent's: only a v2 or v3 header with one ref is read.
 */
async function indexBundle(file, git) {
  const fd = openSync(file, C.O_RDONLY | C.O_NOFOLLOW);
  const head = Buffer.alloc(65536);
  const n = readSync(fd, head, 0, head.length, 0);
  closeSync(fd);
  const end = head.subarray(0, n).indexOf("\n\n");
  if (end < 0) throw new Error("the agent's bundle has no header");
  const lines = head.subarray(0, end).toString("utf8").split("\n");
  if (!/^# v[23] git bundle$/.test(lines[0])) throw new Error("the agent's bundle is not a git bundle");
  const prereqs = [];
  const refs = [];
  for (const l of lines.slice(1)) {
    if (l.startsWith("@")) continue;
    const m = /^(-?)([0-9a-f]{40,64})(?: (.*))?$/.exec(l);
    if (!m) throw new Error("the agent's bundle has a malformed header");
    (m[1] ? prereqs : refs).push(m[2]);
  }
  if (refs.length !== 1) throw new Error(`the agent's bundle carries ${refs.length} refs, not one`);
  for (const p of prereqs) if ((await git(["cat-file", "-e", `${p}^{commit}`])).code !== 0) throw new Error("the agent's bundle needs a commit GitHub does not have");
  const idx = await new Promise((resolve, reject) => {
    const [gitCmd, gitEnv] = agentUser() ? runnerCommand("git", git.env()) : ["git", git.env()];
    const child = spawn(gitCmd, ["index-pack", "--strict", "--stdin", "--fix-thin"], { cwd: git.dir, env: gitEnv, stdio: ["pipe", "pipe", "pipe"] });
    const err = [];
    child.stderr.on("data", (c) => err.push(c));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr: Buffer.concat(err).toString("utf8") }));
    // index-pack may exit before it reads the whole pack (a bad pack, an unreadable mirror): its exit code is the
    // answer, so a write to its closed stdin (EPIPE) is not an error of its own, and a failed read of the bundle is.
    child.stdin.on("error", () => {});
    const pack = createReadStream(file, { start: end + 2 });
    pack.on("error", (e) => {
      child.kill();
      reject(e);
    });
    pack.pipe(child.stdin);
  });
  if (idx.code !== 0) throw new Error(`the agent's bundle failed Factory's object check: ${idx.stderr.trim().split("\n").at(-1)?.slice(0, 200)}`);
  // Every object the new commits reach is here now (index-pack checks the pack's own objects, this the rest).
  const all = await git(["rev-list", "--objects", "--missing=error", refs[0], ...(prereqs.length ? ["--not", ...prereqs] : [])]);
  if (all.code !== 0) throw new Error("the agent's bundle is missing objects its commits need");
  return refs[0];
}

/**
 * The stage's outbox for factory/<issue>. `remote` is the repository's URL (GitHub's https URL; a path in tests),
 * `token()` the current write token (null for a remote that needs none), `agentEnv` the env the agent's commands run
 * with (its sandbox settings ride in it), `local` whether the local media cap applies. The mirror holds only what
 * GitHub has and what the agent's bundles brought: nothing of any other clone on the machine.
 */
export async function openOutbox({ base: tmpBase = tmpdir(), ...opts }) {
  const mirror = mkdtempSync(join(tmpBase, "mirror-"));
  const scratch = mkdtempSync(join(tmpBase, "outbox-"));
  try {
    return await outboxIn({ ...opts, mirror, scratch });
  } catch (e) {
    // An outbox that did not open leaves nothing behind (box.close is the caller's once it opens).
    rmSync(mirror, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
    throw e;
  }
}

async function outboxIn({ branch, defaultBranch, checkout, remote, token = () => null, agentEnv = process.env, local = false, protectedList = [], toolchain = [], mirror, scratch }) {
  // Factory's own git sees the real history (no replace refs or grafts), none of the box's global or system config,
  // and no hook: it runs only here, never in the agent's checkout.
  const gitEnv = () => noReplace(addConfig({ PATH: process.env.PATH, HOME: mirror, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TEMPLATE_DIR: "", GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_PUSH: "1", LANG: "C", ...credentialEnv(token()) }, [["core.hooksPath", "/dev/null"], ["core.fsmonitor", "false"]]));
  const git = (args, opts = {}) => exec("git", ["-C", mirror, ...args], { env: gitEnv(), maxBytes: 64 * 1024 * 1024, ...opts });
  git.dir = mirror;
  git.env = gitEnv;
  const must = async (args, opts) => {
    const r = await git(args, opts);
    if (r.code !== 0) throw new Error(`git ${args[0]} in Factory's mirror failed: ${String(r.stderr).trim().split("\n").at(-1)?.slice(0, 200) || r.code}`);
    return r.stdout.trim();
  };
  // A git command as the agent, in its checkout and its sandbox.
  // Replace refs and grafts are ignored there too, so the bundle carries the real history.
  const agentGitEnv = { ...agentEnv, GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0" };
  const agent = (args) => backend(agentGitEnv).sandbox.git(["git", "-C", checkout, ...args], agentGitEnv);

  await must(["init", "-q", "--bare"]);
  await must(["config", "remote.origin.url", remote]);
  /** GitHub's head of a branch, read from the server (never a remote-tracking ref), or "" when it does not exist. */
  const serverHead = async (ref) => {
    const r = await git(["ls-remote", "origin", `refs/heads/${ref}`]);
    if (r.code !== 0) throw new Error(`the branch on GitHub could not be read: ${String(r.stderr).trim().split("\n").at(-1)?.slice(0, 200)}`);
    return /^([0-9a-f]{40,64})\t/m.exec(r.stdout)?.[1] ?? "";
  };
  // git cannot hold factory/<issue> beside factory/<issue>/<anything> (a ref is a file or a directory, not both): an
  // earlier tool's branches under that name block every push. Found here, before any harness spend.
  const under = await git(["ls-remote", "--heads", "origin", `${branch}/*`]);
  const colliding = under.code === 0 ? under.stdout.split("\n").map((l) => l.split("\t")[1]).filter(Boolean).map((r) => r.replace(/^refs\/heads\//, "")) : [];
  if (colliding.length) {
    const e = new Error(`branch ${branch} cannot be created: ${colliding.join(", ")} exist${colliding.length > 1 ? "" : "s"} on origin (delete or rename them)`);
    e.code = "ref-collision";
    throw e;
  }
  await must(["fetch", "-q", "--no-tags", "origin", `+refs/heads/${defaultBranch}:refs/remotes/origin/${defaultBranch}`]);
  let expected = await serverHead(branch);
  if (expected) await must(["fetch", "-q", "--no-tags", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  // The default branch's head as Factory last fetched it: the stage's start, moved on by box.refresh (a re-fetch) and by
  // catchUp (the tip it merged into the branch). Either way it is a head GitHub's default branch had.
  let base = await must(["rev-parse", `refs/remotes/origin/${defaultBranch}`]);
  // What this stage answers for starts at the head GitHub had before any harness ran.
  const start = expected || base;

  const box = {
    mirror,
    start,
    base,
    resumed: !!expected,
    expected: () => expected,
    failed: false,
    error: "",
    errorKind: "",
    lfsRefused: false,
    head: null,
    conflicts: [],
    git,
    // The identity of the merge commits Factory makes in the mirror (catchUp); the stage sets its bot's.
    author: { name: "factory[bot]", email: "factory[bot]@users.noreply.github.com" },
    // Set by the last push: Factory's merge of the default branch ({default, paths}), a conflict with it, the raw text of
    // a rejected push (for the job log only), and whether the checkout took the merge.
    merged: null,
    conflict: null,
    detail: "",
    synced: true,
    // Why the last catch-up merge the checkout took left Git LFS pointer files (sync), or "".
    lfsWarning: "",
  };
  // New-branch conflicts with the default branch seen so far (catchUp): the second is refused.
  let conflicts = 0;
  // The catch-up merges (catchUp) this outbox pushed, by commit id: a validated head that is one of them is Factory's
  // own merge, not the agent's change (box.caughtUp).
  const catchUps = new Set();
  // A merge of Factory's the checkout could not take (box.synced false): {from: the agent's head it was made from, to:
  // the merge pushed}. The next push builds on that merge instead of making a fresh one that would replace it.
  let unsynced = null;
  // `kind`: what refused it, for a caller that names it apart ("protected", "fix-scope"; "" for anything else).
  const refuse = (reason, { lfs = false, kind = "" } = {}) => {
    box.failed = true;
    box.error = reason;
    box.errorKind = kind;
    box.lfsRefused = lfs;
    return false;
  };

  /**
   * Take the agent's HEAD into the mirror as refs/heads/incoming (Factory's HEAD there). Returns its sha. A head the
   * mirror already has (GitHub's, or an earlier bundle's) needs no bundle; any other arrives in one.
   */
  const take = async () => {
    const said = (await exec(...agent(["rev-parse", "--verify", "HEAD^{commit}"]), { env: agentGitEnv })).stdout.trim();
    if (!SHA.test(said)) throw new Error("the checkout has no commit at HEAD");
    let head = said;
    if ((await git(["cat-file", "-e", `${said}^{commit}`])).code !== 0) {
      const file = join(scratch, `${Date.now()}.bundle`);
      const nots = [expected, base].filter(Boolean);
      const [cmd, args] = agent(["bundle", "create", "-", "HEAD", ...(nots.length ? ["--not", ...nots] : [])]);
      let r = await pipeToFile(cmd, args, { env: agentGitEnv, file, cap: 4 * 1024 ** 3 });
      if (r.code !== 0 && !r.over) {
        // The checkout lacks a commit named in --not (a rewritten branch): the whole history then.
        rmSync(file, { force: true });
        const [c2, a2] = agent(["bundle", "create", "-", "HEAD"]);
        r = await pipeToFile(c2, a2, { env: agentGitEnv, file, cap: 4 * 1024 ** 3 });
      }
      if (r.over) throw new Error("the branch's bundle is over 4 GB");
      if (r.code !== 0) throw new Error(`the agent could not bundle its branch: ${r.stderr.trim().split("\n").at(-1)?.slice(0, 200)}`);
      head = await indexBundle(file, git);
      rmSync(file, { force: true });
    }
    await must(["update-ref", "refs/heads/incoming", head]);
    await must(["symbolic-ref", "HEAD", "refs/heads/incoming"]);
    return head;
  };

  /**
   * Hand the agent's checkout what the mirror has (the default branch, and the Objective's branch as GitHub has it, or
   * `extra` commits Factory made) as a bundle on a pipe, fetched into its remote-tracking refs inside its sandbox.
   * Factory never fetches into the checkout itself.
   */
  box.feed = async (extra = {}) => {
    const refs = [`refs/remotes/origin/${defaultBranch}`, ...(expected ? [`refs/remotes/origin/${branch}`] : [])];
    for (const [name, sha] of Object.entries(extra)) {
      await must(["update-ref", `refs/factory/${name}`, sha]);
      refs.push(`refs/factory/${name}`);
    }
    const known = (await exec(...agent(["rev-parse", "--verify", "-q", `refs/remotes/origin/${defaultBranch}^{commit}`]), { env: agentGitEnv })).stdout.trim();
    const nots = SHA.test(known) && (await git(["cat-file", "-e", `${known}^{commit}`])).code === 0 ? ["--not", known] : [];
    let bundle = await git(["bundle", "create", "-q", "-", ...refs, ...nots], { encoding: "buffer", maxBytes: 4 * 1024 ** 3 });
    // Nothing new since what the checkout has: an empty bundle is refused, so the refs alone go over.
    if (bundle.code !== 0) bundle = await git(["bundle", "create", "-q", "-", ...refs], { encoding: "buffer", maxBytes: 4 * 1024 ** 3 });
    if (bundle.code !== 0) throw new Error(`the mirror could not bundle ${refs.join(", ")}`);
    const script = 'f="$(mktemp)" && cat > "$f" && git -C "$1" fetch -q --no-tags --update-head-ok "$f" "+refs/remotes/origin/*:refs/remotes/origin/*" "+refs/factory/*:refs/factory/*"; rc=$?; rm -f "$f"; exit $rc';
    const r = await exec(...backend(agentGitEnv).sandbox.git(["sh", "-c", script, "sh", checkout], agentGitEnv), { env: agentGitEnv, input: bundle.stdout });
    if (r.code !== 0) throw new Error(`the checkout could not take the default branch: ${String(r.stderr).trim().split("\n").at(-1)?.slice(0, 200)}`);
    return base;
  };

  /** A git command in the agent's checkout, in its sandbox (sandbox.git): what Factory needs done there, done as the agent. */
  box.agentGit = (args, opts = {}) => exec(...agent(args), { env: agentGitEnv, ...opts });
  // One that moves HEAD or writes the working tree: no Git LFS smudge (lfs.mjs noSmudge); the media comes by lfsHandOver.
  const agentMove = (inner) => exec(...backend(agentGitEnv).sandbox.git(noSmudge(inner), agentGitEnv), { env: agentGitEnv });

  /**
   * Put the agent's checkout on the Objective's branch at `ref` (a ref feed handed over), exactly as that commit has it.
   * Local mode keeps one clone per Objective between stages and runs, so a resumed run meets what an earlier one left
   * there: changed or staged files, untracked files the branch now tracks, a rebase it stopped. That is Factory's own
   * working copy and nothing in it was pushed, so it is discarded (a rebase quit, the checkout forced) rather than
   * refusing the switch. Untracked files out of the branch's way stay (local.mjs prepareClone clears them at stage start).
   * Git LFS files are left as pointers (lfs.mjs noSmudge): the caller hands the media over next (lfsSetup, lfsHandOver).
   * Returns {code, error}: error is git's own cause (gitError), "" on success.
   */
  box.putOn = async (ref) => {
    const script = 'git -C "$1" rebase --quit >/dev/null 2>&1; exec git -C "$1" checkout -q -f -B "$2" "$3"';
    const r = await agentMove(["sh", "-c", script, "sh", checkout, branch, ref]);
    return { code: r.code, error: r.code === 0 ? "" : gitError(r.stderr) || `exit ${r.code}` };
  };

  /**
   * The git operations left in progress in the agent's checkout (a stopped rebase, a merge, a cherry-pick, a revert),
   * read in its sandbox: its HEAD is then part of the work, not the branch. {ops} (empty when none), or {ops: [], code}
   * with the check's exit code when it could not run: what the checkout holds is then unknown.
   */
  box.inProgress = async () => {
    const script = 'cd "$1" || exit 3; for p in rebase-merge rebase-apply MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD; do f="$(git rev-parse --git-path "$p")" || exit 3; if [ -e "$f" ]; then echo "$p"; fi; done';
    const r = await exec(...backend(agentGitEnv).sandbox.git(["sh", "-c", script, "sh", checkout], agentGitEnv), { env: agentGitEnv }).catch(() => ({ code: null, stdout: "" }));
    if (r.code !== 0) return { ops: [], code: r.code ?? "none" };
    const ops = { "rebase-merge": "rebase", "rebase-apply": "rebase", MERGE_HEAD: "merge", CHERRY_PICK_HEAD: "cherry-pick", REVERT_HEAD: "revert" };
    return { ops: [...new Set(String(r.stdout).split("\n").map((l) => ops[l.trim()]).filter(Boolean))] };
  };

  /** Refuse every later push with `reason` (fixed text): the caller found the branch must not go out as it stands. */
  box.block = (reason) => refuse(reason);

  /**
   * Rebase the Objective's branch onto the default branch in a worktree of the mirror, with Factory's identity and no
   * hooks. Returns the new commit, or null when it conflicts (the harness then resolves it in its checkout).
   */
  box.rebase = async ({ name, email }) => {
    const dir = join(scratch, `rebase-${Date.now()}`);
    await must(["worktree", "add", "-q", "--detach", dir, expected]);
    const wt = (args) => exec("git", ["-C", dir, "-c", `user.name=${name}`, "-c", `user.email=${email}`, ...args], { env: gitEnv() });
    const r = await wt(["rebase", "-q", "--no-autostash", `refs/remotes/origin/${defaultBranch}`]);
    const sha = r.code === 0 ? (await wt(["rev-parse", "HEAD"])).stdout.trim() : null;
    // The paths that conflicted, for the pass that resolves them (its fix-pass scope names them).
    box.conflicts = r.code === 0 ? [] : (await wt(["diff", "--name-only", "--diff-filter=U", "-z"])).stdout.split("\0").filter(Boolean);
    if (r.code !== 0) await wt(["rebase", "--abort"]);
    await git(["worktree", "remove", "--force", dir]);
    return sha;
  };

  /**
   * Fetch the default branch again: a branch found conflicting mid-stage is rebased onto where it is now. The base the
   * stage counts from (delta, the fix-pass fence, behind) moves with it; `start` (what this stage answers for) does not.
   */
  box.refresh = async () => {
    await must(["fetch", "-q", "--no-tags", "origin", `+refs/heads/${defaultBranch}:refs/remotes/origin/${defaultBranch}`]);
    base = await must(["rev-parse", `refs/remotes/origin/${defaultBranch}`]);
    box.base = base;
    return base;
  };

  /** Whether a .gitattributes in `head`'s tree routes any path through Git LFS (comment lines aside). */
  const routedAt = async (head) => (await git(["grep", "-q", "-I", "-E", "-e", "^[[:space:]]*[^#[:space:]].*filter=lfs", head, "--", ":(glob)**/.gitattributes"])).code === 0;

  /**
   * Git LFS in the agent's checkout, set up from the mirror: the filters installed and the endpoint's access mode
   * written in the git sandbox, the objects of `head`'s tree fetched by Factory into the mirror (with its token) and
   * handed over as an archive, and the files checked out in the sandbox. {used: false} for a tree without LFS patterns;
   * only a missing git-lfs is not ok; a failed fetch is a warning (pointer files stay).
   */
  box.lfsSetup = async (head, { timeoutMs } = {}) => {
    if (!(await routedAt(head))) return { used: false, ok: true, reason: "", warning: "" };
    if (!(await lfsVersion())) return { used: true, ok: false, reason: "this repository's .gitattributes uses Git LFS and git-lfs is not installed here (install git-lfs on the runner or machine)", warning: "" };
    const endpoint = lfsEndpoint(remote);
    const setup = await box.agentGit(["lfs", "install", "--local", "--force"]);
    if (setup.code !== 0) return { used: true, ok: false, reason: `git lfs install failed in the checkout: ${String(setup.stderr).trim().split("\n").at(-1)?.slice(0, 160)}`, warning: "" };
    if (endpoint) await box.agentGit(["config", `lfs.${endpoint}.access`, "basic"]);
    return { used: true, ok: true, reason: "", warning: await handOver(head, { timeoutMs }) };
  };

  /**
   * The media of `head`'s tree for a checkout Factory has just moved there (the rebased branch, its catch-up merge),
   * after lfsSetup: the same hand-over, with no change to the checkout's git config (its git state is pinned by then).
   * {used: false} when `head` routes nothing through LFS, git-lfs is missing or the checkout has no LFS filter (its
   * files are pointers anyway); else {used: true, warning} ("" when the media arrived).
   */
  box.lfsHandOver = async (head, { timeoutMs } = {}) => {
    if (!(await routedAt(head)) || !(await lfsVersion())) return { used: false, warning: "" };
    const filter = await box.agentGit(["config", "--get-regexp", "^filter\\.lfs\\.(process|smudge)$"]);
    if (filter.code !== 0 || !String(filter.stdout).trim()) return { used: false, warning: "" };
    return { used: true, warning: await handOver(head, { timeoutMs }) };
  };

  /** The objects of `head`'s tree fetched into the mirror, copied into the checkout's store, and `git lfs checkout` there; a warning or "". */
  const handOver = async (head, { timeoutMs } = {}) => {
    const fetched = await git([...lfsPinArgs(remote), "lfs", "fetch", "origin", head], { timeoutMs });
    if (fetched.code !== 0 || fetched.timedOut) {
      const out = `${fetched.stdout}\n${fetched.stderr}`;
      const quota = lfsQuotaLine(out);
      return quota ? `Git LFS refused the download (quota): ${quota}` : `Git LFS objects could not be fetched: ${out.split("\n").map((l) => l.trim()).find((l) => /error|fatal|failed|denied|not found/i.test(l))?.slice(0, 200) || `exit ${fetched.code}`}`;
    }
    if (existsSync(join(mirror, "lfs", "objects"))) {
      const tar = await exec("tar", ["-C", join(mirror, "lfs", "objects"), "-cf", "-", "."], { encoding: "buffer", maxBytes: 8 * 1024 ** 3 });
      const put = await exec(...backend(agentGitEnv).sandbox.git(["sh", "-c", 'd="$(git -C "$1" rev-parse --absolute-git-dir)/lfs/objects" && mkdir -p "$d" && tar -xf - -C "$d" --skip-old-files', "sh", checkout], agentGitEnv), { env: agentGitEnv, input: tar.stdout });
      if (tar.code !== 0 || put.code !== 0) return "Git LFS objects could not be handed to the checkout";
    }
    const co = await box.agentGit(["lfs", "checkout"]);
    return co.code === 0 ? "" : "git lfs checkout failed in the checkout; the run goes on with pointer files";
  };

  /**
   * The branch brought up to date with the default branch when GitHub's default changed a workflow file since `head`'s
   * base. GitHub refuses a token without the Workflows permission (the local token, the App) a branch whose workflow
   * files are a version no branch on GitHub has any more, which is what a run cut before such a change carries (#2579).
   * Factory merges in its own mirror (git merge-tree, no worktree, no hooks) with its own identity. Returns {head} (no
   * change), {head, merged} (the merge commit) or {head, conflict} (the merge conflicts; head unchanged). A default
   * branch that cannot be read or merged changes nothing: the push goes as it would have.
   */
  const catchUp = async (head) => {
    // Read from the server each time (never a remote-tracking ref). Unmoved since Factory read it, only a head cut from
    // an older default (a resumed branch) can lag behind it.
    const now = await serverHead(defaultBranch).catch(() => "");
    if (!SHA.test(now)) return { head };
    const has = async (c) => (await git(["cat-file", "-e", `${c}^{commit}`])).code === 0;
    let tip = now;
    if (!(await has(now))) {
      if ((await git(["fetch", "-q", "--no-tags", "origin", `+refs/heads/${defaultBranch}:refs/factory/default-now`])).code !== 0) return { head };
      // It moved again between the read and the fetch: the fetched head, then.
      if (!(await has(now))) tip = (await git(["rev-parse", "--verify", "-q", "refs/factory/default-now^{commit}"])).stdout.trim();
    }
    if (!SHA.test(tip)) return { head };
    const mb = (await git(["merge-base", head, tip])).stdout.trim();
    // Nothing to merge (the branch already has the default), or nothing of the branch's own to merge it into: a merge
    // there would be Factory's alone, a commit whose tree is the default branch's.
    if (!SHA.test(mb) || mb === tip || mb === head) return { head };
    const paths = (await names([mb, tip]).catch(() => [])).filter((f) => f.startsWith(WORKFLOWS));
    if (!paths.length) return { head };
    // From here on the mirror's default branch is the one GitHub has now: the bundle, media and scope checks count from it.
    await must(["update-ref", `refs/remotes/origin/${defaultBranch}`, tip]);
    base = tip;
    box.base = tip;
    const m = await git(["merge-tree", "--write-tree", head, tip]);
    if (m.code === 1) return { head, conflict: { default: tip, paths } };
    const tree = m.code === 0 ? m.stdout.split("\n")[0].trim() : "";
    if (!SHA.test(tree)) return { head };
    const { name, email } = box.author;
    const who = { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email };
    const sha = await must(["commit-tree", tree, "-p", head, "-p", tip, "-m", `Merge ${defaultBranch} into ${branch}\n\n${defaultBranch} changed ${paths.join(", ")} since this branch's base.`], { env: { ...gitEnv(), ...who } });
    return { head: sha, merged: { default: tip, paths } };
  };

  /**
   * The agent's `head` on top of Factory's own unsynced merge (`unsynced`): the merge itself when the checkout made
   * nothing since, else the agent's new commits merged onto it (merge-tree, Factory's identity), so the pushed branch
   * only moves forward. Null when `head` is not built on what the merge was made from, or the merge conflicts: the
   * push then goes as it would have.
   */
  const onUnsynced = async (head) => {
    if (!unsynced || unsynced.to !== expected || head === expected) return null;
    if ((await git(["merge-base", "--is-ancestor", unsynced.from, head])).code !== 0) return null;
    if (head === unsynced.from) return unsynced.to;
    const m = await git(["merge-tree", "--write-tree", unsynced.to, head]);
    const tree = m.code === 0 ? m.stdout.split("\n")[0].trim() : "";
    if (!SHA.test(tree)) return null;
    const { name, email } = box.author;
    const who = { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email };
    return must(["commit-tree", tree, "-p", unsynced.to, "-p", head, "-m", `Merge the checkout's new commits into ${branch}\n\nThe checkout could not take Factory's merge of ${defaultBranch} (${unsynced.to.slice(0, 7)}).`], { env: { ...gitEnv(), ...who } });
  };

  /**
   * Put the agent's checkout on `head`, Factory's merge (fast-forward only, in its sandbox, no hooks), so its next
   * commits build on it. One that cannot (uncommitted edits in the way) is recorded in `unsynced`: the next push builds
   * on the merge (onUnsynced) rather than replacing it. `from`: the agent's head the merge was made from.
   */
  const sync = async (head, from) => {
    try {
      await box.feed({ merged: head });
      box.synced = (await agentMove(["git", "-C", checkout, "-c", "core.hooksPath=/dev/null", "merge", "--ff-only", "-q", "refs/factory/merged"])).code === 0;
    } catch {
      box.synced = false;
    }
    unsynced = box.synced ? null : { from, to: head };
    // The default branch's media the merge brought, handed over (it left them as pointers).
    box.lfsWarning = box.synced ? (await box.lfsHandOver(head).catch(() => ({ warning: "Git LFS objects could not be handed to the checkout" }))).warning : "";
  };

  /** The workflow files `head` has unlike the default branch, and whether the branch itself changed any of them. */
  const workflowDrift = async (head) => {
    const differ = (await names([base, head]).catch(() => [])).filter((f) => f.startsWith(WORKFLOWS));
    const own = (await names([`${base}...${head}`]).catch(() => [])).filter((f) => f.startsWith(WORKFLOWS));
    return { paths: differ, own: own.filter((f) => differ.includes(f)) };
  };

  /** How many commits the default branch has that the Objective's branch (as GitHub has it) lacks. */
  box.behind = async () => (expected ? Number(await must(["rev-list", "--count", `${expected}..${base}`])) || 0 : 0);

  /** The LFS objects the new commits point to, copied from the agent's store into the mirror's and checked by sha256. */
  const lfsMedia = async (head) => {
    const listed = await must(["rev-list", "--objects", head, "--not", ...[expected, base].filter(Boolean)]);
    const ids = [...new Set(listed.split("\n").map((l) => l.split(" ")[0]).filter((x) => SHA.test(x)))];
    if (!ids.length) return { objects: [], bytes: 0 };
    const check = await git(["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], { input: `${ids.join("\n")}\n` });
    const small = check.stdout.split("\n").map((l) => l.split(" ")).filter(([, t, s]) => t === "blob" && Number(s) < 1024).map(([id]) => id);
    const objects = new Map();
    for (const id of small) {
      const p = parsePointer((await git(["cat-file", "blob", id])).stdout);
      if (p) objects.set(p.oid, p);
    }
    return { objects: [...objects.values()], bytes: [...objects.values()].reduce((n, o) => n + o.size, 0) };
  };

  const copyObject = async (o, agentGitDir) => {
    const dir = join(mirror, "lfs", "objects", o.oid.slice(0, 2), o.oid.slice(2, 4));
    const dest = join(dir, o.oid);
    if (existsSync(dest)) return true;
    mkdirSync(dir, { recursive: true });
    const [cmd, args] = backend(agentEnv).sandbox.command(["cat", "--", join(agentGitDir, "lfs", "objects", o.oid.slice(0, 2), o.oid.slice(2, 4), o.oid)], agentEnv);
    const tmp = join(scratch, `${o.oid}.part`);
    const r = await pipeToFile(cmd, args, { env: agentEnv, file: tmp, cap: o.size + 1 });
    const d = r.code === 0 && !r.over ? digest(tmp) : null;
    if (!d || d.sha256 !== o.oid || d.size !== o.size) {
      rmSync(tmp, { force: true });
      return false;
    }
    renameSync(tmp, dest);
    return true;
  };

  // The fix-pass fence (logic.mjs fixScopeRefused): set when the first fix pass starts, widened by each later one.
  let fence = null;
  const names = async (range) => {
    const r = await git(["diff", "--no-renames", "--no-relative", "--name-only", "-z", ...range, "--"]);
    if (r.code !== 0) throw new Error(`git diff in Factory's mirror failed: ${String(r.stderr).trim().split("\n").at(-1)?.slice(0, 160) || r.code}`);
    return r.stdout.split("\0").filter(Boolean);
  };

  /**
   * Fence what fix passes change from here on: the agent's head now is where the fence starts, and what the branch had
   * changed by then is in scope. `plan` (the plan as it stands) counts from the first call only, so a fix pass cannot
   * widen a later one's scope by editing the plan; `texts` (the issue, the decisions, the red's output, the review
   * comments) widen it at each call. `toolchain` (the files the `setup` and `install` commands name) counts as
   * toolchain. Every later push is checked against it (box.outside). A fence that could not be set fails closed: every
   * later push is refused, never let through unchecked.
   */
  box.fence = async ({ plan = "", texts = [] } = {}) => {
    if (!fence) {
      const since = await take().catch(() => expected || base);
      try {
        fence = { since, prior: await names([`${base}...${since}`]), texts: [plan], extra: toolchain };
      } catch (e) {
        fence = { since, prior: [], texts: [], extra: toolchain, broken: String(e?.message || e).slice(0, 160) };
        throw e;
      }
    }
    fence.texts.push(...texts);
    fence.texts = fence.texts.filter((t) => typeof t === "string" && t);
  };
  box.fenced = () => !!fence;
  box.fenceStart = () => fence?.since ?? null;

  // A regular file's text at `rev` (64 KiB at most, membershipOnly's bound), null when `rev` has no `path`, undefined when
  // it cannot be read as that: a symlink, a directory, a larger file, a git failure.
  const settingsAt = async (rev, path) => {
    const ls = await git(["ls-tree", "-z", rev, "--", path]);
    if (ls.code !== 0) return undefined;
    if (!ls.stdout) return null;
    const m = /^(100644|100755) blob ([0-9a-f]+)\t/.exec(ls.stdout);
    if (!m || ls.stdout.split("\0").filter(Boolean).length !== 1) return undefined;
    const r = await git(["cat-file", "blob", m[2]], { maxBytes: 64 * 1024 + 1 });
    return r.code === 0 && !r.truncated ? r.stdout : undefined;
  };

  /** The toolchain files changed since the fence started, on the branch, that its scope does not reach ([] unfenced). */
  box.outside = async ({ head = null } = {}) => {
    if (!fence) return [];
    if (fence.broken) throw new Error(fence.broken);
    const h = head || (await take());
    const since = await names([fence.since, h]);
    if (!since.length) return [];
    // Only the branch's own changes: a file the default branch changed and the branch took in a rebase is not the pass's.
    const own = new Set(await names([`${base}...${h}`]));
    const mine = since.filter((f) => own.has(f));
    let refused = fixScopeRefused(mine, fence);
    // A refused pnpm-workspace.yaml whose change touches only its `packages` list, from where the fence starts to the
    // head (logic.mjs membershipOnly): workspace membership, not toolchain. A version that cannot be read is not.
    const membership = [];
    for (const p of refused.filter(settingsFile)) {
      const [was, now] = await Promise.all([fence.since, h].map((rev) => settingsAt(rev, p)));
      if (was !== undefined && now !== undefined && membershipOnly(was, now)) membership.push(p);
    }
    if (membership.length) refused = fixScopeRefused(mine, { ...fence, membership });
    // A refused lockfile at a workspace root: in scope when a member manifest is (logic.mjs workspaceDeclarations). The
    // declarations are read as they stood where the fence starts, so a pass cannot widen its own scope by editing them.
    const dirs = workspaceLockDirs(refused);
    if (!dirs.length) return refused;
    const read = async (path) => {
      const r = await git(["cat-file", "blob", `${fence.since}:${path}`]);
      return r.code === 0 ? r.stdout : null;
    };
    const workspaces = [];
    for (const dir of dirs) workspaces.push(...workspaceDeclarations(dir, Object.fromEntries(await Promise.all(WORKSPACE_FILES.map(async (f) => [f, await read(`${dir}${f}`)])))));
    return workspaces.length ? fixScopeRefused(mine, { ...fence, membership, workspaces }) : refused;
  };

  /**
   * Push the agent's HEAD to factory/<issue>. True when GitHub's head is now that commit (or already was); false with
   * box.error set, and the outbox refuses every later push.
   */
  box.push = async ({ sha = null } = {}) => {
    if (box.failed) return false;
    // What this push did, never an earlier one's: Factory's merge, a conflict, GitHub's text, whether the checkout took it.
    box.merged = null;
    box.conflict = null;
    box.detail = "";
    box.synced = true;
    box.lfsWarning = "";
    let head;
    try {
      // `sha`: a commit Factory made in the mirror itself (its own rebase); else the agent's HEAD, as a bundle.
      if (sha) {
        await must(["update-ref", "refs/heads/incoming", sha]);
        await must(["symbolic-ref", "HEAD", "refs/heads/incoming"]);
        head = sha;
      } else head = await take();
    } catch (e) {
      return refuse(e.message);
    }
    // The agent's own head, before anything Factory merges into it.
    const agentHead = head;
    const onto = sha ? null : await onUnsynced(head).catch(() => null);
    if (onto) {
      head = onto;
      await must(["update-ref", "refs/heads/incoming", head]);
      await must(["symbolic-ref", "HEAD", "refs/heads/incoming"]);
    }
    box.head = head;
    if (head === expected) {
      // Nothing new beyond Factory's unsynced merge: the checkout is offered it again.
      if (onto) await sync(head, agentHead);
      return true;
    }
    // A new branch with no commits of its own (a Question, nothing to change, a harness that stopped early): nothing goes
    // out, so the run reads as one that left no commits; never a branch that is only some older default-branch commit.
    if (!expected && (await git(["merge-base", "--is-ancestor", head, base])).code === 0) return true;
    // Factory's merge of a default branch that changed a workflow file (catchUp). A new branch that conflicts with it is
    // not pushed: the caller hands the conflict to the harness (the conflict prompt) and pushes again; a second conflict
    // is refused. An existing branch goes as it is, and its PR's conflict takes the send-back path.
    const caught = await catchUp(head).catch(() => ({ head }));
    if (caught.conflict && !expected) {
      const why = `${branch} conflicts with ${defaultBranch}, which changed ${caught.conflict.paths.join(", ")} since the branch's base; GitHub refuses a branch carrying an older workflow file from this token, so it was not pushed`;
      if (conflicts > 0) return refuse(why);
      conflicts += 1;
      box.conflict = caught.conflict;
      box.error = why;
      return false;
    }
    head = caught.head;
    box.head = head;
    box.merged = caught.merged || null;
    if (caught.merged) {
      await must(["update-ref", "refs/heads/incoming", head]);
      await must(["symbolic-ref", "HEAD", "refs/heads/incoming"]);
    }
    const files = await stageChanges(mirror, start, gitEnv()).catch((e) => e);
    if (files instanceof Error) return refuse(`the branch's changes could not be read: ${files.message.slice(0, 160)}`);
    const hits = protectedTouched(files, protectedList);
    if (hits.length) return refuse(`touched protected path ${hits.join(", ")}`, { kind: "protected" });
    // A worker secret's value (inputs.mjs holdSecrets) in any commit going out, its change or its message: nothing is pushed.
    const leak = await secretScan(git, `${base}..${head}`);
    if (leak) return refuse(leak);
    const outside = await box.outside({ head }).catch((e) => e);
    if (outside instanceof Error) return refuse(`the fix pass's changes could not be read: ${outside.message.slice(0, 160)}`);
    if (outside.length) return refuse(fixScopeReason(outside), { kind: "fix-scope" });
    const plain = await plainLfsBlobs(mirror, base, { source: "HEAD", env: gitEnv() }).catch(() => []);
    if (plain.length) return refuse(`committed as plain git blobs though .gitattributes routes them to Git LFS: ${plain.slice(0, 5).join(", ")}`, { lfs: true });
    const media = await lfsMedia(head);
    if (media.objects.length) {
      if (local && media.bytes > localMediaCapMb() * 1024 * 1024) return refuse(`the branch's Git LFS media is ${(media.bytes / 1024 / 1024).toFixed(1)} MB (${media.objects.length} object(s)), over the local limit of ${localMediaCapMb()} MB (FACTORY_LOCAL_MEDIA_MAX_MB)`, { lfs: true });
      if (!(await lfsVersion())) return refuse("the branch carries Git LFS media and git-lfs is not installed here", { lfs: true });
      const gd = (await exec(...agent(["rev-parse", "--absolute-git-dir"]), { env: agentGitEnv })).stdout.trim();
      const bad = [];
      for (const o of media.objects) if (!(await copyObject(o, gd))) bad.push(o.oid.slice(0, 12));
      if (bad.length) return refuse(`Git LFS objects missing from the checkout's store, or not matching their pointers: ${bad.slice(0, 5).join(", ")}`, { lfs: true });
      const pin = lfsPinArgs(remote);
      if (!pin.length) return refuse("the remote has no https Git LFS endpoint to pin the media upload to", { lfs: true });
      for (let k = 0; k < media.objects.length; k += 100) {
        const up = await git([...pin, "lfs", "push", "--object-id", "origin", ...media.objects.slice(k, k + 100).map((o) => o.oid)]);
        if (up.code !== 0) {
          const out = `${up.stdout}\n${up.stderr}`;
          const quota = lfsQuotaLine(out);
          return refuse(quota ? `Git LFS refused the upload (quota or storage): ${quota}` : `Git LFS upload failed: ${out.split("\n").map((l) => l.trim()).filter(Boolean).at(-1)?.slice(0, 200) || `exit ${up.code}`}`, { lfs: !!quota });
        }
      }
    }
    const lease = `--force-with-lease=refs/heads/${branch}:${expected}`;
    const r = await git(["push", "--no-verify", "--porcelain", lease, "origin", `refs/heads/incoming:refs/heads/${branch}`]);
    if (r.code !== 0) {
      const out = String(`${r.stdout}\n${r.stderr}`).split("\n");
      // GitHub's own text (the remote's URL, its `remote:` lines, ruleset or push-protection messages) is for the job
      // log only: the Blocked reason is Factory's fixed text and codes (pushRefusal).
      box.detail = out.filter((l) => /rejected|error|fatal|!|workflow/.test(l)).join("; ").slice(0, 600);
      // GitHub's refusal of a workflow file the token may not write, read only from its own reason on this ref's
      // porcelain line: named with its cause, in Factory's own words. Anything else is a plain refusal.
      if (out.some((l) => workflowScopeRefused(l, branch))) return refuse(workflowScopeReason({ branch, defaultBranch, ...(await workflowDrift(head).catch(() => ({}))) }));
      return refuse(pushRefusal({ branch, out, code: r.code }));
    }
    // GitHub's head must now be exactly the commit Factory checked.
    let now = "";
    for (let i = 0; i < 3; i += 1) {
      now = await serverHead(branch).catch(() => "");
      if (now === head) break;
      await new Promise((res) => setTimeout(res, 2000));
    }
    if (now !== head) return refuse(`after the push GitHub's ${branch} is ${now.slice(0, 7) || "missing"}, not the checked ${head.slice(0, 7)}`);
    expected = head;
    if (caught.merged) catchUps.add(head);
    await git(["update-ref", `refs/remotes/origin/${branch}`, head]);
    // The agent's checkout takes Factory's merge, so its next commits build on it (sync). A push of a commit Factory
    // made (`sha`, its rebase) leaves the checkout to the caller, which re-points it.
    if ((caught.merged || onto) && !sha) await sync(head, agentHead);
    else unsynced = null;
    return true;
  };

  /** Whether `sha` is a catch-up merge (catchUp) this outbox made and pushed: Factory's own commit, never the agent's. */
  box.caughtUp = (sha) => catchUps.has(sha);

  /** The branch as pushed: its commits beyond the default branch and the paths this stage changed (protected check). */
  box.delta = async () => {
    const head = expected || base;
    const count = Number((await git(["rev-list", "--count", `${base}..${head}`])).stdout.trim()) || 0;
    await git(["update-ref", "refs/heads/incoming", head]);
    await git(["symbolic-ref", "HEAD", "refs/heads/incoming"]);
    return { count, files: await stageChanges(mirror, start, gitEnv()).catch(() => []), head };
  };

  /**
   * The whole branch as it stands, beyond what this stage checked: `files` the paths its PR changes (base...head, as
   * GitHub's PR diff reads them), and `foreign` the commits on base..start (the head GitHub had before this stage ran)
   * that `vouched` (a head Factory recorded pushing there) does not hold: commits someone else pushed onto the branch,
   * which no Factory check saw. -1 when `vouched` is not on the branch (it was rewritten since). A new branch has none.
   */
  box.whole = async (vouched = "") => {
    const head = expected || base;
    const files = await names([`${base}...${head}`]);
    if (start === base) return { files, foreign: 0 };
    const nots = [base];
    if (vouched) {
      if (!SHA.test(vouched) || (await git(["merge-base", "--is-ancestor", vouched, start])).code !== 0) return { files, foreign: -1 };
      nots.push(vouched);
    }
    return { files, foreign: Number(await must(["rev-list", "--count", start, "--not", ...nots])) || 0 };
  };

  /** A clean tree of the default branch as GitHub has it, in Factory's own temp directory: where `setup` runs on Actions. */
  box.defaultTree = async () => {
    const dir = join(scratch, "default-tree");
    if (!existsSync(dir)) await must(["worktree", "add", "-q", "--detach", dir, base]);
    return dir;
  };

  box.close = () => {
    rmSync(mirror, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  };
  return box;
}

/**
 * The tree a clean merge of `ours` and `theirs` has, computed by Factory in a scratch mirror (git merge-tree, no
 * worktree, no hooks), or null when they conflict or cannot be read. An update-branch head is accepted only when its
 * tree is exactly this: GitHub's own merge, with nothing edited in.
 */
export async function mergeTree({ remote, token = () => null, ours, theirs, base = tmpdir() }) {
  const dir = mkdtempSync(join(base, "merge-tree-"));
  const env = () => addConfig({ PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TEMPLATE_DIR: "", GIT_TERMINAL_PROMPT: "0", LANG: "C", ...credentialEnv(token()) }, [["core.hooksPath", "/dev/null"]]);
  const git = (args) => exec("git", ["-C", dir, ...args], { env: env() });
  try {
    if ((await git(["init", "-q", "--bare"])).code !== 0) return null;
    await git(["config", "remote.origin.url", remote]);
    // Commits by id (GitHub serves any reachable one); blobs as the merge needs them.
    if ((await git(["fetch", "-q", "--no-tags", "--filter=blob:none", "origin", ours, theirs])).code !== 0) return null;
    const r = await git(["merge-tree", "--write-tree", ours, theirs]);
    return r.code === 0 ? r.stdout.split("\n")[0].trim() || null : null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A scratch bare repository for a diff Factory makes outside a stage's mirror (local mode's post-review): it reads the
 * object store `objects` (a clone's, as an alternate: none of that clone's config, hooks or refs is used, and no git
 * runs there) and fetches a commit it lacks from `remote` by id, as the mirror does. Returns {git, close}.
 */
export async function scratchHistory({ remote, token = () => null, objects = null, base = tmpdir() }) {
  const dir = mkdtempSync(join(base, "history-"));
  const env = () => noReplace(addConfig({ PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TEMPLATE_DIR: "", GIT_TERMINAL_PROMPT: "0", LANG: "C", ...credentialEnv(token()) }, [["core.hooksPath", "/dev/null"], ["core.fsmonitor", "false"], ["core.alternateRefsCommand", "true"]]));
  const git = (args, opts = {}) => exec("git", ["-C", dir, ...args], { env: env(), maxBytes: 64 * 1024 * 1024, ...opts });
  const close = () => rmSync(dir, { recursive: true, force: true });
  if ((await git(["init", "-q", "--bare"])).code !== 0 || (await git(["config", "remote.origin.url", remote])).code !== 0) {
    close();
    throw new Error("a scratch repository could not be made");
  }
  if (objects) writeFileSync(join(dir, "objects", "info", "alternates"), `${objects}\n`);
  return { git, close };
}
