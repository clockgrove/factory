import "./temp.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setSelf } from "../scripts/lib/logic.mjs";
import { planHanded, planOf, planSync, planTextMarker, planTextOf } from "../scripts/lib/handoff.mjs";
import { EDITED_FIX, EDITED_REASON, editedSincePlan, objectiveSha, planGate, planStateNow, planTextState } from "../scripts/lib/objective-trust.mjs";
import { blockedLine, mergeBlockCause, mergeBlockReason } from "../scripts/lib/session.mjs";
import { BLOCK_CAUSES } from "../scripts/lib/logic.mjs";

// #205: an edit to an Objective's title, body or harness and model labels after its plan was made is never acted on halfway. The plan comment
// records the text it was made from; the next stage compares, and Blocks or (after a person re-applied the label) plans again.

const repo = { owner: "acme", name: "app", full: "acme/app" };
const A = objectiveSha("Objective", "Build the thing.");
const B = objectiveSha("Objective", "Build the other thing.");
const L0 = "2026-11-13T10:00:00Z";
const L1 = "2026-11-13T12:00:00Z";
const SCRIPTS = join(import.meta.dirname, "..", "scripts");

// Each route's own login: the App's bot on Actions and in a cloud sandbox stage, the developer in local mode, where the
// same login also edits the issue, applies the label and answers a Question.
const ROUTES = [
  { route: "Actions", self: "pendulum-app[bot]", person: "kirk" },
  { route: "cloud sandbox", self: "pendulum-app[bot]", person: "kirk" },
  { route: "local mode", self: "dev", person: "dev" },
];

/** GitHub's comments on issue 7: the plan comment Pendulum wrote (from `record`, or none), and a person's answer. */
function comments({ self, person, record = null, none = false, plan = "## Plan\n- [ ] item" }) {
  const list = [{ id: 3, user: { login: person }, body: "Use the second option.", created_at: L1 }];
  if (!none) list.unshift({ id: 2, user: { login: self }, body: `<!-- pendulum:7:plan -->${record ? planTextMarker(record) : ""}\n${plan}`, created_at: L0 });
  return list;
}

/** A stage's gate against the plan comment `list`, the latest label event at `labeledAt`; GitHub's writes recorded. */
async function gate(list, { sha, work, labeledAt = L0, before = null, editedAt = null, changedAt = null }) {
  const applied = [];
  const writes = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if ((init.method || "GET") === "GET") return new Response(JSON.stringify(list), { status: 200, headers: { "content-type": "application/json" } });
    writes.push({ url: String(url), method: init.method, body: init.body ? JSON.parse(init.body) : null });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const r = await planGate({ repo, issue: 7, sha, editedAt, work, pr: { number: 9 }, notify: "boss", opts: { token: "t" }, apply: async (_, exit) => applied.push(exit), before, stage: work ? "work" : "review", read: { planComment: async () => planOf(list, 7), labeledAt: async () => labeledAt, changedAt: async () => changedAt } });
    return { r, applied, writes };
  } finally {
    globalThis.fetch = real;
  }
}

test("edit after plan: the text's record is decided on the hash and GitHub's label times, never the words", () => {
  const plan = { at: L0, record: { sha256: A, label: L0 } };
  assert.equal(planTextState({ sha: A, plan: null, work: true }), "unplanned", "no plan yet: the text is simply used");
  assert.equal(planTextState({ sha: A, plan, labeledAt: L1, work: true }), "same");
  assert.equal(planTextState({ sha: B, plan, labeledAt: L0, work: true }), "changed", "an edit with no label applied since: Blocked");
  assert.equal(planTextState({ sha: B, plan, labeledAt: L1, work: true }), "replan", "the label applied after the edit: plan again");
  assert.equal(planTextState({ sha: B, plan, labeledAt: L1 }), "changed", "the review stage never plans");
  assert.notEqual(objectiveSha("Objective", "Build the thing!"), A, "any change to the body is an edit");
  assert.equal(objectiveSha("Objective", "Build the thing.  \r\n"), A, "a save that only changed line ends or trailing spaces is not");
  assert.equal(objectiveSha("Objective", "Line one\r\nLine two"), objectiveSha("Objective", "Line one \nLine two"));
  assert.notEqual(objectiveSha("Objective!", "Build the thing."), A, "and to the title");
  assert.notEqual(objectiveSha("a", "b\nc"), objectiveSha("a\nb", "c"), "title and body are kept apart");
});

