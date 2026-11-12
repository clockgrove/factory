// Git LFS in a Factory checkout. A repository whose .gitattributes routes files through LFS gets, before any harness
// runs: git-lfs's filters and hooks in the checkout's own config (a sandbox may not see the box's global config, and a
// runner's checkout has none), the LFS endpoint's access mode written up front (git-lfs otherwise learns it from a 401
// and writes it to .git/config, which the local sandboxes keep read-only), and the objects of the branch's tree fetched
// so setup, validation and the model see the real files. The harness commits media and pushes nothing: Factory's push
// (outbox.mjs) copies each object the new commits point to from the checkout's store, checks it against its pointer,
// and uploads it to the repository's own endpoint (lfsPinConfig) before the ref moves. The pre-commit hook and
// plainLfsBlobs below refuse a file that .gitattributes routes to LFS but was committed as a plain blob.
import { exec } from "./proc.mjs";

/** The first line of every LFS pointer file. */
export const POINTER_HEAD = "version https://git-lfs.github.com/spec/v1";
/** The first line of a pointer in git-lfs's earliest spec, which it still reads. */
export const LEGACY_POINTER_HEAD = "version https://hawser.github.com/spec/v1";

/** True when a .gitattributes file in the tree at `rev` routes any path through the LFS filter (comment lines aside). */
export async function usesLfs(checkout, rev = "HEAD") {
  const r = await exec("git", ["grep", "-q", "-I", "-E", "-e", "^[[:space:]]*[^#[:space:]].*filter=lfs", rev, "--", ":(glob)**/.gitattributes"], { cwd: checkout });
  return r.code === 0;
}

/** git-lfs's version line, or null when git-lfs is not installed. */
export async function lfsVersion(env = process.env) {
  const r = await exec("git", ["lfs", "version"], { env }).catch(() => ({ code: 1 }));
  return r.code === 0 ? String(r.stdout).trim().split("\n")[0] : null;
}

