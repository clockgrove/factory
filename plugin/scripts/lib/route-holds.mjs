// Usage-limit holds per account on GitHub Actions and the cloud sandbox, and automatic account choice there (#268).
// Local mode keeps its holds in the machine's files (holds.mjs); these routes have no machine that outlives a job, so
// the same records live on GitHub, written by Factory's App alone: one comment per usage limit met, on Factory's own
// holds issue (HOLDS_TITLE, label `factory:holds`, closed and locked as the sandbox image's record issue is: github.mjs
// findRecordIssue; normally one, two only after a race at the first limit until a writer moves the newer one's records
// over and retires it). Only comments by Factory's own login there count (isSelf), and only as written: a record is
// never edited, so one edited since (its updated_at is not its created_at: a person who can edit comments did it) holds
// nothing. So no one else can make, move or lengthen a hold; a person who deletes a hold's comment lifts it, and one
// who unlocks or retitles the issue drops every hold on it. Each record is a new comment, so jobs that meet limits at
// once each add theirs and lose none; a writer deletes the records forgotten (holds.mjs forgotten: an hour after a
// hold's end, a day after a guess's). A reader makes one labelled issues query (a miss is "no holds") and lists that
// issue's comments; only a writer searches Factory's own issues past the label before it opens the issue, on its first
// limit. Only a stage whose harness has more than one account and the setting on reads or writes anything: with
// FACTORY_AUTO_ACCOUNT off, or one account, nothing here runs and every stage runs exactly as before. The records hold
// no secret: a harness, an account's name, times, a count and the limit's window.
//
// Hold semantics are holds.mjs's own (accountHolds over these records): a limit holds its account until the provider's
// reset, with the back-off floor for a provider that refuses again past its reset; a usage limit with no reset reported
// (Copilot's, Codex's with none in its snapshot) is a guess automatic choice avoids for 1, 4, then 24 hours, and the
// Objective that met it moves to a free account as on a known reset (#332). These routes write no served-pass record
// (a pass's end would cost a read on every stage): a back-off streak or a guess ends when its records are forgotten
// instead.
//
// A person who can push lifts a hold with `factory hold release <account> --repo OWNER/NAME` (#376): a release record,
// a comment of theirs on the holds issue (RELEASE_LINE), which ends every record of that account made before it, as a
// local release does (holds.mjs standing). The issue is locked, so only people with write access can comment there; a
// reader counts a release only from a person who can push (logic.mjs pushAuthor, else their permission read), and only
// as written. It is kept, and then deleted by a writer, as long as any record it ends could be (holds.mjs forgotten).
import { createHash } from "node:crypto";
import { HARNESS_NAMES, chooseAccount, routeAutoAccounts } from "./accounts.mjs";
import { waitOnAccounts } from "./account-wait.mjs";
import { addLabels, collaboratorPermission, listComments, openRecordIssue, primeSelf, removeLabel, rest } from "./github.mjs";
import { HOLD_MAX_MS, accountHolds, clamped, forgotten as forgottenAt, heldRecord, holdKey } from "./holds.mjs";
import { guessHoursMs, input, log } from "./inputs.mjs";
import { isSelf, pushAuthor, selfLogin } from "./logic.mjs";

/** Factory's holds issue: the label is a hint to find it, the exact title and Factory's own login are what count. */
export const HOLDS_LABEL = "factory:holds";
export const HOLDS_TITLE = "Factory: account holds";
const HOLDS_BODY = "Factory keeps the usage-limit holds of this repository's accounts on GitHub Actions and the cloud sandbox here: one comment per limit met, which automatic account choice (`FACTORY_AUTO_ACCOUNT`) reads. Factory reads only its own comments, and a release by a person who can push (`factory hold release <account> --repo OWNER/NAME`), which lifts that account's holds. Do not reopen.";

const iso = (ms) => new Date(ms).toISOString();
const LINE = /^<!-- factory:hold (\{[^\n]*\}) -->(?:\r?\n|$)/;
/** A hold record's first line (`<` and `>` escaped, as the image record's). */
export const holdLine = (r) => `<!-- factory:hold ${JSON.stringify(r).replace(/</g, "\\u003c").replace(/>/g, "\\u003e")} -->`;
const edited = (c) => !!(c.updated_at && c.created_at && c.updated_at !== c.created_at);
/** The record a comment carries: Factory's own comment's (`own`) first line, parsed, unchecked; else null. */
const rawRecord = (c, own = isSelf) => {
  if (!own(c) || edited(c)) return null;
  const m = LINE.exec(String(c.body || ""));
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
};

