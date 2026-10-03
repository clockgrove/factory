// One planning eval run, started by scripts/eval-planning.mjs in its own
// process with private XDG state. It plans one local Objective body against an
// isolated checkout at the pinned commit and writes result.json.
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  readDiagnosticMetadata,
  summarizeModelInvocations,
} from "../dist/diagnostics.js";
import { composePlanning, validateConfig } from "../dist/index.js";

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

/** An isolated checkout at the pinned commit, bound to the case repository. */
function prepareCheckout() {
  const git = (...args) =>
    execFileSync("git", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1" },
    });
  git("clone", "--quiet", "--shared", "--no-checkout", spec.target, checkout);
  git("-C", checkout, "checkout", "--quiet", "--detach", spec.commit);
  git(
    "-C",
    checkout,
    "remote",
    "set-url",
    "origin",
    `https://github.com/${spec.repository}.git`,
  );
}

function reviewOutcome(review) {
  if (review.failure) return "question";
  return review.findings.length ? "findings" : "clean";
}

const result = { planned: false, wallMs: 0, error: null };
let started;
try {
  prepareCheckout();
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
  const plan = await application.planObjective(spec.objective);
  result.wallMs = Math.round(performance.now() - started);
  result.planned = true;
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
} catch (error) {
  if (started) result.wallMs = Math.round(performance.now() - started);
  result.error = error instanceof Error ? error.message : String(error);
} finally {
  rmSync(checkout, { recursive: true, force: true });
}
try {
  const usage = summarizeModelInvocations(
    readDiagnosticMetadata(spec.repository, spec.objective),
  );
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
} catch (error) {
  result.error ??= `Diagnostics unreadable: ${error instanceof Error ? error.message : String(error)}`;
}
writeFileSync(
  join(spec.directory, "result.json"),
  `${JSON.stringify(result, null, 2)}\n`,
);
