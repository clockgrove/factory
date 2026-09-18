import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CompiledGraphProjectionRecord, CompiledGraphRecord } from "../src/control/graphs.js";
import type { FactoryEvent } from "../src/protocol/events.js";
import {
  CompilerQualificationCheckpointHeldError,
  CompilerQualificationCheckpointShutdownError,
  compilerQualificationCheckpointPath,
  holdCompilerQualificationCheckpoint,
  proveGraphProjectionQualificationBoundary,
  type CompilerQualificationArm,
  type CompilerQualificationControllerObservation,
  type CompilerQualificationProof,
} from "../src/runtime/compiler-qualification-checkpoint.js";

const hash = (value: unknown) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
const now = new Date();
const binding = {
  repository: "example/compiler-fixture",
  objective: 47,
  activationRequestId: "compiler-checkpoint-activate",
  runId: "2f71de37-e17c-4c69-a337-087d429e4f65",
  policyDigest: "a".repeat(64),
  baseSha: "b".repeat(40),
} as const;
const controller: CompilerQualificationControllerObservation = {
  bundleIdentity: `sha256:${"c".repeat(64)}`,
  hostIdentity: "d".repeat(64),
  producerPid: process.pid,
  producerStartTicks: "123456",
  producerUnit: "clockgrove-factory-0123456789abcdef.service",
  producerInvocationId: "e".repeat(32),
};
const selectionProof: CompilerQualificationProof = {
  checkpoint: "compiler-selection",
  journalDigest: "1".repeat(64),
  selectionSequence: 9,
  revision: 1,
  graphDigest: "2".repeat(64),
  graphAbsent: true,
  usage: ["inventory", "compile", "judge"].map((stage, index) => ({
    invocationId: `compiler-${stage}`,
    stage: stage as "inventory" | "compile" | "judge",
    revision: stage === "inventory" ? 0 : 1,
    amount: 10 + index,
    reservationSequence: index * 2 + 1,
    reconciliationSequence: index * 2 + 2,
  })),
};

const roots = new Set<string>();
afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

function fixture(
  checkpoint: "compiler-selection" | "graph-projection" = "compiler-selection",
  holdDurationMs = 20,
) {
  const objectiveStartedAt = new Date(now.getTime() - 60_000);
  const objectiveDeadline = new Date(now.getTime() + 60 * 60_000);
  const arm: CompilerQualificationArm = {
    protocol: "clockgrove.factory/compiler-qualification-checkpoint-arm",
    bundleIdentity: controller.bundleIdentity,
    effectiveUid: process.geteuid!(),
    controllerUnit: controller.producerUnit,
    repository: binding.repository,
    objective: binding.objective,
    activationRequestId: binding.activationRequestId,
    policyDigest: binding.policyDigest,
    baseSha: binding.baseSha,
    checkpoint,
    eligibilityDurationMs: objectiveDeadline.getTime() - objectiveStartedAt.getTime(),
    holdDurationMs,
  };
  const path = compilerQualificationCheckpointPath(arm);
  roots.add(dirname(path));
  const order: string[] = [];
  const proof =
    checkpoint === "compiler-selection"
      ? selectionProof
      : ({
          checkpoint: "graph-projection",
          graphDigest: "2".repeat(64),
          graphSize: 1,
          graphRef: "refs/clockgrove-factory/graphs/objective-47/run-fixture",
          graphCommitOid: "3".repeat(40),
          graphBlobSha: "4".repeat(40),
          graphReceiptDigest: "5".repeat(64),
          projectionRef: "refs/clockgrove-factory/graph-projections/objective-47/run-fixture",
          projectionCommitOid: "6".repeat(40),
          projectionBlobSha: "7".repeat(40),
          projectionReceiptDigest: "8".repeat(64),
          bindingsDigest: "9".repeat(64),
          workItemNumbers: [48],
          attemptReservations: 0,
          capacityReservations: 0,
        } satisfies CompilerQualificationProof);
  const args: Parameters<typeof holdCompilerQualificationCheckpoint>[0] = {
    ...binding,
    checkpoint,
    objectiveStartedAt,
    objectiveDeadline,
    holdDurationMs,
    observeController: async () => {
      order.push("controller");
      return controller;
    },
    assertCurrent: async () => {
      order.push("lease");
    },
    proveBoundary: async () => {
      order.push("proof");
      return proof;
    },
  };
  return { arm, path, args, order };
}

