import { createHash } from "node:crypto";
import type {
  AcceptanceCoverage,
  CoverageObligation,
  WorkGraph,
  WorkItem,
} from "./contracts.js";
import { installedControllerCapabilities } from "./controller-capabilities.js";
import type { FactoryState } from "./state.js";

/** The accepted graph determines whether this run qualifies existing bytes or delivers changes. */
export function baselineQaGraph(graph: WorkGraph): boolean {
  return (
    graph.items.length > 0 && graph.items.every((item) => item.kind === "qa")
  );
}

export function objectiveCandidate(
  state: Pick<
    FactoryState,
    | "graph"
    | "baseSha"
    | "integratedSha"
    | "work"
    | "stackNumbers"
    | "stackMerges"
  >,
):
  | {
      basis: "pinned-baseline" | "current-graph-integration";
      commitSha: string;
    }
  | undefined {
  if (baselineQaGraph(state.graph)) {
    if (
      state.integratedSha !== undefined ||
      Object.values(state.work).some(
        (work) =>
          work.execution ||
          work.pullRequest ||
          work.integratedSha ||
          work.preIntegrationChecks?.length,
      ) ||
      Object.keys(state.stackNumbers ?? {}).length ||
      Object.keys(state.stackMerges ?? {}).length
    )
      throw new Error(
        "Baseline-only QA cannot claim current-graph integration",
      );
    return { basis: "pinned-baseline", commitSha: state.baseSha };
  }
  return state.integratedSha
    ? { basis: "current-graph-integration", commitSha: state.integratedSha }
    : undefined;
}

/** New parents join implementation delivery and read-only proof, not fictional QA delivery. */
const aggregateJoinCriterion =
  "Every explicit child Work Item has completed acceptance. Implementation child results are integrated into this aggregate's exact candidate; read-only QA and aggregate children have accepted proof against that candidate without a worker or delivery.";

export function aggregateAcceptance(
  item: Pick<WorkItem, "id">,
  previousGraph?: WorkGraph,
): string[] {
  const previous = previousGraph?.items.find((entry) => entry.id === item.id);
  return previous ? [...previous.acceptance] : [aggregateJoinCriterion];
}

/** Candidate boundary only: existing admitted graph bytes remain immutable. */
export function assertAggregateAcceptance(
  graph: WorkGraph,
  previousGraph?: WorkGraph,
): void {
  for (const item of graph.items.filter((entry) => entry.kind === "aggregate"))
    if (
      JSON.stringify(item.acceptance) !==
      JSON.stringify(aggregateAcceptance(item, previousGraph))
    )
      throw new Error(
        "Aggregate acceptance must retain prior obligations or the controller-derived child join; new semantic assertions require QA",
      );
}

export function sourceDigest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Controller identities bind order, exact criterion text and the whole pinned Objective. */
export function coverageObligations(
  body: string,
  criteria: string[],
): CoverageObligation[] {
  const digest = sourceDigest(body);
  return criteria.map((text, index) => ({
    criterionId: sourceDigest(JSON.stringify([digest, index, text])),
    source: { path: "OBJECTIVE", digest, text },
  }));
}

/** Canonical criterion references resolve only against controller-owned obligations. */
export function hydrateCoverageSources(
  graph: WorkGraph,
  obligations: CoverageObligation[],
): void {
  if (!Array.isArray(graph.coverage)) return;
  const byId = new Map(obligations.map((entry) => [entry.criterionId, entry]));
  const seen = new Set<string>();
  for (const entry of graph.coverage) {
    const obligation = byId.get(entry?.criterionId);
    if (!obligation || seen.has(entry.criterionId))
      throw new Error("Coverage criterion identity is unknown or duplicated");
    seen.add(entry.criterionId);
    entry.source = { ...obligation.source };
  }
}

function indexReference(index: number, length: number): boolean {
  return Number.isSafeInteger(index) && index >= 0 && index < length;
}

function assertProofShape(entry: AcceptanceCoverage): void {
  const proof = entry.proof;
  if ("phase" in entry || "oracle" in entry)
    throw new Error(
      "Obsolete coverage representation; typed proof is required",
    );
  const fields: Record<string, string[]> = {
    "result-command": ["kind", "validationIndex"],
    "integrated-command": ["kind", "validationIndex"],
    "result-semantic": ["kind", "acceptanceIndex"],
    "integrated-semantic": ["kind", "acceptanceIndex"],
    "final-review": ["kind"],
    "final-controller": ["kind", "guaranteeId"],
    "integrated-ci": ["kind", "checkName"],
    "published-ci": ["kind", "checkName", "targetItem"],
  };
  if (
    !proof ||
    typeof proof !== "object" ||
    Array.isArray(proof) ||
    !Object.hasOwn(fields, proof.kind) ||
    Object.keys(proof).sort().join() !== [...fields[proof.kind]!].sort().join()
  )
    throw new Error(
      "Coverage requires a supported typed proof; published ordinary proof is unsupported",
    );
}

