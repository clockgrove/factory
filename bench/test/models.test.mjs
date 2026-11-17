// The scorecard row names the harness and models that ran and the labels that chose them (#224), so rows compare model
// to model. Invented data, no network.
import "../../plugin/test/temp.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadPrices } from "../lib/cost.mjs";
import { accountUse, harnessCell, markdownTable, objectiveModels, scoreObjective, stageHarnessOf } from "../lib/objective.mjs";
import { harnessMarker, stageSpendLine } from "../../plugin/scripts/lib/logic.mjs";
import { localMerge } from "./fixtures/github.mjs";

const prices = loadPrices();
const score = (c) => scoreObjective(c, { prices, now: "2031-03-05T00:00:00Z" });
const ran = (worker, subagent, reviewer, labels = []) => ({ harness: "claude", worker, subagent, reviewer, labels });

test("a stage's harness line carries the Objective's three models and its labels; an older line reads without them", () => {
  const line = harnessMarker("claude", "claude-sonnet-5-5", ran("claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5", ["pendulum:model:claude-sonnet-5-5"]));
  assert.deepEqual(stageHarnessOf(line), { harness: "claude", model: "claude-sonnet-5-5", ran: { worker: "claude-sonnet-5-5", subagent: "claude-haiku-5-5", reviewer: "claude-opus-5-5", labels: ["pendulum:model:claude-sonnet-5-5"] } });
  assert.deepEqual(stageHarnessOf(harnessMarker("codex", "gpt-6.1-sol")), { harness: "codex", model: "gpt-6.1-sol" });
});

test("objectiveModels: the worker's model as the harness reported it, the last work stage's sub-agent model, the last review's reviewer", () => {
  const usage = [
    { artifact: "pendulum-usage-7", ran: { worker: "claude-opus-5-5", subagent: "claude-sonnet-5-5", reviewer: "claude-fable-5-2", labels: [] } },
    { artifact: "pendulum-usage-7", ran: { worker: "claude-sonnet-5-5", subagent: "claude-haiku-5-5", reviewer: "claude-fable-5-2", labels: ["pendulum:model:claude-sonnet-5-5"] } },
    { artifact: "pendulum-usage-7-review", ran: { worker: "claude-sonnet-5-5", subagent: "claude-haiku-5-5", reviewer: "claude-opus-5-5", labels: ["pendulum:reviewer-model:claude-opus-5-5"] } },
  ];
  const m = objectiveModels(usage, { model: "claude-sonnet-5-5-20261101" });
  assert.deepEqual(m, { worker: "claude-sonnet-5-5-20261101", subagent: "claude-haiku-5-5", reviewer: "claude-opus-5-5", labels: ["pendulum:model:claude-sonnet-5-5", "pendulum:reviewer-model:claude-opus-5-5"] });
  assert.equal(harnessCell({ harness: "claude", models: m }), "claude claude-sonnet-5-5-20261101; sub-agents claude-haiku-5-5; reviewer claude-opus-5-5 (by label: pendulum:model:claude-sonnet-5-5, pendulum:reviewer-model:claude-opus-5-5)");
  assert.deepEqual(objectiveModels([{ artifact: "pendulum-usage-7" }], { model: "gpt-6.1-sol" }), { worker: "gpt-6.1-sol", subagent: null, reviewer: null, labels: [] }, "a record from before `ran`");
  assert.equal(harnessCell({ harness: "codex", model: "gpt-6.1-sol", models: { worker: null, subagent: null, reviewer: null, labels: [] } }), "codex gpt-6.1-sol");
});

