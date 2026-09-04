import type { DeliveryRelationship } from "../compiler/index.js";

export const DELIVERY_PLAN_PROTOCOL = "clockgrove.factory/delivery-plan-v1" as const;

export interface DeliveryWorkItem {
  id: string;
  dependsOn: readonly string[];
  delivery: {
    group: string;
    relationship: DeliveryRelationship;
    parentWorkItem?: string;
  };
}

export interface DeliveryItemPlan {
  itemId: string;
  unitId: string;
  position: number;
  parentItemId?: string;
  /** Dependencies that must merge before this unit can start from trunk. */
  waitsForMerge: string[];
}

export interface DeliveryUnit {
  id: string;
  kind: "sibling" | "stack";
  items: string[];
}

export type DeliveryPlan =
  | {
      protocol: typeof DELIVERY_PLAN_PROTOCOL;
      result: "supported";
      units: DeliveryUnit[];
      items: DeliveryItemPlan[];
    }
  | {
      protocol: typeof DELIVERY_PLAN_PROTOCOL;
      result: "unsupported";
      code: "duplicate-item" | "unknown-dependency" | "dependency-cycle" | "invalid-delivery-hint";
      reason: string;
    };

export interface StackCapability {
  available: boolean;
  /** False means the probe did not produce an authoritative repository answer. */
  observed: boolean;
  version: string;
  reason: string;
}

export interface DeliverySelection {
  requested: "regular-prs" | "stacked-prs";
  selected: "regular-prs" | "native-stacks" | "escalate";
  capabilityVersion: string;
  reason: string;
}

/**
 * Regular pull requests all target trunk. Until Factory can rebase and
 * revalidate an arbitrary provider artifact after a sibling merge, admitting
 * more than one complete regular-PR pipeline can invalidate every sibling's
 * observed base. Native stacks have their own cascading revalidation path and
 * retain full scheduler concurrency.
 */
export function admissionsWithinDeliverySafety<T>(args: {
  selected: DeliverySelection["selected"];
  activeExecutions: number;
  admissions: readonly T[];
}): T[] {
  if (args.selected !== "regular-prs") return [...args.admissions];
  if (args.activeExecutions > 0) return [];
  return args.admissions.slice(0, 1);
}

/**
 * Select delivery only from an observed repository capability. The returned
 * record is intended to be persisted before publication starts; callers must
 * not silently reconsider it after any PR has been opened.
 */
export function selectDelivery(args: {
  requested: "regular-prs" | "stacked-prs";
  onUnavailable: "regular-prs" | "escalate";
  capability: StackCapability;
}): DeliverySelection {
  if (args.requested === "regular-prs") {
    return {
      requested: args.requested,
      selected: "regular-prs",
      capabilityVersion: args.capability.version,
      reason: "run policy selected regular pull requests",
    };
  }
  if (args.capability.available && args.capability.observed) {
    return {
      requested: args.requested,
      selected: "native-stacks",
      capabilityVersion: args.capability.version,
      reason: args.capability.reason,
    };
  }
  if (!args.capability.observed) {
    return {
      requested: args.requested,
      selected: "escalate",
      capabilityVersion: args.capability.version,
      reason: args.capability.reason,
    };
  }
  return {
    requested: args.requested,
    selected: args.onUnavailable === "regular-prs" ? "regular-prs" : "escalate",
    capabilityVersion: args.capability.version,
    reason: args.capability.reason,
  };
}

function unsupported(
  code: Extract<DeliveryPlan, { result: "unsupported" }>["code"],
  reason: string,
): DeliveryPlan {
  return { protocol: DELIVERY_PLAN_PROTOCOL, result: "unsupported", code, reason };
}

/**
 * Turn compiler hints into maximal *linear* stack units. A fork ends a stack:
 * every child waits for the fork point to merge and starts a new sibling unit.
 * A multi-parent join likewise waits for every parent and starts from trunk.
 * This avoids inventing a multi-base or placing one PR in multiple stacks.
 */
