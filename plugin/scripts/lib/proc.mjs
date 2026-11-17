// Child processes: run to completion with optional stdin, a wall clock, and captured
// stdout/stderr. Used for gh, git and the harness CLIs. No dependencies.
import { execFile, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, closeSync, constants, fstatSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { appendOwn } from "./fsafe.mjs";
import { readFile, readdir, readlink, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { StringDecoder } from "node:string_decoder";

// ------------------------------------------------------------------ the agent uid

/**
 * On Actions the harness, the install and the validation run as a separate uid, `pendulum-agent` (agent.mjs sets it up):
 * it cannot read Pendulum's /proc/<pid>/environ, its 700 home or the runner's. Set here, every process Pendulum starts with
 * its working directory in the agent's home runs as the agent, so Pendulum runs no command of its own in the agent's
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
 * agent.mjs allowAgentEnv), Pendulum's hand-off names, and `extra` (the harness's model credential). Never a token, a
 * runner credential or anything else from the job's env.
 */
const AGENT_ENV = /^(LANG|LANGUAGE|LC_[A-Z]+|TZ|TERM|COLORTERM|CI|NODE_OPTIONS|NODE_EXTRA_CA_CERTS|npm_config_[a-z_]+|COREPACK_[A-Z_]+|JAVA_HOME[A-Z0-9_]*|GOROOT[A-Z0-9_]*|GOPATH|CARGO_HOME|RUSTUP_HOME|PYTHONPATH|PIPX_[A-Z_]+|CHROME[A-Z_]*|CHROMEWEBDRIVER|EDGEWEBDRIVER|GECKOWEBDRIVER|SELENIUM_JAR_PATH|ANDROID_[A-Z_]+|DOTNET_[A-Z_]+|GITHUB_(ACTIONS|REPOSITORY|REPOSITORY_OWNER|REF|REF_NAME|SHA|SERVER_URL|API_URL|GRAPHQL_URL|EVENT_NAME|RUN_ID|RUN_NUMBER|JOB|WORKFLOW)|RUNNER_(OS|ARCH|NAME|ENVIRONMENT)|ImageOS|ImageVersion|PENDULUM_(IN|OUT|ISSUE|BRANCH|COMPACTION_WINDOW|DB_WRAP|LOCAL_DB))$/;

/**
 * On Actions, Pendulum's own commands run by absolute path with a fixed PATH: the runner image leaves directories that
 * come first on PATH (the tool cache, pipx's bin) writable by every uid, so a bare name could be the agent's.
 */
export const SAFE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
export const bin = (name) => (AGENT ? `/usr/bin/${name}` : name);

/** Every unit the agent runs in is named with this prefix, so a reap can stop them all. */
const UNIT_PREFIX = "pendulum-agent-";

/**
 * `cmd args` as the agent, in a transient systemd unit of its own:
 * `sudo -n systemd-run --uid=pendulum-agent --pipe --wait --collect -p ... -E NAME ... -- env cmd args`.
 * The unit sees the file system read-only except the agent's home (ProtectSystem=strict, ProtectHome=tmpfs with only
 * that home bound in), /run read-only, a private /tmp, /dev/shm, /run/lock and IPC namespace, no privilege gain, and when its main process ends systemd kills everything left
 * in its cgroup. The variables' values travel in the environment (`-E NAME` takes them from there), never on the
 * command line, where every uid could read them. Returns [cmd, args, env] for spawn.
 */
export function asAgent(cmd, args, env = {}, extra = [], cwd = null) {
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
    "ProtectKernelTunables=yes",
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
export const AGENT_CGROUP = "/sys/fs/cgroup/pendulum-agent";

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
  '[ -d "$home" ] && [ ! -L "$home" ] || { echo "pendulum: the agent home is not a plain directory" >&2; exit 126; }',
  `echo $$ > ${AGENT_CGROUP}/cgroup.procs`,
  "mount --make-rprivate /",
  'private="/tmp /var/tmp /dev/shm /run/lock"',
  'for d in $private; do [ -d "$d" ] && [ ! -L "$d" ] && mount -t tmpfs -o mode=1777,nosuid,nodev tmpfs "$d"; done',
  // The iptables lock, where it is a plain file: a private one over it, from the private /run/lock only this namespace sees,
  // which Copilot's sandbox takes as the agent where ip6tables is the legacy backend (launch.mjs START). Its rules go
  // into network namespaces of its own, so nothing on the host needs that lock shared; the host's stays root's.
  'if [ -f /run/xtables.lock ] && [ ! -L /run/xtables.lock ] && [ -d /run/lock ] && [ ! -L /run/lock ]; then ( umask 0; : > /run/lock/pendulum-xtables.lock ) && mount --bind /run/lock/pendulum-xtables.lock /run/xtables.lock; fi',
  'mount --bind "$home" "$home"',
  'mount -o remount,bind,nosuid,nodev "$home"',
  // Every other mount, read-only: the root and whatever the vendor mounted beside it (/dev, /sys, the cgroup tree, its
  // own share). A target findmnt prints escaped (a space in it) fails the remount, and the wrapper with it: fail closed.
  'findmnt -rno TARGET | while IFS= read -r m; do',
  '  case "$m" in /proc|/proc/*|/dev/pts|"$home"|/tmp|/var/tmp|/dev/shm|/run/lock|/run/xtables.lock) continue ;; esac',
  '  if [ "$m" = /dev ]; then mount -o remount,bind,ro,nosuid "$m"; else mount -o remount,bind,ro,nosuid,nodev "$m"; fi',
  "done",
  'export HOME="$home" TMPDIR="$tmp" PATH="$path" USER="$user" LOGNAME="$user"',
  'exec /usr/bin/setpriv --reuid="$user" --regid="$user" --clear-groups --no-new-privs --inh-caps=-all --bounding-set=-all /bin/sh -c \'umask 077; [ -L "$1" ] && { echo "pendulum: the agent temp directory is a symlink" >&2; exit 126; }; mkdir -p -- "$1" && cd -- "$2" && shift 2 && exec /usr/bin/env "$@"\' pendulum-agent-sh "$tmp" "$cwd" "$@"',
].join("\n");

/** `cmd args` as the agent through NAMESPACE_WRAP: `sudo -n --preserve-env=NAMES unshare ... bash -c WRAP ...`. */
function asAgentInNamespace(cmd, args, env, keys, cwd) {
  return [
    "/usr/bin/sudo",
    ["-n", `--preserve-env=${keys.join(",")}`, "/usr/bin/unshare", "--mount", "--pid", "--ipc", "--fork", "--kill-child", "--mount-proc", "/bin/bash", "-c", NAMESPACE_WRAP, "pendulum-agent-wrap", AGENT.home, AGENT.tmp, cwd || AGENT.home, AGENT.user, env.PATH || process.env.PATH, cmd, ...args],
  ];
}

/**
 * The environment `sudo` itself is started with: only the names it preserves for the command, and a fixed PATH. sudo's
 * own processes keep the environment they were started with, so they never get Pendulum's.
 */
export function sudoEnv(args, env = process.env) {
  const keep = String(args.find((a) => String(a).startsWith("--preserve-env=")) || "").slice("--preserve-env=".length).split(",").filter(Boolean);
  return { PATH: SAFE_PATH, ...Object.fromEntries(keep.filter((k) => env[k] !== undefined).map((k) => [k, env[k]])) };
}
const isSudo = (cmd) => cmd === "sudo" || cmd === "/usr/bin/sudo";

/** Pendulum's own tools: on Actions they also run with the fixed PATH, so git finds its helpers (git-lfs) in /usr/bin. */
const OWN_TOOLS = new Set(["git", "tar", "find", "gh", "id", "chmod", "mkdir", "mv", "rm", "pkill", "systemctl", "systemd-run", "unshare"]);

/**
 * A command Pendulum runs as the runner on Actions, by bare name: found only in the system directories (never the tool
 * cache or pipx's bin, which the image leaves writable), and Pendulum's own tools also get the fixed PATH. A repository's
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
 * left is killed, before Pendulum reads anything it left.
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
 * The most a `fileStdio` read takes from each file in one go: a child that writes faster than Pendulum reads never holds
 * the event loop, so the time cap, the idle kill and a caller's stop still fire.
 */
export const FILE_STDIO_READ_BYTES = 8 * 1024 * 1024;

/**
 * The child's stdout and stderr as regular files Pendulum reads as they grow (exec's `fileStdio`), never pipes. A pipe or
 * socket's O_NONBLOCK flag belongs to the open file, which every process holding it shares: a Node process in the chain
 * that touches its own process.stdout (srt, the outer sandbox's launcher, does) makes the harness's stdout non-blocking
 * too, and a harness that writes it synchronously (Codex's Rust println!) then dies on EAGAIN the moment the buffer is
 * full (#2649: exit 101, "failed printing to stdout"). A write to a regular file never returns EAGAIN.
 * Each descriptor is closed exactly once: a number closed is free for whatever Pendulum opens next (a socket, a file),
 * and a second close would close that instead. `limit`: no file is read past it, and `pull` says when one has grown past
 * it (the caller kills the run: a file, unlike a pipe, would keep growing on disk).
 */
function fileStdio(limit) {
  const dir = mkdtempSync(join(tmpdir(), "pendulum-stdio-"));
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
    /** Pendulum's descriptor of the stdout file, open until drop: what the run's own processes hold as their stdout. */
    get streamFd() {
      return files.out.r;
    },
    /** The child holds its own copies once it is spawned: Pendulum's write ends are closed. */
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
 * Run a command. Resolves {code, signal, stdout, stderr, timedOut, idle, idleOpen, stopped, truncated, readError}; rejects
 * only when the process cannot start. `truncated`: stdout ran past `maxBytes` and only its first `maxBytes` are kept. `tee`
 * streams stdout lines to a file as they arrive
 * (the harness event log), `echo` mirrors stderr to ours. `fileStdio`: the child writes its stdout and stderr to
 * regular files Pendulum reads every FILE_STDIO_POLL_MS (fileStdio above says why: the harness runs). There an output
 * file past `maxBytes` kills the run (`truncated`), and a read that fails mid-run kills it too (`readError`, its code),
 * rather than leaving a live run that looks silent.
 * `idleMs`: the window a silent run is checked over, and `openItems` (a function) the count of command items its own
 * stream shows started and not yet ended. Silence alone kills nothing: a run that printed nothing across a whole window
 * is killed only when hangVerdict finds it hung (its open command made no progress, or with none open a harness that
 * prints its answer as it arrives, `answerStreams`, printed nothing), and reported `idle`, with `idleOpen` the items
 * open at the kill. `dropLine`: stdout lines that count as output for that check and are not kept, teed or handed to
 * `onLine` (a harness's answer deltas).
 */
export function exec(cmd, args, { cwd, env, input, timeoutMs, tee, echo = false, encoding = "utf8", maxBytes = 512 * 1024 * 1024, killPastMax = false, onLine = null, dropLine = null, idleMs = 0, openItems = null, answerStreams = false, harnessHome = null, agentExtra = [], group = false, record = null, signal = null, fileStdio: toFiles = false } = {}) {
  // In the agent's home, as the agent (with its own env), whoever asked; the directory is entered as the agent.
  if (inAgentHome(cwd)) {
    if (!isSudo(cmd)) [cmd, args, env] = asAgent(cmd, args, env ?? process.env, agentExtra, cwd);
    else {
      // Already the agent's (backend.mjs sandbox.command): the unit (or the namespace wrapper) starts in this directory.
      args = args.map((a) => (String(a).startsWith("--working-directory=") ? `--working-directory=${cwd}` : a));
      const w = args.indexOf("pendulum-agent-wrap");
      if (w >= 0) args[w + 3] = cwd;
    }
    cwd = "/";
  }
  if (isSudo(cmd)) env = sudoEnv(args, env ?? process.env);
  else if (AGENT && !String(cmd).includes("/")) [cmd, env] = runnerCommand(cmd, env ?? process.env);
  return new Promise((resolve, reject) => {
    // `group`: the child leads a process group, and the whole group is killed when it exits (local mode's harness:
    // nothing it or its sandboxed commands started outlives the run, before Pendulum reads what it left).
    // Every process the run starts inherits a tag, so one that left the group (setsid, a double fork) is still found.
    // A signal that stops this process stops the group first (stopGroups); `record` names the run in a file for as long
    // as it lives (a file in the `record` directory), so a later start can stop it should this process die unsignalled
    // (reapRecorded).
    const tag = group ? randomBytes(12).toString("hex") : null;
    const files = toFiles ? fileStdio(maxBytes) : null;
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: tag ? { ...(env ?? process.env), PENDULUM_RUN_TAG: tag } : env ?? process.env, stdio: ["pipe", ...(files ? files.stdio : ["pipe", "pipe"])], detached: group });
    } catch (e) {
      files?.drop();
      throw e;
    }
    files?.spawned();
    if (group && child.pid) trackGroup(child.pid, tag, record);
    const out = [];
    const err = [];
    let outBytes = 0;
    let timedOut = false;
    let idle = false;
    let idleOpen = 0;
    let timer = null;
    let check = null;
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
    // Each idleMs window, a run that printed nothing across it is judged from its own state (runReading, hangVerdict):
    // killed when hung, left when working or when that cannot be told (the wall clock, timeoutMs, still stops it).
    // `answerStreams`: the run prints its model's answer as it arrives (dropLine's deltas), so its silence with no
    // command open is a stalled model stream.
    let heard = false;
    let exited = false;
    let baseline = null;
    if (idleMs > 0 && child.pid) {
      const opts = { group, tag, agent: agentRoute(args), streamFd: files ? files.streamFd : null, harnessHome };
      const read = () => runReading(child.pid, opts).catch(() => null);
      let before = null;
      let ticking = false;
      check = setInterval(async () => {
        if (ticking || exited) return;
        ticking = true;
        const silent = !heard;
        heard = false;
        try {
          const after = await read();
          if (exited) return;
          const open = openItems?.() ?? 0;
          if (hangVerdict(before, after, { heard: !silent, open, streams: answerStreams }) === true) {
            idle = true;
            idleOpen = open;
            clearInterval(check);
            kill();
          } else if (after) before = after;
        } catch {
          // decides nothing
        } finally {
          ticking = false;
        }
      }, idleMs);
      // The processes' windows count from the first reading that finds the run (an agent's unit starts after its
      // client): tried at the start, and again at each output until one does.
      let reading = false;
      baseline = async () => {
        if (reading || before || exited) return;
        reading = true;
        try {
          before = await read();
        } finally {
          reading = false;
        }
      };
      baseline();
    }
    let partial = "";
    const decoder = new StringDecoder("utf8");
    const keep = (chunk) => {
      outBytes += chunk.length;
      if (outBytes <= maxBytes) out.push(chunk);
      // `killPastMax`: a child that writes past `maxBytes` is stopped, not read on and dropped (a file that never ends).
      else if (killPastMax) kill();
      if (tee) appendOwn(tee, chunk);
    };
    // `dropLine`: stdout lines it names (a harness's answer deltas) count as output for the hung check and go no further:
    // not into the result, `tee` or `onLine`.
    const onOut = (chunk) => {
      heard = true;
      baseline?.();
      if (!dropLine) keep(chunk);
      if (!onLine && !dropLine) return;
      partial += decoder.write(chunk);
      const parts = partial.split("\n");
      partial = parts.pop();
      for (const line of parts) {
        if (dropLine && line && dropLine(line)) continue;
        if (dropLine) keep(Buffer.from(`${line}\n`));
        if (line) onLine?.(line);
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
    // A run whose own process has exited is not hung: what it left goes with it (`group`), or is no longer the run's.
    child.on("exit", () => {
      exited = true;
      if (check) clearInterval(check);
    });
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      if (check) clearInterval(check);
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
        if (left) process.stdout.write(`[pendulum] ${left} process(es) the run left outside its group were killed\n`);
        untrackGroup(child.pid);
      });
    }
    child.on("close", async (code, sig) => {
      closed = true;
      if (timer) clearTimeout(timer);
      if (check) clearInterval(check);
      signal?.removeEventListener("abort", stop);
      if (files) {
        clearInterval(poll);
        // What the run wrote after the last read (up to maxBytes), in bounded reads that yield between them; then the
        // files go.
        while (pullFiles()?.more) await new Promise((r) => setImmediate(r));
        files.drop();
      }
      if (readError) err.push(Buffer.from(`\n[pendulum] reading the run's output failed (${readError}); the run was stopped\n`));
      partial += decoder.end();
      if (partial && !dropLine?.(partial)) {
        if (dropLine) keep(Buffer.from(partial));
        onLine?.(partial);
      }
      const decode = (chunks) => (encoding === "buffer" ? Buffer.concat(chunks) : Buffer.concat(chunks).toString("utf8"));
      resolve({ code, signal: sig, stdout: decode(out), stderr: decode(err), timedOut, idle, idleOpen, stopped, truncated: outBytes > maxBytes || overflow, readError });
    });
    // A child that exits before draining a large prompt raises EPIPE on stdin; that is its exit code's story, not ours.
    child.stdin.on("error", () => {});
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

// ------------------------------------------------------------------ group runs and stop signals

/** The files in a stage's usage directory that name its live harness runs (exec's `record`), for a later start to reap. */
export const groupRecordName = (pid) => `harness-group-${pid}.json`;
export const GROUP_RECORD = /^harness-group-\d+\.json$/;
/** This process's live `group` runs: leader pid → {tag, record}. */
const GROUPS = new Map();
let trapped = false;
/** What runs once the groups are killed on a stop signal, before the exit (atStop). */
const AT_STOP = new Set();

/**
 * Run `fn(sig)` when a stop signal ends a process with a live or past `group` run: after its groups are killed, before
 * it exits, synchronously (stopGroups: no other code of the process runs meanwhile), so `fn` must bound its own time.
 * A throw is ignored. Returns a function that removes it.
 */
export function atStop(fn) {
  AT_STOP.add(fn);
  return () => AT_STOP.delete(fn);
}

/** `sysctl -n kern.boottime` ("{ sec = 1731450000, usec = 12345 } Thu Nov 12 ...") as its seconds, a string; else null. */
export const boottimeSeconds = (text) => /\bsec = (\d+)/.exec(String(text || ""))?.[1] ?? null;

/** This boot: Linux's boot id; elsewhere the boot time macOS's sysctl reports. Null when unreadable. A pid means nothing across boots. */
export function bootId() {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    try {
      return boottimeSeconds(execFileSync("sysctl", ["-n", "kern.boottime"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { PATH: process.env.PATH || "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C" } }));
    } catch {
      return null;
    }
  }
}

const probe = (target) => {
  try {
    process.kill(target, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};

/** The fields of a /proc/<pid>/stat line after the command name (index 0 is field 3, the state); null if it is none. */
export function statFields(text) {
  const end = String(text || "").lastIndexOf(")");
  return end < 0 ? null : text.slice(end + 2).trim().split(" ");
}
/** Linux: /proc/<pid>/stat's fields (statFields), or null. */
function procStat(pid) {
  try {
    return statFields(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return null;
  }
}

/**
 * `ps` (macOS) with a fixed environment: its time and text formats follow the locale and TZ, and a record written under
 * one environment must read the same under another.
 */
const ps = (args) => execFileSync("ps", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024, env: { PATH: process.env.PATH || "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC0" } });

/** `ps -o lstart=` under LC_ALL=C TZ=UTC0 ("Thu Nov 12 21:15:03 2026") as Unix seconds, a string; null if it is none. */
export function lstartSeconds(text) {
  const m = /^\s*[A-Z][a-z]{2}\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s*$/.exec(String(text || ""));
  const month = m ? ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(m[1]) : -1;
  if (month < 0) return null;
  return String(Date.UTC(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])) / 1000);
}

/** `ps`'s cumulative CPU time ("[dd-][hh:]mm:ss[.cc]": procps prints 00:01:02, macOS 1:02.03) in ms; null if it is none. */
export function cpuTimeMs(text) {
  const m = /^(?:(\d+)-)?((?:\d+:){0,2}\d+)(?:\.(\d{1,3}))?$/.exec(String(text || "").trim());
  if (!m) return null;
  const seconds = m[2].split(":").reduce((s, p) => s * 60 + Number(p), 0) + Number(m[1] || 0) * 86_400;
  return seconds * 1000 + Number((m[3] || "0").padEnd(3, "0"));
}

/** A bounded command's stdout, whatever its exit status (a missing pid fails a batch read only for that pid); null if none. */
async function runOut(cmd, args, { env = { PATH: SAFE_PATH, LC_ALL: "C", TZ: "UTC0" } } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: "utf8", timeout: READ_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, env }, (e, out) => resolve(typeof out === "string" && (out || !e) ? out : null));
  });
}
/** The longest one of a run's readings may wait for a helper (systemctl on a slow D-Bus, sudo, ps, lsof). */
const READ_TIMEOUT_MS = 60_000;

