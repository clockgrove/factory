/**
 * Result collection: Factory, not the worker, turns a worker's files into
 * a commit. The worktree is staged minus private staging, checked for
 * ownership, protected paths and filesystem safety, scanned for secrets,
 * and committed under the Factory identity on the exact base. A wrong
 * result is a repair finding, a suspected secret a question for the
 * operator, and a scanner that can't run a retry. A failed Git read
 * throws, and the step retries.
 */
import { spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { SandboxConfig } from "../config.js";
import { type Held, hold, objectiveWide } from "../engine.js";
import type { GitExit } from "../git.js";
import { inert } from "../markdown.js";
import { validPath } from "../objective.js";
import { forceRemove, within } from "../paths.js";
import {
  type WorkDiscovery,
  workDiscoveryProblem,
} from "../planning/amendments.js";
import { isRecord, ownsPath } from "../planning/graph.js";
import { DESIGN_QUESTIONS, type DesignRisk } from "../planning/rubric.js";
import type { Plan, WorkItem } from "../planning/types.js";
import { candidateBounds } from "../sandbox.js";
import { errorMessage } from "../text.js";
import {
  hasGitlink,
  hostGit,
  hostGitExit,
  workerEnvironment,
} from "../worktree.js";

/** The committer email on every commit Factory writes. */
export const FACTORY_EMAIL = "factory@users.noreply.github.com";

/** The commit message of a collected result; the title can't close or mention (markdown.ts inert). */
function collectionMessage(item: Pick<WorkItem, "title">): string {
  return `Factory: ${inert(item.title)}`;
}

/** CI configuration Factory knows of, by path from the root. */
const CI_PATHS = [
  ".appveyor.yml",
  ".drone.yml",
  ".gitlab-ci.yaml",
  ".gitlab-ci.yml",
  ".travis.yml",
  ".woodpecker.yaml",
  ".woodpecker.yml",
  "appveyor.yml",
  "azure-pipelines.yaml",
  "azure-pipelines.yml",
  "bitbucket-pipelines.yml",
  "Jenkinsfile",
];
const CI_DIRECTORIES = [
  ".buildkite/",
  ".circleci/",
  ".forgejo/workflows/",
  ".gitea/workflows/",
  ".github/",
  ".woodpecker/",
];

/**
 * Whether `path` steers CI or review: anything under `.github/` (workflows,
 * CODEOWNERS, settings), a CODEOWNERS file anywhere, or another CI
 * system's configuration. A worker changes one only when the Objective's
 * May change section lists that path.
 */
function protectedPath(path: string): boolean {
  return (
    CI_DIRECTORIES.some((directory) => path.startsWith(directory)) ||
    CI_PATHS.includes(path) ||
    basename(path) === "CODEOWNERS"
  );
}

/** A worker's advisory note from `.factory-handoff.json`. */
export interface HandoffNote {
  kind: "interface" | "pitfall" | "hypothesis" | "verification" | "design";
  summary: string;
  paths: string[];
  /** Peer Work Item ids the note is for. */
  consumers: string[];
  /** A verification note's zero-based acceptance criterion; an index for review, never proof. */
  criterionIndex?: number;
  /** A design note's checklist question; an index for review, never proof. */
  designRisk?: DesignRisk;
}

export interface CollectInput {
  /** The operator's Secretlint rules (policy.secretlintConfig), checked at load. */
  secretlintConfig?: string;
  worktree: string;
  /** The commit the worktree started from. */
  base: string;
  plan: Plan;
  item: WorkItem;
  /** The accepted Objective's "May change" paths (objective.ts mayChange): the only protected paths a worker may change. */
  mayChange: readonly string[];
  sandbox: SandboxConfig;
  /** The worker's last message, carried by an empty-result finding. */
  finalResponse: string;
  /**
   * The tree of the result a repair refused: submitting that same tree
   * again is no change.
   */
  refusedTree?: string;
  signal: AbortSignal;
}

export type Collection =
  | {
      kind: "collected";
      commit: string;
      tree: string;
      notes: HandoffNote[];
      discovery?: WorkDiscovery;
    }
  /** The worker's result is wrong; the finding goes back to it. */
  | { kind: "repair"; finding: string; discovery?: WorkDiscovery }
  | Held
  | { kind: "retry"; reason: string };

/** A deterministic problem with the worker's result. */
class WorkFinding extends Error {}

/** A check that ends collection with something other than a repair. */
class CollectionStop extends Error {
  constructor(readonly outcome: Exclude<Collection, { kind: "collected" }>) {
    super("collection stopped");
  }
}

/** Controller-owned staging that collection reads but never commits. */
const PRIVATE_STAGING = [
  ".factory-discovery.json",
  ".factory-handoff.json",
  ".factory-inputs",
  ".factory-assets.json",
  ".factory-media",
];

/** Whether a Git-relative path is private staging, which is never a delivery candidate. */
export function privateStagingPath(path: string): boolean {
  return PRIVATE_STAGING.some(
    (name) => path === name || path.startsWith(`${name}/`),
  );
}

/** Collect the worker's result in `worktree` as one commit on `base`. */
export async function collect(input: CollectInput): Promise<Collection> {
  try {
    return await collectResult(input);
  } catch (error) {
    if (error instanceof WorkFinding)
      return { kind: "repair", finding: error.message };
    if (error instanceof CollectionStop) return error.outcome;
    throw error;
  }
}

async function collectResult(collected: CollectInput): Promise<Collection> {
  const input: Scan = {
    ...collected,
    rules: await scannerRules(collected.secretlintConfig),
  };
  const { worktree, item, base, signal } = input;
  const git = (...args: string[]) => hostGit(worktree, args, { signal });
  const text = async (...args: string[]) =>
    (await git(...args)).toString("utf8").trim();
  const untracked = async (path: string) =>
    !(await text("ls-tree", "HEAD", "--", path)) &&
    !(await text("ls-files", "--stage", "--", path));

  const handoffPath = join(worktree, ".factory-handoff.json");
  const notes = await readHandoff(
    handoffPath,
    handoffPeers(input.plan, item),
    item.acceptance.length,
  );
  if (notes) {
    if (!(await untracked(".factory-handoff.json")))
      throw new WorkFinding(
        "Handoff manifest must be untracked private staging",
      );
    const stopped = await scanStaging(input, [
      { name: ".factory-handoff.json", bytes: await readFile(handoffPath) },
    ]);
    if (stopped) throw new CollectionStop(stopped);
  }
  const discoveryPath = join(worktree, ".factory-discovery.json");
  const discovery = await readDiscovery(discoveryPath);
  if (discovery && !(await untracked(".factory-discovery.json")))
    throw new WorkFinding(
      "Discovery manifest must be untracked private staging",
    );
  // A collection interrupted after its own commit, or a repair continuing
  // from Factory's earlier commit, is undone to the staged candidate and
  // checked again from the top.
  const head = await text("rev-parse", "HEAD");
  if (
    head !== base &&
    (await parent(worktree, signal)) === base &&
    (await text("log", "-1", "--format=%ae%n%s")) ===
      `${FACTORY_EMAIL}\n${collectionMessage(item)}`
  )
    await git("reset", "--quiet", "--soft", base);
  if ((await text("rev-parse", "HEAD")) !== base)
    throw new WorkFinding(
      "Worker changed HEAD; expected uncommitted changes at exact base",
    );
  // Private staging is never staged, so its bytes never reach the object
  // database. Before host-side Git stages anything: no nested repository
  // it would enter, and no more than sandbox.limits allow.
  await assertNoNestedGit(worktree);
  await assertCandidateBounds(worktree, candidateBounds(input.sandbox), signal);
  await stageFiles(worktree, signal);
  const paths = await checkStagedCandidate(input);
  // An empty result is still wrong, but a staged discovery is the worker's
  // account of why: it rides on the finding. A repair that left the refused
  // tree as it was resubmits the refused result, so it is empty too.
  const unchanged =
    paths.length > 0 &&
    input.refusedTree !== undefined &&
    (await text("write-tree")) === input.refusedTree;
  if (!paths.length || unchanged)
    return {
      kind: "repair",
      finding: noChangeDetail(input.finalResponse),
      ...(discovery ? { discovery } : {}),
    };
  await git(
    "-c",
    "user.name=Factory",
    "-c",
    `user.email=${FACTORY_EMAIL}`,
    "commit",
    "--quiet",
    "-m",
    collectionMessage(item),
  );
  const commit = await text("rev-parse", "HEAD");
  const tree = await text("rev-parse", "HEAD^{tree}");
  await Promise.all(
    [
      discoveryPath,
      handoffPath,
      join(worktree, ".factory-inputs"),
      join(worktree, ".factory-assets.json"),
    ].map(forceRemove),
  );
  return {
    kind: "collected",
    commit,
    tree,
    notes: notes ?? [],
    ...(discovery ? { discovery } : {}),
  };
}

/**
 * `git add -A` of the worktree minus private staging, into the worktree's
 * index or `index`. Git rejects an explicit ignored path even when it is
 * an exclusion, so only present staging is excluded; ignored untracked
 * staging isn't added by the root pathspec anyway.
 */
async function stageFiles(
  worktree: string,
  signal: AbortSignal,
  index?: string,
): Promise<void> {
  const exclusions: string[] = [];
  for (const name of PRIVATE_STAGING)
    if (
      (
        await hostGit(
          worktree,
          [
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
            "--",
            name,
          ],
          { signal },
        )
      ).length
    )
      exclusions.push(`:(exclude,literal)${name}`);
  const added = await hostGitExit(
    worktree,
    ["add", "-A", "--", ".", ...exclusions],
    { magic: true, stdout: "ignore", signal, ...(index ? { index } : {}) },
  );
  if (added.code !== 0) {
    // Git cannot index what the worker left unreadable; any other failure
    // is Factory's own.
    const unreadable = await firstUnreadable(worktree);
    if (unreadable)
      throw new WorkFinding(`Worker left an unreadable path: ${unreadable}`);
    throw new Error(
      `git add in ${worktree} exited ${added.code}: ${added.stderr}`,
    );
  }
}

/**
 * A commit of the worker's current files on HEAD, staged as collection
 * stages them, for a worker's own Validate. It uses a separate index, so
 * the worker's index and HEAD stay as they are and a nested repository
 * made meanwhile never becomes a gitlink there. A problem the worker can
 * fix comes back as data.
 */
export async function snapshot(
  worktree: string,
  sandbox: SandboxConfig,
  signal: AbortSignal,
): Promise<{ tree: string; commit: string } | { problem: string }> {
  const scratch = await mkdtemp(join(dirname(worktree), "snapshot-"));
  try {
    // Host-side Git must not enter a repository the worker wrote, nor hash
    // into the shared object store more than collection could retain.
    await assertNoNestedGit(worktree);
    await assertCandidateBounds(worktree, candidateBounds(sandbox), signal);
    const index = join(scratch, "index");
    const indexed = async (...args: string[]) =>
      (await hostGit(worktree, args, { index, signal })).toString("utf8");
    await indexed("read-tree", "HEAD");
    await stageFiles(worktree, signal, index);
    // No snapshot with a gitlink is committed, let alone validated.
    if (await hasGitlink(worktree, { index, signal }))
      return {
        problem:
          "Your files include a submodule gitlink; Factory refuses nested repositories and submodules",
      };
    const tree = (await indexed("write-tree")).trim();
    const commit = (
      await hostGit(
        worktree,
        [
          "-c",
          "user.name=Factory",
          "-c",
          `user.email=${FACTORY_EMAIL}`,
          "commit-tree",
          tree,
          "-p",
          "HEAD",
          "-m",
          "Factory worker validation snapshot",
        ],
        { signal },
      )
    )
      .toString("utf8")
      .trim();
    return { tree, commit };
  } catch (error) {
    if (error instanceof WorkFinding) return { problem: error.message };
    throw error;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * The worker's handoff notes, decoded exactly as collection decodes them:
 * undefined when it left none, or the problem collection would refuse.
 */
export async function readHandoffNotes(
  worktree: string,
  plan: Pick<Plan, "items">,
  item: WorkItem,
): Promise<HandoffNote[] | { problem: string } | undefined> {
  try {
    return await readHandoff(
      join(worktree, ".factory-handoff.json"),
      handoffPeers(plan, item),
      item.acceptance.length,
    );
  } catch (error) {
    if (error instanceof WorkFinding) return { problem: error.message };
    throw error;
  }
}

/** HEAD's first parent, or undefined at a root commit. */
async function parent(
  worktree: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const result = await hostGitExit(
    worktree,
    ["rev-parse", "--verify", "--quiet", "HEAD^"],
    { signal },
  );
  return result.code === 0 ? result.stdout.toString("utf8").trim() : undefined;
}

/** The longest worker final response carried into a finding. */
const FINAL_RESPONSE_LIMIT = 2000;

/**
 * An empty result still has the worker's own account of why it changed
 * nothing; the finding carries it.
 */
function noChangeDetail(finalResponse: string): string {
  const text = finalResponse.trim();
  const shown =
    text.length > FINAL_RESPONSE_LIMIT
      ? `${text.slice(0, FINAL_RESPONSE_LIMIT)}...`
      : text;
  return shown
    ? `Worker produced no repository change. Worker's final response: ${shown}`
    : "Worker produced no repository change";
}

// ── Private staging ─────────────────────────────────────────────────────

/** The handoff notes, or undefined when the worker left none. */
async function readHandoff(
  path: string,
  peers: readonly { id: string; title: string }[],
  criterionCount: number,
): Promise<HandoffNote[] | undefined> {
  const stat = await lstat(path).catch(() => undefined);
  if (!stat) return undefined;
  if (!stat.isFile() || (await realpath(path)) !== resolve(path))
    throw new WorkFinding(
      "Handoff manifest must be a regular private staging file",
    );
  if (stat.size > 256 * 1024)
    throw new WorkFinding("Handoff manifest exceeds 256 KiB");
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new WorkFinding(
      `Handoff manifest is not JSON: ${errorMessage(error)}`,
    );
  }
  const decoded = decodeHandoff(value, peers, criterionCount);
  if (!Array.isArray(decoded)) throw new WorkFinding(decoded.problem);
  return decoded;
}

/** The discovery proposal, or undefined when the worker left none. */
async function readDiscovery(path: string): Promise<WorkDiscovery | undefined> {
  const stat = await lstat(path).catch(() => undefined);
  if (!stat) return undefined;
  if (!stat.isFile() || (await realpath(path)) !== resolve(path))
    throw new WorkFinding(
      "Discovery manifest must be a regular private staging file",
    );
  let value: WorkDiscovery;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as WorkDiscovery;
  } catch (error) {
    throw new WorkFinding(
      `Discovery manifest is not JSON: ${errorMessage(error)}`,
    );
  }
  // The one rule, shared with amendment intake.
  const problem = workDiscoveryProblem(value);
  if (problem) throw new WorkFinding(problem);
  return {
    scope: value.scope,
    reason: value.reason,
    evidence: value.evidence,
    ownership: value.ownership,
    acceptance: value.acceptance,
    dependencies: value.dependencies,
  };
}

// ── Candidate checks ────────────────────────────────────────────────────

/**
 * Refuse any `.git` below the checkout's own. Host-side Git (status, diff,
 * add) recurses into a nested repository behind a gitlink and honours that
 * repository's own configuration, which sandboxed code can write: a filter or
 * other program there would run outside the sandbox. Checked before any
 * host-side Git reads a worker's checkout. Links are not followed.
 */
async function assertNoNestedGit(root: string): Promise<void> {
  const inspect = async (directory: string, relative: string) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      // A directory the worker made unreadable is its fault, as collection
      // reports for any other unreadable path.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM")
        throw new WorkFinding(
          `Worker left an unreadable path: ${relative || "."}`,
        );
      throw error;
    }
    for (const entry of entries) {
      if (!relative && entry.name === ".git") continue;
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.name === ".git")
        throw new WorkFinding(
          `Worker created a nested Git entry at ${JSON.stringify(path)}; Factory refuses nested repositories and submodules`,
        );
      if (entry.isDirectory()) await inspect(join(directory, entry.name), path);
    }
  };
  await inspect(root, "");
}

