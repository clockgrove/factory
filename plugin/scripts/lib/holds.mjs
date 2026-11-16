// Usage-limit holds per account (#264): a provider's usage limit holds only the account that met it (lib/accounts.mjs:
// a declared one by its name; with none declared, by its login: local.mjs holdOf), and every `serve` on the machine, in any
// repository and after a restart, reads the same holds from ~/.cache/factory/holds, so none spends a call to find a
// limit another already met. Each limit met is one file of its own, written whole under a dot-name and renamed into
// place, never rewritten: writers at the same time each add theirs and lose none, with no lock. A hold is the latest
// reset any file names for the account; its back-off streak is the newest file's. The record holds no secret: a
// harness, an account's name, times, a count and the limit's window when the harness named it. With automatic account
// choice on (#266), each account also has one `<key>.started.json`, replaced whole at each stage start on it: the
// machine's round-robin, where the last writer wins and nothing else depends on it. The folder is outside
// every directory a sandbox may write, and the outer sandbox denies writing it (lib/local.mjs harnessOuterSettings). A
// file a sandbox or another user could have made (a link, another owner, group or world write bits) is not read. A
// person lifts an account's hold with `factory hold release` (#376): one more file, a release record, that ends every
// record made on the account before it, for every serve, and resets its back-off count; no file need be removed.
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { writeNew } from "./fsafe.mjs";

/** The least a usage-limit hold lasts past now, by how many such pauses on one account came in a row (accountHolds.limit). */
export const LIMIT_BACKOFF_MS = [2, 5, 10, 15].map((m) => m * 60_000);
/** A hold that ended this long ago is forgotten, its back-off streak with it, and its file removed. */
export const HOLD_FORGET_MS = 60 * 60_000;
/**
 * A no-reset limit's guess (accountHolds.spent), and a served pass's record that can end one, is kept this long past its
 * end: a second such limit within a day of the first guess's end counts on (1, 4, then 24 hours), so an account out
 * for longer (a monthly quota) is retried less and less often rather than every hour or two (#332).
 */
export const GUESS_FORGET_MS = 24 * 60 * 60_000;
/**
 * Whether record `r` is forgotten at `now`: HOLD_FORGET_MS past its end, GUESS_FORGET_MS for a guess or a served pass's
 * (a release record is one too: `release`).
 */
export const forgotten = (r, now) => now - r.until > (r.guess === true || r.served === true ? GUESS_FORGET_MS : HOLD_FORGET_MS);
/** The longest a hold lasts past now: a week's window and a day more. A record naming a later end is held to it. */
export const HOLD_MAX_MS = 8 * 24 * 60 * 60_000;
/**
 * How long automatic account choice (#266) avoids an account that met its usage limit or quota with no reset reported
 * (Copilot's always, Codex's when its snapshot names none: accountHolds.spent), by how many in a row: 1, 4, then 24
 * hours. Nothing else holds on it: with the setting off, or the Objective pinned, such a limit Blocks; with it on, the
 * Objective moves to a free account (#332), and Blocks only when none is free.
 */
export const SPENT_GUESS_MS = [1, 4, 24].map((h) => h * 60 * 60_000);
/** A stage-start record (accountHolds.started) of an account no stage started on this long is removed. */
export const START_FORGET_MS = HOLD_MAX_MS;

/** The machine's holds: under Factory's cache folder, never ~/.config/factory (no secret is in them). */
export const holdsDir = (home = homedir()) => join(home, ".cache", "factory", "holds");

const NAME = /^[a-z0-9][a-z0-9-]{0,49}$/;
/** A hold's key: a declared account's name, or a harness's login (`<harness>@<12 hex>`, or `@env` for a token in serve's env). */
const KEY_SRC = "[a-z0-9][a-z0-9-]{0,49}(?:@(?:[0-9a-f]{12}|env))?";
const KEY = new RegExp(`^${KEY_SRC}$`);
/** Whether `k` is a hold's key a record may carry (a declared account's name, or a login's). */
export const holdKey = (k) => typeof k === "string" && KEY.test(k);
const FILE = new RegExp(`^(${KEY_SRC})\\.[0-9a-f]{16}\\.json$`);
const TEMP = new RegExp(`^\\.${KEY_SRC}\\.[0-9a-f]{16}\\.tmp$`);
const STARTED = new RegExp(`^(${KEY_SRC})\\.started\\.json$`);
const MAX_BYTES = 4096;

