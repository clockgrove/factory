export function totalCents(items: readonly number[]): number {
  if (items.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error("items must be nonnegative integer cents");
  }
  const total = items.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(total)) throw new Error("total exceeds safe integer range");
  return total;
}
