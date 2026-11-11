// Child processes: run to completion with optional stdin, a wall clock, and captured
// stdout/stderr. Used for gh, git and the harness CLIs. No dependencies.
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, closeSync, constants, fstatSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { appendOwn } from "./fsafe.mjs";
import { delimiter, join } from "node:path";

// ------------------------------------------------------------------ the agent uid

/**
 * On Actions the harness, the install and the validation run as a separate uid, `factory-agent` (agent.mjs sets it up):
 * it cannot read Factory's /proc/<pid>/environ, its 700 home or the runner's. Set here, every process Factory starts with
 * its working directory in the agent's home runs as the agent, so Factory runs no command of its own in the agent's
 * checkout. Null in local mode and before setup.
 */
let AGENT = null;
export const setAgent = (a) => {
  AGENT = a;
};
export const agentUser = () => AGENT;
const inAgentHome = (cwd) => !!AGENT && !!cwd && (cwd === AGENT.home || String(cwd).startsWith(`${AGENT.home}/`));

/**
 * The variables an agent process may see: the toolchain's and the locale's, the repository's own (what `setup` wrote,
 * agent.mjs allowAgentEnv), Factory's hand-off names, and `extra` (the harness's model credential). Never a token, a
 * runner credential or anything else from the job's env.
 */
const AGENT_ENV = /^(LANG|LANGUAGE|LC_[A-Z]+|TZ|TERM|COLORTERM|CI|NODE_OPTIONS|NODE_EXTRA_CA_CERTS|npm_config_[a-z_]+|COREPACK_[A-Z_]+|JAVA_HOME[A-Z0-9_]*|GOROOT[A-Z0-9_]*|GOPATH|CARGO_HOME|RUSTUP_HOME|PYTHONPATH|PIPX_[A-Z_]+|CHROME[A-Z_]*|CHROMEWEBDRIVER|EDGEWEBDRIVER|GECKOWEBDRIVER|SELENIUM_JAR_PATH|ANDROID_[A-Z_]+|DOTNET_[A-Z_]+|GITHUB_(ACTIONS|REPOSITORY|REPOSITORY_OWNER|REF|REF_NAME|SHA|SERVER_URL|API_URL|GRAPHQL_URL|EVENT_NAME|RUN_ID|RUN_NUMBER|JOB|WORKFLOW)|RUNNER_(OS|ARCH|NAME|ENVIRONMENT)|ImageOS|ImageVersion|FACTORY_(IN|OUT|ISSUE|BRANCH|COMPACTION_WINDOW|DB_WRAP|LOCAL_DB))$/;

/**
 * On Actions, Factory's own commands run by absolute path with a fixed PATH: the runner image leaves directories that
 * come first on PATH (the tool cache, pipx's bin) writable by every uid, so a bare name could be the agent's.
 */
export const SAFE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
export const bin = (name) => (AGENT ? `/usr/bin/${name}` : name);

/** Every unit the agent runs in is named with this prefix, so a reap can stop them all. */
const UNIT_PREFIX = "factory-agent-";

/**
 * `cmd args` as the agent, in a transient systemd unit of its own:
 * `sudo -n systemd-run --uid=factory-agent --pipe --wait --collect -p ... -E NAME ... -- env cmd args`.
 * The unit sees the file system read-only except the agent's home (ProtectSystem=strict, ProtectHome=tmpfs with only
 * that home bound in), /run read-only, a private /tmp, /dev/shm, /run/lock and IPC namespace, no privilege gain, and when its main process ends systemd kills everything left
 * in its cgroup. The variables' values travel in the environment (`-E NAME` takes them from there), never on the
 * command line, where every uid could read them. Returns [cmd, args, env] for spawn.
 */
