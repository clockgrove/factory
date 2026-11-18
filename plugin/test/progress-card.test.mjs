// The progress comment's card (#589): the stage's real reporter on a fake GitHub writes the card over its log, the log
// and every hidden line byte-identical to the comment a stage wrote before the card, and every reader reads the new
// comment as the old one: the scorecard's phases, cost-join, the report's stage reads and the finish card.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { endStep, nextStep, progressReporter, PROGRESS_CARD_ROOM, PROGRESS_LEDGER_ROOM, questionAnswer, questionNotice } from "../scripts/lib/session.mjs";
import { repoOf } from "../scripts/lib/github.mjs";
import { decisionsReadOf, findingsOf, ledgerOfComment, rebaseCostOf, setSelf, spendOf, spendParts } from "../scripts/lib/logic.mjs";
import { stageHarnessOf } from "../scripts/lib/cost-join.mjs";
import { finishData, modellessStages, objectiveSpend, renderFinishCard, summaryMarker, unlinedStages } from "../scripts/lib/finish-card.mjs";
import { ROWS_MAX, progressCard, progressData, stepOf, stepRows } from "../scripts/lib/progress-card.mjs";
import { tableCell } from "../scripts/lib/card-kit.mjs";
import { phaseMinutes, stageLastWrite } from "../../bench/lib/phases.mjs";
import { newForm, newForms } from "./fixtures/progress-new-form.mjs";

const at = (iso) => Date.parse(iso);
const ZONE = { GITHUB_ACTIONS: "true", PENDULUM_TIME_ZONE: "America/Los_Angeles" };

/** Runs `fn` with these env vars set (undefined: unset), restored once its promise settles. */
async function withEnv(vars, fn) {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const set = (v) => {
    for (const [k, x] of Object.entries(v)) if (x === undefined) delete process.env[k];
    else process.env[k] = x;
  };
  set(vars);
  try {
    return await fn();
  } finally {
    set(before);
  }
}

/**
 * The stage's real reporter on a fake GitHub with a fake clock: `drive(p, clock)` writes its lines. Returns every body
 * written, its key line removed.
 */
async function reporter(stage, drive, { start = "2026-11-18T04:41:10Z", runId = "1794976879130" } = {}) {
  const real = globalThis.fetch;
  const realNow = Date.now;
  const posted = [];
  globalThis.fetch = async (url, init = {}) => {
    const json = (v) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
    if ((init.method || "GET") === "GET") return json([]);
    posted.push(JSON.parse(init.body).body);
    return json({ id: 9, user: { login: "me", type: "User" }, body: posted.at(-1) });
  };
  let t = at(start);
  Date.now = () => t;
  const clock = (iso) => {
    t = at(iso);
  };
  try {
    await withEnv(ZONE, async () => {
      const p = progressReporter(repoOf("acme/app"), 433, { token: () => "t" }, { stage, runId, harness: "claude", model: stage === "review" ? "claude-fable-5-2" : "claude-opus-5-5", soFar: null });
      await drive(p, clock);
    });
  } finally {
    globalThis.fetch = real;
    Date.now = realNow;
  }
  return posted;
}

const LEDGER = '<!-- pendulum:ledger {"v":"0.10.2","m":"claude-fable-5-2","b":"subscription","p":[{"l":"review","ms":[1794976905000,1794977257000],"u":1.592051},{"l":"decision","d":7,"m":null,"b":"api","ms":[1794977386000,1794978436000],"q":7,"w":["decision"]},{"l":"answer","m":"claude-opus-5-5","e":"medium","ms":[1794977266000,1794977940000],"u":1.511129}]} -->';
const SPEND = { usdByBilling: { subscription: 3.10318, api: 0 }, billing: "subscription", usdUnknown: 7, usdUnknownWhy: ["decision"] };
const FINDINGS = { pr: 435, reviews: [5950949242], items: [{ id: 4609309105, outcome: "fixed-test", review: 5950949242 }, { id: 4609248794, outcome: "fixed-verdict", from: "github-advanced-security[bot]" }] };
const RAN = { harness: "claude", worker: "claude-opus-5-5", subagent: "claude-sonnet-5-5", reviewer: "claude-fable-5-2", labels: [] };

