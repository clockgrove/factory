import { createHash } from "node:crypto";
import type { WorkGraph, DeliveryObservation } from "../contracts.js";
import { decision, StepFault } from "../fault.js";
import type { FactoryState } from "../state.js";
import { notYet, settled } from "./lag.js";

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

/**
 * Whether a published PR may merge. Returns undefined when it may (or has
 * already merged), or what it is waiting for. Only required checks gate: a
 * failed check the source or the repository's rules require, or a conflict
 * with the base, is `work` on the published result; checks the repository
 * does not require never block. A PR made a draft, or closed without
 * merging, is a decision.
 */
export function deliveryReadiness(
  pullRequest: number,
  observation: DeliveryObservation,
  requiredChecks: string[] = [],
  expectedHead?: string,
): string | undefined {
  const work = (detail: string) =>
    new StepFault({ kind: "work", evidence: { detail } });
  if (observation.state === "merged") return undefined;
  if (observation.state === "closed")
    // A merge GitHub has not shown yet reads as closed for a moment.
    throw notYet(
      `closed:${pullRequest}:${expectedHead}`,
      `PR #${pullRequest} is closed without a merge`,
      decision(
        `PR #${pullRequest} was closed without merging. Start a new attempt or cancel?`,
        `PR #${pullRequest} closed${observation.closedAt ? ` at ${observation.closedAt}` : ""}`,
      ),
    );
  settled(`closed:${pullRequest}:${expectedHead}`);
  // Source-required checks, and those the repository's rules require.
  const failed = [
    ...new Set([...requiredChecks, ...(observation.requiredChecks ?? [])]),
  ].filter((name) => observation.failedChecks?.includes(name));
  if (failed.length)
    throw work(
      `Required checks failed on PR #${pullRequest} at ${expectedHead}: ${failed.join(", ")}`,
    );
  // A gateway without protection readiness gates on every check.
  const protection = observation.mergeReadiness;
  if (!protection && observation.checks === "failing")
    throw work(`Checks failed on PR #${pullRequest} at ${expectedHead}`);
  if (protection === "conflict")
    throw work(
      `PR #${pullRequest} conflicts with its base branch; rebase the change`,
    );
  if (protection === "draft")
    throw new StepFault(
      decision(
        `PR #${pullRequest} was made a draft. Mark it ready, then retry, or cancel?`,
        `PR #${pullRequest} is a draft`,
      ),
    );
  const named = requiredChecks.filter((name) => {
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
  });
  if (named.length)
    return `Awaiting successful exact-head source-required checks: ${named.join(", ")}`;
  if (
    protection === "waiting" ||
    (!protection && observation.checks === "pending")
  )
    return observation.failedChecks?.length
      ? `GitHub blocks the merge of PR #${pullRequest}; failed checks: ${observation.failedChecks.join(", ")}`
      : `Awaiting checks and protection readiness on PR #${pullRequest}`;
  return undefined;
}

/**
 * The gates a PR has not reported on at all: no check run of that name at the
 * head and no failure of it. Only these can be waiting for a check that never
 * comes. A merged or closed PR waits for nothing, and a gate already running,
 * passed or failed on the exact head exists on it whatever main has renamed
 * since.
 */
export function unreportedGates(
  observation: DeliveryObservation,
  gates: string[],
  expectedHead: string,
): string[] {
  if (observation.state !== "open") return [];
  return gates.filter(
    (name) =>
      !observation.failedChecks?.includes(name) &&
      !(observation.namedChecks ?? []).some(
        (check) => check.name === name && check.headSha === expectedHead,
      ),
  );
}

/**
 * A published item waiting for CI (its await-ci step's wait), or a QA item
 * waiting for named CI. Existing publication/QA identity is the durable
 * continuation, not another store.
 */
export function isReadinessWait(state: FactoryState, id: string): boolean {
  const work = state.work[id];
  return Boolean(
    work &&
      ((work.status === "published" && work.wait?.kind === "ci") ||
        (work.wait?.kind === "ci" &&
          work.status === "running" &&
          work.step === "validate" &&
          state.graph.items.find((item) => item.id === id)?.kind === "qa")),
  );
}

export function hasReadinessWait(state: FactoryState): boolean {
  return Object.keys(state.work).some((id) => isReadinessWait(state, id));
}
