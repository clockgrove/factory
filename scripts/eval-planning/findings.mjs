// Review findings as reports keep them. A finding's `itemIds` is the
// reviewer's structured pointer at the Work Items it concerns (empty for a
// plan-wide defect); recall can check it against the mutated item, which prose
// matching cannot.

/** What a report keeps of a production finding. */
export function projectFinding({ detail, question, itemIds }) {
  return {
    detail,
    question,
    ...(Array.isArray(itemIds) ? { itemIds: [...itemIds] } : {}),
  };
}

/**
 * Whether a flagging review pointed at the item a defect was injected into:
 * true when a finding names it, false when every finding names other items,
 * null when it cannot be told (no mutated item, no finding, or findings that
 * carry no `itemIds`). A review that missed the plan has nothing to point with.
 */
export function pointsAtItem(findings, itemId) {
  if (typeof itemId !== "string") return null;
  if (!findings.length) return null;
  if (!findings.every((finding) => Array.isArray(finding.itemIds))) return null;
  return findings.some((finding) => finding.itemIds.includes(itemId));
}