/** A release record's first line, a person's (factory hold release): the account's hold key alone. */
export const RELEASE_LINE = /^<!-- factory:release (\{[^\n]*\}) -->(?:\r?\n|$)/;
export const releaseLine = (account) => `<!-- factory:release ${JSON.stringify({ account })} -->`;
const WRITE = new Set(["admin", "maintain", "write"]);

/** Whether a login can push to `repo` (its permission read once per login per `pushCheck`); a failed read is no. */
const pushCheck = (repo, opts) => {
  const asked = new Map();
  return (login) => {
    if (!asked.has(login)) asked.set(login, collaboratorPermission(repo, login, opts).then((p) => WRITE.has(p), () => false));
    return asked.get(login);
  };
};

/**
 * The release a comment carries, as holds.mjs keeps one (`released`, at the comment's creation by GitHub's clock, held
 * to the reader's `now` as a hold record is: holds.mjs clamped), when a person who can push wrote it and it was never
 * edited; else null. `canPush` is pushCheck's.
 */
async function releaseOf(c, canPush, now) {
  const m = RELEASE_LINE.exec(String(c.body || ""));
  if (!m || c.user?.type !== "User" || edited(c)) return null;
  let v;
  try {
    v = JSON.parse(m[1]);
  } catch {
    return null;
  }
  const at = Date.parse(c.created_at || "");
  if (typeof v?.account !== "string" || !holdKey(v.account) || !Number.isSafeInteger(at)) return null;
  if (!pushAuthor(c) && !(await canPush(c.user.login))) return null;
  return clamped({ harness: "release", account: v.account, until: at + HOLD_MAX_MS, streak: 0, at, served: true, released: true }, now);
}

/**
 * The holds recorded on issue `number` at `now`: {records (heldRecord's), releases (releaseOf's), forgotten (ids of
 * record comments a writer deletes: forgotten (holds.mjs), or Factory's own edited since written, which count for
 * nothing)}. `own`: whose comments are Factory's records (isSelf; a person's view names the issue's author).
 */
async function recordsOn(repo, number, opts, now, own = isSelf) {
  const records = [];
  const releases = [];
  const forgotten = [];
  const canPush = pushCheck(repo, opts);
  if (number) {
    for (const c of await listComments(repo, number, opts)) {
      if (own(c) && LINE.test(String(c.body || "")) && edited(c)) {
        forgotten.push(c.id);
        continue;
      }
      const rel = await releaseOf(c, canPush, now);
      if (rel) {
        if (forgottenAt(rel, now)) forgotten.push(c.id);
        else releases.push(rel);
        continue;
      }
      const v = rawRecord(c, own);
      if (!v) continue;
      const r = heldRecord(v, now);
      if (r) records.push(r);
      else if (Number.isSafeInteger(v.until) && forgottenAt(v, now)) forgotten.push(c.id);
    }
  }
  return { records, releases, forgotten };
}

const selfKnown = async (opts) => {
  // Factory's own login decides which records count: unknown, nothing is read as held, and nothing is written.
  if (!selfLogin() && !(await primeSelf(opts))) throw new Error("Factory's own login is unknown, so its holds cannot be told from anyone else's");
};

const hasLabel = (i) => (i.labels || []).some((l) => (typeof l === "string" ? l : l?.name) === HOLDS_LABEL);
const ownHolds = (i, actions) => !i.pull_request && isSelf(i) && i.title === HOLDS_TITLE && (!actions || i.locked === true);

/**
 * Factory's holds issues as a reader finds them: one labelled query (no other page), its own with the exact title,
 * locked on Actions, oldest first. Normally one; two only after a race at the first limit, until a writer retires the
 * newer, and every one's records count meanwhile, so a hold written to either is read.
 */
async function labelledIssues(repo, opts, actions = process.env.GITHUB_ACTIONS === "true") {
  const self = selfLogin();
  const list = (await rest(`repos/${repo.full}/issues?creator=${encodeURIComponent(self)}&labels=${encodeURIComponent(HOLDS_LABEL)}&state=all&sort=created&direction=asc&per_page=100`, opts)) || [];
  return list.filter((i) => ownHolds(i, actions)).sort((a, b) => a.number - b.number);
}

