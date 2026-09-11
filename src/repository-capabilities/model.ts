import type { RepositoryCapabilityBindings } from "../protocol/worker-packet.js";
import type { RuntimeBundleRequirement } from "../runtime/toolchain-bundle.js";

export interface CapabilityOperation {
  kind: string;
  key: string;
}

export interface DeferredCapabilityAdapter {
  id: string;
  rootAuthorityPaths: readonly string[];
  generationAuthorityPaths: readonly string[];
  runtime?: RuntimeBundleRequirement;
  operation(command: string): CapabilityOperation | null;
}

export interface CapabilityGraphItem {
  id: string;
  dependsOn: readonly string[];
  scope: readonly string[];
  validationCommands: readonly string[];
}

function dependencyPath(
  byId: ReadonlyMap<string, { dependsOn: readonly string[] }>,
  from: string,
  to: string,
): boolean {
  const pending = [from];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === to) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    pending.push(...(byId.get(current)?.dependsOn ?? []));
  }
  return false;
}

const operationIdentity = (operation: CapabilityOperation) => `${operation.kind}\0${operation.key}`;

/** A trailing slash grants a directory subtree; every other scope entry names one exact path. */
export function scopeOwnsPath(scope: readonly string[], path: string): boolean {
  return scope.some((entry) => entry === path || (entry.endsWith("/") && path.startsWith(entry)));
}

function itemOperations(
  item: CapabilityGraphItem,
  adapter: DeferredCapabilityAdapter,
): CapabilityOperation[] {
  const operations = item.validationCommands.flatMap((command) => {
    const operation = adapter.operation(command);
    return operation ? [operation] : [];
  });
  return operations.filter(
    (operation, index) =>
      operations.findIndex(
        (candidate) => operationIdentity(candidate) === operationIdentity(operation),
      ) === index,
  );
}

/**
 * Bind deferred operations to the closest unambiguous ancestor generation.
 * This layer knows nothing about pnpm, Python, lockfiles, PATH, or setup. An
 * adapter defines only how its typed operation and authority surfaces are
 * recognized; runtime activation remains a later exact-base decision.
 */
export function bindDeferredCapabilityGraph(
  items: readonly CapabilityGraphItem[],
  adapters: readonly DeferredCapabilityAdapter[],
  isDeferred: (item: CapabilityGraphItem, command: string) => boolean,
): Map<string, RepositoryCapabilityBindings> {
  const byId = new Map(items.map((item) => [item.id, item]));
  const result = new Map<string, RepositoryCapabilityBindings>(
    items.map((item) => [item.id, { provides: [], requires: [] }]),
  );
  for (const adapter of adapters) {
    const operations = items.flatMap((item) =>
      item.validationCommands.flatMap((command) => {
        const operation = adapter.operation(command);
        return operation && isDeferred(item, command) ? [{ item, operation }] : [];
      }),
    );
    if (operations.length === 0) continue;
    const runtime = adapter.runtime;
    for (const { item, operation } of operations) {
      const rootCandidates = items.filter(
        (candidate) =>
          dependencyPath(byId, item.id, candidate.id) &&
          adapter.rootAuthorityPaths.every((path) => scopeOwnsPath(candidate.scope, path)) &&
          itemOperations(candidate, adapter).length > 0,
      );
      const roots = rootCandidates.filter(
        (candidate) =>
          !rootCandidates.some(
            (other) => other.id !== candidate.id && dependencyPath(byId, other.id, candidate.id),
          ),
      );
      if (roots.length !== 1)
        throw new Error(
          `${adapter.id} deferred capability for ${item.id} has ${roots.length} dependency-root providers`,
        );
      const root = roots[0]!;
      const candidates = items.filter(
        (candidate) =>
          (candidate.id !== item.id || item.id === root.id) &&
          dependencyPath(byId, item.id, candidate.id) &&
          dependencyPath(byId, candidate.id, root.id) &&
          (candidate.id === root.id ||
            (adapter.generationAuthorityPaths.every((path) =>
              scopeOwnsPath(candidate.scope, path),
            ) &&
              itemOperations(candidate, adapter).some(
                (candidateOperation) =>
                  operationIdentity(candidateOperation) === operationIdentity(operation),
              ))),
      );
      const closest = candidates.filter(
        (candidate) =>
          !candidates.some(
            (other) => other.id !== candidate.id && dependencyPath(byId, other.id, candidate.id),
          ),
      );
      if (closest.length !== 1)
        throw new Error(
          `${adapter.id} deferred capability for ${item.id} has ambiguous provider generations`,
        );
      const provider = closest[0]!;
      const generation = `${adapter.id}/${provider.id}`;
      const authorityPaths = [
        ...(provider.id === root.id
          ? adapter.rootAuthorityPaths
          : adapter.generationAuthorityPaths),
      ];
      result.get(item.id)!.requires.push({
        adapter: adapter.id,
        generation,
        providerWorkItem: provider.id,
        authorityPaths,
        operation,
        activation: provider.id === item.id ? "artifact" : "integrated-base",
        ...(runtime ? { runtime } : {}),
      });
      const provisions = result.get(provider.id)!.provides;
      let provision = provisions.find(
        (candidate) => candidate.adapter === adapter.id && candidate.generation === generation,
      );
      if (!provision) {
        provision = {
          adapter: adapter.id,
          generation,
          authorityPaths,
          operations: [],
          ...(runtime ? { runtime } : {}),
        };
        provisions.push(provision);
      }
      if (
        !provision.operations.some(
          (candidate) => operationIdentity(candidate) === operationIdentity(operation),
        )
      )
        provision.operations.push(operation);
    }
  }
  for (const bindings of result.values()) {
    bindings.provides.sort((a, b) => a.generation.localeCompare(b.generation));
    bindings.requires.sort(
      (a, b) =>
        a.generation.localeCompare(b.generation) ||
        operationIdentity(a.operation).localeCompare(operationIdentity(b.operation)),
    );
    for (const provision of bindings.provides)
      provision.operations.sort((a, b) => operationIdentity(a).localeCompare(operationIdentity(b)));
  }
  return result;
}

