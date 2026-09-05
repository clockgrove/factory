import { spawn, type ChildProcess } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";

import { assertNoSecretMaterial, MAX_LOG_BYTES } from "../protocol/limits.js";

const activeGroups = new Set<number>();
let exitHookInstalled = false;

/** Enumerate names only: Dirent conversion may lstat a PID that has already exited. */
export async function linuxProcessIds(procRoot = "/proc"): Promise<number[]> {
  return (await readdir(procRoot))
    .filter((name) => /^[1-9]\d*$/.test(name))
    .map(Number)
    .filter(Number.isSafeInteger);
}

export const PARENT_DEATH_WATCHDOG = String.raw`
supervisor_pid="$1"
shift
(
  parent_gone=0
  sleep_pid=""
  stop_watchdog() {
    if [ "$parent_gone" -eq 1 ]; then return; fi
    if [ -n "$sleep_pid" ]; then kill -KILL "$sleep_pid" 2>/dev/null || true; fi
    exit 0
  }
  trap 'stop_watchdog' HUP TERM
  while kill -0 "$supervisor_pid" 2>/dev/null; do
    sleep 1 &
    sleep_pid=$!
    wait "$sleep_pid" 2>/dev/null || true
    sleep_pid=""
  done
  parent_gone=1
  /bin/kill -TERM -- "-$$" 2>/dev/null || true
  sleep 2
  /bin/kill -KILL -- "-$$" 2>/dev/null || true
) </dev/null >/dev/null 2>&1 &
watchdog_pid=$!
"$@"
worker_status=$?
kill -TERM "$watchdog_pid" 2>/dev/null || true
wait "$watchdog_pid" 2>/dev/null || true
exit "$worker_status"
`;

function installExitHook(): void {
  if (exitHookInstalled || process.platform === "win32") return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const pid of activeGroups) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // Already gone. Exit cleanup is best-effort and cannot await.
      }
    }
  });
}

function boundedAppend(current: string, chunk: Buffer, limit: number): string {
  const next = current + chunk.toString("utf8");
  if (Buffer.byteLength(next, "utf8") <= limit) return next;
  const bytes = Buffer.from(next, "utf8");
  const tailBudget = Math.max(0, limit - 80);
  return `[output truncated to ${limit} bytes]\n${bytes.subarray(bytes.length - tailBudget).toString("utf8")}`;
}

export function sanitizedWorkerEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  permittedSecretNames: string[] = [],
): NodeJS.ProcessEnv {
  const permitted = new Set(permittedSecretNames);
  const result: NodeJS.ProcessEnv = {};
  const deniedNames =
    /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY|ACCESS_KEY|CREDENTIALS?)(?:$|_)/i;
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (/^(?:GH|GITHUB)_/i.test(key)) continue;
    if (["SSH_AUTH_SOCK", "GIT_ASKPASS", "SSH_ASKPASS"].includes(key)) continue;
    if (key.startsWith("FACTORY_") && key !== "FACTORY_TEST_MODE") continue;
    if (deniedNames.test(key) && !permitted.has(key)) continue;
    result[key] = value;
  }
  result.GIT_TERMINAL_PROMPT = "0";
  result.GCM_INTERACTIVE = "Never";
  result.GIT_CONFIG_COUNT = "1";
  result.GIT_CONFIG_KEY_0 = "credential.helper";
  result.GIT_CONFIG_VALUE_0 = "";
  result.FACTORY_WORKER = "1";
  result.FACTORY_SUPERVISED = "1";
  return result;
}

export interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface ContainedProcess {
  pid: number;
  completed: Promise<ProcessResult>;
  cancel(signal?: NodeJS.Signals): Promise<void>;
}

export interface StartProcessOptions {
  command: string;
  args?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes?: number;
  cancellationGraceMs?: number;
  /** Owned outer resource cleanup, invoked on exit, timeout, and cancellation
   * before waiting for pipes that escaped descendants may still hold open. */
  terminateDescendants?: () => Promise<void>;
}

