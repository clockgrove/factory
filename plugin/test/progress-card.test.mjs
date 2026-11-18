// The progress comment's card (#589): the stage's real reporter on a fake GitHub writes the card over its log, the log
// and every hidden line byte-identical to the comment a stage wrote before the card, and every reader reads the new
// comment as the old one: the scorecard's phases, cost-join, the report's stage reads and the finish card.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GITHUB_COMMENT_MAX, PROGRESS_LEDGER_ROOM, appliedExit, endStep, progressReporter } from "../scripts/lib/session.mjs";
import { repoOf } from "../scripts/lib/github.mjs";
import { decisionsReadOf, findingsOf, ledgerOfComment, rebaseCostOf, setSelf, spendOf, spendParts } from "../scripts/lib/logic.mjs";
import { stageHarnessOf } from "../scripts/lib/cost-join.mjs";
import { finishData, modellessStages, objectiveSpend, renderFinishCard, summaryMarker, unlinedStages } from "../scripts/lib/finish-card.mjs";
import { progressCard, progressData, stepOf } from "../scripts/lib/progress-card.mjs";
import { tableCell, vendorCard } from "../scripts/lib/card-kit.mjs";
import { vendorBody, vendorLine } from "../scripts/lib/logic.mjs";
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
    await p("install", { step: "setup", end: at("2026-11-18T04:41:30Z") });
    await p("re-entry: fresh (resume policy is fresh)", { step: "setup", session: "fresh (resume policy is fresh)" });
    await p("pre-review-validation pass 1 (required checks)", { step: "ci", begin: true });
    await p("waiting for required checks (ci) on 95d326b", { step: "ci", sha: "95d326b", wait: true, end: at("2026-11-18T04:47:20Z"), outcome: "passed" });
    await p("reviewer claude-fable-5-2", { step: "review", model: "claude-fable-5-2" });
    clock("2026-11-18T04:47:30Z");
    await p("answer pass: 3 comment(s) (1 from third-party reviewers)", { step: "answer", comments: 3, thirdParty: 1 });
    clock("2026-11-18T04:59:30Z");
    await p("review-validation pass 1 (required checks)", { step: "ci", begin: true });
    clock("2026-11-18T05:05:30Z");
    const last = { step: "ci", sha: "e755fde", wait: true };
    await p("waiting for required checks (ci) on e755fde", last);
    if (stop === "running") {
      clock("2026-11-18T05:07:00Z");
      p.live("claude (claude-opus-5-5) working: 3 min, 12 turns", { force: true });
      await new Promise((r) => setTimeout(r, 20));
      return;
    }
    clock("2026-11-18T05:07:30Z");
    Object.assign(last, { end: at("2026-11-18T05:07:00Z"), outcome: "passed" });
    await p.findings(FINDINGS);
    await p("finding check: 2 of 2 named test(s) fail without the fix and pass with it", { step: "check", tests: { proven: 2, of: 2 }, start: at("2026-11-18T05:07:05Z"), end: at("2026-11-18T05:07:20Z") });
    await p("finding check (perplexity/pplx-decider-v1.2): 1 of 1 answer(s) resolve their findings", { step: "check", judged: { resolved: 1, of: 1 }, model: "perplexity/pplx-decider-v1.2", start: at("2026-11-18T05:07:20Z"), end: at("2026-11-18T05:07:30Z") });
    p.spend(3.10318, SPEND, LEDGER);
    await p.decisionsRead({});
    await p("exit: delivered; usd 3.10318 (review 1.59, answer 1.51)", endStep({ issue: 433, exit: "delivered" }));
  });

/** The comment this stage wrote before the card (#586's lines), key removed: what every reader read, byte for byte. */
const OLD_LOG = [
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
].join("\n");
/** Its marker lines, after the Full log, unchanged. */
const OLD_TAIL = [
  '<!-- pendulum:harness {"harness":"claude","model":"claude-fable-5-2","models":{"worker":"claude-opus-5-5","subagent":"claude-sonnet-5-5","reviewer":"claude-fable-5-2"},"labels":[]} -->',
  `<!-- pendulum:spend ${JSON.stringify({ usd: 3.10318, ...SPEND })} -->`,
  LEDGER,
  "<!-- pendulum:decisions-read {} -->",
  `<!-- pendulum:findings ${JSON.stringify(FINDINGS)} -->`,
].join("\n");
const OLD_435 = `${OLD_LOG}\n${OLD_TAIL}`;
const KEY = "<!-- pendulum:433:progress:review:1794976879130 -->";

