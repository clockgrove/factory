// A repository's third-party reviewers (`third_party_reviewers`): reviewer Apps outside Factory (Greptile's
// `greptile-apps[bot]`, say), named by login. Their review is part of the PR's review: the review stage waits for each
// one's review of the head its own reviewer read, within a bound, then its answer pass handles their line comments as it
// handles Factory's reviewer's. Their text is untrusted review input: sanitised like harness text, marked as theirs in
// the answer pass's prompt, and never instructions. With none named, nothing here runs.
//
// The wait holds nothing: a stage whose named reviewer has not reviewed the head yet records the wait on the PR (its
// wait record: the head, the logins, GitHub's time of the record) and ends `waiting`, its review label taken off. The
// dispatcher's tick, on every route (the Action's, a cloud sandbox's, `serve`'s), puts the label back once that review
// exists or the bound has passed (waitState), and the label starts the review stage again as it always does. That stage
// finds Factory's own review already posted, so no reviewer pass runs again, and goes on to the answer pass.
import { addLabels, listComments, objectiveLabeledAt, removeLabel, rest, setStateLabel } from "./github.mjs";
import { sanitize } from "./handoff.mjs";
import { log } from "./inputs.mjs";
import { REVIEW_LABEL, isSelf, selfLogin, trustedAuthor } from "./logic.mjs";

/** How long Factory waits for a named reviewer's review of the head, from its wait record (Greptile takes 10 to 15 minutes). */
export const THIRD_PARTY_WAIT_MS = 20 * 60_000;
/** How often `serve`'s ticks read a waiting PR's reviews at most (the Action's dispatcher reads on its own ticks). */
export const THIRD_PARTY_POLL_MS = 60_000;
/** The most of one third-party comment the answer pass is given. */
export const THIRD_PARTY_TEXT_MAX = 8000;

const key = (login) => String(login ?? "").trim().replace(/^@/, "").toLowerCase();
// A GitHub login, or an App's `<slug>[bot]`: nothing else can author a review.
const LOGIN = /^[a-z0-9](?:[a-z0-9-]{0,38})(?:\[bot\])?$/;

/**
 * The named reviewers Factory waits for and answers: each valid login once, lower-cased. A name that is no login, or
 * one of Factory's own (`own`: the reviewer's App and the login Factory posts as), is refused: Factory's own review is
 * handled already, and its comments must never read as a stranger's.
 */
export function thirdPartyReviewers(names = [], own = []) {
  const ours = new Set(own.map(key).filter(Boolean));
  const logins = [];
  const refused = [];
  for (const name of names) {
    const k = key(name);
    if (!LOGIN.test(k) || ours.has(k)) refused.push(String(name));
    else if (!logins.includes(k)) logins.push(k);
  }
  return { logins, refused };
}

/** The named reviewer who wrote a review or comment (its `user.login`, matched exactly), or null. */
export const namedReviewer = (item, logins = []) => (logins.length ? (logins.find((l) => l === key(item?.user?.login)) ?? null) : null);

/**
 * A named reviewer's line comment as the answer pass gets it: its id, place and body, the body sanitised (handoff.mjs
 * sanitize) and cut, and `from`, the reviewer, which marks it as untrusted review input.
 */
export const thirdPartyComment = (c, from) => ({ id: c.id, path: c.path, line: c.line ?? c.original_line ?? null, body: sanitize(c.body, { max: THIRD_PARTY_TEXT_MAX }), from });

/**
 * The comments that hold the stage's exit (decideExit's unanswered count): every one of Factory's own, and a named
 * reviewer's only when the answer pass was given it (`given`, ids). One that came after the wait is left for the next
 * review: the stage went on without it.
 */
export const exitUnaddressed = (open, given) => {
  const ids = new Set([...given].map(String));
  return open.filter((c) => !c.from || ids.has(String(c.id)));
};

