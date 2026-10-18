import { createHash } from "node:crypto";
import { readAdaptiveContextBytes } from "./adaptive-context.js";
import type { ContentRef, ContentStore } from "./contracts.js";
import { graphDigest } from "./graph-amendments.js";
import {
  coverageCriterion,
  objectiveCandidate,
  semanticProofCriterion,
} from "./qa.js";
import {
  PAID_ATTEMPTS,
  amendmentAllowed,
  implementationRepairable,
  remaining,
  repairScopes,
} from "./repair-policy.js";
import { pendingItemBlocker, rankPending, workSettled } from "./scheduler.js";
import type { FactoryState } from "./state.js";

const MAX_RECORDS = 16;
const MAX_BODY_BYTES = 256 * 1024;
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function exactKeys(
  value: unknown,
  required: string[],
  optional: string[] = [],
): boolean {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      required.every((key) => Object.hasOwn(value, key)) &&
      Object.keys(value).every(
        (key) => required.includes(key) || optional.includes(key),
      ),
  );
}
export interface WorkflowReflectionEvent {
  kind: "completion" | "blocker" | "integration-contract-conflict";
  itemId?: string;
}
interface Progress {
  completedItems: number;
  currentProofs: number;
  repairedAttempts: number;
  /** Sum of attributable completed attempt durations; not wall-clock throughput. */
  completedAttemptMs: number | null;
}
export interface WorkflowReflectionRecord {
  id: string;
  event: WorkflowReflectionEvent;
  binding: {
    repository: string;
    objective: number;
    runId: string;
    configDigest: string;
    graphDigest: string;
    baseSha: string;
  };
  factsDigest: string;
  bodyRef: ContentRef;
  cause: string;
  affectedPendingItemIds: string[];
  action: {
    kind:
      | "existing-critical-path"
      | "existing-diagnosis"
      | "reviewed-amendment"
      | "no-change"
      | "hold";
    /** The existing scheduler's order; never a replacement graph or reservation. */
    eligibleItemIds: string[];
    reason: string;
  };
  expectedProgress: string;
  qualityEffect: string;
  remainingAllowances: ReturnType<typeof remaining>;
  diagnosisAttemptsRemaining: number | null;
  baseline: Progress;
  assessment: {
    previousId: string | null;
    outcome: "initial" | "useful-progress" | "no-progress" | "inconclusive";
    completedItemDelta: number | null;
    currentProofDelta: number | null;
    repairedAttemptDelta: number | null;
    completedAttemptMsDelta: number | null;
    confounders: string[];
  };
  reassess: "next-material-event";
}
export interface WorkflowReflectionState {
  schemaVersion: 1;
  records: WorkflowReflectionRecord[];
}

/** Authenticate retained supporting observations before exposing their body. */
export async function readWorkflowReflection(
  store: ContentStore,
  record: WorkflowReflectionRecord,
): Promise<object> {
  if (
    record.bodyRef.bytes > MAX_BODY_BYTES ||
    record.bodyRef.mediaType !== "application/json"
  )
    throw new Error("Workflow reflection body exceeds its admitted bound");
  const { id, bodyRef, ...proposal } = record;
  if (hash({ ...proposal, bodyRef }) !== id)
    throw new Error("Workflow reflection metadata differs from its identity");
  const body = JSON.parse(
    (await readAdaptiveContextBytes(store, bodyRef)).toString("utf8"),
  ) as {
    schemaVersion?: unknown;
    proposal?: unknown;
    observations?: unknown;
    previousRecord?: WorkflowReflectionRecord | null;
  };
  if (
    body.schemaVersion !== 1 ||
    JSON.stringify(body.proposal) !== JSON.stringify(proposal) ||
    hash(body.observations) !== record.factsDigest ||
    (body.previousRecord?.id ?? null) !== record.assessment.previousId
  )
    throw new Error(
      "Workflow reflection body differs from its retained source bindings",
    );
  return body;
}

