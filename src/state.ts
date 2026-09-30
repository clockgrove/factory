import { assertFinalAcceptance } from "./completion.js";
import { assertRepairLedger } from "./repair-policy.js";
import {
  type AutonomousAdmission,
  assertAdmissionBinding,
} from "./admission.js";
import type { SourceSelector } from "./compiler.js";
import type {
  AssetSelectionDecision,
  AuthenticationRequest,
  CapturedAssetSet,
  ExecutionHandle,
  NamedCheckEvidence,
  ResultReviewCandidate,
  WorkGraph,
} from "./contracts.js";
import {
  assertAssetCaptureReceipt,
  assertHydrationReceipt,
  assetSelectionDigest,
  finalValidationLfsMembers,
} from "./media.js";
import { assertGraphRevisions } from "./graph-amendments.js";
import { assertCompletedCoverage, assertCoverageShape } from "./qa.js";
import type { AcceptanceDecision, ValidationEvidence } from "./validation.js";
import { assertSelectedLfsValidation } from "./validation.js";

export type WorkStatus =
  | "pending"
  | "running"
  | "published"
  | "waiting"
  | "done"
  | "failed"
  | "cancelled";
export type WorkStep =
  | "execute"
  | "validate"
  | "approve-asset"
  | "approve-result"
  | "deliver";

export type ReviewRejectionReason =
  | "invalid-response"
  | "missing-finding"
  | "criterion-mismatch"
  | "invalid-verdict"
  | "empty-detail"
  | "unknown-source"
  | "source-truncated"
  | "empty-quote"
  | "quote-not-found";

export interface AcceptancePending {
  criterion: string;
  treeSha: string;
  source?: string;
  quote?: string;
  question: string;
  detail: string;
  reviewFinding?: ResultReviewCandidate;
  reviewRejection?: {
    field: "finding" | "criterion" | "verdict" | "detail" | "source" | "quote";
    reason: ReviewRejectionReason;
  };
}

export interface WorkState {
  recovery?: import("./repair-policy.js").WorkRecovery;
  /** Reservation survives an uncertain effect; item ownership is separate. */
  phaseReservation?: import("./config.js").ResourcePhase;
  requestedPhase?: import("./config.js").ResourcePhase;
  graphRevisionDigest?: string;
  discovery?: import("./contracts.js").WorkDiscovery & { attempt: string };
  discoveryDisposition?: "proposed" | "accepted";
  pendingEffect?: "review" | "publication" | "merge";
  qaChecks?: NamedCheckEvidence[];
  status: WorkStatus;
  step?: WorkStep;
  attempt?: string;
  waitingReason?: string;
  execution?: ExecutionHandle;
  /** Immutable base supplied to the worker for this attempt. */
  executionBaseSha?: string;
  /** Integrated default-branch head observed when this attempt started. */
  integratedShaAtStart?: string | null;
  /** Mutable validation/delivery base; native replay may advance it. */
  baseSha?: string;
  changeRef?: string;
  treeSha?: string;
  validation?: ValidationEvidence;
  acceptancePending?: AcceptancePending;
  acceptanceDecisions?: AcceptanceDecision[];
  assets?: CapturedAssetSet[];
  selectedAssetSet?: string;
  selectionDigest?: string;
  selection?: AssetSelectionDecision;
  pullRequest?: number;
  error?: string;
  authentication?: AuthenticationRequest;
  startedAt?: string;
  completedAt?: string;
  integratedSha?: string;
  githubClosure?: "pending" | "complete";
}

export interface CoordinatorDisposition {
  mode: "running" | "paused" | "draining";
  phase: string;
  phaseStartedAt: string;
  deadlineAt?: string;
  observedAt?: string;
  observationError?: string;
  waitReason?: string;
  cancelError?: string;
  processes?: { pid: number; startTime: string }[];
}

/** Preparation shares the atomic state path; no executable graph is invented. */
export interface PreparationState {
  sourcePacketDigest?: string;
  planningRecovery?: import("./compiler.js").PlanningRecoveryRecord;
  authority?: import("./admission.js").ExecutionAuthority;
  allowanceConsumption?: import("./graph-amendments.js").AllowanceConsumption;
  repairConsumption?: Record<
    string,
    import("./graph-amendments.js").AllowanceConsumption
  >;
  schemaVersion: 5;
  kind: "preparing";
  repository: string;
  objective: number;
  runId: string;
  configDigest: string;
  baseSha: string;
  objectiveBodyDigest: string;
  admission?: AutonomousAdmission;
  coordinator: CoordinatorDisposition;
  planning: "ready" | "submitted" | "complete";
  plan?: import("./compiler.js").PlanCandidate;
  issueByItemId: Record<string, number>;
  projectionPending?: string;
  error?: string;
  cancelRequested?: boolean;
  cancelledAt?: string;
}
export type ContinuationState = FactoryState | PreparationState;

