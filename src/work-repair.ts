import { randomUUID } from "node:crypto";
import type { DiagnosticEmitter } from "./diagnostics.js";
import { attachFault, faultOf, StepFault, transient } from "./fault.js";
import { type StepClock, StepPaused, clearRepeats, step } from "./step.js";
import type { PlanningModel, WorkItem } from "./contracts.js";
import { blameDecision, cappedDiagnosis } from "./blame-decision.js";
import { graphDigest, recordWorkerDiscovery } from "./graph-amendments.js";
import { ownsPath, validOwnershipPath } from "./ownership.js";
import { pinnedGitRaw } from "./process.js";
import {
  installedControllerCapabilities,
  CONTROLLER_CAPABILITIES_DIGEST,
} from "./controller-capabilities.js";
import type { FactoryState } from "./state.js";
import {
  archiveAttempt,
  chargeRepair,
  consumption,
  failureDigest,
  implementationRepairable,
  itemEvent,
  releaseCharge,
  repairScopes,
  validateCorrection,
  type FailureClass,
  type FailureDisposition,
  type RepairCorrection,
} from "./repair-policy.js";

/** The exact collected candidate exists, but settled local validation failed: a wrong result. */
export class CandidateValidationFailure extends Error {
  constructor(detail: string) {
    super(detail);
    attachFault(this, { kind: "work", evidence: { detail } });
  }
}
/** The controller could not prepare validation; the candidate was never judged. */
export class CandidateEnvironmentFailure extends Error {
  constructor(detail: string) {
    super(detail);
    attachFault(this, {
      kind: "config",
      detail,
      fix: "Restore the controller's validation environment",
    });
  }
}

/** The Work Item whose failure an error carries, set where the failure is recorded. */
const failedItems = new WeakMap<object, string>();
export const failedItemOf = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null
    ? failedItems.get(error)
    : undefined;

const retryCommand = (state: FactoryState, id: string): string =>
  `factory retry --objective ${state.objective} --item ${id}`;

/**
 * Record a failed attempt. Only a contained wrong result (a `work` fault)
 * gets a failure event, so only it is diagnosed and charged. Decisions and
 * config faults normally wait instead (step rule 7); they are recorded here
 * only when a caller ends the attempt on them.
 */
