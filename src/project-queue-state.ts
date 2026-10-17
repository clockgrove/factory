import { splitSettled } from "./objective-split.js";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readlinkSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type FactoryConfig,
  factoryConfigDigest,
  factoryAuthorityDigest,
  stateRoot,
} from "./config.js";
import { LocalContentStore } from "./content/local.js";
import type {
  ContentRef,
  GitHubGateway,
  ProjectQueueAction,
  ProjectQueueBinding,
  ProjectQueueIntent,
  ProjectQueueInspection,
  ProjectQueueTarget,
  ProjectQueueExpectedTarget,
  ProjectQueueSnapshot,
  ProjectQueueKnownTarget,
  ProjectQueueWriteReceipt,
  ProjectQueuePlannedEffect,
} from "./contracts.js";
import {
  assertProjectQueueIntent,
  assertProjectQueueWriteReceipt,
  assertProjectQueuePlannedEffect,
  resolveProjectQueuePlannedEffect,
  projectQueueReceiptTarget,
} from "./github-project-queue.js";
import {
  awaitCheckpointAdmission,
  assertRecoveryCheckpointManifest,
  hasPrivateCheckpointScope,
  markCheckpointDirty,
  type RecoveryCheckpointClosure,
  readVerifiedRecoveryCheckpoint,
  readVerifiedProjectQueueHistory,
  type QueueCheckpointWitness,
} from "./recovery-checkpoint.js";
import type { ContinuationState } from "./state.js";
import {
  assertRestoredContinuationReady,
  cancelledContinuationResourceHold,
  continuationConfigurationMatches,
  parsePortableContinuation,
  readControllerOwner,
  readContinuation,
  objectiveLockPath,
  installationLockPath,
  statePath,
  restoredContinuationOwnershipHold,
  type ControllerLock,
} from "./state-store.js";
import { canHandoff } from "./runner/ownership.js";
import { collectedLocalWorkerSessionSettled } from "./execution/checkpoint.js";
import {
  isExecutionState,
  isPreparationState,
  projectionStarted,
} from "./state.js";
import { objectiveComplete } from "./completion.js";
import {
  assertProcessActive,
  currentProcessDeadlineAt,
  hasUnresolvedSubprocesses,
  linuxProcessIdentity,
  ownIdentity,
  processGroupExists,
} from "./process.js";

export const queueDigest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const digest = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const date = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid Project queue receipt");
  return value as Record<string, unknown>;
};
const only = (value: Record<string, unknown>, keys: string[]) => {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error("Unsupported Project queue receipt field");
};

export type QueueMode = "running" | "paused" | "draining";
export type QueueMetadata =
  | {
      schemaVersion: 1;
      kind: "admission";
      admissionId: string;
      receiptId: string;
      state: "queued" | "withdrawn";
    }
  | {
      schemaVersion: 1;
      kind: "control";
      receiptId: string;
      mode: QueueMode;
      watch: boolean;
    };
export function parseQueueMetadata(text: string): QueueMetadata {
  const value = object(JSON.parse(text));
  if (value.schemaVersion !== 1 || !uuid(value.receiptId))
    throw new Error("Invalid Project queue metadata identity");
  if (value.kind === "admission") {
    only(value, ["schemaVersion", "kind", "admissionId", "receiptId", "state"]);
    if (
      !uuid(value.admissionId) ||
      !["queued", "withdrawn"].includes(String(value.state))
    )
      throw new Error("Invalid Project admission metadata");
  } else {
    only(value, ["schemaVersion", "kind", "receiptId", "mode", "watch"]);
    if (
      value.kind !== "control" ||
      !["running", "paused", "draining"].includes(String(value.mode)) ||
      typeof value.watch !== "boolean"
    )
      throw new Error("Invalid Project control metadata");
  }
  return value as unknown as QueueMetadata;
}
interface QueueEffect {
  intent: ProjectQueueIntent;
  receipt?: Omit<ProjectQueueWriteReceipt, "original">;
  original?: ContentRef;
  rejectedOriginal?: ContentRef;
}
interface QueueBeforeEffectFailure {
  schemaVersion: 1;
  at: string;
  originalOperation: ContentRef;
  error: ContentRef;
  checkpoint: ContentRef;
  sources: { path: string; ref: ContentRef }[];
}
export interface QueueOperation {
  schemaVersion: 1;
  kind: "project-queue-operation";
  id: string;
  repository: string;
  binding: ProjectQueueBinding;
  authorityDigest: string;
  at: string;
  action: "admit" | "withdraw" | "control" | "roadmap";
  /** Original explicit local operation; these historical receipts never supply membership. */
  approval: {
    kind: "queue-command" | "background-setup" | "proposal";
    proposalId?: string;
    approvalDigest?: string;
  };
  scope: string;
  previousReceiptId: string | null;
  objective?: number;
  issueNodeId?: string;
  bodyDigest?: string;
  order?: number;
  metadata?: string;
  effects: QueueEffect[];
  completed?: true;
  /** Positive creating-callback refusal; never an inferred unknown response. */
  beforeEffectFailure?: QueueBeforeEffectFailure;
  /** All members use the first existing operation as their immutable command owner. */
  commandId?: string;
  commandRecipe?: QueueCommandRecipe;
}
type QueueOperationHeader = Omit<
  QueueOperation,
  | "effects"
  | "completed"
  | "beforeEffectFailure"
  | "commandId"
  | "commandRecipe"
>;
interface QueueCommandRecipe {
  schemaVersion: 1;
  id: string;
  configDigest: string;
  deadlineAt: string | null;
  operations: QueueOperationHeader[];
  effects: ProjectQueuePlannedEffect[];
}
interface QueueCommand {
  operations: QueueOperation[];
  recipe: QueueCommandRecipe;
}
export interface QueueOwnerClaim {
  schemaVersion: 1;
  kind: "project-queue-owner";
  id: string;
  repository: string;
  authorityDigest: string;
  admissionId: string;
  receiptId: string;
  objective: number;
  bodyDigest: string;
  ownerTokenDigest: string;
  /** Original creating controller. */
  ownerProcess: { pid: number; startTime: string; namespace: string };
  at: string;
  deadlineAt: string | null;
  priorRunId?: string;
  runBinding?: { schemaVersion: 1; runId: string; initialSnapshot: ContentRef };
  settled?: {
    at: string;
    runId?: string;
    disposition: "quiescent";
    cancellation?: QueueCancellationProof;
    handoff?: QueueStoppedHandoffProof;
    reservationFailure?: {
      schemaVersion: 1;
      originalClaim: ContentRef;
      failure: ContentRef;
    };
    /** The settled run's unprojected plan was refused; it never dispatches again. */
    refusal?: { schemaVersion: 1; at: string };
  };
}

interface QueueStoppedHandoffProof {
  schemaVersion: 1;
  originalClaim: ContentRef;
  stoppedSnapshot: ContentRef;
  configDigest: string;
  owner: { pid: number; startTime: string; tokenDigest: string };
}
function assertStoppedClaimState(state: ContinuationState): void {
  if (isExecutionState(state)) {
    const work = Object.values(state.work);
    const collected = (entry: (typeof work)[number]) => {
      const execution = entry.execution;
      const data = execution?.data as
        | { result?: import("./contracts.js").ExecutionResult }
        | undefined;
      return !!(
        execution?.provider === "local" &&
        execution.identity === entry.attempt &&
        data?.result?.collection &&
        data.result.session &&
        collectedLocalWorkerSessionSettled(execution, data.result.session)
      );
    };
    // A worker that ended without a result (#1268): the driver records that
    // it stopped only after settling its process group, so nothing remains to
    // collect. Settlement below still proves its process identity is gone.
    const ceased = (entry: (typeof work)[number]) => {
      const execution = entry.execution;
      const data = execution?.data as
        | { result?: unknown; stopped?: unknown; rejectedCollection?: unknown }
        | undefined;
      return !!(
        execution?.provider === "local" &&
        execution.identity === entry.attempt &&
        typeof data?.stopped === "string" &&
        data.result === undefined &&
        data.rejectedCollection === undefined
      );
    };
    // A refused return: the driver records the rejection only after freezing
    // the candidate and settling the worker, so nothing remains to collect.
    const rejected = (entry: (typeof work)[number]) => {
      const execution = entry.execution;
      const data = execution?.data as
        | { result?: unknown; rejectedCollection?: unknown }
        | undefined;
      return !!(
        execution?.provider === "local" &&
        execution.identity === entry.attempt &&
        data?.rejectedCollection !== undefined &&
        data.result === undefined
      );
    };
    // Execution may end with a collected, ceased or refused worker. The later
    // pre-delivery steps (validation, review and operator approval) hold its
    // collected result; delivery's GitHub effects are never handed off.
    const settled = (entry: (typeof work)[number]) =>
      entry.step === "execute"
        ? collected(entry) || ceased(entry) || rejected(entry)
        : (entry.step === "validate" ||
            entry.step === "approve-asset" ||
            entry.step === "approve-result") &&
          entry.pullRequest === undefined &&
          collected(entry);
    if (
      state.restoration ||
      state.cancelRequested ||
      state.cancelledAt ||
      state.finalAcceptance ||
      state.coordinator?.cancelError ||
      state.coordinator?.processes?.length ||
      restoredContinuationOwnershipHold(state, true) ||
      // Every running item must be settled; pending items (for example after
      // a retry) hold no worker and need no proof.
      work.some(
        (entry) =>
          (entry.execution && entry.execution.provider !== "local") ||
          entry.status === "published" ||
          (entry.status === "running" && !settled(entry)),
      )
    )
      throw new Error(
        "Stopped Project execution handoff requires collected local results and settled source-host resources without unresolved effects",
      );
    return;
  }
  // Planning may stop for a decision, or between calls once an abandoned
  // call is settled; a submitted call or a completed plan is never handed off.
  if (
    !isPreparationState(state) ||
    state.cancelRequested ||
    state.cancelledAt ||
    projectionStarted(state) ||
    (state.planningRecovery?.phase !== "stopped" &&
      state.planningRecovery?.phase !== "ready") ||
    !canHandoff(state) ||
    restoredContinuationOwnershipHold(state)
  )
    throw new Error(
      "Project handoff requires the original nonterminal stopped planning run and settled native resources",
    );
  const recovery = state.planningRecovery;
  const receipts = [
    ...(recovery.invocations ?? []),
    ...recovery.history.flatMap((entry) => entry.invocations),
  ];
  if (
    receipts.some((receipt) => !receipt.resultDigest && !receipt.abandoned) ||
    (recovery.invocation &&
      !receipts.some(
        (receipt) =>
          receipt.id === recovery.invocation!.id &&
          receipt.phase === recovery.invocation!.phase &&
          receipt.resultDigest,
      ))
  )
    throw new Error(
      "Stopped Project handoff has an unresolved retained planning invocation",
    );
}

