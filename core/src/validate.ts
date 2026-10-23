/**
 * Validation: the one validator. The validate step, the worker's own
 * Validate tool and final validation all run a candidate's commands here, in
 * a fresh detached worktree of the exact commit, every command through the
 * OS sandbox. Before anything runs, the package scripts the commands use are
 * pinned to the accepted base. The answer is data: per-command results, or a
 * classified problem the step turns into an outcome. A failed command is the
 * candidate's (repair); a failed install whose inputs match the base is the
 * environment's (retry); an install that ran offline for the host's lack of
 * network, or a configuration fault, is the operator's (hold).
 */
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isScalar, parseDocument, visit } from "yaml";
import type { SandboxConfig } from "./config.js";
import { hold, type Outcome, objectiveWide } from "./engine.js";
import { GitRefusal } from "./git.js";
import { knowledgeSettings } from "./knowledge/settings.js";
import {
  hydrateTree,
  type LfsFile,
  rewrittenMedia,
  type SelectedMember,
} from "./media.js";
import { declaration, onlyEntry } from "./objective.js";
import { installNetworkRefusal } from "./package-network.js";
import { forceRemove, openParent, within } from "./paths.js";
import {
  PINNED_NPM_BOOTSTRAP,
  PINNED_PNPM_BOOTSTRAP,
  packageBootstrap,
  packageManagerVersionProbe,
  packageScriptInvocation,
} from "./planning/facts.js";
import { ownsPath } from "./planning/graph.js";
import { packageManagerUpdate } from "./planning/prompts.js";
import type { Plan, WorkItem } from "./planning/types.js";
import {
  captureReviewArtifacts,
  outputLimit,
  plannedReviewArtifactsProblem,
  type ReviewArtifact,
  type ReviewArtifactSelector,
  selectorsFor,
} from "./review/artifacts.js";
import { runSandboxed, sandboxAvailable } from "./sandbox.js";
import type { ObjectiveBlock } from "./shown.js";
import { errorMessage, headAndTail } from "./text.js";
import { privateStagingPath } from "./work/collect.js";
import {
  addWorktree,
  hasGitlink,
  hostGit,
  removeWorktree,
  validationEnvironment,
} from "./worktree.js";

const MINUTE = 60_000;

export interface ValidateInput {
  /** The target clone; the fresh worktree is linked from it. */
  checkout: string;
  /** Where the fresh worktree goes, such as `<item worktree>.validation`. Replaced, then removed. */
  directory: string;
  /** The exact candidate commit. */
  commit: string;
  /** One Work Item's commands, or, absent, the plan's final commands. */
  item?: WorkItem;
  plan: Plan;
  /** The Objective as planned (shown.ts): its Package manager update and Workspace package additions. */
  blocks: readonly ObjectiveBlock[];
  /** The commit a later item started from, when not the base: its new scripts stay fixed too. */
  predecessor?: string;
  sandbox: SandboxConfig;
  /** Each command's limit; past it the command failed. */
  commandTimeoutMs?: number;
  /**
   * The worker's checkout, for its own Validate: files the commands produce
   * under the item's owned paths that Git ignores come back to it.
   */
  returnTo?: string;
  /**
   * Review artifact capture, for the validate step and final validation
   * (never the worker's own Validate). Each passing, non-preparation command
   * is captured with `selectorsFor(configured, item)` while its checkout and
   * TMPDIR still exist; the captures come back as `artifacts` in `passed`.
   */
  reviewArtifacts?: {
    /** The installation's selectors now: `config.reviewArtifacts`. */
    configured: readonly ReviewArtifactSelector[];
    /**
     * The selectors the plan was compiled and reviewed with. One the
     * installation no longer configures holds before anything runs.
     */
    planned?: readonly ReviewArtifactSelector[];
    /** Private capture directory, such as `<state>/artifacts/<issue>/<item>` or `.../final`; emptied first. */
    dir: string;
  };
  /** Origin's `owner/name`: Git LFS objects the local store lacks are fetched from it. */
  repository: string;
  /**
   * The selected media the tree must hold: media's `validationMembers(plan,
   * item, selection)`. Every Git LFS file of the tree, these and any other,
   * is restored before any command runs (hydrateTree); restored files are
   * left out of the clean and mutation checks, and after the commands
   * their bytes must still be their pointers'.
   */
  media?: readonly SelectedMember[];
  signal: AbortSignal;
  log(event: Record<string, unknown>): void;
}

export interface CommandResult {
  command: string;
  /** Final validation's bootstrap and declared prerequisites, run before its commands. */
  preparation?: true;
  exitCode: number | null;
  durationMs: number;
  /** The end of the command's output. */
  tail: string;
}

export type Validation =
  | {
      kind: "passed";
      tree: string;
      /** The commands that ran, preparation first. */
      commands: string[];
      results: CommandResult[];
      /** What came back to `returnTo`, for the worker; absent when nothing did. */
      produced?: string;
      /** Every review artifact captured, in command order; present when `reviewArtifacts` was given. */
      artifacts?: ReviewArtifact[];
    }
  /** The candidate's fault: the step repairs it. */
  | {
      kind: "failed";
      tree: string;
      commands: string[];
      /** The commands that passed before the failure. */
      results: CommandResult[];
      /** The failed command, when one ran or its review artifact capture failed; absent for a pin or the mutation check. */
      failed?: { index: number; command: string };
      /** What people read: the start and end of the output. */
      detail: string;
      /** The complete output, for diagnosis and the next attempt. */
      output: string;
      produced?: string;
    }
  | Extract<Outcome, { kind: "retry" | "hold" }>;

/**
 * Validate `commit`: pins first, then every command in a fresh checkout.
 *
 * Outcomes: `passed` → done (keep `artifacts` in the done result for
 * review); `failed` → repair in the validate step (final validation: the
 * final step's handling of a failed command), and a failed review artifact
 * capture is one, naming its command; `retry` → retry; `hold` → hold. A
 * plan selector the installation dropped is a hold with retry (after the
 * selector is restored), replan or cancel; a required media member whose
 * pointer is gone, a Git LFS file neither the local store nor origin can
 * restore, or LFS files over the bound are media's hold (hydrateTree).
 */