/** The hidden lines and stamps of a body: every line that starts a marker, and each line's UTC stamp. */
const hidden = (body) => body.split("\n").filter((l) => l.startsWith("<!--")).concat([...body.matchAll(/<!-- (\d\d:\d\dZ) -->/g)].map((m) => m[1]));


test("the Full log is the header and lines every reader read before the card, byte for byte; the marker lines follow it unchanged", async () => {
  const now = (await review435()).at(-1);
  assert.ok(now.startsWith(`${KEY}\n**✅ Review delivered**`), "the headline first, under the key");
  assert.ok(now.endsWith(`**Full log**\n\n${OLD_LOG}\n\n</details>\n${OLD_TAIL}`), "the Full log in Run details, then the markers");
  assert.deepEqual(hidden(now), hidden(`${KEY}\n${OLD_435}`));
  // Outside the Full log the card writes no `- <clock>` line and never "min at the last line".
  const card = now.slice(0, now.indexOf("**Full log**"));
  assert.doesNotMatch(card, /^- [^\n]*\d{1,2}:\d\d/m);
  assert.doesNotMatch(card, /min at the last line/);
});

test("every reader reads the new comment as the old one: phases, cost-join, spend, ledger, findings, decisions read", async () => {
  const now = (await review435()).at(-1);
  const old = `${KEY}\n${OLD_435}`;
  const comment = (body) => ({ body, user: { login: "me", type: "User" }, created_at: "2026-11-18T04:41:10Z", updated_at: "2026-11-18T05:07:31Z" });
  assert.deepEqual(phaseMinutes([comment(now)], 433), phaseMinutes([comment(old)], 433));
  assert.equal(phaseMinutes([comment(now)], 433).modelMinutes, 18, "read from the Full log, not the table");
  assert.equal(stageLastWrite(comment(now)), stageLastWrite(comment(old)));
  for (const read of [stageHarnessOf, spendParts, spendOf, ledgerOfComment, findingsOf, rebaseCostOf]) assert.deepEqual(read(now), read(old), read.name);
  // cost-join's fallback to the harness line when the marker is gone reads the Full log's line.
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
  assert.ok(fresh.some((c, i) => c.body !== real.comments[i].body && c.body.includes("**Full log**")), "the fixture has progress comments, now in the new form");
  const [a, b] = [data(real.comments), data(fresh)];
  assert.equal(summaryMarker(b), summaryMarker(a));
  assert.equal(renderFinishCard(b), renderFinishCard(a));
  const mine = (c) => c.user?.login === "clockgrove-pendulum[bot]";
  assert.deepEqual(objectiveSpend({ issue: 3, comments: fresh, mine }), objectiveSpend({ issue: 3, comments: real.comments, mine }));
  assert.deepEqual(unlinedStages(fresh, 3, mine), unlinedStages(real.comments, 3, mine));
  assert.deepEqual(modellessStages(fresh, 3, mine), modellessStages(real.comments, 3, mine));
});

/** The headline, action line and table of a card (the part above its charts and Run details). */
const cardOf = (body) => body.split("\n\n<details>")[0];

