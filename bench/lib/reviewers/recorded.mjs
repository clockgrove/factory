/**
 * No model: the verdicts Factory recorded for the review, so the set's
 * history is scored the same way as a replay (its refusals by their hand
 * labels). A record whose full answer survives (`recorded.verdicts`) gives
 * every verdict; otherwise its refused criteria are refusals and the rest
 * passes, which is what a review that refused only those reached.
 */
export const id = "recorded";

export const fits = () => true;

export const needsTree = false;

const KIND = { pass: "pass", refuse: "refuse", "needs-human": "question" };

export async function review({ record }) {
  const { recorded } = record;
  const cost = { tokens: recorded.tokens ?? 0, ms: recorded.durationMs ?? 0 };
  if (recorded.verdicts)
    return {
      ...cost,
      verdicts: recorded.verdicts.map((v) => ({
        criterionIndex: v.criterionIndex,
        kind: KIND[v.verdict] ?? "question",
        detail: v.detail,
      })),
    };
  const refused = new Map(recorded.refused.map((r) => [r.criterionIndex, r]));
  return {
    ...cost,
    verdicts: record.criteria.map((_, criterionIndex) =>
      refused.has(criterionIndex)
        ? {
            criterionIndex,
            kind: "refuse",
            detail: refused.get(criterionIndex).detail,
          }
        : { criterionIndex, kind: "pass", detail: "" },
    ),
  };
}
