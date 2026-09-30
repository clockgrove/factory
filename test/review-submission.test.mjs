import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalContentStore } from "../dist/content/local.js";
import { runNativeGraph } from "../dist/delivery/native-runner.js";
import { runRegularGraph } from "../dist/delivery/regular-runner.js";
import { phaseAdmission } from "../dist/phase-admission.js";
import { runQaItem } from "../dist/qa-execution.js";
import { coverageObligations } from "../dist/qa.js";
import { objectiveCriteria } from "../dist/compiler.js";
import { readState, statePath } from "../dist/state-store.js";
import { reviewAcceptance, validateWorkItem } from "../dist/validation.js";
import {
  createTarget,
  factoryConfig,
  git,
  makeApplication,
} from "./support/integration-fixture.mjs";
import { withCoverage } from "./support/coverage.mjs";
import { resultFindings } from "./support/review-protocol.mjs";

const body =
  "## Acceptance\n- result.txt exists\n\n## Commands\n- test -s result.txt\n\n## Final validation\n- test -s result.txt\n";
function item(id, kind = "work", dependencies = []) {
  return {
    id,
    kind,
    children: [],
    title: id,
    goal: id,
    brief: id,
    acceptance: [
      kind === "qa" ? "integrated result.txt exists" : "result.txt exists",
    ],
    nonGoals: ["No unrelated changes"],
    citations: [{ path: "OBJECTIVE", heading: "Acceptance" }],
    dependencies,
    ownedPaths: kind === "qa" ? [] : ["result.txt"],
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
async function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "factory-review-submission-"));
  const oldState = process.env.XDG_STATE_HOME;
  const oldPath = process.env.PATH;
  process.env.XDG_STATE_HOME = join(root, "state");
  try {
    await run(root);
  } finally {
    if (oldState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = oldState;
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
  }
}
function commitResult(target) {
  writeFileSync(join(target.checkout, "result.txt"), "done\n");
  git(target.checkout, "add", "result.txt");
  git(
    target.checkout,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "Factory: result",
  );
  return {
    commit: git(target.checkout, "rev-parse", "HEAD"),
    treeSha: git(target.checkout, "rev-parse", "HEAD^{tree}"),
  };
}
function accounting(state) {
  return structuredClone({
    allowanceConsumption: state.allowanceConsumption,
    repairConsumption: state.repairConsumption,
  });
}
function pass(request) {
  return {
    packetId: request.reviewPacket.id,
    findings: resultFindings(
      request,
      request.criteria.map((criterion) => ({
        criterion,
        source: "OBJECTIVE",
        verdict: "pass",
        detail: "Fixture verifies the exact supplied result",
        question: "",
      })),
    ),
  };
}
// Fault only the exact inventory command; hydration, validation and Git identity checks remain real.
function failInventory(root) {
  const previousGit = execFileSync("which", ["git"], {
    encoding: "utf8",
  }).trim();
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const bin = join(root, "inventory-fault");
  mkdirSync(bin);
  const path = join(bin, "git");
  writeFileSync(
    path,
    `#!/bin/sh\ncase " $* " in\n  *" ls-tree -r --name-only -z "*) exit 91 ;;\nesac\nexec ${quote(previousGit)} "$@"\n`,
  );
  chmodSync(path, 0o755);
  process.env.PATH = `${bin}:${process.env.PATH}`;
}

