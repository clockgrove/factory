/**
 * The exact install's package store the whole installation shares across
 * Objectives (#2353, after #2280): `<work root>/.packages/<key>/cache`, one
 * per `installKey`, so an Objective's first install of a key reuses what
 * earlier Objectives fetched. Never emptied for another key; a new one is
 * made whole under a temporary name and renamed into place, so installs of
 * one key at once never remove the store another is filling. The key is the
 * directory's name and `claims` sits beside `cache`, both outside what the
 * install may write. Old keys are pruned by last use, by age and by total
 * size (`Retention`).
 *
 * Pruning removes a key only when it is safe while another install might
 * use it: not used for `GRACE_MS`, and with no live claim. A claim is a
 * file named for the claiming process, held for one install; one left by a
 * dead process no longer counts. Everything between reading a key's claims
 * and renaming it away is synchronous, so no install in this process claims
 * a key in between (one Factory service writes an installation).
 */
import { execFile } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { forceRemove } from "./paths.js";

const execFileAsync = promisify(execFile);

/** A key unused for this long, with no live claim, may be pruned. */
const GRACE_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const KEY = /^[0-9a-f]{64}$/;
let removals = 0;

/** What the installation keeps: keys unused for `days`, then the oldest until `mib` MiB remain, are pruned. */
export interface Retention {
  days: number;
  mib: number;
}

/** A shared store, ready for one install. */
export interface SharedStore {
  /** The package-manager store and caches' root, the install's to write. */
  root: string;
  /** What holds it, removed when the store is not kept. */
  directory: string;
  /** An earlier install of this key made it. */
  reused: boolean;
  shared: true;
}

/** The claims one install holds on keys, released when it ends (`using`). */
export class StoreClaims implements Disposable {
  private files: string[] = [];
  private static count = 0;

  claim(kept: string): void {
    const directory = join(kept, "claims");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, `${process.pid}-${StoreClaims.count++}`);
    writeFileSync(file, "", { mode: 0o600 });
    this.files.push(file);
  }

  [Symbol.dispose](): void {
    for (const file of this.files) rmSync(file, { force: true });
    this.files = [];
  }
}

/** Whether a process holds a claim on `kept`. */
function claimed(kept: string): boolean {
  let names: string[] = [];
  try {
    names = readdirSync(join(kept, "claims"));
  } catch {
    return false;
  }
  return names.some((name) => {
    const pid = Number.parseInt(name, 10);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  });
}

/**
 * The installation's store for installs of one `key`, claimed by `claims`
 * until they are disposed. A key made now prunes the old ones (`retention`).
 */
export async function sharedStore(
  directory: string,
  key: string,
  claims: StoreClaims,
  retention?: Retention,
): Promise<SharedStore> {
  const kept = join(directory, key);
  const root = join(kept, "cache");
  const store = { root, directory: kept, shared: true as const };
  const use = (): void => {
    const now = new Date();
    claims.claim(kept);
    utimesSync(kept, now, now);
  };
  if (lstatSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    use();
    return { ...store, reused: true };
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const made = await mkdtemp(join(directory, ".new-"));
  try {
    mkdirSync(join(made, "cache"), { mode: 0o700 });
    renameSync(made, kept);
  } catch (error) {
    await forceRemove(made);
    // Another install of this key made it first: this one shares it.
    if (!lstatSync(root, { throwIfNoEntry: false })?.isDirectory()) throw error;
    use();
    return { ...store, reused: true };
  }
  use();
  if (retention)
    await prune(directory, retention).catch(() => {
      // Pruning is housekeeping: the next new key tries again.
    });
  return { ...store, reused: false };
}

/** Kibibytes each of `paths` holds, by `du`; a path it can't read counts 0. */
async function sizes(paths: string[]): Promise<Map<string, number>> {
  const sized = new Map<string, number>();
  if (!paths.length) return sized;
  let output = "";
  try {
    output = (await execFileAsync("du", ["-sk", "--", ...paths])).stdout;
  } catch (error) {
    output = String((error as { stdout?: string }).stdout ?? "");
  }
  for (const line of output.split("\n")) {
    const [size, ...path] = line.split("\t");
    if (path.length) sized.set(path.join("\t"), Number(size) || 0);
  }
  return sized;
}

/**
 * Removes keys unused for `retention.days`, then the oldest until the rest
 * hold at most `retention.mib`, and temporary directories a crash left. A
 * key used within the grace period, or with a live claim, stays.
 */
async function prune(directory: string, retention: Retention): Promise<void> {
  const paths = readdirSync(directory)
    .filter((name) => KEY.test(name))
    .map((name) => join(directory, name));
  const size = await sizes(paths);
  const now = Date.now();
  const entries = paths
    .map((path) => ({
      path,
      used: statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? now,
      kibibytes: size.get(path) ?? 0,
    }))
    .sort((a, b) => a.used - b.used);
  let total = entries.reduce((sum, entry) => sum + entry.kibibytes, 0);
  const doomed: string[] = [];
  for (const entry of entries) {
    const expired = entry.used < now - retention.days * DAY_MS;
    if (!expired && total <= retention.mib * 1024) break;
    if (entry.used > now - GRACE_MS || claimed(entry.path)) continue;
    // Synchronous from the claims check to the rename: nothing claims it between.
    const gone = join(directory, `.gone-${process.pid}-${removals++}`);
    try {
      renameSync(entry.path, gone);
    } catch {
      continue;
    }
    doomed.push(gone);
    total -= entry.kibibytes;
  }
  for (const gone of doomed) await forceRemove(gone);
  // What a crash left of a key being made or removed.
  for (const name of readdirSync(directory))
    if (/^\.(new|gone)-/.test(name)) {
      const path = join(directory, name);
      const touched = statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? now;
      if (touched < now - GRACE_MS) await forceRemove(path);
    }
}
