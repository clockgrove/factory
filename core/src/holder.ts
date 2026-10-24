/**
 * The repository's holder (docs/PRD.md, single player): one installation
 * serves a repository at a time. The record is `refs/factory/holder` in the
 * target, an empty-tree commit whose message names the installation. It
 * isn't a branch, so no branch list, PR or normal clone shows it. Every
 * change is a lease push, git's own compare-and-swap, so of two
 * installations racing exactly one wins.
 *
 * `serve` takes the record before anything reaches GitHub, keeps it while
 * it runs (a crash keeps it too, so the same installation resumes) and
 * deletes it at a clean stop. Another installation is refused while the
 * record names someone else, until a deliberate `--take-over`. There is no
 * heartbeat or expiry: a sleeping machine never loses the repository by
 * accident, and the one that took over is told at its next check.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { promisify } from "node:util";
import { crashPoint } from "./crash.js";
import { gitEnvironment, remoteGit } from "./git.js";
import { errorMessage } from "./text.js";

export const HOLDER_REF = "refs/factory/holder";

const run = promisify(execFile);

/** Who holds the repository: the commit message of the holder record. */
export interface HolderRecord {
  /** The machine and state directory, hashed (`installationId`). */
  installation: string;
  host: string;
  user: string;
  /** When it took the repository. */
  since: string;
}

/** A holder record's message, or undefined when something else wrote it. */
function parsed(message: string): HolderRecord | undefined {
  try {
    const record = JSON.parse(message) as Partial<HolderRecord>;
    return typeof record.installation === "string"
      ? (record as HolderRecord)
      : undefined;
  } catch {
    return undefined;
  }
}

/** The record as read: its commit, and what it names (absent: no record). */
interface Read {
  sha?: string;
  record?: HolderRecord;
}

/** This installation: its machine and its state directory. */
export function installationId(root: string): string {
  let machine: string;
  try {
    machine = readFileSync("/etc/machine-id", "utf8").trim();
  } catch {
    machine = hostname();
  }
  return createHash("sha256")
    .update(`${machine}\0${root}`)
    .digest("hex")
    .slice(0, 24);
}

/** The holder as people read it: `user@host since TIME`. */
export function holderText(record: HolderRecord): string {
  return `${record.user}@${record.host} (installation ${record.installation}, since ${record.since})`;
}

/**
 * Serving refused, or stopped, because another installation holds the
 * repository; or the record can't be written for a reason a retry won't
 * fix (a ruleset or a permission). The message says what to run.
 */
export class HolderRefusal extends Error {}

export interface Holder {
  /** The record this installation pushed, or found naming it. */
  readonly sha: string;
  /** The record a `--take-over` replaced. */
  readonly replaced?: HolderRecord;
}

interface Context {
  checkout: string;
  repository: string;
  root: string;
}

async function remote(context: Context, args: string[]): Promise<string> {
  return await remoteGit(context.checkout, context.repository, args, {
    timeoutMs: 60_000,
  });
}

async function local(context: Context, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", context.checkout, ...args], {
    env: {
      ...gitEnvironment(),
      GIT_AUTHOR_NAME: "Factory",
      GIT_AUTHOR_EMAIL: "factory@invalid",
      GIT_COMMITTER_NAME: "Factory",
      GIT_COMMITTER_EMAIL: "factory@invalid",
    },
    encoding: "utf8",
  });
  return stdout.trim();
}

/** The holder record on origin, read with `ls-remote` (no REST call). */
async function readHolder(context: Context): Promise<Read> {
  const listed = await remote(context, ["ls-remote", "origin", HOLDER_REF]);
  const sha = listed.split(/\s/)[0];
  if (!sha) return {};
  await remote(context, [
    "fetch",
    "--quiet",
    "--no-tags",
    "--no-write-fetch-head",
    "origin",
    HOLDER_REF,
  ]);
  const message = await local(context, ["log", "-1", "--format=%B", sha]);
  const record = parsed(message);
  if (record) return { sha, record };
  // Something else wrote the ref: it isn't ours, so it's someone's.
  return {
    sha,
    record: {
      installation: "unknown",
      host: "unknown",
      user: "unknown",
      since: "unknown",
    },
  };
}

