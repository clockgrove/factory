import { createHash } from "node:crypto";

import {
  CompilerToolchainCapabilitySchema,
  CompilerValidationRecipeSchema,
  type CompilerToolchainCapability,
  type CompilerValidationRecipe,
} from "../compiler/contracts.js";
import {
  discoverValidationCommands,
  normalizeRepositoryFacts,
  observedValidationScriptNames,
  type PinnedRepositoryFacts,
} from "../repository-profiles/index.js";
import { scopeOwnsPath, type CapabilityOperation } from "../repository-capabilities/model.js";
import { destinationAllowedByPolicy } from "../protocol/policy.js";
import {
  TOOLCHAIN_AUTHORITY_ADAPTERS,
  toolchainAdapterById,
  type ToolchainAuthorityAdapter,
} from "./authority.js";

export interface CompilerRepositoryCapabilities {
  validationRecipes: CompilerValidationRecipe[];
  toolchains: CompilerToolchainCapability[];
}

const uniqueSorted = (values: readonly string[]) => [...new Set(values)].sort();

function recipeId(command: string): string {
  return `recipe-${createHash("sha256").update(command).digest("hex").slice(0, 16)}`;
}

function capability(
  adapter: ToolchainAuthorityAdapter,
  state: CompilerToolchainCapability["state"],
): CompilerToolchainCapability {
  const contract = adapter.compiler;
  if (!contract)
    return CompilerToolchainCapabilitySchema.parse({
      adapterId: adapter.id,
      state: "unsupported",
      contract: "clockgrove.factory/toolchain-compiler/unsupported",
      rootAuthorityPaths: adapter.requiredRootPaths,
      generationAuthorityPaths: [],
      requiredTools: [],
      networkDestinations: [],
      runtimePins: [],
      mixedAuthority: "reject",
      descendants: { allowed: false, requiresTransitiveProviderAncestor: false },
      operation: null,
    });
  return CompilerToolchainCapabilitySchema.parse({
    adapterId: adapter.id,
    state,
    contract: contract.contract,
    rootAuthorityPaths: [...contract.rootAuthorityPaths],
    generationAuthorityPaths: [...contract.generationAuthorityPaths],
    requiredTools: [...contract.requiredTools],
    networkDestinations: [...contract.networkDestinations],
    runtimePins: contract.runtimePins.map((pin) => ({
      path: pin.path,
      fields: [...pin.fields],
      source: pin.source,
    })),
    mixedAuthority: contract.mixedAuthority,
    descendants: { ...contract.descendants },
    operation: contract.operation
      ? {
          kind: contract.operation.kind,
          keySchema: { ...contract.operation.keySchema },
          providerCommandCount: { ...contract.operation.providerCommandCount },
          maxProvisionedOperations: contract.operation.maxProvisionedOperations,
        }
      : null,
  });
}

function supportedStates(
  pinned: PinnedRepositoryFacts,
  allowedDestinations: ReadonlySet<string>,
): Map<string, CompilerToolchainCapability["state"]> {
  const paths = new Set(pinned.relevantPaths);
  const supported = TOOLCHAIN_AUTHORITY_ADAPTERS.filter((adapter) => adapter.compiler);
  const result = new Map<string, CompilerToolchainCapability["state"]>();
  const groups = new Map<string, ToolchainAuthorityAdapter[]>();
  for (const adapter of supported)
    if (adapter.compiler!.authorityGroup)
      groups.set(adapter.compiler!.authorityGroup, [
        ...(groups.get(adapter.compiler!.authorityGroup) ?? []),
        adapter,
      ]);
  for (const adapters of groups.values()) {
    const common = new Set(adapters[0]!.compiler!.rootAuthorityPaths);
    for (const adapter of adapters.slice(1))
      for (const path of common)
        if (!adapter.compiler!.rootAuthorityPaths.includes(path)) common.delete(path);
    const owners = adapters.filter((adapter) =>
      adapter.compiler!.rootAuthorityPaths.some((path) => !common.has(path) && paths.has(path)),
    );
    if (owners.length > 1) {
      for (const adapter of adapters) result.set(adapter.id, "mixed");
    } else if (owners.length === 1) {
      const owner = owners[0]!;
      for (const adapter of adapters)
        result.set(
          adapter.id,
          adapter.id !== owner.id
            ? "unsupported"
            : owner.compiler!.rootAuthorityPaths.every((path) => paths.has(path))
              ? "observed"
              : "partial",
        );
    } else if ([...common].some((path) => paths.has(path))) {
      for (const adapter of adapters) result.set(adapter.id, "partial");
    } else {
      for (const adapter of adapters) {
        const denied = adapter.compiler!.networkDestinations.some(
          (destination) => !destinationAllowedByPolicy(destination, [...allowedDestinations]),
        );
        result.set(adapter.id, denied ? "policy-blocked" : "eligible-deferred");
      }
    }
  }

  for (const adapter of supported.filter((candidate) => !candidate.compiler!.authorityGroup)) {
    const present = adapter.compiler!.rootAuthorityPaths.filter((path) => paths.has(path));
    if (present.length === adapter.compiler!.rootAuthorityPaths.length)
      result.set(adapter.id, "observed");
    else if (present.length > 0) result.set(adapter.id, "partial");
    else {
      const unsupportedSource = [...paths].some((path) =>
        (adapter.compiler!.unsupportedWithoutAuthorityExtensions ?? []).some((extension) =>
          path.endsWith(extension),
        ),
      );
      const denied = adapter.compiler!.networkDestinations.some(
        (destination) => !destinationAllowedByPolicy(destination, [...allowedDestinations]),
      );
      result.set(
        adapter.id,
        unsupportedSource ? "unsupported" : denied ? "policy-blocked" : "eligible-deferred",
      );
    }
  }
  return result;
}

