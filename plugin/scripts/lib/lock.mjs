// A real create-only lock in GitHub, for launches that more than one process may attempt (the Actions launcher's
// runs, the dispatcher's re-launch): a git ref under refs/factory-launch/. Creating a ref that
// exists is refused (HTTP 422), so of two creators exactly one holds it; a sandbox record's write-then-read-back claim
// cannot promise that. The ref points at a commit object of its own (no parents, the default branch's tree) whose
// author is Factory, whose message is the ref (then a random line: git objects are named by their content, so two
// launchers in one second would otherwise make the same commit and both read it back as theirs) and whose author
// date is when it was taken, so a lock its holder never
// released (a crash, a cut job) is known to be stale. Taking over a stale lock and releasing one are compare-and-swap
// updates (GraphQL updateRefs with the oid that was read), so two launchers that read the same stale lock cannot both
// take it, and a release never drops a lock someone else holds now. Every decision is made on a read of the ref, never
// on an error's text. The App's contents write covers it; custom refs show in no branch or tag list. Small and shared:
// launch.mjs takes one per stage start and releases it, the dispatcher's tick (sweepLocks) clears stale and foreign ones.
import { randomBytes } from "node:crypto";
import { graphql, rest } from "./github.mjs";

export const LOCK_NAMESPACE = "factory-launch";
/**
 * A lock is held for one launcher call (the Action's launch job is cut at 5 minutes), so
 * one older than this has no live holder: the next launcher takes it over and the dispatcher's tick releases it.
 */
export const LOCK_STALE_MS = 15 * 60_000;
const PART = /^[A-Za-z0-9._-]{1,80}$/;
const ZERO = "0".repeat(40);
const AUTHOR = Object.freeze({ name: "Factory", email: "factory@users.noreply.github.com" });
const API = Object.freeze({ rest, graphql });

/** The lock for one cue of one stage of Objective `n`: `refs/factory-launch/<n>/<stage>-<cue>`. */
export function lockRef(n, stage, cue) {
  if (!Number.isSafeInteger(n) || n < 1 || !PART.test(stage) || !PART.test(cue)) throw new Error("a lock needs an issue number, a stage and a cue of plain characters");
  return `refs/${LOCK_NAMESPACE}/${n}/${stage}-${cue}`;
}

/** What locks need from the repository, read once per launch: its GraphQL id (for updateRefs) and the default branch's tree. */
export async function lockBase(repo, opts, api = API) {
  const d = await api.graphql(`query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id defaultBranchRef { target { ... on Commit { tree { oid } } } } } }`, { owner: repo.owner, name: repo.name }, opts);
  return { repositoryId: d?.repository?.id ?? null, tree: d?.repository?.defaultBranchRef?.target?.tree?.oid ?? null };
}

/**
 * The lock as GitHub holds it now: null when the ref is absent, else `{oid, at, foreign}`. `foreign` is a ref Factory
 * did not make the way takeLock does (not a commit, another author, a message whose first line is not the ref); its
 * `at` is null.
 */
export async function readLock(repo, ref, opts, api = API) {
  const r = await api.rest(`repos/${repo.full}/git/${ref.replace(/^refs\//, "ref/")}`, opts).catch((e) => {
    if (e?.status === 404) return null;
    throw e;
  });
  if (!r || Array.isArray(r) || r.ref !== ref) return null;
  return lockOf(repo, ref, r.object, opts, api);
}

async function lockOf(repo, ref, object, opts, api) {
  const oid = object?.sha ?? null;
  if (object?.type !== "commit") return { oid, at: null, foreign: true };
  const c = await api.rest(`repos/${repo.full}/git/commits/${oid}`, opts);
  const mine = c?.author?.name === AUTHOR.name && c?.author?.email === AUTHOR.email && String(c?.message ?? "").split("\n")[0] === ref && Number.isFinite(Date.parse(c?.author?.date));
  return mine ? { oid, at: c.author.date, foreign: false } : { oid, at: null, foreign: true };
}

/** Point `ref` at `after` only if it points at `before` now (ZERO deletes). Its result is not trusted: callers read the ref. */
const swap = (base, ref, before, after, opts, api) =>
  api.graphql(`mutation($repositoryId: ID!, $refUpdates: [RefUpdate!]!) { updateRefs(input: { repositoryId: $repositoryId, refUpdates: $refUpdates }) { clientMutationId } }`, { repositoryId: base.repositoryId, refUpdates: [{ name: ref, beforeOid: before, afterOid: after, force: true }] }, opts);

