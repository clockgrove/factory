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
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isScalar, parseDocument, visit } from "yaml";
import type { SandboxConfig } from "./config.js";
import { hold, type Outcome, objectiveWide } from "./engine.js";
import { GitRefusal, readBlobs } from "./git.js";
import type { CommitAuthor } from "./github.js";
import type { RunFile } from "./log.js";
import {
  hydrateTree,
  type LfsFile,
  rewrittenMedia,
  type SelectedMember,
} from "./media.js";
import {
  declaredRequests,
  holdNote,
  judgeLookup,
  lookupCommand,
  lookupRefusal,
  matchRequest,
  refusedRequest,
  repairMessage,
} from "./missing-version.js";
import { declaration, onlyEntry } from "./objective.js";
import {
  configurationRefusal,
  installNetworkRefusal,
  type NetworkRefusal,
  resolutionNetworkRefusal,
  WORKSPACE_DEPENDENCY_KEYS,
  workspaceSettings,
} from "./package-network.js";
import { forceRemove, openParent, within } from "./paths.js";
import {
  LOCKFILE_RESOLUTION,
  PINNED_NPM_BOOTSTRAP,
  PINNED_PNPM_BOOTSTRAP,
  packageBootstrap,
  packageManagerVersionProbe,
  packageScriptInvocation,
  unpinnablePackageCommand,
} from "./planning/facts.js";
import { ownsPath } from "./planning/graph.js";
import {
  checkedAtFinal,
  dependencyOrder,
  fallbackRuns,
  finalChecks,
} from "./planning/plan.js";
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
import { errorMessage, failureExcerpt, headAndTail } from "./text.js";
import { factoryCommit, privateStagingPath } from "./work/collect.js";
import {
  addWorktree,
  clearStaleLocks,
  hasGitlink,
  hostGit,
  hostGitExit,
  removeWorktree,
  validationEnvironment,
} from "./worktree.js";

const MINUTE = 60_000;

/** `validation.commandTimeoutSeconds` when the configuration leaves it out. */
export const DEFAULT_COMMAND_TIMEOUT_SECONDS = 30 * 60;

/** Room in a validation deadline for the checkout, Git LFS, pins and capture. */
const VALIDATION_MARGIN_MS = 15 * MINUTE;

/**
 * The deadline of a step that validates a Work Item, or a plan's final
 * validation: every command it runs at its full limit, plus a margin (one
 * per Work Item run, when final validation runs those). It grows with the
 * commands, so a long command list never outlasts it. A Work Item's
 * validation with the repository's formatter (`formatting`) runs one more
 * command.
 */
export function validationDeadlineMs(
  of: WorkItem | Plan,
  commandTimeoutMs: number,
  formatting = false,
): number {
  if (!("validation" in of) && fallbackRuns(of).length)
    return fallbackRuns(of).reduce(
      (sum, item) => sum + validationDeadlineMs(item, commandTimeoutMs),
      0,
    );
  const { preparation, commands } =
    "validation" in of ? validationSequence(of) : finalSequence(of);
  const formatter = formatting && "validation" in of ? 1 : 0;
  return (
    (preparation.length + commands.length + formatter) * commandTimeoutMs +
    VALIDATION_MARGIN_MS
  );
}

/** A Work Item's commands, with no preparation. */
function validationSequence(item: WorkItem): {
  preparation: string[];
  commands: string[];
} {
  return { preparation: [], commands: item.validation.map((v) => v.command) };
}

/**
 * The indices of `sequence` a run takes, in order (`order`, #2281): every
 * one in declared order when `order` is absent, else `order`'s, each once.
 * The exact install, when the sequence starts with one, always runs first,
 * since the commands after it need what it installs.
 */
export function runOrder(
  sequence: readonly string[],
  order?: readonly number[],
): number[] {
  if (!order) return sequence.map((_, index) => index);
  const chosen = [...new Set(order)].filter(
    (index) => Number.isInteger(index) && index >= 0 && index < sequence.length,
  );
  return sequence.length && packageBootstrap(sequence[0]!) !== undefined
    ? [0, ...chosen.filter((index) => index !== 0)]
    : chosen;
}