for (const { route, self, person } of ROUTES) {
  test(`edit after plan (${route}): an edit while running or in review stops the next stage as Blocked, cause work`, async () => {
    setSelf(self);
    const list = comments({ self, person, record: { sha256: A, label: L0 } });
    // The next work stage (a rebase send-back, the next split part, a requeued Question): no label applied since.
    const work = await gate(list, { sha: B, work: true, labeledAt: L0 });
    assert.equal(work.r.ok, false);
    assert.deepEqual(work.applied, [{ issue: 7, pr: { number: 9 }, exit: "blocked", reason: EDITED_REASON, fix: EDITED_FIX, cause: "work", notify: "boss", stage: "work" }]);
    assert.deepEqual(work.writes, [], "the record is not moved");
    // The review job (reviewer, answer pass, merge): its label comes off first.
    const order = [];
    const review = await gate(list, { sha: B, work: false, before: async () => order.push("before") });
    assert.equal(review.r.ok, false);
    assert.deepEqual(order, ["before"]);
    assert.equal(review.applied[0].stage, "review");
    assert.equal(review.applied[0].pr.number, 9, "the PR goes back to a draft");
    assert.equal(BLOCK_CAUSES[review.applied[0].cause].external, false, "an edit is a person's action, never External");
    const notice = blockedLine({ issue: 7, pr: { number: 9 }, stage: "review", reason: EDITED_REASON, fix: EDITED_FIX });
    assert.match(notice, /title, body or harness, model and host labels \(`pendulum:harness:`, `pendulum:model:`, `pendulum:subagent-model:`, `pendulum:reviewer-model:`, `pendulum:host:`\) changed after its plan was made/);
    assert.match(notice, /To work from the issue as it is now, add `pendulum:draft` if it is missing, then remove it to resume. The worker makes its plan again from the current text and harness, model and host labels/);
  });

  test(`edit after plan (${route}): a comment answering a Question is no edit`, async () => {
    setSelf(self);
    const list = comments({ self, person, record: { sha256: A, label: L0 } });
    const work = await gate(list, { sha: A, work: true, labeledAt: L0 });
    assert.deepEqual([work.r.ok, work.r.state, work.applied, work.writes], [true, "same", [], []]);
    assert.equal(planHanded(planOf(list, 7), work.r.record), "## Plan\n- [ ] item", "the plan as it stands");
    const review = await gate(list, { sha: A, work: false });
    assert.deepEqual([review.r.ok, review.r.record], [true, { sha256: A, label: L0 }], "the review keeps the plan's record");
  });
}

test("edit after plan: the record is Pendulum's own, on the plan comment's marker line", async () => {
  setSelf("pendulum-app[bot]");
  const posted = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if ((init.method || "GET") === "GET") return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    posted.push(JSON.parse(init.body).body);
    return new Response(JSON.stringify({ id: 2 }), { status: 201, headers: { "content-type": "application/json" } });
  };
  try {
    // A harness that writes a record line into its plan: escaped like any HTML comment it writes.
    await planSync(repo, 7, { token: "t" }, { sha256: A, label: L0 })(`${planTextMarker({ sha256: B, label: L1 })}\n## Plan`);
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(posted.length, 1);
  assert.match(posted[0], /^<!-- pendulum:7:plan --><!-- pendulum:plan-text \{"sha256":"[0-9a-f]{64}","label":"2026-11-13T10:00:00Z"\} -->\n&lt;!-- pendulum:plan-text/);
  const mine = planOf([{ id: 2, user: { login: "pendulum-app[bot]" }, body: posted[0] }], 7);
  assert.deepEqual(mine.record, { sha256: A, label: L0 });
  assert.match(mine.text, /^&lt;!-- pendulum:plan-text .*\n## Plan$/, "the marker line is not the plan's");
  assert.equal(planOf([{ id: 2, user: { login: "stranger" }, body: posted[0] }], 7), null, "anyone else's copy of the comment is no plan");
  assert.equal(planOf([{ id: 2, user: { login: "pendulum-app[bot]" }, body: `<!-- pendulum:7:plan -->\n${planTextMarker({ sha256: B, label: L1 })}\n## Plan` }], 7).record, null, "a record below the marker line is not read");
  assert.equal(planTextOf('<!-- pendulum:plan-text {"sha256":"abc","label":null} -->'), null, "a record that is no SHA-256");
});

test("edit after plan: the merge Blocks on an edit, cause work, as every other merge Block", () => {
  assert.equal(mergeBlockReason("edited"), EDITED_REASON);
  assert.equal(mergeBlockCause("edited"), "work");
  const src = readFileSync(join(SCRIPTS, "lib", "session.mjs"), "utf8");
  const merge = src.slice(src.indexOf("export async function mergeReadyOne("));
  const at = merge.lastIndexOf("await editedSincePlan(repo, issue, opts, { check: editCheck, progress: keptSaid(repo, issue, opts) })");
  assert.ok(at > merge.indexOf('return "unread"'), "checked once the checks are green, before any merge");
  assert.ok(merge.indexOf("await mergeVerified(") > at, "the merge only after the check");
});

const own = (body, extra = {}) => ({ id: 2, user: { login: "pendulum-app[bot]" }, body, created_at: L0, ...extra });

test("edit after plan: a plan comment saved with CRLF line ends keeps its record", async () => {
  setSelf("pendulum-app[bot]");
  // GitHub's web editor saves the whole comment with CRLF when a person ticks the plan's checklist.
  const list = [own(`<!-- pendulum:7:plan -->${planTextMarker({ sha256: A, label: L0 })}\r\n## Plan\r\n- [x] item`)];
  assert.deepEqual(planOf(list, 7).record, { sha256: A, label: L0 });
  const { r, applied } = await gate(list, { sha: B, work: false });
  assert.deepEqual([r.ok, applied[0]?.reason], [false, EDITED_REASON], "an edit after it still Blocks");
});

test("edit after plan: a stage that knows no record never erases the one the plan comment has", async () => {
  setSelf("pendulum-app[bot]");
  const head = planTextMarker({ sha256: A, label: L0 });
  const list = [own(`<!-- pendulum:7:plan -->${head}\r\n## Plan`)];
  const written = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if ((init.method || "GET") === "GET") return new Response(JSON.stringify(list), { status: 200, headers: { "content-type": "application/json" } });
    written.push({ method: init.method, body: JSON.parse(init.body).body });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    // `pendulum deliver` with no issue.md from `pendulum issue`, or a review with no record: planSync with none.
    await planSync(repo, 7, { token: "t" }, null)("## Plan, ticked");
  } finally {
    globalThis.fetch = real;
  }
  assert.deepEqual(written, [{ method: "PATCH", body: `<!-- pendulum:7:plan -->${head}\n## Plan, ticked` }]);
});

