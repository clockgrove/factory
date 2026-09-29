import { resultFindings } from "./support/review-protocol.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { stateRoot } from "../dist/config.js";
import { readDiagnostics } from "../dist/diagnostics.js";
import {
  acquireControllerLock,
  releaseControllerLock,
  readState,
  saveState,
  statePath,
} from "../dist/state-store.js";
import {
  createTarget,
  factoryConfig,
  makeApplication,
  readEvents,
} from "./support/integration-fixture.mjs";

for (const delivery of ["regular", "native-stack"]) {
  test(`${delivery} explicit re-review preserves implementation and final run resumes automatic review`, async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-rereview-"));
    const previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = join(root, "state");
    try {
      const target = createTarget(root);
      const config = factoryConfig(
        target.checkout,
        "example/rereview",
        delivery,
      );
      const commands = ["test -s first.txt", "test -s second.txt"];
      const items = ["first", "second"].map((id, index) => ({
        id,
        title: id,
        goal: `Create ${id}.txt`,
        acceptance: [commands[index]],
        nonGoals: ["No deployment"],
        citations: [{ path: "OBJECTIVE", heading: "Acceptance" }],
        dependencies: index ? ["first"] : [],
        ownedPaths: [`${id}.txt`],
        resources: [],
        sourceAssets: [],
        expectedOutputRoles: [],
        minimumAssetSets: 0,
        requiredLfsRoles: [],
        validation: [
          {
            command: commands[index],
            provenance: "source-declared",
            source: "OBJECTIVE",
          },
        ],
        brief: `Create ${id}.txt only.`,
      }));
      let itemReviews = 0;
      let finalReviews = 0;
      const descriptor = {
        config,
        fakeRoot: join(root, "fake"),
        graph: { objective: 1, baseSha: target.baseSha, items },
        objectiveBody: `# Objective\n\n## Acceptance\n${commands.map((c) => "- `" + c + "`").join("\n")}\n\n## Final validation\n${commands.map((c) => "- `" + c + "`").join("\n")}\n`,
        actions: {
          first: { files: [{ path: "first.txt", text: "first\n" }] },
          second: { files: [{ path: "second.txt", text: "second\n" }] },
        },
        resultReviewer(request) {
          const current = JSON.parse(request.observations).reviewedItemId;
          if (current === "second" && ++itemReviews === 1)
            throw new Error("Provider turn produced no progress for 900000 ms");
          if (!current && ++finalReviews === 1)
            throw new Error("Provider turn produced no progress for 900000 ms");
          return {
            findings: resultFindings(
              request,
              request.criteria.map((criterion) => ({
                criterion,
                verdict: "pass",
                source: "Command pass evidence",
                quote: request.commands[0].command,
                detail: "Exact-tree command passed",
                question: "",
              })),
            ),
          };
        },
      };
      const { application, eventsPath } = makeApplication(descriptor);
      const waiting = await application.runObjective(1);
      assert.equal(waiting.work.second.status, "waiting");
      assert.equal(waiting.work.second.step, "approve-result");
      assert.match(waiting.work.second.acceptancePending.detail, /no progress/);
      assert.equal(
        waiting.work.first.status,
        delivery === "regular" ? "done" : "published",
      );
      const identities = structuredClone(waiting.work);
      const path = statePath(config.repository, 1);
      const input = {
        item: "second",
        treeSha: waiting.work.second.treeSha,
        actor: "operator",
        reason: "Inspected stopped review; request automatic evaluation again",
      };
      const before = readFileSync(path, "utf8");
      const priorDiagnostics = readDiagnostics(config.repository, 1);
      assert.throws(
        () =>
          application.rereviewWorkItem(1, {
            ...input,
            treeSha: "0".repeat(40),
          }),
        /tree differs/,
      );
      assert.equal(readFileSync(path, "utf8"), before);
      const lockPath = join(stateRoot(config.repository), "controller.lock");
      const lock = acquireControllerLock(lockPath, 1);
      try {
        assert.throws(
          () => application.rereviewWorkItem(1, input),
          /already owns/,
        );
      } finally {
        releaseControllerLock(lockPath, lock);
      }
      assert.equal(readFileSync(path, "utf8"), before);
      for (const mutate of [
        (s) => {
          s.configDigest = "0".repeat(64);
        },
        (s) => {
          s.work.second.step = "deliver";
        },
        (s) => {
          s.cancelledAt = new Date().toISOString();
        },
        (s) => {
          s.error = "refused run";
        },
        (s) => {
          delete s.work.second.acceptancePending;
        },
        (s) => {
          s.work.second.pullRequest = 99;
        },
        (s) => {
          s.work.second.acceptanceDecisions = [
            {
              criterion: commands[1],
              treeSha: input.treeSha,
              actor: "owner",
              at: new Date().toISOString(),
              outcome: "refuse",
              reason: "Rejected",
            },
          ];
        },
      ]) {
        const altered = structuredClone(waiting);
        mutate(altered);
        saveState(path, altered);
        const invalid = readFileSync(path, "utf8");
        assert.throws(() => application.rereviewWorkItem(1, input));
        assert.equal(readFileSync(path, "utf8"), invalid);
      }
      saveState(path, waiting);
      const configPath = join(root, "factory.json");
      writeFileSync(configPath, JSON.stringify(config));
      const cli = execFileSync(
        process.execPath,
        [
          resolve("dist/cli.js"),
          "rereview",
          "--objective",
          "1",
          "--item",
          input.item,
          "--tree",
          input.treeSha,
          "--actor",
          input.actor,
          "--reason",
          input.reason,
          "--config",
          configPath,
        ],
        { encoding: "utf8" },
      );
      assert.match(cli, /ready for validation and automatic review/);
      assert.equal(itemReviews, 1);
      const requested = readState(config.repository, 1);
      assert.deepEqual(requested.work.first, identities.first);
      const expected = {
        ...identities.second,
        status: "running",
        step: "validate",
      };
      delete expected.acceptancePending;
      assert.deepEqual(requested.work.second, expected);
      const finalWaiting = await application.runObjective(1);
      assert.equal(itemReviews, 2);
      assert.ok(finalWaiting.finalAcceptancePending);
      assert.ok(
        finalWaiting.work.second.validation.criteria.every(
          (c) => c.verdict === "pass",
        ),
      );
      assert.equal(finalWaiting.work.second.attempt, identities.second.attempt);
      assert.equal(
        finalWaiting.work.second.changeRef,
        identities.second.changeRef,
      );
      assert.equal(finalWaiting.work.second.treeSha, identities.second.treeSha);
      const completed = await application.runObjective(1);
      assert.equal(finalReviews, 2);
      assert.equal(completed.objectiveClosure, "complete");
      assert.equal(completed.finalAcceptancePending, undefined);
      assert.equal(completed.finalAcceptanceDecisions, undefined);
      assert.equal(completed.work.second.acceptanceDecisions, undefined);
      assert.equal(
        readEvents(eventsPath).filter((e) => e.type === "start").length,
        2,
      );
      const timeline = readDiagnostics(config.repository, 1);
      assert.deepEqual(
        timeline.slice(0, priorDiagnostics.length),
        priorDiagnostics,
      );
      assert.ok(
        timeline.some(
          (e) =>
            e.operation === "result-rereview-request" &&
            e.attemptId === identities.second.attempt &&
            e.metadata.actor === input.actor,
        ),
      );
      const finished = readFileSync(path, "utf8");
      assert.throws(
        () => application.rereviewWorkItem(1, input),
        /not awaiting/,
      );
      assert.equal(readFileSync(path, "utf8"), finished);
    } finally {
      if (previous === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
}
