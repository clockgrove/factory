import { assertRetainedPlannerCheckpointCoverage } from "./compiler/transport.js";
import { LocalContentStore } from "./content/local.js";
import { stateRoot } from "./config.js";
import {
  assertWorkflowRecipePin,
  type WorkflowRecipePin,
} from "./workflow-recipes.js";
import { isExecutionState, isPreparationState } from "./state.js";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  assertContextLookupBounds,
  type PlanningContextPacket,
} from "./compiler/context.js";
import type {
  AgentSessionCapabilities,
  AgentSessionContinuation,
  AgentSessionRef,
  AgentSessionScope,
  ApprovedPlaybookPin,
  ExecutionDriver,
  PlanningModel,
} from "./contracts.js";
import { assertApprovedPlaybookPin } from "./contracts.js";
import { assertDurableValue } from "./execution/checkpoint.js";
import { graphDigest } from "./graph-amendments.js";
import { withCheckpointDisposals } from "./recovery-checkpoint.js";
import type { ContinuationState } from "./state.js";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Agent session is not an object");
  return value as Record<string, unknown>;
}

const roles = [
  "planning",
  "implementation",
  "result-review",
  "objective-review",
];

export function assertAgentSessionCapabilities(
  value: unknown,
): asserts value is AgentSessionCapabilities {
  const capabilities = object(value);
  if (
    Object.keys(capabilities).some((key) => key !== "resumeRoles") ||
    !Array.isArray(capabilities.resumeRoles) ||
    capabilities.resumeRoles.some((role) => !roles.includes(role)) ||
    new Set(capabilities.resumeRoles).size !== capabilities.resumeRoles.length
  )
    throw new Error("Agent session capabilities are invalid");
}

/** Frozen inputs survive projection and lookup rounds; each turn binds its exact current packet separately. */
export function planningSessionInputDigest(inputs: {
  baseSha: string;
  objectiveBodyDigest?: string;
  sourcePacketDigest?: string;
  approvedPlaybookPin: ApprovedPlaybookPin;
  workflowRecipePin?: WorkflowRecipePin;
  planningRecovery?: { contextLookup?: { packet: PlanningContextPacket } };
}): string {
  if (!/^[a-f0-9]{40}$/.test(inputs.baseSha))
    throw new Error("Planner immutable base is invalid");
  for (const name of ["objectiveBodyDigest", "sourcePacketDigest"] as const)
    if (
      typeof inputs[name] !== "string" ||
      !/^[a-f0-9]{64}$/.test(inputs[name]!)
    )
      throw new Error(`Planner immutable ${name} is unavailable`);
  assertApprovedPlaybookPin(inputs.approvedPlaybookPin);
  const frozen: unknown[] = [
    inputs.baseSha,
    inputs.objectiveBodyDigest,
    inputs.sourcePacketDigest,
    inputs.approvedPlaybookPin === null
      ? null
      : {
          version: inputs.approvedPlaybookPin.version,
          digest: inputs.approvedPlaybookPin.digest,
        },
  ];
  const context = inputs.planningRecovery?.contextLookup?.packet;
  if (context) {
    if (context.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(context.binding))
      throw new Error("Planner immutable context binding is invalid");
    assertContextLookupBounds(context.bounds);
    frozen.push({
      contextVersion: context.schemaVersion,
      binding: context.binding,
      bounds: [
        context.bounds.maxRounds,
        context.bounds.maxRequestsPerRound,
        context.bounds.maxResults,
        context.bounds.maxBytes,
        context.bounds.maxElapsedMs,
        context.bounds.maxProviderCalls,
      ],
    });
  }
  if (inputs.workflowRecipePin) {
    assertWorkflowRecipePin(inputs.workflowRecipePin);
    frozen.push({ workflowRecipePin: inputs.workflowRecipePin });
  }
  return createHash("sha256").update(JSON.stringify(frozen)).digest("hex");
}

