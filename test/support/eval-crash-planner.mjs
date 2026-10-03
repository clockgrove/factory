import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** `--planning-model` that leaves a truncated result.json and dies mid-run. */
export function createPlanningModel({ directory }) {
  writeFileSync(join(directory, "result.json"), '{"planned": tr');
  process.exit(3);
}
