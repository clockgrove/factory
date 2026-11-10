import assert from "node:assert/strict";
import { test } from "node:test";
import { DRIFT_MODEL, DRIFT_QUESTION, EVERY_MS, GOALS, MIN_CONFIDENCE, WINDOW, activityLog, driftInput, driftLine, isDrift, openDrift, planItems } from "../scripts/lib/drift.mjs";
import { scrubbedEnv } from "../scripts/lib/harness.mjs";
import { resolveInputs } from "../scripts/lib/inputs.mjs";
import { liveActivity } from "../scripts/lib/session.mjs";

const ROOT = "/work/app/.factory/7/repo";
const j = (o) => JSON.stringify(o);
// One Codex command per call: `cmd` with its exit code.
const codexCmd = (cmd, exit = 0) => j({ type: "item.completed", item: { type: "command_execution", command: `/bin/bash -lc '${cmd}'`, exit_code: exit, aggregated_output: "" } });
const codexEdit = (path) => j({ type: "item.completed", item: { type: "file_change", changes: [{ path, kind: "update" }] } });

/** A decider that answers from a script and records each question. */
function scripted(answers) {
  const calls = [];
  return {
    calls,
    decider: {
      name: "script",
      model: "script",
      async decide(input, question) {
        calls.push({ input, question });
        return answers.length ? answers.shift() : { verdict: "on_task", confidence: 0.9 };
      },
    },
  };
}

/** A progress reporter that keeps its lines. */
function fakeProgress() {
  const lines = [];
  const progress = async (l) => {
    lines.push(l);
  };
  progress.live = () => {};
  return { progress, lines };
}

test("the question, the model and the threshold are the ones the replay measured", () => {
  assert.equal(DRIFT_MODEL, "baseten/elephant-1");
  assert.equal(MIN_CONFIDENCE, 0.7);
  assert.equal(EVERY_MS, 120_000, "no more often than the progress comment's activity line");
  assert.deepEqual(DRIFT_QUESTION.choices.map((c) => c.value), ["on_task", "scope_creep", "looping"]);
  assert.equal(isDrift({ verdict: "scope_creep", confidence: 0.7 }), true);
  assert.equal(isDrift({ verdict: "looping", confidence: 0.84 }), true);
  assert.equal(isDrift({ verdict: "looping", confidence: 0.69 }), false);
  assert.equal(isDrift({ verdict: "scope_creep", confidence: null }), false, "no confidence is not enough");
  assert.equal(isDrift({ verdict: "on_task", confidence: 0.99 }), false);
  assert.equal(isDrift({ verdict: null, confidence: null, error: "auth" }), false);
});

test("planItems: the plan's checklist items up to the next heading; a plan with none gives its first lines", () => {
  const plan = "## Plan\n\n- [x] 1. Registry (`src/a.ts`): typed capabilities\n- [ ] 2. Web rail\n  detail line\n1. [ ] Proofs\n\n## Assumptions\n- [ ] not an item\n";
  assert.deepEqual(planItems(plan), ["1. Registry (`src/a.ts`): typed capabilities", "2. Web rail", "Proofs"]);
  assert.deepEqual(planItems("<!-- marker -->\nFix the red.\n\nThen push."), ["Fix the red.", "Then push."]);
  assert.deepEqual(planItems(null), []);
  assert.equal(planItems(`- [ ] ${"x".repeat(300)}`)[0].length, 200);
  assert.equal(planItems(Array.from({ length: 12 }, (_, i) => `- [ ] item ${i}`).join("\n")).length, 8);
});

