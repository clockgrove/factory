import "./temp.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DRIFT_MODEL, DRIFT_QUESTION, EVERY_MS, GOALS, WINDOW, driftLine, openDrift } from "../scripts/lib/drift.mjs";

const ROOT = "/work/app/.pendulum/7/repo";
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

test("a decider that throws never reaches the run: the harness's lines keep flowing", async () => {
  let t = 0;
  const drift = openDrift({ inputs: {}, decider: { name: "x", model: "x", decide: async () => { throw new Error("boom"); } }, now: () => t });
  const w = drift.watch({ stage: "work-1", goal: GOALS.work });
  t += EVERY_MS;
  for (let i = 0; i < WINDOW; i += 1) w.feed(codexCmd(`ls ${i}`));
  await w.stop();
  assert.equal(w.entries.length, WINDOW);
});