/** PR #435's review stage (clockgrove's #433, Kirk's mockup), through the real reporter. `stop`: where it stops writing. */
const review435 = (stop = null) =>
  reporter("review", async (p, clock) => {
    p.link("PR #435", "https://github.com/acme/app/pull/435");
    p.ran(RAN);
    await p("install", { step: "setup" });
    await p("re-entry: fresh (resume policy is fresh)", { step: "setup", resume: "fresh (resume policy is fresh)" });
    await p("pre-review-validation pass 1 (required checks)", { step: "ci" });
    await p("waiting for required checks (ci) on 95d326b", { step: "ci", sha: "95d326b" });
    await p("reviewer claude-fable-5-2", { step: "review", model: "claude-fable-5-2" });
    clock("2026-11-18T04:47:30Z");
    await p("answer pass: 3 comment(s) (1 from third-party reviewers)", { step: "answer", comments: 3, thirdParty: 1 });
    clock("2026-11-18T04:59:30Z");
    await p("review-validation pass 1 (required checks)", { step: "ci" });
    clock("2026-11-18T05:05:30Z");
    await p("waiting for required checks (ci) on e755fde", { step: "ci", sha: "e755fde" });
    if (stop === "running") {
      clock("2026-11-18T05:07:00Z");
      p.live("claude (claude-opus-5-5) working: 3 min, 12 turns", { force: true });
      await new Promise((r) => setTimeout(r, 20));
      return;
    }
    clock("2026-11-18T05:07:30Z");
    await p.findings(FINDINGS);
    await p("finding check: 2 of 2 named test(s) fail without the fix and pass with it", { step: "check", tests: { proven: 2, of: 2 } });
    await p("finding check (perplexity/pplx-decider-v1.2): 1 of 1 answer(s) resolve their findings", { step: "check", judged: { resolved: 1, of: 1 }, model: "perplexity/pplx-decider-v1.2" });
    p.spend(3.10318, SPEND, LEDGER);
    await p.decisionsRead({});
    await p("exit: delivered; usd 3.10318 (review 1.59, answer 1.51)", endStep({ issue: 433, exit: "delivered" }));
  });

/** The comment this stage wrote before the card (#586's lines), key removed: what every reader read, byte for byte. */
const OLD_435 = [
  "Pendulum review run 1794976879130 · [PR #435](https://github.com/acme/app/pull/435): started 8:41 PM PST<!-- 04:41Z -->, 26 min at the last line.",
  "- 8:41 PM PST<!-- 04:41Z --> install",
  "- 8:41 PM PST<!-- 04:41Z --> re-entry: fresh (resume policy is fresh)",
  "- 8:41 PM PST<!-- 04:41Z --> pre-review-validation pass 1 (required checks)",
  "- 8:41 PM PST<!-- 04:41Z --> waiting for required checks (ci) on 95d326b",
  "- 8:41 PM PST<!-- 04:41Z --> reviewer claude-fable-5-2",
  "- 8:47 PM PST<!-- 04:47Z --> answer pass: 3 comment(s) (1 from third-party reviewers)",
  "- 8:59 PM PST<!-- 04:59Z --> review-validation pass 1 (required checks)",
  "- 9:05 PM PST<!-- 05:05Z --> waiting for required checks (ci) on e755fde",
  "- 9:07 PM PST<!-- 05:07Z --> finding check: 2 of 2 named test(s) fail without the fix and pass with it",
  "- 9:07 PM PST<!-- 05:07Z --> finding check (perplexity/pplx-decider-v1.2): 1 of 1 answer(s) resolve their findings",
  "- 9:07 PM PST<!-- 05:07Z --> exit: delivered; usd 3.10318 (review 1.59, answer 1.51)",
  '<!-- pendulum:harness {"harness":"claude","model":"claude-fable-5-2","models":{"worker":"claude-opus-5-5","subagent":"claude-sonnet-5-5","reviewer":"claude-fable-5-2"},"labels":[]} -->',
  `<!-- pendulum:spend ${JSON.stringify({ usd: 3.10318, ...SPEND })} -->`,
  LEDGER,
  "<!-- pendulum:decisions-read {} -->",
  `<!-- pendulum:findings ${JSON.stringify(FINDINGS)} -->`,
].join("\n");
const KEY = "<!-- pendulum:433:progress:review:1794976879130 -->";

/** The hidden lines and stamps of a body: every line that starts a marker, and each line's UTC stamp. */
const hidden = (body) => body.split("\n").filter((l) => l.startsWith("<!--")).concat([...body.matchAll(/<!-- (\d\d:\d\dZ) -->/g)].map((m) => m[1]));