interface QueueCancellationProof {
  schemaVersion: 1;
  originalClaim: ContentRef;
  initialSnapshot: ContentRef;
  cancelledSnapshot: ContentRef;
  configDigest: string;
  owner: { pid: number; startTime: string; tokenDigest: string };
  lineage:
    | { kind: "producer-bound" }
    | {
        kind: "verified-first-run";
        checkpoints: {
          before: QueueCheckpointWitness;
          claimed: QueueCheckpointWitness;
          initial: QueueCheckpointWitness;
        };
      };
}
function sameContentRef(left: ContentRef, right: ContentRef): boolean {
  return (
    left.digest === right.digest &&
    left.bytes === right.bytes &&
    left.mediaType === right.mediaType
  );
}
function sameRunBinding(
  left: QueueOwnerClaim["runBinding"],
  right: QueueOwnerClaim["runBinding"],
): boolean {
  return left === undefined || right === undefined
    ? left === right
    : left.schemaVersion === right.schemaVersion &&
        left.runId === right.runId &&
        sameContentRef(left.initialSnapshot, right.initialSnapshot);
}
/** Retain literal archive originals without treating JSON key order as identity. */
export function retainProjectQueueOriginal(
  store: LocalContentStore,
  reference: ContentRef,
  bytes: Uint8Array,
): ContentRef {
  if (!ref(reference)) throw new Error("Invalid Project original reference");
  const retained = store.putBytes(bytes, { mediaType: reference.mediaType });
  if (!sameContentRef(retained, reference))
    throw new Error("Project original retention differs");
  return reference;
}
export type QueueRecord = QueueOperation | QueueOwnerClaim;
const ref = (value: unknown): value is ContentRef => {
  const row = object(value);
  only(row, ["digest", "bytes", "mediaType"]);
  return (
    digest(row.digest) &&
    Number.isSafeInteger(row.bytes) &&
    Number(row.bytes) >= 0 &&
    row.mediaType === "application/json"
  );
};
export function parseQueueRecord(
  bytes: Uint8Array,
  repository: string,
  id: string,
): QueueRecord {
  const row = object(JSON.parse(Buffer.from(bytes).toString("utf8")));
  if (
    row.schemaVersion !== 1 ||
    row.repository !== repository ||
    row.id !== id ||
    !uuid(row.id) ||
    !digest(row.authorityDigest) ||
    !date(row.at)
  )
    throw new Error("Project queue history binding differs");
  if (row.kind === "project-queue-owner") {
    only(row, [
      "schemaVersion",
      "kind",
      "id",
      "repository",
      "authorityDigest",
      "admissionId",
      "receiptId",
      "objective",
      "bodyDigest",
      "ownerTokenDigest",
      "ownerProcess",
      "at",
      "deadlineAt",
      "priorRunId",
      "runBinding",
      "settled",
    ]);
    if (
      !uuid(row.admissionId) ||
      !uuid(row.receiptId) ||
      !digest(row.bodyDigest) ||
      !digest(row.ownerTokenDigest) ||
      !Number.isSafeInteger(row.objective) ||
      Number(row.objective) < 1 ||
      !(row.deadlineAt === null || date(row.deadlineAt)) ||
      (row.priorRunId !== undefined && !uuid(row.priorRunId))
    )
      throw new Error("Invalid Project queue owner identity");
    const owner = object(row.ownerProcess);
    only(owner, ["pid", "startTime", "namespace"]);
    if (
      !Number.isSafeInteger(owner.pid) ||
      Number(owner.pid) < 1 ||
      typeof owner.startTime !== "string" ||
      !/^\d+$/.test(owner.startTime) ||
      typeof owner.namespace !== "string" ||
      !/^pid:\[\d+\]$/.test(owner.namespace)
    )
      throw new Error("Invalid original Project controller identity");
    if (row.runBinding !== undefined) {
      const binding = object(row.runBinding);
      only(binding, ["schemaVersion", "runId", "initialSnapshot"]);
      if (
        binding.schemaVersion !== 1 ||
        !uuid(binding.runId) ||
        !ref(binding.initialSnapshot)
      )
        throw new Error("Invalid immutable Project run binding");
    }
    if (row.settled !== undefined) {
      const settled = object(row.settled);
      only(settled, [
        "at",
        "runId",
        "disposition",
        "cancellation",
        "handoff",
        "reservationFailure",
        "refusal",
      ]);
      if (
        !date(settled.at) ||
        settled.disposition !== "quiescent" ||
        (settled.runId !== undefined && !uuid(settled.runId))
      )
        throw new Error("Invalid Project queue owner settlement");
      if (settled.refusal !== undefined) {
        const refusal = object(settled.refusal);
        only(refusal, ["schemaVersion", "at"]);
        if (
          refusal.schemaVersion !== 1 ||
          !date(refusal.at) ||
          !uuid(settled.runId) ||
          settled.cancellation !== undefined ||
          Date.parse(String(refusal.at)) < Date.parse(String(settled.at))
        )
          throw new Error("Invalid Project plan refusal settlement");
      }
      if (settled.reservationFailure !== undefined) {
        const proof = object(settled.reservationFailure);
        only(proof, ["schemaVersion", "originalClaim", "failure"]);
        if (
          proof.schemaVersion !== 1 ||
          !ref(proof.originalClaim) ||
          !ref(proof.failure) ||
          row.priorRunId !== undefined ||
          row.runBinding !== undefined ||
          settled.runId !== undefined ||
          settled.handoff !== undefined ||
          settled.cancellation !== undefined ||
          Date.parse(String(settled.at)) < Date.parse(String(row.at))
        )
          throw new Error(
            "Invalid same-owner pre-snapshot reservation failure",
          );
      }
      if (settled.handoff !== undefined) {
        const proof = object(settled.handoff);
        only(proof, [
          "schemaVersion",
          "originalClaim",
          "stoppedSnapshot",
          "configDigest",
          "owner",
        ]);
        const owner = object(proof.owner);
        only(owner, ["pid", "startTime", "tokenDigest"]);
        if (
          settled.cancellation !== undefined ||
          !row.runBinding ||
          proof.schemaVersion !== 1 ||
          !uuid(settled.runId) ||
          !ref(proof.originalClaim) ||
          !ref(proof.stoppedSnapshot) ||
          !digest(proof.configDigest) ||
          !Number.isSafeInteger(owner.pid) ||
          Number(owner.pid) < 1 ||
          typeof owner.startTime !== "string" ||
          !owner.startTime ||
          !digest(owner.tokenDigest)
        )
          throw new Error("Invalid attributable stopped Project handoff proof");
      }
      if (settled.cancellation !== undefined) {
        const proof = object(settled.cancellation);
        only(proof, [
          "schemaVersion",
          "originalClaim",
          "initialSnapshot",
          "cancelledSnapshot",
          "configDigest",
          "owner",
          "lineage",
        ]);
        const owner = object(proof.owner);
        only(owner, ["pid", "startTime", "tokenDigest"]);
        const lineage = object(proof.lineage);
        only(
          lineage,
          lineage.kind === "verified-first-run"
            ? ["kind", "checkpoints"]
            : ["kind"],
        );
        if (
          proof.schemaVersion !== 1 ||
          !uuid(settled.runId) ||
          !ref(proof.originalClaim) ||
          !ref(proof.initialSnapshot) ||
          !ref(proof.cancelledSnapshot) ||
          !digest(proof.configDigest) ||
          !Number.isSafeInteger(owner.pid) ||
          Number(owner.pid) < 1 ||
          typeof owner.startTime !== "string" ||
          !owner.startTime ||
          !digest(owner.tokenDigest) ||
          !["producer-bound", "verified-first-run"].includes(
            String(lineage.kind),
          )
        )
          throw new Error("Invalid attributable Project cancellation proof");
        if (lineage.kind === "verified-first-run") {
          const witnesses = object(lineage.checkpoints);
          only(witnesses, ["before", "claimed", "initial"]);
          for (const name of ["before", "claimed", "initial"]) {
            const witness = object(witnesses[name]);
            only(witness, ["commitSha", "manifest"]);
            if (
              typeof witness.commitSha !== "string" ||
              !/^[a-f0-9]{40,64}$/.test(witness.commitSha) ||
              !ref(witness.manifest)
            )
              throw new Error(
                "Invalid historical Project cancellation witness",
              );
          }
        }
      }
    }
  } else {
    only(row, [
      "schemaVersion",
      "kind",
      "id",
      "repository",
      "binding",
      "authorityDigest",
      "at",
      "action",
      "approval",
      "scope",
      "previousReceiptId",
      "objective",
      "issueNodeId",
      "bodyDigest",
      "order",
      "metadata",
      "effects",
      "completed",
      "beforeEffectFailure",
      "commandId",
      "commandRecipe",
    ]);
    if (
      row.kind !== "project-queue-operation" ||
      !["admit", "withdraw", "control", "roadmap"].includes(
        String(row.action),
      ) ||
      typeof row.scope !== "string" ||
      !(row.previousReceiptId === null || uuid(row.previousReceiptId)) ||
      !Array.isArray(row.effects) ||
      row.effects.length > 3 ||
      (row.completed !== undefined && row.completed !== true)
    )
      throw new Error("Invalid Project queue operation");
    const binding = object(row.binding);
    only(binding, [
      "repository",
      "projectId",
      "metadataFieldId",
      "orderFieldId",
      "controlItemId",
      "factoryManagedFields",
    ]);
    if (
      binding.repository !== repository ||
      binding.factoryManagedFields !== true ||
      ["projectId", "metadataFieldId", "orderFieldId", "controlItemId"].some(
        (key) =>
          typeof binding[key] !== "string" ||
          !/^[A-Za-z0-9_-]{1,256}$/.test(String(binding[key])),
      )
    )
      throw new Error("Invalid Project queue field binding");
    const approval = object(row.approval);
    only(approval, ["kind", "proposalId", "approvalDigest"]);
    if (
      !["queue-command", "background-setup", "proposal"].includes(
        String(approval.kind),
      ) ||
      (approval.kind === "proposal" &&
        (!uuid(approval.proposalId) || !digest(approval.approvalDigest)))
    )
      throw new Error("Invalid Project queue approval provenance");
    if (
      row.action !== "control" &&
      (!Number.isSafeInteger(row.objective) ||
        Number(row.objective) < 1 ||
        typeof row.issueNodeId !== "string" ||
        !digest(row.bodyDigest))
    )
      throw new Error("Invalid Project queue Objective binding");
    if (
      row.order !== undefined &&
      (!Number.isSafeInteger(row.order) || Number(row.order) < 1)
    )
      throw new Error("Invalid Project queue order binding");
    if (row.metadata !== undefined) {
      if (
        typeof row.metadata !== "string" ||
        parseQueueMetadata(row.metadata).receiptId !== id
      )
        throw new Error("Project queue metadata differs from producer receipt");
    }
    if (row.commandId !== undefined && !uuid(row.commandId))
      throw new Error("Invalid queue command owner identity");
    if (row.commandRecipe !== undefined) {
      if (row.commandId !== id)
        throw new Error(
          "Only the original first operation owns its command recipe",
        );
      assertCommandRecipe(row.commandRecipe, repository, id);
      const header = row.commandRecipe.operations.find(
        (value) => value.id === id,
      );
      if (
        JSON.stringify(header) !==
        JSON.stringify(commandHeader(row as unknown as QueueOperation))
      )
        throw new Error(
          "Command owner differs from its frozen operation header",
        );
    }
    const seen = new Set<string>();
    for (const raw of row.effects) {
      const effect = object(raw);
      only(effect, ["intent", "receipt", "original", "rejectedOriginal"]);
      assertProjectQueueIntent(effect.intent);
      const intent = effect.intent as ProjectQueueIntent;
      if (
        intent.action === "set-admission-fields" &&
        (!row.commandId || row.action !== "admit")
      )
        throw new Error(
          "Compound admission requires its declared command membership",
        );
      if (
        JSON.stringify(intent.binding) !== JSON.stringify(binding) ||
        seen.has(intent.requestId)
      )
        throw new Error("Project queue effect differs from operation");
      seen.add(intent.requestId);
      if (effect.original !== undefined && !ref(effect.original))
        throw new Error("Invalid Project queue original body reference");
      if (
        effect.rejectedOriginal !== undefined &&
        !ref(effect.rejectedOriginal)
      )
        throw new Error("Invalid rejected Project queue original reference");
      if ((effect.receipt === undefined) !== (effect.original === undefined))
        throw new Error("Project queue receipt requires its original response");
      if (
        effect.receipt !== undefined &&
        JSON.stringify(object(effect.receipt).intent) !== JSON.stringify(intent)
      )
        throw new Error("Project queue response intent differs");
    }
    if (row.beforeEffectFailure !== undefined) {
      const proof = object(row.beforeEffectFailure);
      only(proof, [
        "schemaVersion",
        "at",
        "originalOperation",
        "error",
        "checkpoint",
        "sources",
      ]);
      if (
        row.completed ||
        !zeroIntentControl(row as unknown as QueueOperation) ||
        proof.schemaVersion !== 1 ||
        !date(proof.at) ||
        Date.parse(proof.at) < Date.parse(String(row.at)) ||
        !ref(proof.originalOperation) ||
        !ref(proof.error) ||
        !ref(proof.checkpoint) ||
        !Array.isArray(proof.sources) ||
        proof.sources.length !== 3
      )
        throw new Error("Invalid positively not-dispatched operation failure");
      const paths = new Set();
      for (const raw of proof.sources) {
        const source = object(raw);
        only(source, ["path", "ref"]);
        if (
          typeof source.path !== "string" ||
          ![
            "project-queue-state.js",
            "github-project-queue.js",
            "intake.js",
          ].includes(source.path) ||
          paths.has(source.path) ||
          !ref(source.ref)
        )
          throw new Error("Missing original queue publication protocol");
        paths.add(source.path);
      }
    }
    if (
      row.completed &&
      row.effects.some((raw) => object(raw).receipt === undefined)
    )
      throw new Error("Completed Project queue operation has unknown effects");
  }
  return row as unknown as QueueRecord;
}
function privateBytes(path: string): Buffer {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.uid !== process.getuid?.() ||
    stat.mode & 0o077 ||
    realpathSync(dirname(path)) !== dirname(path)
  )
    throw new Error(
      "Project queue history must be an owned private regular file",
    );
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
function save(record: QueueRecord): void {
  const directory = join(stateRoot(record.repository), "project-queue-history");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (realpathSync(directory) !== directory)
    throw new Error(
      "Project queue history directory resolves through a symlink",
    );
  const path = join(directory, `${record.id}.json`);
  parseQueueRecord(
    Buffer.from(JSON.stringify(record)),
    record.repository,
    record.id,
  );
  if (existsSync(path)) {
    const previous = parseQueueRecord(
      privateBytes(path),
      record.repository,
      record.id,
    );
    if (previous.kind !== record.kind)
      throw new Error("Project receipt identity cannot change its role");
    if (
      previous.kind === "project-queue-operation" &&
      record.kind === "project-queue-operation"
    ) {
      const {
        effects: oldEffects,
        completed: oldCompleted,
        beforeEffectFailure: oldFailure,
        ...oldBinding
      } = previous;
      const {
        effects: newEffects,
        completed: newCompleted,
        beforeEffectFailure: newFailure,
        ...newBinding
      } = record;
      if (
        JSON.stringify(oldBinding) !== JSON.stringify(newBinding) ||
        (oldCompleted && !newCompleted) ||
        (oldFailure &&
          JSON.stringify(oldFailure) !== JSON.stringify(newFailure)) ||
        (oldFailure &&
          JSON.stringify(oldEffects) !== JSON.stringify(newEffects)) ||
        newEffects.length < oldEffects.length
      )
        throw new Error(
          "Original Project admission and effect history are immutable",
        );
      for (const [index, oldEffect] of oldEffects.entries()) {
        const next = newEffects[index]!;
        if (
          JSON.stringify(oldEffect.intent) !== JSON.stringify(next.intent) ||
          (oldEffect.receipt &&
            JSON.stringify(oldEffect.receipt) !==
              JSON.stringify(next.receipt)) ||
          (oldEffect.original &&
            JSON.stringify(oldEffect.original) !==
              JSON.stringify(next.original)) ||
          (oldEffect.rejectedOriginal &&
            JSON.stringify(oldEffect.rejectedOriginal) !==
              JSON.stringify(next.rejectedOriginal))
        )
          throw new Error(
            "Original Project mutation intent/response cannot be replaced",
          );
      }
    } else if (
      previous.kind === "project-queue-owner" &&
      record.kind === "project-queue-owner"
    ) {
      const {
        settled: oldSettled,
        runBinding: oldRun,
        ...oldBinding
      } = previous;
      const { settled: newSettled, runBinding: newRun, ...newBinding } = record;
      // A plan refusal is the only later addition to a settlement.
      const { refusal: oldRefusal, ...oldTerms } = oldSettled ?? {};
      const { refusal: newRefusal, ...newTerms } = newSettled ?? {};
      if (
        JSON.stringify(oldBinding) !== JSON.stringify(newBinding) ||
        (oldRun && !sameRunBinding(oldRun, newRun)) ||
        (oldSettled &&
          (JSON.stringify(oldTerms) !== JSON.stringify(newTerms) ||
            (oldRefusal &&
              JSON.stringify(oldRefusal) !== JSON.stringify(newRefusal))))
      )
        throw new Error(
          "Original Project owner claim and settlement are immutable",
        );
    }
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(record)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  const parent = openSync(directory, constants.O_RDONLY);
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
  markCheckpointDirty(record.repository, {
    path,
    kind: "project-queue-receipt",
  });
}
function queueOwnerReferences(record: QueueOwnerClaim): ContentRef[] {
  const refs = [
    ...(record.runBinding ? [record.runBinding.initialSnapshot] : []),
    ...(record.settled?.reservationFailure
      ? [
          record.settled.reservationFailure.originalClaim,
          record.settled.reservationFailure.failure,
        ]
      : []),
  ];
  const proof = record.settled?.cancellation;
  if (proof) {
    refs.push(
      proof.originalClaim,
      proof.initialSnapshot,
      proof.cancelledSnapshot,
    );
    if (proof.lineage.kind === "verified-first-run")
      refs.push(
        ...Object.values(proof.lineage.checkpoints).map(
          (witness) => witness.manifest,
        ),
      );
  }
  if (record.settled?.handoff)
    refs.push(
      record.settled.handoff.originalClaim,
      record.settled.handoff.stoppedSnapshot,
    );
  const distinct = new Map<string, ContentRef>();
  for (const reference of refs) {
    const previous = distinct.get(reference.digest);
    if (previous && !sameContentRef(previous, reference))
      throw new Error("Project ownership reference binding differs");
    distinct.set(reference.digest, reference);
  }
  return [...distinct.values()];
}
function assertQueueOwnerReferenceBodies(
  record: QueueOwnerClaim,
  readReference: (ref: ContentRef) => Uint8Array,
  persisted = false,
): ContentRef[] {
  parseQueueRecord(
    Buffer.from(JSON.stringify(record)),
    record.repository,
    record.id,
  );
  const bytes = (ref: ContentRef) => {
    const data = Buffer.from(readReference(ref));
    if (
      data.length !== ref.bytes ||
      createHash("sha256").update(data).digest("hex") !== ref.digest
    )
      throw new Error("Project ownership original bytes differ");
    return data;
  };
  const json = (ref: ContentRef) =>
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes(ref)));
  // A settled claim already persisted is history. Its run snapshots match
  // their digests, so one this version does not parse is an earlier
  // version's shape, not corruption: only the comparisons that need that
  // snapshot are skipped; every original and binding is still checked
  // (#1457). A claim being settled now is always read in full.
  const history = persisted && record.settled !== undefined;
  const snapshot = (ref: ContentRef): ContinuationState | undefined => {
    const value = json(ref);
    try {
      return parsePortableContinuation(
        value,
        record.repository,
        record.objective,
      );
    } catch (error) {
      if (!history) throw error;
      return undefined;
    }
  };
  const matches = (state: ContinuationState, runId: string) => {
    if (
      state.runId !== runId ||
      state.objectiveBodyDigest !== record.bodyDigest ||
      (state.coordinator?.deadlineAt ?? null) !== record.deadlineAt ||
      (record.priorRunId !== undefined && record.priorRunId !== runId)
    )
      throw new Error(
        "Project claim differs from its original run/body/deadline",
      );
  };
  if (record.settled?.reservationFailure) {
    const proof = record.settled.reservationFailure;
    const original = parseQueueRecord(
      bytes(proof.originalClaim),
      record.repository,
      record.id,
    );
    const { settled: ignored, ...binding } = record;
    if (
      original.kind !== "project-queue-owner" ||
      original.settled ||
      JSON.stringify(binding) !== JSON.stringify(original)
    )
      throw new Error(
        "Reservation failure differs from its exact original claim",
      );
    const failure = json(proof.failure);
    if (typeof failure !== "string" || !failure)
      throw new Error("Reservation failure requires its original error");
  }
  if (record.runBinding) {
    const initial = snapshot(record.runBinding.initialSnapshot);
    if (initial) matches(initial, record.runBinding.runId);
  }
  if (record.settled?.handoff) {
    const proof = record.settled.handoff;
    const original = parseQueueRecord(
      bytes(proof.originalClaim),
      record.repository,
      record.id,
    );
    const { settled: _settled, ...binding } = record;
    if (
      original.kind !== "project-queue-owner" ||
      original.settled ||
      !original.runBinding ||
      JSON.stringify(binding) !== JSON.stringify(original) ||
      original.runBinding.runId !== record.settled.runId
    )
      throw new Error(
        "Stopped handoff differs from its original producer-bound Project claim",
      );
    const initial = snapshot(original.runBinding.initialSnapshot);
    const stopped = snapshot(proof.stoppedSnapshot);
    if (initial) matches(initial, original.runBinding.runId);
    if (stopped) matches(stopped, original.runBinding.runId);
    if (
      (initial && initial.configDigest !== proof.configDigest) ||
      (stopped && stopped.configDigest !== proof.configDigest)
    )
      throw new Error(
        "Stopped handoff configuration differs from its original run",
      );
    if (stopped) assertStoppedClaimState(stopped);
  }
  const proof = record.settled?.cancellation;
  if (proof) {
    const original = parseQueueRecord(
      bytes(proof.originalClaim),
      record.repository,
      record.id,
    );
    if (original.kind !== "project-queue-owner" || original.settled)
      throw new Error(
        "Cancellation requires the original unfinished Project claim",
      );
    const { settled: ignored, runBinding: run, ...binding } = record;
    const {
      settled: originalIgnored,
      runBinding: originalRun,
      ...originalBinding
    } = original;
    if (JSON.stringify(binding) !== JSON.stringify(originalBinding))
      throw new Error("Cancellation cannot rewrite the original Project claim");
    const initial = snapshot(proof.initialSnapshot);
    const terminal = snapshot(proof.cancelledSnapshot);
    if (initial) matches(initial, record.settled!.runId!);
    if (terminal) matches(terminal, record.settled!.runId!);
    if (
      (initial && initial.configDigest !== proof.configDigest) ||
      (terminal &&
        (terminal.configDigest !== proof.configDigest ||
          !terminal.cancelledAt ||
          !terminal.cancelRequested ||
          Date.parse(record.settled!.at) < Date.parse(terminal.cancelledAt) ||
          (isExecutionState(terminal) && terminal.finalAcceptance) ||
          cancelledContinuationResourceHold(terminal)))
    )
      throw new Error(
        "Project cancellation has no authenticated terminal quiescent continuation",
      );
    if (proof.lineage.kind === "producer-bound") {
      if (
        !run ||
        !originalRun ||
        run.runId !== record.settled!.runId ||
        !sameRunBinding(run, originalRun) ||
        !sameContentRef(run.initialSnapshot, proof.initialSnapshot)
      )
        throw new Error(
          "Cancellation differs from the producer-bound Project run",
        );
    } else {
      if (
        record.deadlineAt === null ||
        original.priorRunId ||
        original.runBinding ||
        (initial &&
          (!initial.coordinator?.phaseStartedAt ||
            Date.parse(initial.coordinator.phaseStartedAt) <
              Date.parse(record.at) ||
            Date.parse(initial.coordinator.phaseStartedAt) >
              Date.parse(record.deadlineAt)))
      )
        throw new Error("Historical first-run Project provenance is ambiguous");
      const { checkpoints } = proof.lineage;
      const manifests = Object.fromEntries(
        Object.entries(checkpoints).map(([key, witness]) => [
          key,
          json(witness.manifest),
        ]),
      );
      for (const manifest of Object.values(manifests)) {
        assertRecoveryCheckpointManifest(manifest, manifests.initial.binding, {
          maxBytes: Number.MAX_SAFE_INTEGER,
          maxFiles: Number.MAX_SAFE_INTEGER,
        });
        if (
          manifest.binding.repository !== record.repository ||
          manifest.binding.scope !== "private-history" ||
          manifest.binding.visibility !== "private"
        )
          throw new Error(
            "Historical cancellation witnesses have invalid private binding",
          );
      }
      const claimPath = `project-queue-history/${record.id}.json`;
      const statePaths = [
        `objectives/${record.objective}/state.json`,
        `objectives/${record.objective}/pre-state.json`,
      ];
      const claimedRef = manifests.claimed.files.find(
        (file: { path: string }) => file.path === claimPath,
      )?.ref;
      const initialClaimRef = manifests.initial.files.find(
        (file: { path: string }) => file.path === claimPath,
      )?.ref;
      const initialStateRef = manifests.initial.files.find(
        (file: { path: string }) => statePaths.includes(file.path),
      )?.ref;
      if (
        manifests.before.files.some(
          (file: { path: string }) =>
            file.path === claimPath || statePaths.includes(file.path),
        ) ||
        !claimedRef ||
        !sameContentRef(claimedRef, proof.originalClaim) ||
        !initialClaimRef ||
        !sameContentRef(initialClaimRef, proof.originalClaim) ||
        !initialStateRef ||
        !sameContentRef(initialStateRef, proof.initialSnapshot) ||
        !(
          manifests.before.sequence < manifests.claimed.sequence &&
          manifests.claimed.sequence <= manifests.initial.sequence
        ) ||
        manifests.initial.authority?.configDigest !== proof.configDigest ||
        manifests.initial.authority?.authorityDigest !==
          record.authorityDigest ||
        manifests.claimed.authority?.configDigest !== proof.configDigest ||
        manifests.claimed.authority?.authorityDigest !==
          record.authorityDigest ||
        Date.parse(manifests.before.createdAt) > Date.parse(record.at) ||
        Date.parse(manifests.claimed.createdAt) < Date.parse(record.at) ||
        (initial &&
          Date.parse(manifests.initial.createdAt) <
            Date.parse(initial.coordinator!.phaseStartedAt))
      )
        throw new Error(
          "Historical cancellation witnesses differ from original claim/run cohort",
        );
    }
  }
  const refs = queueOwnerReferences(record);
  for (const reference of refs) bytes(reference);
  return refs;
}
export async function authenticateQueueOwnerReferences(
  record: QueueOwnerClaim,
  readReference: (ref: ContentRef) => Promise<Uint8Array> | Uint8Array,
  persisted = false,
): Promise<ContentRef[]> {
  const refs = queueOwnerReferences(record);
  const bodies = new Map<string, Uint8Array>();
  for (const reference of refs)
    bodies.set(reference.digest, await readReference(reference));
  return assertQueueOwnerReferenceBodies(
    record,
    (reference) => {
      const bytes = bodies.get(reference.digest);
      if (!bytes) throw new Error("Project ownership original is unavailable");
      return bytes;
    },
    persisted,
  );
}
function queueOperationReferences(operation: QueueOperation): ContentRef[] {
  const failure = operation.beforeEffectFailure;
  return failure
    ? [
        failure.originalOperation,
        failure.error,
        failure.checkpoint,
        ...failure.sources.map((row) => row.ref),
      ]
    : [];
}
export function assertQueueOperationReferenceBodies(
  operation: QueueOperation,
  readReference: (ref: ContentRef) => Uint8Array,
): void {
  const proof = operation.beforeEffectFailure;
  if (!proof) return;
  const json = (reference: ContentRef) => {
    const bytes = Buffer.from(readReference(reference));
    if (
      bytes.length !== reference.bytes ||
      queueDigest(bytes.toString("utf8")) !== reference.digest
    )
      throw new Error("Queue failure original bytes changed");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  };
  const original = parseQueueRecord(
    Buffer.from(readReference(proof.originalOperation)),
    operation.repository,
    operation.id,
  );
  const { beforeEffectFailure: ignored, ...binding } = operation;
  if (
    original.kind !== "project-queue-operation" ||
    original.beforeEffectFailure ||
    original.completed ||
    JSON.stringify(original) !== JSON.stringify(binding)
  )
    throw new Error("Queue failure changed its exact unfinished original");
  const error = object(json(proof.error)),
    checkpoint = object(json(proof.checkpoint));
  if (
    error.kind !== "creating-owner-before-command-refusal" ||
    error.knownNotDispatched !== true ||
    error.boundary !== "before-effect" ||
    typeof error.message !== "string" ||
    object(checkpoint.binding).repository !== operation.repository ||
    !Number.isSafeInteger(checkpoint.sequence) ||
    !Number.isSafeInteger(checkpoint.acknowledgedSequence)
  )
    throw new Error(
      "Positive original callback/publication failure is unavailable",
    );
  for (const source of proof.sources)
    if (typeof json(source.ref) !== "string")
      throw new Error("Original source must retain its complete text");
}
/** Authenticate the literal producer source before looking up derived references. */
function queueRecordReferenceSource(
  repository: string,
  path: string,
  source: { ref: ContentRef; bytes: Uint8Array },
) {
  const match = /^project-queue-history\/([a-f0-9-]{36})\.json$/.exec(path);
  if (
    !match ||
    !ref(source.ref) ||
    source.bytes.byteLength !== source.ref.bytes ||
    createHash("sha256").update(source.bytes).digest("hex") !==
      source.ref.digest
  )
    throw new Error("Project queue record differs from its exact source body");
  const record = parseQueueRecord(
    Buffer.from(source.bytes),
    repository,
    match[1]!,
  );
  const signature = JSON.stringify([
    "project-queue-record-references",
    repository,
    path,
    record.kind,
    record.id,
    [source.ref.digest, source.ref.bytes, source.ref.mediaType],
  ]);
  return { record, signature };
}
/** Fetch requests only: the actual reader and all validators still authenticate them. */
export function cachedQueueRecordOriginals(
  repository: string,
  path: string,
  source: { ref: ContentRef; bytes: Uint8Array },
  store: LocalContentStore,
): ContentRef[] | undefined {
  const { signature } = queueRecordReferenceSource(repository, path, source);
  if (
    Object.getPrototypeOf(store) !== LocalContentStore.prototype ||
    store.readBytes !== LocalContentStore.prototype.readBytes
  )
    return undefined;
  const cached = LocalContentStore.prototype.checkpointReferences.call(
    store,
    signature,
  );
  if (!cached) return undefined;
  const requested = new Map<string, ContentRef>();
  for (const reference of [...cached.contentRefs, ...cached.originals]) {
    const key = JSON.stringify([
      reference.digest,
      reference.bytes,
      reference.mediaType,
    ]);
    requested.set(key, structuredClone(reference));
  }
  return [...requested.values()];
}
/** Pure immutable record/reference facts only; current queue authority is never memoized. */
export function checkpointQueueRecordReferences(
  repository: string,
  path: string,
  source: { ref: ContentRef; bytes: Uint8Array },
  readReference: (reference: ContentRef) => Uint8Array,
  cache?: { store: LocalContentStore; reader: "local" | "archive" },
): { record: QueueRecord; contentRefs: ContentRef[] } {
  const { record, signature } = queueRecordReferenceSource(
    repository,
    path,
    source,
  );
  const concrete =
    cache &&
    (cache.reader === "local" || cache.reader === "archive") &&
    Object.getPrototypeOf(cache.store) === LocalContentStore.prototype &&
    cache.store.readBytes === LocalContentStore.prototype.readBytes;
  const cached =
    concrete &&
    LocalContentStore.prototype.checkpointReferences.call(
      cache.store,
      signature,
    );
  const authenticatedBytes = (reference: ContentRef): Uint8Array => {
    assertProcessActive();
    const bytes = readReference(reference);
    if (
      bytes.byteLength !== reference.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== reference.digest
    )
      throw new Error(
        "Project queue supporting original changed its exact bytes",
      );
    return bytes;
  };
  if (cached) {
    for (const reference of [...cached.contentRefs, ...cached.originals]) {
      assertProcessActive();
      if (cache!.reader === "local")
        LocalContentStore.prototype.verifyPrivateBytes.call(
          cache!.store,
          reference,
        );
      else authenticatedBytes(reference);
    }
    return { record, contentRefs: cached.contentRefs };
  }
  const originals = new Map<string, ContentRef>();
  const read = (reference: ContentRef): Uint8Array => {
    const key = JSON.stringify([
      reference.digest,
      reference.bytes,
      reference.mediaType,
    ]);
    if (!originals.has(key)) originals.set(key, structuredClone(reference));
    return authenticatedBytes(reference);
  };
  const contentRefs = [source.ref];
  if (record.kind === "project-queue-owner")
    contentRefs.push(...assertQueueOwnerReferenceBodies(record, read, true));
  else {
    assertQueueOperationReferenceBodies(record, read);
    contentRefs.push(...queueOperationReferences(record));
    for (const effect of record.effects) {
      if (effect.original) {
        assertProjectQueueWriteReceipt({
          ...effect.receipt,
          original: JSON.parse(
            Buffer.from(read(effect.original)).toString("utf8"),
          ),
        });
        contentRefs.push(effect.original);
      }
      if (effect.rejectedOriginal) {
        read(effect.rejectedOriginal);
        contentRefs.push(effect.rejectedOriginal);
      }
    }
  }
  if (concrete)
    LocalContentStore.prototype.retainCheckpointReferences.call(
      cache.store,
      signature,
      {
        contentRefs,
        gitObjects: [],
        gaps: [],
        originals: [...originals.values()],
      },
    );
  return { record, contentRefs };
}

