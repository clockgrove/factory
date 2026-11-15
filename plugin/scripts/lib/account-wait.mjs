// Two account labels on GitHub Actions and the cloud sandbox (#267): no stage of the Objective starts until one is left,
// and nothing Blocks for it, as in local mode (#259). The dispatcher leaves a Queued one unpicked (dispatch.mjs). A stage
// that meets two anyway waits, holding nothing:
// - a work stage (a second label went on while it started) puts its Objective back to Queued, where the dispatcher holds
//   it until one label or none is left;
// - a review stage (its review label starts it with no pick) takes `factory:review` off the PR and records the wait on
//   the PR (Factory's own comment, accountWaitMark). The dispatcher's tick puts the label back once one account label or
//   none is left (accountWaitResume), as after a third-party reviewer's wait (third-party-review.mjs), and the label
//   starts the review stage again on its route.
import { addLabels, findProject, moveCard, removeLabel, rest, setStateLabel, upsertComment } from "./github.mjs";
import { REVIEW_LABEL, isSelf, marker } from "./logic.mjs";
import { accountPin, routeTwoLine } from "./accounts.mjs";

/** The wait record's marker, the first line of Factory's own comment on the PR. */
export const accountWaitMark = (issue) => marker(issue, "account-wait");

/**
 * Make a stage that met two account labels (`two`) wait, as above: `stage` "review" with its PR's number in `pr`, else
 * a work stage. Returns the line the stage ends with. A failed write throws: the stage then fails as on any write.
 */
export async function waitOnAccounts({ repo, issue, stage, pr = null, two, opts }) {
  const line = routeTwoLine(two);
  if (stage === "review" && pr) {
    // The record first: a label taken off with no record would wait for nothing.
    await upsertComment(repo, pr, accountWaitMark(issue), `Factory: ${line}. The review waits; once one account label or none is left, Factory puts \`${REVIEW_LABEL}\` back on this PR and the review goes on.`, opts);
    await removeLabel(repo, pr, REVIEW_LABEL, opts);
    return `${line}; the review waits for one to be left`;
  }
  await setStateLabel(repo, issue, null, opts);
  await moveCard(await findProject(repo, opts).catch(() => null), repo, issue, "Queued", opts).catch(() => {});
  return `${line}; back to Queued until one is left`;
}

/** The PR's account-wait record (accountWaitMark, Factory's own comment): {id}, or null. */
export const accountWaitOf = (comments, issue) => {
  const c = [...(comments || [])].reverse().find((x) => isSelf(x) && String(x.body || "").startsWith(accountWaitMark(issue)));
  return c ? { id: c.id } : null;
};

/**
 * The dispatcher's half: a PR whose review waits on account labels (`wait`, accountWaitOf) gets its review label back
 * once the issue's `labels` hold one account label or none, and the record goes. Returns true when it resumed. Not
 * resumed while two are left; a failed write throws (the next tick tries again).
 */
export async function accountWaitResume({ repo, pr, wait, labels, opts }) {
  if (!wait || accountPin(labels).two) return false;
  await addLabels(repo, pr, [REVIEW_LABEL], opts);
  // The record goes after the label is back: one left behind only lets a later label-less PR resume early.
  await rest(`repos/${repo.full}/issues/comments/${wait.id}`, { ...opts, method: "DELETE" });
  return true;
}