export function asAgent(cmd, args, env = {}, extra = [], cwd = null, { nested = false } = {}) {
  const keys = Object.keys(env).filter((k) => env[k] !== undefined && env[k] !== null && (AGENT_ENV.test(k) || AGENT.allow.has(k) || extra.includes(k)));
  const out = Object.fromEntries(keys.map((k) => [k, String(env[k])]));
  if (AGENT.launcher === "namespace") return [...asAgentInNamespace(cmd, args, env, keys, cwd), out];
  const props = [
    "ProtectSystem=strict",
    "ProtectHome=tmpfs",
    `BindPaths=${AGENT.home}`,
    `ReadWritePaths=${AGENT.home}`,
    "PrivateTmp=yes",
    "ReadOnlyPaths=/run",
    "TemporaryFileSystem=/dev/shm:mode=1777 /run/lock:mode=1777",
    "PrivateIPC=yes",
    "NoNewPrivileges=yes",
    "RestrictSUIDSGID=yes",
    // Not for a harness that runs its commands in a sandbox of its own (`nested`: Claude Code's bubblewrap): its
    // read-only mounts over parts of /proc keep a user namespace from mounting a fresh /proc ("Can't mount proc on
    // /newroot/proc"). The agent is unprivileged with no new privileges, so /proc/sys and /sys stay root's to write.
    ...(nested ? [] : ["ProtectKernelTunables=yes"]),
    "ProtectKernelModules=yes",
    "ProtectControlGroups=yes",
    "KillMode=control-group",
    "UMask=0077",
  ];
  const unit = `${UNIT_PREFIX}${randomBytes(6).toString("hex")}`;
  const runArgs = [
    "-n",
    `--preserve-env=${keys.join(",")}`,
    "/usr/bin/systemd-run",
    "--quiet",
    "--wait",
    "--collect",
    "--pipe",
    `--unit=${unit}`,
    `--uid=${AGENT.user}`,
    `--gid=${AGENT.user}`,
    `--working-directory=${cwd || AGENT.home}`,
    ...props.map((p) => `--property=${p}`),
    ...keys.map((k) => `--setenv=${k}`),
    `--setenv=HOME=${AGENT.home}`,
    `--setenv=TMPDIR=${AGENT.tmp}`,
    `--setenv=PATH=${env.PATH || process.env.PATH}`,
    "--",
    "/usr/bin/env",
    cmd,
    ...args,
  ];
  return ["/usr/bin/sudo", runArgs, out];
}

/** The cgroup every namespace-launched agent process joins, so a reap can kill all of them at once. */
export const AGENT_CGROUP = "/sys/fs/cgroup/factory-agent";

/**
 * The namespace launcher's wrapper, run as root in a fresh mount, PID and IPC namespace (`unshare`), for a machine with
 * no systemd (a cloud sandbox VM). It gives the agent what the systemd unit gives it on Actions: every mount read-only
 * and nosuid (and nodev, but for /dev) except its home (nosuid, nodev) and private /tmp, /var/tmp, /dev/shm and
 * /run/lock; its own process tree (when the command ends, the kernel kills every process left in the namespace);
 * membership of AGENT_CGROUP (reapAgent kills it whole); no new privileges, no capabilities and umask 077.
 * As root it touches only what root owns: the cgroup file and mount points. Its home is refused when it is a symlink;
 * the working directory and the temp directory are the agent's own paths (it can swap either for a symlink), so they
 * are entered and created after setpriv, as the agent, and a temp directory that is a symlink is refused.
 * Arguments: home, tmp, cwd, user, PATH, then the command. Values of the environment never appear here.
 */
