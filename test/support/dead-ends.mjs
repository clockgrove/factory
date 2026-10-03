// The dead-end finder (#515): enumerate reachable continuation states, restart
// the real controller from each, and check that every non-terminal state has
// an exit — the restart progresses or completes, or it stops for a human
// decision whose named command continues the Objective.
//
// States come from two structural sources:
// - anchors: every distinct state shape Factory itself persists along a
//   scripted Objective (alpha → beta; alpha's result review and the final
//   review need a human, whose decisions the trajectory follows). At the first
//   snapshot of each shape the controller stops its process group and the
//   test copies that world: target checkout, origin, Factory state and the
//   GitHub fake's state;
// - overlays: values a snapshot can also hold at that point because a step can
//   fail or an operator can act at any time — a failed step by failure class
//   (recorded by Factory's own recordWorkFailure), an error outside any Work
//   Item step, cancel, pause, drain, a held phase reservation, an exhausted
//   interruption budget, a recorded subprocess, a closure error, repeat and
//   wait records, a stopped planning. The state validators prune invalid ones.
// Every anchor is checked as persisted, and anchor × overlay candidates are
// sampled so that every pair of values of the structural dimensions
// (`dimensionsOf`) that a valid candidate admits is covered.
//
// A world's absolute root is part of its identity (the configuration digest
// binds the checkout), so each trajectory is recorded once per slot and a
// slot's cases run one at a time in that slot's own root.
import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OBJECTIVE, workItem } from "./fault-harness.mjs";
import {
  GitHubHttpFake,
  gitTransportEnvironment,
} from "./github-http-fake.mjs";
import { createTarget, git, writeDescriptor } from "./integration-fixture.mjs";

const controller = join(import.meta.dirname, "dead-end-controller.mjs");
const fastTimers = join(import.meta.dirname, "fast-timers.mjs");
const repositoryRoot = join(import.meta.dirname, "..", "..");
const dist = (path) => join(repositoryRoot, "dist", path);
const errors = await import(dist("work-repair.js"));
const { Interruption } = await import(dist("contracts.js"));
const { parseFactoryState } = await import(dist("state.js"));
const { readContinuation } = await import(dist("state-store.js"));

const REPOSITORY = "example/dead-ends";
const ITEMS = [workItem("alpha"), workItem("beta", ["alpha"])];
const STATE = "state/clockgrove-factory/repositories/example/dead-ends";
const statePath = (root) => join(root, STATE, "objectives/1/state.json");

// ---- shapes and progress ---------------------------------------------------

/** The Work Item a shape details and overlays change: the first unfinished one. */
function focus(state) {
  const ids = state.graph.items.map((item) => item.id);
  return (
    ids.find((id) => !["done", "cancelled"].includes(state.work[id].status)) ??
    ids.at(-1)
  );
}

function itemShape(work) {
  const flags = [
    work.execution && "handle",
    work.pullRequest && "PR",
    work.acceptancePending && "pending criterion",
    work.recovery?.phase && `recovery ${work.recovery.phase}`,
    work.githubClosure && `closure ${work.githubClosure}`,
  ].filter(Boolean);
  return `${work.status}${work.step ? `/${work.step}` : ""}${flags.length ? ` (${flags.join(", ")})` : ""}`;
}

/**
 * A readable key for a state's shape: the focus item in detail, the other
 * items by status, and the Objective's flags. Anchors are the first snapshot
 * of each key.
 */
