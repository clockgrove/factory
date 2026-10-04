import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  objectiveComplete,
  assertTerminalEligibility,
  assertFinalAcceptance,
} from "../dist/completion.js";
import { submitAmendment, graphDigest } from "../dist/graph-amendments.js";
import { readState, saveState, statePath } from "../dist/state-store.js";
import { supervise } from "../dist/supervision.js";
import { statusDocument } from "../dist/diagnostics.js";
import {
  createTarget,
  factoryConfig,
  makeApplication,
  git,
  readEvents,
} from "./support/integration-fixture.mjs";

const discovery = {
  scope: "in-scope",
  reason: "Required integrated behavior needs independent QA",
  evidence: ["Implementation result needs integrated proof"],
  ownership: ["result.txt"],
  acceptance: ["result.txt exists at integrated head"],
  dependencies: ["result"],
};
const body =
  "## Acceptance\n- result.txt exists\n\n## Commands\n- test -s result.txt\n\n## Final validation\n- test -s result.txt\n";
function item(id = "result", dependencies = []) {
  return {
    kind: "work",
    id,
    title: id,
    goal: `Write ${id}.txt`,
    brief: `Write ${id}.txt`,
    acceptance: ["result.txt exists"],
    nonGoals: ["No unrelated changes"],
    citations: [{ path: "OBJECTIVE", heading: "Acceptance" }],
    dependencies,
    ownedPaths: [`${id}.txt`],
    resources: [],
    validation: [
      {
        command: "test -s result.txt",
        provenance: "source-declared",
        source: "OBJECTIVE",
      },
    ],
    sourceAssets: [],
    expectedOutputRoles: [],
    minimumAssetSets: 0,
    requiredLfsRoles: [],
  };
}
async function fixture(name, fn, delivery = "regular") {
  const root = mkdtempSync(join(tmpdir(), `factory-amend-${name}-`));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, "state");
  try {
    const target = createTarget(root);
    const config = factoryConfig(
      target.checkout,
      `example/amend-${name}`,
      delivery,
    );
    const initial = { objective: 1, baseSha: target.baseSha, items: [item()] };
    await fn({ root, config, initial, target });
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

function setupFixture({ config, initial, root }, resultReviewer) {
  return makeApplication({
    config,
    graph: initial,
    objectiveBody: body,
    fakeRoot: join(root, "fake"),
    resultReviewer,
    actions: { result: { files: [{ path: "result.txt", text: "done\n" }] } },
  });
}

test("sealed closure reconciles a lost acknowledgement on rerun without model replay", async () => {
  await fixture("closure", async (args) => {
    const setup = setupFixture(args);
    const close = setup.github.closeIssue.bind(setup.github);
    let calls = 0;
    setup.github.closeIssue = async (...parameters) => {
      if (parameters[0] === 1) {
        calls++;
        const pending = readState(args.config.repository, 1);
        assert.equal(pending.objectiveClosure, "pending");
        assert.equal(objectiveComplete(pending), false);
        await assert.rejects(
          setup.application.proposeAmendment(1, {
            ...discovery,
            actor: "operator",
            expectedGraphDigest: graphDigest(pending.graph),
          }),
          /busy|reconciliation/,
        );
        await assert.rejects(
          setup.application.cancelObjective(1),
          /sealed.*reconcile/,
        );
        await close(...parameters);
        if (calls === 1)
          throw new Error("Acknowledgement lost after remote closure");
        return;
      }
      return close(...parameters);
    };
    await assert.rejects(
      setup.application.runObjective(1),
      /Acknowledgement lost after remote closure/,
    );
    const pending = readState(args.config.repository, 1);
    assert.equal(pending.objectiveClosure, "pending");
    assert.equal(
      statusDocument(pending, args.config.repository, 1, "regular").state,
      "active",
    );
    const sealed = structuredClone(pending.finalAcceptance);
    const before = readEvents(setup.planningPath).length;
    const state = await setup.application.runObjective(1);
    assert.equal(objectiveComplete(state), true);
    assert.deepEqual(state.finalAcceptance, sealed);
    assert.equal(readEvents(setup.planningPath).length, before);
    assert.equal(calls, 2);
    assert.equal(
      statusDocument(state, args.config.repository, 1, "regular").state,
      "complete",
    );
    const historical = structuredClone(state);
    delete historical.finalAcceptance;
    saveState(statePath(args.config.repository, 1), historical);
    assert.equal(
      readState(args.config.repository, 1).finalAcceptance,
      undefined,
    );
    saveState(statePath(args.config.repository, 1), state);
    assert.throws(
      () =>
        submitAmendment(state, {
          ...discovery,
          actor: "operator",
          expectedGraphDigest: graphDigest(state.graph),
        }),
      /successor/,
    );
    for (const alter of [
      (s) => {
        s.integratedSha = "f".repeat(40);
      },
      (s) => {
        s.graph.items[0].acceptance.push("new requirement");
      },
      (s) => {
        s.configDigest = "e".repeat(64);
      },
      (s) => {
        s.finalValidation.criteria[0].detail = "changed evidence";
      },
    ]) {
      const changed = structuredClone(state);
      alter(changed);
      assert.throws(() => assertFinalAcceptance(changed), /binding/);
      assert.equal(objectiveComplete(changed), false);
    }
    for (const alter of [
      (s) => {
        s.work.result.githubClosure = "pending";
      },
      (s) => {
        // An interrupted delivery repeats its step; it is never terminal.
        s.work.result.status = "running";
        s.work.result.step = "deliver";
      },
      (s) => {
        s.coordinator.processes = [{ pid: 999, startTime: "1" }];
      },
      (s) => {
        s.finalAcceptancePending = { question: "human decision" };
      },
      (s) => {
        s.work.result.status = "published";
      },
      (s) => {
        s.finalValidation.criteria[0].verdict = "human-accept";
      },
    ]) {
      const changed = structuredClone(state);
      delete changed.finalAcceptance;
      alter(changed);
      assert.throws(() => assertTerminalEligibility(changed));
      assert.equal(objectiveComplete(changed), false);
    }
  });
});

test("remote default advancement during final review validates and reviews the new head before sealing", async () => {
  await fixture("remote-head", async (args) => {
    let finalReviews = 0;
    const setup = setupFixture(args, (request) => {
      if (
        request.invocation.phase === "objective-review" &&
        ++finalReviews === 1
      ) {
        const head = git(args.target.origin, "rev-parse", "refs/heads/main");
        git(args.config.checkout, "checkout", "--detach", head);
        writeFileSync(
          join(args.config.checkout, "outside.txt"),
          "external change\n",
        );
        git(args.config.checkout, "add", "outside.txt");
        git(
          args.config.checkout,
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.com",
          "commit",
          "-m",
          "external change",
        );
        git(args.config.checkout, "push", "origin", "HEAD:main");
      }
      return {
        packetId: request.reviewPacket.id,
        findings: request.reviewPacket.criteria.map(
          (criterion, criterionIndex) => ({
            criterionIndex,
            evidenceIndices: [0],
            verdict: "pass",
            detail: "Fixture acceptance",
            question: "",
          }),
        ),
      };
    });
    // Another contributor's push is not a fault: the new head is validated
    // and reviewed again, and only that head is sealed.
    const state = await setup.application.runObjective(1);
    assert.equal(finalReviews, 2);
    const head = git(args.target.origin, "rev-parse", "refs/heads/main");
    assert.equal(state.integratedSha, head);
    assert.equal(state.finalAcceptance.commit, head);
    assert.equal(state.objectiveClosure, "complete");
  });
});

test("supervisor owner verification distinguishes pending closure from completed acceptance", async () => {
  await fixture("service-closure", async (args) => {
    const setup = setupFixture(args);
    const completed = await setup.application.runObjective(1);
    const previousPath = process.env.PATH;
    const previousConfig = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = join(args.root, "user-config");
    const bin = join(args.root, "service-bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "systemctl"),
      '#!/bin/sh\ncase "$2" in is-system-running) echo running;; is-active) echo failed;; is-enabled) echo enabled;; show) echo 0;; esac\n',
      { mode: 0o700 },
    );
    writeFileSync(join(bin, "loginctl"), "#!/bin/sh\necho no\n", {
      mode: 0o700,
    });
    process.env.PATH = `${bin}:${process.env.PATH}`;
    const configPath = join(args.root, "factory.json");
    writeFileSync(configPath, JSON.stringify(args.config), { mode: 0o600 });
    try {
      const pending = structuredClone(completed);
      pending.objectiveClosure = "pending";
      saveState(statePath(args.config.repository, 1), pending);
      await supervise("install", configPath, { objective: 1 });
      await assert.rejects(
        supervise("start", configPath),
        /has not established its exact coordinator owner/,
      );
      assert.equal(
        readState(args.config.repository, 1).objectiveClosure,
        "pending",
      );
      saveState(statePath(args.config.repository, 1), completed);
      await supervise("start", configPath);
      assert.equal(
        objectiveComplete(readState(args.config.repository, 1)),
        true,
      );
    } finally {
      process.env.PATH = previousPath;
      if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousConfig;
    }
  });
});