/**
 * The holds kept on GitHub at `now`, as a reader sees them: {issue (the oldest's number, or null), records (heldRecord's,
 * of every holds issue found), store (holds.mjs accountHolds over the records)}. The labelled query alone finds them: none
 * there is no hold (an issue with its label taken off holds nothing until the next writer finds it again). A failed read
 * throws.
 */
export async function readHolds(repo, opts, { now = Date.now(), actions } = {}) {
  await selfKnown(opts);
  const issues = await labelledIssues(repo, opts, actions);
  const records = [];
  for (const i of issues) {
    const r = await recordsOn(repo, i.number, opts, now);
    records.push(...r.records, ...r.releases);
  }
  return { issue: issues[0]?.number ?? null, records, store: accountHolds({ seed: records }) };
}

/**
 * The holds on GitHub as a person's token reads them (`factory hold list --repo`, #376), which does not know Factory's
 * App by its login: Factory's holds issues are the labelled ones with the exact title, locked, opened by an App, whose
 * records are that App's own comments. {issue (the oldest's number, or null), store (holds.mjs accountHolds over them)}.
 * Issues of two Apps are refused, naming them, since which one is Factory's cannot be told. A failed read throws.
 */
export async function personHolds(repo, opts, { now = Date.now() } = {}) {
  const list = (await rest(`repos/${repo.full}/issues?labels=${encodeURIComponent(HOLDS_LABEL)}&state=all&sort=created&direction=asc&per_page=100`, opts)) || [];
  const issues = list.filter((i) => !i.pull_request && i.user?.type === "Bot" && i.title === HOLDS_TITLE && i.locked === true).sort((a, b) => a.number - b.number);
  const apps = [...new Set(issues.map((i) => i.user.login))];
  if (apps.length > 1) throw new Error(`more than one App opened a holds issue (${issues.map((i) => `#${i.number} by ${i.user.login}`).join(", ")}), so Factory's cannot be told; close and unlock the ones that are not Factory's App's`);
  const own = (c) => c.user?.login === apps[0];
  const records = [];
  for (const i of issues) {
    const r = await recordsOn(repo, i.number, opts, now, own);
    records.push(...r.records, ...r.releases);
  }
  return { issue: issues[0]?.number ?? null, store: accountHolds({ seed: records }) };
}

/**
 * Release `account`'s holds on GitHub (`factory hold release --repo`, #376): a release record, the person's own comment on
 * the oldest holds issue, which every reader takes as the end of each record of that account made before it. Returns
 * {released (holds.mjs list's entry for it, or null when nothing of it is held: then nothing is written), known (the
 * keys of the accounts that are), issue, refused (why readers will not count the comment posted, read back as a reader
 * reads it: a token that is no person's, or a person who cannot push; else null)}. A failed read or write throws.
 */
export async function releaseRouteHold(repo, account, opts, { now = Date.now() } = {}) {
  const { issue, store } = await personHolds(repo, opts, { now });
  const known = store.list(now);
  const released = known.find((x) => x.account === account) ?? null;
  if (!released) return { released, known: known.map((x) => x.account), issue };
  const text = `Factory: account \`${account}\` (${HARNESS_NAMES[released.harness] || released.harness}) released by a person; every hold and guess on it recorded before this comment is over, and its back-off count starts again.`;
  const posted = await rest(`repos/${repo.full}/issues/${issue}/comments`, { ...opts, method: "POST", body: { body: `${releaseLine(account)}\n${text}` } });
  const who = posted?.user?.login || "an unknown login";
  const counts = !!posted && (await releaseOf(posted, pushCheck(repo, opts), Infinity)) !== null;
  const refused = counts ? null : posted?.user?.type !== "User" ? `it was posted as ${who}, which is no person (an App's or a workflow's token), and Factory counts a release only from a person who can push` : `${who} cannot push to ${repo.full}, and Factory counts a release only from a person who can push`;
  return { released, known: known.map((x) => x.account), issue, refused };
}

/** An issue of Factory's that is no holds record (a stray from a race or a failed lock): retitled, its label off, closed. */
async function retire(repo, number, opts) {
  await rest(`repos/${repo.full}/issues/${number}`, { ...opts, method: "PATCH", body: { title: `${HOLDS_TITLE} (unused)`, state: "closed", state_reason: "not_planned" } }).catch(() => {});
  await removeLabel(repo, number, HOLDS_LABEL, opts).catch(() => {});
}

/** How young an unlocked holds issue of Factory's may be and still be one another job is opening: never retired. */
export const OPENING_MS = 10 * 60_000;

/**
 * The writer's holds issues: {record (the oldest of Factory's own issues with HOLDS_TITLE that is locked, on Actions; any
 * off it: its number, or null), strays (the others to retire once this writer's own record is written: a newer locked one
 * a race opened, an unlocked one a failed lock left; never an unlocked one opened within OPENING_MS, which another job may
 * still be closing and locking), relabel (whether the record's label was taken off)}. `scan`: every page of Factory's own
 * issues by creator; else the labelled query's alone.
 */
async function writerIssues(repo, opts, { actions = process.env.GITHUB_ACTIONS === "true", scan, now }) {
  const self = selfLogin();
  const mine = scan
    ? ((await rest(`repos/${repo.full}/issues?creator=${encodeURIComponent(self)}&state=all&sort=created&direction=asc&per_page=100`, { ...opts, paginate: true })) || []).filter((i) => ownHolds(i, false)).sort((a, b) => a.number - b.number)
    : await labelledIssues(repo, opts, actions);
  const record = mine.find((i) => ownHolds(i, actions)) ?? null;
  const opening = (i) => i.locked !== true && now - Date.parse(i.created_at || "") < OPENING_MS;
  return { record: record?.number ?? null, strays: mine.filter((i) => i !== record && !opening(i)).map((i) => i.number), relabel: !!record && !hasLabel(record) };
}

/**
 * Record that a stage on `account` met its usage limit: `kind` "limit", reset at `reset` (ms, the provider's), or "spent"
 * (no reset reported: a guess, by `steps`, the guess_hours setting). The hold is holds.mjs's (limit, spent) over the records on the holds issues now; it is
 * written as a new comment on the oldest. With none by its label, Factory's own issues are searched by creator (one whose
 * label was taken off is found again); with none there either, the issue is opened, closed and locked, then looked for
 * again: of two jobs that opened one each at once, both write to the oldest. Only once this writer's record is written:
 * its label goes back on, the forgotten and edited records go, and each stray's live records are copied to the record
 * issue before it is retired, so a hold another job wrote there is kept. Returns {until, store}: the hold's end and the
 * holds with it. A failed read or write throws.
 */
export async function writeHold(repo, { kind, harness, account, reset = null, window = null, now = Date.now(), steps = undefined }, opts, { actions } = {}) {
  await selfKnown(opts);
  let found = await writerIssues(repo, opts, { actions, scan: false, now });
  if (!found.record) found = await writerIssues(repo, opts, { actions, scan: true, now });
  if (!found.record) {
    try {
      await openRecordIssue(repo, { label: HOLDS_LABEL, color: "5319e7", description: "Factory's account holds record", title: HOLDS_TITLE, body: HOLDS_BODY }, opts);
    } catch (e) {
      if (e.issue) await retire(repo, e.issue, opts);
      throw e;
    }
    found = await writerIssues(repo, opts, { actions, scan: true, now });
    if (!found.record) throw new Error("Factory's holds issue was opened but is not found as its own, locked issue");
  }
  const issue = found.record;
  const read = await recordsOn(repo, issue, opts, now);
  const strays = [];
  for (const n of found.strays) strays.push({ n, ...(await recordsOn(repo, n, opts, now)) });
  let made = null;
  const store = accountHolds({ seed: [...read.records, ...read.releases, ...strays.flatMap((x) => [...x.records, ...x.releases])], onPut: (r) => (made = r) });
  const until = kind === "spent" ? store.spent({ harness, account, now, window, steps }) : store.limit({ harness, account, reset, now, window });
  const name = `account \`${account}\` (${HARNESS_NAMES[harness] || harness})`;
  const human =
    kind === "spent"
      ? `Factory: ${name} reached its usage limit with no reset reported; automatic account choice passes it over until ${iso(until)}.`
      : `Factory: ${name} reached its usage limit${made?.window ? ` (${made.window})` : ""}; it is held until ${iso(until)}.`;
  const post = (r, text) => rest(`repos/${repo.full}/issues/${issue}/comments`, { ...opts, method: "POST", body: { body: `${holdLine(r)}\n${text}` } });
  await post(made, human);
  // Its record is written: the clean-up, each step on its own, none failing the hold.
  if (found.relabel) await addLabels(repo, issue, [HOLDS_LABEL], opts).catch(() => {});
  for (const id of read.forgotten) await rest(`repos/${repo.full}/issues/comments/${id}`, { ...opts, method: "DELETE" }).catch(() => {});
  for (const x of strays) {
    try {
      for (const r of x.records) await post(r, `Factory: a hold on account \`${r.account}\` copied from #${x.n}, which Factory no longer uses.`);
      await retire(repo, x.n, opts);
    } catch {
      // left for the next writer: its records still count (readHolds reads every holds issue found)
    }
  }
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

/** An account's hold in a Block's words: until its reset, or about a guess's end when no reset was reported (holds.mjs spent). */
const heldText = (store, name, t) => {
  const hard = store.until(name, t);
  const end = store.avoidUntil(name, t);
  return end !== null && end !== hard ? `\`${name}\` passed over until about ${iso(end)} (no reset reported)` : `\`${name}\` held until ${iso(end ?? t)}`;
};

/**
 * A stage's usage-limit handling on these routes with automatic account choice on (#268), or null when it does not apply
 * (the setting off, one account of the harness, or a stage on no declared account). `account` is the one the stage runs
 * on; `pinned`: a pin chose it (a label, or one a removal left standing), so the stage never moves off it; `stage`
 * "work" or "review", `pr` the review's PR (its number). `now` is a test's own.
 * - `elsewhere()`: whether another account of the harness is free now (a failed read, or a pinned stage: no), so the
 *   stage ends on a limit it would otherwise wait out in place (harness.mjs runHarness, LIMIT.movePastMs).
 * - `limit(e)`: the stage met its usage limit (harness.mjs UsageLimitReached): its account is held (writeHold), pinned or
 *   not, so automatic choice passes it over for other Objectives; with no reset reported (`e.resetAt` null: a usage
 *   limit or quota that ended the unpinned stage at once, harness.mjs LIMIT.moves, #332) the hold is the guess `spent`
 *   writes. Unpinned, with another account free (read with this stage's own hold written, so the move never lands back
 *   on it), the Objective goes on there ({goOn: line}: account-wait.mjs waitOnAccounts, the work back to Queued or In
 *   review, the review's label off until the dispatcher's next tick); else {note}, the sentence its Block adds (none for
 *   a pinned stage, or when the move itself failed), naming each other account's hold when no reset was reported. Each
 *   such move holds the account it leaves until its reset or guess, so an Objective's moves end once every account is
 *   held: it then Blocks once.
 * - `spent(limitRefused)`: the stage Blocked on a usage limit with no reset reported (session.mjs writeUsage): a guess.
 */
export function routeLimits({ repo, issue, stage, pr = null, harness, account, pinned = false, env = process.env, opts, now = () => Date.now() }) {
  const names = routeAutoAccounts(env, harness);
  if (!names || !names.includes(account)) return null;
  // The guess's steps: the repository's guess_hours (inputs.mjs), Factory's default when it is not a list of hours.
  const steps = guessHoursMs(input("guess_hours", { env })) ?? undefined;
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
      const noReset = !Number.isFinite(e.resetAt);
      const { until, store } = await writeHold(repo, { kind: noReset ? "spent" : "limit", harness, account, reset: e.resetAt, window: e.refusal?.limitType ?? null, now: t, steps }, opts);
      const line = noReset ? `${who} reached its usage limit or quota on account \`${account}\` with no reset reported, so automatic account choice passes it over until about ${iso(until)}` : `${who} reached its usage limit on account \`${account}\`, which is held until ${iso(until)}`;
      if (pinned) return {};
      if (free(store, t).length) {
        try {
          return { goOn: await waitOnAccounts({ repo, issue, stage, pr, limit: line, opts }) };
        } catch (x) {
          log(`the hold on account ${account} is written, but the Objective could not be sent on to another account (${String(x?.message || x).slice(0, 120)}), so the stage Blocks`);
          return {};
        }
      }
      if (noReset) return { note: `Every other ${who} account this repository declares is held too: ${others.map((n) => heldText(store, n, t)).join("; ")}.` };
      const first = Math.min(...others.map((n) => store.avoidUntil(n, t)));
      return { note: `Every other ${who} account this repository declares is held too, the first until ${iso(first)}.` };
    },
    async spent(limitRefused) {
      const { until } = await writeHold(repo, { kind: "spent", harness, account, window: limitRefused?.limitType ?? null, now: now(), steps }, opts);
      log(`${who} account ${account} reached its usage limit with no reset reported; automatic account choice passes it over until ${iso(until)}`);
    },
  };
}
