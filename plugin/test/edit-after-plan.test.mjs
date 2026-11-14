import "./temp.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setSelf } from "../scripts/lib/logic.mjs";
import { planHanded, planOf, planSync, planTextMarker, planTextOf } from "../scripts/lib/handoff.mjs";
import { EDITED_FIX, EDITED_REASON, objectiveSha, planGate, planTextState } from "../scripts/lib/objective-trust.mjs";
import { blockedLine, mergeBlockCause, mergeBlockReason } from "../scripts/lib/session.mjs";
import { BLOCK_CAUSES } from "../scripts/lib/logic.mjs";

// #205: an edit to an Objective's title or body after its plan was made is never acted on halfway. The plan comment
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
  { route: "Actions", self: "factory-app[bot]", person: "kirk" },
  { route: "cloud sandbox", self: "factory-app[bot]", person: "kirk" },
  { route: "local mode", self: "dev", person: "dev" },
];

/** GitHub's comments on issue 7: the plan comment Factory wrote (from `record`, or none), and a person's answer. */
function comments({ self, person, record = null, plan = "## Plan\n- [ ] item" }) {
  const list = [{ id: 3, user: { login: person }, body: "Use the second option.", created_at: L1 }];
  if (record !== undefined) list.unshift({ id: 2, user: { login: self }, body: `<!-- factory:7:plan -->${record ? planTextMarker(record) : ""}\n${plan}`, created_at: L0 });
  return list;
}

/** A stage's gate against the plan comment `list`, the latest label event at `labeledAt`; GitHub's writes recorded. */
async function gate(list, { sha, work, labeledAt = L0, before = null }) {
  const applied = [];
  const writes = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    writes.push({ url: String(url), method: init.method, body: init.body ? JSON.parse(init.body) : null });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const r = await planGate({ repo, issue: 7, sha, work, pr: { number: 9 }, notify: "boss", opts: { token: "t" }, apply: async (_, exit) => applied.push(exit), before, stage: work ? "work" : "review", read: { planComment: async () => planOf(list, 7), labeledAt: async () => labeledAt } });
    return { r, applied, writes };
  } finally {
    globalThis.fetch = real;
  }
}

test("edit after plan: the text's record is decided on the hash and GitHub's label times, never the words", () => {
  const plan = { sha256: A, label: L0 };
  assert.equal(planTextState({ sha: A, record: null, work: true }), "unplanned", "no plan yet: the text is simply used");
  assert.equal(planTextState({ sha: A, record: plan, labeledAt: L1, work: true }), "same");
  assert.equal(planTextState({ sha: B, record: plan, labeledAt: L0, work: true }), "changed", "an edit with no label applied since: Blocked");
  assert.equal(planTextState({ sha: B, record: plan, labeledAt: L1, work: true }), "replan", "the label applied after the edit: plan again");
  assert.equal(planTextState({ sha: B, record: plan, labeledAt: L1 }), "changed", "the review stage never plans");
  assert.notEqual(objectiveSha("Objective", "Build the thing. "), A, "any change to the body is an edit");
  assert.notEqual(objectiveSha("Objective!", "Build the thing."), A, "and to the title");
  assert.notEqual(objectiveSha("a", "b\nc"), objectiveSha("a\nb", "c"), "title and body are kept apart");
});

