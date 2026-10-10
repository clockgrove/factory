import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  AgentSessionContinuation,
  AgentSessionRef,
  AgentSessionScope,
  ExecutionDriver,
  PlanningModel,
} from "./contracts.js";
import { assertDurableValue } from "./execution/checkpoint.js";
import { graphDigest } from "./graph-amendments.js";
import type { FactoryState } from "./state.js";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Agent session is not an object");
  return value as Record<string, unknown>;
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
  for (const key of ["configDigest", "graphDigest"])
    if (typeof scope[key] !== "string" || !/^[a-f0-9]{64}$/.test(scope[key]))
      throw new Error(`Agent session ${key} is invalid`);
  if (
    !["implementation", "result-review", "objective-review"].includes(
      scope.role as string,
    )
  )
    throw new Error("Agent session role is invalid");
  if (scope.role === "objective-review") {
    if (scope.itemId !== undefined)
      throw new Error("Objective review session cannot claim a Work Item");
  } else if (
    typeof scope.itemId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(scope.itemId)
  ) {
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
  assertDurableValue(value, "Agent session receipt");
}

function key(scope: AgentSessionScope): string {
  return JSON.stringify([scope.role, scope.itemId ?? null, scope.graphDigest]);
}

export function assertAgentSessions(state: FactoryState): void {
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
      (ref.scope.itemId &&
        !state.graph.items.some((item) => item.id === ref.scope.itemId))
    )
      throw new Error(
        "Agent session differs from its retained Objective owner",
      );
  }
}

/** The caller already owns the lifecycle mutation lock and paid-step admission. */
export function agentSessionContinuation(
  state: FactoryState,
  role: AgentSessionScope["role"],
  itemId: string | undefined,
  save: () => void,
): AgentSessionContinuation {
  assertAgentSessions(state);
  const scope: AgentSessionScope = {
    repository: state.repository,
    objective: state.objective,
    runId: state.runId,
    configDigest: state.configDigest,
    graphDigest: graphDigest(state.graph),
    role,
    ...(itemId ? { itemId } : {}),
  };
  assertAgentSessionScope(scope);
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
        state.finalAcceptance ||
        state.cancelledAt ||
        state.objectiveClosure === "complete"
      )
        throw new Error(
          "Terminal or cancelling Objective cannot continue an agent session",
        );
      if (
        graphDigest(state.graph) !== scope.graphDigest ||
        JSON.stringify(state.agentSessions?.[entryKey]) !== previous
      )
        throw new Error("Agent session checkpoint was superseded");
      assertAgentSessionRef(ref, scope);
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
      if (prior && isDeepStrictEqual(prior, ref)) return;
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
  state: FactoryState,
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