export function assertCoverageShape(graph: WorkGraph): void {
  if (!Array.isArray(graph.coverage) || !graph.coverage.length)
    throw new Error("Acceptance coverage must be a nonempty collection");
  const ids = new Set<string>();
  for (const entry of graph.coverage) {
    if (
      !entry ||
      typeof entry !== "object" ||
      !/^[a-f0-9]{64}$/.test(entry.criterionId) ||
      ids.has(entry.criterionId)
    )
      throw new Error("Coverage criterion identity is invalid or duplicated");
    ids.add(entry.criterionId);
    if (
      !entry.source ||
      !entry.source.path ||
      !entry.source.text ||
      !/^[a-f0-9]{64}$/.test(entry.source.digest)
    )
      throw new Error("Coverage lacks pinned source identity");
    const item = graph.items.find((item) => item.id === entry.itemId);
    if (!item) throw new Error("Coverage owner is absent from the graph");
    assertProofShape(entry);
    const proof = entry.proof;
    const integrated = proof.kind.startsWith("integrated-");
    const final =
      proof.kind === "final-review" || proof.kind === "final-controller";
    const ci = proof.kind === "integrated-ci" || proof.kind === "published-ci";
    if (
      "validationIndex" in proof &&
      !indexReference(proof.validationIndex, item.validation.length)
    )
      throw new Error(
        "Coverage command is not an owning node validation command",
      );
    if (
      "acceptanceIndex" in proof &&
      !indexReference(proof.acceptanceIndex, item.acceptance.length)
    )
      throw new Error(
        "Coverage semantic proof is not an owning node acceptance criterion",
      );
    if (
      proof.kind === "final-controller" &&
      !installedControllerCapabilities().guarantees.some(
        (guarantee) => guarantee.id === proof.guaranteeId,
      )
    )
      throw new Error("Coverage names an unknown controller guarantee");
    if (
      ci &&
      (item.kind !== "qa" ||
        typeof proof.checkName !== "string" ||
        !proof.checkName.trim())
    )
      throw new Error(
        "Named CI needs a late read-only QA node and exact check name",
      );
    if (proof.kind === "published-ci") {
      const target = graph.items.find(
        (candidate) => candidate.id === proof.targetItem,
      );
      if (
        !target ||
        !item.dependencies.includes(proof.targetItem) ||
        target.kind === "qa" ||
        target.kind === "aggregate"
      )
        throw new Error("Published CI requires the actual delivery dependency");
    }
    if (
      item.kind !== "qa" &&
      item.kind !== "aggregate" &&
      !final &&
      !proof.kind.startsWith("result-")
    )
      throw new Error("Late proof requires a read-only QA node");
    if (
      item.kind === "qa" &&
      ((!item.dependencies.length && !baselineQaGraph(graph)) ||
        (!integrated && proof.kind !== "published-ci" && !final))
    )
      throw new Error(
        "QA proof needs integrated dependencies and a feasible late phase",
      );
    if (item.kind === "qa" && integrated) {
      const ancestors = new Set<string>();
      const visit = (id: string): void => {
        if (ancestors.has(id)) return;
        ancestors.add(id);
        for (const dependency of graph.items.find(
          (candidate) => candidate.id === id,
        )?.dependencies ?? [])
          visit(dependency);
      };
      for (const dependency of item.dependencies) visit(dependency);
      if (
        graph.items.some(
          (candidate) =>
            candidate.kind !== "qa" &&
            candidate.kind !== "aggregate" &&
            !ancestors.has(candidate.id),
        )
      )
        throw new Error(
          "Integrated QA must depend on every implementation node in its candidate",
        );
    }
    const environment = entry.environment;
    if (
      !environment ||
      !["local", "real"].includes(environment.kind) ||
      !["available", "prepare", "missing"].includes(environment.readiness) ||
      typeof environment.probe !== "string" ||
      typeof environment.preparedBy !== "string"
    )
      throw new Error("Coverage environment readiness is invalid");
    if (environment.readiness === "missing")
      throw new Error(
        `Missing external prerequisite for criterion ${entry.criterionId}; source decision required`,
      );
    if (
      environment.kind === "real" &&
      (!environment.probe ||
        !item.validation.some((check) => check.command === environment.probe))
    )
      throw new Error(
        "Real environment requires an exact authorized readiness probe",
      );
    if (
      environment.probe &&
      !item.validation.some((check) => check.command === environment.probe)
    )
      throw new Error("Environment probe lacks command authority");
    if (
      environment.readiness === "prepare" &&
      (!environment.preparedBy ||
        !item.dependencies.includes(environment.preparedBy))
    )
      throw new Error(
        "Environment preparation requires an existing authorized dependency",
      );
    if (environment.readiness !== "prepare" && environment.preparedBy)
      throw new Error("Environment preparation cannot be inferred");
  }
  for (const item of graph.items.filter((item) => item.kind === "qa"))
    if (!graph.coverage.some((entry) => entry.itemId === item.id))
      throw new Error("QA node has no acceptance coverage");
}

