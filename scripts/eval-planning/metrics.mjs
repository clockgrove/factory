// Judge-free planning metrics. Each one counts structured plan fields,
// structured repository files or diagnostics. None interprets prose; what
// needs interpretation is a judge rubric dimension instead.
import { parse } from "yaml";

const isWork = (item) => !item.kind || item.kind === "work";
/** The controller's error prefix when planning stops for an operator. */
const UNDELEGATED_DECISION = "Planning needs an undelegated decision";

/** Longest dependency chain, counted in Work Items. */
export function criticalPath(graph) {
  const byId = new Map(graph.items.map((item) => [item.id, item]));
  const memo = new Map();
  const depth = (id, seen = new Set()) => {
    if (memo.has(id)) return memo.get(id);
    if (seen.has(id)) return Number.POSITIVE_INFINITY;
    seen.add(id);
    const item = byId.get(id);
    const value =
      1 +
      Math.max(
        0,
        ...(item?.dependencies ?? [])
          .filter((dependency) => byId.has(dependency))
          .map((dependency) => depth(dependency, seen)),
      );
    seen.delete(id);
    memo.set(id, value);
    return value;
  };
  return Math.max(0, ...graph.items.map((item) => depth(item.id)));
}

/** How many coverage proofs of each kind the plan uses. */
export function proofKinds(graph) {
  const counts = {};
  for (const entry of graph.coverage)
    counts[entry.proof.kind] = (counts[entry.proof.kind] ?? 0) + 1;
  return counts;
}

/**
 * Command-line obligations left to final review. An obligation is a command
 * line when its criterion contains, character for character, a command the
 * plan's own authority receipts authorize. Final review cannot replace a
 * required command.
 */
export function finalReviewInsteadOfCommand(plan) {
  const commands = (plan.commands ?? [])
    .filter((receipt) => receipt.hostExecution === "authorized")
    .map((receipt) => receipt.command);
  const criteria = plan.graph.coverage
    .filter((entry) => entry.proof.kind === "final-review")
    .map((entry) => entry.source.text)
    .filter((text) => commands.some((command) => text.includes(command)));
  return { count: criteria.length, criteria };
}

/**
 * Check-run names the repository's workflows can produce: each job's `name`,
 * or its id when it has none. Matrix and reusable-workflow names are not
 * expanded.
 */
export function workflowCheckNames(workflows) {
  const names = new Set();
  for (const workflow of workflows) {
    let document;
    try {
      document = parse(workflow.content);
    } catch {
      continue;
    }
    for (const [id, job] of Object.entries(document?.jobs ?? {}))
      names.add(typeof job?.name === "string" ? job.name : id);
  }
  return names;
}

/** Every named CI check in the plan, and whether a workflow job produces it. */
export function ciCheckNames(graph, checkNames) {
  const names = [
    ...new Set([
      ...(graph.requiredPreIntegrationChecks ?? []).map(
        (gate) => gate.checkName,
      ),
      ...graph.coverage.flatMap((entry) =>
        "checkName" in entry.proof ? [entry.proof.checkName] : [],
      ),
    ]),
  ];
  const ungrounded = names.filter((name) => !checkNames.has(name));
  return {
    total: names.length,
    grounded: names.length - ungrounded.length,
    ungrounded,
  };
}

/**
 * How the first compile attempt ended, from model-invocation diagnostics:
 * accepted, review-findings, review-invalid, parse, semantic:<field>,
 * provider, or none.
 */
export function firstTry(events, finalReviewClean) {
  // A provider-capacity retry reuses the invocation id; the last attempt
  // decides how the invocation ended.
  const invocations = [];
  const byId = new Map();
  for (const event of events) {
    if (event.operation !== "model-invocation") continue;
    const id = event.metadata?.invocationId;
    if (typeof id !== "string") continue;
    let entry = byId.get(id);
    if (!entry) {
      entry = { phase: event.metadata.phase, attempt: 0 };
      byId.set(id, entry);
      invocations.push(entry);
    }
    const attempt = event.metadata.providerAttempt ?? 1;
    if (attempt > entry.attempt) {
      entry.attempt = attempt;
      entry.types = new Set();
      entry.failureClass = undefined;
      entry.failureField = undefined;
    }
    if (attempt < entry.attempt) continue;
    const type = event.metadata.observationType;
    entry.types.add(type);
    if (type === "response-invalid") {
      entry.failureClass = event.metadata.failureClass;
      entry.failureField = event.metadata.failureField;
    }
  }
  const index = invocations.findIndex((entry) => entry.phase === "compile");
  if (index < 0) return "none";
  const outcome = (entry) => {
    if (entry.types.has("response-invalid"))
      return entry.failureClass === "structured-output-parse"
        ? "parse"
        : entry.failureClass === "review-protocol"
          ? "review-invalid"
          : `semantic:${entry.failureField ?? "response"}`;
    if (entry.types.has("failed")) return "provider";
    return undefined;
  };
  const compile = outcome(invocations[index]);
  if (compile) return compile;
  const reviewIndex = invocations.findIndex(
    (entry, at) => at > index && entry.phase === "graph-review",
  );
  if (reviewIndex < 0) return "none";
  const review = outcome(invocations[reviewIndex]);
  if (review) return review === "parse" ? "review-invalid" : review;
  if (invocations.length > reviewIndex + 1) return "review-findings";
  return finalReviewClean ? "accepted" : "review-findings";
}

/** Whether a run met its case's declared expectation; failed lists why not. */
export function expectation(expect, run, graph) {
  if (!expect) return null;
  const failed = [];
  const planned = run.planned && graph;
  if (expect.outcome === "plan" && run.review !== "clean")
    failed.push(`expected a clean plan, got ${run.review ?? "no plan"}`);
  if (expect.outcome === "question") {
    // A structural stop: a plan waiting for a decision, or planning that
    // ended with the controller's undelegated-decision refusal.
    const stopped = planned
      ? run.review !== "clean"
      : (run.error ?? "").startsWith(UNDELEGATED_DECISION);
    if (!stopped)
      failed.push(
        `expected an operator question, got ${planned ? "a clean plan" : "no plan"}`,
      );
  }
  if (planned) {
    const required = new Set(
      (graph.requiredPreIntegrationChecks ?? []).map((gate) => gate.checkName),
    );
    for (const name of expect.requiredChecks ?? [])
      if (!required.has(name)) failed.push(`missing required check ${name}`);
    if (expect.maxWorkItems && graph.items.length > expect.maxWorkItems)
      failed.push(
        `${graph.items.length} Work Items, expected at most ${expect.maxWorkItems}`,
      );
    if (expect.maxCriticalPath && criticalPath(graph) > expect.maxCriticalPath)
      failed.push(
        `critical path ${criticalPath(graph)}, expected at most ${expect.maxCriticalPath}`,
      );
    if (expect.readOnly && graph.items.some(isWork))
      failed.push("expected only read-only QA items");
  }
  return { met: failed.length === 0, failed };
}

/** All judge-free metrics for one planned run. */
export function planMetrics(plan, facts) {
  return {
    criticalPath: criticalPath(plan.graph),
    proofKinds: proofKinds(plan.graph),
    finalReviewInsteadOfCommand: finalReviewInsteadOfCommand(plan),
    ciCheckNames: ciCheckNames(plan.graph, workflowCheckNames(facts.workflows)),
  };
}
