// #600: a Copilot stage's models. The cards name each model through the table the report uses (claude-models.json, by
// usage.mjs modelName), an id it does not list as recorded; and the usage record's `ran` names the models Copilot's own
// event stream names, followed end to end: a real pass on a fake `copilot` CLI, result.json, the progress comment's
// harness line and card on a fake GitHub (the stage's real reporter), and the finish card over a real run's comments.
import "./temp.mjs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { credentialEnv, runHarness } from "../scripts/lib/harness.mjs";
import { progressReporter, writeUsage } from "../scripts/lib/session.mjs";
import { repoOf } from "../scripts/lib/github.mjs";
import { setSelf, stageSpendLine } from "../scripts/lib/logic.mjs";
import { CLAUDE_MODELS, IMPLEMENTER_AGENT, copilotRan, modelName as reportName, parseCopilot } from "../scripts/lib/usage.mjs";
import { modelName } from "../scripts/lib/card-kit.mjs";
import { ranModels, ranWith } from "../scripts/lib/choice.mjs";
import { resolveInputs } from "../scripts/lib/inputs.mjs";
import { finishData, renderFinishCard } from "../scripts/lib/finish-card.mjs";

const FIXTURES = join(import.meta.dirname, "fixtures");
const SCRIPTS = join(import.meta.dirname, "..", "scripts");

/** One stream event as Copilot prints it (session-events.schema.json: id, timestamp, parentId, type, data; `agentId` on a sub-agent's). */
let n = 0;
const event = (type, data, extra = {}) => JSON.stringify({ type, data, ...extra, id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, timestamp: "2026-11-18T07:36:30.000Z", parentId: null });

/**
 * A work pass's stream: Copilot 1.0.91's real one (copilot-events.jsonl) on `main`, the main agent's model, with an
 * implementer sub-agent on `sub` (its start, a message of its own under its agentId, its end) and Copilot's own explore
 * agent on gpt-5-mini, which is no sub-agent the sub-agent model pins.
 */
function stream(main = "claude-sonnet-5.5", sub = "claude-haiku-4.5") {
  const real = readFileSync(join(FIXTURES, "copilot-events.jsonl"), "utf8").replaceAll('"claude-sonnet-5"', JSON.stringify(main)).split("\n").filter(Boolean);
  const end = real.findIndex((l) => JSON.parse(l).type === "assistant.turn_end");
  const subAgent = [
    event("subagent.started", { toolCallId: "toolu_1", agentName: IMPLEMENTER_AGENT, agentDisplayName: "implementer", agentDescription: "item 1", model: sub }),
    event("assistant.message", { messageId: "m-sub", model: sub, content: "done", toolRequests: [], parentToolCallId: "toolu_1" }, { agentId: "agent-1" }),
    event("subagent.completed", { toolCallId: "toolu_1", agentName: IMPLEMENTER_AGENT, agentDisplayName: "implementer", model: sub, firstDispatchedModel: sub }),
    event("subagent.started", { toolCallId: "toolu_2", agentName: "explore", agentDisplayName: "Explore", agentDescription: "look around" }),
    event("assistant.message", { messageId: "m-explore", model: "gpt-5-mini", content: "found", toolRequests: [], parentToolCallId: "toolu_2" }, { agentId: "agent-2" }),
    event("subagent.completed", { toolCallId: "toolu_2", agentName: "explore", agentDisplayName: "Explore", model: "gpt-5-mini", firstDispatchedModel: "gpt-5-mini" }),
  ];
  return [...real.slice(0, end), ...(sub ? subAgent : []), ...real.slice(end)].join("\n");
}