/** Every process as {ppid, pgid, cpu, start} by pid: Linux /proc, CPU in clock ticks; null when /proc cannot be read. */
async function procRows() {
  let names;
  try {
    names = await readdir("/proc");
  } catch {
    return null;
  }
  const rows = new Map();
  await Promise.all(
    names.filter((p) => /^\d+$/.test(p)).map(async (p) => {
      const f = statFields(await readFile(`/proc/${p}/stat`, "utf8").catch(() => ""));
      // utime + stime, and cutime + cstime: what its children used before it waited for them.
      if (f) rows.set(Number(p), { ppid: Number(f[1]), pgid: Number(f[2]), cpu: Number(f[11]) + Number(f[12]) + Number(f[13]) + Number(f[14]), start: f[19] });
    }),
  );
  return rows;
}

/** Every process as procRows has it, from `ps` (macOS: `-S` adds what its exited children used), CPU in ms; null on failure. */
async function psRows() {
  const text = await runOut("ps", ["-A", ...(process.platform === "darwin" ? ["-S"] : []), "-o", "pid=,ppid=,pgid=,time=,lstart="]);
  if (text === null) return null;
  const rows = new Map();
  for (const line of text.split("\n")) {
    const [pid, ppid, pgid, time, ...start] = line.trim().split(/\s+/);
    const cpu = cpuTimeMs(time);
    if (/^\d+$/.test(pid || "") && cpu !== null) rows.set(Number(pid), { ppid: Number(ppid), pgid: Number(pgid), cpu, start: lstartSeconds(start.join(" ")) });
  }
  return rows;
}

