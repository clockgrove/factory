// Usage-limit holds per account on GitHub Actions and the cloud sandbox, and automatic account choice there (#268). Local
// mode keeps its holds in the machine's files (holds.mjs); these routes have no machine that outlives a job, so the same
// records live on GitHub, written by Factory's App alone: one comment per usage limit met, on Factory's own holds issue
// (HOLDS_TITLE, label `factory:holds`, closed and locked as the sandbox image's record issue is: github.mjs
// findRecordIssue). Only comments by Factory's own login on that issue count (isSelf), and only as written: a record is
// never edited, so one edited since (its updated_at is not its created_at: a person who can edit comments did it) holds
// nothing. So no one else can make, move or lengthen a hold; a person who deletes a hold's comment lifts it, and one who
// unlocks or retitles the issue drops every hold on it. Each record is a new comment, so jobs that meet limits at once
// each add theirs and lose none; a writer deletes the records forgotten (HOLD_FORGET_MS after their end). A reader makes
// one labelled issues query (a miss is "no holds") and lists that issue's comments; only a writer searches Factory's own
// issues past the label before it opens the issue, on its first limit. Only a stage whose harness has more than one
// account and the setting on reads or writes anything: with FACTORY_AUTO_ACCOUNT off, or one account, nothing here runs
// and every stage runs exactly as before. The records hold no secret: a harness, an account's name, times, a count and
// the limit's window.
//
// Hold semantics are holds.mjs's own (accountHolds over these records): a limit holds its account until the provider's
// reset, with the back-off floor for a provider that refuses again past its reset; a usage limit with no reset reported
// (Copilot's, Codex's with no snapshot) is a guess automatic choice avoids for 1, 4, then 24 hours. These routes write no
// served-pass record (a pass's end would cost a read on every stage): a back-off streak or a guess ends when its records
// are forgotten instead.
import { createHash } from "node:crypto";
import { HARNESS_NAMES, chooseAccount, routeAutoAccounts } from "./accounts.mjs";
import { waitOnAccounts } from "./account-wait.mjs";
import { addLabels, findRecordIssue, listComments, openRecordIssue, primeSelf, removeLabel, rest } from "./github.mjs";
import { HOLD_FORGET_MS, accountHolds, heldRecord } from "./holds.mjs";
import { log } from "./inputs.mjs";
import { isSelf, selfLogin } from "./logic.mjs";

/** Factory's holds issue: the label is a hint to find it, the exact title and Factory's own login are what count. */
export const HOLDS_LABEL = "factory:holds";
export const HOLDS_TITLE = "Factory: account holds";
const HOLDS_BODY = "Factory keeps the usage-limit holds of this repository's accounts on GitHub Actions and the cloud sandbox here: one comment per limit met, which automatic account choice (`FACTORY_AUTO_ACCOUNT`) reads. Factory reads only its own comments. Deleting one lifts that hold. Do not reopen.";

const iso = (ms) => new Date(ms).toISOString();
const LINE = /^<!-- factory:hold (\{[^\n]*\}) -->(?:\r?\n|$)/;
/** A hold record's first line (`<` and `>` escaped, as the image record's). */
export const holdLine = (r) => `<!-- factory:hold ${JSON.stringify(r).replace(/</g, "\\u003c").replace(/>/g, "\\u003e")} -->`;
/** The record a comment carries: Factory's own comment's first line, parsed, unchecked; else null. */
const rawRecord = (c) => {
  if (!isSelf(c) || (c.updated_at && c.created_at && c.updated_at !== c.created_at)) return null;
  const m = LINE.exec(String(c.body || ""));
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
};

/** The holds recorded on issue `number` at `now`: {records (heldRecord's), forgotten (ids of Factory's own past HOLD_FORGET_MS)}. */
async function recordsOn(repo, number, opts, now) {
  const records = [];
  const forgotten = [];
  if (number) {
    for (const c of await listComments(repo, number, opts)) {
      const v = rawRecord(c);
      if (!v) continue;
      const r = heldRecord(v, now);
      if (r) records.push(r);
      else if (Number.isSafeInteger(v.until) && now - v.until > HOLD_FORGET_MS) forgotten.push(c.id);
    }
  }
  return { records, forgotten };
}

const selfKnown = async (opts) => {
  // Factory's own login decides which records count: unknown, nothing is read as held, and nothing is written.
  if (!selfLogin() && !(await primeSelf(opts))) throw new Error("Factory's own login is unknown, so its holds cannot be told from anyone else's");
};

/**
 * The holds kept on GitHub at `now`, as a reader sees them: {issue (its number, or null), records (heldRecord's),
 * forgotten, store (holds.mjs accountHolds over the records)}. The labelled query alone finds the issue: no issue there
 * is no hold (one with its label taken off holds nothing until the next writer finds it again). A failed read throws.
 */