export function projectQueuePersistenceClosure(
  config: FactoryConfig,
  root = stateRoot(config.repository),
): RecoveryCheckpointClosure {
  const directory = join(root, "project-queue-history");
  const store = new LocalContentStore(join(root, "content"));
  const closure: RecoveryCheckpointClosure = {
    files: [],
    contentRefs: [],
    gaps: [],
  };
  for (const name of existsSync(directory)
    ? readdirSync(directory).sort()
    : []) {
    if (!/^[a-f0-9-]{36}\.json$/.test(name))
      throw new Error("Unrecognized Project queue history file");
    const bytes = privateBytes(join(directory, name));
    const body = store.putBytes(bytes, { mediaType: "application/json" });
    const path = `project-queue-history/${name}`;
    const references = checkpointQueueRecordReferences(
      config.repository,
      path,
      { ref: body, bytes },
      (reference) => store.readBytes(reference),
      { store, reader: "local" },
    );
    closure.files.push({
      kind: "historical",
      path,
      ref: body,
      visibility: "private",
    });
    closure.contentRefs.push(...references.contentRefs);
  }
  return closure;
}
export function requireProjectQueueEffects(
  config: FactoryConfig,
): ProjectQueueBinding {
  const binding = config.queue?.project;
  if (!binding)
    throw new Error(
      "Queue operations require an explicitly bound Project; run Factory setup with its existing queue fields and control card",
    );
  if (
    config.gitPersistence?.scope !== "private-history" ||
    !hasPrivateCheckpointScope()
  )
    throw new Error(
      "Project queue mutation and dispatch require the configured private-history Git checkpoint scope",
    );
  return binding;
}
export async function readQueueHistory(
  config: FactoryConfig,
): Promise<QueueRecord[]> {
  if (config.gitPersistence?.scope !== "private-history")
    throw new Error(
      "Authenticated Project queue receipts require private-history Git persistence",
    );
  return readVerifiedProjectQueueHistory(config);
}

