import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexPlanningModel } from "../dist/compiler.js";
import { graphDigest } from "../dist/graph-amendments.js";
import { assertFailedValidationRecord } from "../dist/failed-validation.js";
import { consumption } from "../dist/repair-policy.js";
import { parseFactoryState } from "../dist/state.js";
import { readState } from "../dist/state-store.js";
import { CandidateValidationFailure } from "../dist/work-repair.js";
import { objectiveReviewEvidence, validateTree } from "../dist/validation.js";
import {
  createTarget,
  factoryConfig,
  git,
  makeApplication,
  readEvents,
  ScriptedPlanningModel,
} from "./support/integration-fixture.mjs";
import {
  packetFromPrompt,
  resultFindings,
} from "./support/review-protocol.mjs";

function item(id, validation, dependencies = [], kind = "work") {
  return {
    id,
    kind,
    title: id,
    goal: id,
    acceptance: [`${id} is validated`],
    nonGoals: ["No deployment"],
    citations: [{ path: "OBJECTIVE" }],
    dependencies,
    ownedPaths: kind === "qa" ? [] : [`${id}.txt`],
    resources: [],
    validation: validation.map((command) => ({
      command,
      provenance: "source-declared",
      source: "OBJECTIVE",
    })),
    brief: id,
    sourceAssets: [],
    expectedOutputRoles: [],
    minimumAssetSets: 0,
    requiredLfsRoles: [],
  };
}
function repairFrom(packet, id) {
  const direct = packet.evidence.find(
    (source) => source.path === `Retained repair proof: ${id}`,
  );
  if (direct) return JSON.parse(direct.content);
  for (const source of packet.evidence.filter((entry) =>
    ["Completed dependency results", "Delivery observations"].includes(
      entry.path,
    ),
  )) {
    const record = JSON.parse(source.content).work?.find(
      (entry) => entry.id === id,
    );
    if (record?.repair) return record.repair;
  }
}
function assertRepair(proof, state, id) {
  assert.ok(proof, `Missing real retained repair for ${id}`);
  const current = state.work[id];
  const prior = current.recovery.history[0];
  const facts = proof.controllerFacts;
  const binding = facts.policyBinding;
  assert.equal(binding.origin, "objective-autonomy-snapshot");
  for (const key of ["repository", "objective", "runId", "configDigest"])
    assert.equal(binding[key], state[key]);
  assert.equal(binding.acceptedBaseCommitSha, state.baseSha);
  assert.equal(binding.failureEvent, prior.failure.event);
  assert.deepEqual(
    binding.permittedRepairClasses,
    state.autonomy.repairClasses,
  );
  assert.deepEqual(
    binding.chargedAllowances,
    state.charges[prior.failure.event].allowances,
  );
  assert.deepEqual(
    binding.chargedScopes,
    state.charges[prior.failure.event].scopes,
  );
  assert.equal(facts.failedAttempt.failure.digest, prior.failure.digest);
  assert.equal(facts.failedAttempt.attemptId, prior.work.attempt);
  assert.equal(facts.failedAttempt.resultCommitSha, prior.work.changeRef);
  assert.equal(facts.failedAttempt.resultTreeSha, prior.work.treeSha);
  assert.equal(facts.currentAttemptId, current.attempt);
  assert.equal(facts.currentResultCommitSha, current.changeRef);
  assert.equal(facts.currentResultTreeSha, current.treeSha);
  assert.notEqual(current.attempt, prior.work.attempt);
  const retained = facts.failedAttempt.validation;
  assert.equal(retained.availability, "available");
  assert.equal(retained.runId, state.runId);
  assert.equal(retained.itemId, id);
  assert.equal(retained.attemptId, prior.work.attempt);
  assert.equal(retained.failureEvent, prior.failure.event);
  assert.equal(retained.failureDigest, prior.failure.digest);
  assert.equal(retained.evidence.commitSha, prior.work.changeRef);
  assert.equal(retained.evidence.treeSha, prior.work.treeSha);
  assert.deepEqual(
    retained.evidence.commands.map(({ index, passed, exitCode }) => ({
      index,
      passed,
      exitCode,
    })),
    [
      { index: 0, passed: true, exitCode: 0 },
      { index: 1, passed: false, exitCode: 23 },
    ],
  );
  assert.equal(retained.evidence.postCommandStatus, "unchanged");
  assert.equal(retained.evidence.subprocessOwnership, "settled");
  assert.equal(facts.snapshotConsumption.objective.consumed, 1);
  assert.equal(
    facts.snapshotConsumption.objective.limit,
    state.autonomy.allowances.implementationRepairs,
  );
  assert.deepEqual(facts.snapshotConsumption.paths, [
    {
      scope: id,
      consumed: 1,
      limit: state.autonomy.repairPolicy.perPath.implementationRepairs,
    },
  ]);
  assert.equal(
    proof.declaredCorrection.contentOrigin,
    "declared-diagnosis-and-correction",
  );
}