export interface ValidateInput {
  /** The target clone; the fresh worktree is linked from it. */
  checkout: string;
  /** Where the fresh worktree goes, such as `<item worktree>.validation`. Replaced, then removed. */
  directory: string;
  /**
   * A Work Item's validation, the validate step's and the worker's own:
   * where the exact install keeps its package store across this item's
   * validations, such as `<item worktree>.packages` (#2169). The install
   * still runs every time, frozen, so each validation proves it works on
   * the result; it reuses the store only when the last install that wrote
   * it had the same key (`installKey`: the install command and every
   * dependency input), else it starts from an empty one. Only sandboxed,
   * and only without the operator's `sandbox.packageStore`, which every
   * install shares already. Absent (final validation): each install's
   * store is its own empty HOME's, as before.
   */
  installStore?: string;
  /**
   * With `installStore`: where the Objective's items share the exact
   * install's store (#2280), such as `<workDir>/<issue>/.packages`. An
   * install whose key is the one the item started from (`base`, else the
   * plan's) has every dependency input as there, so it uses the store kept
   * here under that key (`sharedStore`), which the Objective's first such
   * install filled; one whose inputs the candidate changed keeps
   * `installStore`, its own. Absent: always `installStore`.
   */
  sharedInstallStore?: string;
  /** The exact candidate commit. */
  commit: string;
  /** One Work Item's commands, or, absent, the plan's final commands. */
  item?: WorkItem;
  /**
   * The worker's own Validate, with `item` (#2281): the indices of its
   * commands that run, in this order (`runOrder`), such as only the one
   * that failed last, or every one with that one first. The exact install,
   * when the list starts with one, still runs first, and the formatter
   * after it; every command's scripts are still pinned. `commands` in the
   * answer are the ones that ran. Absent: every command, in declared order.
   */
  order?: readonly number[];
  plan: Plan;
  /** The Objective as planned (shown.ts): its Package manager update and Workspace package additions. */
  blocks: readonly ObjectiveBlock[];
  /** The commit a later item started from, when not the base: its new scripts stay fixed too. */
  predecessor?: string;
  /**
   * Item validation: the commit the candidate was built on, the
   * FACTORY_BASE_SHA of each command final validation never runs itself
   * (one that names its base, planning/facts.ts `namedBase`; with final
   * commands, any that isn't one), so its base-relative check sees only
   * this item's change, never other Objectives' merges since the plan's
   * base. A command final validation runs itself (planning/plan.ts
   * `checkedAtFinal`) gets the plan's base, as it will there: a check that
   * reads the base itself (a budget, a size limit, a coverage delta)
   * counts the Objective's change so far here as it will there (#2240).
   * Setup commands (an install, the formatter) keep the item's base. Absent (QA and final
   * validation, on the shared default branch): the plan's base for every
   * command, which no single commit can replace there; the plan check
   * refuses integrated commands that name it.
   */
  base?: string;
  /** Final validation of one Work Item's commands: the declared Package manager update must have landed. */
  requirePackageManagerUpdate?: true;
  /**
   * A Work Item's validation, the validate step's and the worker's own:
   * when the candidate changed its dependency inputs and the bootstrap
   * refuses its lockfile as out of date, Factory resolves the lockfile
   * itself (LOCKFILE_RESOLUTION), as the bootstrap installs, commits it on
   * the candidate and validates that commit instead (#2095). `ref` keeps
   * the commit from Git's pruning; `author` authors it (collect.ts
   * `factoryCommit`). Absent (QA and final validation, on the default
   * branch): the lockfile is never changed.
   */
  lockfile?: FactoryChange;
  /**
   * A Work Item's validation, the validate step's and the worker's own,
   * with the operator's `validation.formatCommand`: Factory runs the
   * repository's formatter in the validation checkout after the install
   * and before the item's commands, with no network, and commits what it
   * changed on the candidate as its own change (#2159; `applyFormatter`).
   * `ref` and `author` as for `lockfile`. Absent (QA and final validation,
   * or no formatter configured): nothing is formatted.
   */
  format?: FactoryChange & { command: string };
  sandbox: SandboxConfig;
  /** Each command's limit (`validation.commandTimeoutSeconds`); past it the command failed. */
  commandTimeoutMs: number;
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
  /**
   * The attempt's private files (engine.ts StepContext.runFile): each
   * command's whole output streams to one, kept only when the command
   * failed, and its `validation-result` names it by `output`.
   */
  runFile(kind: string): RunFile;
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

/**
 * How Factory commits a change of its own on the candidate (a resolved
 * lockfile, the formatter's output): `ref` keeps the commit from Git's
 * pruning until cleanup; `author` authors it (collect.ts `factoryCommit`).
 */
export interface FactoryChange {
  ref?: string;
  author?: () => Promise<CommitAuthor | undefined>;
}

/** Factory's commit on the candidate with the repository's formatter's output (`format`). */
export interface AppliedFormatter {
  /** The commit the commands ran on: the candidate, formatted. */
  commit: string;
  /** The operator's formatter command. */
  command: string;
  /** The files it changed, every one changed by the result and owned by the item. */
  files: string[];
  /**
   * Files the result changed that configure a formatter or fixer
   * (`formatterConfiguration`): the formatter ran under the result's own
   * configuration, so its commit is not layout alone by Factory's word and
   * result review judges its diff. Absent when the result changed none.
   */
  configuration?: string[];
}

/** Factory's commit on the candidate with the lockfile it resolved (`lockfile`). */
export interface RegeneratedLockfile {
  /** The commit the commands ran on: the candidate and the regenerated lockfile. */
  commit: string;
  /** The lockfile's path: pnpm-lock.yaml or package-lock.json. */
  lockfile: string;
}

export type Validation =
  | {
      kind: "passed";
      /** The tree the commands ran on: Factory's last commit's (`formatted`, else `regenerated`) when there is one. */
      tree: string;
      /** The commands that ran, preparation first. */
      commands: string[];
      results: CommandResult[];
      /** What came back to `returnTo`, for the worker; absent when nothing did. */
      produced?: string;
      /** Every review artifact captured, in command order; present when `reviewArtifacts` was given. */
      artifacts?: ReviewArtifact[];
      regenerated?: RegeneratedLockfile;
      /** Factory's formatting commit, on top of `regenerated` when both are made. */
      formatted?: AppliedFormatter;
    }
  /** The candidate's fault: the step repairs it. */
  | {
      kind: "failed";
      tree: string;
      /**
       * The tree validation started from, before Factory's own commits
       * (a resolved lockfile, the formatter's output): what a worker's own
       * Validate passed, when it passed this result. `validateTree` sets it
       * on every failure.
       */
      candidateTree?: string;
      commands: string[];
      /** The commands that passed before the failure. */
      results: CommandResult[];
      /**
       * The failed command, when one ran or its review artifact capture
       * failed; absent for a pin, the formatter or the mutation check.
       * `exit`: how a command that failed by itself ended (its exit code,
       * `time limit` or `disk budget`).
       */
      failed?: { index: number; command: string; exit?: string };
      /**
       * The repository's formatter, when it failed by itself: its command
       * and how it ended, as `failed.exit`. It is no validation command, so
       * `failed` stays absent.
       */
      formatter?: { command: string; exit: string };
      /** What people read: the start and end of the output. */
      detail: string;
      /** The complete output, for diagnosis and the next attempt. */
      output: string;
      /**
       * The failed command's attempt file (`runFile`): its whole output as
       * it arrived, stdout and stderr interleaved. Present when the command
       * itself failed.
       */
      outputFile?: RunFile;
      produced?: string;
      regenerated?: RegeneratedLockfile;
      formatted?: AppliedFormatter;
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
  const result = await validateCandidate(input);
  if (result.kind !== "failed") return result;
  // `tree` is Factory's last commit's when it made one; the rerun of a
  // tree the worker's Validate passed compares the candidate's own.
  return {
    ...result,
    candidateTree: await revParse(
      input.checkout,
      `${input.commit}^{tree}`,
      input.signal,
    ),
  };
}

async function validateCandidate(input: ValidateInput): Promise<Validation> {
  const { checkout, plan, item } = input;
  // A regenerated lockfile moves both to Factory's commit on the candidate.
  let { commit } = input;
  const { preparation, commands } = item
    ? validationSequence(item)
    : finalSequence(plan);
  const sequence = [...preparation, ...commands];
  // Every command is pinned below; only those of `order` run (#2281).
  const order = runOrder(sequence, item ? input.order : undefined);
  const ran = order.map((index) => sequence[index]!);
  const atFinal = checkedAtFinal(plan);
  const { signal } = input;
  let tree = await revParse(checkout, `${commit}^{tree}`, signal);
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
          requirePackageManagerUpdate: input.requirePackageManagerUpdate,
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
      commands: ran,
      results: [],
      detail: refusal.message,
      output: refusal.message,
    };
  const worktree = input.directory;
  try {
    await removeWorktree(checkout, worktree, input.signal);
    await addWorktree(checkout, worktree, commit, input.signal, input.log);
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
    let baseline = await status(worktree, signal);
    const dirty = mutationDetail(Buffer.alloc(0), baseline, hydrated);
    if (dirty) {
      // Checkout filters (line-ending or other attributes) rewrite what
      // the candidate committed; the candidate commits files as checked out.
      const detail = `Validation checkout is not clean before any command ran: ${dirty}. Commit these files as Git checks them out (renormalize them under the repository's .gitattributes), so a fresh checkout of the result is clean.`;
      return {
        kind: "failed",
        tree,
        commands: ran,
        results: [],
        detail,
        output: detail,
      };
    }
    const results: CommandResult[] = [];
    let artifacts: ReviewArtifact[] = [];
    let regenerated: RegeneratedLockfile | undefined;
    let formatted: AppliedFormatter | undefined;
    // An install gets an empty HOME of its own, so nothing an earlier
    // command left there configures it. `offline` keeps a command off the
    // network whatever sandbox.network says (the formatter's).
    const sandboxed = async (
      command: string,
      whole: RunFile,
      grant: {
        install: boolean;
        network: boolean;
        outputLimit?: number;
        offline?: true;
        /** The exact install's kept package store (`installStore`). */
        store?: string;
      },
    ) =>
      runSandboxed(command, {
        cwd: worktree,
        home: grant.install ? await made("factory-install-home-") : home,
        ...(grant.install && grant.store && { installStore: grant.store }),
        temporary,
        env: {
          ...validationEnvironment(credentials),
          // Factory fetches by SHA and never moves the checkout's
          // remote-tracking branches, so base-relative checks use this
          // (#1664): the plan's base for a command final validation runs
          // itself, as it gives it there, else the item's own (#2240).
          FACTORY_BASE_SHA:
            input.base !== undefined && !atFinal(command)
              ? input.base
              : plan.base,
        },
        config: grant.offline
          ? { ...input.sandbox, network: "off" }
          : input.sandbox,
        packageInstall: grant.install,
        network: grant.network,
        readOnlyFiles: linked.map((file) => file.path),
        ...(grant.outputLimit ? { outputLimit: grant.outputLimit } : {}),
        onOutput: (stream, text) => whole.append(text, stream),
        signal: input.signal,
        timeoutMs: input.commandTimeoutMs,
      });
    // The repository's formatter runs once, on a Work Item's validation:
    // after the exact install when the sequence starts with one (the
    // formatter is usually a dependency), else before the first command
    // (positions in `order`, which keeps the install first).
    const formatter = item ? input.format : undefined;
    const formatAt = formatter
      ? sequence.length && packageBootstrap(sequence[0]!) !== undefined
        ? 1
        : 0
      : undefined;
    let formatRan = false;
    const format = async (): Promise<Validation | undefined> => {
      formatRan = true;
      const applied = await applyFormatter({
        input,
        format: formatter!,
        item: item!,
        worktree,
        commit,
        baseline,
        hydrated,
        linked,
        installed: formatAt === 1,
        run: (command, file) =>
          sandboxed(command, file, {
            install: false,
            network: false,
            offline: true,
          }),
      });
      if (applied.kind === "formatted") {
        ({ commit, tree } = applied);
        formatted = {
          commit,
          command: formatter!.command,
          files: applied.files,
          ...(applied.configuration.length > 0 && {
            configuration: applied.configuration,
          }),
        };
        // The new commit's checkout is clean again, formatted.
        baseline = await status(worktree, signal);
        return undefined;
      }
      if (applied.kind === "unchanged" || applied.kind === "skipped")
        return undefined;
      if (applied.kind === "failed")
        return {
          kind: "failed",
          tree,
          commands: ran,
          results,
          ...(applied.exit !== undefined && {
            formatter: { command: formatter!.command, exit: applied.exit },
          }),
          detail: applied.detail,
          output: applied.output,
          ...(regenerated && { regenerated }),
        };
      return applied;
    };
    // After every command that passed: it must leave the result as
    // committed. The refusal names the command and shows what it changed.
    const treeChange = async (command: string) => {
      const changes = statusChanges(
        baseline,
        await status(worktree, signal),
        hydrated,
      );
      const headMoved = (await revParse(worktree, "HEAD", signal)) !== commit;
      if (!changes.length && !headMoved) return undefined;
      const what = [
        ...(changes.length ? [`changed ${describeChanges(changes)}`] : []),
        ...(headMoved ? ["moved HEAD"] : []),
      ].join(" and ");
      const diff = await boundedDiff(worktree, changes, signal);
      return `Validation command modified the result tree: \`${command}\` ${what}. Validation runs on the result as committed, so each command must leave it unchanged, writing only files Git ignores.${diff ? `\n\n${diff}` : ""}`;
    };
    for (let position = 0; position < order.length; position++) {
      if (position === formatAt && !formatRan) {
        const stopped = await format();
        if (stopped) return stopped;
      }
      const index = order[position]!;
      const command = sequence[index]!;
      const preparing = index < preparation.length;
      // Only Factory's exact script-disabled install, run first (before any
      // command could change the checkout) after its package inputs were
      // pinned above, writes the shared store; and only it, when the
      // operator allowed it, reaches the network.
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
      // The item's kept package store, for the exact install alone, keyed
      // by its inputs as this commit has them: the install still runs. An
      // install with the inputs the item started from shares the
      // Objective's store under that key (#2280).
      let store: KeptStore | undefined;
      if (
        install &&
        input.installStore &&
        !input.sandbox.packageStore &&
        sandboxAvailable().available
      )
        try {
          const key = await installKey(checkout, commit, command, signal);
          store =
            input.sharedInstallStore &&
            key ===
              (await installKey(
                checkout,
                input.base ?? plan.base,
                command,
                signal,
              ))
              ? await sharedStore(input.sharedInstallStore, key)
              : await keptStore(input.installStore, key);
        } catch (error) {
          signal.throwIfAborted();
          if (error instanceof GitRefusal) throw error;
          return {
            kind: "retry",
            reason: `The install's package store could not be made at ${input.installStore}: ${errorMessage(error)}. Free disk space and keep Factory's work directory writable.`,
          };
        }
      const started = Date.now();
      input.log({
        event: "validation-command",
        index,
        command,
        preparing,
        ...(store && {
          installStore: store.reused ? "reused" : "new",
          ...(store.shared && { installStoreShared: true }),
        }),
      });
      const limit = capture ? outputLimit(selectors, command) : undefined;
      // The whole output, as it arrives: what the run keeps of a failure.
      const whole = input.runFile(`validation-${index}`);
      let run: Awaited<ReturnType<typeof runSandboxed>>;
      try {
        run = await sandboxed(command, whole, {
          install,
          network: online,
          ...(limit ? { outputLimit: limit } : {}),
          ...(store && { store: store.root }),
        });
      } catch (error) {
        // Cancelled or past its deadline: nothing names its output.
        whole.remove();
        throw error;
      }
      whole.close();
      if (run.kind === "fault") whole.remove();
      if (run.kind === "fault")
        return objectiveWide(
          hold(
            `The command sandbox could not run \`${command}\`: ${run.detail}. ${run.fix}.`,
          ),
        );
      // After every command, the last too: a command that moved a linked
      // file's directory left another file at its path, unchecked by
      // rewrittenMedia, and would leave the operator's LFS object writable
      // to the next command.
      const moved = movedLinks(worktree, linked);
      if (moved.length) {
        whole.remove();
        const detail = `Validation command modified the result tree: Git LFS files moved or replaced: ${moved
          .slice(0, 20)
          .join(
            ", ",
          )}${moved.length > 20 ? ` and ${moved.length - 20} more` : ""}`;
        return {
          kind: "failed",
          tree,
          commands: ran,
          results,
          failed: { index, command },
          detail,
          output: detail,
          ...(regenerated && { regenerated }),
          ...(formatted && { formatted }),
        };
      }
      const output = `${run.stdout}${run.stderr}`;
      const durationMs = Date.now() - started;
      const overflow =
        run.diskOverflow ??
        (run.timedOut
          ? `the command ran longer than ${Math.round(input.commandTimeoutMs / 1000)} s and was stopped`
          : undefined);
      const passed = run.exitCode === 0 && !overflow;
      if (passed) whole.remove();
      // A store over the disk budget is never kept: the next install of the
      // item starts from an empty one.
      if (store && run.diskOverflow) await forceRemove(store.directory);
      input.log({
        event: "validation-result",
        index,
        command,
        passed,
        exitCode: run.exitCode,
        durationMs,
        // A failed command keeps what its repair sees: its head and tail,
        // and the whole output in its attempt file.
        tail: passed ? output.slice(-PASSED_OUTPUT_TAIL) : failedOutput(output),
        ...(passed
          ? {}
          : {
              output: whole.file,
              outputBytes: whole.written,
              ...(whole.dropped ? { outputDropped: whole.dropped } : {}),
            }),
      });
      if (passed) {
        results.push({
          command,
          ...(preparing && { preparation: true as const }),
          exitCode: 0,
          durationMs,
          tail: output.slice(-PASSED_OUTPUT_TAIL),
        });
        const changed = await treeChange(command);
        if (changed) {
          if (input.returnTo && item)
            produced = await returnProduced(
              worktree,
              input.returnTo,
              item,
              signal,
            );
          return {
            kind: "failed",
            tree,
            commands: ran,
            results,
            detail: changed,
            output: changed,
            ...(produced && { produced }),
            ...(regenerated && { regenerated }),
            ...(formatted && { formatted }),
          };
        }
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
            commands: ran,
            results,
            failed: { index, command },
            detail: captured.detail,
            output: captured.detail,
            ...(regenerated && { regenerated }),
            ...(formatted && { formatted }),
          };
        artifacts = captured.artifacts;
        continue;
      }
      // Past the sandbox's disk budget or the time limit the command
      // failed, whatever it exited.
      const exit = run.diskOverflow
        ? "disk budget"
        : run.timedOut
          ? "time limit"
          : String(run.exitCode);
      const failed = `Validation command failed (${exit}): ${command}: `;
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
      // The candidate changed its dependencies, and its lockfile no longer
      // matches them: no worker has the network to resolve one. Factory
      // does, once, as the install runs, and starts the sequence again on
      // its commit of the result (#2095).
      const manager = packageBootstrap(command);
      if (
        install &&
        manager &&
        input.lockfile &&
        !regenerated &&
        !overflow &&
        OUTDATED_LOCKFILE.test(output) &&
        (await dependencyInputsChanged(checkout, plan.base, commit, signal))
      ) {
        const resolved = await resolveLockfile({
          input,
          worktree,
          commit,
          manager,
          failed,
          output,
          baseline,
          hydrated,
          run: (resolution, file, network) =>
            sandboxed(resolution, file, { install: true, network }),
        });
        if (resolved.kind === "regenerated") {
          ({ commit, tree } = resolved);
          regenerated = { commit, lockfile: resolved.lockfile };
          // The new commit's checkout is clean again with its lockfile.
          baseline = await status(worktree, signal);
          position = -1;
          continue;
        }
        if (resolved.kind === "failed")
          return {
            kind: "failed",
            tree,
            commands: ran,
            results,
            failed: { index, command },
            detail: resolved.detail,
            output: resolved.output,
          };
        if (resolved.kind !== "unchanged") return resolved;
      }
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
        commands: ran,
        results,
        failed: { index, command, exit },
        detail,
        output: `${failed}${offlineBecause}${overflow ? `${overflow}\n` : ""}${output}`,
        outputFile: whole,
        ...(produced && { produced }),
        ...(regenerated && { regenerated }),
        ...(formatted && { formatted }),
      };
    }
    // A sequence of only the install formats after it.
    if (formatAt !== undefined && !formatRan) {
      const stopped = await format();
      if (stopped) return stopped;
    }
    if (input.returnTo && item)
      produced = await returnProduced(worktree, input.returnTo, item, signal);
    // Every command's changes were checked as it passed (`treeChange`).
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
        commands: ran,
        results,
        detail,
        output: detail,
        ...(produced && { produced }),
        ...(regenerated && { regenerated }),
        ...(formatted && { formatted }),
      };
    }
    return {
      kind: "passed",
      tree,
      commands: ran,
      results,
      ...(produced && { produced }),
      ...(capture && { artifacts }),
      ...(regenerated && { regenerated }),
      ...(formatted && { formatted }),
    };
  } finally {
    await Promise.all(scratch.map((path) => forceRemove(path)));
    await removeWorktree(checkout, worktree, input.signal).catch(
      () => undefined,
    );
  }
}

