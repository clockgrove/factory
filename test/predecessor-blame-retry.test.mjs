// Retry after a predecessor-blame stop starts a new attempt on the integrated head (#672).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readContinuation, readState } from "../dist/state-store.js";
import {
  createTarget,
  factoryConfig,
  makeApplication,
  ScriptedPlanningModel,
} from "./support/integration-fixture.mjs";

const bodyWith = (command) =>
  `## Acceptance\n- result.txt exists\n\n## Commands\n- \`test -s result.txt\`\n- \`${command}\`\n\n## Final validation\n- \`test -s result.txt\`\n`;
const workItem = (id, file, dependencies, command) => ({
  id,
  title: id,
  kind: "work",
  goal: `Write ${file}`,
  brief: `Write ${file}`,
  acceptance: [`${file} exists`],
  nonGoals: ["No unrelated changes"],
  citations: [{ path: "OBJECTIVE", heading: "Acceptance" }],
  dependencies,
  ownedPaths: [file],
  resources: [],
  validation: [{ command, provenance: "source-declared", source: "OBJECTIVE" }],
  sourceAssets: [],
  expectedOutputRoles: [],
  minimumAssetSets: 0,
  requiredLfsRoles: [],
});
const autonomy = {
  allowances: {
    planningRevisions: 2,
    implementationRepairs: 2,
    resultRereviews: 2,
  },
  repairClasses: ["implementation"],
  repairPolicy: {
    perPath: {
      planningRevisions: 2,
      implementationRepairs: 2,
      resultRereviews: 2,
    },
  },
  requiredEnvironment: [],
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
  for (let n = 0; n < 3000; n++) {
    if (check()) return;
    await delay(10);
  }
  throw new Error("Fixture condition not reached");
}

/**
 * result (merged, writes result.txt) then next (depends on it). A diagnosis
 * always blames result.txt on result. `nextValidation` is next's own command.
 */
async function fixture(name, nextValidation, run) {
  const root = mkdtempSync(join(tmpdir(), "factory-blame-retry-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, "state");
  try {
    const target = createTarget(root);
    const config = {
      ...factoryConfig(target.checkout, `example/blame-${name}`, "regular", 1),
      autonomy,
    };
    const graph = {
      objective: 1,
      baseSha: target.baseSha,
      items: [
        workItem("result", "result.txt", [], "test -s result.txt"),
        workItem("next", "next.txt", ["result"], nextValidation),
      ],
    };
    const fakeRoot = join(root, "fake");
    const scripted = new ScriptedPlanningModel(
      graph,
      join(fakeRoot, "planning.ndjson"),
    );
    let diagnoses = 0;
    const planningModel = Object.create(scripted);
    planningModel.generateStructured = async (request) => {
      if (request.purpose !== "diagnosis")
        return scripted.generateStructured(request);
      diagnoses++;
      return {
        decision: "predecessor",
        diagnosis: "result.txt holds the wrong content",
        correction: "",
        predecessor: "result",
        path: "result.txt",
      };
    };
    const setup = makeApplication({
      config,
      graph,
      objectiveBody: bodyWith(nextValidation),
      fakeRoot,
      planningModel,
      actions: {
        result: { files: [{ path: "result.txt", text: "bad\n" }] },
        next: { files: [{ path: "next.txt", text: "done\n" }] },
      },
    });
    // The first PR (result) passes its checks; later ones wait for the test.
    const { github } = setup;
    const publish = github.publish.bind(github);
    let published = 0;
    github.publish = async (request) => {
      const result = await publish(request);
      if (++published > 1)
        github.update((state) => {
          state.pullRequests[result.number].checks = "pending";
        });
      return result;
    };
    const checks = (number, value) =>
      github.update((state) => {
        state.pullRequests[number].checks = value;
      });
    await run({
      ...setup,
      config,
      checks,
      diagnoses: () => diagnoses,
    });
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
}
const stateOf = (f) => readState(f.config.repository, 1);

test("retry after a blame stop at validation starts a new attempt on the integrated head", async () =>
  fixture(
    "validate",
    // next's own file is fine; the predecessor's content is not.
    'test "$(cat result.txt)" = good',
    async (f) => {
      await f.application.runObjective(1);
      const stopped = stateOf(f);
      assert.equal(stopped.work.result.status, "done");
      assert.equal(stopped.work.next.status, "failed");
      assert.equal(stopped.work.next.step, "validate");
      assert.equal(
        stopped.work.next.recovery.failure.predecessor.item,
        "result",
      );
      assert.equal(f.diagnoses(), 1);
      const first = stopped.work.next.attempt;

      // The same attempt would fail and be blamed again: retry starts a new one.
      assert.equal(f.application.retryWorkItem(1, "next"), "attempt");
      const retried = stateOf(f);
      assert.equal(retried.work.next.status, "pending");
      assert.equal(
        retried.work.next.recovery.history.at(-1).work.attempt,
        first,
      );

      await f.application.runObjective(1);
      const again = stateOf(f);
      assert.equal(f.diagnoses(), 2, "the new attempt ran and was diagnosed");
      assert.notEqual(again.work.next.attempt, first);
      assert.equal(again.work.next.baseSha, again.work.result.integratedSha);
    },
  ));

test("retry after a blame stop of a published item whose check failed starts a new attempt", async () =>
  fixture(
    "published",
    // next passes its own validation; CI fails on the predecessor's file.
    "test -s next.txt",
    async (f) => {
      const running = f.application.runObjective(1);
      await until(() => {
        const next = readContinuation(f.config.repository, 1)?.work?.next;
        return next?.status === "published" && next.wait?.kind === "ci";
      });
      const published = stateOf(f).work.next;
      f.checks(published.pullRequest, "failing");
      await running;
      const stopped = stateOf(f);
      assert.equal(stopped.work.next.status, "failed");
      assert.equal(stopped.work.next.pullRequest, published.pullRequest);
      assert.equal(
        stopped.work.next.recovery.failure.predecessor.item,
        "result",
      );
      assert.equal(f.diagnoses(), 1);

      // Not a resumed delivery of the same PR head: that would fail again.
      assert.equal(f.application.retryWorkItem(1, "next"), "attempt");
      const retried = stateOf(f);
      assert.equal(retried.work.next.status, "pending");
      assert.equal(
        retried.work.next.recovery.history.at(-1).work.pullRequest,
        published.pullRequest,
      );

      const again = f.application.runObjective(1);
      await until(() => {
        const next = readContinuation(f.config.repository, 1)?.work?.next;
        return next?.status === "published" && next.wait?.kind === "ci";
      });
      const second = stateOf(f);
      assert.notEqual(second.work.next.attempt, published.attempt);
      assert.notEqual(second.work.next.changeRef, published.changeRef);
      assert.equal(second.work.next.baseSha, second.work.result.integratedSha);
      f.checks(second.work.next.pullRequest, "passing");
      assert.equal((await again).finalValidation.passed, true);
    },
  ));
