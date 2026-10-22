// Isolated even when run with a bare `node --test`, not only via npm test.
import "./isolate-env.mjs";
// Objective lifecycle conformance (#1714): state × owner × command → the
// outcome or stable refusal code. docs/LIFECYCLE.md holds the matrix and its
// three invariants. A cell that encodes a known gap asserts the target
// behaviour and is marked `todo` with the invariant it breaks; the fix that
// closes the gap makes it pass, and then drops the marker.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { planningSessionInputDigest } from "../dist/agent-session.js";
import { sealFinalAcceptance } from "../dist/completion.js";
import { CodexPlanningModel } from "../dist/compiler/model.js";
import {
  factoryConfigDigest,
  stateRoot,
  validateConfig,
} from "../dist/config.js";
import { LocalContentStore } from "../dist/content/local.js";
import {
  CONTROL_ACTIONS,
  requestControl,
} from "../dist/coordinator-control.js";
import { RegularDelivery } from "../dist/delivery/regular.js";
import { continuationStatusDocument } from "../dist/diagnostics.js";
import { CodexHarness, LocalExecutionDriver } from "../dist/execution/local.js";
import { graphDigest } from "../dist/graph-amendments.js";
import {
  FIELD_BINDING,
  INSPECT,
  ITEMS,
} from "../dist/github-project-queue-wire.js";
import {
  projectQueueReadOnGitHub,
  resolveProjectQueuePlannedEffect,
} from "../dist/github-project-queue.js";
import {
  enqueueIntake,
  foregroundQueueControl,
  intakeControl,
  runIntake,
  watchIntake,
} from "../dist/intake.js";
import { LIFECYCLE_CODES, lifecycleCode } from "../dist/lifecycle-refusal.js";
import {
  queueDigest,
  refuseUnadmittedRun,
} from "../dist/project-queue-state.js";
import { resolveAutonomy } from "../dist/repair-policy.js";
import {
  cancelObjective,
  controlObjective,
  decideObjective,
  repairWorkItem,
  rereviewWorkItem,
  retryWorkItem,
  runObjective,
} from "../dist/runner.js";
import {
  objectiveRoot,
  readContinuation,
  saveState,
  statePath,
} from "../dist/state-store.js";
import { STATUS_PHASES } from "../dist/status-summary.js";
import { checkServiceState, drainForUpgrade } from "../dist/supervision.js";
import { validateWorkItem } from "../dist/validation.js";

const BODY =
  "## Outcome\nVerify the unchanged fixture.\n\n## Acceptance\n- git diff is clean.\n\n## Validation\ngit diff --exit-code\n";
const OWNER = process.env.FACTORY_LIFECYCLE_OWNER;

// ---------------------------------------------------------------------------
// Commands, as the CLI routes them: a live owner's endpoint first, then the
// application function. `upgrade` is the multi-slot upgrade drain, `start`
// the service start check.
// ---------------------------------------------------------------------------
const COMMANDS = [
  "run",
  "retry",
  "rereview",
  "repair",
  "decide",
  "cancel",
  "pause",
  "drain",
  "resume",
  "queue-add",
  "queue-remove",
  "upgrade",
  "start",
];
/** The control action each command sends, if any. */
const COMMAND_ACTION = {
  retry: "retry",
  rereview: "rereview",
  repair: "repair",
  decide: "decide",
  cancel: "cancel",
  pause: "pause",
  drain: "drain",
  resume: "resume",
  "queue-add": "enqueue",
  "queue-remove": "dequeue",
  upgrade: "finish",
};
/** Control actions that are not operator lifecycle commands, with why. */
const NOT_LIFECYCLE = {
  status: "read-only",
  readiness: "read-only",
  handoff: "service-internal; reached through drain and upgrade",
  select: "an asset choice inside a waiting Work Item",
  "propose-amendment": "a graph change, not a lifecycle transition",
  "decline-discovery": "a graph change, not a lifecycle transition",
  watch: "queue authorization, not an Objective transition",
  "project-queue": "the transport of queue-add and queue-remove",
};

// ---------------------------------------------------------------------------
// The matrix: one row per lifecycle state, `phase` the status phase the built
// state reports. A cell is the expected outcome:
//   "ok"       the command passes every lifecycle check
//   "waits"    the upgrade drain returns, waiting on this Objective
//   "invalid"  a refusal of the command's own input or state, outside the
//              lifecycle (no code)
//   a code     the stable LifecycleRefusal code
//   gap(...)   a known gap: the target outcome, marked todo with the
//              invariant it breaks
// A command left out of a row is not meaningful there ("—" in the matrix).
// Owners: "none" (no live controller), "foreground" (a live paused
// `factory run`), "service" (a live service not running this Objective).
// ---------------------------------------------------------------------------
const A = "invariant (a): every non-terminal state has an operator exit";
const B =
  "invariant (b): upgrade never blocks on an Objective that is not executing";