export const NAMESPACE_WRAP = [
  "set -eu",
  'home=$1; tmp=$2; cwd=$3; user=$4; path=$5; shift 5',
  '[ -d "$home" ] && [ ! -L "$home" ] || { echo "factory: the agent home is not a plain directory" >&2; exit 126; }',
  `echo $$ > ${AGENT_CGROUP}/cgroup.procs`,
  "mount --make-rprivate /",
  'private="/tmp /var/tmp /dev/shm /run/lock"',
  'for d in $private; do [ -d "$d" ] && [ ! -L "$d" ] && mount -t tmpfs -o mode=1777,nosuid,nodev tmpfs "$d"; done',
  'mount --bind "$home" "$home"',
  'mount -o remount,bind,nosuid,nodev "$home"',
  // Every other mount, read-only: the root and whatever the vendor mounted beside it (/dev, /sys, the cgroup tree, its
  // own share). A target findmnt prints escaped (a space in it) fails the remount, and the wrapper with it: fail closed.
  'findmnt -rno TARGET | while IFS= read -r m; do',
  '  case "$m" in /proc|/proc/*|/dev/pts|"$home"|/tmp|/var/tmp|/dev/shm|/run/lock) continue ;; esac',
  '  if [ "$m" = /dev ]; then mount -o remount,bind,ro,nosuid "$m"; else mount -o remount,bind,ro,nosuid,nodev "$m"; fi',
  "done",
  'export HOME="$home" TMPDIR="$tmp" PATH="$path" USER="$user" LOGNAME="$user"',
  'exec /usr/bin/setpriv --reuid="$user" --regid="$user" --clear-groups --no-new-privs --inh-caps=-all --bounding-set=-all /bin/sh -c \'umask 077; [ -L "$1" ] && { echo "factory: the agent temp directory is a symlink" >&2; exit 126; }; mkdir -p -- "$1" && cd -- "$2" && shift 2 && exec /usr/bin/env "$@"\' factory-agent-sh "$tmp" "$cwd" "$@"',
].join("\n");

/** `cmd args` as the agent through NAMESPACE_WRAP: `sudo -n --preserve-env=NAMES unshare ... bash -c WRAP ...`. */
function asAgentInNamespace(cmd, args, env, keys, cwd) {
  return [
    "/usr/bin/sudo",
    ["-n", `--preserve-env=${keys.join(",")}`, "/usr/bin/unshare", "--mount", "--pid", "--ipc", "--fork", "--kill-child", "--mount-proc", "/bin/bash", "-c", NAMESPACE_WRAP, "factory-agent-wrap", AGENT.home, AGENT.tmp, cwd || AGENT.home, AGENT.user, env.PATH || process.env.PATH, cmd, ...args],
  ];
}

/**
 * The environment `sudo` itself is started with: only the names it preserves for the command, and a fixed PATH. sudo's
 * own processes keep the environment they were started with, so they never get Factory's.
 */
export function sudoEnv(args, env = process.env) {
  const keep = String(args.find((a) => String(a).startsWith("--preserve-env=")) || "").slice("--preserve-env=".length).split(",").filter(Boolean);
  return { PATH: SAFE_PATH, ...Object.fromEntries(keep.filter((k) => env[k] !== undefined).map((k) => [k, env[k]])) };
}
const isSudo = (cmd) => cmd === "sudo" || cmd === "/usr/bin/sudo";

/** Factory's own tools: on Actions they also run with the fixed PATH, so git finds its helpers (git-lfs) in /usr/bin. */
const OWN_TOOLS = new Set(["git", "tar", "find", "gh", "id", "chmod", "mkdir", "mv", "rm", "pkill", "systemctl", "systemd-run", "unshare"]);

/**
 * A command Factory runs as the runner on Actions, by bare name: found only in the system directories (never the tool
 * cache or pipx's bin, which the image leaves writable), and Factory's own tools also get the fixed PATH. A repository's
 * own command (setup) keeps its PATH: only the program it starts is pinned.
 */
export function runnerCommand(cmd, env) {
  for (const dir of SAFE_PATH.split(":")) {
    const file = join(dir, cmd);
    try {
      if (statSync(file).isFile()) return [file, OWN_TOOLS.has(cmd) ? { ...env, PATH: SAFE_PATH } : env];
    } catch {
      // not here
    }
  }
  throw new Error(`${cmd} is not in ${SAFE_PATH}`);
}

/**
 * After an agent run: every unit the agent runs in is stopped (its whole cgroup killed) and any process of the agent's
 * left is killed, before Factory reads anything it left.
 */
