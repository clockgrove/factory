// One machine's room for Factory's local stages, shared by every local loop on it (serve and run, any repository, any
// harness login): the machine's stage budget, the slots its loops hold against it, and how loaded the machine is now.
// Both live under the user's ~/.cache/factory, which no sandbox may write:
//   machine.json   {"stages": N}: the budget, set once per machine; without it, from the machine's size (defaultStages)
//   slots/         one file per slot held: <pid>-<nonce>.json, its holder's process record (pid, start time, boot) and
//                  what it runs (repository, issue, stage)
// A slot frees itself when its holder dies: a record whose process is gone (another boot, no such pid, or a pid whose
// start time differs) is removed by the next reader, so a crash, a SIGKILL or a reboot leaves nothing held.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { availableParallelism, homedir, loadavg, totalmem } from "node:os";
import { join } from "node:path";
import { writeNew } from "./fsafe.mjs";
import { processRecord, sameProcess, startTime } from "./proc.mjs";

const GB = 2 ** 30;

/** Where the machine's budget setting and its slots live. */
export const machineFile = (home = homedir()) => join(home, ".cache", "factory", "machine.json");
export const slotsDir = (home = homedir()) => join(home, ".cache", "factory", "slots");

/** The budget a machine gets without a setting: a quarter of its CPU threads, at most one per 8 GB of memory, at least 1. */
export const defaultStages = ({ cpus = availableParallelism(), memBytes = totalmem() } = {}) => Math.max(1, Math.min(Math.floor(cpus / 4), Math.floor(memBytes / 8 / GB)));

/**
 * The machine's stage budget: `{stages, from: "setting" | "default", file, cpus, memBytes, problem?}`. A setting that
 * cannot be read or is no positive whole number gives the default, with `problem` saying why.
 */
export function machineBudget({ home = homedir(), cpus = availableParallelism(), memBytes = totalmem() } = {}) {
  const file = machineFile(home);
  const fallback = { stages: defaultStages({ cpus, memBytes }), from: "default", file, cpus, memBytes };
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    return e?.code === "ENOENT" ? fallback : { ...fallback, problem: `${file} cannot be read (${e?.code || "error"})` };
  }
  let stages;
  try {
    stages = JSON.parse(raw)?.stages;
  } catch {
    return { ...fallback, problem: `${file} is not JSON` };
  }
  if (!Number.isSafeInteger(stages) || stages < 1) return { ...fallback, problem: `${file}: "stages" is not a positive whole number` };
  return { ...fallback, stages, from: "setting" };
}

/**
 * The per-loop cap: FACTORY_LOCAL_MAX_CONCURRENT when it is a positive whole number, else the machine's budget. The
 * budget binds every loop whatever its cap.
 */
export function loopCap(setting, budget) {
  const n = Number.parseInt(setting, 10);
  return Number.isFinite(n) && n > 0 ? n : budget;
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};

/**
 * Whether a slot's holder is gone: proc.mjs sameProcess; where that cannot tell (no boot id), whether its pid runs at all
 * and, when both start times read, whether that pid started when the record says.
 */
const holderGone = (rec) => {
  const same = sameProcess(rec);
  if (same !== null) return !same;
  const pid = Number(rec?.pid);
  if (!Number.isInteger(pid) || pid <= 1 || !alive(pid)) return true;
  const now = startTime(pid);
  return !!now && /^\d+$/.test(String(rec.start ?? "")) && now !== String(rec.start);
};

/** The order slots were taken in: their precise time, then their file name, so every reader orders them alike. */
const takenOrder = (a, b) => (Number(a.at) || 0) - (Number(b.at) || 0) || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0);

/**
 * The slots held on this machine now: each live holder's record with its `file`. A record whose holder is gone is
 * removed, as is a half-written one (a dot file) older than a minute; with `reap` false (doctor, a reader only) neither
 * is removed, and a gone holder is just not listed.
 */