export function recordWorkFailure(
  state: FactoryState,
  id: string,
  error: unknown,
): boolean {
  const work = state.work[id]!;
  if (typeof error === "object" && error !== null) failedItems.set(error, id);
  const detail = error instanceof Error ? error.message : String(error);
  const fault = faultOf(error);
  // A discovery staged beside a wrong result is reviewed like one beside a
  // collected result (#820).
  if (fault.kind === "work" && fault.evidence.discovery && work.attempt)
    recordWorkerDiscovery(state, id, fault.evidence.discovery);
  // A published result that fails (a failed check, a conflict) is repaired
  // by a new attempt that republishes the branch with a lease.
  const isolated =
    !work.integratedSha &&
    !state.coordinator?.cancelError &&
    fault.kind === "work";
  const event = isolated
    ? itemEvent(id, work.step ?? "execute", work.recovery?.history?.length ?? 0)
    : undefined;
  const retry = `\`${retryCommand(state, id)}\``;
  const classification: FailureClass = event
    ? "implementation"
    : fault.kind === "work"
      ? "decision"
      : fault.kind;
  // `factory repair` is named only while it would be accepted.
  const repairable =
    event !== undefined &&
    implementationRepairable(state, event, repairScopes(state, id));
  const decisions: Record<FailureClass, string> = {
    implementation: repairable
      ? `Supply a concrete diagnosis and correction (\`factory repair --objective ${state.objective} --proposal FILE\`), enable implementation repair in the configured autonomy, or start a new attempt with ${retry}`
      : `Implementation repair is not available (its allowance is used up or the class is not enabled); start a new attempt with ${retry}`,
    "planning-output": detail,
    "planning-evidence": detail,
    "planning-choice": detail,
    decision:
      fault.kind === "decision"
        ? `${fault.question} Answer with ${retry}, or cancel`
        : `The result failed after it was integrated or while the Objective was cancelling; inspect it, then ${retry} or cancel`,
    config: `${fault.kind === "config" ? fault.fix : detail}; then ${retry}`,
    transient: `Interrupted outside a repeatable step; check the provider, network or GitHub status, then ${retry}`,
    defect: `Factory hit a defect; report it (evidence: \`factory diagnostics --objective ${state.objective} --logs ${id}\`), then start a new attempt with ${retry}`,
    cancelled: "Cancelled by the operator",
  };
  const failure: FailureDisposition = {
    digest: failureDigest(detail),
    ...(event && { event }),
    detail,
    at: new Date().toISOString(),
    classification,
    continuation: isolated
      ? "new-attempt-from-accepted-base"
      : "operator-decision",
    // A work fault at execute ends the attempt only after the driver
    // disposed of the worker's workspace (attempt.ts endAttempt).
    unfinishedEdits:
      fault.kind === "work" && (work.step ?? "execute") === "execute"
        ? "removed"
        : "unavailable",
    decision: decisions[classification],
  };
  // A new failure starts a fresh record: an earlier correction belongs to
  // the attempt it corrected, which the history keeps.
  work.recovery = {
    scopes: repairScopes(state, id),
    ...(work.recovery?.history && { history: work.recovery.history }),
    failure,
    phase: "stopped",
  };
  return isolated;
}
export function applyWorkCorrection(
  state: FactoryState,
  id: string,
  correction: RepairCorrection,
): void {
  const work = state.work[id];
  if (
    !work ||
    work.integratedSha ||
    state.cancelRequested ||
    state.cancelledAt ||
    state.coordinator?.cancelError ||
    state.coordinator?.processes?.length
  )
    throw new Error(
      "Repair cannot cross an unsettled, integrated or cancelled boundary",
    );
  validateCorrection(work, correction);
  if (correction.kind !== "implementation")
    throw new Error(
      "Only an implementation correction is supported: a diagnosed new attempt",
    );
  // Only a wrong result is corrected; anything else is retried or answered.
  if (work.recovery!.failure!.classification !== "implementation")
    throw new Error(
      `Only a wrong result can be repaired; use \`${retryCommand(state, id)}\``,
    );

  // The correction is bound to the event of the failure it corrects, and
  // archived with that failure and the attempt it ended.
  const { event: _unbound, ...admitted } = correction;
  const event = work.recovery?.failure?.event;
  const bound = { ...admitted, ...(event && { event }) };
  const recovery = archiveAttempt({
    ...work,
    recovery: { ...work.recovery, correction: bound },
  });
  recovery.correction = bound;
  recovery.phase = "ready";
  // A wrong result at delivery (the remote refused its content) published
  // nothing; any other failure there may have.
  if (
    work.status !== "failed" ||
    (work.step === "deliver" && !work.recovery?.failure?.event)
  )
    throw new Error(
      "Implementation repair needs an unpublished failed attempt",
    );
  chargeRepair(
    state,
    work.recovery!.failure!.event,
    correction.kind,
    repairScopes(state, id),
  );
  // The new attempt starts without the old one's step records, as a retry
  // does: a stale diagnose record would stop its failure unasked.
  clearRepeats(state, { item: id });
  state.work[id] = { status: "pending", recovery };
}
const diagnosisSchema = {
  type: "object",
  additionalProperties: false,
  required: ["diagnosis", "correction", "decision", "predecessor", "path"],
  properties: {
    diagnosis: { type: "string" },
    correction: { type: "string" },
    decision: { type: "string", enum: ["repair", "operator", "predecessor"] },
    // With "predecessor": the merged predecessor Work Item that owns the
    // faulty file, and that file's path. Empty otherwise.
    predecessor: { type: "string" },
    path: { type: "string" },
  },
};