export interface FactoryState {
  finalAcceptance?: import("./completion.js").FinalAcceptance;
  planningRecovery?: import("./compiler.js").PlanningRecoveryRecord;
  repairConsumption?: Record<
    string,
    import("./graph-amendments.js").AllowanceConsumption
  >;
  backlogDiscoveries?: import("./graph-amendments.js").AmendmentProposal[];
  graphRevisions?: import("./graph-amendments.js").GraphRevision[];
  pendingAmendment?: import("./graph-amendments.js").PendingAmendment;
  allowanceConsumption?: import("./graph-amendments.js").AllowanceConsumption;
  coordinator?: CoordinatorDisposition;
  admission?: AutonomousAdmission;
  additionalSources?: SourceSelector[];
  schemaVersion: 4;
  repository: string;
  objective: number;
  runId: string;
  configDigest: string;
  baseSha: string;
  graph: WorkGraph;
  objectiveCommands?: string[];
  issueByItemId: Record<string, number>;
  work: Record<string, WorkState>;
  stackNumbers?: Record<string, number>;
  stackMerges?: Record<
    string,
    { topPullRequest: number; expectedHeadSha: string; uuid: string }
  >;
  integratedSha?: string;
  finalValidation?: ValidationEvidence & { passed: boolean; detail?: string };
  finalAcceptancePending?: AcceptancePending;
  finalAcceptanceDecisions?: AcceptanceDecision[];
  objectiveBodyDigest?: string;
  objectiveClosure?: "pending" | "complete";
  githubClosureError?: string;
  cancelRequested?: boolean;
  cancelledAt?: string;
  error?: string;
}

export function assertCoordinator(value: unknown): void {
  if (value === undefined) return;
  const entry = record(value, "coordinator");
  if (
    !["running", "paused", "draining"].includes(String(entry.mode)) ||
    typeof entry.phase !== "string" ||
    !Number.isFinite(Date.parse(String(entry.phaseStartedAt)))
  )
    throw new Error("Invalid coordinator disposition");
  for (const key of ["deadlineAt", "observedAt"])
    if (
      entry[key] !== undefined &&
      !Number.isFinite(Date.parse(String(entry[key])))
    )
      throw new Error(`Invalid coordinator ${key}`);
  if (
    entry.processes !== undefined &&
    (!Array.isArray(entry.processes) ||
      entry.processes.some(
        (process) =>
          !process ||
          !Number.isSafeInteger(process.pid) ||
          process.pid <= 0 ||
          typeof process.startTime !== "string",
      ))
  )
    throw new Error("Invalid coordinator process identities");
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value)
    throw new Error(`${label} must be a nonempty string`);
  return value;
}

function sha(value: unknown, label: string, length = 40): string {
  const text = string(value, label);
  if (!new RegExp(`^[0-9a-f]{${length}}$`).test(text))
    throw new Error(
      `${label} must be a SHA-${length === 40 ? "1" : "256"} hex digest`,
    );
  return text;
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((part) => typeof part === "string"))
    throw new Error(`${label} must be a string array`);
  return value;
}