export async function validateTree(input: ValidateInput): Promise<Validation> {
  const { checkout, commit, plan, item } = input;
  const { preparation, commands } = item
    ? { preparation: [], commands: item.validation.map((v) => v.command) }
    : finalSequence(plan);
  const sequence = [...preparation, ...commands];
  const { signal } = input;
  const tree = await revParse(checkout, `${commit}^{tree}`, signal);
  // Sandboxed commands can write any directory of the checkout. Behind a
  // gitlink, host-side Git would enter a repository they wrote, with its
  // configuration; so no tree with one is validated.
  if (await hasGitlink(checkout, { commit, signal }))
    return objectiveWide(
      hold(
        "Factory does not validate trees that contain submodule gitlinks: host-side Git would enter repositories sandboxed commands can write. Use Factory on a repository without submodules.",
      ),
    );
  const capture = input.reviewArtifacts;
  const dropped =
    capture?.planned &&
    plannedReviewArtifactsProblem(capture.planned, capture.configured);
  if (dropped)
    return objectiveWide(
      hold(
        `${dropped}. Restore these selectors in the installation's reviewArtifacts (others may stay or be added), restart the service (it reads its configuration only at start) and answer retry; answer replan to plan again with the current selectors; or cancel.`,
        ["retry", "replan", "cancel"],
      ),
    );
  const selectors = capture ? selectorsFor(capture.configured, item) : [];
  const refusal = await pinRefusal(
    new Revisions(checkout, commit, signal),
    plan.base,
    commit,
    sequence,
    item
      ? {
          sourceDeclared: sourceDeclared([item]),
          workspacePackageAdditions: workspaceAdditions(input.blocks).additions,
          packageManagerUpdate: packageManagerUpdate(input.blocks),
          predecessor: input.predecessor,
        }
      : {
          sourceDeclared: [
            ...sourceDeclared(plan.items),
            ...plan.finalCommands,
          ],
          workspacePackageAdditions: workspaceAdditions(input.blocks).additions,
          packageManagerUpdate: packageManagerUpdate(input.blocks),
          requirePackageManagerUpdate: true,
        },
  );
  if (refusal?.blame === "config")
    return hold(
      `${refusal.message}. The plan's commands or the Objective's declarations need this authority: edit the Objective's Sources or declarations and replan, or cancel.`,
      ["replan", "cancel"],
    );
  if (refusal)
    return {
      kind: "failed",
      tree,
      commands: sequence,
      results: [],
      detail: refusal.message,
      output: refusal.message,
    };
  const worktree = input.directory;
  try {
    await removeWorktree(checkout, worktree, input.signal);
    await addWorktree(checkout, worktree, commit, input.signal);
  } catch (error) {
    input.signal.throwIfAborted();
    // Refused Git is the operator's to fix: the caller holds.
    if (error instanceof GitRefusal) throw error;
    return {
      kind: "retry",
      reason: `The validation checkout could not be made at ${worktree}: ${errorMessage(error)}. Free disk space and keep the target checkout writable.`,
    };
  }
  const scratch: string[] = [];
  let produced: string | undefined;
  try {
    const made = async (prefix: string) => {
      const path = await mkdtemp(join(tmpdir(), prefix));
      scratch.push(path);
      return path;
    };
    let temporary: string;
    let home: string;
    let credentials: string;
    try {
      // One empty TMPDIR per run, under tmpdir() so socket paths stay short.
      // The private HOME lasts the whole sequence, so what setup puts there
      // (caches, downloaded browsers) reaches the commands after it. gh
      // reads an empty configuration: no credentials.
      temporary = await made("factory-validation-");
      home = await made("factory-home-");
      credentials = await made("factory-gh-");
    } catch (error) {
      return {
        kind: "retry",
        reason: `The validation environment could not be made: ${errorMessage(error)}. Free space in ${tmpdir()}.`,
      };
    }
    // Commands run only in the exact commit's fresh checkout: HEAD at the
    // commit, its tree the candidate's, nothing changed.
    if ((await revParse(worktree, "HEAD", signal)) !== commit)
      return hold(
        `The validation checkout at ${worktree} is not at ${commit}. Answer retry to make it again; if it repeats, report it: Factory's checkout is wrong.`,
      );
    const checkedOut = await revParse(worktree, "HEAD^{tree}", signal);
    if (checkedOut !== tree)
      return hold(
        `The validation checkout's tree ${checkedOut} is not the candidate's tree ${tree}. Answer retry to make it again; if it repeats, report it: Factory's checkout is wrong.`,
      );
    // Git LFS files arrive as pointers; commands get their bytes, as in a
    // clone. Restored files differ from their pointer blobs by design.
    const restored = await hydrateTree({
      directory: worktree,
      repository: input.repository,
      commit,
      members: input.media ?? [],
      // Linked files are safe only behind the sandbox's read-only mounts.
      link: sandboxAvailable().available,
      signal,
    });
    if (restored.kind !== "done") return restored;
    const lfsFiles: readonly LfsFile[] = restored.value;
    const hydrated = new Set(lfsFiles.map((file) => file.path));
    const linked = lfsFiles.filter((file) => file.linked);
    const baseline = await status(worktree, signal);
    const dirty = mutationDetail(Buffer.alloc(0), baseline, hydrated);
    if (dirty) {
      // Checkout filters (line-ending or other attributes) rewrite what
      // the candidate committed; the candidate commits files as checked out.
      const detail = `Validation checkout is not clean before any command ran: ${dirty}. Commit these files as Git checks them out (renormalize them under the repository's .gitattributes), so a fresh checkout of the result is clean.`;
      return {
        kind: "failed",
        tree,
        commands: sequence,
        results: [],
        detail,
        output: detail,
      };
    }
    const results: CommandResult[] = [];
    let artifacts: ReviewArtifact[] = [];
    for (const [index, command] of sequence.entries()) {
      const preparing = index < preparation.length;
      // Only Factory's exact script-disabled install, run first (before any
      // command could change the checkout) after its package inputs were
      // pinned above, writes the shared store; and only it, when the
      // operator allowed it, reaches the network. It gets an empty HOME of
      // its own, so nothing an earlier command left there configures it.
      const install = index === 0 && packageBootstrap(command) !== undefined;
      // Network only from the configured registries: unchanged package
      // configuration and a lockfile that resolves only there. A refused
      // grant keeps why, so an offline failure names its cause.
      const refused =
        install && input.sandbox.network === "package-install"
          ? await installNetworkRefusal(worktree, plan.base, commit, signal)
          : undefined;
      const online =
        install && input.sandbox.network === "package-install" && !refused;
      // A command that moved a linked file's directory would leave the
      // operator's LFS object writable to the next one: stop first.
      const moved = linked.filter(
        (file) =>
          lstatSync(join(worktree, file.path), { throwIfNoEntry: false })
            ?.ino !== file.linked?.ino,
      );
      if (moved.length) {
        const detail = `Validation command modified the result tree: Git LFS files moved or replaced: ${moved
          .slice(0, 20)
          .map((file) => file.path)
          .join(
            ", ",
          )}${moved.length > 20 ? ` and ${moved.length - 20} more` : ""}`;
        return {
          kind: "failed",
          tree,
          commands: sequence,
          results,
          detail,
          output: detail,
        };
      }
      const started = Date.now();
      input.log({ event: "validation-command", index, command, preparing });
      const limit = capture ? outputLimit(selectors, command) : undefined;
      const run = await runSandboxed(command, {
        cwd: worktree,
        home: install ? await made("factory-install-home-") : home,
        temporary,
        env: {
          ...validationEnvironment(credentials),
          // Factory fetches by SHA and never moves the checkout's
          // remote-tracking branches, so base-relative checks use this (#1664).
          FACTORY_BASE_SHA: plan.base,
        },
        config: input.sandbox,
        packageInstall: install,
        network: online,
        readOnlyFiles: linked.map((file) => file.path),
        ...(limit ? { outputLimit: limit } : {}),
        signal: input.signal,
        timeoutMs: input.commandTimeoutMs ?? 30 * MINUTE,
      });
      if (run.kind === "fault")
        return objectiveWide(
          hold(
            `The command sandbox could not run \`${command}\`: ${run.detail}. ${run.fix}.`,
          ),
        );
      const output = `${run.stdout}${run.stderr}`;
      const durationMs = Date.now() - started;
      const overflow =
        run.diskOverflow ??
        (run.timedOut
          ? `the command ran longer than ${Math.round((input.commandTimeoutMs ?? 30 * MINUTE) / 1000)} s and was stopped`
          : undefined);
      const passed = run.exitCode === 0 && !overflow;
      input.log({
        event: "validation-result",
        index,
        command,
        passed,
        exitCode: run.exitCode,
        durationMs,
        tail: output.slice(-PASSED_OUTPUT_TAIL),
      });
      if (passed) {
        results.push({
          command,
          ...(preparing && { preparation: true as const }),
          exitCode: 0,
          durationMs,
          tail: output.slice(-PASSED_OUTPUT_TAIL),
        });
        if (preparing || !capture || !selectors.length) continue;
        // Capture reads the full output and the TMPDIR, so it runs now,
        // before the next command and before cleanup.
        const captured = await captureReviewArtifacts({
          selectors,
          checkout,
          worktree,
          tree,
          commandIndex: index,
          command,
          stdout: run.stdout,
          stderr: run.stderr,
          truncated: run.truncated,
          temporary,
          dir: capture.dir,
          prior: artifacts,
          signal,
        });
        if (captured.kind === "retry") return captured;
        if (captured.kind === "failed")
          return {
            kind: "failed",
            tree,
            commands: sequence,
            results,
            failed: { index, command },
            detail: captured.detail,
            output: captured.detail,
          };
        artifacts = captured.artifacts;
        continue;
      }
      // Past the sandbox's disk budget or the time limit the command
      // failed, whatever it exited.
      const failed = `Validation command failed (${run.diskOverflow ? "disk budget" : run.timedOut ? "time limit" : run.exitCode}): ${command}: `;
      // An install that would have had the network, ran offline and found
      // packages missing from the store (the package managers' offline
      // error codes).
      const offlineMissing = !overflow && OFFLINE_PACKAGES_MISSING.test(output);
      // Without pasta, it failed for the host's lack of network, whatever
      // the candidate changed: the operator's fix, never a repair (#1623).
      if (run.offline !== undefined && offlineMissing)
        return objectiveWide(
          hold(
            `${failed}the install ran offline, because ${run.offline}, and the package store lacks packages it needs:\n${failedOutput(output)}\n\nInstall passt so pasta is on Factory's PATH, and run Factory as a regular user, so verified installs reach the configured registry; then answer \`retry\`.`,
          ),
        );
      // When Factory could not verify its package inputs, the limit is
      // Factory's, not the candidate's (#1628).
      if (refused?.unverified && offlineMissing)
        return objectiveWide(
          hold(
            `${failed}the install ran offline, because ${refused.reason}, and the package store lacks packages it needs:\n${failedOutput(output)}\n\nKeep the base's registry configuration literal http(s) URLs and its lockfiles plain YAML or JSON, or warm packageStore with the packages the install needs; then answer \`retry\`.`,
          ),
        );
      // With the network off by configuration, an install whose inputs are
      // the base's can't fetch what the store lacks however often it runs.
      if (
        install &&
        offlineMissing &&
        input.sandbox.network === "off" &&
        !(await dependencyInputsChanged(checkout, plan.base, commit, signal))
      )
        return objectiveWide(
          hold(
            `${failed}the install ran offline, because sandbox.network is off, and the package store lacks packages the base's lockfile needs:\n${failedOutput(output)}\n\nSet sandbox.network to package-install, or warm sandbox.packageStore with those packages; then answer \`retry\`.`,
          ),
        );
      // A grant the candidate's package inputs refused stays its fault,
      // but says why the install was offline.
      const offlineBecause =
        refused && offlineMissing
          ? `the install ran offline, because ${refused.reason}, and the package store lacks packages it needs:\n`
          : "";
      const detail = `${failed}${offlineBecause}${overflow ?? failedOutput(output)}`;
      // The dependency install is the controller's own bootstrap step. When
      // the candidate left every manifest and lockfile as at the accepted
      // base, the same install worked there, so its failure is the
      // environment's: it repeats and charges no repair (#839). A changed
      // manifest or lockfile may be what broke it: the candidate's fault.
      // Over the disk budget, only the verified install, run first with an
      // empty HOME, is: earlier commands could have filled the budget.
      if (
        packageBootstrap(command) !== undefined &&
        (!run.diskOverflow || install) &&
        !(await dependencyInputsChanged(checkout, plan.base, commit, signal))
      )
        return { kind: "retry", reason: detail };
      if (input.returnTo && item)
        produced = await returnProduced(worktree, input.returnTo, item, signal);
      return {
        kind: "failed",
        tree,
        commands: sequence,
        results,
        failed: { index, command },
        detail,
        output: `${failed}${offlineBecause}${overflow ? `${overflow}\n` : ""}${output}`,
        ...(produced && { produced }),
      };
    }
    if (input.returnTo && item)
      produced = await returnProduced(worktree, input.returnTo, item, signal);
    // Hydrated files are left out of the status comparison, so their
    // bytes are checked against their pointers instead.
    const rewritten = await rewrittenMedia(worktree, lfsFiles);
    const mutation =
      mutationDetail(baseline, await status(worktree, signal), hydrated) ??
      (rewritten.length
        ? `Git LFS files rewritten: ${rewritten.slice(0, 20).join(", ")}${rewritten.length > 20 ? ` and ${rewritten.length - 20} more` : ""}`
        : undefined);
    if (mutation || (await revParse(worktree, "HEAD", signal)) !== commit) {
      const detail = `Validation command modified the result tree: ${mutation ?? "HEAD moved"}`;
      return {
        kind: "failed",
        tree,
        commands: sequence,
        results,
        detail,
        output: detail,
        ...(produced && { produced }),
      };
    }
    return {
      kind: "passed",
      tree,
      commands: sequence,
      results,
      ...(produced && { produced }),
      ...(capture && { artifacts }),
    };
  } finally {
    await Promise.all(scratch.map((path) => forceRemove(path)));
    await removeWorktree(checkout, worktree, input.signal).catch(
      () => undefined,
    );
  }
}