/** A usage limit's window as the harness names it (usage.mjs providerRefusal `limitType`: `five_hour`, `codex/primary`), else null. */
const WINDOW = /^[a-z0-9][a-z0-9_./-]{0,39}$/i;
export const windowOf = (w) => (typeof w === "string" && WINDOW.test(w) ? w : null);

/** One record, checked: {harness, account, until, streak, at, window?, served?, guess?, released?}, or null. */
function recordOf(v, account) {
  if (!v || typeof v !== "object" || v.account !== account || typeof v.harness !== "string" || !NAME.test(v.harness)) return null;
  const { until, at, streak } = v;
  if (![until, at].every(Number.isSafeInteger) || !Number.isSafeInteger(streak) || streak < 0) return null;
  const window = windowOf(v.window);
  return { harness: v.harness, account, until, streak, at, ...(window ? { window } : {}), ...(v.served === true ? { served: true } : {}), ...(v.guess === true ? { guess: true } : {}), ...(v.released === true ? { released: true } : {}) };
}

/**
 * Another clock's (or a hand-made) record: no end past the longest window, and one made "after now" is the oldest for the
 * streak, so it never stands over every later record.
 */
export const clamped = (r, now) => ({ ...r, until: Math.min(r.until, now + HOLD_MAX_MS), at: r.at > now ? 0 : r.at });

/**
 * A record kept somewhere other than this machine's files (route-holds.mjs: GitHub Actions and the cloud sandbox keep
 * theirs on GitHub, #268), checked as a file's is and held to this clock: the record, or null when it is none, its key is
 * no account's, or it is forgotten (`forgotten`).
 */
export function heldRecord(v, now) {
  if (typeof v?.account !== "string" || !KEY.test(v.account)) return null;
  const r = recordOf(v, v.account);
  return r && !forgotten(r, now) ? clamped(r, now) : null;
}

/**
 * The records that stand: every release record (`release`) ends each record of its account made at or before it, and
 * goes itself. Every record here, a release included, is already held to the reader's clock (clamped): one dated after
 * now (another clock's) reads as the oldest, so such a release ends nothing until that time comes.
 */
export function standing(records) {
  const released = new Map();
  for (const r of records) if (r.released && r.at > (released.get(r.account) ?? -Infinity)) released.set(r.account, r.at);
  return records.filter((r) => !r.released && !(r.at <= (released.get(r.account) ?? -Infinity)));
}

/** Whether `st` is a file or folder this user made that no one else may write: never a link. */
const ours = (st, uid) => !!st && !st.isSymbolicLink() && (uid === undefined || st.uid === uid) && !(st.mode & 0o022);

/**
 * The records in `dir`, read leniently (an unreadable or foreign file is left out, never thrown on). A record forgotten
 * (`forgotten`) is removed, as is a writer's temp file older than HOLD_FORGET_MS (a killed writer's), and a stage-start
 * record not written for START_FORGET_MS (an account no longer declared, a login no serve runs on now).
 */
function readDir(dir, now, uid) {
  let names;
  try {
    if (!ours(lstatSync(dir, { throwIfNoEntry: false }), uid)) return [];
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const file = join(dir, name);
    try {
      const st = lstatSync(file, { throwIfNoEntry: false });
      if (!st?.isFile() || !ours(st, uid)) continue;
      if (TEMP.test(name)) {
        if (now - st.mtimeMs > HOLD_FORGET_MS) rmSync(file, { force: true });
        continue;
      }
      if (STARTED.test(name)) {
        if (now - st.mtimeMs > START_FORGET_MS) rmSync(file, { force: true });
        continue;
      }
      const m = FILE.exec(name);
      if (!m || st.size > MAX_BYTES || st.nlink !== 1) continue;
      const r = recordOf(JSON.parse(readFileSync(file, "utf8")), m[1]);
      if (!r) continue;
      if (forgotten(r, now)) rmSync(file, { force: true });
      else out.push(clamped(r, now));
    } catch {
      // gone under the read (another serve forgot it), or not JSON: left out
    }
  }
  return out;
}

