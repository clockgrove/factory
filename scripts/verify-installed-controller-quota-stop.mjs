/** Exact installed-controller proof for the primary-quota plus explicit-stop race. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import {
  installedQualificationAuthority,
  qualificationRuntimeEnvironment,
} from "./qualification-install-identity.mjs";

const MAX_OUTPUT = 64 * 1024;
const MAX_EVIDENCE = 1024 * 1024;
const WAIT_MS = 15_000;
const ARM_ENV = "FACTORY_INSTALLED_QUOTA_STOP_ARM";
const MANAGER_ENVIRONMENT_KEYS = ["NODE_OPTIONS", ARM_ENV];
const unitPattern = /^clockgrove-factory-[a-f0-9]{16}\.service$/;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function required(env, name) {
  const value = env[name]?.trim();
  assert.ok(value, `${name} is required`);
  return value;
}

function command(file, args, cwd, env, timeout = 30_000) {
  return execFileSync(file, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout,
    maxBuffer: MAX_OUTPUT,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function privateJson(path, uid, maximum = 16 * 1024) {
  const facts = lstatSync(path);
  assert.ok(facts.isFile() && !facts.isSymbolicLink(), `${path} must be a regular file`);
  assert.equal(facts.uid, uid, `${path} owner differs`);
  assert.equal(facts.mode & 0o777, 0o600, `${path} must be mode 0600`);
  assert.equal(facts.nlink, 1, `${path} must have one link`);
  assert.ok(facts.size > 0 && facts.size <= maximum, `${path} is outside its byte bound`);
  return JSON.parse(readFileSync(path, "utf8"));
}

async function waitForPrivateJson(path, uid, timeoutMs = WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return privateJson(path, uid);
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.name !== "SyntaxError") throw error;
    }
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${path}`);
}

function managerEnvironment(uid) {
  return {
    LANG: "C",
    LC_ALL: "C",
    PATH: "/usr/bin:/bin",
    XDG_RUNTIME_DIR: `/run/user/${uid}`,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus`,
  };
}

function managerCommand(uid, args) {
  return command("/usr/bin/systemctl", ["--user", ...args], homedir(), managerEnvironment(uid));
}

export function parseSelectedManagerEnvironment(output) {
  assert.ok(Buffer.byteLength(output) <= MAX_OUTPUT, "systemd manager environment is unbounded");
  const selected = {};
  for (const line of output.split("\n")) {
    if (!line) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator);
    if (!MANAGER_ENVIRONMENT_KEYS.includes(key)) continue;
    assert.equal(selected[key], undefined, "systemd manager environment key is duplicated");
    selected[key] = line.slice(separator + 1);
  }
  return selected;
}

function selectedManagerEnvironment(uid) {
  return parseSelectedManagerEnvironment(managerCommand(uid, ["show-environment"]));
}

export function qualificationManagerEnvironment(preloadPath, armPath) {
  assert.equal(resolve(preloadPath), preloadPath, "preload path must be absolute");
  assert.equal(resolve(armPath), armPath, "arm path must be absolute");
  const nodeOptions = `--import=${pathToFileURL(preloadPath).href}`;
  assert.equal(/\s/.test(nodeOptions), false, "qualification NODE_OPTIONS contains whitespace");
  assert.equal(/\s/.test(armPath), false, "qualification arm path contains whitespace");
  return { NODE_OPTIONS: nodeOptions, [ARM_ENV]: armPath };
}

function setManagerEnvironment(uid, expected) {
  assert.deepEqual(selectedManagerEnvironment(uid), {}, "qualification manager variables exist");
  managerCommand(uid, [
    "set-environment",
    `NODE_OPTIONS=${expected.NODE_OPTIONS}`,
    `${ARM_ENV}=${expected[ARM_ENV]}`,
  ]);
  assert.deepEqual(
    selectedManagerEnvironment(uid),
    expected,
    "qualification manager variables differ after set",
  );
}

function unsetOwnedManagerEnvironment(uid, expected) {
  const current = selectedManagerEnvironment(uid);
  const owned = MANAGER_ENVIRONMENT_KEYS.filter((key) => current[key] === expected[key]);
  const conflicts = MANAGER_ENVIRONMENT_KEYS.filter(
    (key) => current[key] !== undefined && current[key] !== expected[key],
  );
  if (owned.length > 0) managerCommand(uid, ["unset-environment", ...owned]);
  const after = selectedManagerEnvironment(uid);
  if (conflicts.length > 0) {
    throw new Error(
      `qualification manager variables changed externally: ${conflicts.join(", ")}; foreign values retained`,
    );
  }
  assert.deepEqual(after, {}, "qualification manager variables remain after unset");
  return { variablesAbsent: true };
}

function managerState(uid, unit) {
  const result = spawnSync(
    "/usr/bin/systemctl",
    [
      "--user",
      "show",
      unit,
      "--property=Id,LoadState,UnitFileState,ActiveState,SubState,Result,ExecMainCode,ExecMainStatus,NRestarts,MainPID,FragmentPath,DropInPaths,NeedDaemonReload,InvocationID,ControlGroup,Restart,RestartPreventExitStatus",
      "--no-pager",
    ],
    {
      env: managerEnvironment(uid),
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: MAX_OUTPUT,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.error) throw result.error;
  const raw = result.stdout.trim();
  assert.ok(raw, "systemd returned no controller state");
  return Object.fromEntries(
    raw.split("\n").map((line) => {
      const separator = line.indexOf("=");
      assert.ok(separator > 0, "systemd returned a malformed property");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
  );
}

export function assertUnmodifiedInstalledGeneration(manager, unitPath) {
  assert.equal(manager.LoadState, "loaded");
  assert.equal(manager.FragmentPath, unitPath);
  assert.equal(manager.DropInPaths, "");
  assert.equal(manager.NeedDaemonReload, "no");
}

function unitName(repository, checkout) {
  const key = `${repository.toLowerCase()}\0${resolve(checkout)}`;
  return `clockgrove-factory-${sha256(key).slice(0, 16)}.service`;
}

function exists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function exactStatus(stdout, operation) {
  const status = JSON.parse(stdout);
  assert.ok(status && typeof status === "object", `${operation} returned no status`);
  return status;
}

function acquireQualificationLock(path, uid) {
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const facts = fstatSync(fd);
    assert.ok(facts.isFile(), "qualification lock is not a regular file");
    assert.equal(facts.uid, uid, "qualification lock owner differs");
    assert.equal(facts.mode & 0o077, 0, "qualification lock is not private");
    const result = spawnSync("/usr/bin/flock", ["--exclusive", "--nonblock", "3"], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 2_000,
      stdio: ["ignore", "ignore", "pipe", fd],
    });
    assert.equal(result.error, undefined, "qualification lock helper failed");
    assert.equal(result.signal, null, "qualification lock helper was interrupted");
    assert.equal(result.status, 0, "another installed quota-stop qualification owns the lock");
    return { fd, device: facts.dev, inode: facts.ino };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export async function runInstalledQuotaStopScenario(port) {
  const installed = await port.install();
  const armed = await port.arm(installed);
  const started = await port.start(armed);
  const reached = await port.reached(armed, started);
  const stopped = await port.stop(armed, reached);
  const disarmed = await port.disarm(armed, stopped);
  const telemetry = await port.telemetry(armed, stopped);
  const final = await port.final(armed, telemetry);
  const cleanup = await port.cleanup(armed, final);
  return {
    installed,
    armed,
    started,
    reached,
    disarmed,
    stopped,
    telemetry,
    final,
    cleanup,
  };
}

function authority(env) {
  if (env.FACTORY_QUOTA_STOP_QUALIFICATION !== "1") return null;
  assert.equal(process.platform, "linux", "Linux qualification host required");
  assert.ok(process.getuid, "effective Linux uid unavailable");
  const uid = process.getuid();
  const repository = required(env, "FACTORY_QUOTA_STOP_REPOSITORY");
  assert.match(repository, /^[^/\s]+\/[^/\s]+$/);
  const checkout = realpathSync(required(env, "FACTORY_QUOTA_STOP_CHECKOUT"));
  assert.ok(
    checkout.startsWith(`${realpathSync(homedir())}/`),
    "checkout must be Linux-home native",
  );
  const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const candidate = installedQualificationAuthority(env, {
    uid,
    sourceRoot,
    committedPaths: [
      "scripts/qualification-controller-quota-stop.mjs",
      "scripts/verify-installed-controller-quota-stop.mjs",
    ],
  });
  const runtimeEnvironment = qualificationRuntimeEnvironment(env, { repositoryRoot: checkout });
  const unit = unitName(repository, checkout);
  assert.match(unit, unitPattern);
  const acknowledgement = `${repository}:${unit}:installed-primary-quota-explicit-stop:no-github-transport`;
  assert.equal(required(env, "FACTORY_QUOTA_STOP_ACK"), acknowledgement);
  const evidencePath = resolve(required(env, "FACTORY_QUOTA_STOP_EVIDENCE"));
  const evidenceParent = statSync(dirname(evidencePath));
  assert.ok(evidenceParent.isDirectory());
  assert.equal(evidenceParent.uid, uid);
  assert.equal(evidenceParent.mode & 0o077, 0);
  const runtimeDirectory = `/run/user/${uid}`;
  const runtime = statSync(runtimeDirectory);
  assert.ok(runtime.isDirectory() && runtime.uid === uid && (runtime.mode & 0o077) === 0);
  const unitPath = join(realpathSync(homedir()), ".config/systemd/user", unit);
  return {
    ...candidate,
    repository,
    checkout,
    sourceRoot,
    runtimeEnvironment,
    uid,
    unit,
    unitPath,
    dropInDirectory: `${unitPath}.d`,
    runtimeDirectory,
    lockPath: `${runtimeDirectory}/.clockgrove-factory-installed-quota-stop.lock`,
    acknowledgement,
    evidencePath,
  };
}

export async function main(env = process.env) {
  const selected = authority(env);
  if (!selected) {
    console.log("Not exercised: explicit installed quota-stop qualification opt-in required.");
    return;
  }
  assert.equal(
    command(
      "git",
      ["rev-parse", "--show-toplevel"],
      selected.checkout,
      selected.runtimeEnvironment,
    ),
    selected.checkout,
  );
  assert.equal(
    command(
      "git",
      ["status", "--porcelain", "--untracked-files=all"],
      selected.checkout,
      selected.runtimeEnvironment,
    ),
    "",
  );
  const origin = command(
    "git",
    ["remote", "get-url", "origin"],
    selected.checkout,
    selected.runtimeEnvironment,
  ).replace(/\.git$/, "");
  const actual =
    /^https:\/\/github\.com\/([^/]+\/[^/]+)$/i.exec(origin)?.[1] ??
    /^git@github\.com:([^/]+\/[^/]+)$/i.exec(origin)?.[1] ??
    /^ssh:\/\/git@github\.com\/([^/]+\/[^/]+)$/i.exec(origin)?.[1];
  assert.equal(
    actual?.toLowerCase(),
    selected.repository.toLowerCase(),
    "checkout origin differs from qualification target",
  );
  assert.equal(
    command(
      "git",
      ["status", "--porcelain", "--untracked-files=all"],
      selected.sourceRoot,
      process.env,
    ),
    "",
  );
  assert.equal(
    command("git", ["rev-parse", "HEAD"], selected.sourceRoot, process.env),
    selected.candidateSourceCommit,
  );

  const lock = acquireQualificationLock(selected.lockPath, selected.uid);
  let managerInjection;
  let unitDigest;
  let installed = false;
  let completed = false;
  let evidence;
  let saveEvidence;
  const caseId = randomBytes(16).toString("hex");
  const prefix = `${selected.runtimeDirectory}/.${selected.unit}.${caseId}`;
  const paths = {
    arm: `${prefix}.arm.json`,
    reached: `${prefix}.reached.json`,
    telemetry: `${prefix}.telemetry.json`,
  };
  try {
    assert.ok(!exists(selected.unitPath), "qualification requires an absent controller unit");
    assert.ok(!exists(selected.dropInDirectory), "qualification requires no controller drop-ins");
    assert.deepEqual(
      selectedManagerEnvironment(selected.uid),
      {},
      "qualification manager variables must be absent",
    );
    const preflight = managerState(selected.uid, selected.unit);
    assert.equal(preflight.LoadState, "not-found");
    assert.equal(preflight.DropInPaths, "");

    const evidenceTemporaryPath = `${selected.evidencePath}.${caseId}.tmp`;
    assert.equal(exists(selected.evidencePath), false, "qualification evidence already exists");
    assert.equal(exists(evidenceTemporaryPath), false, "qualification evidence temporary exists");
    evidence = {
      protocol: "clockgrove.factory/installed-controller-quota-stop-qualification",
      sourceCommit: selected.candidateSourceCommit,
      candidateVersion: selected.candidateVersion,
      artifactIdentity: selected.artifactIdentity,
      inventoryIdentity: selected.inventoryIdentity,
      installReceiptIdentity: selected.installReceiptIdentity,
      committedQualificationFiles: selected.committedQualificationFiles,
      unit: selected.unit,
      repositoryIdentity: `sha256:${sha256(selected.repository.toLowerCase())}`,
      checkoutIdentity: `sha256:${sha256(selected.checkout)}`,
      preflight: {
        manager: preflight,
        managerVariablesAbsent: true,
        dropInDirectoryAbsent: true,
        qualificationLock: { device: lock.device, inode: lock.inode },
      },
      stages: {},
      startedAt: new Date().toISOString(),
    };
    saveEvidence = () => {
      const bytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);
      assert.ok(bytes.length <= MAX_EVIDENCE, "qualification evidence exceeds its bound");
      if (exists(selected.evidencePath)) {
        const current = lstatSync(selected.evidencePath);
        assert.ok(current.isFile() && !current.isSymbolicLink());
        assert.equal(current.uid, selected.uid);
        assert.equal(current.mode & 0o777, 0o600);
        assert.equal(current.nlink, 1);
      }
      writeFileSync(evidenceTemporaryPath, bytes, {
        flag: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        mode: 0o600,
      });
      const temporaryFd = openSync(
        evidenceTemporaryPath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      fsyncSync(temporaryFd);
      closeSync(temporaryFd);
      renameSync(evidenceTemporaryPath, selected.evidencePath);
      const parentFd = openSync(
        dirname(selected.evidencePath),
        constants.O_RDONLY | constants.O_DIRECTORY,
      );
      fsyncSync(parentFd);
      closeSync(parentFd);
    };
    const record = (name, value) => {
      evidence.stages[name] = value;
      saveEvidence();
      return value;
    };
    const invoke = (operation, requestId) =>
      exactStatus(
        command(
          process.execPath,
          [
            selected.factoryCli,
            "controller",
            operation,
            selected.repository,
            "--repo",
            selected.checkout,
            "--request-id",
            requestId,
          ],
          selected.checkout,
          selected.runtimeEnvironment,
          120_000,
        ),
        operation,
      );
    saveEvidence();
    await runInstalledQuotaStopScenario({
      install: async () => {
        const status = invoke("install", `issue-314-${caseId}-install`);
        installed = true;
        assert.equal(status.unit, selected.unit);
        assert.equal(status.installed, true);
        assert.equal(status.enabled, true);
        assert.equal(status.active, false);
        assert.equal(status.launcherCurrent, true);
        assert.equal(status.executableIdentity, selected.artifactIdentity);
        const manager = managerState(selected.uid, selected.unit);
        assertUnmodifiedInstalledGeneration(manager, selected.unitPath);
        unitDigest = sha256(readFileSync(selected.unitPath));
        return record("installed", { status, manager, unitDigest });
      },
      arm: async () => {
        const now = Date.now();
        const arm = {
          protocol: "clockgrove.factory/installed-controller-quota-stop-arm",
          caseId,
          unit: selected.unit,
          createdAt: new Date(now).toISOString(),
          expiresAt: new Date(now + 120_000).toISOString(),
          resetEpoch: Math.ceil((now + 3_600_000) / 1_000),
          reachedPath: paths.reached,
          telemetryPath: paths.telemetry,
          nodeExecutable: process.execPath,
          factoryCli: selected.factoryCli,
          repository: selected.repository,
          checkout: selected.checkout,
          artifactIdentity: selected.artifactIdentity,
        };
        writeFileSync(paths.arm, `${JSON.stringify(arm)}\n`, {
          flag: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          mode: 0o600,
        });
        const preload = join(
          selected.sourceRoot,
          "scripts/qualification-controller-quota-stop.mjs",
        );
        managerInjection = qualificationManagerEnvironment(preload, paths.arm);
        setManagerEnvironment(selected.uid, managerInjection);
        const manager = managerState(selected.uid, selected.unit);
        assertUnmodifiedInstalledGeneration(manager, selected.unitPath);
        assert.equal(sha256(readFileSync(selected.unitPath)), unitDigest);
        const armed = {
          ...arm,
          armDigest: sha256(readFileSync(paths.arm)),
          nodeOptionsDigest: sha256(managerInjection.NODE_OPTIONS),
        };
        record("armed", {
          armDigest: armed.armDigest,
          nodeOptionsDigest: armed.nodeOptionsDigest,
          managerVariablesPresent: [...MANAGER_ENVIRONMENT_KEYS],
          manager,
        });
        return armed;
      },
      start: async () => {
        const status = invoke("start", `issue-314-${caseId}-start`);
        assert.equal(status.healthy, true);
        assert.equal(status.active, true);
        assert.equal(status.restartCount, 0);
        const manager = managerState(selected.uid, selected.unit);
        assertUnmodifiedInstalledGeneration(manager, selected.unitPath);
        assert.equal(sha256(readFileSync(selected.unitPath)), unitDigest);
        assert.equal(manager.ActiveState, "active");
        assert.equal(manager.NRestarts, "0");
        assert.match(manager.InvocationID, /^[a-f0-9]{32}$/);
        assert.equal(manager.ControlGroup.split("/").at(-1), selected.unit);
        const mainPid = Number(manager.MainPID);
        assert.ok(Number.isSafeInteger(mainPid) && mainPid > 0, "controller main pid unavailable");
        const argv = readFileSync(`/proc/${mainPid}/cmdline`, "utf8").split("\0").filter(Boolean);
        assert.deepEqual(argv, [
          process.execPath,
          selected.factoryCli,
          "controller",
          "run",
          selected.repository,
          "--repo",
          selected.checkout,
          "--executable-identity",
          selected.artifactIdentity,
        ]);
        record("started", { status, manager, mainPid });
        return { status, manager, mainPid };
      },
      disarm: async () => {
        const cleared = unsetOwnedManagerEnvironment(selected.uid, managerInjection);
        managerInjection = undefined;
        return record("managerEnvironmentCleared", {
          ...cleared,
          clearedImmediatelyAfterSuccessfulExplicitStop: true,
        });
      },
      reached: async (armed, started) => {
        const reached = await waitForPrivateJson(paths.reached, selected.uid);
        assert.deepEqual(
          {
            protocol: reached.protocol,
            caseId: reached.caseId,
            unit: reached.unit,
            armDigest: reached.armDigest,
            nodeOptionsDigest: reached.nodeOptionsDigest,
            pid: reached.pid,
            invocationId: reached.invocationId,
            method: reached.method,
            route: reached.route,
            operation: reached.operation,
          },
          {
            protocol: "clockgrove.factory/installed-controller-quota-stop-reached",
            caseId,
            unit: selected.unit,
            armDigest: armed.armDigest,
            nodeOptionsDigest: armed.nodeOptionsDigest,
            pid: started.mainPid,
            invocationId: started.manager.InvocationID,
            method: "GET",
            route: "repository",
            operation: "repository-facts-rest-read",
          },
        );
        return record("reached", reached);
      },
      stop: async () => {
        const status = invoke("stop", `issue-314-${caseId}-explicit-stop`);
        assert.equal(status.installed, true);
        assert.equal(status.enabled, true);
        assert.equal(status.active, false);
        assert.equal(status.fuseState, "armed");
        assert.equal(status.lastSafeDiagnosticCode, null);
        assert.equal(status.mainExitStatus, 0);
        assert.equal(status.serviceResult, "success");
        assert.equal(status.restartCount, 0);
        return record("stopped", status);
      },
      telemetry: async (armed) => {
        const telemetry = await waitForPrivateJson(paths.telemetry, selected.uid);
        assert.deepEqual(
          {
            protocol: telemetry.protocol,
            caseId: telemetry.caseId,
            unit: telemetry.unit,
            armDigest: telemetry.armDigest,
            nodeOptionsDigest: telemetry.nodeOptionsDigest,
            injectedResponses: telemetry.injectedResponses,
            upstreamFetchCalls: telemetry.upstreamFetchCalls,
            injectedStatus: telemetry.injectedStatus,
            primaryResource: telemetry.primaryResource,
            remaining: telemetry.remaining,
            resetEpoch: telemetry.resetEpoch,
            remoteEffect: telemetry.remoteEffect,
          },
          {
            protocol: "clockgrove.factory/installed-controller-quota-stop-telemetry",
            caseId,
            unit: selected.unit,
            armDigest: armed.armDigest,
            nodeOptionsDigest: armed.nodeOptionsDigest,
            injectedResponses: 1,
            upstreamFetchCalls: 0,
            injectedStatus: 403,
            primaryResource: "core",
            remaining: 0,
            resetEpoch: armed.resetEpoch,
            remoteEffect: "none-preload-intercept",
          },
        );
        assert.equal(telemetry.signal, "SIGTERM");
        assert.ok(Date.parse(telemetry.signalAt) >= Date.parse(telemetry.request.reachedAt));
        assert.ok(Date.parse(telemetry.responseAt) >= Date.parse(telemetry.signalAt));
        return record("telemetry", telemetry);
      },
      final: async () => {
        await sleep(1_000);
        const manager = managerState(selected.uid, selected.unit);
        assertUnmodifiedInstalledGeneration(manager, selected.unitPath);
        assert.equal(sha256(readFileSync(selected.unitPath)), unitDigest);
        assert.equal(manager.ActiveState, "inactive");
        assert.equal(manager.SubState, "dead");
        assert.equal(manager.Result, "success");
        assert.equal(manager.ExecMainCode, "exited");
        assert.equal(manager.ExecMainStatus, "0");
        assert.equal(manager.NRestarts, "0");
        assert.equal(manager.MainPID, "0");
        assert.equal(manager.Restart, "on-failure");
        assert.match(manager.RestartPreventExitStatus, /(?:^|\s)70(?:\s|$)/);
        return record("finalManagerState", manager);
      },
      cleanup: async () => {
        assert.deepEqual(selectedManagerEnvironment(selected.uid), {});
        for (const path of Object.values(paths)) rmSync(path, { force: true });
        const status = invoke("uninstall", `issue-314-${caseId}-cleanup`);
        assert.equal(status.installed, false);
        assert.equal(status.enabled, false);
        assert.equal(status.active, false);
        const manager = managerState(selected.uid, selected.unit);
        assert.equal(manager.LoadState, "not-found");
        assert.equal(manager.DropInPaths, "");
        assert.equal(exists(selected.dropInDirectory), false);
        assert.deepEqual(selectedManagerEnvironment(selected.uid), {});
        installed = false;
        evidence.cleanup = {
          status,
          manager,
          managerVariablesAbsent: true,
          dropInDirectoryAbsent: true,
          metadataRemoved: true,
        };
        saveEvidence();
        return evidence.cleanup;
      },
    });
    completed = true;
    evidence.completedAt = new Date().toISOString();
    saveEvidence();
    console.log(
      JSON.stringify({
        result: "passed",
        sourceCommit: selected.candidateSourceCommit,
        candidateVersion: selected.candidateVersion,
        artifactIdentity: selected.artifactIdentity,
        installReceiptIdentity: selected.installReceiptIdentity,
        unit: selected.unit,
        injectedResponses: 1,
        upstreamFetchCalls: 0,
        serviceResult: "success",
        restartCount: 0,
        fuseState: "armed",
        privateEvidenceRetained: true,
      }),
    );
  } catch (error) {
    if (evidence && saveEvidence) {
      evidence.failure = {
        message: error instanceof Error ? error.message.slice(0, 2_000) : "unknown failure",
        at: new Date().toISOString(),
        automaticRetry: false,
      };
      saveEvidence();
    }
    process.exitCode = 2;
    console.error("Installed quota-stop qualification incomplete; inspect retained evidence.");
  } finally {
    if (!completed && evidence && saveEvidence) {
      evidence.cleanupAfterFailure = { attempted: true, completed: false, errors: [] };
      const cleanupAttempt = (label, operation) => {
        try {
          operation();
        } catch (error) {
          evidence.cleanupAfterFailure.errors.push(
            `${label}: ${error instanceof Error ? error.message.slice(0, 500) : "failed"}`,
          );
        }
      };
      if (installed || exists(selected.unitPath)) {
        cleanupAttempt("stop", () => {
          invokeFailureSafe(selected, "stop", `issue-314-${caseId}-failure-stop`);
        });
        cleanupAttempt("uninstall", () => {
          invokeFailureSafe(selected, "uninstall", `issue-314-${caseId}-failure-uninstall`);
          installed = false;
        });
      }
      if (managerInjection)
        cleanupAttempt("manager-environment", () => {
          assert.equal(
            managerState(selected.uid, selected.unit).LoadState,
            "not-found",
            "manager variables retained because the unit may still restart",
          );
          unsetOwnedManagerEnvironment(selected.uid, managerInjection);
          managerInjection = undefined;
        });
      for (const path of Object.values(paths))
        cleanupAttempt("metadata", () => rmSync(path, { force: true }));
      try {
        evidence.cleanupAfterFailure.completed =
          !exists(selected.unitPath) &&
          !exists(selected.dropInDirectory) &&
          managerState(selected.uid, selected.unit).LoadState === "not-found" &&
          Object.keys(selectedManagerEnvironment(selected.uid)).length === 0;
      } catch (error) {
        evidence.cleanupAfterFailure.errors.push(
          error instanceof Error ? error.message.slice(0, 500) : "cleanup inspection failed",
        );
      }
      saveEvidence();
    }
    closeSync(lock.fd);
  }
}

function invokeFailureSafe(selected, operation, requestId) {
  return command(
    process.execPath,
    [
      selected.factoryCli,
      "controller",
      operation,
      selected.repository,
      "--repo",
      selected.checkout,
      "--request-id",
      requestId,
    ],
    selected.checkout,
    selected.runtimeEnvironment,
    120_000,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch {
    process.exitCode = 2;
    console.error(
      "Installed quota-stop qualification prerequisites unavailable; no claim recorded.",
    );
  }
}
