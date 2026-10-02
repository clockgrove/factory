import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexPlanningModel, objectiveCriteria } from "../dist/compiler.js";
import { LocalContentStore } from "../dist/content/local.js";
import { coverageObligations } from "../dist/qa.js";
import { validateTree, reviewAcceptance } from "../dist/validation.js";
import {
  createTarget,
  git,
  factoryConfig,
  makeApplication,
} from "./support/integration-fixture.mjs";
import {
  packetFromPrompt,
  resultFindings,
} from "./support/review-protocol.mjs";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const sourcePath = "Validator worktree observation";

async function fixture(run, files = { "base.txt": "public baseline\n" }) {
  const root = mkdtempSync(join(tmpdir(), "factory-worktree-observation-"));
  try {
    const target = createTarget(root, files);
    target.treeSha = git(target.checkout, "rev-parse", "HEAD^{tree}");
    await run({
      root,
      target,
      validate: (commands = ["test -f base.txt"], selected = [], store) =>
        validateTree(
          target.checkout,
          join(root, "validation"),
          target.baseSha,
          target.treeSha,
          commands,
          undefined,
          undefined,
          selected,
          store,
        ),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
function reviewer(checkout, capture) {
  const model = new CodexPlanningModel(checkout);
  model.runStructured = async ({ prompt, defaultPhase }) => {
    const packet = packetFromPrompt(prompt);
    const source = packet.evidence.find((e) => e.path === sourcePath);
    capture({ packet, prompt, phase: defaultPhase, source });
    return {
      packetId: packet.packetId,
      findings: resultFindings(
        { reviewPacket: packet },
        packet.criteria.map((c) => ({
          criterion: c.text,
          verdict: "pass",
          source: sourcePath,
          quote: source.content,
          detail:
            "The exact validator observation proves unchanged worktree status and settled validation ownership.",
          question: "",
        })),
      ),
    };
  };
  return model;
}

test("successful real validation supplies exact literal positive observation to rendered item and final review", async () =>
  fixture(async ({ target, validate }) => {
    const evidence = await validate();
    assert.deepEqual(evidence.worktreeObservation, {
      treeSha: target.treeSha,
      initialStatus: "clean",
      postHydrationStatus: { porcelainSha256: hash(""), empty: true },
      postCommandStatus: "unchanged",
      selectedLfsMembers: 0,
      subprocessOwnership: "settled",
    });
    for (const reviewPhase of ["result-review", "objective-review"]) {
      let observed;
      const model = reviewer(target.checkout, (actual) => {
        observed = actual;
      });
      const reviewed = await reviewAcceptance({
        model,
        reviewPhase,
        checkout: target.checkout,
        baseSha: target.baseSha,
        commit: target.baseSha,
        evidence: structuredClone(evidence),
        criteria: [
          "The validation worktree remains clean and unchanged after commands settle.",
        ],
        sources: [],
      });
      assert.equal(reviewed.criteria[0].verdict, "pass");
      assert.equal(observed.phase, reviewPhase);
      assert.equal(observed.source.origin, "controller");
      assert.equal(observed.source.complete, true);
      assert.equal(
        observed.source.content,
        JSON.stringify(evidence.worktreeObservation),
      );
      assert.match(observed.prompt, /not an empty worktree/);
    }
  }));

test("tracked and untracked command mutations and failed commands emit no successful worktree observation", async () =>
  fixture(async ({ validate }) => {
    for (const command of [
      "printf changed >> base.txt",
      "printf changed > untracked.txt",
      "exit 7",
    ]) {
      let evidence;
      await assert.rejects(async () => {
        evidence = await validate([command]);
      }, /modified the result tree|Validation command failed/);
      assert.equal(evidence, undefined);
    }
  }));

test("malformed or wrong-tree observations fail before reviewer submission while historical absence stays absent", async () =>
  fixture(async ({ target, validate }) => {
    const evidence = await validate();
    let calls = 0;
    const args = {
      checkout: target.checkout,
      baseSha: target.baseSha,
      commit: target.baseSha,
      criteria: ["Worktree unchanged"],
      sources: [],
      model: {
        async reviewResult() {
          calls++;
          throw new Error("Historical test review stops here");
        },
      },
    };
    for (const mutate of [
      (value) => {
        value.treeSha = "0".repeat(40);
      },
      (value) => {
        value.initialStatus = "dirty";
      },
      (value) => {
        value.postCommandStatus = "changed";
      },
      (value) => {
        value.subprocessOwnership = "unresolved";
      },
      (value) => {
        value.selectedLfsMembers = 1;
      },
      (value) => {
        value.postHydrationStatus.empty = false;
      },
      (value) => {
        value.postHydrationStatus.porcelainSha256 = hash(" M base.txt");
      },
      (value) => {
        value.unobservedClaim = true;
      },
    ]) {
      const invalid = structuredClone(evidence);
      mutate(invalid.worktreeObservation);
      await assert.rejects(
        reviewAcceptance({ ...args, evidence: invalid }),
        /canonical exact-tree evidence/,
      );
    }
    assert.equal(calls, 0);
    const historical = structuredClone(evidence);
    delete historical.worktreeObservation;
    let received;
    await assert.rejects(
      reviewAcceptance({
        ...args,
        evidence: historical,
        model: {
          async reviewResult(request) {
            received = request;
            throw new Error("Historical review has no observation");
          },
        },
      }),
      /Historical review has no observation/,
    );
    assert.equal(
      received.evidence.some((source) => source.path === sourcePath),
      false,
    );
    assert.equal(
      received.reviewPacket.evidence.some(
        (source) => source.path === sourcePath,
      ),
      false,
    );
    assert.equal(historical.worktreeObservation, undefined);
  }));

test("selected LFS hydration records an honest nonempty baseline and unchanged post-command status", async () => {
  const bytes = Buffer.from([0, 1, 2, 3, 255]);
  const digest = hash(bytes);
  await fixture(
    async ({ root, target, validate }) => {
      const store = new LocalContentStore(join(root, "content"));
      await store.put(
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
        { mediaType: "application/octet-stream" },
      );
      const selected = [
        {
          itemId: "media",
          destination: "asset.bin",
          digest,
          bytes: bytes.length,
          mediaType: "application/octet-stream",
        },
      ];
      const evidence = await validate(
        ["test $(wc -c < asset.bin) -eq 5"],
        selected,
        store,
      );
      assert.equal(evidence.worktreeObservation.selectedLfsMembers, 1);
      assert.equal(
        evidence.worktreeObservation.postHydrationStatus.empty,
        false,
      );
      assert.equal(evidence.worktreeObservation.postCommandStatus, "unchanged");
      let observation;
      await reviewAcceptance({
        model: reviewer(target.checkout, (received) => {
          observation = JSON.parse(received.source.content);
        }),
        checkout: target.checkout,
        baseSha: target.baseSha,
        commit: target.baseSha,
        evidence,
        criteria: [
          "Selected bytes remain intact and commands preserve post-hydration status.",
        ],
        sources: [],
      });
      assert.deepEqual(observation, evidence.worktreeObservation);
      // Raw porcelain preserves staged vs unstaged columns and trailing bytes.
      assert.equal(
        evidence.worktreeObservation.postHydrationStatus.porcelainSha256,
        hash(" M asset.bin\n"),
      );
      await assert.rejects(
        validate(["git add asset.bin"], selected, store),
        /modified the result tree/,
      );
      await assert.rejects(
        validate(["printf bad > asset.bin"], selected, store),
        /could not restore selected LFS bytes/,
      );
    },
    {
      ".gitattributes": "asset.bin filter=lfs diff=lfs merge=lfs -text\n",
      "asset.bin": `version https://git-lfs.github.com/spec/v1\noid sha256:${digest}\nsize ${bytes.length}\n`,
    },
  );
});

for (const route of ["regular", "native-stack"])
  test(`${route}: application retains validator observation through work, QA and final actual provider packets`, async () => {
    const previous = process.env.XDG_STATE_HOME;
    await fixture(async ({ root, target }) => {
      process.env.XDG_STATE_HOME = join(root, "state");
      try {
        const body =
          "## Acceptance\n- Source result exists with unchanged validation worktree.\n- Integrated result validation preserves its worktree.\n\n## Commands\n- test -s result.txt\n\n## Final validation\n- test -s result.txt\n";
        const item = {
          id: "result",
          title: "Result",
          goal: "Write result.txt",
          brief: "Write result.txt",
          kind: "work",
          acceptance: [
            "Source result exists with unchanged validation worktree.",
          ],
          nonGoals: ["No deployment"],
          citations: [{ path: "OBJECTIVE", heading: "Acceptance" }],
          dependencies: [],
          ownedPaths: ["result.txt"],
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
        const qa = {
          ...item,
          kind: "qa",
          id: "proof",
          title: "Integrated proof",
          ownedPaths: [],
          dependencies: ["result"],
          acceptance: ["Integrated result validation preserves its worktree."],
        };
        const obligations = coverageObligations(body, objectiveCriteria(body));
        const graph = {
          objective: 1,
          baseSha: target.baseSha,
          items: [item, qa],
          coverage: obligations.map((obligation, index) => ({
            ...obligation,
            itemId: index ? "proof" : "result",
            proof: index
              ? { kind: "integrated-semantic", acceptanceIndex: 0 }
              : { kind: "final-review" },
            environment: {
              kind: "local",
              readiness: "available",
              probe: "",
              preparedBy: "",
            },
          })),
        };
        const packets = [];
        const model = reviewer(target.checkout, (packet) => {
          assert.equal(
            JSON.parse(packet.source.content).postHydrationStatus.empty,
            true,
          );
          packets.push(packet);
        });
        const config = factoryConfig(
          target.checkout,
          `example/worktree-observation-${route}`,
          route,
          1,
        );
        const { application } = makeApplication({
          config,
          graph,
          objectiveBody: body,
          fakeRoot: join(root, "fake"),
          actions: {
            result: { files: [{ path: "result.txt", text: "done\n" }] },
          },
          resultReviewer: (request) => model.reviewResult(request),
        });
        const candidate = await application.planObjective(1);
        const state = await application.runObjective(1, candidate);
        assert.equal(state.finalValidation.passed, true);
        for (const evidence of [
          state.work.result.validation,
          state.work.proof.validation,
          state.finalValidation,
        ])
          assert.equal(evidence.worktreeObservation.treeSha, evidence.treeSha);
        assert.deepEqual(
          packets.map((packet) => packet.phase),
          ["result-review", "result-review", "objective-review"],
        );
      } finally {
        if (previous === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = previous;
      }
    });
  });
