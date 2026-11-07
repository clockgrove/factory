// Child processes: run to completion with optional stdin, a wall clock, and captured
// stdout/stderr. Used for gh, git and the harness CLIs. No dependencies.
import { spawn } from "node:child_process";
import { accessSync, appendFileSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * Run a command. Resolves {code, signal, stdout, stderr, timedOut}; rejects only when
 * the process cannot start. `tee` streams stdout lines to a file as they arrive
 * (the harness event log), `echo` mirrors stderr to ours.
 */
export function exec(cmd, args, { cwd, env, input, timeoutMs, tee, echo = false, encoding = "utf8", maxBytes = 512 * 1024 * 1024, onLine = null, idleMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
    const out = [];
    const err = [];
    let outBytes = 0;
    let timedOut = false;
    let idle = false;
    let timer = null;
    let idleTimer = null;
    const kill = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 15_000).unref();
    };
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, timeoutMs);
    }
    // A child that prints nothing for idleMs is hung, not thinking: it is killed and reported as idle.
    const armIdle = () => {
      if (!idleMs) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idle = true;
        kill();
      }, idleMs);
    };
    armIdle();
    let partial = "";
    child.stdout.on("data", (chunk) => {
      outBytes += chunk.length;
      if (outBytes <= maxBytes) out.push(chunk);
      if (tee) appendFileSync(tee, chunk);
      armIdle();
      if (onLine) {
        partial += chunk.toString("utf8");
        const parts = partial.split("\n");
        partial = parts.pop();
        for (const line of parts) if (line) onLine(line);
      }
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
      if (idleTimer) clearTimeout(idleTimer);
      if (onLine && partial) onLine(partial);
      const decode = (chunks) => (encoding === "buffer" ? Buffer.concat(chunks) : Buffer.concat(chunks).toString("utf8"));
      resolve({ code, signal, stdout: decode(out), stderr: decode(err), timedOut, idle });
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
/**
 * The executable `cmd` resolves to on PATH, or null. A plain scan of PATH, never a shell: the name can come from a
 * repository's workflow file or the developer's env (FACTORY_HARNESS), and must not be able to run anything.
 */
export function whichSync(cmd, env = process.env) {
  const name = String(cmd);
  if (!name || name.includes("/") || name.includes("\\")) return null;
  for (const dir of String(env.PATH || "").split(delimiter)) {
    if (!dir) continue;
    const file = join(dir, name);
    try {
      if (statSync(file).isFile()) {
        accessSync(file, constants.X_OK);
        return file;
      }
    } catch {
      // not here
    }
  }
  return null;
}

/** The command's path when it is on PATH, else null (doctor prints the path). */
export async function onPath(cmd) {
  return whichSync(cmd);
}