/** Scope validation authenticates identities, never native transcript contents. */
export function assertAgentSessionScope(
  value: unknown,
): asserts value is AgentSessionScope {
  const scope = object(value);
  const keys = [
    "repository",
    "objective",
    "runId",
    "configDigest",
    "graphDigest",
    "planningInputDigest",
    "role",
    "itemId",
  ];
  if (Object.keys(scope).some((key) => !keys.includes(key)))
    throw new Error("Agent session scope has unknown fields");
  for (const key of ["repository", "runId"])
    if (typeof scope[key] !== "string" || !scope[key])
      throw new Error(`Agent session ${key} is missing`);
  if (!Number.isSafeInteger(scope.objective) || (scope.objective as number) < 1)
    throw new Error("Agent session Objective is invalid");
  for (const key of [
    "configDigest",
    scope.role === "planning" ? "planningInputDigest" : "graphDigest",
  ])
    if (typeof scope[key] !== "string" || !/^[a-f0-9]{64}$/.test(scope[key]))
      throw new Error(`Agent session ${key} is invalid`);
  if (!roles.includes(scope.role as string))
    throw new Error("Agent session role is invalid");
  if (scope.role === "planning") {
    if (scope.itemId !== undefined || scope.graphDigest !== undefined)
      throw new Error(
        "Planner session cannot claim a Work Item or graph scope",
      );
  } else {
    if (scope.planningInputDigest !== undefined)
      throw new Error("Graph session cannot claim planner inputs");
    if (scope.role === "objective-review") {
      if (scope.itemId !== undefined)
        throw new Error("Objective review session cannot claim a Work Item");
    } else if (
      typeof scope.itemId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(scope.itemId)
    )
      throw new Error("Agent session Work Item is invalid");
  }
  assertDurableValue(value, "Agent session scope");
}

export function assertAgentSessionRef(
  value: unknown,
  expected?: AgentSessionScope,
): asserts value is AgentSessionRef {
  const ref = object(value);
  if (
    Object.keys(ref).some(
      (key) =>
        ![
          "scope",
          "executionIdentity",
          "adapter",
          "identity",
          "data",
          "turn",
          "currentTurn",
          "status",
        ].includes(key),
    )
  )
    throw new Error("Agent session receipt has unknown fields");
  assertAgentSessionScope(ref.scope);
  if (
    ref.executionIdentity !== undefined &&
    (ref.scope.role !== "implementation" ||
      typeof ref.executionIdentity !== "string" ||
      !/^[A-Za-z0-9_-]{1,160}$/.test(ref.executionIdentity))
  )
    throw new Error("Agent session execution owner is invalid");
  if (expected && !isDeepStrictEqual(ref.scope, expected))
    throw new Error("Agent session receipt differs from the current scope");
  if (
    typeof ref.adapter !== "string" ||
    !ref.adapter ||
    typeof ref.identity !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(ref.identity)
  )
    throw new Error("Agent session adapter or identity is invalid");
  if (
    !Number.isSafeInteger(ref.turn) ||
    (ref.turn as number) < 1 ||
    !["ready", "in-flight", "unavailable", "released"].includes(
      ref.status as string,
    )
  )
    throw new Error("Agent session turn or disposition is invalid");
  if (ref.scope.role === "planning" && ref.currentTurn === undefined)
    throw new Error("Planner session has no admitted current turn");
  if (ref.currentTurn !== undefined) {
    const current = object(ref.currentTurn);
    const digests = [
      "requestDigest",
      "graphDigest",
      "candidateDigest",
      "evidenceDigest",
      "schemaDigest",
    ];
    if (
      Object.keys(current).some(
        (key) =>
          ![
            "invocationId",
            "deadlineAt",
            ...digests,
            "dispatch",
            "terminal",
            "resources",
          ].includes(key),
      )
    )
      throw new Error("Agent session turn has unknown fields");
    if (
      typeof current.invocationId !== "string" ||
      !current.invocationId ||
      typeof current.requestDigest !== "string"
    )
      throw new Error("Agent session turn identity is missing");
    if (
      current.deadlineAt !== undefined &&
      (typeof current.deadlineAt !== "string" ||
        !Number.isFinite(Date.parse(current.deadlineAt)))
    )
      throw new Error("Agent session turn elapsed deadline is invalid");
    for (const name of digests)
      if (
        current[name] !== undefined &&
        (typeof current[name] !== "string" ||
          !/^[a-f0-9]{64}$/.test(current[name] as string))
      )
        throw new Error(`Agent session turn ${name} is invalid`);
    if (
      !["intent", "submitted"].includes(current.dispatch as string) ||
      !["active", "settled", "unknown"].includes(current.resources as string) ||
      (current.terminal !== undefined &&
        !["completed", "failed", "interrupted"].includes(
          current.terminal as string,
        ))
    )
      throw new Error("Agent session turn disposition is invalid");
    if (current.terminal !== undefined && current.dispatch !== "submitted")
      throw new Error("Unsubmitted turn cannot claim native completion");
    if (
      ref.status === "ready" &&
      (current.resources !== "settled" || current.terminal === undefined)
    )
      throw new Error("Ready session requires a settled terminal turn");
    if (
      ["unavailable", "released"].includes(ref.status as string) &&
      current.resources !== "settled"
    )
      throw new Error(
        "Unavailable session requires proved resource settlement",
      );
  }
  assertDurableValue(value, "Agent session receipt");
}

