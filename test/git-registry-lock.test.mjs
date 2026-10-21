import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, readlinkSync, readFileSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  factoryAuthorityDigest,
  factoryConfigDigest,
  queueControlBinding,
  resolveProvider,
  stateRoot,
  validateConfig,
} from "../dist/config.js";
import { LocalContentStore } from "../dist/content/local.js";
import { diagnosticPath } from "../dist/diagnostics.js";
import { RegularDelivery } from "../dist/delivery/regular.js";
import { CodexPlanningModel } from "../dist/compiler/model.js";
import { sealFinalAcceptance } from "../dist/completion.js";
import { LocalExecutionDriver, CodexHarness } from "../dist/execution/local.js";
import { graphDigest } from "../dist/graph-amendments.js";
import {
  enqueueIntake,
  foregroundQueueControl,
  intakeControl,
  runIntake,
  resolveIntakeBase,
  watchIntake,
  withIntakeCommandDeadline,
} from "../dist/intake.js";
import { LocalRepositoryMemory } from "../dist/repository-memory.js";
import { resolveAutonomy } from "../dist/repair-policy.js";
import {
  ControllerCommandIncompleteError,
  requestControl,
  requestForegroundQueueControl,
  serveControl,
} from "../dist/coordinator-control.js";
import { validateWorkItem } from "../dist/validation.js";
import {
  createProjectQueuePlannedEffect,
  resolveProjectQueuePlannedEffect,
} from "../dist/github-project-queue.js";
import { UPDATE } from "../dist/github-project-queue-wire.js";
import {
  linuxProcessIdentity,
  ownIdentity,
  subprocessAsync,
  withCheckpointPublication,
  withProcessCancellation,
  withRegistryFiles,
} from "../dist/process.js";
import {
  admitQueueCommand,
  assertQueueCommandHistory,
  assertProjectQueueClaimAdmission,
  assertQueueOperationReferenceBodies,
  authenticateQueueOwnerReferences,
  completeQueueCommand,
  createQueueCommand,
  createQueueOperation,
  nextProjectQueueOrder,
  observeProjectQueue,
  queueDigest,
  parseQueueRecord,
  performQueueCommandEffect,
  QueueAuthorityChanged,
  readQueueHistory,
  queueObservationTargets,
  verifyQueueObservation,
  verifyQueueInspection,
  retainedQueueEntry,
  settleFailedProjectQueueReservation,
} from "../dist/project-queue-state.js";
import {
  awaitCheckpointAdmission,
  bindRecoveryCheckpointControllerScope,
  gitPersistenceStatus,
  isCheckpointCollectionPending,
  markCheckpointDirty,
  readVerifiedRecoveryCheckpoint,
  synchronizeRecoveryCheckpoint,
  withRecoveryCheckpointControllerVerification,
  withRecoveryCheckpointScope,
} from "../dist/recovery-checkpoint.js";
import { buildRecoveryCheckpointClosure } from "../dist/recovery-checkpoint-closure.js";
import {
  projectQueueReadOnGitHub,
  withProjectQueueObservationOnGitHub,
} from "../dist/github-project-queue.js";
import {
  FIELD_BINDING,
  ITEMS,
  INSPECT,
} from "../dist/github-project-queue-wire.js";
import { runObjective } from "../dist/runner.js";
import {
  admitExecution,
  plannedExecutionConflict,
  sharedCapacity,
} from "../dist/concurrent-objectives.js";
import { phaseAdmission } from "../dist/phase-admission.js";
import {
  acquireInstallationLock,
  acquireObjectiveLock,
  asInstallationOwner,
  installationLockPath,
  objectiveLockPath,
  readControllerOwner,
  readContinuation,
  readState,
  releaseControllerLock,
  statePath,
  saveState,
} from "../dist/state-store.js";

const processUrl = new URL("../dist/process.js", import.meta.url).href;

test("a terminal background watcher holds checkpoint failure while real control and explicit recovery remain usable", async (t) => {
  await watcherWorkflow(t, true);
  await watcherWorkflow(t, false);
});

test("normal run acknowledges a ceased Project owner after genuine local result collection", async (t) => {
  await watcherWorkflow(t, false, true);
});

