import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  holdLifecycleQualificationCheckpoint,
  lifecycleQualificationArmPath,
  lifecycleQualificationSidecarPaths,
} from "../src/service/lifecycle-qualification.js";

const unit = "clockgrove-factory-0123456789abcdef.service";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function waitFor(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      JSON.parse(await readFile(path, "utf8"));
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError))
        throw error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function fixture() {
  const runtimeDirectory = await mkdtemp("/tmp/factory-lifecycle-qualification-");
  roots.push(runtimeDirectory);
  const checkpointId = randomBytes(16).toString("hex");
  const armPath = lifecycleQualificationArmPath(runtimeDirectory, unit);
  const paths = lifecycleQualificationSidecarPaths(runtimeDirectory, unit, checkpointId);
  const created = Date.now();
  const arm = {
    protocol: "clockgrove.factory/lifecycle-checkpoint-arm",
    checkpointId,
    artifactIdentity: `sha256:${"a".repeat(64)}`,
    effectiveUid: process.getuid!(),
    unit,
    repository: "Example/Disposable",
    checkout: join(runtimeDirectory, "checkout"),
    requestId: "qualification-install",
    operation: "install",
    createdAt: new Date(created).toISOString(),
    expiresAt: new Date(created + 60_000).toISOString(),
  } as const;
  const args = {
    configuredArmPath: armPath,
    runtimeDirectory,
    effectiveUid: process.getuid!(),
    unit,
    lockPath: join(runtimeDirectory, `.${unit}.lifecycle.lock`),
    repository: arm.repository,
    checkout: arm.checkout,
    requestId: arm.requestId,
    artifactIdentity: arm.artifactIdentity,
  };
  return {
    arm,
    armPath,
    args,
    paths,
    async armNow(value: unknown = arm) {
      await writeFile(armPath, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
    },
    async release() {
      const bytes = await readFile(armPath);
      await writeFile(
        paths.release,
        `${JSON.stringify({
          protocol: "clockgrove.factory/lifecycle-checkpoint-release",
          checkpointId,
          armDigest: createHash("sha256").update(bytes).digest("hex"),
        })}\n`,
        { flag: "wx", mode: 0o600 },
      );
    },
  };
}

describe("installed lifecycle qualification checkpoint", () => {
  it("is an immediate no-op without the explicit arm path", async () => {
    await expect(
      holdLifecycleQualificationCheckpoint({
        configuredArmPath: undefined,
        runtimeDirectory: "/path/that/does/not/exist",
        effectiveUid: process.getuid!(),
        unit,
        lockPath: "/unread",
        repository: "example/disposable",
        checkout: "/unread",
        requestId: "no-arm",
        artifactIdentity: `sha256:${"a".repeat(64)}`,
      }),
    ).resolves.toBeUndefined();
  });

  it("writes an exact immutable reached witness and releases once", async () => {
    const f = await fixture();
    await f.armNow();
    const holding = holdLifecycleQualificationCheckpoint(f.args);
    await waitFor(f.paths.reached);
    const witness = JSON.parse(await readFile(f.paths.reached, "utf8"));
    expect(witness).toMatchObject({
      protocol: "clockgrove.factory/lifecycle-checkpoint-reached",
      checkpointId: f.arm.checkpointId,
      artifactIdentity: f.arm.artifactIdentity,
      effectiveUid: process.getuid!(),
      unit,
      repository: "example/disposable",
      checkout: f.arm.checkout,
      requestId: f.arm.requestId,
      operation: "install",
      lockPath: f.args.lockPath,
      clientPid: process.pid,
      expiresAt: f.arm.expiresAt,
    });
    expect(witness.clientStartTicks).toMatch(/^[0-9]+$/);
    await f.release();
    await expect(holding).resolves.toBeUndefined();
    await expect(readFile(f.armPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(f.paths.release)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(f.paths.consumed, "utf8"))).toMatchObject({
      protocol: "clockgrove.factory/lifecycle-checkpoint-consumed",
      checkpointId: f.arm.checkpointId,
      armDigest: witness.armDigest,
      outcome: "released",
    });
    expect(JSON.parse(await readFile(f.paths.reached, "utf8"))).toEqual(witness);
  });

  it.each([
    ["artifactIdentity", `sha256:${"b".repeat(64)}`],
    ["effectiveUid", process.getuid!() + 1],
    ["unit", "clockgrove-factory-fedcba9876543210.service"],
    ["repository", "other/repository"],
    ["checkout", "/other/checkout"],
    ["requestId", "other-install"],
    ["operation", "uninstall"],
  ] as const)("rejects an arm with a foreign %s before reaching", async (key, value) => {
    const f = await fixture();
    await f.armNow({ ...f.arm, [key]: value });
    await expect(holdLifecycleQualificationCheckpoint(f.args)).rejects.toThrow(
      /qualification-invalid/,
    );
    await expect(readFile(f.paths.reached)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(f.paths.consumed, "utf8"))).toMatchObject({
      protocol: "clockgrove.factory/lifecycle-checkpoint-consumed",
      checkpointId: f.arm.checkpointId,
      outcome: "binding-mismatch",
    });
    await expect(holdLifecycleQualificationCheckpoint(f.args)).rejects.toThrow(
      /qualification-replayed/,
    );
  });

  it("rejects a foreign arm path without reading it", async () => {
    const f = await fixture();
    await expect(
      holdLifecycleQualificationCheckpoint({
        ...f.args,
        configuredArmPath: join(f.args.runtimeDirectory, "other.json"),
      }),
    ).rejects.toThrow("arm path differs from unit");
  });

  it("rejects an arm that is not private owner-only data", async () => {
    const f = await fixture();
    await f.armNow();
    await chmod(f.armPath, 0o640);
    await expect(holdLifecycleQualificationCheckpoint(f.args)).rejects.toThrow(
      "not bounded private owner data",
    );
    await expect(readFile(f.paths.reached)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["malformed", "{not-json"],
    [
      "expired",
      JSON.stringify({
        protocol: "clockgrove.factory/lifecycle-checkpoint-arm",
        checkpointId: "1".repeat(32),
        artifactIdentity: `sha256:${"a".repeat(64)}`,
        effectiveUid: process.getuid!(),
        unit,
        repository: "example/disposable",
        checkout: "/tmp/disposable",
        requestId: "qualification-install",
        operation: "install",
        createdAt: new Date(0).toISOString(),
        expiresAt: new Date(1).toISOString(),
      }),
    ],
  ])("fails closed on a %s arm", async (_case, body) => {
    const f = await fixture();
    await writeFile(f.armPath, body, { flag: "wx", mode: 0o600 });
    await expect(holdLifecycleQualificationCheckpoint(f.args)).rejects.toThrow(
      /qualification-(?:invalid|expired)/,
    );
  });

  it.each(["reached", "consumed"] as const)(
    "refuses a %s arm after client death instead of holding it again",
    async (sidecar) => {
      const f = await fixture();
      await f.armNow();
      await writeFile(f.paths[sidecar], "{}\n", { flag: "wx", mode: 0o600 });
      await expect(holdLifecycleQualificationCheckpoint(f.args)).rejects.toThrow(
        /qualification-replayed/,
      );
    },
  );

  it("retains a reached witness and denies replay after the holding process dies", async () => {
    const f = await fixture();
    await f.armNow();
    const moduleUrl = new URL("../src/service/lifecycle-qualification.ts", import.meta.url).href;
    const child = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "--eval",
        `const m = await import(${JSON.stringify(moduleUrl)}); await m.holdLifecycleQualificationCheckpoint(${JSON.stringify(f.args)});`,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    try {
      await waitFor(f.paths.reached);
      const reached = JSON.parse(await readFile(f.paths.reached, "utf8"));
      expect(reached.clientPid).toBe(child.pid);
      expect(child.kill("SIGKILL")).toBe(true);
      const [code, signal] = (await once(child, "close")) as [number | null, NodeJS.Signals];
      expect(code).toBeNull();
      expect(signal).toBe("SIGKILL");
      await expect(readFile(f.armPath)).resolves.toBeDefined();
      await expect(readFile(f.paths.consumed)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(holdLifecycleQualificationCheckpoint(f.args)).rejects.toThrow(
        /qualification-replayed/,
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });

  it("does not release when the arm changes after the reached witness", async () => {
    const f = await fixture();
    await f.armNow();
    const holding = holdLifecycleQualificationCheckpoint(f.args);
    await waitFor(f.paths.reached);
    const bytes = await readFile(f.armPath);
    await rm(f.armPath);
    await writeFile(f.armPath, `${bytes.toString("utf8").trim()} \n`, {
      flag: "wx",
      mode: 0o600,
    });
    await writeFile(
      f.paths.release,
      `${JSON.stringify({
        protocol: "clockgrove.factory/lifecycle-checkpoint-release",
        checkpointId: f.arm.checkpointId,
        armDigest: createHash("sha256").update(bytes).digest("hex"),
      })}\n`,
      { flag: "wx", mode: 0o600 },
    );
    await expect(holding).rejects.toThrow("arm changed while held");
    await expect(readFile(f.paths.consumed)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a malformed or foreign release and never enters install", async () => {
    const f = await fixture();
    await f.armNow();
    const holding = holdLifecycleQualificationCheckpoint(f.args);
    await waitFor(f.paths.reached);
    await writeFile(
      f.paths.release,
      `${JSON.stringify({
        protocol: "clockgrove.factory/lifecycle-checkpoint-release",
        checkpointId: f.arm.checkpointId,
        armDigest: "0".repeat(64),
      })}\n`,
      { flag: "wx", mode: 0o600 },
    );
    await expect(holding).rejects.toThrow("release differs from arm");
    await expect(readFile(f.armPath)).resolves.toBeDefined();
    await expect(readFile(f.paths.consumed)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
