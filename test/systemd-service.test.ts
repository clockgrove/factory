import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SystemdUserService } from "../src/service/systemd-user-service.js";

describe("systemd user service lifecycle", () => {
  it("is idempotent through install, start, stop, restart, status, and uninstall", async () => {
    const directory = await mkdtemp(join(tmpdir(), "factory-systemd-test-"));
    let enabled = false;
    let active = false;
    const calls: string[][] = [];
    const run = async (args: readonly string[]) => {
      calls.push([...args]);
      const action = args[0];
      if (action === "enable") enabled = true;
      if (action === "disable") enabled = false;
      if (action === "start" || action === "restart") active = true;
      if (action === "stop") active = false;
      if (action === "is-enabled" && !enabled) throw new Error("disabled");
      if (action === "is-active" && !active) throw new Error("inactive");
    };
    const service = new SystemdUserService({
      factoryCommand: ["/usr/bin/node", "/opt/factory/dist/factory.js"],
      unitDirectory: directory,
      run,
    });
    const input = { repository: "Owner/Repo", checkout: "/work/repo" };

    expect(await service.install(input)).toMatchObject({
      installed: true,
      enabled: true,
      active: false,
    });
    expect(await service.install(input)).toMatchObject({
      installed: true,
      enabled: true,
    });
    const unit = await readFile(service.unitPath(input), "utf8");
    expect(unit).toContain(
      'ExecStart="/usr/bin/node" "/opt/factory/dist/factory.js" controller run "Owner/Repo" --repo "/work/repo"',
    );
    expect(unit).toMatch(/^# Managed by Clockgrove Factory v2/);
    expect(await service.start(input)).toMatchObject({ active: true });
    expect(await service.start(input)).toMatchObject({ active: true });
    expect(await service.stop(input)).toMatchObject({ active: false });
    expect(await service.stop(input)).toMatchObject({ active: false });
    expect(await service.restart(input)).toMatchObject({ active: true });
    expect(await service.status(input)).toMatchObject({
      installed: true,
      enabled: true,
      active: true,
    });
    expect(await service.uninstall(input)).toMatchObject({
      installed: false,
      enabled: false,
      active: false,
    });
    expect(await service.uninstall(input)).toMatchObject({
      installed: false,
      enabled: false,
      active: false,
    });
    expect(calls.some((args) => args[0] === "daemon-reload")).toBe(true);
  });

  it("never overwrites an unmanaged unit with the deterministic Factory name", async () => {
    const directory = await mkdtemp(join(tmpdir(), "factory-systemd-owned-"));
    const service = new SystemdUserService({
      factoryExecutable: "/opt/factory/bin/factory",
      unitDirectory: directory,
      run: async () => {},
    });
    const input = { repository: "Owner/Repo", checkout: "/work/repo" };
    await writeFile(
      service.unitPath(input),
      "[Service]\nExecStart=/bin/false\n",
    );
    await expect(service.install(input)).rejects.toThrow(
      "refusing to overwrite unmanaged unit",
    );
    expect(await readFile(service.unitPath(input), "utf8")).toContain(
      "ExecStart=/bin/false",
    );
    await rm(directory, { recursive: true, force: true });
  });

  const integration =
    process.env.FACTORY_SYSTEMD_INTEGRATION === "1" ? it : it.skip;
  integration(
    "passes the live Linux/WSL systemd user lifecycle gate",
    async () => {
      const checkout = await mkdtemp(join(tmpdir(), "factory-systemd-live-"));
      const executable = join(checkout, "factory-controller-fixture");
      await writeFile(
        executable,
        "#!/bin/sh\ntrap 'exit 0' TERM INT\nwhile :; do sleep 1; done\n",
        { mode: 0o700 },
      );
      await chmod(executable, 0o700);
      const service = new SystemdUserService({ factoryExecutable: executable });
      const input = { repository: "FactoryLifecycleGate/Fixture", checkout };
      try {
        expect(await service.install(input)).toMatchObject({
          installed: true,
          enabled: true,
        });
        expect(await service.install(input)).toMatchObject({
          installed: true,
          enabled: true,
        });
        expect(await service.start(input)).toMatchObject({ active: true });
        expect(await service.stop(input)).toMatchObject({ active: false });
        expect(await service.restart(input)).toMatchObject({ active: true });
        expect(await service.status(input)).toMatchObject({
          installed: true,
          enabled: true,
          active: true,
        });
      } finally {
        expect(await service.uninstall(input)).toMatchObject({
          installed: false,
          enabled: false,
          active: false,
        });
        await rm(checkout, { recursive: true, force: true });
      }
    },
  );
});
