import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SystemdUserService } from "../src/service/systemd-user-service.js";

const commandFixtures: string[] = [];
const currentUserManager = async () => ({
  uid: 1000,
  runtimeDirectory: "/run/user/1000",
  environment: {
    LANG: "C",
    LC_ALL: "C",
    PATH: "/usr/bin:/bin",
    XDG_RUNTIME_DIR: "/run/user/1000",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
  },
});
afterEach(async () => {
  await Promise.all(
    commandFixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function commandFixture() {
  const root = await mkdtemp(join(tmpdir(), "factory-systemd-commands-"));
  commandFixtures.push(root);
  const executable = async (
    directory: string,
    name: string,
    content = "#!/bin/sh\nprintf 'fixture'\n",
  ) => {
    const path = join(root, directory, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, { mode: 0o700 });
    return path;
  };
  const input = { repository: "Owner/Repo", checkout: root };
  const factoryBundle = await executable("factory", "factory.js");
  const unitDirectory = join(root, "units");
  let enabled = false;
  let active = false;
  const run = vi.fn(async (args: readonly string[]) => {
    if (isVersionProbe(args)) return { stdout: "259\n" };
    if (args[0] === "enable") enabled = true;
    if (args[0] === "disable") enabled = false;
    if (["start", "restart"].includes(args[0]!)) active = true;
    if (args[0] === "stop") active = false;
    if (isUnitProbe(args)) {
      const installed = await fileExists(join(unitDirectory, args[1]!));
      return systemdState(args[1]!, {
        loadState: installed ? "loaded" : "not-found",
        enabled,
        active,
      });
    }
  });
  const create = (
    commandEnvironment: NonNullable<
      ConstructorParameters<typeof SystemdUserService>[0]["commandEnvironment"]
    >,
  ) =>
    new SystemdUserService({
      factoryCommand: [process.execPath, factoryBundle],
      unitDirectory,
      run,
      currentUserManager,
      commandEnvironment,
      startupHealthDelayMs: 0,
    });
  return { root, input, executable, factoryBundle, run, create };
}
function isVersionProbe(args: readonly string[]): boolean {
  return args[0] === "show" && args[1] === "--property=Version";
}
function isUnitProbe(args: readonly string[]): boolean {
  return args[0] === "show" && !args[1]?.startsWith("--");
}
function systemdState(
  unit: string,
  options: {
    loadState?: string;
    enabled?: boolean;
    active?: boolean;
    result?: string;
    exitStatus?: number;
    restarts?: number;
  } = {},
): { stdout: string } {
  return {
    stdout: [
      `Id=${unit}`,
      `LoadState=${options.loadState ?? "loaded"}`,
      `UnitFileState=${options.enabled ? "enabled" : "disabled"}`,
      `ActiveState=${options.active ? "active" : "inactive"}`,
      `Result=${options.result ?? "success"}`,
      `ExecMainStatus=${options.exitStatus ?? 0}`,
      `NRestarts=${options.restarts ?? 0}`,
      "",
    ].join("\n"),
  };
}
async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
function unitEnvironment(unit: string): Record<string, string> {
  return Object.fromEntries(
    unit
      .split("\n")
      .filter((line) => line.startsWith("Environment="))
      .map((line) => {
        const assignment = (JSON.parse(line.slice("Environment=".length)) as string).replaceAll(
          "%%",
          "%",
        );
        const equals = assignment.indexOf("=");
        return [assignment.slice(0, equals), assignment.slice(equals + 1)];
      }),
  );
}

describe("systemd installed command discovery", () => {
  it("preserves original search order when the gh directory also contains another Codex", async () => {
    const f = await commandFixture();
    const preferred = await f.executable("first", "codex", "#!/bin/sh\nprintf 'preferred'\n");
    const gh = await f.executable("second", "gh");
    await f.executable("second", "codex", "#!/bin/sh\nprintf 'other'\n");
    const service = f.create(() => ({ PATH: `${dirname(preferred)}:${dirname(gh)}` }));
    await service.install(f.input);
    const installed = unitEnvironment(await readFile(service.unitPath(f.input), "utf8"));
    expect(installed.PATH!.split(":").slice(0, 2)).toEqual([dirname(preferred), dirname(gh)]);
    expect(execFileSync("codex", [], { env: installed, encoding: "utf8" })).toBe("preferred");
  });

  it("does not discover an executable reachable only through a relative installer PATH entry", async () => {
    const f = await commandFixture();
    const command = await f.executable("relative-bin", "codex");
    const service = f.create(() => ({ PATH: `:${relative(process.cwd(), dirname(command))}:` }));
    await service.install(f.input);
    expect(
      unitEnvironment(await readFile(service.unitPath(f.input), "utf8")).PATH!.split(":"),
    ).not.toContain(dirname(command));
  });

  it("persists only discovered user tool directories and executes them with the installed PATH", async () => {
    const f = await commandFixture();
    const gh = await f.executable("github-bin", "gh", "#!/bin/sh\nprintf 'github-fixture'\n");
    const codex = await f.executable(
      "codex-bin",
      "codex",
      "#!/usr/bin/env node\nprocess.stdout.write('codex-fixture');\n",
    );
    const unrelated = join(f.root, "unrelated");
    const environment = {
      PATH: `${dirname(gh)}:${dirname(codex)}:${dirname(gh)}:${unrelated}`,
      GITHUB_TOKEN: "private-github-fixture",
      OPENAI_API_KEY: "private-model-fixture",
      CODEX_HOME: "/private/home",
      HOME: "/private/operator",
      UNRELATED: "private-value",
    };
    const service = f.create(() => environment);
    await service.install(f.input);
    const unit = await readFile(service.unitPath(f.input), "utf8");
    const installed = unitEnvironment(unit);
    const directories = installed.PATH!.split(":");
    expect(directories).toContain(dirname(gh));
    expect(directories).toContain(dirname(codex));
    expect(directories).toContain(dirname(process.execPath));
    expect(directories).toContain("/usr/bin");
    expect(directories).not.toContain(unrelated);
    expect(new Set(directories).size).toBe(directories.length);
    expect(Object.keys(installed)).toEqual(["PATH"]);
    expect(unit).not.toMatch(/private-|GITHUB_TOKEN|OPENAI_API_KEY|CODEX_HOME|UNRELATED/);
    expect(execFileSync("gh", [], { env: installed, encoding: "utf8" })).toBe("github-fixture");
    expect(execFileSync("codex", [], { env: installed, encoding: "utf8" })).toBe("codex-fixture");
    await service.install(f.input);
    expect(await readFile(service.unitPath(f.input), "utf8")).toBe(unit);
  });

  it("persists an explicitly selected private management transcript directory", async () => {
    const f = await commandFixture();
    const codex = await f.executable("codex-bin", "codex");
    const transcriptDirectory = join(f.root, "private transcripts");
    const service = f.create(() => ({
      PATH: dirname(codex),
      FACTORY_MANAGEMENT_TRANSCRIPT_DIR: transcriptDirectory,
    }));
    await service.install(f.input);
    const environment = unitEnvironment(await readFile(service.unitPath(f.input), "utf8"));
    expect(environment.FACTORY_MANAGEMENT_TRANSCRIPT_DIR).toBe(transcriptDirectory);
  });

  it.each(["relative/transcripts", "/private/transcripts\nEnvironment=BAD=value"])(
    "rejects unsafe management transcript directory %j",
    async (transcriptDirectory) => {
      const f = await commandFixture();
      const codex = await f.executable("codex-bin", "codex");
      const service = f.create(() => ({
        PATH: dirname(codex),
        FACTORY_MANAGEMENT_TRANSCRIPT_DIR: transcriptDirectory,
      }));
      await expect(service.install(f.input)).rejects.toThrow("safe absolute path");
      await expect(readFile(service.unitPath(f.input))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each(["basename", "absolute"])(
    "preserves an explicitly selected custom Codex %s",
    async (kind) => {
      const f = await commandFixture();
      const custom = await f.executable("custom-bin", "pinned-codex");
      const service = f.create(() => ({
        PATH: dirname(custom),
        FACTORY_CODEX_PATH: kind === "absolute" ? custom : "pinned-codex",
      }));
      await service.install(f.input);
      const environment = unitEnvironment(await readFile(service.unitPath(f.input), "utf8"));
      expect(environment.FACTORY_CODEX_PATH).toBe(custom);
      expect(environment.PATH!.split(":")).toContain(dirname(custom));
    },
  );

  it("keeps the discovered symlink launcher directory rather than its target directory", async () => {
    const f = await commandFixture();
    const target = await f.executable("package-internals", "cli");
    const launcher = join(f.root, "user-bin", "codex");
    await mkdir(dirname(launcher), { recursive: true });
    await symlink(target, launcher);
    const service = f.create(() => ({ PATH: dirname(launcher) }));
    await service.install(f.input);
    const directories = unitEnvironment(
      await readFile(service.unitPath(f.input), "utf8"),
    ).PATH!.split(":");
    expect(directories).toContain(dirname(launcher));
    expect(directories).not.toContain(dirname(target));
  });

  it("escapes percent specifiers, spaces, quotes and backslashes without expanding variables", async () => {
    const f = await commandFixture();
    const custom = await f.executable('bin with %h "quote" \\slash $HOME', "custom");
    const service = f.create(() => ({ PATH: dirname(custom), FACTORY_CODEX_PATH: custom }));
    await service.install(f.input);
    const unit = await readFile(service.unitPath(f.input), "utf8");
    expect(unit).toContain("%%h");
    expect(unit).toContain('\\"quote\\"');
    expect(unitEnvironment(unit).FACTORY_CODEX_PATH).toBe(custom);
    expect(unitEnvironment(unit).PATH!.split(":")).toContain(dirname(custom));
  });

  it.each(["\n", "\r", "\t", "\u0000", "\u007f", "\u2028"])(
    "rejects nonprintable override character %j before writing a unit",
    async (character) => {
      const f = await commandFixture();
      const service = f.create(() => ({ FACTORY_CODEX_PATH: `/opt/co${character}dex` }));
      await expect(service.install(f.input)).rejects.toThrow("unsupported characters");
      expect(f.run).not.toHaveBeenCalled();
      await expect(readFile(service.unitPath(f.input))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("ignores empty, relative and malformed PATH entries and omits unavailable optional tools", async () => {
    const f = await commandFixture();
    const service = f.create(() => ({
      PATH: `:.:relative-bin:${f.root}/bad\npath:${f.root}/absent::`,
    }));
    await service.install(f.input);
    const environment = unitEnvironment(await readFile(service.unitPath(f.input), "utf8"));
    expect(Object.keys(environment)).toEqual(["PATH"]);
    const directories = environment.PATH!.split(":");
    expect(
      directories.every((directory) => directory.startsWith("/") && directory.length > 1),
    ).toBe(true);
    expect(directories.some((directory) => directory.startsWith(f.root))).toBe(false);
    expect(directories).toContain("/usr/bin");
  });

  it.each(["missing", "non-executable", "directory", "colon"])(
    "rejects an explicit %s Codex command without replacing the installed unit",
    async (kind) => {
      const f = await commandFixture();
      let configured: string | undefined;
      const service = f.create(() => ({ PATH: "", FACTORY_CODEX_PATH: configured }));
      await service.install(f.input);
      const before = await readFile(service.unitPath(f.input), "utf8");
      f.run.mockClear();
      configured =
        kind === "missing"
          ? join(f.root, "absent")
          : kind === "directory"
            ? f.root
            : await f.executable(kind === "colon" ? "bad:directory" : "bin", "custom");
      if (kind === "non-executable") await chmod(configured, 0o600);
      await expect(service.install(f.input)).rejects.toThrow(
        "configured Codex executable is unavailable",
      );
      expect(await readFile(service.unitPath(f.input), "utf8")).toBe(before);
      expect(f.run).not.toHaveBeenCalled();
    },
  );

  it("does not discover commands during constructor, start, restart, stop, status or uninstall", async () => {
    const f = await commandFixture();
    const environment = vi.fn(() => ({ PATH: "" }));
    let enabled = false;
    let active = false;
    const service = new SystemdUserService({
      factoryCommand: [process.execPath, f.factoryBundle],
      unitDirectory: join(f.root, "units"),
      commandEnvironment: environment,
      startupHealthDelayMs: 0,
      currentUserManager,
      run: async (args) => {
        if (isVersionProbe(args)) return { stdout: "259\n" };
        if (args[0] === "enable") enabled = true;
        if (args[0] === "disable") enabled = false;
        if (["start", "restart"].includes(args[0]!)) active = true;
        if (args[0] === "stop") active = false;
        if (isUnitProbe(args)) {
          const installed = await fileExists(join(f.root, "units", args[1]!));
          return systemdState(args[1]!, {
            loadState: installed ? "loaded" : "not-found",
            enabled,
            active,
          });
        }
      },
    });
    expect(environment).not.toHaveBeenCalled();
    await service.install(f.input);
    expect(environment).toHaveBeenCalledTimes(1);
    environment.mockImplementation(() => {
      throw new Error("discovery unavailable");
    });
    await service.start(f.input);
    await service.restart(f.input);
    await service.stop(f.input);
    await service.status(f.input);
    await service.uninstall(f.input);
    expect(environment).toHaveBeenCalledTimes(1);
  });
});

describe("systemd user service lifecycle", () => {
  it("fails before unit mutation when the current Linux user manager is unavailable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "factory-systemd-no-user-bus-"));
    const bundle = join(directory, "desktop-cache", "factory.js");
    await mkdir(dirname(bundle), { recursive: true });
    await writeFile(bundle, "// desktop controller fixture\n");
    const run = vi.fn(async () => {});
    const service = new SystemdUserService({
      factoryCommand: [process.execPath, bundle],
      unitDirectory: join(directory, "units"),
      commandEnvironment: () => ({ PATH: "" }),
      currentUserManager: async () => {
        throw new Error("XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS are unset");
      },
      run,
    });
    const input = {
      repository: "Owner/Repo",
      checkout: "/work/repo",
      requestId: "desktop-mcp-install-1",
    };

    await expect(service.install(input)).rejects.toThrow(
      /controller-user-manager-unavailable:.*same user.*controller.*install.*desktop-mcp-install-1/,
    );
    await expect(readFile(service.unitPath(input))).rejects.toMatchObject({ code: "ENOENT" });
    expect(run).not.toHaveBeenCalled();
    await expect(service.status({ ...input, requestId: "desktop-mcp-status-1" })).rejects.toThrow(
      /controller-user-manager-unavailable:.*controller.*status.*desktop-mcp-status-1/,
    );
  });

  it("rolls back a new unit when daemon reload fails after the atomic write", async () => {
    const directory = await mkdtemp(join(tmpdir(), "factory-systemd-install-rollback-"));
    const bundle = join(directory, "factory.js");
    const units = join(directory, "units");
    await writeFile(bundle, "// controller fixture\n");
    let reloads = 0;
    let enabled = false;
    const run = vi.fn(async (args: readonly string[]) => {
      if (isVersionProbe(args)) return { stdout: "259\n" };
      if (args[0] === "daemon-reload" && reloads++ === 0) {
        throw new Error("fixture reload failure");
      }
      if (args[0] === "enable") enabled = true;
      if (args[0] === "disable") enabled = false;
      if (isUnitProbe(args)) {
        const installed = await fileExists(join(units, args[1]!));
        return systemdState(args[1]!, {
          loadState: installed ? "loaded" : "not-found",
          enabled,
        });
      }
    });
    const service = new SystemdUserService({
      factoryCommand: [process.execPath, bundle],
      unitDirectory: units,
      commandEnvironment: () => ({ PATH: "" }),
      currentUserManager,
      run,
    });
    const input = { repository: "Owner/Repo", checkout: "/work/repo" };

    await expect(service.install(input)).rejects.toThrow(
      /controller-install-failed:.*prior unit state was restored and verified/,
    );
    await expect(readFile(service.unitPath(input))).rejects.toMatchObject({ code: "ENOENT" });
    expect(enabled).toBe(false);
    expect(reloads).toBe(2);
  });

  it("does not translate a user-manager transport failure into disabled and inactive", async () => {
    const f = await commandFixture();
    const service = new SystemdUserService({
      factoryCommand: [process.execPath, f.factoryBundle],
      unitDirectory: join(f.root, "units"),
      commandEnvironment: () => ({ PATH: "" }),
      currentUserManager,
      run: async (args) => {
        if (isVersionProbe(args)) return { stdout: "259\n" };
        if (isUnitProbe(args)) throw new Error("Failed to connect to bus: Operation not permitted");
      },
    });

    await expect(service.status(f.input)).rejects.toThrow(
      /controller-user-manager-unavailable: status could not inspect.*Operation not permitted/,
    );
  });

  it("discards arbitrary inherited bus and cross-user manager variables", async () => {
    const f = await commandFixture();
    const environments: NodeJS.ProcessEnv[] = [];
    const service = new SystemdUserService({
      factoryCommand: [process.execPath, f.factoryBundle],
      unitDirectory: join(f.root, "units"),
      currentUserManager: async () => ({
        uid: process.getuid!(),
        runtimeDirectory: `/run/user/${process.getuid!()}`,
        environment: {
          XDG_RUNTIME_DIR: "/run/user/9999",
          DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/arbitrary-bus",
          SYSTEMD_BUS_ADDRESS: "unix:path=/tmp/cross-user-bus",
        },
      }),
      run: async (args, environment) => {
        environments.push(environment);
        if (isVersionProbe(args)) return { stdout: "259\n" };
        if (isUnitProbe(args)) return systemdState(args[1]!, { loadState: "not-found" });
      },
    });

    expect(await service.status(f.input)).toMatchObject({
      installed: false,
      reasonCode: "controller-not-installed",
    });
    expect(environments).toHaveLength(2);
    for (const environment of environments) {
      expect(environment.XDG_RUNTIME_DIR).toBe(`/run/user/${process.getuid!()}`);
      expect(environment.DBUS_SESSION_BUS_ADDRESS).toBe(
        `unix:path=/run/user/${process.getuid!()}/bus`,
      );
      expect(environment.SYSTEMD_BUS_ADDRESS).toBeUndefined();
    }
  });

  it("accepts and preserves a byte-identical retained Linux launcher", async () => {
    const directory = await mkdtemp(join(tmpdir(), "factory-systemd-retained-launcher-"));
    const retained = join(directory, "linux-cache", "factory.js");
    const desktop = join(directory, "windows-cache", "factory.js");
    const units = join(directory, "units");
    await mkdir(dirname(retained), { recursive: true });
    await mkdir(dirname(desktop), { recursive: true });
    await writeFile(retained, "// byte-identical controller generation\n");
    await writeFile(desktop, "// byte-identical controller generation\n");
    let enabled = false;
    const run = async (args: readonly string[]) => {
      if (isVersionProbe(args)) return { stdout: "259\n" };
      if (args[0] === "enable") enabled = true;
      if (args[0] === "disable") enabled = false;
      if (isUnitProbe(args)) {
        const installed = await fileExists(join(units, args[1]!));
        return systemdState(args[1]!, {
          loadState: installed ? "loaded" : "not-found",
          enabled,
        });
      }
    };
    const options = {
      unitDirectory: units,
      commandEnvironment: () => ({ PATH: "" }),
      currentUserManager,
      run,
      startupHealthDelayMs: 0,
    };
    const retainedService = new SystemdUserService({
      ...options,
      factoryCommand: [process.execPath, retained],
    });
    const desktopService = new SystemdUserService({
      ...options,
      factoryCommand: [process.execPath, desktop],
    });
    const input = { repository: "Owner/Repo", checkout: "/work/repo" };
    await retainedService.install(input);
    const retainedUnit = await readFile(retainedService.unitPath(input), "utf8");

    expect(await desktopService.status(input)).toMatchObject({
      installed: true,
      enabled: true,
      launcherCurrent: true,
      reasonCode: "controller-inactive",
    });
    await desktopService.install(input);
    const afterDesktopInstall = await readFile(desktopService.unitPath(input), "utf8");
    expect(afterDesktopInstall).toBe(retainedUnit);
    expect(afterDesktopInstall).toContain(`"${retained}"`);
    expect(afterDesktopInstall).not.toContain(`"${desktop}"`);
  });

  it("is idempotent through install, start, stop, restart, status, and uninstall", async () => {
    const directory = await mkdtemp(join(tmpdir(), "factory-systemd-test-"));
    const bundle = join(directory, "factory.js");
    await writeFile(bundle, "// controller fixture\n");
    let enabled = false;
    let active = false;
    const calls: string[][] = [];
    const run = async (args: readonly string[]) => {
      calls.push([...args]);
      if (isVersionProbe(args)) return { stdout: "259\n" };
      const action = args[0];
      if (action === "enable") enabled = true;
      if (action === "disable") enabled = false;
      if (action === "start" || action === "restart") active = true;
      if (action === "stop") active = false;
      if (isUnitProbe(args)) {
        const installed = await fileExists(join(directory, args[1]!));
        return systemdState(args[1]!, {
          loadState: installed ? "loaded" : "not-found",
          enabled,
          active,
        });
      }
    };
    const service = new SystemdUserService({
      factoryCommand: [process.execPath, bundle],
      unitDirectory: directory,
      run,
      currentUserManager,
      startupHealthDelayMs: 0,
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
      `ExecStart="${process.execPath}" "${bundle}" controller run "Owner/Repo" --repo "/work/repo"`,
    );
    expect(unit).toMatch(/^# Managed by Clockgrove Factory v2/);
    expect(unit).toMatch(/^# FactoryExecutableIdentity=sha256:[a-f0-9]{64}$/m);
    expect(unit).toContain("RestartPreventExitStatus=2 65 70 72 78 130 203");
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

  it("classifies a stale managed launcher and repairs it through idempotent install", async () => {
    const directory = await mkdtemp(join(tmpdir(), "factory-systemd-stale-"));
    const bundle = join(directory, "current", "factory.js");
    await mkdir(dirname(bundle), { recursive: true });
    await writeFile(bundle, "// current controller fixture\n");
    let enabled = true;
    let active = true;
    const calls: string[][] = [];
    const service = new SystemdUserService({
      factoryCommand: [process.execPath, bundle],
      unitDirectory: directory,
      startupHealthDelayMs: 0,
      currentUserManager,
      run: async (args) => {
        calls.push([...args]);
        if (isVersionProbe(args)) return { stdout: "259\n" };
        if (args[0] === "enable") enabled = true;
        if (args[0] === "start") active = true;
        if (isUnitProbe(args)) {
          const installed = await fileExists(join(directory, args[1]!));
          return systemdState(args[1]!, {
            loadState: installed ? "loaded" : "not-found",
            enabled: installed && enabled,
            active: installed && active,
          });
        }
      },
    });
    const input = { repository: "Owner/Repo", checkout: "/work/repo" };
    await writeFile(
      service.unitPath(input),
      '# Managed by Clockgrove Factory v2\n[Service]\nExecStart="/usr/bin/node" "/missing/old-cache/factory.js" controller run "Owner/Repo" --repo "/work/repo"\n',
    );

    expect(await service.status(input)).toMatchObject({
      installed: true,
      enabled: true,
      active: true,
      launcherCurrent: false,
      healthy: false,
      reasonCode: "controller-launcher-stale",
      action: expect.stringContaining("work and owned resources settle"),
    });
    await expect(service.start(input)).rejects.toThrow("controller-launcher-stale");
    expect(calls.some((args) => args[0] === "start")).toBe(false);

    active = false;
    expect(await service.install(input)).toMatchObject({
      launcherCurrent: true,
      reasonCode: "controller-inactive",
    });
    expect(await readFile(service.unitPath(input), "utf8")).toContain(`"${bundle}"`);
    expect(await service.start(input)).toMatchObject({ healthy: true, reasonCode: null });
  });

  it("rejects a successful systemctl request when the controller immediately exits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "factory-systemd-start-health-"));
    const bundle = join(directory, "factory.js");
    await writeFile(bundle, "// controller fixture\n");
    let enabled = false;
    let active = false;
    const service = new SystemdUserService({
      factoryCommand: [process.execPath, bundle],
      unitDirectory: directory,
      startupHealthDelayMs: 10,
      currentUserManager,
      run: async (args) => {
        if (isVersionProbe(args)) return { stdout: "259\n" };
        if (args[0] === "enable") enabled = true;
        if (args[0] === "start") {
          active = true;
          setTimeout(() => {
            active = false;
          }, 0);
        }
        if (isUnitProbe(args)) {
          const installed = await fileExists(join(directory, args[1]!));
          return systemdState(args[1]!, {
            loadState: installed ? "loaded" : "not-found",
            enabled: installed && enabled,
            active: installed && active,
          });
        }
      },
    });
    const input = { repository: "Owner/Repo", checkout: "/work/repo" };
    await service.install(input);

    await expect(service.start(input)).rejects.toThrow(
      /controller-start-unhealthy:.*controller-inactive/,
    );
    expect(await service.status(input)).toMatchObject({
      launcherCurrent: true,
      healthy: false,
      reasonCode: "controller-inactive",
    });
  });

  it.each([
    [65, "controller-durable-state-incompatible"],
    [70, "controller-internal-invariant"],
    [72, "controller-discovery-failure"],
    [78, "controller-local-configuration"],
    [203, "controller-launcher-failure"],
  ] as const)(
    "reports fatal exit %i as a tripped %s fuse with an operator action",
    async (exitStatus, code) => {
      const f = await commandFixture();
      let enabled = true;
      const service = new SystemdUserService({
        factoryCommand: [process.execPath, f.factoryBundle],
        unitDirectory: join(f.root, "units"),
        commandEnvironment: () => ({ PATH: "" }),
        startupHealthDelayMs: 0,
        currentUserManager,
        run: async (args) => {
          if (isVersionProbe(args)) return { stdout: "259\n" };
          if (args[0] === "enable") enabled = true;
          if (isUnitProbe(args)) {
            const installed = await fileExists(join(f.root, "units", args[1]!));
            return systemdState(args[1]!, {
              loadState: installed ? "loaded" : "not-found",
              enabled: installed && enabled,
              result: "exit-code",
              exitStatus,
              restarts: 3,
            });
          }
        },
      });
      await service.install(f.input);
      expect(await service.status(f.input)).toMatchObject({
        active: false,
        healthy: false,
        fuseState: "tripped",
        lastSafeDiagnosticCode: code,
        reasonCode: code,
        mainExitStatus: exitStatus,
        restartCount: 3,
        action: expect.stringContaining("explicitly restart"),
        executableIdentity: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        currentExecutableIdentity: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      });
    },
  );

  it("keeps unexpected process signals retryable instead of misreporting a fatal fuse", async () => {
    const f = await commandFixture();
    const service = new SystemdUserService({
      factoryCommand: [process.execPath, f.factoryBundle],
      unitDirectory: join(f.root, "units"),
      commandEnvironment: () => ({ PATH: "" }),
      startupHealthDelayMs: 0,
      currentUserManager,
      run: async (args) => {
        if (isVersionProbe(args)) return { stdout: "259\n" };
        if (isUnitProbe(args)) {
          const installed = await fileExists(join(f.root, "units", args[1]!));
          return systemdState(args[1]!, {
            loadState: installed ? "loaded" : "not-found",
            enabled: installed,
            result: "signal",
            exitStatus: 9,
            restarts: 1,
          });
        }
      },
    });
    await service.install(f.input);
    expect(await service.status(f.input)).toMatchObject({
      fuseState: "armed",
      lastSafeDiagnosticCode: "controller-process-signal",
      reasonCode: "controller-inactive",
      restartCount: 1,
    });
  });

  it("lets an explicit operator restart re-evaluate a tripped controller", async () => {
    const f = await commandFixture();
    let fatal = true;
    let active = false;
    const service = new SystemdUserService({
      factoryCommand: [process.execPath, f.factoryBundle],
      unitDirectory: join(f.root, "units"),
      commandEnvironment: () => ({ PATH: "" }),
      startupHealthDelayMs: 0,
      currentUserManager,
      run: async (args) => {
        if (isVersionProbe(args)) return { stdout: "259\n" };
        if (args[0] === "restart") {
          fatal = false;
          active = true;
        }
        if (isUnitProbe(args)) {
          const installed = await fileExists(join(f.root, "units", args[1]!));
          return systemdState(args[1]!, {
            loadState: installed ? "loaded" : "not-found",
            enabled: installed,
            active: installed && active,
            result: fatal ? "exit-code" : "success",
            exitStatus: fatal ? 72 : 0,
          });
        }
      },
    });
    expect(await service.install(f.input)).toMatchObject({
      fuseState: "tripped",
      reasonCode: "controller-discovery-failure",
    });
    expect(await service.restart(f.input)).toMatchObject({
      active: true,
      healthy: true,
      fuseState: "armed",
      lastSafeDiagnosticCode: null,
    });
  });

  it("detects changed artifact bytes and refreshes their exact identity before explicit restart", async () => {
    const f = await commandFixture();
    let active = false;
    const service = new SystemdUserService({
      factoryCommand: [process.execPath, f.factoryBundle],
      unitDirectory: join(f.root, "units"),
      commandEnvironment: () => ({ PATH: "" }),
      startupHealthDelayMs: 0,
      currentUserManager,
      run: async (args) => {
        if (isVersionProbe(args)) return { stdout: "259\n" };
        if (args[0] === "restart") active = true;
        if (isUnitProbe(args)) {
          const installed = await fileExists(join(f.root, "units", args[1]!));
          return systemdState(args[1]!, {
            loadState: installed ? "loaded" : "not-found",
            enabled: installed,
            active: installed && active,
          });
        }
      },
    });
    const installed = await service.install(f.input);
    await writeFile(f.factoryBundle, "// corrected controller fixture\n");
    const changed = await service.status(f.input);
    expect(changed).toMatchObject({
      launcherCurrent: false,
      reasonCode: "controller-launcher-stale",
    });
    expect(changed.currentExecutableIdentity).not.toBe(installed.executableIdentity);
    const refreshed = await service.install(f.input);
    expect(refreshed).toMatchObject({ launcherCurrent: true });
    expect(refreshed.executableIdentity).toBe(changed.currentExecutableIdentity);
    expect(await service.restart(f.input)).toMatchObject({ active: true, healthy: true });
  });

  it("refuses to install an unavailable launcher without creating a startable unit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "factory-systemd-missing-launcher-"));
    const run = vi.fn(async () => {});
    const service = new SystemdUserService({
      factoryExecutable: join(directory, "missing-factory"),
      unitDirectory: directory,
      commandEnvironment: () => ({ PATH: "" }),
      currentUserManager,
      run,
    });
    const input = { repository: "Owner/Repo", checkout: "/work/repo" };
    await expect(service.install(input)).rejects.toThrow("controller-launcher-failure");
    await expect(readFile(service.unitPath(input))).rejects.toMatchObject({ code: "ENOENT" });
    expect(run).not.toHaveBeenCalled();
    await rm(directory, { recursive: true, force: true });
  });

  it("never overwrites an unmanaged unit with the deterministic Factory name", async () => {
    const directory = await mkdtemp(join(tmpdir(), "factory-systemd-owned-"));
    const service = new SystemdUserService({
      factoryExecutable: "/opt/factory/bin/factory",
      unitDirectory: directory,
      currentUserManager,
      run: async () => {},
    });
    const input = { repository: "Owner/Repo", checkout: "/work/repo" };
    await writeFile(service.unitPath(input), "[Service]\nExecStart=/bin/false\n");
    await expect(service.install(input)).rejects.toThrow("refusing to overwrite unmanaged unit");
    expect(await readFile(service.unitPath(input), "utf8")).toContain("ExecStart=/bin/false");
    await rm(directory, { recursive: true, force: true });
  });

  const integration = process.env.FACTORY_SYSTEMD_INTEGRATION === "1" ? it : it.skip;
  integration("passes the live Linux/WSL systemd user lifecycle gate", async () => {
    const checkout = await mkdtemp(join(tmpdir(), "factory-systemd-live-"));
    const executable = join(checkout, "factory-controller-fixture");
    await writeFile(executable, "#!/bin/sh\ntrap 'exit 0' TERM INT\nwhile :; do sleep 1; done\n", {
      mode: 0o700,
    });
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
  });

  integration("bounds a real deterministic fatal process to one service generation", async () => {
    const checkout = await mkdtemp(join(tmpdir(), "factory-systemd-fatal-"));
    const executable = join(checkout, "factory-controller-fatal-fixture");
    const launches = join(checkout, "launches");
    const requests = join(checkout, "requests");
    const leases = join(checkout, "leases");
    const objectives = join(checkout, "objectives");
    const resources = join(checkout, "resources");
    await writeFile(
      executable,
      `#!/bin/sh\nprintf 'launch\\n' >> ${JSON.stringify(launches)}\nprintf 'repository-facts\\nbranch-head\\nlease-acquire\\nactivation-discovery\\n' >> ${JSON.stringify(requests)}\nprintf 'epoch-1\\n' >> ${JSON.stringify(leases)}\nexit 70\n`,
      { mode: 0o700 },
    );
    const service = new SystemdUserService({
      factoryExecutable: executable,
      startupHealthDelayMs: 250,
    });
    const input = { repository: "FactoryFatalFuseGate/Fixture", checkout };
    try {
      await service.install(input);
      await expect(service.start(input)).rejects.toThrow("controller-internal-invariant");
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect((await readFile(launches, "utf8")).trim().split("\n")).toEqual(["launch"]);
      expect((await readFile(requests, "utf8")).trim().split("\n")).toEqual([
        "repository-facts",
        "branch-head",
        "lease-acquire",
        "activation-discovery",
      ]);
      expect((await readFile(leases, "utf8")).trim().split("\n")).toEqual(["epoch-1"]);
      await expect(readFile(objectives)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(resources)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await service.status(input)).toMatchObject({
        active: false,
        fuseState: "tripped",
        lastSafeDiagnosticCode: "controller-internal-invariant",
        restartCount: 0,
      });
    } finally {
      await service.uninstall(input);
      await rm(checkout, { recursive: true, force: true });
    }
  });
});