/** The LFS endpoint git-lfs derives from a remote URL (GitHub's: <repo>.git/info/lfs). */
export function lfsEndpoint(remoteUrl) {
  const u = String(remoteUrl || "").trim().replace(/\/+$/, "");
  if (!/^https:\/\//.test(u)) return null;
  return `${u.endsWith(".git") ? u : `${u}.git`}/info/lfs`;
}

/**
 * A git-lfs refusal for quota or storage, as one line, else null. GitHub answers an LFS batch request over the
 * account's data quota or LFS budget with a message naming it; git-lfs prints that message on the failed transfer.
 */
export function lfsQuotaLine(output) {
  const line = String(output || "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => /over (its|your) data quota|purchase more data packs|exceeded (its|your) LFS budget|LFS budget|storage quota|insufficient storage|data quota/i.test(l));
  return line ? line.replace(/^(batch response|error|LFS|fatal):\s*/gi, "").slice(0, 200) : null;
}

/**
 * Paths a diff adds or changes the content of: added, copied, modified, and renamed with a content change. A pure
 * rename (similarity 100) moves a file without restaging it, so it does not count. `range` is a revision range, or
 * null for the index (what the next commit records).
 */
export async function changedPaths(checkout, range = null, env = process.env) {
  const args = ["diff", ...(range ? [range] : ["--cached"]), "--name-status", "-z", "-M", "--diff-filter=ACMR"];
  const parts = String((await exec("git", args, { cwd: checkout, env })).stdout).split("\0");
  const out = [];
  for (let i = 0; i < parts.length && parts[i]; ) {
    if (/^[RC]/.test(parts[i])) {
      if (parts[i] !== "R100") out.push(parts[i + 2]);
      i += 3;
    } else {
      out.push(parts[i + 1]);
      i += 2;
    }
  }
  return out.filter(Boolean);
}

/** The paths among `files` that .gitattributes (as staged, or as committed in `source`) routes through the LFS filter. */
export async function lfsRouted(checkout, files, { source = null, env = process.env } = {}) {
  if (!files.length) return [];
  const parts = String((await exec("git", ["check-attr", ...(source ? ["--source", source] : ["--cached"]), "-z", "--stdin", "filter"], { cwd: checkout, env, input: `${files.join("\0")}\0` })).stdout).split("\0");
  const routed = [];
  for (let i = 0; i + 2 < parts.length; i += 3) if (parts[i + 2] === "lfs") routed.push(parts[i]);
  return routed;
}

/**
 * The branch's base as it is now: a pass may rebase onto a newer default branch after the job read its base, and the
 * old base would then count the default branch's own media as the branch's. Falls back to the given base.
 */
export async function currentBase(checkout, defaultBranch, fallback) {
  await exec("git", ["fetch", "-q", "origin", defaultBranch], { cwd: checkout }).catch(() => null);
  const r = await exec("git", ["merge-base", `origin/${defaultBranch}`, "HEAD"], { cwd: checkout }).catch(() => ({ code: 1 }));
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : fallback;
}

/** The LFS media the branch adds or changes since base. */
export const lfsMedia = async (checkout, base, opts = {}) => lfsRouted(checkout, await changedPaths(checkout, `${base}...HEAD`, opts.env), opts);

/**
 * The config that sends every git-lfs transfer to the repository's own endpoint, as [key, value] pairs for `git -c`
 * (or GIT_CONFIG_COUNT). Command-line config outranks .lfsconfig, the working-tree file the model writes; these are the
 * keys of git-lfs's .lfsconfig allow-list that pick an endpoint, plus remote.origin.lfspushurl and the incomplete-push
 * switch (a push missing an object stops before the refs update). Transfer agents are not on that allow-list.
 * Null for a remote with no https endpoint.
 */
export function lfsPinConfig(remoteUrl) {
  const endpoint = lfsEndpoint(remoteUrl);
  if (!endpoint) return null;
  return [
    ["lfs.url", endpoint],
    ["lfs.pushurl", endpoint],
    ["remote.origin.lfsurl", endpoint],
    ["remote.origin.lfspushurl", endpoint],
    ["lfs.allowincompletepush", "false"],
  ];
}

/** The pinned config as GIT_CONFIG_COUNT variables, for every git a process runs. */
export function lfsPinEnv(remoteUrl) {
  const pairs = lfsPinConfig(remoteUrl) || [];
  const env = { GIT_CONFIG_COUNT: String(pairs.length) };
  pairs.forEach(([k, v], i) => Object.assign(env, { [`GIT_CONFIG_KEY_${i}`]: k, [`GIT_CONFIG_VALUE_${i}`]: v }));
  return pairs.length ? env : {};
}

/** The Git LFS media a local branch may carry since the default branch, in MB: FACTORY_LOCAL_MEDIA_MAX_MB, default 500. */
export function localMediaCapMb(env = process.env) {
  const n = Number(env.FACTORY_LOCAL_MEDIA_MAX_MB);
  return Number.isFinite(n) && n > 0 ? n : 500;
}

/** The pinned config as `git -c` arguments; empty for a remote with no https endpoint. */
export const lfsPinArgs = (remoteUrl) => (lfsPinConfig(remoteUrl) || []).flatMap(([k, v]) => ["-c", `${k}=${v}`]);

/**
 * The rule for every git command Factory runs in the agent's checkout that moves HEAD or writes the working tree
 * (outbox.mjs putOn and its catch-up merge sync, the rebased branch put on the checkout in worker.mjs, local.mjs
 * PREPARE_CLONE's restore, the local clone itself): it never smudges Git LFS files. That git has no GitHub credential
 * (locally none at all, GIT_TERMINAL_PROMPT=0), and a reused clone keeps the filters an earlier stage installed with
 * filter.lfs.required set, so a smudge of an object the store lacks asks for a username and fails the whole command
 * (#73). With GIT_LFS_SKIP_SMUDGE=1 git-lfs writes the pointer files and makes no request; the media then arrives by
 * Factory's hand-over (outbox.mjs lfsSetup, lfsHandOver): the objects fetched into the mirror with Factory's token,
 * copied into the checkout's store, and `git lfs checkout`. git-lfs's clean side is untouched, so the index stays right.
 * The harness's own git (a conflict pass's rebase or merge) cannot take this env: the hand-over gives its store every
 * object it can check out first (outbox.mjs workingSet), so it never downloads either (#76).
 */
export const SKIP_SMUDGE_ENV = Object.freeze({ GIT_LFS_SKIP_SMUDGE: "1" });

/**
 * `inner` (a command as argv) under SKIP_SMUDGE_ENV. The variable rides in argv (`env K=V ...`), not the process env: a
 * runner's agent gets only an allow-listed env (proc.mjs asAgent), so a variable set there would never reach its git.
 */
export const noSmudge = (inner) => ["env", ...Object.entries(SKIP_SMUDGE_ENV).map(([k, v]) => `${k}=${v}`), ...inner];

/**
 * Factory's own host-side git sees the real history: refs/replace and .git/info/grafts, which sandboxed code can write,
 * are ignored (the graft file is pointed at a path that cannot exist).
 */
export const noReplace = (env = process.env) => ({ ...env, GIT_NO_REPLACE_OBJECTS: "1", GIT_GRAFT_FILE: "/dev/null/grafts" });

/**
 * The merge-base of HEAD and the default branch as origin has it now, read from the server (ls-remote), not from
 * refs/remotes/origin/*, which sandboxed code can move or forge. Null when origin cannot be read.
 */
export async function serverBase(checkout, env = process.env) {
  const ls = await exec("git", ["ls-remote", "--symref", "origin", "HEAD"], { cwd: checkout, env: noReplace(env) });
  const tip = /^([0-9a-f]{40,64})\tHEAD$/m.exec(String(ls.stdout))?.[1];
  const ref = /^ref: (refs\/heads\/\S+)\tHEAD$/m.exec(String(ls.stdout))?.[1];
  if (ls.code !== 0 || !tip || !ref) return null;
  if ((await exec("git", ["cat-file", "-e", `${tip}^{commit}`], { cwd: checkout, env: noReplace(env) })).code !== 0) await exec("git", ["fetch", "-q", "origin", ref], { cwd: checkout, env: noReplace(env) });
  const mb = await exec("git", ["merge-base", tip, "HEAD"], { cwd: checkout, env: noReplace(env) });
  return mb.code === 0 && mb.stdout.trim() ? mb.stdout.trim() : null;
}

/**
 * Files the branch added or changed since base that .gitattributes (as staged) routes through LFS but whose committed
 * blob is not an LFS pointer: a binary committed as a plain git blob, the silent failure a missing filter causes. Empty
 * files pass (git-lfs leaves them empty too).
 */
export async function plainLfsBlobs(checkout, base, opts = {}) {
  const plain = [];
  const env = opts.env || process.env;
  for (const f of await lfsMedia(checkout, base, opts)) {
    const size = Number((await exec("git", ["cat-file", "-s", `HEAD:${f}`], { cwd: checkout, env })).stdout.trim());
    if (!size) continue;
    // A pointer is under 1024 bytes by the LFS spec: anything larger is the file itself, unread.
    const text = String((await exec("git", ["cat-file", "blob", `HEAD:${f}`], { cwd: checkout, env })).stdout);
    if (size >= 1024 || !(text.startsWith(POINTER_HEAD) || text.startsWith(LEGACY_POINTER_HEAD))) plain.push(f);
  }
  return plain;
}

/**
 * The pre-commit hook's LFS guard (bash, appended to the hook configureGit writes), over the staged paths a commit adds
 * or changes (a pure rename does not count). A path .gitattributes routes through LFS must be staged as a pointer.
 */
export function lfsHook() {
  return `
# Git LFS: a file .gitattributes routes through LFS is committed as a pointer, never as the file itself.
lfs_staged() {
  while IFS= read -r -d '' st; do
    case "$st" in
      R*|C*) IFS= read -r -d '' _old; IFS= read -r -d '' p; [ "$st" = R100 ] && continue ;;
      *) IFS= read -r -d '' p ;;
    esac
    printf '%s\\0' "$p"
  done < <(git diff --cached --name-status -z -M --diff-filter=ACMR)
}
lfs_plain=""
while IFS= read -r -d '' f && IFS= read -r -d '' _attr && IFS= read -r -d '' v; do
  [ "$v" = lfs ] || continue
  [ "$(git cat-file -s ":$f" 2>/dev/null || echo 0)" = 0 ] && continue
  first="$(git cat-file blob ":$f" 2>/dev/null | head -c 64 | head -n 1 || true)"
  [ "$first" = "${POINTER_HEAD}" ] || lfs_plain="$lfs_plain $f"
done < <(lfs_staged | git check-attr --cached -z --stdin filter)
if [ -n "$lfs_plain" ]; then
  echo "factory: refusing commit: .gitattributes routes these through Git LFS but they are staged as plain git blobs:$lfs_plain" >&2
  echo "factory: Git LFS is not set up in this checkout; unstage them, run \\\`git lfs install --local\\\`, then \\\`git add --renormalize\\\` them" >&2
  exit 1
fi
`;
}
