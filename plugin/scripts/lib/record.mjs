// Compare-and-set writes of Factory's record comments: the sandbox record and a cloud stage's progress comment, which
// more than one process writes (the launcher, the stage, the sweep). GitHub has no compare-and-set on a comment: a
// PATCH takes no precondition (conditional requests are for GET only) and GraphQL updateIssueComment takes an id and a
// body. Git refs do have one: creating a ref that exists is refused (HTTP 422) and GraphQL updateRefs moves a ref only
// from the oid named as beforeOid (lib/lock.mjs uses both). So each record comment has a version register, the ref
// refs/factory-record/<n>/<key>, pointing at a commit of its own whose message carries the sha256 of the comment text
// last written. A write:
//   1. reads the register and the comment; a comment whose text is not the register's version is a write in flight (its
//      register move is in, its comment write not yet) or a read that lags it: the writer reads again, and only a
//      version older than SETTLE_MS is taken as abandoned (its writer never writes after WRITE_WITHIN_MS);
//   2. hands the text to `update`, which merges its change onto it or returns null to report (the caller says why);
//   3. moves the register from the version read to the new text's version (compare-and-swap), and reads it back: another
//      writer's version there means its update was computed on a stale read, so it reads again and updates again;
//   4. writes the comment, only within WRITE_WITHIN_MS of its register move (GitHub ends any request after 10 seconds),
//      and moves the register back when the comment write fails.
// So every comment write is computed on the text the previous one wrote, and none lands over another unseen. The
// register holds a version only, never the record: the comment stays the one copy of it. The App's contents write
// covers the refs; they show in no branch or tag list.
import { createHash, randomBytes } from "node:crypto";
import { graphql, ownComment, rest } from "./github.mjs";
import { lockBase } from "./lock.mjs";

export const RECORD_NAMESPACE = "factory-record";
/** A register version whose comment text never came is a write in flight this long; after it, an abandoned one. */
export const SETTLE_MS = 60_000;
/** The register's new version is written to the comment within this long of its move, or not at all (and moved back). */
export const WRITE_WITHIN_MS = 20_000;
const TRIES = 6;
const PAUSE_MS = 2000;
const ZERO = "0".repeat(40);
const AUTHOR = Object.freeze({ name: "Factory", email: "factory@users.noreply.github.com" });
const API = Object.freeze({ rest, graphql });
const bases = new Map();

/** The register of the comment whose first line is `marker` (`<!-- factory:<n>:<kind>[:<id>] -->`) on issue `n`. */
export function recordRef(n, marker) {
  const m = /^<!-- factory:(\d+):([A-Za-z0-9._:-]{1,160}) -->$/.exec(String(marker));
  const key = m?.[2].replace(/:/g, ".");
  if (!m || Number(m[1]) !== n || /\.\.|^\.|\.$|\.lock$/.test(key)) throw new Error("a record register needs a Factory marker of plain characters on its own issue");
  return `refs/${RECORD_NAMESPACE}/${n}/${key}`;
}

/** The version of a comment's text (null: no comment). */
export const versionOf = (text) => (text === null || text === undefined ? null : createHash("sha256").update(text).digest("hex"));

const swap = (base, ref, before, after, opts, api) =>
  api.graphql(`mutation($repositoryId: ID!, $refUpdates: [RefUpdate!]!) { updateRefs(input: { repositoryId: $repositoryId, refUpdates: $refUpdates }) { clientMutationId } }`, { repositoryId: base.repositoryId, refUpdates: [{ name: ref, beforeOid: before, afterOid: after, force: true }] }, opts);

async function readRef(repo, ref, opts, api) {
  const r = await api.rest(`repos/${repo.full}/git/${ref.replace(/^refs\//, "ref/")}`, opts).catch((e) => {
    if (e?.status === 404) return null;
    throw e;
  });
  return r && !Array.isArray(r) && r.ref === ref ? r.object : null;
}

/**
 * The register now: null when absent, else `{oid, version, at}` (`at`: when that version was moved in). A ref Factory
 * did not make this way (not a commit by Factory whose first line is the ref) has no version: it is written over.
 */
