// Seeded-defect review suite: feed a known-good plan and one-defect variants
// to the production plan reviewer, through the same compile validation and
// review packet as planning, and measure per-defect recall and false positives.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { CaseError, loadCase } from "./cases.mjs";
import { planVariants } from "./mutations.mjs";

const dist = resolve(import.meta.dirname, "../../dist");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/** Load review fixtures: a case plus an authored known-good plan. */
export function loadReviewFixtures(directory, names, caseOptions) {
  const roots = readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        existsSync(join(directory, entry.name, "fixture.json")),
    )
    .map((entry) => join(directory, entry.name))
    .filter((root) => !names.length || names.includes(basename(root)))
    .sort();
  for (const name of names)
    if (!roots.some((root) => basename(root) === name))
      throw new CaseError(`Unknown review fixture: ${name}`);
  if (!roots.length)
    throw new CaseError(`No review fixtures with fixture.json in ${directory}`);
  return roots.map((root) => {
    const spec = JSON.parse(readFileSync(join(root, "fixture.json"), "utf8"));
    if (!spec.case || !spec.graph)
      throw new CaseError(`${basename(root)}: fixture needs case and graph`);
    return {
      name: basename(root),
      case: loadCase(resolve(root, spec.case), caseOptions),
      native: Boolean(spec.native),
      workerTest: spec.workerTest,
      graph: spec.graph,
    };
  });
}

/**
 * Turn an authored plan into the decoded graph a planner would return:
 * criterion indices become controller criterion ids and required-check
 * sources get their pinned digest. Compile validation does the rest.
 */
export function hydrateAuthoredGraph(authored, request) {
  const graph = structuredClone(authored);
  graph.objective = request.compileContext.objectiveNumber;
  graph.baseSha = request.baseSha;
  graph.items = graph.items.map((item) => ({
    kind: "work",
    nonGoals: [],
    citations: [],
    resources: [],
    sourceAssets: [],
    expectedOutputRoles: [],
    minimumAssetSets: 0,
    requiredLfsRoles: [],
    ...item,
  }));
  graph.coverage = graph.coverage.map(({ criterion, ...entry }) => ({
    criterionId:
      request.coverageObligations[criterion]?.criterionId ??
      `unknown-criterion-${criterion}`,
    environment: {
      kind: "local",
      readiness: "available",
      probe: "",
      preparedBy: "",
    },
    ...entry,
  }));
  graph.requiredPreIntegrationChecks = (
    graph.requiredPreIntegrationChecks ?? []
  ).map((gate) => {
    const source = request.sources.find(
      (candidate) =>
        candidate.path === gate.source.path &&
        candidate.content.includes(gate.source.text),
    );
    return {
      checkName: gate.checkName,
      source: {
        path: gate.source.path,
        text: gate.source.text,
        digest: source ? sha256(source.content) : "0".repeat(64),
      },
    };
  });
  return graph;
}

/** A PlanningModel that "compiles" to one authored graph and never reviews. */
export function fixturePlanningModel(authored) {
  return {
    async generateStructured(request) {
      return hydrateAuthoredGraph(authored, request);
    },
    async reviewGraph() {
      throw new Error("The fixture planning model does not review");
    },
  };
}

/**
 * Build every variant's review packet with production compile validation.
 * A variant that validation refuses never reaches the reviewer; the refusal
 * is recorded because code, not review, caught that defect.
 */
export async function prepareVariants(fixture, config) {
  const {
    commandAuthority,
    compileObjective,
    finalObjectiveCommands,
    objectiveCriteria,
    planReviewPacket,
    planningSources,
  } = await import(`${dist}/compiler.js`);
  const { executionProfileChoices } = await import(
    `${dist}/execution-profiles.js`
  );
  const { preflightObjective } = await import(`${dist}/local-preflight.js`);
  const { resolveCapacity } = await import(`${dist}/config.js`);
  const evalCase = fixture.case;
  const checkout = config.checkout;
  // The same packet inputs as planObjective. Prerequisites stay undefined:
  // the eval gateway serves no predecessor Objectives.
  const bounds = { configuredConcurrency: resolveCapacity(config).concurrency };
  const profiles = executionProfileChoices(config);
  const localExecutables = preflightObjective(
    config,
    evalCase.body,
    evalCase.commit,
  );
  const sources = planningSources(evalCase.body, evalCase.commit, checkout);
  const compile = (graph) =>
    compileObjective(
      evalCase.objective,
      evalCase.body,
      evalCase.commit,
      checkout,
      fixturePlanningModel(graph),
      [],
      [],
      undefined,
      profiles,
      undefined,
      undefined,
      localExecutables,
      bounds,
    );
  let good;
  try {
    good = await compile(fixture.graph);
  } catch (error) {
    throw new CaseError(
      `${fixture.name}: the known-good plan fails compile validation: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const variants = planVariants(fixture.graph, {
    native: fixture.native,
    workerTest: fixture.workerTest,
    sourceText: sources.map((source) => source.content).join("\n"),
    criteria: objectiveCriteria(evalCase.body),
    finalCommands: finalObjectiveCommands(evalCase.body),
    // Which criteria are commands, by production's rule for the good plan.
    isCommand: commandAuthority(
      good,
      sources,
      evalCase.body,
      evalCase.commit,
      checkout,
    ),
  });
  for (const variant of variants) {
    try {
      const graph = await compile(variant.graph);
      variant.packet = planReviewPacket(
        evalCase.body,
        evalCase.commit,
        sources,
        graph,
        checkout,
        profiles,
        undefined,
        localExecutables,
        bounds,
      );
    } catch (error) {
      variant.refused = error instanceof Error ? error.message : String(error);
    }
  }
  return variants;
}

/** One production review of one variant. */
export async function reviewVariant(model, fixture, variant, repeat) {
  const { checkedPlanReview } = await import(`${dist}/compiler.js`);
  let tokens = null;
  const invocation = {
    invocationId: randomUUID(),
    phase: "graph-review",
    ordinal: 0,
    observe(observation) {
      if (observation.usage) tokens = observation.usage;
    },
  };
  const started = performance.now();
  const base = {
    fixture: fixture.name,
    variant: variant.variant,
    defect: variant.defect,
    repeat,
  };
  try {
    const review = await checkedPlanReview(model, variant.packet, invocation);
    const findings = review.findings.map(({ detail, question }) => ({
      detail,
      question,
    }));
    return {
      ...base,
      review: review.failure
        ? "invalid"
        : findings.length
          ? "findings"
          : "clean",
      flagged: findings.length > 0,
      findings,
      ...(review.failure ? { failure: review.failure } : {}),
      tokens,
      wallMs: Math.round(performance.now() - started),
    };
  } catch (error) {
    return {
      ...base,
      review: "error",
      error: error instanceof Error ? error.message : String(error),
      tokens,
      wallMs: Math.round(performance.now() - started),
    };
  }
}

/** The plan view the judge grades for a review variant. */
export function variantPlan(variant) {
  return {
    sources: variant.packet.sources,
    graph: variant.packet.graph,
    commands: variant.packet.commands,
    finalCommands: variant.packet.finalCommands,
  };
}
