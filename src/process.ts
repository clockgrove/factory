import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";

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
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
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