const sourceDeclared = (items: readonly WorkItem[]) =>
  items.flatMap((item) =>
    item.validation
      .filter((check) => check.provenance === "source-declared")
      .map((check) => check.command),
  );

// ---------------------------------------------------------------------------
// Output

/**
 * A failed command's output as people read it: the start and the end, where
 * test runners report failures (#1596). Diagnosis gets the complete output.
 * The tail is at least the 8,000 characters worker Validate shows.
 */
const FAILED_OUTPUT_HEAD = 2_000;
const FAILED_OUTPUT_TAIL = 8_000;
/** What a passing command keeps of its output. */
const PASSED_OUTPUT_TAIL = 2_000;
/** pnpm's and npm's errors for a package an offline install cannot fetch. */
const OFFLINE_PACKAGES_MISSING =
  /\b(?:ERR_PNPM_NO_OFFLINE_(?:META|TARBALL)|ENOTCACHED)\b/;

const failedOutput = (output: string) =>
  headAndTail(output, FAILED_OUTPUT_HEAD, FAILED_OUTPUT_TAIL);

/** The checkout's complete status records. */
async function status(worktree: string, signal: AbortSignal): Promise<Buffer> {
  return hostGit(
    worktree,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { signal },
  );
}

/** The object a revision names, with pinned Git. */
async function revParse(
  directory: string,
  revision: string,
  signal: AbortSignal,
): Promise<string> {
  return (await hostGit(directory, ["rev-parse", revision], { signal }))
    .toString("utf8")
    .trim();
}

