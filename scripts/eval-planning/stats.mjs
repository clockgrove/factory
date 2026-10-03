// Small-sample statistics for planning evals: Wilson intervals for rates and
// a paired bootstrap for deltas between two result sets. Pure functions.

const Z95 = 1.959963984540054;

/** Wilson score 95% interval for `successes` out of `total`. */
export function wilson(successes, total) {
  if (!total) return { successes, total, rate: null, low: null, high: null };
  const p = successes / total;
  const z2 = Z95 * Z95;
  const denominator = 1 + z2 / total;
  const centre = (p + z2 / (2 * total)) / denominator;
  const half =
    (Z95 * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))) /
    denominator;
  return {
    successes,
    total,
    rate: p,
    low: Math.max(0, centre - half),
    high: Math.min(1, centre + half),
  };
}

/** Deterministic PRNG (mulberry32) so reported intervals are reproducible. */
export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mean = (values) =>
  values.reduce((total, value) => total + value, 0) / values.length;

function quantile(sorted, q) {
  const position = (sorted.length - 1) * q;
  const below = Math.floor(position);
  const above = Math.ceil(position);
  return sorted[below] + (sorted[above] - sorted[below]) * (position - below);
}

/**
 * Paired bootstrap of mean(b - a) over units (cases). Resampling whole units
 * keeps each case's A and B together, so case difficulty cancels out.
 */
export function pairedBootstrap(pairs, { iterations = 10_000, seed = 1 } = {}) {
  const n = pairs.length;
  if (!n)
    return { n, meanA: null, meanB: null, delta: null, low: null, high: null };
  const deltas = pairs.map(({ a, b }) => b - a);
  const random = seededRandom(seed);
  const means = new Float64Array(iterations);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let total = 0;
    for (let draw = 0; draw < n; draw += 1)
      total += deltas[Math.floor(random() * n)];
    means[iteration] = total / n;
  }
  means.sort();
  return {
    n,
    meanA: mean(pairs.map(({ a }) => a)),
    meanB: mean(pairs.map(({ b }) => b)),
    delta: mean(deltas),
    low: quantile(means, 0.025),
    high: quantile(means, 0.975),
  };
}

/**
 * A success rate over runs grouped by case. Repeats of one case are not
 * independent, so the 95% interval is the wider of a case-level (cluster)
 * bootstrap and a Wilson interval whose sample size is the number of cases.
 * `groups` maps a cluster id to its runs' outcomes (true/false).
 */
export function clusteredRate(groups, { iterations = 10_000, seed = 1 } = {}) {
  const clusters = [...groups.values()]
    .map((outcomes) => ({
      successes: outcomes.filter(Boolean).length,
      total: outcomes.length,
    }))
    .filter((cluster) => cluster.total);
  const successes = clusters.reduce((sum, c) => sum + c.successes, 0);
  const total = clusters.reduce((sum, c) => sum + c.total, 0);
  const k = clusters.length;
  if (!total)
    return { successes, total, clusters: k, rate: null, low: null, high: null };
  const rate = successes / total;
  const wide = wilson(rate * k, k);
  const random = seededRandom(seed);
  const rates = new Float64Array(iterations);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let hit = 0;
    let all = 0;
    for (let draw = 0; draw < k; draw += 1) {
      const cluster = clusters[Math.floor(random() * k)];
      hit += cluster.successes;
      all += cluster.total;
    }
    rates[iteration] = hit / all;
  }
  rates.sort();
  return {
    successes,
    total,
    clusters: k,
    rate,
    low: Math.min(wide.low, quantile(rates, 0.025)),
    high: Math.max(wide.high, quantile(rates, 0.975)),
  };
}

/** Group run outcomes by cluster id for clusteredRate. */
export function byCluster(runs, cluster, outcome) {
  const groups = new Map();
  for (const run of runs) {
    const id = cluster(run);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(Boolean(outcome(run)));
  }
  return groups;
}

/** Mean, min and max of the numeric values; null when there are none. */
export function spread(values) {
  const numbers = values.filter((value) => typeof value === "number");
  if (!numbers.length) return null;
  return {
    n: numbers.length,
    mean: mean(numbers),
    min: Math.min(...numbers),
    max: Math.max(...numbers),
  };
}
