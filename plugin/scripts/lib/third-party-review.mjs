// A repository's third-party reviewers (`third_party_reviewers`): reviewer Apps outside Factory (Greptile's
// `greptile-apps[bot]`, say), named by login. Their review is part of the PR's review: the review stage waits for each
// one's review of the head its own reviewer read, within a bound, then its answer pass handles their line comments as it
// handles Factory's reviewer's. Their text is untrusted review input: sanitised like harness text, marked as theirs in
// the answer pass's prompt, and never instructions. With none named, nothing here runs.
import { rest } from "./github.mjs";
import { sanitize } from "./handoff.mjs";
import { log } from "./inputs.mjs";

/** How long the review stage waits for a named reviewer's review of the head (Greptile takes 10 to 15 minutes). */
export const THIRD_PARTY_WAIT_MS = 20 * 60_000;
/** The pause between reads of the PR's reviews while waiting. */
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

const pause = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener?.("abort", done);
      resolve();
    }
    signal?.addEventListener?.("abort", done, { once: true });
  });

/**
 * Wait for each named reviewer's review of `sha`: a submitted review by that login whose `commit_id` is `sha`. Reads
 * the PR's reviews now and then every `pollMs` until all have one, `boundMs` has passed, or `signal` (the stage's stop)
 * aborts. A failed read is no reading; it never throws. `onWait(left)` is called once, before the first pause.
 * Returns {reviewed, missing} (logins) and the minutes waited.
 */
export async function awaitThirdPartyReviews(repo, prNumber, sha, logins, { token, boundMs = THIRD_PARTY_WAIT_MS, pollMs = THIRD_PARTY_POLL_MS, signal = null, onWait = null, sleep = pause, now = Date.now } = {}) {
  const started = now();
  const done = new Set();
  let told = false;
  for (;;) {
    const reviews = await rest(`repos/${repo.full}/pulls/${prNumber}/reviews?per_page=100`, { token, paginate: true }).catch(() => null);
    for (const r of reviews || []) {
      const who = namedReviewer(r, logins);
      if (who && r.commit_id === sha && r.state !== "PENDING") done.add(who);
    }
    const left = logins.filter((l) => !done.has(l));
    const elapsed = now() - started;
    if (!left.length || signal?.aborted || elapsed >= boundMs) break;
    if (!told && onWait) await onWait(left);
    told = true;
    await sleep(Math.min(pollMs, boundMs - elapsed), signal);
  }
  return { reviewed: logins.filter((l) => done.has(l)), missing: logins.filter((l) => !done.has(l)), minutes: Math.round((now() - started) / 60_000) };
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
 * and, unless `skip` (the cap is spent: no answer pass runs), the wait for each one's review of `sha`, bounded by
 * THIRD_PARTY_WAIT_MS and by half the stage's time left (`leftMs`), said on the progress comment (`progress`). Returns
 * the logins whose comments the answer pass handles: every valid one named, reviewed in time or not, so a comment
 * one posted earlier is still answered. With none named it reads nothing and returns [].
 */
export async function thirdPartyStep({ repo, prNumber, sha, names = [], own = async () => [], skip = false, leftMs, progress, token, signal = null, sleep, now } = {}) {
  if (!names.length) return [];
  const { logins, refused } = thirdPartyReviewers(names, await own());
  if (refused.length) log(`third_party_reviewers: ${refused.join(", ")} left out (no login, or Factory's own)`);
  if (!logins.length || skip) return logins;
  const boundMs = Math.max(0, Math.min(THIRD_PARTY_WAIT_MS, Math.floor(leftMs / 2)));
  const head = String(sha).slice(0, 7);
  const waited = await awaitThirdPartyReviews(repo, prNumber, sha, logins, { token, boundMs, signal, ...(sleep ? { sleep } : {}), ...(now ? { now } : {}), onWait: (left) => progress(`third-party review: waiting up to ${Math.round(boundMs / 60_000)} min for ${left.join(", ")} to review ${head}`) });
  await progress(thirdPartyLine(waited, sha, boundMs));
  return logins;
}