/**
 * The linked Git LFS files whose path no longer holds their inode as a
 * regular file reached without links.
 */
function movedLinks(worktree: string, linked: readonly LfsFile[]): string[] {
  return linked
    .filter((file) => {
      const path = join(worktree, file.path);
      const seen = lstatSync(path, { throwIfNoEntry: false });
      return (
        !seen?.isFile() ||
        seen.ino !== file.linked?.ino ||
        realpathSync(path) !== join(realpathSync(worktree), file.path)
      );
    })
    .map((file) => file.path);
}

/** The commands the plan declared: its authority for a new script or an install. */
const sourceDeclared = (items: readonly WorkItem[]) =>
  items.flatMap((item) => item.validation.map((check) => check.command));

// ---------------------------------------------------------------------------
// Output

/**
 * A failed command's output as people read it: the start and the end, where
 * test runners report failures (#1596), and the lines that look like errors
 * or failures between them (#2201). Diagnosis gets the kept output
 * (step-validate.ts), cut the same way.
 */
const FAILED_OUTPUT_CHARS = 10_000;
/** What a passing command keeps of its output. */
const PASSED_OUTPUT_TAIL = 2_000;
/** pnpm's and npm's errors for a package an offline install cannot fetch. */
const OFFLINE_PACKAGES_MISSING =
  /\b(?:ERR_PNPM_NO_OFFLINE_(?:META|TARBALL)|ENOTCACHED)\b/;
