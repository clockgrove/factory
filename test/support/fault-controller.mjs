// Runs one Objective in its own process against the strict GitHub HTTP fake.
// The application comes from Factory's public composition
// (composeWithLocalHarness) with the real GitHubClient, RealGitHubGateway,
// NativeStackDelivery and RegularDelivery; only the planning model and the
// harness are scripted. Model and execution-driver calls can be faulted on
// their Nth call: crash (SIGKILL) before or after the call, a lost response
// (the call happened, the caller sees an error) or an unavailable burst (the
// call never happened). Prints one JSON line.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Octokit } from "@octokit/core";
import { stateRoot } from "../../dist/config.js";
import { NativeStackDelivery } from "../../dist/delivery/native-stack.js";
import { LocalExecutionDriver } from "../../dist/execution/local.js";
import { GitHubClient } from "../../dist/github-client.js";
import { RealGitHubGateway } from "../../dist/github.js";
import { Interruption, composeWithLocalHarness } from "../../dist/index.js";
import {
  EXIT_COMPLETE,
  EXIT_NEEDS_DECISION,
  runOutcome,
} from "../../dist/run-outcome.js";
import { readContinuation } from "../../dist/state-store.js";
import { rewritingFetch } from "./github-http-fake.mjs";
import {
  ScriptedHarness,
  ScriptedPlanningModel,
  readDescriptor,
} from "./integration-fixture.mjs";

const FAULTED = {
  model: ["generateStructured", "reviewGraph", "reviewResult"],
  driver: ["start", "observe", "collect", "cancel"],
};

const [descriptorPath] = process.argv.slice(2);
const descriptor = readDescriptor(descriptorPath);
const { config } = descriptor;
const callsPath = join(descriptor.fakeRoot, "calls.ndjson");
const rules = (descriptor.faults ?? []).map((fault) => ({
  occurrence: 1,
  times: 1,
  seen: 0,
  ...fault,
}));

function record(value) {
  mkdirSync(dirname(callsPath), { recursive: true });
  appendFileSync(callsPath, `${JSON.stringify(value)}\n`);
}

/** The error a caller sees when the call never reached its service. */
function unavailable(target) {
  const cause = Object.assign(new Error("503 Service Unavailable"), {
    status: 503,
  });
  return target === "driver" ? new Interruption(cause) : cause;
}

/** The error a caller sees when the call happened but its response was lost. */
function lost(target) {
  const cause = Object.assign(new Error("socket hang up"), {
    code: "ECONNRESET",
  });
  return target === "driver" ? new Interruption(cause) : cause;
}

/** Log the call, apply a due fault, and run `call` unless the fault prevents it. */
async function intercept(target, method, request, call) {
  let fired;
  for (const rule of rules) {
    if (rule.target !== target || rule.method !== method) continue;
    rule.seen++;
    if (
      !fired &&
      rule.seen >= rule.occurrence &&
      rule.seen < rule.occurrence + rule.times
    )
      fired = rule;
  }
  record({
    target,
    method,
    phase: request?.reviewPhase ?? request?.invocation?.phase,
    item: request?.item?.id,
    attempt: request?.attemptId ?? request?.identity,
    fault: fired?.kind,
    // Whether the call reached its service (and may have had an effect).
    reached: !["crash-before", "unavailable"].includes(fired?.kind),
  });
  if (fired?.kind === "crash-before") process.kill(process.pid, "SIGKILL");
  if (fired?.kind === "unavailable") throw unavailable(target);
  const result = await call();
  if (fired?.kind === "crash-after") process.kill(process.pid, "SIGKILL");
  if (fired?.kind === "lost") throw lost(target);
  return result;
}

// The public composition constructs its own LocalExecutionDriver, so the
// driver boundary is intercepted on the class.
for (const method of FAULTED.driver) {
  const original = LocalExecutionDriver.prototype[method];
  LocalExecutionDriver.prototype[method] = function (...args) {
    return intercept("driver", method, args[0], () =>
      original.apply(this, args),
    );
  };
}

const planner = new ScriptedPlanningModel(
  descriptor.graph,
  join(descriptor.fakeRoot, "planning.ndjson"),
);
const planningModel = new Proxy(planner, {
  get(subject, property, receiver) {
    const value = Reflect.get(subject, property, receiver);
    if (typeof value !== "function" || !FAULTED.model.includes(property))
      return value;
    return (...args) =>
      intercept("model", property, args[0], () => value.apply(subject, args));
  },
});

const client = new GitHubClient(
  new Octokit({ request: { fetch: rewritingFetch(descriptor.apiUrl) } }),
);
const application = composeWithLocalHarness(
  config,
  {
    identity: config.execution.harness.adapter,
    config: config.execution.harness.config,
    harness: new ScriptedHarness(
      join(stateRoot(config.repository), "harness"),
      descriptor.actions,
      join(descriptor.fakeRoot, "harness.ndjson"),
    ),
  },
  {
    planningModel,
    github: new RealGitHubGateway(
      config.repository,
      new NativeStackDelivery(config.repository, client),
      client,
    ),
  },
);

function summary() {
  try {
    const state = readContinuation(
      config.repository,
      descriptor.graph.objective,
    );
    if (!state) return {};
    return {
      error: state.error,
      mode: state.coordinator?.mode,
      waitReason: state.coordinator?.waitReason,
      work: Object.fromEntries(
        Object.entries(state.work ?? {}).map(([id, work]) => [
          id,
          {
            status: work.status,
            step: work.step,
            failure: work.recovery?.failure?.detail,
            classification: work.recovery?.failure?.classification,
          },
        ]),
      ),
    };
  } catch (error) {
    return { state: String(error.message ?? error) };
  }
}

try {
  // A run stays alive through waits and returns complete, needing a human
  // decision, or failed (the `factory run` exit codes). The test judges the
  // end state from GitHub and the repository, not from this outcome.
  const state = await application.runObjective(descriptor.graph.objective);
  const { code, message } = runOutcome(state);
  console.log(
    JSON.stringify({
      outcome:
        code === EXIT_COMPLETE
          ? "complete"
          : code === EXIT_NEEDS_DECISION
            ? "needs-decision"
            : "failed-run",
      message,
      ...summary(),
    }),
  );
} catch (error) {
  console.log(
    JSON.stringify({
      outcome: "stopped",
      message: String(error?.message ?? error),
      ...summary(),
    }),
  );
}
// A finished pass may leave idle handles (keep-alive sockets).
process.exit(0);