/**
 * The agent route an asAgent command runs on, from its own argv: `{unit: {name, user}}` for a systemd unit
 * (`--unit=pendulum-agent-…`, `--user` for a user manager's), `{cgroup: AGENT_CGROUP}` for the namespace wrapper, or
 * null for any other command.
 */
export function agentRoute(args) {
  const end = args.indexOf("--");
  const own = end < 0 ? args : args.slice(0, end);
  const name = own.find((a) => String(a).startsWith(`--unit=${UNIT_PREFIX}`))?.slice("--unit=".length);
  if (name) return { unit: { name, user: own.includes("--user") } };
  return args.includes("pendulum-agent-wrap") ? { cgroup: AGENT_CGROUP } : null;
}

/**
 * The install directory of the harness CLI `file` (as PATH finds it), symlinks resolved: the npm package it belongs to
 * (the last `node_modules/<name>` or `node_modules/@scope/<name>` in its real path, where its native binary and
 * helpers live), else its own directory. Null when it cannot be resolved, or when it holds the system's own commands:
 * a SAFE_PATH directory or a directory on `env`'s PATH, or one above either (a CLI installed into /usr/bin), so what
 * runs from there keeps its command role.
 */
export function harnessHome(file, env = process.env) {
  let real;
  try {
    real = realpathSync(file);
  } catch {
    return null;
  }
  const parts = real.split("/");
  const at = parts.lastIndexOf("node_modules");
  const home = at >= 0 && parts.length > at + 2 ? parts.slice(0, at + (parts[at + 1].startsWith("@") ? 3 : 2)).join("/") : parts.slice(0, -1).join("/");
  const resolved = (d) => {
    try {
      return realpathSync(d);
    } catch {
      return null;
    }
  };
  const system = [...SAFE_PATH.split(":"), ...String(env.PATH || "").split(delimiter)].filter((d) => d.startsWith("/")).map(resolved).filter(Boolean);
  return system.some((d) => d === home || d.startsWith(`${home}/`)) ? null : home;
}

