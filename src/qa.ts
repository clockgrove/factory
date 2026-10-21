import { assertWorkRoutingState } from "./runner/routing.js";
import { createHash } from "node:crypto";
import type {
  AcceptanceCoverage,
  CoverageObligation,
  WorkGraph,
  WorkItem,
} from "./contracts.js";
import { installedControllerCapabilities } from "./controller-capabilities.js";
import { PlannerDecision } from "./fault.js";
import type { FactoryState } from "./state.js";
import { packageBootstrap } from "./validation.js";

/** The accepted graph determines whether this run qualifies existing bytes or delivers changes. */
function baselineQaGraph(graph: WorkGraph): boolean {
  return (
    graph.items.length > 0 &&
    graph.items.every((item) => item.kind === "qa" || item.kind === "discovery")
  );
}

export function objectiveCandidate(
  state: Pick<
    FactoryState,
    | "graph"
    | "baseSha"
    | "integratedSha"
    | "finalHead"
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
  const skippedBaseline =
    state.graph.items.some(
      (item) => state.work[item.id]?.status === "skipped",
    ) &&
    state.graph.items.every(
      (item) =>
        item.kind === "qa" ||
        item.kind === "aggregate" ||
        item.kind === "discovery" ||
        state.work[item.id]?.status === "skipped",
    );
  if (skippedBaseline) assertWorkRoutingState(state as FactoryState);
  if (baselineQaGraph(state.graph) || skippedBaseline) {
    if (
      state.integratedSha !== undefined ||
      Object.entries(state.work).some(
        ([id, work]) =>
          (work.execution &&
            state.graph.items.find((item) => item.id === id)?.kind !==
              "discovery") ||
          work.pullRequest ||
          work.integratedSha ||
          work.preIntegrationChecks?.length,
      ) ||
      Object.keys(state.stackNumbers ?? {}).length ||
      Object.keys(state.stackMerges ?? {}).length ||
      state.finalHead
    )
      throw new Error(
        "Baseline-only QA cannot claim current-graph integration",
      );
    return { basis: "pinned-baseline", commitSha: state.baseSha };
  }
  if (!state.integratedSha) return undefined;
  // Heads others pushed on top of Factory's integration, when followed.
  const followed =
    state.finalHead?.integratedSha === state.integratedSha
      ? state.finalHead.heads.at(-1)
      : undefined;
  return {
    basis: "current-graph-integration",
    commitSha: followed ?? state.integratedSha,
  };
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

/** A source exit item's identity binds its exact pinned source and line range. */
export function sourceObligationId(source: {
  path: string;
  digest: string;
  lines: [number, number];
}): string {
  return sourceDigest(
    JSON.stringify([source.digest, source.path, ...source.lines]),
  );
}

/** The exact text of a zero-based inclusive line range, or undefined when out of range. */
export function sourceLines(
  content: string,
  lines: [number, number],
): string | undefined {
  const all = content.split("\n");
  const [first, last] = lines;
  return Number.isSafeInteger(first) &&
    Number.isSafeInteger(last) &&
    first >= 0 &&
    first <= last &&
    last < all.length
    ? all.slice(first, last + 1).join("\n")
    : undefined;
}

/** What review judges for an obligation: its statement, or the criterion itself. */
export function coverageCriterion(entry: CoverageObligation): string {
  // A source exit item always has a statement; an Objective criterion its text.
  return entry.statement ?? entry.source.text!;
}

/**
 * Result review judges the item's own acceptance, then verbatim every
 * Objective criterion and source obligation that the item's review proves:
 * its semantic coverage, plus, when it is the graph's only item, the
 * obligations left to final review, because its result is then the whole
 * Objective. A gap is then refused and repaired before delivery; final review
 * still judges them again on the integrated tree.
 */
export function resultReviewCriteria(
  graph: WorkGraph,
  item: WorkItem,
): string[] {
  const whole = graph.items.length === 1 && graph.items[0]!.id === item.id;
  const owned = itemCoverage(graph, item.id)
    .filter(
      (entry) =>
        entry.proof.kind === "result-semantic" ||
        entry.proof.kind === "integrated-semantic" ||
        (whole && entry.proof.kind === "final-review"),
    )
    .map(coverageCriterion)
    .filter((criterion) => !item.acceptance.includes(criterion));
  return [...item.acceptance, ...new Set(owned)];
}

/**
 * Final review judges, on the integrated tree, the Objective criteria and
 * every coverage obligation once per distinct statement, wherever the plan
 * proved it: item reviews judge obligations one Work Item at a time. Then one
 * fixed integration question per dependency edge between coding items, and
 * per source whose obligations coding items without a direct edge deliver
 * together, asks whether the consumer accepts the producer's real outputs and
 * reuses its helpers and types. Each question names the criteria it bears on
 * by index, so its refusal stays tied to them.
 */
export function finalReviewCriteria(
  graph: WorkGraph,
  criteria: string[],
): string[] {
  const judged = [
    ...new Set([...criteria, ...graph.coverage.map(coverageCriterion)]),
  ];
  const coding = graph.items.filter((item) => (item.kind ?? "work") === "work");
  const ids = new Set(coding.map((item) => item.id));
  const linked = (a: WorkItem, b: WorkItem) =>
    a.dependencies.includes(b.id) || b.dependencies.includes(a.id);
  const bears = (items: string[], paths?: string[]) => {
    const indices = [
      ...new Set(
        graph.coverage
          .filter(
            (entry) =>
              items.includes(entry.itemId) &&
              (!paths || paths.includes(entry.source.path)),
          )
          .map((entry) => judged.indexOf(coverageCriterion(entry))),
      ),
    ].sort((a, b) => a - b);
    return indices.length ? ` It bears on criteria ${indices.join(", ")}.` : "";
  };
  const questions = coding.flatMap((consumer) =>
    consumer.dependencies
      .filter((id) => ids.has(id))
      .map(
        (producer) =>
          `Integration of Work Item "${consumer.id}" with its dependency "${producer}" on the integrated tree: "${consumer.id}" accepts the real outputs and types "${producer}" produces, exactly as "${producer}" produces them (cite the producing and consuming file:lines), and reuses the helpers and types "${producer}" owns instead of redefining them.${bears([consumer.id, producer])}`,
      ),
  );
  // Coding items delivering one source's obligations share its capability.
  const groups = new Map<string, { items: string[]; paths: string[] }>();
  for (const path of new Set(graph.coverage.map((entry) => entry.source.path)))
    if (path !== "OBJECTIVE") {
      const members = coding.filter((item) =>
        graph.coverage.some(
          (entry) => entry.itemId === item.id && entry.source.path === path,
        ),
      );
      if (
        members.every((a, index) =>
          members.slice(index + 1).every((b) => linked(a, b)),
        )
      )
        continue;
      const items = members.map((item) => item.id);
      const key = JSON.stringify(items);
      const group = groups.get(key) ?? { items, paths: [] };
      group.paths.push(path);
      groups.set(key, group);
    }
  for (const { items, paths } of groups.values())
    questions.push(
      `Integration of Work Items ${items.map((id) => `"${id}"`).join(", ")}, which together deliver obligations from ${paths.join(", ")}, on the integrated tree: where one consumes another's outputs it accepts their real shape and types (cite the producing and consuming file:lines), and a helper or type more than one of them needs has one definition the others reuse instead of parallel redefinitions.${bears(items, paths)}`,
    );
  return [...new Set([...judged, ...questions])];
}

/**
 * Controller obligations resolve against controller-owned identities. A
 * planner-extracted source obligation has no controller identity yet;
 * assertCoverageSources verifies its span against the pinned source.
 */
export function hydrateCoverageSources(
  graph: WorkGraph,
  obligations: CoverageObligation[],
): void {
  if (!Array.isArray(graph.coverage)) return;
  const byId = new Map(obligations.map((entry) => [entry.criterionId, entry]));
  const seen = new Set<string>();
  for (const entry of graph.coverage) {
    const obligation = byId.get(entry?.criterionId);
    if (
      seen.has(entry?.criterionId) ||
      (!obligation &&
        (!entry?.source?.lines || entry.source.path === "OBJECTIVE"))
    )
      throw new Error("Coverage criterion identity is unknown or duplicated");
    seen.add(entry.criterionId);
    if (!obligation) continue;
    entry.source = structuredClone(obligation.source);
    if (obligation.statement !== undefined)
      entry.statement = obligation.statement;
  }
}

/**
 * The criterion text an item or QA review judges for a semantic proof: the
 * obligation itself (resultReviewCriteria adds it to the owner's review), or
 * the one acceptance entry a plan retained from an earlier release names.
 */
export function semanticProofCriterion(
  entry: AcceptanceCoverage,
  item: WorkItem,
): string | undefined {
  const proof = entry.proof;
  if (proof.kind !== "result-semantic" && proof.kind !== "integrated-semantic")
    return undefined;
  return proof.acceptanceIndex === undefined
    ? coverageCriterion(entry)
    : item.acceptance[proof.acceptanceIndex];
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
    "result-semantic": ["kind"],
    "integrated-semantic": ["kind"],
    "final-review": ["kind"],
    "final-controller": ["kind", "guaranteeId"],
    "integrated-ci": ["kind", "checkName"],
    "published-ci": ["kind", "checkName", "targetItem"],
  };
  // A semantic proof retained from an earlier release names one entry.
  const legacy =
    (proof?.kind === "result-semantic" ||
      proof?.kind === "integrated-semantic") &&
    Object.hasOwn(proof, "acceptanceIndex")
      ? ["acceptanceIndex"]
      : [];
  if (
    !proof ||
    typeof proof !== "object" ||
    Array.isArray(proof) ||
    !Object.hasOwn(fields, proof.kind) ||
    Object.keys(proof).sort().join() !==
      [...fields[proof.kind]!, ...legacy].sort().join()
  )
    throw new Error(
      "Coverage requires a supported typed proof; published ordinary proof is unsupported",
    );
}