/** pnpm's and npm's refusals of a lockfile that no longer matches the manifests. */
const OUTDATED_LOCKFILE =
  /\bERR_PNPM_(?:OUTDATED_LOCKFILE|LOCKFILE_CONFIG_MISMATCH)\b|`npm ci` can only install packages when your package\.json and package-lock\.json/;

const failedOutput = (output: string) =>
  failureExcerpt(output, FAILED_OUTPUT_CHARS);

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
  const changes = statusChanges(before, after, hydrated);
  return changes.length ? describeChanges(changes) : undefined;
}

/** One status record that appeared (`+`) or went (`-`) between two listings. */
interface StatusChange {
  sign: "+" | "-";
  /** The two-letter status, such as ` M` or `??`. */
  status: string;
  path: string;
  /** A rename's or copy's source. */
  from?: string;
}

/** The status records that differ between two listings, as mutationDetail counts them. */
function statusChanges(
  before: Buffer,
  after: Buffer,
  hydrated: ReadonlySet<string>,
): StatusChange[] {
  const records = (listing: Buffer) => {
    const fields = listing.toString("utf8").split("\0");
    const result = new Map<string, Omit<StatusChange, "sign">>();
    for (let index = 0; index < fields.length; index += 1) {
      const field = fields[index]!;
      if (!field) continue;
      if (field.startsWith(" M ") && hydrated.has(field.slice(3))) continue;
      const record = { status: field.slice(0, 2), path: field.slice(3) };
      // A rename or copy carries its source as the next field.
      if (/[RC]/.test(record.status)) {
        const from = fields[++index]!;
        result.set(`${field} (from ${from})`, { ...record, from });
      } else result.set(field, record);
    }
    return result;
  };
  const initial = records(before);
  const final = records(after);
  return [
    ...[...initial]
      .filter(([entry]) => !final.has(entry))
      .map(([, record]) => ({ sign: "-" as const, ...record })),
    ...[...final]
      .filter(([entry]) => !initial.has(entry))
      .map(([, record]) => ({ sign: "+" as const, ...record })),
  ];
}

/** Status changes as people read them: at most 20, each cut at 260 characters. */
function describeChanges(changes: readonly StatusChange[]): string {
  const entries = changes
    .map(
      ({ sign, status, path, from }) =>
        `${sign}${status} ${path}${from === undefined ? "" : ` (from ${from})`}`,
    )
    .map((entry) => (entry.length > 260 ? `${entry.slice(0, 256)}…` : entry));
  return `${entries.slice(0, 20).join(", ")}${entries.length > 20 ? ` and ${entries.length - 20} more` : ""}`;
}

/** What a mutation refusal shows of the diff: its start and end. */
const CHANGE_DIFF_HEAD = 4_000;
const CHANGE_DIFF_TAIL = 2_000;
/** The most files a refusal's diff reads, and the largest new file it shows. */
const CHANGE_DIFF_FILES = 20;
const CHANGE_DIFF_NEW_BYTES = 64 * 1024;

/**
 * The diff of what appeared in the checkout (`changes`), bounded: tracked
 * files against HEAD, and a new regular file against nothing. Git runs
 * with no external diff or text conversion; a new file that isn't a
 * regular file or is larger than CHANGE_DIFF_NEW_BYTES is only named. Empty
 * when nothing shows.
 */
async function boundedDiff(
  worktree: string,
  changes: readonly StatusChange[],
  signal: AbortSignal,
): Promise<string> {
  const appeared = changes.filter((change) => change.sign === "+");
  const tracked = [
    ...new Set(
      appeared
        .filter((change) => change.status !== "??")
        .flatMap((change) =>
          change.from === undefined
            ? [change.path]
            : [change.path, change.from],
        ),
    ),
  ].slice(0, CHANGE_DIFF_FILES);
  const diff = ["diff", "--no-ext-diff", "--no-textconv", "--no-color"];
  const parts: string[] = [];
  if (tracked.length)
    parts.push(
      (
        await hostGit(worktree, [...diff, "HEAD", "--", ...tracked], { signal })
      ).toString("utf8"),
    );
  for (const change of appeared
    .filter((entry) => entry.status === "??")
    .slice(0, CHANGE_DIFF_FILES - tracked.length)) {
    const file = lstatSync(join(worktree, change.path), {
      throwIfNoEntry: false,
    });
    if (!file?.isFile() || file.size > CHANGE_DIFF_NEW_BYTES) {
      parts.push(
        `new ${file?.isFile() ? `file of ${file.size} bytes` : "entry"}: ${change.path}\n`,
      );
      continue;
    }
    // --no-index exits 1 when the files differ, as they do.
    const shown = await hostGitExit(
      worktree,
      [...diff, "--no-index", "--", "/dev/null", change.path],
      { signal },
    );
    parts.push(shown.stdout.toString("utf8"));
  }
  const text = parts.join("").trim();
  return text ? headAndTail(text, CHANGE_DIFF_HEAD, CHANGE_DIFF_TAIL) : "";
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
  return changed.some(dependencyInput);
}

/** Whether `path` is an input of the dependency install: a lockfile, a manifest or package configuration. */
function dependencyInput(path: string): boolean {
  return (
    path === "pnpm-lock.yaml" ||
    path === "package-lock.json" ||
    path === "pnpm-workspace.yaml" ||
    path === ".npmrc" ||
    // pnpm also reads a project's package.json5 or package.yaml.
    /(?:^|\/)package\.(?:json|json5|yaml)$/.test(path)
  );
}

/**
 * The key of the exact install `command` on `commit` (#2169): a SHA-256 of
 * the command and of every dependency input's path, mode and blob there,
 * so a change to any lockfile, manifest or package configuration, or to
 * the command, makes another.
 *
 * A package from the checkout itself (a `file:` tarball or directory) is
 * fetched from the commit's files, and pnpm and npm then serve it from the
 * store by the integrity the lockfile records, never reading the file
 * again: a result that changed only the vendored tarball would install the
 * old package from a kept store, where an empty one fails the integrity
 * check. So when any dependency input names `file:`, the key covers every
 * path, mode and blob of the commit: only the very same tree reuses it.
 * `file:` counts only as a protocol (LOCAL_PACKAGE): every pnpm lockfile's
 * own `excludeLinksFromLockfile:` setting ends in it too, which once keyed
 * every pnpm install by the whole tree, so a store was reused only on the
 * very tree it was filled on (#2280).
 */
export async function installKey(
  checkout: string,
  commit: string,
  command: string,
  signal: AbortSignal,
): Promise<string> {
  const hash = createHash("sha256").update(`${command.trim()}\0`);
  const entries = (
    await hostGit(checkout, ["ls-tree", "-r", "--full-tree", "-z", commit], {
      signal,
    })
  )
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  // `<mode> <type> <object>\t<path>`, in Git's path order.
  const inputs = entries.filter((entry) =>
    dependencyInput(entry.slice(entry.indexOf("\t") + 1)),
  );
  const bodies = await readBlobs(
    (args, input) => hostGit(checkout, args, { input, signal }),
    inputs
      .map((entry) => entry.split(/[ \t]/))
      .filter(([, type]) => type === "blob")
      .map(([, , object]) => object!),
  );
  const local = bodies.some((body) => LOCAL_PACKAGE.test(body.toString()));
  for (const entry of local ? entries : inputs) hash.update(`${entry}\0`);
  return hash.digest("hex");
}

/**
 * A package from the checkout: the `file:` protocol, as a manifest's
 * dependency (`"file:vendor/foo.tgz"`), a lockfile's specifier, version or
 * tarball (`file:...`, `foo@file:...`) or `git+file:` names it, never a
 * word ending in "file" before a colon, such as pnpm's
 * `excludeLinksFromLockfile:`.
 */
const LOCAL_PACKAGE = /(?<![A-Za-z0-9])file:/;

/** An item's kept package store, ready for one install. */
interface KeptStore {
  /** The package-manager store and caches' root, the install's to write. */
  root: string;
  /** What holds it, removed when the store is not kept. */
  directory: string;
  /** The last install that wrote it had this one's key. */
  reused: boolean;
  /** The Objective's store (`sharedStore`), not the item's own. */
  shared?: true;
}

/**
 * The package store kept in `directory` across one item's validations
 * (`installStore`, #2169): its `cache` reused when the `key` beside it is
 * this install's, else emptied first and keyed anew. Only the install
 * writes `cache`, so what a reused one holds is what installs of these very
 * inputs fetched; the key stays outside, where no command reaches.
 */
export async function keptStore(
  directory: string,
  key: string,
): Promise<KeptStore> {
  const root = join(directory, "cache");
  const keyFile = join(directory, "key");
  let kept: string | undefined;
  try {
    kept = readFileSync(keyFile, "utf8");
  } catch {
    // None yet.
  }
  if (kept === key && lstatSync(root, { throwIfNoEntry: false })?.isDirectory())
    return { root, directory, reused: true };
  await forceRemove(directory);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  writeFileSync(keyFile, key, { mode: 0o600 });
  return { root, directory, reused: false };
}