test("the card's log is the comment every reader read before it, byte for byte; its hidden lines and UTC stamps are the same", async () => {
  const bodies = await review435();
  const now = bodies.at(-1);
  assert.ok(now.startsWith(`${KEY}\n### 🔍 Review`), "the card first, under the key");
  assert.ok(now.includes(`\n\n${OLD_435}\n\n</details>`), "the old comment whole, in Run details");
  assert.deepEqual(hidden(now), hidden(`${KEY}\n${OLD_435}`));
  assert.ok(now.length < PROGRESS_CARD_ROOM);
});

test("every reader reads the new comment as the old one: phases, cost-join, spend, ledger, findings, decisions read", async () => {
  const now = (await review435()).at(-1);
  const old = `${KEY}\n${OLD_435}`;
  const comment = (body) => ({ body, user: { login: "me", type: "User" }, created_at: "2026-11-18T04:41:10Z", updated_at: "2026-11-18T05:07:31Z" });
  assert.deepEqual(phaseMinutes([comment(now)], 433), phaseMinutes([comment(old)], 433));
  assert.equal(phaseMinutes([comment(now)], 433).modelMinutes, 18, "read from the log, not the table");
  assert.equal(stageLastWrite(comment(now)), stageLastWrite(comment(old)));
  for (const read of [stageHarnessOf, spendParts, spendOf, ledgerOfComment, findingsOf, rebaseCostOf]) assert.deepEqual(read(now), read(old), read.name);
  // cost-join's fallback to the harness line when the marker is gone reads the log's line too.
  const bare = (b) => b.replace(/^<!-- pendulum:harness [^\n]*\n/m, "");
  assert.deepEqual(stageHarnessOf(bare(now)), stageHarnessOf(bare(old)));
  assert.deepEqual(decisionsReadOf([comment(now)], { issue: 433, self: "me" }), decisionsReadOf([comment(old)], { issue: 433, self: "me" }));
});

test("the finish card, its summary and the Objective's spend read the new comments as the old ones", () => {
  const real = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "finish-scratch-3.json"), "utf8"));
  const data = (comments) => {
    setSelf("clockgrove-pendulum[bot]");
    try {
      return finishData({ repo: "clockgrove/pendulum-scratch", issue: real.issue, timeline: real.timeline, comments, pulls: [{ pr: real.pr, timeline: real.prTimeline, reviews: real.reviews, reviewComments: real.reviewComments }], checks: real.checks, records: real.records });
    } finally {
      setSelf(null);
    }
  };
  const fresh = newForms(real.comments);
  assert.ok(fresh.some((c, i) => c.body !== real.comments[i].body && c.body.includes("<details><summary>Run details</summary>")), "the fixture has progress comments, now in the new form");
  const [a, b] = [data(real.comments), data(fresh)];
  assert.equal(summaryMarker(b), summaryMarker(a));
  assert.equal(renderFinishCard(b), renderFinishCard(a));
  const mine = (c) => c.user?.login === "clockgrove-pendulum[bot]";
  assert.deepEqual(objectiveSpend({ issue: 3, comments: fresh, mine }), objectiveSpend({ issue: 3, comments: real.comments, mine }));
  assert.deepEqual(unlinedStages(fresh, 3, mine), unlinedStages(real.comments, 3, mine));
  assert.deepEqual(modellessStages(fresh, 3, mine), modellessStages(real.comments, 3, mine));
});

test("render: delivered, as Kirk's mockup (cents on each step's row from the ledger, unknown runs counted in the headline)", async () => {
  const card = (await review435()).at(-1).split("\n\n<details>")[0];
  assert.equal(
    card,
    [
      KEY,
      "### 🔍 Review · [PR #435](https://github.com/acme/app/pull/435) · ✅ delivered",
      "**Started 8:41 PM PST · 26 min** · **$3.10** on your subscription (API-equivalent) · 7 decision calls of unknown cost",
      "",
      "| Time | Step | |",
      "|---|---|---|",
      "| 8:41 PM | Set up | fresh start |",
      "| 8:41 PM | Waited for CI | `95d326b` |",
      "| 8:41 PM | Review | Fable 5.2 · **$1.59** |",
      "| 8:47 PM | Answered 3 comments | 1 from a third-party reviewer · **$1.51** |",
      "| 8:59 PM | Waited for CI | `e755fde` |",
      "| 9:07 PM | Checked the answers | 2 of 2 fixes proven by tests · 1 of 1 judged resolved |",
    ].join("\n"),
  );
  const details = (await review435()).at(-1).split("<details><summary>Run details</summary>\n\n")[1];
  assert.match(details, /^harness claude · models: worker Opus 5\.5, sub-agent Sonnet 5\.5, reviewer Fable 5\.2 · resume: fresh \(resume policy is fresh\) · decision model: perplexity\/pplx-decider-v1\.2\n\n7 runs of unknown cost: /);
});

