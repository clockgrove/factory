import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { TransientError } from "./github.js";

const run = promisify(execFile);
const MINUTE = 60_000;

/** Git without the operator's configuration, replacements or lazy fetches. */
export function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith("GIT_")) delete env[key];
  return Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_LITERAL_PATHSPECS: "1",
  });
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
    await run(
      "git",
      ["-C", checkout, "fetch", "--quiet", "--prune", "origin"],
      { timeout: 5 * MINUTE, signal },
    );
    await run(
      "git",
      ["-C", checkout, "remote", "set-head", "origin", "--auto"],
      { timeout: MINUTE, signal },
    );
    const { stdout } = await run(
      "git",
      [
        "-C",
        checkout,
        "rev-parse",
        "--verify",
        "refs/remotes/origin/HEAD^{commit}",
      ],
      { timeout: MINUTE, signal },
    );
    return stdout.trim();
  } catch (error) {
    if (signal.aborted) throw error;
    throw new TransientError(
      `git fetch in ${checkout}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
