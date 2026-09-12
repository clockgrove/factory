import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SystemdUserService } from "../src/service/systemd-user-service.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "factory-cache-generation-"));
  roots.push(root);
  const bundle = join(root, "cache generation $NAME %n", "factory.js");
  await mkdir(dirname(bundle));
  await writeFile(bundle, "process.exit(1);\n");
  return { root, bundle, input: { repository: "CacheGeneration/Fixture", checkout: root } };
}

it("stops an evicted Node launcher before generic exit 1 without changing crash policy", async () => {
  const f = await fixture();
  const service = new SystemdUserService({
    factoryCommand: [process.execPath, f.bundle],
    unitDirectory: join(f.root, "units"),
    run: async () => {},
  });
  await service.install(f.input);
  const body = await readFile(service.unitPath(f.input), "utf8");
  const conditions = body.split("\n").filter((line) => line.startsWith("ExecCondition="));
  const check = () =>
    conditions.map((line) => {
      const match = line.match(/^ExecCondition=:\/usr\/bin\/test (-[fxr]) (.*)$/)!;
      return spawnSync("/usr/bin/test", [
        match[1]!,
        (JSON.parse(match[2]!) as string).replaceAll("%%", "%"),
      ]).status;
    });
  expect(check()).toEqual([0, 0, 0, 0]);
  expect(body).toContain("Restart=on-failure\n");
  expect(body).not.toMatch(/RestartPreventExitStatus=.*\b1\b/);
  await rm(dirname(f.bundle), { recursive: true });
  expect(spawnSync(process.execPath, [f.bundle]).status).toBe(1);
  expect(check()).toEqual([0, 0, 1, 1]);
  expect(await service.status(f.input)).toMatchObject({
    launcherCurrent: false,
    reasonCode: "controller-launcher-stale",
    unit: service.unitName(f.input),
  });
});

it.each(["active", "activating", "deactivating", "reloading", "unknown"])(
  "preserves the old unit when launcher replacement finds %s ownership",
  async (state) => {
    const f = await fixture();
    const run = vi.fn(async (_args: readonly string[]) => ({ stdout: `ActiveState=${state}\n` }));
    const service = new SystemdUserService({
      factoryCommand: [process.execPath, f.bundle],
      unitDirectory: join(f.root, "units"),
      run,
    });
    await service.install(f.input);
    const original = await readFile(service.unitPath(f.input), "utf8");
    await writeFile(f.bundle, "// replacement bytes\n");
    run.mockClear();
    await expect(service.install(f.input)).rejects.toThrow("settle work and owned resources");
    expect(await readFile(service.unitPath(f.input), "utf8")).toBe(original);
    expect(run.mock.calls.map(([args]) => args)).toHaveLength(1);
  },
);

it("marks a legacy unit stale and adds guards without changing its running bytes", async () => {
  const f = await fixture();
  const run = vi.fn(async (_args: readonly string[]) => ({ stdout: "ActiveState=active\n" }));
  const service = new SystemdUserService({
    factoryCommand: [process.execPath, f.bundle],
    unitDirectory: join(f.root, "units"),
    run,
  });
  const installed = await service.install(f.input);
  const body = await readFile(service.unitPath(f.input), "utf8");
  await writeFile(
    service.unitPath(f.input),
    body
      .split("\n")
      .filter((line) => !line.startsWith("ExecCondition="))
      .join("\n"),
  );
  expect(await service.status(f.input)).toMatchObject({
    active: true,
    launcherCurrent: false,
    reasonCode: "controller-launcher-stale",
  });
  run.mockClear();
  expect(await service.install(f.input)).toMatchObject({
    active: true,
    launcherCurrent: true,
    executableIdentity: installed.executableIdentity,
  });
  expect(await readFile(service.unitPath(f.input), "utf8")).toBe(body);
  expect(run.mock.calls.some(([args]) => ["start", "stop", "restart"].includes(args[0]!))).toBe(
    false,
  );
});

