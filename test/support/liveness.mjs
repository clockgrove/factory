import { fork } from "node:child_process";
import { once } from "node:events";

// Starvation checks (a microtask spin that never yields to timers) cannot run
// in the test process: the spin would also starve node:test's own timeout. The
// script runs in a child that beats from a timer, and the parent kills it only
// when the beats stop. Slow progress on a loaded machine keeps beating; a
// starved event loop goes silent. No total-duration budget is involved.

/**
 * Child side: beat from a timer while this process's event loop turns. Call
 * the returned stop once the script is done, so a process that then fails to
 * exit (a leaked handle) also goes silent and is reported.
 */
export function startHeartbeat(intervalMs = 100) {
  const beat = setInterval(() => process.send?.("beat"), intervalMs);
  beat.unref();
  return () => clearInterval(beat);
}

/** Parent side: run `script` to exit; SIGKILL it once it stops beating. */
export async function runWithHeartbeat(
  script,
  args,
  { stallMs = 30_000 } = {},
) {
  const child = fork(script, args, {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (part) => {
    stdout += part;
  });
  child.stderr.setEncoding("utf8").on("data", (part) => {
    stderr += part;
  });
  let stalled = false;
  let watchdog;
  const arm = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      stalled = true;
      child.kill("SIGKILL");
    }, stallMs);
  };
  child.on("message", arm);
  arm();
  let code;
  let signal;
  try {
    // "close" waits for the output streams as well as the exit.
    [code, signal] = await once(child, "close");
  } finally {
    clearTimeout(watchdog);
  }
  if (stalled)
    throw new Error(
      `${script} stopped beating for ${stallMs}ms: its event loop starved, or it finished without exiting\n${stdout}\n${stderr}`,
    );
  if (code !== 0)
    throw new Error(`${script} exited ${code ?? signal}\n${stderr}`);
  return { stdout, stderr };
}