/** Which of `logins` submitted a review of `sha` (a review by that login whose `commit_id` is `sha`, not pending). */
export function reviewedHead(reviews, sha, logins) {
  const done = new Set();
  for (const r of reviews || []) {
    const who = namedReviewer(r, logins);
    if (who && r.commit_id === sha && r.state !== "PENDING") done.add(who);
  }
  return { reviewed: logins.filter((l) => done.has(l)), missing: logins.filter((l) => !done.has(l)) };
}

/** The PR's reviews, or null when they cannot be read (no reading: the wait goes on). */
const readReviews = (repo, prNumber, opts) => rest(`repos/${repo.full}/pulls/${prNumber}/reviews?per_page=100`, { ...opts, paginate: true }).catch(() => null);

/** The wait record's first line starts with this; JSON follows on the same line. */
const WAIT_MARK = (issue) => `<!-- factory:${Number(issue)}:third-party `;
const LOGINS_MAX = 10;

/** The wait record's body: the head and the logins waited for, then a line for people. */
export function waitBody(issue, { sha, logins, at }) {
  const data = JSON.stringify({ sha, logins: logins.slice(0, LOGINS_MAX), at }).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
  return `${WAIT_MARK(issue)}${data} -->\nFactory: waiting up to ${Math.round(THIRD_PARTY_WAIT_MS / 60_000)} min for ${logins.join(", ")} to review ${String(sha).slice(0, 7)}; the review goes on once that review is posted, or then without it.`;
}

/**
 * The PR's wait record, the newest by Factory itself or by someone who can push (trustedAuthor: a local loop writes as
 * its developer, so the Action's dispatcher and another developer's loop read its record too): {id, sha, logins, since,
 * updatedAt, own}, or null. `since` is GitHub's creation time of the comment, so the bound runs on GitHub's clock;
 * `updatedAt` its last write; `own` whether this process wrote it (only its own is rewritten).
 */
export function waitOf(comments, issue) {
  const mark = WAIT_MARK(issue);
  for (const c of [...(comments || [])].reverse()) {
    const body = String(c?.body || "");
    if (!trustedAuthor(c) || !body.startsWith(mark)) continue;
    const m = /^(\{[^\n]*\}) -->/.exec(body.slice(mark.length));
    let data = null;
    try {
      data = m ? JSON.parse(m[1]) : null;
    } catch {
      data = null;
    }
    const since = Date.parse(c.created_at);
    if (!data || !/^[0-9a-f]{40,64}$/.test(data.sha || "") || !Array.isArray(data.logins) || !Number.isFinite(since)) continue;
    const logins = thirdPartyReviewers(data.logins.slice(0, LOGINS_MAX)).logins;
    if (!logins.length) continue;
    return { id: c.id, sha: data.sha, logins, since, updatedAt: Date.parse(c.updated_at || c.created_at), own: isSelf(c) };
  }
  return null;
}

/** When a wait record's bound passes (ms): THIRD_PARTY_WAIT_MS after GitHub created it. */
export const waitUntil = (wait) => wait.since + THIRD_PARTY_WAIT_MS;

const dropWait = (repo, wait, opts) => (wait ? rest(`repos/${repo.full}/issues/comments/${wait.id}`, { ...opts, method: "DELETE" }).catch((e) => log(`third-party wait record: ${String(e?.message || e).slice(0, 120)}`)) : null);

/**
 * Before a review stage ends `waiting`: what the dispatcher needs to resume it. The PR's review label comes off (a
 * label left on would start nothing again), and the Objective is In review, the only state the dispatcher resumes: an
 * Objective whose Question a person answered by marking its PR ready still carries `factory:question`, which goes now,
 * as the review's own exit would take it off (`labels`, the issue's as the stage read them). {ok} when the stage may
 * end; otherwise {ok: false, why}, with the review label back on, and the stage goes on without the wait.
 */