/**
 * The store the Objective's items share for installs of one `key`
 * (`sharedInstallStore`, #2280): `<directory>/<key>/cache`. Never emptied
 * for another key, since each key has its own; a new one is made whole
 * under a temporary name and renamed into place, so installs of one key
 * at once never remove the store another is filling, and both write it as
 * a package manager's shared store is written. Only the exact install
 * writes `cache`, only with this key's inputs, so what an item reads there
 * is what installs of its very inputs fetched, whichever item ran them; the
 * key is the directory's name, outside what the install may write.
 */
export async function sharedStore(
  directory: string,
  key: string,
): Promise<KeptStore> {
  const kept = join(directory, key);
  const root = join(kept, "cache");
  const store = { root, directory: kept, shared: true as const };
  if (lstatSync(root, { throwIfNoEntry: false })?.isDirectory())
    return { ...store, reused: true };
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const made = await mkdtemp(join(directory, ".new-"));
  try {
    mkdirSync(join(made, "cache"), { mode: 0o700 });
    renameSync(made, kept);
  } catch (error) {
    await forceRemove(made);
    // Another install of this key made it first: this one shares it.
    if (!lstatSync(root, { throwIfNoEntry: false })?.isDirectory()) throw error;
    return { ...store, reused: true };
  }
  return { ...store, reused: false };
}

// ---------------------------------------------------------------------------
// Lockfile resolution

/** The ref that pins an item's resolved-lockfile commit; report and cancel cleanup delete it. */
export function lockfileRef(issue: number, itemId: string): string {
  return `refs/factory/${issue}/${itemId}/lockfile`;
}

/** What resolving an out-of-date lockfile came to. */
type Resolution =
  /** Factory's commit of the candidate with the resolved lockfile. */
  | { kind: "regenerated"; commit: string; tree: string; lockfile: string }
  /** The resolution left the lockfile as it was: the install's failure stands. */
  | { kind: "unchanged" }
  /** The candidate's fault: its package inputs kept the resolution offline. */
  | { kind: "failed"; detail: string; output: string }
  | Extract<Outcome, { kind: "hold" }>;

interface ResolutionContext {
  input: ValidateInput;
  worktree: string;
  commit: string;
  manager: "npm" | "pnpm";
  /** The install's failure, as its messages start. */
  failed: string;
  /** The install's output. */
  output: string;
  /** The checkout's status before any command ran. */
  baseline: Buffer;
  hydrated: ReadonlySet<string>;
  /** Runs the resolution as the install runs, with or without the network. */
  run(
    command: string,
    file: RunFile,
    network: boolean,
  ): ReturnType<typeof runSandboxed>;
}

/**
 * Resolve the lockfile of `commit`, whose bootstrap refused it as out of
 * date after the candidate changed its dependencies (#2095). No worker has
 * the network to, so Factory runs the package manager's lockfile-only
 * resolution (LOCKFILE_RESOLUTION) in the validation checkout as the
 * install runs: scripts and hooks off, the package store writable, and the
 * network only as the install would get it from these inputs, through
 * pasta, and only when every manifest the candidate changed names registry
 * packages alone (package-network.ts `resolutionNetworkRefusal`). The
 * repository's own policy (registries, minimum release age, provenance)
 * applies unchanged: the candidate can't change its configuration. The
 * lockfile is committed on the candidate as Factory's change, and the
 * caller validates that commit.
 *
 * With sandbox.network off nothing can resolve it: a hold naming
 * package-install. A resolution the package manager refuses (the
 * repository's minimum release age, a version the registry lacks) holds
 * with its message, unless the registry says no published version
 * satisfies a range the candidate declares (missingVersion): that is the
 * candidate's to repair. So is one that ran offline because of the
 * candidate's own inputs.
 */
async function resolveLockfile(
  context: ResolutionContext,
): Promise<Resolution> {
  const { input, worktree, commit, failed, output } = context;
  const { signal } = input;
  const { command, lockfile } = LOCKFILE_RESOLUTION[context.manager];
  const network = input.sandbox.network;
  if (network === "off")
    return hold(
      `${failed}the candidate changed its dependencies, and its ${lockfile} no longer matches them:\n${failedOutput(output)}\n\nNo worker has the network to resolve a lockfile, and Factory resolves one itself only when sandbox.network is package-install (or host). Set sandbox.network to package-install (\`factory setup --repo ${input.repository} --sandbox-network package-install --background\`), then answer \`retry\`; or answer replan or cancel.`,
      ["retry", "replan", "cancel"],
    );
  const refused: NetworkRefusal | undefined =
    network === "package-install"
      ? await resolutionNetworkRefusal(
          worktree,
          input.plan.base,
          commit,
          signal,
        )
      : undefined;
  const online = network === "package-install" && !refused;
  const started = Date.now();
  input.log({
    event: "lockfile-resolution",
    command,
    lockfile,
    network: network === "host" ? "host" : online ? "registry" : "offline",
    ...(refused ? { offline: refused.reason } : {}),
  });
  const whole = input.runFile("validation-lockfile");
  let run: Awaited<ReturnType<typeof runSandboxed>>;
  try {
    run = await context.run(command, whole, online);
  } catch (error) {
    // Cancelled or past its deadline: nothing names its output.
    whole.remove();
    throw error;
  }
  whole.close();
  if (run.kind === "fault") {
    whole.remove();
    return objectiveWide(
      hold(
        `The command sandbox could not run \`${command}\`: ${run.detail}. ${run.fix}.`,
      ),
    );
  }
  const resolution = `${run.stdout}${run.stderr}`;
  const overflow =
    run.diskOverflow ??
    (run.timedOut
      ? `the resolution ran longer than ${Math.round(input.commandTimeoutMs / 1000)} s and was stopped`
      : undefined);
  const passed = run.exitCode === 0 && !overflow;
  if (passed) whole.remove();
  input.log({
    event: "lockfile-resolution-result",
    command,
    passed,
    exitCode: run.exitCode,
    durationMs: Date.now() - started,
    tail: passed
      ? resolution.slice(-PASSED_OUTPUT_TAIL)
      : failedOutput(resolution),
    ...(passed
      ? {}
      : {
          output: whole.file,
          outputBytes: whole.written,
          ...(whole.dropped ? { outputDropped: whole.dropped } : {}),
        }),
  });
  if (!passed) {
    const ran = `${failed}the candidate changed its dependencies, so Factory resolved ${lockfile} with \`${command}\`, which failed (${run.diskOverflow ? "disk budget" : run.timedOut ? "time limit" : run.exitCode})`;
    const missing = !overflow && OFFLINE_PACKAGES_MISSING.test(resolution);
    // As for the install: offline for the host's lack of pasta, or for
    // inputs Factory could not check, is the operator's to fix.
    if (run.offline !== undefined && missing)
      return objectiveWide(
        hold(
          `${ran}: it ran offline, because ${run.offline}, and the package store lacks what it needs:\n${failedOutput(resolution)}\n\nInstall passt so pasta is on Factory's PATH, and run Factory as a regular user, so verified installs reach the configured registry; then answer \`retry\`.`,
        ),
      );
    if (refused?.unverified && missing)
      return objectiveWide(
        hold(
          `${ran}: it ran offline, because ${refused.reason}, and the package store lacks what it needs:\n${failedOutput(resolution)}\n\nKeep the base's registry configuration literal http(s) URLs and its lockfiles plain YAML or JSON; then answer \`retry\`.`,
        ),
      );
    // The candidate's own inputs kept it offline: its fault, with why,
    // however the offline resolution failed (a git or URL dependency
    // fails with its own error, not the store's).
    if (refused && !refused.unverified) {
      const offline = `${ran}: it ran offline, because ${refused.reason}${missing ? ", and the package store lacks what it needs" : ""}:\n`;
      return {
        kind: "failed",
        detail: `${offline}${failedOutput(resolution)}`,
        output: `${offline}${resolution}`,
      };
    }
    // A version no published release satisfies is the worker's typo, but
    // pnpm and npm can refuse a release-age policy's version the same way:
    // only the registry's own answer, asked as the resolution asked it,
    // tells them apart (#2099).
    const lookedUp =
      !overflow && run.offline === undefined && (online || network === "host")
        ? await missingVersion(context, resolution, online)
        : undefined;
    if (lookedUp?.kind === "repair") {
      const detail = `${ran}: ${lookedUp.message}`;
      return { kind: "failed", detail, output: detail };
    }
    return hold(
      `${ran}. The package manager refused it:\n${overflow ?? failedOutput(resolution)}\n\n${lookedUp ? `${lookedUp.note}\n\n` : ""}The repository's package policy (such as its minimum release age) or the registry refuses what the change asks for, and Factory never relaxes that policy. Answer \`retry\` once the registry or the policy on the default branch allows it, replan to plan the dependency change again, or cancel.`,
      ["retry", "replan", "cancel"],
    );
  }
  // Only the lockfile may change; anything else is not Factory's to commit.
  const changed = mutationDetail(
    context.baseline,
    await status(worktree, signal),
    context.hydrated,
  );
  if (!changed) return { kind: "unchanged" };
  if (changed !== `+ M ${lockfile}`)
    return hold(
      `\`${command}\` changed more than ${lockfile} in the validation checkout: ${changed}. Factory commits only the lockfile. Answer retry to validate again; if it repeats, report it.`,
    );
  const { commit: made, tree } = await commitFactoryChange(
    input,
    worktree,
    [lockfile],
    `Factory: resolve ${lockfile} for the dependency change`,
    input.lockfile,
  );
  input.log({ event: "lockfile-resolved", lockfile, commit: made });
  return { kind: "regenerated", commit: made, tree, lockfile };
}