/** Point the ref at `target` (undefined: delete it) only if it is still `expected`. */
async function leasePush(
  context: Context,
  expected: string | undefined,
  target: string | undefined,
): Promise<void> {
  await remote(context, [
    "push",
    "--quiet",
    "--no-verify",
    `--force-with-lease=${HOLDER_REF}:${expected ?? ""}`,
    "origin",
    `${target ?? ""}:${HOLDER_REF}`,
  ]);
}

/**
 * A push that failed. Git exits 1 when it refused a ref and 128 when it
 * couldn't talk to origin; the latter is transient and rethrown, so the
 * caller retries. For a refused ref: if the record moved, another
 * installation won the race, and the caller reads it again; if it didn't,
 * GitHub refused the push itself (a ruleset), which no retry fixes.
 */
async function lostRace(
  context: Context,
  expected: string | undefined,
  error: unknown,
): Promise<boolean> {
  if ((error as { code?: unknown }).code !== 1) throw error;
  const now = await readHolder(context);
  if (now.sha !== expected) return true;
  throw new HolderRefusal(
    `GitHub refused Factory's push to ${HOLDER_REF} in ${context.repository} (${errorMessage(error).split("\n").filter(Boolean).at(-1)}). Factory records which installation serves the repository there: allow its pushes to refs/factory/* (a ruleset or a push permission), then start it again.`,
  );
}

/**
 * Take the repository for this installation, before anything reaches
 * GitHub. Resumes when the record already names it; refuses when it names
 * another, unless `takeOver`. A transient Git failure throws, and the
 * caller retries.
 */
export async function takeHolder(
  context: Context,
  takeOver: boolean,
): Promise<Holder> {
  const installation = installationId(context.root);
  for (;;) {
    const { sha, record } = await readHolder(context);
    if (sha && record?.installation === installation) return { sha };
    if (sha && record && !takeOver)
      throw new HolderRefusal(
        `${context.repository} is served by another installation: ${holderText(record)}. Only one installation may serve a repository. If that one is stopped for good (its machine is gone, or its state was wiped), take over from here: factory serve --repo ${context.repository} --take-over`,
      );
    const mine: HolderRecord = {
      installation,
      host: hostname(),
      user: userInfo().username,
      since: new Date().toISOString(),
    };
    const tree = await local(context, [
      "hash-object",
      "-t",
      "tree",
      "-w",
      "/dev/null",
    ]);
    const commit = await local(context, [
      "commit-tree",
      tree,
      "-m",
      JSON.stringify(mine),
    ]);
    const point = sha ? "holder:takeover" : "holder:take";
    crashPoint(`${point}:before`);
    try {
      await leasePush(context, sha, commit);
    } catch (error) {
      if (await lostRace(context, sha, error)) continue;
    }
    crashPoint(`${point}:after`);
    return { sha: commit, ...(sha && record ? { replaced: record } : {}) };
  }
}

/** Who serves the repository, read-only, for readiness: absent when no one does. */
export async function currentHolder(
  context: Context,
): Promise<{ record: HolderRecord; mine: boolean } | undefined> {
  const { record } = await readHolder(context);
  return record
    ? { record, mine: record.installation === installationId(context.root) }
    : undefined;
}

/**
 * Whether this installation still holds the repository: the record's
 * commit, read with `ls-remote`. Any change means another installation
 * took over (or took over and stopped); the record it names, or none.
 */
export async function holderChanged(
  context: Context,
  holder: Holder,
): Promise<{ record?: HolderRecord } | undefined> {
  const listed = await remote(context, ["ls-remote", "origin", HOLDER_REF]);
  if (listed.split(/\s/)[0] === holder.sha) return undefined;
  const { record } = await readHolder(context);
  return record ? { record } : {};
}

/** Delete the record at a clean stop, only if it is still this installation's. */
export async function releaseHolder(
  context: Context,
  holder: Holder,
): Promise<void> {
  crashPoint("holder:release:before");
  try {
    await leasePush(context, holder.sha, undefined);
  } catch (error) {
    // Another installation took over meanwhile: its record stays.
    if (await lostRace(context, holder.sha, error)) return;
  }
  crashPoint("holder:release:after");
}
