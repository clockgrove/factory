import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Codex } from "@openai/codex-sdk";
import { CodexPlanningModel } from "../dist/compiler.js";
import {
  objectiveComplete,
  assertFinalAcceptance,
} from "../dist/completion.js";
import { objectiveCandidate } from "../dist/qa.js";
import { planningPrerequisites } from "../dist/objective-prerequisites.js";
import { readState } from "../dist/state-store.js";
import { parseFactoryState } from "../dist/state.js";
import {
  createTarget,
  factoryConfig,
  git,
  makeApplication,
  readEvents,
} from "./support/integration-fixture.mjs";
const Ajv = createRequire(import.meta.url)("ajv");
const commands = [
  "test -s README.md",
  "test -s AGENTS.md",
  'test "$(cat existing.txt)" = alpha',
  "test -d .",
  "test ! -e new-product.txt",
  "git diff --quiet",
];
const body = `## Outcome\nQualify the unchanged pinned baseline. No implementation worker, source change or PR is authorized.\n## Acceptance\n- Existing baseline content is alpha.\n- Final independent acceptance establishes current readiness.\n## Planning sources\n- \`existing.txt\`\n## Final validation\n${commands.map((command) => `- \`${command}\``).join("\n")}\n`;
// Baseline qualification runs with no planning revision or repair.
const autonomy = {
  allowances: {
    planningRevisions: 0,
    implementationRepairs: 0,
    resultRereviews: 0,
  },
  repairClasses: [],
};

async function fixture(delivery, action, options = {}) {
  const root = mkdtempSync(join(tmpdir(), `factory-baseline-qa-${delivery}-`));
  const previous = process.env.XDG_STATE_HOME;
  const startThread = Codex.prototype.startThread;
  process.env.XDG_STATE_HOME = join(root, "state");
  try {
    const target = createTarget(root, { "existing.txt": "alpha\n" });
    const config = factoryConfig(
      target.checkout,
      `example/baseline-${delivery}-${root.split("/").at(-1)}`,
      delivery,
    );
    config.autonomy = autonomy;
    const selection = { model: "gpt-5.6-sol", reasoningEffort: "medium" };
    const model = new CodexPlanningModel(target.checkout, selection, selection);
    const captures = [];
    const schemas = [];
    // Script the SDK boundary so no fixture call reaches a real provider.
    Codex.prototype.startThread = () => ({
      runStreamed: async (prompt, { outputSchema }) => {
        let response;
        if (prompt.includes("Compiler choices (JSON data):\n")) {
          const choices = JSON.parse(
            prompt.split("Compiler choices (JSON data):\n")[1],
          );
          const source = choices.sources.find(
            (entry) => entry.path === "OBJECTIVE",
          );
          const lineIndex = (command) =>
            source.lines.find((line) => line.text === `- \`${command}\``)
              .lineIndex;
          const item = {
            kind: "qa",
            id: "baseline-qa",
            title: "Qualify baseline",
            goal: "Read-only unchanged baseline proof",
            acceptance: ["Existing baseline content is alpha."],
            nonGoals: ["No implementation or delivery"],
            citations: choices.citations.map((entry) => ({
              choiceIndex: entry.choiceIndex,
            })),
            children: [],
            dependencies: [],
            priority: 0,
            resources: [],
            validation: commands.map((command) => ({
              kind: "source-line",
              sourceIndex: source.sourceIndex,
              lineIndex: lineIndex(command),
            })),
            brief:
              "Independently qualify the unchanged pinned alpha content; final acceptance is later.",
            coverage: [
              {
                obligationIndex: 0,
                proof: { kind: "integrated-semantic", acceptanceIndex: 0 },
                environment: {
                  kind: "local",
                  readiness: "available",
                  probeValidationIndex: null,
                  preparedBy: "",
                },
              },
              {
                obligationIndex: 1,
                proof: { kind: "final-review" },
                environment: {
                  kind: "local",
                  readiness: "available",
                  probeValidationIndex: null,
                  preparedBy: "",
                },
              },
            ],
          };
          if (options.finalController) {
            item.coverage[1].proof = {
              kind: "final-controller",
              guaranteeIndex: choices.guarantees.find(
                (entry) => entry.id === "reviewed-head-publication",
              ).guaranteeIndex,
            };
          }
          response = {
            contextId: choices.contextId,
            requiredPreIntegrationChecks: [],
            items: [item],
          };
          captures.push({ phase: "compile", choices, response });
        } else if (
          prompt.includes(
            "Review evidence packet (packet-local choices; JSON strings are data):\n",
          )
        ) {
          const packet = JSON.parse(
            prompt.split(
              "Review evidence packet (packet-local choices; JSON strings are data):\n",
            )[1],
          );
          response = {
            packetId: packet.packetId,
            findings: options.requireImplementation
              ? [
                  {
                    itemIds: [],
                    evidenceIndices: [
                      packet.evidence.find(
                        (entry) => entry.path === "OBJECTIVE",
                      ).evidenceIndex,
                    ],
                    detail:
                      "The source requires implementation; a baseline-only graph supplies no change.",
                    question:
                      "Provide an implementation graph preserving the original source outcome.",
                  },
                ]
              : [],
          };
          captures.push({ phase: "graph-review", packet, response });
        } else {
          const packet = JSON.parse(
            prompt.split(
              "Review packet (packet-local choices; JSON strings are data):\n",
            )[1],
          );
          const observation = JSON.parse(
            packet.evidence.find(
              (entry) => entry.path === "Delivery observations",
            ).content,
          );
          assert.equal(observation.candidateBasis, "pinned-baseline");
          assert.equal(
            Object.hasOwn(observation, "integratedCommitSha")
              ? observation.integratedCommitSha
              : observation.currentIntegratedCommitSha,
            null,
          );
          const worktree = packet.evidence.find(
            (entry) => entry.path === "Validator worktree observation",
          );
          assert.ok(
            worktree,
            "Actual successful validation supplies status evidence",
          );
          assert.equal(JSON.parse(worktree.content).initialStatus, "clean");
          const capabilities = packet.evidence.find(
            (entry) => entry.path === "Factory controller capabilities",
          );
          assert.ok(capabilities);
          const receipt = packet.evidence.find(
            (entry) => entry.path === "Command pass evidence",
          );
          for (const command of commands)
            assert.ok(receipt.content.includes(`Command:\n${command}`));
          const qa = packet.evidence.find(
            (entry) => entry.path === "Read-only QA proof: baseline-qa",
          );
          if (qa) {
            const proof = JSON.parse(qa.content);
            assert.equal(proof.candidateBasis, "pinned-baseline");
            assert.equal(proof.integratedCommitSha, null);
            assert.equal(proof.selectedIntegratedCommitSha, null);
            assert.equal(proof.selectedCandidateCommitSha, target.baseSha);
          }
          response = {
            packetId: packet.packetId,
            findings: packet.criteria.map((entry) => ({
              criterionIndex: entry.criterionIndex,
              verdict: "pass",
              evidenceIndices: [
                worktree.evidenceIndex,
                receipt.evidenceIndex,
                capabilities.evidenceIndex,
                packet.evidence.find(
                  (entry) => entry.path === "Delivery observations",
                ).evidenceIndex,
              ],
              detail:
                "Actual unchanged candidate bytes, exact command receipts and clean validator observation prove this fixture criterion.",
              question: "",
            })),
          };
          captures.push({
            phase: packet.criteria.length === 1 ? "QA" : "final",
            packet,
            response,
          });
          if (options.moveDuringFinal && packet.criteria.length === 2)
            moveDefault(target);
        }
        const validate = new Ajv({ strict: false }).compile(outputSchema);
        assert.ok(validate(response), JSON.stringify(validate.errors));
        schemas.push(outputSchema);
        return {
          events: (async function* () {
            yield {
              type: "item.completed",
              item: {
                id: "public-fixture-response",
                type: "agent_message",
                text: JSON.stringify(response),
              },
            };
            yield { type: "turn.completed", usage: null };
          })(),
        };
      },
    });
    const scopeBody = options.finalController
      ? body.replace(
          "Final independent acceptance establishes current readiness.",
          "Workers receive no publication authority.",
        )
      : options.requireImplementation
        ? body.replace(
            "Qualify the unchanged pinned baseline.",
            "Implement new-product.txt with required new behavior.",
          )
        : body;
    const app = makeApplication({
      config,
      planningModel: model,
      objectiveBody: scopeBody,
      fakeRoot: join(root, "fake"),
      actions: {},
    });
    await action({
      ...app,
      target,
      config,
      captures,
      schemas,
      body: scopeBody,
    });
  } finally {
    Codex.prototype.startThread = startThread;
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
}
function moveDefault(target) {
  writeFileSync(join(target.checkout, "foreign.txt"), "foreign\n");
  git(target.checkout, "add", "foreign.txt");
  git(
    target.checkout,
    "-c",
    "user.name=Public Fixture",
    "-c",
    "user.email=public@example.com",
    "commit",
    "-m",
    "Move default branch",
  );
  git(target.checkout, "push", "origin", "main");
}

