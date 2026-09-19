/** Exact installed-client qualification for controller lifecycle serialization. */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import {
  installedQualificationAuthority,
  qualificationRuntimeEnvironment,
} from "./qualification-install-identity.mjs";

const ARM_ENV = "FACTORY_LIFECYCLE_QUALIFICATION_ARM";
const MAX_OUTPUT = 64 * 1024;
const CALL_TIMEOUT_MS = 45_000;
const REACHED_TIMEOUT_MS = 15_000;
const WAITING_TIMEOUT_MS = 10_000;
const unitPattern = /^clockgrove-factory-[a-f0-9]{16}\.service$/;
const hash = (value) => createHash("sha256").update(value).digest("hex");

function required(env, name) {
  const value = env[name]?.trim();
  assert.ok(value, `${name} is required`);
  return value;
}

function boundedAppend(current, chunk) {
  const next = `${current}${chunk}`;
  return next.length <= MAX_OUTPUT ? next : next.slice(-MAX_OUTPUT);
}

function command(file, args, cwd, timeout = 15_000, env) {
  return execFileSync(file, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout,
    maxBuffer: MAX_OUTPUT,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function processStartTicks(pid) {
  const text = readFileSync(`/proc/${pid}/stat`, "utf8");
  const ticks = text.slice(text.lastIndexOf(")") + 2).split(" ")[19];
  assert.match(ticks, /^[0-9]+$/, "process birth identity unavailable");
  return ticks;
}

function unitName(repository, checkout) {
  const key = `${repository.toLowerCase()}\0${resolve(checkout)}`;
  return `clockgrove-factory-${hash(key).slice(0, 16)}.service`;
}

function paths(runtimeDirectory, unit, checkpointId) {
  const prefix = `${runtimeDirectory}/.${unit}.lifecycle-qualification-${checkpointId}`;
  return {
    arm: `${runtimeDirectory}/.${unit}.lifecycle-qualification-arm.json`,
    reached: `${prefix}.reached.json`,
    release: `${prefix}.release.json`,
    consumed: `${prefix}.consumed.json`,
  };
}

function readPrivate(path, uid, maximum = 64 * 1024) {
  const facts = lstatSync(path);
  assert.ok(facts.isFile() && !facts.isSymbolicLink(), `${path} must be a regular file`);
  assert.equal(facts.uid, uid, `${path} owner differs`);
  assert.equal(facts.mode & 0o777, 0o600, `${path} must be mode 0600`);
  assert.equal(facts.nlink, 1, `${path} must have one link`);
  assert.ok(facts.size > 0 && facts.size <= maximum, `${path} is unbounded`);
  return readFileSync(path, "utf8");
}

function writeExclusive(path, value) {
  writeFileSync(path, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
}

function spawnCaptured(file, args, options = {}) {
  const startedAt = new Date().toISOString();
  const child = spawn(file, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout = boundedAppend(stdout, chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr = boundedAppend(stderr, chunk);
  });
  const settled = new Promise((resolveChild, rejectChild) => {
    child.once("error", rejectChild);
    child.once("close", (code, signal) =>
      resolveChild({
        pid: child.pid,
        startedAt,
        settledAt: new Date().toISOString(),
        code,
        signal,
        stdout,
        stderr,
      }),
    );
  });
  return { child, settled };
}

async function within(promise, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function waitForPrivateJson(path, child, uid, timeoutMs = REACHED_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`client exited before ${path} was complete`);
    try {
      const bytes = readPrivate(path, uid);
      JSON.parse(bytes);
      return bytes;
    } catch (error) {
      const incomplete =
        error.code === "ENOENT" ||
        error.name === "SyntaxError" ||
        (error.code === "ERR_ASSERTION" && String(error.message).endsWith(" is unbounded"));
      if (!incomplete) throw error;
      if (error.code !== "ENOENT" && openFileDescriptor(child.pid, path) === null) {
        const settledBytes = readPrivate(path, uid);
        JSON.parse(settledBytes);
        return settledBytes;
      }
    }
    await sleep(25);
  }
  throw new Error(`timed out waiting for complete ${path}`);
}

function openFileDescriptor(pid, expectedPath) {
  for (const entry of readdirSync(`/proc/${pid}/fd`)) {
    try {
      if (readlinkSync(`/proc/${pid}/fd/${entry}`) === expectedPath) return Number(entry);
    } catch (error) {
      if (!["ENOENT", "EACCES"].includes(error.code)) throw error;
    }
  }
  return null;
}

function childPids(pid) {
  const value = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim();
  return value ? value.split(/\s+/).map(Number) : [];
}

function linuxLockIdentity(path) {
  const facts = statSync(path, { bigint: true });
  const major = ((facts.dev >> 8n) & 0xfffn) | ((facts.dev >> 32n) & 0xfffff000n);
  const minor = (facts.dev & 0xffn) | ((facts.dev >> 12n) & 0xffffff00n);
  return {
    major: major.toString(16),
    minor: minor.toString(16),
    inode: facts.ino.toString(),
  };
}

export function findPendingFlock(text, expected) {
  for (const line of text.split("\n")) {
    const match =
      /^\d+:\s+->\s+FLOCK\s+ADVISORY\s+WRITE\s+(\d+)\s+([a-f0-9]+):([a-f0-9]+):(\d+)\s+0\s+EOF\s*$/i.exec(
        line,
      );
    if (!match) continue;
    const [, pid, major, minor, inode] = match;
    if (
      Number(pid) === expected.pid &&
      BigInt(`0x${major}`) === BigInt(`0x${expected.major}`) &&
      BigInt(`0x${minor}`) === BigInt(`0x${expected.minor}`) &&
      BigInt(inode) === BigInt(expected.inode)
    ) {
      return {
        state: "pending",
        class: "FLOCK",
        access: "WRITE",
        pid: Number(pid),
        device: `${major.toLowerCase()}:${minor.toLowerCase()}`,
        inode,
        range: "0:EOF",
      };
    }
  }
  return null;
}

export function kernelFlockWaitEvidence(procLocks, waitChannel, expected) {
  const pending = findPendingFlock(procLocks, expected);
  if (pending) return { authority: "proc-locks", ...pending };
  return waitChannel.trim() === "locks_lock_inode_wait"
    ? { authority: "wait-channel", waitChannel: "locks_lock_inode_wait" }
    : null;
}

export function isExactLifecycleFlockWaiter(argv, lockFd) {
  return (
    lockFd === 3 &&
    argv.length === 5 &&
    argv[0] === "/usr/bin/flock" &&
    argv[1] === "--exclusive" &&
    argv[2] === "--wait" &&
    argv[3] === "30.000" &&
    argv[4] === "3"
  );
}

async function proveWaitingOnFlock(processHandle, lockPath) {
  const deadline = Date.now() + WAITING_TIMEOUT_MS;
  while (Date.now() < deadline) {
    assert.equal(processHandle.child.exitCode, null, "competing lifecycle client settled early");
    for (const pid of childPids(processHandle.child.pid)) {
      try {
        if (realpathSync(`/proc/${pid}/exe`) !== "/usr/bin/flock") continue;
        const argv = readFileSync(`/proc/${pid}/cmdline`)
          .toString("utf8")
          .split("\0")
          .filter(Boolean);
        const lockFd = openFileDescriptor(pid, lockPath);
        if (isExactLifecycleFlockWaiter(argv, lockFd)) {
          const lockIdentity = linuxLockIdentity(lockPath);
          const descriptorIdentity = linuxLockIdentity(`/proc/${pid}/fd/${lockFd}`);
          assert.deepEqual(descriptorIdentity, lockIdentity);
          const kernelBlock = kernelFlockWaitEvidence(
            readFileSync("/proc/locks", "utf8"),
            readFileSync(`/proc/${pid}/wchan`, "utf8"),
            { pid, ...lockIdentity },
          );
          if (kernelBlock) {
            return {
              pid,
              startTicks: processStartTicks(pid),
              argv,
              lockFd,
              lockIdentity,
              kernelBlock,
            };
          }
        }
      } catch (error) {
        if (!["ENOENT", "ESRCH"].includes(error.code)) throw error;
      }
    }
    await sleep(25);
  }
  throw new Error("competing client had no exact kernel FLOCK waiting evidence");
}

function parseSuccess(settlement, operation) {
  assert.equal(settlement.signal, null, `${operation} died by signal`);
  assert.equal(settlement.code, 0, `${operation} failed: ${settlement.stderr}`);
  const value = JSON.parse(settlement.stdout);
  assert.ok(value && typeof value === "object", `${operation} returned no status`);
  return value;
}

function managerEnvironment(uid) {
  const runtimeDirectory = `/run/user/${uid}`;
  return {
    LANG: "C",
    LC_ALL: "C",
    PATH: "/usr/bin:/bin",
    XDG_RUNTIME_DIR: runtimeDirectory,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtimeDirectory}/bus`,
  };
}

function managerCommand(uid, args) {
  return execFileSync("/usr/bin/systemctl", ["--user", ...args], {
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: MAX_OUTPUT,
    stdio: ["ignore", "pipe", "pipe"],
    env: managerEnvironment(uid),
  }).trim();
}

function managerState(unit, uid) {
  const result = spawnSync(
    "/usr/bin/systemctl",
    [
      "--user",
      "show",
      unit,
      "--property=Id,LoadState,UnitFileState,ActiveState,SubState,MainPID,FragmentPath",
      "--no-pager",
    ],
    {
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: MAX_OUTPUT,
      stdio: ["ignore", "pipe", "pipe"],
      env: managerEnvironment(uid),
    },
  );
  if (result.error) throw result.error;
  const raw = result.stdout.trim();
  assert.ok(raw, `systemd returned no observation for ${unit}: ${result.stderr.trim()}`);
  return Object.fromEntries(
    raw.split("\n").map((line) => {
      const index = line.indexOf("=");
      assert.ok(index > 0, "malformed systemd property");
      return [line.slice(0, index), line.slice(index + 1)];
    }),
  );
}

function lifecycleAuthority(env) {
  if (env.FACTORY_LIFECYCLE_QUALIFICATION !== "1") return null;
  assert.equal(process.platform, "linux", "Linux qualification host required");
  assert.ok(process.getuid, "effective Linux uid unavailable");
  const uid = process.getuid();
  const repository = required(env, "FACTORY_LIFECYCLE_REPOSITORY");
  assert.match(repository, /^[^/\s]+\/[^/\s]+$/);
  const checkout = realpathSync(required(env, "FACTORY_LIFECYCLE_CHECKOUT"));
  assert.ok(
    checkout.startsWith(`${realpathSync(homedir())}/`),
    "checkout must be Linux-home native",
  );
  const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const runtimeEnvironment = qualificationRuntimeEnvironment(env, { repositoryRoot: checkout });
  const candidate = installedQualificationAuthority(env, {
    uid,
    sourceRoot,
    committedPaths: ["scripts/verify-installed-controller-lifecycle.mjs"],
  });
  const unit = unitName(repository, checkout);
  assert.match(unit, unitPattern);
  const acknowledgement = `${repository}:${unit}:install-start,install-uninstall,busy,killed-owner,cleanup`;
  assert.equal(required(env, "FACTORY_LIFECYCLE_ACK"), acknowledgement);
  const evidence = resolve(required(env, "FACTORY_LIFECYCLE_EVIDENCE"));
  const evidenceParent = statSync(dirname(evidence));
  assert.ok(evidenceParent.isDirectory());
  assert.equal(evidenceParent.uid, uid);
  assert.equal(evidenceParent.mode & 0o077, 0);
  const runtimeDirectory = `/run/user/${uid}`;
  const runtime = statSync(runtimeDirectory);
  assert.ok(runtime.isDirectory());
  assert.equal(runtime.uid, uid);
  assert.equal(runtime.mode & 0o077, 0);
  const configuredUnitRoot =
    env.XDG_CONFIG_HOME === undefined ? join(env.HOME ?? "", ".config") : env.XDG_CONFIG_HOME;
  const configHome = resolve(checkout, configuredUnitRoot);
  return {
    repository,
    checkout,
    ...candidate,
    unit,
    uid,
    runtimeDirectory,
    lockPath: `${runtimeDirectory}/.${unit}.lifecycle.lock`,
    unitPath: join(configHome, "systemd/user", unit),
    acknowledgement,
    evidence,
    runtimeEnvironment,
  };
}

export async function runLifecycleRaceMatrix(port) {
  const cases = [];
  for (const secondOperation of ["start", "uninstall"]) {
    const name = `install-${secondOperation}`;
    const arm = await port.arm(name);
    const installing = port.spawn("install", arm.requestId, arm.environment);
    const reached = await port.reached(name, arm, installing);
    const competing = port.spawn(secondOperation, `${name}-${secondOperation}`);
    const waiting = await port.waiting(name, competing, reached);
    await port.release(name, arm, reached, waiting);
    const installSettlement = await port.settle(name, "install", installing);
    const secondSettlement = await port.settle(name, secondOperation, competing);
    const final = await port.final(name, secondOperation, {
      installSettlement,
      secondSettlement,
    });
    cases.push({ name, arm, reached, waiting, installSettlement, secondSettlement, final });
    await port.reset(name, final);
  }
  const contention = await port.contention();
  const cleanup = await port.cleanup();
  return { cases, contention, cleanup };
}

export async function main(env = process.env) {
  const authority = lifecycleAuthority(env);
  if (!authority) {
    console.log("Not exercised: explicit installed lifecycle qualification opt-in required.");
    return;
  }
  assert.equal(
    command(
      process.execPath,
      [authority.factoryCli, "--version"],
      authority.checkout,
      15_000,
      authority.runtimeEnvironment,
    ).length > 0,
    true,
  );
  assert.equal(realpathSync("/usr/bin/flock"), "/usr/bin/flock");
  const flockIdentity = {
    path: "/usr/bin/flock",
    sha256: hash(readFileSync("/usr/bin/flock")),
    owner: statSync("/usr/bin/flock").uid,
    version: command("/usr/bin/flock", ["--version"]).split("\n")[0],
  };
  const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  assert.equal(command("git", ["status", "--porcelain", "--untracked-files=all"], sourceRoot), "");
  const sourceCommit = command("git", ["rev-parse", "HEAD"], sourceRoot);
  assert.equal(authority.candidateSourceCommit, sourceCommit);
  assert.notEqual(
    authority.installedFactoryRoot,
    sourceRoot,
    "source or development checkout is not an installed candidate",
  );
  assert.equal(
    command("git", ["rev-parse", "--show-toplevel"], authority.checkout),
    authority.checkout,
  );
  assert.equal(
    command("git", ["status", "--porcelain", "--untracked-files=all"], authority.checkout),
    "",
  );
  assert.equal(
    command(
      "gh",
      ["repo", "view", authority.repository, "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
      authority.checkout,
    ).toLowerCase(),
    authority.repository.toLowerCase(),
  );
  const harnessPath = "scripts/verify-installed-controller-lifecycle.mjs";
  assert.equal(
    command("git", ["show", `HEAD:${harnessPath}`], sourceRoot),
    readFileSync(fileURLToPath(import.meta.url), "utf8").trim(),
  );
  const evidenceFd = openSync(
    authority.evidence,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  const evidence = {
    protocol: "clockgrove.factory/installed-lifecycle-qualification",
    authority,
    sourceCommit,
    harnessSha256: hash(readFileSync(fileURLToPath(import.meta.url))),
    flockIdentity,
    managerVersion: managerCommand(authority.uid, [
      "show",
      "--property=Version",
      "--value",
      "--no-pager",
    ]),
    startedAt: new Date().toISOString(),
  };
  const save = () => {
    const facts = fstatSync(evidenceFd);
    assert.ok(facts.isFile());
    assert.equal(facts.uid, authority.uid);
    assert.equal(facts.mode & 0o777, 0o600);
    assert.equal(facts.nlink, 1);
    const bytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);
    ftruncateSync(evidenceFd, 0);
    assert.equal(writeSync(evidenceFd, bytes, 0, bytes.length, 0), bytes.length);
    fsyncSync(evidenceFd);
  };
  save();
  const spawned = new Set();
  const metadata = new Set();
  const qualifications = new Map();
  const factory = (operation, requestId, extraEnvironment = {}) => {
    const handle = spawnCaptured(
      process.execPath,
      [
        authority.factoryCli,
        "controller",
        operation,
        authority.repository,
        "--repo",
        authority.checkout,
        "--request-id",
        requestId,
      ],
      { cwd: authority.checkout, env: { ...authority.runtimeEnvironment, ...extraEnvironment } },
    );
    spawned.add(handle);
    return handle;
  };
  const invoke = async (operation, requestId) => {
    const handle = factory(operation, requestId);
    const settlement = await within(handle.settled, CALL_TIMEOUT_MS, operation);
    spawned.delete(handle);
    return { settlement, status: parseSuccess(settlement, operation) };
  };
  const port = {
    arm: async (name) => {
      assert.ok(!statOptional(authority.unitPath), `${name} requires an absent unit`);
      const checkpointId = randomBytes(16).toString("hex");
      const requestId = `issue-466-${name}-install`;
      const selectedPaths = paths(authority.runtimeDirectory, authority.unit, checkpointId);
      assert.ok(!statOptional(selectedPaths.arm), "prior qualification arm remains");
      const now = Date.now();
      const arm = {
        protocol: "clockgrove.factory/lifecycle-checkpoint-arm",
        checkpointId,
        artifactIdentity: authority.artifactIdentity,
        effectiveUid: authority.uid,
        unit: authority.unit,
        repository: authority.repository,
        checkout: authority.checkout,
        requestId,
        operation: "install",
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 120_000).toISOString(),
      };
      writeExclusive(selectedPaths.arm, arm);
      for (const path of Object.values(selectedPaths)) metadata.add(path);
      const qualification = {
        ...arm,
        paths: selectedPaths,
        environment: { [ARM_ENV]: selectedPaths.arm },
      };
      qualifications.set(name, qualification);
      return qualification;
    },
    spawn: (operation, requestId, environment = {}) => factory(operation, requestId, environment),
    reached: async (name, arm, installing) => {
      const armBytes = readPrivate(arm.paths.arm, authority.uid);
      const reachedBytes = await waitForPrivateJson(
        arm.paths.reached,
        installing.child,
        authority.uid,
      );
      const reached = JSON.parse(reachedBytes);
      assert.equal(reached.protocol, "clockgrove.factory/lifecycle-checkpoint-reached");
      assert.equal(reached.checkpointId, arm.checkpointId);
      assert.equal(reached.armDigest, hash(armBytes));
      assert.equal(reached.artifactIdentity, authority.artifactIdentity);
      assert.equal(reached.effectiveUid, authority.uid);
      assert.equal(reached.unit, authority.unit);
      assert.equal(reached.repository, authority.repository.toLowerCase());
      assert.equal(reached.checkout, authority.checkout);
      assert.equal(reached.requestId, arm.requestId);
      assert.equal(reached.operation, "install");
      assert.equal(reached.expiresAt, arm.expiresAt);
      assert.equal(reached.clientPid, installing.child.pid);
      assert.equal(reached.clientStartTicks, processStartTicks(installing.child.pid));
      assert.equal(reached.lockPath, authority.lockPath);
      assert.ok(openFileDescriptor(installing.child.pid, authority.lockPath) !== null);
      const qualification = qualifications.get(name);
      assert.ok(qualification, "qualification arm was not retained");
      qualification.reachedBytes = reachedBytes;
      return reached;
    },
    waiting: async (_name, competing) => proveWaitingOnFlock(competing, authority.lockPath),
    release: async (_name, arm, reached) => {
      writeExclusive(arm.paths.release, {
        protocol: "clockgrove.factory/lifecycle-checkpoint-release",
        checkpointId: arm.checkpointId,
        armDigest: reached.armDigest,
      });
    },
    settle: async (name, operation, handle) => {
      const settlement = await within(handle.settled, CALL_TIMEOUT_MS, operation);
      spawned.delete(handle);
      const result = { ...settlement, status: parseSuccess(settlement, operation) };
      if (operation === "install") {
        const qualification = qualifications.get(name);
        assert.ok(qualification?.reachedBytes, "qualification witness was not retained");
        assert.equal(statOptional(qualification.paths.arm), false);
        assert.equal(statOptional(qualification.paths.release), false);
        assert.equal(
          readPrivate(qualification.paths.reached, authority.uid),
          qualification.reachedBytes,
          "reached witness changed after release",
        );
        const consumed = JSON.parse(readPrivate(qualification.paths.consumed, authority.uid));
        const reached = JSON.parse(qualification.reachedBytes);
        assert.equal(consumed.protocol, "clockgrove.factory/lifecycle-checkpoint-consumed");
        assert.equal(consumed.checkpointId, qualification.checkpointId);
        assert.equal(consumed.armDigest, reached.armDigest);
        assert.equal(consumed.reachedDigest, hash(qualification.reachedBytes));
        assert.equal(consumed.outcome, "released");
        result.checkpoint = consumed;
      }
      return result;
    },
    final: async (_name, secondOperation, settlements) => {
      if (secondOperation === "start") {
        assert.equal(settlements.installSettlement.status.installed, true);
        assert.equal(settlements.installSettlement.status.enabled, true);
        assert.equal(settlements.secondSettlement.status.active, true);
        assert.equal(settlements.secondSettlement.status.launcherCurrent, true);
        assert.equal(
          settlements.secondSettlement.status.executableIdentity,
          authority.artifactIdentity,
        );
      } else {
        assert.deepEqual(
          {
            installed: settlements.secondSettlement.status.installed,
            enabled: settlements.secondSettlement.status.enabled,
            active: settlements.secondSettlement.status.active,
          },
          { installed: false, enabled: false, active: false },
        );
      }
      const status = (await invoke("status", `issue-466-${secondOperation}-final-status`)).status;
      const manager = managerState(authority.unit, authority.uid);
      let launcherProcess = null;
      if (secondOperation === "start") {
        assert.equal(status.healthy, true);
        assert.equal(status.currentExecutableIdentity, authority.artifactIdentity);
        assert.equal(manager.LoadState, "loaded");
        assert.equal(manager.UnitFileState, "enabled");
        assert.equal(manager.ActiveState, "active");
        assert.equal(realpathSync(manager.FragmentPath), realpathSync(authority.unitPath));
        const mainPid = Number(manager.MainPID);
        assert.ok(Number.isSafeInteger(mainPid) && mainPid > 0, "active unit has no main pid");
        const argv = readFileSync(`/proc/${mainPid}/cmdline`, "utf8").split("\0").filter(Boolean);
        assert.ok(argv.includes(authority.factoryCli));
        assert.ok(argv.includes("controller") && argv.includes("run"));
        assert.ok(argv.includes(authority.repository) && argv.includes(authority.checkout));
        launcherProcess = { pid: mainPid, startTicks: processStartTicks(mainPid), argv };
      } else {
        assert.equal(manager.LoadState, "not-found");
      }
      return { status, manager, launcherProcess };
    },
    reset: async (_name, final) => {
      if (final.status.active) await invoke("stop", "issue-466-between-cases-stop");
      if (final.status.installed) await invoke("uninstall", "issue-466-between-cases-uninstall");
      const absent = await invoke("status", "issue-466-between-cases-status");
      assert.deepEqual(
        {
          installed: absent.status.installed,
          enabled: absent.status.enabled,
          active: absent.status.active,
        },
        { installed: false, enabled: false, active: false },
      );
    },
    contention: async () => {
      const prime = await invoke("status", "issue-466-prime-lock");
      assert.equal(prime.status.installed, false);
      const lockBefore = statSync(authority.lockPath);
      const ownerCommand = [
        "--exclusive",
        "--no-fork",
        authority.lockPath,
        "/usr/bin/sleep",
        "300",
      ];
      const owner = spawnCaptured("/usr/bin/flock", ownerCommand, {
        cwd: authority.checkout,
        env: authority.runtimeEnvironment,
      });
      spawned.add(owner);
      const deadline = Date.now() + WAITING_TIMEOUT_MS;
      while (
        Date.now() < deadline &&
        openFileDescriptor(owner.child.pid, authority.lockPath) === null
      )
        await sleep(25);
      assert.ok(
        openFileDescriptor(owner.child.pid, authority.lockPath) !== null,
        "flock owner absent",
      );
      const ownerIdentity = {
        tool: "/usr/bin/flock",
        arguments: ownerCommand,
        pid: owner.child.pid,
        startTicks: processStartTicks(owner.child.pid),
        lockFd: openFileDescriptor(owner.child.pid, authority.lockPath),
      };
      const busy = factory("status", "issue-466-busy-status");
      const busySettlement = await within(busy.settled, CALL_TIMEOUT_MS, "busy diagnostic");
      spawned.delete(busy);
      assert.equal(busySettlement.signal, null);
      assert.notEqual(busySettlement.code, 0);
      assert.match(
        busySettlement.stderr,
        /controller-lifecycle-busy: status timed out after 30000ms/,
      );
      const busyElapsedMs =
        Date.parse(busySettlement.settledAt) - Date.parse(busySettlement.startedAt);
      assert.ok(busyElapsedMs >= 29_000 && busyElapsedMs <= 42_000);
      owner.child.kill("SIGKILL");
      const killed = await within(owner.settled, 10_000, "killed flock owner");
      spawned.delete(owner);
      assert.equal(killed.signal, "SIGKILL");
      const recovered = await invoke("status", "issue-466-after-killed-owner");
      assert.equal(recovered.status.installed, false);
      const lockAfter = statSync(authority.lockPath);
      assert.equal(lockAfter.dev, lockBefore.dev, "lock device changed during recovery");
      assert.equal(lockAfter.ino, lockBefore.ino, "lock inode was replaced during recovery");
      return {
        owner: ownerIdentity,
        busy: { ...busySettlement, elapsedMs: busyElapsedMs },
        killed,
        recovered: recovered.status,
        lockIdentity: { dev: lockAfter.dev, ino: lockAfter.ino },
      };
    },
    cleanup: async () => {
      const status = await invoke("status", "issue-466-cleanup-status");
      if (status.status.active) await invoke("stop", "issue-466-cleanup-stop");
      if (status.status.installed) await invoke("uninstall", "issue-466-cleanup-uninstall");
      const final = await invoke("status", "issue-466-cleanup-final");
      assert.deepEqual(
        {
          installed: final.status.installed,
          enabled: final.status.enabled,
          active: final.status.active,
        },
        { installed: false, enabled: false, active: false },
      );
      assert.equal(managerState(authority.unit, authority.uid).LoadState, "not-found");
      assert.equal(processesReferencing(authority), 0, "a process still references the launcher");
      for (const path of metadata) rmSync(path, { force: true });
      assert.ok(statOptional(authority.lockPath), "production lock inode unexpectedly disappeared");
      const probe = spawnCaptured(
        "/usr/bin/flock",
        ["--exclusive", "--nonblock", authority.lockPath, "/usr/bin/true"],
        { cwd: authority.checkout, env: authority.runtimeEnvironment },
      );
      spawned.add(probe);
      const unlocked = await within(probe.settled, 5_000, "unlocked lock probe");
      spawned.delete(probe);
      assert.equal(unlocked.code, 0, "production lifecycle lock remains owned");
      return {
        status: final.status,
        manager: managerState(authority.unit, authority.uid),
        lockRetained: true,
      };
    },
  };
  try {
    evidence.preflight = {
      manager: managerState(authority.unit, authority.uid),
      unitPathPresent: statOptional(authority.unitPath),
      lockPathPresent: statOptional(authority.lockPath),
    };
    assert.equal(evidence.preflight.manager.LoadState, "not-found");
    assert.equal(evidence.preflight.unitPathPresent, false);
    save();
    evidence.result = await runLifecycleRaceMatrix(port);
    evidence.completedAt = new Date().toISOString();
    save();
    console.log(
      JSON.stringify({
        result: "passed",
        unit: authority.unit,
        artifactIdentity: authority.artifactIdentity,
        sourceCommit,
        candidateVersion: authority.candidateVersion,
        installReceiptIdentity: authority.installReceiptIdentity,
        harnessSha256: evidence.harnessSha256,
        completedAt: evidence.completedAt,
        privateEvidenceRetained: true,
      }),
    );
  } catch (error) {
    evidence.failure = {
      message: error instanceof Error ? error.message : String(error),
      at: new Date().toISOString(),
      automaticRetry: false,
      automaticUnitCleanup: false,
    };
    save();
    process.exitCode = 2;
    console.error("Installed lifecycle qualification incomplete; inspect retained evidence.");
  } finally {
    for (const handle of spawned) {
      if (handle.child.exitCode === null && handle.child.signalCode === null)
        handle.child.kill("SIGTERM");
    }
    closeSync(evidenceFd);
  }
}

function statOptional(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function processesReferencing(authority) {
  let count = 0;
  for (const entry of readdirSync("/proc")) {
    if (!/^[0-9]+$/.test(entry)) continue;
    try {
      const facts = statSync(`/proc/${entry}`);
      if (facts.uid !== authority.uid) continue;
      const argv = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0").filter(Boolean);
      if (
        argv.includes(authority.factoryCli) &&
        argv.includes("controller") &&
        argv.includes("run") &&
        argv.includes(authority.repository) &&
        argv.includes(authority.checkout)
      )
        count++;
    } catch (error) {
      if (!["ENOENT", "EACCES", "ESRCH"].includes(error.code)) throw error;
    }
  }
  return count;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch {
    process.exitCode = 2;
    console.error(
      "Installed lifecycle qualification prerequisites unavailable; no claim recorded.",
    );
  }
}