export interface ProcessGroupControl {
  platform?: NodeJS.Platform;
  procRoot?: string;
  sendSignal?: (pid: number, signal: NodeJS.Signals | 0) => void;
  wait?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

interface LinuxProcessStat {
  state: string;
  processGroupId: number;
}

class LinuxProcessStatParseError extends Error {}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function readLinuxProcessStat(pid: number, procRoot = "/proc"): LinuxProcessStat | null {
  try {
    const stat = readFileSync(`${procRoot}/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(") ");
    if (close < 0) {
      throw new LinuxProcessStatParseError(`could not parse ${procRoot}/${pid}/stat`);
    }
    const fields = stat
      .slice(close + 2)
      .trim()
      .split(/\s+/);
    const processGroupId = Number(fields[2]);
    if (!fields[0] || !Number.isSafeInteger(processGroupId) || processGroupId < 0) {
      throw new LinuxProcessStatParseError(`could not parse ${procRoot}/${pid}/stat`);
    }
    return { state: fields[0], processGroupId };
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes(errorCode(error) ?? "")) return null;
    throw error;
  }
}

export function linuxProcessGroupId(pid: number, procRoot = "/proc"): number | null {
  return readLinuxProcessStat(pid, procRoot)?.processGroupId ?? null;
}

function linuxProcessGroupExists(groupId: number, procRoot: string): boolean | undefined {
  let entries: string[];
  try {
    entries = readdirSync(procRoot);
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(errorCode(error) ?? "")) return undefined;
    throw error;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let stat: LinuxProcessStat | null;
    try {
      stat = readLinuxProcessStat(Number(entry), procRoot);
    } catch (error) {
      // A process can disappear while procfs is serving its stat file and
      // yield an empty or partial read instead of ENOENT. Fall back to the
      // direct process-group probe rather than reporting absence or failing an
      // otherwise successful child command because an unrelated PID raced us.
      if (error instanceof LinuxProcessStatParseError) return undefined;
      throw error;
    }
    if (stat?.processGroupId === groupId && stat.state !== "Z") return true;
  }
  return false;
}

/**
 * Reports whether a POSIX process group has any live member. EPERM is evidence
 * that the group still exists, not evidence that it disappeared.
 */
export function processGroupExists(groupId: number, control: ProcessGroupControl = {}): boolean {
  if (!Number.isSafeInteger(groupId) || groupId <= 0) {
    throw new Error(`invalid process group ID ${groupId}`);
  }
  const platform = control.platform ?? process.platform;
  if (platform === "linux") {
    const discovered = linuxProcessGroupExists(groupId, control.procRoot ?? "/proc");
    if (discovered !== undefined) return discovered;
  }
  const sendSignal = control.sendSignal ?? process.kill.bind(process);
  try {
    sendSignal(-groupId, 0);
    return true;
  } catch (error) {
    const code = errorCode(error);
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

function signalProcessGroup(
  groupId: number,
  signal: NodeJS.Signals,
  control: ProcessGroupControl,
): boolean {
  const sendSignal = control.sendSignal ?? process.kill.bind(process);
  try {
    sendSignal(-groupId, signal);
    return true;
  } catch (error) {
    if (errorCode(error) === "ESRCH") return false;
    const code = errorCode(error);
    const failure = new Error(
      `could not signal process group ${groupId} with ${signal}${code ? `: ${code}` : ""}`,
      { cause: error },
    ) as NodeJS.ErrnoException;
    if (code) failure.code = code;
    throw failure;
  }
}

/** Terminate a complete POSIX process group and prove that no live member remains. */
export async function terminateProcessGroup(
  groupId: number,
  signal: NodeJS.Signals,
  graceMs: number,
  control: ProcessGroupControl = {},
): Promise<void> {
  if ((control.platform ?? process.platform) === "win32") {
    throw new Error("process-group termination is unavailable on Windows");
  }
  const now = control.now ?? Date.now;
  const wait =
    control.wait ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const waitUntil = async (deadline: number): Promise<boolean> => {
    while (processGroupExists(groupId, control) && now() < deadline) {
      await wait(20);
    }
    return !processGroupExists(groupId, control);
  };
  const signalled = signalProcessGroup(groupId, signal, control);
  if (!signalled && !processGroupExists(groupId, control)) return;
  if (signal !== "SIGKILL" && (await waitUntil(now() + graceMs))) return;
  if (signal !== "SIGKILL") {
    const killed = signalProcessGroup(groupId, "SIGKILL", control);
    if (!killed && !processGroupExists(groupId, control)) return;
  }
  if (!(await waitUntil(now() + Math.max(500, graceMs)))) {
    throw new Error(`process group ${groupId} survived SIGKILL`);
  }
}

async function terminateGroup(
  child: ChildProcess,
  signal: NodeJS.Signals,
  graceMs: number,
): Promise<void> {
  if (!child.pid) return;
  if (process.platform === "win32") {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    return;
  }
  await terminateProcessGroup(child.pid, signal, graceMs);
}

export function startContainedProcess(options: StartProcessOptions): ContainedProcess {
  installExitHook();
  const startedAt = Date.now();
  const command = process.platform === "win32" ? options.command : "/bin/sh";
  const args =
    process.platform === "win32"
      ? (options.args ?? [])
      : [
          "-c",
          PARENT_DEATH_WATCHDOG,
          "factory-parent-watchdog",
          String(process.pid),
          options.command,
          ...(options.args ?? []),
        ];
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!child.pid) throw new Error(`failed to launch ${options.command}`);
  const pid = child.pid;
  if (process.platform !== "win32") activeGroups.add(pid);

  const maxOutput = options.maxOutputBytes ?? MAX_LOG_BYTES;
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let outputViolation: string | null = null;
  const scanTails = { stdout: "", stderr: "" };
  let groupTermination: Promise<void> | null = null;
  const terminateOnce = (signal: NodeJS.Signals): Promise<void> => {
    groupTermination ??= Promise.allSettled([
      terminateGroup(child, signal, options.cancellationGraceMs ?? 2_000),
      Promise.resolve().then(() => options.terminateDescendants?.()),
    ]).then((results) => {
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    });
    // Timeout/output watchdogs initiate cleanup before the exit listener can
    // await it. Preserve the rejection for callers without an unhandled window.
    void groupTermination.catch(() => undefined);
    return groupTermination;
  };
  const scan = (stream: keyof typeof scanTails, chunk: Buffer): boolean => {
    if (outputViolation) return false;
    const candidate = scanTails[stream] + chunk.toString("utf8");
    try {
      assertNoSecretMaterial(candidate, `${stream} output`);
    } catch (error) {
      outputViolation =
        error instanceof Error
          ? error.message
          : `${stream} output contains suspected secret material`;
      void terminateOnce("SIGTERM");
      return false;
    }
    scanTails[stream] = candidate.slice(-8_192);
    return true;
  };
  child.stdout?.on("data", (chunk: Buffer) => {
    if (scan("stdout", chunk)) stdout = boundedAppend(stdout, chunk, maxOutput);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    if (scan("stderr", chunk)) stderr = boundedAppend(stderr, chunk, maxOutput);
  });

  let settle: ((result: ProcessResult) => void) | null = null;
  const completed = new Promise<ProcessResult>((resolve, reject) => {
    settle = resolve;
    child.once("error", reject);
  });
  const streamsClosed = new Promise<void>((resolveClosed) => {
    // `exit` can precede the final stdout/stderr `data` events. Collection must
    // not expose a successful command until both pipes have drained.
    child.once("close", () => resolveClosed());
  });
  let timeout: NodeJS.Timeout | null = setTimeout(() => {
    timedOut = true;
    void terminateOnce("SIGTERM");
  }, options.timeoutMs);

  child.once("exit", (exitCode, signal) => {
    if (timeout) clearTimeout(timeout);
    timeout = null;
    void Promise.all([terminateOnce("SIGTERM"), streamsClosed])
      .then(() => {
        activeGroups.delete(pid);
        settle?.({
          exitCode: outputViolation ? 1 : exitCode,
          signal,
          stdout: outputViolation ? "" : stdout,
          stderr: outputViolation ?? stderr,
          durationMs: Date.now() - startedAt,
          timedOut,
        });
      })
      .catch((error: unknown) => {
        // An escaped descendant can retain the pipes even after its leader and
        // original process group are gone. Failed owned cleanup must return an
        // explicit failure, not keep the Supervisor waiting for that descendant.
        child.stdout?.destroy();
        child.stderr?.destroy();
        activeGroups.delete(pid);
        settle?.({
          exitCode: 1,
          signal,
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - startedAt,
          timedOut,
        });
      });
  });

  return {
    pid,
    completed,
    async cancel(signal = "SIGTERM"): Promise<void> {
      await terminateOnce(signal);
      await completed;
    },
  };
}

export async function runContainedProcess(options: StartProcessOptions): Promise<ProcessResult> {
  return startContainedProcess(options).completed;
}