/**
 * Commit `paths` of the validation checkout on its HEAD as Factory's own
 * change, authored like a collected result, and pin the commit at
 * `change.ref`: the validation checkout goes when validation ends, and the
 * ref keeps the commit until cleanup. A resolved lockfile and the
 * repository's formatter's output are committed this way.
 */
async function commitFactoryChange(
  input: ValidateInput,
  worktree: string,
  paths: readonly string[],
  message: string,
  change: FactoryChange | undefined,
): Promise<{ commit: string; tree: string }> {
  const { signal } = input;
  const git = (args: string[]) => hostGit(worktree, args, { signal });
  const commitAs = factoryCommit(await change?.author?.());
  await git(["add", "--", ...paths]);
  await git([
    ...commitAs.config,
    "commit",
    "--quiet",
    ...commitAs.author,
    "-m",
    message,
  ]);
  const commit = (await git(["rev-parse", "HEAD"])).toString("utf8").trim();
  const tree = (await git(["rev-parse", "HEAD^{tree}"]))
    .toString("utf8")
    .trim();
  if (change?.ref) {
    await clearStaleLocks(input.checkout, { signal, log: input.log });
    await hostGit(input.checkout, ["update-ref", change.ref, commit], {
      signal,
    });
  }
  return { commit, tree };
}

// ---------------------------------------------------------------------------
// The repository's formatter

/** The ref that pins an item's formatting commit; report and cancel cleanup delete it. */
export function formatRef(issue: number, itemId: string): string {
  return `refs/factory/${issue}/${itemId}/format`;
}

/** Factory's commit message for the formatter's output. */
export const FORMAT_COMMIT_MESSAGE =
  "Factory: apply the repository's formatter";

/** What running the repository's formatter came to. */
type Formatting =
  /** Factory's commit of the candidate, formatted; `configuration` as AppliedFormatter's. */
  | {
      kind: "formatted";
      commit: string;
      tree: string;
      files: string[];
      configuration: string[];
    }
  /** The formatter left the checkout as it was. */
  | { kind: "unchanged" }
  /** With no install before it, the formatter couldn't run and changed nothing: validation goes on unformatted. */
  | { kind: "skipped" }
  /**
   * The candidate's fault: the formatter failed, or changed what it may not.
   * `exit`: how a formatter that failed by itself ended, as `failed.exit`.
   */
  | { kind: "failed"; detail: string; output: string; exit?: string }
  | Extract<Outcome, { kind: "hold" }>;

interface FormatContext {
  input: ValidateInput;
  format: NonNullable<ValidateInput["format"]>;
  item: WorkItem;
  worktree: string;
  /** The candidate, as checked out. */
  commit: string;
  /** The checkout's status before the formatter ran. */
  baseline: Buffer;
  hydrated: ReadonlySet<string>;
  linked: readonly LfsFile[];
  /** The item's exact install ran first, so the repository's dependencies are there. */
  installed: boolean;
  /** Runs the formatter as a validation command runs, with no network. */
  run(command: string, file: RunFile): ReturnType<typeof runSandboxed>;
}

/**
 * Apply the repository's formatter to a Work Item's result (#2159).
 * Formatting is deterministic, so no model spends tokens on it: Factory
 * runs the operator's `validation.formatCommand` in the validation
 * checkout, after the exact install and before the item's commands, under
 * the validation sandbox with no network, as `resolveLockfile` resolves a
 * dependency change's lockfile. It may change only files the result
 * changed (against the item's base) that the item owns; a change to any
 * other file the result changed, or any new, deleted or renamed one, fails
 * the candidate with the bounded diff. A change to a file the result left
 * as at its base means the base isn't formatted, which no repair can fix:
 * that holds for the operator, with the diff. A formatter that exits
 * non-zero, outlasts its limit or overflows the disk budget fails the
 * candidate with its output; but with no install before it (an item whose
 * commands don't start with one), a formatter that failed and changed
 * nothing is skipped, logged, since it may need the dependencies the
 * install brings. What it changed is committed on the candidate as
 * Factory's change (FORMAT_COMMIT_MESSAGE), pinned at `format.ref`, and the
 * caller validates, and later steps review and publish, that commit.
 */
async function applyFormatter(context: FormatContext): Promise<Formatting> {
  const { input, format, item, worktree, commit } = context;
  const { signal } = input;
  const { command } = format;
  const started = Date.now();
  input.log({ event: "format", command });
  const whole = input.runFile("validation-format");
  let run: Awaited<ReturnType<typeof runSandboxed>>;
  try {
    run = await context.run(command, whole);
  } catch (error) {
    // Cancelled or past its deadline: nothing names its output.
    whole.remove();
    throw error;
  }
  whole.close();
  if (run.kind === "fault") {
    whole.remove();
    return objectiveWide(
      hold(
        `The command sandbox could not run \`${command}\`: ${run.detail}. ${run.fix}.`,
      ),
    );
  }
  const output = `${run.stdout}${run.stderr}`;
  const overflow =
    run.diskOverflow ??
    (run.timedOut
      ? `the formatter ran longer than ${Math.round(input.commandTimeoutMs / 1000)} s and was stopped`
      : undefined);
  const passed = run.exitCode === 0 && !overflow;
  if (passed) whole.remove();
  const logged = {
    event: "format-result",
    command,
    passed,
    exitCode: run.exitCode,
    durationMs: Date.now() - started,
    tail: passed ? output.slice(-PASSED_OUTPUT_TAIL) : failedOutput(output),
    ...(passed
      ? {}
      : {
          output: whole.file,
          outputBytes: whole.written,
          ...(whole.dropped ? { outputDropped: whole.dropped } : {}),
        }),
  };
  if (!passed) {
    input.log(logged);
    // Without the install, a dependency formatter can't run at all, and
    // the worker can't change the item's commands: never its repair.
    if (
      !context.installed &&
      !run.diskOverflow &&
      !movedLinks(worktree, context.linked).length &&
      !statusChanges(
        context.baseline,
        await status(worktree, signal),
        context.hydrated,
      ).length
    ) {
      input.log({
        event: "format-skipped",
        command,
        reason:
          "the formatter failed with no install before it and changed nothing; the item's commands don't start with the exact install, so the repository's dependencies may be missing",
      });
      return { kind: "skipped" };
    }
    const exit = run.diskOverflow
      ? "disk budget"
      : run.timedOut
        ? "time limit"
        : String(run.exitCode);
    const failed = `The repository's formatter failed (${exit}): ${command}: `;
    return {
      kind: "failed",
      detail: `${failed}${overflow ?? failedOutput(output)}`,
      output: `${failed}${overflow ? `${overflow}\n` : ""}${output}`,
      exit,
    };
  }
  const moved = movedLinks(worktree, context.linked);
  const changes = statusChanges(
    context.baseline,
    await status(worktree, signal),
    context.hydrated,
  );
  input.log({
    ...logged,
    changed: changes.filter((change) => change.sign === "+").length,
  });
  if (moved.length) {
    const detail = `The repository's formatter \`${command}\` moved or replaced Git LFS files: ${moved.slice(0, 20).join(", ")}${moved.length > 20 ? ` and ${moved.length - 20} more` : ""}`;
    return { kind: "failed", detail, output: detail };
  }
  if (!changes.length) return { kind: "unchanged" };
  // The files the result changed, from the commit it was built on.
  const changedByResult = new Set(
    (
      await hostGit(
        input.checkout,
        [
          "diff-tree",
          "-r",
          "--name-only",
          "-z",
          "--no-renames",
          input.base ?? input.plan.base,
          commit,
        ],
        { signal },
      )
    )
      .toString("utf8")
      .split("\0")
      .filter(Boolean),
  );
  const allowed = (change: StatusChange) =>
    change.sign === "+" &&
    change.status === " M" &&
    changedByResult.has(change.path) &&
    ownsPath(change.path, item.ownedPaths);
  const refused = changes.filter((change) => !allowed(change));
  // A file the result left as at its base, reformatted in place: the base
  // isn't formatted, and no repair of this result can change that.
  const unformattedBase = (change: StatusChange) =>
    change.status === " M" && !changedByResult.has(change.path);
  const candidates = refused.filter((change) => !unformattedBase(change));
  if (candidates.length) {
    const diff = await boundedDiff(worktree, candidates, signal);
    const detail = `The repository's formatter \`${command}\` changed files other than those the result changed within the item's owned paths: ${describeChanges(candidates)}. Factory applies the formatter only to the files a result changes and owns, so these must already be as it formats them.${diff ? `\n\n${diff}` : ""}`;
    return { kind: "failed", detail, output: detail };
  }
  if (refused.length) {
    const diff = await boundedDiff(worktree, refused, signal);
    return objectiveWide(
      hold(
        `The repository's formatter \`${command}\` changes files this result didn't change: ${describeChanges(refused)}. The commit the item was built on (${input.base ?? input.plan.base}) isn't formatted as the formatter formats it, and Factory formats only the files a result changes, so no repair can fix this. Format the default branch with \`${command}\` and merge that, then answer replan to plan again from it; or cancel.${diff ? `\n\n${diff}` : ""}`,
        ["replan", "cancel"],
      ),
    );
  }
  const files = changes.map((change) => change.path).sort();
  const configuration = await formatterConfiguration(
    new Revisions(input.checkout, commit, signal),
    input.base ?? input.plan.base,
    commit,
    [...changedByResult],
    signal,
  );
  const made = await commitFactoryChange(
    input,
    worktree,
    files,
    FORMAT_COMMIT_MESSAGE,
    format,
  );
  input.log({
    event: "format-applied",
    command,
    commit: made.commit,
    files,
    ...(configuration.length > 0 && { configuration }),
  });
  return { kind: "formatted", ...made, files, configuration };
}