function adapterRecipes(
  adapter: ToolchainAuthorityAdapter,
  pinned: PinnedRepositoryFacts,
): CompilerValidationRecipe[] {
  const operation = adapter.compiler?.operation;
  if (!operation) return [];
  const scripts = observedValidationScriptNames(pinned.repository);
  const operations =
    adapter.compiler!.observedRecipeSource === "python-test"
      ? /\[tool\.pytest(?:\.ini_options)?\]/.test(
          pinned.repository.documents?.["pyproject.toml"] ?? "",
        ) || pinned.relevantPaths.includes("pytest.ini")
        ? [operation.observed("test")]
        : []
      : adapter.compiler!.observedRecipeSource === "package-scripts"
        ? scripts.map((script) => operation.observed(script))
        : [];
  return operations.flatMap((candidate) => {
    if (!candidate) return [];
    const command = operation.format(candidate);
    if (
      !command ||
      operation.parse(command)?.kind !== candidate.kind ||
      operation.parse(command)?.key !== candidate.key
    )
      throw new Error(`toolchain compiler operation round trip failed for ${adapter.id}`);
    return [
      CompilerValidationRecipeSchema.parse({
        id: recipeId(command),
        command,
        adapterId: adapter.id,
        requiredTools: [...adapter.compiler!.requiredTools],
        networkDestinations: [],
      }),
    ];
  });
}

function genericRecipes(pinned: PinnedRepositoryFacts): CompilerValidationRecipe[] {
  const adapterCommands = new Set(
    TOOLCHAIN_AUTHORITY_ADAPTERS.flatMap((adapter) =>
      adapter.compiler?.operation
        ? discoverValidationCommands(pinned.repository).filter(
            (command) => adapter.compiler!.operation!.parse(command) !== null,
          )
        : [],
    ),
  );
  return discoverValidationCommands(pinned.repository)
    .filter((command) => {
      const runner = command.split(/\s+/)[0];
      return (
        !adapterCommands.has(command) &&
        !["cargo", "go", "python", "python3", "pytest", "ruff", "mypy"].includes(runner ?? "")
      );
    })
    .map((command) =>
      CompilerValidationRecipeSchema.parse({
        id: recipeId(command),
        command,
        adapterId: null,
        requiredTools: [command.split(/\s+/)[0]!],
        networkDestinations: [],
      }),
    );
}

/** Pure prompt-safe capability selection over immutable facts and accepted policy. */
export function compilerCapabilitiesForRepository(
  pinnedInput: PinnedRepositoryFacts,
  allowedDestinationsInput: readonly string[],
): CompilerRepositoryCapabilities {
  const pinned = {
    ...pinnedInput,
    repository: normalizeRepositoryFacts(pinnedInput.repository),
    manifests: uniqueSorted(pinnedInput.manifests),
    relevantPaths: uniqueSorted(pinnedInput.relevantPaths),
  };
  const allowedDestinations = new Set(uniqueSorted(allowedDestinationsInput));
  const states = supportedStates(pinned, allowedDestinations);
  const toolchains = TOOLCHAIN_AUTHORITY_ADAPTERS.filter(
    (adapter) =>
      adapter.compiler ||
      adapter.requiredRootPaths.some((path) => pinned.relevantPaths.includes(path)),
  )
    .map((adapter) => capability(adapter, states.get(adapter.id) ?? "unsupported"))
    .sort((left, right) => left.adapterId.localeCompare(right.adapterId));
  const observedAdapters = TOOLCHAIN_AUTHORITY_ADAPTERS.filter(
    (adapter) => states.get(adapter.id) === "observed",
  );
  const validationRecipes = [
    ...observedAdapters.flatMap((adapter) => adapterRecipes(adapter, pinned)),
    ...genericRecipes(pinned),
  ]
    .sort((left, right) => left.id.localeCompare(right.id))
    .filter(
      (recipe, index, all) => all.findIndex((candidate) => candidate.id === recipe.id) === index,
    );
  return { validationRecipes, toolchains };
}

export function formatCompilerOperation(
  adapterId: string,
  operation: CapabilityOperation,
): string | null {
  return toolchainAdapterById(adapterId)?.compiler?.operation?.format(operation) ?? null;
}

export function parseCompilerOperation(
  adapterId: string,
  command: string,
): CapabilityOperation | null {
  return toolchainAdapterById(adapterId)?.compiler?.operation?.parse(command) ?? null;
}

export function proposalScopeOwnsAuthority(
  scope: readonly string[],
  adapterId: string,
  root: boolean,
): boolean {
  const contract = toolchainAdapterById(adapterId)?.compiler;
  if (!contract) return false;
  const paths = root ? contract.rootAuthorityPaths : contract.generationAuthorityPaths;
  return paths.every((path) => scopeOwnsPath(scope, path));
}
