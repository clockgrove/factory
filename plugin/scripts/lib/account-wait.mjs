// Two account labels on GitHub Actions and the cloud sandbox (#267): no stage of the Objective starts until one is left,
// and nothing Blocks for it, as in local mode (#259). The dispatcher leaves a Queued one unpicked (dispatch.mjs). A stage
// that meets two anyway waits, holding nothing:
// - a work stage (a second label went on while it started) puts its Objective back to Queued, where the dispatcher holds
//   it until one label or none is left, or, sent back with an open PR, to In review, where the dispatcher sends nothing
//   back while two are on (dispatch.mjs);
// - a review stage (its review label starts it with no pick) takes `pendulum:review` off the PR and records the wait on
//   the PR (Pendulum's own comment, accountWaitMark). The dispatcher's tick puts the label back once one account label or
//   none is left (accountWaitResume), as after a third-party reviewer's wait (third-party-review.mjs), and the label
//   starts the review stage again on its route.
// A stage that met its account's usage limit while automatic account choice has another account free (route-holds.mjs,
// #268) goes the same way, so the next stage's account step picks that account: the work stage back to Queued or In
// review, the review's label off and put back at the dispatcher's next tick.
import { addLabels, findPr, findProject, moveCard, removeLabel, rest, setStateLabel, upsertComment } from "./github.mjs";
import { REVIEW_LABEL, isSelf, marker } from "./logic.mjs";
import { accountPin, routeTwoLine } from "./accounts.mjs";

/** The wait record's marker, the first line of Pendulum's own comment on the PR. */
export const accountWaitMark = (issue) => marker(issue, "account-wait");

/**
 * Make a stage wait, as above: on two account labels (`two`), or, with `limit` (the line naming the account a usage limit
 * holds), to go on on another account. `stage` "review" with its PR (`pr`, the PR or its number), else a work stage,
 * whose Objective goes back to In review when it has an open PR that is no draft (a send-back: the dispatcher sends it
 * again, and the stage then goes on with that PR and branch), else to Queued. Returns the line the stage ends with. A
 * failed write throws: the stage then fails as on any write.
 */
export async function waitOnAccounts({ repo, issue, stage, pr = null, two = null, limit = null, opts }) {
  const line = limit || routeTwoLine(two);
  const prNumber = typeof pr === "object" && pr ? pr.number : pr;
  if (stage === "review" && prNumber) {
    // The record first: a label taken off with no record would wait for nothing.
    const then = limit ? `The review goes on on another account: Pendulum puts \`${REVIEW_LABEL}\` back on this PR at its next tick.` : `The review waits; once one account label or none is left, Pendulum puts \`${REVIEW_LABEL}\` back on this PR and the review goes on.`;
    await upsertComment(repo, prNumber, accountWaitMark(issue), `Pendulum: ${line}. ${then}`, opts);
    await removeLabel(repo, prNumber, REVIEW_LABEL, opts);
    return limit ? `${line}; the review goes on on another account` : `${line}; the review waits for one to be left`;
  }
  const open = typeof pr === "object" && pr ? pr : await findPr(repo, `pendulum/${issue}`, opts).catch(() => null);
  const back = open && open.state !== "closed" && !open.draft ? "In review" : "Queued";
  await setStateLabel(repo, issue, back === "In review" ? "in-review" : null, opts);
  await moveCard(await findProject(repo, opts).catch(() => null), repo, issue, back, opts).catch(() => {});
  return limit ? `${line}; back to ${back}, to go on on another account` : `${line}; back to ${back} until one is left`;
}

/** The PR's account-wait record (accountWaitMark, Pendulum's own comment): {id, at} (its last write), or null. */
export const accountWaitOf = (comments, issue) => {
  const c = [...(comments || [])].reverse().find((x) => isSelf(x) && String(x.body || "").startsWith(accountWaitMark(issue)));
  return c ? { id: c.id, at: c.updated_at || c.created_at || null } : null;
};

/**
 * The dispatcher's half: a PR whose review waits on account labels (`wait`, accountWaitOf) gets its review label back
 * once the issue's `labels` hold one account label or none, and the record goes. A record older than the PR's latest
 * review label (`labelledAt`, its time: a label put back since, by the dispatcher or a person) is stale: the wait it
 * recorded is over, so it is deleted and resumes nothing. Returns "resumed", "stale" or "waiting"; a failed write
 * throws (the next tick tries again).
 */
export async function accountWaitResume({ repo, pr, wait, labels, labelledAt = null, opts }) {
  if (!wait) return "waiting";
  const drop = () => rest(`repos/${repo.full}/issues/comments/${wait.id}`, { ...opts, method: "DELETE" });
  if (labelledAt && wait.at && Date.parse(labelledAt) > Date.parse(wait.at)) {
    await drop();
    return "stale";
  }
  if (accountPin(labels).two) return "waiting";
  await addLabels(repo, pr, [REVIEW_LABEL], opts);
  // The record goes after the label is back; one left behind is stale from then on (the label's time is later).
  await drop();
  return "resumed";
}
