/**
 * Crash points for crash tests. Product code calls `crashPoint(name)` at each
 * step boundary, around each outside effect and after each save. When
 * FACTORY_CRASH_AT names that point, the process kills itself with SIGKILL:
 * no cleanup, no flush, exactly like a power cut. Otherwise it does nothing.
 *
 * FACTORY_CRASH_AT is `name` or `name#n` (crash on the n-th time that point is
 * reached in this process, counting from 1). `*` in the name matches any
 * text, for points whose names hold planner-chosen ids.
 */
const target = parseTarget(process.env.FACTORY_CRASH_AT);
let reached = 0;

function parseTarget(
  value: string | undefined,
): { name: RegExp; nth: number } | undefined {
  if (!value) return undefined;
  const [name, nth] = value.split("#");
  const pattern = name!
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return { name: new RegExp(`^${pattern}$`), nth: nth ? Number(nth) : 1 };
}

export function crashPoint(name: string): void {
  if (!target || !target.name.test(name)) return;
  reached += 1;
  if (reached === target.nth) process.kill(process.pid, "SIGKILL");
}