/** A systemd unit's cgroup directory (/sys/fs/cgroup/system.slice/<unit>.service), as its manager reports it; null while it has none. */
async function unitCgroup({ name, user = false }) {
  const out = await runOut("systemctl", [...(user ? ["--user"] : []), "show", "--property=ControlGroup", "--value", `${name}.service`], { env: { ...process.env, PATH: SAFE_PATH } });
  return out?.trim() ? `/sys/fs/cgroup${out.trim()}` : null;
}

/** The pids in a cgroup and every cgroup under it; null when it cannot be read. */
async function cgroupPids(dir) {
  try {
    const pids = (await readFile(join(dir, "cgroup.procs"), "utf8")).split("\n").filter((p) => /^\d+$/.test(p)).map(Number);
    for (const d of await readdir(dir, { withFileTypes: true })) if (d.isDirectory()) pids.push(...((await cgroupPids(join(dir, d.name))) ?? []));
    return pids;
  } catch {
    return null;
  }
}

/** /proc/<pid>/io's rchar and wchar ("rchar: 123" lines), or null. */
const ioCounts = (text) => {
  const r = /^rchar: (\d+)$/m.exec(text || "")?.[1];
  const w = /^wchar: (\d+)$/m.exec(text || "")?.[1];
  return r && w ? { rchar: Number(r), wchar: Number(w) } : null;
};