function jsonSafe(
  value: unknown,
  label: string,
  seen = new Set<unknown>(),
): void {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} must be JSON-safe`);
    return;
  }
  if (typeof value !== "object" || seen.has(value))
    throw new Error(`${label} must be JSON-safe`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (const [index, entry] of value.entries())
        jsonSafe(entry, `${label}[${index}]`, seen);
      return;
    }
    if (
      (Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null) ||
      Object.getOwnPropertySymbols(value).length
    )
      throw new Error(`${label} must contain only JSON objects`);
    for (const [key, entry] of Object.entries(value))
      jsonSafe(entry, `${label}.${key}`, seen);
  } finally {
    seen.delete(value);
  }
}

function acceptanceDecisions(value: unknown, label: string): void {
  if (!Array.isArray(value)) throw new Error(`${label} is invalid`);
  for (const raw of value) {
    const decision = record(raw, label);
    string(decision.criterion, `${label}.criterion`);
    sha(decision.treeSha, `${label}.treeSha`);
    string(decision.actor, `${label}.actor`);
    string(decision.reason, `${label}.reason`);
    if (
      Number.isNaN(Date.parse(string(decision.at, `${label}.at`))) ||
      !["accept", "refuse"].includes(String(decision.outcome))
    )
      throw new Error(`${label} has invalid outcome or time`);
  }
}

function acceptancePending(value: unknown, label: string): void {
  const pending = record(value, label);
  for (const key of ["criterion", "question", "detail"])
    string(pending[key], `${label}.${key}`);
  for (const key of ["source", "quote"])
    if (pending[key] !== undefined) string(pending[key], `${label}.${key}`);
  sha(pending.treeSha, `${label}.treeSha`);
  if (pending.reviewFinding !== undefined) {
    const finding = record(pending.reviewFinding, `${label}.reviewFinding`);
    for (const key of [
      "criterion",
      "verdict",
      "source",
      "quote",
      "detail",
      "question",
    ]) {
      if (typeof finding[key] !== "string" || finding[key].length > 4_096)
        throw new Error(`${label}.reviewFinding.${key} is invalid`);
    }
  }
  if (pending.reviewRejection !== undefined) {
    const rejection = record(
      pending.reviewRejection,
      `${label}.reviewRejection`,
    );
    if (
      ![
        "finding",
        "criterion",
        "verdict",
        "detail",
        "source",
        "quote",
      ].includes(String(rejection.field)) ||
      ![
        "invalid-response",
        "missing-finding",
        "criterion-mismatch",
        "invalid-verdict",
        "empty-detail",
        "unknown-source",
        "source-truncated",
        "empty-quote",
        "quote-not-found",
      ].includes(String(rejection.reason))
    )
      throw new Error(`${label}.reviewRejection is invalid`);
  }
}

function validationEvidence(value: unknown, label: string): string[] {
  const evidence = record(value, label);
  const treeSha = sha(evidence.treeSha, `${label}.treeSha`);
  assertSelectedLfsValidation(evidence.selectedLfs, treeSha);
  if (!Array.isArray(evidence.commands))
    throw new Error(`${label}.commands must be an array`);
  for (const [index, raw] of evidence.commands.entries()) {
    const receipt = record(raw, `${label}.commands[${index}]`);
    string(receipt.command, `${label}.commands[${index}].command`);
    if (
      receipt.index !== index ||
      receipt.passed !== true ||
      receipt.exitCode !== 0 ||
      sha(receipt.treeSha, `${label}.commands[${index}].treeSha`) !== treeSha
    )
      throw new Error(
        `${label}.commands[${index}] is not bound to the exact tree and order`,
      );
  }
  return evidence.commands.map(
    (raw) => (raw as Record<string, unknown>).command as string,
  );
}

const statuses = new Set<WorkStatus>([
  "pending",
  "running",
  "published",
  "waiting",
  "done",
  "failed",
  "cancelled",
]);
const steps = new Set<WorkStep>([
  "execute",
  "validate",
  "approve-asset",
  "approve-result",
  "deliver",
]);

/** Validate persisted state before it can control processes, Git, or GitHub. */
export function parseFactoryState(
  value: unknown,
  repository: string,
  objective: number,
): FactoryState {
  const state = record(value, "state");
  assertCoordinator(state.coordinator);
  if (
    state.schemaVersion !== 4 ||
    state.repository !== repository ||
    state.objective !== objective
  )
    throw new Error(
      "schema version, repository, or Objective identity differs from the installation",
    );
  if (state.admission !== undefined)
    assertAdmissionBinding(state.admission as AutonomousAdmission);
  string(state.runId, "runId");
  sha(state.configDigest, "configDigest", 64);
  sha(state.baseSha, "baseSha");
  const graph = record(state.graph, "graph");
  if (
    graph.objective !== objective ||
    graph.baseSha !== state.baseSha ||
    !Array.isArray(graph.items) ||
    !graph.items.length
  )
    throw new Error("graph identity or items are invalid");
  assertCoverageShape(graph as unknown as WorkGraph);
  assertGraphRevisions(state as unknown as FactoryState);
  assertRepairLedger(state as unknown as FactoryState);
  const ids = new Set<string>();
  for (const [index, raw] of graph.items.entries()) {
    const item = record(raw, `graph.items[${index}]`);
    const id = string(item.id, "Work Item ID");
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id) || ids.has(id))
      throw new Error(`invalid or duplicate Work Item ID ${id}`);
    if (
      item.executionProfile !== undefined ||
      item.executionBinding !== undefined
    ) {
      const profile = record(item.executionProfile, `${id}.executionProfile`);
      const binding = record(item.executionBinding, `${id}.executionBinding`);
      string(profile.id, `${id}.executionProfile.id`);
      string(profile.reason, `${id}.executionProfile.reason`);
      string(binding.adapter, `${id}.executionBinding.adapter`);
      sha(binding.digest, `${id}.executionBinding.digest`, 64);
      if (profile.id !== binding.id)
        throw new Error(
          `Work Item ${id} profile identity differs from binding`,
        );
      for (const key of ["model", "reasoningEffort"])
        if (binding[key] !== undefined)
          string(binding[key], `${id}.executionBinding.${key}`);
    }
    if (item.priority !== undefined && !Number.isSafeInteger(item.priority))
      throw new Error(`Work Item ${id} has invalid priority`);
    ids.add(id);
    for (const key of ["title", "goal", "brief"])
      string(item[key], `${id}.${key}`);
    for (const key of [
      "acceptance",
      "nonGoals",
      "dependencies",
      "ownedPaths",
      "resources",
      "expectedOutputRoles",
      "requiredLfsRoles",
    ])
      strings(item[key], `${id}.${key}`);
    if (
      !Array.isArray(item.sourceAssets) ||
      !item.sourceAssets.every((raw: unknown) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
        const binding = raw as Record<string, unknown>;
        return (
          typeof binding.path === "string" &&
          !!binding.path &&
          typeof binding.role === "string" &&
          !!binding.role &&
          typeof binding.mediaType === "string" &&
          !!binding.mediaType &&
          (binding.kind === undefined ||
            ["repository", "local", "github-attachment"].includes(
              String(binding.kind),
            )) &&
          ["private", "repository"].includes(String(binding.visibility))
        );
      })
    )
      throw new Error(`${id}.sourceAssets are invalid`);
    if (
      !Number.isSafeInteger(item.minimumAssetSets) ||
      Number(item.minimumAssetSets) < 0
    )
      throw new Error(`${id}.minimumAssetSets is invalid`);
    if (
      !Array.isArray(item.citations) ||
      !item.citations.every((citation) => typeof citation?.path === "string")
    )
      throw new Error(`${id}.citations are invalid`);
    if (
      !Array.isArray(item.validation) ||
      !item.validation.every(
        (check) =>
          typeof check?.command === "string" &&
          ["base-observed", "source-declared"].includes(check.provenance),
      )
    )
      throw new Error(`${id}.validation is invalid`);
  }
  for (const raw of graph.items) {
    const item = raw as Record<string, unknown>;
    if (
      !(item.dependencies as string[]).every(
        (id) => ids.has(id) && id !== item.id,
      )
    )
      throw new Error(`Work Item ${item.id} has an unknown dependency`);
  }
  const projected = record(state.issueByItemId, "issueByItemId");
  const work = record(state.work, "work");
  if (new Set(Object.values(projected)).size !== ids.size)
    throw new Error("Projected Work Item Issue identities are not unique");
  if (
    Object.keys(projected).length !== ids.size ||
    Object.keys(work).length !== ids.size
  )
    throw new Error(
      "graph, projected Issues, and work state have different keys",
    );
  for (const id of ids) {
    if (!Number.isSafeInteger(projected[id]) || Number(projected[id]) <= 0)
      throw new Error(`Work Item ${id} has no projected Issue identity`);
    const item = record(work[id], `work.${id}`);
    if (
      item.pendingEffect !== undefined &&
      !["review", "publication", "merge"].includes(String(item.pendingEffect))
    )
      throw new Error(`Work Item ${id} has invalid pending effect`);
    if (!statuses.has(item.status as WorkStatus))
      throw new Error(`Work Item ${id} has an invalid status`);
    for (const field of ["phaseReservation", "requestedPhase"])
      if (
        item[field] !== undefined &&
        !["coding", "validation", "review", "delivery"].includes(
          String(item[field]),
        )
      )
        throw new Error(`Work Item ${id} has an invalid resource phase`);
    if (item.step !== undefined && !steps.has(item.step as WorkStep))
      throw new Error(`Work Item ${id} has an invalid step`);
    if (item.authentication !== undefined) {
      const authentication = record(
        item.authentication,
        `work.${id}.authentication`,
      );
      string(authentication.provider, `${id}.authentication.provider`);
      string(authentication.command, `${id}.authentication.command`);
      if (item.status !== "failed")
        throw new Error(
          `Work Item ${id} authentication request requires failed status`,
        );
    }
    for (const key of ["baseSha", "executionBaseSha", "treeSha", "changeRef"])
      if (item[key] !== undefined) sha(item[key], `${id}.${key}`);
    if (
      item.integratedShaAtStart !== undefined &&
      item.integratedShaAtStart !== null
    )
      sha(item.integratedShaAtStart, `${id}.integratedShaAtStart`);
    if (item.integratedSha !== undefined)
      sha(item.integratedSha, `${id}.integratedSha`);
    if (
      item.startedAt !== undefined &&
      Number.isNaN(Date.parse(string(item.startedAt, `${id}.startedAt`)))
    )
      throw new Error(`Work Item ${id} has an invalid startedAt`);
    if (item.status === "running" && (!item.step || !item.baseSha))
      throw new Error(`Running Work Item ${id} lacks step or base`);
    if (
      item.status === "waiting" &&
      (item.step !== "approve-asset" ||
        !Array.isArray(item.assets) ||
        !item.assets.length ||
        item.selectedAssetSet) &&
      (item.step !== "approve-result" || !item.acceptancePending)
    )
      throw new Error(`Waiting Work Item ${id} lacks candidate assets`);
    if (item.acceptancePending !== undefined)
      acceptancePending(item.acceptancePending, `${id}.acceptancePending`);
    if (item.acceptanceDecisions !== undefined)
      acceptanceDecisions(
        item.acceptanceDecisions,
        `${id}.acceptanceDecisions`,
      );
    if (item.validation !== undefined) {
      const receiptCommands = validationEvidence(
        item.validation,
        `${id}.validation`,
      );
      const declaredCommands = (
        (graph.items as Record<string, unknown>[]).find(
          (candidate) => candidate.id === id,
        )!.validation as { command: string }[]
      ).map((check) => check.command);
      if (JSON.stringify(receiptCommands) !== JSON.stringify(declaredCommands))
        throw new Error(
          `Work Item ${id} validation receipts differ from declared commands`,
        );
      if ((item.validation as { treeSha: string }).treeSha !== item.treeSha)
        throw new Error(
          `Work Item ${id} validation tree differs from result tree`,
        );
    }
    if (
      item.status === "published" &&
      (!Number.isSafeInteger(item.pullRequest) || !item.changeRef)
    )
      throw new Error(`Published Work Item ${id} lacks PR or change identity`);
    if (item.qaChecks !== undefined) {
      if (!Array.isArray(item.qaChecks))
        throw new Error(`${id}.qaChecks is invalid`);
      for (const raw of item.qaChecks) {
        const check = record(raw, `${id}.qaChecks`);
        if (
          !Number.isSafeInteger(check.id) ||
          Number(check.id) <= 0 ||
          check.status !== "completed" ||
          check.conclusion !== "success"
        )
          throw new Error(`${id}.qaChecks lacks successful result identity`);
        sha(check.headSha, `${id}.qaChecks.headSha`);
        string(check.name, `${id}.qaChecks.name`);
        string(check.detailsUrl, `${id}.qaChecks.detailsUrl`);
      }
    }
    const accepted = (graph.items as WorkGraph["items"]).find(
      (candidate) => candidate.id === id,
    )!;
    if (
      (accepted.kind === "qa" || accepted.kind === "aggregate") &&
      (item.execution !== undefined ||
        item.pullRequest !== undefined ||
        accepted.ownedPaths.length)
    )
      throw new Error(`Read-only QA ${id} cannot contain a worker or PR`);
    if (
      item.pullRequest !== undefined &&
      (!Number.isSafeInteger(item.pullRequest) || Number(item.pullRequest) <= 0)
    )
      throw new Error(`Work Item ${id} PR identity is invalid`);
    if (
      item.githubClosure !== undefined &&
      (item.status !== "done" ||
        !["pending", "complete"].includes(String(item.githubClosure)))
    )
      throw new Error(`Work Item ${id} GitHub closure is invalid`);
    if (
      item.selectedAssetSet !== undefined &&
      (typeof item.selectedAssetSet !== "string" ||
        !Array.isArray(item.assets) ||
        !item.assets.some(
          (set: { id?: unknown }) => set.id === item.selectedAssetSet,
        ))
    )
      throw new Error(`Work Item ${id} has an invalid asset selection`);
    if (item.selectionDigest !== undefined)
      sha(item.selectionDigest, `${id}.selectionDigest`, 64);
    if (
      item.selectedAssetSet !== undefined &&
      (item.selection === undefined || item.selectionDigest === undefined)
    )
      throw new Error(`Work Item ${id} lacks a selection decision`);
    if (item.selection !== undefined) {
      const decision = record(item.selection, `${id}.selection`);
      string(decision.actor, "Selection actor");
      if (Number.isNaN(Date.parse(string(decision.at, "Selection time"))))
        throw new Error("Selection time is invalid");
      if (decision.reason !== undefined && typeof decision.reason !== "string")
        throw new Error("Selection reason is invalid");
      if (
        decision.surface !== undefined &&
        !["factory-cli", "application"].includes(String(decision.surface))
      )
        throw new Error("Selection surface is invalid");
      if (
        !Array.isArray(decision.downstreamItems) ||
        !decision.downstreamItems.every(
          (name: unknown) => typeof name === "string" && !!name,
        )
      )
        throw new Error("Selection downstream items are invalid");
      if (
        !Array.isArray(decision.destinations) ||
        !decision.destinations.every((raw: unknown) => {
          if (!raw || typeof raw !== "object" || Array.isArray(raw))
            return false;
          const destination = raw as Record<string, unknown>;
          return (
            typeof destination.role === "string" &&
            !!destination.role &&
            typeof destination.path === "string" &&
            !!destination.path &&
            typeof destination.digest === "string" &&
            /^[0-9a-f]{64}$/.test(destination.digest)
          );
        })
      )
        throw new Error("Selection destinations are invalid");
    }
    if (item.assets !== undefined) {
      if (!Array.isArray(item.assets))
        throw new Error(`Work Item ${id} assets are invalid`);
      const acceptedItem = (graph.items as WorkGraph["items"]).find(
        (candidate) => candidate.id === id,
      )!;
      const acceptedSourceBindings = (acceptedItem.sourceAssets ?? []).map(
        (binding) => ({
          kind: binding.kind ?? "repository",
          path: binding.path,
          role: binding.role,
          mediaType: binding.mediaType,
          visibility: binding.visibility,
        }),
      );
      let sharedInputIdentity: string | undefined;
      for (const rawSet of item.assets) {
        const set = record(rawSet, `work.${id}.assetSet`);
        string(set.id, "AssetSet ID");
        const provenance = record(set.provenance, "AssetSet provenance");
        string(provenance.source, "AssetSet source");
        string(provenance.rights, "AssetSet rights");
        if (!["private", "repository"].includes(String(provenance.visibility)))
          throw new Error("AssetSet visibility is invalid");
        strings(provenance.lineage, "AssetSet lineage");
        if (set.inputs !== undefined) {
          if (!Array.isArray(set.inputs))
            throw new Error("AssetSet inputs are invalid");
          for (const rawInput of set.inputs) {
            const input = record(rawInput, "AssetSet input");
            const binding = record(input.binding, "AssetSet source binding");
            string(binding.path, "AssetSet source path");
            string(binding.role, "AssetSet source role");
            string(binding.mediaType, "AssetSet source media type");
            if (
              binding.kind !== undefined &&
              !["repository", "local", "github-attachment"].includes(
                String(binding.kind),
              )
            )
              throw new Error("AssetSet source kind is invalid");
            if (!["private", "repository"].includes(String(binding.visibility)))
              throw new Error("AssetSet source visibility is invalid");
            const ref = record(input.ref, "AssetSet source ref");
            sha(ref.digest, "AssetSet source digest", 64);
            if (
              !Number.isSafeInteger(ref.bytes) ||
              Number(ref.bytes) < 0 ||
              typeof ref.mediaType !== "string"
            )
              throw new Error("AssetSet source reference is invalid");
          }
        }
        const canonicalInputs = (
          (set.inputs ?? []) as NonNullable<CapturedAssetSet["inputs"]>
        ).map((input) => ({
          binding: {
            kind: input.binding.kind ?? "repository",
            path: input.binding.path,
            role: input.binding.role,
            mediaType: input.binding.mediaType,
            visibility: input.binding.visibility,
          },
          ref: {
            digest: input.ref.digest,
            bytes: input.ref.bytes,
            mediaType: input.ref.mediaType,
          },
        }));
        if (
          JSON.stringify(canonicalInputs.map((input) => input.binding)) !==
          JSON.stringify(acceptedSourceBindings)
        )
          throw new Error(
            "AssetSet inputs differ from accepted source bindings",
          );
        const inputIdentity = JSON.stringify(canonicalInputs);
        if (
          sharedInputIdentity !== undefined &&
          sharedInputIdentity !== inputIdentity
        )
          throw new Error("AssetSet inputs differ across candidate sets");
        sharedInputIdentity = inputIdentity;
        if (!Array.isArray(set.members) || !set.members.length)
          throw new Error("AssetSet has no members");
        const memberRoles = new Set<string>();
        const evidence = record(set.evidence, "AssetSet harness evidence");
        string(evidence.harnessIdentity, "AssetSet harness identity");
        sha(evidence.resultDigest, "AssetSet harness result digest", 64);
        if (set.production !== undefined) {
          const production = record(
            set.production,
            "AssetSet production evidence",
          );
          for (const key of ["model", "tool"])
            if (production[key] !== undefined)
              string(production[key], `AssetSet ${key}`);
        }
        for (const rawMember of set.members) {
          const member = record(rawMember, "AssetSet member");
          string(member.role, "AssetSet role");
          memberRoles.add(member.role as string);
          string(member.destination, "AssetSet destination");
          if (member.formatMetadata !== undefined) {
            const format = record(
              member.formatMetadata,
              "AssetSet format metadata",
            );
            string(format.source, "AssetSet format metadata source");
            record(format.values, "AssetSet format metadata values");
          }
          const ref = record(member.ref, "AssetSet content ref");
          sha(ref.digest, "AssetSet content digest", 64);
          if (
            !Number.isSafeInteger(ref.bytes) ||
            Number(ref.bytes) < 0 ||
            typeof ref.mediaType !== "string"
          )
            throw new Error("AssetSet content reference is invalid");
        }
        if (set.relationships !== undefined) {
          if (
            !Array.isArray(set.relationships) ||
            !set.relationships.every((raw: unknown) => {
              if (!raw || typeof raw !== "object" || Array.isArray(raw))
                return false;
              const edge = raw as Record<string, unknown>;
              return (
                typeof edge.from === "string" &&
                !!edge.from &&
                typeof edge.toRole === "string" &&
                memberRoles.has(edge.toRole) &&
                typeof edge.kind === "string" &&
                !!edge.kind
              );
            })
          )
            throw new Error("AssetSet relationships are invalid");
        }
        if (set.capture !== undefined)
          assertAssetCaptureReceipt(set as unknown as CapturedAssetSet);
      }
    }
    if (item.selectedAssetSet !== undefined) {
      const selected = (item.assets as CapturedAssetSet[]).find(
        (candidate) => candidate.id === item.selectedAssetSet,
      )!;
      if (item.selectionDigest !== assetSelectionDigest(selected))
        throw new Error(
          `Work Item ${id} selection digest differs from its AssetSet`,
        );
      const decision = item.selection as unknown as AssetSelectionDecision;
      if (
        JSON.stringify(decision.destinations) !==
        JSON.stringify(
          selected.members.map((member) => ({
            role: member.role,
            path: member.destination,
            digest: member.ref.digest,
          })),
        )
      )
        throw new Error(
          `Work Item ${id} selection destinations differ from its AssetSet`,
        );
      if (
        decision.downstreamItems.some(
          (name) =>
            !(graph.items as { id: string; dependencies: string[] }[]).some(
              (candidate) =>
                candidate.id === name && candidate.dependencies.includes(id),
            ),
        )
      )
        throw new Error(`Work Item ${id} has an invalid downstream binding`);
    }
    if (item.execution !== undefined) {
      const execution = record(item.execution, `work.${id}.execution`);
      if (
        typeof execution.provider !== "string" ||
        !execution.provider ||
        typeof execution.identity !== "string" ||
        !execution.identity
      )
        throw new Error(`Work Item ${id} execution identity is invalid`);
      if (execution.data !== undefined)
        jsonSafe(execution.data, `work.${id}.execution.data`);
      if (execution.provider === "local") {
        const active = record(execution.data, `work.${id}.execution.data`);
        const request = record(active.request, `work.${id}.execution.request`);
        const attemptedItem = record(request.item, `work.${id}.execution.item`);
        const acceptedItem = (graph.items as Record<string, unknown>[]).find(
          (candidate) => candidate.id === id,
        )!;
        if (
          JSON.stringify(attemptedItem.executionProfile) !==
            JSON.stringify(acceptedItem.executionProfile) ||
          JSON.stringify(attemptedItem.executionBinding) !==
            JSON.stringify(acceptedItem.executionBinding) ||
          JSON.stringify(active.executionBinding) !==
            JSON.stringify(acceptedItem.executionBinding)
        )
          throw new Error(
            `Work Item ${id} execution profile differs from accepted graph`,
          );
        const handle = record(active.handle, `work.${id}.harness`);
        if (
          typeof active.worktree !== "string" ||
          typeof active.adapterIdentity !== "string" ||
          !active.adapterIdentity ||
          attemptedItem.id !== id ||
          (request.baseSha !== item.baseSha &&
            item.status !== "done" &&
            item.status !== "published") ||
          typeof handle.identity !== "string" ||
          !handle.identity
        )
          throw new Error(`Work Item ${id} active attempt handle is invalid`);
        if (handle.data !== undefined)
          jsonSafe(handle.data, `work.${id}.harness.data`);
      }
    }
  }
  if (state.integratedSha !== undefined)
    sha(state.integratedSha, "integratedSha");
  if (state.stackNumbers !== undefined) {
    const numbers = record(state.stackNumbers, "stackNumbers");
    for (const [unit, number] of Object.entries(numbers))
      if (!unit || !Number.isSafeInteger(number) || Number(number) <= 0)
        throw new Error("Native stack identity is invalid");
  }
  if (state.stackMerges !== undefined) {
    const merges = record(state.stackMerges, "stackMerges");
    for (const [unit, raw] of Object.entries(merges)) {
      const merge = record(raw, `stackMerges.${unit}`);
      if (
        !unit ||
        !Number.isSafeInteger(merge.topPullRequest) ||
        Number(merge.topPullRequest) <= 0 ||
        typeof merge.uuid !== "string" ||
        !merge.uuid
      )
        throw new Error("Pending native merge identity is invalid");
      sha(merge.expectedHeadSha, "Pending native merge head");
    }
  }
  if (state.finalValidation !== undefined) {
    const final = record(state.finalValidation, "finalValidation");
    const receiptCommands = validationEvidence(final, "finalValidation");
    if (
      !Array.isArray(state.objectiveCommands) ||
      JSON.stringify(receiptCommands) !==
        JSON.stringify(state.objectiveCommands)
    )
      throw new Error(
        "Final validation receipts differ from declared Objective commands",
      );
    const selections = (graph as unknown as WorkGraph).items.flatMap((item) => {
      const itemWork = (work as Record<string, WorkState>)[item.id];
      const set = itemWork?.assets?.find(
        (candidate) => candidate.id === itemWork.selectedAssetSet,
      );
      return set ? [{ itemId: item.id, set }] : [];
    });
    if (selections.length) {
      assertHydrationReceipt(
        final.hydrationReceipt,
        sha(state.integratedSha, "integratedSha"),
        sha(final.treeSha, "finalValidation.treeSha"),
        selections,
      );
    } else if (final.hydrationReceipt !== undefined) {
      throw new Error("Final validation has unexpected hydration evidence");
    }
    if (final.passed !== true)
      throw new Error("Final validation evidence is invalid");
  }
  if (state.finalAcceptancePending !== undefined)
    acceptancePending(state.finalAcceptancePending, "finalAcceptancePending");
  if (state.finalAcceptanceDecisions !== undefined)
    acceptanceDecisions(
      state.finalAcceptanceDecisions,
      "finalAcceptanceDecisions",
    );
  if (state.objectiveCommands !== undefined)
    strings(state.objectiveCommands, "objectiveCommands");
  if (state.objectiveBodyDigest !== undefined)
    sha(state.objectiveBodyDigest, "objectiveBodyDigest", 64);
  if (
    state.objectiveClosure !== undefined &&
    (state.finalValidation === undefined ||
      !["pending", "complete"].includes(String(state.objectiveClosure)))
  )
    throw new Error("Objective GitHub closure is invalid");
  if (
    state.githubClosureError !== undefined &&
    typeof state.githubClosureError !== "string"
  )
    throw new Error("githubClosureError is invalid");
  if (state.error !== undefined && typeof state.error !== "string")
    throw new Error("state.error is invalid");
  const validated = value as FactoryState;
  const selectedMembers = finalValidationLfsMembers(validated);
  // Item validation may hydrate dependencies or selected sibling pointers already
  // present in its tree, so compare against all selected required-LFS members.
  for (const evidence of [
    ...Object.values(validated.work).map((item) => item.validation),
    validated.finalValidation,
  ]) {
    for (const receipt of evidence?.selectedLfs ?? []) {
      if (
        !selectedMembers.some(
          (member) =>
            member.destination === receipt.destination &&
            member.digest === receipt.digest &&
            member.bytes === receipt.bytes,
        )
      )
        throw new Error(
          "Selected LFS validation evidence does not match a selected member",
        );
    }
  }
  if (validated.finalValidation?.passed) assertCompletedCoverage(validated);
  assertFinalAcceptance(validated);
  return validated;
}