test("a local Objective's row reads what ran from its stages' harness lines", () => {
  const c = localMerge(61);
  const line = (r) => `\n${harnessMarker("codex", r.worker, r)}`;
  c.issueComments[0].body += line({ harness: "codex", worker: "gpt-6.1-terra", subagent: "gpt-6-luna", reviewer: "gpt-6.1-sol", labels: ["pendulum:harness:codex", "pendulum:model:gpt-6.1-terra"] });
  c.issueComments[2].body += line({ harness: "codex", worker: "gpt-6.1-terra", subagent: "gpt-6-luna", reviewer: "gpt-6.1-sol", labels: ["pendulum:harness:codex", "pendulum:model:gpt-6.1-terra"] });
  const row = score(c);
  assert.equal(row.harness, "codex");
  assert.deepEqual(row.models, { worker: "gpt-6.1-terra", subagent: "gpt-6-luna", reviewer: "gpt-6.1-sol", labels: ["pendulum:harness:codex", "pendulum:model:gpt-6.1-terra"] });
  assert.match(markdownTable([row]), /\| codex gpt-6\.1-terra; sub-agents gpt-6-luna; reviewer gpt-6\.1-sol \(by label: pendulum:harness:codex, pendulum:model:gpt-6\.1-terra\) \|/);
});

test("#263: the row's accounts come from the usage artifacts and the local stages' harness lines, once each; the dollars from both", () => {
  // Work on Actions (its usage artifact from before `progressRun`, uploaded by the work's run; its progress comment has
  // no spend line, as on Actions), review run locally on account `alpha`.
  const c = localMerge(62);
  c.issueComments[0].body = c.issueComments[0].body.replace(/\n<!-- pendulum:spend [^\n]* -->/, "");
  c.issueComments[2].body += `\n${harnessMarker("codex", "gpt-6.1-sol", { ...ran("gpt-6.1-terra", null, "gpt-6.1-sol"), harness: "codex", account: "alpha" })}`;
  c.usage = [{ artifact: "pendulum-usage-62", workflowRun: 1700000001, harness: "codex", model: "gpt-6.1-terra", usd: 2 }];
  const row = score(c);
  assert.deepEqual(row.accounts, ["alpha"], "the local review's account");
  // The artifact stands for the work's comment (its run), never the review's: the review's dollars are added. The
  // artifact's Codex run reported no tokens, so it is one run of unknown cost, and the work's comment adds none.
  assert.deepEqual([row.cost.usd, row.cost.usdUnknown], [0.25, 1], "the local review's line beside the artifact, the work not twice");
  c.usage = [{ ...c.usage[0], account: "alpha" }, { ...c.usage[0], account: "beta" }];
  assert.deepEqual(score(c).accounts, ["alpha", "beta"], "deduplicated");
});