/**
 * The status records that differ between two listings, at most 20 paths, or
 * undefined. A `hydrated` Git LFS file's modified record is left out: its
 * bytes replaced its pointer on purpose (rewrittenMedia checks those bytes).
 * Deleting or renaming it still counts.
 */
function mutationDetail(
  before: Buffer,
  after: Buffer,
  hydrated: ReadonlySet<string>,
): string | undefined {
  const records = (listing: Buffer) => {
    const fields = listing.toString("utf8").split("\0");
    const result: string[] = [];
    for (let index = 0; index < fields.length; index += 1) {
      const field = fields[index]!;
      if (!field) continue;
      if (field.startsWith(" M ") && hydrated.has(field.slice(3))) continue;
      // A rename or copy carries its source as the next field.
      if (/[RC]/.test(field.slice(0, 2)))
        result.push(`${field} (from ${fields[++index]})`);
      else result.push(field);
    }
    return result;
  };
  const initial = new Set(records(before));
  const final = new Set(records(after));
  const changed = [
    ...[...initial].filter((entry) => !final.has(entry)).map((e) => `-${e}`),
    ...[...final].filter((entry) => !initial.has(entry)).map((e) => `+${e}`),
  ].map((entry) => (entry.length > 260 ? `${entry.slice(0, 256)}…` : entry));
  if (!changed.length) return undefined;
  return `${changed.slice(0, 20).join(", ")}${changed.length > 20 ? ` and ${changed.length - 20} more` : ""}`;
}

/** Whether the candidate changed any input of the dependency install relative to the base. */
async function dependencyInputsChanged(
  checkout: string,
  base: string,
  commit: string,
  signal: AbortSignal,
): Promise<boolean> {
  const changed = (
    await hostGit(
      checkout,
      ["diff-tree", "-r", "--name-only", "-z", "--no-renames", base, commit],
      { signal },
    )
  )
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  return changed.some(
    (path) =>
      path === "pnpm-lock.yaml" ||
      path === "package-lock.json" ||
      path === "pnpm-workspace.yaml" ||
      path === ".npmrc" ||
      path === "package.json" ||
      path.endsWith("/package.json"),
  );
}

// ---------------------------------------------------------------------------
// Final validation's sequence

/**
 * The commands final validation runs: the declared prerequisites, then the
 * final commands. Only a bootstrap that runs first installs, so the
 * sequence starts with one exactly once: a bootstrap the final commands list
 * moves to the front, and otherwise the plan's source-declared bootstrap
 * leads. The plan's declared prerequisites run first unless the final
 * commands already start with them; when they do run first, the bootstrap
 * leads them.
 */
function finalSequence(plan: Plan): {
  preparation: string[];
  commands: string[];
} {
  const key = (command: string) => command.trim();
  const isBootstrap = (command: string) =>
    packageBootstrap(command) !== undefined;
  const listed = plan.finalCommands.filter(isBootstrap);
  let commands = [
    ...listed.filter(
      (command, index) =>
        listed.findIndex((other) => key(other) === key(command)) === index,
    ),
    ...plan.finalCommands.filter((command) => !isBootstrap(command)),
  ];
  // The bootstrap's position never decides whether the final commands
  // already start with the declared prerequisites.
  const declared = preparationCommands(plan);
  const rest = commands.filter((command) => !isBootstrap(command));
  let preparation = declared
    .filter((command) => !isBootstrap(command))
    .every((command, index) => rest[index] === command)
    ? []
    : declared;
  const bootstrap =
    commands.find(isBootstrap) ??
    sourceDeclared(plan.items).find((command) => isBootstrap(command));
  if (bootstrap === undefined || !(preparation.length || commands.length))
    return { preparation, commands };
  if (!preparation.length)
    return isBootstrap(commands[0]!)
      ? { preparation, commands }
      : { preparation: [bootstrap], commands };
  // Preparation runs ahead of the final commands, so the bootstrap leads it.
  commands = commands.filter((command) => key(command) !== key(bootstrap));
  preparation = [
    bootstrap,
    ...preparation.filter((command) => key(command) !== key(bootstrap)),
  ];
  return { preparation, commands };
}

/**
 * The prerequisites the plan's coverage declares, from each item's own
 * commands, items in dependency order. Preparation only: no readiness or
 * acceptance is inferred from its success.
 */
function preparationCommands(plan: Plan): string[] {
  const ordered: WorkItem[] = [];
  const seen = new Set<string>();
  const visit = (item: WorkItem) => {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    for (const id of item.dependencies) {
      const dependency = plan.items.find((candidate) => candidate.id === id);
      if (dependency) visit(dependency);
    }
    ordered.push(item);
  };
  for (const item of plan.items) visit(item);
  return ordered.flatMap((item) => {
    const selected = new Set(
      plan.coverage
        .filter((entry) => entry.itemId === item.id)
        .flatMap((entry) => entry.environment.prerequisites ?? []),
    );
    return item.validation
      .map((check) => check.command)
      .filter((command) => selected.has(command));
  });
}

// ---------------------------------------------------------------------------
// Package-script pinning

/**
 * Package managers resolve scripts and lifecycle hooks from the result tree,
 * so a worker could make `npm test` pass by rewriting it. The script a
 * command runs, its pre and post hooks, pnpmfile hooks, .npmrc, the
 * workspace configuration and the lockfile rules stay as at the accepted
 * base, unless the Objective's source-declared commands, Package manager
 * update or Workspace package additions authorize a change.
 */
interface PinAuthority {
  /** Exact stable same-manager pin declared by the Objective. */
  packageManagerUpdate?: string;
  /** Final acceptance must include the declared update. */
  requirePackageManagerUpdate?: boolean;
  /** Commands literally declared by a pinned source, not inferred by the model. */
  sourceDeclared: readonly string[];
  /** Exact package directories admitted by the Objective. */
  workspacePackageAdditions: readonly string[];
  /** Newly established scripts are pinned against the item's predecessor too. */
  predecessor?: string;
}

/**
 * A pin the candidate broke (its fault: repair) or one the plan's commands
 * or the Objective's declarations can't satisfy (configuration: hold).
 */
class PinRefusal extends Error {
  constructor(
    message: string,
    readonly blame: "candidate" | "config",
  ) {
    super(message);
  }
}

const candidate = (text: string) => new PinRefusal(text, "candidate");
const configuration = (text: string) => new PinRefusal(text, "config");

/** Files at revisions, read with pinned Git; a path that is not a regular file is refused. */
class Revisions {
  private readonly cache = new Map<string, Promise<Buffer | undefined>>();

  constructor(
    private readonly checkout: string,
    /** The candidate: a problem in it is the candidate's, elsewhere the configuration's. */
    private readonly commit: string,
    private readonly signal: AbortSignal,
  ) {}

