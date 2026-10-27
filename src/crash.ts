/**
 * Crash points for crash tests. Product code calls `crashPoint(name)` at each
 * step boundary, around each outside effect and after each save. When
 * FACTORY_CRASH_AT names that point, the process kills itself with SIGKILL:
 * no cleanup, no flush, exactly like a power cut. Otherwise it does nothing.
 *
 * FACTORY_CRASH_AT is `name` or `name#n` (crash on the n-th time that point is
 * reached in this process, counting from 1). `*` in the name matches any
 * text, for points whose names hold planner-chosen ids.
 *
 * The service first records the point it dies at (`recordCrashes`), so its
 * next start can tell this death, which the test caused, from one with no
 * known cause: no step is suspected of it (service.ts).
 */
const target = parseTarget(process.env.FACTORY_CRASH_AT);
let reached = 0;
let record: ((point: string) => void) | undefined;

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

/** Have `write` record the point before a crash point kills the process; it must reach no crash point itself. */
export function recordCrashes(write: (point: string) => void): void {
  record = write;
}

export function crashPoint(name: string): void {
  if (!target || !target.name.test(name)) return;
  reached += 1;
  if (reached !== target.nth) return;
  try {
    record?.(name);
  } catch {
    // Unrecorded: the next start counts a death with no known cause.
  }
  process.kill(process.pid, "SIGKILL");
}