/**
 * Take the lock: `{ taken: true, oid }` (oid: what release needs), or `{ taken: false, at, foreign? }` when another
 * holds it (`at` when it was taken). A lock older than `staleMs` is taken over by a compare-and-swap from the oid read,
 * so of two takers of one stale lock exactly one gets it. A foreign lock is not taken over here (sweepLocks releases
 * it). `base` is lockBase's. A refusal to create (422) with no ref there afterwards is not "held": the error is thrown.
 */
export async function takeLock(repo, ref, { base, staleMs = LOCK_STALE_MS, now = () => Date.now(), api = API, ...opts }) {
  if (!base?.tree || !base?.repositoryId) throw new Error("takeLock needs lockBase(repo)");
  const commit = await api.rest(`repos/${repo.full}/git/commits`, { ...opts, method: "POST", body: { message: `${ref}\n\n${randomBytes(8).toString("hex")}`, tree: base.tree, parents: [], author: { ...AUTHOR, date: new Date(now()).toISOString() } } });
  const oid = commit?.sha;
  let refused = null;
  // Twice at most: a holder that released between our refused create and our read leaves nothing to report.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await api.rest(`repos/${repo.full}/git/refs`, { ...opts, method: "POST", body: { ref, sha: oid } });
      return { taken: true, oid };
    } catch (e) {
      if (e?.status !== 422) throw e;
      refused = e;
    }
    const held = await readLock(repo, ref, opts, api);
    if (!held) continue;
    if (held.foreign) return { taken: false, at: null, foreign: true };
    if (now() - Date.parse(held.at) <= staleMs) return { taken: false, at: held.at };
    await swap(base, ref, held.oid, oid, opts, api).catch(() => null);
    const after = await readLock(repo, ref, opts, api);
    return after?.oid === oid ? { taken: true, oid, tookOver: held.at } : { taken: false, at: after?.at ?? held.at };
  }
  throw refused;
}

/**
 * Release the lock taken as `oid`: a compare-and-swap delete, so a lock someone else holds now (it was taken over) stays.
 * True when it was ours and is gone, false when it was gone or another's; throws when it is still ours (the next
 * launcher takes it over once stale).
 */
export async function releaseLock(repo, ref, { oid, base, api = API, ...opts }) {
  if (!oid || !base?.repositoryId) throw new Error("releaseLock needs the oid takeLock returned and lockBase(repo)");
  const failed = await swap(base, ref, oid, ZERO, opts, api).then(() => null, (e) => e);
  const held = await readLock(repo, ref, opts, api);
  if (held?.oid === oid) throw failed || new Error(`${ref} is still held`);
  return !failed;
}

/** Every lock in the repository, or those of Objective `n`: `[{ ref, issue, object }]`. */
export async function listLocks(repo, opts, { n = null, api = API } = {}) {
  const list = (await api.rest(`repos/${repo.full}/git/matching-refs/${LOCK_NAMESPACE}/${n ? `${n}/` : ""}`, { ...opts, paginate: true })) || [];
  return list.map((r) => ({ ref: r.ref, issue: Number(String(r.ref).split("/")[2]), object: r.object })).filter((l) => l.ref.startsWith(`refs/${LOCK_NAMESPACE}/`));
}

/**
 * The dispatcher's pass over the locks: releases (compare-and-swap) every lock older than `staleMs` and every foreign
 * one (anyone who can push can create a ref here; that is maintainer trust already, and a foreign ref only blocks its
 * cue). At most `max` a pass; `locks` is listLocks' answer when the caller has it. Returns `[{ ref, action: "released" | "kept" | "skipped", reason }]`.
 */
export async function sweepLocks(repo, { base, locks = null, staleMs = LOCK_STALE_MS, now = () => Date.now(), max = 30, api = API, ...opts }) {
  const out = [];
  for (const l of locks ?? (await listLocks(repo, opts, { api }))) {
    if (out.filter((r) => r.action === "released").length >= max) {
      out.push({ ref: l.ref, action: "skipped", reason: `${max} released this pass; next tick` });
      continue;
    }
    try {
      const held = await lockOf(repo, l.ref, l.object, opts, api);
      const why = held.foreign ? "foreign lock" : now() - Date.parse(held.at) > staleMs ? `stale since ${held.at}` : null;
      if (!why) {
        out.push({ ref: l.ref, action: "kept", reason: `held since ${held.at}` });
        continue;
      }
      out.push((await releaseLock(repo, l.ref, { ...opts, oid: held.oid, base, api })) ? { ref: l.ref, action: "released", reason: why } : { ref: l.ref, action: "skipped", reason: `${why}; changed meanwhile` });
    } catch (e) {
      out.push({ ref: l.ref, action: "skipped", reason: `unreadable (${e?.status ?? "error"})` });
    }
  }
  return out;
}
