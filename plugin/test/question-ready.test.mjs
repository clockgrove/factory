// A Question answered by marking its PR ready (#339): the Question comment says "answer, then mark the PR ready", and
// on the local route that mark starts the review too, as the Action's ready_for_review event does: serve's tick takes a
// Question's PR out of draft as a review, and the review reads the state as the person's ready mark.
import "./temp.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { RETRY } from "../scripts/lib/github.mjs";

RETRY.sleep = async () => {};

const REPO = { owner: "acme", name: "app", full: "acme/app" };
const OBJ = "pendulum:objective";
const issue = (labels, number) => ({ number, state: "open", labels: labels.map((name) => ({ name })), body: "", updated_at: new Date().toISOString(), user: { login: "maintainer" } });

const withApi = async (fn) => {
  const keys = ["PENDULUM_LOCAL", "PENDULUM_LOCAL_ALL", "GITHUB_API_URL"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { GITHUB_API_URL: "https://github.test", PENDULUM_LOCAL: "1", PENDULUM_LOCAL_ALL: "1" });
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
};

/** serve's pendingReviews over a fetch fake: `pulls` the open PRs, `issues` by number, `timelines` by number. */
async function pending({ pulls, issues, timelines = {} }) {
  const { Local } = await import("../scripts/local.mjs");
  const loop = Object.assign(Object.create(Local.prototype), { repo: REPO, repoFull: "acme/app", opts: { token: "t" }, wf: {}, holder: "this-loop", baseEnv: () => ({ PENDULUM_LOCAL_ALL: "1" }) });
  const reads = [];
  return withApi(async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = new URL(url);
      reads.push(`${u.pathname.replace("/repos/acme/app", "")}${u.searchParams.get("labels") ? `?labels=${u.searchParams.get("labels")}` : ""}`);
      const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
      if (u.pathname === "/repos/acme/app/pulls") return json(pulls);
      if (u.pathname === "/repos/acme/app/issues") return json(Object.values(issues).filter((i) => i.labels.some((l) => l.name === u.searchParams.get("labels"))));
      const one = /^\/repos\/acme\/app\/issues\/(\d+)$/.exec(u.pathname);
      if (one) return json(issues[one[1]]);
      const line = /^\/repos\/acme\/app\/issues\/(\d+)\/timeline$/.exec(u.pathname);
      if (line) return json(timelines[line[1]] || []);
      if (u.pathname.endsWith("/collaborators")) return json([{ login: "maintainer" }]);
      if (u.pathname === "/user") return json({ login: "maintainer", type: "User" });
      return json([]);
    };
    try {
      return { out: (await loop.pendingReviews()).map(({ issue: n, pr }) => ({ issue: n, pr })), reads };
    } finally {
      globalThis.fetch = realFetch;
    }
  });
}

const pull = (n, { draft = false, labels = [] } = {}) => ({ number: n * 10, state: "open", draft, head: { ref: `pendulum/${n}` }, labels: labels.map((name) => ({ name })) });
const labeled = (name, at) => ({ event: "labeled", label: { name }, created_at: at });
const ready = (at, login = "maintainer") => ({ event: "ready_for_review", actor: { login, type: "User" }, created_at: at });

test("serve reviews a Question's PR a person marked ready, as the Action's ready_for_review event does", async () => {
  const { out } = await pending({
    pulls: [pull(7), pull(8), pull(9), pull(6, { draft: true })],
    issues: { 7: issue([OBJ, "pendulum:question"], 7), 8: issue([OBJ, "pendulum:question"], 8), 9: issue([OBJ, "pendulum:in-review"], 9), 6: issue([OBJ, "pendulum:question"], 6) },
    timelines: {
      7: [labeled("pendulum:question", "2026-11-15T10:00:00Z")],
      70: [ready("2026-11-15T09:00:00Z"), { event: "convert_to_draft", created_at: "2026-11-15T09:59:59Z" }, ready("2026-11-15T10:04:00Z")],
      // A Question whose PR GitHub kept out of draft: its only ready mark is from before the Question.
      8: [labeled("pendulum:question", "2026-11-15T10:00:00Z")],
      80: [ready("2026-11-15T09:00:00Z")],
    },
  });
  assert.deepEqual(out, [{ issue: 7, pr: 70 }], "#8 has no ready mark since its Question, #9 is In review (reviewed, waiting to merge), #6's PR is still a draft");
});