/**
 * The basenames of files that configure a formatter or fixer: the
 * formatter Factory runs reads the result's own copies, so a result that
 * changes one can make the formatting commit more than layout (a lint rule
 * with a fix, say).
 */
const FORMATTER_CONFIGURATION =
  /^(?:\.?biome\.jsonc?|\.prettierrc(?:\..+)?|prettier\.config\.[cm]?[jt]s|\.editorconfig|\.?dprint\.jsonc?|\.eslintrc(?:\..+)?|eslint\.config\.[cm]?[jt]s|\.stylelintrc(?:\..+)?|stylelint\.config\.[cm]?[jt]s|\.?rustfmt\.toml|\.clang-format|\.clang-tidy|pyproject\.toml|\.?ruff\.toml|setup\.cfg|\.flake8|\.isort\.cfg|deno\.jsonc?|\.golangci\.ya?ml|\.rubocop\.yml|\.swiftformat|\.swift-format|\.scalafmt\.conf|\.php-cs-fixer(?:\.dist)?\.php)$/;

/** The package.json keys formatters and fixers read their configuration from. */
const PACKAGE_FORMATTER_KEYS = [
  "prettier",
  "eslintConfig",
  "stylelint",
  "biome",
] as const;

/**
 * Which of `changed` (the files the result changed from `base`) configure
 * a formatter or fixer: a FORMATTER_CONFIGURATION file, or a package.json
 * whose PACKAGE_FORMATTER_KEYS differ from the base's (one that doesn't
 * parse counts).
 */
async function formatterConfiguration(
  revisions: Revisions,
  base: string,
  commit: string,
  changed: readonly string[],
  signal: AbortSignal,
): Promise<string[]> {
  const found: string[] = [];
  for (const path of [...changed].sort()) {
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (FORMATTER_CONFIGURATION.test(name)) found.push(path);
    else if (name === "package.json") {
      const keys = async (revision: string) => {
        const text = await revisions.text(revision, path);
        if (text === undefined) return {};
        const parsed: unknown = JSON.parse(text);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          throw new Error("not an object");
        const manifest = parsed as Record<string, unknown>;
        return Object.fromEntries(
          PACKAGE_FORMATTER_KEYS.map((key) => [key, manifest[key]]),
        );
      };
      try {
        if (!isDeepStrictEqual(await keys(base), await keys(commit)))
          found.push(path);
      } catch (error) {
        if (error instanceof GitRefusal) throw error;
        signal.throwIfAborted();
        found.push(path);
      }
    }
  }
  return found;
}

/**
 * Whether a failed resolution refused a version no published release
 * satisfies (#2099 item 5): `repair` with the worker's message, or `hold`
 * with what the hold adds; undefined when the output isn't a
 * no-matching-version refusal at all. The refusal must name a specifier
 * the candidate declares in the package inputs it changed, a plain semver
 * range with no prerelease (missing-version.ts). The lookup
 * (`pnpm view`/`npm view <name> versions time --json`) then runs exactly
 * as the resolution ran: the same sandbox and network grant (`online`),
 * in the same checkout, whose package configuration must be the base's
 * (configurationRefusal). It sends the registry nothing the resolution
 * didn't: the package's name. Only when its answer lists no version that
 * satisfies the range is it a repair; a version that satisfies it (one
 * the release-age policy keeps out, say), a failed, timed-out, truncated
 * or unreadable lookup, and every step Factory can't read exactly hold.
 */
async function missingVersion(
  context: ResolutionContext,
  resolution: string,
  online: boolean,
): Promise<
  | { kind: "repair"; message: string }
  | { kind: "hold"; note: string }
  | undefined
> {
  const { input, worktree, commit, manager } = context;
  const { signal } = input;
  const held = (note: string) => ({ kind: "hold" as const, note });
  const request = refusedRequest(manager, resolution);
  if (request === undefined) {
    const code =
      manager === "pnpm"
        ? /\bERR_PNPM_NO_MATCHING_VERSION\b/
        : /^npm error code ETARGET$/m;
    return code.test(resolution)
      ? held(
          "Factory couldn't read exactly one package and range the package manager found no version for, or the message named a release-age policy, so it didn't look the package up.",
        )
      : undefined;
  }
  const configured = await configurationRefusal(
    worktree,
    input.plan.base,
    commit,
    signal,
  );
  if (configured)
    return held(
      `Factory didn't look the package up, because ${configured.reason}.`,
    );
  let declared: Awaited<ReturnType<typeof declaredRequests>>;
  try {
    declared = await declaredRequests(
      worktree,
      input.plan.base,
      commit,
      signal,
    );
  } catch (error) {
    if (error instanceof GitRefusal) throw error;
    signal.throwIfAborted();
    declared = undefined;
  }
  if (!declared)
    return held(
      "Factory didn't look the package up, because it couldn't read the package inputs the change made.",
    );
  const requested = matchRequest(request, declared);
  if (!requested)
    return held(
      "Factory didn't look the package up, because the version refused isn't exactly one the change itself requests.",
    );
  const refused = lookupRefusal(requested);
  if (refused)
    return held(
      `Factory didn't look ${requested.name} up, because ${refused}.`,
    );
  const command = lookupCommand(manager, requested.name);
  const file = input.runFile("validation-lockfile-lookup");
  let run: Awaited<ReturnType<typeof runSandboxed>>;
  try {
    run = await context.run(command, file, online);
  } catch (error) {
    file.remove();
    throw error;
  }
  file.close();
  const judged =
    run.kind === "fault"
      ? ({
          kind: "unknown",
          reason: `the sandbox couldn't run it: ${run.detail}`,
        } as const)
      : run.exitCode !== 0 ||
          run.timedOut ||
          run.diskOverflow ||
          run.offline !== undefined ||
          run.truncated.stdout
        ? ({
            kind: "unknown",
            reason: `\`${command}\` failed (${run.diskOverflow ? "disk budget" : run.timedOut ? "time limit" : run.offline !== undefined ? "offline" : run.truncated.stdout ? "output cut" : run.exitCode})`,
          } as const)
        : judgeLookup(requested.range, run.stdout);
  input.log({
    event: "lockfile-resolution-lookup",
    command,
    network:
      input.sandbox.network === "host"
        ? "host"
        : online
          ? "registry"
          : "offline",
    range: requested.range,
    verdict: judged.kind,
    ...(judged.kind === "unknown" ? { reason: judged.reason } : {}),
    ...(judged.kind === "missing" ? { published: judged.published } : {}),
    ...(judged.kind === "satisfied" ? { version: judged.version } : {}),
    ...(run.kind === "ran"
      ? { exitCode: run.exitCode, output: file.file }
      : {}),
  });
  if (judged.kind === "missing")
    return {
      kind: "repair",
      message: repairMessage(manager, requested, judged),
    };
  return held(holdNote(requested, judged));
}

// ---------------------------------------------------------------------------
// Final validation's sequence

/**
 * The commands final validation runs: the declared prerequisites, then the
 * final checks (planning/plan.ts `finalChecks`). Only a bootstrap that runs
 * first installs, so the sequence starts with one exactly once: a bootstrap
 * the final checks list moves to the front, and otherwise the plan's
 * declared bootstrap leads. The plan's declared prerequisites run
 * first unless the final checks already start with them; when they do run
 * first, the bootstrap leads them.
 */