export async function reapAgent() {
  if (!AGENT) return;
  if (AGENT.launcher === "namespace") return reapNamespace(AGENT.user);
  await exec("/usr/bin/sudo", ["-n", "/usr/bin/systemctl", "kill", "--signal=SIGKILL", `${UNIT_PREFIX}*`], { env: { PATH: SAFE_PATH } });
  await exec("/usr/bin/sudo", ["-n", "/usr/bin/systemctl", "stop", `${UNIT_PREFIX}*`], { env: { PATH: SAFE_PATH } });
  await exec("/usr/bin/sudo", ["-n", "/usr/bin/pkill", "-KILL", "-u", AGENT.user], { env: { PATH: SAFE_PATH } });
}

/**
 * Every process of a namespace-launched agent killed: its cgroup whole, then anything of its uid left. For a caller with
 * no agent registered (the stage in a cloud sandbox, whose worker child registered it and may have died mid-command).
 */
export async function reapNamespace(user) {
  await exec("/usr/bin/sudo", ["-n", "/bin/sh", "-c", `[ -e ${AGENT_CGROUP}/cgroup.kill ] && echo 1 > ${AGENT_CGROUP}/cgroup.kill || true`], { env: { PATH: SAFE_PATH } });
  await exec("/usr/bin/sudo", ["-n", "/usr/bin/pkill", "-KILL", "-u", user], { env: { PATH: SAFE_PATH } });
}

/** How often a `fileStdio` run's output files are read for what was added. */
export const FILE_STDIO_POLL_MS = 100;

/**
 * The most a `fileStdio` read takes from each file in one go: a child that writes faster than Factory reads never holds
 * the event loop, so the time cap, the idle kill and a caller's stop still fire.
 */
export const FILE_STDIO_READ_BYTES = 8 * 1024 * 1024;

/**
 * The child's stdout and stderr as regular files Factory reads as they grow (exec's `fileStdio`), never pipes. A pipe or
 * socket's O_NONBLOCK flag belongs to the open file, which every process holding it shares: a Node process in the chain
 * that touches its own process.stdout (srt, the outer sandbox's launcher, does) makes the harness's stdout non-blocking
 * too, and a harness that writes it synchronously (Codex's Rust println!) then dies on EAGAIN the moment the buffer is
 * full (#2649: exit 101, "failed printing to stdout"). A write to a regular file never returns EAGAIN.
 * Each descriptor is closed exactly once: a number closed is free for whatever Factory opens next (a socket, a file),
 * and a second close would close that instead. `limit`: no file is read past it, and `pull` says when one has grown past
 * it (the caller kills the run: a file, unlike a pipe, would keep growing on disk).
 */
