// The scorecard row names the harness and models that ran and the labels that chose them (#224), so rows compare model
// to model. Invented data, no network.
import "../../plugin/test/temp.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadPrices } from "../lib/cost.mjs";
import { accountUse, harnessCell, scoreObjective, stageHarnessOf } from "../lib/objective.mjs";
import { harnessMarker } from "../../plugin/scripts/lib/logic.mjs";
import { localMerge } from "./fixtures/github.mjs";

const prices = loadPrices();
const score = (c) => scoreObjective(c, { prices, now: "2031-03-05T00:00:00Z" });
const ran = (worker, subagent, reviewer, labels = []) => ({ harness: "claude", worker, subagent, reviewer, labels });

test("a stage's harness line carries the Objective's three models and its labels; an older line reads without them", () => {
  const line = harnessMarker("claude", "claude-sonnet-5-5", ran("claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5", ["pendulum:model:claude-sonnet-5-5"]));
  assert.deepEqual(stageHarnessOf(line), { harness: "claude", model: "claude-sonnet-5-5", ran: { worker: "claude-sonnet-5-5", subagent: "claude-haiku-5-5", reviewer: "claude-opus-5-5", labels: ["pendulum:model:claude-sonnet-5-5"] } });
  assert.deepEqual(stageHarnessOf(harnessMarker("codex", "gpt-6.1-sol")), { harness: "codex", model: "gpt-6.1-sol" });
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

test("#483: an account's share counts its runs of unknown cost beside its known dollars", () => {
  const use = accountUse([{ account: "alpha", usd: 1, usdUnknown: 1, usdUnknownWhy: ["unreported"] }, { account: "alpha", usd: 0.5 }]);
  assert.deepEqual(use, [{ account: "alpha", stages: 2, usd: 1.5, unknown: 1, limitPauses: 0 }]);
  assert.match(harnessCell({ harness: "claude", accountUse: use }), /account alpha \(2 stages, \$1\.50 plus 1 run of unknown cost\)/);
});
