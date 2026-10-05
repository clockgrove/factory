// One controller process for the dead-end finder (test/dead-ends.test.mjs).
// It composes Factory exactly like fault-controller.mjs (public composition,
// real GitHub client and delivery against the HTTP fake; scripted planning
// model and harness) and watches every state snapshot Factory writes:
//
// - trajectory: stop the whole process group at the first snapshot of each
//   new state shape, so the test can copy that reachable state and its world;
// - run: restart the Objective once and report how it ended, stopping as soon
//   as a snapshot shows progress or the controller sits idle;
// - command: apply one operator command the way the CLI does: through the
//   running owner's control socket when one is alive, else through the
//   application.
//
// Prints one JSON line (trajectory: one per anchor).
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

// Factory imports `renameSync` from node:fs; patch it before loading Factory
// so every atomic state snapshot passes through `observeSnapshot`.
let observeSnapshot = () => undefined;
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
  rename(from, to);
  if (String(to).endsWith("/objectives/1/state.json")) observeSnapshot(to);
};
syncBuiltinESMExports();

const { join } = await import("node:path");
const { Octokit } = await import("@octokit/core");
const { factoryConfigDigest, stateRoot } = await import("../../dist/config.js");
const { NativeStackDelivery } = await import(
  "../../dist/delivery/native-stack.js"
);
const { GitHubClient } = await import("../../dist/github-client.js");
const { RealGitHubGateway } = await import("../../dist/github.js");
const { composeWithLocalHarness } = await import("../../dist/index.js");
const { EXIT_COMPLETE, EXIT_NEEDS_DECISION, runOutcome } = await import(
  "../../dist/run-outcome.js"
);
const { readContinuation, readControllerOwner } = await import(
  "../../dist/state-store.js"
);
const { linuxProcessIdentity } = await import("../../dist/process.js");
const { requestControl } = await import("../../dist/coordinator-control.js");
const { continuationStatusDocument } = await import(
  "../../dist/diagnostics.js"
);
const { controlObjective } = await import("../../dist/runner.js");
const { rewritingFetch } = await import("./github-http-fake.mjs");
const { ScriptedHarness, ScriptedPlanningModel, readDescriptor } = await import(
  "./integration-fixture.mjs"
);
const { advanced, fingerprint, shapeKey } = await import("./dead-ends.mjs");

const [descriptorPath] = process.argv.slice(2);
const descriptor = readDescriptor(descriptorPath);
const { config, graph } = descriptor;
const objective = graph.objective;

/** Write one JSON line synchronously, then end the whole process group. */
function finish(value) {
  fs.writeSync(1, `${JSON.stringify(value)}\n`);
  process.kill(-process.pid, "SIGKILL");
}