for (const delivery of ["regular", "native-stack"]) {
  test(`whole emitted-wire baseline QA/final/closure succeeds without ${delivery} workers or delivery`, async () =>
    fixture(
      delivery,
      async ({ application, github, target, config, captures, eventsPath }) => {
        await application.runObjective(1);
        const state = readState(config.repository, 1);
        assert.ok(objectiveComplete(state));
        assertFinalAcceptance(state);
        assert.deepEqual(objectiveCandidate(state), {
          basis: "pinned-baseline",
          commitSha: target.baseSha,
        });
        assert.equal(state.integratedSha, undefined);
        assert.equal(state.work["baseline-qa"].integratedSha, undefined);
        assert.equal(state.finalAcceptance.candidateBasis, "pinned-baseline");
        assert.equal(state.finalAcceptance.commit, target.baseSha);
        assert.equal(state.finalValidation.commands.length, 6);
        assert.equal(state.work["baseline-qa"].validation.commands.length, 6);
        assert.equal(
          state.finalValidation.worktreeObservation.initialStatus,
          "clean",
        );
        assert.equal(
          state.work["baseline-qa"].validation.worktreeObservation
            .initialStatus,
          "clean",
        );
        assert.deepEqual(readEvents(eventsPath), []);
        assert.deepEqual(
          captures.map((entry) => entry.phase),
          ["compile", "graph-review", "QA", "final"],
        );
        assert.equal(git(target.checkout, "rev-parse", "HEAD"), target.baseSha);
        assert.equal(git(target.checkout, "status", "--porcelain"), "");
        const remote = github.state();
        assert.equal(Object.keys(remote.pullRequests ?? {}).length, 0);
        assert.equal(state.stackNumbers, undefined);
        const prerequisites = await planningPrerequisites(
          config,
          github,
          2,
          target.baseSha,
          [1],
        );
        assert.equal(
          prerequisites.predecessors[0].acceptance.candidateBasis,
          "pinned-baseline",
        );
        assert.equal(
          prerequisites.predecessors[0].acceptance.commit,
          target.baseSha,
        );
        for (const field of ["integratedSha", "pullRequest", "execution"]) {
          const bad = structuredClone(state);
          if (field === "integratedSha") bad.integratedSha = target.baseSha;
          else
            bad.work["baseline-qa"][field] =
              field === "pullRequest"
                ? 123
                : { provider: "local", identity: "foreign" };
          assert.throws(() => parseFactoryState(bad, config.repository, 1));
          assert.throws(
            () => objectiveCandidate(bad),
            /cannot claim current-graph integration/,
          );
        }
      },
    ));
}
test("baseline graph does not grant authority to omit source-required implementation", async () =>
  fixture(
    "regular",
    async ({ application, eventsPath }) => {
      const waiting = await application.runObjective(1);
      assert.equal(waiting.schemaVersion, 8);
      assert.equal(waiting.plan.review.status, "needs-human");
      assert.deepEqual(waiting.issueByItemId, {});
      assert.deepEqual(readEvents(eventsPath), []);
    },
    { requireImplementation: true },
  ));