/**
 * A plan that declares a criterion's environment missing asks the operator
 * (#1292). With an authorized probe or preparation it names an external
 * prerequisite to establish; with neither it is the planner saying it cannot
 * cover the criterion as the Objective stands, which is a decision, not an
 * environment fact.
 */
function missingEnvironmentDecision(
  entry: AcceptanceCoverage,
): PlannerDecision {
  const criterion = coverageCriterion(entry).replace(/\s+/g, " ").trim();
  const named =
    criterion.length > 160 ? `${criterion.slice(0, 157)}...` : criterion;
  const environment = entry.environment;
  return new PlannerDecision(
    environment.probe || environment.prerequisites?.length
      ? `The plan needs an external prerequisite for criterion "${named}" (${environment.kind} environment, probe \`${environment.probe}\`). Establish it outside Factory, or say how the criterion should be covered.`
      : `The plan cannot cover criterion "${named}" as the Objective stands. Say how it should be covered or what the Objective allows.`,
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
      (!entry.source.lines && !entry.source.text) ||
      !/^[a-f0-9]{64}$/.test(entry.source.digest)
    )
      throw new Error("Coverage lacks pinned source identity");
    assertSourceObligationShape(entry);
    const item = graph.items.find((item) => item.id === entry.itemId);
    if (!item) throw new Error("Coverage owner is absent from the graph");
    if (item.kind === "discovery")
      throw new Error(
        "Discovery observations cannot own acceptance coverage proof",
      );
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
      proof.acceptanceIndex !== undefined &&
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
        target.kind === "aggregate" ||
        target.kind === "discovery"
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
            candidate.kind !== "discovery" &&
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
    const prerequisites =
      environment.prerequisites === undefined ? [] : environment.prerequisites;
    if (!Array.isArray(prerequisites))
      throw new Error(
        "Environment prerequisites must be an ordered command list",
      );
    const probeIndex = item.validation.findIndex(
      (check) => check.command === environment.probe,
    );
    let previousPrerequisite = -1;
    for (const command of prerequisites) {
      const selected = item.validation.findIndex(
        (check) => check.command === command,
      );
      if (
        typeof command !== "string" ||
        selected < 0 ||
        selected <= previousPrerequisite ||
        selected >= probeIndex ||
        item.validation.filter((check) => check.command === command).length !==
          1 ||
        item.validation.filter((check) => check.command === environment.probe)
          .length !== 1
      )
        throw new Error(
          "Environment prerequisites lack ordered command authority before their probe",
        );
      previousPrerequisite = selected;
    }
    if (environment.readiness === "missing")
      throw missingEnvironmentDecision(entry);
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
  if (graph.sourceExclusions !== undefined) {
    if (!Array.isArray(graph.sourceExclusions))
      throw new Error("Source exclusions must be a collection");
    for (const exclusion of graph.sourceExclusions) {
      if (
        !exclusion ||
        typeof exclusion !== "object" ||
        Object.keys(exclusion).sort().join() !==
          "objectiveLines,reason,source,statement" ||
        typeof exclusion.reason !== "string" ||
        !exclusion.reason.trim() ||
        !Array.isArray(exclusion.objectiveLines) ||
        !exclusion.objectiveLines.length ||
        exclusion.objectiveLines.some(
          (line) => !Number.isSafeInteger(line) || line < 0,
        ) ||
        !exclusion.source?.lines
      )
        throw new Error("Source exclusion is invalid");
      assertSourceObligationShape(exclusion);
    }
  }
}