export function shapeKey(state) {
  if (state.schemaVersion === 7)
    return [
      "preparing",
      state.plan ? `plan ${state.plan.review?.status}` : "no plan",
      state.planningRecovery?.phase &&
        `planning ${state.planningRecovery.phase}`,
      `${Object.keys(state.issueByItemId).length} issues`,
      state.coordinator.phase,
    ]
      .filter(Boolean)
      .join(", ");
  const id = focus(state);
  const items = state.graph.items.map(({ id: other }) =>
    other === id
      ? `${id} ${itemShape(state.work[id])}`
      : `${other} ${state.work[other].status}`,
  );
  const objective = [
    state.error && "error",
    state.finalAcceptancePending && "pending final criterion",
    state.finalValidation && "final validation",
    state.objectiveClosure && `Objective closure ${state.objectiveClosure}`,
    state.githubClosureError && "closure error",
    state.cancelRequested && "cancel requested",
    state.cancelledAt && "cancelled",
    Object.keys(state.stackMerges ?? {}).length && "stack merge pending",
  ].filter(Boolean);
  return [...items, ...objective].join("; ");
}

const STEP_RANK = {
  execute: 1,
  "approve-asset": 2,
  validate: 3,
  "approve-result": 4,
  deliver: 5,
};

/** How far a Work Item has come; failed and cancelled items rank lowest. */
function rank(work) {
  switch (work.status) {
    case "pending":
      return 0;
    case "running":
    case "waiting":
      return (STEP_RANK[work.step] ?? 1) + (work.execution ? 0.5 : 0);
    case "published":
      return 6;
    case "done":
      return work.githubClosure === "complete" ? 8 : 7;
    default:
      return -1;
  }
}

/** The progress-relevant facts of a snapshot. */
export function fingerprint(state) {
  if (state.schemaVersion === 7)
    return {
      milestone:
        1 +
        (state.plan ? 1 : 0) +
        Object.keys(state.issueByItemId).length / 100,
      items: {},
    };
  return {
    milestone:
      10 +
      (state.finalValidation ? 1 : 0) +
      (state.objectiveClosure === "complete" ? 1 : 0),
    items: Object.fromEntries(
      Object.entries(state.work).map(([id, work]) => [id, rank(work)]),
    ),
  };
}

/** What moved forward from `before` to `after`, if anything. */
export function advanced(before, after) {
  if (after.milestone > before.milestone) return "the Objective advanced";
  for (const [id, value] of Object.entries(after.items))
    if (before.items[id] !== undefined && value > before.items[id])
      return `${id} advanced`;
  return undefined;
}

// ---- worlds ------------------------------------------------------------------

const liveRoots = new Set();
process.on("exit", () => {
  for (const root of liveRoots) rmSync(root, { recursive: true, force: true });
});
function temporary(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  liveRoots.add(root);
  return root;
}

const objectiveBody = () => {
  const commands = ITEMS.map((item) => item.validation[0].command);
  return `# Deterministic Objective\n\n## Acceptance\n${commands.map((c) => `- \`${c}\``).join("\n")}\n\n## Final validation\n${commands.map((c) => `- \`${c}\``).join("\n")}\n`;
};

function descriptorFor(root, delivery, baseSha) {
  return {
    // alpha's result review and the final Objective review need a human.
    needsHuman: ["alpha", "objective"],
    config: {
      schemaVersion: 1,
      repository: REPOSITORY,
      checkout: join(root, "target"),
      planning: {
        kind: "codex-sdk",
        planner: { model: "gpt-5.6-sol", reasoningEffort: "medium" },
        reviewer: { model: "gpt-5.6-sol", reasoningEffort: "medium" },
      },
      execution: {
        kind: "local",
        concurrency: 2,
        harness: { kind: "registered", adapter: "scripted-test@1", config: {} },
      },
      delivery: { kind: delivery },
      contentStore: { kind: "local" },
      policy: { network: "off", allowedSecretNames: [], deployments: "denied" },
    },
    graph: { objective: OBJECTIVE, baseSha, items: ITEMS },
    fakeRoot: join(root, "fake"),
    actions: Object.fromEntries(
      ITEMS.map((item) => [
        item.id,
        { files: [{ path: `${item.id}.txt`, text: `${item.id}\n` }] },
      ]),
    ),
  };
}

