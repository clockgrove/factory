import { graphItems } from "./split.js";
import { settleAbandonedPlanningTurn } from "../agent-session.js";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { Readable } from "node:stream";
import { COMPILER_READINESS_GUIDANCE } from "../compiler-wire.js";
import { stateRoot } from "../config.js";
import { LocalContentStore } from "../content/local.js";
import type {
  ApprovedPlaybookPin,
  ContentRef,
  ContentStore,
  ExecutionProfileChoices,
  ModelInvocationContext,
  ModelInvocationObservation,
  ModelInvocationPhase,
  PlanningExecutionBounds,
  PlanningLocalExecutables,
  PlanningModel,
  PlanningPrerequisites,
  PlanReviewRequest,
  WorkGraph,
} from "../contracts.js";
import {
  CONTROLLER_CAPABILITIES_DIGEST,
  installedControllerCapabilities,
} from "../controller-capabilities.js";
import {
  attachedFault,
  decision,
  plannerDecisionOf,
  StepFault,
} from "../fault.js";
import { UnsettledSubprocessError } from "../process.js";
import { awaitCheckpointAdmission } from "../recovery-checkpoint.js";
import {
  allowanceAvailable,
  chargeRepair,
  consumption,
  failureDigest,
  objectiveEvent,
  PAID_ATTEMPTS,
  type RepairClass,
  type RepairLedger,
} from "../repair-policy.js";
import {
  assertReviewPacketBinding,
  decodeGraphReview,
  type ReviewPacket,
  type ReviewPacketRecord,
  reviewPacket,
  reviewPacketRecord,
} from "../review-evidence.js";
import type { ContinuationState } from "../state.js";
import {
  assertWorkflowRecipeInput,
  type WorkflowRecipeInput,
  type WorkflowRecipePin,
} from "../workflow-recipes.js";
import {
  buildPlanCandidate,
  type PlanCandidate,
  verifyPlanCandidate,
} from "./candidate.js";
import {
  assertPlanningLookupRecord,
  contextDigest,
  initializeContextLookup,
  MissingPlanningContext,
  type PlanningContextResolver,
  type PlanningLookupRecord,
  resolveContextRequests,
  retainContextPacket,
} from "./context.js";
import {
  invalidOutput,
  MalformedPlannerOutput,
  PlanValidationError,
} from "./faults.js";
import { digest, planningReviewEvidence, planReviewPacket } from "./packets.js";
import {
  checkedPlanReview,
  compileObjective,
  freshPlannerSession,
  generatePlannerStructured,
  type PlanCorrection,
  PlanningContextResponse,
  PlanningNeedsDecision,
  withPlannerAdmission,
} from "./planning.js";
import { planningSources } from "./sources.js";

/** Compile and independently review a candidate without GitHub or run-state writes. */
export interface PlanningReviewRecord {
  contextDigest: string;
  /** Row digests only; the content is re-derived from the request's inputs. */
  packet: ReviewPacketRecord;
  response?: Awaited<ReturnType<PlanningModel["reviewGraph"]>>;
}

interface PlanningInvocationReceipt {
  id: string;
  phase: string;
  resultDigest?: string;
  /** Submitted, then settled without an authenticated native outcome; its answer is never used. */
  abandoned?: true;
  /** Exact adapter-native bodies; these are evidence, never a reconstructed response. */
  nativeReturns?: ContentRef[];
}

export interface PlanningRecoveryRecord {
  /** Resource coverage only; never a native response or non-submission verdict. */
  cancelledResources?: {
    coverage: import("../contracts.js").RetainedPlannerCheckpointCoverage;
    invocationId: string;
    phase: "compile" | "diagnosis";
    scope: import("../contracts.js").AgentSessionScope;
  };
  contextLookup?: PlanningLookupRecord;
  phase: "ready" | "submitted" | "complete" | "stopped";
  invocation?: { id: string; phase: string };
  invocations?: PlanningInvocationReceipt[];
  response?: unknown;
  responseFailure?: string;
  /** The current round's complete compiler answer, when one decoded. */
  answer?: ContentRef;
  /** The plan this revision round changes: the previous round's answer. */
  revision?: ContentRef;
  diagnosisResponse?: { kind: string; diagnosis: string; correction: string };
  review?: PlanningReviewRecord;
  history: {
    failure: string;
    detail: string;
    invocations: PlanningInvocationReceipt[];
    kind: RepairClass;
    diagnosis: string;
    correction: string;
    /** The exact corrections a check or review supplied without a diagnosis. */
    corrections?: PlanCorrection[];
    review?: PlanningReviewRecord;
  }[];
}