/** Expose admitted obligations and exact retained proof, never a worker's done claim. */
export function workflowStageObligations(state: FactoryState) {
  const candidate = objectiveCandidate(state)?.commitSha;
  return state.graph.coverage.map((entry) => {
    const item = state.graph.items.find((value) => value.id === entry.itemId)!;
    const work = state.work[item.id];
    const proof = entry.proof;
    const final =
      proof.kind === "final-review" || proof.kind === "final-controller";
    const validation = final ? state.finalValidation : work?.validation;
    const decisions = final
      ? state.finalAcceptanceDecisions
      : work?.acceptanceDecisions;
    const tree = final ? state.finalValidation?.treeSha : work?.treeSha;
    const criterion = final
      ? coverageCriterion(entry)
      : semanticProofCriterion(entry, item);
    const semantic =
      criterion === undefined ||
      Boolean(
        validation?.criteria?.some(
          (finding) =>
            finding.criterion === criterion &&
            (finding.verdict === "pass" ||
              (finding.verdict === "human-accept" &&
                decisions?.some(
                  (decision) =>
                    decision.criterion === criterion &&
                    decision.treeSha === tree &&
                    decision.outcome === "accept",
                ))),
        ),
      );
    const command =
      !("validationIndex" in proof) ||
      Boolean(
        validation?.commands.some(
          (receipt) =>
            receipt.command ===
              item.validation[proof.validationIndex]?.command &&
            receipt.treeSha === tree &&
            receipt.passed,
        ),
      );
    const ciHead =
      proof.kind === "published-ci"
        ? state.work[proof.targetItem]?.changeRef
        : candidate;
    const ci =
      !("checkName" in proof) ||
      Boolean(
        ciHead &&
          work?.qaChecks?.some(
            (receipt) =>
              receipt.name === proof.checkName &&
              receipt.headSha === ciHead &&
              receipt.status === "completed" &&
              receipt.conclusion === "success" &&
              Number.isSafeInteger(receipt.id) &&
              receipt.id > 0,
          ),
      );
    const stale = Boolean(
      validation &&
        (!tree ||
          validation.treeSha !== tree ||
          (proof.kind.startsWith("integrated-") &&
            work?.changeRef !== candidate)),
    );
    const current =
      !stale &&
      Boolean(validation) &&
      (final
        ? state.finalValidation?.passed && candidate
        : work?.status === "done") &&
      semantic &&
      command &&
      ci;
    return {
      criterionId: entry.criterionId,
      itemId: entry.itemId,
      sourceDigest: entry.source.digest,
      proof,
      disposition: current
        ? ("current" as const)
        : stale
          ? ("stale" as const)
          : ("missing" as const),
      treeSha: tree ?? null,
      stage: final
        ? "final-acceptance"
        : "checkName" in proof
          ? "delivery-head-ci"
          : proof.kind.startsWith("integrated-")
            ? "integration"
            : "result-acceptance",
      unresolvedEnvironment: entry.environment.readiness === "missing",
    };
  });
}