export function slotHolders(dir = slotsDir(), { reap = true } = {}) {
  const drop = (file) => {
    try {
      if (reap) rmSync(file, { force: true });
    } catch {
      // another reader removed it, or this process may not: it is not counted either way
    }
  };
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const file = join(dir, name);
    if (name.startsWith(".")) {
      try {
        if (Date.now() - statSync(file).mtimeMs > 60_000) drop(file);
      } catch {
        // gone already
      }
      continue;
    }
    if (!name.endsWith(".json")) continue;
    let rec;
    try {
      rec = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (holderGone(rec)) {
      drop(file);
      continue;
    }
    out.push({ ...rec, file });
  }
  return out.sort(takenOrder);
}

let self = null;
/** This process's record, read once: its pid, start time and boot. */
const selfRecord = () => (self ??= processRecord(process.pid));

/** Write a slot file whole: a dot file first, renamed into place, so a reader never sees half of one. */
const writeSlot = (dir, name, rec) => {
  const tmp = join(dir, `.${name}.${randomBytes(4).toString("hex")}`);
  writeNew(tmp, JSON.stringify(rec));
  renameSync(tmp, join(dir, name));
};

/**
 * Take one slot of the machine's budget for this process: a slot handle, or null when the budget is full. The slot is
 * written first and the live slots counted after; when they are over the budget, the slot stays only if it is among the
 * `budget` taken first (`at`, the time it was taken to the microsecond, then its file name). Loops that take the last
 * slot at once all order the slots alike, so one of them keeps it and the others let go. `force`: taken whatever the
 * count (a loop holding no slot always runs one stage). `holder`: what it runs, {repo, issue, stage, cmd}.
 */
export function takeSlot({ dir = slotsDir(), budget, force = false, holder = {} }) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = `${process.pid}-${randomBytes(6).toString("hex")}.json`;
  // `at`: this machine's clock in milliseconds with microseconds (performance's), so two takes in one millisecond order.
  let rec = { ...selfRecord(), ...holder, since: new Date().toISOString(), at: performance.timeOrigin + performance.now() };
  writeSlot(dir, name, rec);
  const file = join(dir, name);
  if (!force) {
    const live = slotHolders(dir);
    const rank = live.findIndex((h) => h.file === file);
    if (live.length > budget && (rank < 0 || rank >= budget)) {
      rmSync(file, { force: true });
      return null;
    }
  }
  return {
    file,
    /** Name what the slot now runs (an issue and its stage). */
    assign(fields) {
      rec = { ...rec, ...fields };
      try {
        writeSlot(dir, name, rec);
      } catch {
        // the slot still counts; only its label is older
      }
    },
    release() {
      rmSync(file, { force: true });
    },
  };
}

/**
 * When the machine counts as saturated, so a loop holds new starts: CPU pressure (Linux PSI, `some` avg60, percent of
 * time a runnable task waited for a CPU over the last minute) at or above `cpuPsi`; without PSI, the 1-minute load
 * average at or above `load` per CPU thread; memory pressure (PSI `some` avg10) at or above `memPsi`; or less than
 * `memAvailable` bytes of memory available (Linux MemAvailable). CPU is judged on the minute, since a busy machine's
 * 10-second CPU pressure swings across any threshold from one tick to the next.
 */
export const PRESSURE = Object.freeze({ cpuPsi: 15, load: 0.9, memPsi: 10, memAvailable: 4 * GB });