async function arm(f: ReturnType<typeof fixture>) {
  await mkdir(dirname(f.path), { mode: 0o700 });
  const file = await open(
    f.path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(JSON.stringify(f.arm));
  } finally {
    await file.close();
  }
}

async function reached(path: string) {
  for (let attempts = 0; attempts < 100; attempts++) {
    try {
      return JSON.parse(await readFile(`${path}.reached`, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new Error("checkpoint witness was not reached");
}

describe.sequential("compiler qualification checkpoint", () => {
  it("is a no-op without an arm and does not observe authority or proof", async () => {
    const f = fixture();
    await mkdir(dirname(f.path), { mode: 0o700 });
    await expect(holdCompilerQualificationCheckpoint(f.args)).resolves.toBeUndefined();
    expect(f.order).toEqual([]);
  });

  it("ignores shared-directory state when this run has no exact arm", async () => {
    for (const state of ["public-empty", "inaccessible-empty", "unrelated", "symlink"] as const) {
      const f = fixture();
      const directory = dirname(f.path);
      if (state === "symlink") {
        const target = `${directory}-unrelated`;
        roots.add(target);
        await mkdir(target, { mode: 0o755 });
        await symlink(target, directory);
      } else {
        await mkdir(directory, { mode: state === "inaccessible-empty" ? 0o700 : 0o755 });
        if (state === "unrelated") {
          await writeFile(`${directory}/unrelated.json`, "not an arm", { mode: 0o644 });
        }
        if (state === "inaccessible-empty") await chmod(directory, 0o000);
      }
      await expect(holdCompilerQualificationCheckpoint(f.args)).resolves.toBeUndefined();
      expect(f.order).toEqual([]);
      if (state === "inaccessible-empty") await chmod(directory, 0o700);
      await rm(directory, { recursive: true, force: true });
      roots.delete(directory);
    }
  });

  it("refuses a malformed or symlinked exact arm after positive discovery", async () => {
    for (const kind of [
      "malformed",
      "public-directory",
      "public-file",
      "file-symlink",
      "directory-symlink",
    ] as const) {
      const f = fixture();
      const directory = dirname(f.path);
      if (kind === "directory-symlink") {
        const target = `${directory}-foreign`;
        roots.add(target);
        await mkdir(target, { mode: 0o700 });
        await writeFile(`${target}/${f.path.slice(directory.length + 1)}`, JSON.stringify(f.arm), {
          mode: 0o600,
        });
        await symlink(target, directory);
      } else if (["malformed", "public-directory", "public-file"].includes(kind)) {
        await mkdir(directory, { mode: kind === "public-directory" ? 0o755 : 0o700 });
        await writeFile(f.path, kind === "malformed" ? "{not-json" : JSON.stringify(f.arm), {
          mode: kind === "public-file" ? 0o644 : 0o600,
        });
      } else {
        await mkdir(directory, { mode: 0o700 });
        const target = `${f.path}.foreign`;
        await writeFile(target, JSON.stringify(f.arm), { mode: 0o600 });
        await symlink(target, f.path);
      }
      await expect(holdCompilerQualificationCheckpoint(f.args)).rejects.toBeInstanceOf(
        CompilerQualificationCheckpointHeldError,
      );
      expect(f.order).toEqual([]);
      await expect(readFile(`${f.path}.reached`)).rejects.toMatchObject({ code: "ENOENT" });
      await rm(directory, { recursive: true, force: true });
      roots.delete(directory);
    }
  });

  it.each(["compiler-selection", "graph-projection"] as const)(
    "writes the exact %s witness only after controller, lease, and durable proof checks",
    async (checkpoint) => {
      const f = fixture(checkpoint);
      await arm(f);
      await expect(holdCompilerQualificationCheckpoint(f.args)).rejects.toBeInstanceOf(
        CompilerQualificationCheckpointHeldError,
      );
      const witness = JSON.parse(await readFile(`${f.path}.reached`, "utf8"));
      expect(f.order).toEqual(["controller", "lease", "proof", "lease"]);
      expect(f.arm).not.toHaveProperty("runId");
      expect(witness).toMatchObject({
        protocol: "clockgrove.factory/compiler-qualification-checkpoint-reached",
        armDigest: hash(JSON.stringify(f.arm)),
        bundleIdentity: f.arm.bundleIdentity,
        effectiveUid: process.geteuid!(),
        controllerUnit: controller.producerUnit,
        controllerInvocationId: controller.producerInvocationId,
        ...binding,
        checkpoint,
        proof: f.args.proveBoundary === undefined ? undefined : expect.any(Object),
      });
      expect(witness.runId).toBe(binding.runId);
      expect(witness.runId).not.toBe(binding.activationRequestId);
      expect((await stat(f.path)).mode & 0o777).toBe(0o600);
      expect((await stat(`${f.path}.reached`)).mode & 0o777).toBe(0o600);
    },
  );

  it("fails closed before a witness when a durability prerequisite or lease check fails", async () => {
    for (const failure of ["first-lease", "proof", "second-lease"] as const) {
      const f = fixture();
      await arm(f);
      let leases = 0;
      f.args.assertCurrent = async () => {
        f.order.push("lease");
        leases += 1;
        if (
          (failure === "first-lease" && leases === 1) ||
          (failure === "second-lease" && leases === 2)
        )
          throw new Error(failure);
      };
      f.args.proveBoundary = async () => {
        f.order.push("proof");
        if (failure === "proof") throw new Error(failure);
        return selectionProof;
      };
      await expect(holdCompilerQualificationCheckpoint(f.args)).rejects.toBeInstanceOf(
        CompilerQualificationCheckpointHeldError,
      );
      await expect(readFile(`${f.path}.reached`)).rejects.toMatchObject({ code: "ENOENT" });
      await rm(dirname(f.path), { recursive: true, force: true });
      roots.delete(dirname(f.path));
    }
  });

  it("consumes an armed hold on graceful shutdown and refuses a replayed arm", async () => {
    const f = fixture("compiler-selection", 60_000);
    const stopped = new AbortController();
    f.args.signal = stopped.signal;
    await arm(f);
    const held = holdCompilerQualificationCheckpoint(f.args);
    await reached(f.path);
    stopped.abort(new Error("controller stop"));
    await expect(held).rejects.toBeInstanceOf(CompilerQualificationCheckpointShutdownError);
    await expect(stat(f.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(holdCompilerQualificationCheckpoint(f.args)).resolves.toBeUndefined();

    await writeFile(f.path, JSON.stringify(f.arm), { mode: 0o600, flag: "wx" });
    await expect(holdCompilerQualificationCheckpoint(f.args)).rejects.toBeInstanceOf(
      CompilerQualificationCheckpointHeldError,
    );
  });

  it("rejects foreign binding and expired arms without invoking the durable proof", async () => {
    for (const mutation of [
      "bundle",
      "uid",
      "unit",
      "repository",
      "objective",
      "activation",
      "legacy-run",
      "policy",
      "base",
      "kind",
      "expired",
    ] as const) {
      const f = fixture();
      if (mutation === "bundle") f.arm.bundleIdentity = `sha256:${"0".repeat(64)}`;
      if (mutation === "uid") f.arm.effectiveUid += 1;
      if (mutation === "unit") f.arm.controllerUnit = "clockgrove-factory-fedcba9876543210.service";
      if (mutation === "repository") f.arm.repository = "example/other";
      if (mutation === "objective") f.arm.objective += 1;
      if (mutation === "activation") f.arm.activationRequestId = "other-activation";
      if (mutation === "legacy-run")
        (f.arm as unknown as Record<string, unknown>).runId = "obsolete-run-binding";
      if (mutation === "policy") f.arm.policyDigest = "0".repeat(64);
      if (mutation === "base") f.arm.baseSha = "0".repeat(40);
      if (mutation === "kind") f.arm.checkpoint = "graph-projection";
      if (mutation === "expired") {
        f.args.objectiveStartedAt = new Date(Date.now() - 120_000);
        f.args.objectiveDeadline = new Date(Date.now() - 60_000);
        f.arm.eligibilityDurationMs = 60_000;
      }
      await arm(f);
      await expect(holdCompilerQualificationCheckpoint(f.args)).rejects.toBeInstanceOf(
        CompilerQualificationCheckpointHeldError,
      );
      expect(f.order).not.toContain("proof");
      await rm(dirname(f.path), { recursive: true, force: true });
      roots.delete(dirname(f.path));
    }
  });
});

describe("graph projection qualification proof", () => {
  const common = {
    protocol: "clockgrove.factory/v2" as const,
    objective: 47,
    runId: binding.runId,
    at: now.toISOString(),
  };
  const graph: CompiledGraphRecord = {
    ref: "refs/clockgrove-factory/graphs/objective-47/run-fixture",
    commitOid: "3".repeat(40),
    blobOid: "4".repeat(40),
    graphDigest: "2".repeat(64),
    graphSize: 1,
    objective: {} as CompiledGraphRecord["objective"],
  };
  const projection: CompiledGraphProjectionRecord = {
    ref: "refs/clockgrove-factory/graph-projections/objective-47/run-fixture",
    commitOid: "6".repeat(40),
    blobOid: "7".repeat(40),
    graphDigest: graph.graphDigest,
    graphSize: 1,
    bindings: [{ compilerId: "work", issueNodeId: "I_work", issueNumber: 48 }],
  };
  const receipts = [
    {
      ...common,
      kind: "graph",
      event: "GraphCompiled",
      sequence: 10,
      graphDigest: graph.graphDigest,
      graphSize: 1,
      baseSha: binding.baseSha,
      graphRef: graph.ref,
      graphBlobSha: graph.blobOid,
    },
    {
      ...common,
      kind: "graph",
      event: "GraphProjected",
      sequence: 11,
      graphDigest: graph.graphDigest,
      graphSize: 1,
      projectionRef: projection.ref,
      projectionBlobSha: projection.blobOid,
    },
  ] as FactoryEvent[];

  it("binds the two exact graph receipts and zero worker admission", () => {
    expect(
      proveGraphProjectionQualificationBoundary({
        objective: 47,
        runId: binding.runId,
        graph,
        projection,
        events: receipts,
      }),
    ).toMatchObject({
      checkpoint: "graph-projection",
      graphDigest: graph.graphDigest,
      graphReceiptDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      projectionReceiptDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      bindingsDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      workItemNumbers: [48],
      attemptReservations: 0,
      capacityReservations: 0,
    });
  });

  it("refuses duplicate receipts, changed projection, and admission before the boundary", () => {
    expect(() =>
      proveGraphProjectionQualificationBoundary({
        objective: 47,
        runId: binding.runId,
        graph,
        projection,
        events: [...receipts, { ...receipts[1]!, sequence: 13 }],
      }),
    ).toThrow();
    expect(() =>
      proveGraphProjectionQualificationBoundary({
        objective: 47,
        runId: binding.runId,
        graph,
        projection: { ...projection, blobOid: "f".repeat(40) },
        events: receipts,
      }),
    ).toThrow();
    expect(() =>
      proveGraphProjectionQualificationBoundary({
        objective: 47,
        runId: binding.runId,
        graph,
        projection,
        events: [
          ...receipts,
          {
            ...common,
            kind: "capacity",
            event: "CapacityReserved",
            sequence: 12,
            workItem: 48,
            attempt: 1,
            phase: "execution",
            backend: "codex-cli/local-worktree",
            requestedCpu: 1,
            requestedMemoryMb: 512,
            directorEpoch: 1,
            policyDigest: binding.policyDigest,
          } as FactoryEvent,
        ],
      }),
    ).toThrow("follows worker admission");
  });
});
