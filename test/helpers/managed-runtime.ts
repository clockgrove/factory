import type { RuntimeBundleRequirement } from "../../src/runtime/toolchain-bundle.js";
import { activeRuntimeBundleSync } from "../../src/runtime/toolchain-store.js";
import { managedRuntimeRequirements } from "../../src/toolchains/authority.js";

export function selectedManagedRuntimeRequirements(
  commands: readonly string[],
): RuntimeBundleRequirement[] {
  const requirements = managedRuntimeRequirements(commands);
  if (requirements.length === 0) return [];
  const receipt = activeRuntimeBundleSync("pnpm");
  return requirements.map((requirement) => ({
    ...requirement,
    bundleDigest: receipt.digest,
  }));
}
