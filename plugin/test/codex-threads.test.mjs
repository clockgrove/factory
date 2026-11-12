import "./temp.mjs";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { codexRollout, codexThreads, localRollouts, withSubAgents } from "../scripts/lib/codex-threads.mjs";
import { priceCodex, priceStage, CODEX_PRICES } from "../scripts/lib/usage.mjs";
import { runHarness, subAgentThreads } from "../scripts/lib/harness.mjs";
import { capturedSession, captureSession, dropSessions, SESSIONS_HELD } from "../scripts/lib/claude-runner.mjs";
import { codexRunnerLayout } from "../scripts/lib/codex-runner.mjs";
import { restoreTranscript, saveTranscript, stageThreads, writeUsage } from "../scripts/lib/session.mjs";
import { costOf } from "../../bench/lib/cost.mjs";

// Real codex-cli 0.167 rollouts, trimmed to the lines codex-threads.mjs reads (ids, sources, models, token counts):
// - a local Factory worker thread that spawned an implementer (`spawn-parent`) and that implementer's own rollout
//   (`spawn-child`), as Codex wrote them side by side under CODEX_HOME/sessions;
// - the factory-scratch #129 worker's thread on the AI Gateway (`spawn-gateway-parent`, from the v0.9.10 gate's
//   artifact), whose implementer's rollout was never saved;
// - a forked sub-agent (`spawn-forked-child`) whose rollout starts with a copy of its parent's history.
const fixture = (f) => readFileSync(join(import.meta.dirname, "fixtures", f), "utf8");
const PARENT = "01a1ce4c-356e-7722-b415-47d5e78afe1b";
const CHILD = "01a1ce4c-c48f-7a91-8213-42a5c3ae2283";
const MODEL = "gpt-6.1-sol";
const parentText = fixture("codex-0.167-spawn-parent.jsonl");
const childText = fixture("codex-0.167-spawn-child.jsonl");
const PARENT_TOKENS = { input: 2700500, cached: 2632832, written: 0, output: 5946 };
const CHILD_TOKENS = { input: 1454076, cached: 1404544, written: 0, output: 5122 };
const rel = (id, at = "21-48-19") => join("2026", "11", "11", `rollout-2026-11-11T${at}-${id}.jsonl`);
const named = (thread, id, kind = "started") => `${JSON.stringify({ timestamp: "2026-11-12T05:50:00.000Z", ordinal: 9000, type: "event_msg", payload: { type: "item_completed", thread_id: thread, item: { type: "SubAgentActivity", kind, agent_thread_id: id, agent_path: "/root/x" } } })}\n`;
/** A child of `parent` with the implementer's real counts, under another id. */
const childOf = (parent, id) => childText.replaceAll(CHILD, id).replaceAll(PARENT, parent);

function sessionsDir(files) {
  const root = mkdtempSync(join(tmpdir(), "codex-threads-"));
  for (const [r, text] of Object.entries(files)) {
    mkdirSync(join(root, r, ".."), { recursive: true });
    writeFileSync(join(root, r), text);
  }
  return root;
}

test("a rollout's own thread: its parent, its model, its own token totals, the threads it names", () => {
  const gw = codexRollout(fixture("codex-0.167-spawn-gateway-parent.jsonl"));
  // The #129 worker's last token_count total is what its turn.completed reported (its result.json's tokens).
  assert.deepEqual(gw.tokens, { input: 223348, cached: 199209, written: 24106, output: 2079 });
  assert.equal(gw.parent, null);
  assert.equal(gw.model, "openai/gpt-6.1-sol");
  assert.deepEqual(gw.names, ["01a1ce7d-97aa-7ba3-aeb1-688467bcfcdf"], "the implementer it spawned, named once");
  const child = codexRollout(childText);
  assert.equal(child.id, CHILD);
  assert.equal(child.parent, PARENT);
  assert.equal(child.model, MODEL);
  assert.deepEqual(child.tokens, CHILD_TOKENS);
  assert.deepEqual(child.names, [PARENT], "a child names its parent too: a name alone proves nothing");
  assert.equal(priceCodex(MODEL, child.tokens), 0.2907);
  assert.equal(codexRollout('{"type":"event_msg","payload":{}}\n'), null, "no session_meta first: no thread");
  assert.equal(codexRollout(""), null);
});

