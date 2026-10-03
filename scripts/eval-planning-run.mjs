// One planning eval run, started by scripts/eval-planning.mjs in its own
// process with private XDG state. It plans one local Objective body through
// the same planObjective path `factory run` uses, against an isolated checkout
// at the pinned commit, computes judge-free metrics, optionally asks the
// frozen judge panel in isolation, and writes result.json.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  readDiagnosticMetadata,
  summarizeModelInvocations,
} from "../dist/diagnostics.js";
import { PlanningNeedsDecision } from "../dist/compiler.js";
import { resolveCapacity } from "../dist/config.js";
import { composePlanning, validateConfig } from "../dist/index.js";
import { preflightObjective } from "../dist/local-preflight.js";
import { prepareCheckout, repositoryFacts } from "./eval-planning/cases.mjs";
import {
  gradeInIsolation,
  judgeInput,
  loadJudges,
} from "./eval-planning/judge.mjs";
import {
  expectation,
  firstTry,
  planMetrics,
} from "./eval-planning/metrics.mjs";

const spec = JSON.parse(readFileSync(process.argv[2], "utf8"));
const checkout = join(spec.directory, "checkout");

/**
 * Serves only the local Objective. Planning reads nothing else from GitHub;
 * any other gateway call fails instead of reaching GitHub.
 */
function evalGateway() {
  const served = {
    async objective(number) {
      if (number !== spec.objective)
        throw new Error(
          `Planning eval serves only Objective #${spec.objective}`,
        );
      return { title: spec.title, body: spec.body, state: "open" };
    },
    async objectiveDependencies() {
      return [];
    },
  };
  return new Proxy(served, {
    get(target, property) {
      if (
        property in target ||
        typeof property !== "string" ||
        property === "then"
      )
        return target[property];
      return () => {
        throw new Error(`Planning eval does not serve GitHub ${property}`);
      };
    },
  });
}

function reviewOutcome(review) {
  if (review.failure) return "question";
  return review.findings.length ? "findings" : "clean";
}

// outcome: "plan" (clean), "question" (stopped for an operator: a plan
// waiting for a decision, or the controller's PlanningNeedsDecision), or
// "error" (crash, timeout, provider or harness failure; no quality metrics).
const result = { outcome: "error", planned: false, wallMs: 0, error: null };
let started;
let plan;
let facts;
try {
  prepareCheckout(spec, checkout);
  const config = validateConfig({
    ...spec.config,
    repository: spec.repository,
    checkout,
  });
  // Host-dependent planning inputs, recorded so runs on different machines
  // can be told apart.
  result.host = {
    localExecutables:
      preflightObjective(config, spec.body, spec.commit) ?? null,
    capacity: resolveCapacity(config),
  };
  const planningModel = spec.planningModule
    ? await (
        await import(pathToFileURL(spec.planningModule).href)
      ).createPlanningModel({ config, directory: spec.directory })
    : undefined;
  const application = composePlanning(config, {
    github: evalGateway(),
    planningModel,
  });
  started = performance.now();
  // The production path: the same recoverable planning `factory run` uses,
  // bounded by the configuration's autonomy allowances.
  try {
    plan = await application.planObjective(spec.objective);
  } catch (error) {
    if (!(error instanceof PlanningNeedsDecision)) throw error;
    result.outcome = "question";
    result.stop = error.message;
  }
  result.wallMs = Math.round(performance.now() - started);
  if (plan) {
    result.planned = true;
    result.outcome = plan.review.status === "clean" ? "plan" : "question";
    result.reviewStatus = plan.review.status;
    result.review = reviewOutcome(plan.review);
    result.findingCount = plan.review.findings.length;
    result.revisions = plan.review.revisions;
    result.workItems = plan.graph.items.length;
    facts = repositoryFacts(checkout, spec.commit);
    result.metrics = planMetrics(plan, facts);
  }
} catch (error) {
  if (started && !result.wallMs)
    result.wallMs = Math.round(performance.now() - started);
  result.outcome = "error";
  result.error = error instanceof Error ? error.message : String(error);
} finally {
  rmSync(checkout, { recursive: true, force: true });
}
// Judges run before the plan or production findings reach disk, with the
// checkout already gone.
if (plan && spec.judges?.length)
  result.judges = await gradeInIsolation(
    loadJudges(spec.judges),
    judgeInput(plan, facts),
    spec.judgeTransport,
  );
if (plan) {
  result.findings = plan.review.findings.map(({ detail, question }) => ({
    detail,
    question,
  }));
  if (plan.review.failure) result.failure = plan.review.failure;
  result.plan = join(spec.directory, "plan.json");
  writeFileSync(result.plan, `${JSON.stringify(plan, null, 2)}\n`);
}
try {
  const events = readDiagnosticMetadata(spec.repository, spec.objective);
  const usage = summarizeModelInvocations(events);
  result.invocations = {
    total: usage.objective.invocationCount,
    completed: usage.objective.completedCount,
    failed: usage.objective.failedCount,
    usageUnavailable: usage.objective.usageUnavailableCount,
    byPhase: Object.fromEntries(
      Object.entries(usage.byPhase).map(([phase, value]) => [
        phase,
        value.invocationCount,
      ]),
    ),
  };
  result.tokens = usage.objective.tokenTotals;
  if (result.outcome !== "error")
    result.firstTry = firstTry(events, result.outcome === "plan");
} catch (error) {
  result.outcome = "error";
  result.error ??= `Diagnostics unreadable: ${error instanceof Error ? error.message : String(error)}`;
}
result.expectation = expectation(spec.expect, result, plan?.graph);
writeFileSync(
  join(spec.directory, "result.json"),
  `${JSON.stringify(result, null, 2)}\n`,
);