type Blame = Omit<
  NonNullable<FailureDisposition["predecessor"]>,
  "diagnosis" | "graphDigest"
>;

/** Work Items this one depends on, directly or not, that are merged. */
function mergedPredecessors(
  state: FactoryState,
  item: WorkItem,
): { item: WorkItem; pullRequest?: number }[] {
  const found = new Map<string, WorkItem>();
  const visit = (current: WorkItem): void => {
    for (const id of current.dependencies) {
      const dependency = state.graph.items.find((entry) => entry.id === id);
      if (!dependency || found.has(id)) continue;
      found.set(id, dependency);
      visit(dependency);
    }
  };
  visit(item);
  return [...found.values()].flatMap((dependency) => {
    const work = state.work[dependency.id];
    return work?.status === "done" && work.integratedSha
      ? [
          {
            item: dependency,
            ...(work.pullRequest && { pullRequest: work.pullRequest }),
          },
        ]
      : [];
  });
}

/**
 * The merged predecessor that last took over `path`. A new item that takes a
 * done item's file depends on it, so the latest owner is the one no other
 * owner of the path is built on; among independent owners, the one added last.
 */
function latestOwner(
  state: FactoryState,
  predecessors: { item: WorkItem; pullRequest?: number }[],
  path: string,
): { item: WorkItem; pullRequest?: number } | undefined {
  const owners = predecessors.filter((entry) =>
    ownsPath(path, entry.item.ownedPaths),
  );
  const builtOn = new Set<string>();
  for (const owner of owners)
    for (const other of mergedPredecessors(state, owner.item))
      builtOn.add(other.item.id);
  const order = (entry: { item: WorkItem }) =>
    state.graph.items.findIndex((candidate) => candidate.id === entry.item.id);
  return owners
    .filter((entry) => !builtOn.has(entry.item.id))
    .sort((a, b) => order(a) - order(b))
    .at(-1);
}

/** The regular files of a result tree: path, with the blob size, from `git ls-tree -l`. */
function treeFiles(
  checkout: string,
  treeSha: string,
  ...paths: string[]
): { path: string; size: number }[] {
  const listing = pinnedGitRaw(
    checkout,
    "ls-tree",
    "-l",
    "-z",
    ...(paths.length ? [] : ["-r"]),
    treeSha,
    ...(paths.length ? ["--", ...paths] : []),
  ).toString("utf8");
  return listing.split("\0").flatMap((line) => {
    // <mode> <type> <object> <size>\t<path>; only a blob that is not a
    // link (100644, 100755) is a regular file.
    const match = /^(\d+) (\w+) [0-9a-f]+ +(\d+)\t(.*)$/s.exec(line);
    return match?.[1]?.startsWith("100") && match[2] === "blob"
      ? [{ path: match[4]!, size: Number(match[3]) }]
      : [];
  });
}

/**
 * The failure is a merged predecessor's when the file the diagnosis names is
 * owned by that predecessor and not by the failing item, and is a regular file
 * of the failed result. Ownership comes from the accepted graph and the file
 * from the result tree, so the answer is checked as structure, never as prose.
 */