/**
 * Linux: each pid's I/O counts (rchar, wchar), what its stdout is ("<dev>:<ino>", or "stream" when it is the run's
 * own stdout, `streamFd`: Pendulum's descriptor of it) and its executable (the kernel's resolved path). Read directly; with `privileged` (an agent route, whose processes
 * are another uid's and need ptrace access), what that cannot read is read through `sudo -n`, with no shell, and the
 * stream through it too, so both sides of the comparison come from one reader. Whatever neither reads stays null.
 */
async function procIo(pids, streamFd, privileged) {
  const io = new Map();
  const fd1 = new Map();
  const exe = new Map();
  const id = (st) => `${st.dev}:${st.ino}`;
  const streams = new Set();
  if (streamFd !== null) streams.add(await stat(`/proc/self/fd/${streamFd}`).then(id, () => null));
  await Promise.all(
    pids.map(async (p) => {
      io.set(p, ioCounts(await readFile(`/proc/${p}/io`, "utf8").catch(() => null)));
      fd1.set(p, await stat(`/proc/${p}/fd/1`).then(id, () => null));
      exe.set(p, await readlink(`/proc/${p}/exe`).catch(() => null));
    }),
  );
  const missed = pids.filter((p) => io.get(p) === null || fd1.get(p) === null || exe.get(p) === null);
  if (privileged && missed.length) {
    // Each line names its file, so a pid gone meanwhile fails alone. Pendulum's own descriptor goes by its pid.
    const ours = streamFd !== null ? `/proc/${process.pid}/fd/${streamFd}` : null;
    const grep = await runOut("/usr/bin/sudo", ["-n", "/usr/bin/grep", "-H", "-E", "^(rchar|wchar):", ...missed.map((p) => `/proc/${p}/io`)]);
    const st = await runOut("/usr/bin/sudo", ["-n", "/usr/bin/stat", "-L", "-c", "%n %d %i", ...(ours ? [ours] : []), ...missed.map((p) => `/proc/${p}/fd/1`)]);
    const found = await runOut("/usr/bin/sudo", ["-n", "/usr/bin/find", ...missed.map((p) => `/proc/${p}/exe`), "-maxdepth", "0", "-printf", "%p\t%l\n"]);
    const exes = new Map();
    for (const l of String(found || "").split("\n")) {
      const m = /^\/proc\/(\d+)\/exe\t(.+)$/.exec(l);
      if (m) exes.set(Number(m[1]), m[2]);
    }
    const lines = new Map();
    for (const l of String(grep || "").split("\n")) {
      const m = /^\/proc\/(\d+)\/io:(.*)$/.exec(l);
      if (m) lines.set(Number(m[1]), `${lines.get(Number(m[1])) || ""}${m[2]}\n`);
    }
    const ids = new Map();
    for (const l of String(st || "").split("\n")) {
      const m = /^(\S+) (\d+) (\d+)$/.exec(l);
      if (m) ids.set(m[1], `${m[2]}:${m[3]}`);
    }
    if (ours && ids.has(ours)) streams.add(ids.get(ours));
    for (const p of missed) {
      if (io.get(p) === null) io.set(p, ioCounts(lines.get(p)));
      if (fd1.get(p) === null) fd1.set(p, ids.get(`/proc/${p}/fd/1`) ?? null);
      if (exe.get(p) === null) exe.set(p, exes.get(p) ?? null);
    }
  }
  streams.delete(null);
  for (const [p, v] of fd1) if (v !== null && streams.has(v)) fd1.set(p, "stream");
  return { io, fd1, exe };
}

