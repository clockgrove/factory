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
 * the child's own, which are the same criteria in the same order.
 */
export function validateSplitGraph(args: {
  graph: WorkGraph;
  request: PlanningRequest<WorkGraph>;
  body: string;
  checkout: string;
}): WorkGraph {
  const { graph, request, body, checkout } = args;
  const objective = request.compileContext!.objectiveNumber;
  for (const child of graph.split!.children) {
    const childBody = childIssueBody(objective, body, child);
    const refused = (error: unknown) =>
      new PlanValidationError(
        new Error(
          `Child Objective ${child.key}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    if (!child.graph) {
      // A stub plans later, but its issue must already be a valid Objective.
      try {
        planningSources(childBody, request.baseSha, checkout);
      } catch (error) {
        throw refused(error);
      }
      continue;
    }
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
      throw refused(error);
    }
    const obligations = childRequest.coverageObligations ?? [];
    let next = 0;
    child.graph.coverage = child.graph.coverage.map((entry) => {
      if (entry.source.path !== "OBJECTIVE") return entry;
      const { itemId, proof, environment } = entry;
      const obligation = obligations[next++];
      if (!obligation)
        throw refused(new Error("covers more outcomes than it has"));
      return { ...structuredClone(obligation), itemId, proof, environment };
    });
    if (next !== obligations.length)
      throw refused(new Error("leaves an Acceptance outcome uncovered"));
    // A required check stays with a child that cites the source requiring it.
    child.graph.requiredPreIntegrationChecks = (
      child.graph.requiredPreIntegrationChecks ?? []
    ).filter((check) =>
      childRequest.sources.some(
        (source) =>
          source.path === check.source.path &&
          sourceDigest(source.content) === check.source.digest,
      ),
    );
    try {
      child.graph = validateCompiledGraph({
        graph: child.graph,
        request: childRequest,
        body: childBody,
        checkout,
      });
    } catch (error) {
      throw refused(error instanceof PlanValidationError ? error.cause : error);
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
