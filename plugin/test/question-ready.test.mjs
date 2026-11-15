// A Question answered by marking its PR ready (#339): the Question comment says "answer, then mark the PR ready", and
// on the local route that mark starts the review too, as the Action's ready_for_review event does: serve's tick takes a
// Question's PR out of draft as a review, and the review reads the state as the person's ready mark.
import "./temp.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { RETRY } from "../scripts/lib/github.mjs";
import { questionNotice } from "../scripts/lib/session.mjs";

RETRY.sleep = async () => {};

const REPO = { owner: "acme", name: "app", full: "acme/app" };
const OBJ = "factory:objective";
const issue = (labels, number) => ({ number, state: "open", labels: labels.map((name) => ({ name })), body: "", updated_at: new Date().toISOString(), user: { login: "maintainer" } });

const withApi = async (fn) => {
  const keys = ["FACTORY_LOCAL", "FACTORY_LOCAL_ALL", "GITHUB_API_URL"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { GITHUB_API_URL: "https://github.test", FACTORY_LOCAL: "1", FACTORY_LOCAL_ALL: "1" });
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
  const loop = Object.assign(Object.create(Local.prototype), { repo: REPO, repoFull: "acme/app", opts: { token: "t" }, wf: {}, holder: "this-loop", baseEnv: () => ({ FACTORY_LOCAL_ALL: "1" }) });
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

const pull = (n, { draft = false, labels = [] } = {}) => ({ number: n * 10, state: "open", draft, head: { ref: `factory/${n}` }, labels: labels.map((name) => ({ name })) });
const labeled = (name, at) => ({ event: "labeled", label: { name }, created_at: at });
const ready = (at, login = "maintainer") => ({ event: "ready_for_review", actor: { login, type: "User" }, created_at: at });

test("serve reviews a Question's PR a person marked ready, as the Action's ready_for_review event does", async () => {
  const { out } = await pending({
    pulls: [pull(7), pull(8), pull(9), pull(6, { draft: true })],
    issues: { 7: issue([OBJ, "factory:question"], 7), 8: issue([OBJ, "factory:question"], 8), 9: issue([OBJ, "factory:in-review"], 9), 6: issue([OBJ, "factory:question"], 6) },
    timelines: {
      7: [labeled("factory:question", "2026-11-15T10:00:00Z")],
      70: [ready("2026-11-15T09:00:00Z"), { event: "convert_to_draft", created_at: "2026-11-15T09:59:59Z" }, ready("2026-11-15T10:04:00Z")],
      // A Question whose PR GitHub kept out of draft: its only ready mark is from before the Question.
      8: [labeled("factory:question", "2026-11-15T10:00:00Z")],
      80: [ready("2026-11-15T09:00:00Z")],
    },
  });
  assert.deepEqual(out, [{ issue: 7, pr: 70 }], "#8 has no ready mark since its Question, #9 is In review (reviewed, waiting to merge), #6's PR is still a draft");
});

test("serve reads the Questions only when an open PR out of draft has no review label, and no timeline without a Question", async () => {
  const none = await pending({ pulls: [pull(6, { draft: true }), pull(5, { labels: ["factory:review"] })], issues: { 6: issue([OBJ, "factory:question"], 6), 5: issue([OBJ, "factory:in-review"], 5) } });
  assert.deepEqual(none.out, [{ issue: 5, pr: 50 }]);
  assert.ok(!none.reads.includes("/issues?labels=factory:question"), none.reads.join("\n"));
  const inReview = await pending({ pulls: [pull(9)], issues: { 9: issue([OBJ, "factory:in-review"], 9) } });
  assert.deepEqual(inReview.out, []);
  assert.deepEqual(inReview.reads.filter((r) => r !== "/pulls" && r !== "/user"), ["/issues?labels=factory:question"], "one listing, no per-PR read");
});

test("the review reads the person's ready mark on every route, and the Question comment names it", async () => {
  const { readyMark } = await import("../scripts/review.mjs");
  const question = issue([OBJ, "factory:question"], 7);
  const inReview = issue([OBJ, "factory:in-review"], 7);
  const out = { number: 70, draft: false };
  assert.equal(readyMark({ action: "ready_for_review", sender: { type: "User" } }), true, "Actions: a person's event");
  assert.equal(readyMark({ action: "ready_for_review", sender: { type: "Bot" } }), false, "Actions: Factory's own mark");
  assert.equal(readyMark({ action: "labeled", sender: { type: "Bot" }, issue: question, pr: out }), false, "Actions: the review label is no ready mark");
  assert.equal(readyMark({ local: true, issue: question, pr: out }), true, "local: a Question's PR out of draft");
  assert.equal(readyMark({ local: true, issue: inReview, pr: out }), false, "local: an In-review PR's review");
  assert.equal(readyMark({ local: true, issue: question, pr: { ...out, draft: true } }), false, "local: still a draft");
  assert.match(questionNotice({ reason: "which name?", pr: out }), /Answer in a comment on the issue or the PR, then mark the PR ready\.$/);
});