/**
 * Bound what `add -A` would stage, before host-side Git reads any of it: the
 * changed and untracked paths outside private staging, counted, and sized by
 * lstat. Git hashes a sparse file's whole apparent size, so that counts; a
 * preallocated file counts at its allocated blocks.
 */
async function assertCandidateBounds(
  worktree: string,
  bounds: { maxBytes: number; maxFiles: number },
  signal: AbortSignal,
): Promise<void> {
  // Git prints names as raw bytes. A name that is not UTF-8 would decode to
  // another path, which lstat misses and Git still hashes.
  const names = (output: Buffer) => {
    try {
      return new TextDecoder("utf-8", { fatal: true })
        .decode(output)
        .split("\0");
    } catch {
      throw new WorkFinding("Worker candidate has an unsafe path");
    }
  };
  // Neither listing reads file contents: diff-index (without --cached)
  // names every path whose stat differs from the index, where diff would
  // hash it, through any clean filter (Git LFS's stores what it cleans).
  const listed = await Promise.all([
    hostGit(
      worktree,
      ["diff-index", "--name-only", "--no-renames", "-z", "HEAD"],
      { signal },
    ),
    hostGit(worktree, ["ls-files", "--others", "--exclude-standard", "-z"], {
      signal,
    }),
  ]);
  const prospective = [
    ...new Set(listed.flatMap(names).filter(Boolean)),
  ].filter((path) => !privateStagingPath(path));
  if (prospective.length > bounds.maxFiles)
    throw new WorkFinding(
      `Worker candidate exceeds the admitted file bound: ${prospective.length} files, at most ${bounds.maxFiles}`,
    );
  let bytes = 0;
  for (const path of prospective) {
    const file = resolve(worktree, path);
    if (!file.startsWith(`${resolve(worktree)}${sep}`))
      throw new WorkFinding("Worker candidate has an unsafe path");
    const info = await lstat(file).catch(() => undefined);
    bytes += info?.isFile() ? Math.max(info.size, info.blocks * 512) : 0;
  }
  if (bytes > bounds.maxBytes)
    throw new WorkFinding(
      `Worker candidate exceeds the admitted byte bound: ${bytes} bytes, at most ${bounds.maxBytes}`,
    );
}

