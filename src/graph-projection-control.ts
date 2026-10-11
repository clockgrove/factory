import { createHash } from "node:crypto";
import type {
  GraphProjection,
  GraphProjectionEffect,
  GraphProjectionEffectRequest,
  GraphProjectionEffectObservation,
  WorkGraph,
} from "./contracts.js";
import { attachFault, decision } from "./fault.js";
import { graphDigest } from "./graph-amendments.js";
import { isPreparationState, type ContinuationState } from "./state.js";
import { assertStepAdmission } from "./step.js";

/** Existing projection's exact write receipts, owned by the atomic continuation snapshot. */
export interface GraphProjectionIntent {
  repository: string;
  objective: number;
  runId: string;
  configDigest: string;
  graphDigest: string;
  effects: GraphProjectionEffect[];
}
function fence(detail: string): Error {
  return attachFault(
    new Error(detail),
    decision(
      "Graph projection remains unresolved. Preserve its exact request; reconciliation permits reads, never another submission.",
      detail,
    ),
  );
}
export function assertGraphProjectionIntents(state: ContinuationState): void {
  const intents = state.graphProjectionIntents;
  if (intents === undefined) return;
  if (state.schemaVersion !== 11 && state.schemaVersion !== 12)
    throw new Error(
      "Bound graph projection requires expansion snapshot semantics",
    );
  if (!intents || typeof intents !== "object" || Array.isArray(intents))
    throw new Error("Invalid graph projection intents");
  const graphs = isPreparationState(state)
    ? state.plan
      ? [state.plan.graph]
      : []
    : [
        state.graph,
        ...(state.graphRevisions ?? []).map((revision) => revision.graph),
        ...(state.pendingExpansion ? [state.pendingExpansion.graph] : []),
        ...(state.pendingAmendment?.graph
          ? [state.pendingAmendment.graph]
          : []),
        ...(state.rejectedAmendments ?? []).flatMap((amendment) =>
          amendment.graph ? [amendment.graph] : [],
        ),
      ];
  const admitted = new Set(graphs.map(graphDigest));
  for (const [digest, intent] of Object.entries(intents)) {
    if (
      !intent ||
      intent.repository !== state.repository ||
      intent.objective !== state.objective ||
      intent.runId !== state.runId ||
      intent.configDigest !== state.configDigest ||
      intent.graphDigest !== digest ||
      !/^[a-f0-9]{64}$/.test(digest) ||
      !admitted.has(digest) ||
      !Array.isArray(intent.effects)
    )
      throw new Error("Graph projection intent owner differs");
    const keys = new Set<string>();
    const ids = new Set<string>();
    for (const effect of intent.effects) {
      if (
        !effect ||
        typeof effect.key !== "string" ||
        !effect.key ||
        keys.has(effect.key) ||
        typeof effect.id !== "string" ||
        !effect.id ||
        ids.has(effect.id) ||
        !["POST", "PATCH", "DELETE"].includes(effect.method) ||
        typeof effect.path !== "string" ||
        !effect.path.startsWith(`repos/${state.repository}/`) ||
        !/^[a-f0-9]{64}$/.test(effect.bodyDigest)
      )
        throw new Error("Invalid or duplicate graph projection effect");
      if (
        effect.id !==
        createHash("sha256")
          .update(
            JSON.stringify({
              method: effect.method,
              path: effect.path,
              bodyDigest: effect.bodyDigest,
            }),
          )
          .digest("hex")
      )
        throw new Error(
          "Graph projection effect digest differs from its exact request",
        );
      keys.add(effect.key);
      ids.add(effect.id);
      for (const observation of [effect.observation, effect.reconciliation])
        if (
          observation &&
          (!["responded", "reconciled", "unknown", "rejected"].includes(
            observation.outcome,
          ) ||
            (observation.responseDigest !== undefined &&
              !/^[a-f0-9]{64}$/.test(observation.responseDigest)))
        )
          throw new Error("Invalid graph projection observation");
      if (effect.observation?.outcome === "reconciled")
        throw new Error(
          "Graph projection transport receipt cannot claim read reconciliation",
        );
      for (const observation of [effect.observation, effect.reconciliation]) {
        if (!observation) continue;
        if (
          observation.status !== undefined &&
          (!Number.isSafeInteger(observation.status) ||
            observation.status < 100 ||
            observation.status > 599)
        )
          throw new Error("Invalid projection HTTP status");
        const identity = observation.identity;
        if (
          identity &&
          ([identity.id, identity.number].some(
            (id) => id !== undefined && (!Number.isSafeInteger(id) || id < 1),
          ) ||
            (identity.name !== undefined &&
              (typeof identity.name !== "string" || !identity.name)))
        )
          throw new Error("Invalid projection response identity");
      }
      if (
        effect.reconciliation &&
        effect.reconciliation.outcome !== "reconciled"
      )
        throw new Error(
          "Graph projection read reconciliation has invalid disposition",
        );
    }
  }
}
export function graphProjectionControl(
  state: ContinuationState,
  graph: WorkGraph,
  save: () => void,
): NonNullable<GraphProjection["expansionControl"]> {
  assertGraphProjectionIntents(state);
  const digest = graphDigest(graph);
  if (state.schemaVersion !== 11 && state.schemaVersion !== 12)
    throw fence("Expanded graph has no admitted projection semantics");
  state.graphProjectionIntents ??= {};
  let intent = state.graphProjectionIntents[digest];
  if (!intent) {
    intent = {
      repository: state.repository,
      objective: state.objective,
      runId: state.runId,
      configDigest: state.configDigest,
      graphDigest: digest,
      effects: [],
    };
    state.graphProjectionIntents[digest] = intent;
    save();
  }
  const retained = intent;
  const check = () => {
    if (
      state.graphProjectionIntents?.[digest] !== retained ||
      state.repository !== retained.repository ||
      state.objective !== retained.objective ||
      state.runId !== retained.runId ||
      state.configDigest !== retained.configDigest ||
      graphDigest(graph) !== digest
    )
      throw fence(
        "Projection owner or desired graph changed during submission",
      );
  };
  return {
    effects: structuredClone(retained.effects),
    beforeWrite: (request: GraphProjectionEffectRequest) => {
      assertStepAdmission();
      check();
      if (
        retained.effects.some(
          (effect) => effect.id === request.id || effect.key === request.key,
        )
      )
        throw fence(
          `Projection effect ${request.key} was already submitted; its outcome cannot authorize replay`,
        );
      retained.effects.push(structuredClone(request));
      assertGraphProjectionIntents(state);
      save();
    },
    observed: (id: string, observation: GraphProjectionEffectObservation) => {
      check();
      const effect = retained.effects.find((entry) => entry.id === id);
      if (!effect)
        throw fence("Projection observation lacks its exact submitted request");
      if (observation.outcome === "reconciled")
        effect.reconciliation = structuredClone(observation);
      else if (effect.observation !== undefined)
        throw fence("Projection transport observation was already retained");
      else effect.observation = structuredClone(observation);
      assertGraphProjectionIntents(state);
      save();
    },
  };
}
