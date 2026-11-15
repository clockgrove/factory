// A machine's load as lib/machine.mjs readPressure reads it, in a directory laid out as Linux's /proc: pressure/cpu,
// pressure/memory, loadavg and meminfo. Tests hand its path to the code under test, so no test reads or holds this
// machine's own slots or load.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const psi = (avg10, avg60) => `some avg10=${avg10.toFixed(2)} avg60=${avg60.toFixed(2)} avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=1\n`;

/**
 * Write (or rewrite) the load in `dir`: `cpu` and `mem` the PSI `some` percents, both its avg10 and its avg60 unless
 * `cpu10` gives CPU's avg10 apart (null: no pressure files, as on a kernel without PSI), `load` the 1-minute load
 * average, `availGb` MemAvailable. Returns `dir`.
 */
export function fakeProc(dir, { cpu = 0, cpu10 = cpu, mem = 0, load = 0.5, availGb = 32 } = {}) {
  mkdirSync(join(dir, "pressure"), { recursive: true });
  if (cpu !== null) writeFileSync(join(dir, "pressure", "cpu"), psi(cpu10, cpu));
  if (mem !== null) writeFileSync(join(dir, "pressure", "memory"), psi(mem, mem));
  writeFileSync(join(dir, "loadavg"), `${load.toFixed(2)} 0.00 0.00 1/100 1\n`);
  writeFileSync(join(dir, "meminfo"), `MemTotal:       47185920 kB\nMemFree:         1000000 kB\nMemAvailable:   ${Math.round(availGb * 1024 * 1024)} kB\n`);
  return dir;
}

/** A home of its own whose machine budget is `stages` (machine.json), so a test never takes the budget from the size of the machine it runs on. */
export function budgetHome(stages = 8) {
  const dir = mkdtempSync(join(tmpdir(), "home-"));
  mkdirSync(join(dir, ".cache", "factory"), { recursive: true });
  writeFileSync(join(dir, ".cache", "factory", "machine.json"), JSON.stringify({ stages }));
  return dir;
}