/** The first path under the worktree Factory cannot read, if any. */
async function firstUnreadable(
  directory: string,
  relative = "",
): Promise<string | undefined> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return relative || ".";
  }
  for (const name of names) {
    if (!relative && name === ".git") continue;
    const path = join(directory, name);
    const shown = relative ? `${relative}/${name}` : name;
    const type = await lstat(path);
    if (type.isDirectory()) {
      const inner = await firstUnreadable(path, shown);
      if (inner) return inner;
    } else if (type.isFile()) {
      try {
        await (await open(path, "r")).close();
      } catch {
        return shown;
      }
    }
  }
  return undefined;
}

/**
 * Guard the staged candidate before Factory commits it: safe filesystem
 * entries, owned paths, regular-file modes, and no secrets. Returns the
 * changed paths.
 */
async function checkStagedCandidate(input: Scan): Promise<string[]> {
  const { worktree, signal } = input;
  await checkWorktreeEntries(worktree, signal);
  const paths = (
    await hostGit(
      worktree,
      ["diff", "--cached", "--name-only", "-z", "--no-renames", "HEAD"],
      { signal },
    )
  )
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  const unowned = paths.filter(
    (path) => !ownsPath(path, input.item.ownedPaths),
  );
  if (unowned.length)
    throw new WorkFinding(
      `Worker changed paths outside ownership: ${unowned.join(", ")}`,
    );
  const guarded = paths.filter(
    (path) => protectedPath(path) && !input.mayChange.includes(path),
  );
  if (guarded.length)
    throw new WorkFinding(
      `Worker changed protected paths the Objective's May change section doesn't list: ${guarded.join(", ")}. CI configuration, .github/ and CODEOWNERS change only when that section lists the exact path; undo these changes`,
    );
  const findings: SecretFinding[] = [];
  for (const path of paths) {
    await checkChangedPath(worktree, path);
    const entry = await stagedEntry(worktree, path, signal);
    if (!entry) continue; // Deletion has no new content to publish.
    if (path === ".gitmodules" || !["100644", "100755"].includes(entry.mode))
      throw new WorkFinding(
        `Worker changed unsafe Git entry at ${JSON.stringify(path)}`,
      );
    const scanRoot = await mkdtemp(join(dirname(worktree), "secret-scan-"));
    try {
      const staged = join(scanRoot, "content", path);
      await mkdir(dirname(staged), { recursive: true, mode: 0o700 });
      const output = await open(staged, "wx", 0o600);
      let copy: GitExit;
      try {
        copy = await hostGitExit(worktree, ["cat-file", "blob", entry.blob], {
          stdout: output.fd,
          signal,
        });
      } finally {
        await output.close();
      }
      if (copy.code !== 0)
        throw new Error(
          `Cannot read staged content at ${JSON.stringify(path)}`,
        );
      let finding = await scanFile(input, path, staged, scanRoot);
      if (
        !finding &&
        (
          await hostGit(worktree, ["hash-object", "--no-filters", "--", path], {
            signal,
          })
        )
          .toString("utf8")
          .trim() !== entry.blob
      )
        finding = await scanFile(input, path, join(worktree, path), scanRoot);
      if (finding) findings.push(finding);
    } finally {
      await rm(scanRoot, { recursive: true, force: true });
    }
  }
  if (findings.length) throw new CollectionStop(secretHold(findings));
  return paths;
}