function facts(state: FactoryState) {
  return {
    graphDigest: graphDigest(state.graph),
    integratedSha: state.integratedSha ?? null,
    finalHead: state.finalHead ?? null,
    finalValidationDigest: state.finalValidation
      ? hash(state.finalValidation)
      : null,
    sealed: Boolean(state.finalAcceptance),
    cancelled: Boolean(state.cancelledAt || state.cancelRequested),
    errorDigest: state.error ? hash(state.error) : null,
    wait: state.wait
      ? { kind: state.wait.kind, digest: hash(state.wait) }
      : null,
    pendingAmendment: state.pendingAmendment?.phase ?? null,
    pendingExpansion: state.pendingExpansion?.phase ?? null,
    projectionEffects: Object.values(
      state.graphProjectionIntents ?? {},
    ).flatMap((intent) =>
      intent.effects.map((effect) => ({
        id: effect.id,
        digest: hash(effect),
        uncertain:
          !effect.observation ||
          ["unknown", "reconciled"].includes(effect.observation.outcome),
      })),
    ),
    publications: Object.values(state.publicationIntents ?? {}).flatMap(
      (intents) =>
        intents.map((intent) => ({
          itemId: intent.itemId,
          attemptId: intent.attemptId,
          uncertain: !intent.observation && !intent.closedConfirmedAt,
        })),
    ),
    coordinator: {
      cancelError: Boolean(state.coordinator?.cancelError),
      processes: state.coordinator?.processes ?? [],
    },
    charges: state.charges ?? {},
    stackMerges: state.stackMerges ?? {},
    sessions: Object.values(state.agentSessions ?? {}).map((session) => ({
      identity: session.identity,
      status: session.status,
      turn: session.currentTurn ?? null,
    })),
    items: state.graph.items.map((item) => {
      const work = state.work[item.id]!;
      return {
        id: item.id,
        status: work.status,
        routingDigest: work.routing ? hash(work.routing) : null,
        step: work.step ?? null,
        attempt: work.attempt ?? null,
        execution: work.execution
          ? {
              provider: work.execution.provider,
              identity: work.execution.identity,
            }
          : null,
        treeSha: work.treeSha ?? null,
        changeRef: work.changeRef ?? null,
        integratedSha: work.integratedSha ?? null,
        validationDigest: work.validation ? hash(work.validation) : null,
        acceptanceDecisionDigest: hash(work.acceptanceDecisions ?? []),
        namedCheckDigest: hash(work.qaChecks ?? []),
        failure: work.recovery?.failure
          ? {
              digest: work.recovery.failure.digest,
              classification: work.recovery.failure.classification,
              predecessor: work.recovery.failure.predecessor ?? null,
            }
          : null,
        recoveryPhase: work.recovery?.phase ?? null,
        diagnosisUncertain: Boolean(
          work.recovery?.diagnosisInvocation?.submitted &&
            work.recovery.diagnosisInvocation.response === undefined,
        ),
        repairedAttempts: work.recovery?.history?.length ?? 0,
        wait: work.wait
          ? { kind: work.wait.kind, digest: hash(work.wait) }
          : null,
        branchUpdateFrom: work.branchUpdateFrom ?? null,
        startedAt: work.startedAt ?? null,
        completedAt: work.completedAt ?? null,
      };
    }),
  };
}
function progress(state: FactoryState): Progress {
  const completed = state.graph.items
    .map((item) => state.work[item.id]!)
    .filter((work) => work.status === "done");
  const durations = completed.map((work) => {
    const duration =
      Date.parse(work.completedAt ?? "") - Date.parse(work.startedAt ?? "");
    return Number.isSafeInteger(duration) && duration >= 0 ? duration : null;
  });
  const sum = durations.reduce<number>(
    (total, duration) => total + (duration ?? 0),
    0,
  );
  return {
    completedItems: completed.length,
    currentProofs: workflowStageObligations(state).filter(
      (proof) => proof.disposition === "current",
    ).length,
    repairedAttempts: Object.values(state.work).reduce(
      (total, work) => total + (work.recovery?.history?.length ?? 0),
      0,
    ),
    completedAttemptMs:
      durations.every((duration) => duration !== null) &&
      completed.length > 0 &&
      Number.isSafeInteger(sum)
        ? sum
        : null,
  };
}