export function planDelivery(input: readonly DeliveryWorkItem[]): DeliveryPlan {
  const ordered = [...input].sort((a, b) => a.id.localeCompare(b.id));
  const byId = new Map<string, DeliveryWorkItem>();
  for (const item of ordered) {
    if (byId.has(item.id)) {
      return unsupported("duplicate-item", `duplicate Work Item ${item.id}`);
    }
    byId.set(item.id, item);
  }
  for (const item of ordered) {
    for (const dependency of item.dependsOn) {
      if (!byId.has(dependency)) {
        return unsupported(
          "unknown-dependency",
          `${item.id} depends on unknown Work Item ${dependency}`,
        );
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    visiting.add(id);
    for (const dependency of byId.get(id)!.dependsOn) {
      if (!visit(dependency)) return false;
    }
    visiting.delete(id);
    visited.add(id);
    return true;
  };
  for (const item of ordered) {
    if (!visit(item.id)) {
      return unsupported("dependency-cycle", `delivery graph contains a cycle at ${item.id}`);
    }
  }

  for (const item of ordered) {
    const hint = item.delivery;
    const parent = hint.parentWorkItem;
    const valid =
      (hint.relationship === "root" &&
        !parent &&
        item.dependsOn.length === 0 &&
        hint.group === item.id) ||
      (hint.relationship === "continue-stack" &&
        Boolean(parent) &&
        item.dependsOn.length === 1 &&
        item.dependsOn[0] === parent &&
        byId.get(parent!)?.delivery.group === hint.group) ||
      (hint.relationship === "sibling" &&
        !parent &&
        item.dependsOn.length === 1 &&
        hint.group === item.id) ||
      (hint.relationship === "join-after-merge" &&
        !parent &&
        item.dependsOn.length >= 2 &&
        hint.group === item.id);
    if (!valid) {
      return unsupported(
        "invalid-delivery-hint",
        `Work Item ${item.id} has a delivery hint inconsistent with its dependencies`,
      );
    }
  }

  const children = new Map<string, string[]>();
  for (const item of ordered) {
    if (item.delivery.relationship !== "continue-stack") continue;
    const parent = item.delivery.parentWorkItem!;
    const values = children.get(parent) ?? [];
    values.push(item.id);
    children.set(parent, values.sort());
  }

  // Only an unbranched edge can live inside a native stack.
  const stackParent = new Map<string, string>();
  const stackChild = new Map<string, string>();
  for (const item of ordered) {
    if (item.delivery.relationship !== "continue-stack") continue;
    const parent = item.delivery.parentWorkItem!;
    if ((children.get(parent)?.length ?? 0) !== 1) continue;
    stackParent.set(item.id, parent);
    stackChild.set(parent, item.id);
  }

  const units: DeliveryUnit[] = [];
  const assigned = new Set<string>();
  for (const item of ordered) {
    if (assigned.has(item.id) || stackParent.has(item.id)) continue;
    const items: string[] = [];
    let current: string | undefined = item.id;
    while (current && !assigned.has(current)) {
      items.push(current);
      assigned.add(current);
      current = stackChild.get(current);
    }
    units.push({
      id: `delivery/${items[0]}`,
      kind: items.length > 1 ? "stack" : "sibling",
      items,
    });
  }
  // A node whose incoming stack edge was rejected because its parent forked is
  // a new root unit, not lost merely because it still has a stack hint.
  for (const item of ordered) {
    if (assigned.has(item.id)) continue;
    const items: string[] = [];
    let current: string | undefined = item.id;
    while (current && !assigned.has(current)) {
      items.push(current);
      assigned.add(current);
      current = stackChild.get(current);
    }
    units.push({
      id: `delivery/${items[0]}`,
      kind: items.length > 1 ? "stack" : "sibling",
      items,
    });
  }

  const unitByItem = new Map<string, DeliveryUnit>();
  for (const unit of units) {
    for (const item of unit.items) unitByItem.set(item, unit);
  }
  const items = ordered.map((item): DeliveryItemPlan => {
    const unit = unitByItem.get(item.id)!;
    const position = unit.items.indexOf(item.id);
    const parentItemId = position > 0 ? unit.items[position - 1] : undefined;
    return {
      itemId: item.id,
      unitId: unit.id,
      position,
      ...(parentItemId ? { parentItemId } : {}),
      waitsForMerge: item.dependsOn.filter((dependency) => dependency !== parentItemId).sort(),
    };
  });
  return {
    protocol: DELIVERY_PLAN_PROTOCOL,
    result: "supported",
    units: units.sort((a, b) => a.items[0]!.localeCompare(b.items[0]!)),
    items,
  };
}
