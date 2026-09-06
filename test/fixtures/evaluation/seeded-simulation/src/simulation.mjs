export function simulate(seed, ticks) {
  if (
    !Number.isSafeInteger(seed) ||
    seed < 0 ||
    seed > 0xffffffff ||
    !Number.isInteger(ticks) ||
    ticks < 0 ||
    ticks > 100
  ) {
    throw new Error("bounded nonnegative seed and tick count required");
  }
  const cycle = [1, 3, 2, 3];
  return Array.from({ length: ticks }, (_, tick) => {
    const arrivals = cycle[(seed + tick) % cycle.length];
    return { tick, arrivals, admitted: arrivals, rejected: 0 };
  });
}
