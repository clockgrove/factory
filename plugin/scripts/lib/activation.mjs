export const DRAFT_LABEL = "pendulum:draft";

/** The owner's workflow for continuing an existing Objective without changing its identity label. */
export const RESUME_OBJECTIVE = `add \`${DRAFT_LABEL}\` if it is missing, then remove it to resume`;

function labelToggles(events, labels) {
  const seen = new Set();
  return (events || []).filter((e) => {
    if ((e?.event !== "labeled" && e?.event !== "unlabeled") || !labels.includes(e.label?.name) || !Number.isFinite(Date.parse(e.created_at))) return false;
    if (e.id === null || e.id === undefined) return true;
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  }).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
}

export const latestDraftEvent = (events) => labelToggles(events, [DRAFT_LABEL]).at(-1) ?? null;

/**
 * An Objective can run when its identity label is present and Draft is absent. New drafts are created with both
 * labels, which GitHub can report in either order in the same second. A Draft application in that same second
 * suppresses that identity event as a start. An old Objective label applied outside Draft still counts.
 * `assumeObjective` applies when the caller already knows the issue is an Objective but the timeline contains no
 * identity events. A recorded removal of the identity still stops it. Equal-time events keep their timeline order.
 */
export function activationEvents(events, label, { assumeObjective = false } = {}) {
  const toggles = labelToggles(events, [label, DRAFT_LABEL]);
  let objective = assumeObjective && !toggles.some((e) => e.label.name === label);
  // Null allows the first observed removal when the earlier application is missing from the timeline.
  let draft = null;
  const starts = [];
  for (const e of toggles) {
    if (e.label.name === label) {
      const applied = e.event === "labeled";
      if (applied && !objective && !draft) starts.push(e);
      objective = applied;
    } else if (e.event === "labeled") {
      if (draft) continue;
      draft = true;
      while (starts.at(-1)?.label.name === label && Date.parse(starts.at(-1).created_at) === Date.parse(e.created_at)) starts.pop();
    } else {
      if (draft !== false && objective) starts.push(e);
      draft = false;
    }
  }
  return starts;
}