/** A started fake that counts the requests it is still serving. */
async function startFake(origin, state) {
  const fake = new GitHubHttpFake({
    repository: REPOSITORY,
    origin,
    issues: [{ title: "Deterministic Objective", body: objectiveBody() }],
  });
  if (state) fake.state = structuredClone(state);
  fake.inFlight = 0;
  const handle = fake.handle.bind(fake);
  fake.handle = async (...args) => {
    fake.inFlight++;
    try {
      return await handle(...args);
    } finally {
      fake.inFlight--;
    }
  };
  return fake.start();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function processState(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
  } catch {
    return undefined;
  }
}

/** Copy a world, leaving out sockets (a crashed controller's are stale). */
const copyWorld = (from, to) =>
  cpSync(from, to, {
    recursive: true,
    filter: (source) => !lstatSync(source).isSocket(),
  });

/**
 * Start one controller process in `world` ({root, fake, descriptor}) with
 * `extra` descriptor fields. `onLine(message, child)` sees every JSON line;
 * resolves to the last one.
 */
let descriptors = 0;
function controllerProcess(world, extra, onLine, timeoutMs = 120_000) {
  const path = join(world.root, `descriptor-${descriptors++}.json`);
  writeDescriptor(path, {
    ...world.descriptor,
    apiUrl: world.fake.apiUrl,
    ...extra,
  });
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["--import", fastTimers, controller, path],
      {
        env: {
          ...process.env,
          ...gitTransportEnvironment(world.fake.gitUrl),
          XDG_STATE_HOME: join(world.root, "state"),
          FACTORY_TEST_TIME_SCALE: "0.01",
        },
        cwd: repositoryRoot,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let buffer = "";
    let stderr = "";
    let last;
    let timedOut = false;
    let pending = Promise.resolve();
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }, timeoutMs);
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      for (
        let newline = buffer.indexOf("\n");
        newline >= 0;
        newline = buffer.indexOf("\n")
      ) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          last = JSON.parse(line);
        } catch {
          continue;
        }
        const message = last;
        if (onLine) pending = pending.then(() => onLine(message, child));
      }
    });
    child.on("close", async () => {
      clearTimeout(timer);
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
      await pending;
      resolve(
        timedOut
          ? { outcome: "hung", stderr: stderr.slice(-1000) }
          : (last ?? { outcome: "crashed", stderr: stderr.slice(-1000) }),
      );
    });
  });
}

// ---- trajectories --------------------------------------------------------------

const DECISIONS = new Set(["decide-result", "decide"]);

/**
 * Run the scripted Objective in a fresh root and capture the first snapshot
 * of every state shape, following the operator's decisions until it
 * completes. Returns the slot: its root and anchors.
 */
async function recordTrajectory(delivery) {
  const root = temporary("fde-");
  const store = temporary("fde-anchors-");
  const target = createTarget(root);
  git(
    target.checkout,
    "remote",
    "set-url",
    "origin",
    `https://github.com/${REPOSITORY}.git`,
  );
  const fake = await startFake(target.origin);
  const world = {
    root,
    fake,
    descriptor: descriptorFor(root, delivery, target.baseSha),
  };
  const anchors = [];
  const seen = [];
  const capture = async (message, child) => {
    if (!message.anchor) return;
    seen.push(message.anchor);
    for (let state; (state = processState(child.pid)) !== "T"; await sleep(2))
      if (!state) return;
    // Requests already sent finish; a stopped client's never will.
    for (let wait = 0; fake.inFlight && wait < 100; wait++) await sleep(2);
    const dir = join(store, String(anchors.length));
    copyWorld(root, dir);
    anchors.push({
      key: message.anchor,
      delivery,
      dir,
      fakeState: structuredClone(fake.state),
      state: JSON.parse(readFileSync(statePath(dir), "utf8")),
    });
    process.kill(-child.pid, "SIGCONT");
  };
  try {
    for (let run = 0; ; run++) {
      const report = await controllerProcess(
        world,
        { mode: "trajectory", seen },
        capture,
        180_000,
      );
      if (report.outcome === "complete") break;
      const command = report.status?.nextAction
        ? operatorCommand(report.status.nextAction.command)
        : {};
      if (run >= 6 || !DECISIONS.has(command.verb))
        throw new Error(
          `${delivery} trajectory stopped: ${JSON.stringify(report)}`,
        );
      const applied = await controllerProcess(world, {
        mode: "command",
        command,
      });
      if (!applied.ok)
        throw new Error(`${delivery} trajectory decision: ${applied.message}`);
    }
    return { delivery, root, descriptor: world.descriptor, anchors };
  } finally {
    await fake.stop();
  }
}