interface VerifiedQueueEntry {
  objective: number;
  itemId: string;
  issueNodeId: string;
  admissionId: string;
  receiptId: string;
  bodyDigest: string;
  authorityDigest: string;
  order: number;
  state: "queued" | "withdrawn";
}
export interface VerifiedQueueObservation {
  snapshot: ProjectQueueSnapshot;
  history: QueueRecord[];
  control: Extract<QueueMetadata, { kind: "control" }>;
  entries: VerifiedQueueEntry[];
}
function completedQueueOperation(
  operation: QueueOperation,
  history: QueueRecord[],
): boolean {
  if (!operation.completed) return false;
  const owner = history.find(
    (row): row is QueueOperation =>
      row.kind === "project-queue-operation" && row.id === operation.commandId,
  );
  return (
    !!owner?.commandRecipe &&
    owner.commandRecipe.operations.every((header) =>
      history.some(
        (row) =>
          row.kind === "project-queue-operation" &&
          row.id === header.id &&
          row.commandId === owner.id &&
          row.completed,
      ),
    )
  );
}
function producer(
  config: FactoryConfig,
  history: QueueRecord[],
  text: string,
  scope: string,
  itemId: string,
  historical = false,
): QueueOperation {
  const metadata = parseQueueMetadata(text);
  const record = history.find(
    (entry): entry is QueueOperation =>
      entry.kind === "project-queue-operation" &&
      entry.id === metadata.receiptId,
  );
  // Each refusal names its cause and the operator's next step (#1298).
  const refusal = (reason: string) =>
    new Error(
      `Project queue metadata lacks its exact authenticated explicit producer receipt: ${reason}`,
    );
  if (!record)
    throw refusal(
      `receipt ${metadata.receiptId} is absent from the authenticated archive; if a queue command reported durability-pending, run factory persistence sync`,
    );
  if (!completedQueueOperation(record, history))
    throw refusal(
      `receipt ${record.id} is not complete in the authenticated archive; if a queue command reported durability-pending, run factory persistence sync`,
    );
  if (
    record.scope !== scope ||
    record.metadata !== text ||
    JSON.stringify(record.binding) !== JSON.stringify(config.queue?.project)
  )
    throw refusal(
      `receipt ${record.id} differs from the card or Project binding`,
    );
  if (!historical && record.authorityDigest !== factoryAuthorityDigest(config))
    throw refusal(
      record.objective === undefined
        ? `control receipt ${record.id} was approved under a different queue authority (queued settings such as autonomy, provider or the Project binding changed); re-authorize with factory queue resume`
        : `receipt ${record.id} for Objective #${record.objective} was approved under a different queue authority (queued settings such as autonomy, provider or the Project binding changed); re-authorize with factory queue resume, then withdraw and re-add it with factory queue remove ${record.objective} and factory queue add ${record.objective} (if it stopped unfinished, cancel it first with factory cancel --objective ${record.objective})`,
    );
  if (
    history.some(
      (entry) =>
        entry.kind === "project-queue-operation" &&
        entry.scope === scope &&
        entry.previousReceiptId === record.id &&
        !entry.beforeEffectFailure,
    )
  )
    throw new Error(
      "Project queue metadata was superseded or has an unresolved successor",
    );
  const last = record.effects.at(-1);
  if (
    !last ||
    last.intent.action === "ensure-card" ||
    (record.action === "admit"
      ? last.intent.action !== "set-admission-fields" ||
        last.intent.order !== record.order
      : last.intent.action !== "set-metadata") ||
    last.intent.itemId !== itemId ||
    last.intent.metadata !== text ||
    last.receipt?.kind !== "response"
  )
    throw new Error(
      "Project queue metadata has no exact original field-update receipt",
    );
  if (
    metadata.kind === "control"
      ? record.action !== "control"
      : record.action !== (metadata.state === "queued" ? "admit" : "withdraw")
  )
    throw new Error(
      "Project metadata role differs from its explicit original action",
    );
  return record;
}

/** Settlement consumes the same complete, exact field receipt as queue admission. */
function admissionEffect(
  config: FactoryConfig,
  history: QueueRecord[],
  admission: QueueOperation | undefined,
  historical = false,
): QueueOperation["effects"][number] | undefined {
  const effect = admission?.effects.at(-1);
  if (
    !admission?.metadata ||
    admission.action !== "admit" ||
    !effect ||
    !("itemId" in effect.intent) ||
    !effect.intent.itemId
  )
    return undefined;
  if (
    producer(
      config,
      history,
      admission.metadata,
      admission.scope,
      effect.intent.itemId,
      historical,
    ) !== admission ||
    !effect.original
  )
    throw new Error(
      "Project settlement lacks its complete original admission response",
    );
  return effect;
}
/** Pure claim/admission binding shared by stopped and cancelled settlement. */
export function assertProjectQueueClaimAdmission(
  config: FactoryConfig,
  history: QueueRecord[],
  claim: QueueOwnerClaim,
  state: Pick<ContinuationState, "objective" | "objectiveBodyDigest">,
  options: { historical?: boolean } = {},
): void {
  const admission = history.find(
    (record): record is QueueOperation =>
      record.kind === "project-queue-operation" &&
      record.id === claim.receiptId,
  );
  const metadata = admission?.metadata
    ? parseQueueMetadata(admission.metadata)
    : undefined;
  const effect = admissionEffect(
    config,
    history,
    admission,
    options.historical,
  );
  if (
    (!options.historical &&
      claim.authorityDigest !== factoryAuthorityDigest(config)) ||
    claim.bodyDigest !== state.objectiveBodyDigest ||
    !admission?.completed ||
    admission.action !== "admit" ||
    admission.objective !== state.objective ||
    admission.bodyDigest !== claim.bodyDigest ||
    admission.authorityDigest !== claim.authorityDigest ||
    JSON.stringify(admission.binding) !==
      JSON.stringify(config.queue?.project) ||
    metadata?.kind !== "admission" ||
    metadata.state !== "queued" ||
    metadata.admissionId !== claim.admissionId ||
    metadata.receiptId !== claim.receiptId ||
    effect?.intent.action !== "set-admission-fields" ||
    effect.intent.metadata !== admission.metadata ||
    effect.receipt?.kind !== "response" ||
    !effect.original
  )
    throw new Error(
      "Project settlement differs from its original authenticated admission receipt",
    );
}
function assertQueueHistorySettled(history: QueueRecord[]): void {
  if (
    history.some(
      (entry) =>
        entry.kind === "project-queue-operation" &&
        !entry.completed &&
        !entry.beforeEffectFailure,
    )
  )
    throw new Error(
      "A Project queue operation remains partial or unknown; preserve its original receipt and do not replay it",
    );
}
function verifiedControl(
  config: FactoryConfig,
  binding: ProjectQueueBinding,
  control: { itemId: string; metadata: string | null },
  history: QueueRecord[],
  historical: boolean,
): Extract<QueueMetadata, { kind: "control" }> {
  if (
    JSON.stringify(binding) !== JSON.stringify(config.queue?.project) ||
    control.itemId !== binding.controlItemId ||
    control.metadata === null
  )
    throw new Error(
      "Project queue control metadata is missing or differs from its binding",
    );
  producer(
    config,
    history,
    control.metadata,
    "control",
    control.itemId,
    historical,
  );
  const metadata = parseQueueMetadata(control.metadata);
  if (metadata.kind !== "control")
    throw new Error("Project control card contains admission metadata");
  return metadata;
}
/**
 * A finished or cancelled Objective whose owner claims are all settled can
 * never dispatch again: its admission is history, so a later configuration
 * change never requires withdrawing it (#1398). Claimed or unfinished work
 * keeps the exact current-authority check.
 */