export async function readHolds(repo, opts, { now = Date.now(), actions } = {}) {
  await selfKnown(opts);
  const found = await findRecordIssue(repo, { label: HOLDS_LABEL, title: HOLDS_TITLE }, opts, { actions, fallback: false });
  const { records, forgotten } = await recordsOn(repo, found?.number, opts, now);
  return { issue: found?.number ?? null, records, forgotten, store: accountHolds({ seed: records }) };
}

/** An issue of Factory's that is no holds record (a stray from a race or a failed lock): retitled, its label off, closed. */
async function retire(repo, number, opts) {
  await rest(`repos/${repo.full}/issues/${number}`, { ...opts, method: "PATCH", body: { title: `${HOLDS_TITLE} (unused)`, state: "closed", state_reason: "not_planned" } }).catch(() => {});
  await removeLabel(repo, number, HOLDS_LABEL, opts).catch(() => {});
}

/**
 * The writer's holds issue: of Factory's own issues with HOLDS_TITLE (every page of them, by creator), the oldest one
 * locked (on Actions; any off it), its label put back when it was taken off. Every other one is retired: a newer
 * locked one a race opened, an unlocked one a failed lock left. Null with none.
 */
async function writerIssue(repo, opts, actions = process.env.GITHUB_ACTIONS === "true") {
  const self = selfLogin();
  const mine = ((await rest(`repos/${repo.full}/issues?creator=${encodeURIComponent(self)}&state=all&sort=created&direction=asc&per_page=100`, { ...opts, paginate: true })) || [])
    .filter((i) => !i.pull_request && isSelf(i) && i.title === HOLDS_TITLE)
    .sort((a, b) => a.number - b.number);
  const record = mine.find((i) => !actions || i.locked === true) ?? null;
  for (const i of mine) if (i !== record) await retire(repo, i.number, opts);
  // Its label taken off: put back, so readers' one labelled query finds it again.
  if (record && !(record.labels || []).some((l) => (typeof l === "string" ? l : l?.name) === HOLDS_LABEL)) await addLabels(repo, record.number, [HOLDS_LABEL], opts);
  return record?.number ?? null;
}

/**
 * Record that a stage on `account` met its usage limit: `kind` "limit", reset at `reset` (ms, the provider's), or "spent"
 * (no reset reported: a guess). The hold is holds.mjs's (limit, spent) over the records on the holds issue now; it is
 * written as a new comment there. With no issue by its label, Factory's own issues are searched by creator (one whose
 * label was taken off is found again, and strays retired); with none there either, the issue is opened, closed and locked, then looked for again: of two
 * jobs that opened one each at once, both write to the oldest and the other is retired. Then the forgotten records go.
 * Returns {until, store}: the hold's end and the holds with it. A failed read or write throws.
 */
export async function writeHold(repo, { kind, harness, account, reset = null, window = null, now = Date.now() }, opts, { actions } = {}) {
  await selfKnown(opts);
  // The labelled query first, as a reader's; Factory's own issues by creator only when it misses.
  let issue = (await findRecordIssue(repo, { label: HOLDS_LABEL, title: HOLDS_TITLE }, opts, { actions, fallback: false }))?.number ?? (await writerIssue(repo, opts, actions));
  if (!issue) {
    try {
      await openRecordIssue(repo, { label: HOLDS_LABEL, color: "5319e7", description: "Factory's account holds record", title: HOLDS_TITLE, body: HOLDS_BODY }, opts);
    } catch (e) {
      if (e.issue) await retire(repo, e.issue, opts);
      throw e;
    }
    issue = await writerIssue(repo, opts, actions);
    if (!issue) throw new Error("Factory's holds issue was opened but is not found as its own, locked issue");
  }
  const read = await recordsOn(repo, issue, opts, now);
  let made = null;
  const store = accountHolds({ seed: read.records, onPut: (r) => (made = r) });
  const until = kind === "spent" ? store.spent({ harness, account, now, window }) : store.limit({ harness, account, reset, now, window });
  const name = `account \`${account}\` (${HARNESS_NAMES[harness] || harness})`;
  const human =
    kind === "spent"
      ? `Factory: ${name} reached its usage limit with no reset reported; automatic account choice passes it over until ${iso(until)}.`
      : `Factory: ${name} reached its usage limit${made?.window ? ` (${made.window})` : ""}; it is held until ${iso(until)}.`;
  await rest(`repos/${repo.full}/issues/${issue}/comments`, { ...opts, method: "POST", body: { body: `${holdLine(made)}\n${human}` } });
  for (const id of read.forgotten) await rest(`repos/${repo.full}/issues/comments/${id}`, { ...opts, method: "DELETE" }).catch(() => {});
  return { until, store };
}

