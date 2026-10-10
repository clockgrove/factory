import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
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

/** Same producer before and after projection; no graph or candidate enters it. */
export function planningSessionInputDigest(inputs: {
  baseSha: string;
  objectiveBodyDigest?: string;
  sourcePacketDigest?: string;
  approvedPlaybookPin?: ApprovedPlaybookPin;
}): string {
  if (!/^[a-f0-9]{40}$/.test(inputs.baseSha))
    throw new Error("Planner immutable base is invalid");
  for (const name of ["objectiveBodyDigest", "sourcePacketDigest"] as const)
    if (
      typeof inputs[name] !== "string" ||
      !/^[a-f0-9]{64}$/.test(inputs[name]!)
    )
      throw new Error(`Planner immutable ${name} is unavailable`);
  if (inputs.approvedPlaybookPin !== undefined)
    assertApprovedPlaybookPin(inputs.approvedPlaybookPin);
  return createHash("sha256")
    .update(
      JSON.stringify([
        inputs.baseSha,
        inputs.objectiveBodyDigest,
        inputs.sourcePacketDigest,
        inputs.approvedPlaybookPin === undefined
          ? "absent"
          : inputs.approvedPlaybookPin,
      ]),
    )
    .digest("hex");
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
        : state.schemaVersion === 8 ||
          (ref.scope.itemId !== undefined &&
            !state.graph.items.some((item) => item.id === ref.scope.itemId)))
    )
      throw new Error(
        "Agent session differs from its retained Objective owner",
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
    if (state.schemaVersion !== 7)
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
  const admittedGraphDigest =
    state.schemaVersion === 7 ? graphDigest(state.graph) : undefined;
  const entryKey = key(scope);
  const retained = state.agentSessions?.[entryKey];
  let previous = JSON.stringify(retained);
  const continuation: AgentSessionContinuation = {
    scope,
    identity:
      retained && ["ready", "in-flight"].includes(retained.status)
        ? retained.identity
        : randomUUID(),
    ...(retained && ["ready", "in-flight"].includes(retained.status)
      ? { retained: structuredClone(retained) }
      : {}),
    checkpoint(ref) {
      if (
        (state.schemaVersion === 7 && state.finalAcceptance) ||
        state.cancelledAt ||
        (state.schemaVersion === 7 && state.objectiveClosure === "complete")
      )
        throw new Error(
          "Terminal or cancelling Objective cannot continue an agent session",
        );
      if (
        scope.role === "planning"
          ? planningSessionInputDigest(state) !== scope.planningInputDigest
          : state.schemaVersion !== 7 ||
            graphDigest(state.graph) !== scope.graphDigest
      )
        throw new Error("Agent session checkpoint was superseded");
      assertAgentSessionRef(ref, scope);
      if (
        scope.role === "planning" &&
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
      if (state.cancelRequested && (!sameTurn || ref.status === "in-flight"))
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
      if (prior && prior.identity === ref.identity) {
        if (ref.turn > prior.turn && prior.status !== "ready")
          throw new Error("Unsettled session cannot dispatch another turn");
        if (ref.turn === prior.turn && prior.currentTurn) {
          if (!ref.currentTurn)
            throw new Error("Agent session lost its turn binding");
          const before = prior.currentTurn;
          const after = ref.currentTurn;
          for (const field of [
            "invocationId",
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
          if (prior.status !== "in-flight" && ref.status === "in-flight")
            throw new Error("Settled agent turn cannot become active again");
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

/** Release private adapter resources only through their owned disposal surface. */
export async function releaseAgentSessions(
  state: ContinuationState,
  driver: ExecutionDriver | undefined,
  model: PlanningModel | undefined,
  save: () => void,
): Promise<void> {
  assertAgentSessions(state);
  if (state.coordinator?.processes?.length)
    throw new Error("Agent session disposal requires settled owned processes");
  for (const [entryKey, ref] of Object.entries(state.agentSessions ?? {})) {
    if (ref.status === "released") continue;
    const owner = ref.scope.role === "implementation" ? driver : model;
    if (!owner?.releaseSession) continue;
    await owner.releaseSession(ref);
    state.agentSessions![entryKey] = { ...ref, status: "released" };
    save();
  }
  for (const [index, ref] of (state.agentSessionHistory ?? []).entries()) {
    if (ref.status === "released") continue;
    const owner = ref.scope.role === "implementation" ? driver : model;
    if (!owner?.releaseSession) continue;
    await owner.releaseSession(ref);
    state.agentSessionHistory![index] = { ...ref, status: "released" };
    save();
  }
}
