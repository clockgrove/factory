// Shared by the service-*.test.mjs files: the service's record, and an
// installation whose GitHub never answers.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configured, silentServer } from "../helpers.mjs";

/** The service's record, `service.json`. */
export const recordOf = (inst) => {
  try {
    return JSON.parse(readFileSync(join(inst.root, "service.json"), "utf8"));
  } catch {
    return {};
  }
};

/**
 * A configured installation whose GitHub never answers, so every check
 * that starts stays running. Each start still gives up on the Project's
 * repositories and starts unchecked, after 200 ms rather than 5 s.
 */
export async function stalled(inst, fields = {}) {
  configured(
    inst,
    `http://127.0.0.1:${await silentServer()}`,
    { FACTORY_PROJECT_START_MS: "200" },
    fields,
  );
}