for (const failure of [
  "dependency hydration",
  "packet inventory",
  "marker save",
  "unknown model response",
])
  test(`QA ${failure} preserves the actual submission and reservation boundary`, async () =>
    fixture(async (root) => {
      const target = createTarget(root);
      const config = factoryConfig(
        target.checkout,
        `example/submission-qa-${failure.replaceAll(" ", "-")}`,
      );
      const result = commitResult(target);
      const integratedSha = git(
        target.checkout,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit-tree",
        result.treeSha,
        "-p",
        target.baseSha,
        "-p",
        result.commit,
        "-m",
        "Merge result",
      );
      const dependency = item("result");
      const dependencyEvidence = await validateWorkItem(
        target.checkout,
        join(root, "dependency-validation"),
        dependency,
        result.commit,
        result.treeSha,
        target.baseSha,
      );
      const qa = item("qa", "qa", ["result"]);
      const state = {
        baseSha: target.baseSha,
        integratedSha,
        graph: {
          objective: 1,
          baseSha: target.baseSha,
          items: [dependency, qa],
          coverage: [],
        },
        work: {
          result: {
            status: "done",
            executionBaseSha: target.baseSha,
            baseSha: target.baseSha,
            changeRef: result.commit,
            treeSha: result.treeSha,
            integratedSha,
            validation: dependencyEvidence,
          },
          qa: { status: "pending" },
        },
        allowanceConsumption: {
          planningRevisions: 1,
          implementationRepairs: 0,
          resultRereviews: 0,
        },
        repairConsumption: {},
      };
      const before = accounting(state);
      const snapshots = [];
      let saveFailed = false;
      const save = () => {
        if (
          failure === "marker save" &&
          state.work.qa.pendingEffect === "review" &&
          !saveFailed
        ) {
          saveFailed = true;
          throw new Error("Review marker save failed");
        }
        snapshots.push(structuredClone(state));
      };
      const phases = phaseAdmission(config, state, save, () => false);
      let submissions = 0;
      const model = {
        async reviewResult() {
          submissions++;
          assert.equal(state.work.qa.pendingEffect, "review");
          assert.equal(state.work.qa.phaseReservation, "review");
          assert.equal(snapshots.at(-1).work.qa.pendingEffect, "review");
          throw new Error("Review response was lost after model entry");
        },
      };
      if (failure === "dependency hydration")
        delete state.work.result.changeRef;
      if (failure === "packet inventory") failInventory(root);
      await assert.rejects(
        runQaItem({
          config,
          root,
          state,
          item: qa,
          github: {},
          model,
          objectiveBody: body,
          store: new LocalContentStore(join(root, "content")),
          save,
          cancelled: () => false,
          phases,
        }),
        failure === "dependency hydration"
          ? /Dependency result lacks a completed delivery result/
          : failure === "packet inventory"
            ? /Cannot inventory exact result tree/
            : failure === "marker save"
              ? /Review marker save failed/
              : /Review response was lost/,
      );
      assert.ok(
        snapshots.some(
          (snapshot) => snapshot.work.qa.phaseReservation === "review",
        ),
      );
      const unknown = failure === "unknown model response";
      assert.equal(submissions, unknown ? 1 : 0);
      assert.equal(state.work.qa.pendingEffect, unknown ? "review" : undefined);
      assert.equal(
        state.work.qa.phaseReservation,
        unknown ? "review" : undefined,
      );
      assert.equal(state.work.qa.requestedPhase, undefined);
      assert.equal(
        snapshots.at(-1).work.qa.pendingEffect,
        unknown ? "review" : undefined,
      );
      assert.equal(
        snapshots.at(-1).work.qa.phaseReservation,
        unknown ? "review" : undefined,
      );
      assert.equal(state.work.qa.status, "failed");
      assert.deepEqual(accounting(state), before);
      if (!unknown)
        assert.ok(
          snapshots.every(
            (snapshot) => snapshot.work.qa.pendingEffect === undefined,
          ),
        );
      else {
        await assert.rejects(
          runQaItem({
            config,
            root,
            state,
            item: qa,
            github: {},
            model,
            objectiveBody: body,
            store: new LocalContentStore(join(root, "content")),
            save,
            cancelled: () => false,
            phases,
          }),
          /unknown outcome/,
        );
        assert.equal(submissions, 1);
        assert.equal(state.work.qa.phaseReservation, "review");
      }
    }));

for (const failure of ["selected LFS", "Git change", "packet digest"])
  test(`reviewAcceptance ${failure} preparation never invokes beforeSubmit or the model`, async () =>
    fixture(async (root) => {
      const target = createTarget(root);
      const result = commitResult(target);
      let markers = 0;
      let submissions = 0;
      const args = {
        checkout: target.checkout,
        baseSha: target.baseSha,
        commit: result.commit,
        evidence: { treeSha: result.treeSha, commands: [] },
        criteria: ["result.txt exists"],
        sources: [{ path: "OBJECTIVE", content: body }],
        beforeSubmit() {
          markers++;
        },
        model: {
          async reviewResult() {
            submissions++;
            throw new Error("Unexpected submission");
          },
        },
      };
      if (failure === "selected LFS")
        args.evidence.selectedLfs = [
          {
            treeSha: "0".repeat(40),
            destination: "asset.bin",
            digest: "a".repeat(64),
            bytes: 1,
            filter: "lfs",
          },
        ];
      if (failure === "Git change") args.baseSha = "0".repeat(40);
      if (failure === "packet digest")
        args.evidenceSources = [
          { path: "Invalid local evidence", content: undefined },
        ];
      await assert.rejects(
        reviewAcceptance(args),
        failure === "selected LFS"
          ? /Selected LFS validation evidence differs/
          : failure === "Git change"
            ? /git/
            : /data.*argument/i,
      );
      assert.equal(markers, 0);
      assert.equal(submissions, 0);
    }));

