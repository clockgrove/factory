import { AsyncLocalStorage } from "node:async_hooks";
import { type SpawnOptions, spawn, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

export function command(
  file: string,
  args: string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv,
  input?: string,
): string {
  const result = spawnSync(file, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: Number.MAX_SAFE_INTEGER,
    input,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${file} ${args.join(" ")} failed (${result.status}): ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout.trim();
}

export function git(checkout: string, ...args: string[]): string {
  return command("git", ["-C", checkout, ...args]);
}

/** Keep inherited Git overrides from redirecting a pinned local tree operation. */
export function pinnedGit(checkout: string, ...args: string[]): string {
  return pinnedGitRaw(checkout, ...args)
    .toString("utf8")
    .trim();
}

/** Preserve exact pinned Git output without trimming or decoding. */
export function pinnedGitRaw(checkout: string, ...args: string[]): Buffer {
  const result = spawnSync("git", ["-C", checkout, ...args], {
    env: pinnedGitEnvironment(),
    maxBuffer: Number.MAX_SAFE_INTEGER,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `git ${args.join(" ")} failed (${result.status}): ${result.stderr.toString("utf8")}`,
    );
  return result.stdout;
}

export function pinnedGitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith("GIT_")) delete env[key];
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_LITERAL_PATHSPECS: "1",
  });
  return env;
}

/** Give workers and validators only the ambient variables needed for local work. */
export function sanitizedWorkerEnvironment(
  credentialDirectory: string,
  allowedSecretNames: string[] = [],
): Record<string, string> {
  const env: Record<string, string> = {};
  const allowedNames = new Set([
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "TERM",
    "TMPDIR",
    "TMP",
    "TEMP",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_RUNTIME_DIR",
    "CODEX_HOME",
    "CODEX_SQLITE_HOME",
  ]);
  for (const [key, value] of Object.entries(process.env)) {
    const declared =
      allowedSecretNames.includes(key) &&
      !/^(GH_|GITHUB_|GIT_|SSH_)/i.test(key);
    if (
      value &&
      (allowedNames.has(key) || /^LC_[A-Z_]+$/.test(key) || declared)
    )
      env[key] = value;
  }
  Object.assign(env, {
    GH_CONFIG_DIR: credentialDirectory,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
  });
  return env;
}

/** Validation and its read-only lookup use the supplied PATH, not login profiles. */
export function localValidationShellArguments(command: string): string[] {
  return ["-c", command];
}

export function localValidationEnvironment(
  credentialDirectory: string,
): Record<string, string> {
  return sanitizedWorkerEnvironment(credentialDirectory);
}

export function resolveLocalExecutable(
  executable: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  shell: string,
) {
  return spawnSync(
    shell,
    [
      ...localValidationShellArguments('command -v "$1"'),
      "factory-preflight",
      executable,
    ],
    { cwd, env, encoding: "utf8" },
  );
}

export function linuxProcessIdentity(
  pid: number,
): { group: number; startTime: string; state: string } | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(") ");
    if (close < 0) throw new Error(`Cannot parse process identity for ${pid}`);
    const fields = stat
      .slice(close + 2)
      .trim()
      .split(/\s+/);
    const group = Number(fields[2]);
    const startTime = fields[19];
    if (!Number.isSafeInteger(group) || !startTime || !fields[0])
      throw new Error(`Cannot parse process identity for ${pid}`);
    return { group, startTime, state: fields[0] };
  } catch (error) {
    if (
      ["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")
    )
      return null;
    throw error;
  }
}

export function processGroupExists(group: number): boolean {
  for (const name of readdirSync("/proc")) {
    if (!/^[1-9]\d*$/.test(name)) continue;
    const identity = linuxProcessIdentity(Number(name));
    if (identity?.group === group && identity.state !== "Z") return true;
  }
  return false;
}

/**
 * SIGKILL a worker's process group and wait for it to go. A group that
 * survives SIGKILL is a host problem; repeating the kill is always safe.
 */
