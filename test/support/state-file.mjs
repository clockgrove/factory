// Write a state snapshot as-is. Only for tests that tamper with state to
// check that a load refuses it: saveState refuses to write invalid state.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function writeStateFile(path, state) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}
