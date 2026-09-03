import { spawn, type ChildProcess } from "node:child_process";

import { MAX_LOG_BYTES } from "../protocol/limits.js";

const activeGroups = new Set<number>();
let exitHookInstalled = false;

export const PARENT_DEATH_WATCHDOG = String.raw`
supervisor_pid="$1"
shift
(
  trap 'exit 0' HUP
  trap '' TERM
  while kill -0 "$supervisor_pid" 2>/dev/null; do sleep 1; done
  /bin/kill -TERM -- "-$$" 2>/dev/null || true
  sleep 2
  /bin/kill -KILL -- "-$$" 2>/dev/null || true
) </dev/null >/dev/null 2>&1 &
watchdog_pid=$!
"$@"
worker_status=$?
kill -KILL "$watchdog_pid" 2>/dev/null || true
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
}

async function terminateGroup(
  child: ChildProcess,
  signal: NodeJS.Signals,
  graceMs: number,
): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, graceMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === "win32") child.kill("SIGKILL");
    else process.kill(-child.pid, "SIGKILL");
  } catch {
    // Already exited between the check and kill.
  }
}

export function startContainedProcess(options: StartProcessOptions): ContainedProcess {
  installExitHook();
  const startedAt = Date.now();
  const command = process.platform === "win32" ? options.command : "/bin/sh";
  const args = process.platform === "win32"
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
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout = boundedAppend(stdout, chunk, maxOutput);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = boundedAppend(stderr, chunk, maxOutput);
  });

  let settle: ((result: ProcessResult) => void) | null = null;
  const completed = new Promise<ProcessResult>((resolve, reject) => {
    settle = resolve;
    child.once("error", reject);
  });
  let timeout: NodeJS.Timeout | null = setTimeout(() => {
    timedOut = true;
    void terminateGroup(child, "SIGTERM", options.cancellationGraceMs ?? 2_000);
  }, options.timeoutMs);

  child.once("exit", (exitCode, signal) => {
    if (timeout) clearTimeout(timeout);
    timeout = null;
    activeGroups.delete(pid);
    settle?.({
      exitCode,
      signal,
      stdout,
      stderr,
      durationMs: Date.now() - startedAt,
      timedOut,
    });
  });

  return {
    pid,
    completed,
    async cancel(signal = "SIGTERM"): Promise<void> {
      await terminateGroup(child, signal, options.cancellationGraceMs ?? 2_000);
      await completed;
    },
  };
}

export async function runContainedProcess(
  options: StartProcessOptions,
): Promise<ProcessResult> {
  return startContainedProcess(options).completed;
}
