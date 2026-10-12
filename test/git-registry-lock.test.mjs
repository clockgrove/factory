import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, readlinkSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  factoryAuthorityDigest,
  stateRoot,
  validateConfig,
} from "../dist/config.js";
import { LocalContentStore } from "../dist/content/local.js";
import { diagnosticPath } from "../dist/diagnostics.js";
import { createProjectQueuePlannedEffect } from "../dist/github-project-queue.js";
import { UPDATE } from "../dist/github-project-queue-wire.js";
import {
  ownIdentity,
  subprocessAsync,
  withCheckpointPublication,
  withProcessCancellation,
  withRegistryFiles,
} from "../dist/process.js";
import {
  admitQueueCommand,
  assertQueueCommandHistory,
  authenticateQueueOwnerReferences,
  completeQueueCommand,
  createQueueCommand,
  createQueueOperation,
  nextProjectQueueOrder,
  performQueueCommandEffect,
  readQueueHistory,
  retainedQueueEntry,
  retireUnknownProjectAdmission,
  settleFailedProjectQueueReservation,
} from "../dist/project-queue-state.js";
import {
  awaitCheckpointAdmission,
  markCheckpointDirty,
  readVerifiedRecoveryCheckpoint,
  withRecoveryCheckpointControllerVerification,
  withRecoveryCheckpointScope,
} from "../dist/recovery-checkpoint.js";
import { buildRecoveryCheckpointClosure } from "../dist/recovery-checkpoint-closure.js";
import { controlObjective } from "../dist/runner.js";
import {
  acquireInstallationLock,
  acquireObjectiveLock,
  installationLockPath,
  objectiveLockPath,
  readControllerOwner,
  releaseControllerLock,
  statePath,
} from "../dist/state-store.js";

const processUrl = new URL("../dist/process.js", import.meta.url).href;