async function stagedEntry(
  worktree: string,
  path: string,
  signal: AbortSignal,
): Promise<{ mode: string; blob: string } | null> {
  const output = await hostGit(
    worktree,
    ["ls-files", "--stage", "-z", "--", path],
    { signal },
  );
  if (!output.length) return null;
  const line = output.toString("utf8");
  const match = /^(\d{6}) ([a-f0-9]{40,64}) 0\t([^\0]*)\0$/.exec(line);
  if (!match || match[3] !== path)
    throw new Error(`Cannot verify staged entry at ${JSON.stringify(path)}`);
  return { mode: match[1]!, blob: match[2]! };
}

async function checkChangedPath(worktree: string, path: string): Promise<void> {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path
      .split("/")
      .some(
        (component) => !component || component === "." || component === "..",
      )
  )
    throw new WorkFinding(`Worker changed unsafe path ${JSON.stringify(path)}`);
  const destination = resolve(worktree, path);
  if (!within(destination, worktree))
    throw new WorkFinding(
      `Worker changed path outside worktree: ${JSON.stringify(path)}`,
    );
  let current = worktree;
  for (const component of path.split("/")) {
    current = join(current, component);
    let type: import("node:fs").Stats;
    try {
      type = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (type.isSymbolicLink() || (!type.isFile() && !type.isDirectory()))
      throw new WorkFinding(
        `Worker changed unsafe filesystem entry at ${JSON.stringify(path)}`,
      );
  }
  const exists = await lstat(destination).catch(() => undefined);
  if (exists && !within(await realpath(destination), worktree))
    throw new WorkFinding(
      `Worker changed path escaping worktree: ${JSON.stringify(path)}`,
    );
}

