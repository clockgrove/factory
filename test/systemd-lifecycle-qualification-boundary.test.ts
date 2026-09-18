import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const qualification = vi.hoisted(() => ({ hold: vi.fn() }));
vi.mock("../src/service/lifecycle-qualification.js", () => ({
  LIFECYCLE_QUALIFICATION_ARM_ENV: "FACTORY_LIFECYCLE_QUALIFICATION_ARM",
  holdLifecycleQualificationCheckpoint: qualification.hold,
}));

import { SystemdUserService } from "../src/service/systemd-user-service.js";

const roots: string[] = [];
const testUid = process.getuid?.() ?? 1000;
const armEnvironment = "FACTORY_LIFECYCLE_QUALIFICATION_ARM";

afterEach(async () => {
  delete process.env[armEnvironment];
  qualification.hold.mockReset();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

describe("systemd lifecycle qualification boundary", () => {
  it("does not invoke or await the qualification hook when no arm is selected", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-lifecycle-no-arm-"));
    roots.push(root);
    const bundle = join(root, "installed", "dist", "factory.js");
    await mkdir(dirname(bundle), { recursive: true });
    await writeFile(bundle, "#!/bin/sh\nprintf original\n", { mode: 0o700 });
    const input = {
      repository: "Example/NoArm",
      checkout: join(root, "checkout"),
      requestId: "issue-466-no-arm",
    };
    await mkdir(input.checkout);
    const unitDirectory = join(root, "units");
    let enabled = false;
    const run = vi.fn(async (args: readonly string[]) => {
      if (args[0] === "show" && args[1] === "--property=Version") return { stdout: "259\n" };
      if (args[0] === "enable") enabled = true;
      if (args[0] === "show") {
        const installed = await exists(join(unitDirectory, args[1]!));
        return {
          stdout: [
            `Id=${args[1]}`,
            `LoadState=${installed ? "loaded" : "not-found"}`,
            `UnitFileState=${installed && enabled ? "enabled" : "disabled"}`,
            "ActiveState=inactive",
            "Result=success",
            "ExecMainStatus=0",
            "NRestarts=0",
            "",
          ].join("\n"),
        };
      }
    });
    qualification.hold.mockRejectedValue(new Error("qualification hook must remain unreachable"));
    const service = new SystemdUserService({
      factoryCommand: [process.execPath, bundle],
      unitDirectory,
      run,
      currentUserManager: async () => ({
        uid: testUid,
        runtimeDirectory: `/run/user/${testUid}`,
        environment: {},
      }),
      commandEnvironment: () => ({ PATH: "/usr/bin:/bin" }),
      startupHealthDelayMs: 0,
    });
    delete process.env[armEnvironment];

    await expect(service.install(input)).resolves.toMatchObject({
      installed: true,
      enabled: true,
    });
    expect(qualification.hold).not.toHaveBeenCalled();
  });

  it("preserves unarmed post-lock unit-read error precedence", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-lifecycle-unarmed-order-"));
    roots.push(root);
    const bundle = join(root, "installed", "dist", "factory.js");
    await mkdir(dirname(bundle), { recursive: true });
    await writeFile(bundle, "#!/bin/sh\nprintf original\n", { mode: 0o700 });
    const input = {
      repository: "Example/UnarmedOrder",
      checkout: join(root, "checkout"),
      requestId: "issue-466-unarmed-order",
    };
    await mkdir(input.checkout);
    const unitDirectory = join(root, "units");
    qualification.hold.mockRejectedValue(new Error("qualification hook must remain unreachable"));
    let service!: SystemdUserService;
    service = new SystemdUserService({
      factoryCommand: [process.execPath, bundle],
      unitDirectory,
      run: async (args) => {
        if (args[0] === "show" && args[1] === "--property=Version") {
          return { stdout: "259\n" };
        }
      },
      currentUserManager: async () => {
        await rm(bundle);
        await mkdir(unitDirectory, { recursive: true });
        await writeFile(service.unitPath(input), "[Service]\nExecStart=/unmanaged\n");
        return {
          uid: testUid,
          runtimeDirectory: `/run/user/${testUid}`,
          environment: {},
        };
      },
      commandEnvironment: () => ({ PATH: "/usr/bin:/bin" }),
      startupHealthDelayMs: 0,
    });
    delete process.env[armEnvironment];

    await expect(service.install(input)).rejects.toThrow("refusing to overwrite unmanaged unit");
    expect(qualification.hold).not.toHaveBeenCalled();
  });

  it("reaches after the real lock and rejects changed artifact bytes before unit mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-lifecycle-boundary-"));
    roots.push(root);
    const bundle = join(root, "installed", "dist", "factory.js");
    await mkdir(dirname(bundle), { recursive: true });
    await writeFile(bundle, "#!/bin/sh\nprintf original\n", { mode: 0o700 });
    await chmod(bundle, 0o700);
    const originalIdentity = `sha256:${createHash("sha256")
      .update(await readFile(bundle))
      .digest("hex")}`;
    const input = {
      repository: "Example/Disposable",
      checkout: join(root, "checkout"),
      requestId: "issue-466-boundary",
    };
    await mkdir(input.checkout);
    const unitDirectory = join(root, "units");
    let enabled = false;
    const run = vi.fn(async (args: readonly string[]) => {
      if (args[0] === "show" && args[1] === "--property=Version") return { stdout: "259\n" };
      if (args[0] === "enable") enabled = true;
      if (args[0] === "show") {
        const installed = await exists(join(unitDirectory, args[1]!));
        return {
          stdout: [
            `Id=${args[1]}`,
            `LoadState=${installed ? "loaded" : "not-found"}`,
            `UnitFileState=${installed && enabled ? "enabled" : "disabled"}`,
            "ActiveState=inactive",
            "Result=success",
            "ExecMainStatus=0",
            "NRestarts=0",
            "",
          ].join("\n"),
        };
      }
    });
    let release!: () => void;
    qualification.hold.mockImplementation(
      () =>
        new Promise<void>((resolveHold) => {
          release = resolveHold;
        }),
    );
    const service = new SystemdUserService({
      factoryCommand: [process.execPath, bundle],
      unitDirectory,
      run,
      currentUserManager: async () => ({
        uid: testUid,
        runtimeDirectory: `/run/user/${testUid}`,
        environment: {},
      }),
      commandEnvironment: () => ({ PATH: "/usr/bin:/bin" }),
      startupHealthDelayMs: 0,
    });
    process.env[armEnvironment] = `/run/user/${testUid}/qualification-arm`;

    const installing = service.install(input);
    await vi.waitFor(() => expect(qualification.hold).toHaveBeenCalledOnce());
    const call = qualification.hold.mock.calls[0]![0];
    expect(call).toMatchObject({
      configuredArmPath: process.env[armEnvironment],
      runtimeDirectory: `/run/user/${testUid}`,
      effectiveUid: testUid,
      unit: service.unitName(input),
      repository: input.repository,
      checkout: input.checkout,
      requestId: input.requestId,
      artifactIdentity: originalIdentity,
    });
    expect(call.lockPath).toBe(`/run/user/${testUid}/.${service.unitName(input)}.lifecycle.lock`);
    expect(run.mock.calls.map(([args]) => args)).toEqual([
      ["show", "--property=Version", "--value", "--no-pager"],
    ]);
    expect(await exists(service.unitPath(input))).toBe(false);

    await writeFile(bundle, "#!/bin/sh\nprintf changed\n", { mode: 0o700 });
    release();
    await expect(installing).rejects.toThrow("exact Factory launch command changed while held");
    expect(await exists(service.unitPath(input))).toBe(false);
  });
});