function key(scope: AgentSessionScope): string {
  return JSON.stringify([
    scope.role,
    scope.itemId ?? null,
    scope.role === "planning" ? scope.planningInputDigest : scope.graphDigest,
  ]);
}

export function assertAgentSessions(state: ContinuationState): void {
  if (
    state.agentSessionHistory !== undefined &&
    !Array.isArray(state.agentSessionHistory)
  )
    throw new Error("Agent session history is invalid");
  const records = Object.entries(object(state.agentSessions ?? {}));
  for (const ref of state.agentSessionHistory ?? []) {
    assertAgentSessionRef(ref);
    records.push([key(ref.scope), ref]);
  }
  for (const [entryKey, ref] of records) {
    assertAgentSessionRef(ref);
    if (
      entryKey !== key(ref.scope) ||
      ref.scope.repository !== state.repository ||
      ref.scope.objective !== state.objective ||
      ref.scope.runId !== state.runId ||
      ref.scope.configDigest !== state.configDigest ||
      (ref.scope.role === "planning"
        ? ref.scope.planningInputDigest !== planningSessionInputDigest(state)
        : isPreparationState(state) ||
          (ref.scope.itemId !== undefined &&
            !state.graph.items.some((item) => item.id === ref.scope.itemId)))
    )
      throw new Error(
        "Agent session differs from its retained Objective owner",
      );
  }
  const proof = state.planningRecovery?.cancelledResources;
  if (proof !== undefined) {
    object(proof);
    const planning = state.planningRecovery!;
    assertRetainedPlannerCheckpointCoverage(proof.coverage);
    assertAgentSessionScope(proof.scope);
    const expected = {
      repository: state.repository,
      objective: state.objective,
      runId: state.runId,
      configDigest: state.configDigest,
      role: "planning",
      planningInputDigest: planningSessionInputDigest(state),
    };
    if (
      Object.keys(proof).sort().join() !==
        "coverage,invocationId,phase,scope" ||
      !state.cancelRequested ||
      planning.phase !== "submitted" ||
      planning.response !== undefined ||
      !["compile", "diagnosis"].includes(proof.phase) ||
      proof.invocationId !== planning.invocation?.id ||
      proof.phase !== planning.invocation?.phase ||
      !isDeepStrictEqual(proof.scope, expected) ||
      planning.invocations?.some(
        (entry) => entry.id === proof.invocationId && entry.resultDigest,
      ) ||
      records.some(([, ref]) => {
        assertAgentSessionRef(ref);
        return (
          ref.status !== "released" ||
          (ref.currentTurn && ref.currentTurn.resources !== "settled") ||
          (ref.scope.role === "planning" &&
            ref.adapter !== proof.coverage.adapter)
        );
      })
    )
      throw new Error(
        "Planning cancellation resource proof differs from its current invocation or scope",
      );
  }
}