const C = "invariant (c): no housekeeping on the operator path";
const gap = (want, invariant) => ({ want, todo: invariant });
/** A live service refuses control of an Objective it is not running (gap 1). */
const notOwned = (want) => gap(want, A);
const ROWS = [
  {
    name: "queued, no state",
    phase: "not-started",
    build: () => undefined,
    none: {
      run: "ok",
      retry: "no_factory_state",
      decide: "no_factory_state",
      cancel: "no_factory_state",
      pause: "no_factory_state",
      "queue-add": "ok",
      "queue-remove": "ok",
      upgrade: "ok",
      start: "ok",
    },
    service: {
      run: "controller_owned",
      retry: notOwned("no_factory_state"),
      cancel: "no_factory_state",
      upgrade: "ok",
    },
  },
  {
    name: "planning, owner gone",
    phase: "planning",
    build: preparationState,
    none: {
      run: "ok",
      decide: "ok",
      cancel: "ok",
      pause: "ok",
      resume: "ok",
      "queue-remove": "unfinished_owned_work",
      upgrade: "ok",
    },
    service: {
      decide: "ok",
      cancel: "ok",
      pause: notOwned("ok"),
      resume: notOwned("ok"),
    },
  },
  {
    name: "plan decision",
    phase: "needs-plan-decision",
    build: with_(preparationState, (state) => {
      state.planningRecovery = { phase: "stopped", history: [] };
      state.coordinator.waitReason =
        "Planning stopped for a decision: answer the question";
    }),
    none: { run: "ok", decide: "ok", cancel: "ok", resume: "ok" },
    service: { decide: "ok", cancel: "ok", resume: notOwned("ok") },
  },
  {
    name: "plan decision, paused owner",
    phase: "waiting",
    build: with_(preparationState, (state) => {
      state.planningRecovery = { phase: "stopped", history: [] };
      state.coordinator.mode = "paused";
    }),
    // Refusing the plan needs the live owner stopped first (gap 8).
    foreground: { decide: gap("ok", A), cancel: "ok", upgrade: gap("ok", B) },
  },
  {
    name: "items running, owner gone",
    phase: "running",
    build: with_(executionState, (state, fixture) => {
      state.work.local = {
        status: "running",
        step: "execute",
        attempt: randomUUID(),
        baseSha: fixture.baseSha,
      };
    }),
    none: {
      run: "ok",
      retry: "finish_or_cancel_active",
      cancel: "ok",
      pause: "ok",
      "queue-remove": "unfinished_owned_work",
    },
    service: {
      retry: notOwned("finish_or_cancel_active"),
      cancel: "ok",
    },
  },
  {
    name: "failed",
    phase: "failed",
    build: with_(executionState, (state, fixture) => {
      state.work.local = {
        status: "failed",
        step: "execute",
        baseSha: fixture.baseSha,
        error: "fixture failure",
      };
      state.error = "fixture failure";
      state.errorItem = "local";
    }),
    none: {
      run: "ok",
      retry: "ok",
      cancel: "ok",
      "queue-remove": "unfinished_owned_work",
    },
    service: { retry: notOwned("ok"), cancel: "ok", resume: notOwned("ok") },
  },
  {
    name: "cancel unresolved",
    phase: "needs-decision",
    build: with_(executionState, (state) => {
      state.cancelRequested = true;
      state.coordinator.cancelError = "fixture cessation unresolved";
    }),
    none: { run: "ok", retry: "cancel_unresolved", cancel: "ok" },
    service: { retry: notOwned("cancel_unresolved"), cancel: "ok" },
  },
  {
    name: "diagnosis held by planning",
    phase: "failed",
    build: with_(executionState, (state, fixture) => {
      const id = randomUUID();
      state.work.local = {
        status: "failed",
        step: "execute",
        baseSha: fixture.baseSha,
        error: "fixture failure",
        recovery: {
          diagnosisInvocation: {
            id,
            submitted: true,
            requestDigest: "a".repeat(64),
          },
        },
      };
      const scope = {
        repository: state.repository,
        objective: state.objective,
        runId: state.runId,
        configDigest: state.configDigest,
        role: "planning",
      };
      state.sourcePacketDigest =
        state.approvedPlaybookAdmission.sourcePacketDigest;
      scope.planningInputDigest = planningSessionInputDigest(state);
      state.agentSessions = {
        [JSON.stringify(["planning", null, scope.planningInputDigest])]: {
          scope,
          adapter: "codex",
          identity: randomUUID(),
          turn: 1,
          currentTurn: {
            invocationId: id,
            requestDigest: "a".repeat(64),
            dispatch: "submitted",
            resources: "active",
          },
          status: "in-flight",
        },
      };
    }),
    none: { retry: "diagnosis_held", cancel: gap("ok", A), pause: "ok" },
    service: { cancel: gap("ok", A) },
  },
  {
    name: "operator-paused",
    phase: "waiting",
    build: with_(executionState, (state) => {
      state.coordinator.mode = "paused";
    }),
    none: {
      run: "ok",
      cancel: "ok",
      pause: "ok",
      drain: "ok",
      resume: "ok",
      upgrade: "ok",
    },
    foreground: {
      run: "controller_owned",
      cancel: "ok",
      pause: "ok",
      resume: "ok",
      "queue-remove": "unfinished_owned_work",
      upgrade: gap("ok", B),
    },
    service: { pause: notOwned("ok"), resume: notOwned("ok"), cancel: "ok" },
  },
  {
    name: "drained",
    phase: "waiting",
    build: with_(executionState, (state) => {
      state.coordinator.mode = "draining";
    }),
    none: { run: "coordinator_draining", resume: "ok", cancel: "ok" },
    service: { resume: notOwned("ok"), cancel: "ok" },
  },
  {
    name: "rejection hold",
    phase: "needs-decision",
    build: with_(executionState, (state) => {
      state.coordinator.mode = "paused";
      const evidence = ["README.md"];
      state.pendingAmendment = {
        id: randomUUID(),
        proposal: {
          scope: "in-scope",
          reason: "Restore",
          evidence,
          ownership: evidence,
          acceptance: evidence,
          dependencies: [],
          actor: "operator",
          expectedGraphDigest: state.planGraphDigest,
        },
        phase: "rejected",
        rejectionStage: "decision",
        error: "Refused",
        issueByItemId: { local: 2 },
      };
    }),
    none: {
      run: "ok",
      retry: "rejection_hold",
      repair: "rejection_hold",
      drain: "rejection_hold",
      resume: "rejection_hold",
      cancel: "ok",
    },
    service: { resume: notOwned("rejection_hold"), cancel: "ok" },
  },
  {
    name: "acceptance sealed",
    phase: "waiting",
    build: completedState,
    none: {
      run: "ok",
      retry: "objective_complete",
      cancel: "acceptance_sealed",
      pause: "ok",
    },
    service: { cancel: "acceptance_sealed" },
  },
  {
    name: "restored, held",
    phase: "running",
    build: with_(executionState, (state, fixture) => {
      const bytes = Buffer.from(JSON.stringify(state));
      const snapshot = {
        digest: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
        mediaType: "application/json",
      };
      const layout = {
        configDigest: state.configDigest,
        authorityDigest: "f".repeat(64),
        checkout: fixture.config.checkout,
        stateRoot: stateRoot(fixture.config.repository),
      };
      state.schemaVersion = 19;
      state.restoration = {
        schemaVersion: 1,
        checkpoint: {
          commitSha: fixture.baseSha,
          payloadDigest: snapshot.digest,
        },
        archive: snapshot,
        original: {
          snapshot,
          configDigest: state.configDigest,
          schemaVersion: 7,
        },
        source: layout,
        installation: { ...layout, identity: "restored-fixture-owner" },
        status: "held",
        reason: "Foreign source ownership remains unresolved",
      };
    }),
    none: {
      run: "restoration_held",
      retry: "restoration_held",
      cancel: gap("ok", A),
      start: "restoration_held",
    },
    service: { cancel: gap("ok", A) },
  },
  {
    name: "configuration changed",
    phase: "running",
    build: with_(executionState, (state) => {
      state.configDigest = "f".repeat(64);
      state.approvedPlaybookAdmission.configDigest = state.configDigest;
    }),
    none: {
      run: "config_frozen",
      rereview: "config_frozen",
      repair: "config_frozen",
      cancel: "ok",
      start: "config_frozen",
    },
    service: { cancel: "ok", resume: notOwned("ok") },
  },
  {
    name: "cancelled",
    phase: "cancelled",
    build: with_(executionState, (state) => {
      state.cancelRequested = true;
      state.cancelledAt = new Date().toISOString();
    }),
    none: { run: "ok", cancel: "ok", "queue-remove": "ok", "queue-add": "ok" },
    service: { cancel: "ok" },
  },
  {
    name: "complete",
    phase: "complete",
    build: with_(completedState, (state) => {
      state.objectiveClosure = "complete";
    }),
    none: {
      run: "ok",
      retry: "objective_complete",
      cancel: "ok",
      "queue-remove": "ok",
    },
    service: { cancel: "ok" },
  },
  {
    name: "complete, card archived",
    phase: "complete",
    build: with_(completedState, (state) => {
      state.objectiveClosure = "complete";
    }),
    // Removal archived the card; adding it again re-admits it against this
    // Project fixture. Gap 7 (an archived card refused) needs the real
    // Project's archived-item response to reproduce.
    archive: true,
    none: { "queue-add": "ok" },
  },
];