for (const { route, self, person } of ROUTES) {
  test(`edit after plan (${route}): an edit before the worker reads the text is simply used`, async () => {
    setSelf(self);
    const { r, applied, writes } = await gate(comments({ self, person, record: undefined }), { sha: B, work: true, labeledAt: L1 });
    assert.deepEqual([r.ok, r.state], [true, "unplanned"]);
    assert.deepEqual(r.record, { sha256: B, label: L1 }, "the plan this stage makes records the text it read");
    assert.deepEqual([applied, writes], [[], []]);
  });

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
    assert.match(notice, /title or body changed after its plan was made/);
    assert.match(notice, /Re-apply `factory:objective` to work from the new text: the worker makes its plan again from it/);
  });

  test(`edit after plan (${route}): an edit while Blocked, then the label re-applied, plans again from the new text`, async () => {
    setSelf(self);
    const list = comments({ self, person, record: { sha256: A, label: L0 } });
    const { r, applied, writes } = await gate(list, { sha: B, work: true, labeledAt: L1 });
    assert.deepEqual([r.ok, r.state], [true, "replan"]);
    assert.deepEqual(r.record, { sha256: B, label: L1 });
    assert.deepEqual([applied, writes], [[], []]);
    assert.equal(planHanded(planOf(list, 7), r.record), null, "the plan made from the earlier text is not handed to the harness");
    // Once the new plan is posted with its record, the stages after it go on.
    const replanned = comments({ self, person, record: r.record, plan: "## Plan\n- [ ] new item" });
    assert.equal(planHanded(planOf(replanned, 7), r.record), "## Plan\n- [ ] new item");
    assert.equal((await gate(replanned, { sha: B, work: false })).r.ok, true, "the review of the new plan's work");
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

  test(`edit after plan (${route}): a work stage started by a new label on the same text moves the record's label time`, async () => {
    setSelf(self);
    const list = comments({ self, person, record: { sha256: A, label: L0 } });
    const { r, writes } = await gate(list, { sha: A, work: true, labeledAt: L1 });
    assert.equal(r.state, "same");
    assert.equal(writes.length, 1);
    assert.equal(writes[0].method, "PATCH");
    assert.match(writes[0].url, /\/repos\/acme\/app\/issues\/comments\/2$/);
    assert.equal(writes[0].body.body, `<!-- factory:7:plan -->${planTextMarker({ sha256: A, label: L1 })}\n## Plan\n- [ ] item`, "the plan's text unchanged");
    // So an edit after this stage, with no label after it, Blocks rather than plans again.
    assert.equal(planTextState({ sha: B, record: planOf([{ id: 2, user: { login: self }, body: writes[0].body.body }], 7).record, labeledAt: L1, work: true }), "changed");
  });
}

test("edit after plan: the record is Factory's own, on the plan comment's marker line", async () => {
  setSelf("factory-app[bot]");
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
  assert.match(posted[0], /^<!-- factory:7:plan --><!-- factory:plan-text \{"sha256":"[0-9a-f]{64}","label":"2026-11-13T10:00:00Z"\} -->\n&lt;!-- factory:plan-text/);
  const mine = planOf([{ id: 2, user: { login: "factory-app[bot]" }, body: posted[0] }], 7);
  assert.deepEqual(mine.record, { sha256: A, label: L0 });
  assert.match(mine.text, /^&lt;!-- factory:plan-text .*\n## Plan$/, "the marker line is not the plan's");
  assert.equal(planOf([{ id: 2, user: { login: "stranger" }, body: posted[0] }], 7), null, "anyone else's copy of the comment is no plan");
  assert.equal(planOf([{ id: 2, user: { login: "factory-app[bot]" }, body: `<!-- factory:7:plan -->\n${planTextMarker({ sha256: B, label: L1 })}\n## Plan` }], 7).record, null, "a record below the marker line is not read");
  assert.equal(planTextOf('<!-- factory:plan-text {"sha256":"abc","label":null} -->'), null, "a record that is no SHA-256");
});

test("edit after plan: the merge Blocks on an edit, cause work, as every other merge Block", () => {
  assert.equal(mergeBlockReason("edited"), EDITED_REASON);
  assert.equal(mergeBlockCause("edited"), "work");
  const src = readFileSync(join(SCRIPTS, "lib", "session.mjs"), "utf8");
  const merge = src.slice(src.indexOf("export async function mergeReadyOne("));
  const at = merge.indexOf("await editedSincePlan(repo, issue, opts)");
  assert.ok(at > merge.indexOf('return "unread"'), "checked once the checks are green, before any merge");
  assert.ok(merge.indexOf("await mergeVerified(") > at, "the merge only after the check");
});

test("edit after plan: every route's work and review stages check the text before any harness, after the trust check", () => {
  // Actions runs worker.mjs and review.mjs as its jobs; a cloud sandbox stage (stage.mjs) and local mode (local.mjs) run the same scripts.
  assert.match(readFileSync(join(SCRIPTS, "stage.mjs"), "utf8"), /stage === "work" \? "worker\.mjs" : "review\.mjs"/);
  const local = readFileSync(join(SCRIPTS, "local.mjs"), "utf8");
  assert.match(local, /this\.stage\(issue, "work", "worker\.mjs"/);
  assert.match(local, /this\.stage\(issue, "review", "review\.mjs"/);
  for (const [file, work] of [["worker.mjs", true], ["review.mjs", false]]) {
    const src = readFileSync(join(SCRIPTS, file), "utf8");
    const trust = src.indexOf("await authorGate(");
    const at = src.indexOf("await planGate(");
    assert.ok(trust > 0 && at > trust, `${file}: the trust rule first, so an edit by someone who cannot push Blocks as before`);
    const call = src.slice(at, src.indexOf("\n", at));
    assert.match(call, /sha: trusted\.sha/, `${file}: the text the stage acts on`);
    assert.equal(/work: true/.test(call), work, `${file}: only the work stage plans again`);
    if (!work) assert.match(call, /before: dropLabel/);
    assert.match(src.slice(at, at + 800), /if \(!planned\.ok\) \{\n\s+log\(planned\.reason\);\n\s+await finish\("blocked", planned\.reason\);\n\s+return;/, `${file} stops on a Block`);
    for (const later of ["declaredQuestion(", "openOutbox(", "installPlugin(", "runHarness(", "openHandoff(", "validationLoop("]) {
      const i = src.indexOf(later, src.indexOf("async function run()"));
      assert.ok(i === -1 || i > at, `${file}: ${later} only after the check`);
    }
    assert.match(src, /openHandoff\(\{[^}]*record: planned\.record \}\)/, `${file}: the plan comment carries the record`);
  }
});