test("activityLog: one entry per call, edit and message from each harness's own events, failures by its own fields", () => {
  const a = activityLog();
  // Claude: a Bash call that errors, an Edit, a sub-agent, a message.
  a.feed(j({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: `cd ${ROOT} && pnpm test` } }, { type: "text", text: "Running   the tests." }] } }));
  a.feed(j({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "Exit code 1" }] } }));
  a.feed(j({ type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Edit", input: { file_path: `${ROOT}/src/a.ts` } }, { type: "tool_use", id: "t3", name: "Task", input: { description: "write the proofs" } }] } }));
  // Codex: a failed command, a file change, a message.
  a.feed(codexCmd("rg -n foo src", 1));
  a.feed(codexEdit(`${ROOT}/scripts/ci/toolchain.sh`));
  a.feed(j({ type: "item.completed", item: { type: "agent_message", text: "The download host is blocked." } }));
  // Copilot: a shell call whose exit code fails it, an edit.
  a.feed(j({ type: "tool.execution_start", data: { toolName: "bash", toolCallId: "c1", arguments: { command: "psql -c 'select 1'" } } }));
  a.feed(j({ type: "tool.execution_complete", data: { toolCallId: "c1", success: true, shellExecution: { exitCode: 2 } } }));
  a.feed(j({ type: "tool.execution_start", data: { toolName: "edit", toolCallId: "c2", arguments: { path: `${ROOT}/README.md` } } }));
  a.feed("not json");
  a.feed(j({ type: "turn.completed", usage: {} }));
  const input = driftInput({ stage: "validation-fix-1", goal: GOALS.fix, items: ["Registry"], entries: a.entries, root: ROOT });
  assert.equal(
    input,
    [
      `Stage: validation-fix-1 (goal: ${GOALS.fix}). Checkpoint after 9 tool calls.`,
      "Plan items:",
      "1. Registry",
      "",
      "Recent activity, oldest first:",
      "- $ pnpm test  -> failed",
      "- agent says: Running the tests.",
      "- edit src/a.ts",
      "- sub-agent Task: write the proofs",
      "- $ rg -n foo src  -> failed (exit 1)",
      "- edit scripts/ci/toolchain.sh",
      "- agent says: The download host is blocked.",
      "- $ psql -c 'select 1'  -> failed (exit 2)",
      "- edit README.md",
      "",
      "Files touched so far: src/a.ts, scripts/ci/toolchain.sh, README.md",
    ].join("\n"),
  );
  // Only the last WINDOW entries are shown; files touched are the checkout's own, latest last, each once.
  const b = activityLog();
  b.feed(codexEdit(`${ROOT}/a.ts`));
  b.feed(codexEdit("/tmp/scratch/x.ts"));
  for (let i = 0; i < 20; i += 1) b.feed(codexCmd(`echo ${i}`));
  b.feed(codexEdit(`${ROOT}/b.ts`));
  b.feed(codexEdit(`${ROOT}/a.ts`));
  const shown = driftInput({ stage: "work-1", goal: GOALS.work, entries: b.entries, root: ROOT });
  assert.equal(shown.split("\n").filter((l) => l.startsWith("- ")).length, WINDOW);
  assert.match(shown, /Plan items:\n\nRecent activity/);
  assert.match(shown, /Files touched so far: b\.ts, a\.ts$/);
});

test("a checkpoint: no sooner than the clock and the window allow, one call each, a drift line once per run", async () => {
  let t = 0;
  const { decider, calls } = scripted([{ verdict: "on_task", confidence: 0.95 }, { verdict: "scope_creep", confidence: 0.84 }]);
  const { progress, lines } = fakeProgress();
  const drift = openDrift({ inputs: {}, decider, progress, now: () => t });
  const w = drift.watch({ stage: "validation-fix-1", goal: GOALS.fix, root: ROOT, plan: () => "- [ ] Renderer\n- [ ] Proofs" });
  const settle = () => new Promise((r) => setImmediate(r));
  // Fewer entries than the window: no question, however long it runs.
  for (let i = 0; i < WINDOW - 1; i += 1) w.feed(codexCmd(`echo ${i}`));
  t = 10 * EVERY_MS;
  w.feed(j({ type: "turn.started" }));
  await settle();
  assert.equal(calls.length, 0);
  // The window is full and the clock has run: one question, with the plan's items and the stage's goal.
  w.feed(codexCmd("pnpm test"));
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].question, DRIFT_QUESTION);
  assert.match(calls[0].input, /^Stage: validation-fix-1 \(goal: fix the red required check/);
  assert.match(calls[0].input, /Plan items:\n1\. Renderer\n2\. Proofs\n/);
  assert.deepEqual(lines, [], "on_task writes nothing on the progress comment");
  // Inside the interval: nothing, whatever the harness does.
  t += EVERY_MS - 1;
  w.feed(codexEdit(`${ROOT}/scripts/ci/toolchain.sh`));
  await settle();
  assert.equal(calls.length, 1);
  // The interval since the last question has run and there is something new: the next line is a checkpoint.
  t += 1;
  w.feed(codexCmd("git add scripts/ci/toolchain.sh"));
  await settle();
  assert.equal(calls.length, 2);
  assert.match(calls[1].input, /Files touched so far: scripts\/ci\/toolchain\.sh$/);
  assert.deepEqual(lines, [driftLine({ stage: "validation-fix-1", model: DRIFT_MODEL, verdict: "scope_creep", confidence: 0.84, entries: 14 })]);
  assert.equal(lines[0], `drift advisory (${DRIFT_MODEL}): scope_creep 0.84 in validation-fix-1 after 14 activity entries; advice only, the run goes on`);
  // Flagged once: the rest of the run asks nothing more.
  for (let i = 0; i < 5; i += 1) {
    t += EVERY_MS;
    w.feed(codexCmd(`echo again ${i}`));
  }
  await settle();
  assert.equal(calls.length, 2);
  await w.stop();
  // The next run (another stage) is watched afresh.
  const w2 = drift.watch({ stage: "validation-fix-2", goal: GOALS.fix, root: ROOT });
  for (let i = 0; i < WINDOW; i += 1) w2.feed(codexCmd(`echo ${i}`));
  t += EVERY_MS;
  w2.feed(codexCmd("echo last"));
  await settle();
  assert.equal(calls.length, 3);
  assert.match(calls[2].input, /Plan items:\n\nRecent/, "no plan yet: no items");
  // The interval has run again with no new activity entry: nothing to ask about.
  t += EVERY_MS;
  w2.feed(j({ type: "turn.started" }));
  await settle();
  assert.equal(calls.length, 3);
});