/**
 * Rows that need the service actively running the Objective: planning,
 * executing, waiting on CI or settling. Their cells are not built yet; each
 * names the outcome it pins once a live-run owner exists.
 */
const LIVE_RUN_ROWS = [
  {
    name: "planning under a live service run",
    phase: "planning",
    pins: "upgrade hands the run off instead of waiting for it",
    todo: B,
  },
  {
    name: "items running under a live service run",
    phase: "running",
    pins: "retry refuses with finish_or_cancel_active; upgrade hands off",
    todo: B,
  },
  {
    name: "waiting on CI under a live service run",
    phase: "waiting",
    pins: "upgrade hands the run off (a CI wait is safe to hand off)",
    todo: B,
  },
  {
    name: "settling under a live service",
    phase: "running",
    pins: "decide and cancel end within a deadline instead of owner_settling",
    todo: A,
  },
  {
    name: "operator-paused under a live service run",
    phase: "waiting",
    pins: "upgrade hands the paused run off instead of waiting forever",
    todo: B,
  },
];

// ---------------------------------------------------------------------------
// Installation fixture: a real Git checkout and archive, and the real queue,
// archive and runner code; only the remote Project is a literal wire
// fixture (as in git-registry-lock.test.mjs's watcherWorkflow), kept in a
// file so that owner processes share it.
// ---------------------------------------------------------------------------
async function installation(t, seeded = true) {
  const directory = await mkdtemp(join(tmpdir(), "factory-lifecycle-"));
  const repository = `fixture/lifecycle-${randomUUID()}`;
  t.after(() => rm(directory, { recursive: true, force: true }));
  t.after(() => rm(stateRoot(repository), { recursive: true, force: true }));
  const checkout = join(directory, "target"),
    remote = join(directory, "archive.git");
  await mkdir(checkout);
  const git = (...args) =>
    execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).trim();
  git("init", "-b", "main");
  git("remote", "add", "origin", `https://github.com/${repository}.git`);
  await writeFile(join(checkout, "README.md"), "# Unchanged public fixture\n");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-m",
    "baseline",
  );
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  // Origin is served from a local bare repository through a trusted
  // transport: real Git, no network.
  const source = join(directory, "source.git"),
    ssh = join(directory, "source-ssh");
  execFileSync("git", ["init", "--bare", "-b", "main", source], {
    stdio: "ignore",
  });
  git("push", source, "HEAD:main");
  git("remote", "set-url", "origin", `git@github.com:${repository}.git`);
  await writeFile(ssh, `#!/bin/sh\nexec git-upload-pack '${source}'\n`, {
    mode: 0o700,
  });
  process.env.GIT_SSH_COMMAND = ssh;
  process.env.GIT_SSH_VARIANT = "ssh";
  const selection = { model: "unused-local-check", reasoningEffort: "low" };
  const config = validateConfig({
    schemaVersion: 1,
    repository,
    checkout,
    planning: { kind: "codex-sdk", planner: selection, reviewer: selection },
    execution: {
      kind: "local",
      concurrency: 1,
      harness: { kind: "codex-sdk", ...selection },
    },
    delivery: { kind: "regular" },
    policy: { network: "off", allowedSecretNames: [] },
    queue: {
      pollSeconds: 1,
      maxActiveObjectives: 2,
      project: {
        repository,
        projectId: "PVT_fixture",
        metadataFieldId: "PVTF_metadata",
        orderFieldId: "PVTF_order",
        controlItemId: "PVTI_control",
        factoryManagedFields: true,
      },
    },
    gitPersistence: {
      remote,
      ref: "refs/heads/factory-history",
      visibility: "private",
      scope: "private-history",
      maxBytes: 16 * 1024 * 1024,
      maxFiles: 4096,
      timeoutMs: 30_000,
      coalesceMs: 0,
    },
  });
  const fixture = {
    directory,
    config,
    services: services(config, directory),
    baseSha: git("rev-parse", "HEAD"),
    treeSha: git("rev-parse", "HEAD^{tree}"),
  };
  await watchIntake(config, fixture.services.github);
  await intakeControl(config, "resume", undefined, fixture.services.github);
  // A real first run up to its first planning call records the plan's
  // source packet digest, which every preparation row reuses. The seed keeps
  // its queue claim, one of the installation's dispatch slots.
  if (seeded) {
    await enqueueIntake(config, fixture.services.github, [1]);
    const seed = owner(fixture, "foreground", 1);
    assert.equal(await seed.exited, "ok");
    fixture.sourcePacketDigest = readContinuation(
      repository,
      1,
    ).sourcePacketDigest;
  }
  fixture.validation = await validateWorkItem(
    checkout,
    join(directory, "validation"),
    qaItem(),
    fixture.baseSha,
    fixture.treeSha,
    fixture.baseSha,
  );
  return fixture;
}