/** The caller already owns the lifecycle mutation lock and paid-step admission. */
export function agentSessionContinuation(
  state: ContinuationState,
  role: AgentSessionScope["role"],
  itemId: string | undefined,
  save: () => void,
): AgentSessionContinuation {
  assertAgentSessions(state);
  const objectiveScope = {
    repository: state.repository,
    objective: state.objective,
    runId: state.runId,
    configDigest: state.configDigest,
  };
  let scope: AgentSessionScope;
  if (role === "planning") {
    if (itemId !== undefined)
      throw new Error("Planner cannot claim a Work Item");
    scope = {
      ...objectiveScope,
      role,
      planningInputDigest: planningSessionInputDigest(state),
    };
  } else {
    if (!isExecutionState(state))
      throw new Error("Preparation cannot own a graph session");
    const binding = {
      ...objectiveScope,
      graphDigest: graphDigest(state.graph),
    };
    if (role === "objective-review") {
      if (itemId !== undefined)
        throw new Error("Objective reviewer cannot claim a Work Item");
      scope = { ...binding, role };
    } else {
      if (!itemId) throw new Error("Graph session Work Item is missing");
      scope = { ...binding, role, itemId };
    }
  }
  assertAgentSessionScope(scope);
  const admittedGraphDigest = isExecutionState(state)
    ? graphDigest(state.graph)
    : undefined;
  const entryKey = key(scope);
  if (
    role !== "planning" &&
    [
      ...Object.entries(state.agentSessions ?? {})
        .filter(([existingKey]) => existingKey !== entryKey)
        .map(([, ref]) => ref),
      ...(state.agentSessionHistory ?? []),
    ].some(
      (ref) =>
        ref.scope.role === role &&
        ref.scope.itemId === itemId &&
        (ref.status === "in-flight" ||
          (ref.currentTurn && ref.currentTurn.resources !== "settled")),
    )
  )
    throw new Error(
      "Role has unsettled agent ownership in another graph scope",
    );
  const retained = state.agentSessions?.[entryKey];
  let previous = JSON.stringify(retained);
  const continuation: AgentSessionContinuation = {
    scope,
    ...(state.coordinator?.deadlineAt
      ? { objectiveDeadlineAt: state.coordinator.deadlineAt }
      : {}),
    ...(scope.role === "planning" && admittedGraphDigest
      ? { currentGraphDigest: admittedGraphDigest }
      : {}),
    identity:
      retained && ["ready", "in-flight"].includes(retained.status)
        ? retained.identity
        : randomUUID(),
    ...(retained && ["ready", "in-flight"].includes(retained.status)
      ? { retained: structuredClone(retained) }
      : {}),
    checkpoint(ref) {
      if (
        (isExecutionState(state) && state.finalAcceptance) ||
        state.cancelledAt ||
        (isExecutionState(state) && state.objectiveClosure === "complete")
      )
        throw new Error(
          "Terminal or cancelling Objective cannot continue an agent session",
        );
      if (
        scope.role === "planning"
          ? planningSessionInputDigest(state) !== scope.planningInputDigest
          : !isExecutionState(state) ||
            graphDigest(state.graph) !== scope.graphDigest
      )
        throw new Error("Agent session checkpoint was superseded");
      assertAgentSessionRef(ref, scope);
      if (
        scope.role === "planning" &&
        ref.turn !== retained?.turn &&
        ref.currentTurn?.graphDigest !== admittedGraphDigest
      )
        throw new Error("Planner current turn differs from its admitted graph");
      const prior = state.agentSessions?.[entryKey];
      const sameTurn =
        prior &&
        prior.identity === ref.identity &&
        prior.adapter === ref.adapter &&
        prior.executionIdentity === ref.executionIdentity &&
        prior.turn === ref.turn;
      // Local closure can settle the owned resources without establishing a
      // native outcome. Preserve that in-flight uncertainty during cancellation.
      if (
        state.cancelRequested &&
        (!sameTurn ||
          (ref.status === "in-flight" &&
            ref.currentTurn?.resources !== "settled"))
      )
        throw new Error(
          "Cancelling Objective permits only owned turn settlement",
        );
      // Repeated settlement and disposal are safe after the caller's identity
      // has rotated for a future fresh conversation.
      if (prior && isDeepStrictEqual(prior, ref)) {
        // Cancellation and collection may each hold a callback for the same
        // admitted turn. A matching settled receipt acknowledges its result,
        // without overwriting any newer turn or rewriting the snapshot.
        previous = JSON.stringify(prior);
        if (["unavailable", "released"].includes(ref.status)) {
          delete continuation.retained;
          if (continuation.identity === ref.identity)
            continuation.identity = randomUUID();
        } else continuation.retained = structuredClone(prior);
        return;
      }
      if (JSON.stringify(state.agentSessions?.[entryKey]) !== previous)
        throw new Error("Agent session checkpoint was superseded");
      const disposingUnavailable =
        sameTurn && prior.status === "unavailable" && ref.status === "released";
      if (ref.identity !== continuation.identity && !disposingUnavailable)
        throw new Error(
          "Agent session checkpoint changed its logical identity",
        );
      if (
        prior &&
        prior.identity === ref.identity &&
        (ref.turn < prior.turn || ref.turn > prior.turn + 1)
      )
        throw new Error("Agent session checkpoint changed its turn accounting");
      if ((!prior || prior.identity !== ref.identity) && ref.turn !== 1)
        throw new Error("Fresh agent session must start at turn one");
      if (prior && prior.identity === ref.identity) {
        if (
          prior.adapter !== ref.adapter ||
          (ref.turn === prior.turn &&
            prior.executionIdentity !== ref.executionIdentity)
        )
          throw new Error(
            "Agent session changed its admitted adapter or owner",
          );
        if (ref.turn > prior.turn && prior.status !== "ready")
          throw new Error("Unsettled session cannot dispatch another turn");
        if (
          ref.turn === prior.turn &&
          prior.status !== "in-flight" &&
          ref.status === "in-flight"
        )
          throw new Error("Settled agent turn cannot become active again");
        if (ref.turn === prior.turn && prior.currentTurn) {
          if (!ref.currentTurn)
            throw new Error("Agent session lost its turn binding");
          const before = prior.currentTurn;
          const after = ref.currentTurn;
          for (const field of [
            "invocationId",
            "deadlineAt",
            "requestDigest",
            "graphDigest",
            "candidateDigest",
            "evidenceDigest",
            "schemaDigest",
          ] as const)
            if (before[field] !== after[field])
              throw new Error(
                "Agent session changed its admitted turn binding",
              );
          if (
            (before.dispatch === "submitted" &&
              after.dispatch !== "submitted") ||
            (before.terminal !== undefined &&
              before.terminal !== after.terminal) ||
            (before.resources === "settled" && after.resources !== "settled")
          )
            throw new Error("Agent session turn disposition regressed");
        }
      }
      if (prior && prior.identity !== ref.identity) {
        if (!["unavailable", "released"].includes(prior.status))
          throw new Error("An unsettled agent session cannot be replaced");
        state.agentSessionHistory ??= [];
        state.agentSessionHistory.push(structuredClone(prior));
      }
      state.agentSessions ??= {};
      state.agentSessions[entryKey] = structuredClone(ref);
      save();
      previous = JSON.stringify(ref);
      if (["unavailable", "released"].includes(ref.status)) {
        delete continuation.retained;
        if (!disposingUnavailable) continuation.identity = randomUUID();
      } else continuation.retained = structuredClone(ref);
    },
  };
  return continuation;
}