test("a forked sub-agent's copy of its parent's history is skipped; a total carried in is not its own", () => {
  const forked = fixture("codex-0.167-spawn-forked-child.jsonl");
  const own = codexRollout(forked);
  assert.deepEqual(own.tokens, { input: 624464, cached: 603776, written: 0, output: 1301 });
  const [meta, ...rest] = forked.trim().split("\n");
  const copied = [
    JSON.stringify({ ordinal: 5, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 9e6, output_tokens: 9e4 }, last_token_usage: { input_tokens: 1e5 } } } }),
    JSON.stringify({ ordinal: 6, type: "event_msg", payload: { type: "item_completed", item: { type: "SubAgentActivity", kind: "started", agent_thread_id: "sibling" } } }),
  ];
  const withCopy = codexRollout([meta, ...copied, ...rest].join("\n"));
  assert.deepEqual(withCopy.tokens, own.tokens, "the parent's counts before subagent_history_start_ordinal are not the child's");
  assert.ok(!withCopy.names.includes("sibling"));
  // A thread whose running total starts above its first request's: only what it added is its own.
  const tc = (total, last) => JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: total, cached_input_tokens: 0, output_tokens: 10 }, last_token_usage: { input_tokens: last, cached_input_tokens: 0, output_tokens: 10 } } } });
  const carried = codexRollout([JSON.stringify({ type: "session_meta", payload: { id: "c1" } }), tc(1500, 500), tc(1800, 300)].join("\n"));
  assert.deepEqual(carried.tokens, { input: 800, cached: 0, written: 0, output: 10 });
});

