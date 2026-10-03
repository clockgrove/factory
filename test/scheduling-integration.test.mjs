import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { validateConfig } from "../dist/config.js";
import { readState, saveState, statePath } from "../dist/state-store.js";
import {
  createTarget,
  factoryConfig,
  makeApplication,
} from "./support/integration-fixture.mjs";
import { resultFindings } from "./support/review-protocol.mjs";

for (const delivery of ["regular", "native-stack"]) {
  for (const slowFirst of [
    false,
    true,
    ...(delivery === "native-stack" ? ["unknown-merge"] : []),
  ])
    test(`${delivery} slowFirst=${slowFirst}: review receives the freed coding capacity while an independent worker remains active`, async () => {
      const root = mkdtempSync(join(tmpdir(), "factory-phase-integration-"));
      const previous = process.env.XDG_STATE_HOME;
      process.env.XDG_STATE_HOME = join(root, "state");
      try {
        const target = createTarget(root);
        const repository = `example/phase-${delivery}`;
        const barrier = join(root, "barriers", "slow.go");
        const body =
          "# Phase admission\n## Acceptance\n- fast.txt exists\n- slow.txt exists\n- joined.txt exists\n- tail.txt exists\n## Commands\n- test -s fast.txt\n- test -s slow.txt\n- test -s joined.txt\n- test -s tail.txt\n## Final validation\n- test -s joined.txt\n";
        const item = (id, dependencies = []) => ({
          id,
          title: id,
          goal: id,
          acceptance: [`${id}.txt exists`],
          nonGoals: ["No deployment"],
          citations: [{ path: "OBJECTIVE" }],
          dependencies,
          ownedPaths: [`${id}.txt`],
          resources: [],
          validation: [
            {
              command: `test -s ${id}.txt`,
              provenance: "source-declared",
              source: "OBJECTIVE",
            },
          ],
          brief: id,
          sourceAssets: [],
          expectedOutputRoles: [],
          minimumAssetSets: 0,
          requiredLfsRoles: [],
        });
        const config = factoryConfig(target.checkout, repository, delivery, 2);
        config.scheduling = {
          cpu: 2,
          memoryMiB: 200,
          reviewConcurrency: 1,
          validationConcurrency: 1,
          phases: Object.fromEntries(
            ["coding", "validation", "review", "delivery"].map((phase) => [
              phase,
              { cpu: 1, memoryMiB: 100 },
            ]),
          ),
        };
        assert.equal(validateConfig(config), config);
        const missing = structuredClone(config);
        delete missing.scheduling.phases.review.cpu;
        assert.throws(
          () => validateConfig(missing),
          /requires a fitting declaration/,
        );
        const oversized = structuredClone(config);
        oversized.scheduling.phases.validation.memoryMiB = 201;
        assert.throws(
          () => validateConfig(oversized),
          /requires a fitting declaration/,
        );
        let reviewedWhileCoding = false;
        const { application, driver, github } = makeApplication({
          config,
          graph: {
            objective: 1,
            baseSha: target.baseSha,
            items: [
              ...(slowFirst
                ? [item("slow"), item("fast")]
                : [item("fast"), item("slow")]),
              item("joined", ["fast", "slow"]),
              item("tail", ["joined"]),
            ],
          },
          objectiveBody: body,
          fakeRoot: join(root, "fake"),
          actions: {
            fast: { files: [{ path: "fast.txt", text: "fast" }] },
            slow: { barrier, files: [{ path: "slow.txt", text: "slow" }] },
            joined: { files: [{ path: "joined.txt", text: "joined" }] },
            tail: { files: [{ path: "tail.txt", text: "tail" }] },
          },
          resultReviewer(request) {
            const state = readState(repository, 1);
            const held = Object.values(state.work).filter(
              (work) => work.phaseReservation,
            );
            assert.ok(
              held.length <= 2,
              "declared CPU/memory remains within the operator envelope",
            );
            if (
              request.criteria.includes("fast.txt exists") &&
              state.work.fast.status === "running"
            ) {
              assert.equal(state.work.fast.phaseReservation, "review");
              assert.equal(state.work.slow.phaseReservation, "coding");
              reviewedWhileCoding = true;
              mkdirSync(dirname(barrier), { recursive: true });
              writeFileSync(barrier, "release");
            }
            return {
              packetId: request.reviewPacket.id,
              findings: resultFindings(
                request,
                request.criteria.map((criterion) => ({
                  criterion,
                  verdict: "pass",
                  source: "OBJECTIVE",
                  quote: "# Phase admission",
                  detail: "Exact fixture proof",
                  question: "",
                })),
              ),
            };
          },
        });
        let stackMerges = 0;
        let crashSnapshot;
        for (const method of ["merge", "mergeNativeStack"]) {
          const original = github[method].bind(github);
          github[method] = async (...args) => {
            const state = readState(repository, 1);
            const number =
              method === "merge" ? args[0].number : args[0].at(-1).pullRequest;
            const owner = Object.values(state.work).find(
              (work) => work.pullRequest === number,
            );
            assert.equal(
              owner.phaseReservation,
              "delivery",
              `actual ${method} must reserve delivery`,
            );
            assert.ok(
              Object.values(state.work).filter((work) => work.phaseReservation)
                .length <= 2,
            );
            if (method === "mergeNativeStack") {
              stackMerges++;
              if (slowFirst === "unknown-merge" && stackMerges === 1) {
                // The merge is applied but the controller dies before it
                // records the result: keep the snapshot a crash would leave.
                await original(...args);
                crashSnapshot = readFileSync(statePath(repository, 1), "utf8");
                throw new Error("Native merge response lost");
              }
            }
            return original(...args);
          };
        }
        const start = driver.start.bind(driver);
        driver.start = async (request) => {
          const state = readState(repository, 1);
          assert.equal(state.work[request.item.id].phaseReservation, "coding");
          assert.ok(
            Object.values(state.work).filter((work) => work.phaseReservation)
              .length <= 2,
          );
          return start(request);
        };
        if (slowFirst === "unknown-merge") {
          await assert.rejects(
            application.runObjective(1),
            /Native merge response lost/,
          );
          const merged = () =>
            github
              .state()
              .events.filter((event) => event.type === "merge-stack").length;
          assert.equal(merged(), 1);
          // Restart from the snapshot a crash after the merge call leaves:
          // the published unit still holds its delivery reservation.
          saveState(statePath(repository, 1), JSON.parse(crashSnapshot));
          const crashed = readState(repository, 1);
          assert.equal(crashed.error, undefined);
          assert.equal(crashed.work.tail.status, "published");
          assert.equal(crashed.work.tail.phaseReservation, "delivery");
          // The restart repeats the merge; the gateway confirms the merged
          // stack instead of merging again.
          const final = await application.runObjective(1);
          assert.equal(final.finalValidation.passed, true);
          assert.equal(stackMerges, 2);
          assert.equal(merged(), 1);
          assert.ok(
            Object.values(final.work).every((work) => !work.phaseReservation),
          );
          return;
        }
        const final = await application.runObjective(1);
        assert.equal(reviewedWhileCoding, true);
        assert.equal(final.finalValidation.passed, true);
        if (delivery === "native-stack") assert.equal(stackMerges, 1);
        assert.ok(
          Object.values(final.work).every((work) => !work.phaseReservation),
        );
      } finally {
        if (previous === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = previous;
        rmSync(root, { recursive: true, force: true });
      }
    });
}