for (const delivery of ["regular", "native-stack"])
  for (const repairedId of ["result", "qa"])
    test(`${delivery}: actual failed ${repairedId} commands and supported repair reach result, dependency, QA and final packets`, async () => {
      const root = mkdtempSync(join(tmpdir(), "factory-retained-repair-"));
      const previous = process.env.XDG_STATE_HOME;
      process.env.XDG_STATE_HOME = join(root, "state");
      try {
        const target = createTarget(root);
        const ready = join(root, "ready");
        const condition = `node -e "process.exit(require('node:fs').existsSync('${ready}') ? 0 : 23)"`;
        const resultCheck = `node -e "process.exit(require('node:fs').readFileSync('result.txt','utf8') === 'correct' ? 0 : 23)"`;
        const qaCheck = "test -s result.txt && test -s after.txt";
        const items = [
          item("result", ["test -s result.txt", resultCheck]),
          item("after", ["test -s after.txt"], ["result"]),
          item(
            "qa",
            repairedId === "qa" ? [qaCheck, condition] : [qaCheck],
            ["after"],
            "qa",
          ),
        ];
        const graph = { objective: 1, baseSha: target.baseSha, items };
        const body = `# Real retained repair fixture\n## Acceptance\n- Retain actual failed validation and finite controller repair authority after a supported correction.\n- \`test -s result.txt\`\n- \`test -s after.txt\`\n- \`${qaCheck}\`\n## Commands\n${items
          .flatMap((entry) => entry.validation)
          .map((check) => `- \`${check.command}\``)
          .join("\n")}\n`;
        const config = factoryConfig(
          target.checkout,
          `example/retained-${delivery}-${repairedId}`,
          delivery,
          1,
        );
        const packets = [];
        const renderer = new CodexPlanningModel(target.checkout);
        renderer.runStructured = async ({ prompt, defaultPhase }) => {
          const packet = packetFromPrompt(prompt);
          packets.push({ packet, prompt, phase: defaultPhase });
          return {
            packetId: packet.packetId,
            findings: resultFindings(
              { reviewPacket: packet },
              packet.criteria.map(({ text }) => ({
                criterion: text,
                verdict: "pass",
                source: "OBJECTIVE",
                detail:
                  "Synthetic semantic transport; real controller packet inspected separately.",
                question: "",
              })),
            ),
          };
        };
        const model = new ScriptedPlanningModel(
          graph,
          join(root, "planning.ndjson"),
        );
        const generate = model.generateStructured.bind(model);
        model.generateStructured = async (request) => {
          if (request.purpose !== "diagnosis") return generate(request);
          model.observe(request);
          return {
            decision: "operator",
            diagnosis:
              "The actual command failed; a concrete supported correction is required.",
            correction: "",
            predecessor: "",
            path: "",
          };
        };
        model.reviewResult = (request) => {
          model.observe(request);
          return renderer.reviewResult(request);
        };
        const actions = {
          result: {
            files: [
              {
                path: "result.txt",
                text: repairedId === "result" ? "wrong" : "correct",
              },
            ],
          },
          after: { files: [{ path: "after.txt", text: "dependent result" }] },
        };
        const fixture = makeApplication({
          config,
          graph,
          objectiveBody: body,
          fakeRoot: join(root, "fake"),
          actions,
          planningModel: model,
        });
        let stopped;
        try {
          stopped = await fixture.application.runObjective(1);
        } catch (error) {
          assert.ok(error instanceof CandidateValidationFailure);
          stopped = readState(config.repository, 1);
        }
        const failed = stopped.work[repairedId];
        assert.equal(failed.status, "failed");
        assert.equal(failed.validation, undefined);
        assert.equal(failed.failedValidation.evidence.commands[1].exitCode, 23);
        const original = structuredClone(failed);
        const charges = structuredClone(stopped.charges);
        const events = readEvents(fixture.eventsPath);
        fixture.application.repairWorkItem(1, {
          item: repairedId,
          correction: {
            failureDigest: failed.recovery.failure.digest,
            kind: "implementation",
            diagnosis:
              "The retained failed command establishes the missing fixture condition.",
            correction:
              repairedId === "result"
                ? "Write the correct owned result from the accepted base."
                : "The fixture owner restores the declared disposable condition.",
            actor: "public-fixture-owner",
          },
        });
        if (repairedId === "result") actions.result.files[0].text = "correct";
        else writeFileSync(ready, "ready");
        const done = await fixture.application.runObjective(1);
        assert.equal(done.finalValidation.passed, true);
        assert.equal(consumption(done).implementationRepairs, 1);
        assert.deepEqual(done.charges, charges);
        const prior = done.work[repairedId].recovery.history[0];
        assert.deepEqual(
          prior.work.failedValidation,
          original.failedValidation,
        );
        assert.deepEqual(prior.failure, original.recovery.failure);
        assert.deepEqual(prior.work.execution, original.execution);
        assert.equal(prior.work.validation, undefined);
        assert.equal(
          readEvents(fixture.eventsPath).filter(
            (entry) => entry.type === "start",
          ).length - events.filter((entry) => entry.type === "start").length,
          repairedId === "result" ? 2 : 0,
        );
        parseFactoryState(
          readState(config.repository, 1),
          config.repository,
          1,
        );
        assert.ok(packets.some(({ phase }) => phase === "objective-review"));
        for (const { packet, prompt } of packets.filter(({ packet }) =>
          repairFrom(packet, repairedId),
        )) {
          const proof = repairFrom(packet, repairedId);
          // Earlier packets retain their own current result; native replay may advance it later.
          const matching = structuredClone(done);
          matching.work[repairedId].attempt =
            proof.controllerFacts.currentAttemptId;
          matching.work[repairedId].changeRef =
            proof.controllerFacts.currentResultCommitSha;
          matching.work[repairedId].treeSha =
            proof.controllerFacts.currentResultTreeSha;
          assertRepair(proof, matching, repairedId);
          assert.match(
            prompt,
            /failed validation.*unavailable|unsuccessful validation/,
          );
          assert.equal(
            packet.evidence
              .find((source) => source.path === "Command pass evidence")
              .content.includes('"passed":false'),
            false,
          );
        }
        const finalPacket = packets
          .filter(({ phase }) => phase === "objective-review")
          .at(-1).packet;
        assertRepair(repairFrom(finalPacket, repairedId), done, repairedId);
        if (repairedId === "result") {
          assert.ok(
            packets.some(({ packet }) =>
              packet.evidence.some(
                (source) => source.path === "Retained repair proof: result",
              ),
            ),
          );
          assert.equal(
            packets.filter(
              ({ packet }) =>
                packet.evidence.some(
                  (source) => source.path === "Completed dependency results",
                ) && repairFrom(packet, "result"),
            ).length,
            2,
          );
        } else assert.equal(prior.work.changeRef, done.work.qa.changeRef);

        if (delivery === "regular" && repairedId === "result") {
          const build = (state) =>
            objectiveReviewEvidence({
              state,
              checkout: target.checkout,
              candidateCommitSha: done.integratedSha,
              candidateTreeSha: done.finalValidation.treeSha,
            });
          const legacy = structuredClone(done);
          delete legacy.work.result.recovery.history[0].work.failedValidation;
          delete legacy.work.result.recovery.history[0].failure
            .validationCaptureDigest;
          delete legacy.work.result.recovery.failure.validationCaptureDigest;
          const missing = JSON.parse(build(legacy).observations).work.find(
            (entry) => entry.id === "result",
          ).repair;
          assert.deepEqual(missing.controllerFacts.failedAttempt.validation, {
            availability: "unavailable",
          });
          assert.equal(
            missing.controllerFacts.failedAttempt.failure.digest,
            prior.failure.digest,
          );
          for (const mutate of [
            (state) => {
              delete state.work.result.recovery.history[0].work
                .failedValidation;
            },
            (state) => {
              delete state.work.result.recovery.history[0].failure
                .validationCaptureDigest;
            },
            (state) => {
              state.work.result.recovery.history[0].work.failedValidation.evidence.commands[1].exitCode = 24;
            },
            (state) => {
              state.work.result.recovery.history[0].work.failedValidation.runId =
                "other-run";
            },
            (state) => {
              state.work.result.recovery.history[0].work.failedValidation.configDigest =
                "f".repeat(64);
            },
            (state) => {
              state.work.result.recovery.history[0].work.failedValidation.attemptId =
                "other-attempt";
            },
            (state) => {
              state.work.result.recovery.history[0].work.failedValidation.evidence.treeSha =
                done.finalValidation.treeSha;
            },
            (state) => {
              state.work.result.recovery.history[0].work.failedValidation.evidence.commands[1].passed = true;
            },
            (state) => {
              state.work.result.recovery.history[0].work.failedValidation.evidence.commands[1].command =
                "true";
            },
            (state) => {
              state.work.result.recovery.history[0].work.failedValidation.evidence.commands[0].index = 1;
            },
            (state) => {
              state.work.result.recovery.history[0].work.failedValidation.evidence.subprocessOwnership =
                "unresolved";
            },
            (state) => {
              state.work.result.recovery.correction.failureDigest = "f".repeat(
                64,
              );
            },
            (state) => {
              state.work.result.recovery.correction.event =
                "item/after/validate/0";
            },
            (state) => {
              state.charges[prior.failure.event].scopes = ["after"];
            },
            (state) => {
              state.work.result.recovery.scopes = ["after"];
              state.charges[prior.failure.event].scopes = ["after"];
            },
            (state) => {
              state.autonomy.repairClasses = [];
            },
            (state) => {
              state.autonomy.allowances.implementationRepairs = 0;
            },
          ]) {
            const corrupt = structuredClone(done);
            mutate(corrupt);
            assert.throws(() => build(corrupt));
          }
          for (const mutate of [
            (record) => {
              record.itemId = "after";
            },
            (record) => {
              record.evidence.commands[1].exitCode = 0;
            },
            (record) => {
              record.evidence.commands[1].stdout = "invented historical output";
            },
          ]) {
            const corrupt = structuredClone(done);
            mutate(
              corrupt.work.result.recovery.history[0].work.failedValidation,
            );
            assert.throws(() =>
              parseFactoryState(corrupt, config.repository, 1),
            );
          }
          const changed = structuredClone(done);
          const oldGraph = structuredClone(changed.graph);
          const oldDigest = graphDigest(oldGraph);
          changed.graph.items[0].validation[1].command = "true";
          changed.graphRevisions = [{ graph: oldGraph, digest: oldDigest }];
          assertFailedValidationRecord(
            prior.work.failedValidation,
            changed,
            "result",
            prior.work,
            prior.failure,
          );
          changed.graphRevisions[0].graph.items[0].validation[1].command =
            "false";
          assert.throws(() =>
            assertFailedValidationRecord(
              prior.work.failedValidation,
              changed,
              "result",
              prior.work,
              prior.failure,
            ),
          );
        }
      } finally {
        if (previous === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = previous;
        rmSync(root, { recursive: true, force: true });
      }
    });

test("failed capture preserves outcomes without output and distinguishes later commands after tree or HEAD changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-failed-command-"));
  try {
    const target = createTarget(root, { "base.txt": "original" });
    const tree = git(target.checkout, "rev-parse", "HEAD^{tree}");
    for (const commands of [
      [
        "true",
        `node -e "process.stdout.write(['private','stdout','sentinel'].join('-'));process.exit(23)"`,
      ],
      ["printf changed > base.txt", "exit 23"],
      [`git checkout --detach ${target.baseSha}^`, "exit 23"],
      ["true", "kill -TERM $$"],
    ]) {
      // createTarget's base may be the first commit; provide a different retained Git commit.
      if (commands[0].startsWith("git checkout")) {
        writeFileSync(join(target.checkout, "new.txt"), "new");
        git(target.checkout, "add", "new.txt");
        git(
          target.checkout,
          "-c",
          "user.name=Public fixture",
          "-c",
          "user.email=fixture@example.test",
          "commit",
          "-m",
          "Second public candidate",
        );
        commands[0] = `git checkout --detach ${git(target.checkout, "rev-parse", "HEAD")}`;
      }
      await assert.rejects(
        validateTree(
          target.checkout,
          join(root, "validation"),
          target.baseSha,
          tree,
          commands,
        ),
        (error) => {
          assert.ok(error instanceof CandidateValidationFailure);
          const evidence = error.failedValidation;
          assert.equal(
            evidence.commands[1].exitCode,
            commands[1] === "kill -TERM $$" ? null : 23,
          );
          assert.equal(evidence.commands[1].passed, false);
          assert.equal(
            evidence.commands[1].worktreeStatusBefore,
            commands[0] === "true" ? "unchanged" : "modified",
          );
          assert.equal(
            evidence.postCommandStatus,
            commands[0] === "true" ? "unchanged" : "modified",
          );
          assert.equal(
            JSON.stringify(evidence).includes("private-stdout-sentinel"),
            false,
          );
          assert.ok(
            evidence.commands.every(
              (receipt) =>
                !("stdout" in receipt) &&
                !("stderr" in receipt) &&
                !("output" in receipt),
            ),
          );
          return true;
        },
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