function readJson(path) {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** Whether a live controller owns this Objective, as `factory status` reads it. */
function controllerActive() {
  try {
    const owner = readControllerOwner(
      join(stateRoot(config.repository), "controller.lock"),
    );
    if (!owner) return false;
    const current = linuxProcessIdentity(owner.pid);
    return (
      current?.startTime === owner.startTime &&
      current.state !== "Z" &&
      (owner.intake === true || owner.objective === objective)
    );
  } catch {
    return null;
  }
}

/** The operator's view: the status document `factory status --json` prints. */
function status() {
  try {
    const continuation = readContinuation(config.repository, objective);
    const document = continuationStatusDocument(
      continuation,
      config.repository,
      objective,
      config.delivery.kind,
      [],
      continuation?.capacity.concurrency,
      controllerActive(),
      undefined,
      factoryConfigDigest(config),
    );
    return {
      phase: document.phase,
      summary: document.summary,
      nextAction: document.nextAction,
      active: document.runActive ?? null,
      // Every sentence of the status that can name a command: the summary,
      // the next action's reason, each repair's nextDecision, item errors
      // and waits, and the coordinator's wait reason.
      texts: [
        document.summary,
        document.nextAction?.reason,
        ...Object.values(document.repairs ?? {}).map(
          (repair) => repair.nextDecision,
        ),
        document.lastError,
        document.wait?.detail,
        document.wait?.fix,
        document.coordinator?.waitReason,
        ...(document.work ?? []).flatMap((item) => [
          item.lastError,
          item.wait?.detail,
          item.wait?.fix,
        ]),
      ].filter((text) => typeof text === "string"),
      coordinator: continuation?.coordinator && {
        mode: continuation.coordinator.mode,
        waitReason: continuation.coordinator.waitReason,
      },
      // Which criteria wait for a decision, to tell two decisions apart.
      pending: [
        ...Object.entries(continuation?.work ?? {})
          .filter(([, work]) => work.acceptancePending)
          .map(([id, work]) => `${id}: ${work.acceptancePending.criterion}`),
        ...(continuation?.finalAcceptancePending
          ? [`Objective: ${continuation.finalAcceptancePending.criterion}`]
          : []),
      ],
    };
  } catch (error) {
    return { unreadable: String(error?.message ?? error) };
  }
}

const planner = new ScriptedPlanningModel(
  graph,
  join(descriptor.fakeRoot, "planning.ndjson"),
);
// The result reviews of the named items (and of the Objective, as
// "objective") answer needs-human, so the run waits for a criterion decision.
const human = new Set(descriptor.needsHuman ?? []);
const planningModel = new Proxy(planner, {
  get(subject, property, receiver) {
    const value = Reflect.get(subject, property, receiver);
    if (property !== "reviewResult" || !human.size) return value;
    return async (request) => {
      const result = await value.call(subject, request);
      const phase = request.reviewPhase ?? request.invocation?.phase;
      const named =
        phase === "objective-review"
          ? human.has("objective")
          : request.criteria.some((criterion) =>
              [...human].some((id) => criterion.startsWith(`${id}.txt`)),
            );
      if (!named) return result;
      return {
        ...result,
        findings: result.findings.map((finding) => ({
          ...finding,
          verdict: "needs-human",
          question: "Is this result acceptable?",
        })),
      };
    };
  },
});

// GitHub requests in flight, so a controller awaiting a response is busy.
let requests = 0;
const githubFetch = rewritingFetch(descriptor.apiUrl);
const countedFetch = async (...args) => {
  requests++;
  try {
    return await githubFetch(...args);
  } finally {
    requests--;
  }
};
const client = new GitHubClient(
  new Octokit({ request: { fetch: countedFetch } }),
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

/**
 * Run one operator command a status names ({verb, options}, parsed in
 * dead-ends.mjs), filling its placeholders: decisions accept. Control actions
 * go to the running owner first and fall back to the application, as the CLI
 * does (src/cli.ts).
 */
// Whether the owner's control socket answered the command, or the application did.
let handledByOwner = false;

async function command({ verb, options, input }) {
  const item = options.item;
  const viaOwner = async (action, body, apply) => {
    const reply = await requestControl(config.repository, {
      objective,
      action,
      input: body,
    });
    handledByOwner = reply.handled === true;
    return reply.handled ? reply.result : apply();
  };
  switch (verb) {
    case "run":
      return;
    case "retry":
      return viaOwner("retry", item === undefined ? {} : { item }, () =>
        application.retryWorkItem(objective, item),
      );
    case "select":
      return viaOwner(
        "select",
        { item, set: options.set, actor: "operator" },
        () =>
          application.selectAssetSet(objective, item, options.set, {
            actor: "operator",
          }),
      );
    case "repair": {
      const state = readContinuation(config.repository, objective);
      const [id, work] =
        Object.entries(state.work ?? {}).find(
          ([, work]) => work.recovery?.phase === "stopped",
        ) ?? [];
      if (!work?.recovery?.failure)
        throw new Error("No stopped repair names a failure to correct");
      // The operator writes the proposal: a diagnosed implementation correction.
      const proposal = {
        item: id,
        correction: {
          failureDigest: work.recovery.failure.digest,
          kind: "implementation",
          diagnosis: "Diagnosed by the dead-end finder",
          correction: "Make the scripted change again",
          actor: "operator",
        },
      };
      return viaOwner("repair", proposal, () =>
        application.repairWorkItem(objective, proposal),
      );
    }
    case "decide":
      // The state says whether this is a plan or a result; only a plan takes an answer.
      return application.decide(objective, {
        item,
        actor: "operator",
        outcome: options.outcome === "refuse" ? "refuse" : "accept",
        answer: options.answer ? "Proceed" : undefined,
        reason: "Decided by the dead-end finder",
      });
    case "cancel":
      return viaOwner("cancel", {}, () =>
        application.cancelObjective(objective),
      );
    case "resume":
    case "pause":
    case "drain":
      return viaOwner(verb, undefined, () =>
        controlObjective(config, { objective, action: verb }),
      );
    case "propose-amendment":
      return viaOwner("propose-amendment", input, () =>
        controlObjective(config, {
          objective,
          action: "propose-amendment",
          input,
        }),
      );
  }
  throw new Error(`Unsupported operator command: factory ${verb}`);
}

if (descriptor.mode === "command") {
  try {
    await command(descriptor.command);
    finish({ ok: true, status: status(), viaOwner: handledByOwner });
  } catch (error) {
    finish({ ok: false, message: String(error?.message ?? error) });
  }
}

if (descriptor.mode === "trajectory") {
  // Stop the process group at the first snapshot of every new shape; the
  // test copies the stopped world and continues the group.
  const seen = new Set(descriptor.seen ?? []);
  observeSnapshot = (path) => {
    const state = readJson(path);
    if (!state) return;
    const key = shapeKey(state);
    if (seen.has(key)) return;
    seen.add(key);
    fs.writeSync(1, `${JSON.stringify({ anchor: key })}\n`);
    process.kill(-process.pid, "SIGSTOP");
  };
}

if (descriptor.mode === "run") {
  const baseline = descriptor.baseline;
  observeSnapshot = (path) => {
    quietSince = Date.now();
    const state = readJson(path);
    if (!state) return;
    const step = baseline && advanced(baseline, fingerprint(state));
    if (!step) return;
    const progressed = () =>
      finish({ outcome: "progressed", step, status: status() });
    // A command sent to the owner is answered after the snapshot it wrote.
    if (idleReported) setTimeout(progressed, 200);
    else progressed();
  };
  // A controller that has nothing in progress — no subprocess, file
  // operation or timer other than this one, and no snapshot for a while —
  // waits for an operator (a paused or draining owner waits for a control
  // request). Idle keep-alive sockets do not count. It reports every
  // quiet period, so the test sees the state after its commands.
  let quietSince = Date.now();
  let idleReported = false;
  setInterval(() => {
    const busy = process
      .getActiveResourcesInfo()
      .filter((resource) => !/TCP|Pipe|TTY/.test(resource));
    if (busy.length > 1 || requests) quietSince = Date.now();
    else if (Date.now() - quietSince > descriptor.idleMs) {
      const idle = { outcome: "idle", at: Date.now(), status: status() };
      if (!descriptor.keepOwner) finish(idle);
      // The owner stays alive: the test applies the operator's commands
      // through its control socket, then reads the next report.
      fs.writeSync(1, `${JSON.stringify(idle)}\n`);
      idleReported = true;
      quietSince = Date.now();
    }
  }, 50);
}

if (descriptor.mode === "run" || descriptor.mode === "trajectory") {
  try {
    const state = await application.runObjective(objective);
    const { code, message } = runOutcome(state);
    finish({
      outcome:
        code === EXIT_COMPLETE
          ? "complete"
          : code === EXIT_NEEDS_DECISION
            ? "needs-decision"
            : "failed-run",
      message,
      status: status(),
    });
  } catch (error) {
    finish({
      outcome: "stopped",
      message: String(error?.message ?? error),
      status: status(),
    });
  }
}