/**
 * An account's hold from its records: the latest reset any names (`until`, and that record's window, when it names one;
 * null with only guesses), the newest such record's back-off streak and time (`streak`, `at`: of two made in the same
 * millisecond, the longer streak; 0 and null with none), when the newest usage limit was met (`limitedAt`: a served
 * pass's record is no limit), and the guess (`guess`: accountHolds.spent) its no-reset limits since the last served pass
 * stand for, {until, streak, at} (their own count, apart from the back-off's), or null; null with no record.
 */
function fold(records, account, now) {
  const mine = records.filter((r) => r.account === account && !forgotten(r, now));
  if (!mine.length) return null;
  const newestOf = (list) => (list.length ? list.reduce((a, b) => (b.at > a.at || (b.at === a.at && b.streak > a.streak) ? b : a)) : null);
  const hard = mine.filter((r) => !r.guess);
  const newest = newestOf(hard);
  // A served pass's record holds nothing: its end only keeps it as long as the hold and the guess it outlives.
  const limitsMet = hard.filter((r) => !r.served);
  const latest = limitsMet.length ? limitsMet.reduce((a, b) => (b.until > a.until || (b.until === a.until && b.window && !a.window) ? b : a)) : null;
  const limits = mine.filter((r) => !r.served).map((r) => r.at);
  // A served pass after a no-reset limit shows the account is not spent: that guess is over.
  const served = Math.max(-Infinity, ...mine.filter((r) => r.served).map((r) => r.at));
  const guesses = mine.filter((r) => r.guess && r.at > served);
  const guess = newestOf(guesses);
  return { harness: newestOf(mine).harness, until: latest?.until ?? null, streak: newest?.streak ?? 0, at: newest?.at ?? null, window: latest?.window ?? null, limitedAt: limits.length ? Math.max(...limits) : null, guess: guess ? { until: Math.max(...guesses.map((r) => r.until)), streak: guess.streak, at: guess.at } : null };
}

/** A stage-start record's file (accountHolds.started): one per account, replaced whole at each start. */
const START = (key) => `${key}.started.json`;

