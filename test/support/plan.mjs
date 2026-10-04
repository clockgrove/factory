import { createHash } from "node:crypto";
import { compilePlan as compileRecordedPlan } from "../../dist/compiler.js";
import { resolveAutonomy } from "../../dist/repair-policy.js";

/**
 * compilePlan over a fresh in-memory ledger with the default autonomy unless
 * the test passes its own recovery context (argument 9), as `factory plan`
 * does. Arguments as compilePlan; an omitted configDigest is a fixed one.
 */
export function compilePlan(
  objective,
  body,
  baseSha,
  checkout,
  model,
  configDigest = createHash("sha256")
    .update("unbound-test-configuration")
    .digest("hex"),
  observe,
  executionProfiles,
  recovery = { state: { autonomy: resolveAutonomy() }, save() {} },
  ...rest
) {
  return compileRecordedPlan(
    objective,
    body,
    baseSha,
    checkout,
    model,
    configDigest,
    observe,
    executionProfiles,
    recovery,
    ...rest,
  );
}

/** The answer of a planning diagnosis that asks for `correction`. */
export const planningDiagnosis = (correction) => ({
  kind: "planning-output",
  diagnosis: "The plan needs a correction.",
  correction,
});