/** A PSI file's `some` line's average over `window` (avg10 or avg60), a percent; null when it cannot be read. */
const psiSome = (file, window) => {
  try {
    const m = new RegExp(`^some .*\\b${window}=(\\d+(?:\\.\\d+)?)`, "m").exec(readFileSync(file, "utf8"));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
};

/**
 * The machine's load now, read from `root` (Linux's /proc; a test's own directory laid out the same):
 * `{cpuPsi, memPsi, load, cpus, memAvailable}` (cpuPsi CPU pressure's avg60, memPsi memory pressure's avg10), each null
 * where it cannot be read. Without a loadavg file there, the
 * load is Node's (macOS); MemAvailable is read on Linux only, so elsewhere memory is not judged.
 */
export function readPressure({ root = "/proc", cpus = availableParallelism() } = {}) {
  let load = null;
  try {
    load = Number(readFileSync(join(root, "loadavg"), "utf8").trim().split(/\s+/)[0]);
  } catch {
    load = loadavg()[0];
  }
  let memAvailable = null;
  try {
    const kb = /^MemAvailable:\s+(\d+)\s*kB/m.exec(readFileSync(join(root, "meminfo"), "utf8"))?.[1];
    if (kb) memAvailable = Number(kb) * 1024;
  } catch {
    // not Linux
  }
  return { cpuPsi: psiSome(join(root, "pressure", "cpu"), "avg60"), memPsi: psiSome(join(root, "pressure", "memory"), "avg10"), load: Number.isFinite(load) ? load : null, cpus, memAvailable };
}

const pct = (n) => `${Number(n.toFixed(1))}%`;
const gb = (n) => `${(n / GB).toFixed(1)} GB`;

/** The machine's load as one line, for the tick line and doctor. */
export function pressureLine(p) {
  const cpu = p.cpuPsi !== null ? `CPU pressure ${pct(p.cpuPsi)} over a minute` : p.load !== null ? `load ${p.load.toFixed(1)} on ${p.cpus} CPU threads` : "CPU load unknown";
  const mem = [p.memPsi !== null ? `memory pressure ${pct(p.memPsi)}` : "", p.memAvailable !== null ? `${gb(p.memAvailable)} memory available` : ""].filter(Boolean).join(", ");
  return mem ? `${cpu}, ${mem}` : cpu;
}

/** Why the machine is saturated by PRESSURE (`limits`), `{code: "cpu" | "memory", why}`, or null when it is not. */
export function saturation(p, limits = PRESSURE) {
  if (p.cpuPsi !== null ? p.cpuPsi >= limits.cpuPsi : p.load !== null && p.load >= limits.load * p.cpus) {
    return { code: "cpu", why: p.cpuPsi !== null ? `CPU pressure ${pct(p.cpuPsi)} over a minute (at least ${limits.cpuPsi}%)` : `load ${p.load.toFixed(1)} on ${p.cpus} CPU threads (at least ${limits.load} per thread)` };
  }
  if (p.memPsi !== null && p.memPsi >= limits.memPsi) return { code: "memory", why: `memory pressure ${pct(p.memPsi)} (at least ${limits.memPsi}%)` };
  if (p.memAvailable !== null && p.memAvailable < limits.memAvailable) return { code: "memory", why: `${gb(p.memAvailable)} memory available (under ${gb(limits.memAvailable)})` };
  return null;
}

/**
 * How many new stages a loop may start now (resumes count as starts): `{room, force, why, budget, held, pressure}`.
 * `running`: the stages this loop holds; `cap`: its own cap (loopCap). Room is what the machine's budget and the loop's
 * cap leave, and none while the machine is saturated; but a loop that holds no stage may always start one (`force`),
 * so no loop waits forever behind the others or behind work outside Factory. `why` says what holds starts, or null.
 */
export function machineRoom({ running, cap, budget, held, pressure }) {
  const sat = saturation(pressure);
  const free = Math.max(0, budget - held);
  const mine = Math.max(0, cap - running);
  let room = sat ? 0 : Math.min(free, mine);
  const holds = `${held} of ${budget} stage(s) held on this machine`;
  let why = sat ? `the machine is saturated: ${sat.why}` : free === 0 ? `the machine's budget is full (${holds})` : free < mine ? `the machine's budget has room for ${free} more (${holds})` : null;
  const force = running === 0 && room === 0 && mine > 0;
  if (force) {
    room = 1;
    why = `${why}; one stage starts, as this loop holds none`;
  }
  return { room, force, why, budget, held, pressure };
}