/**
 * The machine's holds in `dir` (holdsDir), or in this process's memory alone with no `dir`. The files are the record: a
 * person who removes an account's files lifts its hold for every serve. A record that cannot be written to `dir` is
 * kept in this process's memory instead, so this process still holds the account, and `onError` hears why.
 * - `until(account, now)`: the reset (ms) the account is held until, when still ahead; else null.
 * - `window(account, now)`: the window of the usage limit that holds it that long (`five_hour`), or null when unknown.
 * - `held(harness, now, guesses)`: whether any account of that harness is held now (with `guesses`, avoided: `spent`).
 * - `limit({harness, account, reset, now, window})`: a stage on the account met its usage limit, reset at `reset` (ms, the
 *   provider's), of `window` when the harness named one. A provider that refuses again past the reset it stated (or states one no more than LIMIT_BACKOFF_MS's
 *   last ahead) is not taken at its word: the hold is at least now plus a backoff that grows with each such pause in
 *   a row on that account (2, 5, 10, then 15 minutes); a reset further out starts the count again. Returns the hold's end.
 * - `served({harness, account, now, started})`: a pass on the account completed, its stage started at `started` (ms):
 *   the streak ends (its hold, if any, stays) when that start is after the newest record's, and a guess (`spent`) made
 *   before that start is over.
 * - `limitedAt(account, now)`: when a stage last met the account's usage limit (ms), while its records are kept; else null.
 * - `spent({harness, account, now, window})`: a stage on the account met its usage limit or quota with no reset reported.
 *   Only automatic account choice (#266) weighs it (`avoidUntil`), for SPENT_GUESS_MS by how many in a row, until a pass
 *   on the account is served; `until` and `held`'s holds never include it. Returns the guess's end.
 * - `avoidUntil(account, now)`: `until`, or the guess's end when that is later; null when neither is ahead.
 * - `started({harness, account, now})`: a stage starts on the account now (automatic account choice's round-robin, #266):
 *   one small file per account, replaced whole, so every serve on the machine takes turns from the same record.
 * - `forgetStarts(keep)`: the start records of declared accounts' names not in `keep` (no longer declared) are removed;
 *   a login's (`<harness>@…`) goes START_FORGET_MS after its last start, since another serve may run on it.
 * - `startedAt(account, now)`: when a stage last started on the account (ms), or null; a time after `now` (another clock's,
 *   or a hand-made file) counts as long ago, as a hold record's does.
 * - `list(now)`: every account the records remember a hold or a guess of, by key: {account, harness, until (the hold's
 *   end, past or ahead; null with only guesses), window, streak (the back-off count), guess ({until, streak}, or null)}.
 * - `release({account, now})`: a person lifts the account's holds and guesses (`factory hold release`, #376): one record
 *   that ends every record of the account made before it (standing), for every serve here, so its hold, its guess and
 *   its back-off count are gone, and a later limit counts from one. It is a served pass's record too, so a serve on an
 *   older Factory, which knows no release, at least ends the guess and the count. Returns what it ended (`list`'s entry),
 *   or null when the records remember nothing of the account, and writes nothing then.
 * - `releasedAt(account, now)`: when the account was last released (ms), while that record is kept; else null.
 * `account` is the hold's key: a declared account's name, or a login's (local.mjs holdOf).
 * With no `dir`, `seed` is the records already kept elsewhere (heldRecord's), and `onPut` hears each record this store
 * makes, for its caller to keep there (route-holds.mjs).
 */