test("#266: the row gives each local account its stages, dollars and usage-limit pauses, from the stages' progress lines and, given, their own result.json, each stage once; the Harness cell shows them", () => {
  const c = localMerge(63);
  const mark = (account) => `\n${harnessMarker("codex", "gpt-6.1-sol", { ...ran("gpt-6.1-sol", null, "gpt-6.1-sol"), harness: "codex", account })}`;
  const paused = { ...c.issueComments[0], id: 1700000000, body: `<!-- pendulum:63:progress:work:1700000000 -->\nPendulum work run 1700000000\n- 00:50Z exit: paused\n<!-- pendulum:spend {"usd":0.5,"limitPaused":true} -->${mark("alpha")}` };
  c.issueComments[0].body += mark("beta");
  c.issueComments[2].body += mark("beta");
  c.issueComments.unshift(paused);
  const row = score(c);
  assert.deepEqual(row.accountUse, [
    { account: "alpha", stages: 1, usd: 0.5, unknown: 0, limitPauses: 1 },
    { account: "beta", stages: 2, usd: 1.5, unknown: 0, limitPauses: 0 },
  ]);
  assert.match(markdownTable([row]), /; accounts alpha \(1 stage, \$0\.50, 1 limit pause\), beta \(2 stages, \$1\.50\) \|/);
  // Mixed: two stages' own result.json given (each naming its progress comment), and the review stage's line alone.
  c.usage = [
    { artifact: "usage-work-1/result.json", progressRun: "1700000000", harness: "codex", account: "alpha", usd: 0.5, exit: "paused", usageLimit: { harness: "codex", reset: "2031-03-02T05:00:00Z", since: "2031-03-02T00:50:00Z" } },
    { artifact: "usage-work-2/result.json", progressRun: "1700000001", harness: "codex", account: "beta", usd: 1.3, exit: "delivered" },
  ];
  assert.deepEqual(score(c).accountUse, [
    { account: "alpha", stages: 1, usd: 0.5, unknown: 0, limitPauses: 1 },
    { account: "beta", stages: 2, usd: 1.55, unknown: 0, limitPauses: 0 },
  ], "the records' figures for their stages, the review's line added, nothing twice");
  // A result.json from before `progressRun` cannot be matched to a line: its account's lines are left out, never both.
  c.usage = [{ artifact: "usage-work-1/result.json", harness: "codex", account: "alpha", usd: 0.5, exit: "paused", usageLimit: { harness: "codex", reset: "2031-03-02T05:00:00Z", since: "2031-03-02T00:50:00Z" } }, c.usage[1]];
  assert.deepEqual(score(c).accountUse, [
    { account: "alpha", stages: 1, usd: 0.5, unknown: 0, limitPauses: 1 },
    { account: "beta", stages: 2, usd: 1.55, unknown: 0, limitPauses: 0 },
  ]);
  // No dollars anywhere (no spend lines, no usage): the stages and pauses still count.
  const bare = localMerge(65);
  bare.issueComments = bare.issueComments.map((x) => ({ ...x, body: x.body.replace(/\n<!-- pendulum:spend [^\n]* -->/, "") }));
  bare.issueComments[0].body += `${mark("beta")}`;
  bare.issueComments[2].body += `${mark("beta")}`;
  bare.issueComments.unshift({ ...paused, body: paused.body.replace(":63:", ":65:").replace(/<!-- pendulum:spend [^\n]* -->/, "<!-- pendulum:spend-x -->") });
  bare.issueComments[0].body = bare.issueComments[0].body.replace("<!-- pendulum:spend-x -->", "");
  assert.deepEqual(score(bare).accountUse, [
    { account: "alpha", stages: 1, usd: null, unknown: 1, limitPauses: 0 },
    { account: "beta", stages: 2, usd: null, unknown: 2, limitPauses: 0 },
  ]);
  assert.match(markdownTable([score(bare)]), /accounts alpha \(1 stage, unknown\), beta \(2 stages, unknown, 2 runs\)/);
  assert.deepEqual(score(localMerge(64)).accountUse, [], "no account named: none");
  assert.deepEqual(stageSpendLine({ usd: 0.5, exit: "paused", usageLimit: { harness: "claude" } }).parts, { limitPaused: true }, "the spend line marks a usage-limit pause");
  assert.deepEqual(stageSpendLine({ usd: 0.5, exit: "paused", outage: { host: "github.com" } }).parts, {}, "not an outage's");
  // On GitHub Actions and the cloud sandbox (#268), a stage that went on on another account is that account's limit pause.
  assert.deepEqual(stageSpendLine({ usd: 0.5, exit: "waiting", usageLimit: { harness: "claude" } }).parts, { limitPaused: true });
  assert.deepEqual(accountUse([{ account: "claude-2", usd: 0.5, exit: "waiting", usageLimit: { harness: "claude" } }, { account: "claude-2", usd: 0.2, exit: "waiting" }]), [{ account: "claude-2", stages: 2, usd: 0.7, unknown: 0, limitPauses: 1 }]);
});

test("#483: an account's share counts its runs of unknown cost beside its known dollars", () => {
  const use = accountUse([{ account: "alpha", usd: 1, usdUnknown: 1, usdUnknownWhy: ["unreported"] }, { account: "alpha", usd: 0.5 }]);
  assert.deepEqual(use, [{ account: "alpha", stages: 2, usd: 1.5, unknown: 1, limitPauses: 0 }]);
  assert.match(harnessCell({ harness: "claude", accountUse: use }), /account alpha \(2 stages, \$1\.50 plus 1 run of unknown cost\)/);
});