function blamedPredecessor(
  state: FactoryState,
  item: WorkItem,
  answer: { predecessor?: string; path?: string },
  checkout: string | undefined,
): Blame {
  const path = answer.path?.trim() ?? "";
  const predecessors = mergedPredecessors(state, item);
  const named = predecessors.find(
    (entry) => entry.item.id === answer.predecessor,
  );
  // A file a later item took over is that item's now: it is the one to build
  // on, even when the answer names the earlier owner.
  const owner =
    named && ownsPath(path, named.item.ownedPaths)
      ? (latestOwner(state, predecessors, path) ?? named)
      : named;
  if (!owner)
    throw new Error(
      `${answer.predecessor || "(none)"} is not a merged predecessor of ${item.id}`,
    );
  if (!path || path.endsWith("/") || !validOwnershipPath(path))
    throw new Error(`${path || "(none)"} is not a file path`);
  if (!ownsPath(path, owner.item.ownedPaths))
    throw new Error(`${path} is not owned by ${owner.item.id}`);
  if (ownsPath(path, item.ownedPaths))
    throw new Error(`${path} is owned by ${item.id} itself`);
  const treeSha = state.work[item.id]?.treeSha;
  if (!checkout || !treeSha)
    throw new Error(`${item.id} has no result tree to hold ${path}`);
  let present: boolean;
  try {
    present = treeFiles(checkout, treeSha, path).some(
      (file) => file.path === path,
    );
  } catch (error) {
    throw new Error(
      `${path} cannot be read from the result of ${item.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!present)
    throw new Error(
      `${path} is not a regular file in the result of ${item.id}`,
    );
  return {
    item: owner.item.id,
    path,
    ...(owner.pullRequest && { pullRequest: owner.pullRequest }),
  };
}

const EVIDENCE_FILE_BYTES = 16_000;
const EVIDENCE_TOTAL_BYTES = 64_000;
/** A larger blob is not read at all: it is not source a diagnosis can use. */
const EVIDENCE_READ_BYTES = 1_000_000;
/**
 * The files of the failed result that it and its merged predecessors own, as
 * text: what a diagnosis needs to tell whose file is wrong. They are read from
 * the result tree, which holds the integrated predecessors' files. The failing
 * item's own files come first, so the budget never goes to a predecessor
 * before them.
 */
function diagnosisFiles(
  state: FactoryState,
  item: WorkItem,
  checkout: string | undefined,
): { path: string; heading: string; content: string }[] {
  const treeSha = state.work[item.id]?.treeSha;
  if (!checkout || !treeSha) return [];
  const predecessors = mergedPredecessors(state, item);
  const files: { path: string; heading: string; content: string }[] = [];
  let total = 0;
  try {
    const listed = treeFiles(checkout, treeSha);
    // The failing item's files first, so the budget never goes to a
    // predecessor before them.
    const rank = (path: string): number =>
      ownsPath(path, item.ownedPaths) ? 0 : 1;
    const owned = listed
      .map((file) => ({
        ...file,
        owner: ownsPath(file.path, item.ownedPaths)
          ? undefined
          : latestOwner(state, predecessors, file.path),
      }))
      .filter((file) => rank(file.path) === 0 || file.owner)
      .sort((a, b) => rank(a.path) - rank(b.path));
    for (const { path, size, owner } of owned) {
      // The budget is spent: nothing more is read.
      if (total >= EVIDENCE_TOTAL_BYTES) break;
      // Check the size before reading the blob. A character takes at most
      // three bytes, so this bounds what is read from below.
      if (
        size > EVIDENCE_READ_BYTES ||
        total + Math.min(Math.ceil(size / 3), EVIDENCE_FILE_BYTES) >
          EVIDENCE_TOTAL_BYTES
      )
        continue;
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(
          pinnedGitRaw(checkout, "show", `${treeSha}:${path}`),
        );
      } catch {
        continue;
      }
      if (content.length > EVIDENCE_FILE_BYTES)
        content = `${content.slice(0, EVIDENCE_FILE_BYTES)}\n[truncated]`;
      // One file too large for what is left does not hide the smaller
      // ones after it.
      if (total + content.length > EVIDENCE_TOTAL_BYTES) continue;
      total += content.length;
      files.push({
        path,
        heading: owner
          ? `owned by ${owner.item.id} (merged)`
          : `owned by ${item.id} (the failing item)`,
        content,
      });
    }
  } catch {
    // Evidence is best effort: the diagnosis still runs on the failure record.
  }
  return files;
}

export async function diagnoseWorkRepair(args: {
  state: FactoryState;
  item: WorkItem;
  model: PlanningModel;
  save: () => void;
  stopped: () => boolean;
  diagnostics?: DiagnosticEmitter;
  sources?: { path: string; content: string; heading?: string }[];
  /** The target checkout: the failed result's files are read from it. */
  checkout?: string;
  /** The run's cancel signal: ends the diagnose step's wait or try. */
  signal?: AbortSignal;
  /** The run's pause signal: ends the diagnose step's wait; it resumes later. */
  pause?: AbortSignal;
  /** Backoff time for the diagnose step; tests inject one. */
  clock?: StepClock;
}): Promise<boolean> {
  const { state, item, save } = args;
  const work = state.work[item.id]!;
  const failure = work.recovery?.failure;
  // Only a wrong result has a failure event; anything else is repeated or
  // fixed, never diagnosed against an allowance. A cancelled run diagnoses
  // nothing.
  if (!failure?.event || work.status !== "failed" || args.signal?.aborted)
    return false;
  const retry = retryCommand(state, item.id);
  if (work.recovery?.phase === "ready" && work.recovery.correction) {
    // The next pass applies a ready correction once the run goes on.
    if (args.stopped()) return false;
    applyWorkCorrection(state, item.id, work.recovery.correction);
    save();
    return true;
  }
  const stop = (decision: string): false => {
    work.recovery!.phase = "stopped";
    failure.decision = decision;
    save();
    return false;
  };
  // The charge is keyed by the failure event, so a diagnosis repeated after
  // a restart or a lost response is not charged again.
  try {
    chargeRepair(
      state,
      failure.event,
      "implementation",
      repairScopes(state, item.id),
    );
  } catch (error) {
    return stop(
      `${error instanceof Error ? error.message : String(error)}; start a new attempt with \`${retry}\``,
    );
  }
  work.recovery!.phase = "diagnosing";
  save();
  // Paused, or an amendment pending: the diagnosis is due, not dropped. The
  // phase is "diagnosing", so resumeDiagnoses asks it once the run goes on
  // (pause is not cancel; its event is already charged).
  if (args.stopped()) return false;
  // A paid step: a lost answer is asked again, an invalid one again with
  // its validation error, until the paid bound makes it a decision.
  const predecessors = mergedPredecessors(state, item);
  const files = diagnosisFiles(state, item, args.checkout);
  let answer: RepairCorrection | string | { blame: Blame; diagnosis: string };
  try {
    answer = await step(
      state,
      { scope: { item: item.id }, name: "diagnose", paid: true },
      (context) => {
        // The last answer's error, kept in the step's record across a restart.
        const rejected = context.previousInvalid();
        return context.paid(async () => {
          const response = await args.model.generateStructured<{
            diagnosis: string;
            correction: string;
            decision: string;
            predecessor?: string;
            path?: string;
          }>({
            purpose: "diagnosis",
            objective: `Diagnose this failed Work Item using its original evidence. Return a concrete correction within the unchanged acceptance, ownership, commands and configured authority. Do not propose weaker validation, provider changes, new permissions or repeating an unchanged failure. If the failure comes from a file this item does not own but a merged predecessor does (see predecessors, and the files under "owned by"), return predecessor with that predecessor's id and the file's path: the item cannot fix it. If evidence cannot establish a correction, return operator. Prior unfinished edits are unavailable; a repair starts from the accepted base.${rejected ? `\nYour previous answer was rejected: ${rejected}. Answer again.` : ""}\n${JSON.stringify({ item, failure, predecessors: predecessors.map((entry) => ({ id: entry.item.id, pullRequest: entry.pullRequest, ownedPaths: entry.item.ownedPaths })), prior: work.recovery?.history?.map((entry) => ({ failure: entry.failure, correction: entry.correction })), treeSha: work.treeSha, changeRef: work.changeRef })}`,
            baseSha: work.executionBaseSha ?? state.baseSha,
            sources: [...(args.sources ?? []), ...files],
            controllerCapabilities: installedControllerCapabilities(),
            controllerCapabilitiesDigest: CONTROLLER_CAPABILITIES_DIGEST,
            schema: diagnosisSchema,
            invocation: {
              invocationId: randomUUID(),
              phase: "diagnosis",
              ordinal: consumption(state).implementationRepairs,
              observe: args.diagnostics?.modelObserver({
                scopeId: work.attempt!,
                runId: state.runId,
                itemId: item.id,
                attemptId: work.attempt,
              }),
            },
          });
          if (response.decision === "predecessor") {
            try {
              return {
                blame: blamedPredecessor(state, item, response, args.checkout),
                diagnosis: response.diagnosis,
              };
            } catch (error) {
              const detail =
                error instanceof Error ? error.message : String(error);
              context.invalid(detail);
              throw new StepFault(
                transient(`Diagnosis was invalid: ${detail}`, true),
              );
            }
          }
          if (response.decision !== "repair")
            return (
              response.diagnosis || "Failure requires an operator decision"
            );
          const proposed: RepairCorrection = {
            kind: "implementation",
            failureDigest: failure.digest,
            event: failure.event,
            diagnosis: response.diagnosis,
            correction: response.correction,
            actor: "factory-controller",
          };
          try {
            validateCorrection(work, proposed);
          } catch (error) {
            const detail =
              error instanceof Error ? error.message : String(error);
            context.invalid(detail);
            throw new StepFault(
              transient(`Diagnosis was invalid: ${detail}`, true),
            );
          }
          return proposed;
        });
      },
      {
        save,
        ...(args.signal && { signal: args.signal }),
        ...(args.pause && { pause: args.pause }),
        ...(args.clock && { clock: args.clock }),
      },
    );
  } catch (error) {
    // Paused or cancelled: stop quietly. The phase stays "diagnosing", so
    // the next run asks again (its event is already charged).
    if (error instanceof StepPaused) return false;
    // A decision (the paid bound, a refusal) stops the diagnosis for the
    // operator; a configuration fix leaves it due (step rule 7): the step
    // waits, and the next run asks again under the event already charged.
    // Anything else is a defect.
    const fault = faultOf(error);
    if (fault.kind === "cancelled") return false;
    if (fault.kind === "decision")
      return stop(
        `${fault.question} Supply a correction (\`factory repair --objective ${state.objective} --proposal FILE\`) or start a new attempt with \`${retry}\``,
      );
    if (fault.kind === "config") {
      failure.decision = `${fault.fix}; then \`factory run --objective ${state.objective}\` asks the diagnosis again`;
      save();
      return false;
    }
    throw error;
  }
  if (typeof answer === "string") return stop(answer);
  if ("blame" in answer) {
    // The defect is in a merged predecessor: no repair of this item can pass,
    // so none is spent. The allowance the diagnosis took is given back and
    // the failure becomes a decision about the predecessor.
    const { blame, diagnosis } = answer;
    releaseCharge(state, failure.event);
    delete failure.event;
    failure.classification = "decision";
    failure.continuation = "operator-decision";
    failure.predecessor = {
      ...blame,
      diagnosis: cappedDiagnosis(diagnosis),
      graphDigest: graphDigest(state.graph),
    };
    return stop(
      blameDecision(state, item.id, failure.predecessor.graphDigest)!,
    );
  }
  const correction = answer;
  work.recovery!.correction = correction;
  work.recovery!.phase = "ready";
  save();
  if (args.stopped()) return false;
  applyWorkCorrection(state, item.id, correction);
  save();
  return true;
}

/**
 * Ask again any diagnosis a restart left under way.
 * Its event is already charged, so asking again is free.
 */
export async function resumeDiagnoses(
  args: Omit<Parameters<typeof diagnoseWorkRepair>[0], "item">,
): Promise<void> {
  for (const item of args.state.graph.items) {
    const work = args.state.work[item.id];
    if (work?.status === "failed" && work.recovery?.phase === "diagnosing")
      await diagnoseWorkRepair({ ...args, item });
  }
}
