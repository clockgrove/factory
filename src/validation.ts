import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { isDeepStrictEqual } from "node:util";
import type {
  ContentStore,
  ValidationCommandReceipt,
  ValidationLfsMember,
  WorkItem,
} from "./contracts.js";
import type { FailedValidationEvidence } from "./failed-validation.js";
import {
  type CommandSandboxPolicy,
  STRICT_COMMAND_SANDBOX,
  recordSandboxBaseline,
  sandboxDiskOverflow,
  sandboxedCommand,
} from "./execution/sandbox.js";
import { StepFault, transient } from "./fault.js";
import { installMayUseNetwork } from "./execution/package-network.js";
import { indexHasGitlinks } from "./execution/staged-candidate.js";
import { lfsFiltered } from "./media.js";
import { ownsPath } from "./ownership.js";
import {
  assertPackageManagerUpdate,
  packageMetadata,
} from "./package-manager-update.js";
import {
  addWorktree,
  currentProcessDeadlineAt,
  currentProcessSignal,
  hasUnresolvedSubprocesses,
  localValidationEnvironment,
  pinnedGit,
  pinnedGitRaw,
  removeWorktree,
  subprocessAsync,
  withWorktreeRegistry,
} from "./process.js";
import {
  assertReviewArtifactSelectors,
  assertReviewArtifacts,
  captureReviewArtifacts,
  MAX_REVIEW_IMAGE_BYTES,
  type ReviewArtifactSelector,
} from "./review-artifacts.js";
import { stepDeadlineAt } from "./step.js";
import {
  type SelectedLfsValidation,
  safeValidationPath,
  type ValidationEvidence,
} from "./validation-evidence.js";
import {
  CandidateEnvironmentFailure,
  CandidateValidationFailure,
} from "./work-repair.js";
import { assertWorkspacePackageChange } from "./workspace-membership.js";

interface ValidationObservation {
  index: number;
  passed: boolean;
  exitCode: number;
  durationMs: number;
  output: string;
}

interface ValidationOutputObservation {
  index: number;
  stream: "stdout" | "stderr";
  output: string;
  final: boolean;
}

function assertSelectedLfsPointer(
  worktree: string,
  member: ValidationLfsMember,
): SelectedLfsValidation {
  if (!safeValidationPath(member.destination))
    throw new Error("Validation LFS destination is invalid");
  if (
    !/^[a-f0-9]{64}$/.test(member.digest) ||
    !Number.isSafeInteger(member.bytes) ||
    member.bytes < 0
  )
    throw new Error(
      `Validation LFS identity is invalid: ${member.destination}`,
    );
  if (
    !lfsFiltered(
      pinnedGit(
        worktree,
        "check-attr",
        "-z",
        "filter",
        "--",
        member.destination,
      ),
    )
  )
    throw new Error(
      `Validation LFS policy does not cover ${member.destination}`,
    );
  let pointer: string;
  try {
    pointer = pinnedGitRaw(
      worktree,
      "show",
      `HEAD:${member.destination}`,
    ).toString("utf8");
  } catch {
    throw new Error(
      `Validation tree is missing selected LFS path: ${member.destination}`,
    );
  }
  const expected = `version https://git-lfs.github.com/spec/v1\noid sha256:${member.digest}\nsize ${member.bytes}\n`;
  if (pointer !== expected)
    throw new Error(
      `Validation LFS pointer differs from selected bytes: ${member.destination}`,
    );
  return {
    treeSha: pinnedGit(worktree, "rev-parse", "HEAD^{tree}"),
    destination: member.destination,
    digest: member.digest,
    bytes: member.bytes,
    filter: "lfs",
  };
}