function settledTerminalObjective(
  config: FactoryConfig,
  history: QueueRecord[],
  objective: number,
): boolean {
  if (
    history.some(
      (record) =>
        record.kind === "project-queue-owner" &&
        record.objective === objective &&
        !record.settled,
    )
  )
    return false;
  const state = readContinuation(config.repository, objective);
  return (
    !!state &&
    (!!state.cancelledAt ||
      (isExecutionState(state) && objectiveComplete(state)) ||
      splitSettled(state))
  );
}
function verifiedEntry(
  config: FactoryConfig,
  card: ProjectQueueTarget,
  history: QueueRecord[],
  historical: boolean,
  terminalHistory = false,
): VerifiedQueueEntry | undefined {
  if (card.repository !== config.repository)
    throw new Error("Project queue target belongs to another repository");
  if (card.archived) return undefined;
  if (card.metadata === null) return undefined;
  const metadata = parseQueueMetadata(card.metadata);
  const stale =
    terminalHistory &&
    metadata.kind === "admission" &&
    history.some(
      (record) =>
        record.kind === "project-queue-operation" &&
        record.id === metadata.receiptId &&
        record.authorityDigest !== factoryAuthorityDigest(config),
    );
  const operation = producer(
    config,
    history,
    card.metadata,
    card.issueNodeId,
    card.itemId,
    historical ||
      (metadata.kind === "admission" && metadata.state === "withdrawn") ||
      (stale && settledTerminalObjective(config, history, card.objective)),
  );
  if (
    metadata.kind !== "admission" ||
    operation.objective !== card.objective ||
    operation.issueNodeId !== card.issueNodeId ||
    operation.order !== card.order ||
    !Number.isSafeInteger(card.order) ||
    Number(card.order) < 1
  )
    throw new Error("Project queue card/order differs from original admission");
  return {
    objective: card.objective,
    itemId: card.itemId,
    issueNodeId: card.issueNodeId,
    admissionId: metadata.admissionId,
    receiptId: metadata.receiptId,
    bodyDigest: operation.bodyDigest!,
    authorityDigest: operation.authorityDigest,
    order: card.order!,
    state: metadata.state,
  };
}
export interface VerifiedQueueInspection {
  inspection: ProjectQueueInspection;
  history: QueueRecord[];
  control: Extract<QueueMetadata, { kind: "control" }> | undefined;
  uninitializedControl: boolean;
  entry?: VerifiedQueueEntry;
}
/** A bounded command observation never grants whole-queue dispatch authority. */
export function verifyQueueInspection(
  config: FactoryConfig,
  inspection: ProjectQueueInspection,
  history: QueueRecord[],
  options: { allowUninitializedControl?: boolean } = {},
): VerifiedQueueInspection {
  if (
    inspection.scope !== "target" ||
    !date(inspection.observedAt) ||
    !Number.isSafeInteger(inspection.actorId) ||
    inspection.actorId < 1
  )
    throw new Error("Invalid partial Project command inspection");
  assertQueueHistorySettled(history);
  const uninitializedControl = inspection.control.metadata === null;
  if (
    uninitializedControl &&
    (!options.allowUninitializedControl ||
      // A replacement control card under a new binding has no producer yet.
      history.some(
        (row) =>
          row.kind === "project-queue-operation" &&
          row.scope === "control" &&
          !row.beforeEffectFailure &&
          row.binding.controlItemId === inspection.binding.controlItemId,
      ) ||
      JSON.stringify(inspection.binding) !==
        JSON.stringify(config.queue?.project) ||
      inspection.control.itemId !== inspection.binding.controlItemId)
  )
    throw new Error(
      "Only an explicitly initial control with no original producer may be initialized",
    );
  const control = uninitializedControl
    ? undefined
    : verifiedControl(
        config,
        inspection.binding,
        inspection.control,
        history,
        true,
      );
  const entry = inspection.target
    ? verifiedEntry(config, inspection.target, history, true)
    : undefined;
  if (inspection.issue) {
    const issue = inspection.issue;
    if (
      issue.repository !== config.repository ||
      !issue.issueNodeId ||
      !Number.isSafeInteger(issue.objective) ||
      issue.objective < 1 ||
      typeof issue.body !== "string" ||
      !Array.isArray(inspection.membership) ||
      new Set(inspection.membership.map((row) => row.itemId)).size !==
        inspection.membership.length ||
      inspection.membership.length > 1
    )
      throw new Error(
        "Current Issue identity or complete bound Project membership is unavailable",
      );
    const member = inspection.membership[0];
    if (
      (inspection.target &&
        (inspection.target.issueNodeId !== issue.issueNodeId ||
          inspection.target.objective !== issue.objective ||
          !member ||
          member.itemId !== inspection.target.itemId ||
          member.archived !== inspection.target.archived)) ||
      (!inspection.target && member)
    )
      throw new Error(
        "Issue membership differs from the inspected exact target",
      );
  } else if (inspection.membership !== undefined)
    throw new Error("Project membership requires the current exact Issue");
  return {
    inspection,
    history,
    control,
    uninitializedControl,
    ...(entry ? { entry } : {}),
  };
}
/** Exact completed receipt identity, never cached Project membership or spending authority. */
export function retainedQueueEntry(
  config: FactoryConfig,
  history: QueueRecord[],
  objective: number,
): VerifiedQueueEntry | undefined {
  assertQueueHistorySettled(history);
  const candidates = history.filter(
    (record): record is QueueOperation =>
      record.kind === "project-queue-operation" &&
      record.completed === true &&
      ["admit", "withdraw"].includes(record.action) &&
      record.objective === objective &&
      !history.some(
        (next) =>
          next.kind === "project-queue-operation" &&
          next.scope === record.scope &&
          next.previousReceiptId === record.id &&
          !next.beforeEffectFailure,
      ),
  );
  if (candidates.length > 1)
    throw new Error("Retained admission has competing producers");
  const record = candidates[0];
  if (!record) return undefined;
  const last = record.effects.at(-1);
  if (
    !record.metadata ||
    !record.issueNodeId ||
    !last ||
    last.intent.action === "ensure-card" ||
    (record.action === "admit"
      ? last.intent.action !== "set-admission-fields" ||
        last.intent.order !== record.order
      : last.intent.action !== "set-metadata") ||
    !last.intent.itemId ||
    last.receipt?.kind !== "response"
  )
    throw new Error("Retained admission lacks its exact final response");
  return verifiedEntry(
    config,
    {
      itemId: last.intent.itemId,
      issueNodeId: record.issueNodeId,
      objective,
      repository: record.repository,
      metadata: record.metadata,
      order: record.order ?? null,
      archived: false,
    },
    history,
    true,
  );
}
/** Authenticated successful and uncertain allocations are never recycled. */
export function nextProjectQueueOrder(history: QueueRecord[]): number {
  const allocated = history.flatMap((record) =>
    record.kind === "project-queue-operation"
      ? [
          ...(record.completed && Number.isSafeInteger(record.order)
            ? [record.order!]
            : []),
          ...record.effects.flatMap((effect) =>
            effect.intent.action === "set-admission-fields"
              ? [effect.intent.order]
              : [],
          ),
          ...(record.commandRecipe?.effects.flatMap((effect) =>
            effect.action === "set-admission-fields" ? [effect.order] : [],
          ) ?? []),
        ]
      : [],
  );
  const next = Math.max(0, ...allocated) + 1;
  if (!Number.isSafeInteger(next))
    throw new Error("Project order exhausted its exact integer range");
  return next;
}
export function verifyQueueObservation(
  config: FactoryConfig,
  snapshot: ProjectQueueSnapshot,
  history: QueueRecord[],
): VerifiedQueueObservation {
  const control = verifiedControl(
    config,
    snapshot.binding,
    snapshot.control,
    history,
    false,
  );
  const entries = snapshot.cards.flatMap((card) => {
    if (card.archived) return [];
    const entry = verifiedEntry(config, card, history, false, true);
    return entry ? [entry] : [];
  });
  if (
    new Set(entries.map((entry) => entry.objective)).size !== entries.length ||
    new Set(entries.map((entry) => entry.order)).size !== entries.length ||
    new Set(entries.map((entry) => entry.admissionId)).size !== entries.length
  )
    throw new Error("Project queue has duplicate admission/order bindings");
  assertQueueHistorySettled(history);
  return {
    snapshot,
    history,
    control,
    entries: entries.sort((a, b) => a.order - b.order),
  };
}
/** Original completed responses supply stable identities only, never live queue values. */
export function queueObservationTargets(
  history: QueueRecord[],
): ProjectQueueKnownTarget[] {
  const targets = new Map<string, ProjectQueueKnownTarget>();
  for (const record of history) {
    if (
      record.kind !== "project-queue-operation" ||
      !record.completed ||
      record.scope === "control" ||
      record.objective === undefined ||
      record.issueNodeId === undefined
    )
      continue;
    for (const effect of record.effects) {
      if (!effect.receipt) continue;
      const target = {
        objective: record.objective,
        issueNodeId: record.issueNodeId,
        itemId: effect.receipt.itemId,
      };
      const previous = targets.get(target.itemId);
      if (previous && JSON.stringify(previous) !== JSON.stringify(target))
        throw new Error("Original Project target identity mappings conflict");
      targets.set(target.itemId, target);
    }
  }
  return [...targets.values()].sort((a, b) => a.itemId.localeCompare(b.itemId));
}

export async function observeProjectQueue(
  config: FactoryConfig,
  github: GitHubGateway,
): Promise<VerifiedQueueObservation> {
  const binding = config.queue?.project;
  if (!binding || !github.projectQueueRead)
    throw new Error(
      "The configured GitHub gateway cannot read the bound Project queue",
    );
  const history = await readQueueHistory(config);
  const snapshot = await github.projectQueueRead(
    binding,
    queueObservationTargets(history),
  );
  return verifyQueueObservation(config, snapshot, history);
}
export function createQueueOperation(
  config: FactoryConfig,
  fields: Pick<
    QueueOperation,
    "action" | "scope" | "previousReceiptId" | "approval"
  > &
    Partial<
      Pick<QueueOperation, "objective" | "issueNodeId" | "bodyDigest" | "order">
    >,
): QueueOperation {
  return {
    schemaVersion: 1,
    kind: "project-queue-operation",
    id: randomUUID(),
    repository: config.repository,
    binding: requireProjectQueueEffects(config),
    authorityDigest: factoryAuthorityDigest(config),
    at: new Date().toISOString(),
    ...fields,
    effects: [],
  };
}
function commandHeader(operation: QueueOperation): QueueOperationHeader {
  const {
    effects: _effects,
    completed: _completed,
    beforeEffectFailure: _failure,
    commandId: _command,
    commandRecipe: _recipe,
    ...header
  } = operation;
  return header;
}
function assertCommandRecipe(
  value: unknown,
  repository: string,
  ownerId: string,
): asserts value is QueueCommandRecipe {
  const recipe = object(value);
  only(recipe, [
    "schemaVersion",
    "id",
    "configDigest",
    "deadlineAt",
    "operations",
    "effects",
  ]);
  if (
    recipe.schemaVersion !== 1 ||
    recipe.id !== ownerId ||
    !digest(recipe.configDigest) ||
    !(recipe.deadlineAt === null || date(recipe.deadlineAt)) ||
    !Array.isArray(recipe.operations) ||
    !recipe.operations.length ||
    !Array.isArray(recipe.effects) ||
    !recipe.effects.length
  )
    throw new Error("Invalid complete Project queue command recipe");
  const operations = new Map<string, QueueOperation>();
  for (const raw of recipe.operations) {
    const header = object(raw);
    const parsed = parseQueueRecord(
      Buffer.from(JSON.stringify({ ...header, effects: [] })),
      repository,
      String(header.id),
    );
    if (
      parsed.kind !== "project-queue-operation" ||
      operations.has(parsed.id) ||
      JSON.stringify(commandHeader(parsed)) !== JSON.stringify(header)
    )
      throw new Error("Command operation headers must be complete and unique");
    operations.set(parsed.id, parsed);
  }
  if ([...operations.keys()][0] !== ownerId)
    throw new Error("Command owner must be its first declared operation");
  const first = operations.get(ownerId)!;
  if (
    [...operations.values()].some(
      (operation) =>
        operation.authorityDigest !== first.authorityDigest ||
        JSON.stringify(operation.binding) !== JSON.stringify(first.binding),
    )
  )
    throw new Error("Command configuration and field bindings differ");
  const previous = new Map<string, ProjectQueuePlannedEffect>(),
    counts = new Map<string, number>();
  let actor: number | undefined;
  for (const raw of recipe.effects) {
    assertProjectQueuePlannedEffect(raw, first.binding);
    const step = raw,
      operation = operations.get(step.operationId);
    if (
      !operation ||
      previous.has(step.requestId) ||
      (actor !== undefined && actor !== step.actorId)
    )
      throw new Error("Command effect identity, operation or actor differs");
    actor = step.actorId;
    const sameOperation = (id: string) => {
      const dependency = previous.get(id);
      if (!dependency || dependency.operationId !== step.operationId)
        throw new Error(
          "Command target dependency must precede it in the same operation",
        );
      return dependency;
    };
    if (
      step.action !== "ensure-card" &&
      "resultOf" in step.target &&
      sameOperation(step.target.resultOf).action !== "ensure-card"
    )
      throw new Error(
        "Generated card identity requires its declared earlier ensure original",
      );
    if ("resultOf" in step.prior) {
      const dependency = sameOperation(step.prior.resultOf);
      const earlier = [...previous.values()]
        .filter((v) => v.operationId === step.operationId)
        .at(-1);
      if (dependency !== earlier)
        throw new Error(
          "Target proof must be the immediately preceding actual original",
        );
    }
    if ("resultOf" in step.control) {
      const dependency = previous.get(step.control.resultOf);
      if (
        !dependency ||
        dependency.action !== "set-metadata" ||
        !("itemId" in dependency.target) ||
        dependency.target.itemId !== first.binding.controlItemId
      )
        throw new Error(
          "Control dependency must be its declared earlier control original",
        );
    }
    if (["admit", "roadmap"].includes(operation.action)) {
      if (
        JSON.stringify(step.expectedIssue) !==
        JSON.stringify({
          issueNodeId: operation.issueNodeId,
          objective: operation.objective,
          bodyDigest: operation.bodyDigest,
        })
      )
        throw new Error(
          "Command admission requires its exact approved Issue body",
        );
    } else if (step.expectedIssue !== undefined)
      throw new Error("Unexpected admission authority in command effect");
    if (
      (step.action === "ensure-card" &&
        step.issueNodeId !== operation.issueNodeId) ||
      (step.action === "set-metadata" &&
        (step.metadata !== operation.metadata ||
          step.fieldId !== first.binding.metadataFieldId)) ||
      (step.action === "set-admission-fields" &&
        (operation.action !== "admit" ||
          step.order !== operation.order ||
          step.metadata !== operation.metadata ||
          step.orderFieldId !== first.binding.orderFieldId ||
          step.metadataFieldId !== first.binding.metadataFieldId)) ||
      (operation.action === "control" &&
        (step.action !== "set-metadata" ||
          !("itemId" in step.target) ||
          step.target.itemId !== first.binding.controlItemId)) ||
      (operation.action === "withdraw" && step.action !== "set-metadata")
    )
      throw new Error(
        "Command effect differs from its immutable operation header",
      );
    counts.set(operation.id, (counts.get(operation.id) ?? 0) + 1);
    if (counts.get(operation.id)! > 3)
      throw new Error("Command exceeds its existing operation effect schema");
    previous.set(step.requestId, step);
  }
  for (const operation of operations.values()) {
    const steps = [...previous.values()].filter(
      (step) => step.operationId === operation.id,
    );
    const actualActions = steps.map((step) => step.action);
    const actions =
      operation.action === "admit"
        ? ["ensure-card", "set-admission-fields"]
        : operation.action === "roadmap"
          ? ["ensure-card"]
          : ["set-metadata"];
    if (JSON.stringify(actualActions) !== JSON.stringify(actions))
      throw new Error(
        "Command must declare every admission effect and operation",
      );
  }
}
/** Cross-record original facts; incomplete recipes never grant dispatch authority. */
export function assertQueueCommandHistory(
  history: QueueRecord[],
  readReference: (reference: ContentRef) => Uint8Array,
): void {
  const operations = new Map(
    history
      .filter(
        (row): row is QueueOperation => row.kind === "project-queue-operation",
      )
      .map((row) => [row.id, row]),
  );
  for (const row of operations.values()) {
    const owner = row.commandId ? operations.get(row.commandId) : undefined;
    if (!owner?.commandRecipe)
      throw new Error("Command member lacks its exact original recipe owner");
    assertCommandRecipe(owner.commandRecipe, owner.repository, owner.id);
    const recipe = owner.commandRecipe,
      members = recipe.operations.map((header) => operations.get(header.id));
    if (
      members.some(
        (member, index) =>
          member &&
          (member.commandId !== owner.id ||
            JSON.stringify(commandHeader(member)) !==
              JSON.stringify(recipe.operations[index])),
      )
    )
      throw new Error("Command member changed its frozen original header");
    if (
      row.id !== owner.id &&
      !recipe.operations.some((header) => header.id === row.id)
    )
      throw new Error(
        "Operation was appended to a previously declared command",
      );
    if (row.id !== owner.id) continue;
    for (const member of members) {
      if (!member) continue;
      const declared = recipe.effects.filter(
        (step) => step.operationId === member.id,
      );
      if (
        member.effects.length > declared.length ||
        member.effects.some(
          (effect, index) =>
            effect.intent.requestId !== declared[index]?.requestId,
        )
      )
        throw new Error(
          "Retained command effects changed their declared order",
        );
    }
    const receipts: ProjectQueueWriteReceipt[] = [];
    let pending = false;
    for (const step of recipe.effects) {
      const operation = operations.get(step.operationId),
        effect = operation?.effects.find(
          (v) => v.intent.requestId === step.requestId,
        );
      if (!effect) {
        pending = true;
        continue;
      }
      if (pending)
        throw new Error(
          "Command effect skipped an unresolved earlier declaration",
        );
      const concrete = resolveProjectQueuePlannedEffect(
        owner.binding,
        step,
        receipts,
      );
      if (
        effect.intent.actorId !== step.actorId ||
        JSON.stringify(effect.intent.request) !==
          JSON.stringify(concrete.request) ||
        Object.entries(concrete.action).some(
          ([key, value]) => object(effect.intent)[key] !== value,
        )
      )
        throw new Error(
          "Concrete Project intent differs from its exact declared recipe",
        );
      if (!effect.receipt || !effect.original) {
        pending = true;
        continue;
      }
      const bytes = readReference(effect.original);
      if (
        bytes.byteLength !== effect.original.bytes ||
        createHash("sha256").update(bytes).digest("hex") !==
          effect.original.digest
      )
        throw new Error("Command response original changed its exact bytes");
      const receipt = {
        ...effect.receipt,
        original: JSON.parse(Buffer.from(bytes).toString("utf8")),
      };
      assertProjectQueueWriteReceipt(receipt);
      if (step.action === "set-admission-fields") {
        const target = projectQueueReceiptTarget(receipt);
        if (
          target.issueNodeId !== step.expectedIssue?.issueNodeId ||
          target.objective !== step.expectedIssue?.objective
        )
          throw new Error(
            "Compound admission original differs from its approved Issue identity",
          );
      }
      receipts.push(receipt);
    }
    for (const member of members)
      if (
        member &&
        member.effects.some(
          (effect) =>
            !recipe.effects.some(
              (step) =>
                step.operationId === member.id &&
                step.requestId === effect.intent.requestId,
            ),
        )
      )
        throw new Error("Undeclared effect was appended to a command");
    if (
      members.some((member) => member?.completed) &&
      (pending || members.some((member) => !member))
    )
      throw new Error(
        "Command completion requires every declared original response",
      );
  }
}
const queueCommandOwners = new WeakMap<
  QueueCommand,
  {
    recipe: string;
    admitted: boolean;
    index: number;
    receipts: ProjectQueueWriteReceipt[];
    stopped: boolean;
  }