/** Pure validation: missing observational bodies never block cancellation or old reads. */
export function assertWorkflowReflection(state: FactoryState): void {
  const ledger = state.workflowReflection;
  if (ledger === undefined) return;
  if (
    !ledger ||
    ledger.schemaVersion !== 1 ||
    !Array.isArray(ledger.records) ||
    ledger.records.length > MAX_RECORDS ||
    Object.keys(ledger).sort().join(",") !== "records,schemaVersion"
  )
    throw new Error("Invalid bounded workflow reflection ledger");
  const graphs = [
    state.graph,
    ...(state.graphRevisions ?? []).map((revision) => revision.graph),
  ];
  const ids = new Set<string>();
  for (const record of ledger.records) {
    if (
      !exactKeys(record, [
        "id",
        "event",
        "binding",
        "factsDigest",
        "bodyRef",
        "cause",
        "affectedPendingItemIds",
        "action",
        "expectedProgress",
        "qualityEffect",
        "remainingAllowances",
        "diagnosisAttemptsRemaining",
        "baseline",
        "assessment",
        "reassess",
      ]) ||
      !exactKeys(record.binding, [
        "repository",
        "objective",
        "runId",
        "configDigest",
        "graphDigest",
        "baseSha",
      ]) ||
      !exactKeys(record.event, ["kind"], ["itemId"]) ||
      !exactKeys(record.bodyRef, ["digest", "bytes", "mediaType"]) ||
      !exactKeys(record.action, ["kind", "eligibleItemIds", "reason"]) ||
      !exactKeys(record.baseline, [
        "completedItems",
        "currentProofs",
        "repairedAttempts",
        "completedAttemptMs",
      ]) ||
      !exactKeys(record.assessment, [
        "previousId",
        "outcome",
        "completedItemDelta",
        "currentProofDelta",
        "repairedAttemptDelta",
        "completedAttemptMsDelta",
        "confounders",
      ]) ||
      !exactKeys(record.remainingAllowances, ["objective", "paths"])
    )
      throw new Error("Invalid workflow reflection fields");
    const { id, ...body } = record;
    const graph = graphs.find(
      (value) => graphDigest(value) === record.binding?.graphDigest,
    );
    if (
      !/^[a-f0-9]{64}$/.test(id) ||
      ids.has(id) ||
      hash(body) !== id ||
      !graph ||
      record.binding.repository !== state.repository ||
      record.binding.objective !== state.objective ||
      record.binding.runId !== state.runId ||
      record.binding.configDigest !== state.configDigest ||
      !/^[a-f0-9]{40,64}$/.test(record.binding.baseSha) ||
      !/^[a-f0-9]{64}$/.test(record.factsDigest) ||
      !["completion", "blocker", "integration-contract-conflict"].includes(
        record.event?.kind,
      ) ||
      (record.event.itemId !== undefined &&
        !graph.items.some((item) => item.id === record.event.itemId)) ||
      !record.bodyRef ||
      !/^[a-f0-9]{64}$/.test(record.bodyRef.digest) ||
      record.bodyRef.mediaType !== "application/json" ||
      !Number.isSafeInteger(record.bodyRef.bytes) ||
      record.bodyRef.bytes < 0 ||
      record.bodyRef.bytes > MAX_BODY_BYTES ||
      ![
        "existing-critical-path",
        "existing-diagnosis",
        "reviewed-amendment",
        "no-change",
        "hold",
      ].includes(record.action?.kind) ||
      !["initial", "useful-progress", "no-progress", "inconclusive"].includes(
        record.assessment?.outcome,
      ) ||
      record.reassess !== "next-material-event"
    )
      throw new Error(
        "Workflow reflection differs from its bounded source binding",
      );
    for (const list of [
      record.affectedPendingItemIds,
      record.action.eligibleItemIds,
    ])
      if (
        !Array.isArray(list) ||
        list.length > graph.items.length ||
        new Set(list).size !== list.length ||
        list.some((itemId) => !graph.items.some((item) => item.id === itemId))
      )
        throw new Error("Invalid reflected pending scope");
    for (const text of [
      record.cause,
      record.action.reason,
      record.expectedProgress,
      record.qualityEffect,
    ])
      if (typeof text !== "string" || !text.trim() || text.length > 2048)
        throw new Error("Invalid workflow reflection explanation");
    if (
      !record.baseline ||
      Object.values(record.baseline).some(
        (value) =>
          value !== null && (!Number.isSafeInteger(value) || value < 0),
      ) ||
      !record.remainingAllowances?.objective ||
      !record.remainingAllowances.paths ||
      Object.values(record.remainingAllowances.objective).some(
        (value) => !Number.isSafeInteger(value) || value < 0,
      ) ||
      Object.values(record.remainingAllowances.paths).some((allowances) =>
        Object.values(allowances).some(
          (value) => !Number.isSafeInteger(value) || value < 0,
        ),
      )
    )
      throw new Error("Invalid reflected progress or remaining allowance");
    if (
      (record.diagnosisAttemptsRemaining !== null &&
        (!Number.isSafeInteger(record.diagnosisAttemptsRemaining) ||
          record.diagnosisAttemptsRemaining < 0 ||
          record.diagnosisAttemptsRemaining > PAID_ATTEMPTS)) ||
      (record.assessment.previousId !== null &&
        !/^[a-f0-9]{64}$/.test(record.assessment.previousId)) ||
      [
        record.assessment.completedItemDelta,
        record.assessment.currentProofDelta,
        record.assessment.repairedAttemptDelta,
        record.assessment.completedAttemptMsDelta,
      ].some((value) => value !== null && !Number.isSafeInteger(value)) ||
      !Array.isArray(record.assessment.confounders) ||
      record.assessment.confounders.length > 8 ||
      record.assessment.confounders.some(
        (value) => typeof value !== "string" || value.length > 2048,
      )
    )
      throw new Error("Invalid reflected reassessment");
    for (const allowances of [
      record.remainingAllowances.objective,
      ...Object.values(record.remainingAllowances.paths),
    ])
      if (
        !exactKeys(allowances, [
          "implementationRepairs",
          "planningRevisions",
          "resultRereviews",
        ])
      )
        throw new Error("Invalid reflected original allowances");
    ids.add(id);
  }
}

