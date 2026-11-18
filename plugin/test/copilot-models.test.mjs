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
import { stageSpendLine } from "../scripts/lib/logic.mjs";
import { IMPLEMENTER_AGENT, copilotRan, parseCopilot } from "../scripts/lib/usage.mjs";
import { ranModels, ranWith } from "../scripts/lib/choice.mjs";
import { resolveInputs } from "../scripts/lib/inputs.mjs";

const FIXTURES = join(import.meta.dirname, "fixtures");

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
