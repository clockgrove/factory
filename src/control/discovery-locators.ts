import { createHash } from "node:crypto";
import type { LeaseStore } from "./lease.js";

/** Disposable retrieval hints. Existing comments and lease history remain authority. */
export type DiscoveryLocatorScope =
  | { kind: "request"; objective: number; requestId: string }
  | { kind: "run"; objective: number; runId: string; epoch: number };

export interface DiscoveryLocatorStore {
  ensureDiscoveryLocator(scope: DiscoveryLocatorScope, anchor?: { oid: string }): Promise<void>;
  retireDiscoveryLocator(scope: DiscoveryLocatorScope): Promise<void>;
}

export const DISCOVERY_LOCATOR_PREFIX = "refs/clockgrove-factory/active/";

export function discoveryLocatorRef(scope: DiscoveryLocatorScope): string {
  if (!Number.isSafeInteger(scope.objective) || scope.objective <= 0)
    throw new Error("invalid discovery Objective identity");
  if (scope.kind === "run" && (!Number.isSafeInteger(scope.epoch) || scope.epoch <= 0))
    throw new Error("invalid discovery writer epoch");
  const identity = scope.kind === "request" ? [scope.requestId] : [scope.runId, scope.epoch];
  const digest = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  return `${DISCOVERY_LOCATOR_PREFIX}objective-${scope.objective}/${scope.kind}-${digest}`;
}

export function parseDiscoveryLocatorRef(ref: string): { objective: number } | null {
  const match =
    /^refs\/clockgrove-factory\/active\/objective-([1-9]\d*)\/(?:request|run)-[0-9a-f]{64}$/.exec(
      ref,
    );
  if (!match) return null;
  const objective = Number(match[1]);
  return Number.isSafeInteger(objective) ? { objective } : null;
}

/** Never advance an existing locator. Its target is only an existing reachable
 * commit; even a competing creator's target conveys no execution authority. */
export async function ensureDiscoveryLocator(
  store: Pick<LeaseStore, "readRef" | "createRef">,
  scope: DiscoveryLocatorScope,
  anchorOid: string,
): Promise<void> {
  const ref = discoveryLocatorRef(scope);
  if (await store.readRef(ref)) return;
  if (!(await store.createRef(ref, anchorOid)) && !(await store.readRef(ref)))
    throw new Error("discovery locator registration is unresolved; retry the same request");
}

/** Caller must prove permanent settlement of this exact scope. GitHub ref
 * deletion has no CAS: immutable names keep a stale deletion away from a new
 * request or writer epoch. Original lease/recovery/graph refs are never deleted. */
export async function retireDiscoveryLocator(
  store: { deleteExactDiscoveryRef(ref: string): Promise<void> },
  scope: DiscoveryLocatorScope,
): Promise<void> {
  await store.deleteExactDiscoveryRef(discoveryLocatorRef(scope));
}
