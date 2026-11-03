// Child processes: run to completion with optional stdin, a wall clock, and captured
// stdout/stderr. Used for gh, git and the harness CLIs. No dependencies.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

/**
 * Run a command. Resolves {code, signal, stdout, stderr, timedOut}; rejects only when
 * the process cannot start. `tee` streams stdout lines to a file as they arrive
 * (the harness event log), `echo` mirrors stderr to ours.
 */
export function exec(cmd, args, { cwd, env, input, timeoutMs, tee, echo = false, encoding = "utf8", maxBytes = 512 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
    const out = [];
    const err = [];
    let outBytes = 0;
    let timedOut = false;
    let timer = null;
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 15_000).unref();
      }, timeoutMs);
    }
    child.stdout.on("data", (chunk) => {
      outBytes += chunk.length;
      if (outBytes <= maxBytes) out.push(chunk);
      if (tee) appendFileSync(tee, chunk);
    });
    child.stderr.on("data", (chunk) => {
      err.push(chunk);
      if (echo) process.stderr.write(chunk);
    });
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      const decode = (chunks) => (encoding === "buffer" ? Buffer.concat(chunks) : Buffer.concat(chunks).toString("utf8"));
      resolve({ code, signal, stdout: decode(out), stderr: decode(err), timedOut });
    });
    // A child that exits before draining a large prompt raises EPIPE on stdin; that is its exit code's story, not ours.
    child.stdin.on("error", () => {});
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** exec that throws on a non-zero exit with stderr in the message. */
export async function must(cmd, args, opts = {}) {
  const r = await exec(cmd, args, opts);
  if (r.code !== 0) {
    const e = new Error(`${cmd} ${args.join(" ")} exited ${r.code ?? r.signal}: ${String(r.stderr).slice(0, 1000)}`);
    e.result = r;
    throw e;
  }
  return r;
}

/** `git` in a directory, throwing on failure. */
export const git = (cwd, args, opts = {}) => must("git", args, { cwd, ...opts });

/** Whether a command is on PATH. */
export async function onPath(cmd) {
  const r = await exec("sh", ["-c", 'command -v "$1"', "_", String(cmd)]);
  return r.code === 0 ? r.stdout.trim() : null;
}
