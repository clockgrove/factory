import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { TransientError } from "./github.js";

const run = promisify(execFile);
const MINUTE = 60_000;

/**
 * Configuration pinned for every Factory Git call, as GIT_CONFIG_* entries:
 * they outrank the repository's own configuration, so worker-planted config
 * or attributes can't run a program outside the sandbox.
 */
const PINNED: [string, string][] = [
  ["maintenance.auto", "false"],
  ["gc.auto", "0"],
  ["core.hooksPath", "/dev/null"],
  ["core.fsmonitor", "false"],
  // Never descend into a submodule: its configuration is not Factory's.
  ["diff.ignoreSubmodules", "all"],
  ["submodule.recurse", "false"],
  ["core.alternateRefsCommand", ""],
  ["commit.gpgSign", "false"],
  ["tag.gpgSign", "false"],
  ["push.gpgSign", "false"],
  ["merge.verifySignatures", "false"],
  ["log.showSignature", "false"],
  ["protocol.ext.allow", "never"],
  ["protocol.git.allow", "never"],
  ["remote.origin.uploadpack", "git-upload-pack"],
  ["remote.origin.receivepack", "git-receive-pack"],
  // An empty helper clears every helper configured before it.
  ["credential.helper", ""],
  ["core.askPass", ""],
];

/**
 * Git without the operator's configuration: no system or global
 * configuration, no system attributes, no replace objects, no lazy fetch,
 * LFS skip-smudge, literal pathspecs, and the pins above. PATH keeps only
 * absolute entries: Git runs in a tree a worker wrote, so a relative or
 * empty entry would find its helpers (git-lfs, git-<command>) there.
 */
export function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith("GIT_")) delete env[key];
  if (env.PATH !== undefined)
    env.PATH = env.PATH.split(":")
      .filter((entry) => entry.startsWith("/"))
      .join(":");
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
    GIT_CONFIG_COUNT: String(PINNED.length),
  });
  PINNED.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

/**
 * Git with the operator's configuration, which holds credentials and
 * insteadOf rewrites: never prompting, with C messages. Returns standard
 * output; a non-zero exit rejects with execFile's error (code, stdout).
 */
export async function operatorGit(
  checkout: string,
  args: string[],
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string> {
  const { LANGUAGE: _language, LC_ALL: _all, ...env } = process.env;
  const { stdout } = await run("git", ["-C", checkout, ...args], {
    env: { ...env, GIT_TERMINAL_PROMPT: "0", LC_MESSAGES: "C" },
    encoding: "utf8",
    timeout: options.timeoutMs ?? MINUTE,
    maxBuffer: 16 * 1024 * 1024,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return stdout;
}

/**
 * Fetch the target and return its default branch head. Runs with the
 * operator's configuration, which holds the fetch credentials.
 */
export async function defaultHead(
  checkout: string,
  signal: AbortSignal,
): Promise<string> {
  try {
    await operatorGit(checkout, ["fetch", "--quiet", "--prune", "origin"], {
      signal,
      timeoutMs: 5 * MINUTE,
    });
    await operatorGit(checkout, ["remote", "set-head", "origin", "--auto"], {
      signal,
    });
    return (
      await operatorGit(
        checkout,
        ["rev-parse", "--verify", "refs/remotes/origin/HEAD^{commit}"],
        { signal },
      )
    ).trim();
  } catch (error) {
    if (signal.aborted) throw error;
    throw new TransientError(
      `git fetch in ${checkout}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