/** The reconciled receipt of the admitted turn, with its resources settled. */
function reconciledReceipt(
  ref: AgentSessionRef,
  session: AgentSessionRef,
): AgentSessionRef {
  if (
    session.identity !== ref.identity ||
    session.adapter !== ref.adapter ||
    session.turn !== ref.turn ||
    session.currentTurn?.invocationId !== ref.currentTurn?.invocationId ||
    session.currentTurn?.resources !== "settled"
  )
    throw new Error("Reconciled agent turn differs from its admitted owner");
  return session;
}

/** The ceased turn's unavailable receipt; the adapter may settle only its resources. */
function ceasedReceipt(
  ref: AgentSessionRef,
  session: AgentSessionRef,
): AgentSessionRef {
  if (reconciledReceipt(ref, session).currentTurn!.terminal !== undefined)
    throw new Error("Ceased agent turn differs from its admitted owner");
  return { ...session, status: "unavailable" };
}

/**
 * The unavailable receipt for an in-flight turn that ended without a native
 * outcome, or undefined while one may still arrive: its adapter settled the
 * local process, or proves that the process a stopped controller left behind
 * has ceased. With `settled` (cancellation, which disposes the session next),
 * an outcome the adapter recovers for the turn is also its settled receipt.
 */
export async function stoppedTurnReceipt(
  ref: AgentSessionRef,
  model: PlanningModel | undefined,
  settled = false,
): Promise<AgentSessionRef | undefined> {
  if (ref.status !== "in-flight" || !ref.currentTurn) return undefined;
  if (ref.currentTurn.terminal === undefined) {
    if (ref.currentTurn.resources === "settled")
      return { ...ref, status: "unavailable" };
  } else if (!settled) return undefined;
  const reconciled = await model?.reconcileSession?.(structuredClone(ref));
  if (reconciled?.disposition === "ceased")
    return ceasedReceipt(ref, reconciled.session);
  return settled && reconciled?.disposition === "settled"
    ? reconciledReceipt(ref, reconciled.session)
    : undefined;
}