function canonicalBindings(
  bindings: RepositoryCapabilityBindings | undefined,
  ignoreBundleSelection = false,
): RepositoryCapabilityBindings {
  const runtime = (value: RuntimeBundleRequirement): RuntimeBundleRequirement => {
    if (!ignoreBundleSelection) return value;
    const { bundleDigest: _bundleDigest, ...unselected } = value;
    return unselected;
  };
  return {
    provides: [...(bindings?.provides ?? [])]
      .map((provision) => ({
        ...provision,
        ...(provision.runtime ? { runtime: runtime(provision.runtime) } : {}),
        authorityPaths: [...provision.authorityPaths],
        operations: [...provision.operations].sort((left, right) =>
          operationIdentity(left).localeCompare(operationIdentity(right)),
        ),
      }))
      .sort((left, right) => left.generation.localeCompare(right.generation)),
    requires: [...(bindings?.requires ?? [])]
      .map((requirement) => ({
        ...requirement,
        ...(requirement.runtime ? { runtime: runtime(requirement.runtime) } : {}),
      }))
      .sort(
        (left, right) =>
          left.generation.localeCompare(right.generation) ||
          operationIdentity(left.operation).localeCompare(operationIdentity(right.operation)),
      ),
  };
}

/**
 * Verify persisted bindings by repeating the complete registered host derivation.
 * A graph digest binds bytes, but it does not make self-consistent attacker- or
 * legacy-authored capability claims true. Recovery therefore uses the same
 * adapter registry and canonical binding algorithm as fresh compilation before
 * it may persist or project a graph again.
 */