/** Elsewhere (no /proc): each pid's stdout and executable, from `lsof` with the run's stream read beside them; no I/O counts. */
async function lsofFiles(pids, streamFd) {
  const fd1 = new Map(pids.map((p) => [p, null]));
  const exe = new Map(pids.map((p) => [p, null]));
  if (!pids.length) return { fd1, exe };
  const out = await runOut("lsof", ["-n", "-P", "-a", "-d", `1,txt${streamFd !== null ? `,${streamFd}` : ""}`, "-F", "pfDin", "-p", [process.pid, ...pids].join(",")]);
  let pid = null;
  let fd = null;
  let dev = null;
  const seen = new Map();
  for (const l of String(out || "").split("\n")) {
    const v = l.slice(1);
    if (l[0] === "p") pid = Number(v);
    else if (l[0] === "f") {
      fd = v;
      dev = null;
    } else if (l[0] === "D") dev = v;
    else if (l[0] === "i") seen.set(`${pid}/${fd}`, `${dev}:${v}`);
    // The first `txt` file is the executable.
    else if (l[0] === "n" && fd === "txt" && exe.get(pid) === null) exe.set(pid, v);
  }
  const stream = streamFd !== null ? (seen.get(`${process.pid}/${streamFd}`) ?? null) : null;
  for (const p of pids) {
    const v = seen.get(`${p}/1`);
    if (v) fd1.set(p, stream && v === stream ? "stream" : v);
  }
  return { fd1, exe };
}

/**
 * One reading of a run's processes: a Map of "<pid>:<start>" to {pid, ppid, cpu, io: {rchar, wchar} | null, role},
 * with `ioRead` whether this platform gives I/O counts at all (Linux /proc does; elsewhere `ps` and `lsof` give CPU
 * and stdout only). The run's processes: on an agent route (`agent`, agentRoute) its systemd unit's or the namespace's
 * cgroup; otherwise `pid` and its descendants, with `group` its process group, and with `tag` every process carrying
 * PENDULUM_RUN_TAG=`tag` (a setsid or double fork) and their descendants. `streamFd`: Pendulum's descriptor of the run's
 * stdout file (exec's fileStdio).
 * Role: the harness and its launchers (sudo, systemd-run's unit, srt, bwrap) write the run's stdout and pass it on
 * unchanged, so a process is `harness` when it is a root of the run (its parent outside it) whose stdout is the run's
 * stream (or `pid` itself), or a child of a `harness` with its parent's stdout; every other process is a `command` the
 * harness started, unless its executable lies in `harnessHome` (the harness CLI's install directory, harnessHome()):
 * a helper the harness ships and talks to over pipes is the harness's. Null when its stdout or that executable cannot
 * be read. Null altogether when the run cannot be found: `pid` absent from
 * the processes read (a hidepid /proc, an unparsed row), or an agent route's cgroup unread or empty.
 */
export async function runReading(pid, { group = false, tag = null, agent = null, streamFd = null, harnessHome = null, procfs = process.platform === "linux" } = {}) {
  const rows = procfs ? await procRows() : await psRows();
  if (!rows) return null;
  let members;
  if (agent) {
    const dir = agent.unit ? await unitCgroup(agent.unit) : agent.cgroup;
    const pids = dir ? await cgroupPids(dir) : null;
    if (!pids?.length) return null;
    members = new Set(pids.filter((p) => rows.has(p)));
    if (!members.size) return null;
  } else {
    if (!rows.has(pid)) return null;
    const children = new Map();
    for (const [p, r] of rows) {
      if (!children.has(r.ppid)) children.set(r.ppid, []);
      children.get(r.ppid).push(p);
    }
    const walk = [pid];
    if (group) for (const [p, r] of rows) if (r.pgid === pid) walk.push(p);
    if (tag) walk.push(...(await taggedPidsAsync(tag, procfs)));
    members = new Set();
    while (walk.length) {
      const p = walk.pop();
      if (!rows.has(p) || p === process.pid || members.has(p)) continue;
      members.add(p);
      walk.push(...(children.get(p) || []));
    }
  }
  const pids = [...members];
  const { io, fd1, exe } = procfs ? await procIo(pids, streamFd, !!agent) : { io: new Map(), ...(await lsofFiles(pids, streamFd)) };
  const home = harnessHome ? `${harnessHome.replace(/\/+$/, "")}/` : null;
  // Roles, parents first. An unread stdout (null) leaves the role unknown, unless it is the run's own stream.
  const role = new Map();
  const roleOf = (p) => {
    if (role.has(p)) return role.get(p);
    const parent = rows.get(p).ppid;
    const own = fd1.get(p) ?? null;
    let r;
    if (p === pid && !agent) r = "harness";
    else if (own === "stream") r = members.has(parent) && roleOf(parent) !== "harness" ? roleOf(parent) : "harness";
    else if (!members.has(parent)) r = own === null ? null : "command";
    else if (roleOf(parent) !== "harness") r = roleOf(parent);
    else if (own === null || (fd1.get(parent) ?? null) === null) r = null;
    else if (own === fd1.get(parent)) r = "harness";
    // A helper the harness ships beside its own binary (Codex's codex-code-mode-host) talks to it over pipes of its own.
    else if (!home) r = "command";
    else r = exe.get(p) ? (exe.get(p).startsWith(home) ? "harness" : "command") : null;
    role.set(p, r);
    return r;
  };
  const procs = new Map();
  for (const p of pids) {
    const r = rows.get(p);
    procs.set(`${p}:${r.start}`, { pid: p, ppid: r.ppid, cpu: r.cpu, io: io.get(p) ?? null, role: roleOf(p) });
  }
  return { procs, ioRead: procfs };
}