test("below the threshold, no verdict or a stopped run: no line; a refused key stops the questions for the job", async () => {
  let t = 0;
  const { decider, calls } = scripted([{ verdict: "looping", confidence: 0.69 }, { verdict: null, confidence: null, error: "unavailable" }, { verdict: null, confidence: null, error: "auth" }]);
  const { progress, lines } = fakeProgress();
  const drift = openDrift({ inputs: {}, decider, progress, now: () => t });
  const w = drift.watch({ stage: "work-1", goal: GOALS.work, root: ROOT });
  const settle = () => new Promise((r) => setImmediate(r));
  const burst = async () => {
    t += EVERY_MS;
    for (let i = 0; i < WINDOW; i += 1) w.feed(codexCmd(`ls ${i}`, 2));
    await settle();
  };
  await burst();
  await burst();
  await burst();
  assert.equal(calls.length, 3);
  assert.deepEqual(lines, []);
  // `auth`: no further question in this job, in this run or the next.
  await burst();
  const w2 = drift.watch({ stage: "answer", goal: GOALS.answer, root: ROOT });
  t += EVERY_MS;
  for (let i = 0; i < 2 * WINDOW; i += 1) w2.feed(codexCmd(`ls ${i}`));
  await settle();
  assert.equal(calls.length, 3);
  // A stopped run asks nothing more.
  const fresh = scripted([]);
  const w3 = openDrift({ inputs: {}, decider: fresh.decider, progress, now: () => t }).watch({ stage: "work-1", goal: GOALS.work });
  await w3.stop();
  t += EVERY_MS;
  for (let i = 0; i < 2 * WINDOW; i += 1) w3.feed(codexCmd(`ls ${i}`));
  await settle();
  assert.equal(fresh.calls.length, 0);
});

test("a decider that throws never reaches the run: the harness's lines keep flowing", async () => {
  let t = 0;
  const drift = openDrift({ inputs: {}, decider: { name: "x", model: "x", decide: async () => { throw new Error("boom"); } }, now: () => t });
  const w = drift.watch({ stage: "work-1", goal: GOALS.work });
  t += EVERY_MS;
  for (let i = 0; i < WINDOW; i += 1) w.feed(codexCmd(`ls ${i}`));
  await w.stop();
  assert.equal(w.entries.length, WINDOW);
});

test("liveActivity feeds the watcher every harness line and stops it when the run finishes", async () => {
  const fed = [];
  let stopped = 0;
  const { progress } = fakeProgress();
  const live = liveActivity(progress, { harness: "codex", model: "m", drift: { feed: (l) => fed.push(l), stop: () => (stopped += 1) } });
  live.onLine(codexCmd("ls"));
  live.onLine("plain text");
  live.finish();
  assert.deepEqual(fed, [codexCmd("ls"), "plain text"]);
  assert.equal(stopped, 1);
  // No watcher (no key): today's path.
  const off = liveActivity(progress, { harness: "codex", model: "m" });
  off.onLine(codexCmd("ls"));
  off.finish();
});

test("no key: no drift advisory; the model is its own setting, apart from triage's", () => {
  const actions = { GITHUB_ACTIONS: "true" };
  assert.equal(openDrift({ inputs: {}, env: actions }), null, "no key: today's path");
  assert.equal(openDrift({ inputs: { aiGatewayApiKey: "" }, env: actions }), null);
  assert.equal(openDrift({ inputs: { aiGatewayApiKey: "k" }, env: actions }).model, DRIFT_MODEL);
  assert.equal(openDrift({ inputs: { aiGatewayApiKey: "k", triageModel: "t/m", driftModel: "d/m" }, env: actions }).model, "d/m");
  assert.equal(resolveInputs({ env: { FACTORY_DRIFT_MODEL: "a/b" } }).driftModel, "a/b");
  assert.equal(resolveInputs({ env: { FACTORY_INPUT_DRIFT_MODEL: " c/d " } }).driftModel, "c/d");
  assert.equal(resolveInputs({ env: {} }).driftModel, "");
  // The key stays out of every child under each name; the model setting is no secret.
  assert.deepEqual(Object.keys(scrubbedEnv({ AI_GATEWAY_API_KEY: "k", FACTORY_INPUT_AI_GATEWAY_API_KEY: "k", FACTORY_AI_GATEWAY_API_KEY: "k", FACTORY_DRIFT_MODEL: "m" })), ["FACTORY_DRIFT_MODEL"]);
});
