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

function sameActor(a, b) {
  if (a?.id && b?.id) return a.id === b.id;
  return !!a?.login && a.login.toLowerCase() === b?.login?.toLowerCase();
}

/** GitHub may record the two labels from one issue creation in adjacent seconds. */
function draftFiledTogether(events, issue, objective, draft) {
  const opened = Date.parse(issue?.created_at);
  if (Date.parse(objective.created_at) !== opened || Date.parse(draft.created_at) - opened !== 1000) return false;
  if (!sameActor(issue.user, objective.actor) || !sameActor(issue.user, draft.actor)) return false;
  const ordered = events.filter((e) => Number.isFinite(Date.parse(e?.created_at))).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  return ordered.slice(ordered.indexOf(objective) + 1, ordered.indexOf(draft)).every((e) =>
    ["assigned", "milestoned", "added_to_project"].includes(e?.event) ||
    (e?.event === "labeled" && !/^pendulum:(running|in-review|blocked|question|restart)$/.test(e.label?.name ?? "")));
}

/**
 * An Objective can run when its identity label is present and Draft is absent. New drafts are created with both
 * labels. GitHub can report them in either order in the same second, or record the filer applying Draft one second
 * after issue creation. In either case, only releasing Draft starts the Objective. A later hold keeps any earlier start.
 * `assumeObjective` applies when the caller already knows the issue is an Objective but the timeline contains no
 * identity events. A recorded removal of the identity still stops it. Equal-time events keep their timeline order.
 */
export function activationEvents(events, label, { assumeObjective = false, issue = null } = {}) {
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
      if (starts[0] && starts[0] === toggles[0] && e === toggles[1] && draftFiledTogether(events, issue, starts[0], e)) starts.pop();
      while (starts.at(-1)?.label.name === label && Date.parse(starts.at(-1).created_at) === Date.parse(e.created_at)) starts.pop();
    } else {
      if (draft !== false && objective) starts.push(e);
      draft = false;
    }
  }
  return starts;
}