export async function waitEnd({ repo, issue, prNumber, labels = [], token }) {
  const opts = { token };
  try {
    await removeLabel(repo, prNumber, REVIEW_LABEL, opts);
  } catch (e) {
    log(`review label: ${String(e?.message || e).slice(0, 120)}`);
    return { ok: false, why: "the review label could not be taken off" };
  }
  const states = (labels || []).map((l) => (typeof l === "string" ? l : l?.name)).filter((n) => /^factory:(running|blocked|question|in-review)$/.test(n || ""));
  if (states.length === 1 && states[0] === "factory:in-review") return { ok: true };
  try {
    await setStateLabel(repo, issue, "in-review", opts);
    return { ok: true };
  } catch (e) {
    log(`state label: ${String(e?.message || e).slice(0, 120)}`);
    await addLabels(repo, prNumber, [REVIEW_LABEL], opts).catch((x) => log(`review label: ${String(x?.message || x).slice(0, 120)}`));
    return { ok: false, why: "the Objective could not be moved to In review" };
  }
}

/** Remove the PR's wait record, if any (a stage that went on after all). Never throws. */
export async function clearWait({ repo, issue, prNumber, token }) {
  const comments = await listComments(repo, prNumber, { token }).catch(() => []);
  await dropWait(repo, waitOf(comments, issue), { token });
}

/** The progress line after the wait: who reviewed the head, and who did not within the bound (the stage goes on). */
export function thirdPartyLine({ reviewed, missing }, sha, boundMs) {
  const head = String(sha).slice(0, 7);
  const parts = [];
  if (reviewed.length) parts.push(`${reviewed.join(", ")} reviewed ${head}`);
  if (missing.length) parts.push(`${missing.join(", ")} posted no review of ${head} within ${Math.round(boundMs / 60_000)} min; going on without ${missing.length === 1 ? "it" : "them"}`);
  return `third-party review: ${parts.join("; ")}`;
}

/**
 * The review stage's step before its answer pass: the named reviewers (`names`, the setting; `own`, Factory's logins)
 * and, unless `skip` (the cap is spent: no answer pass runs), whether to go on now. It reads the PR's reviews and its
 * wait record once each. Every named reviewer has reviewed `sha`, or the record for `sha` is past its bound
 * (THIRD_PARTY_WAIT_MS from GitHub's time of the record): the stage goes on, says so on its progress comment
 * (`progress`) and removes the record. Otherwise it records the wait (a new record for a new head; the same one,
 * rewritten, when a review starts again within its bound, so the bound is never restarted) and returns `wait`
 * ({missing, until}): the stage ends there, holding nothing, and the dispatcher starts it again (waitState). A record
 * that cannot be read or written is no wait: the stage goes on without the reviewer rather than stall. Returns {logins,
 * wait}: `logins` are the ones whose comments the answer pass handles, every valid one named, reviewed or not, so a
 * comment one posted earlier is still answered. With none named it reads nothing and returns no logins.
 */
