// Stopping processes, on real processes: an aborted Codex run leaves no
// command behind, and a host that refuses Codex's namespace holds the call.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { codexLauncher } from "../dist/providers/codex.js";
import { LaunchedGroup, namespacedLauncher } from "../dist/sandbox.js";
import { tempDir } from "./helpers.mjs";

/** Process ids whose command line is exactly `sleep <seconds>`. */
function sleeping(seconds) {
  const found = [];
  for (const pid of readdirSync("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      if (args[0] === "sleep" && args[1] === String(seconds))
        found.push(Number(pid));
    } catch {
      // Gone meanwhile.
    }
  }
  return found;
}

async function until(check, ms, what) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Seconds no other process sleeps for. */
const unique = () => 7_000 + Math.floor(Math.random() * 90_000);

/**
 * Run `launcher` as the SDK does (a plain child, not detached) with a shell
 * command that starts one sleep in a session of its own and one in the
 * shell's group; abort it once both run, and expect neither to survive.
 */
async function abortLeavesNothing(launcher, pidFile, args, env, cwd) {
  const [detached, grouped] = [unique(), unique()];
  const child = spawn(
    launcher,
    [...args, "sh", "-c", `setsid sleep ${detached} & sleep ${grouped}`],
    { env, cwd, stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const controller = new AbortController();
  const group = new LaunchedGroup(pidFile, controller.signal);
  try {
    await until(
      () => sleeping(detached).length && sleeping(grouped).length,
      20_000,
      `both commands to start (${stderr.trim()})`,
    );
    controller.abort();
    group.end();
    await until(
      () => !sleeping(detached).length && !sleeping(grouped).length,
      5_000,
      "every command to end",
    );
  } finally {
    group.end();
    for (const pid of [...sleeping(detached), ...sleeping(grouped)])
      process.kill(pid, "SIGKILL");
  }
}

test("an aborted Codex run ends every command it started", async () => {
  // Codex itself, as workers and planning calls launch it, running a
  // command in its sandbox.
  const root = tempDir("factory-codex-abort-");
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    CODEX_HOME: join(root, "codex-home"),
  };
  mkdirSync(env.CODEX_HOME);
  const codex = codexLauncher(root, env);
  await abortLeavesNothing(
    codex.launcher,
    codex.pidFile,
    ["sandbox", "--"],
    env,
    root,
  );
  // The namespace alone, with no Codex sandbox around the commands.
  const shell = join(root, "shell");
  namespacedLauncher(shell, "/usr/bin/env", join(root, "shell.pid"));
  await abortLeavesNothing(
    shell,
    join(root, "shell.pid"),
    [],
    process.env,
    root,
  );
});

test("a host that refuses Codex's namespace holds the call, with the launcher's standard error", () => {
  // A user namespace with no mapping for its user can't make another, so
  // the launcher's probe fails there and it exits 125 before codex runs.
  // The prompt is larger than a pipe holds: the launcher must still read
  // it, or the SDK's write fails with an EPIPE nothing handles.
  const run = spawnSync(
    "unshare",
    [
      "--user",
      process.execPath,
      "--input-type=module",
      "-e",
      `const { CodexPlanner } = await import(process.argv[1]);
      try {
        await new CodexPlanner().answer({ role: "planner", phase: "plan", prompt: "Plan. ".repeat(100_000), schema: { type: "object" }, signal: AbortSignal.timeout(60_000), log() {} });
        console.log(JSON.stringify({ answered: true }));
      } catch (error) {
        console.log(JSON.stringify({ outcome: error.outcome, message: error.message }));
      }`,
      new URL("../dist/providers/codex.js", import.meta.url).href,
    ],
    { encoding: "utf8", timeout: 60_000 },
  );
  const result = JSON.parse(run.stdout || "{}");
  assert.equal(result.outcome, "hold", `${run.stdout}${run.stderr}`);
  assert.match(result.message, /own process namespace/);
  assert.match(result.message, /unshare failed/);
});