export function validateCapabilityGraphBindings(
  items: readonly (Omit<CapabilityGraphItem, "validationCommands"> & {
    validationCommands?: readonly string[] | undefined;
    repositoryCapabilities?: RepositoryCapabilityBindings | undefined;
  })[],
  adapters: readonly DeferredCapabilityAdapter[],
  deferredAdapterIds?: readonly string[] | undefined,
): void {
  const hasBindings = items.some((item) => item.repositoryCapabilities !== undefined);
  if (!hasBindings && deferredAdapterIds === undefined) return;
  if (!hasBindings && deferredAdapterIds?.length === 0) return;
  if (
    items.some((item) =>
      [
        ...(item.repositoryCapabilities?.provides ?? []),
        ...(item.repositoryCapabilities?.requires ?? []),
      ].some((binding) => binding.runtime?.bundleDigest !== undefined),
    )
  )
    throw new Error("immutable repository capability graph selected a managed runtime bundle");
  if (items.some((item) => !item.validationCommands))
    throw new Error("repository capability bindings require complete validation commands");
  const capabilityItems: CapabilityGraphItem[] = items.map((item) => ({
    ...item,
    validationCommands: item.validationCommands!,
  }));
  // Fresh graphs persist the host-derived, objective-wide adapter disposition.
  // Historical graphs predate that field, so their authenticated bindings are
  // the narrow compatibility source. Selection is graph-wide because complete
  // root-authority absence is an adapter/repository fact, not an item-local
  // property that a deleted requirement may redefine.
  const selectedIds =
    deferredAdapterIds ??
    [
      ...new Set(
        items.flatMap((item) =>
          [
            ...(item.repositoryCapabilities?.provides ?? []),
            ...(item.repositoryCapabilities?.requires ?? []),
          ].map(({ adapter }) => adapter),
        ),
      ),
    ].sort();
  if (
    new Set(selectedIds).size !== selectedIds.length ||
    JSON.stringify(selectedIds) !== JSON.stringify([...selectedIds].sort())
  )
    throw new Error("deferred repository capability adapters are not canonical");
  const adaptersById = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  for (const id of selectedIds)
    if (!adaptersById.has(id))
      throw new Error(`unknown deferred repository capability adapter ${id}`);
  const selected = new Set(selectedIds);
  for (const id of selected) {
    const adapter = adaptersById.get(id)!;
    if (
      !capabilityItems.some((item) =>
        item.validationCommands.some((command) => adapter.operation(command)),
      )
    )
      throw new Error(`deferred repository capability adapter ${id} has no operation`);
  }
  const expected = bindDeferredCapabilityGraph(capabilityItems, adapters, (_item, command) =>
    adapters.some((adapter) => selected.has(adapter.id) && adapter.operation(command) !== null),
  );
  for (const item of items) {
    const actual = canonicalBindings(item.repositoryCapabilities, true);
    const derived = canonicalBindings(expected.get(item.id), true);
    if (JSON.stringify(actual) !== JSON.stringify(derived))
      throw new Error(
        `repository capability bindings for ${item.id} differ from canonical host derivation`,
      );
  }

  const byId = new Map(items.map((item) => [item.id, item]));
  const generations = new Map<string, string>();
  for (const item of items) {
    for (const provision of item.repositoryCapabilities?.provides ?? []) {
      const identity = `${provision.adapter}\0${provision.generation}`;
      const previous = generations.get(identity);
      if (previous && previous !== item.id)
        throw new Error(
          `repository capability generation has multiple providers: ${provision.generation}`,
        );
      generations.set(identity, item.id);
      if (!provision.authorityPaths.every((path) => scopeOwnsPath(item.scope, path)))
        throw new Error(
          `repository capability provider ${item.id} does not own its authority paths`,
        );
    }
  }
  for (const item of items) {
    for (const requirement of item.repositoryCapabilities?.requires ?? []) {
      const provider = byId.get(requirement.providerWorkItem);
      if (!provider)
        throw new Error(`unknown repository capability provider ${requirement.providerWorkItem}`);
      const provision = provider.repositoryCapabilities?.provides.find(
        (candidate) =>
          candidate.adapter === requirement.adapter &&
          candidate.generation === requirement.generation &&
          candidate.operations.some(
            (operation) =>
              operationIdentity(operation) === operationIdentity(requirement.operation),
          ),
      );
      if (!provision)
        throw new Error(`repository capability requirement lacks its exact provision`);
      if (
        provision.authorityPaths.join("\0") !== requirement.authorityPaths.join("\0") ||
        JSON.stringify(provision.runtime) !== JSON.stringify(requirement.runtime) ||
        !requirement.authorityPaths.every((path) => scopeOwnsPath(provider.scope, path))
      )
        throw new Error(
          `repository capability authority paths disagree with provider ${provider.id}`,
        );
      if (requirement.activation === "artifact") {
        if (provider.id !== item.id)
          throw new Error("artifact-time repository capability must belong to its provider");
      } else if (provider.id === item.id || !dependencyPath(byId, item.id, provider.id)) {
        throw new Error(`repository capability provider is not an ancestor of consumer ${item.id}`);
      }
    }
  }
}