/** A fake `copilot` printing `text` as its stream, its usage file the 1.0.107 one. */
function fakeCopilot(text) {
  const bin = mkdtempSync(join(tmpdir(), "copilot-models-"));
  writeFileSync(join(bin, "stream.jsonl"), text);
  writeFileSync(join(bin, "copilot"), `#!${process.execPath}
const fs = require("node:fs");
const at = process.argv.indexOf("--usage-output-file");
if (at > 0) fs.copyFileSync(${JSON.stringify(join(FIXTURES, "copilot-1.0.107-usage.json"))}, process.argv[at + 1]);
process.stdout.write(fs.readFileSync(${JSON.stringify(join(bin, "stream.jsonl"))}, "utf8") + "\\n");
`, { mode: 0o755 });
  return bin;
}

/** A fake GitHub keeping every comment body written. */
async function fakeGitHub() {
  const written = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if ((req.method === "POST" || req.method === "PATCH") && /\/comments/.test(req.url)) written.push(JSON.parse(body || "{}").body || "");
      else if (req.method === "GET") return res.end("[]");
      res.end(JSON.stringify({ id: 1, user: { login: "owner", type: "User" }, body: "" }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { written, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

/** Copilot at its defaults: no model named, so Copilot picks its own. */
const copilotInputs = () => resolveInputs({ args: {}, env: { PENDULUM_HARNESS: "copilot" } });

/**
 * One Copilot stage as worker.mjs (or review.mjs) ends it: its passes run for real on the fake CLI, then its usage
 * record, the progress reporter told the models that record names, its spend line and its exit line.
 */
async function copilotStage({ stage = "work", labels = ["work-1"], text = stream() }) {
  const bin = fakeCopilot(text);
  const env = { HOME: process.env.HOME, PATH: `${bin}:${process.env.PATH}` };
  const cred = await credentialEnv({ harness: "copilot", credential: "api", inputs: { copilotGithubToken: "github_pat_dummy" }, env });
  const inputs = copilotInputs();
  const ran = ranWith(inputs, ["pendulum:harness:copilot"]);
  const gh = await fakeGitHub();
  const saved = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = gh.url;
  try {
    const progress = progressReporter(repoOf("owner/repo"), 28, { token: () => "t" }, { stage, runId: "44260045806", harness: "copilot", model: "", soFar: null });
    progress.billing(cred.billing);
    progress.ran(ran);
    await progress("harness copilot attempt 1", { step: stage === "review" ? "review" : "work", harness: "copilot", model: null, attempt: 1 });
    const records = [];
    for (const label of labels) {
      const dir = mkdtempSync(join(tmpdir(), "copilot-pass-"));
      records.push(await runHarness({ harness: "copilot", model: "", prompt: "p", maxUsd: 25, cwd: dir, eventsFile: join(dir, "events.jsonl"), env: { ...env, ...cred.env }, timeoutMs: 60_000, label }));
    }
    const dir = mkdtempSync(join(tmpdir(), "copilot-usage-"));
    const usage = writeUsage(dir, { harness: "copilot", model: "", records, passes: records.length, exit: "delivered", reason: "", credentialBasis: cred.basis, billing: cred.billing, ran });
    // As worker.mjs and review.mjs do once the usage is written.
    progress.models(usage.ran);
    const line = stageSpendLine(usage);
    progress.spend(line.usd, line.parts, line.ledger);
    await progress("exit: delivered");
    return { records, stored: JSON.parse(readFileSync(join(dir, "result.json"), "utf8")), body: gh.written.at(-1) };
  } finally {
    if (saved === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = saved;
    gh.close();
  }
}

const harnessLine = (body) => JSON.parse(/^<!-- pendulum:harness (\{.*\}) -->$/m.exec(body)[1]);

test("a card names a model by the report's table: each Copilot catalog id it lists as the API id's name, any other id as recorded", () => {
  assert.ok(Object.keys(CLAUDE_MODELS.aliases).length > 0);
  for (const [catalog, api] of Object.entries(CLAUDE_MODELS.aliases)) {
    assert.equal(modelName(catalog), modelName(api), catalog);
    assert.notEqual(modelName(catalog), catalog, `${catalog} is named, not printed raw`);
  }
  assert.deepEqual(["claude-sonnet-5.5", "claude-opus-5.5", "claude-opus-5-5", "claude-fable-5-2"].map(modelName), ["Sonnet 5.5", "Opus 5.5", "Opus 5.5", "Fable 5.2"]);
  // Not in the table: as recorded, never guessed from the name's shape.
  assert.deepEqual(["claude-sonnet-9.9", "claude-haiku-4.5", "claude-2.1", "gpt-6.1-sol", "openai/gpt-6.1-sol", "gpt-5-mini"].map(modelName), ["claude-sonnet-9.9", "claude-haiku-4.5", "claude-2.1", "gpt-6.1-sol", "openai/gpt-6.1-sol", "gpt-5-mini"]);
  assert.equal(modelName("evil\nid"), null);
  // The cards' table is the report's own: the report's name function with no Codex price table is the table alone.
  for (const id of ["claude-sonnet-5.5", "claude-sonnet-9.9", "gpt-5.6"]) assert.equal(reportName(id, null), CLAUDE_MODELS.aliases[id] ?? id);
});

test("the implementer the sub-agent model pins is the agent definition Copilot names by IMPLEMENTER_AGENT", () => {
  const def = readFileSync(join(SCRIPTS, "..", "agents", "copilot", "implementer.agent.md"), "utf8");
  assert.equal(/^name: (.+)$/m.exec(def)?.[1], IMPLEMENTER_AGENT);
});

test("a Copilot work stage, run for real: ran names the models Copilot's stream named, and its progress card names them by the table", async () => {
  const { records, stored, body } = await copilotStage({});
  assert.deepEqual(records[0].agentModels, { main: ["claude-sonnet-5.5"], agents: { [IMPLEMENTER_AGENT]: ["claude-haiku-4.5"], explore: ["gpt-5-mini"] } });
  // The worker is the main agent's model and the sub-agent the implementer's; a work stage runs no reviewer.
  assert.deepEqual([stored.ran.worker, stored.ran.subagent, stored.ran.reviewer], ["claude-sonnet-5.5", "claude-haiku-4.5", null]);
  assert.deepEqual(stored.ran.labels, ["pendulum:harness:copilot"]);
  const h = harnessLine(body);
  assert.deepEqual([h.harness, h.model, h.models], ["copilot", "claude-sonnet-5.5", { worker: "claude-sonnet-5.5", subagent: "claude-haiku-4.5", reviewer: null }]);
  assert.match(body, /^\| [^|]+ \| Built the change · Sonnet 5\.5 \| /m);
  assert.match(body, /^- \*\*Models:\*\* worker Sonnet 5\.5 · sub-agents claude-haiku-4\.5$/m);
  assert.doesNotMatch(body.split("**Full log**")[0], /claude-sonnet-5\.5/, "the card names no raw catalog id");
});

test("a Copilot review stage, run for real: the reviewer is its review passes' main model, the worker its answer pass's", async () => {
  const { stored, body } = await copilotStage({ stage: "review", labels: ["review"], text: stream("claude-opus-5.5", null) });
  assert.deepEqual([stored.ran.worker, stored.ran.subagent, stored.ran.reviewer], [null, null, "claude-opus-5.5"]);
  assert.deepEqual(harnessLine(body).models, { worker: null, subagent: null, reviewer: "claude-opus-5.5" });
  assert.match(body, /^- \*\*Models:\*\* reviewer Opus 5\.5$/m);
  const both = await copilotStage({ stage: "review", labels: ["review", "answer"], text: stream("claude-opus-5.5", null) });
  assert.deepEqual([both.stored.ran.worker, both.stored.ran.reviewer], ["claude-opus-5.5", "claude-opus-5.5"]);
});

test("ran keeps a model only where Copilot's stream names exactly one for it; the rest is null, or the model Pendulum asked for", () => {
  const rec = (label, text) => ({ ...parseCopilot(text, null, 0), label });
  // Two main models across the stage's work passes: no one id is what the worker ran.
  assert.deepEqual(copilotRan([rec("work-1", stream("claude-sonnet-5.5")), rec("validation-fix-1", stream("gpt-6.1-sol"))]), { worker: null, subagent: "claude-haiku-4.5" }, "no review pass ran: no reviewer key");
  // A decision call, and a pass of no kind the stage's roles have, name none of them.
  assert.deepEqual(copilotRan([{ ...rec("decision", stream("gpt-6.1-sol", null)), decision: true }, rec("exit-record", stream("gpt-6.1-sol", null)), rec("work-1", stream("claude-sonnet-5.5", null))]), { worker: "claude-sonnet-5.5" });
  // A stream that names no model (killed before its first message): nothing, so the ran Pendulum chose stands.
  assert.equal(parseCopilot("", null, 1).agentModels, undefined);
  assert.deepEqual(ranModels(ranWith(copilotInputs(), []), copilotRan([])), { worker: null, subagent: null, reviewer: null });
  // A model asked for and a stream that names two for its role: null, never the model asked for.
  const two = copilotRan([rec("work-1", stream("claude-sonnet-5.5", null)), rec("work-2", stream("claude-opus-5.5", null))]);
  assert.deepEqual(two, { worker: null });
  assert.deepEqual(ranModels(ranWith(resolveInputs({ args: {}, env: { PENDULUM_HARNESS: "copilot", PENDULUM_MODEL: "claude-sonnet-5.5" } }), []), two), { worker: null, subagent: null, reviewer: "claude-sonnet-5.5" });
  const chosen = ranWith(resolveInputs({ args: {}, env: { PENDULUM_HARNESS: "copilot", PENDULUM_MODEL: "gpt-6.1-sol" } }), []);
  assert.deepEqual(ranModels(chosen, copilotRan([])), { worker: "gpt-6.1-sol", subagent: null, reviewer: "gpt-6.1-sol" });
});

test("a sub-agent that sent no request names no model; a message marked only by parentToolCallId is a sub-agent's", () => {
  const lines = (...extra) => [...stream("claude-sonnet-5.5", null).split("\n"), ...extra].join("\n");
  const failed = parseCopilot(lines(event("subagent.failed", { toolCallId: "toolu_9", agentName: IMPLEMENTER_AGENT, agentDisplayName: "implementer", error: "refused", model: "claude-haiku-4.5" })), null, 0);
  assert.deepEqual(failed.agentModels, { main: ["claude-sonnet-5.5"], agents: {} }, "no firstDispatchedModel: it never ran a model");
  const ran = parseCopilot(lines(event("subagent.failed", { toolCallId: "toolu_9", agentName: IMPLEMENTER_AGENT, agentDisplayName: "implementer", error: "x", firstDispatchedModel: "claude-haiku-4.5" })), null, 0);
  assert.deepEqual(ran.agentModels.agents, { [IMPLEMENTER_AGENT]: ["claude-haiku-4.5"] });
  const marked = parseCopilot(lines(event("assistant.message", { messageId: "m-x", model: "gpt-5-mini", content: "x", toolRequests: [], parentToolCallId: "toolu_3" })), null, 0);
  assert.deepEqual(marked.agentModels.main, ["claude-sonnet-5.5"]);
});

test("a pass through a bring-your-own-key provider names no model: none in ran, the ledger line or the cards", async () => {
  const arn = "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-5-5";
  const byok = (type) => stream(arn, null).split("\n").map((l) => (JSON.parse(l).type === type ? l.replace('"isByok":false', '"isByok":true') : l)).concat(type === "assistant.usage" ? [event("assistant.usage", { model: arn, isByok: true, inputTokens: 1, outputTokens: 1 })] : []).join("\n");
  for (const type of ["model.call_final_result", "assistant.usage"]) {
    const rec = parseCopilot(byok(type), null, 0);
    assert.equal(rec.byok, true, type);
    assert.equal(rec.agentModels, undefined, type);
  }
  const { stored, body } = await copilotStage({ text: byok("model.call_final_result") });
  assert.equal(stored.byok, true);
  assert.deepEqual([stored.ran.worker, stored.ran.subagent, stored.ran.reviewer], [null, null, null]);
  assert.doesNotMatch(body, /123456789012/, "the account never reaches the comment");
  const ledger = JSON.parse(/^<!-- pendulum:ledger (\{.*\}) -->$/m.exec(body)[1]);
  assert.equal(ledger.m, undefined);
  assert.ok(ledger.p.every((p) => p.m === undefined || p.m === null));
  // A stage with one pass through BYOK names no model from any of its passes.
  const mixed = writeUsage(mkdtempSync(join(tmpdir(), "copilot-mixed-")), { harness: "copilot", model: "", records: [{ ...parseCopilot(byok("assistant.usage"), null, 0), label: "work-1" }, { ...parseCopilot(stream(), null, 0), label: "work-2" }], passes: 2, exit: "delivered", reason: "", credentialBasis: null, ran: ranWith(copilotInputs(), []) });
  assert.deepEqual([mixed.byok, mixed.ran.worker, mixed.ran.subagent], [true, null, null]);
  // Not BYOK: the stage's model is on its ledger line, as before.
  const plain = await copilotStage({});
  assert.equal(JSON.parse(/^<!-- pendulum:ledger (\{.*\}) -->$/m.exec(plain.body)[1]).m, "claude-sonnet-5.5");
});

test("fails closed: a stream that never says whether its calls went through BYOK records no model, and a replayed checkpoint record counts for none", async () => {
  // Copilot writes model.call_final_result after the message: a run killed between them says nothing of BYOK.
  const arn = "arn:aws:bedrock:us-east-1:123456789012:inference-profile/x";
  const silent = stream(arn).split("\n").filter((l) => JSON.parse(l).type !== "model.call_final_result").join("\n");
  const rec = parseCopilot(silent, null, 0);
  assert.equal(rec.agentModels, undefined);
  assert.equal(rec.byok, true, "a model named with no live isByok: false is treated as BYOK");
  const { stored, body } = await copilotStage({ text: silent });
  assert.equal(stored.byok, true);
  assert.deepEqual([stored.ran.worker, stored.ran.subagent, stored.ran.reviewer], [null, null, null]);
  assert.deepEqual(harnessLine(body).models, { worker: null, subagent: null, reviewer: null });
  assert.equal(JSON.parse(/^<!-- pendulum:ledger (\{.*\}) -->$/m.exec(body)[1]).m, undefined, "no model on the ledger line");
  assert.doesNotMatch(body, /123456789012/, "the account never reaches the comment");
  // A stream that names no model at all is no BYOK pass: nothing to hide.
  assert.equal(parseCopilot("", null, 1).byok, undefined);
  // A checkpoint record (the envelope's `checkpoint`) is the session's history: its messages, sub-agents and isByok:false count for none.
  const replayed = [
    event("assistant.message", { messageId: "m-old", model: "gpt-6.1-sol", content: "old", toolRequests: [] }, { checkpoint: true }),
    event("subagent.completed", { toolCallId: "toolu_8", agentName: IMPLEMENTER_AGENT, agentDisplayName: "implementer", model: "gpt-5-mini", firstDispatchedModel: "gpt-5-mini" }, { checkpoint: true }),
  ];
  assert.deepEqual(parseCopilot([...replayed, stream("claude-sonnet-5.5")].join("\n"), null, 0).agentModels, { main: ["claude-sonnet-5.5"], agents: { [IMPLEMENTER_AGENT]: ["claude-haiku-4.5"], explore: ["gpt-5-mini"] } });
  const onlyReplayedFalse = [event("model.call_final_result", { model: "claude-sonnet-5.5", isByok: false, result: "success" }, { checkpoint: true }), silent].join("\n");
  assert.equal(parseCopilot(onlyReplayedFalse, null, 0).agentModels, undefined, "a replayed isByok: false is not this run's");
  // A replayed isByok: true still marks the run: fail closed.
  assert.equal(parseCopilot([event("assistant.usage", { model: "x", isByok: true }, { checkpoint: true }), stream("claude-sonnet-5.5")].join("\n"), null, 0).byok, true);
});

test("a stage that ends before its own ran is known (an early Block) gets no models on its harness line from its usage record", async () => {
  const gh = await fakeGitHub();
  const saved = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = gh.url;
  try {
    const progress = progressReporter(repoOf("owner/repo"), 28, { token: () => "t" }, { stage: "work", runId: "1", harness: "copilot", model: "", soFar: null });
    progress.models({ worker: "claude-opus-5-5", subagent: null, reviewer: null });
    await progress("exit: blocked");
    assert.deepEqual(harnessLine(gh.written.at(-1)), { harness: "copilot" });
  } finally {
    if (saved === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = saved;
    gh.close();
  }
});

test("the finish card names a Copilot stage's model by the table, its run log by the report's id; an unlisted id as recorded", () => {
  const real = readFileSync(join(FIXTURES, "finish-scratch-3.json"), "utf8");
  const card = (id) => {
    const r = JSON.parse(real.replaceAll("claude-opus-5-5", id).replaceAll("claude-fable-5-2", id));
    setSelf("clockgrove-pendulum[bot]");
    try {
      return renderFinishCard(finishData({ repo: "clockgrove/pendulum-scratch", issue: r.issue, timeline: r.timeline, comments: r.comments, pulls: [{ pr: r.pr, timeline: r.prTimeline, reviews: r.reviews, reviewComments: r.reviewComments }], checks: r.checks, records: r.records }));
    } finally {
      setSelf(null);
    }
  };
  const listed = card("claude-sonnet-5.5");
  assert.match(listed, /^\| [^|]+ \| Plan \+ build · Sonnet 5\.5 \| /m);
  assert.match(listed, /^\| [^|]+ \| Review · Sonnet 5\.5 \| /m);
  assert.match(listed, / plan \+ build stage started \(claude-sonnet-5-5\)$/m);
  assert.doesNotMatch(listed, /claude-sonnet-5\.5/);
  // A stage whose harness and ledger lines name no model takes its record's, unless that record ran through BYOK.
  const r = JSON.parse(real);
  const bare = r.comments.map((c) => ({ ...c, body: c.body.replace(/^<!-- pendulum:harness \{[^\n]*\} -->$/m, '<!-- pendulum:harness {"harness":"copilot","models":{"worker":null,"subagent":null,"reviewer":null},"labels":[]} -->').replace("harness claude (claude-opus-5-5) attempt 1", "harness copilot attempt 1") }));
  const withRecords = (records) => {
    setSelf("clockgrove-pendulum[bot]");
    try {
      return finishData({ repo: "clockgrove/pendulum-scratch", issue: r.issue, timeline: r.timeline, comments: bare, pulls: [{ pr: r.pr, timeline: r.prTimeline, reviews: r.reviews, reviewComments: r.reviewComments }], checks: r.checks, records }).stages.map((s) => s.model);
    } finally {
      setSelf(null);
    }
  };
  // Each record tagged with its stage's artifact, as objectiveRecords returns it.
  const tagged = (over) => r.records.map((x) => ({ ...x, ...over, artifact: r.comments.some((c) => c.body.startsWith(`<!-- pendulum:3:progress:review:${x.progressRun} -->`)) ? "pendulum-usage-3-review" : "pendulum-usage-3" }));
  assert.deepEqual(withRecords(tagged({ harness: "copilot", model: "claude-sonnet-5.5" })), ["claude-sonnet-5.5", "claude-sonnet-5.5"]);
  assert.deepEqual(withRecords(tagged({ harness: "copilot", model: "arn-like.id", byok: true })), [null, null]);
  const unlisted = card("claude-sonnet-9.9");
  assert.match(unlisted, /^\| [^|]+ \| Plan \+ build · claude-sonnet-9\.9 \| /m);
  assert.match(unlisted, / plan \+ build stage started \(claude-sonnet-9\.9\)$/m);
});