export function accountHolds({ dir = null, uid = process.getuid?.(), onError = () => {}, seed = [], onPut = null } = {}) {
  // Made before any stage starts, so the outer sandbox's deny of it covers a folder that exists.
  if (dir) {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch {
      // made again at the first write, which says why it cannot be
    }
  }
  let kept = dir ? [] : [...seed];
  const starts = new Map();
  // Every record kept, release records too; `records` is those that stand (standing).
  const all = (now) => {
    kept = kept.filter((r) => !forgotten(r, now));
    return dir ? [...kept, ...readDir(dir, now, uid)] : kept;
  };
  const records = (now) => standing(all(now));
  const put = (r) => {
    if (!dir || !KEY.test(r.account) || !NAME.test(r.harness)) {
      kept.push(r);
      if (dir) onError(new Error("the account's key is not one a file may be named by"));
      else onPut?.(r);
      return;
    }
    const id = randomBytes(8).toString("hex");
    const temp = join(dir, `.${r.account}.${id}.tmp`);
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (!ours(lstatSync(dir), uid)) throw new Error("the holds folder is a link, another user's, or writable by others");
      writeNew(temp, `${JSON.stringify(r)}\n`);
      renameSync(temp, join(dir, `${r.account}.${id}.json`));
    } catch (e) {
      rmSync(temp, { force: true });
      kept.push(r);
      onError(e);
    }
  };
  const of = (account, now) => fold(records(now), account, now);
  return {
    dir,
    until(account, now) {
      const h = of(account, now);
      return h && h.until !== null && h.until > now ? h.until : null;
    },
    window(account, now) {
      const h = of(account, now);
      return h && h.until > now ? h.window : null;
    },
    held(harness, now, guesses = false) {
      return records(now).some((r) => r.harness === harness && !r.served && (guesses || !r.guess) && r.until > now);
    },
    avoidUntil(account, now) {
      const h = of(account, now);
      const end = Math.max(h?.until ?? -Infinity, h?.guess?.until ?? -Infinity);
      return end > now ? end : null;
    },
    spent({ harness, account, now, window = null }) {
      const n = (of(account, now)?.guess?.streak ?? 0) + 1;
      const until = now + SPENT_GUESS_MS[Math.min(n, SPENT_GUESS_MS.length) - 1];
      const w = windowOf(window);
      put({ harness, account, until, streak: n, at: now, guess: true, ...(w ? { window: w } : {}) });
      return until;
    },
    limit({ harness, account, reset, now, window = null }) {
      const n = reset - now > LIMIT_BACKOFF_MS.at(-1) ? 0 : (of(account, now)?.streak ?? 0) + 1;
      const until = Math.min(n ? Math.max(reset, now + LIMIT_BACKOFF_MS[Math.min(n, LIMIT_BACKOFF_MS.length) - 1]) : reset, now + HOLD_MAX_MS);
      const w = windowOf(window);
      put({ harness, account, until, streak: n, at: now, ...(w ? { window: w } : {}) });
      return until;
    },
    served({ harness, account, now, started }) {
      const h = of(account, now);
      // Only a pass that started after the newest limit met: one that ran before it says nothing of the account now.
      // Its record lasts as long as the hold and the guess it ends, so neither older record stands again once it is gone.
      const backoff = h?.streak > 0 && started > h.at;
      const guess = !!h?.guess && started > h.guess.at;
      if (backoff || guess) put({ harness, account, until: Math.max(now, h.until ?? now, h.guess?.until ?? now), streak: 0, at: now, served: true });
    },
    limitedAt(account, now) {
      return of(account, now)?.limitedAt ?? null;
    },
    list(now) {
      const keys = [...new Set(records(now).map((r) => r.account))].sort();
      return keys.flatMap((account) => {
        const h = of(account, now);
        return h && (h.until !== null || h.guess) ? [{ account, harness: h.harness, until: h.until, window: h.window, streak: h.streak, guess: h.guess }] : [];
      });
    },
    release({ account, now }) {
      const h = this.list(now).find((x) => x.account === account);
      if (!h) return null;
      put({ harness: h.harness, account, until: now + HOLD_MAX_MS, streak: 0, at: now, served: true, released: true });
      return h;
    },
    releasedAt(account, now) {
      const at = all(now).filter((r) => r.released && r.account === account).map((r) => r.at);
      return at.length ? Math.max(...at) : null;
    },
    started({ harness, account, now }) {
      starts.set(account, now);
      if (!dir || !KEY.test(account) || !NAME.test(harness)) return;
      const temp = join(dir, `.${account}.${randomBytes(8).toString("hex")}.tmp`);
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        if (!ours(lstatSync(dir), uid)) throw new Error("the holds folder is a link, another user's, or writable by others");
        writeNew(temp, `${JSON.stringify({ harness, account, at: now })}\n`);
        renameSync(temp, join(dir, START(account)));
      } catch (e) {
        rmSync(temp, { force: true });
        onError(e);
      }
    },
    forgetStarts(keep) {
      if (!dir) return;
      try {
        if (!ours(lstatSync(dir, { throwIfNoEntry: false }), uid)) return;
        for (const name of readdirSync(dir)) {
          const key = STARTED.exec(name)?.[1];
          if (key && !key.includes("@") && !keep.includes(key)) rmSync(join(dir, name), { force: true });
        }
      } catch (e) {
        onError(e);
      }
    },
    startedAt(account, now = Date.now()) {
      const mine = starts.get(account) ?? null;
      if (!dir || !KEY.test(account)) return mine;
      try {
        const file = join(dir, START(account));
        const st = lstatSync(file, { throwIfNoEntry: false });
        if (!st?.isFile() || !ours(st, uid) || st.nlink !== 1 || st.size > MAX_BYTES || !ours(lstatSync(dir), uid)) return mine;
        const v = JSON.parse(readFileSync(file, "utf8"));
        return v?.account === account && Number.isSafeInteger(v.at) ? Math.max(v.at > now ? 0 : v.at, mine ?? -Infinity) : mine;
      } catch {
        return mine;
      }
    },
  };
}