/**
 * An Objective's turn among `n` accounts: a hash of its number, never the number itself, since issues and PRs share one
 * numbering and Objectives' numbers often keep one parity, which would put them all on one account of two.
 */
export const routeTurn = (issue, n) => createHash("sha256").update(String(Number(issue) || 0)).digest().readUInt32BE(0) % n;

/**
 * The account automatic choice starts a stage of Objective `issue` on, of a harness's declared `names` (in order), from
 * the holds `store` at `now`: accounts.mjs chooseAccount, an account free when neither a hold nor a guess is ahead
 * (avoidUntil); of the free ones the least recently limited, then the Objective's turn, then the first declared; with
 * every one held, the one whose hold ends first. These routes keep no round-robin record (a write at every stage start):
 * the turn is a hash of the Objective's number (routeTurn), so Objectives spread across the accounts with no state, and
 * each keeps its account while that one is free. Returns {name, until} (`until`: its hold's end when every account is
 * held, else null).
 */
export function pickRouteAccount({ names, store, issue, now = Date.now() }) {
  const list = names.map((name) => ({ name }));
  const n = list.length;
  const turn = routeTurn(issue, n);
  const a = chooseAccount(list, {
    until: (x) => store.avoidUntil(x.name, now),
    limitedAt: (x) => store.limitedAt(x.name, now),
    startedAt: (x) => (list.indexOf(x) - turn + n) % n,
  });
  return { name: a.name, until: store.avoidUntil(a.name, now) };
}

/**
 * A stage's usage-limit handling on these routes with automatic account choice on (#268), or null when it does not apply
 * (the setting off, one account of the harness, or a stage on no declared account). `account` is the one the stage runs
 * on; `pinned`: a pin chose it (a label, or one a removal left standing), so the stage never moves off it; `stage`
 * "work" or "review", `pr` the review's PR (its number). `now` is a test's own.
 * - `elsewhere()`: whether another account of the harness is free now (a failed read, or a pinned stage: no), so the
 *   stage ends on a limit it would otherwise wait out in place (harness.mjs runHarness, LIMIT.movePastMs).
 * - `limit(e)`: the stage met its usage limit (harness.mjs UsageLimitReached): its account is held (writeHold), pinned or
 *   not, so automatic choice passes it over for other Objectives. Unpinned, with another account free, the Objective goes
 *   on there ({goOn: line}: account-wait.mjs waitOnAccounts, the work back to Queued or In review, the review's label
 *   off until the dispatcher's next tick); else {note}, the sentence its Block adds (none for a pinned stage, or when the
 *   move itself failed).
 * - `spent(limitRefused)`: the stage Blocked on a usage limit with no reset reported (session.mjs writeUsage): a guess.
 */
export function routeLimits({ repo, issue, stage, pr = null, harness, account, pinned = false, env = process.env, opts, now = () => Date.now() }) {
  const names = routeAutoAccounts(env, harness);
  if (!names || !names.includes(account)) return null;
  const others = names.filter((n) => n !== account);
  const free = (store, t) => others.filter((n) => store.avoidUntil(n, t) === null);
  const who = HARNESS_NAMES[harness] || harness;
  return {
    async elsewhere() {
      if (pinned) return false;
      try {
        const t = now();
        return free((await readHolds(repo, opts, { now: t })).store, t).length > 0;
      } catch (e) {
        log(`the account holds could not be read (${String(e?.message || e).slice(0, 120)}), so the usage limit is waited for here`);
        return false;
      }
    },
    async limit(e) {
      const t = now();
      const { until, store } = await writeHold(repo, { kind: "limit", harness, account, reset: e.resetAt, window: e.refusal?.limitType ?? null, now: t }, opts);
      const line = `${who} reached its usage limit on account \`${account}\`, which is held until ${iso(until)}`;
      if (pinned) return {};
      if (free(store, t).length) {
        try {
          return { goOn: await waitOnAccounts({ repo, issue, stage, pr, limit: line, opts }) };
        } catch (x) {
          log(`the hold on account ${account} is written, but the Objective could not be sent on to another account (${String(x?.message || x).slice(0, 120)}), so the stage Blocks`);
          return {};
        }
      }
      const first = Math.min(...others.map((n) => store.avoidUntil(n, t)));
      return { note: `Every other ${who} account this repository declares is held too, the first until ${iso(first)}.` };
    },
    async spent(limitRefused) {
      const { until } = await writeHold(repo, { kind: "spent", harness, account, window: limitRefused?.limitType ?? null, now: now() }, opts);
      log(`${who} account ${account} reached its usage limit with no reset reported; automatic account choice passes it over until ${iso(until)}`);
    },
  };
}