/** Observational proposal only: existing admission, diagnosis and amendments own effects. */
export async function reflectWorkflow(input: {
  state: FactoryState;
  event: WorkflowReflectionEvent;
  store: ContentStore;
  save: () => void;
  /** Already authenticated by the current runtime admission path. */
  resolvedExpansionIds?: ReadonlySet<string>;
}): Promise<WorkflowReflectionRecord | undefined> {
  const { state, event } = input;
  if (
    !state.planningRecovery?.contextLookup ||
    state.finalAcceptance ||
    state.cancelledAt
  )
    return undefined;
  const item = state.graph.items.find((value) => value.id === event.itemId);
  const work = event.itemId ? state.work[event.itemId] : undefined;
  const active = new Set(
    state.graph.items
      .filter((value) =>
        Boolean(
          state.work[value.id]?.execution ||
            state.work[value.id]?.phaseReservation ||
            ["running", "waiting", "published"].includes(
              state.work[value.id]?.status ?? "",
            ),
        ),
      )
      .map((value) => value.id),
  );
  const pending = rankPending(state.graph, state.work).filter(
    (value) => state.work[value.id]?.status === "pending",
  );
  const blockers = pending.map((value) => ({
    itemId: value.id,
    blocker: pendingItemBlocker(
      state.graph,
      state.work,
      value,
      active,
      input.resolvedExpansionIds,
    ),
  }));
  if (event.itemId && !item)
    throw new Error("Reflection event has no admitted item");
  if (event.kind === "completion" && (!workSettled(work) || work?.execution))
    return undefined;
  if (
    event.kind === "integration-contract-conflict" &&
    !work?.recovery?.failure?.predecessor
  )
    return undefined;
  if (
    event.kind === "blocker" &&
    !state.wait &&
    !work?.wait &&
    !work?.recovery?.failure &&
    !blockers.some((value) => value.blocker)
  )
    return undefined;
  const previous = state.workflowReflection?.records.at(-1);
  // Ordinary task completion alone is not a reason for another checkpoint.
  const reassessing =
    previous &&
    [
      "existing-critical-path",
      "existing-diagnosis",
      "reviewed-amendment",
    ].includes(previous.action.kind) &&
    (previous.action.eligibleItemIds.includes(event.itemId ?? "") ||
      previous.event.itemId === event.itemId);
  if (
    event.kind === "completion" &&
    !reassessing &&
    !pending.some((value) => value.dependencies.includes(event.itemId!))
  )
    return undefined;
  if (!pending.length && event.kind === "completion" && !previous)
    return undefined;
  const observations = facts(state);
  const factsDigest = hash(observations);
  const repeated = [...(state.workflowReflection?.records ?? [])]
    .reverse()
    .find(
      (record) =>
        record.event.kind === event.kind &&
        record.event.itemId === event.itemId &&
        record.factsDigest === factsDigest,
    );
  if (repeated) return repeated;
  const baseline = progress(state);
  let previousAvailable = true;
  if (previous) {
    try {
      await readWorkflowReflection(input.store, previous);
    } catch {
      previousAvailable = false;
    }
  }
  const comparable =
    previousAvailable &&
    previous?.binding.graphDigest === observations.graphDigest;
  const completedItemDelta = comparable
    ? baseline.completedItems - previous.baseline.completedItems
    : null;
  const currentProofDelta = comparable
    ? baseline.currentProofs - previous.baseline.currentProofs
    : null;
  const repairedAttemptDelta = comparable
    ? baseline.repairedAttempts - previous.baseline.repairedAttempts
    : null;
  const completedAttemptMsDelta =
    comparable &&
    baseline.completedAttemptMs !== null &&
    previous.baseline.completedAttemptMs !== null
      ? baseline.completedAttemptMs - previous.baseline.completedAttemptMs
      : null;
  const outcome: WorkflowReflectionRecord["assessment"]["outcome"] = !previous
    ? "initial"
    : !comparable
      ? "inconclusive"
      : completedItemDelta! > 0 || currentProofDelta! > 0
        ? "useful-progress"
        : "no-progress";
  const uncertain =
    observations.publications.some((value) => value.uncertain) ||
    observations.projectionEffects.some((value) => value.uncertain) ||
    observations.sessions.some(
      (session) => session.turn?.resources === "unknown",
    ) ||
    observations.items.some(
      (value) => value.branchUpdateFrom !== null || value.diagnosisUncertain,
    ) ||
    Object.keys(state.stackMerges ?? {}).length > 0 ||
    Boolean(
      state.coordinator?.cancelError ||
        state.pendingExpansion ||
        state.pendingAmendment,
    );
  const eligible = blockers
    .filter((value) => !value.blocker)
    .map((value) => value.itemId);
  const failure = work?.recovery?.failure;
  const allowances = remaining(state, item ? repairScopes(state, item.id) : []);
  const diagnosisEligible =
    failure?.event &&
    failure.classification === "implementation" &&
    implementationRepairable(
      state,
      failure.event,
      item ? repairScopes(state, item.id) : [],
    ) &&
    (work?.recovery?.diagnosisInvocation?.rejected?.length ?? 0) <
      PAID_ATTEMPTS;
  const kind: WorkflowReflectionRecord["action"]["kind"] = uncertain
    ? "hold"
    : event.kind === "integration-contract-conflict"
      ? failure?.predecessor?.graphDigest === observations.graphDigest &&
        amendmentAllowed(state)
        ? "reviewed-amendment"
        : "hold"
      : failure
        ? diagnosisEligible
          ? "existing-diagnosis"
          : "hold"
        : outcome === "no-progress"
          ? "no-change"
          : eligible.length
            ? "existing-critical-path"
            : "no-change";
  const cause = uncertain
    ? "Submitted effects or an admitted graph transition remain unresolved"
    : failure
      ? "A retained task failure requires a meaningful correction; elapsed time is not its cause"
      : blockers.some((value) => value.blocker?.kind === "operator")
        ? "A retained prerequisite or decision blocks dependent work"
        : blockers.some((value) => value.blocker)
          ? "Accepted dependencies, ownership or shared resources constrain pending work"
          : "A settled result made admitted downstream work eligible";
  const reason =
    kind === "existing-critical-path"
      ? "Continue the existing critical-path and explicit-priority order inside admitted ownership and phase ceilings"
      : kind === "existing-diagnosis"
        ? "Use the existing finite diagnosis/correction cycle and its original failure event; reflection grants no attempt"
        : kind === "reviewed-amendment"
          ? "Return the retained predecessor conflict to its existing owner and independently reviewed amendment path; no batching or edge change is admitted here"
          : kind === "hold"
            ? "Keep submitted identities, owners and spent allowances; resolve the existing decision or exhausted path before any changed organization"
            : outcome === "no-progress"
              ? "No useful acceptance progress is established; stop reconsidering this organization until a material fact or diagnosed correction changes"
              : "No eligible organizational change is justified; preserve the cohesive owner and required proof";
  const proposal = {
    event,
    binding: {
      repository: state.repository,
      objective: state.objective,
      runId: state.runId,
      configDigest: state.configDigest,
      graphDigest: observations.graphDigest,
      baseSha: state.baseSha,
    },
    factsDigest,
    cause,
    affectedPendingItemIds: pending.map((value) => value.id),
    action: { kind, eligibleItemIds: kind === "hold" ? [] : eligible, reason },
    expectedProgress:
      kind === "existing-critical-path"
        ? "Advance already admitted dependencies and proof nodes without another planning call"
        : "Preserve current evidence and require a useful diagnosed change or resolved prerequisite before claiming improvement",
    qualityEffect:
      "Preserve substantive coverage, independent review, exact-tree command proof, required delivery-head CI and final acceptance; no historical result becomes new acceptance",
    remainingAllowances: allowances,
    diagnosisAttemptsRemaining: failure
      ? Math.max(
          0,
          PAID_ATTEMPTS -
            (work?.recovery?.diagnosisInvocation?.rejected?.length ?? 0) -
            (work?.recovery?.diagnosisInvocation?.submitted ? 1 : 0),
        )
      : null,
    baseline,
    assessment: {
      previousId: previous?.id ?? null,
      outcome,
      completedItemDelta,
      currentProofDelta,
      repairedAttemptDelta,
      completedAttemptMsDelta,
      confounders: [
        "No causal speedup is established from this small observational sample",
        "Provider usage and queue duration are unavailable; missing values are not zero",
        "Completed attempt duration is not elapsed time to acceptance",
        ...(previousAvailable
          ? []
          : [
              "Previous supporting observations are unavailable; historical metrics cannot support this reassessment",
            ]),
        ...(!previous ||
        previous.binding.graphDigest === observations.graphDigest
          ? []
          : [
              "Graph revision changed; progress baselines are not directly comparable",
            ]),
      ],
    },
    reassess: "next-material-event" as const,
  };
  const bytes = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      proposal,
      observations,
      obligations: workflowStageObligations(state),
      capacity: state.capacity,
      // Immutable linked source refs preserve settled experiments beyond the
      // bounded active view, without resetting any operational accounting.
      previousRecord: previous ?? null,
    }),
  );
  if (bytes.length > MAX_BODY_BYTES) return undefined;
  const bodyRef = await input.store.put(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    { mediaType: "application/json" },
  );
  const metadata = { ...proposal, bodyRef };
  const record: WorkflowReflectionRecord = { ...metadata, id: hash(metadata) };
  state.workflowReflection = {
    schemaVersion: 1,
    records: [...(state.workflowReflection?.records ?? []), record].slice(
      -MAX_RECORDS,
    ),
  };
  assertWorkflowReflection(state);
  input.save();
  return record;
}