function assertSelectedLfsBytes(
  worktree: string,
  member: ValidationLfsMember,
): void {
  const path = join(worktree, member.destination);
  let fd: number | undefined;
  try {
    if (!lstatSync(path).isFile() || realpathSync(path) !== resolve(path))
      throw new Error("unsafe file type");
    fd = openSync(path, "r");
    const expectedBytes = fstatSync(fd).size;
    const hash = createHash("sha256");
    let bytes = 0;
    const chunk = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      hash.update(chunk.subarray(0, count));
      bytes += count;
    }
    if (
      bytes !== expectedBytes ||
      bytes !== member.bytes ||
      hash.digest("hex") !== member.digest
    )
      throw new Error("identity mismatch");
  } catch {
    throw new Error(
      `Validation could not restore selected LFS bytes: ${member.destination}`,
    );
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

async function hydrateSelectedLfsBytes(
  worktree: string,
  members: ValidationLfsMember[],
  contentStore?: ContentStore,
): Promise<SelectedLfsValidation[]> {
  if (!members.length) return [];
  if (!contentStore)
    throw new Error("Validation LFS content store is unavailable");
  const byDestination = new Map<string, ValidationLfsMember>();
  for (const member of members) {
    const existing = byDestination.get(member.destination);
    if (
      existing &&
      (existing.digest !== member.digest || existing.bytes !== member.bytes)
    )
      throw new Error(
        `Validation has conflicting LFS selections: ${member.destination}`,
      );
    byDestination.set(member.destination, member);
  }
  const selected = [...byDestination.values()];
  const receipts = selected.map((member) =>
    assertSelectedLfsPointer(worktree, member),
  );
  for (const member of selected) {
    const path = join(worktree, member.destination);
    try {
      if (!lstatSync(path).isFile() || realpathSync(path) !== resolve(path))
        throw new Error("unsafe file type");
      const ref = {
        digest: member.digest,
        bytes: member.bytes,
        mediaType: member.mediaType,
      };
      await contentStore.verify(ref);
      rmSync(path);
      await contentStore.materialize(ref, path);
    } catch {
      throw new Error(
        `Validation could not restore selected LFS bytes: ${member.destination}`,
      );
    }
    assertSelectedLfsBytes(worktree, member);
  }
  return receipts;
}

/**
 * A failed command's output as the Work Item error shows it: the start and
 * the end, where test runners report failures (#1596). The failure's
 * evidence keeps the complete output for diagnosis and the next attempt, and
 * `factory diagnostics --logs ITEM` prints it from the private diagnostics log.
 * The tail is at least the 8,000 characters worker Validate shows.
 */
const FAILED_OUTPUT_HEAD = 2_000;
const FAILED_OUTPUT_TAIL = 8_000;
function failedOutput(output: string): string {
  const omitted = output.length - FAILED_OUTPUT_HEAD - FAILED_OUTPUT_TAIL;
  if (omitted <= 0) return output;
  return `${output.slice(0, FAILED_OUTPUT_HEAD)}\n[… ${omitted} characters of output omitted …]\n${output.slice(-FAILED_OUTPUT_TAIL)}`;
}

/** Diagnostic-only projection: compare complete Git records before bounding display. */
function validationMutationDetail(before: Buffer, after: Buffer): string {
  const records = (output: Buffer) => {
    const result: {
      identity: string;
      status: string;
      path: Buffer;
      from?: Buffer;
    }[] = [];
    let offset = 0;
    while (offset < output.length) {
      const start = offset;
      const end = output.indexOf(0, offset);
      if (end < 0) throw new Error("Incomplete validation status observation");
      const record = output.subarray(offset, end);
      const status = record.subarray(0, 2).toString("ascii");
      offset = end + 1;
      let from: Buffer | undefined;
      if (/[RC]/.test(status)) {
        const fromEnd = output.indexOf(0, offset);
        if (fromEnd < 0)
          throw new Error("Incomplete validation rename observation");
        from = output.subarray(offset, fromEnd);
        offset = fromEnd + 1;
      }
      result.push({
        identity: output.subarray(start, offset).toString("hex"),
        status,
        path: record.subarray(3),
        ...(from ? { from } : {}),
      });
    }
    return result;
  };
  const initial = records(before);
  const final = records(after);
  const initialIds = new Set(initial.map((entry) => entry.identity));
  const finalIds = new Set(final.map((entry) => entry.identity));
  const changed = [
    ...initial
      .filter((entry) => !finalIds.has(entry.identity))
      .map((entry) => ({ ...entry, phase: "before" })),
    ...final
      .filter((entry) => !initialIds.has(entry.identity))
      .map((entry) => ({ ...entry, phase: "after" })),
  ];
  const displayPath = (bytes: Buffer) => {
    const text = bytes.toString("utf8");
    const utf8 = Buffer.from(text).equals(bytes);
    const value = utf8 ? text : bytes.toString("hex");
    return {
      path: value.slice(0, 256),
      ...(!utf8 ? { pathEncoding: "hex" } : {}),
      ...(value.length > 256 ? { pathTruncated: true } : {}),
    };
  };
  const paths: (ReturnType<typeof displayPath> & {
    phase: string;
    status: string;
    from?: ReturnType<typeof displayPath>;
  })[] = [];
  const detail = (entries: typeof paths) =>
    JSON.stringify({
      paths: entries,
      omittedRecords: changed.length - entries.length,
    });
  for (const entry of changed) {
    const display = {
      phase: entry.phase,
      status: entry.status,
      ...displayPath(entry.path),
      ...(entry.from ? { from: displayPath(entry.from) } : {}),
    };
    if (paths.length === 20 || detail([...paths, display]).length > 8192) break;
    paths.push(display);
  }
  return detail(paths);
}

/** Whether the candidate changed any input of the dependency install relative to the base. */
function dependencyInputsChanged(
  worktree: string,
  baseSha: string | undefined,
  commit: string,
): boolean {
  if (!baseSha) return false;
  const changed = pinnedGitRaw(
    worktree,
    "diff-tree",
    "-r",
    "--name-only",
    "-z",
    "--no-renames",
    baseSha,
    commit,
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

function treeHasGitlinks(checkout: string, commit: string): boolean {
  return pinnedGitRaw(checkout, "ls-tree", "-r", "-z", "--full-tree", commit)
    .toString("utf8")
    .split("\0")
    .some((entry) => entry.startsWith("160000 "));
}

const gitlinkRefusal = () =>
  new StepFault({
    kind: "config",
    detail:
      "Factory does not validate trees that contain submodule gitlinks: host-side Git would enter repositories sandboxed commands can write",
    fix: "Use Factory on a repository without submodules",
  });

interface ValidationPreparation {
  commands: string[];
  observe?: (entry: ValidationObservation) => void;
  observeOutput?: (entry: ValidationOutputObservation) => void;
}

export async function validateTree(
  checkout: string,
  root: string,
  commit: string,
  expectedTree: string,
  commands: string[],
  observe?: (entry: ValidationObservation) => void,
  observeOutput?: (entry: ValidationOutputObservation) => void,
  lfsMembers: ValidationLfsMember[] = [],
  contentStore?: ContentStore,
  acceptedBaseSha?: string,
  retainFailedValidation = true,
  preparation: ValidationPreparation = { commands: [] },
  reviewArtifacts: readonly ReviewArtifactSelector[] = [],
  /** Reads the settled checkout, passed or failed, before it is removed; must not throw. */
  inspectSettled?: (worktree: string) => void,
  sandbox: CommandSandboxPolicy = STRICT_COMMAND_SANDBOX,
): Promise<ValidationEvidence> {
  const worktree = join(root, "worktree");
  try {
    mkdirSync(root, { recursive: true });
  } catch (error) {
    throw new CandidateEnvironmentFailure(
      `Validation environment unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (treeHasGitlinks(checkout, commit)) throw gitlinkRefusal();
  await removeValidationWorktree(checkout, worktree);
  await addWorktree(checkout, worktree, commit);
  try {
    const evidence = await validateCheckout(
      worktree,
      root,
      commit,
      expectedTree,
      commands,
      observe,
      observeOutput,
      lfsMembers,
      contentStore,
      acceptedBaseSha,
      retainFailedValidation,
      preparation,
      reviewArtifacts,
      sandbox,
    );
    evidence.worktreeObservation!.checkoutPreparation = {
      kind: "fresh-detached-worktree",
      commitSha: commit,
      commandSequence: "after-checkout-creation",
    };
    return evidence;
  } finally {
    if (!hasUnresolvedSubprocesses()) {
      inspectSettled?.(worktree);
      await removeWorktree(checkout, worktree);
    }
  }
}

/** The same exact-tree executor for a newly created validator or worker checkout.
 * Its caller owns that checkout's lifetime; ignored preparation never transfers. */
export async function validateCheckout(
  worktree: string,
  root: string,
  commit: string,
  expectedTree: string,
  commands: string[],
  observe?: (entry: ValidationObservation) => void,
  observeOutput?: (entry: ValidationOutputObservation) => void,
  lfsMembers: ValidationLfsMember[] = [],
  contentStore?: ContentStore,
  acceptedBaseSha?: string,
  retainFailedValidation = true,
  preparation: ValidationPreparation = { commands: [] },
  reviewArtifacts: readonly ReviewArtifactSelector[] = [],
  /** The OS sandbox every command runs in; strict unless configuration relaxes it. */
  sandbox: CommandSandboxPolicy = STRICT_COMMAND_SANDBOX,
): Promise<ValidationEvidence> {
  assertReviewArtifactSelectors(reviewArtifacts);
  if (reviewArtifacts.length && !contentStore)
    throw new Error(
      "Review artifact capture requires the existing content store",
    );
  const emptyCredentials = join(root, "empty-gh-config");
  try {
    mkdirSync(root, { recursive: true });
    mkdirSync(emptyCredentials, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new CandidateEnvironmentFailure(
      `Validation environment unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (pinnedGit(worktree, "rev-parse", "HEAD") !== commit)
    throw new Error(
      "Validation checkout commit differs from its exact current scope",
    );
  const treeSha = pinnedGit(worktree, "rev-parse", "HEAD^{tree}");
  if (treeSha !== expectedTree)
    throw new Error(
      `Validation tree mismatch: expected ${expectedTree}, got ${treeSha}`,
    );
  if (pinnedGitRaw(worktree, "status", "--porcelain").length)
    throw new Error("Validation worktree is not initially clean");
  // Sandboxed commands can write any directory of the checkout. Behind a
  // gitlink, host-side Git would enter a repository they wrote, with its
  // configuration; so no checkout with one is validated.
  if (indexHasGitlinks(worktree)) throw gitlinkRefusal();
  const selectedLfs = await hydrateSelectedLfsBytes(
    worktree,
    lfsMembers,
    contentStore,
  );
  const hydratedStatus = pinnedGitRaw(worktree, "status", "--porcelain");
  const hydratedPaths = pinnedGitRaw(
    worktree,
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  );
  const evidence: ValidationEvidence = {
    treeSha,
    commands: [],
    ...(selectedLfs.length ? { selectedLfs } : {}),
  };
  const partial: FailedValidationEvidence = {
    commitSha: pinnedGit(worktree, "rev-parse", "HEAD"),
    treeSha,
    declaredCommands: [...commands],
    commands: [],
    reason: "command",
    initialStatus: "clean",
    postHydrationStatus: {
      porcelainSha256: createHash("sha256")
        .update(hydratedStatus)
        .digest("hex"),
      empty: hydratedStatus.length === 0,
    },
    postCommandStatus: "unchanged",
    selectedLfsMembers: selectedLfs.length,
    selectedLfsContentBinding: selectedLfs.length
      ? "unavailable"
      : "not-applicable",
    subprocessOwnership: "settled",
  };
  const candidateStatus = () =>
    pinnedGitRaw(worktree, "status", "--porcelain").equals(hydratedStatus) &&
    pinnedGit(worktree, "rev-parse", "HEAD") === partial.commitSha &&
    pinnedGit(worktree, "rev-parse", "HEAD^{tree}") === treeSha
      ? ("unchanged" as const)
      : ("modified" as const);
  if (preparation.commands.length) evidence.preparation = [];
  const sequence = [...preparation.commands, ...commands];
  // Every run gets its own empty TMPDIR, which a locator's files stay inside:
  // no other run's temporary files reach the commands. Under tmpdir(), not
  // the state root, so socket paths inside it stay short.
  // The sandbox's private HOME lasts the whole sequence, so what setup puts
  // there (caches, downloaded browsers) reaches the commands after it.
  let temporaryRoot: string;
  let homeRoot: string;
  const installHomes: string[] = [];
  try {
    temporaryRoot = mkdtempSync(join(tmpdir(), "factory-validation-"));
  } catch (error) {
    throw new CandidateEnvironmentFailure(
      `Validation environment unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    homeRoot = mkdtempSync(join(tmpdir(), "factory-home-"));
  } catch (error) {
    rmSync(temporaryRoot, { recursive: true, force: true });
    throw new CandidateEnvironmentFailure(
      `Validation environment unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    for (const [sequenceIndex, check] of sequence.entries()) {
      const preparing = sequenceIndex < preparation.commands.length;
      const index = preparing
        ? sequenceIndex
        : sequenceIndex - preparation.commands.length;
      const commandObserver = preparing ? preparation.observe : observe;
      const outputObserver = preparing
        ? preparation.observeOutput
        : observeOutput;
      const worktreeStatusBefore = candidateStatus();
      const started = Date.now();
      const cancellation = currentProcessSignal();
      const controllerDeadline = currentProcessDeadlineAt();
      const executionControl: ValidationCommandReceipt["executionControl"] =
        cancellation && !cancellation.aborted
          ? {
              scope: "controller-owned-process-group",
              cancellation: "active-at-dispatch",
              settlement: "verified",
              ...(controllerDeadline === stepDeadlineAt() &&
                controllerDeadline !== undefined &&
                Number.isFinite(Date.parse(controllerDeadline)) &&
                Date.parse(controllerDeadline) > started && {
                  deadlineAt: controllerDeadline,
                }),
            }
          : undefined;
      const settlement = { verified: false };
      let stdout = "";
      let stderr = "";
      const streamLimit = (stream: "stdout" | "stderr") => {
        const limits = reviewArtifacts.flatMap((selector) =>
          "text" in selector && selector.command === check
            ? [
                ...(selector.text[stream]
                  ? [selector.text[stream]!.maxBytes]
                  : []),
                ...(stream === "stdout" && selector.text.locator
                  ? [MAX_REVIEW_IMAGE_BYTES]
                  : []),
              ]
            : [],
        );
        return limits.length ? Math.min(...limits) : undefined;
      };
      const originalStreams = {
        stdout: {
          chunks: [] as Buffer[],
          bytes: 0,
          limit: streamLimit("stdout"),
        },
        stderr: {
          chunks: [] as Buffer[],
          bytes: 0,
          limit: streamLimit("stderr"),
        },
      };
      const decoders = {
        stdout: new StringDecoder("utf8"),
        stderr: new StringDecoder("utf8"),
      };
      // Only Factory's exact script-disabled install, run first (before any
      // command could change the checkout) after its package inputs were
      // verified, writes the shared store; and only it, when the operator
      // allowed it, reaches the network. It gets an empty HOME of its own,
      // so nothing an earlier command left there configures it.
      const install =
        sequenceIndex === 0 &&
        sandbox.packageInputsVerified === true &&
        packageBootstrap(check) !== undefined;
      // Network only from the configured registries: unchanged package
      // configuration and a lockfile that resolves only there.
      const online =
        install &&
        sandbox.network === "package-install" &&
        sandbox.packageInputsBase !== undefined &&
        installMayUseNetwork(worktree, sandbox.packageInputsBase, commit);
      let home = homeRoot;
      if (install) {
        home = mkdtempSync(join(tmpdir(), "factory-install-home-"));
        installHomes.push(home);
      }
      await recordSandboxBaseline({
        checkout: worktree,
        temporary: temporaryRoot,
      });
      const launch = sandboxedCommand({
        command: check,
        checkout: worktree,
        temporary: temporaryRoot,
        home,
        env: {
          ...localValidationEnvironment(emptyCredentials),
          TMPDIR: temporaryRoot,
          TMP: temporaryRoot,
          TEMP: temporaryRoot,
        },
        network: online,
        packageInstall: install,
        policy: sandbox,
      });
      const result = await subprocessAsync(
        launch.file,
        launch.args,
        { cwd: worktree, env: launch.env, bubblewrap: launch.bubblewrap },
        undefined,
        (stream, chunk) => {
          const original = originalStreams[stream];
          if (original.limit !== undefined) {
            const remaining = original.limit + 1 - original.bytes;
            if (remaining > 0) {
              const bytes = Buffer.from(chunk.subarray(0, remaining));
              original.chunks.push(bytes);
              original.bytes += bytes.length;
            }
          }
          const text = decoders[stream].write(chunk);
          if (stream === "stdout") stdout += text;
          else stderr += text;
          if (text)
            outputObserver?.({ index, stream, output: text, final: false });
        },
        (entry) => {
          if (entry.event === "cessation" && entry.status === "verified")
            settlement.verified = true;
        },
      );
      for (const stream of ["stdout", "stderr"] as const) {
        const trailing = decoders[stream].end();
        if (stream === "stdout") stdout += trailing;
        else stderr += trailing;
        outputObserver?.({ index, stream, output: trailing, final: true });
      }
      const output = `${stdout}${stderr}`;
      const durationMs = Date.now() - started;
      const overflow = await sandboxDiskOverflow({
        checkout: worktree,
        home,
        temporary: temporaryRoot,
        policy: sandbox,
      });
      commandObserver?.({
        index,
        passed: result.status === 0 && !overflow,
        exitCode: result.status ?? -1,
        durationMs,
        output,
      });
      if (hasUnresolvedSubprocesses())
        throw new Error(
          "Validation subprocess ownership unresolved; checkout retained",
        );
      // Over the budget no host-side Git reads the checkout: `git status`
      // would hash what the command wrote, through any clean filter.
      if (!overflow) {
        partial.postCommandStatus = candidateStatus();
        if (!preparing)
          partial.commands.push({
            index,
            command: check,
            passed: result.status === 0,
            exitCode: result.status,
            treeSha,
            worktreeStatusBefore,
            worktreeStatusAfter: partial.postCommandStatus,
            ...(result.stoppedLeftovers && {
              stoppedLeftovers: result.stoppedLeftovers,
            }),
          });
      }
      // Past the sandbox's disk budget the command failed, whatever it exited.
      if (result.status !== 0 || overflow) {
        const failed = `Validation command failed (${overflow ? "disk budget" : result.status}): ${check}: `;
        // People read the bounded form; diagnosis reads the complete output.
        const detail = `${failed}${overflow ?? failedOutput(output)}`;
        // The dependency install is the controller's own bootstrap step. When
        // the candidate left every manifest and lockfile as at the accepted
        // base, the same install worked there, so its failure is the
        // environment's: it repeats and charges no repair (#839). A changed
        // manifest or lockfile may be what broke it: the candidate's fault.
        // Over the disk budget, only the verified install, run first with an
        // empty HOME, is: earlier commands could have filled the budget.
        if (
          packageBootstrap(check) !== undefined &&
          (!overflow || install) &&
          !dependencyInputsChanged(worktree, acceptedBaseSha, commit)
        )
          throw new StepFault(transient(detail, false));
        throw new CandidateValidationFailure(
          detail,
          // Its receipt records the exit, which an overflow passed.
          retainFailedValidation && !preparing && !overflow
            ? partial
            : undefined,
          `${failed}${overflow ? `${overflow}\n` : ""}${output}`,
        );
      }
      if (!preparing && contentStore && reviewArtifacts.length) {
        const captured = await captureReviewArtifacts({
          worktree,
          treeSha,
          commandIndex: index,
          command: check,
          stdout,
          stderr,
          ...(originalStreams.stdout.limit !== undefined && {
            stdoutBytes: Buffer.concat(originalStreams.stdout.chunks),
          }),
          ...(originalStreams.stderr.limit !== undefined && {
            stderrBytes: Buffer.concat(originalStreams.stderr.chunks),
          }),
          temporaryRoot,
          selectors: reviewArtifacts,
          contentStore,
        });
        if (captured.length) {
          if (!evidence.reviewArtifacts) evidence.reviewArtifacts = [];
          evidence.reviewArtifacts.push(...captured);
        }
      }
      (preparing ? evidence.preparation! : evidence.commands).push({
        index,
        command: check,
        passed: true,
        exitCode: 0,
        treeSha,
        ...(executionControl && settlement.verified && { executionControl }),
        ...(result.stoppedLeftovers && {
          stoppedLeftovers: result.stoppedLeftovers,
        }),
      });
    }
    for (const member of lfsMembers) {
      assertSelectedLfsPointer(worktree, member);
      assertSelectedLfsBytes(worktree, member);
    }
    if (hasUnresolvedSubprocesses())
      throw new Error(
        "Validation subprocess ownership unresolved; checkout retained",
      );
    if (candidateStatus() !== "unchanged") {
      partial.reason = "worktree-mutation";
      throw new CandidateValidationFailure(
        `Validation command modified the result tree: ${validationMutationDetail(
          hydratedPaths,
          pinnedGitRaw(
            worktree,
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
          ),
        )}`,
        retainFailedValidation ? partial : undefined,
      );
    }
    assertReviewArtifacts(evidence.reviewArtifacts, treeSha, evidence.commands);
    evidence.worktreeObservation = {
      treeSha,
      initialStatus: "clean",
      postHydrationStatus: {
        porcelainSha256: createHash("sha256")
          .update(hydratedStatus)
          .digest("hex"),
        empty: hydratedStatus.length === 0,
      },
      postCommandStatus: "unchanged",
      selectedLfsMembers: selectedLfs.length,
      subprocessOwnership: "settled",
    };
    return evidence;
  } finally {
    if (!hasUnresolvedSubprocesses())
      for (const path of [temporaryRoot, homeRoot, ...installHomes])
        rmSync(path, { recursive: true, force: true });
  }
}

/**
 * Remove the validation worktrees an interrupted run of one Objective left in
 * `objectiveDirectory`. Only that Objective's owner calls this, before any
 * validation. The same trees directly under the state `root` are from a build
 * that kept them there: no controller validates there now, so any run
 * removes them (#823). Then unregister Factory's stale worktrees anywhere
 * under `root`: their directories are gone, so no live run uses them.
 */
export async function sweepValidationWorktrees(
  checkout: string,
  objectiveDirectory: string,
  root: string,
): Promise<void> {
  const owned: string[] = [];
  for (const base of [objectiveDirectory, root]) {
    owned.push(join(base, "final-validation", "worktree"));
    for (const parent of ["validation", "environment-preflight"]) {
      const directory = join(base, parent);
      if (!existsSync(directory)) continue;
      for (const entry of readdirSync(directory))
        owned.push(join(directory, entry, "worktree"));
    }
  }
  for (const worktree of owned)
    if (existsSync(worktree)) await removeWorktree(checkout, worktree);
  await unregisterStaleWorktrees(checkout, root);
}

async function removeValidationWorktree(
  checkout: string,
  worktree: string,
): Promise<void> {
  if (existsSync(worktree)) await removeWorktree(checkout, worktree);
  // A registration whose directory is gone would refuse the next add.
  await unregisterStaleWorktrees(checkout, worktree);
}

/**
 * Unregister only Factory's own stale worktrees: registrations at or under
 * `under` whose directory is gone. `git worktree prune` would also drop the
 * operator's stale registrations elsewhere, so it is never run.
 */
async function unregisterStaleWorktrees(
  checkout: string,
  under: string,
): Promise<void> {
  const roots = [resolve(under)];
  try {
    roots.push(realpathSync(under));
  } catch {
    // The directory is gone; its resolved path is the registration.
  }
  const within = (path: string) =>
    roots.some((root) => {
      const rest = relative(root, path);
      return rest === "" || (!rest.startsWith("..") && !isAbsolute(rest));
    });
  // One hold of the registry lock covers the listing and the removals:
  // another Objective's controller sweeping at the same moment lists only
  // after these entries are gone, so no entry is unregistered twice (#822).
  await withWorktreeRegistry(checkout, async (git) => {
    const listing = await git("worktree", "list", "--porcelain");
    for (const entry of listing.split(/\n\n+/)) {
      const lines = entry.split("\n");
      const path = lines
        .find((line) => line.startsWith("worktree "))
        ?.slice("worktree ".length);
      if (
        path &&
        lines.some(
          (line) => line === "prunable" || line.startsWith("prunable "),
        ) &&
        within(resolve(path))
      )
        await git("worktree", "remove", "--force", path);
    }
  });
}

/** Package managers resolve scripts and lifecycle hooks from the result tree.
 * Pin the selected entrypoint and execution config to the accepted base. */
export const PINNED_PNPM_BOOTSTRAP =
  "pnpm install --frozen-lockfile --ignore-scripts";
const PINNED_NPM_BOOTSTRAP = "npm ci --ignore-scripts";

/** Exact script-disabled root installs; this classification grants no authority. */
export function packageBootstrap(command: string): "npm" | "pnpm" | undefined {
  if (command.trim() === PINNED_NPM_BOOTSTRAP) return "npm";
  if (command.trim() === PINNED_PNPM_BOOTSTRAP) return "pnpm";
  return undefined;
}

export interface PackageScriptAuthority {
  /** Exact stable same-manager pin declared by the pinned Objective. */
  packageManagerUpdate?: string;
  /** Final acceptance must include the declared update. */
  requirePackageManagerUpdate?: boolean;
  /** Commands literally declared by a pinned source, not inferred by the model. */
  sourceDeclared?: readonly string[];
  /** Exact package directories admitted by the pinned Objective. */
  workspacePackageAdditions?: readonly string[];
  /** A plan may authorize creation of an entrypoint it cannot inspect yet. */
  preview?: boolean;
  /** Pin newly established scripts against the exact Work Item predecessor. */
  predecessorSha?: string;
}

/** The commands that run package scripts: the ones validation pins to the accepted base. */
export function packageScriptCommands(commands: readonly string[]): string[] {
  return commands.filter(
    (check) =>
      /\b(?:npm|pnpm)\b/.test(check) &&
      !packageBootstrap(check) &&
      !packageManagerVersionProbe(check),
  );
}

/**
 * A version-only invocation may be followed by a source-declared shell
 * assertion. Every package-manager token must belong to that exact probe;
 * extra options, subcommands or script invocations remain subject to the
 * script gate. This classification supplies no command or executable authority.
 */
export function packageManagerVersionProbe(command: string): boolean {
  if (!/\b(?:npm|pnpm)\b/.test(command)) return false;
  const withoutProbes = command.replace(
    /\b(?:npm|pnpm) --version(?=\s*(?:[;&|)\n]|$))/g,
    "",
  );
  return !/\b(?:npm|pnpm)\b/.test(withoutProbes);
}

/** Names of the package scripts (and their pre/post hooks) validation keeps identical to the base. */
export function fixedPackageScripts(commands: readonly string[]): string[] {
  const names = new Set<string>();
  for (const command of packageScriptCommands(commands)) {
    const invocation = packageScriptInvocation(command);
    if (invocation)
      for (const name of [
        invocation.name,
        `pre${invocation.name}`,
        `post${invocation.name}`,
      ])
        names.add(name);
  }
  return [...names];
}

export function assertPinnedNpmScripts(
  checkout: string,
  acceptedBaseSha: string,
  commit: string,
  commands: string[],
  authority: PackageScriptAuthority = {},
): void {
  assertWorkspacePackageChange(
    checkout,
    acceptedBaseSha,
    commit,
    authority.workspacePackageAdditions,
    authority.predecessorSha,
  );
  // A failed Git read is an absent file unless a package-manager update
  // needs it; a path that is not a regular file always blocks.
  const read = <T>(run: () => T): T | undefined => {
    try {
      return run();
    } catch (error) {
      if (authority.packageManagerUpdate !== undefined) throw error;
      return undefined;
    }
  };
  const fileBytes = (revision: string, path: string): Buffer | undefined => {
    const entry = read(() =>
      pinnedGit(checkout, "ls-tree", revision, "--", path),
    );
    if (!entry) return undefined;
    if (!/^100(?:644|755) blob /.test(entry))
      throw new Error(
        `Package script validation blocked: ${path} is not a regular file`,
      );
    return read(() => pinnedGitRaw(checkout, "show", `${revision}:${path}`));
  };
  const file = (revision: string, path: string): string | undefined =>
    fileBytes(revision, path)?.toString("utf8");
  const original = packageMetadata(checkout, acceptedBaseSha);
  const predecessor =
    authority.predecessorSha && authority.predecessorSha !== acceptedBaseSha
      ? packageMetadata(checkout, authority.predecessorSha)
      : original;
  const after = packageMetadata(checkout, commit);
  if (original || predecessor || authority.packageManagerUpdate !== undefined)
    assertPackageManagerUpdate(
      authority.packageManagerUpdate !== undefined
        ? original?.packageManager
        : (original ?? predecessor)?.packageManager,
      after?.packageManager,
      authority.packageManagerUpdate,
      authority.requirePackageManagerUpdate,
    );
  if (
    authority.packageManagerUpdate !== undefined &&
    predecessor?.packageManager === authority.packageManagerUpdate &&
    after?.packageManager !== authority.packageManagerUpdate
  )
    throw new Error("Package manager update cannot revert a predecessor pin");
  const managerToken = /\b(?:npm|pnpm)\b/;
  const selected = commands.filter((check) => managerToken.test(check));
  if (selected.length || authority.packageManagerUpdate !== undefined)
    for (const key of ["config", "pnpm"])
      if (
        (original ?? predecessor) &&
        !isDeepStrictEqual((original ?? predecessor)?.[key], after?.[key])
      )
        throw new Error(
          `Package script validation blocked: ${key} differs from the accepted base`,
        );
  if (
    authority.packageManagerUpdate !== undefined &&
    file(acceptedBaseSha, "pnpm-workspace.yaml") === undefined &&
    file(commit, "pnpm-workspace.yaml") !== undefined
  )
    throw new Error(
      "Package manager update cannot create workspace security configuration",
    );
  if (authority.packageManagerUpdate !== undefined)
    for (const path of [
      ".npmrc",
      ".pnpmfile.cjs",
      ".pnpmfile.js",
      ".pnpmfile.mjs",
      "package.yaml",
    ])
      if (file(acceptedBaseSha, path) !== file(commit, path))
        throw new Error(
          `Package script validation blocked: ${path} differs from the accepted base; Package manager update grants no configuration or hook changes`,
        );
  const pnpmBootstrap = selected.some(
    (check) => packageBootstrap(check) === "pnpm",
  );
  const npmBootstrap = selected.some(
    (check) => packageBootstrap(check) === "npm",
  );
  const bootstrap = pnpmBootstrap || npmBootstrap;
  if (
    (pnpmBootstrap || authority.packageManagerUpdate !== undefined) &&
    [file(commit, ".npmrc"), file(commit, "pnpm-workspace.yaml")].some(
      (content) => /pnpmfile/i.test(content ?? ""),
    )
  )
    throw new Error(
      "Package script validation blocked: configured pnpmfile hooks need separate authority",
    );
  if (!selected.length) return;
  const declared = new Set(authority.sourceDeclared ?? []);
  if (npmBootstrap) {
    if (!declared.has(PINNED_NPM_BOOTSTRAP))
      throw new Error(
        "Package script validation blocked: npm bootstrap needs exact source-declared command authority",
      );
    if (pnpmBootstrap || selected.some((command) => /\bpnpm\b/.test(command)))
      throw new Error(
        "Package script validation blocked: npm bootstrap cannot mix package managers",
      );
    if (
      !original ||
      original.workspaces !== undefined ||
      (original.packageManager !== undefined &&
        !String(original.packageManager).startsWith("npm@")) ||
      authority.packageManagerUpdate !== undefined
    )
      throw new Error(
        "Package script validation blocked: npm bootstrap requires an existing root npm package without workspaces or a manager update",
      );
    for (const path of ["package.json", "package-lock.json"]) {
      const before = fileBytes(acceptedBaseSha, path);
      const after = fileBytes(commit, path);
      if (!before?.length || !after || !before.equals(after))
        throw new Error(
          `Package script validation blocked: npm bootstrap needs unchanged tracked ${path} from the accepted base`,
        );
    }
    let lock: unknown;
    try {
      lock = JSON.parse(file(acceptedBaseSha, "package-lock.json")!);
    } catch {
      throw new Error(
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
      throw new Error(
        "Package script validation blocked: npm bootstrap needs a supported package-lock.json",
      );
    for (const revision of [acceptedBaseSha, commit])
      if (file(revision, "npm-shrinkwrap.json") !== undefined)
        throw new Error(
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
    throw new Error(
      "Package script validation blocked: script-disabled bootstrap must run first",
    );
  const scriptCommands = packageScriptCommands(commands);
  const requests = scriptCommands.map(packageScriptInvocation);
  if (requests.some((request) => !request))
    throw new Error(
      "Package script validation blocked: only root npm/pnpm test, pnpm check, or npm/pnpm run NAME can be pinned",
    );

  if (
    !original &&
    selected.some(
      (command) =>
        !packageManagerVersionProbe(command) && !declared.has(command),
    )
  )
    throw new Error(
      "Package script validation blocked: a new package.json needs exact source-declared command authority",
    );
  if (
    !after &&
    !authority.preview &&
    (original || bootstrap || scriptCommands.length)
  )
    throw new Error(
      "Package script validation blocked: package.json is absent from the result tree",
    );
  const scripts = (pkg: Record<string, unknown>): Record<string, unknown> => {
    const value = pkg.scripts;
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error(
        "Package script validation blocked: scripts are unavailable",
      );
    return value as Record<string, unknown>;
  };
  const originalScripts =
    requests.length && original?.scripts ? scripts(original) : {};
  const predecessorScripts =
    requests.length && predecessor?.scripts ? scripts(predecessor) : {};
  const afterScripts = requests.length && after?.scripts ? scripts(after) : {};
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
      throw new Error(
        `Package script validation blocked: new script ${name} needs exact source-declared command authority`,
      );
    if (
      (typeof body === "string" && afterScripts[name] !== body) ||
      (!authority.preview && typeof afterScripts[name] !== "string")
    )
      throw new Error(
        `Package script validation blocked: script ${name} differs from the accepted base`,
      );
    for (const scriptName of [name, `pre${name}`, `post${name}`]) {
      if (
        scriptName !== name &&
        typeof body !== "string" &&
        afterScripts[scriptName] !== undefined
      )
        throw new Error(
          `Package script validation blocked: new script ${name} cannot add lifecycle hook ${scriptName}`,
        );
      if (
        scriptName !== name &&
        beforeScripts[scriptName] !== afterScripts[scriptName]
      )
        throw new Error(
          `Package script validation blocked: lifecycle hook ${scriptName} differs from the accepted base`,
        );
      const scriptBody = afterScripts[scriptName] ?? beforeScripts[scriptName];
      if (typeof scriptBody !== "string") continue;
      if (/\b(?:npm|pnpm)\b/.test(scriptBody))
        throw new Error(
          `Package script validation blocked: nested package-manager invocation in ${scriptName} needs separate authority`,
        );
    }
  }
  if (
    usesPnpm &&
    (file(acceptedBaseSha, "package.yaml") !== undefined ||
      file(commit, "package.yaml") !== undefined)
  )
    throw new Error(
      "Package script validation blocked: pnpm package.yaml manifests are not supported",
    );
  if (pnpmBootstrap) {
    if (
      (!file(acceptedBaseSha, "pnpm-lock.yaml") &&
        !declared.has(PINNED_PNPM_BOOTSTRAP)) ||
      (!file(commit, "pnpm-lock.yaml") && !authority.preview)
    )
      throw new Error(
        "Package script validation blocked: frozen pnpm bootstrap needs a tracked lockfile",
      );
    for (const path of [".pnpmfile.cjs", ".pnpmfile.js", ".pnpmfile.mjs"])
      if (
        file(acceptedBaseSha, path) !== undefined ||
        file(commit, path) !== undefined
      )
        throw new Error(
          "Package script validation blocked: pnpmfile hooks need separate authority",
        );
  }
  for (const path of [".npmrc", ...(usesPnpm ? ["pnpm-workspace.yaml"] : [])]) {
    const original = file(acceptedBaseSha, path);
    const predecessor = file(authority.predecessorSha ?? acceptedBaseSha, path);
    if (
      (original ?? predecessor) !== file(commit, path) &&
      !(
        path === "pnpm-workspace.yaml" &&
        original === undefined &&
        predecessor === undefined &&
        selected.every((command) => declared.has(command))
      ) &&
      !(
        path === "pnpm-workspace.yaml" &&
        authority.workspacePackageAdditions?.length
      )
    )
      throw new Error(
        `Package script validation blocked: ${path} differs from the accepted base`,
      );
  }
}

/** Supported root script forms; shell wrappers and package-manager flags are ambiguous. */
export function packageScriptInvocation(
  check: string,
): { manager: "npm" | "pnpm"; name: string } | undefined {
  const match = check
    .trim()
    .match(/^(npm|pnpm) (?:(run) )?([A-Za-z0-9][A-Za-z0-9:_-]*)$/);
  if (!match) return undefined;
  const manager = match[1] as "npm" | "pnpm";
  const name = match[3]!;
  if (manager === "npm" && !match[2] && name !== "test") return undefined;
  if (manager === "pnpm" && !match[2] && !["check", "test"].includes(name))
    return undefined;
  return { manager, name };
}

export async function validateWorkItem(
  checkout: string,
  root: string,
  item: WorkItem,
  commit: string,
  treeSha: string,
  acceptedBaseSha: string,
  observe?: (entry: ValidationObservation) => void,
  observeOutput?: (entry: ValidationOutputObservation) => void,
  predecessorSha?: string,
  lfsMembers: ValidationLfsMember[] = [],
  contentStore?: ContentStore,
  workspacePackageAdditions: readonly string[] = [],
  packageManagerUpdate?: string,
  retainFailedValidation = true,
  reviewArtifacts: readonly ReviewArtifactSelector[] = [],
  sandbox: CommandSandboxPolicy = STRICT_COMMAND_SANDBOX,
): Promise<ValidationEvidence> {
  // Validate every declaration before selection, including unowned producers.
  assertReviewArtifactSelectors(reviewArtifacts);
  const selectedArtifacts = reviewArtifacts.filter(
    (selector) =>
      item.kind !== "work" ||
      !("text" in selector) ||
      ownsPath(selector.text.source, item.ownedPaths),
  );
  assertPinnedNpmScripts(
    checkout,
    acceptedBaseSha,
    commit,
    item.validation.map((v) => v.command),
    {
      sourceDeclared: item.validation
        .filter((v) => v.provenance === "source-declared")
        .map((v) => v.command),
      predecessorSha,
      workspacePackageAdditions,
      packageManagerUpdate,
    },
  );
  const evidence = await validateTree(
    checkout,
    root,
    commit,
    treeSha,
    item.validation.map((v) => v.command),
    observe,
    observeOutput,
    lfsMembers,
    contentStore,
    acceptedBaseSha,
    retainFailedValidation,
    { commands: [] },
    selectedArtifacts,
    undefined,
    // The package inputs were just checked for exactly these commands. The
    // network grant compares them with the accepted base, never a
    // predecessor's unaccepted output (which could name its own registry).
    {
      ...sandbox,
      packageInputsVerified: true,
      packageInputsBase: acceptedBaseSha,
    },
  );
  // Keep the installation selector identity when only this item's producers
  // were selected. QA and final validation still use the complete selection.
  for (const artifact of evidence.reviewArtifacts ?? [])
    artifact.selectorIndex = reviewArtifacts.indexOf(
      selectedArtifacts[artifact.selectorIndex]!,
    );
  return evidence;
}
export {
  objectiveReviewEvidence,
  retainedReviewLiterals,
  validStoppedLeftovers,
  workItemReviewEvidence,
  workItemReviewObservations,
} from "./result-evidence.js";
export { ReviewOutcome, reviewAcceptance } from "./result-review.js";
export {
  AcceptanceDecision,
  assertSelectedLfsValidation,
  assertValidationWorktreeObservation,
  SelectedLfsValidation,
  ValidationEvidence,
} from "./validation-evidence.js";