export async function thirdPartyStep({ repo, issue, prNumber, sha, names = [], own = async () => [], skip = false, progress, token, now = Date.now } = {}) {
  if (!names.length) return { logins: [], wait: null };
  const { logins, refused } = thirdPartyReviewers(names, await own());
  if (refused.length) log(`third_party_reviewers: ${refused.join(", ")} left out (no login, or Factory's own)`);
  // No wait here (the cap spent: no answer pass runs): a record an earlier stage left goes, so it holds no later merge.
  if (!logins.length || skip) {
    await clearWait({ repo, issue, prNumber, token });
    return { logins, wait: null };
  }
  const opts = { token };
  const head = String(sha).slice(0, 7);
  // Factory's own login unknown: its record could not be told from a pasted one, so a stage started again would post a
  // new record with a new bound every time. No wait.
  if (!selfLogin()) {
    await clearWait({ repo, issue, prNumber, token });
    await progress(`third-party review: Factory's own login is unknown, so its wait record could not be read back; going on without waiting`);
    return { logins, wait: null };
  }
  const seen = reviewedHead(await readReviews(repo, prNumber, opts), sha, logins);
  let comments;
  try {
    comments = await listComments(repo, prNumber, opts);
  } catch (e) {
    await progress(`third-party review: the PR's wait record could not be read (${String(e?.message || e).slice(0, 80)}); going on without waiting`);
    return { logins, wait: null };
  }
  const record = waitOf(comments, issue);
  const current = record?.sha === sha ? record : null;
  const passed = current && now() >= waitUntil(current);
  // Only this process's own record is rewritten; another writer's for this head gets a record of ours beside it.
  const mine = current?.own ? current : null;
  if (!seen.missing.length || passed) {
    await progress(thirdPartyLine(seen, sha, THIRD_PARTY_WAIT_MS));
    await dropWait(repo, record, opts);
    return { logins, wait: null };
  }
  const body = waitBody(issue, { sha, logins: seen.missing, at: new Date(now()).toISOString() });
  let since;
  try {
    if (mine) {
      await rest(`repos/${repo.full}/issues/comments/${mine.id}`, { ...opts, method: "PATCH", body: { body } });
      since = mine.since;
    } else {
      const made = await rest(`repos/${repo.full}/issues/${prNumber}/comments`, { ...opts, method: "POST", body: { body } });
      since = Date.parse(made?.created_at);
      if (!Number.isFinite(since)) since = now();
      if (record && !current) await dropWait(repo, record, opts);
    }
  } catch (e) {
    await dropWait(repo, record, opts);
    await progress(`third-party review: the wait could not be recorded on the PR (${String(e?.message || e).slice(0, 80)}); going on without ${seen.missing.join(", ")}`);
    return { logins, wait: null };
  }
  const until = since + THIRD_PARTY_WAIT_MS;
  await progress(`third-party review: waiting until ${new Date(until).toISOString().slice(11, 16)} UTC for ${seen.missing.join(", ")} to review ${head}; this stage ends here, holding no slot, and the review goes on once that review is posted or then`);
  return { logins, wait: { missing: seen.missing, until } };
}

/**
 * The dispatcher's read of an unlabelled In-review PR's wait (thirdPartyStep's record, `wait`: waitOf over the PR's
 * comments it already read), on every route. Null when there is none (or the PR is a draft or closed). Otherwise:
 *  - {waiting, until}: the bound is ahead and a named reviewer has not reviewed the head (or the reviews are unread);
 *    the PR is left as it is (no merge pass, no update), and `until` is when time alone changes that;
 *  - {resume, until}: `reviewed`, `deadline`, or `head`: the PR's head is no longer the one the record waits on (a
 *    maintainer's commit, GitHub's "Update branch"), so that head needs its review; the caller puts the review label
 *    back, which starts the review again (as the merge pass does for a head that is not GitHub's update of the reviewed one);
 *  - {stale}: a review was asked for since the record was last written, so its stage has taken the wait up already.
 * `reads` (serve's memory, `${pr}:${sha}` to ms) keeps the reviews read to one per THIRD_PARTY_POLL_MS per head; the
 * Action's dispatcher reads on its own ticks. `unread` is set when the review label's history could not be read.
 */
export async function waitState({ repo, issue, pr, wait, opts, now = Date.now(), reads = null }) {
  if (!wait || !pr || pr.draft || pr.state === "closed") return null;
  const until = waitUntil(wait);
  let resume = wait.sha !== pr.head?.sha ? "head" : now >= until ? "deadline" : null;
  if (!resume) {
    const key = `${pr.number}:${wait.sha}`;
    const last = reads?.get(key);
    if (Number.isFinite(last) && now - last < THIRD_PARTY_POLL_MS) return { waiting: true, until };
    reads?.set(key, now);
    const reviews = await readReviews(repo, pr.number, opts);
    if (reviews && !reviewedHead(reviews, wait.sha, wait.logins).missing.length) resume = "reviewed";
    else return { waiting: true, until };
  }
  // The review label applied since the record was last written: that review stage has the wait (a record its end could
  // not remove). Unread: nothing is put back this tick.
  let labelled;
  try {
    labelled = await objectiveLabeledAt(repo, pr.number, REVIEW_LABEL, opts);
  } catch {
    return { waiting: true, until, unread: true };
  }
  if (labelled && Date.parse(labelled) >= wait.updatedAt) return { stale: true };
  reads?.delete(`${pr.number}:${wait.sha}`);
  return { resume, until };
}
