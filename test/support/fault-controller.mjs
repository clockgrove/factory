// Runs one Objective in its own process against the strict GitHub HTTP fake,
// with Factory's real GitHubClient, RealGitHubGateway, NativeStackDelivery and
// RegularDelivery. In-process effects (model and execution-driver calls) can
// be faulted on their Nth call: crash (SIGKILL) before or after the call, a
// lost response (the call happened, the caller sees an error) or an
// unavailable burst (the call never happened). Prints one JSON line.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Octokit } from "@octokit/core";
import { createApplication } from "../../dist/application.js";
import { stateRoot } from "../../dist/config.js";
import { LocalContentStore } from "../../dist/content/local.js";
import { Interruption } from "../../dist/contracts.js";
import { NativeStackDelivery } from "../../dist/delivery/native-stack.js";
import { RegularDelivery } from "../../dist/delivery/regular.js";
import { LocalExecutionDriver } from "../../dist/execution/local.js";
import { GitHubClient } from "../../dist/github-client.js";
import { RealGitHubGateway } from "../../dist/github.js";
import { readState } from "../../dist/state-store.js";
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

function record(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(value)}\n`);
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

function faulty(object, target, faults, logPath) {
  const rules = faults
    .filter((fault) => fault.target === target)
    .map((fault) => ({ occurrence: 1, times: 1, seen: 0, ...fault }));
  return new Proxy(object, {
    get(subject, property, receiver) {
      const value = Reflect.get(subject, property, receiver);
      if (typeof value !== "function" || !FAULTED[target].includes(property))
        return value;
      return async (...args) => {
        const request = args[0] ?? {};
        record(logPath, {
          target,
          method: property,
          phase: request.reviewPhase ?? request.invocation?.phase,
          item: request.item?.id,
          attempt: request.attemptId ?? request.identity,
        });
        let fired;
        for (const rule of rules) {
          if (rule.method !== property) continue;
          rule.seen++;
          if (
            rule.seen >= rule.occurrence &&
            rule.seen < rule.occurrence + rule.times
          )
            fired = rule;
        }
        if (fired?.kind === "crash-before")
          process.kill(process.pid, "SIGKILL");
        if (fired?.kind === "unavailable") throw unavailable(target);
        const result = await value.apply(subject, args);
        if (fired?.kind === "crash-after") process.kill(process.pid, "SIGKILL");
        if (fired?.kind === "lost") throw lost(target);
        return result;
      };
    },
  });
}

const [descriptorPath] = process.argv.slice(2);
const descriptor = readDescriptor(descriptorPath);
const { config } = descriptor;
const faults = descriptor.faults ?? [];
const callsPath = join(descriptor.fakeRoot, "calls.ndjson");
const root = stateRoot(config.repository);
const contentStore = new LocalContentStore(join(root, "content"));
const client = new GitHubClient(
  new Octokit({ request: { fetch: rewritingFetch(descriptor.apiUrl) } }),
);
const github = new RealGitHubGateway(
  config.repository,
  new NativeStackDelivery(config.repository, client),
  client,
);
const driver = faulty(
  new LocalExecutionDriver(
    config.checkout,
    join(root, "worktrees"),
    new ScriptedHarness(
      join(root, "harness"),
      descriptor.actions,
      join(descriptor.fakeRoot, "harness.ndjson"),
    ),
    config.execution.concurrency,
    contentStore,
    "scripted-test@1",
  ),
  "driver",
  faults,
  callsPath,
);
const planningModel = faulty(
  new ScriptedPlanningModel(
    descriptor.graph,
    join(descriptor.fakeRoot, "planning.ndjson"),
  ),
  "model",
  faults,
  callsPath,
);
const application = createApplication(config, {
  planningModel,
  driver,
  github,
  delivery: new RegularDelivery(config.checkout, github),
  contentStore,
});

function summary() {
  try {
    const state = readState(config.repository, descriptor.graph.objective);
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
  const state = await application.runObjective(descriptor.graph.objective);
  console.log(
    JSON.stringify({
      outcome: "completed",
      finalValidation: state.finalValidation?.passed === true,
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
// A completed Objective may leave idle handles (keep-alive sockets).
process.exit(0);