/** Ignored links are not delivery candidates, but must still resolve safely. */
async function safeIgnoredLink(
  worktree: string,
  path: string,
  signal: AbortSignal,
): Promise<boolean> {
  if (
    (
      await hostGit(worktree, ["ls-files", "--stage", "-z", "--", path], {
        signal,
      })
    ).length
  )
    return false; // A staged entry or descendant cannot use this exception.
  // check-ignore accepts literal filenames, not pathspecs.
  const ignored = await hostGitExit(
    worktree,
    ["check-ignore", "-q", "--", path],
    { magic: true, stdout: "ignore", signal },
  );
  if (ignored.code === 1) return false;
  if (ignored.code !== 0)
    throw new Error(`Cannot verify ignored entry at ${JSON.stringify(path)}`);
  try {
    const destination = await realpath(join(worktree, path));
    if (
      destination === resolve(worktree) ||
      !within(destination, worktree) ||
      within(destination, join(worktree, ".git"))
    )
      return false;
    const type = await lstat(destination);
    return type.isFile() || type.isDirectory();
  } catch {
    return false; // Missing, cyclic or unreadable targets are not safe generated links.
  }
}

/** Recurse even through ignored directories: special files and unsafe links still fail. */
async function checkWorktreeEntries(
  worktree: string,
  signal: AbortSignal,
): Promise<void> {
  const inspect = async (directory: string, relative: string) => {
    for (const name of await readdir(directory)) {
      if (!relative && name === ".git") continue;
      const path = relative ? `${relative}/${name}` : name;
      if (name === ".git")
        throw new WorkFinding(
          `Worker created a nested Git entry at ${JSON.stringify(path)}; Factory refuses nested repositories and submodules`,
        );
      const absolute = join(directory, name);
      const type = await lstat(absolute);
      if (type.isDirectory()) {
        await inspect(absolute, path);
      } else if (type.isSymbolicLink()) {
        const base = (
          await hostGit(worktree, ["ls-tree", "HEAD", "--", path], { signal })
        ).toString("utf8");
        if (
          !base.startsWith("120000 blob\t") &&
          !base.startsWith("120000 blob ") &&
          !(
            base.length === 0 && (await safeIgnoredLink(worktree, path, signal))
          )
        )
          throw new WorkFinding(
            `Worker introduced unsafe symlink at ${JSON.stringify(path)}`,
          );
      } else if (!type.isFile()) {
        throw new WorkFinding(
          `Worker introduced special file at ${JSON.stringify(path)}`,
        );
      }
    }
  };
  await inspect(worktree, "");
}

// ── Secret scan ─────────────────────────────────────────────────────────

interface SecretFinding {
  path: string;
  rules: string[];
}

/** Collection's input with the Secretlint rules it scans with. */
type Scan = CollectInput & { rules: string };

/** What a scan needs: the rules and the call's signal. */
type Scanner = Pick<Scan, "rules" | "signal">;

const RECOMMENDED_RULES = JSON.stringify({
  rules: [{ id: "@secretlint/secretlint-rule-preset-recommend" }],
});

/**
 * The scanner child: Secretlint's file API on one exact file, with no CLI
 * config discovery, globs or target ignore files. Exit 0 clean, 1 finding,
 * 2 unavailable. The engine is loaded from Factory's own installation by
 * absolute URL, never resolved from the scanned tree.
 */
const SCANNER = `const [source, descriptor, engine] = process.argv.slice(1);
try {
  const { createEngine } = await import(engine);
  const scanner = await createEngine({ configFileJSON: JSON.parse(descriptor), formatter: "compact", maskSecrets: true, color: false, terminalLink: false });
  const result = await scanner.executeOnFiles({ filePathList: [source] });
  if (result.output) process.stdout.write(result.output + "\\n");
  process.exitCode = result.ok ? 0 : 1;
} catch {
  process.stderr.write("Secretlint scan unavailable\\n");
  process.exitCode = 2;
}`;

const SCAN_TIMEOUT_MS = 5 * 60_000;

/** The operator's Secretlint rules, or a hold naming the fix. */
async function scannerRules(config: string | undefined): Promise<string> {
  if (!config) return RECOMMENDED_RULES;
  try {
    return await readFile(config, "utf8");
  } catch (error) {
    throw new CollectionStop(
      objectiveWide(
        hold(
          `policy.secretlintConfig ${config} can't be read (${errorMessage(error)}). Fix the file or the configuration, restart the service, then answer retry.`,
        ),
      ),
    );
  }
}

/**
 * Scan one file. A finding names its rules; a scanner that can't run stops
 * collection with a retry.
 */