async function watcherWorkflow(
  t,
  preSnapshotFailure,
  collectedExecution = false,
) {
  const directory = await mkdtemp(
    join(tmpdir(), "factory-watcher-checkpoint-"),
  );
  const repository = `fixture/watcher-${randomUUID()}`;
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
  const selection = { model: "unused-local-check", reasoningEffort: "low" };
  const config = {
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
      ...(preSnapshotFailure ? { objectiveDeadlineSeconds: 60 } : {}),
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
  };
  validateConfig(config);
  const binding = config.queue.project;
  const body =
    "## Outcome\nVerify the unchanged fixture.\n\n## Acceptance\n- git diff is clean.\n\n## Validation\ngit diff --exit-code\n";
  let controlMetadata = null;
  const card = {
    itemId: "PVTI_issue",
    issueNodeId: "I_fixture",
    objective: 1,
    repository,
    title: "Verify fixture",
    body,
    state: "open",
    archived: false,
    metadata: null,
    order: null,
  };
  let reads = 0,
    writes = 0;
  let holdArchiveAfterWrite = false,
    archiveHolder;
  let indexReads = 0;
  let membershipVisible = true;
  let changeControlDuringRead = false;
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
  const wireCard = (control = false) => ({
    __typename: "ProjectV2Item",
    id: control ? binding.controlItemId : card.itemId,
    isArchived: control ? false : card.archived,
    project: { id: binding.projectId },
    content: control
      ? { __typename: "DraftIssue", id: "D_control" }
      : {
          __typename: "Issue",
          id: card.issueNodeId,
          number: card.objective,
          repository: { nameWithOwner: repository },
        },
    fieldValues: {
      nodes: fields(
        control ? controlMetadata : card.metadata,
        control ? null : card.order,
      ),
      pageInfo: { hasNextPage: false, endCursor: null },
    },
    metadataValue:
      (control ? controlMetadata : card.metadata) === null
        ? null
        : fields(control ? controlMetadata : card.metadata, null)[0],
    orderValue:
      control || card.order === null ? null : fields(null, card.order)[0],
  });
  const wireAccess = () => ({
    viewer: { databaseId: 1 },
    project: {
      __typename: "ProjectV2",
      id: binding.projectId,
      closed: false,
      viewerCanUpdate: true,
      owner: { __typename: "Organization", login: "fixture" },
      fields: {
        nodes: [
          {
            __typename: "ProjectV2Field",
            id: binding.metadataFieldId,
            name: "Factory Admission",
          },
          {
            __typename: "ProjectV2Field",
            id: binding.orderFieldId,
            name: "Factory Order",
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
    metadata: {
      __typename: "ProjectV2Field",
      id: binding.metadataFieldId,
      name: "Factory Admission",
      dataType: "TEXT",
      project: { id: binding.projectId },
    },
    order: {
      __typename: "ProjectV2Field",
      id: binding.orderFieldId,
      name: "Factory Order",
      dataType: "NUMBER",
      project: { id: binding.projectId },
    },
  });
  // Literal current wire shapes reproduce the observed index/membership disagreement.
  // The actual decoder, receipt production, Git archive and watcher stay real.
  const graphql = async (query, variables, readOnly) => {
    assert.equal(readOnly, true);
    if (query === FIELD_BINDING) return wireAccess();
    if (query === ITEMS) {
      indexReads++;
      return {
        node: {
          __typename: "ProjectV2",
          id: binding.projectId,
          items: {
            nodes: [wireCard(true)],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      };
    }
    if (query === INSPECT) {
      if (changeControlDuringRead) {
        changeControlDuringRead = false;
        controlMetadata += " ";
      }
      return {
        ...wireAccess(),
        control: wireCard(true),
        ...(variables.includeItem ? { target: wireCard(false) } : {}),
        repository: {
          nameWithOwner: repository,
          ...(variables.includeIssue
            ? {
                issue: {
                  __typename: "Issue",
                  id: card.issueNodeId,
                  number: card.objective,
                  title: card.title,
                  body: card.body,
                  state: card.state === "open" ? "OPEN" : "CLOSED",
                  repository: { nameWithOwner: repository },
                  projectItems: {
                    nodes:
                      card.metadata === null || !membershipVisible
                        ? []
                        : [
                            {
                              id: card.itemId,
                              isArchived: card.archived,
                              project: { id: binding.projectId },
                            },
                          ],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              }
            : {}),
        },
      };
    }
    throw new Error("Unexpected Project read query in wire workflow");
  };
  // Only the remote Project contract is a fixture; actual receipt production,
  // durable Git publication, runner completion and local control remain real.
  const github = {
    effectAdmission: "controller-checkpoint-v1",
    projectionMutationAdmission: "controller-checkpoint-v1",
    async projectQueueRead(_binding, knownTargets) {
      reads++;
      return projectQueueReadOnGitHub(
        repository,
        binding,
        graphql,
        knownTargets,
      );
    },
    async projectQueueInspect(_binding, request) {
      return {
        scope: "target",
        binding,
        actorId: 1,
        owner: "fixture",
        observedAt: new Date().toISOString(),
        control: { itemId: binding.controlItemId, metadata: controlMetadata },
        ...(request?.itemId ? { target: structuredClone(card) } : {}),
        ...(request?.objective
          ? {
              issue: structuredClone(card),
              membership: card.metadata
                ? [{ itemId: card.itemId, archived: false }]
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
      writes++;
      if (intent.action === "remove-card") {
        card.metadata = card.order = null;
        const deleted = {
          clientMutationId: intent.requestId,
          deletedItemId: card.itemId,
        };
        return {
          intent,
          itemId: card.itemId,
          observedAt: new Date().toISOString(),
          kind: "response",
          original: { deleteProjectV2Item: deleted },
        };
      }
      const control = resolved.action.itemId === binding.controlItemId;
      if (control) controlMetadata = resolved.action.metadata;
      else {
        if ("metadata" in resolved.action)
          card.metadata = resolved.action.metadata;
        if ("order" in resolved.action) card.order = resolved.action.order;
      }
      const target = {
        id: control ? binding.controlItemId : card.itemId,
        isArchived: false,
        project: { id: binding.projectId },
        content: control
          ? { __typename: "DraftIssue", id: "D_control" }
          : {
              __typename: "Issue",
              id: card.issueNodeId,
              number: 1,
              repository: { nameWithOwner: repository },
            },
        fieldValues: {
          nodes: [
            ...((control ? controlMetadata : card.metadata)
              ? [
                  {
                    __typename: "ProjectV2ItemFieldTextValue",
                    field: { id: binding.metadataFieldId },
                    text: control ? controlMetadata : card.metadata,
                  },
                ]
              : []),
            ...(card.order !== null && !control
              ? [
                  {
                    __typename: "ProjectV2ItemFieldNumberValue",
                    field: { id: binding.orderFieldId },
                    number: card.order,
                  },
                ]
              : []),
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      };
      const response = (clientMutationId) => ({
        clientMutationId,
        projectV2Item: structuredClone(target),
      });
      if (holdArchiveAfterWrite) {
        holdArchiveAfterWrite = false;
        archiveHolder = await holder(
          join(stateRoot(repository), "recovery", ".publication.guard"),
          "exclusive",
          true,
        );
      }
      const original =
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
            : { updateProjectV2ItemFieldValue: response(intent.requestId) };
      return {
        intent,
        itemId: target.id,
        observedAt: new Date().toISOString(),
        kind: "response",
        original,
      };
    },
    async objective() {
      return structuredClone(card);
    },
    async closeIssue() {
      card.state = "closed";
    },
  };
  await watchIntake(config, github);
  await enqueueIntake(config, github, [1]);
  // Authenticated real Git originals are stable identity hints, not a cached queue.
  const history = await readQueueHistory(config),
    hints = queueObservationTargets(history);
  assert.deepEqual(hints, [
    { objective: 1, issueNodeId: card.issueNodeId, itemId: card.itemId },
  ]);
  const beforeIndexReads = indexReads;
  await withProjectQueueObservationOnGitHub(
    repository,
    binding,
    graphql,
    async () => {
      assert.equal(
        (await projectQueueReadOnGitHub(repository, binding, graphql)).cards
          .length,
        0,
      );
      const current = await projectQueueReadOnGitHub(
        repository,
        binding,
        graphql,
        hints,
      );
      assert.equal(current.cards[0].body, body);
      assert.equal(
        verifyQueueObservation(config, current, history).entries[0].state,
        "queued",
      );
    },
  );
  assert.equal(
    indexReads - beforeIndexReads,
    2,
    "new mappings cannot reuse the index-only observation",
  );
  card.archived = true;
  const archived = await projectQueueReadOnGitHub(
    repository,
    binding,
    graphql,
    hints,
  );
  assert.equal(archived.cards[0].archived, true);
  assert.equal(
    verifyQueueObservation(config, archived, history).entries.length,
    0,
  );
  card.archived = false;
  membershipVisible = false;
  assert.equal(
    (await projectQueueReadOnGitHub(repository, binding, graphql, hints)).cards
      .length,
    0,
  );
  membershipVisible = true;
  card.order++;
  const reordered = await projectQueueReadOnGitHub(
    repository,
    binding,
    graphql,
    hints,
  );
  assert.equal(reordered.cards[0].order, card.order);
  assert.throws(
    () => verifyQueueObservation(config, reordered, history),
    /differs from original admission/,
  );
  card.order--;
  card.body += "Current changed contents.\n";
  const changed = await projectQueueReadOnGitHub(
    repository,
    binding,
    graphql,
    hints,
  );
  assert.equal(changed.cards[0].body, card.body);
  assert.notEqual(
    createHash("sha256").update(changed.cards[0].body).digest("hex"),
    verifyQueueObservation(config, changed, history).entries[0].bodyDigest,
  );
  card.body = body;
  const originalIssueId = card.issueNodeId;
  card.issueNodeId = "I_foreign";
  await assert.rejects(
    () => projectQueueReadOnGitHub(repository, binding, graphql, hints),
    /differs from current full observation/,
  );
  card.issueNodeId = originalIssueId;
  const originalControl = controlMetadata;
  changeControlDuringRead = true;
  await assert.rejects(
    () => projectQueueReadOnGitHub(repository, binding, graphql, hints),
    /differs from current full observation/,
  );
  controlMetadata = originalControl;

  if (collectedExecution) {
    const { addWorktree, processGroupExists } = await import(
      "../dist/process.js"
    );
    const { launchWorker, killGroup } = await import(
      "../dist/execution/worker-process.js"
    );
    const { checkpointWorkerSession } = await import(
      "../dist/execution/local.js"
    );
    const { collectCompletedWorker } = await import("../dist/runner.js");
    const { agentSessionContinuation } = await import(
      "../dist/agent-session.js"
    );
    const { settleStoppedProjectQueueRun } = await import(
      "../dist/project-queue-state.js"
    );
    const { linuxProcessIdentity } = await import("../dist/process.js");
    const baseSha = git("rev-parse", "HEAD"),
      attempt = randomUUID();
    const item = {
      id: "local",
      title: "Local evidence",
      goal: "Retain local evidence",
      brief: "A finite local integration process",
      acceptance: ["git diff is clean."],
      dependencies: [],
      ownedPaths: ["README.md"],
      resources: [],
      nonGoals: [],
      validation: [],
      citations: [],
      sourceAssets: [],
      expectedOutputRoles: [],
      requiredLfsRoles: [],
      minimumAssetSets: 0,
    };
    const graph = {
      objective: 1,
      baseSha,
      items: [item],
      coverage: [
        {
          criterionId: "b".repeat(64),
          itemId: item.id,
          source: {
            path: "OBJECTIVE",
            digest: queueDigest(body),
            text: "git diff is clean.",
          },
          proof: { kind: "result-semantic", acceptanceIndex: 0 },
          environment: {
            kind: "local",
            readiness: "available",
            probe: "",
            preparedBy: "",
          },
        },
      ],
    };
    const state = {
      schemaVersion: 17,
      repository,
      objective: 1,
      runId: randomUUID(),
      configDigest: factoryConfigDigest(config),
      objectiveBodyDigest: queueDigest(body),
      baseSha,
      graph,
      planGraphDigest: graphDigest(graph),
      publicationContract: "exact-request-v1",
      objectiveCommands: [],
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
    };
    const path = statePath(repository, 1),
      privateRoot = stateRoot(repository),
      store = new LocalContentStore(join(privateRoot, "content"));
    saveState(path, state);
    await intakeControl(config, "resume", undefined, github);
    const inputs = join(directory, "old-owner-input.json");
    await writeFile(
      inputs,
      JSON.stringify({
        config,
        state,
        snapshot: await github.projectQueueRead(binding, hints),
      }),
      { mode: 0o600 },
    );
    const ownerScript = join(directory, "old-owner.mjs");
    const dist = new URL("../dist/", import.meta.url).href;
    await writeFile(
      ownerScript,
      `import {readFileSync} from 'node:fs';
import {acquireObjectiveLock,releaseControllerLock,objectiveLockPath} from '${dist}state-store.js';
import {claimProjectQueueRun,bindProjectQueueRun} from '${dist}project-queue-state.js';
import {buildRecoveryCheckpointClosure} from '${dist}recovery-checkpoint-closure.js';
import {withRecoveryCheckpointScope,awaitCheckpointAdmission} from '${dist}recovery-checkpoint.js';
const {config,state,snapshot}=JSON.parse(readFileSync(process.argv[2],'utf8'));
const lock=acquireObjectiveLock(config.repository,1);
try {await withRecoveryCheckpointScope({config,buildClosure:()=>buildRecoveryCheckpointClosure({config})},async()=>{
const gateway={effectAdmission:'controller-checkpoint-v1',projectQueueRead:async()=>snapshot};
const claim=await claimProjectQueueRun(config,gateway,1,lock.token,state);
bindProjectQueueRun(config,claim,lock.token,state);await awaitCheckpointAdmission(config.repository,'explicit');
});}finally{releaseControllerLock(objectiveLockPath(config.repository,1),lock);}
`,
      { mode: 0o600 },
    );
    execFileSync(process.execPath, [ownerScript, inputs], {
      env: process.env,
      stdio: "pipe",
      timeout: 15_000,
    });
    const originalClaim = (await readQueueHistory(config)).find(
      (row) => row.kind === "project-queue-owner",
    );
    const originalClaimBytes = JSON.stringify(originalClaim);
    const workRoot = join(privateRoot, "worktrees"),
      worktree = join(workRoot, attempt);
    await addWorktree(checkout, worktree, baseSha);
    const harness = new CodexHarness(
      join(privateRoot, "credentials"),
      "off",
      selection,
    );
    state.work.local = { status: "running", step: "execute", attempt, baseSha };
    const continuity = agentSessionContinuation(
      state,
      "implementation",
      item.id,
      () => saveState(path, state),
    );
    const request = {
      attemptId: attempt,
      baseSha,
      item,
      session: { scope: continuity.scope, identity: continuity.identity },
    };
    checkpointWorkerSession(
      request.session,
      { adapter: "codex", supportsResume: true, executionIdentity: attempt },
      continuity.checkpoint,
    );
    const session = await harness.workerSession(request);
    const release = join(directory, "release-worker"),
      script = join(directory, "owned-result.cjs");
    // Same finite owned local protocol producer as the collection workflow:
    // no inference, semantic verdict or provider response is fabricated.
    await writeFile(
      script,
      `const fs=require('node:fs'),p=require('node:path');const input=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));const timer=setInterval(()=>{if(!fs.existsSync(input.release))return;clearInterval(timer);fs.writeFileSync(p.join(input.request.worktree,'README.md'),'# Local incomplete candidate\\n');fs.writeFileSync(process.argv[3],JSON.stringify({state:'complete',evidence:{finalResponse:'INCOMPLETE: normal validation and review required'},session:{...input.session.ref,status:'ready',data:{...input.session.ref.data,threadId:'owned-local-protocol-process',nativeEof:true}}}),{mode:0o600});},10);`,
    );
    const worker = await launchWorker({
      root: join(privateRoot, "harness"),
      identity: attempt,
      input: { request: { ...request, worktree }, session, release },
      script,
      env: process.env,
      label: "Local integration process",
    });
    t.after(async () => {
      if (processGroupExists(worker.pid))
        await killGroup(worker.pid, "Local integration process");
    });
    state.work.local.execution = {
      provider: "local",
      identity: attempt,
      data: {
        request: structuredClone(request),
        worktree,
        adapterIdentity: "codex-sdk",
        handle: { identity: attempt, data: worker },
      },
    };
    saveState(path, state);
    const lock = acquireObjectiveLock(repository, 1);
    try {
      await withRecoveryCheckpointScope(
        {
          config,
          buildClosure: () => buildRecoveryCheckpointClosure({ config }),
        },
        () =>
          assert.rejects(
            settleStoppedProjectQueueRun(config, state, lock),
            /collected local results/,
          ),
      );
    } finally {
      releaseControllerLock(objectiveLockPath(repository, 1), lock);
    }
    assert.equal(
      JSON.stringify(
        (await readQueueHistory(config)).find(
          (row) => row.id === originalClaim.id,
        ),
      ),
      originalClaimBytes,
    );
    await writeFile(release, "release");
    const resultDeadline = Date.now() + 10_000;
    while (!existsSync(worker.resultPath) && Date.now() < resultDeadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert(existsSync(worker.resultPath));
    // Between the worker's return and its collection, publication refuses with
    // a typed pending-collection cause, which a concurrent presentation tick
    // skips (#1276); the acknowledged checkpoint after collection follows below.
    saveState(path, state);
    await assert.rejects(
      withRecoveryCheckpointScope(
        {
          config,
          buildClosure: () => buildRecoveryCheckpointClosure({ config }),
        },
        () => awaitCheckpointAdmission(repository, "explicit"),
      ),
      (error) => isCheckpointCollectionPending(error),
    );
    const driver = new LocalExecutionDriver(
      checkout,
      workRoot,
      harness,
      1,
      store,
      "codex-sdk",
    );
    // A collector announces itself to other controller processes with a
    // marker naming its live process. A marker whose process is gone is
    // ignored, so the refusal stands; with a live collector, another admission
    // waits for the freeze and then publishes instead of stopping (#1281, #1285).
    const collections = join(stateRoot(repository), "recovery", "collections");
    const marker = join(collections, `${attempt}.json`);
    await mkdir(collections, { recursive: true, mode: 0o700 });
    await writeFile(
      marker,
      JSON.stringify({ pid: worker.pid, startTime: "0" }),
      {
        mode: 0o600,
      },
    );
    await assert.rejects(
      withRecoveryCheckpointScope(
        {
          config,
          buildClosure: () => buildRecoveryCheckpointClosure({ config }),
        },
        () => awaitCheckpointAdmission(repository, "explicit"),
      ),
      (error) => isCheckpointCollectionPending(error),
    );
    await writeFile(
      marker,
      JSON.stringify({
        pid: process.pid,
        startTime: linuxProcessIdentity(process.pid).startTime,
      }),
      { mode: 0o600 },
    );
    const admitted = withRecoveryCheckpointScope(
      {
        config,
        buildClosure: () => buildRecoveryCheckpointClosure({ config }),
      },
      () => awaitCheckpointAdmission(repository, "explicit"),
    );
    await collectCompletedWorker(
      config,
      1,
      { runId: state.runId, item: item.id, attempt },
      driver,
    );
    await rm(marker);
    await admitted;
    const collected = readState(repository, 1),
      frozen = JSON.stringify(collected.work.local.execution.data.result),
      allowances = JSON.stringify(collected.autonomy);
    assert.equal(processGroupExists(worker.pid), false);
    const checkpoint = gitPersistenceStatus(config);
    assert.equal(checkpoint.sequence, checkpoint.acknowledgedSequence);
    // Reuse the genuine pre-intent archive refusal producer from the existing
    // reservation workflow: permanent failed control is inactive, not replayed.
    await withRecoveryCheckpointScope(
      {
        config,
        buildClosure: () => buildRecoveryCheckpointClosure({ config }),
      },
      async () => {
        const operation = createQueueOperation(config, {
          action: "control",
          scope: "control",
          previousReceiptId: JSON.parse(controlMetadata).receiptId,
          approval: { kind: "queue-command" },
        });
        operation.metadata = JSON.stringify({
          schemaVersion: 1,
          kind: "control",
          receiptId: operation.id,
          mode: "paused",
          watch: true,
        });
        const step = createProjectQueuePlannedEffect(binding, {
          operationId: operation.id,
          requestId: randomUUID(),
          actorId: 1,
          action: "set-metadata",
          target: { itemId: binding.controlItemId },
          fieldId: binding.metadataFieldId,
          metadata: operation.metadata,
          prior: {
            target: {
              itemId: binding.controlItemId,
              metadata: controlMetadata,
            },
          },
          control: { metadata: controlMetadata },
        });
        const command = createQueueCommand(config, {
          operations: [operation],
          effects: [step],
          deadlineAt: null,
        });
        await rename(remote, `${remote}.unavailable`);
        try {
          await assert.rejects(admitQueueCommand(config, command), /ENOENT/);
        } finally {
          await rename(`${remote}.unavailable`, remote);
        }
        assert.equal(operation.effects.length, 0);
        assert(operation.beforeEffectFailure);
        await assert.rejects(
          admitQueueCommand(config, command),
          /never replay/,
        );
        await awaitCheckpointAdmission(repository, "explicit");
      },
    );
    const refusalLock = acquireObjectiveLock(repository, 1);
    try {
      await withRecoveryCheckpointScope(
        {
          config,
          buildClosure: () => buildRecoveryCheckpointClosure({ config }),
        },
        async () => {
          const unknown = structuredClone(collected);
          const native = Object.values(unknown.agentSessions)[0];
          native.data.workerSettled = false;
          unknown.work.local.execution.data.result.session.data.workerSettled = false;
          await assert.rejects(
            settleStoppedProjectQueueRun(config, unknown, refusalLock),
            /collected local results/,
          );
          const foreign = structuredClone(collected);
          foreign.restoration = { disposition: "reconciliation-required" };
          await assert.rejects(
            settleStoppedProjectQueueRun(config, foreign, refusalLock),
            /collected local results/,
          );
          // A worker that ended without a result is a ceased owner (#1268):
          // the claim check accepts it, and settlement still refuses while
          // its recorded process identity is alive.
          const ceased = structuredClone(collected);
          const ceasedData = ceased.work.local.execution.data;
          delete ceasedData.result;
          ceasedData.stopped = "The worker stopped without a result";
          ceased.work.local.status = "running";
          ceased.work.local.step = "execute";
          // The driver records the ceased worker's session as unavailable.
          for (const ref of Object.values(ceased.agentSessions ?? {}))
            if (ref.executionIdentity === attempt) {
              ref.status = "unavailable";
              delete ref.currentTurn;
            }
          ceasedData.handle.data = {
            ...ceasedData.handle.data,
            pid: process.pid,
            startTime: linuxProcessIdentity(process.pid).startTime,
          };
          await assert.rejects(
            settleStoppedProjectQueueRun(config, ceased, refusalLock),
            /remains active or uncertain/,
          );
        },
      );
    } finally {
      releaseControllerLock(objectiveLockPath(repository, 1), refusalLock);
    }
    const boundary = new Error(
      "Observed original run before new execution or inference",
    );
    const services = {
      github,
      contentStore: store,
      driver,
      planningModel: new CodexPlanningModel(checkout, selection, selection),
      delivery: new RegularDelivery(checkout, github),
      reportRunStatus(message) {
        if (message.includes("resuming the existing run")) throw boundary;
      },
    };
    await assert.rejects(
      runObjective(config, 1, services),
      (error) => error === boundary,
    );
    const owners = (await readQueueHistory(config)).filter(
      (row) => row.kind === "project-queue-owner",
    );
    assert.equal(owners.length, 2);
    const old = owners.find((row) => row.id === originalClaim.id),
      current = owners.find((row) => row.id !== originalClaim.id);
    assert.equal(old.settled.disposition, "quiescent");
    assert.equal(old.settled.runId, collected.runId);
    assert.equal(old.settled.handoff.owner.pid, process.pid);
    assert.notEqual(
      old.settled.handoff.owner.tokenDigest,
      old.ownerTokenDigest,
    );
    const { settled, ...unchanged } = old;
    assert.equal(JSON.stringify(unchanged), originalClaimBytes);
    await authenticateQueueOwnerReferences(old, (ref) => store.readBytes(ref));
    assert.equal(current.priorRunId, collected.runId);
    assert.equal(current.deadlineAt, old.deadlineAt);
    const resumed = readState(repository, 1);
    assert.equal(resumed.runId, collected.runId);
    assert.equal(
      JSON.stringify(resumed.work.local.execution.data.result),
      frozen,
    );
    assert.equal(JSON.stringify(resumed.autonomy), allowances);
    assert.equal(resumed.finalAcceptance, undefined);
    assert.match(
      resumed.work.local.execution.data.result.evidence.finalResponse,
      /^INCOMPLETE:/,
    );
    return;
  }

  if (preSnapshotFailure) {
    const initial = git("rev-parse", "HEAD"),
      sourceRemote = join(directory, "source.git");
    execFileSync("git", ["init", "--bare", "-b", "main", sourceRemote], {
      stdio: "ignore",
    });
    git("push", sourceRemote, "HEAD:main");
    git("remote", "set-url", "origin", `git@github.com:${repository}.git`);
    const ssh = join(directory, "source-ssh");
    // A trusted operator transport executes the actual upload-pack against
    // this owned bare repository. Git refs/objects/output remain genuine;
    // no synthetic Git response or provider is involved.
    await writeFile(
      ssh,
      `#!/bin/sh\nexec git-upload-pack '${sourceRemote}'\n`,
      { mode: 0o700 },
    );
    const originalSsh = process.env.GIT_SSH_COMMAND,
      originalVariant = process.env.GIT_SSH_VARIANT;
    process.env.GIT_SSH_COMMAND = ssh;
    process.env.GIT_SSH_VARIANT = "ssh";
    const contentStore = new LocalContentStore(
      join(stateRoot(repository), "content"),
    );
    const boundary = new Error(
      "Observed actual preparation before compiler submission",
    );
    let planningBoundary = 0;
    const services = {
      github: {
        ...github,
        async defaultBranch() {
          return "main";
        },
      },
      contentStore,
      planningModel: new CodexPlanningModel(checkout, selection, selection),
      driver: new LocalExecutionDriver(
        checkout,
        join(directory, "worktrees"),
        new CodexHarness(join(directory, "credentials"), "off", selection),
        1,
        contentStore,
        "codex",
      ),
      delivery: new RegularDelivery(checkout, github),
      reportRunStatus(message) {
        if (!message.includes("compiling and independently reviewing")) return;
        planningBoundary++;
        throw boundary;
      },
    };
    try {
      await intakeControl(config, "resume", undefined, github);
      await writeFile(
        join(checkout, "diverged.txt"),
        "actual retained user work\n",
      );
      git("add", "diverged.txt");
      git(
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "-m",
        "diverged local source",
      );
      const diverged = git("rev-parse", "HEAD");
      await assert.rejects(
        runObjective(config, 1, services),
        /fast-forward|diverg/i,
      );
      assert.equal(planningBoundary, 0);
      assert.equal(git("rev-parse", "HEAD"), diverged);
      assert.equal(
        await readFile(join(checkout, "diverged.txt"), "utf8"),
        "actual retained user work\n",
      );
      assert.equal(readState(repository, 1), undefined);
      assert.equal(
        readControllerOwner(objectiveLockPath(repository, 1)),
        undefined,
      );
      const first = (await readQueueHistory(config)).filter(
        (row) => row.kind === "project-queue-owner",
      );
      assert.equal(first.length, 1);
      assert.equal(first[0].settled.disposition, "quiescent");
      assert(first[0].settled.reservationFailure);
      assert.equal(first[0].runBinding, undefined);
      await authenticateQueueOwnerReferences(first[0], (ref) =>
        contentStore.readBytes(ref),
      );
      const settledOriginal = JSON.stringify(first[0]);
      const acknowledged = await withRecoveryCheckpointScope(
        {
          config,
          buildClosure: () => buildRecoveryCheckpointClosure({ config }),
        },
        () => readVerifiedRecoveryCheckpoint(config),
      );
      const archivedClaim = acknowledged.manifest.files.find(
        (file) => file.path === `project-queue-history/${first[0].id}.json`,
      );
      assert(archivedClaim);
      assert.deepEqual(
        Buffer.from(await acknowledged.readVerifiedBlob(archivedClaim.ref)),
        await readFile(
          join(
            stateRoot(repository),
            "project-queue-history",
            `${first[0].id}.json`,
          ),
        ),
      );
      // Repair only this disposable fixture by switching to a new branch;
      // the divergent branch and its real original commit remain intact.
      git("switch", "-c", "corrected-source", initial);
      await assert.rejects(
        runObjective(config, 1, services),
        (error) => error === boundary,
      );
      assert.equal(planningBoundary, 1);
      const prepared = readContinuation(repository, 1);
      assert.equal(prepared.baseSha, initial);
      const next = (await readQueueHistory(config)).filter(
        (row) => row.kind === "project-queue-owner",
      );
      assert.equal(next.length, 2);
      assert.equal(
        JSON.stringify(next.find((row) => row.id === first[0].id)),
        settledOriginal,
      );
      const admitted = next.find((row) => row.id !== first[0].id);
      assert.equal(
        admitted.deadlineAt,
        first[0].deadlineAt,
        "source correction cannot renew the original deadline",
      );
      assert.equal(admitted.settled.runId, prepared.runId);
      assert.equal(admitted.runBinding.runId, prepared.runId);
      assert.equal(
        readControllerOwner(objectiveLockPath(repository, 1)),
        undefined,
      );
      return;
    } finally {
      if (originalSsh === undefined) delete process.env.GIT_SSH_COMMAND;
      else process.env.GIT_SSH_COMMAND = originalSsh;
      if (originalVariant === undefined) delete process.env.GIT_SSH_VARIANT;
      else process.env.GIT_SSH_VARIANT = originalVariant;
    }
  }

  const commit = git("rev-parse", "HEAD"),
    treeSha = git("rev-parse", "HEAD^{tree}");
  const item = {
    id: "qa",
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
  const graph = {
    objective: 1,
    baseSha: commit,
    items: [item],
    coverage: [
      {
        criterionId: createHash("sha256")
          .update("git diff is clean.")
          .digest("hex"),
        itemId: item.id,
        source: {
          path: "OBJECTIVE",
          digest: createHash("sha256").update(body).digest("hex"),
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
  const validation = await validateWorkItem(
    checkout,
    join(directory, "validation"),
    item,
    commit,
    treeSha,
    commit,
  );
  const state = {
    schemaVersion: 7,
    repository,
    objective: 1,
    runId: randomUUID(),
    configDigest: factoryConfigDigest(config),
    baseSha: commit,
    objectiveBodyDigest: createHash("sha256").update(body).digest("hex"),
    objectiveCommands: ["git diff --exit-code"],
    graph,
    planGraphDigest: graphDigest(graph),
    publicationContract: "exact-request-v1",
    approvedPlaybookPin: null,
    approvedPlaybookAdmission: {
      approvedPlaybookPin: null,
      configDigest: factoryConfigDigest(config),
      graphDigest: graphDigest(graph),
      packetDigest: "c".repeat(64),
      reviewDigest: "d".repeat(64),
      sourcePacketDigest: "e".repeat(64),
    },
    issueByItemId: { qa: 2 },
    work: {
      qa: {
        status: "done",
        changeRef: commit,
        treeSha,
        githubClosure: "complete",
        validation,
      },
    },
    finalValidation: { ...validation, passed: true },
    autonomy: resolveAutonomy({ allowances: { implementationRepairs: 0 } }),
    capacity: { concurrency: 1 },
    coordinator: {
      mode: "running",
      phase: "idle",
      phaseStartedAt: new Date().toISOString(),
      processes: [],
    },
  };
  // Historical command-only acceptance is sealed from real clean-checkout
  // receipts; this is no model response or claim of provider qualification.
  sealFinalAcceptance(state);
  saveState(statePath(repository, 1), state);
  if (!collectedExecution) {
    // With no service, a live foreground owner executes the installation's
    // queue commands and returns their completion after the terminal archive
    // acknowledgment; the forwarding command publishes nothing itself. The
    // owner runs another provider than the command's default: queue commands
    // bind the queue's authority and default configuration, which every
    // provider of the installation shares.
    const { planning, execution } = config;
    const otherSelection = { ...selection, model: "unused-other-check" };
    const file = Object.fromEntries(
      Object.entries(config).flatMap(([key, value]) =>
        key === "planning"
          ? [
              ["defaultProvider", "codex"],
              [
                "providers",
                {
                  codex: { planning, execution },
                  other: {
                    planning: {
                      ...planning,
                      planner: otherSelection,
                      reviewer: otherSelection,
                    },
                    execution: {
                      ...execution,
                      harness: { ...execution.harness, ...otherSelection },
                    },
                  },
                },
              ],
            ]
          : key === "execution"
            ? []
            : [[key, value]],
      ),
    );
    assert.equal(
      factoryConfigDigest(resolveProvider(file, "codex")),
      factoryConfigDigest(config),
    );
    const other = resolveProvider(file, "other");
    assert.notEqual(factoryConfigDigest(other), factoryConfigDigest(config));
    assert.deepEqual(queueControlBinding(other), queueControlBinding(config));
    // A run started before a shared queue setting changed keeps the old queue
    // authority: it neither receives nor executes this queue's commands.
    const stale = validateConfig({
      ...other,
      queue: { ...other.queue, objectiveDeadlineSeconds: 120 },
    });
    assert.notEqual(
      factoryAuthorityDigest(stale),
      factoryAuthorityDigest(config),
    );
    const staleLock = acquireObjectiveLock(
      repository,
      1,
      queueControlBinding(stale),
    );
    const staleQueue = foregroundQueueControl(stale, github);
    const staleServer = await serveControl(
      repository,
      staleLock,
      (request) => staleQueue(request),
      1,
    );
    let foregroundLock;
    let stop;
    const stopped = new Promise((resolve) => {
      stop = resolve;
    });
    let serving;
    const listening = new Promise((resolve) => {
      serving = resolve;
    });
    let owner;
    try {
      const before = writes;
      await assert.rejects(
        intakeControl(config, "pause", undefined, github),
        /Objective #1 runs with other shared settings .*nothing was sent/,
      );
      // Sent anyway, the stale owner refuses it before any effect.
      await assert.rejects(
        requestForegroundQueueControl(
          repository,
          {
            objective: 0,
            action: "project-queue",
            input: {
              operation: "pause",
              protocol: "project-queue-v1",
              ...queueControlBinding(config),
            },
            command: { id: randomUUID(), deadlineAt: Date.now() + 60_000 },
          },
          {
            deadlineAt: Date.now() + 60_000,
            binding: queueControlBinding(stale),
          },
        ),
        /Project queue control protocol or authority binding differs/,
      );
      assert.equal(writes, before);
      foregroundLock = acquireObjectiveLock(
        repository,
        5,
        queueControlBinding(other),
      );
      owner = withRecoveryCheckpointControllerVerification(
        {
          config: other,
          buildClosure: () => buildRecoveryCheckpointClosure({ config: other }),
        },
        async () => {
          const queue = bindRecoveryCheckpointControllerScope(
            foregroundQueueControl(other, github),
          );
          const server = await serveControl(
            repository,
            foregroundLock,
            (request) => queue(request),
            5,
          );
          serving();
          await stopped;
          await new Promise((resolve) => server.close(resolve));
        },
      );
      await listening;
      const status = await intakeControl(config, "status", undefined, github);
      assert.deepEqual(status.activeObjectives, [1, 5]);
      // The lowest-numbered owner of this queue executes it, past the stale one.
      const paused = await intakeControl(config, "pause", undefined, github);
      assert.equal(paused.mode, "paused");
      assert.equal(paused.configDigest, factoryConfigDigest(config));
      assert.equal(JSON.parse(controlMetadata).mode, "paused");
      assert.equal(writes, before + 1);
      assert.equal(gitPersistenceStatus(config).pendingChanges, false);
      const resumed = await intakeControl(config, "resume", undefined, github);
      assert.equal(resumed.mode, "running");
      // An unchanged admission keeps its place: no Project write.
      const kept = await enqueueIntake(config, github, [1]);
      assert.deepEqual(
        kept.targets.map((target) => [target.objective, target.state]),
        [[1, "queued"]],
      );
      assert.equal(writes, before + 2);
      const history = await readQueueHistory(config);
      assert(
        history.some(
          (record) =>
            record.kind === "project-queue-operation" &&
            record.action === "control" &&
            record.completed &&
            JSON.parse(record.metadata).mode === "paused",
        ),
      );
    } finally {
      stop();
      await owner;
      if (foregroundLock)
        releaseControllerLock(objectiveLockPath(repository, 5), foregroundLock);
      await new Promise((resolve) => staleServer.close(resolve));
      releaseControllerLock(objectiveLockPath(repository, 1), staleLock);
    }
  }
  if (!collectedExecution) {
    // Opting in to concurrent Objectives changes neither digest, so started
    // Objectives and queue receipts stay valid.
    const concurrent = {
      ...config,
      queue: { ...config.queue, maxActiveObjectives: 2 },
    };
    validateConfig(concurrent);
    assert.equal(factoryConfigDigest(concurrent), factoryConfigDigest(config));
    assert.equal(
      factoryAuthorityDigest(concurrent),
      factoryAuthorityDigest(config),
    );
    // Concurrent Objectives see each other through real retained snapshots
    // and live controller locks of another installation identity.
    const shared = `fixture/concurrent-${randomUUID()}`;
    t.after(() => rm(stateRoot(shared), { recursive: true, force: true }));
    const sharedConfig = {
      ...config,
      repository: shared,
      queue: { pollSeconds: 1, maxActiveObjectives: 2 },
    };
    delete sharedConfig.gitPersistence;
    const planned = (objective, ownedPaths) => {
      const next = structuredClone(state);
      Object.assign(next, {
        repository: shared,
        objective,
        runId: randomUUID(),
      });
      for (const key of [
        "finalAcceptance",
        "finalValidation",
        "objectiveClosure",
      ])
        delete next[key];
      next.graph = {
        ...next.graph,
        objective,
        items: [
          {
            ...next.graph.items[0],
            id: "code",
            kind: "work",
            title: "Change owned files",
            ownedPaths,
          },
          { ...next.graph.items[0], dependencies: ["code"] },
        ],
      };
      next.planGraphDigest = graphDigest(next.graph);
      next.approvedPlaybookAdmission.graphDigest = next.planGraphDigest;
      next.work = { qa: { status: "pending" }, code: { status: "pending" } };
      next.issueByItemId = { code: 3, qa: 2 };
      next.capacity = {
        concurrency: 1,
        scheduling: { validationConcurrency: 1 },
      };
      saveState(statePath(shared, objective), next);
      return next;
    };
    const first = planned(2, ["src/"]),
      overlapping = planned(3, ["src/a.ts", "README.md"]),
      disjoint = planned(4, ["docs/"]);
    assert.equal(admitExecution(sharedConfig, first), undefined);
    assert.deepEqual(admitExecution(sharedConfig, overlapping), {
      objective: 2,
      paths: ["src/a.ts"],
    });
    assert.deepEqual(plannedExecutionConflict(sharedConfig, overlapping), {
      objective: 2,
      paths: ["src/a.ts"],
    });
    assert.equal(admitExecution(sharedConfig, disjoint), undefined);
    // The earlier admission keeps running when re-admitted at its next pass.
    assert.equal(admitExecution(sharedConfig, first), undefined);
    // A path an amendment adds yields to a later admission that owns it.
    const amended = structuredClone(first);
    amended.graph.items[0].ownedPaths = ["src/", "docs/guide.md"];
    assert.deepEqual(admitExecution(sharedConfig, amended), {
      objective: 4,
      paths: ["docs/guide.md"],
    });
    // Two amendments onto each other's paths: the later one, now waiting
    // itself, no longer holds the earlier one, which goes first.
    const crossed = structuredClone(disjoint);
    crossed.graph.items[0].ownedPaths = ["docs/", "src/x.ts"];
    assert.deepEqual(admitExecution(sharedConfig, crossed), {
      objective: 2,
      paths: ["src/x.ts"],
    });
    assert.equal(admitExecution(sharedConfig, amended), undefined);
    assert.deepEqual(admitExecution(sharedConfig, crossed)?.objective, 2);
    // Host capacity: another live controller's reservation fills the ceiling.
    const firstLock = acquireObjectiveLock(shared, 2),
      secondLock = acquireObjectiveLock(shared, 4);
    try {
      const firstCapacity = sharedCapacity(sharedConfig, 2, firstLock.token);
      firstCapacity.publish(["validation"], []);
      const capacity = sharedCapacity(sharedConfig, 4, secondLock.token);
      assert.deepEqual(capacity.others(), {
        reserved: ["validation"],
        pending: [],
      });
      const phases = phaseAdmission(
        disjoint,
        () => undefined,
        () => false,
        capacity,
      );
      assert.equal(phases.blocker("code", "validation")?.kind, "concurrency");
      assert.equal(phases.blocker("code", "coding"), undefined);
      // An older request of the other controller goes first.
      firstCapacity.publish(
        [],
        [{ phase: "validation", requestedAt: Date.now() - 1000 }],
      );
      assert.equal(phases.blocker("code", "validation")?.kind, "concurrency");
      assert.equal(phases.blocker("code", "review"), undefined);
      releaseControllerLock(objectiveLockPath(shared, 2), firstLock);
      assert.deepEqual(capacity.others(), { reserved: [], pending: [] });
      assert.equal(phases.blocker("code", "validation"), undefined);
    } finally {
      releaseControllerLock(objectiveLockPath(shared, 4), secondLock);
      if (readControllerOwner(objectiveLockPath(shared, 2)))
        releaseControllerLock(objectiveLockPath(shared, 2), firstLock);
    }
    // A finished Objective releases its paths.
    first.cancelRequested = true;
    first.cancelledAt = new Date().toISOString();
    saveState(statePath(shared, 2), first);
    assert.equal(admitExecution(sharedConfig, overlapping), undefined);
  }
  // Exercise the actual intake eligibility seam against real Git. An empty
  // native dependency set has no base-dependent eligibility, while the
  // predecessor path still fetches and proves accepted ancestry before alignment.
  let sourceReads = 0;
  const sourceGithub = {
    ...github,
    async defaultBranch() {
      sourceReads++;
      return "main";
    },
  };
  await resolveIntakeBase(config, sourceGithub, [], 2);
  assert.equal(sourceReads, 0);
  await writeFile(join(checkout, "dirty.txt"), "preserve this actual change\n");
  await assert.rejects(
    resolveIntakeBase(config, sourceGithub, [], 2),
    /local changes/,
  );
  assert.equal(sourceReads, 0);
  await rm(join(checkout, "dirty.txt"));
  const sealed = JSON.stringify(state.finalAcceptance);
  const contentStore = new LocalContentStore(
    join(stateRoot(repository), "content"),
  );
  const memory = new LocalRepositoryMemory(
    stateRoot(repository),
    repository,
    contentStore,
  );
  const source = contentStore.putBytes(
    Buffer.from("Actual new public fixture observation\n"),
    { mediaType: "text/plain" },
  );
  const originalReferences = LocalContentStore.prototype.checkpointReferences;
  let injected = false;
  let lateMemory;
  let previousAck;
  LocalContentStore.prototype.checkpointReferences = function (description) {
    if (
      !injected &&
      card.state === "closed" &&
      JSON.parse(description)[0] === "memory-learning-producer"
    ) {
      injected = true;
      previousAck = gitPersistenceStatus(config).lastAcknowledged;
      lateMemory = memory.retain({
        schemaVersion: 1,
        repository,
        visibility: "repository",
        kind: "reference",
        producer: { objective: 1, runId: state.runId, status: "observed" },
        createdAt: new Date().toISOString(),
        authority: "observation",
        summary: "A real late source original",
        bodies: [{ role: "notes", ref: source, availability: "retained" }],
        sources: [
          { identity: "fixture:late-source", complete: true, ref: source },
        ],
        bindings: {},
        validity: { state: "current", conditions: [] },
        supersedes: [],
      });
    }
    return Reflect.apply(originalReferences, this, [description]);
  };
  const services = {
    github,
    contentStore,
    planningModel: new CodexPlanningModel(checkout, selection, selection),
    driver: new LocalExecutionDriver(
      checkout,
      join(directory, "worktrees"),
      new CodexHarness(join(directory, "credentials"), "off", selection),
      1,
      contentStore,
      "codex",
    ),
    delivery: new RegularDelivery(checkout, github),
  };
  let running;
  try {
    running = runIntake(config, services, {
      backgroundConfigurationPath: join(directory, "config.json"),
    });
    const deadline = Date.now() + 15_000;
    let status;
    do {
      await new Promise((resolve) => setTimeout(resolve, 20));
      status = await requestControl(repository, {
        objective: 0,
        action: "status",
      }).catch((error) => {
        if (error.code === "ENOENT") return { handled: false };
        throw error;
      });
    } while (
      (!status.handled || !status.result.observation?.error) &&
      Date.now() < deadline
    );
    assert.equal(status.handled, true);
    assert.match(status.result.observation.error, /memory \(memory\/records\)/);
    assert.equal(status.result.localMode, "paused");
    assert.equal(status.result.activeObjective, null);
    // `factory decide` reaches the held service (#1290): it checks the
    // forwarded input before any state, then applies the ordinary decision
    // checks itself instead of refusing a stopped Objective's lifecycle.
    await assert.rejects(
      requestControl(repository, { objective: 1, action: "decide", input: {} }),
      /Forwarded decision lacks its outcome, actor or reason/,
    );
    await assert.rejects(
      requestControl(repository, {
        objective: 1,
        action: "decide",
        input: { outcome: "accept", actor: "fixture", reason: "fixture" },
      }),
      /Objective is not awaiting a result decision/,
    );
    assert.equal(injected, true);
    assert.equal(readState(repository, 1).objectiveClosure, "complete");
    assert.equal(
      JSON.stringify(readState(repository, 1).finalAcceptance),
      sealed,
    );
    const held = gitPersistenceStatus(config),
      heldReads = reads,
      heldWrites = writes;
    assert.equal(held.pendingChanges, true);
    assert.equal(held.protectedContinuation, false);
    assert.equal(held.status, "failed");
    assert.match(held.error, /memory \(memory\/records\)/);
    assert.deepEqual(held.lastAcknowledged, previousAck);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(reads, heldReads);
    assert.equal(writes, heldWrites);
    assert.deepEqual(gitPersistenceStatus(config), held);
    await intakeControl(config, "resume", undefined, github);
    const recovered = gitPersistenceStatus(config);
    assert.equal(recovered.protectedContinuation, true);
    const archive = await readVerifiedRecoveryCheckpoint(config);
    assert.equal(archive.commitSha, recovered.lastAcknowledged.commitSha);
    assert(
      archive.manifest.contentRefs.some(
        (ref) => ref.digest === lateMemory.manifestRef.digest,
      ),
    );
    assert.deepEqual(
      Buffer.from(await archive.readVerifiedBlob(lateMemory.manifestRef)),
      contentStore.readBytes(lateMemory.manifestRef),
    );
    const resumed = await requestControl(repository, {
      objective: 0,
      action: "status",
    });
    assert.equal(resumed.result.localMode, undefined);
    assert.equal(resumed.result.observation?.error, undefined);
    assert.equal(
      JSON.stringify(readState(repository, 1).finalAcceptance),
      sealed,
    );
    await intakeControl(config, "drain", undefined, github);
    await running;
    assert.equal(
      readControllerOwner(installationLockPath(repository)),
      undefined,
    );
    const sourceRemote = join(directory, "source.git"),
      sourceClone = join(directory, "source-clone");
    execFileSync("git", ["init", "--bare", "-b", "main", sourceRemote], {
      stdio: "ignore",
    });
    git("push", sourceRemote, "HEAD:main");
    execFileSync("git", ["clone", sourceRemote, sourceClone], {
      stdio: "ignore",
    });
    const sourceConfig = { ...config, checkout: sourceClone };
    const priorLocalOrigins = process.env.FACTORY_TEST_LOCAL_ORIGINS;
    process.env.FACTORY_TEST_LOCAL_ORIGINS = "1";
    try {
      await resolveIntakeBase(sourceConfig, sourceGithub, [1], 2);
      assert.equal(sourceReads, 1);
      assert.equal(
        execFileSync("git", ["-C", sourceClone, "rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim(),
        commit,
      );
      await assert.rejects(
        resolveIntakeBase(sourceConfig, sourceGithub, [999], 2),
        /lacks bound accepted candidate evidence/,
      );
      assert.equal(sourceReads, 2);
    } finally {
      if (priorLocalOrigins === undefined)
        delete process.env.FACTORY_TEST_LOCAL_ORIGINS;
      else process.env.FACTORY_TEST_LOCAL_ORIGINS = priorLocalOrigins;
    }
    if (!preSnapshotFailure && !collectedExecution) {
      // A queued-settings change leaves the completed Objective's settled
      // admission historical: re-authorizing the control alone makes the
      // queue readable again, without withdrawing its card (#1398).
      const reauthorized = {
        ...config,
        autonomy: { allowances: { implementationRepairs: 0 } },
      };
      assert.notEqual(
        factoryAuthorityDigest(reauthorized),
        factoryAuthorityDigest(config),
      );
      // Until then the control receipt authorizes nothing, and a starting
      // service waits for that re-authorization rather than failing (#1305).
      await assert.rejects(
        observeProjectQueue(reauthorized, github),
        QueueAuthorityChanged,
      );
      await intakeControl(reauthorized, "resume", undefined, github);
      const historical = await observeProjectQueue(reauthorized, github);
      assert.deepEqual(
        historical.entries.map((entry) => [entry.objective, entry.state]),
        [[1, "queued"]],
      );
      assert.equal(
        historical.entries[0].authorityDigest,
        factoryAuthorityDigest(config),
      );
      // No current admission binds that card: the listing marks it inert (#1697).
      assert.deepEqual(
        (await intakeControl(reauthorized, "sync", undefined, github)).inert,
        [1],
      );
      await intakeControl(config, "drain", undefined, github);
      // A foreground removal returns its Project effect, then another
      // publisher holds the archive acknowledgment past the command deadline.
      const writesBefore = writes;
      holdArchiveAfterWrite = true;
      const incomplete = await withIntakeCommandDeadline(
        Date.now() + 4000,
        () => intakeControl(config, "dequeue", [1], github),
      ).then(
        () =>
          assert.fail("a held archive acknowledgment completed the command"),
        (error) => error,
      );
      try {
        assert(incomplete instanceof ControllerCommandIncompleteError);
        assert.equal(incomplete.requestId, undefined);
        assert.equal(writes, writesBefore + 1);
        assert.equal(JSON.parse(card.metadata).state, "withdrawn");
        assert.equal(incomplete.returned.operations.length, 1);
        assert.equal(incomplete.returned.operations[0].action, "withdraw");
        assert.equal(incomplete.returned.operations[0].objective, 1);
        assert.equal(incomplete.returned.durability.pendingChanges, true);
        assert.notEqual(incomplete.returned.durability.status, "acknowledged");
        assert.equal(incomplete.returned.acknowledged, false);
        assert.match(incomplete.message, /not acknowledged.*Do not repeat it/);
      } finally {
        await archiveHolder?.release();
        archiveHolder = undefined;
      }
      // The supported explicit synchronization acknowledges the retained bytes
      // without replaying the returned mutation.
      const acknowledged = await synchronizeRecoveryCheckpoint(config, {
        reason: "explicit",
      });
      assert.equal(acknowledged.status, "acknowledged");
      assert.equal(acknowledged.pendingChanges, false);
      assert.equal(writes, writesBefore + 1);
      assert(
        (await readQueueHistory(config)).some(
          (record) =>
            record.id === incomplete.returned.operations[0].id &&
            record.completed,
        ),
      );
      // A withdrawn card is inert: removal deletes it from the Project, once.
      const removed = await intakeControl(config, "dequeue", [1], github);
      assert.deepEqual(
        removed.targets.map((target) => [target.objective, target.state]),
        [[1, "removed"]],
      );
      assert.equal(writes, writesBefore + 2);
      await assert.rejects(
        intakeControl(config, "dequeue", [1], github),
        /Objective #1 is not admitted/,
      );
    }
  } finally {
    LocalContentStore.prototype.checkpointReferences = originalReferences;
    if (running) {
      process.emit("SIGTERM");
      await running.catch(() => undefined);
    }
  }
}

/** Another controller process: holds the lock in `mode` until told to let go. */
async function holder(key, mode, publication = false) {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { withRegistryFiles, withCheckpointPublication } from ${JSON.stringify(processUrl)};
       const body = async () => {
         process.stdout.write("held\\n");
         await new Promise((resolve) => process.stdin.once("data", resolve));
       };
       await ${publication ? `withCheckpointPublication(${JSON.stringify(key)}, body)` : `withRegistryFiles(${JSON.stringify(key)}, ${JSON.stringify(mode)}, undefined, body)`};
       process.exit(0);`,
    ],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  child.stdout.setEncoding("utf8");
  let output = "";
  const seen = (line) =>
    new Promise((resolve) => {
      const check = () => output.includes(line) && resolve();
      child.stdout.on("data", (part) => {
        output += part;
        check();
      });
      check();
    });
  await seen("held");
  return {
    release: async () => {
      child.stdin.write("go\n");
      await once(child, "exit");
    },
    kill: async () => {
      child.kill("SIGKILL");
      await once(child, "exit");
    },
  };
}

/** Whether this process's command ran within `ms` while the other held the lock. */
async function ranWithin(key, mode, ms) {
  let ran = false;
  const command = withRegistryFiles(key, mode, undefined, async () => {
    ran = true;
  });
  await new Promise((resolve) => setTimeout(resolve, ms));
  return { ran, command };
}

test("the worktree registry lock holds across processes: exclusive excludes the other, shared readers share", async () => {
  const key = `/registry-${process.pid}-${Date.now()}`;

  // Another process changes the registry: this process neither reads nor changes it.
  let other = await holder(key, "exclusive");
  const reader = await ranWithin(key, "shared", 200);
  const changer = await ranWithin(key, "exclusive", 200);
  assert.equal(reader.ran, false);
  assert.equal(changer.ran, false);
  await other.release();
  await Promise.all([reader.command, changer.command]);

  // Another process reads the registry: this process reads too, but does not change it.
  other = await holder(key, "shared");
  assert.equal((await ranWithin(key, "shared", 200)).ran, true);
  const writer = await ranWithin(key, "exclusive", 200);
  assert.equal(writer.ran, false);
  await other.release();
  await writer.command;

  // A holder that crashed leaves a stale file, which no longer excludes anyone.
  other = await holder(key, "exclusive");
  await other.kill();
  await withRegistryFiles(key, "exclusive", undefined, async () => undefined);
});

test("the actual creating lease settles only a fresh failed reservation and archives exact originals without a canonical run", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "factory-reservation-failure-"),
  );
  const repository = `fixture/reservation-${randomUUID()}`;
  const checkout = join(directory, "target"),
    remote = join(directory, "archive.git");
  await mkdir(checkout);
  const git = (...args) =>
    execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).trim();
  git("init", "-b", "main");
  git("remote", "add", "origin", `https://github.com/${repository}.git`);
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "--allow-empty",
    "-m",
    "public fixture baseline",
  );
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  const selection = { model: "unused-local-check", reasoningEffort: "low" };
  const config = {
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
      project: {
        repository,
        projectId: "PVT_storage",
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
  };
  validateConfig(config);
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  // A genuine archive destination failure precedes admission and every Project
  // intent. Retain its failed singleton recipe instead of poisoning later control.
  await mkdir(stateRoot(repository), { recursive: true, mode: 0o700 });
  const controlStore = new LocalContentStore(
    join(stateRoot(repository), "content"),
  );
  await withRecoveryCheckpointScope(
    { config, buildClosure: () => buildRecoveryCheckpointClosure({ config }) },
    async () => {
      const operation = createQueueOperation(config, {
        action: "control",
        scope: "control",
        previousReceiptId: null,
        approval: { kind: "queue-command" },
      });
      operation.metadata = JSON.stringify({
        schemaVersion: 1,
        kind: "control",
        receiptId: operation.id,
        mode: "paused",
        watch: true,
      });
      const step = createProjectQueuePlannedEffect(config.queue.project, {
        operationId: operation.id,
        requestId: randomUUID(),
        actorId: 1,
        action: "set-metadata",
        target: { itemId: config.queue.project.controlItemId },
        fieldId: config.queue.project.metadataFieldId,
        metadata: operation.metadata,
        prior: {
          target: {
            itemId: config.queue.project.controlItemId,
            metadata: null,
          },
        },
        control: { metadata: null },
      });
      const command = createQueueCommand(config, {
        operations: [operation],
        effects: [step],
        deadlineAt: null,
      });
      const originalControl = await readFile(
        join(
          stateRoot(repository),
          "project-queue-history",
          `${operation.id}.json`,
        ),
      );
      await rename(remote, `${remote}.unavailable`);
      try {
        await assert.rejects(admitQueueCommand(config, command), /ENOENT/);
      } finally {
        await rename(`${remote}.unavailable`, remote);
      }
      assert.deepEqual(
        Buffer.from(
          controlStore.readBytes(
            operation.beforeEffectFailure.originalOperation,
          ),
        ),
        originalControl,
      );
      assert.equal(operation.effects.length, 0);
      assert(operation.beforeEffectFailure);
      assert.equal(
        JSON.parse(
          controlStore
            .readBytes(operation.beforeEffectFailure.error)
            .toString(),
        ).kind,
        "creating-owner-before-command-refusal",
      );
      await assert.rejects(admitQueueCommand(config, command), /never replay/);
      await awaitCheckpointAdmission(repository, "explicit");
      assertQueueOperationReferenceBodies(operation, (ref) =>
        controlStore.readBytes(ref),
      );
      assert.equal(
        retainedQueueEntry(config, await readQueueHistory(config), 1),
        undefined,
      );
      const inspection = {
        scope: "target",
        binding: config.queue.project,
        observedAt: new Date().toISOString(),
        actorId: 1,
        owner: "Fixture",
        control: { itemId: config.queue.project.controlItemId, metadata: null },
      };
      assert.equal(
        verifyQueueInspection(
          config,
          inspection,
          await readQueueHistory(config),
          { allowUninitializedControl: true },
        ).uninitializedControl,
        true,
        "a positively failed initial control has no successful producer to supersede",
      );
      assert.throws(
        () =>
          verifyQueueInspection(
            config,
            inspection,
            [parseQueueRecord(originalControl, repository, operation.id)],
            { allowUninitializedControl: true },
          ),
        /partial or unknown/,
        "a historical empty header alone remains fenced",
      );
    },
  );
  const lock = acquireObjectiveLock(repository, 1);
  let lockReleased = false;
  try {
    // This is an original reservation/storage test, not a fabricated remote
    // admission or a claim that any provider or GitHub write ran.
    const claim = {
      schemaVersion: 1,
      kind: "project-queue-owner",
      id: randomUUID(),
      repository,
      authorityDigest: factoryAuthorityDigest(config),
      admissionId: randomUUID(),
      receiptId: randomUUID(),
      objective: 1,
      bodyDigest: hash("original approved body"),
      ownerTokenDigest: hash(lock.token),
      ownerProcess: {
        ...ownIdentity(),
        namespace: readlinkSync("/proc/self/ns/pid"),
      },
      at: new Date().toISOString(),
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const history = join(stateRoot(repository), "project-queue-history");
    await mkdir(history, { recursive: true, mode: 0o700 });
    const path = join(history, `${claim.id}.json`),
      original = Buffer.from(`${JSON.stringify(claim)}\n`);
    await writeFile(path, original, { mode: 0o600 });
    const error = new Error("original before-effect failure");
    const buildClosure = () =>
      buildRecoveryCheckpointClosure({
        config,
        scope: "private-history",
      });
    await withRecoveryCheckpointScope({ config, buildClosure }, async () => {
      await assert.rejects(
        settleFailedProjectQueueReservation(
          config,
          claim,
          "foreign-token",
          error,
        ),
        /creating controller lease/,
      );
      const foreign = structuredClone(claim);
      foreign.ownerProcess.startTime = "1";
      await assert.rejects(
        settleFailedProjectQueueReservation(config, foreign, lock.token, error),
        /same creating owner/,
      );
      await writeFile(
        statePath(repository, 1),
        '{"schemaVersion":18,"kind":"preparing"}\n',
        { mode: 0o600 },
      );
      await assert.rejects(
        settleFailedProjectQueueReservation(config, claim, lock.token, error),
      );
      await rm(statePath(repository, 1));
      assert.deepEqual(await readFile(path), original);
      await settleFailedProjectQueueReservation(
        config,
        claim,
        lock.token,
        error,
      );
    });
    assert.equal(claim.settled.runId, undefined);
    assert.equal(claim.runBinding, undefined);
    assert.equal(claim.settled.disposition, "quiescent");
    const store = new LocalContentStore(join(stateRoot(repository), "content"));
    const proof = claim.settled.reservationFailure;
    assert.deepEqual(
      Buffer.from(store.readBytes(proof.originalClaim)),
      original,
    );
    assert.equal(
      JSON.parse(Buffer.from(store.readBytes(proof.failure)).toString()),
      error.stack,
    );
    await authenticateQueueOwnerReferences(claim, async (ref) =>
      store.readBytes(ref),
    );
    await withRecoveryCheckpointControllerVerification(
      { config, buildClosure },
      async () => {
        const verified = await buildClosure();
        assert.deepEqual(await buildClosure(), verified);
        const failurePath = join(
          stateRoot(repository),
          "content",
          proof.failure.digest.slice(0, 2),
          proof.failure.digest,
        );
        const failureBytes = await readFile(failurePath);
        try {
          await writeFile(
            failurePath,
            Buffer.concat([failureBytes, Buffer.from("x")]),
          );
          await assert.rejects(buildClosure(), /size|digest|exact|reference/i);
        } finally {
          await writeFile(failurePath, failureBytes);
        }
        assert.deepEqual(await buildClosure(), verified);
        const ownedBase = await readVerifiedRecoveryCheckpoint(config);
        const offset = (await readFile(diagnosticPath(repository, 0))).length;
        for (let index = 0; index < 2; index++) {
          markCheckpointDirty(repository, {
            path: `project-queue-history/${claim.id}.json`,
            kind: "historical",
          });
          await awaitCheckpointAdmission(repository, "before-effect");
        }
        const events = (await readFile(diagnosticPath(repository, 0)))
          .subarray(offset)
          .toString("utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const completed = events.filter(
          (event) => event.outcome === "completed",
        );
        const transports = completed.filter(
          (event) => event.operation === "recovery-checkpoint-transport",
        );
        assert.equal(
          transports.filter((event) => event.metadata.kind === "ls-remote")
            .length,
          2,
        );
        assert.equal(
          transports.filter((event) => event.metadata.kind === "fetch").length,
          2,
          "only the mandatory independently fetched candidate ACK remains per warm push",
        );
        assert.equal(
          transports.filter((event) => event.metadata.kind === "push").length,
          2,
        );
        for (const event of transports.filter(
          (event) => event.metadata.kind === "push",
        )) {
          assert.equal(event.metadata.trace2, "observed");
          assert(event.metadata.maxGitChildWallMs >= 0);
          assert.equal(
            JSON.stringify(event.metadata).includes(directory),
            false,
          );
        }
        const parents = completed.filter(
          (event) =>
            event.operation === "recovery-checkpoint-publication-parent",
        );
        assert.equal(parents.length, 2);
        assert(parents.every((event) => event.metadata.reused));
        for (const event of [...transports, ...parents]) {
          assert(event.durationMs >= 0);
          assert(event.metadata.parentCpuUserUs >= 0);
          assert(event.metadata.parentCpuSystemUs >= 0);
          assert.equal(event.metadata.parentCpuScope, "process-wide-interval");
          assert.equal(event.metadata.childCpu, "unavailable");
        }
        const publisher = join(stateRoot(repository), "recovery", "git.git");
        const objectPath = join(
          publisher,
          "objects",
          ownedBase.commitSha.slice(0, 2),
          ownedBase.commitSha.slice(2),
        );
        // Git freshens an object it is asked to write again (this or another
        // Factory process sharing the publisher). That only re-authenticates
        // the parent's bodies; the warm publication still completes.
        execFileSync(
          "git",
          [
            `--git-dir=${publisher}`,
            "hash-object",
            "-w",
            "-t",
            "commit",
            "--stdin",
          ],
          {
            input: execFileSync("git", [
              `--git-dir=${publisher}`,
              "cat-file",
              "commit",
              ownedBase.commitSha,
            ]),
          },
        );
        const freshenedOffset = (await readFile(diagnosticPath(repository, 0)))
          .length;
        markCheckpointDirty(repository, {
          path: `project-queue-history/${claim.id}.json`,
          kind: "historical",
        });
        await awaitCheckpointAdmission(repository, "before-effect");
        const freshenedParents = (await readFile(diagnosticPath(repository, 0)))
          .subarray(freshenedOffset)
          .toString("utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
          .filter(
            (event) =>
              event.outcome === "completed" &&
              event.operation === "recovery-checkpoint-publication-parent",
          );
        assert.equal(freshenedParents.length, 1);
        assert(freshenedParents[0].metadata.reused);
        const bytes = await readFile(objectPath),
          mode = (await stat(objectPath)).mode & 0o777;
        try {
          await chmod(objectPath, 0o600);
          await writeFile(objectPath, Buffer.concat([bytes, Buffer.from("x")]));
          await chmod(objectPath, mode);
          markCheckpointDirty(repository, {
            path: `project-queue-history/${claim.id}.json`,
            kind: "historical",
          });
          const before = execFileSync(
            "git",
            [`--git-dir=${remote}`, "rev-parse", config.gitPersistence.ref],
            { encoding: "utf8" },
          ).trim();
          await assert.rejects(
            awaitCheckpointAdmission(repository, "before-effect"),
            /altered or missing object material/,
          );
          assert.equal(
            execFileSync(
              "git",
              [`--git-dir=${remote}`, "rev-parse", config.gitPersistence.ref],
              { encoding: "utf8" },
            ).trim(),
            before,
          );
        } finally {
          await chmod(objectPath, 0o600);
          await writeFile(objectPath, bytes);
          await chmod(objectPath, mode);
        }
      },
    );
    const forged = structuredClone(claim);
    forged.deadlineAt = new Date(Date.now() + 120_000).toISOString();
    await assert.rejects(
      authenticateQueueOwnerReferences(forged, async (ref) =>
        store.readBytes(ref),
      ),
      /exact original claim/,
    );
    const archive = await readVerifiedRecoveryCheckpoint(config);
    assert.equal(archive.manifest.gaps.length, 0);
    assert.equal(
      archive.manifest.files.some(
        (file) => file.path === "objectives/1/state.json",
      ),
      false,
    );
    for (const ref of [proof.originalClaim, proof.failure])
      assert.deepEqual(
        Buffer.from(await archive.readVerifiedBlob(ref)),
        Buffer.from(store.readBytes(ref)),
      );
    // A retained intent is not a remote outcome. Archive a genuine local original
    // through Git, then prove a later authority cannot ignore its unknown effect.
    // No gateway, submitted mutation, response or operator retirement is fabricated.
    const operationId = randomUUID(),
      requestId = randomUUID();
    const metadata = JSON.stringify({
      schemaVersion: 1,
      kind: "admission",
      admissionId: claim.admissionId,
      receiptId: operationId,
      state: "withdrawn",
    });
    const binding = config.queue.project;
    const header = {
      schemaVersion: 1,
      kind: "project-queue-operation",
      id: operationId,
      repository,
      binding,
      authorityDigest: "1".repeat(64),
      at: new Date().toISOString(),
      action: "withdraw",
      approval: { kind: "queue-command" },
      scope: "I_storage",
      previousReceiptId: claim.receiptId,
      objective: 1,
      issueNodeId: "I_storage",
      bodyDigest: claim.bodyDigest,
      order: 1,
      metadata,
    };
    const planned = createProjectQueuePlannedEffect(binding, {
      operationId,
      requestId,
      actorId: 1,
      action: "set-metadata",
      target: { itemId: "PVTI_storage" },
      fieldId: binding.metadataFieldId,
      metadata,
      prior: { target: { itemId: "PVTI_storage", metadata: null } },
      control: { metadata: null },
    });
    const unknown = {
      ...header,
      effects: [
        {
          intent: {
            binding,
            requestId,
            actorId: 1,
            observedAt: new Date().toISOString(),
            action: "set-metadata",
            itemId: "PVTI_storage",
            metadata,
            fieldId: binding.metadataFieldId,
            request: {
              query: UPDATE,
              variables: {
                input: {
                  clientMutationId: requestId,
                  projectId: binding.projectId,
                  itemId: "PVTI_storage",
                  fieldId: binding.metadataFieldId,
                  value: { text: metadata },
                },
              },
            },
          },
        },
      ],
      commandId: operationId,
      commandRecipe: {
        schemaVersion: 1,
        id: operationId,
        configDigest: "1".repeat(64),
        deadlineAt: null,
        operations: [header],
        effects: [planned],
      },
    };
    const unknownBytes = Buffer.from(`${JSON.stringify(unknown)}\n`);
    await withRecoveryCheckpointScope({ config, buildClosure }, async () => {
      await writeFile(join(history, `${operationId}.json`), unknownBytes, {
        mode: 0o600,
      });
      markCheckpointDirty(repository, {
        path: `project-queue-history/${operationId}.json`,
        kind: "historical",
      });
      await awaitCheckpointAdmission(repository, "explicit");
    });
    const restoredHistory = await readQueueHistory(config);
    assert.deepEqual(
      restoredHistory.find((row) => row.id === operationId),
      unknown,
    );
    const independent = await readQueueHistory(config);
    independent.find((row) => row.id === operationId).completed =
      new Date().toISOString();
    assert.deepEqual(
      (await readQueueHistory(config)).find((row) => row.id === operationId),
      unknown,
    );
    assert.throws(
      () => retainedQueueEntry(config, restoredHistory, 1),
      /partial or unknown/,
    );
    const restoredArchive = await readVerifiedRecoveryCheckpoint(config);
    const originalFile = restoredArchive.manifest.files.find(
      (file) => file.path === `project-queue-history/${operationId}.json`,
    );
    assert.deepEqual(
      Buffer.from(await restoredArchive.readVerifiedBlob(originalFile.ref)),
      unknownBytes,
    );
    assert.equal(
      restoredHistory.find((row) => row.id === operationId).completed,
      undefined,
    );
    assert.equal(
      restoredHistory.find((row) => row.id === operationId).beforeEffectFailure,
      undefined,
    );

    // One exact-ref fetch observes the current tip, while a selected older
    // checkpoint must still be its authenticated ancestor. Neither a previous
    // FETCH_HEAD nor the publisher's local objects supply read authority.
    await withRecoveryCheckpointControllerVerification(
      { config, buildClosure },
      async () => {
        const offset = (await readFile(diagnosticPath(repository, 0))).length;
        const selected = await readVerifiedRecoveryCheckpoint(
          config,
          archive.commitSha,
        );
        assert.notEqual(archive.commitSha, restoredArchive.commitSha);
        assert.equal(selected.commitSha, archive.commitSha);
        assert.equal(selected.remoteTip, restoredArchive.commitSha);
        const events = (await readFile(diagnosticPath(repository, 0)))
          .subarray(offset)
          .toString("utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
          .filter((event) => event.operation === "recovery-checkpoint-archive");
        assert.equal(
          events.filter(
            (event) =>
              event.metadata.phase === "fetch" && event.outcome === "started",
          ).length,
          1,
        );
        assert.equal(
          events.some((event) => event.metadata.phase === "remote-tip"),
          false,
        );
        const recovery = join(stateRoot(repository), "recovery");
        const verifier = async () => {
          const names = (await readdir(recovery)).filter(
            (name) => name.startsWith("verify-") && name.endsWith(".git"),
          );
          assert.equal(names.length, 1);
          return join(recovery, names[0]);
        };
        const staleHead = await readFile(join(await verifier(), "FETCH_HEAD"));
        assert(staleHead.toString().startsWith(restoredArchive.commitSha));
        execFileSync("git", [
          `--git-dir=${remote}`,
          "update-ref",
          "-d",
          config.gitPersistence.ref,
          restoredArchive.commitSha,
        ]);
        const missingOffset = (await readFile(diagnosticPath(repository, 0)))
          .length;
        try {
          await assert.rejects(
            readVerifiedRecoveryCheckpoint(config),
            /Bounded Git archive transport command failed/,
          );
          const missingEvents = (await readFile(diagnosticPath(repository, 0)))
            .subarray(missingOffset)
            .toString("utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
            .filter(
              (event) => event.operation === "recovery-checkpoint-archive",
            );
          assert(
            missingEvents.some(
              (event) =>
                event.metadata.phase === "fetch" && event.outcome === "failed",
            ),
          );
          assert.equal(
            missingEvents.some(
              (event) => event.metadata.phase === "fetched-material",
            ),
            false,
            "a failed fetch cannot inspect or accept its stale FETCH_HEAD",
          );
        } finally {
          execFileSync("git", [
            `--git-dir=${remote}`,
            "update-ref",
            config.gitPersistence.ref,
            restoredArchive.commitSha,
          ]);
        }
        assert.equal(
          (await readVerifiedRecoveryCheckpoint(config)).commitSha,
          restoredArchive.commitSha,
        );
        await assert.rejects(
          readVerifiedRecoveryCheckpoint(config, git("rev-parse", "HEAD")),
          /is not in the remote archive/,
        );
        const changedBinding = structuredClone(config);
        changedBinding.gitPersistence.ref = "refs/heads/another-history";
        await assert.rejects(
          readVerifiedRecoveryCheckpoint(changedBinding),
          /different admitted binding|admitted binding changed/,
        );

        await readVerifiedRecoveryCheckpoint(config);
        const objectRoot = join(await verifier(), "objects");
        const objects = await readdir(objectRoot, {
          recursive: true,
          withFileTypes: true,
        });
        const object = objects.find(
          (entry) => entry.isFile() && !entry.parentPath.endsWith("/info"),
        );
        assert(object);
        const objectPath = join(object.parentPath, object.name);
        const bytes = await readFile(objectPath);
        const mode = (await stat(objectPath)).mode & 0o777;
        await chmod(objectPath, 0o600);
        await writeFile(objectPath, Buffer.concat([bytes, Buffer.from("x")]));
        await chmod(objectPath, mode);
        await assert.rejects(
          readVerifiedRecoveryCheckpoint(config),
          /altered or missing object material/,
        );
        assert.equal(
          (await readVerifiedRecoveryCheckpoint(config)).commitSha,
          restoredArchive.commitSha,
          "a failed owned verifier is discarded before a fresh strict read",
        );
      },
    );

    // Freeze a whole multi-target removal as real local records, then archive it
    // through the real Git checkpoint. No remote response or completion is invented.
    await withRecoveryCheckpointScope({ config, buildClosure }, async () => {
      const removals = [2, 3].map((objective) => {
        const operation = createQueueOperation(config, {
          action: "withdraw",
          scope: `I_${objective}`,
          previousReceiptId: randomUUID(),
          approval: { kind: "queue-command" },
          objective,
          issueNodeId: `I_${objective}`,
          bodyDigest: hash(`body ${objective}`),
          order: objective,
        });
        operation.metadata = JSON.stringify({
          schemaVersion: 1,
          kind: "admission",
          admissionId: randomUUID(),
          receiptId: operation.id,
          state: "withdrawn",
        });
        return operation;
      });
      const removalEffects = removals.map((operation) =>
        createProjectQueuePlannedEffect(binding, {
          operationId: operation.id,
          requestId: randomUUID(),
          actorId: 1,
          action: "set-metadata",
          target: { itemId: `PVTI_${operation.objective}` },
          fieldId: binding.metadataFieldId,
          metadata: operation.metadata,
          prior: {
            target: { itemId: `PVTI_${operation.objective}`, metadata: null },
          },
          control: { metadata: null },
        }),
      );
      let command;
      await withRecoveryCheckpointScope({ config, buildClosure }, async () => {
        command = createQueueCommand(config, {
          operations: removals,
          effects: removalEffects,
          deadlineAt: null,
        });
        await admitQueueCommand(config, command);
        await assert.rejects(
          completeQueueCommand(config, command),
          /every declared fulfilled original/,
        );
        await assert.rejects(
          admitQueueCommand(config, structuredClone(command)),
          /Original creating command/,
        );
        await assert.rejects(
          performQueueCommandEffect(config, {}, command, 1),
          /Only the next/,
        );
        await assert.rejects(
          admitQueueCommand(config, command),
          /cannot replay/,
        );
      });
      const commandArchive = await readVerifiedRecoveryCheckpoint(config);
      for (const operation of removals) {
        const file = commandArchive.manifest.files.find(
          (entry) =>
            entry.path === `project-queue-history/${operation.id}.json`,
        );
        assert.ok(file);
        assert.deepEqual(
          Buffer.from(await commandArchive.readVerifiedBlob(file.ref)),
          await readFile(join(history, `${operation.id}.json`)),
        );
        assert.equal(operation.completed, undefined);
        assert.deepEqual(operation.effects, []);
      }
      const records = structuredClone(removals);
      assert.doesNotThrow(() =>
        assertQueueCommandHistory(records, () =>
          assert.fail("intent-only command has no response originals"),
        ),
      );
      const refuses = (change, pattern) => {
        const changed = structuredClone(records);
        change(changed);
        assert.throws(
          () =>
            assertQueueCommandHistory(changed, () =>
              assert.fail("no response original should be requested"),
            ),
          pattern,
        );
      };
      refuses((rows) => {
        rows[1].bodyDigest = hash("changed approved body");
      }, /frozen original header/);
      refuses((rows) => {
        rows[1].commandId = randomUUID();
      }, /frozen original header/);
      refuses((rows) => {
        rows[0].commandRecipe.effects.pop();
      }, /every admission effect/);
      refuses((rows) => {
        rows[0].completed = true;
      }, /every declared original response/);
      refuses((rows) => {
        rows[0].commandRecipe.effects[1].requestId =
          rows[0].commandRecipe.effects[0].requestId;
        rows[0].commandRecipe.effects[1].request.variables.input.clientMutationId =
          rows[0].commandRecipe.effects[0].requestId;
      }, /identity.*differs/);
      refuses((rows) => {
        rows[0].commandRecipe.effects[1].actorId = 2;
      }, /actor differs/);

      // Test the admission and roadmap schemas with pure public wire contracts;
      // these declarations make no claim that a GitHub effect has occurred.
      const admission = createQueueOperation(config, {
        action: "admit",
        scope: "I_new",
        previousReceiptId: null,
        approval: { kind: "queue-command" },
        objective: 4,
        issueNodeId: "I_new",
        bodyDigest: hash("new approved body"),
        order: 9,
      });
      admission.metadata = JSON.stringify({
        schemaVersion: 1,
        kind: "admission",
        admissionId: randomUUID(),
        receiptId: admission.id,
        state: "queued",
      });
      const common = {
        operationId: admission.id,
        actorId: 1,
        expectedIssue: {
          issueNodeId: admission.issueNodeId,
          objective: admission.objective,
          bodyDigest: admission.bodyDigest,
        },
        control: { metadata: null },
      };
      const ensured = createProjectQueuePlannedEffect(binding, {
        ...common,
        requestId: randomUUID(),
        action: "ensure-card",
        issueNodeId: admission.issueNodeId,
        prior: { target: null },
      });
      const fields = createProjectQueuePlannedEffect(binding, {
        ...common,
        requestId: randomUUID(),
        action: "set-admission-fields",
        target: { resultOf: ensured.requestId },
        orderFieldId: binding.orderFieldId,
        metadataFieldId: binding.metadataFieldId,
        order: 9,
        metadata: admission.metadata,
        prior: { resultOf: ensured.requestId },
      });
      const admissionPlan = {
        operations: [admission],
        effects: [ensured, fields],
        deadlineAt: null,
      };
      assert.throws(
        () =>
          createQueueCommand(config, {
            ...admissionPlan,
            effects: [fields, ensured],
          }),
        /dependency must precede/,
      );
      assert.throws(
        () =>
          createQueueCommand(config, {
            ...admissionPlan,
            effects: [fields],
          }),
        /dependency must precede/,
      );
      assert.throws(
        () =>
          createQueueCommand(config, {
            ...admissionPlan,
            deadlineAt: new Date().toISOString(),
          }),
        /original armed deadline/,
      );
      const wrongBody = structuredClone(admissionPlan);
      wrongBody.effects[0].expectedIssue.bodyDigest = hash("changed body");
      assert.throws(
        () => createQueueCommand(config, wrongBody),
        /exact approved Issue body/,
      );
      await withRecoveryCheckpointScope({ config, buildClosure }, async () => {
        const planned = createQueueCommand(config, admissionPlan);
        assert.equal(nextProjectQueueOrder([admission]), 10);
        await admitQueueCommand(config, planned);
        await assert.rejects(
          completeQueueCommand(config, planned),
          /every declared fulfilled original/,
        );
      });
      // Archive a second compound declaration as real local intent only: no
      // remote result exists.
      const compoundAdmission = createQueueOperation(config, {
        action: "admit",
        scope: "I_compound",
        previousReceiptId: null,
        approval: { kind: "queue-command" },
        objective: 6,
        issueNodeId: "I_compound",
        bodyDigest: hash("compound approved body"),
        order: 17,
      });
      compoundAdmission.metadata = JSON.stringify({
        schemaVersion: 1,
        kind: "admission",
        admissionId: randomUUID(),
        receiptId: compoundAdmission.id,
        state: "queued",
      });
      const compoundCommon = {
        operationId: compoundAdmission.id,
        actorId: 1,
        expectedIssue: {
          issueNodeId: compoundAdmission.issueNodeId,
          objective: compoundAdmission.objective,
          bodyDigest: compoundAdmission.bodyDigest,
        },
        control: { metadata: null },
      };
      const compoundEnsure = createProjectQueuePlannedEffect(binding, {
        ...compoundCommon,
        requestId: randomUUID(),
        action: "ensure-card",
        issueNodeId: compoundAdmission.issueNodeId,
        prior: { target: null },
      });
      const compoundFields = createProjectQueuePlannedEffect(binding, {
        ...compoundCommon,
        requestId: randomUUID(),
        action: "set-admission-fields",
        target: { resultOf: compoundEnsure.requestId },
        orderFieldId: binding.orderFieldId,
        metadataFieldId: binding.metadataFieldId,
        order: compoundAdmission.order,
        metadata: compoundAdmission.metadata,
        prior: { resultOf: compoundEnsure.requestId },
      });
      const compoundPlan = {
        operations: [compoundAdmission],
        effects: [compoundEnsure, compoundFields],
        deadlineAt: null,
      };
      for (const change of [
        (value) => {
          value.orderFieldId = binding.metadataFieldId;
        },
        (value) => {
          value.metadataFieldId = binding.orderFieldId;
        },
        (value) => {
          value.target.resultOf = randomUUID();
        },
        (value) => {
          value.expectedIssue = undefined;
        },
      ]) {
        const changed = structuredClone(compoundFields);
        change(changed);
        assert.throws(() => createProjectQueuePlannedEffect(binding, changed));
      }
      for (const change of [
        (plan) => {
          plan.effects.pop();
        },
        (plan) => {
          plan.effects.reverse();
        },
        (plan) => {
          plan.effects[1].order++;
        },
        (plan) => {
          plan.effects[1].metadata = admission.metadata;
        },
        (plan) => {
          plan.effects[1].expectedIssue.bodyDigest = hash("other body");
        },
        (plan) => {
          plan.effects[1].prior.resultOf = randomUUID();
        },
        (plan) => {
          plan.effects.push(structuredClone(plan.effects[1]));
        },
      ]) {
        const changed = structuredClone(compoundPlan);
        change(changed);
        assert.throws(() => createQueueCommand(config, changed));
      }
      const compoundCommand = createQueueCommand(config, compoundPlan);
      assert.deepEqual(
        compoundAdmission.commandRecipe.effects.map((v) => v.action),
        ["ensure-card", "set-admission-fields"],
      );
      assert.equal(nextProjectQueueOrder([compoundAdmission]), 18);
      await admitQueueCommand(config, compoundCommand);
      await assert.rejects(
        completeQueueCommand(config, compoundCommand),
        /every declared fulfilled original/,
      );
      await assert.rejects(
        performQueueCommandEffect(config, {}, compoundCommand, 1),
        /Only the next/,
      );
      await assert.rejects(
        admitQueueCommand(config, compoundCommand),
        /cannot replay/,
      );
      const interrupted = structuredClone(compoundAdmission);
      interrupted.completed = true;
      assert.throws(
        () =>
          assertQueueCommandHistory([interrupted], () =>
            assert.fail("an interrupted declaration has no originals"),
          ),
        /every declared original response/,
      );
      // Pure decoder coverage below uses explicit synthetic API originals only
      // in memory. They are never archived or called installed qualification.
      const originals = new Map();
      const originalRef = (value) => {
        const bytes = Buffer.from(JSON.stringify(value));
        const ref = {
          digest: hash(bytes),
          bytes: bytes.length,
          mediaType: "application/json",
        };
        originals.set(ref.digest, bytes);
        return ref;
      };
      const readOriginal = (ref) => originals.get(ref.digest);
      const card = (order = null, metadata = null) => ({
        id: "PVTI_compound",
        isArchived: false,
        project: { id: binding.projectId },
        content: {
          __typename: "Issue",
          id: compoundAdmission.issueNodeId,
          number: compoundAdmission.objective,
          repository: { nameWithOwner: repository },
        },
        fieldValues: {
          nodes: [
            ...(order === null
              ? []
              : [
                  {
                    __typename: "ProjectV2ItemFieldNumberValue",
                    field: { id: binding.orderFieldId },
                    number: order,
                  },
                ]),
            ...(metadata === null
              ? []
              : [
                  {
                    __typename: "ProjectV2ItemFieldTextValue",
                    field: { id: binding.metadataFieldId },
                    text: metadata,
                  },
                ]),
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      });
      const concreteIntent = (step, receipts) => {
        const resolved = resolveProjectQueuePlannedEffect(
          binding,
          step,
          receipts,
        );
        return {
          ...resolved.action,
          binding,
          actorId: step.actorId,
          requestId: step.requestId,
          observedAt: new Date().toISOString(),
          request: resolved.request,
        };
      };
      const ensureIntent = concreteIntent(compoundEnsure, []);
      const ensureOriginal = {
        addProjectV2ItemById: {
          clientMutationId: ensureIntent.requestId,
          item: card(),
        },
      };
      const ensureReceipt = {
        intent: ensureIntent,
        itemId: "PVTI_compound",
        observedAt: ensureIntent.observedAt,
        kind: "response",
        original: ensureOriginal,
      };
      const fieldsIntent = concreteIntent(compoundFields, [ensureReceipt]);
      assert.deepEqual(fieldsIntent.request.variables, {
        orderInput: {
          clientMutationId: `${fieldsIntent.requestId}:order`,
          projectId: binding.projectId,
          itemId: "PVTI_compound",
          fieldId: binding.orderFieldId,
          value: { number: 17 },
        },
        metadataInput: {
          clientMutationId: `${fieldsIntent.requestId}:metadata`,
          projectId: binding.projectId,
          itemId: "PVTI_compound",
          fieldId: binding.metadataFieldId,
          value: { text: compoundAdmission.metadata },
        },
      });
      assert(
        fieldsIntent.request.query.indexOf(
          "order: updateProjectV2ItemFieldValue",
        ) <
          fieldsIntent.request.query.indexOf(
            "admission: updateProjectV2ItemFieldValue",
          ),
      );
      const fieldsOriginal = {
        order: {
          clientMutationId: `${fieldsIntent.requestId}:order`,
          projectV2Item: card(compoundAdmission.order),
        },
        admission: {
          clientMutationId: `${fieldsIntent.requestId}:metadata`,
          projectV2Item: card(
            compoundAdmission.order,
            compoundAdmission.metadata,
          ),
        },
      };
      const synthetic = structuredClone(compoundAdmission);
      synthetic.effects = [
        {
          intent: ensureIntent,
          receipt: {
            intent: ensureIntent,
            itemId: "PVTI_compound",
            observedAt: ensureIntent.observedAt,
            kind: "response",
          },
          original: originalRef(ensureOriginal),
        },
        {
          intent: fieldsIntent,
          receipt: {
            intent: fieldsIntent,
            itemId: "PVTI_compound",
            observedAt: fieldsIntent.observedAt,
            kind: "response",
          },
          original: originalRef(fieldsOriginal),
        },
      ];
      synthetic.completed = true;
      assert.doesNotThrow(() =>
        assertQueueCommandHistory([synthetic], readOriginal),
      );
      const stripped = structuredClone(synthetic);
      delete stripped.commandId;
      delete stripped.commandRecipe;
      assert.throws(
        () =>
          parseQueueRecord(
            Buffer.from(JSON.stringify(stripped)),
            repository,
            stripped.id,
          ),
        /declared command membership/,
      );
      assert.throws(
        () => assertQueueCommandHistory([stripped], readOriginal),
        /exact original recipe owner/,
      );
      assert.throws(
        () => retainedQueueEntry(config, [stripped], 6),
        /exact authenticated explicit producer receipt/,
      );
      assert.equal(retainedQueueEntry(config, [synthetic], 6).order, 17);
      // Exercise the exact shared stopped/cancelled settlement admission boundary.
      // Originals above are narrow schema fixtures; this does not claim remote effects.
      const settlementClaim = {
        ...claim,
        objective: synthetic.objective,
        bodyDigest: synthetic.bodyDigest,
        authorityDigest: synthetic.authorityDigest,
        receiptId: synthetic.id,
        admissionId: JSON.parse(synthetic.metadata).admissionId,
      };
      const settlementState = {
        objective: synthetic.objective,
        objectiveBodyDigest: synthetic.bodyDigest,
      };
      assert.doesNotThrow(() =>
        assertProjectQueueClaimAdmission(
          config,
          [synthetic],
          settlementClaim,
          settlementState,
        ),
      );
      // A configuration change that rewrites the queue authority strands a
      // started Objective; its cancellation still settles against the
      // authority its claim was admitted under (#1308), while the claim,
      // admission and receipt chain stay bound.
      const changedAuthority = {
        ...config,
        policy: {
          ...config.policy,
          network: config.policy.network === "off" ? "host" : "off",
        },
      };
      assert.throws(
        () =>
          assertProjectQueueClaimAdmission(
            changedAuthority,
            [synthetic],
            settlementClaim,
            settlementState,
          ),
        /different queue authority/,
      );
      assert.doesNotThrow(() =>
        assertProjectQueueClaimAdmission(
          changedAuthority,
          [synthetic],
          settlementClaim,
          settlementState,
          { historical: true },
        ),
      );
      assert.throws(
        () =>
          assertProjectQueueClaimAdmission(
            changedAuthority,
            [synthetic],
            { ...settlementClaim, authorityDigest: "0".repeat(64) },
            settlementState,
            { historical: true },
          ),
        /original authenticated admission receipt/,
      );
      for (const change of [
        (record) => {
          delete record.completed;
        },
        (record) => {
          delete record.effects[1].original;
        },
        (record) => {
          record.effects[1].intent.order++;
        },
        (record) => {
          record.bodyDigest = hash("changed original body");
        },
      ]) {
        const changed = structuredClone(synthetic);
        change(changed);
        assert.throws(() =>
          assertProjectQueueClaimAdmission(
            config,
            [changed],
            settlementClaim,
            settlementState,
          ),
        );
      }
      assert.throws(() =>
        assertProjectQueueClaimAdmission(
          config,
          [synthetic],
          { ...settlementClaim, admissionId: randomUUID() },
          settlementState,
        ),
      );

      for (const change of [
        (value) => {
          delete value.admission;
        },
        (value) => {
          value.order.clientMutationId = fieldsIntent.requestId;
        },
        (value) => {
          value.admission.projectV2Item.id = "PVTI_other";
        },
        (value) => {
          value.order.projectV2Item.isArchived = true;
        },
        (value) => {
          value.admission.projectV2Item.fieldValues.pageInfo.hasNextPage = true;
        },
        (value) => {
          value.admission.projectV2Item.fieldValues.nodes.pop();
        },
        (value) => {
          value.admission.projectV2Item.fieldValues.nodes[0].number++;
        },
        (value) => {
          value.order.projectV2Item.content.number++;
          value.admission.projectV2Item.content.number++;
        },
        (value) => {
          value.errors = [{ message: "second write failed" }];
        },
      ]) {
        const changedOriginal = structuredClone(fieldsOriginal);
        change(changedOriginal);
        const changed = structuredClone(synthetic);
        changed.effects[1].original = originalRef(changedOriginal);
        assert.throws(() => assertQueueCommandHistory([changed], readOriginal));
      }
      const partial = structuredClone(synthetic);
      delete partial.completed;
      delete partial.effects[1].receipt;
      delete partial.effects[1].original;
      partial.effects[1].rejectedOriginal = originalRef({
        data: { order: fieldsOriginal.order },
        errors: [{ message: "metadata write failed" }],
      });
      assert.doesNotThrow(() =>
        assertQueueCommandHistory([partial], readOriginal),
      );
      assert.equal(nextProjectQueueOrder([partial]), 18);
      assert.throws(
        () => retainedQueueEntry(config, [partial], 6),
        /partial or unknown/,
      );
      partial.completed = true;
      assert.throws(
        () => assertQueueCommandHistory([partial], readOriginal),
        /every declared original response/,
      );
      assert.equal(
        originals.get(partial.effects[1].rejectedOriginal.digest).toString(),
        JSON.stringify({
          data: { order: fieldsOriginal.order },
          errors: [{ message: "metadata write failed" }],
        }),
      );
      const compoundArchive = await readVerifiedRecoveryCheckpoint(config);
      const compoundFile = compoundArchive.manifest.files.find(
        (file) =>
          file.path === `project-queue-history/${compoundAdmission.id}.json`,
      );
      assert.ok(compoundFile);
      assert.deepEqual(
        Buffer.from(await compoundArchive.readVerifiedBlob(compoundFile.ref)),
        await readFile(join(history, `${compoundAdmission.id}.json`)),
      );
      assert.equal(compoundAdmission.completed, undefined);
      assert.deepEqual(compoundAdmission.effects, []);
      const controlOperation = createQueueOperation(config, {
        action: "control",
        scope: "control",
        previousReceiptId: null,
        approval: { kind: "background-setup" },
      });
      controlOperation.metadata = JSON.stringify({
        schemaVersion: 1,
        kind: "control",
        receiptId: controlOperation.id,
        mode: "paused",
        watch: true,
      });
      const controlStep = createProjectQueuePlannedEffect(binding, {
        operationId: controlOperation.id,
        requestId: randomUUID(),
        actorId: 1,
        action: "set-metadata",
        target: { itemId: binding.controlItemId },
        fieldId: binding.metadataFieldId,
        metadata: controlOperation.metadata,
        prior: { target: { itemId: binding.controlItemId, metadata: null } },
        control: { metadata: null },
      });
      const roadmap = createQueueOperation(config, {
        action: "roadmap",
        scope: "roadmap:I_roadmap",
        previousReceiptId: null,
        approval: { kind: "queue-command" },
        objective: 5,
        issueNodeId: "I_roadmap",
        bodyDigest: hash("roadmap body"),
      });
      const roadmapStep = createProjectQueuePlannedEffect(binding, {
        operationId: roadmap.id,
        requestId: randomUUID(),
        actorId: 1,
        action: "ensure-card",
        issueNodeId: roadmap.issueNodeId,
        expectedIssue: {
          issueNodeId: roadmap.issueNodeId,
          objective: roadmap.objective,
          bodyDigest: roadmap.bodyDigest,
        },
        prior: { target: null },
        control: { resultOf: controlStep.requestId },
      });
      const controlPlan = {
        operations: [controlOperation, roadmap],
        effects: [controlStep, roadmapStep],
        deadlineAt: null,
      };
      assert.throws(
        () =>
          createQueueCommand(config, {
            ...controlPlan,
            effects: [roadmapStep, controlStep],
          }),
        /declared earlier control original/,
      );
      const controlCommand = createQueueCommand(config, controlPlan);
      await admitQueueCommand(config, controlCommand);
      await assert.rejects(
        completeQueueCommand(config, controlCommand),
        /every declared fulfilled original/,
      );
      const groupedHistory = await readQueueHistory(config);
      assert.equal(nextProjectQueueOrder(groupedHistory), 18);
      assert.throws(
        () => acquireInstallationLock(repository, 4),
        /already owns Objective #1/,
      );
      releaseControllerLock(objectiveLockPath(repository, 1), lock);
      lockReleased = true;
      const maintenanceLock = acquireInstallationLock(repository, 4);
      try {
        // The live installation owner may lock a stopped Objective only while
        // it decides that Objective itself (#1290); anyone else stays refused.
        assert.throws(
          () => acquireObjectiveLock(repository, 5),
          /already owns this installation/,
        );
        const decided = await asInstallationOwner(maintenanceLock, async () =>
          acquireObjectiveLock(repository, 5),
        );
        releaseControllerLock(objectiveLockPath(repository, 5), decided);
        assert.throws(
          () => acquireObjectiveLock(repository, 5),
          /already owns this installation/,
        );
      } finally {
        releaseControllerLock(
          installationLockPath(repository),
          maintenanceLock,
        );
      }
      assert.deepEqual(
        await readFile(join(history, `${operationId}.json`)),
        unknownBytes,
      );
      assert.equal(
        (await readQueueHistory(config)).find((row) => row.id === admission.id)
          .completed,
        undefined,
      );
      // A real cancellation after immutable preparation interrupts the next
      // visibility child before push. The remote-only reader cannot contain
      // this producer's never-published candidate; fresh sync must not ask it to.
      const journalPath = join(
        stateRoot(repository),
        "recovery",
        "checkpoint.json",
      );
      const beforePrepared = JSON.parse(await readFile(journalPath));
      markCheckpointDirty(repository, {
        path: `project-queue-history/${operationId}.json`,
        kind: "historical",
      });
      const cancellation = new AbortController();
      let interruptedPrepared;
      await assert.rejects(
        withProcessCancellation(
          cancellation.signal,
          () =>
            withRecoveryCheckpointScope({ config, buildClosure }, () =>
              awaitCheckpointAdmission(repository, "explicit"),
            ),
          () => {
            const recorded = JSON.parse(readFileSync(journalPath));
            const latest = recorded.attempts.at(-1);
            if (
              latest?.status === "prepared" &&
              latest.transportOutcome === "not-dispatched" &&
              latest.submittedAt === undefined
            ) {
              interruptedPrepared = structuredClone(latest);
              cancellation.abort(
                new Error(
                  "Actual operator cancellation before archive dispatch",
                ),
              );
            }
          },
        ),
        /cancel|abort|checkpoint|SIGTERM/i,
      );
      assert(interruptedPrepared);
      assert.equal(
        execFileSync(
          "git",
          [`--git-dir=${remote}`, "rev-parse", config.gitPersistence.ref],
          { encoding: "utf8" },
        ).trim(),
        beforePrepared.lastAcknowledged.commitSha,
      );
      assert.throws(() =>
        execFileSync(
          "git",
          [
            `--git-dir=${remote}`,
            "cat-file",
            "-e",
            interruptedPrepared.candidate,
          ],
          { stdio: "pipe" },
        ),
      );
      await withRecoveryCheckpointControllerVerification(
        { config, buildClosure },
        async () => {
          await readVerifiedRecoveryCheckpoint(config);
          await awaitCheckpointAdmission(repository, "explicit");
        },
      );
      const continued = JSON.parse(await readFile(journalPath));
      assert.deepEqual(
        continued.attempts.find(
          (entry) => entry.candidate === interruptedPrepared.candidate,
        ),
        interruptedPrepared,
      );
      assert.equal(continued.attempts.at(-1).status, "acknowledged");
      assert.equal(
        continued.attempts.at(-1).transportOutcome,
        "response-success",
      );
      assert.notEqual(
        continued.attempts.at(-1).candidate,
        interruptedPrepared.candidate,
      );
      assert.equal(continued.acknowledgedSequence, continued.sequence);
      assert.equal(
        execFileSync(
          "git",
          [`--git-dir=${remote}`, "rev-parse", config.gitPersistence.ref],
          { encoding: "utf8" },
        ).trim(),
        continued.lastAcknowledged.commitSha,
      );
      await withRecoveryCheckpointControllerVerification(
        { config, buildClosure },
        async () => {
          const current = await readVerifiedRecoveryCheckpoint(config);
          const tree = execFileSync(
            "git",
            [`--git-dir=${remote}`, "rev-parse", `${current.commitSha}^{tree}`],
            { encoding: "utf8" },
          ).trim();
          const advanced = execFileSync(
            "git",
            [
              `--git-dir=${remote}`,
              "-c",
              "user.name=Fixture",
              "-c",
              "user.email=fixture@example.test",
              "commit-tree",
              tree,
              "-p",
              current.commitSha,
            ],
            { input: "External archive advance\n", encoding: "utf8" },
          ).trim();
          execFileSync("git", [
            `--git-dir=${remote}`,
            "update-ref",
            config.gitPersistence.ref,
            advanced,
            current.commitSha,
          ]);
          markCheckpointDirty(repository, {
            path: `project-queue-history/${operationId}.json`,
            kind: "historical",
          });
          const offset = (await readFile(diagnosticPath(repository, 0))).length;
          await assert.rejects(
            awaitCheckpointAdmission(repository, "before-effect"),
            /changed before.*push|changed before bounded publication/,
          );
          assert.equal(
            execFileSync(
              "git",
              [`--git-dir=${remote}`, "rev-parse", config.gitPersistence.ref],
              { encoding: "utf8" },
            ).trim(),
            advanced,
          );
          const events = (await readFile(diagnosticPath(repository, 0)))
            .subarray(offset)
            .toString("utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          assert(
            events.some(
              (event) =>
                event.operation === "recovery-checkpoint-publication-parent" &&
                event.outcome === "completed" &&
                event.metadata.reused,
            ),
          );
          assert.equal(
            events.some(
              (event) =>
                event.operation === "recovery-checkpoint-transport" &&
                event.metadata.kind === "push",
            ),
            false,
            "immutable parent reuse cannot skip fresh remote authority or dispatch a conflicting push",
          );
        },
      );
    });
  } finally {
    if (!lockReleased)
      releaseControllerLock(objectiveLockPath(repository, 1), lock);
    await rm(directory, { recursive: true, force: true });
    await rm(stateRoot(repository), { recursive: true, force: true });
  }
});

test("archive publication waits for a real publisher beyond one second and preserves cancellation and dead-owner reclamation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "factory-publication-lock-"));
  const guard = join(directory, ".publication.guard");
  let other;
  try {
    other = await holder(guard, "exclusive", true);
    let entered = false;
    const waiting = withCheckpointPublication(guard, async () => {
      entered = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 1300));
    assert.equal(entered, false);
    await other.release();
    other = undefined;
    await waiting;
    assert.equal(entered, true);

    other = await holder(guard, "exclusive", true);
    const controller = new AbortController();
    const cancelled = withProcessCancellation(controller.signal, () =>
      withCheckpointPublication(guard, async () =>
        assert.fail("aborted waiter ran"),
      ),
    );
    const refusal = assert.rejects(cancelled, /original cancellation/);
    controller.abort(new Error("original cancellation"));
    await refusal;
    await other.release();
    other = undefined;

    const alreadyAborted = AbortSignal.abort(new Error("already aborted"));
    await assert.rejects(
      withRegistryFiles(guard, "exclusive", alreadyAborted, async () =>
        assert.fail("already aborted free-lock callback ran"),
      ),
      /already aborted/,
    );
    await assert.rejects(
      withProcessCancellation(alreadyAborted, () =>
        withCheckpointPublication(guard, async () =>
          assert.fail("already aborted publisher ran"),
        ),
      ),
      /already aborted/,
    );
    for (const operation of [
      () =>
        withCheckpointPublication(guard, async () =>
          assert.fail("expired publisher ran"),
        ),
      () =>
        subprocessAsync(process.execPath, [
          "-e",
          "process.stdout.write('expired child ran')",
        ]),
    ]) {
      const deadlineAt = new Date(Date.now() + 10).toISOString();
      await assert.rejects(
        withProcessCancellation(
          AbortSignal.timeout(10),
          async () => {
            // The original timer cannot fire while this actual synchronous work
            // blocks the event loop. The absolute armed deadline still applies.
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
            return operation();
          },
          undefined,
          deadlineAt,
        ),
        /original process deadline elapsed/,
      );
    }

    other = await holder(guard, "exclusive", true);
    await other.kill();
    other = undefined;
    await withCheckpointPublication(guard, async () => undefined);
  } finally {
    if (other) await other.kill();
    await rm(directory, { recursive: true, force: true });
  }
});