test("render (spec 4.3): delivered, each step's Took and cents on its row, AI judge calls in their own row, the Total", async () => {
  const body = (await review435()).at(-1);
  assert.equal(
    cardOf(body),
    [
      KEY,
      "**✅ Review delivered** · PR #435 · 26 min · **$3.10 + unknown**",
      "8:41 PM – 9:07 PM PST · API-equivalent, not billed · plus 7 AI runs of unknown cost (AI judge calls)",
      "",
      "| Time | Step | Took | Cost |",
      "| :-- | :-- | --: | --: |",
      "| 8:41 PM | Set up | 20 s | — |",
      "| 8:41 PM | Waited for CI ×2 · passed, last on `e755fde` | 7 min 40 s | — |",
      "| 8:41 PM | Reviewed the change · Fable 5.2 | 5 min 52 s | $1.59 |",
      "| 8:47 PM | Answered 3 review comments (1 from an outside reviewer) · Opus 5.5 | 11 min 14 s | $1.51 |",
      "| 9:07 PM | Checked the answers · 2 of 2 fixes proven by tests, 1 of 1 judged resolved | 25 s | — |",
      "| 8:49 PM | AI judge calls ×7 | — | unknown |",
      "| | **Total** | **26 min** | **$3.10 + unknown** |",
    ].join("\n"),
  );
  // The timeline chart, collapsed, at the end: one section per step, one bar per recorded span.
  assert.match(body, /<details><summary>Timeline chart<\/summary>\n\n```mermaid\n%%\{init: [^\n]*"leftPadding":110[^\n]*\}%%\ngantt\n/);
  assert.match(body, /section CI wait\n    6m 10s :active, 2026-11-17T20:41:10, 2026-11-17T20:47:20\n    1m 30s :active, 2026-11-17T21:05:30, 2026-11-17T21:07:00\n    section Review\n/);
  assert.match(body, /Every bar's figures are in the table above\./);
  const details = body.split("<details><summary>Run details</summary>\n\n")[1].split("\n\n**Full log**")[0];
  assert.equal(
    details,
    [
      "- **Run:** 1794976879130 on GitHub Actions · agent Claude Code",
      "- **Models:** worker Opus 5.5 · sub-agents Sonnet 5.5 · reviewer Fable 5.2 · AI judge perplexity/pplx-decider-v1.2",
      "- **Session:** new (resume policy is fresh)",
      "- **Unknown cost:** 7 AI judge calls went through the AI Gateway, which did not report their cost. They are counted as unknown, never as $0.",
      "- **Cost notes:** API-equivalent is what this usage would cost at API list prices; you are on a subscription, so it is not billed.",
      "- — means no AI ran in that step; AI judge calls are counted in their own row. Steps can overlap, so the Took column does not add up to the total; the full log below is in time order.",
    ].join("\n"),
  );
});

// The states of spec 4.2 and 4.4–4.6, each through the pure renderer over the steps and AI runs a stage records.
const Z = "America/Los_Angeles";
const iso = (t) => new Date(t).toISOString();
const render = (args) => progressCard({ zone: Z, runId: "1794979777859", harness: "claude", ...args });

test("render (spec 4.2): running, the Now row says what the stage does, its model and its agent's activity; no Total, no chart", () => {
  const lines = [
    [at("2026-11-18T05:30:00Z"), "install", { step: "setup", end: at("2026-11-18T05:30:14Z") }],
    [at("2026-11-18T05:30:14Z"), "re-entry: fresh (resume policy is fresh)", { step: "setup", session: "fresh (resume policy is fresh)" }],
    [at("2026-11-18T05:30:20Z"), "harness claude (claude-opus-5-5) attempt 1", { step: "work", model: "claude-opus-5-5", attempt: 1 }],
    [at("2026-11-18T05:31:22Z"), "validation pass 1 (required checks)", { step: "ci", begin: true }],
    [at("2026-11-18T05:31:22Z"), "waiting for required checks (ci) on abc1234", { step: "ci", sha: "abc1234", wait: true, end: at("2026-11-18T05:36:10Z"), outcome: "failed" }],
    [at("2026-11-18T05:36:12Z"), "validation pass 1 red: pnpm test; fix run", { step: "fix", check: "pnpm test" }],
  ];
  const passes = [{ label: "work-1", usd: 0.304073, started: "2026-11-18T05:30:20Z", ended: "2026-11-18T05:31:22Z" }];
  const snap = { model: "claude-opus-5-5", snap: { elapsedMin: 4, turns: 10, toolCalls: 6, idleMin: 0, ended: false, backgroundCommands: 1, lastTool: "Bash: pnpm test", tokens: { input: 392000, output: 89 }, subagentsActive: [] } };
  const c = render({ stage: "work", subject: { label: "PR #436", url: "u" }, issue: 418, started: at("2026-11-18T05:29:40Z"), now: at("2026-11-18T05:40:30Z"), lines, passes, spend: 0.304073, parts: { usdByBilling: { subscription: 0.304073 }, usdUnknown: 2, usdUnknownWhy: ["unreported"], running: true, usdRunning: 2 }, snap, ran: { worker: "claude-opus-5-5", subagent: "claude-sonnet-5-5", reviewer: "claude-fable-5-2", account: "claude" } });
  assert.equal(
    c.card,
    [
      "**⏳ Work running** · PR #436 · 11 min so far · **$0.30** so far",
      "Started 9:29 PM PST · updated 9:40 PM PST · API-equivalent, not billed · 2 AI runs have not reported a cost yet",
      "",
      "| Time | Step | Took | Cost |",
      "| :-- | :-- | --: | --: |",
      "| 9:30 PM | Set up | 14 s | — |",
      "| 9:30 PM | Built the change · Opus 5.5 | 1 min 2 s | $0.30 |",
      "| 9:31 PM | Waited for CI · failed: `pnpm test` | 4 min 48 s | — |",
      "| 9:36 PM | **Now:** fixing CI · Opus 5.5 · 4 min, 10 turns, 6 tool calls, active now | running | when it ends |",
    ].join("\n"),
  );
  assert.equal(c.chart, "");
  assert.match(c.details, /^- \*\*Run:\*\* 1794979777859 on this machine · agent Claude Code · account `claude`\n- \*\*Models:\*\* worker Opus 5\.5 · sub-agents Sonnet 5\.5 · reviewer Fable 5\.2\n- \*\*Session:\*\* new \(resume policy is fresh\)\n- \*\*Right now:\*\* 1 background command running; last tool Bash: pnpm test; 392k tokens in, 89 out\n/);
});

const BLOCKED = () => {
  const t0 = at("2026-11-18T02:27:00Z");
  const lines = [
    [t0, "install", { step: "setup", end: t0 + 15000 }],
    [t0 + 15000, "pass 1", { step: "ci", begin: true }],
    [t0 + 15000, "wait", { step: "ci", sha: "86f7710", wait: true, end: t0 + 45000, outcome: "passed" }],
    [t0 + 60000, "answer pass: 2 comment(s)", { step: "answer", comments: 2 }],
    [t0 + 170000, "pass 2", { step: "ci", begin: true }],
    [t0 + 170000, "wait", { step: "ci", sha: "86f7710", wait: true, end: t0 + 200000, outcome: "passed" }],
    [t0 + 210000, "finding check", { step: "check", judged: { resolved: 0, of: 2 }, open: ["src/loop.ts:134", "src/routes.ts:992"], start: t0 + 200000, end: t0 + 220000, model: "perplexity/pplx-decider-v1.2", verdicts: [{ place: "src/loop.ts:134", verdict: "not_resolved", confidence: 0.71 }, { place: "src/routes.ts:992", verdict: "not_resolved", confidence: 0.75 }] }],
    [t0 + 240000, "exit: blocked", endStep({ issue: 416, exit: "blocked", reason: "2 review findings are still open after 2 rounds of answers: `src/loop.ts:134`, `src/routes.ts:992`. Fix them on the branch.", applied: { exit: "blocked", cause: "work", pr: { number: 428, draft: true } } })],
  ];
  const passes = [
    { label: "answer", model: "claude-opus-5-5", usd: 0.52, started: iso(t0 + 61000), ended: iso(t0 + 170000) },
    { label: "decision", decision: true, calls: 2, usd: null, usdUnknown: 2, usdUnknownWhy: ["decision"], started: iso(t0 + 205000), ended: iso(t0 + 215000) },
  ];
  return render({ stage: "review", subject: { label: "PR #428", url: "u" }, issue: 416, started: t0, now: t0 + 240000, lines, passes, exit: "blocked", spend: 0.52, parts: { usdByBilling: { subscription: 0.52 }, usdUnknown: 2, usdUnknownWhy: ["decision"] } });
};

test("render (spec 4.4): Blocked, the action line and the reason's first sentence above the table; the AI judge's verdicts in Run details", () => {
  const c = BLOCKED();
  assert.equal(
    c.card,
    [
      "**⛔ Review Blocked** · PR #428 · 4 min · **$0.52 + unknown**",
      "6:27 PM – 6:31 PM PST · API-equivalent, not billed · plus 2 AI runs of unknown cost (AI judge calls)",
      "",
      "> **What to do:** fix the cause below, then re-apply the `pendulum:objective` label. The Blocked notice on this issue has the full steps.",
      ">",
      "> **Why:** 2 review findings are still open after 2 rounds of answers: `src/loop.ts:134`, `src/routes.ts:992`.",
      "",
      "| Time | Step | Took | Cost |",
      "| :-- | :-- | --: | --: |",
      "| 6:27 PM | Set up | 15 s | — |",
      "| 6:27 PM | Waited for CI ×2 · passed, last on `86f7710` | 1 min | — |",
      "| 6:28 PM | Answered 2 review comments · Opus 5.5 | 1 min 49 s | $0.52 |",
      "| 6:30 PM | Checked the answers · 0 of 2 judged resolved; still open: `src/loop.ts:134`, `src/routes.ts:992` | 20 s | — |",
      "| 6:30 PM | AI judge calls ×2 | — | unknown |",
      "| | **Total** | **4 min** | **$0.52 + unknown** |",
    ].join("\n"),
  );
  assert.match(c.details, /^- \*\*AI judge verdicts:\*\* `src\/loop\.ts:134` not resolved \(0\.71\); `src\/routes\.ts:992` not resolved \(0\.75\)$/m);
  assert.match(c.details, /^- \*\*Unknown cost:\*\* 2 AI judge calls went through the AI Gateway, which did not report their cost\. They are counted as unknown, never as \$0\.$/m);
});

const SHORT_STAGE = (exit, step, extra = {}) => {
  const t0 = at("2026-11-17T22:10:00Z");
  const lines = [
    [t0, "install", { step: "setup", end: t0 + 18000 }],
    [t0 + 20000, "harness claude (claude-opus-5-5) attempt 1", { step: "work", model: "claude-opus-5-5", attempt: 1 }],
    [t0 + 540000, `exit: ${exit}`, step],
  ];
  return render({ stage: "work", issue: 512, started: t0, now: t0 + 540000, lines, passes: [{ label: "work-1", usd: 0.84, started: iso(t0 + 20000), ended: iso(t0 + 530000) }], exit, spend: 0.84, parts: { usdByBilling: { subscription: 0.84 } }, ...extra });
};

test("render (spec 4.5): a Question says how to answer it, as its form decides, and quotes the question", () => {
  const q = SHORT_STAGE("question", endStep({ issue: 512, exit: "question", reason: "question: Should the export keep the legacy column order, or follow the new schema?", applied: { exit: "question", pr: null, askOnIssue: true } }));
  assert.equal(
    q.card,
    [
      "**❓ Work has a Question** · issue #512 · 9 min · **$0.84**",
      "2:10 PM – 2:19 PM PST · API-equivalent, not billed",
      "",
      "> **What to do:** answer the question in a comment on this issue. Pendulum goes on from where it stopped.",
      ">",
      "> **Question:** Should the export keep the legacy column order, or follow the new schema?",
      "",
      "| Time | Step | Took | Cost |",
      "| :-- | :-- | --: | --: |",
      "| 2:10 PM | Set up | 18 s | — |",
      "| 2:10 PM | Built the change · Opus 5.5 | 8 min 30 s | $0.84 |",
      "| | **Total** | **9 min** | **$0.84** |",
    ].join("\n"),
  );
  // Asked on a draft PR: answered on the issue or the PR, then the PR marked ready (logic.mjs questionForm).
  const pr = SHORT_STAGE("question", endStep({ issue: 512, exit: "question", reason: "which API?", applied: appliedExit({ exit: "question", pr: { number: 515 } }, { exit: "question" }) }));
  assert.match(pr.card, /^> \*\*What to do:\*\* answer in a comment on this issue or PR #515, then mark PR #515 ready\. Pendulum goes on from where it stopped\.$/m);
  // A Question GitHub would not draft is applied as a Block: the card says Blocked.
  assert.equal(appliedExit({ exit: "question", pr: { number: 515 } }, { exit: "blocked" }).exit, "blocked");
});

test("render (spec 4.5): paused, waiting and stopped", () => {
  const paused = SHORT_STAGE("paused", endStep({ issue: 512, exit: "paused", reason: "claude reached its usage limit", resetAt: "2026-11-18T03:00:00Z" }));
  assert.match(paused.card, /^\*\*⏸️ Work paused\*\* · issue #512 · 9 min · \*\*\$0\.84\*\*\n2:10 PM – 2:19 PM PST · API-equivalent, not billed\n\n> \*\*What to do:\*\* nothing; Pendulum goes on when the usage limit resets at 7:00 PM PST\.\n\n\| Time/);
  const stopped = SHORT_STAGE("stopped", endStep({ issue: 512, exit: "stopped", reason: "the pendulum:objective label came off" }));
  assert.match(stopped.card, /^\*\*⏹️ Work stopped\*\* · issue #512 · 9 min · \*\*\$0\.84\*\*\n2:10 PM – 2:19 PM PST · API-equivalent, not billed\nthe pendulum:objective label came off\n\n\| Time/);
  // A send-back's rebase stage: the rebase line under the headline; its harness run is Rebased, the stage a Rebase.
  const rebase = render({ stage: "work", issue: 512, started: at("2026-11-17T22:10:00Z"), now: at("2026-11-17T22:14:00Z"), lines: [[at("2026-11-17T22:10:30Z"), "harness", { step: "work", model: "claude-opus-5-5", attempt: 1, rebase: true }], [at("2026-11-17T22:14:00Z"), "exit: delivered", endStep({ issue: 512, exit: "delivered", rebase: "rebase 2 of this Objective (conflict): $0.61; all its rebases: $1.20" })]], exit: "delivered", spend: 0.61, parts: { usdByBilling: { api: 0.61 } } });
  assert.match(rebase.card, /^\*\*✅ Rebase delivered\*\* · issue #512 · 4 min · \*\*\$0\.61\*\*\n2:10 PM – 2:14 PM PST · billed to your API key\nRebase 2 of this Objective \(conflict\): \$0\.61; all its rebases: \$1\.20\n/);
  assert.match(rebase.card, /^\| 2:10 PM \| Rebased · Opus 5\.5 \| — \| — \|$/m);
  const t0 = at("2026-11-17T22:10:00Z");
  const waiting = render({ stage: "review", subject: { label: "PR #435", url: "u" }, issue: 433, started: t0, now: t0 + 120000, lines: [[t0, "install", { step: "setup", end: t0 + 10000 }], [t0 + 60000, "third-party review: waiting", { step: "thirdParty", waiting: ["coderabbitai[bot]"], until: t0 + 1260000 }], [t0 + 120000, "exit: waiting", endStep({ issue: 433, exit: "waiting", reason: "an outside review" })]], exit: "waiting", spend: 0, parts: {} });
  assert.match(waiting.card, /^\*\*⏸️ Review waiting\*\* · PR #435 · 2 min · \*\*\$0\.00\*\*\n2:10 PM – 2:12 PM PST\n\n> \*\*What to do:\*\* nothing; waiting for coderabbitai\[bot\] until 2:31 PM PST\.\n/);
  assert.match(waiting.card, /^\| 2:11 PM \| Outside reviewer · waiting for coderabbitai\[bot\] until 2:31 PM \| — \| — \|$/m);
});

test("render (spec 4.6): a long run across midnight folds each kind of step into one row, ×N, with dates; each fix round's cost in Run details", () => {
  const t0 = at("2026-11-18T06:05:00Z");
  const lines = [[t0, "first-time setup: cloned in 41 s", { step: "setup", first: true, start: t0 - 41000, end: t0 }], [t0 + 60000, "harness", { step: "work", model: "claude-opus-5-5", attempt: 1 }]];
  const passes = [{ label: "work-1", usd: 6.1, model: "claude-opus-5-5", started: iso(t0 + 60000), ended: iso(t0 + 60000 + 38 * 60000) }];
  let t = t0 + 39 * 60000;
  for (let i = 1; i <= 13; i++) {
    lines.push([t, "pass", { step: "ci", begin: true }], [t, "wait", { step: "ci", sha: i === 13 ? "4be19c2" : `aaaaaa${i % 10}`, wait: true, end: t + 8 * 60000, outcome: i === 13 ? "passed" : "failed" }]);
    t += 8 * 60000;
    if (i <= 3) lines.push([t, "triage", { step: "triage", outcome: i === 2 ? "flake-rerun" : "fix", start: t, end: t + 40000 }]);
    if (i <= 12) {
      lines.push([t + 60000, "red; fix run", { step: "fix", check: "test (ubuntu-26.04, 4/4)" }]);
      passes.push({ label: `validation-fix-${i}`, model: "claude-opus-5-5", usd: i === 9 ? null : 0.68, usdUnknown: i === 9 ? 1 : 0, usdUnknownWhy: i === 9 ? ["unreported"] : [], started: iso(t + 61000), ended: iso(t + 61000 + 345000) });
      t += 7 * 60000;
    }
  }
  passes.push({ label: "decision", decision: true, calls: 5, usd: 0.003, started: iso(t), ended: iso(t + 1000) });
  lines.push([t + 2000, "exit: delivered", endStep({ issue: 77, exit: "delivered" })]);
  const c = render({ stage: "work", subject: { label: "PR #81", url: "u" }, issue: 77, started: t0, now: t + 2000, lines, passes, exit: "delivered", spend: 13.583, parts: { usdByBilling: { subscription: 13.583 }, usdUnknown: 1, usdUnknownWhy: ["unreported"] } });
  assert.equal(
    c.card,
    [
      "**✅ Work delivered** · PR #81 · 3 h 47 min · **$13.58 + unknown**",
      "Nov 17, 10:05 PM – Nov 18, 1:52 AM PST · API-equivalent, not billed · plus 1 AI run of unknown cost (ended before it reported)",
      "",
      "| Time | Step | Took | Cost |",
      "| :-- | :-- | --: | --: |",
      "| Nov 17, 10:05 PM | Set up · first clone on this machine | 41 s | — |",
      "| Nov 17, 10:06 PM | Built the change · Opus 5.5 | 38 min | $6.10 |",
      "| Nov 17, 10:44 PM | Waited for CI ×13 · passed, last on `4be19c2` | 1 h 44 min | — |",
      "| Nov 17, 10:52 PM | Flake check ×3 · 2 the change's, 1 flake rerun | 2 min | — |",
      "| Nov 17, 10:53 PM | Fixed CI ×12 · last failure: `test (ubuntu-26.04, 4/4)` | 1 h 9 min | $7.48 + unknown |",
      "| Nov 18, 1:52 AM | AI judge calls ×5 | — | <$0.01 |",
      "| | **Total** | **3 h 47 min** | **$13.58 + unknown** |",
    ].join("\n"),
  );
  assert.match(c.details, /^- \*\*Fixed CI, each round:\*\* 1: \$0\.68 · 2: \$0\.68 · .* · 9: unknown · .* · 12: \$0\.68$/m);
  assert.match(c.chart, /axisFormat %b %d %H:%M/);
});

test("the vendor comment: a two-line headline, the raw line in Run details, its spend line last and unchanged", () => {
  const cost = { usd: 0.0042, vcpus: 4, memoryMb: 8192, activeCpuMs: 41200, wallMs: 1380000 };
  const line = vendorLine({ id: "pendulum-x", state: "stopped", cost, rates: { date: "2026-11-10" }, at: "2026-11-18T04:41:00Z" });
  const old = vendorBody({ line, vendorUsd: 0.0042 });
  const now = vendorBody({ line, vendorUsd: 0.0042, card: vendorCard({ stage: "work", cost, rates: { date: "2026-11-10" } }) });
  assert.ok(now.startsWith("**Cloud sandbox** · Work · **<$0.01**\n41.2 s of CPU in 23 min · 4 vCPU / 8 GB · vendor list rates, read 2026-11-10\n\n<details><summary>Run details</summary>\n\n"));
  assert.equal(now.split("\n").at(-1), old.split("\n").at(-1), "the spend line, last");
  assert.ok(now.includes(`\n${line}\n`));
  assert.deepEqual(spendParts(now), spendParts(old));
  assert.match(vendorCard({ stage: "review", cost: { usd: null } }), /^\*\*Cloud sandbox\*\* · Review · \*\*unknown\*\*\nThe sandbox vendor did not report this stage's usage\.$/);
});

test("near GitHub's limit: the chart goes first, then shorter Step cells, then the explanations, then the ledger's cut form; the Full log's middle only as a last resort", async () => {
  const many = (n, size) =>
    reporter("work", async (p) => {
      for (let i = 0; i < n; i++) await p(`${"y".repeat(size)} ${i}`, { step: "note" });
      p.spend(1, { usdByBilling: { api: 1 } }, LEDGER);
      await p("exit: delivered", endStep({ issue: 433, exit: "delivered" }));
    });
  // A log that leaves room: the ledger line whole.
  const fits = (await many(25, 1990)).at(-1);
  assert.ok(fits.length <= PROGRESS_LEDGER_ROOM + 100 && fits.includes(LEDGER));
  // Past the room: the ledger's cut form, every line of the log still there.
  const cut = (await many(31, 1990)).at(-1);
  assert.ok(cut.length < GITHUB_COMMENT_MAX, `${cut.length}`);
  assert.ok(!cut.includes(LEDGER) && /^<!-- pendulum:ledger \{"cut":3\} -->$/m.test(cut));
  assert.match(cut, /- [^\n]*<!-- \d\d:\d\dZ --> y+ 30$/m);
  // Past GitHub's limit even so: the first 20 and last 40 lines, one line saying how many were left out.
  const huge = (await many(80, 1990)).at(-1);
  assert.ok(huge.length < GITHUB_COMMENT_MAX, `${huge.length}`);
  assert.match(huge, /^- … \d+ lines left out to keep this comment under GitHub's size limit; the job log has them$/m);
  assert.match(huge, /y+ 0\n/, "the first lines kept");
  assert.match(huge, /exit: delivered\n\n<\/details>/, "the last lines kept");
  assert.equal(tableCell("a | b\nc <img src=x>"), "a \\| b c &lt;img src=x&gt;");
});

test("every line a stage writes names its step: no progress call is left a bare note", () => {
  const files = ["worker.mjs", "review.mjs", "lib/session.mjs", "lib/finding-check.mjs", "lib/third-party-review.mjs", "lib/triage.mjs", "lib/drift.mjs", "lib/objective-trust.mjs"];
  const bare = [];
  for (const f of files) {
    const src = readFileSync(join(import.meta.dirname, "..", "scripts", f), "utf8");
    src.split("\n").forEach((l, i) => {
      if (/^\s*(\/\/|\*)/.test(l)) return;
      if (/await (?:progress|onPhase|args\.onPhase)\??\.?\(/.test(l) && !/\bstep\b|Step\b|endStep/.test(l)) bare.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(bare, []);
});

test("steps decide on their fields alone: a step the card does not know is a note, its line its words", () => {
  const e = stepOf({ step: "nonsense" }, 1, "a line");
  assert.equal(e.kind, "note");
  assert.equal(e.line, "a line");
  const d = progressData({ stage: "work", issue: 1, started: 0, now: 60_000, lines: [[0, "x", { step: "ci", sha: "abcdef1", wait: true }]], live: true, zone: "UTC" });
  assert.equal(d.current.kind, "ci", "running: the last step is the Now row's");
});

test("newForm (the readers' fixture) is the reporter's form: key, card, Run details with the old header and lines, the old markers", () => {
  const fresh = newForm(`${KEY}\n${OLD_435}`, "2026-11-18T04:41:00Z");
  assert.ok(fresh.startsWith(`${KEY}\n**✅ Review delivered**`));
  assert.ok(fresh.endsWith(`**Full log**\n\n${OLD_LOG}\n\n</details>\n${OLD_TAIL}`));
});
