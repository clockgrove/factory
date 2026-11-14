// The scorecard row names the harness and models that ran and the labels that chose them (#224), so rows compare model
// to model. Invented data, no network.
import "../../plugin/test/temp.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadPrices } from "../lib/cost.mjs";
import { harnessCell, markdownTable, objectiveModels, scoreObjective, stageHarnessOf } from "../lib/objective.mjs";
import { harnessMarker } from "../../plugin/scripts/lib/logic.mjs";
import { localMerge } from "./fixtures/github.mjs";

const prices = loadPrices();
const score = (c) => scoreObjective(c, { prices, now: "2031-03-05T00:00:00Z" });
const ran = (worker, subagent, reviewer, labels = []) => ({ harness: "claude", worker, subagent, reviewer, labels });

test("a stage's harness line carries the Objective's three models and its labels; an older line reads without them", () => {
  const line = harnessMarker("claude", "claude-sonnet-5-5", ran("claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5", ["factory:model:claude-sonnet-5-5"]));
  assert.deepEqual(stageHarnessOf(line), { harness: "claude", model: "claude-sonnet-5-5", ran: { worker: "claude-sonnet-5-5", subagent: "claude-haiku-5-5", reviewer: "claude-opus-5-5", labels: ["factory:model:claude-sonnet-5-5"] } });
  assert.deepEqual(stageHarnessOf(harnessMarker("codex", "gpt-6.1-sol")), { harness: "codex", model: "gpt-6.1-sol" });
});

test("objectiveModels: the worker's model as the harness reported it, the last work stage's sub-agent model, the last review's reviewer", () => {
  const usage = [
    { artifact: "factory-usage-7", ran: { worker: "claude-opus-5-5", subagent: "claude-sonnet-5-5", reviewer: "claude-fable-5-2", labels: [] } },
    { artifact: "factory-usage-7", ran: { worker: "claude-sonnet-5-5", subagent: "claude-haiku-5-5", reviewer: "claude-fable-5-2", labels: ["factory:model:claude-sonnet-5-5"] } },
    { artifact: "factory-usage-7-review", ran: { worker: "claude-sonnet-5-5", subagent: "claude-haiku-5-5", reviewer: "claude-opus-5-5", labels: ["factory:reviewer-model:claude-opus-5-5"] } },
  ];
  const m = objectiveModels(usage, { model: "claude-sonnet-5-5-20261101" });
  assert.deepEqual(m, { worker: "claude-sonnet-5-5-20261101", subagent: "claude-haiku-5-5", reviewer: "claude-opus-5-5", labels: ["factory:model:claude-sonnet-5-5", "factory:reviewer-model:claude-opus-5-5"] });
  assert.equal(harnessCell({ harness: "claude", models: m }), "claude claude-sonnet-5-5-20261101; sub-agents claude-haiku-5-5; reviewer claude-opus-5-5 (by label: factory:model:claude-sonnet-5-5, factory:reviewer-model:claude-opus-5-5)");
  assert.deepEqual(objectiveModels([{ artifact: "factory-usage-7" }], { model: "gpt-6.1-sol" }), { worker: "gpt-6.1-sol", subagent: null, reviewer: null, labels: [] }, "a record from before `ran`");
  assert.equal(harnessCell({ harness: "codex", model: "gpt-6.1-sol", models: { worker: null, subagent: null, reviewer: null, labels: [] } }), "codex gpt-6.1-sol");
});

test("a local Objective's row reads what ran from its stages' harness lines", () => {
  const c = localMerge(61);
  const line = (r) => `\n${harnessMarker("codex", r.worker, r)}`;
  c.issueComments[0].body += line({ harness: "codex", worker: "gpt-6.1-terra", subagent: "gpt-6-luna", reviewer: "gpt-6.1-sol", labels: ["factory:harness:codex", "factory:model:gpt-6.1-terra"] });
  c.issueComments[2].body += line({ harness: "codex", worker: "gpt-6.1-terra", subagent: "gpt-6-luna", reviewer: "gpt-6.1-sol", labels: ["factory:harness:codex", "factory:model:gpt-6.1-terra"] });
  const row = score(c);
  assert.equal(row.harness, "codex");
  assert.deepEqual(row.models, { worker: "gpt-6.1-terra", subagent: "gpt-6-luna", reviewer: "gpt-6.1-sol", labels: ["factory:harness:codex", "factory:model:gpt-6.1-terra"] });
  assert.match(markdownTable([row]), /\| codex gpt-6\.1-terra; sub-agents gpt-6-luna; reviewer gpt-6\.1-sol \(by label: factory:harness:codex, factory:model:gpt-6\.1-terra\) \|/);
});