test("render: running, the last row says what the stage is doing now, for how long, and what its harness last said", async () => {
  const body = (await review435("running")).at(-1);
  assert.match(body, /^### 🔍 Review · \[PR #435\]\(https:\/\/github\.com\/acme\/app\/pull\/435\) · ⏳ running$/m);
  assert.match(body, /^\| 8:59 PM \| \*\*Waiting for CI · 8 min so far\*\* \| `e755fde` · claude \(claude-opus-5-5\) working: 3 min, 12 turns \|$/m);
  assert.doesNotMatch(body, /^\*\*claude/m, "the live line is in the table, not over the card");
});

test("render: Blocked and Question get the notice's own 'what to do' under the headline", async () => {
  const pr = { number: 435, draft: true };
  const blocked = endStep({ issue: 433, exit: "blocked", reason: "the fix pass made no progress", applied: { exit: "blocked", pr, cause: "work" } });
  assert.equal(blocked.todo, nextStep({ issue: 433, pr, next: "work" }));
  const body = (
    await reporter("work", async (p) => {
      p.link("PR #435", "https://github.com/acme/app/pull/435");
      await p("setup", { step: "setup" });
      await p("exit: blocked (the fix pass made no progress); usd 0", blocked);
    })
  ).at(-1);
  assert.match(body, /^### 🛠️ Work · \[PR #435\]\(https:\/\/github\.com\/acme\/app\/pull\/435\) · ⛔ Blocked$/m);
  assert.ok(body.includes(`\n\n**What to do:** Resume once the cause is fixed: re-apply \`pendulum:objective\` to go on from \`pendulum/433\` and PR #435.`));
  assert.match(body, /^\| 8:41 PM \| Blocked \| the fix pass made no progress \|$/m);
  // A Blocked stage whose applied exit is not known points to its notice; a Question says how to answer, as its notice.
  assert.match(endStep({ issue: 433, exit: "blocked" }).todo, /Blocked notice/);
  const q = endStep({ issue: 433, exit: "question", reason: "which API?", applied: { exit: "question", pr: { number: 435 } } });
  assert.equal(q.todo, questionAnswer({ pr: { number: 435 } }));
  assert.ok(questionNotice({ reason: "which API?", pr: { number: 435 } }).endsWith(q.todo));
  const qb = (await reporter("review", async (p) => p("exit: question (which API?)", q))).at(-1);
  assert.match(qb, /· ❓ Question$/m);
  assert.ok(qb.includes(`**What to do:** ${q.todo}`));
});

test("render: a long fix loop folds into one row with its count, the CI runs between it named; the table stays short", () => {
  const t0 = at("2026-11-18T04:00:00Z");
  const lines = [[t0, "harness", stepOf({ step: "work", model: "claude-opus-5-5", attempt: 1 })]];
  let t = t0 + 60_000;
  for (let i = 1; i <= 12; i++) {
    lines.push([(t += 60_000), "pass", stepOf({ step: "ci" })], [(t += 60_000), "wait", stepOf({ step: "ci", sha: `abc${String(i).padStart(4, "0")}` })], [(t += 60_000), "red", stepOf({ step: "fix", detail: "npm test was red" })]);
  }
  lines.push([(t += 60_000), "pass", stepOf({ step: "ci" })], [(t += 60_000), "wait", stepOf({ step: "ci", sha: "def0001" })], [(t += 60_000), "exit", stepOf({ step: "exit", exit: "delivered" })]);
  const rows = stepRows(lines);
  assert.deepEqual(rows.map((r) => [r.kind, r.passes ?? null, r.between]), [["work", 1, 0], ["ci", null, 0], ["fix", 12, 11], ["ci", null, 0]]);
  const { card } = withEnvSync(ZONE, () => progressCard({ stage: "work", issue: 7, started: t0, now: t, lines, exit: "delivered", spend: 4.2, parts: { usdByBilling: { api: 4.2 } } }));
  assert.match(card, /^\| 8:04 PM \| Fixed CI ×12 \| npm test was red · 11 CI steps between, in Run details \|$/m);
  assert.equal(card.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| Time")).length, 4);
  // Past ROWS_MAX rows, the middle ones fold into one row that points to Run details.
  const many = Array.from({ length: 90 }, (_, i) => [t0 + i * 60_000, `note ${i}`, stepOf(null, `note ${i}`)]);
  const big = withEnvSync(ZONE, () => progressCard({ stage: "work", issue: 7, started: t0, now: t0 + 90 * 60_000, lines: many, exit: "stopped" })).card;
  assert.equal(big.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| Time")).length, ROWS_MAX);
  assert.match(big, /^\| … \| 51 more steps \| in Run details \|$/m);
});

test("the data the table and charts read: each row's time span and its own dollars, the cents adding up", () => {
  const t0 = at("2026-11-18T04:00:00Z");
  const lines = [
    [t0, "setup", stepOf({ step: "setup" })],
    [t0 + 60_000, "harness", stepOf({ step: "work", model: "claude-opus-5-5" })],
    [t0 + 600_000, "fix", stepOf({ step: "fix" })],
  ];
  const ledger = [
    { label: "work-1", started: new Date(t0 + 61_000).toISOString(), usd: 1.004, usdUnknown: 0 },
    { label: "decision", decision: true, started: new Date(t0 + 62_000).toISOString(), usd: null, usdUnknown: 2 },
    { label: "validation-fix-1", started: new Date(t0 + 601_000).toISOString(), usd: 0.003, usdUnknown: 1 },
  ];
  const d = progressData({ stage: "work", issue: 7, started: t0, now: t0 + 700_000, lines, spend: 1.007, ledger, zone: "UTC" });
  assert.deepEqual(d.rows.map((r) => [r.kind, r.end - r.t, r.usd, r.unknown, r.cents]), [["setup", 60_000, null, 0, null], ["work", 540_000, 1.004, 0, 101], ["fix", 100_000, 0.003, 1, 0]]);
});

test("table cells: one line, pipes escaped, no HTML, bounded; the comment stays under GitHub's limit with a huge log", async () => {
  assert.equal(tableCell("a | b\nc <img src=x>"), "a \\| b c &lt;img src=x&gt;");
  assert.equal(tableCell("x".repeat(400)).length, 300);
  const huge = "y".repeat(1990);
  const bodies = await reporter("work", async (p) => {
    for (let i = 0; i < 28; i++) await p(`${huge} ${i}`, { step: "note" });
    p.spend(1, { usdByBilling: { api: 1 } }, LEDGER);
    await p("exit: delivered", { step: "exit", exit: "delivered" });
  });
  const body = bodies.at(-1);
  assert.ok(body.length <= 65_536, `${body.length}`);
  assert.ok(body.includes("The steps are in Run details: this comment is near GitHub's size limit."), `${body.length} ${body.indexOf("<details>")}`);
  // The ledger is cut by the log's own size, as before the card: this log fits with it.
  const log = body.split("<details><summary>Run details</summary>\n\n")[1];
  assert.ok(log.length < PROGRESS_LEDGER_ROOM && body.includes(LEDGER));
});

test("every line a stage writes names its step: no progress call is left a bare note", () => {
  const files = ["worker.mjs", "review.mjs", "lib/session.mjs", "lib/finding-check.mjs", "lib/third-party-review.mjs", "lib/triage.mjs", "lib/drift.mjs", "lib/objective-trust.mjs"];
  const bare = [];
  for (const f of files) {
    const src = readFileSync(join(import.meta.dirname, "..", "scripts", f), "utf8");
    src.split("\n").forEach((l, i) => {
      if (/^\s*(\/\/|\*)/.test(l)) return;
      if (/await (?:progress|onPhase|args\.onPhase)\??\.?\(/.test(l) && !/\bstep\b|endStep/.test(l)) bare.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(bare, []);
});

/** withEnv for a synchronous `fn`. */
function withEnvSync(vars, fn) {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, x] of Object.entries(vars)) process.env[k] = x;
  try {
    return fn();
  } finally {
    for (const [k, x] of Object.entries(before)) if (x === undefined) delete process.env[k];
    else process.env[k] = x;
  }
}

test("newForm (the readers' fixture) is the reporter's form: key, card, Run details holding the old body", () => {
  const old = `${KEY}\n${OLD_435}`;
  const fresh = newForm(old, "2026-11-18T04:41:00Z");
  assert.ok(fresh.startsWith(`${KEY}\n### 🔍 Review`));
  assert.ok(fresh.endsWith(`\n\n${OLD_435}\n\n</details>`));
});
