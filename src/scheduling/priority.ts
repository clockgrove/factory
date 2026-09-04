import type { z } from "zod";

import type { PriorityPolicySchema } from "../protocol/policy.js";
import type { DerivedWorkItem } from "../state.js";
import { scoreUnfinishedGraph } from "./graph-score.js";

export type PriorityPolicy = z.infer<typeof PriorityPolicySchema>;

export type ObservedPrioritySource =
  | "subissue-order"
  | "issue-field"
  | "subissue-order-fallback";

export interface RankedWorkItem {
  item: DerivedWorkItem;
  rank: number;
  source: ObservedPrioritySource;
  fieldId?: string;
  optionId?: string;
  subIssuePosition: number;
  criticalPathLength: number;
  unfinishedDownstream: number;
  fallbackReason?: string;
}

export class PriorityUnavailableError extends Error {
  constructor(
    readonly workItem: number,
    message: string,
  ) {
    super(`Work Item #${workItem} priority unavailable: ${message}`);
    this.name = "PriorityUnavailableError";
  }
}

function isDependencyReady(item: DerivedWorkItem): boolean {
  return (
    (item.state === "unstarted" || item.state === "failed") &&
    item.blockedBy.every((dependency) => dependency.closed)
  );
}

function issueFieldPriority(
  item: DerivedWorkItem,
  policy: PriorityPolicy,
):
  | { rank: number; fieldId: string; optionId?: string }
  | { unavailable: string } {
  const fieldId = policy.issueFieldId!;
  if (!item.issueFieldValues) return { unavailable: "issue-field snapshot is absent" };
  const matching = item.issueFieldValues.filter((value) => value.fieldId === fieldId);
  if (matching.length > 1) return { unavailable: `field ${fieldId} has multiple values` };
  const selected = matching[0];
  if (!selected || !selected.optionId) {
    return { rank: policy.unsetRank, fieldId };
  }
  const rank = policy.optionRanks?.[selected.optionId];
  if (rank === undefined) {
    return {
      unavailable: `option ${selected.optionId} is not pinned in run policy`,
    };
  }
  return { rank, fieldId, optionId: selected.optionId };
}

/**
 * Deterministically rank only dependency-ready work. The input array order is
 * never used as a tie-breaker, so replaying a shuffled snapshot is identical.
 */
export function rankReadyWorkItems(
  items: readonly DerivedWorkItem[],
  policy: PriorityPolicy,
  configuredUnavailableReason?: string,
): RankedWorkItem[] {
  const scores = scoreUnfinishedGraph(items);
  const ready = items.filter(isDependencyReady);
  const observations = new Map(
    policy.source === "issue-field-then-subissue-order"
      ? ready.map((item) => [item.number, issueFieldPriority(item, policy)] as const)
      : [],
  );
  const unavailable = [...observations].find(([, value]) => "unavailable" in value);
  if ((configuredUnavailableReason || unavailable) && policy.onUnavailable === "escalate") {
    throw new PriorityUnavailableError(
      unavailable?.[0] ?? ready[0]?.number ?? 1,
      configuredUnavailableReason ??
        (unavailable && "unavailable" in unavailable[1]
          ? unavailable[1].unavailable
          : "unknown"),
    );
  }
  const fallbackAll = configuredUnavailableReason !== undefined || unavailable !== undefined;
  const ranked = ready.map((item): RankedWorkItem => {
    const subIssuePosition = item.subIssuePosition ?? item.number;
    const score = scores.get(item.number) ?? {
      criticalPathLength: 0,
      unfinishedDownstream: 0,
    };
    if (policy.source === "subissue-order") {
      return {
        item,
        rank: policy.unsetRank,
        source: "subissue-order",
        subIssuePosition,
        ...score,
      };
    }
    const observed = observations.get(item.number)!;
    if (fallbackAll) {
      return {
        item,
        rank: policy.unsetRank,
        source: "subissue-order-fallback",
        subIssuePosition,
        fallbackReason:
          configuredUnavailableReason ??
          ("unavailable" in observed
            ? observed.unavailable
            : `another ready Work Item has unavailable field ${policy.issueFieldId}`),
        ...score,
      };
    }
    if ("unavailable" in observed) {
      throw new Error("unreachable unavailable priority observation");
    }
    return {
      item,
      rank: observed.rank,
      source: "issue-field",
      fieldId: observed.fieldId,
      ...(observed.optionId ? { optionId: observed.optionId } : {}),
      subIssuePosition,
      ...score,
    };
  });

  return ranked.sort((left, right) => {
    const issueFieldOrder =
      left.source === "issue-field" && right.source === "issue-field";
    if (issueFieldOrder && left.rank !== right.rank) return left.rank - right.rank;
    if (!issueFieldOrder && left.subIssuePosition !== right.subIssuePosition) {
      return left.subIssuePosition - right.subIssuePosition;
    }
    if (left.criticalPathLength !== right.criticalPathLength) {
      return right.criticalPathLength - left.criticalPathLength;
    }
    if (left.unfinishedDownstream !== right.unfinishedDownstream) {
      return right.unfinishedDownstream - left.unfinishedDownstream;
    }
    if (issueFieldOrder && left.subIssuePosition !== right.subIssuePosition) {
      return left.subIssuePosition - right.subIssuePosition;
    }
    return left.item.number - right.item.number;
  });
}
