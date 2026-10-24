import { createHash } from "node:crypto";
import { graphDigest } from "./graph-amendments.js";
import { ownsPath, validOwnershipPath } from "./ownership.js";
import { itemEvent, type FailureDisposition } from "./repair-policy.js";
import type { FactoryState, WorkState } from "./state.js";
import { refuseUnknownFields } from "./unknown-fields.js";

/** Actual command outcomes from unsuccessful validation, never acceptance receipts. */
export interface FailedValidationEvidence {
  commitSha: string;
  treeSha: string;
  declaredCommands: string[];
  commands: {
    index: number;
    command: string;
    passed: boolean;
    /** Null means the settled child ended without an observed exit code. */
    exitCode: number | null;
    treeSha: string;
    worktreeStatusBefore: "unchanged" | "modified";
    worktreeStatusAfter: "unchanged" | "modified";
    stoppedLeftovers?: number;
  }[];
  reason: "command" | "worktree-mutation";
  initialStatus: "clean";
  postHydrationStatus: { porcelainSha256: string; empty: boolean };
  postCommandStatus: "unchanged" | "modified";
  selectedLfsMembers: number;
  /** Porcelain equality alone does not authenticate hydrated selected bytes. */
  selectedLfsContentBinding: "unavailable" | "not-applicable";
  subprocessOwnership: "settled";
}

/** Controller context captured before the failed attempt is archived. */
export interface FailedValidationRecord {
  repository: string;
  objective: number;
  runId: string;
  configDigest: string;
  itemId: string;
  attemptId: string;
  acceptedBaseSha: string;
  executionBaseSha: string;
  resultBaseSha: string;
  graphRevisionDigest: string;
  failureDigest: string;
  failureEvent?: string;
  evidence: FailedValidationEvidence;
}

/** The original failure binds the complete capture, independently of its prose digest. */
export const failedValidationDigest = (record: FailedValidationRecord) =>
  createHash("sha256").update(JSON.stringify(record)).digest("hex");

