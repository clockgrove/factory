// One repository's issue comments and git refs, in memory, answering as GitHub does for what the record writers call
// (launch.mjs writeSandboxRecord and bookVendor, stage.mjs stageWriter, lib/lock.mjs): a comment PATCH takes no
// precondition, creating an existing ref is 422, a missing ref reads 404, updateRefs refuses (a GraphQL error) when
// the ref no longer points at beforeOid. Every call waits a pseudo-random few ticks first (seeded,
// so a run is repeatable), so writers started together interleave differently with each seed. `lag` reads: the comment
// list answers with a comment's previous body for that many reads after each write, as a lagging replica would.
// `hideNew` reads: a newly posted comment is missing from the list for that many reads.
import { createHash } from "node:crypto";

export const BOT = { login: "factory-app[bot]", type: "Bot" };
export const REPO = { owner: "acme", name: "widgets", full: "acme/widgets" };
export const BASE = { repositoryId: "R_1", tree: "t".repeat(40) };
const ZERO = "0".repeat(40);
const err = (status, message) => Object.assign(new Error(message), { status });

export function githubStore({ seed = 1, maxTicks = 6, lag = 0, hideNew = 0 } = {}) {
  let rnd = seed >>> 0 || 1;
  const random = () => ((rnd = (rnd * 1103515245 + 12345) >>> 0) % 1000) / 1000;
  const pause = async () => {
    for (let i = Math.floor(random() * maxTicks); i > 0; i -= 1) await new Promise((r) => setImmediate(r));
  };
  const comments = new Map();
  const refs = new Map();
  const objects = new Map();
  const calls = [];
  let nextId = 100;
  const prefix = `repos/${REPO.full}/`;
  const view = (c) => {
    if (c.stale > 0) {
      c.stale -= 1;
      return { ...c, body: c.prev };
    }
    return { ...c };
  };
  const rest = async (path, { method = "GET", body } = {}) => {
    await pause();
    const p = path.slice(prefix.length);
    calls.push(`${method} ${p}`);
    let m;
    if (method === "GET" && (m = /^issues\/(\d+)\/comments\?/.exec(p))) {
      const all = [...comments.values()].filter((c) => c.issue === Number(m[1])).sort((a, b) => a.id - b.id);
      return all.filter((c) => (c.hidden > 0 ? (c.hidden -= 1, false) : true)).map(view);
    }
    if (method === "POST" && (m = /^issues\/(\d+)\/comments$/.exec(p))) {
      const c = { id: (nextId += 1), issue: Number(m[1]), user: BOT, body: body.body, prev: body.body, stale: 0, hidden: hideNew };
      comments.set(c.id, c);
      return { id: c.id };
    }
    if (method === "PATCH" && (m = /^issues\/comments\/(\d+)$/.exec(p))) {
      const c = comments.get(Number(m[1]));
      if (!c) throw err(404, "Not Found");
      Object.assign(c, { prev: c.body, body: body.body, stale: lag });
      return { id: c.id };
    }
    if (method === "POST" && p === "git/commits") {
      const sha = createHash("sha1").update(JSON.stringify([body.message, body.tree, body.parents, body.author])).digest("hex");
      objects.set(sha, { type: "commit", sha, message: body.message, author: body.author });
      return { sha };
    }
    if (method === "POST" && p === "git/refs") {
      if (!objects.has(body.sha)) throw err(422, "Object does not exist");
      if (refs.has(body.ref)) throw err(422, "Reference already exists");
      refs.set(body.ref, body.sha);
      return { ref: body.ref };
    }
    if (method === "GET" && p.startsWith("git/ref/")) {
      const ref = `refs/${p.slice(8)}`;
      if (!refs.has(ref)) throw err(404, "Not Found");
      const o = objects.get(refs.get(ref));
      return { ref, object: { sha: o.sha, type: o.type } };
    }
    if (method === "GET" && p.startsWith("git/commits/")) return objects.get(p.slice(12)) ?? Promise.reject(err(404, "Not Found"));
    throw new Error(`unexpected ${method} ${path}`);
  };
  const graphql = async (q, { repositoryId, refUpdates: [u] = [] } = {}) => {
    await pause();
    if (/defaultBranchRef/.test(q)) return { repository: { id: BASE.repositoryId, defaultBranchRef: { target: { tree: { oid: BASE.tree } } } } };
    if (repositoryId !== BASE.repositoryId) throw new Error("another repository");
    calls.push(`updateRefs ${u.name}`);
    if ((refs.get(u.name) ?? ZERO) !== u.beforeOid) throw err(0, "Something went wrong while executing your query");
    if (u.afterOid === ZERO) refs.delete(u.name);
    else refs.set(u.name, u.afterOid);
    return { updateRefs: { clientMutationId: null } };
  };
  const put = (issue, body) => {
    const c = { id: (nextId += 1), issue, user: BOT, body, prev: body, stale: 0 };
    comments.set(c.id, c);
    return c.id;
  };
  const bodyOf = (issue, head) => [...comments.values()].find((c) => c.issue === issue && c.body.startsWith(head))?.body ?? null;
  return { api: { rest, graphql }, comments, refs, calls, put, bodyOf };
}