/**
 * A review call that ended without a native outcome (a timeout, or a stopped
 * controller whose process has since ceased) leaves its turn in flight. No
 * review answer is recovered from a retained turn, so the next ask starts a
 * fresh conversation: settle the turn as abandoned, its terminal unknown and
 * its resources settled. The receipt and its storage remain for later
 * disposal. Only current-graph scopes settle; any other unsettled owner stays
 * held.
 */
export async function settleAbandonedReviewTurns(
  state: ContinuationState,
  model: PlanningModel | undefined,
  save: () => void,
  only?: { role: "result-review" | "objective-review"; itemId?: string },
): Promise<void> {
  if (
    !isExecutionState(state) ||
    state.restoration ||
    state.cancelledAt ||
    state.finalAcceptance ||
    state.objectiveClosure === "complete"
  )
    return;
  const current = graphDigest(state.graph);
  for (const ref of Object.values(state.agentSessions ?? {})) {
    const { role, itemId } = ref.scope;
    if (
      (role !== "result-review" && role !== "objective-review") ||
      (only && (only.role !== role || only.itemId !== itemId)) ||
      ref.scope.graphDigest !== current
    )
      continue;
    // A turn whose reconciliation fails stays held; the others still settle.
    const receipt = await stoppedTurnReceipt(ref, model).catch(() => undefined);
    if (receipt)
      agentSessionContinuation(state, role, itemId, save).checkpoint(receipt);
  }
}

