// One machine's room for Factory's local stages, shared by every local loop on it (serve and run, any repository, any
// harness login): the machine's stage budget, the slots its loops hold against it, and how loaded the machine is now.
// Both live under the user's ~/.cache/factory, which no sandbox may write:
//   machine.json   {"stages": N}: the budget, set once per machine; without it, from the machine's size (defaultStages);
//                  beside it the machine's limits (machineLimits): when it counts as saturated, and how long a usage
//                  limit with no reset passes an account over
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
import { SPENT_GUESS_MS } from "./holds.mjs";
import { GUESS_MAX_HOURS, guessHoursValid } from "./inputs.mjs";
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
  const fallback = { stages: defaultStages({ cpus, memBytes }), from: "default", file: machineFile(home), cpus, memBytes };
  const { data, problem } = readMachine(home);
  if (problem) return { ...fallback, problem };
  const stages = data?.stages;
  if (stages === undefined) return fallback;
  if (!Number.isSafeInteger(stages) || stages < 1) return { ...fallback, problem: `${fallback.file}: "stages" is not a positive whole number` };
  return { ...fallback, stages, from: "setting" };
}

/** machine.json as `{data}` (null when there is none), or `{problem}` when it cannot be read or is not a JSON object. */
function readMachine(home) {
  const file = machineFile(home);
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    return e?.code === "ENOENT" ? { data: null } : { problem: `${file} cannot be read (${e?.code || "error"})` };
  }
  try {
    const data = JSON.parse(raw);
    return data && typeof data === "object" && !Array.isArray(data) ? { data } : { problem: `${file} is not a JSON object` };
  } catch {
    return { problem: `${file} is not JSON` };
  }
}

/** machine.json's names for PRESSURE's limits (`available_gb` in GB, memAvailable in bytes), each a number above 0. */
const PRESSURE_KEYS = { cpu_psi: "cpuPsi", load: "load", memory_psi: "memPsi", available_gb: "memAvailable" };

/**
 * The machine's limits a person owns, from machine.json beside `stages`: `pressure` (an object of PRESSURE_KEYS's
 * names, each optional) is when the machine counts as saturated (saturation); `guess_hours` (a list of hours, each
 * above 0 and at most inputs.mjs GUESS_MAX_HOURS) is how long automatic account choice passes over an account whose usage limit reported no reset, by how
 * many in a row (holds.mjs SPENT_GUESS_MS). Returns `{pressure, guessMs, from: {pressure, guess}, file, problems}`:
 * a value that is not given, or cannot be used (named in `problems`), is Factory's default.
 */
export function machineLimits({ home = homedir() } = {}) {
  const file = machineFile(home);
  const { data, problem } = readMachine(home);
  const problems = problem ? [problem] : [];
  const pressure = { ...PRESSURE };
  const from = { pressure: "default", guess: "default" };
  const given = data?.pressure;
  if (given !== undefined && (!given || typeof given !== "object" || Array.isArray(given))) problems.push(`${file}: "pressure" is not an object`);
  else if (given) {
    for (const [k, v] of Object.entries(given)) {
      const to = Object.hasOwn(PRESSURE_KEYS, k) ? PRESSURE_KEYS[k] : null;
      if (!to) problems.push(`${file}: "pressure" has no limit "${k}" (${Object.keys(PRESSURE_KEYS).join(", ")})`);
      else if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) problems.push(`${file}: "pressure.${k}" is not a number above 0`);
      else {
        pressure[to] = to === "memAvailable" ? v * GB : v;
        from.pressure = "setting";
      }
    }
  }
  let guessMs = SPENT_GUESS_MS;
  const hours = data?.guess_hours;
  if (hours !== undefined) {
    if (!guessHoursValid(hours)) problems.push(`${file}: "guess_hours" is not a list of hours, each above 0 and at most ${GUESS_MAX_HOURS}`);
    else {
      guessMs = hours.map((h) => h * 3600_000);
      from.guess = "setting";
    }
  }
  return { pressure: Object.freeze(pressure), guessMs, from, file, problems };
}