async function scanFile(
  input: Scanner,
  path: string,
  source: string,
  scanRoot: string,
): Promise<SecretFinding | undefined> {
  const result = await new Promise<{ code: number | null; output: string }>(
    (done) => {
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          SCANNER,
          source,
          input.rules,
          import.meta.resolve("@secretlint/node"),
        ],
        {
          cwd: scanRoot,
          env: workerEnvironment(join(scanRoot, "empty-gh-config")),
          stdio: ["ignore", "pipe", "pipe"],
          timeout: SCAN_TIMEOUT_MS,
          killSignal: "SIGKILL",
          signal: input.signal,
        },
      );
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => {
        if (output.length < 8192) output += chunk.toString("utf8");
      });
      child.stderr.resume();
      child.on("error", () => done({ code: null, output }));
      child.on("close", (code) => done({ code, output }));
    },
  );
  if (input.signal.aborted) throw input.signal.reason;
  if (result.code !== 0 && result.code !== 1)
    throw new CollectionStop({
      kind: "retry",
      reason: `Secretlint could not check ${JSON.stringify(path)}; publication stopped`,
    });
  if (result.code === 0) return undefined;
  const named = [
    ...new Set(
      [...result.output.matchAll(/@secretlint\/secretlint-rule-[A-Za-z0-9-]+/g)]
        .map((match) => match[0])
        .filter((rule) => !rule.includes("-rule-preset-")),
    ),
  ];
  return {
    path,
    rules: named.length ? named : ["Secretlint recommended rules"],
  };
}

/**
 * Private staging Factory keeps (handoff notes, the media manifest, captured
 * media members) crosses the same secret boundary as the result before it
 * is retained. Scans the exact bytes Factory kept: `bytes` read from staging
 * file `name`, or the file Factory copied them to (`path`), not the worker's
 * file again. Undefined when clean; otherwise one secret hold naming every
 * finding (`repair` → repair to work, `retry` → collect again, `cancel`), or
 * a retry when the scanner can't run or a hold when
 * policy.secretlintConfig can't be read. collect and media's captureAssets
 * both call it.
 */
export async function scanStaging(
  input: Pick<CollectInput, "secretlintConfig" | "worktree" | "signal"> & {
    rules?: string;
  },
  entries: readonly ({ name: string } & (
    | { bytes: Buffer }
    | { path: string }
  ))[],
): Promise<Exclude<Collection, { kind: "collected" | "repair" }> | undefined> {
  const scanRoot = await mkdtemp(join(dirname(input.worktree), "secret-scan-"));
  try {
    const scanner = {
      rules: input.rules ?? (await scannerRules(input.secretlintConfig)),
      signal: input.signal,
    };
    const findings: SecretFinding[] = [];
    for (const [index, entry] of entries.entries()) {
      let source: string;
      if ("path" in entry) source = entry.path;
      else {
        source = join(scanRoot, String(index), basename(entry.name));
        await mkdir(dirname(source), { mode: 0o700 });
        await writeFile(source, entry.bytes, { mode: 0o600, flag: "wx" });
      }
      const finding = await scanFile(scanner, entry.name, source, scanRoot);
      if (finding) findings.push(finding);
    }
    return findings.length ? secretHold(findings) : undefined;
  } catch (error) {
    if (error instanceof CollectionStop && error.outcome.kind !== "repair")
      return error.outcome;
    throw error;
  } finally {
    await rm(scanRoot, { recursive: true, force: true });
  }
}

function secretHold(
  findings: readonly SecretFinding[],
): Extract<Collection, { kind: "hold" }> {
  const found = findings
    .map(({ path, rules }) => `${JSON.stringify(path)} (${rules.join(", ")})`)
    .join(", ");
  return hold(
    `Secretlint found suspected secret in ${found}. Publication stopped. Operator: review the finding; remove or rotate the value, or name a reviewed Secretlint config outside the target checkout in policy.secretlintConfig, restart the service and explicitly retry. Answer repair to have the worker remove the value, retry to collect again, or cancel.`,
    [
      {
        answer: "repair",
        family: "repair",
        consequence: "The worker removes the value.",
      },
      {
        answer: "retry",
        family: "retry",
        consequence: "Collects the result again.",
      },
      "cancel",
    ],
  );
}

// ── Handoff manifest ────────────────────────────────────────────────────

/** The peers a handoff note may name: every other planned item, by index. */
export function handoffPeers(
  plan: Pick<Plan, "items">,
  item: Pick<WorkItem, "id">,
): { id: string; title: string }[] {
  return plan.items
    .filter((peer) => peer.id !== item.id)
    .map(({ id, title }) => ({ id, title }));
}

/**
 * Learnings are short; a verification map names every sub-clause of one
 * acceptance criterion with its proof locations, so it gets more room.
 */
const LEARNING_LIMIT = { notes: 16, summary: 1024, paths: 8 };
/** One verification note per acceptance criterion; the manifest size bounds the rest. */
const VERIFICATION_LIMIT = { summary: 4096, paths: 16 };
/**
 * One design note per design risk: an answer and the file:line locations it rests on. Decision:
 * half the verification-note limits, because a note answers one question, not a whole criterion.
 */
const DESIGN_LIMIT = { summary: 2048, paths: 8 };
/** Every design risk a note may answer: the generic questions, then the repository's own. */
const DESIGN_RISKS: readonly string[] = [
  ...Object.keys(DESIGN_QUESTIONS),
  "repository",
];
const NOTE_KINDS = [
  "interface",
  "pitfall",
  "hypothesis",
  "verification",
  "design",
];

