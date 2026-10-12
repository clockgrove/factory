import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  withCheckpointPublication,
  withProcessCancellation,
  withRegistryFiles,
  ownIdentity,
  subprocessAsync,
} from "../dist/process.js";
import { factoryAuthorityDigest, stateRoot } from "../dist/config.js";
import { LocalContentStore } from "../dist/content/local.js";
import {
  acquireObjectiveLock,
  objectiveLockPath,
  releaseControllerLock,
  statePath,
} from "../dist/state-store.js";
import {
  authenticateQueueOwnerReferences,
  settleFailedProjectQueueReservation,
} from "../dist/project-queue-state.js";
import {
  readVerifiedRecoveryCheckpoint,
  withRecoveryCheckpointScope,
} from "../dist/recovery-checkpoint.js";
import { buildRecoveryCheckpointClosure } from "../dist/recovery-checkpoint-closure.js";

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
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const lock = acquireObjectiveLock(repository, 1);
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
    const buildClosure = () =>
      buildRecoveryCheckpointClosure({ config, scope: "private-history" });
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
  } finally {
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