/** Retain the current owned native original and complete its existing admission. */
export async function retainPlanningNativeReturn(
  args: {
    record: PlanningRecoveryRecord;
    invocationId: string;
    phase: ModelInvocationPhase;
    repository: string;
    store: ContentStore;
    save: () => void;
  },
  receipt: Parameters<
    NonNullable<ModelInvocationContext["retainNativeReturn"]>
  >[0],
): Promise<"admission-complete"> {
  const owner = args.record.invocations?.find(
    (entry) => entry.id === args.invocationId && entry.phase === args.phase,
  );
  if (!owner || args.record.invocation?.id !== args.invocationId)
    throw new Error("Native planning return has a superseded invocation owner");
  const bytes = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      invocationId: args.invocationId,
      phase: args.phase,
      ...receipt,
    }),
  );
  const ref = await args.store.put(
    Readable.toWeb(Readable.from([bytes])) as ReadableStream<Uint8Array>,
    { mediaType: "application/json" },
  );
  owner.nativeReturns ??= [];
  owner.nativeReturns.push(ref);
  args.save();
  // Retained locally; the next pre-effect checkpoint carries it.
  await awaitCheckpointAdmission(args.repository, "settled");
  return "admission-complete";
}

class PlanningReviewBindingError extends Error {}

/** A complete compiler answer, retained by reference in the content store. */
async function retainPlanAnswer(
  store: ContentStore,
  answer: unknown,
): Promise<ContentRef> {
  return store.put(
    Readable.toWeb(
      Readable.from([Buffer.from(JSON.stringify(answer))]),
    ) as ReadableStream<Uint8Array>,
    { mediaType: "application/json" },
  );
}

/** The exact retained answer a revision changes, verified against its reference. */
async function readPlanAnswer(
  store: ContentStore,
  ref: ContentRef,
): Promise<unknown> {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(
      await new Response(await store.open(ref)).arrayBuffer(),
    );
  } catch {
    throw new PlanningReviewBindingError(
      "Retained plan answer is unavailable from the content store; preserve the planning record and use supported cancellation before a corrected successor",
    );
  }
  if (
    bytes.length !== ref.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== ref.digest
  )
    throw new PlanningReviewBindingError(
      "Retained plan answer differs from its reference; preserve it and use supported cancellation before a corrected successor",
    );
  return JSON.parse(bytes.toString("utf8"));
}

/** A review as history keeps it; a retained packet's inline content is dropped. */
function reviewByReference(review: PlanningReviewRecord): PlanningReviewRecord {
  return structuredClone({
    ...review,
    packet: reviewPacketRecord(review.packet),
  });
}

/** The retained review (by reference) and its packet with the re-derived content. */
function retainedPlanningReview(
  record: PlanningRecoveryRecord,
  packet: PlanReviewRequest,
  configDigest: string,
): { review: PlanningReviewRecord; packet: ReviewPacket } {
  const contextDigest = digest(JSON.stringify([configDigest, packet]));
  if (record.review) {
    if (record.review.contextDigest !== contextDigest)
      throw new PlanningReviewBindingError(
        "Retained planning review context changed; preserve its evidence and use supported cancellation before a corrected successor",
      );
    try {
      return {
        review: record.review,
        packet: assertReviewPacketBinding(
          record.review.packet,
          [],
          planningReviewEvidence(packet),
        ),
      };
    } catch {
      throw new PlanningReviewBindingError(
        "Retained planning review request binding is invalid; do not reconstruct or replay it",
      );
    }
  }
  const evidence = reviewPacket([], planningReviewEvidence(packet));
  return {
    review: { contextDigest, packet: reviewPacketRecord(evidence) },
    packet: evidence,
  };
}

/** Freeze and admit the current logical intent after complete provider admission. */
export async function checkpointPlanningDispatch(args: {
  record: PlanningRecoveryRecord;
  id: string;
  phase: ModelInvocationPhase;
  repository?: string;
  save: () => void;
}): Promise<"admission-complete"> {
  if (
    args.record.invocation?.id !== args.id ||
    args.record.invocation.phase !== args.phase
  )
    throw new Error("Planning dispatch differs from its current invocation");
  args.record.phase = "submitted";
  args.save();
  await awaitCheckpointAdmission(args.repository, "before-effect");
  return "admission-complete";
}