export async function killProcessGroup(group: number): Promise<void> {
  try {
    process.kill(-group, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  for (let poll = 0; poll < 250 && processGroupExists(group); poll++)
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  if (processGroupExists(group))
    throw new Error(
      `Worker process group ${group} survived SIGKILL; the host must reap it before the attempt can be repeated`,
    );
}

export interface OwnedSubprocess {
  pid: number;
  startTime: string;
}
interface ProcessScope {
  unresolved?: boolean;
  signal?: AbortSignal;
  observe?: (process: OwnedSubprocess, settled: boolean) => void;
}
const processCancellation = new AsyncLocalStorage<ProcessScope>();
export function hasUnresolvedSubprocesses(): boolean {
  return processCancellation.getStore()?.unresolved === true;
}
export function currentProcessSignal(): AbortSignal | undefined {
  return processCancellation.getStore()?.signal;
}

/** Bind controller subprocesses to the current coordinator cancellation request. */
export function withProcessCancellation<T>(
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
  observe?: ProcessScope["observe"],
): Promise<T> {
  return processCancellation.run({ signal, observe }, operation);
}

export async function subprocessAsync(
  file: string,
  args: string[],
  options: SpawnOptions = {},
  input?: string,
  observe?: (stream: "stdout" | "stderr", chunk: Buffer) => void,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const scope = processCancellation.getStore();
  const signal = scope?.signal;
  signal?.throwIfAborted();
  const child = spawn(file, args, { ...options, detached: true });
  const identity = child.pid ? linuxProcessIdentity(child.pid) : null;
  const owned =
    child.pid && identity
      ? { pid: child.pid, startTime: identity.startTime }
      : undefined;
  if (owned) scope?.observe?.(owned, false);
  let cancellationError: unknown;
  let aborted = false;
  const cancel = () => {
    aborted = true;
    if (!child.pid) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH")
        cancellationError = error;
    }
  };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const output: Record<"stdout" | "stderr", Buffer[]> = {
    stdout: [],
    stderr: [],
  };
  for (const stream of ["stdout", "stderr"] as const)
    child[stream]?.on("data", (chunk: Buffer) => {
      output[stream].push(chunk);
      observe?.(stream, chunk);
    });
  // A child may exit before consuming input; its exit status remains authoritative.
  child.stdin?.on("error", () => {
    /* Child exit status is authoritative. */
  });
  child.stdin?.end(input);
  let error: Error | undefined;
  const status = await new Promise<number | null>((resolve) => {
    child.on("error", (cause) => {
      error = cause;
    });
    child.on("close", resolve);
  });
  signal?.removeEventListener("abort", cancel);
  if (aborted && child.pid) {
    // SIGKILL is asynchronous. Allow the kernel to reap runnable descendants.
    for (
      let attempt = 0;
      attempt < 100 && processGroupExists(child.pid);
      attempt++
    )
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    if (cancellationError || processGroupExists(child.pid)) {
      if (scope) scope.unresolved = true;
      throw new Error(
        "Owned subprocess cessation could not be verified; outcome unknown",
        { cause: cancellationError },
      );
    }
  }
  if (owned && !processGroupExists(owned.pid)) scope?.observe?.(owned, true);
  else if (owned) {
    if (scope) scope.unresolved = true;
    throw new Error("Owned subprocess group remains active; outcome unknown");
  }
  if (aborted)
    throw new Error("Owned subprocess cancelled after verified cessation");
  if (error) throw error;
  return {
    status,
    stdout: Buffer.concat(output.stdout).toString("utf8"),
    stderr: Buffer.concat(output.stderr).toString("utf8"),
  };
}

export async function commandAsync(
  file: string,
  args: string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv,
  input?: string,
): Promise<string> {
  const result = await subprocessAsync(file, args, { cwd, env }, input);
  if (result.status !== 0)
    throw new Error(
      `${file} ${args.join(" ")} failed (${result.status}): ${result.stderr || result.stdout}`,
    );
  return result.stdout.trim();
}

export function gitAsync(checkout: string, ...args: string[]): Promise<string> {
  return commandAsync("git", ["-C", checkout, ...args]);
}

export function pinnedGitAsync(
  checkout: string,
  ...args: string[]
): Promise<string> {
  return commandAsync(
    "git",
    ["-C", checkout, ...args],
    undefined,
    pinnedGitEnvironment(),
  );
}