  bytes(revision: string, path: string): Promise<Buffer | undefined> {
    const key = `${revision}:${path}`;
    let found = this.cache.get(key);
    if (!found) {
      found = this.read(revision, path);
      this.cache.set(key, found);
    }
    return found;
  }

  async text(revision: string, path: string): Promise<string | undefined> {
    return (await this.bytes(revision, path))?.toString("utf8");
  }

  blame(revision: string): (text: string) => PinRefusal {
    return revision === this.commit ? candidate : configuration;
  }

  private async read(
    revision: string,
    path: string,
  ): Promise<Buffer | undefined> {
    const entry = (
      await hostGit(this.checkout, ["ls-tree", revision, "--", path], {
        signal: this.signal,
      })
    )
      .toString("utf8")
      .trim();
    if (!entry) return undefined;
    if (!/^100(?:644|755) blob /.test(entry))
      throw this.blame(revision)(
        `Package script validation blocked: ${path} is not a regular file`,
      );
    return hostGit(this.checkout, ["show", `${revision}:${path}`], {
      signal: this.signal,
    });
  }
}

async function packageMetadata(
  git: Revisions,
  revision: string,
): Promise<Record<string, unknown> | undefined> {
  const text = await git.text(revision, "package.json");
  if (text === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value))
      return value as Record<string, unknown>;
  } catch {
    // Refused below.
  }
  throw git.blame(revision)(
    "Package script validation blocked: package.json is invalid",
  );
}