export function assertCoverageSources(
  graph: WorkGraph,
  sources: { path: string; content: string }[],
  obligations: CoverageObligation[],
): void {
  assertCoverageShape(graph);
  for (const required of obligations) {
    const actual = graph.coverage.find(
      (entry) => entry.criterionId === required.criterionId,
    );
    if (
      !actual ||
      JSON.stringify(actual.source) !== JSON.stringify(required.source)
    )
      throw new Error(`Uncovered Objective obligation ${required.criterionId}`);
  }
  for (const entry of graph.coverage) {
    const source = sources.find(
      (source) =>
        source.path === entry.source.path &&
        sourceDigest(source.content) === entry.source.digest,
    );
    if (
      !source ||
      (entry.source.path !== "OBJECTIVE" &&
        !source.content.includes(entry.source.text))
    )
      throw new Error("Coverage source differs from pinned content");
    if (
      entry.source.path === "OBJECTIVE" &&
      !obligations.some(
        (required) => required.criterionId === entry.criterionId,
      )
    )
      throw new Error(
        "Coverage invents a controller Objective criterion identity",
      );
  }
}

export function itemCoverage(
  graph: WorkGraph,
  itemId: string,
): AcceptanceCoverage[] {
  return graph.coverage.filter((entry) => entry.itemId === itemId);
}

export function assertCompletedCoverage(state: FactoryState): void {
  for (const entry of state.graph.coverage) {
    assertProofShape(entry);
    const proof = entry.proof;
    if (proof.kind === "final-review" || proof.kind === "final-controller") {
      if (
        state.finalValidation?.passed &&
        !state.finalValidation.criteria?.some(
          (criterion) =>
            criterion.criterion === entry.source.text &&
            ["pass", "human-accept"].includes(criterion.verdict),
        )
      )
        throw new Error(
          "Final acceptance coverage lacks its exact criterion proof",
        );
      continue;
    }
    const item = state.graph.items.find((item) => item.id === entry.itemId)!;
    const work = state.work[entry.itemId];
    if (
      work?.status !== "done" ||
      !work.validation ||
      !work.treeSha ||
      work.validation.treeSha !== work.treeSha
    )
      throw new Error("Acceptance coverage lacks completed exact-tree proof");
    if (
      proof.kind.startsWith("integrated-") &&
      work.changeRef !== objectiveCandidate(state)?.commitSha
    )
      throw new Error("Integrated QA proof is stale at the final candidate");
    if (
      "validationIndex" in proof &&
      !work.validation.commands.some(
        (command) =>
          command.command === item.validation[proof.validationIndex]?.command &&
          command.treeSha === work.treeSha &&
          command.passed,
      )
    )
      throw new Error("Required coverage command proof is missing");
    if (
      "acceptanceIndex" in proof &&
      !work.validation.criteria?.some(
        (criterion) =>
          criterion.criterion === item.acceptance[proof.acceptanceIndex] &&
          ["pass", "human-accept"].includes(criterion.verdict),
      )
    )
      throw new Error("Required semantic coverage proof is missing");
    if (proof.kind === "integrated-ci" || proof.kind === "published-ci") {
      const head =
        proof.kind === "published-ci"
          ? state.work[proof.targetItem]?.changeRef
          : objectiveCandidate(state)?.commitSha;
      if (
        !head ||
        !work.qaChecks?.some(
          (check) =>
            check.name === proof.checkName &&
            check.headSha === head &&
            check.status === "completed" &&
            check.conclusion === "success" &&
            Number.isSafeInteger(check.id) &&
            check.id > 0,
        )
      )
        throw new Error("Required named CI proof is missing or stale");
    }
  }
}
