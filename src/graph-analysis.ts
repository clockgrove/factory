export interface DependencyItem {
  id: string;
  dependsOn: readonly string[];
}

export interface DependencyAnalysis {
  order: string[];
  ancestors: Map<string, ReadonlySet<string>>;
  duplicates: string[];
  unknownDependencies: Array<{ itemId: string; dependencyId: string }>;
  cycleItems: string[];
  hasPath(from: string, to: string): boolean;
}

/** Pure, stable dependency analysis shared by compilation, graph validation,
 * capability binding, delivery projection, and judge views. */
export function analyzeDependencies(items: readonly DependencyItem[]): DependencyAnalysis {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
  const duplicates = [...counts]
    .filter(([, count]) => count > 1)
    .map(([id]) => id)
    .sort();
  const byId = new Map<string, DependencyItem>();
  for (const item of items) if (!byId.has(item.id)) byId.set(item.id, item);
  const unknownDependencies = [...byId.values()]
    .flatMap((item) =>
      item.dependsOn
        .filter((dependencyId) => !byId.has(dependencyId))
        .map((dependencyId) => ({ itemId: item.id, dependencyId })),
    )
    .sort(
      (left, right) =>
        left.itemId.localeCompare(right.itemId) ||
        left.dependencyId.localeCompare(right.dependencyId),
    );

  const dependents = new Map<string, string[]>([...byId.keys()].map((id) => [id, []]));
  const position = new Map([...byId.keys()].map((id, index) => [id, index]));
  const remaining = new Map<string, number>();
  for (const item of byId.values()) {
    const dependencies = [...new Set(item.dependsOn.filter((id) => byId.has(id)))];
    remaining.set(item.id, dependencies.length);
    for (const dependency of dependencies) dependents.get(dependency)!.push(item.id);
  }
  const ready = [...byId.keys()].filter((id) => remaining.get(id) === 0);
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const dependent of dependents.get(id) ?? []) {
      const count = remaining.get(dependent)! - 1;
      remaining.set(dependent, count);
      if (count === 0) {
        ready.push(dependent);
        ready.sort((left, right) => position.get(left)! - position.get(right)!);
      }
    }
  }
  const cycleItems = [...byId.keys()].filter((id) => !order.includes(id));
  order.push(...cycleItems);

  const ancestors = new Map<string, ReadonlySet<string>>();
  const ancestorsOf = (id: string, visiting = new Set<string>()): ReadonlySet<string> => {
    const cached = ancestors.get(id);
    if (cached) return cached;
    if (visiting.has(id)) return new Set();
    const nextVisiting = new Set(visiting).add(id);
    const result = new Set<string>();
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(dependency)) continue;
      result.add(dependency);
      for (const ancestor of ancestorsOf(dependency, nextVisiting)) result.add(ancestor);
    }
    ancestors.set(id, result);
    return result;
  };
  for (const id of [...byId.keys()].sort()) ancestorsOf(id);

  return {
    order,
    ancestors,
    duplicates,
    unknownDependencies,
    cycleItems,
    hasPath: (from, to) => from === to || (ancestors.get(from)?.has(to) ?? false),
  };
}

export function scopePathsOverlap(left: string, right: string): boolean {
  const leftDirectory = left.endsWith("/");
  const rightDirectory = right.endsWith("/");
  if (!leftDirectory && !rightDirectory) return left === right;
  if (leftDirectory && rightDirectory) return left.startsWith(right) || right.startsWith(left);
  return leftDirectory ? right.startsWith(left) : left.startsWith(right);
}

/** Sorted prefix scan over the bounded Work Item scope inventory. */
export function overlappingScopePairs(
  items: readonly { id: string; scope: readonly string[] }[],
): Array<[string, string]> {
  const entries = items
    .flatMap((item) => item.scope.map((path) => ({ itemId: item.id, path })))
    .sort(
      (left, right) =>
        (left.path < right.path ? -1 : left.path > right.path ? 1 : 0) ||
        (left.itemId < right.itemId ? -1 : left.itemId > right.itemId ? 1 : 0),
    );
  const pairs = new Set<string>();
  for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
    const left = entries[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
      const right = entries[rightIndex]!;
      if (
        left.path !== right.path &&
        (left.path.endsWith("/") ? !right.path.startsWith(left.path) : right.path !== left.path)
      )
        break;
      if (left.itemId === right.itemId || !scopePathsOverlap(left.path, right.path)) continue;
      const pair = [left.itemId, right.itemId].sort() as [string, string];
      pairs.add(`${pair[0]}\0${pair[1]}`);
    }
  }
  return [...pairs].sort().map((pair) => pair.split("\0") as [string, string]);
}

export function exclusiveResourcePairs(
  items: readonly { id: string; exclusiveResources: readonly string[] }[],
): Array<{ left: string; right: string; resources: string[] }> {
  const owners = new Map<string, Set<string>>();
  for (const item of items)
    for (const resource of item.exclusiveResources)
      owners.set(resource, (owners.get(resource) ?? new Set()).add(item.id));
  const pairs = new Map<string, Set<string>>();
  for (const [resource, itemIds] of [...owners].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const ids = [...itemIds].sort();
    for (let left = 0; left < ids.length; left += 1)
      for (let right = left + 1; right < ids.length; right += 1) {
        const key = `${ids[left]}\0${ids[right]}`;
        pairs.set(key, (pairs.get(key) ?? new Set()).add(resource));
      }
  }
  return [...pairs]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, resources]) => {
      const [left, right] = key.split("\0");
      return { left: left!, right: right!, resources: [...resources].sort() };
    });
}