>();
/** A planned singleton control write is not an actual intent. */
function zeroIntentControl(operation: QueueOperation): boolean {
  const recipe = operation.commandRecipe;
  return (
    operation.action === "control" &&
    operation.scope === "control" &&
    !operation.completed &&
    operation.effects.length === 0 &&
    operation.commandId === operation.id &&
    recipe?.id === operation.id &&
    recipe.operations.length === 1 &&
    recipe.effects.length === 1 &&
    JSON.stringify(recipe.operations[0]) ===
      JSON.stringify(commandHeader(operation)) &&
    recipe.effects[0]!.operationId === operation.id &&
    recipe.effects[0]!.action === "set-metadata" &&
    "itemId" in recipe.effects[0]!.target &&
    recipe.effects[0]!.target.itemId === operation.binding.controlItemId
  );
}
function retainUnadmittedControlFailure(
  operation: QueueOperation,
  error: Record<string, unknown>,
): void {
  if (!zeroIntentControl(operation) || operation.beforeEffectFailure)
    throw new Error(
      "Only an unchanged singleton unadmitted control may fail permanently",
    );
  const store = new LocalContentStore(
    join(stateRoot(operation.repository), "content"),
  );
  const put = (bytes: Buffer) =>
    store.putBytes(bytes, { mediaType: "application/json" });
  const path = join(
    stateRoot(operation.repository),
    "project-queue-history",
    `${operation.id}.json`,
  );
  const original = privateBytes(path);
  if (
    JSON.stringify(
      parseQueueRecord(original, operation.repository, operation.id),
    ) !== JSON.stringify(operation)
  )
    throw new Error("Stopped control differs from its original header");
  const directory = dirname(fileURLToPath(import.meta.url));
  operation.beforeEffectFailure = {
    schemaVersion: 1,
    at: new Date().toISOString(),
    originalOperation: put(original),
    checkpoint: put(
      privateBytes(
        join(stateRoot(operation.repository), "recovery", "checkpoint.json"),
      ),
    ),
    error: put(Buffer.from(JSON.stringify(error))),
    sources: [
      "project-queue-state.js",
      "github-project-queue.js",
      "intake.js",
    ].map((path) => ({
      path,
      ref: put(
        Buffer.from(
          JSON.stringify(readFileSync(join(directory, path), "utf8")),
        ),
      ),
    })),
  };
  assertQueueOperationReferenceBodies(operation, (ref) => store.readBytes(ref));
  save(operation);
}

export function createQueueCommand(
  config: FactoryConfig,
  input: {
    operations: QueueOperation[];
    effects: ProjectQueuePlannedEffect[];
    deadlineAt: string | null;
  },
): QueueCommand {
  assertProcessActive();
  requireProjectQueueEffects(config);
  if (
    !input.operations.length ||
    input.operations.some(
      (operation) =>
        operation.effects.length ||
        operation.completed ||
        operation.commandId ||
        operation.beforeEffectFailure ||
        operation.repository !== config.repository ||
        operation.authorityDigest !== factoryAuthorityDigest(config) ||
        JSON.stringify(operation.binding) !==
          JSON.stringify(config.queue?.project) ||
        existsSync(
          join(
            stateRoot(config.repository),
            "project-queue-history",
            operation.id + ".json",
          ),
        ),
    )
  )
    throw new Error(
      "Only fresh complete operations can declare a new command; historical recipes cannot replay",
    );
  if (input.deadlineAt !== (currentProcessDeadlineAt() ?? null))
    throw new Error(
      "Command must retain its original armed deadline, including an undeclared deadline",
    );
  const recipe: QueueCommandRecipe = {
    schemaVersion: 1,
    id: input.operations[0]!.id,
    configDigest: factoryConfigDigest(config),
    deadlineAt: input.deadlineAt,
    operations: input.operations.map((operation) =>
      structuredClone(commandHeader(operation)),
    ),
    effects: structuredClone(input.effects),
  };
  assertCommandRecipe(recipe, config.repository, recipe.id);
  for (const operation of input.operations) operation.commandId = recipe.id;
  input.operations[0]!.commandRecipe = recipe;
  for (const operation of input.operations) save(operation);
  const command = { operations: input.operations, recipe };
  queueCommandOwners.set(command, {
    recipe: JSON.stringify(recipe),
    admitted: false,
    index: 0,
    receipts: [],
    stopped: false,
  });
  return command;
}
function ownQueueCommand(config: FactoryConfig, command: QueueCommand) {
  assertProcessActive();
  const owner = queueCommandOwners.get(command);
  if (
    !owner ||
    owner.stopped ||
    owner.recipe !== JSON.stringify(command.recipe) ||
    command.recipe.configDigest !== factoryConfigDigest(config) ||
    command.recipe.deadlineAt !== (currentProcessDeadlineAt() ?? null)
  )
    throw new Error(
      "Original creating command, configuration and deadline are required; never replay a historical recipe",
    );
  if (
    command.operations.length !== command.recipe.operations.length ||
    command.operations.some(
      (operation, index) =>
        operation.id !== command.recipe.operations[index]?.id ||
        operation.commandId !== command.recipe.id,
    )
  )
    throw new Error(
      "Live command must retain every original operation in its declared order",
    );
  for (const operation of command.operations) {
    const original = parseQueueRecord(
      privateBytes(
        join(
          stateRoot(config.repository),
          "project-queue-history",
          operation.id + ".json",
        ),
      ),
      config.repository,
      operation.id,
    );
    if (
      original.kind !== "project-queue-operation" ||
      JSON.stringify(original) !== JSON.stringify(operation)
    )
      throw new Error(
        "Current command differs from its original retained operation",
      );
  }
  const store = new LocalContentStore(
    join(stateRoot(config.repository), "content"),
  );
  assertQueueCommandHistory(command.operations, (ref) => store.readBytes(ref));
  return owner;
}
export async function admitQueueCommand(
  config: FactoryConfig,
  command: QueueCommand,
): Promise<void> {
  const owner = ownQueueCommand(config, command);
  if (owner.admitted || owner.index)
    throw new Error("Command admission cannot replay");
  try {
    await awaitCheckpointAdmission(config.repository, "before-effect");
    assertProcessActive();
    owner.admitted = true;
  } catch (error) {
    owner.stopped = true;
    if (
      command.operations.length === 1 &&
      zeroIntentControl(command.operations[0]!)
    )
      try {
        retainUnadmittedControlFailure(command.operations[0]!, {
          kind: "creating-owner-before-command-refusal",
          boundary: "before-effect",
          knownNotDispatched: true,
          name: error instanceof Error ? error.name : "ThrownValue",
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? (error.stack ?? null) : null,
        });
      } catch (retentionError) {
        throw new AggregateError(
          [error, retentionError],
          "Unadmitted control failure and its original retention remain unresolved",
          { cause: error },
        );
      }
    throw error;
  }
}
/**
 * What a creating command's own retained operations establish, read back from
 * their authenticated private files. A completed command has every declared
 * original response; archive durability is a separate fact.
 */