// ---- overlays --------------------------------------------------------------------

const active = (work) =>
  ["running", "published", "waiting"].includes(work.status);

/**
 * A step of the focus item fails with `error` as the runner records it: the
 * item fails (keeping step, handle and PR), recordWorkFailure classifies the
 * failure, and a failure that is not isolated also stops the Objective.
 */
const failStep = (make, steps) => (state) => {
  if (state.schemaVersion !== 6) return false;
  const id = focus(state);
  const work = state.work[id];
  if (!active(work) || (steps && !steps.includes(work.step))) return false;
  const error = make();
  work.status = "failed";
  work.error = error.message;
  delete work.authentication;
  if (work.phaseReservation !== "coding") delete work.phaseReservation;
  if (!errors.recordWorkFailure(state, id, error)) state.error = error.message;
  return true;
};

const coordinator = (state) =>
  (state.coordinator ??= {
    mode: "running",
    phase: "idle",
    phaseStartedAt: new Date().toISOString(),
  });

const reserve = (phase) => (state) => {
  if (state.schemaVersion !== 6) return false;
  const work = state.work[focus(state)];
  if ((!active(work) && work.status !== "failed") || work.phaseReservation)
    return false;
  work.phaseReservation = phase;
  return true;
};

/** Overlay dimensions; each value mutates a state and says if it applies. */
const OVERLAYS = {
  "item event": {
    "a step fails with an unclassified error": failStep(
      () => new Error("Injected step failure"),
    ),
    "a step exhausts its interruptions": failStep(
      () => new Interruption(new Error("socket hang up")),
    ),
    // Validation and settled-worker failures come only from their own step.
    "validation fails": failStep(
      () =>
        new errors.CandidateValidationFailure("Injected validation failure"),
      ["validate"],
    ),
    "the validation environment fails": failStep(
      () =>
        new errors.CandidateEnvironmentFailure("Injected environment failure"),
      ["validate"],
    ),
    "the worker settles without a result": failStep(
      () =>
        new errors.SettledAttemptFailure(
          new Error("Injected settled failure"),
          "implementation",
        ),
      ["execute"],
    ),
  },
  "Objective event": {
    "an error stops the Objective outside any Work Item step": (state) => {
      if (state.schemaVersion !== 6 || state.error) return false;
      state.error = "Injected stop outside a Work Item step";
      return true;
    },
    "cancel was requested": (state) => {
      if (state.cancelRequested || state.cancelledAt) return false;
      state.cancelRequested = true;
      coordinator(state).waitReason = "Verifying owned work cessation";
      return true;
    },
    "cancellation is unresolved": (state) => {
      if (state.cancelledAt) return false;
      state.cancelRequested = true;
      coordinator(state).cancelError = "Injected unresolved cessation";
      coordinator(state).waitReason =
        "Cancellation unresolved; operator direction required";
      return true;
    },
    paused: (state) => {
      coordinator(state).mode = "paused";
      return true;
    },
    draining: (state) => {
      coordinator(state).mode = "draining";
      return true;
    },
    "GitHub observation failed": (state) => {
      Object.assign(coordinator(state), {
        mode: "paused",
        observationError: "Exact Objective observation unavailable",
        waitReason:
          "GitHub API unavailable; resume to observe again or cancel locally",
      });
      return true;
    },
    // Closure of the focus item or the Objective was under way.
    "GitHub closure failed": (state) => {
      if (
        state.schemaVersion !== 6 ||
        state.githubClosureError ||
        (state.work[focus(state)].githubClosure !== "pending" &&
          state.objectiveClosure !== "pending")
      )
        return false;
      state.githubClosureError = "Injected GitHub closure failure";
      return true;
    },
  },
  "phase reservation": {
    "coding phase reserved": reserve("coding"),
    "validation phase reserved": reserve("validation"),
    "review phase reserved": reserve("review"),
    "delivery phase reserved": reserve("delivery"),
  },
  record: {
    "interruptions exhausted": (state) => {
      if (state.schemaVersion !== 6) return false;
      const work = state.work[focus(state)];
      if (!["running", "published"].includes(work.status) || work.interruptions)
        return false;
      work.interruptions = 2;
      work.waitingReason = "Interrupted (2/2), repeating: socket hang up";
      return true;
    },
    "a subprocess was recorded": (state) => {
      // Above the kernel's largest pid_max (2^22), so it never exists.
      coordinator(state).processes = [{ pid: 4_194_305, startTime: "0" }];
      return true;
    },
    "a repeat record is pending": (state) => {
      const id = state.schemaVersion === 6 ? focus(state) : undefined;
      const work = id && state.work[id];
      const key =
        work?.attempt && work.step
          ? `${id}/${work.attempt}/${work.step}`
          : "objective/run";
      state.repeats = {
        [key]: {
          since: new Date().toISOString(),
          count: 1,
          last: {
            kind: "transient",
            detail: "socket hang up",
            outcomeUnknown: true,
          },
          nextAt: new Date(Date.now() + 60_000).toISOString(),
        },
      };
      return true;
    },
    "a wait is recorded": (state) => {
      state.wait = { kind: "outage", detail: "GitHub unavailable" };
      if (state.schemaVersion === 6)
        state.work[focus(state)].wait = {
          kind: "ci",
          detail: "checks pending",
        };
      return true;
    },
    "planning stopped": (state) => {
      if (state.schemaVersion !== 7 || state.plan) return false;
      state.planningRecovery = {
        ...(state.planningRecovery ?? { history: [] }),
        phase: "stopped",
      };
      coordinator(state).waitReason =
        "Planning stopped for a decision: injected planning stop";
      return true;
    },
  },
};