export interface PlanningRecoveryContext {
  contextResolver?: PlanningContextResolver;
  sessionState?: ContinuationState;
  state: RepairLedger & {
    planningRecovery?: PlanningRecoveryRecord;
    plan?: PlanCandidate;
    approvedPlaybookPin?: ApprovedPlaybookPin;
    workflowRecipePin?: WorkflowRecipePin;
  };
  save: () => void;
  stopped?: () => boolean;
}

/**
 * The one planning path: compile, review independently, and revise against
 * the allowance, recording each model call in `context.state` so a repeat
 * (a step's, a restart's) never pays again for a call that completed.
 */
export async function compilePlan(
  ...args: Parameters<typeof compilePlanAdmitted>
): Promise<PlanCandidate> {
  const context = args[8];
  return context.sessionState
    ? withPlannerAdmission(
        context.sessionState,
        context.stopped ?? (() => false),
        () => compilePlanAdmitted(...args),
      )
    : compilePlanAdmitted(...args);
}

async function compilePlanAdmitted(
  objective: number,
  body: string,
  baseSha: string,
  checkout: string,
  model: PlanningModel,
  configDigest: string,
  observe: ((observation: ModelInvocationObservation) => void) | undefined,
  executionProfiles: ExecutionProfileChoices | undefined,
  context: PlanningRecoveryContext,
  prerequisites?: PlanningPrerequisites,
  localExecutables?: PlanningLocalExecutables,
  executionBounds?: PlanningExecutionBounds,
  workflowRecipe?: WorkflowRecipeInput,
): Promise<PlanCandidate> {
  const { state, save } = context;
  if (workflowRecipe) assertWorkflowRecipeInput(workflowRecipe);
  if (
    JSON.stringify(state.workflowRecipePin) !==
    JSON.stringify(workflowRecipe?.pin)
  )
    throw new PlanningReviewBindingError(
      "Planning recipe differs from its retained admission",
    );
  if (
    JSON.stringify(state.approvedPlaybookPin) !==
    JSON.stringify(model.approvedPlaybookPin)
  )
    throw new Error(
      "Planning model differs from the retained advisory selection",
    );
  state.planningRecovery ??= { phase: "ready", history: [] };
  const record = state.planningRecovery;
  if (
    context.contextResolver &&
    model.providerAttemptAdmission !== "controller-checkpoint-v1"
  )
    throw new PlanningReviewBindingError(
      "Context-enabled planning requires a model with controller admission before every native provider attempt",
    );
  if (record.contextLookup) {
    assertPlanningLookupRecord(record.contextLookup);
    if (
      !context.contextResolver ||
      record.contextLookup.packet.binding !== context.contextResolver.binding ||
      contextDigest(record.contextLookup.packet.bounds) !==
        contextDigest(context.contextResolver.bounds)
    )
      throw new PlanningReviewBindingError(
        "Retained lookup source/environment or frozen limits changed; no new dispatch is admitted",
      );
    await context.contextResolver.contentStore.verify(
      record.contextLookup.packetRef!,
    );
  } else if (context.contextResolver) {
    record.contextLookup = await initializeContextLookup(
      context.contextResolver,
    );
    save();
  }
  // A retried call whose turn its adapter settled without an outcome is
  // abandoned here too, so a live owner plans afresh instead of stopping.
  if (context.sessionState)
    await settleAbandonedPlanningTurn(context.sessionState, model, save);
  const recoverInvocationId =
    record.phase === "submitted" ? record.invocation?.id : undefined;
  // Submitted calls retain their original owner until authenticated settlement.
  if (
    record.phase === "submitted" &&
    (!context.sessionState || record.invocation?.phase === "graph-review")
  )
    throw new StepFault(
      decision(
        "Submitted planning call cannot be replayed without authenticated adapter settlement; preserve the retained invocation",
      ),
    );
  if (record.phase === "stopped")
    throw new PlanningNeedsDecision(
      "Planning recovery stopped; inspect the preserved exact decision",
    );
  const sources = planningSources(body, baseSha, checkout);
  if (record.review) {
    try {
      assertReviewPacketBinding(
        record.review.packet,
        [],
        planningReviewEvidence({
          sources,
          prerequisites,
          localExecutables,
          executionBounds,
          contextLookup: record.contextLookup?.packet,
          workflowRecipe,
        }),
      );
    } catch {
      throw new PlanningReviewBindingError(
        "Retained planning review evidence changed or its binding is invalid; preserve the original and use supported cancellation before a corrected successor",
      );
    }
  }
  if (record.phase === "complete") {
    if (!state.plan || record.review?.response === undefined)
      throw new PlanningReviewBindingError(
        "Completed planning review lacks its original request binding; do not reconstruct or replay it",
      );
    const packet = planReviewPacket(
      body,
      baseSha,
      sources,
      state.plan.graph,
      checkout,
      executionProfiles,
      prerequisites,
      localExecutables,
      executionBounds,
      state.approvedPlaybookPin,
      record.contextLookup?.packet,
      workflowRecipe,
    );
    const retained = retainedPlanningReview(record, packet, configDigest);
    if (
      decodeGraphReview(
        record.review.response,
        retained.packet,
        graphItems(state.plan.graph).map((item) => item.id),
      ).length
    )
      throw new PlanningReviewBindingError(
        "Completed planning review retains unresolved findings",
      );
    verifyPlanCandidate(
      state.plan,
      objective,
      body,
      baseSha,
      checkout,
      configDigest,
    );
    return structuredClone(state.plan);
  }
  // Retained bodies (native returns, plan answers) persist by reference.
  const contentStore: ContentStore | undefined =
    context.contextResolver?.contentStore ??
    (context.sessionState
      ? new LocalContentStore(
          join(stateRoot(context.sessionState.repository), "content"),
        )
      : undefined);
  // This round's complete compiler answer, until it is retained by reference.
  let answered: unknown;
  const last = record.history.at(-1);
  let corrections: PlanCorrection[] = last
    ? (last.corrections ?? [{ source: "diagnosis", detail: last.correction }])
    : [];
  const invocationHooks = (
    id: string,
    phase: ModelInvocationPhase,
  ): Pick<
    ModelInvocationContext,
    "beforeProviderAttempt" | "beforeProviderDispatch" | "retainNativeReturn"
  > => ({
    ...(model.providerDispatchAdmission === "after-attempt-admission-v1"
      ? {
          beforeProviderDispatch: () =>
            checkpointPlanningDispatch({
              record,
              id,
              phase,
              repository: context.sessionState?.repository,
              save,
            }),
        }
      : {}),
    beforeProviderAttempt: async () => {
      if (phase === "compile" && record.contextLookup) {
        const lookup = record.contextLookup;
        if (lookup.providerCalls >= lookup.packet.bounds.maxProviderCalls) {
          record.phase = "stopped";
          save();
          throw new StepFault(
            decision("Frozen planning lookup provider allowance is exhausted"),
          );
        }
        lookup.providerCalls++;
        save();
      }
      // The declared immediately following dispatch hook checkpoints these
      // charged attempt facts together with its current logical intent. No
      // transport effect can occur between the two controller callbacks.
      if (model.providerDispatchAdmission !== "after-attempt-admission-v1")
        await awaitCheckpointAdmission(
          context.sessionState?.repository,
          "before-effect",
        );
    },
    ...(context.sessionState &&
    [17, 18, 19, 20].includes(context.sessionState.schemaVersion)
      ? {
          retainNativeReturn: (receipt) =>
            retainPlanningNativeReturn(
              {
                record,
                invocationId: id,
                phase,
                repository: context.sessionState!.repository,
                store: contentStore!,
                save,
              },
              receipt,
            ),
        }
      : {}),
  });
  const invocation = (phase: ModelInvocationPhase): ModelInvocationContext => {
    if (context.stopped?.()) throw new Error("Planning is paused or cancelled");
    if (
      (phase === "compile" &&
        (record.response !== undefined ||
          record.responseFailure !== undefined)) ||
      (phase === "graph-review" && record.review?.response !== undefined) ||
      (phase === "diagnosis" && record.diagnosisResponse !== undefined)
    )
      return {
        invocationId: record.invocation?.id ?? "preserved",
        phase,
        ordinal: consumption(state).planningRevisions,
      };
    if (record.phase === "submitted") {
      if (record.invocation?.phase !== phase)
        throw new StepFault(
          decision(
            "A different submitted planner invocation still owns this scope",
          ),
        );
      return {
        ...invocationHooks(record.invocation.id, phase),
        invocationId: record.invocation.id,
        phase,
        ordinal: consumption(state).planningRevisions,
        observe,
      };
    }
    if (
      phase === "compile" &&
      record.contextLookup &&
      record.contextLookup.providerCalls >=
        record.contextLookup.packet.bounds.maxProviderCalls
    ) {
      record.phase = "stopped";
      save();
      throw new PlanningNeedsDecision(
        "Frozen planning lookup provider allowance is exhausted",
      );
    }
    const prepared =
      record.invocation?.phase === phase &&
      !record.invocations?.some(
        (entry) => entry.id === record.invocation!.id && entry.resultDigest,
      );
    const id = prepared ? record.invocation!.id : randomUUID();
    if (model.providerDispatchAdmission !== "after-attempt-admission-v1")
      record.phase = "submitted";
    record.invocation = { id, phase };
    record.invocations ??= [];
    if (!prepared) record.invocations.push({ id, phase });
    save();
    return {
      ...invocationHooks(id, phase),
      invocationId: id,
      phase,
      ordinal: consumption(state).planningRevisions,
      observe,
    };
  };
  const retainResult = (result: unknown): void => {
    const receipt = record.invocations?.at(-1);
    if (receipt) receipt.resultDigest = failureDigest(JSON.stringify(result));
  };
  const observedModel: PlanningModel = {
    ...(model.providerAttemptAdmission
      ? { providerAttemptAdmission: model.providerAttemptAdmission }
      : {}),
    ...(model.retainedPlannerCheckpointCoverage
      ? {
          retainedPlannerCheckpointCoverage:
            model.retainedPlannerCheckpointCoverage,
        }
      : {}),
    ...(model.providerDispatchAdmission
      ? { providerDispatchAdmission: model.providerDispatchAdmission }
      : {}),
    ...(model.sessionCapabilities
      ? { sessionCapabilities: model.sessionCapabilities }
      : {}),
    ...(model.releaseSession
      ? { releaseSession: model.releaseSession.bind(model) }
      : {}),
    ...(model.reconcileSession
      ? { reconcileSession: model.reconcileSession.bind(model) }
      : {}),
    ...(model.decodeSessionResponse
      ? { decodeSessionResponse: model.decodeSessionResponse.bind(model) }
      : {}),
    approvedPlaybook: model.approvedPlaybook,
    approvedPlaybookPin: model.approvedPlaybookPin,
    generateStructured: async (request) => {
      if (record.response !== undefined)
        return structuredClone(record.response) as never;
      if (record.responseFailure) throw invalidOutput(record.responseFailure);
      let result;
      answered = undefined;
      const retainAnswer = async () => {
        if (answered !== undefined && contentStore)
          record.answer = await retainPlanAnswer(contentStore, answered);
      };
      try {
        // A revision round plans in a fresh conversation.
        if (corrections.length && context.sessionState)
          await freshPlannerSession(model, context.sessionState, save, (id) =>
            Boolean(record.invocations?.some((entry) => entry.id === id)),
          );
        result = context.sessionState
          ? await generatePlannerStructured(
              model,
              context.sessionState,
              save,
              request,
              request.invocation?.invocationId === recoverInvocationId,
            )
          : await model.generateStructured(request);
      } catch (error) {
        if (
          error instanceof MalformedPlannerOutput ||
          error instanceof PlanValidationError
        ) {
          await retainAnswer();
          retainResult(error.message);
          record.responseFailure = error.message;
          record.phase = "ready";
          save();
        }
        throw error;
      }
      await retainAnswer();
      retainResult(result);
      record.response = structuredClone(result);
      record.phase = "ready";
      save();
      return result;
    },
    reviewGraph: async (request) => {
      if (record.review?.response !== undefined)
        return structuredClone(record.review.response);
      const result = await model.reviewGraph(request);
      retainResult(result);
      record.review!.response = structuredClone(result);
      record.phase = "ready";
      save();
      return result;
    },
  };
  // The next round revises this round's answer. Without one (a change-list
  // that did not apply, or an unreadable answer) it revises the same plan.
  const nextRevision = () => {
    if (record.answer !== undefined) record.revision = record.answer;
    delete record.answer;
  };
  while (true) {
    let graph: WorkGraph | undefined;
    let packet: PlanReviewRequest | undefined;
    let review: Awaited<ReturnType<typeof checkedPlanReview>> | undefined;
    let reviewing = false;
    let failure: string;
    // Where the failure came from when it already states what to fix.
    let stated: "check" | "review" | undefined;
    try {
      const revised =
        corrections.length && record.revision && contentStore
          ? await readPlanAnswer(contentStore, record.revision)
          : undefined;
      graph = await compileObjective(
        objective,
        body,
        baseSha,
        checkout,
        observedModel,
        [],
        corrections,
        invocation("compile"),
        executionProfiles,
        undefined,
        prerequisites,
        localExecutables,
        executionBounds,
        (decoded) => {
          graph = decoded;
        },
        undefined,
        record.contextLookup?.packet,
        workflowRecipe,
        {
          ...(revised !== undefined && { answer: revised }),
          retain: (answer) => {
            answered = structuredClone(answer);
          },
        },
      );
      packet = planReviewPacket(
        body,
        baseSha,
        sources,
        graph,
        checkout,
        executionProfiles,
        prerequisites,
        localExecutables,
        executionBounds,
        state.approvedPlaybookPin,
        record.contextLookup?.packet,
        workflowRecipe,
      );
      const retained = retainedPlanningReview(record, packet, configDigest);
      record.review = retained.review;
      save();
      reviewing = true;
      review = await checkedPlanReview(
        observedModel,
        packet,
        invocation("graph-review"),
        retained.packet,
      );
      if (!review.findings.length && !review.failure) {
        const candidate = buildPlanCandidate(
          objective,
          body,
          baseSha,
          configDigest,
          executionProfiles,
          sources,
          graph,
          packet,
          review,
          record.history.length,
        );
        state.plan = candidate;
        delete record.response;
        delete record.responseFailure;
        delete record.answer;
        delete record.revision;
        record.phase = "complete";
        save();
        return candidate;
      }
      // A review that did not answer validly is not a revision. A paid step
      // sees it as a fault of its paid call and re-asks within its bound
      // (paidPlanningModel); without a step it is kept for the operator.
      // Fix findings are the planner's: a review with any is revised for
      // them alone, and the revised plan's fresh review asks the operator
      // only the decisions that remain (#1434).
      const fixes = review.findings.filter((finding) => finding.kind === "fix");
      failure = JSON.stringify(
        fixes.length ? { ...review, findings: fixes } : review,
      );
      if (review.findings.length) stated = "review";
    } catch (error) {
      if (error instanceof MissingPlanningContext) {
        record.phase = "stopped";
        save();
        throw new PlanningNeedsDecision(error.message);
      }
      // The planner asked a question the operator answers (#1296): planning
      // stops for that decision instead of revising against the allowance.
      const asked = plannerDecisionOf(error);
      if (asked) {
        record.phase = "stopped";
        save();
        throw new PlanningNeedsDecision(asked.question);
      }
      if (error instanceof PlanningContextResponse) {
        const lookup = record.contextLookup;
        const resolver = context.contextResolver;
        if (!lookup || !resolver)
          throw new Error("Context response has no admitted resolver");
        if (error.response.kind === "human-dependency") {
          record.phase = "stopped";
          save();
          throw new PlanningNeedsDecision(
            `${error.response.question}: ${error.response.detail}`,
          );
        }
        const requests = error.response.requests;
        const identity = contextDigest(
          requests.map(
            ({ collection, operation, selector, query, required }) => ({
              collection,
              operation,
              selector,
              query,
              required,
            }),
          ),
        );
        if (
          lookup.packet.batches.length >= lookup.packet.bounds.maxRounds ||
          requests.length > lookup.packet.bounds.maxRequestsPerRound ||
          lookup.requestDigests.includes(identity)
        ) {
          record.phase = "stopped";
          save();
          throw new PlanningNeedsDecision(
            "Context lookup exhausted its frozen rounds or repeated an unchanged no-progress request",
          );
        }
        const results = await resolveContextRequests(
          lookup,
          resolver,
          requests,
        );
        lookup.packet.batches.push(results);
        lookup.requestDigests.push(identity);
        await retainContextPacket(lookup, resolver.contentStore);
        delete record.response;
        delete record.invocation;
        record.phase = "ready";
        save();
        continue;
      }
      // Only an answered plan (refused or invalid) is revised against the
      // allowance; a transient or configuration fault is never charged.
      // checkedPlanReview turns every answered review into a finding or a
      // failure, so whatever escapes it (even invalid output) is the step's.
      const fault = attachedFault(error);
      const answered =
        !reviewing &&
        (error instanceof MalformedPlannerOutput ||
          error instanceof PlanValidationError);
      if (
        (model.providerDispatchAdmission === "after-attempt-admission-v1" &&
          record.phase === "ready" &&
          record.invocation &&
          !record.invocations?.some(
            (entry) => entry.id === record.invocation!.id && entry.resultDigest,
          )) ||
        error instanceof UnsettledSubprocessError ||
        error instanceof PlanningReviewBindingError ||
        context.stopped?.() ||
        (String(record.phase) === "submitted" &&
          (record.invocation?.phase !== "diagnosis" || reviewing)) ||
        fault?.kind === "config" ||
        fault?.kind === "decision" ||
        fault?.kind === "cancelled" ||
        (fault?.kind === "transient" && !answered)
      )
        throw error;
      if (record.review)
        throw new PlanningReviewBindingError(
          "Retained planning review compiled input cannot be validated; preserve its evidence and use supported cancellation before a corrected successor",
        );
      failure = error instanceof Error ? error.message : String(error);
      if (answered) stated = "check";
    }
    const identity = failureDigest(failure);
    const unchanged = record.history.some(
      (entry) => entry.failure === identity,
    );
    // Diagnosis is bounded independently; only an admitted engineering
    // correction consumes a revision. An operator question changes no graph.
    const permitted = (
      ["planning-output", "planning-evidence", "planning-choice"] as const
    ).filter((kind) => state.autonomy.repairClasses.includes(kind));
    // One revision is charged per failed round; the round is the number of
    // accepted corrections before it.
    const event = objectiveEvent("plan", record.history.length);
    const unanswered = Boolean(review && !review.findings.length);
    const fixes =
      review?.findings.filter((finding) => finding.kind === "fix") ?? [];
    const diagnosed = (record.invocations ?? []).filter(
      (entry) => entry.phase === "diagnosis",
    ).length;
    if (
      unchanged ||
      unanswered ||
      (diagnosed >= PAID_ATTEMPTS &&
        record.invocation?.phase !== "diagnosis") ||
      !permitted.length ||
      !allowanceAvailable(state, event, "planningRevisions", ["$planning"])
    ) {
      // A reviewed graph waits for an operator plan decision only when no fix
      // finding remains; fixes the planner could not apply stop planning and
      // say why, never become operator choices. Anything else stops planning.
      record.phase = "stopped";
      if (graph && packet && review && !fixes.length) {
        const candidate = buildPlanCandidate(
          objective,
          body,
          baseSha,
          configDigest,
          executionProfiles,
          sources,
          graph,
          packet,
          review,
          record.history.length,
        );
        state.plan = candidate;
        save();
        return candidate;
      }
      save();
      const reason = unchanged
        ? "Unchanged planning failure"
        : diagnosed >= PAID_ATTEMPTS
          ? `Planning diagnosis did not answer ${PAID_ATTEMPTS} times`
          : !permitted.length
            ? "Planning correction is disabled"
            : "Planning revision allowance is exhausted";
      throw new PlanningNeedsDecision(
        fixes.length
          ? `${reason}; the planner did not apply ${fixes.length} plan review fix finding${fixes.length === 1 ? "" : "s"}`
          : `${reason}; operator decision required`,
      );
    }
    if (context.stopped?.())
      throw new Error("Planning is paused or cancelled before diagnosis");
    // A review whose findings all need an operator-owned decision waits for
    // the operator's plan decision, as a diagnosis that classified the
    // failure as operator did. A review with fix findings is revised first.
    if (
      stated === "review" &&
      record.invocation?.phase !== "diagnosis" &&
      !fixes.length
    ) {
      record.phase = "stopped";
      const candidate = buildPlanCandidate(
        objective,
        body,
        baseSha,
        configDigest,
        executionProfiles,
        sources,
        graph!,
        packet!,
        review!,
        record.history.length,
      );
      state.plan = candidate;
      save();
      return candidate;
    }
    // A deterministic refusal or a fix finding already says what is wrong, so
    // it goes back to the planner as is; the planner asks the operator through
    // decisionRequired when the fix needs a decision. Operator-decision
    // findings of the same review are not corrections: the revised plan's
    // fresh review raises them again if they still apply. A diagnosis still
    // classifies other failures, and review findings when the configuration
    // permits only some planning repair classes.
    const direct =
      record.invocation?.phase !== "diagnosis" &&
      (stated === "check"
        ? permitted.includes("planning-output")
        : stated === "review" && permitted.length === 3);
    if (direct) {
      const stating: PlanCorrection[] =
        stated === "check"
          ? [{ source: "check", detail: failure }]
          : fixes.map((finding) => ({
              source: "review" as const,
              itemIds: finding.itemIds,
              detail: finding.detail,
              question: finding.question,
              evidence: finding.evidence,
            }));
      chargeRepair(state, event, "planning-output", ["$planning"]);
      record.history.push({
        failure: identity,
        detail: failure,
        invocations: structuredClone(record.invocations ?? []),
        kind: "planning-output",
        diagnosis:
          stated === "check"
            ? "A deterministic Factory check refused the compiled graph"
            : "The independent plan review refused the compiled graph",
        correction: stating.map((entry) => entry.detail).join("\n"),
        corrections: structuredClone(stating),
        ...(record.review ? { review: reviewByReference(record.review) } : {}),
      });
      record.invocations = [];
      corrections = stating;
      nextRevision();
      delete record.response;
      delete record.responseFailure;
      delete record.review;
      record.phase = "ready";
      save();
      continue;
    }
    const diagnosisInvocation = invocation("diagnosis");
    const correctionDescriptions = {
      "planning-output":
        "malformed or invalid generated graph including invented assets",
      "planning-evidence": "omitted already supplied source facts",
      "planning-choice":
        "routine engineering choice already delegated by the Objective",
    };
    const allowedCorrections = permitted
      .map((kind) => `${kind} (${correctionDescriptions[kind]})`)
      .join(", ");
    const diagnosisRequest = {
      ...(workflowRecipe ? { workflowRecipe } : {}),
      ...(prerequisites ? { prerequisites } : {}),
      ...(localExecutables ? { localExecutables } : {}),
      ...(executionBounds ? { executionBounds } : {}),
      purpose: "diagnosis" as const,
      rejectedGraph: graph ?? null,
      objective: `Classify this planning failure from the supplied sources. Allowed engineering corrections: ${allowedCorrections}. ${COMPILER_READINESS_GUIDANCE} Return operator for missing product/security decisions, new authority or unsupported capability. Give a concrete correction within the permitted classes and recorded attempt limits; never waive findings, claim a future probe passed or infer extra retry/spending authority.\nObjective:\n${body}\nFailure:\n${failure}`,
      baseSha,
      sources,
      controllerCapabilities: installedControllerCapabilities(),
      controllerCapabilitiesDigest: CONTROLLER_CAPABILITIES_DIGEST,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "diagnosis", "correction"],
        properties: {
          kind: { type: "string", enum: [...permitted, "operator"] },
          diagnosis: { type: "string" },
          correction: { type: "string" },
        },
      },
      invocation: diagnosisInvocation,
    };
    const diagnosis =
      record.diagnosisResponse ??
      (context.sessionState
        ? await generatePlannerStructured<{
            kind: string;
            diagnosis: string;
            correction: string;
          }>(
            model,
            context.sessionState,
            save,
            diagnosisRequest,
            diagnosisInvocation.invocationId === recoverInvocationId,
          )
        : await model.generateStructured<{
            kind: string;
            diagnosis: string;
            correction: string;
          }>(diagnosisRequest));
    record.diagnosisResponse = structuredClone(diagnosis);
    retainResult(diagnosis);
    record.phase = "ready";
    save();
    if (
      !permitted.includes(diagnosis.kind as (typeof permitted)[number]) ||
      !diagnosis.diagnosis?.trim() ||
      !diagnosis.correction?.trim()
    ) {
      // Only a review with fix findings reaches diagnosis; fixes the
      // diagnosis does not admit stop planning rather than ask the operator.
      record.phase = "stopped";
      save();
      throw new PlanningNeedsDecision(
        `Planning needs an undelegated decision: ${diagnosis.diagnosis || failure}`,
      );
    }
    chargeRepair(state, event, diagnosis.kind as RepairClass, ["$planning"]);
    record.history.push({
      failure: identity,
      detail: failure,
      invocations: structuredClone(record.invocations ?? []),
      kind: diagnosis.kind as RepairClass,
      diagnosis: diagnosis.diagnosis,
      correction: diagnosis.correction,
      ...(record.review ? { review: reviewByReference(record.review) } : {}),
    });
    record.invocations = [];
    corrections = [{ source: "diagnosis", detail: diagnosis.correction }];
    nextRevision();
    delete record.response;
    delete record.responseFailure;
    delete record.review;
    delete record.diagnosisResponse;
    record.phase = "ready";
    save();
  }
}
