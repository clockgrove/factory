// One planning eval run, started by scripts/eval-planning.mjs in its own
// process with private XDG state. It plans one local Objective body through
// the same planObjective path `factory run` uses, against an isolated checkout
// at the pinned commit, computes judge-free metrics, optionally asks the
// frozen judge panel, and writes result.json.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  readDiagnosticMetadata,
  summarizeModelInvocations,
} from "../dist/diagnostics.js";
import { composePlanning, validateConfig } from "../dist/index.js";
import { prepareCheckout, repositoryFacts } from "./eval-planning/cases.mjs";
import { judgeInput, loadJudges, runPanel } from "./eval-planning/judge.mjs";
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

const result = { planned: false, wallMs: 0, error: null };
let started;
let plan;
try {
  prepareCheckout(spec, checkout);
  const config = validateConfig({
    ...spec.config,
    repository: spec.repository,
    checkout,
  });
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
  plan = await application.planObjective(spec.objective);
  result.wallMs = Math.round(performance.now() - started);
  result.planned = true;
  result.reviewStatus = plan.review.status;
  result.review = reviewOutcome(plan.review);
  result.findingCount = plan.review.findings.length;
  result.revisions = plan.review.revisions;
  result.workItems = plan.graph.items.length;
  result.findings = plan.review.findings.map(({ detail, question }) => ({
    detail,
    question,
  }));
  if (plan.review.failure) result.failure = plan.review.failure;
  result.plan = join(spec.directory, "plan.json");
  writeFileSync(result.plan, `${JSON.stringify(plan, null, 2)}\n`);
  const facts = repositoryFacts(checkout, spec.commit);
  result.metrics = planMetrics(plan, facts);
  if (spec.judges?.length)
    result.judges = await runPanel(
      loadJudges(spec.judges),
      judgeInput(plan, facts, plan.review.status !== "clean"),
      checkout,
      spec.judgeTransport,
    );
} catch (error) {
  if (started && !result.wallMs)
    result.wallMs = Math.round(performance.now() - started);
  result.error = error instanceof Error ? error.message : String(error);
} finally {
  rmSync(checkout, { recursive: true, force: true });
}
result.expectation = expectation(spec.expect, result, plan?.graph);
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
  result.firstTry = firstTry(events, result.review === "clean");
} catch (error) {
  result.error ??= `Diagnostics unreadable: ${error instanceof Error ? error.message : String(error)}`;
}
writeFileSync(
  join(spec.directory, "result.json"),
  `${JSON.stringify(result, null, 2)}\n`,
);
