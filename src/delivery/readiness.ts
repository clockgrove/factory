import { createHash } from "node:crypto";
import type { WorkGraph, DeliveryObservation } from "../contracts.js";
import type { FactoryState } from "../state.js";

/** A read-only wait, never an uncertain submitted delivery effect. */
export class DeliveryReadinessPending extends Error {
  constructor(
    message = "Awaiting exact published head checks or target protection readiness",
  ) {
    super(message);
  }
}

export function assertPreIntegrationCheckShape(graph: WorkGraph): void {
  const gates = graph.requiredPreIntegrationChecks;
  if (gates === undefined) return;
  if (!Array.isArray(gates))
    throw new Error("Source-required pre-integration checks must be an array");
  const names = new Set<string>();
  for (const gate of gates) {
    if (
      !gate ||
      typeof gate.checkName !== "string" ||
      !gate.checkName.trim() ||
      names.has(gate.checkName) ||
      !gate.source ||
      typeof gate.source.path !== "string" ||
      !gate.source.path ||
      typeof gate.source.text !== "string" ||
      !gate.source.text ||
      !/^[a-f0-9]{64}$/.test(gate.source.digest)
    )
      throw new Error(
        "Source-required pre-integration check lacks unique name or pinned authority",
      );
    names.add(gate.checkName);
  }
}

export function assertPreIntegrationCheckSources(
  graph: WorkGraph,
  sources: { path: string; content: string }[],
): void {
  assertPreIntegrationCheckShape(graph);
  for (const gate of graph.requiredPreIntegrationChecks ?? []) {
    if (
      !sources.some(
        (source) =>
          source.path === gate.source.path &&
          createHash("sha256").update(source.content).digest("hex") ===
            gate.source.digest &&
          source.content.includes(gate.source.text),
      )
    )
      throw new Error(
        `Pre-integration check ${gate.checkName} lacks exact pinned source authority`,
      );
  }
}

export function assertDeliveryReady(
  observation: DeliveryObservation,
  requiredChecks: string[] = [],
  expectedHead?: string,
): void {
  if (observation.state !== "open" || observation.checks === "failing")
    throw new Error(
      `PR is not mergeable: ${observation.state}, checks ${observation.checks}`,
    );
  if (observation.mergeReadiness === "blocked")
    throw new Error("PR is not mergeable under authenticated target readiness");
  if (
    observation.checks === "pending" ||
    observation.mergeReadiness === "waiting" ||
    requiredChecks.some((name) => {
      const matches = (observation.namedChecks ?? []).filter(
        (check) => check.name === name,
      );
      return (
        matches.length !== 1 ||
        !matches.some(
          (check) =>
            check.name === name &&
            check.headSha === expectedHead &&
            check.status === "completed" &&
            check.conclusion === "success" &&
            Number.isSafeInteger(check.id) &&
            check.id > 0 &&
            check.detailsUrl,
        )
      );
    })
  )
    throw new DeliveryReadinessPending(
      requiredChecks.length
        ? `Awaiting successful exact-head source-required checks: ${requiredChecks.join(", ")}`
        : undefined,
    );
}

/** Existing publication/QA identity is the durable continuation, not another store. */
export function isReadinessWait(state: FactoryState, id: string): boolean {
  const work = state.work[id];
  return Boolean(
    work &&
      work.waitingReason &&
      (work.status === "published" ||
        (work.status === "running" &&
          work.step === "validate" &&
          state.graph.items.find((item) => item.id === id)?.kind === "qa")),
  );
}

export function hasReadinessWait(state: FactoryState): boolean {
  return Object.keys(state.work).some((id) => isReadinessWait(state, id));
}
