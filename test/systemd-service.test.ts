import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SystemdUserService } from "../src/service/systemd-user-service.js";

const commandFixtures: string[] = [];
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
  const run = vi.fn(async () => {});
  const create = (
    commandEnvironment: NonNullable<
      ConstructorParameters<typeof SystemdUserService>[0]["commandEnvironment"]
    >,
  ) =>
    new SystemdUserService({
      factoryCommand: [process.execPath, "/opt/factory/dist/factory.js"],
      unitDirectory: join(root, "units"),
      run,
      commandEnvironment,
    });
  return { root, input, executable, run, create };
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
      factoryCommand: [process.execPath, "/opt/factory.js"],
      unitDirectory: join(f.root, "units"),
      commandEnvironment: environment,
      run: async (args) => {
        if (args[0] === "enable") enabled = true;
        if (args[0] === "disable") enabled = false;
        if (["start", "restart"].includes(args[0]!)) active = true;
        if (args[0] === "stop") active = false;
        if (args[0] === "is-enabled" && !enabled) throw new Error("disabled");
        if (args[0] === "is-active" && !active) throw new Error("inactive");
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
});