function finalSequence(plan: Plan): {
  preparation: string[];
  commands: string[];
} {
  const key = (command: string) => command.trim();
  const isBootstrap = (command: string) =>
    packageBootstrap(command) !== undefined;
  // A plan without final commands runs its Work Items' own (fallbackRuns).
  const finalCommands = plan.finalCommands.length ? finalChecks(plan) : [];
  const listed = finalCommands.filter(isBootstrap);
  let commands = [
    ...listed.filter(
      (command, index) =>
        listed.findIndex((other) => key(other) === key(command)) === index,
    ),
    ...finalCommands.filter((command) => !isBootstrap(command)),
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
  return dependencyOrder(plan).flatMap((item) => {
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
 * base, unless the plan's declared commands, the Package manager
 * update or Workspace package additions authorize a change. A dependency
 * change may move dependencies, the workspace's overrides and catalogs,
 * and the lockfile (checkWorkspaceChange).
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

/**
 * The package-script commands among `commands` whose script, or one of its
 * lifecycle hooks, a merge of this Objective changed: on `head` it differs
 * from the script the item validated (the accepted base's where the base
 * has it, else `predecessor`'s), so the pin check would refuse it there.
 * Each names the items whose merge changed it. A change no merge made is
 * left to the pin check.
 */
export async function laterScriptChanges(input: {
  checkout: string;
  base: string;
  predecessor?: string;
  head: string;
  commands: readonly string[];
  merges: readonly { items: string[]; mergeSha: string }[];
  signal: AbortSignal;
}): Promise<{ command: string; changedBy: string[] }[]> {
  const git = new Revisions(input.checkout, input.head, input.signal);
  const scriptsAt = async (
    revision: string,
  ): Promise<Record<string, unknown>> => {
    try {
      const scripts = JSON.parse(
        (await git.text(revision, "package.json")) ?? "{}",
      ).scripts;
      return scripts && typeof scripts === "object" ? scripts : {};
    } catch {
      input.signal.throwIfAborted();
      // Unreadable: the pin check refuses it.
      return {};
    }
  };
  const changes: { command: string; changedBy: string[] }[] = [];
  for (const command of packageScriptCommands(input.commands)) {
    const name = packageScriptInvocation(command)?.name;
    if (!name) continue;
    const hooks = [`pre${name}`, `post${name}`];
    const base = await scriptsAt(input.base);
    const reference =
      typeof base[name] === "string" || !input.predecessor
        ? base
        : await scriptsAt(input.predecessor);
    const head = await scriptsAt(input.head);
    if (
      !(
        (typeof reference[name] === "string" &&
          head[name] !== reference[name]) ||
        hooks.some((hook) => head[hook] !== reference[hook])
      )
    )
      continue;
    const changedBy: string[] = [];
    for (const merge of input.merges) {
      const [before, after] = await Promise.all([
        scriptsAt(`${merge.mergeSha}^1`),
        scriptsAt(merge.mergeSha),
      ]);
      if ([name, ...hooks].some((key) => before[key] !== after[key]))
        changedBy.push(...merge.items);
    }
    // An item final review sent back has merged more than once.
    if (changedBy.length)
      changes.push({ command, changedBy: [...new Set(changedBy)] });
  }
  return changes;
}

/**
 * A Work Item command final validation skipped (work/finish.ts finalRuns):
 * it compares with the base (`baseRelative`), or merges of `changedBy`
 * changed its package script.
 */
export type SkippedCheck = { item: string; command: string } & (
  | { baseRelative: true }
  | { changedBy: string[] }
);

/** Each skipped command and why, for the report, status and final review. */
export function skippedLines(skipped: readonly SkippedCheck[]): string[] {
  return skipped.map(
    (entry) =>
      `command \`${entry.command}\` (Work Item ${entry.item}): ${"changedBy" in entry ? `the merge of ${entry.changedBy.join(", ")} changed its package script` : "it compares with the base, so it checks only its own item's change"}; Work Item ${entry.item}'s own validation ran it`,
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
        "Package script validation blocked: npm bootstrap runs only when a plan validation command is exactly it",
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
    // A dependency change may move package.json and package-lock.json, as
    // pnpm's may (#2099): the install gets the network only for a lockfile
    // that resolves from the configured registries alone, Factory resolves
    // a stale one under the base's unchanged .npmrc, and the scripts it
    // runs stay pinned below. Both stay tracked, and no workspaces appear.
    for (const path of ["package.json", "package-lock.json"]) {
      if (!(await git.bytes(base, path))?.length)
        throw configuration(
          `Package script validation blocked: npm bootstrap needs tracked ${path} at the accepted base`,
        );
      if (!(await git.bytes(commit, path))?.length)
        throw candidate(
          `Package script validation blocked: npm bootstrap needs tracked ${path} in the result tree`,
        );
    }
    if (after?.workspaces !== undefined)
      throw candidate(
        "Package script validation blocked: npm bootstrap does not support workspaces",
      );
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
  if (commands.some(unpinnablePackageCommand))
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
      "Package script validation blocked: a new package.json runs only for a command the plan declared",
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
        `Package script validation blocked: new script ${name} runs only for a command the plan declared`,
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
      // An existing workspace's change was judged by checkWorkspaceChange.
      !(
        path === "pnpm-workspace.yaml" &&
        (atBase ?? atPredecessor) !== undefined
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
): { packages?: string[]; config: Record<string, unknown> } {
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
  // pnpm reads a workspace file without `packages` for its settings alone.
  if (
    (packages !== undefined &&
      (!Array.isArray(packages) ||
        packages.some((entry) => typeof entry !== "string") ||
        new Set(packages).size !== packages.length)) ||
    Object.hasOwn(config, "<<")
  )
    throw refuse(
      "Workspace packages must be a unique string sequence without merges",
    );
  return {
    ...(packages !== undefined && { packages: packages as string[] }),
    config,
  };
}

/** A mapping whose every value is a string: package selectors or names to specifiers. */
function specifierMap(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

/**
 * Why a workspace's changed dependency keys are malformed, or undefined:
 * `overrides` and `catalog` map names to specifiers, `catalogs` maps
 * catalog names to such mappings. Only keys that differ from `before`.
 */
function dependencyKeysProblem(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string | undefined {
  for (const key of WORKSPACE_DEPENDENCY_KEYS) {
    const value = after[key];
    if (value === undefined || isDeepStrictEqual(before[key], value)) continue;
    const valid =
      key === "catalogs"
        ? !!value &&
          typeof value === "object" &&
          !Array.isArray(value) &&
          Object.values(value).every(specifierMap)
        : specifierMap(value);
    if (!valid)
      return key === "catalogs"
        ? "catalogs must map catalog names to mappings of package names to version specifiers"
        : `${key} must map package ${key === "overrides" ? "selectors" : "names"} to version specifiers`;
  }
  return undefined;
}

/**
 * Keep the base's workspace security configuration across accepted
 * predecessors. Two kinds of change are allowed. Package membership grows
 * only by the Objective's Workspace package additions. The dependency keys
 * (package-network.ts WORKSPACE_DEPENDENCY_KEYS: overrides and catalogs)
 * may change with a dependency change, as package.json's dependencies may
 * (#2099): the frozen install fetches only what its verified lockfile
 * names, and Factory resolves that lockfile under the base's unchanged
 * policy, with the network only when every entry names the registry. Every
 * other setting (build approvals, release age, trust policy, registries,
 * hooks, patches) is the operator's.
 */
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
  if (after === undefined)
    throw candidate(
      additions.length
        ? "Workspace membership authority cannot remove the workspace"
        : `Package script validation blocked: ${WORKSPACE} differs from the accepted base`,
    );
  const before = parseWorkspace(baseline, configuration);
  const result = parseWorkspace(after, candidate);
  if (
    !isDeepStrictEqual(
      workspaceSettings(before.config),
      workspaceSettings(result.config),
    )
  )
    throw candidate(
      `Workspace configuration differs from the accepted base in settings other than package membership and ${WORKSPACE_DEPENDENCY_KEYS.join(", ")}; those settings (such as dependency build approvals, release age and registries) are the operator's to change on the default branch`,
    );
  const malformed = dependencyKeysProblem(before.config, result.config);
  if (malformed)
    throw candidate(
      `Package script validation blocked: ${WORKSPACE} ${malformed}`,
    );
  if (!additions.length) {
    if (!isDeepStrictEqual(before.packages, result.packages))
      throw candidate(
        `Package script validation blocked: ${WORKSPACE} package membership differs from the accepted base, and the Objective declares no Workspace package additions`,
      );
    return;
  }
  const existing = before.packages;
  const members = result.packages;
  if (!existing)
    throw configuration(
      "Workspace packages must be a unique string sequence without merges",
    );
  if (!members)
    throw candidate(
      "Workspace packages must be a unique string sequence without merges",
    );
  if (
    !isDeepStrictEqual(
      members.filter((entry) => existing.includes(entry)),
      existing,
    )
  )
    throw candidate(
      "Workspace membership authority cannot remove or reorder existing entries",
    );
  if (
    predecessor !== undefined &&
    (parseWorkspace(predecessor, configuration).packages ?? []).some(
      (entry) => !members.includes(entry),
    )
  )
    throw candidate(
      "Workspace membership authority cannot remove predecessor entries",
    );
  for (const entry of members.filter((entry) => !existing.includes(entry))) {
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
 * update, Quality checkpoint and Workspace package additions. The check
 * step runs this once; validation and planning then trust what it accepted.
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
  return problems;
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