test("edit after plan: another App's marker never hides Pendulum's plan comment or its record, github-actions[bot] included", async () => {
  setSelf("pendulum-app[bot]");
  const mine = own(`<!-- pendulum:7:plan -->${planTextMarker({ sha256: A, label: L0 })}\n## Plan`);
  const later = "2026-11-13T13:00:00Z";
  const app = (id, login, body) => ({ id, user: { login, type: "Bot" }, body, created_at: later, updated_at: later });
  const cases = [
    ["another App", app(8, "other-app[bot]", "<!-- pendulum:7:plan -->\n## Something")],
    ["github-actions[bot]", app(9, "github-actions[bot]", "<!-- pendulum:7:plan -->\n## From a workflow")],
    ["another App's forged record of the new text", app(10, "other-app[bot]", `<!-- pendulum:7:plan -->${planTextMarker({ sha256: B, label: later })}\n## Forged`)],
  ];
  const issueNow = { gh: { graphql: async () => ({ repository: { issue: { title: "Objective", body: "Build the other thing.", lastEditedAt: L1 } } }) }, changed: async () => null };
  for (const [name, c] of cases) {
    const list = [mine, c];
    const read = async () => planOf(list, 7);
    assert.deepEqual([planOf(list, 7).id, planOf(list, 7).record], [2, { sha256: A, label: L0 }], name);
    // The text edited (B) after the plan, before the App's comment: every check still sees the change.
    assert.equal((await gate(list, { sha: B, work: false, editedAt: L1 })).r.ok, false, `${name}: the review`);
    assert.equal((await gate(list, { sha: B, work: true, labeledAt: L0, editedAt: L1 })).r.ok, false, `${name}: the next work stage`);
    assert.equal(await editedSincePlan(repo, 7, { token: "t" }, { ...issueNow, read }), "changed", `${name}: the merge and the queue`);
    assert.equal((await planStateNow(repo, 7, { sha: B, editedAt: L1 }, { token: "t" }, { planComment: read, changedAt: async () => null })).state, "changed", `${name}: post-review`);
  }
  // With no plan comment of Pendulum's, an App's marker only makes the check stricter: its time, never its record.
  const alone = planOf([cases[2][1]], 7);
  assert.deepEqual([alone.foreign, alone.record, alone.text], [true, null, null]);
  assert.equal(planTextState({ sha: B, plan: alone, editedAt: "2026-11-13T14:00:00Z" }), "changed");
});
