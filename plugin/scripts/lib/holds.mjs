// Usage-limit holds per account (#264): a provider's usage limit holds only the account that met it (lib/accounts.mjs,
// by name; with none declared, the account named after its harness), and every `serve` on the machine, in any
// repository and after a restart, reads the same holds from ~/.cache/factory/holds, so none spends a call to find a
// limit another already met. Each limit met is one file of its own, written whole under a dot-name and renamed into
// place, never rewritten: writers at the same time each add theirs and lose none, with no lock. A hold is the latest
// reset any file names for the account; its back-off streak is the newest file's. The record holds no secret: a
// harness, an account's name, times and a count. The folder is outside every directory a sandbox may write, and the
// outer sandbox denies writing it (lib/local.mjs harnessOuterSettings). A file a sandbox or another user could have
// made (a link, another owner, group or world write bits) is not read.
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { writeNew } from "./fsafe.mjs";

/** The least a usage-limit hold lasts past now, by how many such pauses on one account came in a row (accountHolds.limit). */
export const LIMIT_BACKOFF_MS = [2, 5, 10, 15].map((m) => m * 60_000);
/** A hold that ended this long ago is forgotten, its back-off streak with it, and its file removed. */
export const HOLD_FORGET_MS = 60 * 60_000;

/** The machine's holds: under Factory's cache folder, never ~/.config/factory (no secret is in them). */
export const holdsDir = (home = homedir()) => join(home, ".cache", "factory", "holds");

const NAME = /^[a-z0-9][a-z0-9-]{0,49}$/;
const FILE = /^([a-z0-9][a-z0-9-]{0,49})\.[0-9a-f]{16}\.json$/;
const TEMP = /^\.[a-z0-9][a-z0-9-]{0,49}\.[0-9a-f]{16}\.tmp$/;
const MAX_BYTES = 4096;

/** One record, checked: {harness, account, until, streak, at}, or null. */
function recordOf(v, account) {
  if (!v || typeof v !== "object" || v.account !== account || typeof v.harness !== "string" || !NAME.test(v.harness)) return null;
  const { until, at, streak } = v;
  if (![until, at].every(Number.isSafeInteger) || !Number.isSafeInteger(streak) || streak < 0) return null;
  return { harness: v.harness, account, until, streak, at };
}

/** Whether `st` is a file or folder this user made that no one else may write: never a link. */
const ours = (st, uid) => !!st && !st.isSymbolicLink() && (uid === undefined || st.uid === uid) && !(st.mode & 0o022);

/**
 * The records in `dir`, read leniently (an unreadable or foreign file is left out, never thrown on). A record forgotten
 * (its hold ended HOLD_FORGET_MS ago) is removed, as is a writer's temp file older than that (a killed writer's).
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
      const m = FILE.exec(name);
      if (!m || st.size > MAX_BYTES || st.nlink !== 1) continue;
      const r = recordOf(JSON.parse(readFileSync(file, "utf8")), m[1]);
      if (!r) continue;
      if (now - r.until > HOLD_FORGET_MS) rmSync(file, { force: true });
      else out.push(r);
    } catch {
      // gone under the read (another serve forgot it), or not JSON: left out
    }
  }
  return out;
}

/**
 * An account's hold from its records: the latest reset any names, and the newest record's streak (of two made in the
 * same millisecond, the longer streak); null with none.
 */
function fold(records, account, now) {
  const mine = records.filter((r) => r.account === account && now - r.until <= HOLD_FORGET_MS);
  if (!mine.length) return null;
  const newest = mine.reduce((a, b) => (b.at > a.at || (b.at === a.at && b.streak > a.streak) ? b : a));
  return { harness: newest.harness, until: Math.max(...mine.map((r) => r.until)), streak: newest.streak };
}

/**
 * The machine's holds in `dir` (holdsDir), or in this process's memory alone with no `dir`. The files are the record: a
 * person who removes an account's files lifts its hold for every serve. A record that cannot be written to `dir` is
 * kept in this process's memory instead, so this process still holds the account, and `onError` hears why.
 * - `until(account, now)`: the reset (ms) the account is held until, when still ahead; else null.
 * - `held(harness, now)`: whether any account of that harness is held now.
 * - `limit({harness, account, reset, now})`: a stage on the account met its usage limit, reset at `reset` (ms, the
 *   provider's). A provider that refuses again past the reset it stated (or states one no more than LIMIT_BACKOFF_MS's
 *   last ahead) is not taken at its word: the hold is at least now plus a backoff that grows with each such pause in
 *   a row on that account (2, 5, 10, then 15 minutes); a reset further out starts the count again. Returns the hold's end.
 * - `served({harness, account, now})`: a pass on the account completed: its streak ends (its hold, if any, stays).
 */
export function accountHolds({ dir = null, uid = process.getuid?.(), onError = () => {} } = {}) {
  // Made before any stage starts, so the outer sandbox's deny of it covers a folder that exists.
  if (dir) {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch {
      // made again at the first write, which says why it cannot be
    }
  }
  let kept = [];
  const records = (now) => {
    kept = kept.filter((r) => now - r.until <= HOLD_FORGET_MS);
    return dir ? [...kept, ...readDir(dir, now, uid)] : kept;
  };
  const put = (r) => {
    if (!NAME.test(r.account) || !NAME.test(r.harness)) return;
    if (!dir) return void kept.push(r);
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
      return h && h.until > now ? h.until : null;
    },
    held(harness, now) {
      return records(now).some((r) => r.harness === harness && r.until > now);
    },
    limit({ harness, account, reset, now }) {
      const n = reset - now > LIMIT_BACKOFF_MS.at(-1) ? 0 : (of(account, now)?.streak ?? 0) + 1;
      const until = n ? Math.max(reset, now + LIMIT_BACKOFF_MS[Math.min(n, LIMIT_BACKOFF_MS.length) - 1]) : reset;
      put({ harness, account, until, streak: n, at: now });
      return until;
    },
    served({ harness, account, now }) {
      if ((of(account, now)?.streak ?? 0) > 0) put({ harness, account, until: now, streak: 0, at: now });
    },
  };
}