for (const delivery of ["regular", "native"])
  for (const failure of ["marker save", "unknown model response"])
    test(`${delivery} coding ${failure} uses the production submission callback`, async () =>
      fixture(async (root) => {
        const target = createTarget(root);
        const config = factoryConfig(
          target.checkout,
          `example/submission-${delivery}-${failure.replaceAll(" ", "-")}`,
          delivery,
          1,
        );
        const result = commitResult(target);
        const workItem = item("result");
        const state = {
          baseSha: target.baseSha,
          graph: {
            objective: 1,
            baseSha: target.baseSha,
            items: [workItem],
            coverage: [],
          },
          work: {
            result: {
              status: "running",
              step: "validate",
              attempt: "fixture-attempt",
              executionBaseSha: target.baseSha,
              baseSha: target.baseSha,
              changeRef: result.commit,
              treeSha: result.treeSha,
            },
          },
          allowanceConsumption: {
            planningRevisions: 0,
            implementationRepairs: 0,
            resultRereviews: 0,
          },
          repairConsumption: {},
        };
        const before = accounting(state);
        let submissions = 0;
        let markerSaveFailed = false;
        const snapshots = [];
        const save = () => {
          if (
            failure === "marker save" &&
            state.work.result.pendingEffect === "review" &&
            !markerSaveFailed
          ) {
            markerSaveFailed = true;
            throw new Error("Review marker save failed");
          }
          snapshots.push(structuredClone(state));
        };
        const runner =
          delivery === "regular" ? runRegularGraph : runNativeGraph;
        const args = {
          config,
          root,
          state,
          objective: 1,
          objectiveBody: body,
          save,
          active: new Map(),
          cancelled: () => false,
          driver: {
            async availableSlots() {
              return 1;
            },
            async start() {
              throw new Error("Unexpected implementation attempt");
            },
          },
          github: {
            async defaultBranch() {
              return "main";
            },
          },
          delivery: {},
          contentStore: new LocalContentStore(join(root, "content")),
          planningModel: {
            async reviewResult() {
              submissions++;
              assert.equal(state.work.result.pendingEffect, "review");
              assert.equal(state.work.result.phaseReservation, "review");
              assert.equal(
                snapshots.at(-1).work.result.pendingEffect,
                "review",
              );
              throw new Error("Review response was lost after model entry");
            },
          },
        };
        await assert.rejects(
          runner(args),
          failure === "marker save"
            ? /Review marker save failed/
            : /Review response was lost/,
        );
        const unknown = failure === "unknown model response";
        assert.equal(submissions, unknown ? 1 : 0);
        assert.equal(
          state.work.result.pendingEffect,
          unknown ? "review" : undefined,
        );
        assert.equal(
          state.work.result.phaseReservation,
          unknown ? "review" : undefined,
        );
        assert.equal(state.work.result.requestedPhase, undefined);
        assert.equal(state.work.result.status, "failed");
        assert.deepEqual(accounting(state), before);
        if (unknown) {
          await assert.rejects(runner(args), /unknown outcome/);
          assert.equal(submissions, 1);
        } else
          assert.ok(
            snapshots.every(
              (snapshot) => snapshot.work.result.pendingEffect === undefined,
            ),
          );
      }));

