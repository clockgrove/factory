export interface SchedulingGraphItem {
  number: number;
  closed: boolean;
  blockedBy: readonly { number: number; closed: boolean }[];
}

export interface GraphScore {
  /** Longest unfinished downstream path, in edges. A leaf has length zero. */
  criticalPathLength: number;
  /** Count of distinct unfinished descendants. */
  unfinishedDownstream: number;
}

/** Pure scoring over the unfinished portion of a dependency DAG. */
export function scoreUnfinishedGraph(
  items: readonly SchedulingGraphItem[],
): ReadonlyMap<number, GraphScore> {
  const unfinished = new Map<number, SchedulingGraphItem>();
  for (const item of items) {
    if (unfinished.has(item.number)) {
      throw new Error(`duplicate Work Item #${item.number}`);
    }
    if (!item.closed) unfinished.set(item.number, item);
  }

  const children = new Map<number, number[]>();
  for (const number of unfinished.keys()) children.set(number, []);
  for (const item of unfinished.values()) {
    for (const dependency of item.blockedBy) {
      if (unfinished.has(dependency.number)) {
        children.get(dependency.number)!.push(item.number);
      }
    }
  }
  for (const downstream of children.values()) downstream.sort((a, b) => a - b);

  const pathMemo = new Map<number, number>();
  const visit = new Set<number>();
  const criticalPath = (number: number): number => {
    const memoized = pathMemo.get(number);
    if (memoized !== undefined) return memoized;
    if (visit.has(number)) throw new Error("Work Item dependency graph contains a cycle");
    visit.add(number);
    const downstream = children.get(number) ?? [];
    const value =
      downstream.length === 0
        ? 0
        : 1 + Math.max(...downstream.map((child) => criticalPath(child)));
    visit.delete(number);
    pathMemo.set(number, value);
    return value;
  };

  const descendants = (number: number): Set<number> => {
    const result = new Set<number>();
    const pending = [...(children.get(number) ?? [])];
    while (pending.length > 0) {
      const child = pending.pop()!;
      if (result.has(child)) continue;
      result.add(child);
      pending.push(...(children.get(child) ?? []));
    }
    return result;
  };

  return new Map(
    [...unfinished.keys()]
      .sort((a, b) => a - b)
      .map((number) => [
        number,
        {
          criticalPathLength: criticalPath(number),
          unfinishedDownstream: descendants(number).size,
        },
      ]),
  );
}