export function retainedQueueCommandOutcome(
  config: FactoryConfig,
  commandId: string,
):
  | {
      commandId: string;
      operations: { id: string; action: string; objective?: number }[];
    }
  | undefined {
  const directory = join(stateRoot(config.repository), "project-queue-history");
  const read = (id: string) => {
    const record = parseQueueRecord(
      privateBytes(join(directory, `${id}.json`)),
      config.repository,
      id,
    );
    if (record.kind !== "project-queue-operation")
      throw new Error("Retained queue command member is not an operation");
    return record;
  };
  const recipe = read(commandId).commandRecipe;
  if (!recipe) return undefined;
  const operations = recipe.operations.map((header) => read(header.id));
  if (
    operations.some(
      (operation) => operation.commandId !== commandId || !operation.completed,
    )
  )
    return undefined;
  return {
    commandId,
    operations: operations.map((operation) => ({
      id: operation.id,
      action: operation.action,
      ...(operation.objective === undefined
        ? {}
        : { objective: operation.objective }),
    })),
  };
}
export async function performQueueCommandEffect(
  config: FactoryConfig,
  github: GitHubGateway,
  command: QueueCommand,
  index: number,
  observation?: ProjectQueueInspection | ProjectQueueWriteReceipt,
): Promise<ProjectQueueWriteReceipt> {
  const owner = ownQueueCommand(config, command);
  if (
    !owner.admitted ||
    index !== owner.index ||
    !command.recipe.effects[index]
  )
    throw new Error(
      "Only the next already acknowledged declared effect may execute",
    );
  const step = command.recipe.effects[index]!,
    operation = command.operations.find((v) => v.id === step.operationId)!;
  const concrete = resolveProjectQueuePlannedEffect(
    operation.binding,
    step,
    owner.receipts,
  );
  try {
    const receipt = await performQueueEffect(
      config,
      github,
      operation,
      concrete.action,
      concrete.expectedTarget,
      observation,
      { command, index },
    );
    owner.receipts.push(structuredClone(receipt));
    owner.index++;
    return receipt;
  } catch (error) {
    owner.stopped = true;
    throw error;
  }
}
export async function completeQueueCommand(
  config: FactoryConfig,
  command: QueueCommand,
): Promise<void> {
  const owner = ownQueueCommand(config, command);
  if (
    !owner.admitted ||
    owner.index !== command.recipe.effects.length ||
    command.operations.some((operation) =>
      operation.effects.some(
        (effect) =>
          !effect.receipt || !effect.original || effect.rejectedOriginal,
      ),
    )
  )
    throw new Error(
      "Terminal command acknowledgment requires every declared fulfilled original",
    );
  owner.stopped = true;
  for (const operation of command.operations) {
    operation.completed = true;
    save(operation);
  }
  await awaitCheckpointAdmission(config.repository, "explicit");
}
async function performQueueEffect(
  config: FactoryConfig,
  github: GitHubGateway,
  operation: QueueOperation,
  action: ProjectQueueAction,
  expectedTarget: ProjectQueueExpectedTarget | undefined,
  observation: ProjectQueueInspection | ProjectQueueWriteReceipt | undefined,
  commandEffect: { command: QueueCommand; index: number },
): Promise<ProjectQueueWriteReceipt> {
  requireProjectQueueEffects(config);
  if (
    ["admit", "roadmap"].includes(operation.action) &&
    (!operation.issueNodeId || !operation.objective || !operation.bodyDigest)
  )
    throw new Error(
      "Project admission requires its complete current Issue identity",
    );
  if (
    operation.completed ||
    operation.beforeEffectFailure ||
    !github.projectQueueWrite ||
    operation.effects.some((effect) => !effect.receipt)
  )
    throw new Error(
      "Project queue write is unavailable or held by an unknown prior effect",
    );
  const commandOwner = ownQueueCommand(config, commandEffect.command);
  const planned = commandEffect.command.recipe.effects[commandEffect.index];
  if (
    !planned ||
    !commandOwner.admitted ||
    commandOwner.index !== commandEffect.index ||
    planned.operationId !== operation.id
  )
    throw new Error(
      "Grouped effects require the actual admitted creating command",
    );
  const requestId = planned.requestId;
  const store = new LocalContentStore(
    join(stateRoot(config.repository), "content"),
  );
  let retained: QueueEffect | undefined;
  try {
    const returned = await github.projectQueueWrite({
      ...action,
      binding: operation.binding,
      requestId,
      plannedEffect: planned,
      dependencyReceipts: commandOwner.receipts,
      ...(expectedTarget ? { expectedTarget } : {}),
      ...(observation ? { observation } : {}),
      ...(["admit", "roadmap"].includes(operation.action) &&
      operation.issueNodeId &&
      operation.objective &&
      operation.bodyDigest
        ? {
            expectedIssue: {
              issueNodeId: operation.issueNodeId,
              objective: operation.objective,
              bodyDigest: operation.bodyDigest,
            },
          }
        : {}),
      beforeWrite: async (intent) => {
        assertProjectQueueIntent(intent);
        if (
          intent.requestId !== requestId ||
          JSON.stringify(intent.binding) !== JSON.stringify(operation.binding)
        )
          throw new Error("Project queue adapter intent differs");
        retained = { intent };
        operation.effects.push(retained);
        save(operation);
        const concrete = resolveProjectQueuePlannedEffect(
          operation.binding,
          planned,
          commandOwner.receipts,
        );
        if (
          intent.actorId !== planned.actorId ||
          JSON.stringify(intent.request) !== JSON.stringify(concrete.request) ||
          Object.entries(concrete.action).some(
            ([key, value]) => object(intent)[key] !== value,
          )
        )
          throw new Error(
            "Adapter intent differs from its acknowledged command recipe",
          );
        assertProcessActive();
      },
    });
    assertProjectQueueWriteReceipt(returned);
    if (returned.kind === "existing-read") {
      if (action.action !== "ensure-card" || retained)
        throw new Error(
          "Existing Project observation cannot settle a submitted effect",
        );
      retained = { intent: returned.intent };
      operation.effects.push(retained);
    }
    if (
      !retained ||
      JSON.stringify(retained.intent) !== JSON.stringify(returned.intent)
    )
      throw new Error("Project queue response differs from retained effect");
    const { original, ...receipt } = returned;
    retained.original = store.putBytes(Buffer.from(JSON.stringify(original)), {
      mediaType: "application/json",
    });
    retained.receipt = receipt;
    // Retain every original locally. Group completion acknowledges all declared
    // responses together.
    save(operation);
    return returned;
  } catch (error) {
    if (
      retained &&
      error &&
      typeof error === "object" &&
      "original" in error &&
      error.original !== undefined
    ) {
      retained.rejectedOriginal = store.putBytes(
        Buffer.from(JSON.stringify(error.original)),
        { mediaType: "application/json" },
      );
      save(operation);
    }
    throw error;
  }
}
export async function claimProjectQueueRun(
  config: FactoryConfig,
  github: GitHubGateway,
  objective: number,
  ownerToken: string,
  snapshot?: ContinuationState,
  recoveryLock?: ControllerLock,
): Promise<QueueOwnerClaim | undefined> {
  if (!config.queue?.project) return;
  assertProcessActive();
  const enteredAt = Date.now();
  requireProjectQueueEffects(config);
  if (snapshot) assertRestoredContinuationReady(snapshot, config);
  if (snapshot && !continuationConfigurationMatches(snapshot, config))
    throw new Error(
      "Existing execution configuration differs; if this Objective started with another provider, continue it from that provider's host or with its foreground run; otherwise use supported reconciliation without renewing admission or allowances",
    );
  // Existing archive without this host's verified baseline cannot be overwritten.
  await awaitCheckpointAdmission(config.repository, "explicit");
  let observed = await observeProjectQueue(config, github);
  const approvedEntry = (current: typeof observed) => {
    const entry = current.entries.find(
      (candidate) =>
        candidate.objective === objective && candidate.state === "queued",
    );
    const card = current.snapshot.cards.find(
      (candidate) => !candidate.archived && candidate.objective === objective,
    );
    if (
      current.control.mode !== "running" ||
      !entry ||
      card?.state !== "open" ||
      queueDigest(card.body) !== entry.bodyDigest
    )
      throw new Error(
        `Foreground and queue dispatch require a current open, exact-content approved Project admission and running control; use factory queue add ${objective}, or factory queue resume for an intentionally paused queue`,
      );
    // Historical admissions of settled terminal Objectives never dispatch.
    if (entry.authorityDigest !== factoryAuthorityDigest(config))
      throw new Error(
        `Objective #${objective} was admitted under a different queue authority; withdraw and re-add it with factory queue remove ${objective} and factory queue add ${objective}`,
      );
    return entry;
  };
  let entry = approvedEntry(observed);
  if (
    snapshot &&
    recoveryLock &&
    observed.history.some(
      (record) => record.kind === "project-queue-owner" && !record.settled,
    )
  ) {
    if (recoveryLock.token !== ownerToken)
      throw new Error(
        "Recovery owner differs from the current controller lock",
      );
    await settleStoppedProjectQueueRun(config, snapshot, recoveryLock);
    // Settlement acknowledges only old ownership. Fresh Project authority is
    // still required before a new claim for the exact same continuation.
    observed = await observeProjectQueue(config, github);
    entry = approvedEntry(observed);
  }
  // A refused plan's run ended before projection; the next run plans afresh.
  const prior = observed.history.filter(
    (record): record is QueueOwnerClaim =>
      record.kind === "project-queue-owner" &&
      record.objective === objective &&
      !record.settled?.refusal,
  );
  if (
    observed.history.some(
      (record) => record.kind === "project-queue-owner" && !record.settled,
    )
  )
    throw new Error(
      "This Project admission has an unfinished or foreign owner; supported resource reconciliation is required before dispatch",
    );
  const started = prior.filter((claim) => !claim.settled?.reservationFailure);
  if (
    started.length &&
    (!snapshot ||
      started.some(
        (claim) =>
          (claim.settled?.runId ?? claim.priorRunId) !== snapshot.runId,
      ))
  )
    throw new Error(
      "A prior Objective run exists; restore its exact continuation before dispatch, preserving its original results and spent allowances",
    );
  const recorded = prior.at(0)?.deadlineAt;
  if (prior.some((claim) => claim.deadlineAt !== recorded))
    throw new Error("Historical Objective deadlines differ; dispatch is held");
  const deadlineAt =
    recorded !== undefined
      ? recorded
      : snapshot
        ? (snapshot.coordinator?.deadlineAt ?? null)
        : config.queue?.objectiveDeadlineSeconds === undefined
          ? null
          : new Date(
              enteredAt + config.queue.objectiveDeadlineSeconds * 1000,
            ).toISOString();
  if (
    snapshot &&
    recorded !== undefined &&
    recorded !== (snapshot.coordinator?.deadlineAt ?? null)
  )
    throw new Error(
      "Project admission deadline differs from its original continuation",
    );
  if (deadlineAt !== null && Date.parse(deadlineAt) <= Date.now())
    throw new Error(
      "Project admission's frozen deadline elapsed; it cannot be renewed",
    );
  const claim: QueueOwnerClaim = {
    schemaVersion: 1,
    kind: "project-queue-owner",
    id: randomUUID(),
    repository: config.repository,
    authorityDigest: factoryAuthorityDigest(config),
    admissionId: entry.admissionId,
    receiptId: entry.receiptId,
    objective,
    bodyDigest: entry.bodyDigest,
    ownerTokenDigest: queueDigest(ownerToken),
    ownerProcess: creatingClaimOwner(config, objective, ownerToken),
    at: new Date().toISOString(),
    deadlineAt,
    ...(snapshot ? { priorRunId: snapshot.runId } : {}),
  };
  assertProcessActive();
  save(claim);
  try {
    await awaitCheckpointAdmission(config.repository, "before-effect");
    await assertProjectQueueRunLive(config, github, claim);
  } catch (error) {
    if (!snapshot) {
      try {
        await settleFailedProjectQueueReservation(
          config,
          claim,
          ownerToken,
          error,
        );
      } catch (settlementError) {
        throw new AggregateError(
          [error, settlementError],
          "Pre-snapshot Project admission and its same-owner settlement failed",
          { cause: error },
        );
      }
    }
    throw error;
  }
  return claim;
}

function creatingClaimOwner(
  config: FactoryConfig,
  objective: number,
  token: string,
): QueueOwnerClaim["ownerProcess"] {
  const identity = ownIdentity();
  const owner = [
    objectiveLockPath(config.repository, objective),
    installationLockPath(config.repository),
  ]
    .map((path) => readControllerOwner(path))
    .find((record) => record?.token === token);
  if (
    !owner ||
    owner.pid !== identity.pid ||
    owner.startTime !== identity.startTime ||
    owner.objective !== objective
  )
    throw new Error(
      "Project claim requires its actual creating controller lease",
    );
  return { ...identity, namespace: readlinkSync("/proc/self/ns/pid") };
}

/** The creating controller has not started canonical work or any provider when this fails. */
export async function settleFailedProjectQueueReservation(
  config: FactoryConfig,
  claim: QueueOwnerClaim,
  ownerToken: string,
  error: unknown,
): Promise<void> {
  requireProjectQueueEffects(config);
  const owner = creatingClaimOwner(config, claim.objective, ownerToken);
  if (
    JSON.stringify(owner) !== JSON.stringify(claim.ownerProcess) ||
    claim.ownerTokenDigest !== queueDigest(ownerToken) ||
    claim.authorityDigest !== factoryAuthorityDigest(config) ||
    claim.priorRunId ||
    claim.runBinding ||
    claim.settled ||
    readContinuation(config.repository, claim.objective) ||
    hasUnresolvedSubprocesses()
  )
    throw new Error(
      "Pre-snapshot settlement requires the same creating owner and settled resources; historical or started work remains held",
    );
  const path = join(
    stateRoot(config.repository),
    "project-queue-history",
    `${claim.id}.json`,
  );
  const original = privateBytes(path);
  if (
    JSON.stringify(parseQueueRecord(original, claim.repository, claim.id)) !==
    JSON.stringify(claim)
  )
    throw new Error(
      "Pre-snapshot settlement differs from its retained original claim",
    );
  const store = new LocalContentStore(
    join(stateRoot(config.repository), "content"),
  );
  const originalClaim = store.putBytes(original, {
    mediaType: "application/json",
  });
  const failure = store.putBytes(
    Buffer.from(
      JSON.stringify(
        error instanceof Error ? (error.stack ?? error.message) : String(error),
      ),
    ),
    { mediaType: "application/json" },
  );
  claim.settled = {
    at: new Date().toISOString(),
    disposition: "quiescent",
    reservationFailure: { schemaVersion: 1, originalClaim, failure },
  };
  save(claim);
  await awaitCheckpointAdmission(config.repository, "explicit");
}

/** A fresh read can hold an actual owner; it never grants or releases ownership. */
export async function assertProjectQueueRunLive(
  config: FactoryConfig,
  github: GitHubGateway,
  claim: QueueOwnerClaim,
): Promise<void> {
  const observed = await observeProjectQueue(config, github);
  const entry = observed.entries.find(
    (candidate) =>
      candidate.admissionId === claim.admissionId &&
      candidate.receiptId === claim.receiptId &&
      candidate.state === "queued",
  );
  const card =
    entry &&
    observed.snapshot.cards.find(
      (candidate) => candidate.itemId === entry.itemId,
    );
  const retained = observed.history.find(
    (record) => record.kind === "project-queue-owner" && record.id === claim.id,
  );
  if (
    observed.control.mode !== "running" ||
    !entry ||
    card?.state !== "open" ||
    queueDigest(card.body) !== claim.bodyDigest ||
    !retained ||
    retained.kind !== "project-queue-owner" ||
    retained.settled ||
    retained.ownerTokenDigest !== claim.ownerTokenDigest
  )
    throw new Error(
      "The owned Project admission is unavailable, changed, paused or draining; retain its original claim and use supported queue reconciliation",
    );
}
/** Only the actual owning controller calls this after its existing resource check. */
export async function settleProjectQueueRun(
  config: FactoryConfig,
  claim: QueueOwnerClaim,
  ownerToken: string,
  runId?: string,
): Promise<void> {
  if (claim.ownerTokenDigest !== queueDigest(ownerToken) || claim.settled)
    throw new Error(
      "Project admission settlement differs from its actual owner",
    );
  claim.settled = {
    at: new Date().toISOString(),
    disposition: "quiescent",
    ...(runId ? { runId } : {}),
  };
  save(claim);
  await awaitCheckpointAdmission(config.repository, "explicit");
}