/**
 * Whether a run that printed nothing across a window (`heard`: it did print) is hung at its end: true hung, false
 * working, null unknown (the caller then decides nothing; the wall clock still ends the run).
 * With no command item open (`open`, from the harness's own stream), the harness is waiting on its model: a harness that
 * prints the answer as it arrives (`streams`) and printed nothing has a stalled model stream, hung; for any other the
 * silence decides nothing (Codex ends a stalled stream itself). Neither its CPU nor its reads say more: an idle
 * harness's timers use CPU and read its own files.
 * With a command item open, the question is whether the commands (`before` and `after`, runReading) progress: any CPU,
 * or any byte read or written (a download, a pipe), by a command process, one started since included, is working;
 * none, with every command's I/O read, is hung. An item open with no command process (a sub-agent, a web fetch, in the
 * harness itself), a reading missing, a process unclassified or I/O unread where the platform has it: unknown.
 */
export function hangVerdict(before, after, { heard = false, open = 0, streams = false } = {}) {
  if (heard) return false;
  if (open === 0) return streams ? true : null;
  if (!before || !after) return null;
  const was = (k) => before.procs.get(k);
  const commands = [...after.procs].filter(([, v]) => v.role === "command");
  const unclassified = [...after.procs.values()].some((v) => v.role === null);
  const gain = (k, v, f) => Math.max(0, f(v) - (was(k) ? f(was(k)) : 0));
  if (!commands.length) return null;
  let progress = 0;
  let unread = false;
  for (const [k, v] of commands) {
    progress += gain(k, v, (x) => x.cpu);
    if (v.io && (!was(k) || was(k).io)) progress += gain(k, v, (x) => x.io.rchar + x.io.wchar);
    else if (after.ioRead) unread = true;
  }
  if (progress > 0) return false;
  return unread || unclassified ? null : true;
}

/** The pids in process group `pgid`, from `ps -A -o pid=,pgid=` output. */
export const groupMembers = (text, pgid) =>
  String(text || "")
    .split("\n")
    .map((l) => l.trim().split(/\s+/).map(Number))
    .filter(([p, g]) => Number.isInteger(p) && p > 0 && g === pgid)
    .map(([p]) => p);

/** Whether a process's environment, as /proc/<pid>/environ (NUL-separated) or `ps eww` prints it, holds `mark` exactly. */
export const holdsMark = (text, mark) => String(text || "").split(/[\0\s]+/).includes(mark);

/**
 * When process `pid` started, as a string that differs for another process given the same pid: Linux's start time in
 * clock ticks since boot (/proc/<pid>/stat field 22), elsewhere `ps -o lstart=` read in a fixed locale and time zone, as
 * Unix seconds. Null when it cannot be read.
 */
export function startTime(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") return procStat(pid)?.[19] ?? null;
  try {
    return lstartSeconds(ps(["-o", "lstart=", "-p", String(pid)]));
  } catch {
    return null;
  }
}

/** A process as Pendulum names it in a record: its pid, start time and boot (sameProcess checks one). */
export const processRecord = (pid = process.pid) => ({ pid, start: startTime(pid), boot: bootId() });

/**
 * Whether the process a record names is still that process: true when it is (this boot, alive, started when recorded),
 * false only when it is known gone (another boot, no such pid, or a start time read and different), null when that
 * cannot be told (no pid or boot, a start time unread or unrecorded): a caller then signals and deletes nothing.
 */
export function sameProcess(rec) {
  const pid = Number(rec?.pid);
  const boot = bootId();
  if (!Number.isInteger(pid) || pid <= 1 || !boot || !rec.boot) return null;
  if (rec.boot !== boot || !probe(pid)) return false;
  const now = startTime(pid);
  if (!now || !/^\d+$/.test(String(rec.start ?? ""))) return null;
  return now === String(rec.start);
}

/** Whether process `pid` carries PENDULUM_RUN_TAG=`tag` in its environment (Linux /proc; elsewhere `ps eww`). */
function carriesTag(pid, tag) {
  const mark = `PENDULUM_RUN_TAG=${tag}`;
  if (process.platform === "linux") {
    try {
      return holdsMark(readFileSync(`/proc/${pid}/environ`, "latin1"), mark);
    } catch {
      return false;
    }
  }
  try {
    return holdsMark(ps(["eww", "-o", "command=", "-p", String(pid)]), mark);
  } catch {
    return false;
  }
}

/** Whether a live process in process group `pgid` carries the run's tag, which every process the run starts inherits. */
function groupCarriesTag(pgid, tag) {
  let members = [];
  if (process.platform === "linux") {
    try {
      members = readdirSync("/proc").filter((p) => /^\d+$/.test(p) && procStat(p)?.[2] === String(pgid)).map(Number);
    } catch {
      return false;
    }
  } else {
    try {
      members = groupMembers(ps(["-A", "-o", "pid=,pgid="]), pgid);
    } catch {
      return false;
    }
  }
  return members.some((p) => carriesTag(p, tag));
}

