import { createHash } from "node:crypto";
import type {
  AcceptanceCoverage,
  CoverageObligation,
  WorkGraph,
} from "./contracts.js";
import { installedControllerCapabilities } from "./controller-capabilities.js";
import type { FactoryState } from "./state.js";

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

/** Model output selects IDs; source facts are restored exclusively by the controller. */
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

function indexReference(reference: string, length: number): boolean {
  return /^(0|[1-9][0-9]*)$/.test(reference) && Number(reference) < length;
}

export function assertCoverageShape(graph: WorkGraph): void {
  if (graph.coverage === undefined) {
    if (graph.items.some((item) => item.kind === "qa"))
      throw new Error("QA nodes require an accepted coverage map");
    return;
  }
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
    if (!["result", "integrated", "published", "final"].includes(entry.phase))
      throw new Error("Coverage phase is invalid");
    if (
      !entry.oracle ||
      !["command", "semantic", "controller", "ci"].includes(
        entry.oracle.kind,
      ) ||
      !entry.oracle.reference
    )
      throw new Error(
        "Coverage requires an explicit command or semantic oracle",
      );
    const { kind, reference, targetItem } = entry.oracle;
    if (
      kind === "command" &&
      !indexReference(reference, item.validation.length)
    )
      throw new Error(
        "Coverage command is not an owning node validation command",
      );
    if (
      kind === "semantic" &&
      (entry.phase === "final"
        ? reference !== entry.criterionId
        : !indexReference(reference, item.acceptance.length))
    )
      throw new Error(
        "Coverage semantic oracle is not an owning node acceptance criterion",
      );
    if (
      kind === "controller" &&
      !installedControllerCapabilities().guarantees.some(
        (guarantee) => guarantee.id === reference,
      )
    )
      throw new Error("Coverage names an unknown controller guarantee");
    if (entry.phase === "final" && !["semantic", "controller"].includes(kind))
      throw new Error(
        "Final coverage uses existing Objective semantic review or controller guarantees; executable checks need a QA node",
      );
    if (kind === "controller" && entry.phase !== "final")
      throw new Error(
        "Controller guarantee coverage must retain final Objective review",
      );
    if (kind === "ci") {
      if (
        item.kind !== "qa" ||
        !["published", "integrated"].includes(entry.phase)
      )
        throw new Error("Named CI needs a late read-only QA node");
      if (
        entry.phase === "published" &&
        (!targetItem ||
          !item.dependencies.includes(targetItem) ||
          graph.items.find((candidate) => candidate.id === targetItem)?.kind ===
            "qa")
      )
        throw new Error("Published CI requires the actual delivery dependency");
    } else if (targetItem)
      throw new Error("Only CI coverage names a candidate Work Item");
    if (
      item.kind !== "qa" &&
      item.kind !== "aggregate" &&
      !["result", "final"].includes(entry.phase)
    )
      throw new Error("Late proof requires a read-only QA node");
    if (
      item.kind === "qa" &&
      (!item.dependencies.length ||
        entry.phase === "result" ||
        entry.phase === "final")
    )
      throw new Error(
        "QA proof needs integrated dependencies and a feasible late phase",
      );
    if (item.kind === "qa" && entry.phase === "integrated") {
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
  if (graph.coverage === undefined) return;
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
  return (graph.coverage ?? []).filter((entry) => entry.itemId === itemId);
}

export function assertCompletedCoverage(state: FactoryState): void {
  for (const entry of state.graph.coverage ?? []) {
    if (entry.phase === "final") {
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
    if (entry.phase === "integrated" && work.changeRef !== state.integratedSha)
      throw new Error("Integrated QA proof is stale at the final candidate");
    if (
      entry.oracle.kind === "command" &&
      !work.validation.commands.some(
        (command) =>
          command.command ===
            item.validation[Number(entry.oracle.reference)]?.command &&
          command.treeSha === work.treeSha &&
          command.passed,
      )
    )
      throw new Error("Required coverage command proof is missing");
    if (
      entry.oracle.kind === "semantic" &&
      !work.validation.criteria?.some(
        (criterion) =>
          criterion.criterion ===
            item.acceptance[Number(entry.oracle.reference)] &&
          ["pass", "human-accept"].includes(criterion.verdict),
      )
    )
      throw new Error("Required semantic coverage proof is missing");
    if (entry.oracle.kind === "ci") {
      const head =
        entry.phase === "published"
          ? state.work[entry.oracle.targetItem]?.changeRef
          : state.integratedSha;
      if (
        !head ||
        !work.qaChecks?.some(
          (check) =>
            check.name === entry.oracle.reference &&
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