test("every thread under a run's thread, children of children too; a thread that does not name it as parent is not counted", async () => {
  const GRAND = "01a1ce4d-0000-7000-8000-000000000001";
  const STRANGER = "01a1ce4d-0000-7000-8000-000000000002";
  const root = sessionsDir({
    [rel(PARENT, "21-47-43")]: parentText + named(PARENT, STRANGER),
    [rel(CHILD)]: childText + named(CHILD, GRAND),
    [rel(GRAND, "21-49-00")]: childOf(CHILD, GRAND),
    // Named by the parent, but its own rollout says another thread spawned it.
    [rel(STRANGER, "21-49-30")]: childOf("01a1ffff-0000-7000-8000-00000000ffff", STRANGER),
  });
  try {
    const threads = await codexThreads(localRollouts(root), PARENT);
    assert.deepEqual(threads.map((t) => [t.id, t.parent]), [[CHILD, PARENT], [GRAND, CHILD]]);
    assert.deepEqual(threads[1].tokens, CHILD_TOKENS);
    assert.deepEqual(await codexThreads(localRollouts(root), CHILD), [threads[1]], "from the child down only");
    assert.deepEqual(await codexThreads(localRollouts(root), "../etc"), [], "no path out of the sessions directory");
    // The #129 worker named its implementer, whose rollout was not kept: nothing to count, nothing invented.
    const gw = sessionsDir({ [rel("01a1ce7d-369e-7983-89dd-9f98e083d64e")]: fixture("codex-0.167-spawn-gateway-parent.jsonl") });
    assert.deepEqual(await codexThreads(localRollouts(gw), "01a1ce7d-369e-7983-89dd-9f98e083d64e"), []);
    rmSync(gw, { recursive: true, force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a run's record gains each thread's own share, priced at its own model; a thread counted before adds only what is new", () => {
  const rec = { harness: "codex", model: MODEL, usd: priceCodex(MODEL, PARENT_TOKENS), tokens: { ...PARENT_TOKENS } };
  const thread = codexRollout(childText);
  const { rec: out, totals } = withSubAgents(rec, [thread]);
  assert.deepEqual(out.tokens, { input: 2700500 + 1454076, cached: 2632832 + 1404544, written: 0, output: 5946 + 5122 });
  assert.equal(out.usd, Math.round((rec.usd + 0.2907384) * 10000) / 10000);
  assert.deepEqual(out.subAgents, [{ id: CHILD, parent: PARENT, model: MODEL, usd: 0.2907, tokens: CHILD_TOKENS }]);
  assert.ok(!out.usdLowerBound);
  // The same thread seen again (a resumed parent's rollout still names it): nothing new, nothing counted twice.
  const again = withSubAgents(rec, [thread], (id) => totals[id]);
  assert.equal(again.rec.usd, rec.usd);
  assert.deepEqual(again.rec.subAgents[0].tokens, { input: 0, cached: 0, written: 0, output: 0 });
  // It worked on: only the growth.
  const grown = withSubAgents(rec, [{ ...thread, tokens: { ...CHILD_TOKENS, input: CHILD_TOKENS.input + 1000, output: CHILD_TOKENS.output + 100 } }], (id) => totals[id]);
  assert.deepEqual(grown.rec.subAgents[0].tokens, { input: 1000, cached: 0, written: 0, output: 100 });
  // A sub-agent on a cheaper model is priced at its own rate.
  const mini = withSubAgents(rec, [{ ...thread, model: "openai/gpt-5.4-mini" }]);
  assert.equal(mini.rec.subAgents[0].usd, priceCodex("gpt-5.4-mini", CHILD_TOKENS));
  // A model with no price: the dollars are a lower bound, never lowered, never null.
  const unpriced = withSubAgents(rec, [{ ...thread, model: "gpt-unlisted" }]);
  assert.equal(unpriced.rec.usd, rec.usd);
  assert.equal(unpriced.rec.usdLowerBound, true);
  // A run that reported no tokens of its own (no turn completed) still counts what its threads spent.
  const cut = withSubAgents({ harness: "codex", model: MODEL, usd: null, tokens: { input: null, output: null, cached: null, written: null } }, [thread]);
  assert.equal(cut.rec.usd, 0.2907);
  assert.equal(cut.rec.usdLowerBound, true);
  assert.equal(withSubAgents(rec, []).rec, rec, "no threads: the record as it was");
  // The bench prices the same record the same way, the sub-agent at its own model.
  const stage = { ...mini.rec };
  assert.equal(priceStage(CODEX_PRICES, MODEL, stage.tokens, stage.subAgents).usd, Math.round((rec.usd + mini.rec.subAgents[0].usd) * 10000) / 10000);
  assert.equal(costOf([{ harness: "codex", model: MODEL, runs: 1, tokens: stage.tokens, subAgents: stage.subAgents, basis: "priced" }], CODEX_PRICES).usd, priceStage(CODEX_PRICES, MODEL, stage.tokens, stage.subAgents).usd);
});

test("a Codex run counts its sub-agents in this pass, on a resume, and in a later stage that restores its thread; the transcript keeps them", async () => {
  // A fake `codex`: copies the next pass's rollouts into CODEX_HOME/sessions as Codex writes them, prints its stream.
  const work = mkdtempSync(join(tmpdir(), "codex-spawn-"));
  const next = join(work, "next");
  const bin = join(work, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "codex"), `#!${process.execPath}
const fs = require("node:fs");
fs.cpSync(${JSON.stringify(join(next, "sessions"))}, process.env.CODEX_HOME + "/sessions", { recursive: true });
process.stdout.write(fs.readFileSync(${JSON.stringify(join(next, "stdout.jsonl"))}, "utf8"));
`, { mode: 0o755 });
  const stream = (thread, t) => `${JSON.stringify({ type: "thread.started", thread_id: thread })}\n${JSON.stringify({ type: "turn.completed", usage: { input_tokens: t.input, cached_input_tokens: t.cached, cache_write_input_tokens: t.written, output_tokens: t.output } })}\n`;
  const pass = (files, out) => {
    rmSync(next, { recursive: true, force: true });
    for (const [r, text] of Object.entries(files)) {
      mkdirSync(join(next, "sessions", r, ".."), { recursive: true });
      writeFileSync(join(next, "sessions", r), text);
    }
    mkdirSync(next, { recursive: true });
    writeFileSync(join(next, "stdout.jsonl"), out);
  };
  const home = join(work, "codex");
  const saved = { PATH: process.env.PATH, CODEX_HOME: process.env.CODEX_HOME, FACTORY_LOCAL: process.env.FACTORY_LOCAL };
  process.env.PATH = `${bin}:${saved.PATH}`;
  process.env.CODEX_HOME = home;
  const run = (resume, label) => runHarness({ harness: "codex", model: MODEL, prompt: "p", maxUsd: 0, resume, cwd: work, env: { PATH: process.env.PATH, CODEX_HOME: home }, timeoutMs: 60_000, label });
  const parentUsd = priceCodex(MODEL, PARENT_TOKENS);
  try {
    pass({ [rel(PARENT, "21-47-43")]: parentText, [rel(CHILD)]: childText }, stream(PARENT, PARENT_TOKENS));
    const first = await run(null, "work-1");
    assert.equal(first.usd, Math.round((parentUsd + 0.2907384) * 10000) / 10000, "the implementer's spend is in the pass's dollars");
    assert.deepEqual(first.subAgents.map((t) => [t.id, t.usd]), [[CHILD, 0.2907]]);
    assert.equal(first.sessionTotal.usd, parentUsd, "the thread's own running total stays the parent's");
    assert.deepEqual(first.sessionTotal.children[CHILD].tokens, CHILD_TOKENS);

    // A fix pass resumes the thread: the parent's rollout still names the implementer, whose rollout is unchanged.
    pass({ [rel(PARENT, "21-47-43")]: parentText, [rel(CHILD)]: childText }, stream(PARENT, PARENT_TOKENS));
    const fix = await run(PARENT, "validation-fix-1");
    assert.equal(fix.usd, 0, "nothing new: neither the thread nor its implementer counted twice");
    assert.deepEqual(fix.subAgents[0].tokens, { input: 0, cached: 0, written: 0, output: 0 });

    // The stage's record and transcript cover the implementer.
    const usageDir = join(work, "ws", "usage-work-1");
    mkdirSync(usageDir, { recursive: true });
    const session = saveTranscript({ harness: "codex", sessionId: PARENT, also: stageThreads([first, fix]), usageDir, checkout: "/c" });
    assert.deepEqual(session.others, [{ id: CHILD, files: [rel(CHILD)] }]);
    assert.ok(existsSync(join(usageDir, "transcript", rel(CHILD))));
    const usage = writeUsage(usageDir, { harness: "codex", model: MODEL, records: [first, fix], passes: 1, exit: "delivered", reason: "", credentialBasis: "test", session });
    assert.equal(usage.usd, first.usd);
    assert.deepEqual(usage.subAgents.map((t) => [t.id, t.run]), [[CHILD, "work-1"], [CHILD, "validation-fix-1"]]);
    assert.deepEqual(usage.sessionTotal.children[CHILD].tokens, CHILD_TOKENS);

    // A later stage restores the thread (here under new ids: this process has seen the first). Locally Codex's
    // sessions persist, so the old implementer's rollout is still there; the resumed pass gives it more work.
    const P2 = "01a1ce4e-0000-7000-8000-0000000000a2";
    const C2 = "01a1ce4e-0000-7000-8000-0000000000c2";
    const parent2 = parentText.replaceAll(PARENT, P2).replaceAll(CHILD, C2);
    const child2 = childOf(P2, C2);
    mkdirSync(join(home, "sessions", "2026", "11", "11"), { recursive: true });
    writeFileSync(join(home, "sessions", rel(C2)), child2);
    const ws2 = join(work, "ws2", "usage-work-1");
    mkdirSync(join(ws2, "transcript", "2026", "11", "11"), { recursive: true });
    writeFileSync(join(ws2, "transcript", rel(P2, "21-47-43")), parent2);
    const total = { usd: parentUsd, tokens: PARENT_TOKENS, children: { [C2]: { usd: 0.2907, tokens: CHILD_TOKENS, model: MODEL } } };
    writeFileSync(join(ws2, "result.json"), JSON.stringify({ session: { harness: "codex", id: P2, files: [rel(P2, "21-47-43")], checkout: "/c" }, sessionTotal: total }));
    process.env.FACTORY_LOCAL = "1";
    assert.equal((await restoreTranscript({ checkout: "/c", workDir: join(work, "ws2"), harness: "codex" })).id, P2);
    delete process.env.FACTORY_LOCAL;
    const more = { input: CHILD_TOKENS.input + 30000, cached: CHILD_TOKENS.cached + 20000, written: 0, output: CHILD_TOKENS.output + 400 };
    const tick = JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: more.input, cached_input_tokens: more.cached, cache_write_input_tokens: 0, output_tokens: more.output }, last_token_usage: { input_tokens: 30000, cached_input_tokens: 20000, output_tokens: 400 } } } });
    const grownParent = { ...PARENT_TOKENS, input: PARENT_TOKENS.input + 5000, output: PARENT_TOKENS.output + 50 };
    pass({ [rel(P2, "21-47-43")]: parent2, [rel(C2)]: `${child2}${tick}\n` }, stream(P2, grownParent));
    const review = await run(P2, "review-fix-1");
    assert.deepEqual(review.subAgents[0].tokens, { input: 30000, cached: 20000, written: 0, output: 400 }, "only the implementer's new work");
    assert.equal(review.usd, Math.round((priceCodex(MODEL, { input: 5000, cached: 0, written: 0, output: 50 }) + priceCodex(MODEL, { input: 30000, cached: 20000, written: 0, output: 400 })) * 10000) / 10000);
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    rmSync(work, { recursive: true, force: true });
  }
});

