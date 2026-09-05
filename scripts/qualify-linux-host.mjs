/** No-model installed-product and disposable Linux host component qualification.
 * This is release evidence, never Factory's durable orchestration state. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { arch, platform, release, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const hostClasses = ["native-linux", "wsl2", "macos-linux-guest"];

export function classifyLinuxHost({ platform, kernel, virtualization, claimed = "auto" }) {
  assert.ok(["auto", ...hostClasses].includes(claimed), "invalid host class");
  let detected = "unavailable";
  if (platform !== "linux") detected = "unsupported";
  else if (/microsoft.*wsl2|wsl2.*microsoft/i.test(kernel)) detected = "wsl2";
  else if (/microsoft|wsl/i.test(kernel)) detected = "unsupported-wsl-version";
  else if (virtualization === "none") detected = "native-linux";
  else if (virtualization) detected = "linux-guest";
  const matched = claimed === "auto" || claimed === detected;
  return {
    platform,
    detected,
    claimed,
    claimVerified: matched && hostClasses.includes(detected),
    // A guest cannot attest its physical host OS using uname or its CPU architecture.
    reason:
      platform !== "linux"
        ? "native-platform-unsupported"
        : claimed === "macos-linux-guest" && detected === "linux-guest"
          ? "macos-host-provenance-required"
          : !matched
            ? "host-class-mismatch"
            : detected === "linux-guest"
              ? "guest-parent-os-unavailable"
              : detected === "unavailable"
                ? "virtualization-observation-unavailable"
                : null,
  };
}

export function qualificationEnvironment(environment = process.env) {
  // Allowlist avoids leaking arbitrary secrets through user-manager inheritance or child logs.
  return Object.fromEntries(
    [
      "PATH",
      "HOME",
      "XDG_CONFIG_HOME",
      "XDG_RUNTIME_DIR",
      "DBUS_SESSION_BUS_ADDRESS",
      "LANG",
      "LC_ALL",
      "TMPDIR",
    ].flatMap((name) => (typeof environment[name] === "string" ? [[name, environment[name]]] : [])),
  );
}

export function installedPluginRoot(listed, codexHome, version) {
  assert.match(version, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/);
  const installed = listed.installed?.filter(
    (entry) =>
      entry.name === "factory" &&
      entry.marketplaceName === "factory-install-test" &&
      entry.pluginId === "factory@factory-install-test" &&
      entry.version === version &&
      entry.installed === true &&
      entry.enabled === true,
  );
  assert.equal(installed?.length, 1, "one exact enabled installed plugin receipt is required");
  return join(resolve(codexHome), "plugins", "cache", "factory-install-test", "factory", version);
}

async function command(
  executable,
  args,
  { env = qualificationEnvironment(), cwd, timeout = 15_000 } = {},
) {
  try {
    const result = await exec(executable, args, { env, cwd, timeout, maxBuffer: 256 * 1024 });
    return result.stdout.trim();
  } catch {
    // Do not export provider diagnostics, private paths, environment, or raw subprocess output.
    throw new Error("qualification-command-failed");
  }
}

function properties(text) {
  const result = {};
  for (const line of text.trim().split("\n")) {
    const index = line.indexOf("=");
    assert.ok(index > 0 && !Object.hasOwn(result, line.slice(0, index)), "invalid unit properties");
    result[line.slice(0, index)] = line.slice(index + 1);
  }
  return result;
}
async function show(unit) {
  const args = [
    "--user",
    "show",
    unit,
    "--property=Id,LoadState,ActiveState,SubState,ControlGroup,InvocationID,MainPID,Job,KillMode",
    "--no-pager",
  ];
  try {
    const result = await exec("systemctl", args, {
      timeout: 10_000,
      maxBuffer: 16_384,
      env: qualificationEnvironment(),
    });
    return properties(result.stdout);
  } catch (error) {
    if ([1, 4].includes(error.code) && typeof error.stdout === "string") {
      const state = properties(error.stdout);
      if (
        state.Id === unit &&
        state.LoadState === "not-found" &&
        state.ActiveState === "inactive" &&
        state.ControlGroup === ""
      )
        return state;
    }
    throw new Error("unit-observation-unavailable");
  }
}

export function ownedCgroupPath(unit, state) {
  assert.match(unit, /^factory-qualification-[a-f0-9-]+\.service$/);
  assert.equal(state.Id, unit);
  const path = state.ControlGroup;
  assert.ok(typeof path === "string" && path.startsWith("/") && !path.includes("\0"));
  assert.ok(
    path
      .split("/")
      .slice(1)
      .every((part) => part && part !== "." && part !== ".."),
  );
  assert.equal(path.split("/").at(-1), unit);
  return `/sys/fs/cgroup${path}`;
}

export function assertOwnedServiceCleanup(unit, state, cgroupEvents) {
  assert.match(unit, /^factory-qualification-[a-f0-9-]+\.service$/);
  assert.equal(state?.Id, unit, "cleanup response belongs to another unit");
  assert.ok(["loaded", "not-found"].includes(state.LoadState));
  assert.ok(["inactive", "failed"].includes(state.ActiveState));
  assert.equal(state.ControlGroup, "", "disposable service still owns a cgroup");
  assert.ok(["", "0", "0 /"].includes(state.Job), "disposable service has a pending job");
  assert.ok(state.MainPID === undefined || state.MainPID === "0");
  const populated = cgroupEvents
    .trim()
    .split("\n")
    .filter((line) => line.startsWith("populated"));
  assert.deepEqual(populated, ["populated 0"], "disposable cgroup cleanup is ambiguous");
}

async function birth(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  try {
    const text = await readFile(`/proc/${pid}/stat`, "utf8");
    assert.ok(text.startsWith(`${pid} (`));
    const fields = text
      .slice(text.lastIndexOf(") ") + 2)
      .trim()
      .split(/\s+/);
    assert.match(fields[19], /^\d+$/);
    return ["Z", "X", "x"].includes(fields[0]) ? null : fields[19];
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
async function until(observe, timeout = 10_000) {
  const end = Date.now() + timeout;
  do {
    const value = await observe();
    if (value) return value;
    await sleep(50);
  } while (Date.now() < end);
  throw new Error("qualification-observation-timeout");
}
async function disappeared(identities) {
  await until(async () =>
    (
      await Promise.all(identities.map(async ({ pid, ticks }) => (await birth(pid)) !== ticks))
    ).every(Boolean),
  );
}

export async function installedArtifactIdentity(installedRoot, forbiddenRoot = sourceRoot) {
  const root = await realpath(installedRoot);
  const forbidden = await realpath(forbiddenRoot);
  assert.ok(
    root !== forbidden && !root.startsWith(`${forbidden}${sep}`),
    "source checkout is not an installed artifact",
  );
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(manifest.name, "@clockgrove/factory");
  assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/);
  const inventory = JSON.parse(await readFile(join(root, "dist/bundle-inventory.json"), "utf8"));
  assert.equal(inventory.protocol, "clockgrove.factory/bundle-inventory-v1");
  const bundles = [];
  for (const file of ["factory.js", "mcp-server.js"]) {
    const records = inventory.bundles.filter((entry) => entry.file === file);
    assert.equal(records.length, 1, "missing or duplicate installed bundle identity");
    const path = await realpath(join(root, "dist", file));
    assert.ok(path.startsWith(`${root}${sep}`), "installed bundle escapes its artifact");
    const bytes = await readFile(path);
    assert.equal(bytes.length, records[0].bytes);
    assert.equal(sha256(bytes), records[0].sha256, "installed artifact inventory mismatch");
    bundles.push({ file, bytes: bytes.length, sha256: sha256(bytes) });
  }
  return { version: manifest.version, bundles };
}

async function controllerInstallCycle(cli, temporary, expectedVersion) {
  const checkout = join(temporary, "checkout");
  await mkdir(checkout);
  const repository = "factory-qualification/disposable";
  const unit = `clockgrove-factory-${sha256(`${repository}\0${checkout}`).slice(0, 16)}.service`;
  const directory = join(
    process.env.XDG_CONFIG_HOME ?? join(process.env.HOME, ".config"),
    "systemd/user",
  );
  const path = join(directory, unit);
  const before = await lstat(path).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  assert.equal(before, null, "disposable controller target already exists");
  const invoke = async (operation) =>
    JSON.parse(
      await command(
        process.execPath,
        [cli, "controller", operation, repository, "--repo", checkout],
        { timeout: 30_000 },
      ),
    );
  const existing = await invoke("status");
  assert.equal(existing.unit, unit);
  assert.ok(
    !existing.installed && !existing.enabled && !existing.active,
    "disposable unit is not absent",
  );
  let attempted = false;
  try {
    attempted = true;
    const installed = await invoke("install");
    assert.equal(installed.unit, unit);
    assert.ok(installed.installed && installed.enabled && !installed.active);
    const body = await readFile(path, "utf8");
    assert.ok(body.startsWith("# Managed by Clockgrove Factory v2\n"));
    assert.ok(body.includes(cli) && body.includes("KillMode=control-group\n"));
    await command("systemd-analyze", ["--user", "verify", path]);
    assert.equal(await command(process.execPath, [cli, "--version"]), expectedVersion);
    const again = await invoke("install");
    assert.ok(again.installed && again.enabled && !again.active);
  } finally {
    if (attempted) {
      const removed = await invoke("uninstall");
      assert.equal(removed.unit, unit);
      assert.ok(
        !removed.installed && !removed.enabled && !removed.active,
        "disposable controller cleanup unverified",
      );
    }
  }
  return {
    result: "passed",
    scope: "installed-controller-install-idempotency-uninstall",
    controllerStarted: false,
  };
}

// Fixture is plain Node and only invokes the installed CLI's no-auth --version.
// Its synthetic workload measures host mechanics, not Factory worker acceptance.
const fixtureSource = `import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const [cli, receipt] = process.argv.slice(2);
const result = spawnSync(process.execPath, [cli, "--version"], { encoding: "utf8", timeout: 10000, env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent" } });
if (result.status !== 0) process.exit(3);
const child = spawn(process.execPath, ["-e", "const memory = Buffer.alloc(16 * 1024 * 1024, 1); setInterval(() => { const end = Date.now() + 100; while (Date.now() < end) Math.sqrt(12345); if (memory[0] !== 1) process.exit(2); }, 120);"], { detached: true, stdio: "ignore", env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent" } });
writeFileSync(receipt, JSON.stringify({ pid: process.pid, childPid: child.pid, version: result.stdout.trim() }), { mode: 0o600 });
setInterval(() => {}, 1000);
`;

async function transientLifecycle(cli, temporary, expectedVersion) {
  const unit = `factory-qualification-${randomUUID()}.service`;
  const fixture = join(temporary, "host-fixture.mjs");
  const receipt = join(temporary, "processes.json");
  await writeFile(fixture, fixtureSource, { mode: 0o600 });
  let attempted = false;
  const identities = [];
  let group;
  let cleanupVerified = false;
  const observation = async (previousInvocation) => {
    const state = await show(unit);
    if (
      state.ActiveState !== "active" ||
      !/^[a-f0-9]{32}$/.test(state.InvocationID ?? "") ||
      state.InvocationID === previousInvocation
    )
      return null;
    let data;
    try {
      data = JSON.parse(await readFile(receipt, "utf8"));
    } catch {
      return null;
    }
    if (data.pid !== Number(state.MainPID)) return null;
    assert.equal(data.version, expectedVersion);
    const values = await Promise.all(
      [data.pid, data.childPid].map(async (pid) => ({ pid, ticks: await birth(pid) })),
    );
    if (values.some((entry) => !entry.ticks)) return null;
    identities.push(...values);
    group = ownedCgroupPath(unit, state);
    assert.equal(state.KillMode, "control-group");
    return { invocation: state.InvocationID, identities: values, group };
  };
  try {
    // Runtime and restart limits cap a crash even if the harness itself disappears.
    attempted = true;
    await command("systemd-run", [
      "--user",
      `--unit=${unit}`,
      "--quiet",
      "--collect",
      "--service-type=exec",
      "--expand-environment=no",
      "--property=KillMode=control-group",
      "--property=CPUQuota=25%",
      "--property=MemoryMax=384M",
      "--property=TasksMax=64",
      "--property=RuntimeMaxSec=20s",
      "--property=TimeoutStopSec=3s",
      "--property=Restart=on-failure",
      "--property=RestartSec=100ms",
      "--property=StartLimitIntervalSec=120s",
      "--property=StartLimitBurst=3",
      "--property=StandardOutput=null",
      "--property=StandardError=null",
      "/usr/bin/env",
      "-i",
      "PATH=/usr/bin:/bin",
      "HOME=/nonexistent",
      process.execPath,
      fixture,
      cli,
      receipt,
    ]);
    const first = await until(() => observation());
    const quota = (await readFile(join(first.group, "cpu.max"), "utf8"))
      .trim()
      .split(/\s+/)
      .map(Number);
    assert.ok(quota.length === 2 && quota[0] > 0 && quota[0] / quota[1] <= 0.25);
    const memoryLimitBytes = Number(
      (await readFile(join(first.group, "memory.max"), "utf8")).trim(),
    );
    assert.equal(memoryLimitBytes, 384 * 1024 * 1024);
    const pressure = await until(async () => {
      const cpu = Object.fromEntries(
        (await readFile(join(first.group, "cpu.stat"), "utf8"))
          .trim()
          .split("\n")
          .map((line) => line.trim().split(/\s+/)),
      );
      const memoryBytes = Number(
        (await readFile(join(first.group, "memory.current"), "utf8")).trim(),
      );
      return Number(cpu.nr_throttled) > 0 &&
        memoryBytes > 16 * 1024 * 1024 &&
        memoryBytes < memoryLimitBytes
        ? { throttledPeriods: Number(cpu.nr_throttled), memoryBytes, memoryLimitBytes }
        : null;
    });
    // A real main-process crash exercises systemd's restart and old-descendant cleanup.
    await command("systemctl", ["--user", "kill", "--kill-whom=main", "--signal=KILL", unit]);
    const second = await until(() => observation(first.invocation));
    await disappeared(first.identities);
    await command("systemctl", ["--user", "stop", unit]);
    await disappeared(second.identities);
    cleanupVerified = true;
    return {
      result: "passed",
      scope: "installed-cli-disposable-host-process-components",
      pressure,
      detachedDescendantCancelled: true,
      restartGenerationChanged: true,
      originalProcessesGone: true,
      cleanupVerified: true,
    };
  } finally {
    if (attempted) {
      // The exact random unit is our only signal target, including response-loss cleanup.
      await command("systemctl", ["--user", "stop", unit]).catch(() => undefined);
      await disappeared(identities);
      let events = "populated 0\n";
      if (group) {
        events = await readFile(join(group, "cgroup.events"), "utf8").catch((error) => {
          if (error.code === "ENOENT") return "populated 0\n";
          throw error;
        });
      }
      const state = await show(unit).catch(() => null);
      assertOwnedServiceCleanup(unit, state, events);
      if (!cleanupVerified && identities.length === 0) {
        assert.ok(
          state.LoadState === "not-found" || state.MainPID === "0",
          "unobserved launch remains",
        );
      }
    }
  }
}

export function summarizeQualification(evidence) {
  const checks = Object.values(evidence.checks);
  const required = [
    "installedStartup",
    "hostPrerequisites",
    "controllerInstallLifecycle",
    "hostProcessLifecycle",
  ];
  const result = checks.some((check) => check.result === "failed")
    ? "failed"
    : evidence.host.detected.startsWith("unsupported")
      ? "unsupported"
      : !evidence.host.claimVerified ||
          required.some((name) => evidence.checks[name]?.result !== "passed")
        ? "incomplete"
        : "passed";
  return {
    ...evidence,
    result,
    scope: "installed-artifacts-and-no-model-linux-host-components",
    fullFactoryHostMatrix: "open",
    unverified: [
      "model-backed-sdk-and-cli-implementation-and-clean-validation",
      "factory-adaptive-admission-under-pressure",
      "github-fenced-controller-restart-and-durable-cancellation",
      "other-physical-host-configurations",
      "published-artifact-clean-install",
    ],
  };
}

export async function qualifyInstalledLinuxHost({
  installedRoot,
  artifactKind,
  installation,
  claimedHost = "auto",
}) {
  assert.ok(["npm", "plugin"].includes(artifactKind));
  const evidence = {
    protocol: "clockgrove.factory/portable-qualification-v1",
    observedAt: new Date().toISOString(),
    runtime: {
      architecture: arch(),
      node: process.versions.node,
      kernel: /^[A-Za-z0-9_.+-]{1,160}$/.test(release()) ? release() : "unavailable",
    },
    artifactKind,
    installation,
    artifact: await installedArtifactIdentity(installedRoot),
    host: null,
    checks: {},
  };
  let virtualization;
  try {
    const result = await exec("systemd-detect-virt", [], {
      timeout: 5_000,
      maxBuffer: 4096,
      env: qualificationEnvironment(),
    });
    virtualization = result.stdout.trim();
  } catch (error) {
    if (error.code === 1 && error.stdout?.trim() === "none") virtualization = "none";
  }
  evidence.host = classifyLinuxHost({
    platform: platform(),
    kernel: release(),
    virtualization,
    claimed: claimedHost,
  });
  const run = async (name, action) => {
    try {
      evidence.checks[name] = await action();
    } catch {
      evidence.checks[name] = { result: "failed", reason: `${name}-unverified` };
    }
  };
  const cli = join(await realpath(installedRoot), "dist/factory.js");
  await run("installedStartup", async () => {
    assert.equal(await command(process.execPath, [cli, "--version"]), evidence.artifact.version);
    const help = await command(process.execPath, [cli, "--help"]);
    assert.ok(help.includes("factory controller install|start|stop|restart|status|uninstall"));
    return { result: "passed", scope: "installed-cli-version-and-controller-surface" };
  });
  if (platform() !== "linux") return summarizeQualification(evidence);
  try {
    const managerVersion = await command("systemctl", [
      "--user",
      "show",
      "--property=Version",
      "--value",
    ]);
    const systemdMajor = Number(/^(\d+)/.exec(managerVersion)?.[1]);
    assert.ok(Number.isSafeInteger(systemdMajor) && systemdMajor > 0);
    const mounts = await readFile("/proc/self/mountinfo", "utf8");
    assert.ok(
      mounts.split("\n").some((line) => {
        const fields = line.split(" ");
        return (
          fields[3] === "/" &&
          fields[4] === "/sys/fs/cgroup" &&
          fields[fields.indexOf("-") + 1] === "cgroup2"
        );
      }),
    );
    evidence.checks.hostPrerequisites = {
      result: "passed",
      userManager: true,
      unifiedCgroupView: true,
      systemdMajor,
    };
  } catch {
    evidence.checks.hostPrerequisites = {
      result: "unavailable",
      reason: "systemd-user-manager-or-unified-cgroup-unavailable",
    };
    return summarizeQualification(evidence);
  }
  const temporary = await mkdtemp(join(tmpdir(), "factory-host-qualification-"));
  try {
    await run("controllerInstallLifecycle", () =>
      controllerInstallCycle(cli, temporary, evidence.artifact.version),
    );
    await run("hostProcessLifecycle", () =>
      transientLifecycle(cli, temporary, evidence.artifact.version),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return summarizeQualification(evidence);
}

/** Install verifiers call this before removing their exact freshly installed artifact. */
export async function optionalHostQualification(input) {
  if (process.env.FACTORY_QUALIFY_LINUX_HOST !== "1") return;
  const output = process.env.FACTORY_QUALIFICATION_OUTPUT;
  assert.ok(output && output.endsWith(".json"), "qualification output path required");
  const evidence = await qualifyInstalledLinuxHost({
    ...input,
    claimedHost: process.env.FACTORY_QUALIFICATION_HOST ?? "auto",
  });
  await writeFile(resolve(output), `${JSON.stringify(evidence, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  if (evidence.result === "failed")
    throw new Error("installed Linux host qualification failed; see sanitized evidence");
}