/** Apply overlay values ({dimension: value}) to a copy of a state. */
function applyOverlays(state, values) {
  const copy = structuredClone(state);
  for (const [dimension, value] of Object.entries(values))
    if (!OVERLAYS[dimension][value](copy)) return undefined;
  return copy;
}

/** Whether Factory's own validators accept a snapshot. */
function validSnapshot(state) {
  try {
    if (state.schemaVersion === 6) {
      parseFactoryState(state, REPOSITORY, OBJECTIVE);
      return true;
    }
    // readContinuation's preparation checks, against a scratch state root.
    const root = temporary("fde-validate-");
    const path = join(root, STATE.replace(/^state\//, ""), "objectives/1");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "state.json"), JSON.stringify(state));
    const previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = root;
    try {
      readContinuation(REPOSITORY, OBJECTIVE);
    } finally {
      process.env.XDG_STATE_HOME = previous;
      rmSync(root, { recursive: true, force: true });
      liveRoots.delete(root);
    }
    return true;
  } catch {
    return false;
  }
}

// ---- dimensions and sampling --------------------------------------------------------

/**
 * The structural dimensions of a snapshot, read from the state itself:
 * `paired` dimensions are covered pairwise, `single` ones value by value.
 */
function dimensionsOf(state) {
  const coordinator = state.coordinator ?? {};
  const shared = {
    "coordinator mode": coordinator.mode ?? "none",
    cancel: state.cancelledAt
      ? "cancelled"
      : coordinator.cancelError
        ? "unresolved"
        : state.cancelRequested
          ? "requested"
          : "none",
  };
  const single = {
    "observation error": Boolean(coordinator.observationError),
    "recorded subprocess": Boolean(coordinator.processes?.length),
    "repeat or wait record": Boolean(state.repeats || state.wait),
  };
  if (state.schemaVersion === 7)
    return {
      paired: {
        ...shared,
        plan: state.plan ? state.plan.review.status : "none",
        "planning recovery": state.planningRecovery?.phase ?? "none",
        projection: `${Object.keys(state.issueByItemId).length} issues`,
      },
      single,
    };
  const work = state.work[focus(state)];
  return {
    paired: {
      ...shared,
      "item status": work.status,
      "item step": work.step ?? "none",
      "execution handle": Boolean(work.execution),
      "pull request": Boolean(work.pullRequest),
      recovery: work.recovery?.phase
        ? `${work.recovery.phase} ${work.recovery.failure?.classification ?? ""}`.trim()
        : "none",
      "pending criterion": Boolean(work.acceptancePending),
      "phase reservation": work.phaseReservation ?? "none",
      "interruptions exhausted": (work.interruptions ?? 0) >= 2,
      "Objective error": Boolean(state.error),
      "final stage": state.objectiveClosure
        ? `closure ${state.objectiveClosure}`
        : state.finalValidation
          ? "validated"
          : state.finalAcceptancePending
            ? "pending criterion"
            : "none",
      "closure error": Boolean(state.githubClosureError),
    },
    single,
  };
}

/** What a snapshot covers: its paired dimension values and its single values. */
function coverageOf(state) {
  const { paired, single } = dimensionsOf(state);
  const entries = Object.entries(paired).map(
    ([name, value]) => `${name}=${value}`,
  );
  const covers = Object.entries({ ...paired, ...single }).map(
    ([name, value]) => `${name}=${value}`,
  );
  for (let i = 0; i < entries.length; i++)
    for (let j = i + 1; j < entries.length; j++)
      covers.push(`${entries[i]} & ${entries[j]}`);
  return covers;
}

/** Overlay combinations with at most two values, `{}` first. */
function overlayCombinations() {
  const singles = Object.entries(OVERLAYS).flatMap(([dimension, values]) =>
    Object.keys(values).map((value) => [dimension, value]),
  );
  const combinations = [{}];
  for (const [dimension, value] of singles)
    combinations.push({ [dimension]: value });
  for (let i = 0; i < singles.length; i++)
    for (let j = i + 1; j < singles.length; j++)
      if (singles[i][0] !== singles[j][0])
        combinations.push({
          [singles[i][0]]: singles[i][1],
          [singles[j][0]]: singles[j][1],
        });
  return combinations;
}

const caseName = (anchor, values) =>
  `${anchor.delivery}: ${anchor.key}${Object.values(values)
    .map((value) => ` + ${value}`)
    .join("")}`;

/**
 * The cases to check: every anchor as persisted, then anchor × overlay
 * candidates chosen greedily until every value pair of the paired dimensions,
 * and every value of each dimension, that some valid candidate admits is
 * covered. Deterministic for the same anchors.
 */
function enumerateCases(anchors) {
  const candidates = [];
  for (const anchor of anchors)
    for (const values of overlayCombinations()) {
      const state = applyOverlays(anchor.state, values);
      if (!state) continue;
      candidates.push({
        anchor,
        values,
        state,
        pairs: coverageOf(state),
      });
    }
  const covered = new Set();
  const cases = [];
  const take = (candidate) => {
    for (const pair of candidate.pairs) covered.add(pair);
    cases.push({
      name: caseName(candidate.anchor, candidate.values),
      anchor: candidate.anchor,
      values: candidate.values,
      state: candidate.state,
    });
  };
  // Every persisted shape as persisted, valid or not: a snapshot Factory
  // wrote but its own validator rejects is a dead end too.
  for (const candidate of candidates)
    if (!Object.keys(candidate.values).length) take(candidate);
  // Lazy greedy pair cover over the overlaid candidates.
  const gain = (candidate) =>
    candidate.pairs.reduce((sum, pair) => sum + (covered.has(pair) ? 0 : 1), 0);
  const queue = candidates
    .filter((candidate) => Object.keys(candidate.values).length)
    .map((candidate, index) => ({ candidate, index, gain: gain(candidate) }));
  const better = (a, b) => b.gain - a.gain || a.index - b.index;
  queue.sort(better);
  while (queue.length) {
    const head = queue[0];
    const current = gain(head.candidate);
    if (current < head.gain) {
      head.gain = current;
      queue.sort(better);
      continue;
    }
    if (current === 0) break;
    queue.shift();
    if (validSnapshot(structuredClone(head.candidate.state)))
      take(head.candidate);
  }
  return cases;
}

// ---- running and classifying a case ------------------------------------------------

/** Parse a status next action into an operator command. */
function operatorCommand(text) {
  const words = text.match(/"[^"]*"|\S+/g) ?? [];
  if (words[0] !== "factory") return { external: text };
  const options = {};
  for (let index = 2; index < words.length; index++)
    if (words[index].startsWith("--"))
      options[words[index].slice(2)] = words[index + 1]?.replace(/^"|"$/g, "");
  return { verb: words[1], options };
}

const INSPECTION = new Set(["diagnostics", "logs", "status", "review"]);
/** How a stop reads to the operator, to tell two stops apart. */
const stopOf = (report) =>
  JSON.stringify([
    report.status?.phase,
    report.status?.nextAction?.command,
    report.status?.pending,
  ]);

/** Operator commands followed from one state before it counts as stranded. */
const MAX_COMMANDS = 4;

/**
 * Restart the controller from `state` in a copy of the anchor's world (in
 * `slot`'s root) and classify the outcome:
 * - complete / progressed: the restart finished, or moved a Work Item or the
 *   Objective forward on its own;
 * - terminal: the Objective is cancelled, as requested;
 * - decision: it stopped, and following the commands the status names (each
 *   then `factory run`) continues the Objective;
 * - rerun: the status names only `factory run`, and rerunning continues;
 * - config: it waits for a named fix outside Factory;
 * - stranded: anything else — no command, an inspection-only command, a
 *   refused command, a command after which the same stop repeats, a hang.
 */
async function classify(slot, anchor, state) {
  rmSync(slot.root, { recursive: true, force: true });
  copyWorld(anchor.dir, slot.root);
  // The stopped controller's lock names a process that is gone.
  rmSync(join(slot.root, STATE, "controller.lock"), { force: true });
  writeFileSync(statePath(slot.root), `${JSON.stringify(state, null, 2)}\n`);
  const fake = await startFake(join(slot.root, "origin.git"), anchor.fakeState);
  const world = { root: slot.root, fake, descriptor: slot.descriptor };
  const trace = [];
  // A refused plan discards the preparation; the next run plans again.
  const current = () =>
    existsSync(statePath(slot.root))
      ? fingerprint(JSON.parse(readFileSync(statePath(slot.root), "utf8")))
      : { milestone: 0, items: {} };
  const run = async () => {
    const report = await controllerProcess(world, {
      mode: "run",
      baseline: current(),
      idleMs: 300,
    });
    trace.push(
      `run: ${report.outcome}${report.step ? ` (${report.step})` : ""}${report.message ? `: ${report.message.split("\n")[0]}` : ""} → ${report.status?.phase ?? "?"}: ${report.status?.nextAction?.command ?? "no next command"}`,
    );
    return report;
  };
  const result = (kind, reason) => ({ kind, reason, trace });
  try {
    const stops = new Map();
    let followed;
    for (let report = await run(); ; report = await run()) {
      const continued = followed?.verb === "run" ? "rerun" : "decision";
      if (report.outcome === "complete" || report.status?.phase === "complete")
        return result(followed ? continued : "complete");
      if (report.outcome === "progressed")
        return result(followed ? continued : "progressed", report.step);
      if (["hung", "crashed"].includes(report.outcome))
        return result("stranded", `the restart ${report.outcome}`);
      if (report.status?.unreadable)
        return result(
          "stranded",
          `unreadable state: ${report.status.unreadable}`,
        );
      if (report.status?.phase === "cancelled")
        return followed || state.cancelRequested
          ? result("terminal")
          : result("stranded", "cancelled without a request");
      const why = `${report.outcome}: ${report.message?.split("\n")[0] ?? report.status?.summary ?? ""}`;
      const stop = stopOf(report);
      if (stops.has(stop))
        return result(
          "stranded",
          `factory ${followed.verb} does not continue after ${stops.get(stop)}`,
        );
      stops.set(stop, why);
      const action = report.status?.nextAction;
      if (!action) return result("stranded", `no next command after ${why}`);
      const command = operatorCommand(action.command);
      if (command.external) return result("config", action.command);
      if (INSPECTION.has(command.verb))
        return result(
          "stranded",
          `only inspection (factory ${command.verb}) after ${why}`,
        );
      if (command.verb === "propose-amendment")
        return result("decision", "propose-amendment (not exercised)");
      if (stops.size > MAX_COMMANDS)
        return result("stranded", `commands do not converge after ${why}`);
      followed = command;
      if (command.verb === "run") continue;
      const applied = await controllerProcess(world, {
        mode: "command",
        command,
      });
      trace.push(
        `factory ${command.verb}: ${applied.ok ? "applied" : `refused: ${applied.message}`}`,
      );
      if (!applied.ok)
        return result(
          "stranded",
          `factory ${command.verb} is refused (${applied.message}) after ${why}`,
        );
      if (applied.status?.phase === "cancelled") return result("terminal");
    }
  } finally {
    await fake.stop();
  }
}

/**
 * Record `slots` trajectories per delivery strategy, enumerate the cases from
 * the first slot's anchors, and return a scheduler that runs each case in a
 * slot holding its anchor, one case per slot at a time.
 */
export async function prepare({ deliveries, slots }) {
  const recorded = await Promise.all(
    deliveries.flatMap((delivery) =>
      Array.from({ length: slots }, () => recordTrajectory(delivery)),
    ),
  );
  const cases = deliveries.flatMap((delivery) =>
    enumerateCases(recorded.find((slot) => slot.delivery === delivery).anchors),
  );
  const queues = new Map(recorded.map((slot) => [slot, Promise.resolve()]));
  const load = new Map(recorded.map((slot) => [slot, 0]));
  // A case runs in the least loaded slot whose own copy of the anchor yields
  // the same state shape and progress with the same overlays (the slot it
  // was enumerated from always does).
  const schedule = (testCase) => {
    const choices = recorded.flatMap((slot) => {
      if (slot.delivery !== testCase.anchor.delivery) return [];
      const anchor = slot.anchors.find(
        (candidate) => candidate.key === testCase.anchor.key,
      );
      if (anchor === testCase.anchor)
        return [{ slot, anchor, state: testCase.state }];
      const state = anchor && applyOverlays(anchor.state, testCase.values);
      const same = (value) =>
        shapeKey(value) + JSON.stringify(fingerprint(value));
      return state && same(state) === same(testCase.state)
        ? [{ slot, anchor, state }]
        : [];
    });
    const { slot, anchor, state } = choices.sort(
      (a, b) => load.get(a.slot) - load.get(b.slot),
    )[0];
    load.set(slot, load.get(slot) + 1);
    const run = queues.get(slot).then(() => classify(slot, anchor, state));
    queues.set(
      slot,
      run.catch(() => undefined),
    );
    return run;
  };
  return { cases, schedule, slots: recorded };
}