/** A located source obligation names a non-Objective line range and its statement. */
function assertSourceObligationShape(entry: {
  source: CoverageObligation["source"];
  statement?: string;
}): void {
  const lines = entry.source.lines;
  if (lines === undefined && entry.statement === undefined) return;
  if (
    !Array.isArray(lines) ||
    lines.length !== 2 ||
    !lines.every((line) => Number.isSafeInteger(line) && line >= 0) ||
    lines[0] > lines[1] ||
    entry.source.path === "OBJECTIVE" ||
    typeof entry.statement !== "string" ||
    !entry.statement.trim() ||
    !/^[a-f0-9]{64}$/.test(entry.source.digest)
  )
    throw new Error(
      "Source obligation needs a cited source line range and a statement",
    );
}

export function normalizedCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

/**
 * The command an Acceptance bullet consists of: exactly one backticked
 * command, or a plain line, that has command authority of its own. Any other
 * bullet is a semantic obligation for review to judge.
 */
function commandObligation(
  text: string,
  isCommand: (command: string, backticked: boolean) => boolean,
): string | undefined {
  const quoted = text.trim().match(/^`([^`]+)`$/)?.[1];
  const candidate = quoted ?? text.trim();
  return isCommand(candidate, quoted !== undefined)
    ? normalizedCommand(candidate)
    : undefined;
}

export function assertCoverageSources(
  graph: WorkGraph,
  sources: { path: string; content: string }[],
  obligations: CoverageObligation[],
  finalCommands: string[],
  isCommand: (command: string, backticked: boolean) => boolean,
): void {
  assertCoverageShape(graph);
  const checks = (graph.requiredPreIntegrationChecks ?? []).map(
    (gate) => gate.checkName,
  );
  const finals = finalCommands.map(normalizedCommand);
  // A located exit item is re-sliced from its pinned source; an Objective
  // criterion carries its text.
  const spanText = (source: CoverageObligation["source"]) => {
    if (!source.lines) return source.text;
    const pinned = sources.find(
      (entry) =>
        entry.path === source.path &&
        sourceDigest(entry.content) === source.digest,
    );
    return pinned && sourceLines(pinned.content, source.lines);
  };
  for (const { itemId, proof, source } of graph.coverage) {
    // A command obligation is proved by running exactly that command, on
    // its owning item or among the Acceptance commands.
    const text = spanText(source);
    // An unlocatable span is refused below with its source identity.
    if (text === undefined) continue;
    const command = commandObligation(text, isCommand);
    if (
      command === undefined ||
      finals.includes(command) ||
      checks.includes(command) ||
      ("checkName" in proof && proof.checkName === command)
    )
      continue;
    const owner = graph.items.find((item) => item.id === itemId)!;
    const proved =
      "validationIndex" in proof &&
      normalizedCommand(owner.validation[proof.validationIndex]!.command) ===
        command;
    if (!proved)
      throw new Error(
        `Objective obligation \`${command}\` is a command, so its proof must be a result-command or integrated-command whose validationIndex selects exactly \`${command}\` on its owning item; it is proved by ${proof.kind} on ${itemId}`,
      );
  }
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
  const objective = sources.find((source) => source.path === "OBJECTIVE");
  const spans: CoverageObligation["source"][] = [];
  const located = (entry: { source: CoverageObligation["source"] }) => {
    const { path, digest, lines } = entry.source;
    const source = sources.find(
      (source) =>
        source.path === path && sourceDigest(source.content) === digest,
    );
    const actual = lines && source && sourceLines(source.content, lines);
    if (!lines || !actual?.trim())
      throw new Error(
        "Source obligation line range differs from its pinned source",
      );
    if (
      spans.some(
        (span) =>
          span.path === path &&
          span.digest === digest &&
          span.lines![0] <= lines[1] &&
          lines[0] <= span.lines![1],
      )
    )
      throw new Error("Source obligations repeat or overlap a source span");
    spans.push(entry.source);
  };
  for (const exclusion of graph.sourceExclusions ?? []) {
    located(exclusion);
    const objectiveLines = objective?.content.split("\n").length ?? 0;
    if (exclusion.objectiveLines.some((line) => line >= objectiveLines))
      throw new Error(
        "Source exclusion must cite existing Objective lines for its reason",
      );
  }
  for (const entry of graph.coverage) {
    if (entry.source.lines) {
      located(entry);
      if (
        entry.criterionId !==
        sourceObligationId(
          entry.source as Parameters<typeof sourceObligationId>[0],
        )
      )
        throw new Error("Source obligation identity differs from its span");
      continue;
    }
    const source = sources.find(
      (source) =>
        source.path === entry.source.path &&
        sourceDigest(source.content) === entry.source.digest,
    );
    if (!source || entry.source.path !== "OBJECTIVE")
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

/** Deterministic children add local acceptance, never replace admitted Objective proof. */
export function assertExpansionCoverage(
  original: WorkGraph,
  materialized: WorkGraph,
): void {
  if (
    JSON.stringify(original.coverage) !== JSON.stringify(materialized.coverage)
  )
    throw new Error(
      "Graph expansion must preserve every original coverage identity, source, owner, proof and environment unchanged",
    );
  assertCoverageShape(materialized);
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
            criterion.criterion === coverageCriterion(entry) &&
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
    const semantic = semanticProofCriterion(entry, item);
    if (
      semantic !== undefined &&
      !work.validation.criteria?.some(
        (criterion) =>
          criterion.criterion === semantic &&
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

/** Exact declared rows, in source-authorized validation order, in this checkout. */
export function environmentValidationIndices(
  graph: WorkGraph,
  itemId: string,
): number[] {
  assertCoverageShape(graph);
  const item = graph.items.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error("Environment owner is absent");
  const selected = new Set(
    itemCoverage(graph, itemId)
      .flatMap((entry) => [
        ...(entry.environment.prerequisites ?? []),
        entry.environment.probe,
      ])
      .filter(Boolean),
  );
  return item.validation.flatMap((check, index) =>
    selected.has(check.command) ? [index] : [],
  );
}

/** Readiness may replace setup only when that row is not substantive proof. */
export function reusableEnvironmentValidationIndices(
  graph: WorkGraph,
  itemId: string,
): number[] {
  const indices = environmentValidationIndices(graph, itemId);
  const item = graph.items.find((candidate) => candidate.id === itemId)!;
  const coverage = itemCoverage(graph, itemId);
  return indices.filter((index) => {
    const command = normalizedCommand(item.validation[index]!.command);
    return !coverage.some((entry) => {
      // State checks this without the pinned sources, so a located exit item
      // is matched by its statement.
      const explicitCommand = coverageCriterion(entry)
        .trim()
        .replace(/^`([^`]+)`$/, "$1");
      return (
        item.acceptance.some(
          (criterion) =>
            normalizedCommand(criterion.trim().replace(/^`([^`]+)`$/, "$1")) ===
            command,
        ) ||
        ("validationIndex" in entry.proof &&
          entry.proof.validationIndex === index) ||
        normalizedCommand(explicitCommand) === command
      );
    });
  });
}

/**
 * What final validation runs on its fresh checkout before the final commands:
 * the graph's declared prerequisites, unless the final commands already start
 * with them, led by the graph's source-declared package bootstrap when no
 * final command installs. Only a bootstrap that runs first installs, so the
 * final commands get dependencies even when none of them lists one.
 */
export function finalPreparationCommands(
  graph: WorkGraph,
  finalCommands: readonly string[],
): string[] {
  const declared = objectivePreparationCommands(graph);
  const preparation = declared.every(
    (command, index) => finalCommands[index] === command,
  )
    ? []
    : declared;
  const bootstrap = graph.items
    .flatMap((item) => item.validation)
    .find(
      (check) =>
        check.provenance === "source-declared" &&
        packageBootstrap(check.command) !== undefined,
    )?.command;
  const sequence = [...preparation, ...finalCommands];
  return bootstrap === undefined ||
    !sequence.length ||
    packageBootstrap(sequence[0]!) !== undefined ||
    finalCommands.some((command) => packageBootstrap(command) !== undefined)
    ? preparation
    : [bootstrap, ...preparation.filter((command) => command !== bootstrap)];
}

/** Preparation authority only; no readiness or acceptance inferred from success. */
export function objectivePreparationCommands(graph: WorkGraph): string[] {
  assertCoverageShape(graph);
  const commands: string[] = [];
  const ordered: WorkItem[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (item: WorkItem) => {
    if (visited.has(item.id)) return;
    if (visiting.has(item.id))
      throw new Error("Preparation dependencies contain a cycle");
    visiting.add(item.id);
    for (const id of item.dependencies) {
      const dependency = graph.items.find((candidate) => candidate.id === id);
      if (!dependency) throw new Error("Preparation dependency is absent");
      visit(dependency);
    }
    visiting.delete(item.id);
    visited.add(item.id);
    ordered.push(item);
  };
  for (const item of graph.items) visit(item);
  for (const item of ordered) {
    const selected = new Set(
      itemCoverage(graph, item.id).flatMap(
        (entry) => entry.environment.prerequisites ?? [],
      ),
    );
    for (const check of item.validation)
      if (selected.has(check.command)) commands.push(check.command);
  }
  return commands;
}
