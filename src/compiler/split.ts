import { assertKnownCheckNames, workflowCheckNames } from "../check-names.js";
import type { PlanningRequest, WorkGraph } from "../contracts.js";
import { assertPreIntegrationCheckSources } from "../delivery/readiness.js";
import { assertChildObjectives, childIssueBody } from "../objective-split.js";
import { sourceDigest } from "../qa.js";
import { verifyReviewedGraph } from "./candidate.js";
import { PlanValidationError } from "./faults.js";
import {
  prepareCompilationRequest,
  validateCompiledGraph,
} from "./planning.js";
import {
  finalObjectiveCommands,
  objectiveCriteria,
  planningSources,
} from "./sources.js";

/** Every Work Item of a graph, including each ready child's in a split. */
export function graphItems(graph: WorkGraph): WorkGraph["items"] {
  return graph.split
    ? graph.split.children.flatMap((child) => child.graph?.items ?? [])
    : graph.items;
}

/**
 * A split's ready children are checked as the Objectives they become: each
 * child's graph is validated against its own issue body, sources and
 * Acceptance at the same base, with exactly the checks a compile of that
 * child would apply. Its coverage moves from the parent's obligations to
 * the child's own, which are the same criteria in the same order. Nothing
 * the parent's plan requires may fall between the children: every required
 * check and source exclusion stays with a child that cites its source.
 */
export function validateSplitGraph(args: {
  graph: WorkGraph;
  request: PlanningRequest<WorkGraph>;
  body: string;
  checkout: string;
}): WorkGraph {
  const { graph, request, body, checkout } = args;
  const objective = request.compileContext!.objectiveNumber;
  const children = graph.split!.children;
  const refused = (key: string, error: unknown) =>
    new PlanValidationError(
      new Error(
        `Child Objective ${key}: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  const prepared = children.map((child) => {
    const childBody = childIssueBody(objective, body, child);
    try {
      return {
        child,
        childBody,
        // Every child's issue must already be a valid Objective at the base.
        sources: planningSources(childBody, request.baseSha, checkout),
      };
    } catch (error) {
      throw refused(child.key, error);
    }
  });
  const cites = (
    sources: { path: string; content: string }[],
    source: { path: string; digest: string },
  ) =>
    sources.some(
      (entry) =>
        entry.path === source.path &&
        sourceDigest(entry.content) === source.digest,
    );
  // The decoder gave every ready child the whole plan's checks and exclusions.
  const ready = children.find((child) => child.graph)!.graph!;
  for (const required of [
    ...(ready.requiredPreIntegrationChecks ?? []),
    ...(ready.sourceExclusions ?? []),
  ])
    if (!prepared.some(({ sources }) => cites(sources, required.source)))
      throw new PlanValidationError(
        new Error(
          `No child Objective cites ${required.source.path}, so the split would drop what it requires`,
        ),
      );
  const parentLines = body.split("\n");
  for (const { child, childBody, sources } of prepared) {
    if (!child.graph) continue;
    let childRequest: PlanningRequest<WorkGraph>;
    try {
      childRequest = prepareCompilationRequest({
        objective,
        body: childBody,
        baseSha: request.baseSha,
        checkout,
        ...(request.executionProfiles
          ? { executionProfiles: request.executionProfiles }
          : {}),
        ...(request.executionBounds
          ? { executionBounds: request.executionBounds }
          : {}),
        ...(request.approvedPlaybookPin !== undefined
          ? { approvedPlaybookPin: request.approvedPlaybookPin }
          : {}),
        ...(request.invocation ? { invocation: request.invocation } : {}),
      });
    } catch (error) {
      throw refused(child.key, error);
    }
    const obligations = childRequest.coverageObligations ?? [];
    let next = 0;
    child.graph.coverage = child.graph.coverage.map((entry) => {
      if (entry.source.path !== "OBJECTIVE") return entry;
      const { itemId, proof, environment } = entry;
      const obligation = obligations[next++];
      if (!obligation)
        throw refused(child.key, new Error("covers more outcomes than it has"));
      return { ...structuredClone(obligation), itemId, proof, environment };
    });
    if (next !== obligations.length)
      throw refused(
        child.key,
        new Error("leaves an Acceptance outcome uncovered"),
      );
    child.graph.requiredPreIntegrationChecks = (
      child.graph.requiredPreIntegrationChecks ?? []
    ).filter((check) => cites(sources, check.source));
    // An exclusion's reason cites Objective lines the child carries verbatim.
    const childLines = childBody.split("\n");
    const exclusions = (child.graph.sourceExclusions ?? [])
      .filter((exclusion) => cites(sources, exclusion.source))
      .map((exclusion) => ({
        ...exclusion,
        objectiveLines: exclusion.objectiveLines.map((line) => {
          const moved = childLines.indexOf(parentLines[line] ?? "\0");
          if (moved < 0)
            throw refused(
              child.key,
              new Error(
                `excludes ${exclusion.source.path} for Objective text it does not carry`,
              ),
            );
          return moved;
        }),
      }));
    if (exclusions.length) child.graph.sourceExclusions = exclusions;
    else delete child.graph.sourceExclusions;
    try {
      child.graph = validateCompiledGraph({
        graph: child.graph,
        request: childRequest,
        body: childBody,
        checkout,
      });
    } catch (error) {
      throw refused(
        child.key,
        error instanceof PlanValidationError ? error.cause : error,
      );
    }
  }
  return graph;
}

/**
 * A retained split's reviewed bytes: the children carry exactly the
 * Objective's Acceptance criteria between them, and each ready child's graph
 * verifies as that child's own reviewed plan would.
 */
export function verifySplitGraph(
  graph: WorkGraph,
  objective: number,
  body: string,
  baseSha: string,
  checkout: string,
): void {
  const children = graph.split!.children;
  assertChildObjectives(children);
  if (graph.items.length || graph.coverage.length)
    throw new Error("A split carries its Work Items in its children");
  const sorted = (values: string[]) => JSON.stringify([...values].sort());
  if (
    sorted(children.flatMap((child) => child.outcomes)) !==
    sorted(objectiveCriteria(body))
  )
    throw new Error(
      "Child Objectives must carry exactly the Objective's Acceptance criteria between them",
    );
  for (const child of children) {
    if (!child.graph) continue;
    const childBody = childIssueBody(objective, body, child);
    const sources = planningSources(childBody, baseSha, checkout);
    assertPreIntegrationCheckSources(child.graph, sources);
    assertKnownCheckNames(child.graph, workflowCheckNames(checkout, baseSha));
    verifyReviewedGraph(
      child.graph,
      objective,
      baseSha,
      sources,
      childBody,
      finalObjectiveCommands(childBody),
      checkout,
    );
  }
}