for (const delivery of ["regular", "native"])
  test(`${delivery} actual model entry observes persisted coding, QA and final submission markers`, async () =>
    fixture(async (root) => {
      const target = createTarget(root);
      const config = factoryConfig(
        target.checkout,
        `example/submission-entry-${delivery}`,
        delivery,
        1,
      );
      const workItem = item("result");
      const qa = item("qa", "qa", ["result"]);
      const graph = {
        objective: 1,
        baseSha: target.baseSha,
        items: [workItem, qa],
        coverage: coverageObligations(body, objectiveCriteria(body)).map(
          (obligation) => ({
            ...obligation,
            itemId: "qa",
            proof: { kind: "integrated-semantic", acceptanceIndex: 0 },
            environment: {
              kind: "local",
              readiness: "available",
              probe: "",
              preparedBy: "",
            },
          }),
        ),
      };
      const entries = [];
      const planningModel = {
        async generateStructured(request) {
          return withCoverage(request, graph);
        },
        async reviewGraph(request) {
          return { packetId: request.reviewPacket.id, findings: [] };
        },
        async reviewResult(request) {
          const persisted = readState(config.repository, 1);
          if (request.reviewPhase === "objective-review") {
            entries.push("final");
            assert.equal(
              persisted.coordinator.phase,
              "objective-review-submitted",
            );
          } else {
            const id = request.criteria[0].startsWith("integrated")
              ? "qa"
              : "result";
            entries.push(id);
            assert.equal(persisted.work[id].pendingEffect, "review");
            assert.equal(persisted.work[id].phaseReservation, "review");
          }
          assert.equal(
            request.treeSha,
            request.reviewPhase === "objective-review"
              ? git(
                  target.checkout,
                  "rev-parse",
                  `${persisted.integratedSha}^{tree}`,
                )
              : persisted.work[
                  request.criteria[0].startsWith("integrated") ? "qa" : "result"
                ].treeSha,
          );
          return pass(request);
        },
      };
      const { application } = makeApplication({
        config,
        graph,
        objectiveBody: body,
        fakeRoot: join(root, "fake"),
        planningModel,
        actions: {
          result: { files: [{ path: "result.txt", text: "done\n" }] },
        },
      });
      const plan = await application.planObjective(1);
      const completed = await application.runObjective(1, plan);
      assert.deepEqual(entries, ["result", "qa", "final"]);
      assert.equal(completed.finalValidation.passed, true);
      assert.equal(completed.work.result.pendingEffect, undefined);
      assert.equal(completed.work.qa.pendingEffect, undefined);
    }));

for (const failure of ["marker save", "unknown model response"])
  test(`final ${failure} preserves the actual objective submission boundary`, async () =>
    fixture(async (root) => {
      const target = createTarget(root);
      const config = factoryConfig(
        target.checkout,
        `example/submission-final-${failure.replaceAll(" ", "-")}`,
        "regular",
        1,
      );
      const graph = {
        objective: 1,
        baseSha: target.baseSha,
        items: [item("result")],
      };
      let finalSubmissions = 0;
      const planningModel = {
        async generateStructured(request) {
          return withCoverage(request, graph);
        },
        async reviewGraph(request) {
          return { packetId: request.reviewPacket.id, findings: [] };
        },
        async reviewResult(request) {
          if (request.reviewPhase !== "objective-review") return pass(request);
          finalSubmissions++;
          assert.equal(
            readState(config.repository, 1).coordinator.phase,
            "objective-review-submitted",
          );
          throw new Error("Final response was lost after model entry");
        },
      };
      const { application } = makeApplication({
        config,
        graph,
        objectiveBody: body,
        fakeRoot: join(root, "fake"),
        planningModel,
        actions: {
          result: { files: [{ path: "result.txt", text: "done\n" }] },
        },
      });
      const plan = await application.planObjective(1);
      const fs = (await import("node:fs")).default;
      const { syncBuiltinESMExports } = await import("node:module");
      const rename = fs.renameSync;
      let saveFailed = false;
      let priorPhase;
      let priorAccounting;
      try {
        // Use the established built-in filesystem fault seam at the real atomic snapshot rename.
        fs.renameSync = function (from, to) {
          if (to === statePath(config.repository, 1)) {
            const next = JSON.parse(fs.readFileSync(from, "utf8"));
            if (
              next.coordinator?.phase === "objective-review-submitted" &&
              !priorPhase
            ) {
              const previous = readState(config.repository, 1);
              priorPhase = previous.coordinator.phase;
              priorAccounting = accounting(previous);
              if (failure === "marker save") {
                saveFailed = true;
                throw new Error("Final review marker save failed");
              }
            }
          }
          return rename(from, to);
        };
        syncBuiltinESMExports();
        await assert.rejects(
          application.runObjective(1, plan),
          failure === "marker save"
            ? /Final review marker save failed/
            : /Final response was lost/,
        );
      } finally {
        fs.renameSync = rename;
        syncBuiltinESMExports();
      }
      assert.ok(priorPhase);
      const failed = readState(config.repository, 1);
      const unknown = failure === "unknown model response";
      assert.equal(saveFailed, !unknown);
      assert.equal(finalSubmissions, unknown ? 1 : 0);
      assert.equal(
        failed.coordinator.phase,
        unknown ? "objective-review-submitted" : priorPhase,
      );
      assert.equal(failed.finalValidation, undefined);
      assert.equal(failed.finalAcceptance, undefined);
      assert.deepEqual(accounting(failed), priorAccounting);
      if (unknown) {
        await assert.rejects(
          application.runObjective(1, plan),
          /unknown|submitted/i,
        );
        assert.equal(finalSubmissions, 1);
        assert.equal(
          readState(config.repository, 1).coordinator.phase,
          "objective-review-submitted",
        );
      }
    }));
