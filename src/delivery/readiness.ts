import { createHash } from "node:crypto";
import type { WorkGraph, DeliveryObservation } from "../contracts.js";
import { now } from "../clock.js";
import { decision, StepFault } from "../fault.js";
import type { FactoryState } from "../state.js";
import { ESCALATE_AFTER_MS } from "../step.js";
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
      (gate.source.heading !== undefined &&
        typeof gate.source.heading !== "string") ||
      !/^[a-f0-9]{64}$/.test(gate.source.digest)
    )
      throw new Error(
        "Source-required pre-integration check lacks unique name or pinned authority",
      );
    names.add(gate.checkName);
  }
}

/** The gate's pinned source, by path, heading and digest at the base; never a quote. */
export function assertPreIntegrationCheckSources(
  graph: WorkGraph,
  sources: { path: string; content: string; heading?: string }[],
): void {
  assertPreIntegrationCheckShape(graph);
  for (const gate of graph.requiredPreIntegrationChecks ?? []) {
    if (
      !sources.some(
        (source) =>
          source.path === gate.source.path &&
          (gate.source.heading === undefined ||
            source.heading === gate.source.heading) &&
          createHash("sha256").update(source.content).digest("hex") ===
            gate.source.digest,
      )
    )
      throw new Error(
        `Pre-integration check ${gate.checkName} lacks exact pinned source authority`,
      );
  }
}

/**
 * Whether a published PR may merge. Returns undefined when it may (or has
 * already merged), or what it is waiting for. Any check on the head that
 * failed, required or not, or a conflict with the base, is `work` on the
 * published result (#1637). Every check must settle, and a source-required
 * one must succeed by name. A PR made a draft, closed without merging, with
 * only cancelled checks nothing re-ran, or with the same checks pending for
 * a day, is a decision (#1640).
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
  // GitHub merges past a check the repository does not require; Factory
  // does not (#1637). The evidence names each check, so a repair can fix it.
  const failed = observation.failedChecks ?? [];
  const listed = (checks: typeof failed) =>
    checks
      .map(
        (check) =>
          `${check.name} (${check.conclusion}${check.url ? `, ${check.url}` : ""})`,
      )
      .join("; ");
  const broken = failed.filter(
    (check) => !["cancelled", "stale"].includes(check.conclusion),
  );
  if (broken.length)
    throw work(
      `Checks failed on PR #${pullRequest} at ${expectedHead}: ${listed(broken)}`,
    );
  // A run cancelled (often by another PR's run in a shared concurrency
  // group) or gone stale says nothing about the change; a repair cannot fix
  // it (#1640).
  if (failed.length)
    throw new StepFault(
      decision(
        `Checks on PR #${pullRequest} ended cancelled or stale, and nothing re-ran them: ${[...new Set(failed.map((check) => check.name))].join(", ")}. Re-run them, then retry, or cancel?`,
        `Checks cancelled on PR #${pullRequest} at ${expectedHead}: ${listed(failed)}`,
      ),
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
  const pending = observation.pendingChecks?.length
    ? observation.pendingChecks.join(", ")
    : undefined;
  // Checks the repository does not require still running: GitHub would
  // merge now, but their result could still be a failure.
  const waiting = named.length
    ? `Awaiting successful exact-head source-required checks: ${named.join(", ")}`
    : protection === "waiting" || observation.checks === "pending"
      ? `Awaiting checks and protection readiness on PR #${pullRequest}${pending ? `: ${pending}` : ""}`
      : undefined;
  // A check held for an approval or a runner, or a status nobody completes,
  // never settles on its own: after a day with the same pending set, ask.
  const since = Date.parse(observation.pendingSince ?? "");
  if (waiting && now() - since >= ESCALATE_AFTER_MS)
    throw new StepFault(
      decision(
        `Checks on PR #${pullRequest} have been pending since ${observation.pendingSince}: ${pending ?? "unnamed"}. Complete or re-run them, or merge the PR by hand, then retry; or cancel?`,
        waiting,
      ),
    );
  return waiting;
}

/**
 * The gates a PR has not reported on at all: no check run or status of that
 * name at the exact head, in any state (queued, running, or ended with any
 * conclusion). Only these can be waiting for a check that never comes. A
 * merged or closed PR waits for nothing, and a gate that exists on the exact
 * head, whether running, passed, failed, cancelled or skipped, is there
 * whatever main has renamed since.
 */
export function unreportedGates(
  observation: DeliveryObservation,
  gates: string[],
): string[] {
  if (observation.state !== "open") return [];
  return gates.filter(
    (name) =>
      !observation.failedChecks?.some((check) => check.name === name) &&
      !observation.reportedChecks?.includes(name),
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
