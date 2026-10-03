// Judge-free planning metrics. Each one is computed from the plan, the pinned
// sources and diagnostics only, so it cannot drift with any model prompt.

// A command span starts with a runner and an argument; `test/a.mjs` and
// `go.mod` are paths, not commands.
const RUNNER =
  /^(?:npm|pnpm|npx|yarn|node|git|make|cargo|go|python3?|pytest|bash|sh|test|grep)\s+\S/;
// Acceptance that states the item's own merge, upload, publication or
// hydration as done. "passes the check before it merges" and "published
// image" describe other things and do not count.
const OWN_LIFECYCLE = [
  /\b(?:is|are|was|were|be|been|gets?|got|has|have)\s+(?:been\s+)?(?:merged|uploaded|hydrated|published|released)\b/i,
  /\bmerged\s+(?:in)?to\s+(?:main|master|the default branch)\b/i,
  /\buploaded\s+to\b/i,
  /\bhydrat\w*\b[^.]*\bclone\b/i,
];

const isWork = (item) => !item.kind || item.kind === "work";

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

function codeSpans(text) {
  return [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1].trim());
}

/**
 * Coverage that leaves a command-shaped criterion to final review. Final
 * review cannot replace a source-required command or check.
 */
export function finalReviewInsteadOfCommand(plan) {
  const commands = new Set([
    ...plan.graph.items.flatMap((item) =>
      item.validation.map((v) => v.command),
    ),
    ...(plan.finalCommands ?? []),
  ]);
  const criteria = plan.graph.coverage
    .filter((entry) => entry.proof.kind === "final-review")
    .map((entry) => entry.source.text)
    .filter((text) =>
      codeSpans(text).some((span) => commands.has(span) || RUNNER.test(span)),
    );
  return { count: criteria.length, criteria };
}

/** Work Item acceptance that needs the item's own merge, upload or hydration. */
export function ownLifecycleAcceptance(graph) {
  const found = graph.items
    .filter(isWork)
    .flatMap((item) =>
      item.acceptance
        .filter((text) => OWN_LIFECYCLE.some((pattern) => pattern.test(text)))
        .map((text) => ({ item: item.id, text })),
    );
  return { count: found.length, acceptance: found };
}

/** Every named CI check in the plan, and whether it appears in any source text. */
export function ciCheckNames(graph, texts) {
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
  const ungrounded = names.filter(
    (name) => !texts.some((text) => text.includes(name)),
  );
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
    // An operator stop is a plan waiting for a decision, or planning that
    // stopped on an undelegated decision before any plan.
    const stopText = planned
      ? run.review === "clean"
        ? null
        : [
            run.failure?.detail,
            run.failure?.question,
            ...(run.findings ?? []).flatMap((f) => [f.detail, f.question]),
          ].join("\n")
      : /undelegated decision|operator (?:decision|direction)|source decision required/i.test(
            run.error ?? "",
          )
        ? run.error
        : null;
    if (stopText === null)
      failed.push(
        `expected an operator question, got ${planned ? "a clean plan" : `no plan (${run.error?.split("\n")[0] ?? "no error"})`}`,
      );
    else if (
      expect.questionPattern &&
      !new RegExp(expect.questionPattern, "i").test(stopText)
    )
      failed.push(
        `the operator question does not mention /${expect.questionPattern}/`,
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
export function planMetrics(plan, texts) {
  return {
    criticalPath: criticalPath(plan.graph),
    finalReviewInsteadOfCommand: finalReviewInsteadOfCommand(plan),
    ownLifecycleAcceptance: ownLifecycleAcceptance(plan.graph),
    ciCheckNames: ciCheckNames(plan.graph, texts),
  };
}
