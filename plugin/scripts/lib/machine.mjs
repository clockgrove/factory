// One machine's room for Factory's local stages, shared by every local loop on it (serve and run, any repository, any
// harness login): the machine's stage budget, the slots its loops hold against it, and how loaded the machine is now.
// Both live under the user's ~/.cache/factory, which no sandbox may write:
//   machine.json   {"stages": N}: the budget, set once per machine; without it, from the machine's size (defaultStages)
//   slots/         numbered slots, each a file <slot>.<generation>.json: its holder's process record (pid, start time,
//                  boot) and what it runs (repository, issue, stage), or {"free": true} once let go
// A slot's highest generation says who holds it. Taking a slot is creating its next generation, which the file system
// lets exactly one loop do (a hard link, refused when the name exists), so two loops never hold one slot. A slot frees
// itself when its holder dies: a record whose process is gone (another boot, no such pid, or a pid whose start time
// differs) holds nothing, so a crash, a SIGKILL or a reboot leaves nothing held. The highest generation is never
// removed (a name removed could be taken again by a loop that read the slot before), only the generations below it.
import { randomBytes } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { availableParallelism, homedir, loadavg, totalmem } from "node:os";
import { basename, dirname, join } from "node:path";
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

const SLOT = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.json$/;
const slotName = (slot, gen) => `${slot}.${gen}.json`;

/**
 * The slot files in `dir`: a Map of slot number to its generations, highest first. A dot file (one being written) older
 * than a minute is a leftover of a killed writer and is removed when `reap`.
 */
function slotFiles(dir, reap) {
  const by = new Map();
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) {
      try {
        if (reap && Date.now() - statSync(join(dir, name)).mtimeMs > 60_000) rmSync(join(dir, name), { force: true });
      } catch {
        // gone already, or this process may not remove it
      }
      continue;
    }
    const m = SLOT.exec(name);
    if (!m) continue;
    const slot = Number(m[1]);
    by.set(slot, [...(by.get(slot) || []), Number(m[2])]);
  }
  for (const gens of by.values()) gens.sort((a, b) => b - a);
  return by;
}

/**
 * A slot file's content: its record or `{free: true}`; undefined when the file is gone (a higher generation replaced
 * it), null when it cannot be read (it names no holder, and no loop takes the slot over it).
 */
const readSlot = (file) => {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    return e?.code === "ENOENT" ? undefined : null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    // every slot file is written whole (writeSlot, linkSlot): one that does not parse names no holder
    return { free: true };
  }
};

/** Whether a slot's content holds it: a record whose holder still runs. */
const holds = (rec) => !!rec && !rec.free && !holderGone(rec);

/** Remove a slot's generations below its highest: none of them says anything any more. */
const dropBelow = (dir, slot, gens) => {
  for (const gen of gens.slice(1)) {
    try {
      rmSync(join(dir, slotName(slot, gen)), { force: true });
    } catch {
      // this process may not remove it: a lower generation is never read
    }
  }
};

/**
 * The slots held on this machine now, by slot number: each live holder's record with its `file` and `slot`. A slot whose
 * holder is gone holds nothing; when `reap`, the generations below each slot's highest are removed, as are dot files a
 * killed writer left. Doctor reads with `reap` false and removes nothing.
 */
export function slotHolders(dir = slotsDir(), { reap = true } = {}) {
  let out = [];
  for (let look = 0; look < 5; look += 1) {
    let by;
    try {
      by = slotFiles(dir, reap);
    } catch {
      return [];
    }
    out = [];
    let moved = false;
    for (const [slot, gens] of [...by].sort((a, b) => a[0] - b[0])) {
      const file = join(dir, slotName(slot, gens[0]));
      const rec = readSlot(file);
      if (rec === undefined) {
        // a loop took this slot's next generation since the listing: list again
        moved = true;
        break;
      }
      if (reap) dropBelow(dir, slot, gens);
      if (holds(rec)) out.push({ ...rec, file, slot });
    }
    if (!moved) break;
  }
  return out;
}

let self = null;
/** This process's record, read once: its pid, start time and boot. */
const selfRecord = () => (self ??= processRecord(process.pid));

/** A dot file beside slot file `file` to write it whole in: readers skip dot files. */
const tempFor = (file) => join(dirname(file), `.${basename(file)}.${randomBytes(4).toString("hex")}`);

/** Replace a slot file whole: a dot file first, renamed into place, so a reader never sees half of one. */
const writeSlot = (file, rec) => {
  const tmp = tempFor(file);
  writeNew(tmp, JSON.stringify(rec));
  renameSync(tmp, file);
};

/** Create slot file `file` whole, only if no file has that name: true when this call created it. */
const linkSlot = (file, rec) => {
  const tmp = tempFor(file);
  writeNew(tmp, JSON.stringify(rec));
  try {
    linkSync(tmp, file);
    return true;
  } catch (e) {
    if (e?.code === "EEXIST") return false;
    throw e;
  } finally {
    rmSync(tmp, { force: true });
  }
};

/**
 * Take slot `slot` for `rec` when nobody holds it: its file, or null when a live holder has it. The slot's next
 * generation is created only if no file has that name, so of loops taking it at once exactly one creates it. When a
 * higher generation turns up after (this loop read a listing older than a generation since removed), the new file is
 * withdrawn and the slot read again.
 */
function claimSlot(dir, slot, rec) {
  for (let look = 0; look < 8; look += 1) {
    const gens = slotFiles(dir, false).get(slot) || [];
    if (gens.length) {
      const cur = readSlot(join(dir, slotName(slot, gens[0])));
      if (cur === undefined) continue;
      if (cur === null || holds(cur)) return null;
    }
    const gen = gens.length ? gens[0] + 1 : 0;
    const file = join(dir, slotName(slot, gen));
    if (!linkSlot(file, rec)) continue;
    const now = slotFiles(dir, false).get(slot) || [];
    if (now[0] !== gen) {
      rmSync(file, { force: true });
      continue;
    }
    dropBelow(dir, slot, now);
    return file;
  }
  return null;
}

/**
 * Take one slot of the machine's budget for this process: a slot handle, or null when the budget is full. When the
 * live slots already reach the budget, none is taken; otherwise the first free slot of 0 .. budget-1 is, and loops
 * taking the last one at once cannot both have it (claimSlot), so one keeps it and the others find the budget full.
 * `force`: taken whatever the count, as the first free slot of any number (a loop holding no slot always runs one
 * stage). `holder`: what it runs, {repo, issue, stage, cmd}.
 */
export function takeSlot({ dir = slotsDir(), budget, force = false, holder = {} }) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let rec = { ...selfRecord(), ...holder, since: new Date().toISOString() };
  if (!force && slotHolders(dir).length >= budget) return null;
  let file = null;
  for (let slot = 0; !file && (force || slot < budget); slot += 1) file = claimSlot(dir, slot, rec);
  if (!file) return null;
  let held = true;
  return {
    file,
    /** Name what the slot now runs (an issue and its stage). */
    assign(fields) {
      if (!held) return;
      rec = { ...rec, ...fields };
      try {
        writeSlot(file, rec);
      } catch {
        // the slot still counts; only its label is older
      }
    },
    /** Let the slot go: its file says free (the file stays, the slot's highest generation). */
    release() {
      if (!held) return;
      held = false;
      try {
        writeSlot(file, { free: true });
      } catch {
        // the record still names this process, which frees the slot when it ends
      }
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