/**
 * The most distinct files one item's handoff can cite: every learning note and
 * every criterion's verification map at its path limit.
 */
export function maxHandoffSources(criterionCount: number): number {
  return (
    LEARNING_LIMIT.notes * LEARNING_LIMIT.paths +
    criterionCount * VERIFICATION_LIMIT.paths +
    DESIGN_RISKS.length * DESIGN_LIMIT.paths
  );
}

/** A literal repository file, never a directory, `.git` or private staging. */
const filePath = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 512 &&
  validPath(value) &&
  !/[*?]/.test(value) &&
  value.split("/").every((part) => part === part.trim()) &&
  !value.split("/").some((part) => part.toLowerCase() === ".git") &&
  !value.startsWith(".factory-");

/** Verification and design notes describe one result for its own review. */
const reviewNote = (kind: unknown) =>
  kind === "verification" || kind === "design";
/** Name a key in a problem without echoing more than a short bound of model text. */
const keyName = (key: string) =>
  JSON.stringify(key.length > 64 ? `${key.slice(0, 64)}…` : key);
/** Missing and unexpected keys, so a worker can repair the whole object at once. */
function keyProblems(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): string[] {
  const unexpected = Object.keys(value).filter(
    (key) => !required.includes(key) && !optional.includes(key),
  );
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  return [
    ...(unexpected.length
      ? [`unexpected key ${unexpected.map(keyName).join(", ")}`]
      : []),
    ...(missing.length ? [`missing key ${missing.join(", ")}`] : []),
  ];
}

function noteFieldProblems(note: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const verification = note.kind === "verification";
  const design = note.kind === "design";
  const limit = verification
    ? VERIFICATION_LIMIT
    : design
      ? DESIGN_LIMIT
      : LEARNING_LIMIT;
  if (Object.hasOwn(note, "kind") && !NOTE_KINDS.includes(note.kind as string))
    problems.push(`kind must be one of ${NOTE_KINDS.join(", ")}`);
  if (verification) {
    if (
      !Number.isSafeInteger(note.criterionIndex) ||
      (note.criterionIndex as number) < 0
    )
      problems.push("a verification note needs an integer criterionIndex >= 0");
  } else if (note.criterionIndex !== undefined)
    problems.push("criterionIndex is allowed only on verification notes");
  if (design) {
    if (!DESIGN_RISKS.includes(note.designRisk as string))
      problems.push(
        `a design note needs a designRisk, one of ${DESIGN_RISKS.join(", ")}`,
      );
  } else if (note.designRisk !== undefined)
    problems.push("designRisk is allowed only on design notes");
  if (Object.hasOwn(note, "summary")) {
    if (typeof note.summary !== "string" || !note.summary.trim())
      problems.push("summary must be a non-empty string");
    else if (note.summary.length > limit.summary)
      problems.push(
        `summary has ${note.summary.length} characters; at most ${limit.summary} for this kind`,
      );
  }
  if (Object.hasOwn(note, "paths")) {
    if (!Array.isArray(note.paths))
      problems.push("paths must be an array of repository file paths");
    else {
      if (note.paths.length > limit.paths)
        problems.push(
          `paths has ${note.paths.length} entries; at most ${limit.paths} for this kind`,
        );
      const invalid = note.paths.findIndex((path) => !filePath(path));
      if (invalid >= 0)
        problems.push(
          `paths[${invalid}] is not a literal repository file path (no directory, .git or .factory- staging path)`,
        );
      if (new Set(note.paths).size !== note.paths.length)
        problems.push("paths has duplicate entries");
    }
  }
  return problems;
}

/** Note-count limits over the notes that are objects. */
function countProblems(notes: readonly Record<string, unknown>[]): string[] {
  const problems: string[] = [];
  const learning = notes.filter((note) => !reviewNote(note.kind)).length;
  if (learning > LEARNING_LIMIT.notes)
    problems.push(
      `${learning} learning notes; at most ${LEARNING_LIMIT.notes} are allowed`,
    );
  const repeated = (values: unknown[]) =>
    [
      ...new Set(
        values.filter((value, index) => values.indexOf(value) !== index),
      ),
    ]
      .map(String)
      .join(", ");
  const criteria = repeated(
    notes
      .filter((note) => note.kind === "verification")
      .map((note) => note.criterionIndex),
  );
  if (criteria)
    problems.push(
      `more than one verification note for criterionIndex ${criteria}; write exactly one per criterion`,
    );
  const risks = repeated(
    notes
      .filter((note) => note.kind === "design")
      .map((note) => note.designRisk),
  );
  if (risks)
    problems.push(
      `more than one design note for designRisk ${risks}; write exactly one per risk`,
    );
  return problems;
}

/** One problem naming every structural problem found, bounded for prompts and records. */
function handoffProblem(problems: readonly string[]): { problem: string } {
  const shown = problems.slice(0, 12);
  return {
    problem: `Handoff manifest is invalid:${shown.map((problem) => `\n- ${problem}`).join("")}${problems.length > shown.length ? `\n- and ${problems.length - shown.length} more` : ""}`,
  };
}