export async function readVersion(repo, ref, opts, api = API) {
  const object = await readRef(repo, ref, opts, api);
  if (!object) return null;
  const oid = object.sha ?? null;
  if (object.type !== "commit") return { oid, version: null, at: null };
  const c = await api.rest(`repos/${repo.full}/git/commits/${oid}`, opts);
  const lines = String(c?.message ?? "").split("\n");
  const version = lines.find((l) => /^version:[0-9a-f]{64}$/.test(l))?.slice(8) ?? null;
  const mine = c?.author?.name === AUTHOR.name && c?.author?.email === AUTHOR.email && lines[0] === ref && version && Number.isFinite(Date.parse(c?.author?.date));
  return mine ? { oid, version, at: c.author.date } : { oid, version: null, at: null };
}

async function baseOf(repo, opts, api) {
  if (api !== API) return lockBase(repo, opts, api);
  if (!bases.has(repo.full)) bases.set(repo.full, await lockBase(repo, opts, api));
  return bases.get(repo.full);
}

/**
 * Write the comment on issue `number` whose first line is `marker`, compare-and-set (above). `update(text)` gets the
 * comment's whole text as it is now (null: none yet) and returns the new body without the marker line, or null to
 * write nothing. It is called again on the text another writer left whenever that writer got in first, so it merges
 * its change onto what it is given; it must not lean on an earlier read. Returns `{ok, text}` (written, or
 * `unchanged`), `{refused, text}` (update returned null on that text) or `{contended}` (no settled version to write
 * over within `tries` reads `pauseMs` apart). GitHub's errors are thrown.
 */
export async function casComment(repo, number, { marker, update, tries = TRIES, pauseMs = PAUSE_MS, settleMs = SETTLE_MS, writeWithinMs = WRITE_WITHIN_MS, now = () => Date.now(), api = API, base = null, ...opts }) {
  const ref = recordRef(number, marker);
  const b = base ?? (await baseOf(repo, opts, api));
  if (!b?.tree || !b?.repositoryId) throw new Error("a record write needs the repository's id and a tree (lockBase)");
  for (let i = 0; i < tries; i += 1) {
    if (i) await new Promise((r) => setTimeout(r, pauseMs));
    const v = await readVersion(repo, ref, opts, api);
    const comment = ownComment((await api.rest(`repos/${repo.full}/issues/${number}/comments?per_page=100`, { ...opts, paginate: true })) || [], marker);
    const text = comment?.body ?? null;
    if (v?.version && v.version !== versionOf(text) && now() - Date.parse(v.at) < settleMs) continue;
    const next = await update(text);
    if (next === null || next === undefined) return { refused: true, text };
    const full = `${marker}\n${next}`;
    if (full === text) return { ok: true, text, unchanged: true };
    const at = now();
    const commit = await api.rest(`repos/${repo.full}/git/commits`, { ...opts, method: "POST", body: { message: `${ref}\n\nversion:${versionOf(full)}\n${randomBytes(8).toString("hex")}`, tree: b.tree, parents: [], author: { ...AUTHOR, date: new Date(at).toISOString() } } });
    const oid = commit?.sha;
    if (v) await swap(b, ref, v.oid, oid, opts, api).catch(() => null);
    else {
      await api.rest(`repos/${repo.full}/git/refs`, { ...opts, method: "POST", body: { ref, sha: oid } }).catch((e) => {
        if (e?.status !== 422) throw e;
      });
    }
    // Decided on a read of the register, never on the swap's answer or an error's text.
    if ((await readRef(repo, ref, opts, api))?.sha !== oid) continue;
    const back = () => swap(b, ref, oid, v?.oid ?? ZERO, opts, api).catch(() => null);
    if (now() - at > writeWithinMs) {
      await back();
      continue;
    }
    try {
      if (comment) await api.rest(`repos/${repo.full}/issues/comments/${comment.id}`, { ...opts, method: "PATCH", body: { body: full } });
      else await api.rest(`repos/${repo.full}/issues/${number}/comments`, { ...opts, method: "POST", body: { body: full } });
    } catch (e) {
      await back();
      throw e;
    }
    return { ok: true, text: full };
  }
  return { contended: true };
}