/**
 * A planning call that ended without a usable outcome leaves its invocation
 * submitted. Settle it as abandoned so the next call is a fresh invocation and
 * retry, refuse and cancel proceed:
 * - a turn left in flight (an elapsed deadline, or a stopped controller), once
 *   its adapter settled the local process or proves it ceased and cannot
 *   authenticate an outcome: the turn becomes unavailable (terminal unknown,
 *   resources settled) in the same save;
 * - a turn that ended with an authenticated failure, or whose session is
 *   unavailable or released so no outcome can be recovered from it: the turn
 *   already holds no resource and stays as it is.
 * The receipt is kept, marked abandoned. During execution the owner is a Work
 * Item diagnosis. A live or recoverable turn stays held for its owner.
 */
export async function settleAbandonedPlanningTurn(
  state: ContinuationState,
  model: PlanningModel | undefined,
  save: () => void,
): Promise<void> {
  if (
    state.restoration ||
    state.cancelledAt ||
    state.coordinator?.processes?.length ||
    !model?.reconcileSession
  )
    return;
  // The planning session whose current turn is the invocation's.
  const owner = (id: string) =>
    Object.values(state.agentSessions ?? {}).find(
      (ref) =>
        ref.scope.role === "planning" && ref.currentTurn?.invocationId === id,
    );
  let invocationId: string;
  let abandon: () => void;
  let restore: () => void;
  if (isPreparationState(state)) {
    const planning = state.planningRecovery;
    const invocation = planning?.invocation;
    if (
      planning?.phase !== "submitted" ||
      planning.response !== undefined ||
      !invocation
    )
      return;
    const receipt = planning.invocations?.find(
      (entry) => entry.id === invocation.id && entry.phase === invocation.phase,
    );
    if (receipt?.resultDigest) return;
    invocationId = invocation.id;
    abandon = () => {
      // A submitted invocation an earlier build left without its receipt.
      if (receipt) receipt.abandoned = true;
      else {
        planning.invocations ??= [];
        planning.invocations.push({
          id: invocation.id,
          phase: invocation.phase,
          abandoned: true,
        });
      }
      delete planning.invocation;
      planning.phase = "ready";
    };
    restore = () => {
      if (receipt) delete receipt.abandoned;
      else planning.invocations!.pop();
      planning.invocation = invocation;
      planning.phase = "submitted";
    };
  } else {
    if (state.finalAcceptance || state.objectiveClosure === "complete") return;
    const recovery = Object.values(state.work).find((work) => {
      const id = work.recovery?.diagnosisInvocation?.id;
      return id !== undefined && owner(id) !== undefined;
    })?.recovery;
    const invocation = recovery?.diagnosisInvocation;
    if (
      !recovery ||
      !invocation?.submitted ||
      invocation.response !== undefined ||
      invocation.nativeReturns?.length
    )
      return;
    invocationId = invocation.id;
    abandon = () => {
      recovery.diagnosisInvocation = {
        id: randomUUID(),
        submitted: false,
        ...(invocation.rejected && {
          rejected: structuredClone(invocation.rejected),
        }),
        abandoned: [...(invocation.abandoned ?? []), invocation.id],
      };
    };
    restore = () => {
      recovery.diagnosisInvocation = invocation;
    };
  }
  const turn = owner(invocationId);
  if (!turn) return;
  if (turn.status !== "in-flight") {
    // A completed turn its adapter still holds is recovered by its owner.
    if (turn.status === "ready" && turn.currentTurn!.terminal === "completed")
      return;
    abandon();
    save();
    return;
  }
  const session = agentSessionContinuation(state, "planning", undefined, save);
  const retained = session.retained;
  if (
    retained?.status !== "in-flight" ||
    retained.currentTurn?.invocationId !== invocationId ||
    retained.currentTurn.terminal !== undefined
  )
    return;
  // A turn left active is abandoned only once its adapter proves the process
  // ceased; one its adapter settled, once no outcome can be authenticated.
  const reconciled = await model.reconcileSession(structuredClone(retained));
  let receipt: AgentSessionRef;
  if (reconciled.disposition === "ceased")
    receipt = ceasedReceipt(retained, reconciled.session);
  else if (
    reconciled.disposition === "unknown" &&
    retained.currentTurn.resources === "settled"
  )
    receipt = { ...retained, status: "unavailable" };
  else return;
  abandon();
  try {
    session.checkpoint(receipt);
  } catch (error) {
    restore();
    throw error;
  }
}

