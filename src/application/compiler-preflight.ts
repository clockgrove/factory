import { inspectLocalCheckout } from "./checkout.js";
import { validateCompilerRepositoryAuthority } from "../compiler/proposal.js";
import { destinationAllowedByPolicy } from "../protocol/policy.js";
import {
  readPinnedCompilerFacts,
  type PinnedRepositoryFacts,
} from "../repository-profiles/index.js";
import { compilerCapabilitiesForRepository } from "../toolchains/compiler-capabilities.js";
import type { ExecutionRequirements } from "../protocol/worker-packet.js";
import type { RunPolicy } from "../protocol/policy.js";
import type { BackendRegistry } from "../execution/registry.js";
import {
  assessExecutionRouteAvailability,
  assessExecutionTrustRoutes,
  executionRouteCatalog,
  type ExecutionRouteCatalog,
} from "../execution/route-capabilities.js";

export function assessPinnedCompilerPreflight(
  pinned: PinnedRepositoryFacts,
  allowedNetworkDestinations: readonly string[],
  execution: {
    routes: ExecutionRouteCatalog;
    trust?: ExecutionRequirements["trust"];
  },
) {
  const capabilities = compilerCapabilitiesForRepository(pinned, allowedNetworkDestinations);
  const validation = validateCompilerRepositoryAuthority(capabilities, allowedNetworkDestinations);
  const paths = new Set(pinned.relevantPaths);
  const toolchains = capabilities.toolchains.map((toolchain) => ({
    adapterId: toolchain.adapterId,
    state: toolchain.state,
    rootAuthorityPaths: toolchain.rootAuthorityPaths,
    presentAuthorityPaths: toolchain.rootAuthorityPaths.filter((path) => paths.has(path)),
    missingAuthorityPaths: toolchain.rootAuthorityPaths.filter((path) => !paths.has(path)),
    deniedNetworkDestinations: toolchain.networkDestinations.filter(
      (destination) => !destinationAllowedByPolicy(destination, [...allowedNetworkDestinations]),
    ),
    validationRecipeCount: capabilities.validationRecipes.filter(
      (recipe) => recipe.adapterId === toolchain.adapterId,
    ).length,
  }));
  const routeAssessment = execution.trust
    ? assessExecutionTrustRoutes(execution.routes, execution.trust)
    : assessExecutionRouteAvailability(execution.routes);
  return {
    result:
      validation.status === "valid" && routeAssessment.result !== "blocked"
        ? ("passed" as const)
        : ("blocked" as const),
    baseSha: pinned.baseSha,
    pinnedFactsDigest: pinned.digest,
    validationRecipeCount: capabilities.validationRecipes.length,
    eligibleDeferredAdapters: toolchains
      .filter(({ state }) => state === "eligible-deferred")
      .map(({ adapterId }) => adapterId),
    toolchains,
    validation,
    execution: routeAssessment,
  };
}

/** Read-only qualification boundary over the same exact Git objects used by
 * compiler request preparation. No checkout bytes, hooks, filters, installs,
 * provider calls, or repository mutations participate. */
export async function inspectCompilerPreflight(input: {
  checkout: string;
  baseSha: string;
  policy: RunPolicy;
  registry: Pick<BackendRegistry, "capabilities" | "get">;
  executionTrust?: ExecutionRequirements["trust"];
}) {
  const checkout = await inspectLocalCheckout(input.checkout);
  if (checkout.head.toLowerCase() !== input.baseSha.toLowerCase())
    throw new Error("compiler preflight checkout differs from the exact selected base");
  const pinned = await readPinnedCompilerFacts(
    checkout.root,
    checkout.head.toLowerCase(),
    checkout.files,
  );
  return assessPinnedCompilerPreflight(pinned, input.policy.allowedNetworkDestinations, {
    routes: executionRouteCatalog(input.registry, input.policy),
    ...(input.executionTrust ? { trust: input.executionTrust } : {}),
  });
}