/** The limits in force as one line, for doctor: when the machine counts as saturated, and the no-reset guess's steps. */
export function limitsLine({ pressure, guessMs }) {
  const h = (ms) => `${Number((ms / 3600_000).toFixed(2))} h`;
  return `saturated at CPU pressure ${pressure.cpuPsi}% over a minute (without PSI, a load of ${pressure.load} per CPU thread), memory pressure ${pressure.memPsi}%, or under ${gb(pressure.memAvailable)} memory available; a usage limit with no reset passes its account over for ${guessMs.map(h).join(", ")} by how many in a row`;
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

/** A dot file older than this is a killed writer's leftover: far longer than any take stalls (a stopped or suspended loop). */
const STALE_DOT_MS = 10 * 60_000;
/** A slot file that does not parse counts as held this long after it was written, then as free. */
const UNPARSED_HELD_MS = 5 * 60_000;
/** A slot file of the one-file-per-holder layout, <pid>-<nonce>.json: removed once its pid has ended, never counted. */
const OLD_SLOT = /^(\d+)-[0-9a-f]+\.json$/;

/**
 * The slot files in `dir`: a Map of slot number to its generations, highest first. When `reap`, a dot file older than
 * STALE_DOT_MS and an OLD_SLOT file whose pid has ended are removed.
 */
function slotFiles(dir, reap) {
  const by = new Map();
  for (const name of readdirSync(dir)) {
    const old = OLD_SLOT.exec(name);
    if (name.startsWith(".") || old) {
      try {
        if (reap && (old ? !alive(Number(old[1])) : Date.now() - statSync(join(dir, name)).mtimeMs > STALE_DOT_MS)) rmSync(join(dir, name), { force: true });
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

/** A slot that counts as held without a record of its holder: its file cannot be read, or does not parse yet. */
const UNKNOWN = Object.freeze({ unknown: true });

/**
 * A slot file's content: its record or `{free: true}`; undefined when the file is gone (a higher generation replaced
 * it). UNKNOWN when it cannot be read, or does not parse and is younger than UNPARSED_HELD_MS: every slot file is
 * written whole, so such a file is no loop's and frees once it is older; until then no loop takes the slot over it.
 */
const readSlot = (file) => {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    return e?.code === "ENOENT" ? undefined : UNKNOWN;
  }
  try {
    const rec = JSON.parse(raw);
    if (rec && typeof rec === "object") return rec;
  } catch {
    // judged by its age below
  }
  try {
    return Date.now() - statSync(file).mtimeMs < UNPARSED_HELD_MS ? UNKNOWN : { free: true };
  } catch (e) {
    return e?.code === "ENOENT" ? undefined : UNKNOWN;
  }
};

/** Whether a slot's content holds it: UNKNOWN, or a record whose holder still runs. */
const holds = (rec) => rec === UNKNOWN || (!!rec && !rec.free && !holderGone(rec));

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
 * The slots held on this machine now, by slot number: each live holder's record with its `file` and `slot` (a slot held
 * without a readable record has only those two). A slot whose holder is gone holds nothing; when `reap`, the
 * generations below each slot's highest are removed, as are a killed writer's dot files. A slot whose highest
 * generation keeps moving while it is read counts as held. Doctor reads with `reap` false and removes nothing.
 */
export function slotHolders(dir = slotsDir(), { reap = true } = {}) {
  let by;
  try {
    by = slotFiles(dir, reap);
  } catch {
    return [];
  }
  const out = [];
  for (const [slot, listed] of [...by].sort((a, b) => a[0] - b[0])) {
    let gens = listed;
    let file = null;
    let rec;
    for (let look = 0; look < 5 && gens?.length; look += 1) {
      file = join(dir, slotName(slot, gens[0]));
      rec = readSlot(file);
      if (rec !== undefined) break;
      // a loop took this slot's next generation since the listing: list it again
      gens = slotFiles(dir, false).get(slot);
    }
    if (!gens?.length) continue;
    if (rec === undefined) rec = UNKNOWN;
    if (reap) dropBelow(dir, slot, gens);
    if (holds(rec)) out.push(rec === UNKNOWN ? { file, slot } : { ...rec, file, slot });
  }
  return out;
}

let self = null;
/** This process's record, read once: its pid, start time and boot. */
const selfRecord = () => (self ??= processRecord(process.pid));

/** A dot file beside slot file `file` to write it whole in: readers skip dot files. */
const tempFor = (file) => join(dirname(file), `.${basename(file)}.${randomBytes(4).toString("hex")}`);

/**
 * Write `rec` whole to a dot file beside `file` and `place` it (rename or link). A take stalled past STALE_DOT_MS finds
 * its dot file removed (ENOENT): it writes it again and places it once more.
 */
const viaDot = (file, rec, place) => {
  for (let tries = 0; ; tries += 1) {
    const tmp = tempFor(file);
    writeNew(tmp, JSON.stringify(rec));
    try {
      return place(tmp);
    } catch (e) {
      if (e?.code !== "ENOENT" || tries > 0) throw e;
    } finally {
      rmSync(tmp, { force: true });
    }
  }
};

/** Replace a slot file whole: a dot file first, renamed into place, so a reader never sees half of one. */
const writeSlot = (file, rec) => viaDot(file, rec, (tmp) => renameSync(tmp, file));

/** Create slot file `file` whole, only if no file has that name: true when this call created it. */
const linkSlot = (file, rec) =>
  viaDot(file, rec, (tmp) => {
    try {
      linkSync(tmp, file);
      return true;
    } catch (e) {
      if (e?.code === "EEXIST") return false;
      throw e;
    }
  });

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
      if (holds(cur)) return null;
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
 * The live slots are counted again once it is taken: a forced slot at or above the budget counts too, and loops that
 * took two free slots below it at once may together be over the budget, so a loop that finds it over lets its slot go
 * (both may, and then neither runs this tick). `force`: taken whatever the count, as the first free slot of any number
 * (a loop holding no slot always runs one stage). `holder`: what it runs, {repo, issue, stage, cmd}. `afterCount`: a
 * test's hook, run between the first count and the take.
 */
export function takeSlot({ dir = slotsDir(), budget, force = false, holder = {}, afterCount = null }) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let rec = { ...selfRecord(), ...holder, since: new Date().toISOString() };
  if (!force && slotHolders(dir).length >= budget) return null;
  afterCount?.();
  let file = null;
  for (let slot = 0; !file && (force || slot < budget); slot += 1) file = claimSlot(dir, slot, rec);
  if (!file) return null;
  if (!force && slotHolders(dir).length > budget) {
    try {
      writeSlot(file, { free: true });
    } catch {
      // the record still names this process: the slot frees when it ends
    }
    return null;
  }
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
 * `limits`: when the machine counts as saturated (machineLimits's `pressure`).
 */
export function machineRoom({ running, cap, budget, held, pressure, limits = PRESSURE }) {
  const sat = saturation(pressure, limits);
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
