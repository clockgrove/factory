// The median and the p25..p75 spread of a measure: one implementation for the bench's baseline line (bench/lib/baseline.mjs)
// and `pendulum report --compare` (report.mjs). Linear interpolation between the closest ranks, over the finite numbers only.

/** The `q` quantile (0..1) of the finite numbers in `xs`, rounded to `digits` places; null when there are none. */
export const quantile = (xs, q, digits = 1) => {
  const s = xs.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const k = 10 ** digits;
  return Math.round((s[lo] + (s[hi] - s[lo]) * (pos - lo)) * k) / k;
};

/** {median, p25, p75, n} of `xs` (n: its numbers), with `leftOut` when that many were left out of it. */
export const spread = (xs, digits = 1, leftOut = 0) => ({ median: quantile(xs, 0.5, digits), p25: quantile(xs, 0.25, digits), p75: quantile(xs, 0.75, digits), n: xs.filter((x) => typeof x === "number").length, ...(leftOut ? { leftOut } : {}) });