/** Exact settled source receipts remain historical; they grant no destination adapter ownership. */
export function restoredSessionIsHistorical(
  state: ContinuationState,
  ref: AgentSessionRef,
): boolean {
  if (
    !state.restoration ||
    state.restoration.status !== "reconciled" ||
    !ref.currentTurn?.terminal ||
    ref.currentTurn.resources !== "settled"
  )
    return false;
  const store = new LocalContentStore(`${stateRoot(state.repository)}/content`);
  const visited = new Set<string>();
  let snapshot = state.restoration.original.snapshot;
  while (!visited.has(snapshot.digest)) {
    visited.add(snapshot.digest);
    const original = JSON.parse(
      store.readBytes(snapshot).toString("utf8"),
    ) as ContinuationState;
    if (
      original.repository !== state.repository ||
      original.objective !== state.objective ||
      original.runId !== state.runId ||
      original.configDigest !== state.configDigest
    )
      throw new Error("Foreign session original snapshot identity differs");
    assertAgentSessions(original);
    for (const prior of [
      ...Object.values(original.agentSessions ?? {}),
      ...(original.agentSessionHistory ?? []),
    ]) {
      if (
        !prior.currentTurn?.terminal ||
        prior.currentTurn.resources !== "settled"
      )
        continue;
      const { status: priorStatus, ...priorReceipt } = prior;
      const { status, ...receipt } = ref;
      if (
        (status === priorStatus ||
          (priorStatus === "ready" && status === "unavailable")) &&
        isDeepStrictEqual(priorReceipt, receipt)
      )
        return true;
    }
    if (!original.restoration) break;
    snapshot = original.restoration.original.snapshot;
  }
  return false;
}

/** Release private adapter resources only through their owned disposal surface. */
export async function releaseAgentSessions(
  state: ContinuationState,
  driver: ExecutionDriver | undefined,
  model: PlanningModel | undefined,
  save: () => void,
  assertCurrent?: () => void,
): Promise<void> {
  assertAgentSessions(state);
  if (state.coordinator?.processes?.length)
    throw new Error("Agent session disposal requires settled owned processes");
  if (
    [
      ...Object.values(state.agentSessions ?? {}),
      ...(state.agentSessionHistory ?? []),
    ].some((ref) => ref.currentTurn && ref.currentTurn.resources !== "settled")
  )
    throw new Error("Agent session disposal requires settled native resources");
  // Every session is settled, so one acknowledgment covers all their storage.
  await withCheckpointDisposals(async () => {
    for (const [entryKey, ref] of Object.entries(state.agentSessions ?? {})) {
      if (ref.status === "released" || restoredSessionIsHistorical(state, ref))
        continue;
      const owner = ref.scope.role === "implementation" ? driver : model;
      if (!owner?.releaseSession)
        throw new Error(
          "Agent session disposal requires its authenticated adapter",
        );
      assertCurrent?.();
      await owner.releaseSession(ref);
      assertCurrent?.();
      state.agentSessions![entryKey] = { ...ref, status: "released" };
      save();
    }
    for (const [index, ref] of (state.agentSessionHistory ?? []).entries()) {
      if (ref.status === "released" || restoredSessionIsHistorical(state, ref))
        continue;
      const owner = ref.scope.role === "implementation" ? driver : model;
      if (!owner?.releaseSession)
        throw new Error(
          "Agent session disposal requires its authenticated adapter",
        );
      assertCurrent?.();
      await owner.releaseSession(ref);
      assertCurrent?.();
      state.agentSessionHistory![index] = { ...ref, status: "released" };
      save();
    }
  });
}
