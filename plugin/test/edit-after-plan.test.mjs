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
function comments({ self, person, record = null, none = false, plan = "## Plan\n- [ ] item" }) {
  const list = [{ id: 3, user: { login: person }, body: "Use the second option.", created_at: L1 }];
  if (!none) list.unshift({ id: 2, user: { login: self }, body: `<!-- factory:7:plan -->${record ? planTextMarker(record) : ""}\n${plan}`, created_at: L0 });
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
  test(`edit after plan (${route}): an edit before the worker reads the text is simply used`, async () => {
    setSelf(self);
    const { r, applied, writes } = await gate(comments({ self, person, none: true }), { sha: B, work: true, labeledAt: L1 });
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
    assert.equal(planTextState({ sha: B, plan: planOf([{ id: 2, user: { login: self }, body: writes[0].body.body }], 7), labeledAt: L1, work: true }), "changed");
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
  const at = merge.lastIndexOf("await editedSincePlan(repo, issue, opts)");
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

const own = (body, extra = {}) => ({ id: 2, user: { login: "factory-app[bot]" }, body, created_at: L0, ...extra });

test("edit after plan: a plan comment saved with CRLF line ends keeps its record", async () => {
  setSelf("factory-app[bot]");
  // GitHub's web editor saves the whole comment with CRLF when a person ticks the plan's checklist.
  const list = [own(`<!-- factory:7:plan -->${planTextMarker({ sha256: A, label: L0 })}\r\n## Plan\r\n- [x] item`)];
  assert.deepEqual(planOf(list, 7).record, { sha256: A, label: L0 });
  const { r, applied } = await gate(list, { sha: B, work: false });
  assert.deepEqual([r.ok, applied[0]?.reason], [false, EDITED_REASON], "an edit after it still Blocks");
});

test("edit after plan: a plan comment whose record cannot be read is decided on GitHub's edit times, never taken for no plan", async () => {
  setSelf("factory-app[bot]");
  const T = (m) => `2026-11-13T${m}:00Z`;
  for (const head of ["", "<!-- factory:plan-text {not json} -->", '<!-- factory:plan-text {"sha256":"abc"} -->']) {
    const list = [own(`<!-- factory:7:plan -->${head}\n## Plan`, { created_at: T("10:00") })];
    assert.equal(planOf(list, 7).record, null);
    // No edit since the comment was posted: the same text. The work stage records it there and then, and hands the plan on.
    const kept = await gate(list, { sha: B, work: true, labeledAt: T("09:00"), editedAt: T("09:30") });
    assert.equal(kept.r.state, "same", head);
    assert.equal(kept.writes.length, 1);
    assert.equal(kept.writes[0].body.body, `<!-- factory:7:plan -->${planTextMarker({ sha256: B, label: T("09:00") })}\n## Plan`);
    // The body edited after it, no label since: Blocked, at review and at the next work stage.
    for (const work of [false, true]) {
      const edited = await gate(list, { sha: B, work, labeledAt: T("09:00"), editedAt: T("11:00") });
      assert.deepEqual([edited.r.ok, edited.applied[0]?.reason, edited.writes], [false, EDITED_REASON, []], head);
    }
    // The title, or a harness or model label, changed after it: the same.
    assert.equal((await gate(list, { sha: B, work: false, editedAt: T("09:30"), changedAt: T("11:00") })).r.ok, false);
    // The label applied after the edit: the plan is made again, and the old one is not handed on.
    const again = await gate(list, { sha: B, work: true, labeledAt: T("12:00"), editedAt: T("11:00") });
    assert.equal(again.r.state, "replan");
    assert.equal(planHanded(planOf(list, 7), again.r.record), null);
  }
});

test("edit after plan: a stage that knows no record never erases the one the plan comment has", async () => {
  setSelf("factory-app[bot]");
  const head = planTextMarker({ sha256: A, label: L0 });
  const list = [own(`<!-- factory:7:plan -->${head}\r\n## Plan`)];
  const written = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if ((init.method || "GET") === "GET") return new Response(JSON.stringify(list), { status: 200, headers: { "content-type": "application/json" } });
    written.push({ method: init.method, body: JSON.parse(init.body).body });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    // `factory deliver` with no issue.md from `factory issue`, or a review with no record: planSync with none.
    await planSync(repo, 7, { token: "t" }, null)("## Plan, ticked");
  } finally {
    globalThis.fetch = real;
  }
  assert.deepEqual(written, [{ method: "PATCH", body: `<!-- factory:7:plan -->${head}\n## Plan, ticked` }]);
});

test("edit after plan: the plan comment of another Factory login counts: a writer's in full, another App's for its time only", async () => {
  // Local mode (the developer's login) after the Action made the plan, or the other way round.
  setSelf("dev");
  const bot = { id: 2, user: { login: "factory-app[bot]", type: "Bot" }, body: `<!-- factory:7:plan -->${planTextMarker({ sha256: A, label: L0 })}\n## Plan`, created_at: L0 };
  const stranger = { id: 4, user: { login: "stranger", type: "User" }, author_association: "NONE", body: `<!-- factory:7:plan -->${planTextMarker({ sha256: B, label: L1 })}\n## Forged`, created_at: L1 };
  const fromApp = planOf([bot, stranger], 7);
  assert.deepEqual([fromApp.id, fromApp.text, fromApp.record, fromApp.own], [2, null, null, false], "another App's: its time, never its text or record; a stranger's: nothing");
  const edited = await gate([bot, stranger], { sha: B, work: false, editedAt: L1 });
  assert.equal(edited.r.ok, false, "edited after the App's plan comment: Blocked, not taken for no plan");
  assert.equal((await gate([bot], { sha: B, work: false, editedAt: "2026-11-13T09:00:00Z" })).r.ok, true);
  setSelf("factory-app[bot]");
  const writer = { id: 5, user: { login: "dev", type: "User" }, author_association: "MEMBER", body: `<!-- factory:7:plan -->${planTextMarker({ sha256: A, label: L1 })}\n## Plan from local mode`, created_at: L1, updated_at: L1 };
  const fromWriter = planOf([bot, writer], 7);
  assert.deepEqual([fromWriter.id, fromWriter.text, fromWriter.record], [5, "## Plan from local mode", { sha256: A, label: L1 }], "the newest written");
  const moved = await gate([bot, writer], { sha: B, work: false });
  assert.equal(moved.r.ok, false);
  // The work stage records on its own login's comment, with the plan it read.
  const same = await gate([writer], { sha: A, work: true, labeledAt: L1 });
  assert.deepEqual(same.writes.map((w) => [w.method, w.body.body]), [["POST", `<!-- factory:7:plan -->${planTextMarker({ sha256: A, label: L1 })}\n## Plan from local mode`]]);
});

test("edit after plan: the work stage's label time is the one read before the text", async () => {
  setSelf("factory-app[bot]");
  let read = 0;
  const r = await planGate({ repo, issue: 7, sha: A, labeledAt: L0, work: true, opts: { token: "t" }, apply: async () => {}, stage: "work", read: { planComment: async () => null, labeledAt: async () => (read += 1, L1) } });
  assert.deepEqual([r.record, read], [{ sha256: A, label: L0 }, 0]);
  const src = readFileSync(join(SCRIPTS, "worker.mjs"), "utf8");
  assert.ok(src.indexOf("await startedAt(") > 0 && src.indexOf("await startedAt(") < src.indexOf("await authorGate("), "worker.mjs reads the label time before the text");
  // run() sits inside main(): a local of that name there would hide the import (every work stage crashed on it once).
  assert.doesNotMatch(src, /\b(?:const|let|var)\s+startedAt\b/, "no local hides the imported startedAt");
  assert.match(src, /planGate\(\{[^)]*labeledAt,/);
  const local = readFileSync(join(SCRIPTS, "local.mjs"), "utf8");
  const deliver = local.slice(local.indexOf("async function deliver("));
  assert.ok(deliver.indexOf("await startedAt(") > 0 && deliver.indexOf("await startedAt(") < deliver.indexOf("await authorGate("), "so does deliver");
});

test("edit after plan: with Factory's own login unknown, the merge and a session's review stop rather than see no plan", async () => {
  setSelf(null);
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401, headers: { "content-type": "application/json" } });
  try {
    const plan = async () => planOf([own(`<!-- factory:7:plan -->${planTextMarker({ sha256: A, label: L0 })}\n## Plan`)], 7);
    await assert.rejects(editedSincePlan(repo, 7, { token: "t" }, { read: plan, gh: { graphql: async () => ({ repository: { issue: { title: "Objective", body: "Build the other thing." } } }) } }), /own login could not be read/);
    await assert.rejects(planStateNow(repo, 7, { sha: B }, { token: "t" }, { planComment: plan }), /own login could not be read/);
  } finally {
    globalThis.fetch = real;
  }
});

test("edit after plan: another App's marker never hides Factory's plan comment or its record, github-actions[bot] included", async () => {
  setSelf("factory-app[bot]");
  const mine = own(`<!-- factory:7:plan -->${planTextMarker({ sha256: A, label: L0 })}\n## Plan`);
  const later = "2026-11-13T13:00:00Z";
  const app = (id, login, body) => ({ id, user: { login, type: "Bot" }, body, created_at: later, updated_at: later });
  const cases = [
    ["another App", app(8, "other-app[bot]", "<!-- factory:7:plan -->\n## Something")],
    ["github-actions[bot]", app(9, "github-actions[bot]", "<!-- factory:7:plan -->\n## From a workflow")],
    ["another App's forged record of the new text", app(10, "other-app[bot]", `<!-- factory:7:plan -->${planTextMarker({ sha256: B, label: later })}\n## Forged`)],
  ];
  const issueNow = { gh: { graphql: async () => ({ repository: { issue: { title: "Objective", body: "Build the other thing.", lastEditedAt: L1 } } }) }, changed: async () => null };
  for (const [name, c] of cases) {
    const list = [mine, c];
    const read = async () => planOf(list, 7);
    assert.deepEqual([planOf(list, 7).id, planOf(list, 7).record], [2, { sha256: A, label: L0 }], name);
    // The text edited (B) after the plan, before the App's comment: every check still sees the change.
    assert.equal((await gate(list, { sha: B, work: false, editedAt: L1 })).r.ok, false, `${name}: the review`);
    assert.equal((await gate(list, { sha: B, work: true, labeledAt: L0, editedAt: L1 })).r.ok, false, `${name}: the next work stage`);
    assert.equal(await editedSincePlan(repo, 7, { token: "t" }, { ...issueNow, read }), true, `${name}: the merge and the queue`);
    assert.equal((await planStateNow(repo, 7, { sha: B, editedAt: L1 }, { token: "t" }, { planComment: read, changedAt: async () => null })).state, "changed", `${name}: post-review`);
  }
  // With no plan comment of Factory's, an App's marker only makes the check stricter: its time, never its record.
  const alone = planOf([cases[2][1]], 7);
  assert.deepEqual([alone.foreign, alone.record, alone.text], [true, null, null]);
  assert.equal(planTextState({ sha: B, plan: alone, editedAt: "2026-11-13T14:00:00Z" }), "changed");
});