/** Decode the indexed declaration; a rejected manifest is never repaired. */
function decodeHandoff(
  value: unknown,
  peers: readonly { id: string; title: string }[],
  criterionCount: number,
): HandoffNote[] | { problem: string } {
  if (!isRecord(value))
    return handoffProblem([
      "the manifest must be a JSON object whose only key is notes",
    ]);
  const extra = Object.keys(value).filter((key) => key !== "notes");
  const problems = extra.length
    ? [
        `unexpected top-level key ${extra.map(keyName).join(", ")}; the only top-level key is notes`,
      ]
    : [];
  if (!Array.isArray(value.notes))
    return handoffProblem([
      ...problems,
      "notes must be an array of note objects",
    ]);
  if (
    value.notes.length >
    LEARNING_LIMIT.notes + criterionCount + DESIGN_RISKS.length
  )
    problems.push(
      `${value.notes.length} notes; at most ${LEARNING_LIMIT.notes} learning notes, one verification note for each of the ${criterionCount} criteria and one design note for each of the ${DESIGN_RISKS.length} design risks`,
    );
  const objects: Record<string, unknown>[] = [];
  value.notes.forEach((raw: unknown, index) => {
    if (!isRecord(raw)) {
      problems.push(`note ${index} must be an object`);
      return;
    }
    objects.push(raw);
    const noteProblems = [
      ...keyProblems(
        raw,
        ["kind", "summary", "paths", "consumerIndices"],
        ["criterionIndex", "designRisk"],
      ),
      ...noteFieldProblems(raw),
    ];
    const criterionIndex = raw.criterionIndex;
    if (
      Number.isSafeInteger(criterionIndex) &&
      (criterionIndex as number) >= criterionCount
    )
      noteProblems.push(
        `criterionIndex ${criterionIndex} names no acceptance criterion of this Work Item (it has ${criterionCount})`,
      );
    else if (
      criterionIndex !== undefined &&
      !Number.isSafeInteger(criterionIndex)
    )
      noteProblems.push("criterionIndex must be an integer");
    const indices = raw.consumerIndices;
    if (
      Object.hasOwn(raw, "consumerIndices") &&
      (!Array.isArray(indices) ||
        indices.length > 16 ||
        new Set(indices).size !== indices.length ||
        !indices.every(
          (index) =>
            Number.isSafeInteger(index) && index >= 0 && index < peers.length,
        ))
    )
      noteProblems.push(
        peers.length
          ? `consumerIndices must be at most 16 distinct integers from 0 to ${peers.length - 1}`
          : "consumerIndices must be [] (this Work Item has no peers)",
      );
    else if (
      reviewNote(raw.kind) &&
      Array.isArray(indices) &&
      indices.length !== 0
    )
      noteProblems.push(`a ${String(raw.kind)} note must have no consumers`);
    if (noteProblems.length)
      problems.push(`note ${index}: ${noteProblems.join("; ")}`);
  });
  problems.push(...countProblems(objects));
  if (problems.length) return handoffProblem(problems);
  const notes = objects.map(
    (note): HandoffNote => ({
      kind: note.kind as HandoffNote["kind"],
      summary: note.summary as string,
      paths: [...(note.paths as string[])],
      consumers: (note.consumerIndices as number[]).map(
        (index) => peers[index]!.id,
      ),
      ...(note.kind === "verification"
        ? { criterionIndex: note.criterionIndex as number }
        : {}),
      ...(note.kind === "design"
        ? { designRisk: note.designRisk as DesignRisk }
        : {}),
    }),
  );
  const cited = new Set(notes.flatMap((note) => note.paths)).size;
  if (cited > maxHandoffSources(criterionCount))
    return handoffProblem([
      `notes cite more than ${maxHandoffSources(criterionCount)} distinct files`,
    ]);
  return notes;
}

/** Models choose recipients; the controller owns their identities. */
export function workHandoffSchema(
  peerCount: number,
  criterionCount: number,
): Record<string, unknown> {
  const paths = (maxItems: number) => ({
    type: "array",
    maxItems,
    uniqueItems: true,
    items: { type: "string", minLength: 1, maxLength: 512 },
  });
  const learning = {
    type: "object",
    additionalProperties: false,
    required: ["kind", "summary", "paths", "consumerIndices"],
    properties: {
      kind: { type: "string", enum: ["interface", "pitfall", "hypothesis"] },
      summary: {
        type: "string",
        minLength: 1,
        maxLength: LEARNING_LIMIT.summary,
      },
      paths: paths(LEARNING_LIMIT.paths),
      consumerIndices: {
        type: "array",
        maxItems: peerCount === 0 ? 0 : 16,
        uniqueItems: true,
        items: {
          type: "integer",
          minimum: 0,
          ...(peerCount > 0 ? { maximum: peerCount - 1 } : {}),
        },
      },
    },
  };
  const verification = {
    type: "object",
    additionalProperties: false,
    required: ["kind", "summary", "paths", "consumerIndices", "criterionIndex"],
    properties: {
      kind: { type: "string", const: "verification" },
      summary: {
        type: "string",
        minLength: 1,
        maxLength: VERIFICATION_LIMIT.summary,
      },
      paths: paths(VERIFICATION_LIMIT.paths),
      criterionIndex: {
        type: "integer",
        minimum: 0,
        maximum: criterionCount - 1,
      },
      consumerIndices: { type: "array", maxItems: 0 },
    },
  };
  const design = {
    type: "object",
    additionalProperties: false,
    required: ["kind", "designRisk", "summary", "paths", "consumerIndices"],
    properties: {
      kind: { type: "string", const: "design" },
      designRisk: { type: "string", enum: DESIGN_RISKS },
      summary: {
        type: "string",
        minLength: 1,
        maxLength: DESIGN_LIMIT.summary,
      },
      paths: paths(DESIGN_LIMIT.paths),
      consumerIndices: { type: "array", maxItems: 0 },
    },
  };
  return {
    type: "object",
    additionalProperties: false,
    required: ["notes"],
    properties: {
      notes: {
        type: "array",
        maxItems: LEARNING_LIMIT.notes + criterionCount + DESIGN_RISKS.length,
        items: {
          oneOf:
            criterionCount > 0
              ? [learning, verification, design]
              : [learning, design],
        },
      },
    },
  };
}
