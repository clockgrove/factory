// Runs one Objective in its own process against the strict GitHub HTTP fake.
// The application comes from Factory's public composition
// (composeWithLocalHarness) with the real GitHubClient, RealGitHubGateway,
// NativeStackDelivery and RegularDelivery; only the planning model and the
// harness are scripted. Model and execution-driver calls can be faulted on
// their Nth call: crash (SIGKILL) before or after the call, a lost response
// (the call happened, the caller sees an error), an unavailable burst (the
// call never happened) or, for model calls, a usage limit with a reset time
// or (reviews) an answer the decoder refuses.
// An operator action (cancel) can be taken when a driver call for an item
// begins. With `answer`, a restart first runs the `factory retry` command the
// status names for the previous run's stop, as the operator would. Prints
// one JSON line.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Octokit } from "@octokit/core";
import { stateRoot } from "../../dist/config.js";
import { NativeStackDelivery } from "../../dist/delivery/native-stack.js";
import { executionFault } from "../../dist/execution/fault.js";
import { LocalExecutionDriver } from "../../dist/execution/local.js";
import { attachFault, transient } from "../../dist/fault.js";
import { GitHubClient } from "../../dist/github-client.js";
import { RealGitHubGateway } from "../../dist/github.js";
import { composeWithLocalHarness } from "../../dist/index.js";
import { continuationStatusDocument } from "../../dist/diagnostics.js";
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
  appendFileSync(
    callsPath,
    `${JSON.stringify({ run: descriptor.run ?? 0, ...value })}\n`,
  );
}

/**
 * The operator runs `factory cancel` while this controller owns the
 * Objective: the CLI signals the owner with SIGUSR1. With `settle`, wait
 * until Factory's handler has run, so the cancellation is recorded before
 * the intercepted call proceeds.
 */
async function operatorCancel(settle) {
  if (!settle) return void process.kill(process.pid, "SIGUSR1");
  await new Promise((resolve) => {
    process.once("SIGUSR1", () => setImmediate(resolve));
    process.kill(process.pid, "SIGUSR1");
  });
}

/** The Work Item a driver call is for: a request names it, a handle carries it. */
const itemOf = (request) =>
  request?.item?.id ?? request?.data?.request?.item?.id;

// The harness signals a controller only with SIGKILL. A SIGTERM came from
// outside the test (it makes Factory drain and release ownership), so record
// it: the scenario is then void, not a Factory result.
process.on("SIGTERM", () => {
  mkdirSync(descriptor.fakeRoot, { recursive: true });
  appendFileSync(
    join(descriptor.fakeRoot, "signals.ndjson"),
    `${JSON.stringify({ signal: "SIGTERM", at: new Date().toISOString() })}\n`,
  );
});
/**
 * The error a caller sees, classified as the adapter whose boundary is
 * faulted classifies it: the execution driver's classifier, or a model
 * adapter's (unreached: nothing paid; lost mid-call: maybe paid).
 */
function classified(target, method, error, reached) {
  return target === "driver"
    ? attachFault(
        error,
        executionFault(error, method) ??
          transient(`Driver ${method} failed: ${error.message}`, reached),
      )
    : attachFault(
        error,
        transient(
          `Model call ${reached ? "did not complete" : "unreachable"}: ${error.message}`,
          reached,
        ),
      );
}

/** The error a caller sees when the call never reached its service. */
function unavailable(target, method) {
  const cause = Object.assign(new Error("503 Service Unavailable"), {
    status: 503,
  });
  return classified(target, method, cause, false);
}

/**
 * A model provider's usage limit with its reset time: the call never ran,
 * and the caller is told when it may try again.
 */
const USAGE_RESET_MS = 3_000;
function usageLimited() {
  const cause = Object.assign(new Error("429 usage limit reached"), {
    status: 429,
  });
  return attachFault(
    cause,
    transient(
      cause.message,
      false,
      new Date(Date.now() + USAGE_RESET_MS).toISOString(),
    ),
  );
}

/** The error a caller sees when the call happened but its response was lost. */
function lost(target, method) {
  const cause = Object.assign(new Error("socket hang up"), {
    code: "ECONNRESET",
  });
  return classified(target, method, cause, true);
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
  const item = target === "driver" ? itemOf(request) : request?.item?.id;
  record({
    target,
    method,
    phase: request?.reviewPhase ?? request?.invocation?.phase,
    item,
    attempt: request?.attemptId ?? request?.identity,
    fault: fired?.kind,
    // Whether the call reached its service (and may have had an effect).
    reached: !["crash-before", "unavailable", "usage-limit"].includes(
      fired?.kind,
    ),
  });
  const operator = descriptor.operator;
  if (
    operator &&
    !operator.done &&
    target === "driver" &&
    operator.method === method &&
    operator.item === item
  ) {
    operator.done = true;
    // Cancelling while start is in flight must be recorded before start
    // returns; cancelling a running worker only needs to arrive.
    await operatorCancel(method === "start");
  }
  if (fired?.kind === "crash-before") process.kill(process.pid, "SIGKILL");
  if (fired?.kind === "unavailable") throw unavailable(target, method);
  if (fired?.kind === "usage-limit") throw usageLimited();
  const result = await call();
  if (fired?.kind === "crash-after") process.kill(process.pid, "SIGKILL");
  if (fired?.kind === "lost") throw lost(target, method);
  // An answer the decoder refuses: a review for another packet.
  if (fired?.kind === "invalid") return { ...result, packetId: "invalid" };
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
      // Only an Objective an operator cancelled reports its cancellation.
      ...(state.cancelRequested && {
        cancel: state.cancelledAt ? "done" : "requested",
        cancelError: state.coordinator?.cancelError,
      }),
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

/**
 * The operator answers the stop the status shows with the command it names,
 * when that command is `factory retry` (the answer to a step's decision or
 * configuration fix). Applied through the application, as the CLI does when
 * no run owns the Objective. Returns the command and its result.
 */
function answerStop() {
  const objective = descriptor.graph.objective;
  const continuation = readContinuation(config.repository, objective);
  if (!continuation) return undefined;
  const command = continuationStatusDocument(
    continuation,
    config.repository,
    objective,
    config.delivery.kind,
    [],
    continuation.capacity?.concurrency,
    false,
  ).nextAction?.command;
  const words = command?.split(" ") ?? [];
  if (words[0] !== "factory" || words[1] !== "retry")
    return command && { command, applied: "not a retry" };
  const option = (name) => {
    const index = words.indexOf(`--${name}`);
    return index < 0 ? undefined : words[index + 1];
  };
  if (Number(option("objective")) !== objective)
    return { command, applied: "another Objective" };
  try {
    return {
      command,
      applied: application.retryWorkItem(objective, option("item")),
    };
  } catch (error) {
    return { command, applied: `refused: ${error?.message ?? error}` };
  }
}

const answered =
  descriptor.answer && (descriptor.run ?? 0) > 0 ? answerStop() : undefined;

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
      ...(answered && { answered }),
      ...summary(),
    }),
  );
} catch (error) {
  console.log(
    JSON.stringify({
      outcome: "stopped",
      message: String(error?.message ?? error),
      ...(answered && { answered }),
      ...summary(),
    }),
  );
}
// A finished pass may leave idle handles (keep-alive sockets).
process.exit(0);