/** A version update, never a manager switch, range, URL or prerelease. */
function exactPin(value: unknown): RegExpMatchArray | null {
  return typeof value === "string"
    ? value.match(/^(npm|pnpm)@(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
    : null;
}

function checkPackageManagerUpdate(
  before: unknown,
  after: unknown,
  update: string | undefined,
  requireUpdate = false,
): void {
  if (update !== undefined) {
    const target = exactPin(update);
    const baseline = exactPin(before);
    if (!target || !baseline || baseline[1] !== target[1])
      throw configuration(
        "Package manager update requires an existing exact stable pin of the same manager at the accepted base",
      );
    if (after === update) return;
    if (requireUpdate)
      throw candidate(
        `Package manager update was not delivered: expected ${update}`,
      );
  }
  if (!isDeepStrictEqual(before, after))
    throw candidate(
      "Package script validation blocked: packageManager differs from the accepted base without the declared exact update",
    );
}

/** The commands that run package scripts: the ones validation pins to the accepted base. */
function packageScriptCommands(commands: readonly string[]): string[] {
  return commands.filter(
    (check) =>
      /\b(?:npm|pnpm)\b/.test(check) &&
      !packageBootstrap(check) &&
      !packageManagerVersionProbe(check),
  );
}

/** Why `commands` may not run on `commit`, or undefined when every pin holds. */
async function pinRefusal(
  git: Revisions,
  base: string,
  commit: string,
  commands: string[],
  authority: PinAuthority,
): Promise<PinRefusal | undefined> {
  try {
    await checkPins(git, base, commit, commands, authority);
    return undefined;
  } catch (error) {
    if (error instanceof PinRefusal) return error;
    throw error;
  }
}

async function checkPins(
  git: Revisions,
  base: string,
  commit: string,
  commands: string[],
  authority: PinAuthority,
): Promise<void> {
  const update = authority.packageManagerUpdate;
  const predecessorSha = authority.predecessor ?? base;
  await checkWorkspaceChange(
    git,
    base,
    commit,
    authority.workspacePackageAdditions,
    predecessorSha,
  );
  const file = (revision: string, path: string) => git.text(revision, path);
  const original = await packageMetadata(git, base);
  const predecessor =
    predecessorSha !== base
      ? await packageMetadata(git, predecessorSha)
      : original;
  const after = await packageMetadata(git, commit);
  if (original || predecessor || update !== undefined)
    checkPackageManagerUpdate(
      update !== undefined
        ? original?.packageManager
        : (original ?? predecessor)?.packageManager,
      after?.packageManager,
      update,
      authority.requirePackageManagerUpdate,
    );
  if (
    update !== undefined &&
    predecessor?.packageManager === update &&
    after?.packageManager !== update
  )
    throw candidate("Package manager update cannot revert a predecessor pin");
  const managerToken = /\b(?:npm|pnpm)\b/;
  const selected = commands.filter((check) => managerToken.test(check));
  if (selected.length || update !== undefined)
    for (const key of ["config", "pnpm"])
      if (
        (original ?? predecessor) &&
        !isDeepStrictEqual((original ?? predecessor)?.[key], after?.[key])
      )
        throw candidate(
          `Package script validation blocked: ${key} differs from the accepted base`,
        );
  if (
    update !== undefined &&
    (await file(base, "pnpm-workspace.yaml")) === undefined &&
    (await file(commit, "pnpm-workspace.yaml")) !== undefined
  )
    throw candidate(
      "Package manager update cannot create workspace security configuration",
    );
  if (update !== undefined)
    for (const path of [
      ".npmrc",
      ".pnpmfile.cjs",
      ".pnpmfile.js",
      ".pnpmfile.mjs",
      "package.yaml",
    ])
      if ((await file(base, path)) !== (await file(commit, path)))
        throw candidate(
          `Package script validation blocked: ${path} differs from the accepted base; Package manager update grants no configuration or hook changes`,
        );
  const pnpmBootstrap = selected.some(
    (check) => packageBootstrap(check) === "pnpm",
  );
  const npmBootstrap = selected.some(
    (check) => packageBootstrap(check) === "npm",
  );
  const bootstrap = pnpmBootstrap || npmBootstrap;
  if (pnpmBootstrap || update !== undefined)
    for (const path of [".npmrc", "pnpm-workspace.yaml"]) {
      const content = await file(commit, path);
      if (/pnpmfile/i.test(content ?? ""))
        throw (
          content === (await file(base, path)) ? configuration : candidate
        )(
          "Package script validation blocked: configured pnpmfile hooks need separate authority",
        );
    }
  if (!selected.length) return;
  const declared = new Set(authority.sourceDeclared);
  if (npmBootstrap) {
    if (!declared.has(PINNED_NPM_BOOTSTRAP))
      throw configuration(
        "Package script validation blocked: npm bootstrap needs exact source-declared command authority",
      );
    if (pnpmBootstrap || selected.some((command) => /\bpnpm\b/.test(command)))
      throw configuration(
        "Package script validation blocked: npm bootstrap cannot mix package managers",
      );
    if (
      !original ||
      original.workspaces !== undefined ||
      (original.packageManager !== undefined &&
        !String(original.packageManager).startsWith("npm@")) ||
      update !== undefined
    )
      throw configuration(
        "Package script validation blocked: npm bootstrap requires an existing root npm package without workspaces or a manager update",
      );
    for (const path of ["package.json", "package-lock.json"]) {
      const before = await git.bytes(base, path);
      const now = await git.bytes(commit, path);
      if (!before?.length)
        throw configuration(
          `Package script validation blocked: npm bootstrap needs unchanged tracked ${path} from the accepted base`,
        );
      if (!now || !before.equals(now))
        throw candidate(
          `Package script validation blocked: npm bootstrap needs unchanged tracked ${path} from the accepted base`,
        );
    }
    let lock: unknown;
    try {
      lock = JSON.parse((await file(base, "package-lock.json"))!);
    } catch {
      throw configuration(
        "Package script validation blocked: npm bootstrap needs a valid package-lock.json",
      );
    }
    if (
      !lock ||
      typeof lock !== "object" ||
      Array.isArray(lock) ||
      ![1, 2, 3].includes(
        (lock as Record<string, unknown>).lockfileVersion as number,
      )
    )
      throw configuration(
        "Package script validation blocked: npm bootstrap needs a supported package-lock.json",
      );
    for (const revision of [base, commit])
      if ((await file(revision, "npm-shrinkwrap.json")) !== undefined)
        throw git.blame(revision)(
          "Package script validation blocked: npm bootstrap does not authorize npm-shrinkwrap.json",
        );
  }
  if (
    bootstrap &&
    commands.findIndex((check) => packageBootstrap(check) !== undefined) >
      commands.findIndex(
        (check) =>
          managerToken.test(check) && !packageManagerVersionProbe(check),
      )
  )
    throw configuration(
      "Package script validation blocked: script-disabled bootstrap must run first",
    );
  const scriptCommands = packageScriptCommands(commands);
  const requests = scriptCommands.map(packageScriptInvocation);
  if (requests.some((request) => !request))
    throw configuration(
      "Package script validation blocked: only root npm/pnpm test, pnpm check, or npm/pnpm run NAME can be pinned",
    );
  if (
    !original &&
    selected.some(
      (command) =>
        !packageManagerVersionProbe(command) && !declared.has(command),
    )
  )
    throw configuration(
      "Package script validation blocked: a new package.json needs exact source-declared command authority",
    );
  if (!after && (original || bootstrap || scriptCommands.length))
    throw candidate(
      "Package script validation blocked: package.json is absent from the result tree",
    );
  const scripts = (
    pkg: Record<string, unknown>,
    refuse: (text: string) => PinRefusal,
  ): Record<string, unknown> => {
    const value = pkg.scripts;
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw refuse(
        "Package script validation blocked: scripts are unavailable",
      );
    return value as Record<string, unknown>;
  };
  const originalScripts =
    requests.length && original?.scripts
      ? scripts(original, configuration)
      : {};
  const predecessorScripts =
    requests.length && predecessor?.scripts
      ? scripts(predecessor, configuration)
      : {};
  const afterScripts =
    requests.length && after?.scripts ? scripts(after, candidate) : {};
  const usesPnpm = selected.some((command) => /\bpnpm\b/.test(command));
  for (let index = 0; index < requests.length; index++) {
    const request = requests[index]!;
    const command = scriptCommands[index]!;
    const name = request.name;
    const beforeScripts =
      typeof originalScripts[name] === "string"
        ? originalScripts
        : predecessorScripts;
    const body = beforeScripts[name];
    if (typeof body !== "string" && !declared.has(command))
      throw configuration(
        `Package script validation blocked: new script ${name} needs exact source-declared command authority`,
      );
    if (
      (typeof body === "string" && afterScripts[name] !== body) ||
      typeof afterScripts[name] !== "string"
    )
      throw candidate(
        `Package script validation blocked: script ${name} differs from the accepted base`,
      );
    for (const scriptName of [name, `pre${name}`, `post${name}`]) {
      if (
        scriptName !== name &&
        typeof body !== "string" &&
        afterScripts[scriptName] !== undefined
      )
        throw candidate(
          `Package script validation blocked: new script ${name} cannot add lifecycle hook ${scriptName}`,
        );
      if (
        scriptName !== name &&
        beforeScripts[scriptName] !== afterScripts[scriptName]
      )
        throw candidate(
          `Package script validation blocked: lifecycle hook ${scriptName} differs from the accepted base`,
        );
      const scriptBody = afterScripts[scriptName] ?? beforeScripts[scriptName];
      if (typeof scriptBody !== "string") continue;
      if (/\b(?:npm|pnpm)\b/.test(scriptBody))
        throw (
          beforeScripts[scriptName] === scriptBody ? configuration : candidate
        )(
          `Package script validation blocked: nested package-manager invocation in ${scriptName} needs separate authority`,
        );
    }
  }
  if (usesPnpm)
    for (const revision of [base, commit])
      if ((await file(revision, "package.yaml")) !== undefined)
        throw git.blame(revision)(
          "Package script validation blocked: pnpm package.yaml manifests are not supported",
        );
  if (pnpmBootstrap) {
    if (
      !(await file(base, "pnpm-lock.yaml")) &&
      !declared.has(PINNED_PNPM_BOOTSTRAP)
    )
      throw configuration(
        "Package script validation blocked: frozen pnpm bootstrap needs a tracked lockfile",
      );
    if (!(await file(commit, "pnpm-lock.yaml")))
      throw candidate(
        "Package script validation blocked: frozen pnpm bootstrap needs a tracked lockfile",
      );
    for (const path of [".pnpmfile.cjs", ".pnpmfile.js", ".pnpmfile.mjs"])
      for (const revision of [base, commit])
        if ((await file(revision, path)) !== undefined)
          throw git.blame(revision)(
            "Package script validation blocked: pnpmfile hooks need separate authority",
          );
  }
  for (const path of [".npmrc", ...(usesPnpm ? ["pnpm-workspace.yaml"] : [])]) {
    const atBase = await file(base, path);
    const atPredecessor = await file(predecessorSha, path);
    if (
      (atBase ?? atPredecessor) !== (await file(commit, path)) &&
      !(
        path === "pnpm-workspace.yaml" &&
        atBase === undefined &&
        atPredecessor === undefined &&
        selected.every((command) => declared.has(command))
      ) &&
      !(
        path === "pnpm-workspace.yaml" &&
        authority.workspacePackageAdditions.length
      )
    )
      throw candidate(
        `Package script validation blocked: ${path} differs from the accepted base`,
      );
  }
}

// ---------------------------------------------------------------------------
// Workspace package additions

const WORKSPACE = "pnpm-workspace.yaml";

function exactPackageDirectory(path: string): boolean {
  return (
    /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(path) &&
    path
      .split("/")
      .every((part) => part !== "." && part !== ".." && part !== "node_modules")
  );
}

function parseWorkspace(
  content: string,
  refuse: (text: string) => PinRefusal,
): { packages: string[]; config: Record<string, unknown> } {
  let value: unknown;
  try {
    const document = parseDocument(content, {
      uniqueKeys: true,
      merge: false,
      version: "1.2",
    });
    if (document.errors.length || document.warnings.length)
      throw document.errors[0] ?? document.warnings[0];
    visit(document, {
      Alias: () => {
        throw new Error("YAML aliases are unsupported");
      },
      Node: (_key, node) => {
        if (node.anchor || node.tag)
          throw new Error("YAML anchors and explicit tags are unsupported");
      },
      Pair: (_key, pair) => {
        if (!isScalar(pair.key) || typeof pair.key.value !== "string")
          throw new Error("YAML mapping keys must be strings");
        if (pair.key.value === "<<")
          throw new Error("YAML merges are unsupported");
      },
    });
    value = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    throw refuse(`Invalid workspace YAML: ${errorMessage(error)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw refuse("Workspace YAML must be a mapping");
  const { packages, ...config } = value as Record<string, unknown>;
  if (
    !Array.isArray(packages) ||
    packages.some((entry) => typeof entry !== "string") ||
    new Set(packages).size !== packages.length ||
    Object.hasOwn(config, "<<")
  )
    throw refuse(
      "Workspace packages must be a unique string sequence without merges",
    );
  return { packages, config };
}

/** Keep the base's workspace security configuration across accepted predecessors. */
async function checkWorkspaceChange(
  git: Revisions,
  base: string,
  commit: string,
  additions: readonly string[],
  predecessorSha: string,
): Promise<void> {
  if (
    additions.some((entry) => !exactPackageDirectory(entry)) ||
    new Set(additions).size !== additions.length
  )
    throw configuration("Invalid workspace package addition authority");
  const original = await git.text(base, WORKSPACE);
  const predecessor =
    predecessorSha === base
      ? original
      : await git.text(predecessorSha, WORKSPACE);
  const baseline = original ?? predecessor;
  const after = commit === base ? original : await git.text(commit, WORKSPACE);
  // Command authority for a new workspace stays with the script pins.
  if (baseline === undefined) return;
  if (baseline === after && predecessor === after && !additions.length) return;
  if (!additions.length)
    throw candidate(
      `Package script validation blocked: ${WORKSPACE} differs from the accepted base`,
    );
  if (after === undefined)
    throw candidate(
      "Workspace membership authority cannot remove the workspace",
    );
  const before = parseWorkspace(baseline, configuration);
  const result = parseWorkspace(after, candidate);
  if (!isDeepStrictEqual(before.config, result.config))
    throw candidate(
      "Workspace non-membership configuration differs from the accepted base; settings other than package membership are the operator's to change on the default branch",
    );
  if (
    !isDeepStrictEqual(
      result.packages.filter((entry) => before.packages.includes(entry)),
      before.packages,
    )
  )
    throw candidate(
      "Workspace membership authority cannot remove or reorder existing entries",
    );
  if (
    predecessor !== undefined &&
    parseWorkspace(predecessor, configuration).packages.some(
      (entry) => !result.packages.includes(entry),
    )
  )
    throw candidate(
      "Workspace membership authority cannot remove predecessor entries",
    );
  for (const entry of result.packages.filter(
    (entry) => !before.packages.includes(entry),
  )) {
    if (!additions.includes(entry))
      throw candidate(`Workspace package addition is not authorized: ${entry}`);
    const manifest = await git.text(commit, `${entry}/package.json`);
    if (manifest === undefined)
      throw candidate(`Workspace package addition has no manifest: ${entry}`);
    let pkg: unknown;
    try {
      pkg = JSON.parse(manifest);
    } catch {
      throw candidate(`Invalid workspace package manifest: ${entry}`);
    }
    if (!pkg || typeof pkg !== "object" || Array.isArray(pkg))
      throw candidate(`Invalid workspace package manifest: ${entry}`);
  }
}

// ---------------------------------------------------------------------------
// Objective declarations

/** The Objective's Workspace package additions: exact package directories it admits. */
function workspaceAdditions(blocks: readonly ObjectiveBlock[]): {
  additions: string[];
  problem?: string;
} {
  const found = declaration(
    blocks,
    "workspace package additions",
    "Workspace package additions",
  );
  if (!found.entries) return { additions: [], problem: found.problem };
  const additions: string[] = [];
  let noResponse = false;
  for (const entry of found.entries) {
    if (entry.kind === "empty") {
      noResponse = true;
      continue;
    }
    const directory = entry.kind === "item" ? entry.code : undefined;
    if (directory === undefined || !exactPackageDirectory(directory))
      return {
        additions,
        problem:
          "Workspace package additions require exact backticked package directories, one per bullet, such as - `packages/new-lib`.",
      };
    if (additions.includes(directory))
      return {
        additions,
        problem: `Duplicate Workspace package additions entry \`${directory}\`; list each directory once.`,
      };
    additions.push(directory);
  }
  if (!additions.length && !noResponse)
    return {
      additions,
      problem:
        "Workspace package additions must not be empty; list the package directories, or remove the section.",
    };
  return { additions };
}

/**
 * The problems in the Objective's optional declarations: Package manager
 * update, Quality checkpoint, Workspace package additions and Adaptive
 * workflow. The check step runs this once; validation and planning then
 * trust what it accepted.
 */
export function declarationProblems(
  blocks: readonly ObjectiveBlock[],
): string[] {
  const problems: string[] = [];
  const update = declaration(
    blocks,
    "package manager update",
    "Package manager update",
  );
  if (update.problem) problems.push(update.problem);
  else if (update.entries) {
    const only = onlyEntry(update.entries);
    const pin = only?.kind === "item" ? only.code : undefined;
    if (only?.kind !== "empty" && !exactPin(pin))
      problems.push(
        "Package manager update requires exactly one backticked stable npm@X.Y.Z or pnpm@X.Y.Z pin, such as - `pnpm@9.15.0`.",
      );
  }
  const checkpoint = declaration(
    blocks,
    "quality checkpoint",
    "Quality checkpoint",
  );
  if (checkpoint.problem) problems.push(checkpoint.problem);
  else if (checkpoint.entries) {
    const only = onlyEntry(checkpoint.entries);
    const selection = only?.kind === "text" ? only.text : undefined;
    if (selection !== "enabled" && selection !== "disabled")
      problems.push(
        "Quality checkpoint requires exactly enabled or disabled as its only line.",
      );
  }
  const workspace = workspaceAdditions(blocks).problem;
  if (workspace) problems.push(workspace);
  const adaptive = adaptiveWorkflow(blocks);
  if (adaptive.problem) problems.push(adaptive.problem);
  else if (adaptive.enabled && !knowledgeSettings()?.planningContext)
    problems.push(
      "Adaptive workflow is enabled, but this installation admits no planning context. Add a planning.context section (selectors, and optionally bounds and memory) to the configuration and restart the service, or set the section to disabled.",
    );
  return problems;
}

/** The Objective's Adaptive workflow section: on only when it reads `enabled`. */
export function adaptiveWorkflow(blocks: readonly ObjectiveBlock[]): {
  enabled: boolean;
  problem?: string;
} {
  const found = declaration(blocks, "adaptive workflow", "Adaptive workflow");
  if (!found.entries)
    return { enabled: false, ...(found.problem && { problem: found.problem }) };
  const only = onlyEntry(found.entries);
  if (only?.kind === "empty") return { enabled: false };
  const selection = only?.kind === "text" ? only.text : undefined;
  if (selection !== "enabled" && selection !== "disabled")
    return {
      enabled: false,
      problem:
        "Adaptive workflow requires exactly enabled or disabled as its only line.",
    };
  return { enabled: selection === "enabled" };
}

// ---------------------------------------------------------------------------
// Produced files

/**
 * Bounds on the produced files one Validate run returns: enough for actual
 * values a check writes (goldens, snapshots, hashes), never a build tree.
 */
const MAX_RETURNED_FILES = 64;
const MAX_RETURNED_BYTES = 8 * 1024 * 1024;
/** Report lines per category; the rest are counted. */
const MAX_LISTED_PATHS = 16;

function safeRelative(path: string): boolean {
  const parts = path.split("/");
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    parts.every((part) => part !== "" && part !== "." && part !== "..") &&
    !parts.includes(".git") &&
    !privateStagingPath(path)
  );
}

/**
 * After a Validate run settles, return the files its commands produced
 * under the item's owned paths from the validation copy to the worker's
 * checkout, which the worker otherwise cannot read. Only regular files the
 * worker's checkout ignores are copied, so they stay out of the result
 * unless the ignore rules change. A file this run produced replaces the
 * worker's copy at that path. Tracked or unignored changes are reported,
 * not copied. Returns the report, or "" when nothing was produced under
 * owned paths. Never throws: a failure is reported instead.
 */
async function returnProduced(
  validationCopy: string,
  worktree: string,
  item: WorkItem,
  signal: AbortSignal,
): Promise<string> {
  try {
    return await copyProduced(
      validationCopy,
      worktree,
      item.ownedPaths,
      signal,
    );
  } catch (error) {
    if (error instanceof GitRefusal) throw error;
    signal.throwIfAborted();
    return `Files the commands produced under your owned paths could not be returned: ${errorMessage(error)}`;
  }
}

async function copyProduced(
  validationCopy: string,
  worktree: string,
  scopes: string[],
  signal: AbortSignal,
): Promise<string> {
  if (!scopes.length) return "";
  // Pinned Git pathspecs are literal. `matching` lists an ignored directory
  // (a dependency tree or build cache) as one entry, never its contents.
  const fields = (
    await hostGit(
      validationCopy,
      [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignored=matching",
        "--",
        ...scopes,
      ],
      { signal, timeoutMs: MINUTE },
    )
  )
    .toString("utf8")
    .split("\0");
  const candidates: string[] = [];
  const directories: string[] = [];
  const changed: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    if (!field) continue;
    const code = field.slice(0, 2);
    const path = field.slice(3);
    if (code[0] === "R" || code[0] === "C") index += 1;
    const plain = path.endsWith("/") ? path.slice(0, -1) : path;
    if (!safeRelative(plain) || !ownsPath(path, scopes)) continue;
    if (code !== "!!") changed.push(path);
    else if (path.endsWith("/")) directories.push(path);
    else candidates.push(path);
  }
  const ignored = await ignoredInWorktree(worktree, candidates, signal);
  const root = realpathSync(validationCopy);
  const returned: string[] = [];
  const skipped: string[] = [];
  const omitted: string[] = [];
  let bytes = 0;
  for (const path of candidates) {
    if (!ignored.has(path)) {
      changed.push(path);
      continue;
    }
    if (returned.length >= MAX_RETURNED_FILES) {
      omitted.push(`- ${path}`);
      continue;
    }
    const content = readProduced(root, path, MAX_RETURNED_BYTES - bytes);
    if (typeof content === "string") {
      skipped.push(`- ${path}: ${content}`);
      continue;
    }
    if (typeof content === "number") {
      omitted.push(`- ${path} (${content} bytes)`);
      continue;
    }
    const written = writeReturned(worktree, path, content);
    if (typeof written === "string") {
      skipped.push(`- ${path}: ${written}`);
      continue;
    }
    bytes += content.length;
    returned.push(
      `- ${path} (${content.length} bytes${written.existed ? ", replaced the earlier copy" : ""})`,
    );
  }
  const listed = (lines: string[]) =>
    (lines.length <= MAX_LISTED_PATHS
      ? lines
      : [
          ...lines.slice(0, MAX_LISTED_PATHS),
          `- and ${lines.length - MAX_LISTED_PATHS} more`,
        ]
    ).join("\n");
  if (![returned, skipped, omitted, changed, directories].some((s) => s.length))
    return "";
  const parts = ["Files the commands produced under your owned paths:"];
  if (returned.length)
    parts.push(
      `Returned to your checkout at the same paths (Git ignores them, so they stay out of your result unless the ignore rules change):\n${listed(returned)}`,
    );
  if (skipped.length) parts.push(`Not returned:\n${listed(skipped)}`);
  if (omitted.length)
    parts.push(
      `Not returned, over the bound of ${MAX_RETURNED_FILES} files and ${MAX_RETURNED_BYTES / (1024 * 1024)} MiB per run:\n${listed(omitted)}`,
    );
  if (changed.length)
    parts.push(
      `Changed in the validation copy only, not returned because Git tracks them or does not ignore them, so a copy would change your result:\n${listed(changed.map((path) => `- ${path}`))}`,
    );
  if (directories.length)
    parts.push(
      `Ignored directories, contents not returned:\n${listed(directories.map((path) => `- ${path}`))}`,
    );
  return parts.join("\n");
}

