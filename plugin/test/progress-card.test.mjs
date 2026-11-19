// The progress comment's card (#589): the stage's real reporter on a fake GitHub writes the card over its log, the log
// and every hidden line byte-identical to the comment a stage wrote before the card, and every reader reads the new
// comment as the old one: the scorecard's phases, cost-join, the report's stage reads and the finish card.
import "./temp.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GITHUB_COMMENT_MAX, endStep, progressReporter } from "../scripts/lib/session.mjs";
import { repoOf } from "../scripts/lib/github.mjs";
import { decisionsReadOf, findingsOf, ledgerOfComment, rebaseCostOf, setSelf, spendOf, spendParts } from "../scripts/lib/logic.mjs";
import { stageHarnessOf } from "../scripts/lib/cost-join.mjs";
import { finishData, modellessStages, objectiveSpend, renderFinishCard, summaryMarker, unlinedStages } from "../scripts/lib/finish-card.mjs";
import { progressCard } from "../scripts/lib/progress-card.mjs";
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
 * written, in the order they landed. `delayMs`: how long the fake GitHub takes to answer a write (a number, or a function
 * asked for each write); `posted`: given the list of bodies as it fills; `stats`: filled with the writes in flight now
 * (`now`) and at most at once (`max`); `opts`: the reporter's own options (its spend so far, its passes).
 */
async function reporter(stage, drive, { start = "2026-11-18T04:41:10Z", runId = "1794976879130", env = {}, delayMs = 0, posted: seen = null, stats = {}, opts = {} } = {}) {
  const real = globalThis.fetch;
  const realNow = Date.now;
  const posted = [];
  seen?.(posted);
  globalThis.fetch = async (url, init = {}) => {
    const json = (v) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
    if ((init.method || "GET") === "GET") return json([]);
    stats.now = (stats.now ?? 0) + 1;
    stats.max = Math.max(stats.max ?? 0, stats.now);
    const ms = typeof delayMs === "function" ? delayMs() : delayMs;
    if (ms) await new Promise((r) => setTimeout(r, ms));
    posted.push(JSON.parse(init.body).body);
    stats.now -= 1;
    return json({ id: 9, user: { login: "me", type: "User" }, body: posted.at(-1) });
  };
  let t = at(start);
  Date.now = () => t;
  const clock = (iso) => {
    t = at(iso);
  };
  try {
    await withEnv(ZONE, async () => {
      // The stage's own environment, given: an Actions stage of no workflow run, whatever runner runs this test.
      const p = progressReporter(repoOf("acme/app"), 433, { token: () => "t" }, { stage, runId, harness: "claude", model: stage === "review" ? "claude-fable-5-2" : "claude-opus-5-5", soFar: null, env: { ...ZONE, ...env }, ...opts });
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
      "| 8:49 PM | AI judge calls ×7 | — | unknown |",
      "| 9:07 PM | Checked the answers · 2 of 2 fixes proven by tests, 1 of 1 judged resolved | 25 s | — |",
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
      "- In Took, — means no recorded start and end; in Cost, — means no AI ran in that step or it cost nothing, and AI judge calls are counted in their own row. Steps can overlap, so the Took column does not add up to the total; the full log below is in time order.",
    ].join("\n"),
  );
});

// The states of spec 4.2 and 4.4–4.6, each through the pure renderer over the steps and AI runs a stage records.
const Z = "America/Los_Angeles";
const iso = (t) => new Date(t).toISOString();
const render = (args) => progressCard({ zone: Z, runId: "1794979777859", harness: "claude", ...args });