/** Another controller process: holds the lock in `mode` until told to let go. */
async function holder(key, mode, publication = false) {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { withRegistryFiles, withCheckpointPublication, takeGuard, releaseGuard } from ${JSON.stringify(processUrl)};
       const body = async () => {
         process.stdout.write("held\\n");
         await new Promise((resolve) => process.stdin.once("data", resolve));
       };
       ${publication === "legacy" ? `takeGuard(${JSON.stringify(key)}); try { await body(); } finally { releaseGuard(${JSON.stringify(key)}); }` : `await ${publication ? `withCheckpointPublication(${JSON.stringify(key)}, body)` : `withRegistryFiles(${JSON.stringify(key)}, ${JSON.stringify(mode)}, undefined, body)`};`}
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
      timeoutMs: 1000,
      coalesceMs: 0,
    },
  };
  validateConfig(config);
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
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
    await mkdir(history, { mode: 0o700 });
    const path = join(history, `${claim.id}.json`),
      original = Buffer.from(`${JSON.stringify(claim)}\n`);
    await writeFile(path, original, { mode: 0o600 });
    const error = new Error("original before-effect failure");
    const maintenanceBuildOwners = [];
    let observingMaintenance = false;
    const buildClosure = () => {
      if (observingMaintenance)
        maintenanceBuildOwners.push(
          readControllerOwner(installationLockPath(repository)),
        );
      return buildRecoveryCheckpointClosure({
        config,
        scope: "private-history",
      });
    };
    await withRecoveryCheckpointScope({ config, buildClosure }, async () => {
      const historical = structuredClone(claim);
      delete historical.ownerProcess;
      await assert.rejects(
        settleFailedProjectQueueReservation(
          config,
          historical,
          lock.token,
          error,
        ),
        /historical or started work/,
      );
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
    const unknown = {
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
    assert.equal(
      restoredHistory.find((row) => row.id === operationId).retiredWithdrawal,
      undefined,
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
      const ordered = createProjectQueuePlannedEffect(binding, {
        ...common,
        requestId: randomUUID(),
        action: "set-order",
        target: { resultOf: ensured.requestId },
        fieldId: binding.orderFieldId,
        order: 9,
        prior: { resultOf: ensured.requestId },
      });
      const final = createProjectQueuePlannedEffect(binding, {
        ...common,
        requestId: randomUUID(),
        action: "set-metadata",
        target: { resultOf: ensured.requestId },
        fieldId: binding.metadataFieldId,
        metadata: admission.metadata,
        prior: { resultOf: ordered.requestId },
      });
      const admissionPlan = {
        operations: [admission],
        effects: [ensured, ordered, final],
        deadlineAt: null,
      };
      assert.throws(
        () =>
          createQueueCommand(config, {
            ...admissionPlan,
            effects: [ordered, ensured, final],
          }),
        /dependency must precede/,
      );
      assert.throws(
        () =>
          createQueueCommand(config, {
            ...admissionPlan,
            effects: [ensured, final],
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
      const wrongPrior = structuredClone(admissionPlan);
      wrongPrior.effects[2].prior.resultOf = ensured.requestId;
      assert.throws(
        () => createQueueCommand(config, wrongPrior),
        /immediately preceding/,
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
      assert.equal(nextProjectQueueOrder(groupedHistory), 10);
      assert.equal(
        groupedHistory.find((row) => row.id === admission.id).retiredAdmission,
        undefined,
      );
      // Unknown legacy effects and grouped recipes cannot be silently reclassified
      // as the narrowly authorized, two-response legacy admission disposition.
      assert.throws(
        () => acquireInstallationLock(repository, 4),
        /already owns Objective #1/,
      );
      releaseControllerLock(objectiveLockPath(repository, 1), lock);
      lockReleased = true;
      const maintenanceLock = acquireInstallationLock(repository, 4);
      try {
        await assert.rejects(
          retireUnknownProjectAdmission(
            config,
            {},
            4,
            {},
            "Fixture",
            maintenanceLock,
          ),
          /Explicit unknown.*evidence/,
        );
        await assert.rejects(
          retireUnknownProjectAdmission(
            { ...config, planning: { kind: "unsupported" } },
            {},
            4,
            {},
            "Fixture",
            maintenanceLock,
          ),
          /unknown provider resource protocols/,
        );
        await assert.rejects(
          retireUnknownProjectAdmission(config, {}, 4, {}, "Fixture", {
            ...maintenanceLock,
            token: "foreign",
          }),
          /exclusive stopped installation lease/,
        );
      } finally {
        releaseControllerLock(
          installationLockPath(repository),
          maintenanceLock,
        );
      }
      // Exercise the real stopped-controller entry and its error settlement.
      // These deliberately incomplete descriptors claim no operator observation,
      // provider response or permission to retire any of the preserved intents.
      const configPath = join(directory, "maintenance-config.json"),
        configBytes = Buffer.from(JSON.stringify(config)),
        refusedProofPath = join(directory, "not-an-operator-proof.json"),
        refusedProofBytes = Buffer.from("{}\n");
      await writeFile(configPath, configBytes, { mode: 0o600 });
      await writeFile(refusedProofPath, refusedProofBytes, { mode: 0o600 });
      const refusedOriginal = {
        path: refusedProofPath,
        sha256: hash(refusedProofBytes),
        bytes: refusedProofBytes.length,
      };
      const refusedEvidence = {
        schemaVersion: 1,
        kind: "operator-retired-admission-unknown",
        operationId: randomUUID(),
        originalInstallation: {
          cli: process.execPath,
          configPath,
          configSha256: hash(configBytes),
          ownFileInventory: refusedOriginal,
        },
        originals: Object.fromEntries(
          [
            "ownerObservation",
            "installedPlan",
            "callerFailure",
            "sourceProtocolReview",
            "physicalClosure",
          ].map((name) => [name, refusedOriginal]),
        ),
      };
      const maintenanceOffset = (await readFile(diagnosticPath(repository, 0)))
        .length;
      // An actual rewritten retained original makes error settlement durable;
      // the old unknown intent itself remains byte-for-byte unchanged.
      await writeFile(join(history, `${operationId}.json`), unknownBytes);
      markCheckpointDirty(repository, {
        path: `project-queue-history/${operationId}.json`,
        kind: "historical",
      });
      observingMaintenance = true;
      try {
        await assert.rejects(
          controlObjective(
            config,
            {
              objective: 4,
              action: "handoff",
              input: {
                actor: "Fixture",
                retiredAdmissionEvidence: refusedEvidence,
              },
            },
            {},
          ),
          /Other partial effects or active owners remain held/,
        );
      } finally {
        observingMaintenance = false;
      }
      assert(maintenanceBuildOwners.length > 0);
      assert(
        maintenanceBuildOwners.every(
          (owner) => owner?.pid === process.pid && owner.objective === 4,
        ),
        "terminal error settlement retains the exclusive installation lease",
      );
      const maintenanceEvents = (await readFile(diagnosticPath(repository, 0)))
        .subarray(maintenanceOffset)
        .toString("utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const maintenanceReads = maintenanceEvents.filter(
        (event) =>
          event.operation === "recovery-checkpoint-verify" &&
          event.outcome === "started",
      );
      assert(maintenanceReads.length >= 2);
      assert(maintenanceReads.every((event) => event.metadata.owned === true));
      assert.equal(maintenanceReads[0].metadata.objectsRetained, false);
      assert(
        maintenanceReads
          .slice(1)
          .every((event) => event.metadata.objectsRetained),
        "terminal error settlement reuses the same authenticated verifier",
      );
      assert.equal(existsSync(installationLockPath(repository)), false);
      // The normal compiled CLI delegates this complete guarded controller;
      // rejection must not trigger an unowned, duplicate cold synchronization.
      const evidencePath = join(directory, "refused-maintenance-evidence.json");
      await writeFile(evidencePath, JSON.stringify(refusedEvidence), {
        mode: 0o600,
      });
      const cliOffset = (await readFile(diagnosticPath(repository, 0))).length;
      assert.throws(
        () =>
          execFileSync(
            process.execPath,
            [
              new URL("../dist/cli.js", import.meta.url).pathname,
              "handoff",
              "--objective",
              "4",
              "--retired-admission-evidence",
              evidencePath,
              "--config",
              configPath,
            ],
            { env: process.env, encoding: "utf8", timeout: 30_000 },
          ),
        (error) =>
          error.status === 1 &&
          /Other partial effects or active owners remain held/.test(
            error.stderr,
          ),
      );
      const cliReads = (await readFile(diagnosticPath(repository, 0)))
        .subarray(cliOffset)
        .toString("utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter(
          (event) =>
            event.operation === "recovery-checkpoint-verify" &&
            event.outcome === "started",
        );
      assert(cliReads.length > 0);
      assert(
        cliReads.every((event) => event.metadata.owned === true),
        "CLI error propagation never reopens an unowned verifier",
      );
      assert.equal(existsSync(installationLockPath(repository)), false);

      assert.deepEqual(
        await readFile(join(history, `${operationId}.json`)),
        unknownBytes,
      );
      assert.equal(
        (await readQueueHistory(config)).find((row) => row.id === admission.id)
          .completed,
        undefined,
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

    other = await holder(guard, "exclusive", "legacy");
    await assert.rejects(
      withCheckpointPublication(guard, async () =>
        assert.fail("live legacy publisher ignored"),
      ),
      /lock guard .* held by process/,
    );
    await other.release();
    other = undefined;
    await withCheckpointPublication(guard, async () => undefined);
  } finally {
    if (other) await other.kill();
    await rm(directory, { recursive: true, force: true });
  }
});