/** Which paths the worker's checkout ignores now; tracked paths never are. */
async function ignoredInWorktree(
  worktree: string,
  paths: readonly string[],
  signal: AbortSignal,
): Promise<Set<string>> {
  if (!paths.length) return new Set();
  // check-ignore takes literal filenames and refuses the literal-pathspec
  // switch. With --verbose --non-matching it reports every path as
  // (source, line, pattern, path) and exits 0; a path is ignored when a
  // pattern matched it and that pattern is not a negation.
  const fields = (
    await hostGit(
      worktree,
      ["--no-literal-pathspecs", "check-ignore", "-z", "-v", "-n", "--stdin"],
      { input: `${paths.join("\0")}\0`, signal, timeoutMs: MINUTE },
    )
  )
    .toString("utf8")
    .split("\0");
  const ignored = new Set<string>();
  for (let index = 0; index + 3 < fields.length; index += 4)
    if (fields[index] && !fields[index + 2]!.startsWith("!"))
      ignored.add(fields[index + 3]!);
  return ignored;
}

/** A regular file's bytes, never through a link, within the remaining budget. */
function readProduced(
  root: string,
  path: string,
  budget: number,
): Buffer | string | number {
  const source = join(root, path);
  try {
    if (!within(realpathSync(dirname(source)), root))
      return "its directory leaves the validation copy";
  } catch (error) {
    return `unreadable in the validation copy (${(error as NodeJS.ErrnoException).code ?? "error"})`;
  }
  let fd: number;
  try {
    fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return "not a regular file";
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return "not a regular file";
    if (stat.size > budget) return stat.size;
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Write one returned file in the worker's checkout. Parents are walked by
 * held descriptor (openParent) and created as plain directories; the
 * file itself is never a link or special file. Returns whether it replaced
 * an earlier copy, or why it was not written.
 */
function writeReturned(
  worktree: string,
  path: string,
  content: Buffer,
): { existed: boolean } | string {
  let parent: { fd: number; anchor: string; name: string };
  try {
    parent = openParent(worktree, path, true);
  } catch {
    return "a parent in your checkout is not a directory";
  }
  try {
    const destination = `${parent.anchor}/${parent.name}`;
    let existed = false;
    try {
      if (!lstatSync(destination).isFile())
        return "not a regular file in your checkout";
      existed = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let fd: number;
    try {
      // Never through a link; never blocks on a special file.
      fd = openSync(
        destination,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_TRUNC |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK,
      );
    } catch {
      return "not a regular file in your checkout";
    }
    try {
      if (!fstatSync(fd).isFile()) return "not a regular file in your checkout";
      writeFileSync(fd, content);
    } finally {
      closeSync(fd);
    }
    return { existed };
  } finally {
    closeSync(parent.fd);
  }
}