test("#642: the queue row reports uncertainty while fixing and when blocked", () => {
  const started = at("2026-11-18T04:41:10Z");
  const queueRow = (state, unsure) =>
    render({
      stage: "review",
      issue: 432,
      started,
      now: started + 1000,
      lines: [[started, "merge queue run red", { step: "queue", state, unsure }]],
      exit: state === "blocked" ? "blocked" : "delivered",
    }).card.split("\n").find((line) => line.includes("Merge queue failure"));

  const fixing = queueRow("fixing", true);
  const blocked = queueRow("blocked", true);
  assert.match(fixing, /Pendulum could not tell whose failure it was; one fix/);
  assert.match(blocked, /Pendulum could not tell whose failure it was; Blocked/);
  assert.doesNotMatch(fixing + blocked, /the PR's own change/);
  assert.match(queueRow("fixing"), /the PR's own change; one fix/);
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

test("newForm (the readers' fixture) is the reporter's form: key, card, Run details with the old header and lines, the old markers", () => {
  const fresh = newForm(`${KEY}\n${OLD_435}`, "2026-11-18T04:41:00Z");
  assert.ok(fresh.startsWith(`${KEY}\n**✅ Review delivered**`));
  assert.ok(fresh.endsWith(`**Full log**\n\n${OLD_LOG}\n\n</details>\n${OLD_TAIL}`));
});

test("harness and person text is sanitised and on one line: no live mention, no bot command, no clock line before the Full log", async () => {
  const reason = "Should it use @octocat's API?\n/approve\n- 05:30Z harness claude (x) attempt 1";
  const body = (
    await reporter("work", async (p) => {
      p.live("x", { force: true, snap: { elapsedMin: 1, turns: 1, toolCalls: 1, idleMin: 0, ended: false, lastTool: "Bash: pnpm add @types/node", tokens: { input: 1, output: 1 }, subagentsActive: [] }, model: "claude-opus-5-5" });
      await p("harness claude (claude-opus-5-5) attempt 1", { step: "work", model: "claude-opus-5-5", attempt: 1 });
      await new Promise((r) => setTimeout(r, 20));
    })
  ).at(-1);
  assert.match(body, /last tool Bash: pnpm add @\u200btypes\/node/);
  const q = SHORT_STAGE("question", endStep({ issue: 512, exit: "question", reason, applied: { exit: "question", pr: null, askOnIssue: true } }));
  const b = SHORT_STAGE("blocked", endStep({ issue: 512, exit: "blocked", reason, applied: { exit: "blocked", cause: "work" } }));
  for (const c of [q, b]) {
    const card = `${c.card}\n${c.details}`;
    assert.doesNotMatch(card, /@octocat/, "no live mention");
    assert.match(card, /@\u200boctocat/);
    assert.doesNotMatch(card, /^\s*\/approve/m, "no line a bot reads as a command");
    assert.doesNotMatch(card, /^- [^\n]*\d\d:\d\dZ/m, "no line the scorecard reads as a progress line");
  }
  assert.match(q.card, /^> \*\*Question:\*\* Should it use @\u200boctocat's API\? \u200b\/approve - 05:30Z harness claude \(x\) attempt 1$/m);
  // Phases read the same with the card as without it.
  const comment = (x) => ({ body: x, created_at: "2026-11-18T04:41:10Z", updated_at: "2026-11-18T05:07:31Z" });
  assert.deepEqual(phaseMinutes([comment(`${KEY}\n${q.card}`)], 433).runs, 1);
  assert.equal(phaseMinutes([comment(`${KEY}\n${q.card}`)], 433).modelMinutes, 0);
});

test("#617: one CI wait is one row: the Now row while it runs, its finished row after, never both", () => {
  // pendulum-scratch #38's rebase stage: the round's first line, then its wait.
  const t0 = at("2026-11-18T19:31:36Z");
  const wait = { step: "ci", sha: "21ae7e1", wait: true };
  const lines = [
    [t0 + 4_000, "re-entry: fresh (resume policy is fresh)", { step: "setup", session: "fresh (resume policy is fresh)" }],
    [t0 + 5_000, "harness copilot attempt 1", { step: "work", model: "claude-sonnet-5.5", attempt: 1, rebase: true }],
    [t0 + 44_000, "validation pass 1 (required checks)", { step: "ci", begin: true }],
    [t0 + 44_000, "waiting for required checks (test) on 21ae7e1", wait],
  ];
  const passes = [{ label: "work-1", model: "claude-sonnet-5.5", usd: 0.085139, started: iso(t0 + 5_000), ended: iso(t0 + 21_000) }];
  const ci = (c) => c.card.split("\n").filter((l) => /\bCI\b/.test(l));
  const args = { stage: "work", issue: 38, started: t0, lines, passes, spend: 0.085139, parts: { usdByBilling: { credits: 0.085139 }, running: true } };
  assert.deepEqual(ci(render({ ...args, now: t0 + 104_000 })), ["| 11:32 AM | **Now:** waiting for CI on `21ae7e1` · 1 min | running | — |"]);
  // The wait over (its step's end and outcome set, as the stage sets them), the stage still running: its finished row alone.
  Object.assign(wait, { end: t0 + 106_000, outcome: "passed" });
  assert.deepEqual(ci(render({ ...args, now: t0 + 107_000 })), ["| 11:32 AM | Waited for CI · passed on `21ae7e1` | 1 min 2 s | — |"]);

  // A second round is a second wait: the first one's finished row, and the Now row for the one in progress, whose own
  // first line is not counted into the finished row.
  const again = { step: "ci", sha: "0c0ffee", wait: true };
  Object.assign(wait, { outcome: "failed" });
  const two = [...lines, [t0 + 108_000, "validation pass 1 red: test; fix run", { step: "fix", check: "test" }], [t0 + 200_000, "validation pass 2 (required checks)", { step: "ci", begin: true }], [t0 + 260_000, "waiting for required checks (test) on 0c0ffee", again]];
  const fixed = [...passes, { label: "validation-fix-1", model: "claude-sonnet-5.5", usd: 0.05, started: iso(t0 + 109_000), ended: iso(t0 + 199_000) }];
  const second = render({ ...args, lines: two, passes: fixed, now: t0 + 300_000 });
  assert.deepEqual(ci(second), ["| 11:32 AM | Waited for CI · failed: `test` | 1 min 2 s | — |", "| 11:33 AM | Fixed CI · last failure: `test` | 1 min 30 s | $0.05 |", "| 11:34 AM | **Now:** waiting for CI on `0c0ffee` · 40 s | running | — |"]);
  // Both over: one row for the kind, its two waits counted.
  Object.assign(again, { end: t0 + 290_000, outcome: "passed" });
  assert.match(render({ ...args, lines: two, passes: fixed, now: t0 + 300_000 }).card, /^\| 11:32 AM \| Waited for CI ×2 · passed, last on `0c0ffee` \| 1 min 32 s \| — \|$/m);
  // A cross-OS round's first line is its own wait's too.
  const cross = [[t0, "cross-os-validation pass 1 (cross-OS legs)", { step: "ci", begin: true, crossOs: true }], [t0 + 1_000, "waiting for cross-OS legs", { step: "ci", sha: "21ae7e1", wait: true, crossOs: true }]];
  assert.deepEqual(ci(render({ stage: "work", issue: 38, started: t0, now: t0 + 61_000, lines: cross })), ["| 11:31 AM | **Now:** waiting for cross-OS CI on `21ae7e1` · 1 min | running | — |"]);
});

test("#617: a send-back's rebase stage names itself from its first write; a line a stage notes before it knows goes out with that write", async () => {
  const head = (body) => body.split("\n")[1];
  const posted = await reporter("work", async (p, clock) => {
    // What the stage says before it has read its PR: no write of its own.
    p.note("`pendulum:account:beta` does nothing on this route", { step: "setup", account: "`pendulum:account:beta` does nothing on this route" });
    clock("2026-11-18T04:41:20Z");
    // worker.mjs, once its own rebase says the branch is behind: before the stage's first progress write.
    p.rebaseStage();
    await p("re-entry: fresh (resume policy is fresh)", { step: "setup", session: "fresh (resume policy is fresh)" });
    clock("2026-11-18T04:41:30Z");
    await p("harness claude (claude-opus-5-5) attempt 1", { step: "work", model: "claude-opus-5-5", attempt: 1, rebase: true });
  });
  assert.equal(posted.length, 2, "the note made no write");
  assert.deepEqual(posted.map((b) => /^\*\*⏳ (\w+) running\*\*/.exec(head(b))?.[1]), ["Rebase", "Rebase"]);
  // The first write carries the noted line, in the Full log and in Run details, in the order written.
  assert.match(posted[0], /\n- 8:41 PM PST<!-- 04:41Z --> `pendulum:account:beta` does nothing on this route\n- 8:41 PM PST<!-- 04:41Z --> re-entry: fresh \(resume policy is fresh\)\n/);
  assert.match(posted[0], /^- \*\*Account:\*\* /m);
  // A work stage that is no rebase is Work, as before.
  const work = await reporter("work", async (p) => p("re-entry: fresh (resume policy is fresh)", { step: "setup", session: "fresh (resume policy is fresh)" }));
  assert.match(head(work[0]), /^\*\*⏳ Work running\*\*/);

  // worker.mjs says so where it learns it is a send-back's rebase, before any progress write of the stage, and notes the
  // account line it writes before it can know.
  const src = readFileSync(join(import.meta.dirname, "..", "scripts", "worker.mjs"), "utf8");
  const [before, after] = src.split("\n      rebaseStage = { conflict: rebaseConflict };\n");
  assert.match(after, /^ {6}\/\/[^\n]*\n {6}progress\.rebaseStage\(\);\n/);
  assert.doesNotMatch(before.slice(before.indexOf("\n  async function run() {\n")), /await progress\(/, "no progress write before the stage knows");
  assert.ok(before.includes("\n  async function run() {\n"));
  assert.match(before, /\n {2}if \(acct\.note\) progress\.note\(acct\.note, \{ step: "setup", account: acct\.note \}\);\n/);
  assert.match(before, /\n {2}const planned = await planGate\(\{[^\n]*, check: editCheck, progress: progress\.note \}\);\n/);
});

test("every write goes through one queue: the exit write lands last, after the forced writes queued before it, however slow the write ahead of them", async () => {
  const snap = { elapsedMin: 1, turns: 1, toolCalls: 1, idleMin: 0, ended: false, tokens: { input: 1, output: 1 }, subagentsActive: [] };
  const stats = {};
  // The first write is the slow one: every later write is queued behind it, and none may pass it or another.
  let first = true;
  const posted = await reporter(
    "work",
    async (p) => {
      const line = p("harness claude (claude-opus-5-5) attempt 1", { step: "work", model: "claude-opus-5-5", attempt: 1 });
      p.live("claude working", { force: true, snap, model: "claude-opus-5-5" });
      p.live("claude working", { force: true, snap: { ...snap, turns: 2 }, model: "claude-opus-5-5" });
      p.spend(1.25, null);
      await p("exit: delivered", endStep({ issue: 433, exit: "delivered" }));
      await line;
      for (const until = performance.now() + 5_000; stats.now && performance.now() < until; ) await new Promise((r) => setImmediate(r));
    },
    {
      stats,
      delayMs: () => {
        const ms = first ? 20 : 0;
        first = false;
        return ms;
      },
    },
  );
  assert.equal(stats.max, 1, "one write at a time");
  assert.match(posted.at(-1), /- [^\n]* exit: delivered\n/, "the exit write is the last to land");
  assert.deepEqual(spendOf(posted.at(-1)), { usd: 1.25, unknown: 0 });
});

test("near GitHub's limit: a log of 80 lines of 2,000 characters stays under the comment limit, its first and last lines, exit line and spend line kept", async () => {
  const huge = (
    await reporter("work", async (p) => {
      for (let i = 0; i < 80; i++) await p(`${"y".repeat(1990)} ${i}`, { step: "note" });
      p.spend(1, { usdByBilling: { api: 1 } }, LEDGER);
      await p("exit: delivered", endStep({ issue: 433, exit: "delivered" }));
    })
  ).at(-1);
  assert.ok(huge.length < GITHUB_COMMENT_MAX, `${huge.length}`);
  assert.match(huge, /y+ 0\n/, "the first lines kept");
  assert.match(huge, /exit: delivered\n\n<\/details>/, "the last lines kept");
  assert.deepEqual(spendOf(huge), { usd: 1, unknown: 0, byBilling: { api: 1 } });
});