/** The signals that stop a process with a live `group` run (its groups go first: stopGroups), or a local loop. */
export const STOP_SIGNALS = ["SIGTERM", "SIGHUP", "SIGINT"];

function trackGroup(pid, tag, recordDir) {
  const record = recordDir ? join(recordDir, groupRecordName(pid)) : null;
  GROUPS.set(pid, { tag, record });
  // A record names the run for the next start, should this process die without stopping it (SIGKILL, a crash).
  if (record) {
    try {
      const owner = processRecord();
      writeFileSync(record, JSON.stringify({ pid, start: startTime(pid), tag, owner: owner.pid, ownerStart: owner.start, boot: owner.boot }), { mode: 0o600 });
    } catch {
      // no record: the signal path below still stops it
    }
  }
  // A process with a harness in its own process group stops it before it exits: a terminal's signal never reaches it.
  if (!trapped) {
    trapped = true;
    for (const s of STOP_SIGNALS) process.on(s, () => stopGroups(s));
  }
}

function untrackGroup(pid) {
  const g = GROUPS.get(pid);
  GROUPS.delete(pid);
  if (g?.record) rmSync(g.record, { force: true });
}

/**
 * On SIGTERM, SIGHUP or SIGINT: every live group run's process group and tagged processes are killed, then what atStop
 * registered runs, then the process exits as the signal would have ended it (128 + its number), unless another handler
 * of that signal is installed and decides when. All at once, with no await between: no code of the stage runs (a next
 * pass, a post) once it is told to stop, and nothing of the harness is left when it exits. A killed pass's session is
 * not carried over anyway.
 */
function stopGroups(sig) {
  for (const [pid, g] of [...GROUPS]) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // gone
    }
    killTagged(g.tag);
    untrackGroup(pid);
  }
  for (const fn of [...AT_STOP]) {
    AT_STOP.delete(fn);
    try {
      fn(sig);
    } catch {
      // the exit goes ahead
    }
  }
  if (process.listenerCount(sig) <= 1) process.exit(128 + (osConstants.signals[sig] || 15));
}

/**
 * Stop the harness run a dead stage recorded in `file` (exec's `record`), then remove the record. Nothing is signalled
 * unless the record is this boot's and its owner stage is gone (sameProcess: a pid reused since does not keep it). The
 * group is killed only when a live process in it carries the run's tag; when its leader is alive it must also be the
 * process recorded. Every process carrying the tag goes too. Whatever cannot be checked on this platform is not
 * signalled; never a match on command lines. Returns whether anything was signalled.
 */
export function reapRecorded(file) {
  let rec = null;
  try {
    rec = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return false;
  }
  const pid = Number(rec?.pid);
  const tag = typeof rec?.tag === "string" && /^[0-9a-f]{24}$/.test(rec.tag) ? rec.tag : null;
  const boot = bootId();
  if (!boot) return false;
  if (!tag || !Number.isInteger(pid) || pid <= 1 || rec.boot !== boot) {
    rmSync(file, { force: true });
    return false;
  }
  // A live owner is a stage still running (its own stop path ends its run); one that cannot be told is left too.
  if (sameProcess({ pid: rec.owner, start: rec.ownerStart, boot: rec.boot }) !== false) return false;
  let hit = false;
  const leader = probe(pid) ? sameProcess(rec) === true : true;
  if (leader && groupCarriesTag(pid, tag)) {
    try {
      process.kill(-pid, "SIGKILL");
      hit = true;
    } catch {
      // gone
    }
  }
  if (killTagged(tag)) hit = true;
  rmSync(file, { force: true });
  return hit;
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
 * repository's workflow file or the developer's env (PENDULUM_HARNESS), and must not be able to run anything.
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

/**
 * The command's path when it is on PATH, else null (doctor prints the path). `env`: the environment the command will
 * be launched with, whose PATH is the one that finds it (a stage's harness env, not this process's).
 */
export async function onPath(cmd, env = process.env) {
  return whichSync(cmd, env);
}

/**
 * Kill every process of this user whose environment carries PENDULUM_RUN_TAG=`tag` (exec's `group` runs): what a run
 * left behind outside its process group, a setsid or double-forked one included. Linux reads /proc; elsewhere `ps eww`.
 * Returns how many were killed.
 */
export function killTagged(tag) {
  if (!tag) return 0;
  let killed = 0;
  for (const pid of taggedPids(tag)) {
    try {
      process.kill(pid, "SIGKILL");
      killed += 1;
    } catch {
      // gone
    }
  }
  return killed;
}

/** taggedPids without holding the event loop: a run's reading scans /proc while the stage goes on. */
async function taggedPidsAsync(tag, procfs = process.platform === "linux") {
  const mark = `PENDULUM_RUN_TAG=${tag}`;
  if (!procfs) return String((await runOut("ps", ["eww", "-A", "-o", "pid=,command="])) || "").split("\n").filter((l) => holdsMark(l, mark)).map((l) => Number(l.trim().split(/\s+/)[0]));
  const names = await readdir("/proc").catch(() => []);
  const hits = await Promise.all(names.map(async (p) => /^\d+$/.test(p) && Number(p) !== process.pid && (await readFile(`/proc/${p}/environ`, "latin1").catch(() => "")).split("\0").includes(mark)));
  return names.filter((_, i) => hits[i]).map(Number);
}

/** The pids of this user's processes whose environment carries PENDULUM_RUN_TAG=`tag`: /proc, or `ps eww` without it. */
function taggedPids(tag, procfs = process.platform === "linux") {
  const mark = `PENDULUM_RUN_TAG=${tag}`;
  const pids = [];
  if (procfs) {
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
      for (const line of ps(["eww", "-A", "-o", "pid=,command="]).split("\n")) if (holdsMark(line, mark)) pids.push(Number(line.trim().split(/\s+/)[0]));
    } catch {
      // no ps
    }
  }
  return pids;
}
