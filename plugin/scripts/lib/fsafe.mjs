// Factory's own files. Factory's temp directory is a fresh directory under a 700 one it owns, never a predictable
// path in a shared /tmp; and every file Factory writes is opened with O_NOFOLLOW (and O_EXCL where it must be new),
// so a symlink the harness planted where Factory writes is refused, never written through.
import { chmodSync, closeSync, constants as C, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const write = (file, data, flags) => {
  const fd = openSync(file, flags | C.O_WRONLY | C.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, typeof data === "string" ? data : Buffer.from(data));
  } finally {
    closeSync(fd);
  }
};

/** Create a file that must not exist yet. */
export const writeNew = (file, data) => write(file, data, C.O_CREAT | C.O_EXCL);
/** Create or replace a file, never through a symlink. */
export const writeOwn = (file, data) => write(file, data, C.O_CREAT | C.O_TRUNC);
/** Append to a file, never through a symlink. */
export const appendOwn = (file, data) => write(file, data, C.O_CREAT | C.O_APPEND);

/**
 * Give this process its own temp directory: a mkdtemp directory with mode 700 under `base` (FACTORY_PRIVATE_DIR, which
 * local mode points at the Objective's directory no sandbox may write; else the runner's temp directory; else the
 * system's). TMPDIR is set to it for Factory's own files (the mirror, bundles, archives). It is removed when the
 * process exits, and one a killed process left is removed by the next (sweepOwned). Returns {factory, agent}: `agent`
 * is the TMPDIR the stage started with, the one the harness and its commands keep.
 */
export function privateTmp(env = process.env) {
  const agent = env.TMPDIR || tmpdir();
  const base = env.FACTORY_PRIVATE_DIR || env.RUNNER_TEMP || tmpdir();
  mkdirSync(base, { recursive: true, mode: 0o700 });
  sweepOwned(base, /^factory-[A-Za-z0-9]{6}$/);
  const factory = ownedTemp(base, "factory-");
  chmodSync(factory, 0o700);
  process.once("exit", () => dropOwned(factory));
  env.TMPDIR = factory;
  return { factory, agent };
}

/** Whether process `pid` has ended: signal 0 finds no such process (EPERM means it runs as another user). */
export function pidGone(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return e.code === "ESRCH";
  }
}

/**
 * A temp directory `<base>/<prefix>XXXXXX` held by this process: its pid is written beside it in `<dir>.pid`, so a
 * later sweep (sweepOwned) can tell a killed process's leftover from one a live process still uses. The name stays
 * short (a stage's sockets live in it). Remove it with dropOwned.
 */
export function ownedTemp(base, prefix) {
  const dir = mkdtempSync(join(base, prefix));
  try {
    writeNew(`${dir}.pid`, `${process.pid}\n`);
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  return dir;
}

/**
 * Remove an ownedTemp directory, then its pid file; never throws. Links in it are removed, never followed. `unlock`
 * also opens up write-protected directories in it (removeTree): only for a tree no sandbox could write, since a
 * process still running there could swap such a directory for a link between the check and the chmod. A directory
 * that could not be removed keeps its pid file, so a later sweep tries again.
 */
export function dropOwned(dir, { unlock = false } = {}) {
  if (unlock) removeTree(dir);
  else {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // left for a later sweep
    }
  }
  if (!statOr(dir)) rmSync(`${dir}.pid`, { force: true });
}

/** Remove a tree no sandbox could write, write-protected directories in it included (a test may leave one); never throws. */
export function removeTree(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
    return;
  } catch {
    // a directory without write permission: opened up below, then removed again
  }
  const open = (p) => {
    try {
      if (!lstatSync(p).isDirectory()) return;
      chmodSync(p, 0o700);
      for (const n of readdirSync(p)) open(join(p, n));
    } catch {
      // gone, or not ours
    }
  };
  open(dir);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // left for the next sweep
  }
}

const HOUR = 3600_000;
const WEEK = 7 * 24 * HOUR;
const uid = () => process.getuid?.() ?? -1;
const statOr = (p) => {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
};

/**
 * Clear what ended processes left in `base`: each directory whose name matches `names` and that this user owns, once
 * the pid in its `<dir>.pid` (ownedTemp) is gone and the pid file is over `minAgeMs` old. A directory whose pid is
 * alive is never touched (a reused pid only keeps a leftover longer). With `legacy`, a matching directory with no pid
 * file (made before Factory recorded holders) goes once it is over `legacyAgeMs` old, longer than any stage runs.
 * Returns the names removed.
 */
export function sweepOwned(base, names, { legacy = false, minAgeMs = HOUR, legacyAgeMs = WEEK, now = Date.now(), gone = pidGone } = {}) {
  let entries;
  try {
    entries = readdirSync(base);
  } catch {
    return [];
  }
  const keys = new Set(entries.map((n) => n.replace(/\.pid$/, "")).filter((n) => names.test(n)));
  const removed = [];
  for (const key of keys) {
    const dir = join(base, key);
    const pidFile = `${dir}.pid`;
    const d = statOr(dir);
    const p = statOr(pidFile);
    if ((d && (!d.isDirectory() || d.uid !== uid())) || (p && (!p.isFile() || p.uid !== uid()))) continue;
    let stale;
    if (p) {
      let pid = NaN;
      try {
        const text = readFileSync(pidFile, "utf8");
        if (/^\d{1,10}\n?$/.test(text)) pid = Number(text);
      } catch {
        continue;
      }
      stale = gone(pid) && now - p.mtimeMs > minAgeMs;
    } else {
      stale = legacy && d && now - d.mtimeMs > legacyAgeMs;
    }
    if (!stale) continue;
    dropOwned(dir);
    if (!statOr(dir)) removed.push(key);
  }
  return removed;
}