function object(value: unknown, keys: string[], label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} is invalid`);
  const record = value as Record<string, unknown>;
  refuseUnknownFields(record, keys, label);
  return record;
}
const sha = (value: unknown, length = 40) =>
  typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
const status = (value: unknown) =>
  value === "unchanged" || value === "modified";

export function assertFailedValidationEvidence(
  value: unknown,
): asserts value is FailedValidationEvidence {
  const evidence = object(
    value,
    [
      "commitSha",
      "treeSha",
      "declaredCommands",
      "commands",
      "reason",
      "initialStatus",
      "postHydrationStatus",
      "postCommandStatus",
      "selectedLfsMembers",
      "selectedLfsContentBinding",
      "subprocessOwnership",
    ],
    "Failed validation evidence",
  );
  const baseline = object(
    evidence.postHydrationStatus,
    ["porcelainSha256", "empty"],
    "Failed validation baseline",
  );
  if (
    !sha(evidence.commitSha) ||
    !sha(evidence.treeSha) ||
    !Array.isArray(evidence.declaredCommands) ||
    !evidence.declaredCommands.length ||
    evidence.declaredCommands.some(
      (command) => typeof command !== "string" || !command.trim(),
    ) ||
    !Array.isArray(evidence.commands) ||
    !evidence.commands.length ||
    evidence.commands.length > evidence.declaredCommands.length ||
    !["command", "worktree-mutation"].includes(String(evidence.reason)) ||
    evidence.initialStatus !== "clean" ||
    !sha(baseline.porcelainSha256, 64) ||
    typeof baseline.empty !== "boolean" ||
    baseline.empty !==
      (baseline.porcelainSha256 ===
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855") ||
    !status(evidence.postCommandStatus) ||
    !Number.isSafeInteger(evidence.selectedLfsMembers) ||
    Number(evidence.selectedLfsMembers) < 0 ||
    (!baseline.empty && !evidence.selectedLfsMembers) ||
    evidence.selectedLfsContentBinding !==
      (evidence.selectedLfsMembers ? "unavailable" : "not-applicable") ||
    evidence.subprocessOwnership !== "settled"
  )
    throw new Error("Failed validation evidence is incomplete or inconsistent");
  let previousStatus: unknown = "unchanged";
  for (const [index, raw] of evidence.commands.entries()) {
    const receipt = object(
      raw,
      [
        "index",
        "command",
        "passed",
        "exitCode",
        "treeSha",
        "worktreeStatusBefore",
        "worktreeStatusAfter",
        "stoppedLeftovers",
      ],
      "Failed validation command",
    );
    const failed =
      evidence.reason === "command" && index === evidence.commands.length - 1;
    if (
      receipt.index !== index ||
      receipt.command !== evidence.declaredCommands[index] ||
      receipt.treeSha !== evidence.treeSha ||
      (receipt.exitCode !== null &&
        (!Number.isSafeInteger(receipt.exitCode) ||
          Number(receipt.exitCode) < 0 ||
          Number(receipt.exitCode) > 255)) ||
      receipt.passed !== (receipt.exitCode === 0) ||
      receipt.passed === failed ||
      receipt.worktreeStatusBefore !== previousStatus ||
      !status(receipt.worktreeStatusAfter) ||
      (receipt.stoppedLeftovers !== undefined &&
        (!Number.isSafeInteger(receipt.stoppedLeftovers) ||
          Number(receipt.stoppedLeftovers) <= 0))
    )
      throw new Error(
        "Failed validation command differs from its actual order, outcome or candidate",
      );
    previousStatus = receipt.worktreeStatusAfter;
  }
  if (
    previousStatus !== evidence.postCommandStatus ||
    (evidence.reason === "worktree-mutation" &&
      (evidence.commands.length !== evidence.declaredCommands.length ||
        evidence.postCommandStatus !== "modified"))
  )
    throw new Error("Failed validation stop differs from its command outcomes");
}

/** Authenticate supplied captures against the original attempt and its accepted graph. */
export function assertFailedValidationRecord(
  value: unknown,
  state: FactoryState,
  itemId: string,
  work: Omit<WorkState, "recovery">,
  failure?: FailureDisposition,
): asserts value is FailedValidationRecord | undefined {
  if (value === undefined) {
    if (failure?.validationCaptureDigest !== undefined)
      throw new Error(
        `Work Item ${itemId} lost its retained failed validation capture`,
      );
    return;
  }
  const record = object(
    value,
    [
      "repository",
      "objective",
      "runId",
      "configDigest",
      "itemId",
      "attemptId",
      "acceptedBaseSha",
      "executionBaseSha",
      "resultBaseSha",
      "graphRevisionDigest",
      "failureDigest",
      "failureEvent",
      "evidence",
    ],
    "Failed validation record",
  );
  assertFailedValidationEvidence(record.evidence);
  const evidence = record.evidence;
  const revision =
    state.graphRevisions?.find(
      (entry) => entry.digest === record.graphRevisionDigest,
    )?.graph ??
    (graphDigest(state.graph) === record.graphRevisionDigest
      ? state.graph
      : undefined);
  const item = revision?.items.find((entry) => entry.id === itemId);
  const history = state.work[itemId]?.recovery?.history ?? [];
  const retainedIndexes = history.flatMap((prior, index) =>
    prior.work.attempt === work.attempt &&
    prior.failure?.validationCaptureDigest === failure?.validationCaptureDigest
      ? [index]
      : [],
  );
  if (retainedIndexes.length > 1)
    throw new Error(
      `Work Item ${itemId} failed validation has ambiguous retained attempts`,
    );
  const retainedIndex = retainedIndexes[0] ?? -1;
  const originalEvent = itemEvent(
    itemId,
    "validate",
    retainedIndex < 0 ? history.length : retainedIndex,
  );
  // A checked predecessor blame releases the charge and removes the active
  // event. The immutable capture still names the original failed attempt.
  const predecessor = failure?.predecessor;
  // Diagnosis can be deferred across an accepted amendment. Its decision
  // graph is independent of the capture's original immutable command map.
  const decisionGraph =
    state.graphRevisions?.find(
      (entry) => entry.digest === predecessor?.graphDigest,
    )?.graph ??
    (graphDigest(state.graph) === predecessor?.graphDigest
      ? state.graph
      : undefined);
  const dependencies = new Set<string>();
  const visit = (id: string): void => {
    for (const dependency of decisionGraph?.items.find(
      (entry) => entry.id === id,
    )?.dependencies ?? []) {
      if (dependencies.has(dependency)) continue;
      dependencies.add(dependency);
      visit(dependency);
    }
  };
  visit(itemId);
  const decisionItem = decisionGraph?.items.find(
    (entry) => entry.id === itemId,
  );
  const owner = decisionGraph?.items.find(
    (entry) => entry.id === predecessor?.item,
  );
  const ownerWork = owner && state.work[owner.id];
  const predecessorDecision =
    failure?.event === undefined &&
    failure?.classification === "decision" &&
    failure?.continuation === "operator-decision" &&
    predecessor !== undefined &&
    decisionGraph &&
    graphDigest(decisionGraph) === predecessor.graphDigest &&
    owner &&
    ownerWork?.status === "done" &&
    sha(ownerWork.integratedSha) &&
    predecessor.pullRequest === ownerWork.pullRequest &&
    dependencies.has(owner.id) &&
    validOwnershipPath(predecessor.path) &&
    !predecessor.path.endsWith("/") &&
    ownsPath(predecessor.path, owner.ownedPaths) &&
    decisionItem &&
    !ownsPath(predecessor.path, decisionItem.ownedPaths);
  if (
    record.repository !== state.repository ||
    record.objective !== state.objective ||
    record.runId !== state.runId ||
    !record.runId ||
    record.configDigest !== state.configDigest ||
    !sha(record.configDigest, 64) ||
    record.itemId !== itemId ||
    record.attemptId !== work.attempt ||
    !record.attemptId ||
    record.acceptedBaseSha !== state.baseSha ||
    !sha(record.acceptedBaseSha) ||
    record.executionBaseSha !== work.executionBaseSha ||
    !sha(record.executionBaseSha) ||
    record.resultBaseSha !== work.baseSha ||
    !sha(record.resultBaseSha) ||
    !sha(record.graphRevisionDigest, 64) ||
    (work.graphRevisionDigest !== undefined &&
      record.graphRevisionDigest !== work.graphRevisionDigest) ||
    record.failureDigest !== failure?.digest ||
    !sha(record.failureDigest, 64) ||
    (record.failureEvent !== undefined &&
      record.failureEvent !== originalEvent) ||
    (predecessor !== undefined &&
      (record.failureEvent !== originalEvent || !predecessorDecision)) ||
    (record.failureEvent !== failure?.event && !predecessorDecision) ||
    !sha(failure?.validationCaptureDigest, 64) ||
    failure?.validationCaptureDigest !==
      failedValidationDigest(value as FailedValidationRecord) ||
    !failure ||
    work.step !== "validate" ||
    evidence.commitSha !== work.changeRef ||
    evidence.treeSha !== work.treeSha ||
    !item ||
    !revision ||
    graphDigest(revision) !== record.graphRevisionDigest ||
    JSON.stringify(evidence.declaredCommands) !==
      JSON.stringify(item.validation.map((check) => check.command))
  )
    throw new Error(
      `Work Item ${itemId} failed validation is not bound to its retained controller context`,
    );
}