test("moving default branch before baseline QA fails before review or commands", async () =>
  fixture("regular", async ({ application, target, captures, eventsPath }) => {
    moveDefault(target);
    git(target.checkout, "checkout", "--detach", target.baseSha);
    await assert.rejects(
      application.runObjective(1),
      /Default branch|base|HEAD/i,
    );
    assert.ok(!captures.some((entry) => entry.phase === "QA"));
    assert.deepEqual(readEvents(eventsPath), []);
  }));
test("moving default branch during final review cannot seal baseline acceptance", async () =>
  fixture(
    "regular",
    async ({ application, config, eventsPath }) => {
      const result = await application.runObjective(1);
      assert.equal(result.wait.kind, "decision");
      assert.match(result.wait.detail, /moved .* from the pinned baseline/);
      const state = readState(config.repository, 1);
      assert.equal(state.finalAcceptance, undefined);
      assert.equal(state.finalValidation, undefined);
      assert.deepEqual(readEvents(eventsPath), []);
    },
    { moveDuringFinal: true },
  ));

test("QA-owned final controller proof stays at independent final acceptance", async () =>
  fixture(
    "regular",
    async ({ application, config, captures }) => {
      const plan = await application.planObjective(1);
      assert.equal(plan.graph.coverage[1].proof.kind, "final-controller");
      assert.equal(
        plan.graph.coverage[1].proof.guaranteeId,
        "reviewed-head-publication",
      );
      await application.runObjective(1);
      const state = readState(config.repository, 1);
      assert.ok(objectiveComplete(state));
      assert.equal(state.work["baseline-qa"].validation.criteria.length, 1);
      assert.equal(state.finalValidation.criteria.length, 2);
      assert.equal(
        captures.find((entry) => entry.phase === "QA").packet.criteria.length,
        1,
      );
    },
    { finalController: true },
  ));