function fileStdio(limit) {
  const dir = mkdtempSync(join(tmpdir(), "factory-stdio-"));
  const open = (name) => {
    const file = join(dir, name);
    const w = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
    return { w, r: openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW), pos: 0 };
  };
  const files = { out: open("stdout"), err: open("stderr") };
  const buf = Buffer.allocUnsafe(1024 * 1024);
  let dropped = false;
  const closeOnce = (f, end) => {
    if (f[end] === null) return;
    const fd = f[end];
    f[end] = null;
    closeSync(fd);
  };
  return {
    stdio: [files.out.w, files.err.w],
    /** The child holds its own copies once it is spawned: Factory's write ends are closed. */
    spawned: () => {
      for (const f of Object.values(files)) closeOnce(f, "w");
    },
    get dropped() {
      return dropped;
    },
    /**
     * Hand each chunk read to `onOut` / `onErr`, in order, at most `budget` bytes of each file. Returns {more: a file has
     * more to read now, over: a file has grown past `limit`}. A file that shrank (truncated by whoever holds it) is read
     * again from its start. Throws on a read error, or when dropped.
     */
    pull: (onOut, onErr, budget = FILE_STDIO_READ_BYTES) => {
      if (dropped) throw new Error("fileStdio: dropped");
      let more = false;
      let over = false;
      for (const [f, on] of [[files.out, onOut], [files.err, onErr]]) {
        const size = fstatSync(f.r).size;
        if (size < f.pos) f.pos = 0;
        if (size > limit) over = true;
        const end = Math.min(size, limit);
        let took = 0;
        while (f.pos < end && took < budget) {
          const n = readSync(f.r, buf, 0, Math.min(buf.length, end - f.pos, budget - took), f.pos);
          if (!n) break;
          f.pos += n;
          took += n;
          on(Buffer.from(buf.subarray(0, n)));
        }
        if (f.pos < end) more = true;
      }
      return { more, over };
    },
    /** Every descriptor still open is closed and the files go; a second call does nothing. */
    drop: () => {
      if (dropped) return;
      dropped = true;
      for (const f of Object.values(files)) {
        for (const end of ["w", "r"]) {
          try {
            closeOnce(f, end);
          } catch {
            // nulled before the close: never closed twice
          }
        }
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Run a command. Resolves {code, signal, stdout, stderr, timedOut, idle, stopped, truncated, readError}; rejects only
 * when the process cannot start. `truncated`: stdout ran past `maxBytes` and only its first `maxBytes` are kept. `tee`
 * streams stdout lines to a file as they arrive
 * (the harness event log), `echo` mirrors stderr to ours. `fileStdio`: the child writes its stdout and stderr to
 * regular files Factory reads every FILE_STDIO_POLL_MS (fileStdio above says why: the harness runs). There an output
 * file past `maxBytes` kills the run (`truncated`), and a read that fails mid-run kills it too (`readError`, its code),
 * rather than leaving a live run that looks silent.
 */
export function exec(cmd, args, { cwd, env, input, timeoutMs, tee, echo = false, encoding = "utf8", maxBytes = 512 * 1024 * 1024, onLine = null, idleMs = 0, agentExtra = [], agentNested = false, group = false, signal = null, fileStdio: toFiles = false } = {}) {
  // In the agent's home, as the agent (with its own env), whoever asked; the directory is entered as the agent.
  if (inAgentHome(cwd)) {
    if (!isSudo(cmd)) [cmd, args, env] = asAgent(cmd, args, env ?? process.env, agentExtra, cwd, { nested: agentNested });
    else {
      // Already the agent's (backend.mjs sandbox.command): the unit (or the namespace wrapper) starts in this directory.
      args = args.map((a) => (String(a).startsWith("--working-directory=") ? `--working-directory=${cwd}` : a));
      const w = args.indexOf("factory-agent-wrap");
      if (w >= 0) args[w + 3] = cwd;
    }
    cwd = "/";
  }
  if (isSudo(cmd)) env = sudoEnv(args, env ?? process.env);
  else if (AGENT && !String(cmd).includes("/")) [cmd, env] = runnerCommand(cmd, env ?? process.env);
  return new Promise((resolve, reject) => {
    // `group`: the child leads a process group, and the whole group is killed when it exits (local mode's harness:
    // nothing it or its sandboxed commands started outlives the run, before Factory reads what it left).
    // Every process the run starts inherits a tag, so one that left the group (setsid, a double fork) is still found.
    const tag = group ? randomBytes(12).toString("hex") : null;
    const files = toFiles ? fileStdio(maxBytes) : null;
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: tag ? { ...(env ?? process.env), FACTORY_RUN_TAG: tag } : env ?? process.env, stdio: ["pipe", ...(files ? files.stdio : ["pipe", "pipe"])], detached: group });
    } catch (e) {
      files?.drop();
      throw e;
    }
    files?.spawned();
    const out = [];
    const err = [];
    let outBytes = 0;
    let timedOut = false;
    let idle = false;
    let timer = null;
    let idleTimer = null;
    const kill = () => {
      const sig = (s) => {
        try {
          if (group) process.kill(-child.pid, s);
          else child.kill(s);
        } catch {
          // gone
        }
      };
      sig("SIGTERM");
      setTimeout(() => sig("SIGKILL"), 15_000).unref();
    };
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, timeoutMs);
    }
    // `signal` (an AbortSignal): the caller stops the child, as the time cap does, and the result says `stopped`.
    let stopped = false;
    const stop = () => {
      stopped = true;
      kill();
    };
    if (signal?.aborted) stop();
    else signal?.addEventListener("abort", stop, { once: true });
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
    const onOut = (chunk) => {
      outBytes += chunk.length;
      if (outBytes <= maxBytes) out.push(chunk);
      if (tee) appendOwn(tee, chunk);
      armIdle();
      if (onLine) {
        partial += chunk.toString("utf8");
        const parts = partial.split("\n");
        partial = parts.pop();
        for (const line of parts) if (line) onLine(line);
      }
    };
    const onErr = (chunk) => {
      err.push(chunk);
      if (echo) process.stderr.write(chunk);
    };
    let poll = null;
    let overflow = false;
    let readError = null;
    let closed = false;
    // One bounded read of what the files gained ({more, over}); null once they are dropped (the child failed to start)
    // or a read failed. A failed read mid-run stops the run: its output can no longer be seen.
    const pullFiles = () => {
      if (readError) return null;
      try {
        const got = files.pull(onOut, onErr);
        if (got.over && !overflow) {
          overflow = true;
          if (!closed) kill();
        }
        return got;
      } catch (e) {
        if (files.dropped) return null;
        readError = e.code || "EUNKNOWN";
        if (poll) clearInterval(poll);
        if (!closed) kill();
        return null;
      }
    };
    if (files) poll = setInterval(pullFiles, FILE_STDIO_POLL_MS);
    else {
      child.stdout.on("data", onOut);
      child.stderr.on("data", onErr);
    }
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      if (poll) clearInterval(poll);
      files?.drop();
      signal?.removeEventListener("abort", stop);
      reject(e);
    });
    // When the run itself exits (not when its pipes close: a leftover holding them would keep them open), its group
    // and every tagged process go.
    if (group) {
      child.on("exit", () => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // the group is gone already
        }
        const left = killTagged(tag);
        if (left) process.stdout.write(`[factory] ${left} process(es) the run left outside its group were killed\n`);
      });
    }
    child.on("close", async (code, sig) => {
      closed = true;
      if (timer) clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);
      signal?.removeEventListener("abort", stop);
      if (files) {
        clearInterval(poll);
        // What the run wrote after the last read (up to maxBytes), in bounded reads that yield between them; then the
        // files go.
        while (pullFiles()?.more) await new Promise((r) => setImmediate(r));
        files.drop();
        if (idleTimer) clearTimeout(idleTimer);
      }
      if (readError) err.push(Buffer.from(`\n[factory] reading the run's output failed (${readError}); the run was stopped\n`));
      if (onLine && partial) onLine(partial);
      const decode = (chunks) => (encoding === "buffer" ? Buffer.concat(chunks) : Buffer.concat(chunks).toString("utf8"));
      resolve({ code, signal: sig, stdout: decode(out), stderr: decode(err), timedOut, idle, stopped, truncated: outBytes > maxBytes || overflow, readError });
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

/**
 * Kill every process of this user whose environment carries FACTORY_RUN_TAG=`tag` (exec's `group` runs): what a run
 * left behind outside its process group, a setsid or double-forked one included. Linux reads /proc; elsewhere `ps eww`.
 * Returns how many were killed.
 */
export function killTagged(tag) {
  if (!tag) return 0;
  const mark = `FACTORY_RUN_TAG=${tag}`;
  const pids = [];
  if (process.platform === "linux") {
    for (const p of readdirSync("/proc")) {
      if (!/^\d+$/.test(p) || Number(p) === process.pid) continue;
      try {
        if (readFileSync(`/proc/${p}/environ`, "latin1").split("\0").includes(mark)) pids.push(Number(p));
      } catch {
        // gone, or not ours
      }
    }
  } else {
    try {
      for (const line of execFileSync("ps", ["eww", "-A", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n")) if (line.includes(mark)) pids.push(Number(line.trim().split(/\s+/)[0]));
    } catch {
      // no ps
    }
  }
  let killed = 0;
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
      killed += 1;
    } catch {
      // gone
    }
  }
  return killed;
}
