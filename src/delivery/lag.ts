import { attachFault, type Fault, transient } from "../fault.js";
import { GITHUB_LAG_MS } from "../github-client.js";

/**
 * When this process first saw each postcondition not hold. Keys name the
 * exact object and head (a PR and its head, a merge commit), so another
 * attempt never inherits a window.
 */
const firstSeen = new Map<string, number>();

let now = (): number => Date.now();

/** Replace the lag window's clock; returns a restore. Tests only. */
export function setLagClock(clock: () => number): () => void {
  const previous = now;
  now = clock;
  return () => {
    now = previous;
  };
}

/**
 * A delivery postcondition that does not hold yet (a merge GitHub has not
 * shown, an ancestry check after a merge): transient while GitHub may still
 * lag, then `after`. The window starts when this process first saw it; past
 * it the step ends, and the operator's retry starts a new window.
 */
export function notYet(
  key: string,
  message: string,
  after: Fault = { kind: "defect", detail: message },
): Error {
  const time = now();
  const since = firstSeen.get(key) ?? time;
  const lagging = time - since < GITHUB_LAG_MS;
  if (lagging) firstSeen.set(key, since);
  else firstSeen.delete(key);
  return attachFault(
    new Error(message),
    lagging ? transient(message, false) : after,
  );
}

/** The postcondition held: a later failure starts a new window. */
export function settled(key: string): void {
  firstSeen.delete(key);
}