const integration = process.env.FACTORY_SYSTEMD_INTEGRATION === "1" ? it : it.skip;
integration.each([false, true])(
  "contains real cache eviction with active=%s and preserves the running generation",
  async (active) => {
    const f = await fixture();
    // Keep the real service fixture's path free of environment expansion: command
    // argument expansion is existing systemd behavior, separate from the guards.
    const bundle = join(f.root, "factory.js");
    const launches = join(f.root, "launches");
    const release = join(f.root, "release");
    await writeFile(
      bundle,
      `const fs = require('node:fs'); fs.appendFileSync(${JSON.stringify(launches)}, 'old\\n'); setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) process.exit(1); }, 20);`,
    );
    const service = new SystemdUserService({ factoryCommand: [process.execPath, bundle] });
    const command = (...args: string[]) =>
      execFileSync("systemctl", ["--user", ...args], { encoding: "utf8" });
    const unit = service.unitName(f.input);
    try {
      await service.install(f.input);
      // Speed up only this isolated fixture's retry clock, retaining the actual
      // installed ExecCondition, ExecStart and failure classification.
      const dropin = `${service.unitPath(f.input)}.d`;
      await mkdir(dropin, { recursive: true });
      await writeFile(join(dropin, "retry.conf"), "[Service]\nRestartSec=100ms\n");
      command("daemon-reload");
      if (active) await service.start(f.input);
      await rm(bundle);
      if (active) {
        expect(await service.status(f.input)).toMatchObject({
          active: true,
          launcherCurrent: false,
        });
        expect(await readFile(launches, "utf8")).toBe("old\n");
        const originalUnit = await readFile(service.unitPath(f.input), "utf8");
        const replacement = join(f.root, "replacement.js");
        await writeFile(replacement, "process.exit(0);\n");
        const newer = new SystemdUserService({ factoryCommand: [process.execPath, replacement] });
        await expect(newer.install(f.input)).rejects.toThrow("settle work and owned resources");
        expect(await readFile(service.unitPath(f.input), "utf8")).toBe(originalUnit);
        // Eviction alone neither terminates the old process nor adopts new bytes.
        await writeFile(release, "settled fixture\n");
      } else command("start", unit);
      await expect
        .poll(async () => (await service.status(f.input)).serviceResult)
        .toBe("exec-condition");
      const stopped = await service.status(f.input);
      expect(stopped.restartCount).toBe(active ? 1 : 0);
      expect(stopped).toMatchObject({
        active: false,
        fuseState: "tripped",
        lastSafeDiagnosticCode: "controller-launcher-failure",
        reasonCode: "controller-launcher-stale",
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect((await service.status(f.input)).restartCount).toBe(stopped.restartCount);
      if (active) expect(await readFile(launches, "utf8")).toBe("old\n");
      else await expect(readFile(launches)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await service.uninstall(f.input);
      await rm(`${service.unitPath(f.input)}.d`, { recursive: true, force: true });
      command("daemon-reload");
    }
  },
);

const installedIntegration =
  process.env.FACTORY_SYSTEMD_INTEGRATION === "1" && process.env.FACTORY_CACHE_TEST_PACKAGE
    ? it
    : it.skip;
installedIntegration(
  "qualifies staged package eviction, explicit upgrade and exact-byte rejection through the installed CLI",
  async () => {
    const f = await fixture();
    const previous = join(f.root, "generation-old");
    const current = join(f.root, "generation-new");
    await cp(process.env.FACTORY_CACHE_TEST_PACKAGE!, previous, { recursive: true });
    await cp(process.env.FACTORY_CACHE_TEST_PACKAGE!, current, { recursive: true });
    const cli = (generation: string, operation: string) =>
      JSON.parse(
        execFileSync(
          process.execPath,
          [
            join(generation, "dist/factory.js"),
            "controller",
            operation,
            f.input.repository,
            "--repo",
            f.root,
          ],
          { encoding: "utf8" },
        ),
      );
    let unit: string | undefined;
    try {
      const installed = cli(previous, "install");
      unit = installed.unit;
      expect(installed.launcherCurrent).toBe(true);
      await rm(previous, { recursive: true });
      execFileSync("systemctl", ["--user", "start", unit!]);
      expect(cli(current, "status")).toMatchObject({
        active: false,
        reasonCode: "controller-launcher-stale",
        serviceResult: "exec-condition",
        restartCount: 0,
      });
      const refreshed = cli(current, "install");
      expect(refreshed).toMatchObject({
        active: false,
        launcherCurrent: true,
        executableIdentity: installed.executableIdentity,
      });
      // Different bytes at the same path must trip the identity fuse before any
      // GitHub access, activation or resource dispatch can occur.
      const bundle = join(current, "dist/factory.js");
      await writeFile(bundle, `${await readFile(bundle, "utf8")}\n// changed generation\n`);
      execFileSync("systemctl", ["--user", "start", unit!]);
      await expect.poll(() => cli(current, "status").mainExitStatus).toBe(203);
      expect(cli(current, "status")).toMatchObject({
        active: false,
        fuseState: "tripped",
        launcherCurrent: false,
        restartCount: 0,
      });
    } finally {
      if (unit) cli(current, "uninstall");
    }
  },
);