/** Freeze the literal first canonical snapshot before the controller admits work. */
export function bindProjectQueueRun(
  config: FactoryConfig,
  claim: QueueOwnerClaim,
  ownerToken: string,
  state: ContinuationState,
): void {
  if (
    claim.settled ||
    claim.ownerTokenDigest !== queueDigest(ownerToken) ||
    state.repository !== config.repository ||
    state.objective !== claim.objective ||
    !continuationConfigurationMatches(state, config) ||
    state.objectiveBodyDigest !== claim.bodyDigest ||
    (state.coordinator?.deadlineAt ?? null) !== claim.deadlineAt ||
    (claim.priorRunId !== undefined && claim.priorRunId !== state.runId)
  )
    throw new Error("Project producer cannot bind a different continuation");
  if (claim.runBinding) {
    if (claim.runBinding.runId !== state.runId)
      throw new Error("Project producer run binding cannot change");
    return;
  }
  const bytes = readFileSync(statePath(config.repository, state.objective));
  const original = parsePortableContinuation(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    config.repository,
    state.objective,
  );
  if (JSON.stringify(original) !== JSON.stringify(state))
    throw new Error(
      "Project producer requires the saved original canonical snapshot",
    );
  const store = new LocalContentStore(
    join(stateRoot(config.repository), "content"),
  );
  claim.runBinding = {
    schemaVersion: 1,
    runId: state.runId,
    initialSnapshot: store.putBytes(bytes, { mediaType: "application/json" }),
  };
  save(claim);
}

function assertCeased(pid: number, startTime: string): void {
  const current = linuxProcessIdentity(pid);
  if (
    (current?.startTime === startTime && current.state !== "Z") ||
    processGroupExists(pid)
  )
    throw new Error(
      "Original Project controller or local worker remains active or uncertain",
    );
}

function assertClaimOwnerCeased(claim: QueueOwnerClaim): void {
  const originalOwner = claim.ownerProcess;
  if (
    originalOwner.namespace !== readlinkSync("/proc/self/ns/pid") ||
    hasUnresolvedSubprocesses()
  )
    throw new Error(
      "Stopped Project handoff requires the original source-host namespace and settled subprocess ownership",
    );
  assertCeased(originalOwner.pid, originalOwner.startTime);
}

async function unfinishedObjectiveClaims(
  config: FactoryConfig,
  objective: number,
): Promise<QueueOwnerClaim[]> {
  return (await readQueueHistory(config)).filter(
    (record): record is QueueOwnerClaim =>
      record.kind === "project-queue-owner" &&
      record.objective === objective &&
      !record.settled,
  );
}

/**
 * A plan refusal may follow a run that stopped without settling its claim.
 * `check` only authenticates that its original controller has ceased, before
 * any refusal effect; otherwise the stopped claim is handed off under the
 * stopped-run rules, before the refusal disposes planner storage.
 */
export async function handOffStoppedRefusal(
  config: FactoryConfig,
  state: ContinuationState,
  lock: ControllerLock,
  check = false,
): Promise<void> {
  if (!config.queue?.project) return;
  const unfinished = await unfinishedObjectiveClaims(config, state.objective);
  if (!unfinished.length) return;
  if (check) for (const claim of unfinished) assertClaimOwnerCeased(claim);
  else await settleStoppedProjectQueueRun(config, state, lock);
}

/** Neutral stopped-owner handoff; never cancels, resumes or retries the original run. */
export async function settleStoppedProjectQueueRun(
  config: FactoryConfig,
  state: ContinuationState,
  lock: ControllerLock,
): Promise<void> {
  requireProjectQueueEffects(config);
  assertStoppedClaimState(state);
  if (
    state.repository !== config.repository ||
    !continuationConfigurationMatches(state, config)
  )
    throw new Error("Stopped Project handoff configuration differs");
  const lockPath = objectiveLockPath(config.repository, state.objective);
  const assertOwner = () => {
    const identity = linuxProcessIdentity(process.pid);
    const owner = [lockPath, installationLockPath(config.repository)]
      .map((path) => readControllerOwner(path))
      .find((candidate) => candidate?.token === lock.token);
    if (
      !identity ||
      !owner ||
      owner.token !== lock.token ||
      owner.pid !== process.pid ||
      owner.startTime !== identity.startTime ||
      owner.objective !== state.objective
    )
      throw new Error(
        "Stopped Project handoff requires its actual exclusive recovery owner",
      );
    return owner;
  };
  assertOwner();
  await awaitCheckpointAdmission(config.repository, "explicit");
  const history = await readQueueHistory(config);
  if (
    history.some(
      (record) =>
        record.kind === "project-queue-operation" &&
        !record.completed &&
        !record.beforeEffectFailure,
    )
  )
    throw new Error(
      "Stopped Project handoff cannot settle an unfinished queue mutation",
    );
  const pending = history.filter(
    (record): record is QueueOwnerClaim =>
      record.kind === "project-queue-owner" && !record.settled,
  );
  if (!pending.length) return;
  if (pending.length !== 1 || pending[0]!.objective !== state.objective)
    throw new Error("Stopped Project handoff has competing unfinished claims");
  const claim = pending[0]!;
  // Execution and planning hand off under the same rule: the original
  // controller and every local process it owned have ceased on this host.
  assertClaimOwnerCeased(claim);
  if (isExecutionState(state)) {
    for (const work of Object.values(state.work).flatMap((entry) => [
      entry,
      ...(entry.recovery?.history ?? []).map((history) => history.work),
    ])) {
      const data = work.execution?.data as
        | { handle?: { data?: { pid?: number; startTime?: string } } }
        | undefined;
      if (!work.execution) continue;
      if (
        work.execution.provider !== "local" ||
        !Number.isSafeInteger(data?.handle?.data?.pid) ||
        !data?.handle?.data?.startTime
      )
        throw new Error(
          "Stopped Project handoff has unsupported local resource ownership",
        );
      assertCeased(data.handle!.data!.pid!, data.handle!.data!.startTime!);
    }
  }
  if (
    !claim.runBinding ||
    claim.runBinding.runId !== state.runId ||
    claim.deadlineAt !== (state.coordinator?.deadlineAt ?? null)
  )
    throw new Error(
      "Stopped handoff differs from its original Project run binding",
    );
  assertProjectQueueClaimAdmission(config, history, claim, state);
  const archive = await readVerifiedRecoveryCheckpoint(config);
  const snapshotFile = archive.manifest.files.find(
    (file) => file.path === `objectives/${state.objective}/state.json`,
  );
  const claimFile = archive.manifest.files.find(
    (file) => file.path === `project-queue-history/${claim.id}.json`,
  );
  if (!snapshotFile || !claimFile)
    throw new Error("Stopped handoff exact archived originals are unavailable");
  const store = new LocalContentStore(
    join(stateRoot(config.repository), "content"),
  );
  for (const reference of [
    snapshotFile.ref,
    claimFile.ref,
    claim.runBinding.initialSnapshot,
  ])
    retainProjectQueueOriginal(
      store,
      reference,
      await archive.readVerifiedBlob(reference),
    );
  const snapshotBytes = store.readBytes(snapshotFile.ref);
  const originalClaimBytes = store.readBytes(claimFile.ref);
  const currentClaimPath = join(
    stateRoot(config.repository),
    "project-queue-history",
    `${claim.id}.json`,
  );
  const owner = assertOwner();
  if (
    !Buffer.from(snapshotBytes).equals(
      readFileSync(statePath(config.repository, state.objective)),
    ) ||
    !Buffer.from(originalClaimBytes).equals(privateBytes(currentClaimPath)) ||
    JSON.stringify(
      parsePortableContinuation(
        JSON.parse(Buffer.from(snapshotBytes).toString("utf8")),
        config.repository,
        state.objective,
      ),
    ) !== JSON.stringify(state)
  )
    throw new Error(
      "Stopped handoff claim or continuation changed during authentication",
    );
  claim.settled = {
    at: new Date().toISOString(),
    runId: state.runId,
    disposition: "quiescent",
    handoff: {
      schemaVersion: 1,
      originalClaim: claimFile.ref,
      stoppedSnapshot: snapshotFile.ref,
      configDigest: state.configDigest,
      owner: {
        pid: owner.pid,
        startTime: owner.startTime,
        tokenDigest: queueDigest(owner.token),
      },
    },
  };
  await authenticateQueueOwnerReferences(claim, (reference) =>
    store.readBytes(reference),
  );
  // Reference authentication above is asynchronous; authenticate the exclusive originals again.
  assertOwner();
  if (
    !Buffer.from(snapshotBytes).equals(
      readFileSync(statePath(config.repository, state.objective)),
    ) ||
    !Buffer.from(originalClaimBytes).equals(privateBytes(currentClaimPath))
  )
    throw new Error("Stopped handoff originals changed before settlement");
  save(claim);
  await awaitCheckpointAdmission(config.repository, "explicit");
}

/**
 * A refused, unprojected plan ends its run: every settled claim of that run
 * records the refusal so the next run of the Objective plans again. Called by
 * the exclusive decision owner before it removes the preparation.
 */
export async function settleRefusedProjectQueueRun(
  config: FactoryConfig,
  objective: number,
  runId: string,
  lock: ControllerLock,
): Promise<void> {
  if (!config.queue?.project) return;
  requireProjectQueueEffects(config);
  const identity = linuxProcessIdentity(process.pid);
  const owner = [
    objectiveLockPath(config.repository, objective),
    installationLockPath(config.repository),
  ]
    .map((path) => readControllerOwner(path))
    .find((candidate) => candidate?.token === lock.token);
  if (
    !identity ||
    !owner ||
    owner.pid !== process.pid ||
    owner.startTime !== identity.startTime ||
    owner.objective !== objective
  )
    throw new Error(
      "Project plan refusal requires its actual exclusive controller identity",
    );
  await awaitCheckpointAdmission(config.repository, "explicit");
  const claims = (await readQueueHistory(config)).filter(
    (record): record is QueueOwnerClaim =>
      record.kind === "project-queue-owner" && record.objective === objective,
  );
  if (claims.some((claim) => !claim.settled))
    throw new Error(
      "This Objective has an unfinished or foreign Project owner; settle it before refusing the plan",
    );
  const at = new Date().toISOString();
  for (const claim of claims) {
    if (claim.settled!.runId !== runId || claim.settled!.refusal) continue;
    claim.settled!.refusal = { schemaVersion: 1, at };
    save(claim);
  }
  await awaitCheckpointAdmission(config.repository, "explicit");
}

/** Cancellation settles only the authenticated claim for this terminal run. */
export async function settleCancelledProjectQueueRun(
  config: FactoryConfig,
  state: ContinuationState,
  lock: ControllerLock,
): Promise<void> {
  if (!config.queue?.project) return;
  requireProjectQueueEffects(config);
  if (
    !state.cancelledAt ||
    !state.cancelRequested ||
    (isExecutionState(state) && state.finalAcceptance) ||
    cancelledContinuationResourceHold(state) ||
    state.repository !== config.repository
  )
    throw new Error(
      "Project cancellation requires a terminal run with authenticated resource cessation",
    );
  const identity = linuxProcessIdentity(process.pid);
  const owner = [
    objectiveLockPath(config.repository, state.objective),
    installationLockPath(config.repository),
  ]
    .map((path) => readControllerOwner(path))
    .find((candidate) => candidate?.token === lock.token);
  if (
    !identity ||
    !owner ||
    owner.pid !== process.pid ||
    owner.startTime !== identity.startTime ||
    owner.objective !== state.objective
  )
    throw new Error(
      "Project cancellation requires its actual exclusive controller identity",
    );
  await awaitCheckpointAdmission(config.repository, "explicit");
  const history = await readQueueHistory(config);
  const pending = history.filter(
    (record): record is QueueOwnerClaim =>
      record.kind === "project-queue-owner" &&
      record.objective === state.objective &&
      !record.settled,
  );
  if (!pending.length) return;
  if (pending.length !== 1)
    throw new Error("Project cancellation has competing unfinished claims");
  const claim = pending[0]!;
  // A cancelled run settles against the authority its claim was admitted
  // under, which a later configuration change does not rewrite (#1308).
  assertProjectQueueClaimAdmission(config, history, claim, state, {
    historical: true,
  });
  const archive = await readVerifiedRecoveryCheckpoint(
    config,
    undefined,
    claim.runBinding
      ? undefined
      : { objective: state.objective, claimId: claim.id, runId: state.runId },
  );
  const store = new LocalContentStore(
    join(stateRoot(config.repository), "content"),
  );
  const retain = async (reference: ContentRef) => {
    const bytes = await archive.readVerifiedBlob(reference);
    return retainProjectQueueOriginal(store, reference, bytes);
  };
  const finalFile = archive.manifest.files.find(
    (file) => file.path === `objectives/${state.objective}/state.json`,
  );
  const claimFile = archive.manifest.files.find(
    (file) => file.path === `project-queue-history/${claim.id}.json`,
  );
  if (!finalFile || !claimFile)
    throw new Error("Project cancellation originals are unavailable");
  const cancelledSnapshot = await retain(finalFile.ref);
  if (
    !Buffer.from(store.readBytes(cancelledSnapshot)).equals(
      readFileSync(statePath(config.repository, state.objective)),
    )
  )
    throw new Error(
      "Project cancellation checkpoint differs from the current terminal snapshot",
    );
  let originalClaim: ContentRef;
  let initialSnapshot: ContentRef;
  let lineage: QueueCancellationProof["lineage"];
  if (claim.runBinding) {
    originalClaim = await retain(claimFile.ref);
    initialSnapshot = await retain(claim.runBinding.initialSnapshot);
    lineage = { kind: "producer-bound" };
  } else {
    const verified = archive.queueOwnerLineage;
    if (!verified)
      throw new Error("Project historical first-run binding is unavailable");
    for (const body of verified.bodies) {
      retainProjectQueueOriginal(store, body.ref, body.bytes);
    }
    originalClaim = verified.originalClaim;
    initialSnapshot = verified.initialSnapshot;
    lineage = { kind: "verified-first-run", checkpoints: verified.checkpoints };
  }
  claim.settled = {
    at: new Date().toISOString(),
    runId: state.runId,
    disposition: "quiescent",
    cancellation: {
      schemaVersion: 1,
      originalClaim,
      initialSnapshot,
      cancelledSnapshot,
      configDigest: state.configDigest,
      owner: {
        pid: owner.pid,
        startTime: owner.startTime,
        tokenDigest: queueDigest(owner.token),
      },
      lineage,
    },
  };
  await authenticateQueueOwnerReferences(claim, (reference) =>
    store.readBytes(reference),
  );
  save(claim);
  await awaitCheckpointAdmission(config.repository, "explicit");
}