test("on a runner (Actions, a cloud sandbox) the threads are read from archives the agent makes, and captured with the run's own", async () => {
  dropSessions();
  const root = mkdtempSync(join(tmpdir(), "codex-runner-threads-"));
  const agent = { home: join(root, "agent"), tmp: join(root, "agent", "tmp") };
  const layout = codexRunnerLayout(agent, join(root, "codex-home"));
  const GRAND = "01a1ce4d-0000-7000-8000-000000000003";
  for (const [r, text] of Object.entries({ [rel(PARENT, "21-47-43")]: parentText, [rel(CHILD)]: childText + named(CHILD, GRAND), [rel(GRAND, "21-49-00")]: childOf(CHILD, GRAND) })) {
    mkdirSync(join(layout.sessions, r, ".."), { recursive: true });
    writeFileSync(join(layout.sessions, r), text);
  }
  try {
    assert.deepEqual(await captureSession(layout, PARENT), [rel(PARENT, "21-47-43")]);
    const threads = await subAgentThreads(PARENT, layout, process.env);
    assert.deepEqual(threads.map((t) => [t.id, t.tokens]), [[CHILD, CHILD_TOKENS], [GRAND, CHILD_TOKENS]]);
    // Captured as the run's own session is: saved with the stage (saveAgentTranscript) and put back on the next reset.
    assert.deepEqual(capturedSession(CHILD).files, [rel(CHILD)]);
    assert.deepEqual(capturedSession(GRAND).files, [rel(GRAND, "21-49-00")]);
    assert.equal(SESSIONS_HELD().length, 3);
    // The run's own thread is read from Factory's captured copy, not from what the agent's home holds by now.
    appendFileSync(join(layout.sessions, rel(PARENT, "21-47-43")), named(PARENT, "01a1ce4d-0000-7000-8000-000000000009"));
    assert.equal((await subAgentThreads(PARENT, layout, process.env)).length, 2);
  } finally {
    dropSessions();
    rmSync(root, { recursive: true, force: true });
  }
});