test("serve waits when a ready PR's Objective timeline still shows Draft held", async () => {
  const { out } = await pending({
    pulls: [pull(7)],
    issues: { 7: issue([OBJ, "pendulum:question"], 7) },
    timelines: {
      7: [labeled("pendulum:question", "2026-11-15T10:00:00Z"), labeled("pendulum:draft", "2026-11-15T10:01:00Z")],
      70: [ready("2026-11-15T10:02:00Z")],
    },
  });
  assert.deepEqual(out, []);
});

test("a Question whose PR GitHub will not draft Blocks once, naming it, rather than leaving a ready PR serve would ask again each tick", async () => {
  const { applyExit } = await import("../scripts/lib/session.mjs");
  const pr = { number: 70, node_id: "PR_70", draft: false, head: { sha: "abc" }, user: { login: "pendulum[bot]" } };
  const writes = [];
  const run = (refuse) =>
    withApi(async () => {
      writes.length = 0;
      const real = globalThis.fetch;
      globalThis.fetch = async (url, init = {}) => {
        const u = new URL(url);
        const method = init.method || "GET";
        const body = init.body ? JSON.parse(init.body) : null;
        const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
        if (u.pathname === "/graphql") {
          if (/convertPullRequestToDraft/.test(body?.query || "")) {
            writes.push("draft");
            return json(refuse ? { errors: [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }] } : { data: {} });
          }
          return json({ data: {} });
        }
        if (method !== "GET") writes.push(`${method} ${decodeURIComponent(u.pathname).replace("/repos/acme/app", "")}${body?.body ? ` ${body.body}` : ""}${body?.labels ? ` ${body.labels.join(",")}` : ""}`);
        if (u.pathname === "/repos/acme/app/pulls/70") return json(pr);
        return json(method === "GET" && /\/comments$/.test(u.pathname) ? [] : {});
      };
      try {
        return await applyExit(REPO, { issue: 7, pr, exit: "question", reason: "which name?", notify: "kirk", stage: "review" }, { token: "t" });
      } finally {
        globalThis.fetch = real;
      }
    });
  const asked = await run(false);
  assert.equal(asked.exit, "question");
  assert.ok(writes.some((w) => w === "POST /issues/7/labels pendulum:question"), writes.join("\n"));
  const blocked = await run(true);
  assert.equal(blocked.exit, "blocked", "the stage ends as it was applied");
  assert.match(blocked.reason, /^PR #70 could not be made a draft for its Question \(graphql: Resource not accessible by integration\), so the Question is not asked; the question was: which name\?$/);
  assert.ok(!writes.some((w) => /pendulum:question/.test(w) && w.startsWith("POST")), `no Question label: ${writes.join("\n")}`);
  assert.ok(!writes.some((w) => /Question \(review\)/.test(w)), "no Question notice");
  assert.ok(!writes.some((w) => /requested_reviewers/.test(w)), "no review request");
  const notice = writes.find((w) => /^POST \/issues\/7\/comments /.test(w)) || "";
  assert.match(notice, /Blocked \(review\): PR #70 could not be made a draft/, writes.join("\n"));
  assert.match(notice, /"cause":"pendulum"/, "cause pendulum");
  assert.match(notice, /Fix by letting Pendulum's token convert PR #70 to a draft, or by making it one by hand/);
  assert.ok(!/was delivered|is a draft/.test(notice), "the notice never says the PR is a draft");
  assert.equal(writes.filter((w) => w === "draft").length, 1, "one draft attempt");
  assert.ok(writes.includes("POST /issues/7/labels pendulum:blocked"), writes.join("\n"));
});