function services(config, directory) {
  const selection = { model: "unused-local-check", reasoningEffort: "low" };
  const github = projectFixture(
    config.repository,
    config.queue.project,
    join(directory, "project.json"),
  );
  const contentStore = new LocalContentStore(
    join(stateRoot(config.repository), "content"),
  );
  return {
    github,
    contentStore,
    planningModel: new CodexPlanningModel(
      config.checkout,
      selection,
      selection,
    ),
    driver: new LocalExecutionDriver(
      config.checkout,
      join(directory, "worktrees"),
      new CodexHarness(join(directory, "credentials"), "off", selection),
      1,
      contentStore,
      "codex",
    ),
    delivery: new RegularDelivery(config.checkout, github),
  };
}

/** The remote Project as literal current wire shapes, one card per Objective. */
function projectFixture(repository, binding, file) {
  const load = () =>
    existsSync(file)
      ? JSON.parse(readFileSync(file, "utf8"))
      : { control: null, cards: {} };
  const save = (project) => writeFileSync(file, JSON.stringify(project));
  const card = (project, objective) =>
    (project.cards[objective] ??= {
      itemId: `PVTI_${objective}`,
      issueNodeId: `I_${objective}`,
      objective,
      repository,
      title: `Objective ${objective}`,
      body: BODY,
      state: "open",
      archived: false,
      metadata: null,
      order: null,
    });
  const byItem = (project, itemId) =>
    Object.values(project.cards).find((entry) => entry.itemId === itemId);
  const fields = (metadata, order) => [
    ...(metadata === null
      ? []
      : [
          {
            __typename: "ProjectV2ItemFieldTextValue",
            text: metadata,
            field: { id: binding.metadataFieldId },
          },
        ]),
    ...(order === null
      ? []
      : [
          {
            __typename: "ProjectV2ItemFieldNumberValue",
            number: order,
            field: { id: binding.orderFieldId },
          },
        ]),
  ];
  const wireCard = (project, entry) => {
    const metadata = entry ? entry.metadata : project.control;
    const order = entry ? entry.order : null;
    return {
      __typename: "ProjectV2Item",
      id: entry ? entry.itemId : binding.controlItemId,
      isArchived: entry ? entry.archived : false,
      project: { id: binding.projectId },
      content: entry
        ? {
            __typename: "Issue",
            id: entry.issueNodeId,
            number: entry.objective,
            repository: { nameWithOwner: repository },
          }
        : { __typename: "DraftIssue", id: "D_control" },
      fieldValues: {
        nodes: fields(metadata, order),
        pageInfo: { hasNextPage: false, endCursor: null },
      },
      metadataValue: metadata === null ? null : fields(metadata, null)[0],
      orderValue: order === null ? null : fields(null, order)[0],
    };
  };
  const field = (id, name, dataType) => ({
    __typename: "ProjectV2Field",
    id,
    name,
    ...(dataType ? { dataType, project: { id: binding.projectId } } : {}),
  });
  const access = () => ({
    viewer: { databaseId: 1 },
    project: {
      __typename: "ProjectV2",
      id: binding.projectId,
      closed: false,
      viewerCanUpdate: true,
      owner: { __typename: "Organization", login: "fixture" },
      fields: {
        nodes: [
          field(binding.metadataFieldId, "Factory Admission"),
          field(binding.orderFieldId, "Factory Order"),
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
    metadata: field(binding.metadataFieldId, "Factory Admission", "TEXT"),
    order: field(binding.orderFieldId, "Factory Order", "NUMBER"),
  });
  const issue = (entry) => ({
    __typename: "Issue",
    id: entry.issueNodeId,
    number: entry.objective,
    title: entry.title,
    body: entry.body,
    state: entry.state === "open" ? "OPEN" : "CLOSED",
    repository: { nameWithOwner: repository },
    projectItems: {
      nodes:
        entry.metadata === null
          ? []
          : [
              {
                id: entry.itemId,
                isArchived: entry.archived,
                project: { id: binding.projectId },
              },
            ],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  });
  const graphql = async (query, variables, readOnly) => {
    assert.equal(readOnly, true);
    const project = load();
    if (query === FIELD_BINDING) return access();
    if (query === ITEMS)
      return {
        node: {
          __typename: "ProjectV2",
          id: binding.projectId,
          items: {
            nodes: [wireCard(project)],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      };
    if (query === INSPECT) {
      const subject = variables.includeIssue
        ? project.cards[variables.objective]
        : undefined;
      return {
        ...access(),
        control: wireCard(project),
        ...(variables.includeItem
          ? { target: wireCard(project, byItem(project, variables.item)) }
          : {}),
        repository: {
          nameWithOwner: repository,
          ...(subject ? { issue: issue(subject) } : {}),
        },
      };
    }
    throw new Error("Unexpected Project read query");
  };
  return {
    effectAdmission: "controller-checkpoint-v1",
    projectionMutationAdmission: "controller-checkpoint-v1",
    projectQueueRead: (_binding, knownTargets) =>
      projectQueueReadOnGitHub(repository, binding, graphql, knownTargets),
    async projectQueueInspect(_binding, request) {
      const project = load();
      const target = request?.itemId
        ? byItem(project, request.itemId)
        : undefined;
      const subject = request?.objective
        ? card(project, request.objective)
        : undefined;
      save(project);
      return {
        scope: "target",
        binding,
        actorId: 1,
        owner: "fixture",
        observedAt: new Date().toISOString(),
        control: { itemId: binding.controlItemId, metadata: project.control },
        ...(target ? { target: structuredClone(target) } : {}),
        ...(subject
          ? {
              issue: structuredClone(subject),
              membership: subject.metadata
                ? [{ itemId: subject.itemId, archived: subject.archived }]
                : [],
            }
          : {}),
      };
    },
    async projectQueueWrite(request) {
      const resolved = resolveProjectQueuePlannedEffect(
        binding,
        request.plannedEffect,
        request.dependencyReceipts ?? [],
      );
      const intent = {
        ...resolved.action,
        binding,
        requestId: request.requestId,
        actorId: 1,
        observedAt: new Date().toISOString(),
        request: resolved.request,
        ...(resolved.action.action === "set-metadata"
          ? { fieldId: binding.metadataFieldId }
          : {}),
      };
      await request.beforeWrite(intent);
      const project = load();
      const control = resolved.action.itemId === binding.controlItemId;
      const entry = control
        ? undefined
        : (byItem(project, resolved.action.itemId) ??
          Object.values(project.cards).find(
            (candidate) =>
              candidate.issueNodeId === resolved.action.issueNodeId ||
              candidate.objective === resolved.action.objective,
          ));
      const done = (original) => {
        save(project);
        return {
          intent,
          itemId: entry ? entry.itemId : binding.controlItemId,
          observedAt: new Date().toISOString(),
          kind: "response",
          original,
        };
      };
      if (intent.action === "archive-card") {
        entry.archived = true;
        return done({
          archiveProjectV2Item: {
            clientMutationId: intent.requestId,
            item: wireCard(project, entry),
          },
        });
      }
      if (control) project.control = resolved.action.metadata;
      else {
        if ("metadata" in resolved.action)
          entry.metadata = resolved.action.metadata;
        if ("order" in resolved.action) entry.order = resolved.action.order;
      }
      const target = wireCard(project, entry);
      const response = (clientMutationId) => ({
        clientMutationId,
        projectV2Item: structuredClone(target),
      });
      return done(
        intent.action === "ensure-card"
          ? {
              addProjectV2ItemById: {
                clientMutationId: intent.requestId,
                item: target,
              },
            }
          : intent.action === "set-admission-fields"
            ? {
                order: response(`${intent.requestId}:order`),
                admission: response(`${intent.requestId}:metadata`),
              }
            : { updateProjectV2ItemFieldValue: response(intent.requestId) },
      );
    },
    async objective(number) {
      const project = load();
      const entry = structuredClone(card(project, number));
      save(project);
      return entry;
    },
    async objectiveDependencies() {
      return [];
    },
    async closeIssue() {},
    defaultBranch: () => "main",
  };
}

// ---------------------------------------------------------------------------
// State builder: a valid continuation for each row, from the execution
// snapshot of the watcher scenario and the sealed snapshot beside it.
// ---------------------------------------------------------------------------
function qaItem() {
  return {
    id: "local",
    kind: "qa",
    title: "Verify unchanged fixture",
    goal: "Verify clean Git state",
    brief: "Verify only",
    acceptance: ["git diff is clean."],
    nonGoals: [],
    citations: [{ path: "OBJECTIVE" }],
    dependencies: [],
    ownedPaths: [],
    resources: [],
    expectedOutputRoles: [],
    sourceAssets: [],
    minimumAssetSets: 0,
    requiredLfsRoles: [],
    validation: [
      {
        command: "git diff --exit-code",
        provenance: "source-declared",
        source: "OBJECTIVE",
      },
    ],
  };
}

function executionState(fixture, objective) {
  const { config, baseSha } = fixture;
  const item = qaItem();
  const graph = {
    objective,
    baseSha,
    items: [item],
    coverage: [
      {
        criterionId: createHash("sha256")
          .update("git diff is clean.")
          .digest("hex"),
        itemId: item.id,
        source: {
          path: "OBJECTIVE",
          digest: queueDigest(BODY),
          text: "git diff is clean.",
        },
        proof: { kind: "integrated-command", validationIndex: 0 },
        environment: {
          kind: "local",
          readiness: "available",
          probe: "",
          preparedBy: "",
        },
      },
    ],
  };
  return {
    schemaVersion: 7,
    repository: config.repository,
    objective,
    runId: randomUUID(),
    configDigest: factoryConfigDigest(config),
    objectiveBodyDigest: queueDigest(BODY),
    baseSha,
    graph,
    planGraphDigest: graphDigest(graph),
    publicationContract: "exact-request-v1",
    objectiveCommands: ["git diff --exit-code"],
    approvedPlaybookPin: null,
    approvedPlaybookAdmission: {
      approvedPlaybookPin: null,
      configDigest: factoryConfigDigest(config),
      graphDigest: graphDigest(graph),
      packetDigest: "c".repeat(64),
      reviewDigest: "d".repeat(64),
      sourcePacketDigest: "e".repeat(64),
    },
    capacity: { concurrency: 1 },
    autonomy: resolveAutonomy(),
    issueByItemId: { local: 2 },
    work: { local: { status: "pending", step: "execute", baseSha } },
    coordinator: {
      mode: "running",
      phase: "idle",
      phaseStartedAt: new Date().toISOString(),
      processes: [],
    },
  };
}

function completedState(fixture, objective) {
  const state = executionState(fixture, objective);
  state.work.local = {
    status: "done",
    changeRef: fixture.baseSha,
    treeSha: fixture.treeSha,
    githubClosure: "complete",
    validation: fixture.validation,
  };
  state.finalValidation = { ...fixture.validation, passed: true };
  sealFinalAcceptance(state);
  return state;
}

function preparationState(fixture, objective) {
  const { config, baseSha } = fixture;
  return {
    schemaVersion: 18,
    kind: "preparing",
    approvedPlaybookPin: null,
    repository: config.repository,
    objective,
    runId: randomUUID(),
    configDigest: factoryConfigDigest(config),
    baseSha,
    objectiveBodyDigest: queueDigest(BODY),
    sourcePacketDigest: fixture.sourcePacketDigest,
    issueByItemId: {},
    autonomy: resolveAutonomy(),
    capacity: { concurrency: 1 },
    coordinator: {
      mode: "running",
      phase: "planning",
      phaseStartedAt: new Date().toISOString(),
      processes: [],
    },
  };
}

/** A row's state: `base` changed by `change`. */
function with_(base, change) {
  return (fixture, objective) => {
    const state = base(fixture, objective);
    change(state, fixture);
    return state;
  };
}

// ---------------------------------------------------------------------------
// Dispatch one command as the CLI does and classify the outcome by structure.
// ---------------------------------------------------------------------------
async function dispatch(fixture, command, objective) {
  const { config, services } = fixture;
  const forward = (action, input) =>
    requestControl(config.repository, { objective, action, input });
  try {
    switch (command) {
      case "run":
        return await foregroundRun(fixture, objective);
      case "retry": {
        const reply = await forward("retry", { item: "local" });
        if (!reply.handled) retryWorkItem(config, objective, "local");
        return "ok";
      }
      case "rereview": {
        const input = { item: "local", actor: "fixture" };
        const reply = await forward("rereview", input);
        if (!reply.handled) rereviewWorkItem(config, objective, input);
        return "ok";
      }
      case "repair": {
        const input = {
          item: "local",
          correction: { actor: "fixture", reason: "fixture" },
        };
        const reply = await forward("repair", input);
        if (!reply.handled) repairWorkItem(config, objective, input);
        return "ok";
      }
      case "decide":
        await decideObjective(config, objective, services, {
          actor: "fixture",
          outcome: "refuse",
          reason: "fixture",
        });
        return "ok";
      case "cancel": {
        const reply = await forward("cancel");
        if (!reply.handled)
          await cancelObjective(
            config,
            objective,
            services.driver,
            services.github,
            services.planningModel,
          );
        return "ok";
      }
      case "pause":
      case "drain":
      case "resume": {
        const result = await controlObjective(config, {
          objective,
          action: command,
        });
        return result?.hold ? "rejection_hold" : "ok";
      }
      case "queue-add":
        await enqueueIntake(config, services.github, [objective]);
        return "ok";
      case "queue-remove":
        await intakeControl(config, "dequeue", [objective], services.github);
        return "ok";
      case "upgrade":
        return (await drainForUpgrade(config)).includes(objective)
          ? "waits"
          : "ok";
      case "start":
        checkServiceState(
          config,
          objective,
          join(fixture.directory, "config.json"),
        );
        return "ok";
    }
  } catch (error) {
    if (process.env.FACTORY_LIFECYCLE_TRACE)
      console.error(command, objective, error);
    return lifecycleCode(error) ?? "invalid";
  }
  throw new Error(`Unknown command ${command}`);
}

// ---------------------------------------------------------------------------
// Owners run in their own processes, as `factory run` and the service do.
// ---------------------------------------------------------------------------
function owner(fixture, mode, objective) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    env: {
      ...process.env,
      FACTORY_LIFECYCLE_OWNER: JSON.stringify({
        mode,
        objective,
        config: fixture.config,
        directory: fixture.directory,
        state: process.env.XDG_STATE_HOME,
      }),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (part) => {
    output += part;
  });
  child.stderr.on("data", (part) => {
    if (process.env.FACTORY_LIFECYCLE_TRACE) process.stderr.write(part);
  });
  const exited = once(child, "exit").then(() => {
    const line = output.trim().split("\n").at(-1);
    return line ? JSON.parse(line).outcome : "invalid";
  });
  return {
    exited,
    /** "live" once the owner serves control, else how it ended. */
    async ready() {
      const deadline = Date.now() + 30_000;
      for (;;) {
        const ended = await Promise.race([
          exited,
          new Promise((resolve) => setTimeout(resolve, 50, undefined)),
        ]);
        if (ended !== undefined) return ended;
        const status = await requestControl(fixture.config.repository, {
          objective: mode === "service" ? 0 : objective,
          action: "status",
        }).catch(() => ({ handled: false }));
        if (status.handled) return "live";
        if (Date.now() > deadline) throw new Error(`${mode} owner never ready`);
      }
    },
    /** A live run is cancelled, which settles its queue claim. */
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (mode !== "service")
        await requestControl(fixture.config.repository, {
          objective,
          action: "cancel",
        }).catch(() => undefined);
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      if (mode === "service") child.kill("SIGKILL");
      await exited.catch(() => undefined);
      clearTimeout(timer);
    },
  };
}

/**
 * `factory run`: "ok" once it passes every lifecycle check and reaches its
 * queue claim, else its refusal. It stops there, so it claims no slot.
 */
async function foregroundRun(fixture, objective) {
  if (!readContinuation(fixture.config.repository, objective))
    refuseUnadmittedRun(fixture.config, objective);
  return owner(fixture, "run", objective).exited;
}

async function serveOwner({ mode, objective, config, directory, state }) {
  process.env.XDG_STATE_HOME = state;
  const composed = services(config, directory);
  let outcome = "ok";
  try {
    if (mode === "service") await runIntake(config, composed);
    else {
      // Any provider or delivery call means the run passed every lifecycle
      // check; it ends here, before work.
      const admitted = new Error("admitted");
      const guard = (adapter) =>
        new Proxy(adapter, {
          get(target, property) {
            const value = Reflect.get(target, property, target);
            return typeof value === "function" &&
              /^(generate|review|plan|execute|start|deliver|publish|worker)/i.test(
                String(property),
              )
              ? () => {
                  throw admitted;
                }
              : value;
          },
        });
      const claim = (github) =>
        new Proxy(github, {
          get(target, property) {
            return /^projectQueue(Read|Inspect)$/.test(String(property))
              ? () => {
                  throw admitted;
                }
              : Reflect.get(target, property, target);
          },
        });
      await runObjective(
        config,
        objective,
        {
          ...composed,
          ...(mode === "run" ? { github: claim(composed.github) } : {}),
          planningModel: guard(composed.planningModel),
          driver: guard(composed.driver),
          delivery: guard(composed.delivery),
        },
        // As `factory run` composes it: the run executes queue commands.
        { queueControl: foregroundQueueControl(config, composed.github) },
      ).catch((error) => {
        if (error !== admitted && error?.cause !== admitted) throw error;
      });
    }
  } catch (error) {
    if (process.env.FACTORY_LIFECYCLE_TRACE) console.error(error);
    outcome = lifecycleCode(error) ?? "invalid";
  }
  console.log(JSON.stringify({ outcome }));
  process.exit(0);
}

/** The bound for one operator command with a held publication lock. */
const OPERATOR_BOUND_MS = 5_000;

/** Another process holding the archive publication lock until released. */
async function publicationHolder(repository) {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { withCheckpointPublication } from ${JSON.stringify(new URL("../dist/process.js", import.meta.url).href)};
       await withCheckpointPublication(${JSON.stringify(join(stateRoot(repository), "recovery", ".publication.guard"))}, async () => {
         process.stdout.write("held\\n");
         await new Promise((resolve) => setTimeout(resolve, ${OPERATOR_BOUND_MS * 3}));
       });`,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  await new Promise((resolve, reject) => {
    child.stdout.on(
      "data",
      (part) => String(part).includes("held") && resolve(),
    );
    child.once("exit", () => reject(new Error("publication holder exited")));
  });
  return {
    async release() {
      child.kill("SIGKILL");
      await once(child, "exit").catch(() => undefined);
    },
  };
}

/** A real bounded maintenance pass (pack and reclaim) in another process. */
function maintenance(fixture) {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { maintainRecoveryCheckpoint } from ${JSON.stringify(new URL("../dist/recovery-checkpoint.js", import.meta.url).href)};
       await maintainRecoveryCheckpoint(${JSON.stringify(fixture.config)});`,
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  const exited = once(child, "exit");
  return {
    async release() {
      await exited;
    },
  };
}

// ---------------------------------------------------------------------------

async function cell(t, fixture, row, owner, command, value, objective) {
  const want = typeof value === "string" ? value : value.want;
  const got = await dispatch(fixture, command, objective);
  await t.test(
    `${row.name} / ${owner} / ${command}`,
    typeof value === "string" ? {} : { todo: value.todo },
    () => assert.equal(got, want),
  );
}

/**
 * Commands whose outcome depends on the queue admission every started
 * Objective has; other cells skip admitting, which is the slow part.
 * Admitted Objectives are reused unless the command changed their card.
 */
const ADMITTED = {
  none: ["run", "queue-add", "queue-remove"],
  foreground: COMMANDS,
  service: ["run", "decide", "cancel", "queue-add", "queue-remove"],
};
const CONSUMES = ["decide", "cancel", "queue-add", "queue-remove"];

/**
 * Every cell of `owner`, each with its own Objective, admitted up front as
 * a started Objective would be (a live service learns admissions as it
 * observes the queue).
 */
async function admit(fixture, owner) {
  const planned = [];
  for (const row of ROWS)
    for (const [command, value] of Object.entries(row[owner] ?? {})) {
      if (owner === "service" && command === "start") continue;
      const admitted = row.archive || ADMITTED[owner].includes(command);
      const reuse =
        admitted &&
        fixture.pool.length > 0 &&
        !row.archive &&
        owner !== "foreground";
      const objective = reuse ? fixture.pool.pop() : fixture.next++;
      if (admitted && !reuse)
        await enqueueIntake(fixture.config, fixture.services.github, [
          objective,
        ]);
      const returns =
        admitted &&
        owner !== "foreground" &&
        !row.archive &&
        !CONSUMES.includes(command);
      planned.push({ row, command, value, objective, returns });
    }
  return planned;
}

/** Run each planned cell on its Objective with the row's state. */
async function cells(t, fixture, owner, planned, around = (_, body) => body()) {
  for (const { row, command, value, objective, returns } of planned) {
    const state = row.build(fixture, objective);
    if (state) {
      saveState(statePath(fixture.config.repository, objective), state);
      assert.equal(
        continuationStatusDocument(
          state,
          fixture.config.repository,
          objective,
          "regular",
        ).phase,
        row.phase,
        row.name,
      );
    }
    if (row.archive)
      assert.equal(await dispatch(fixture, "queue-remove", objective), "ok");
    await around({ row, objective }, () =>
      cell(t, fixture, row, owner, command, value, objective),
    );
    rmSync(objectiveRoot(fixture.config.repository, objective), {
      recursive: true,
      force: true,
    });
    if (returns) fixture.pool.push(objective);
  }
}

/** How long `command` takes while `slow` runs beside it; "unbounded" past twice the bound. */
async function timed(fixture, command, objective, slow) {
  const startedAt = Date.now();
  const running = dispatch(fixture, command, objective);
  const outcome = await Promise.race([
    running,
    new Promise((resolve) =>
      setTimeout(resolve, OPERATOR_BOUND_MS * 2, "unbounded"),
    ),
  ]);
  const elapsed = Date.now() - startedAt;
  await slow.release();
  await running;
  return { outcome, elapsed };
}

if (OWNER) await serveOwner(JSON.parse(OWNER));
else {
  test("lifecycle codes, commands and phases are exhaustive", () => {
    assert.equal(new Set(LIFECYCLE_CODES).size, LIFECYCLE_CODES.length);
    for (const action of CONTROL_ACTIONS)
      assert(
        Object.values(COMMAND_ACTION).includes(action) ||
          action in NOT_LIFECYCLE,
        `control action ${action} has no lifecycle column or exemption`,
      );
    for (const phase of STATUS_PHASES)
      assert(
        [...ROWS, ...LIVE_RUN_ROWS].some((row) => row.phase === phase),
        `status phase ${phase} has no lifecycle row`,
      );
    for (const row of ROWS) {
      assert(row.none || row.foreground || row.service, row.name);
      for (const owner of ["none", "foreground", "service"])
        for (const [command, value] of Object.entries(row[owner] ?? {})) {
          assert(COMMANDS.includes(command), `${row.name}: ${command}`);
          const want = typeof value === "string" ? value : value.want;
          assert(
            ["ok", "waits", "invalid"].includes(want) ||
              LIFECYCLE_CODES.includes(want),
            `${row.name}/${owner}/${command}: ${want}`,
          );
        }
    }
  });

  for (const row of LIVE_RUN_ROWS)
    test(`${row.name}: ${row.pins}`, {
      todo: `${row.todo}; needs a live service run in the suite`,
    });

  test("lifecycle conformance matrix", { timeout: 900_000 }, async (t) => {
    const fixture = await installation(t);
    fixture.next = 100;
    fixture.pool = [];
    // No live owner.
    await cells(t, fixture, "none", await admit(fixture, "none"));
    // A live paused foreground run of the Objective.
    await cells(
      t,
      fixture,
      "foreground",
      await admit(fixture, "foreground"),
      async ({ row, objective }, body) => {
        const run = owner(fixture, "foreground", objective);
        try {
          assert.equal(await run.ready(), "live", `${row.name} foreground`);
          await body();
        } finally {
          await run.stop();
        }
      },
    );
    // Bounded time (invariant c): housekeeping beside an operator command.
    const objective = fixture.next++;
    saveState(
      statePath(fixture.config.repository, objective),
      executionState(fixture, objective),
    );
    const maintained = await timed(
      fixture,
      "pause",
      objective,
      maintenance(fixture),
    );
    await t.test(
      "an operator command ends within its bound beside a maintenance pass",
      () => {
        assert.equal(maintained.outcome, "ok");
        assert(
          maintained.elapsed < OPERATOR_BOUND_MS,
          `${maintained.elapsed} ms`,
        );
      },
    );
    // A publication lock held past the bound (a stuck publisher) still
    // holds the operator command: its own admission waits without a bound.
    const stuck = await timed(
      fixture,
      "resume",
      objective,
      await publicationHolder(fixture.config.repository),
    );
    await t.test(
      "an operator command ends within its bound beside a stuck publisher",
      { todo: C },
      () => {
        assert.equal(stuck.outcome, "ok");
        assert(stuck.elapsed < OPERATOR_BOUND_MS, `${stuck.elapsed} ms`);
      },
    );
    // A live service that runs none of them: its queue stays paused.
    await intakeControl(
      fixture.config,
      "pause",
      undefined,
      fixture.services.github,
    );
    const planned = await admit(fixture, "service");
    const service = owner(fixture, "service", 0);
    try {
      assert.equal(await service.ready(), "live");
      await cells(t, fixture, "service", planned);
    } finally {
      await service.stop();
    }
  });

  // Dispatch isolation (#1715): failed and cancel-requested queued
  // Objectives ahead of another neither stop the service nor block the
  // Objective behind them.
  test("a failed or cancel-requested queued Objective does not stop dispatch", async (t) => {
    const fixture = await installation(t, false);
    const [failed, cancelling, next] = [2, 3, 4];
    await enqueueIntake(fixture.config, fixture.services.github, [
      failed,
      cancelling,
      next,
    ]);
    const requested = executionState(fixture, cancelling);
    requested.cancelRequested = true;
    saveState(statePath(fixture.config.repository, cancelling), requested);
    const state = executionState(fixture, failed);
    state.work.local = {
      status: "failed",
      step: "execute",
      baseSha: fixture.baseSha,
      error: "fixture failure",
    };
    state.error = "fixture failure";
    state.errorItem = "local";
    saveState(statePath(fixture.config.repository, failed), state);
    const service = owner(fixture, "service", 0);
    try {
      assert.equal(await service.ready(), "live");
      const deadline = Date.now() + 60_000;
      let status;
      do {
        await new Promise((resolve) => setTimeout(resolve, 250));
        status = await requestControl(fixture.config.repository, {
          objective: 0,
          action: "status",
        });
      } while (
        status.handled &&
        !readContinuation(fixture.config.repository, next) &&
        Date.now() < deadline
      );
      if (process.env.FACTORY_LIFECYCLE_TRACE)
        console.error(JSON.stringify(status.result));
      assert.equal(status.handled, true, "the service stays up");
      assert(
        readContinuation(fixture.config.repository, next),
        "the Objective behind the failed one is dispatched",
      );
      // Each skipped Objective is named with its reason.
      for (const id of [failed, cancelling])
        assert(id in (status.result.observation?.reasons ?? {}), `#${id}`);
      assert.equal(
        readContinuation(fixture.config.repository, failed).runId,
        state.runId,
      );
    } finally {
      await service.stop();
    }
  });
}
