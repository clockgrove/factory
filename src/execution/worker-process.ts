/**
 * The spawned local worker process the Codex, Claude and GitHub Copilot
 * harnesses share (#515, #585). A worker is identified before it is spawned:
 * its request path, unique per attempt identity, is in its argv. Its pid is
 * written next to it as soon as spawn returns. So a start that a crash or a
 * cancel interrupted before the handle was recorded can still be found and
 * stopped, and a repeat of the start never runs beside it.
 */
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { HarnessObservation } from "../contracts.js";
import { linuxProcessIdentity, processGroupExists } from "../process.js";
import { parseAuthenticationRequest } from "./harness-support.js";

export interface WorkerHandleData {
  pid: number;
  startTime: string;
  requestPath: string;
  resultPath: string;
  logPath: string;
}

function workerPaths(root: string, identity: string) {
  return {
    requestPath: resolve(join(root, `${identity}.request.json`)),
    resultPath: resolve(join(root, `${identity}.result.json`)),
    logPath: resolve(join(root, `${identity}.log`)),
    pidPath: resolve(join(root, `${identity}.pid`)),
  };
}

/**
 * Spawn one worker in its own process group. An earlier unrecorded start of
 * the same identity is stopped and its files removed first, so this start
 * is fresh.
 */
export async function launchWorker(options: {
  root: string;
  identity: string;
  input: unknown;
  script: string;
  env: NodeJS.ProcessEnv;
  label: string;
}): Promise<WorkerHandleData> {
  const { root, identity, label } = options;
  await stopUnrecordedWorker(root, identity, label);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const paths = workerPaths(root, identity);
  writeFileSync(paths.requestPath, `${JSON.stringify(options.input)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  const log = openSync(paths.logPath, "a", 0o600);
  let pid: number;
  try {
    const child = spawn(
      process.execPath,
      [options.script, paths.requestPath, paths.resultPath],
      { detached: true, stdio: ["ignore", log, log], env: options.env },
    );
    if (!child.pid) throw new Error(`Failed to launch ${label} worker`);
    pid = child.pid;
    writeFileSync(paths.pidPath, `${pid}\n`, { mode: 0o600 });
    child.unref();
  } finally {
    closeSync(log);
  }
  const host = linuxProcessIdentity(pid);
  if (!host || host.group !== pid) {
    await stopUnrecordedWorker(root, identity, label);
    throw new Error(`${label} worker did not start in its own process group`);
  }
  return {
    pid,
    startTime: host.startTime,
    requestPath: paths.requestPath,
    resultPath: paths.resultPath,
    logPath: paths.logPath,
  };
}

function commandLine(pid: string): string[] {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
  } catch {
    return [];
  }
}

/**
 * Stop whatever a start of `identity` spawned whose handle was never
 * recorded, then remove its request, result and pid files. Resolves once no
 * process of it runs. The log is kept for diagnosis.
 */
export async function stopUnrecordedWorker(
  root: string,
  identity: string,
  label: string,
): Promise<void> {
  const paths = workerPaths(root, identity);
  const groups = new Set<number>();
  try {
    const pid = Number(readFileSync(paths.pidPath, "utf8").trim());
    if (Number.isSafeInteger(pid) && pid > 1) groups.add(pid);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // A crash between spawn and the pid file: the request path in argv names it.
  if (existsSync(paths.requestPath))
    for (const name of readdirSync("/proc"))
      if (
        /^[1-9]\d*$/.test(name) &&
        commandLine(name).includes(paths.requestPath)
      )
        groups.add(Number(name));
  for (const group of groups) {
    const leader = linuxProcessIdentity(group);
    // A live leader must be our worker (pids are reused). With the leader
    // gone, a group that still exists is ours: Linux never hands out a pid
    // that is still some group's id.
    if (leader) {
      if (
        leader.group !== group ||
        !commandLine(String(group)).includes(paths.requestPath)
      )
        continue;
    } else if (!processGroupExists(group)) continue;
    await killGroup(group, label);
  }
  rmSync(`${paths.requestPath}.codex-home`, { recursive: true, force: true });
  for (const path of [paths.requestPath, paths.resultPath, paths.pidPath])
    rmSync(path, { force: true });
}

/** SIGTERM, then SIGKILL after two seconds; resolves once the group is gone. */
export async function killGroup(group: number, label: string): Promise<void> {
  const signal = (name: NodeJS.Signals) => {
    try {
      process.kill(-group, name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  const settled = async (milliseconds: number) => {
    const deadline = Date.now() + milliseconds;
    while (processGroupExists(group) && Date.now() < deadline)
      await new Promise<void>((done) => setTimeout(done, 20));
    return !processGroupExists(group);
  };
  signal("SIGTERM");
  if (await settled(2_000)) return;
  signal("SIGKILL");
  if (await settled(10_000)) return;
  throw new Error(`${label} worker cessation remains unresolved`);
}

/**
 * What a worker's durable result file says, or whether its process still
 * runs. A failure the worker marked `lost` (the provider turn broke after
 * the model was reached) and a worker that died without a result are
 * `interrupted`: a lost paid run, not a wrong result.
 */
export function observeWorker(
  data: WorkerHandleData,
  label: string,
): HarnessObservation {
  if (existsSync(data.resultPath)) {
    const result = JSON.parse(readFileSync(data.resultPath, "utf8")) as {
      state: "complete" | "failed";
      error?: string;
      authentication?: unknown;
      lost?: boolean;
    };
    const authentication = parseAuthenticationRequest(result.authentication);
    return result.state === "complete"
      ? { state: "complete" }
      : {
          state: "failed",
          detail: result.error,
          ...(result.lost === true && !authentication && { interrupted: true }),
          ...(authentication && { authentication }),
        };
  }
  const current = linuxProcessIdentity(data.pid);
  return current?.startTime === data.startTime &&
    current.group === data.pid &&
    current.state !== "Z"
    ? { state: "running" }
    : {
        state: "failed",
        interrupted: true,
        detail: `${label} worker exited without a durable result`,
      };
}
