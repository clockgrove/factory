import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexPlanningModel, objectiveCriteria } from "../dist/compiler.js";
import { LocalContentStore } from "../dist/content/local.js";
import { coverageObligations } from "../dist/qa.js";
import {
  lingeringDescendants,
  pinnedGit,
  processGroupExists,
  withProcessCancellation,
} from "../dist/process.js";
import {
  CandidateValidationFailure,
  recordWorkFailure,
} from "../dist/work-repair.js";
import {
  commandPassEvidence,
  reviewAcceptance,
  validateTree,
} from "../dist/validation.js";
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

function mutationDetail(error) {
  assert.ok(error instanceof CandidateValidationFailure);
  return JSON.parse(error.message.slice(error.message.indexOf(": ") + 2));
}

test("settled dirty refusals retain structured relative tracked, generated, special and rename paths after cleanup", async () =>
  fixture(async ({ root, target, validate }) => {
    const special = 'space \" quote\n雪.txt';
    for (const [command, expected] of [
      [
        "printf secret-content >> base.txt",
        [{ phase: "after", status: " M", path: "base.txt" }],
      ],
      [
        "mkdir -p generated/cache; printf secret-content > generated/cache/result.txt",
        [{ phase: "after", status: "??", path: "generated/cache/result.txt" }],
      ],
      [
        `node -e 'require("fs").writeFileSync(${JSON.stringify(special)}, "secret-content")'`,
        [{ phase: "after", status: "??", path: special }],
      ],
      [
        "git mv base.txt renamed.txt",
        [
          {
            phase: "after",
            status: "R ",
            path: "renamed.txt",
            from: { path: "base.txt" },
          },
        ],
      ],
      [
        `node -e 'require("fs").writeFileSync(Buffer.from("ff2e747874","hex"), "secret-content")'`,
        [
          {
            phase: "after",
            status: "??",
            path: "ff2e747874",
            pathEncoding: "hex",
          },
        ],
      ],
    ]) {
      let failure;
      const observations = [];
      await assert.rejects(
        validateTree(
          target.checkout,
          join(root, "validation"),
          target.baseSha,
          target.treeSha,
          [command],
          (entry) => observations.push(entry),
        ),
        (error) => {
          failure = error;
          assert.deepEqual(mutationDetail(error), {
            paths: expected,
            omittedRecords: 0,
          });
          assert.doesNotMatch(
            error.message,
            /secret-content|factory-worktree-observation-/,
          );
          return true;
        },
      );
      assert.equal(observations.length, 1);
      assert.equal(observations[0].passed, true);
      assert.equal(
        readdirSync(join(root, "validation")).filter(
          (name) => name !== "empty-gh-config",
        ).length,
        0,
      );
      assert.equal(
        git(target.checkout, "worktree", "list", "--porcelain").split(
          "worktree ",
        ).length - 1,
        1,
      );
      const state = {
        graph: { items: [{ id: "result", dependencies: [] }] },
        work: {
          result: {
            status: "failed",
            step: "validate",
            changeRef: target.baseSha,
            treeSha: target.treeSha,
            usage: { availability: "unavailable" },
          },
        },
      };
      assert.equal(recordWorkFailure(state, "result", failure), true);
      assert.equal(
        state.work.result.recovery.failure.classification,
        "implementation",
      );
      assert.equal(state.work.result.recovery.failure.detail, failure.message);
      assert.deepEqual(state.work.result.usage, {
        availability: "unavailable",
      });
      state.work.result.pullRequest = 1;
      assert.equal(recordWorkFailure(state, "result", failure), false);
      assert.equal(
        state.work.result.recovery.failure.classification,
        "uncertain",
      );
    }
    const evidence = await validate();
    assert.equal(evidence.worktreeObservation.postCommandStatus, "unchanged");
  }));

test("dirty diagnostics bound record count and path display while retaining explicit omission facts", async () =>
  fixture(async ({ validate }) => {
    const command = `node -e 'const fs=require("fs"); for(let i=0;i<50;i++) { const dir="generated/"+String(i).padStart(2,"0")+"/"+"x".repeat(180); fs.mkdirSync(dir,{recursive:true}); fs.writeFileSync(dir+"/"+"y".repeat(180),"private file contents") }'`;
    await assert.rejects(validate([command]), (error) => {
      const detail = mutationDetail(error);
      assert.equal(detail.paths.length, 20);
      assert.equal(detail.omittedRecords, 30);
      assert.ok(JSON.stringify(detail.paths).length <= 8192);
      assert.ok(
        detail.paths.every(
          (entry) => entry.path.length === 256 && entry.pathTruncated,
        ),
      );
      assert.doesNotMatch(error.message, /private file contents/);
      return true;
    });
  }));

test("escaped control-character paths bound the complete diagnostic envelope independently of record count", async () =>
  fixture(async ({ validate }) => {
    const command = `node -e 'const fs=require("fs"); for(let i=0;i<16;i++) fs.writeFileSync(String(i).padStart(2,"0")+String.fromCharCode(1).repeat(220), "private contents")'`;
    await assert.rejects(validate([command]), (error) => {
      const detail = mutationDetail(error);
      assert.ok(JSON.stringify(detail).length <= 8192);
      assert.ok(detail.paths.length > 0 && detail.paths.length < 20);
      assert.equal(detail.paths.length + detail.omittedRecords, 16);
      assert.ok(detail.paths.every((entry) => !entry.pathTruncated));
      assert.doesNotMatch(error.message, /private contents/);
      return true;
    });
  }));

test("validation descendants left running are stopped and the tree they changed is judged", async () =>
  fixture(async ({ root, validate }) => {
    const saved = lingeringDescendants.graceMilliseconds;
    lingeringDescendants.graceMilliseconds = 200;
    const groups = [];
    try {
      await withProcessCancellation(
        undefined,
        async () => {
          // A descendant that finishes within the grace period is waited for.
          const evidence = await validate(["(sleep 0.05) >/dev/null 2>&1 &"]);
          assert.equal(
            evidence.worktreeObservation.subprocessOwnership,
            "settled",
          );
          assert.equal(evidence.commands[0].stoppedLeftovers, undefined);
          // One still running after it is stopped, and its receipt says so.
          const stopped = await validate(["sleep 30 >/dev/null 2>&1 &"]);
          assert.equal(stopped.commands[0].stoppedLeftovers, 1);
          assert.match(
            commandPassEvidence(stopped.commands).content,
            /"stoppedLeftovers":1/,
          );
          // One still running after it is stopped; the change it made counts.
          await assert.rejects(
            validate(["printf dirty >> base.txt; sleep 30 >/dev/null 2>&1 &"]),
            (error) => {
              assert.ok(error instanceof CandidateValidationFailure, error);
              assert.match(error.message, /modified the result tree/);
              return true;
            },
          );
        },
        (owned, settled) => groups.push({ owned, settled }),
      );
    } finally {
      lingeringDescendants.graceMilliseconds = saved;
    }
    assert.ok(groups.length > 0);
    for (const { owned } of groups)
      assert.equal(processGroupExists(owned.pid), false);
    assert.equal(
      groups.filter(({ settled }) => settled).length,
      groups.filter(({ settled }) => !settled).length,
    );
    // The stopped validation's worktree is removed like any other.
    assert.deepEqual(
      readdirSync(join(root, "validation")).filter(
        (name) => name !== "empty-gh-config",
      ),
      [],
    );
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
      // This is a local validator fixture, not an LFS publication test. Publish
      // the ordinary initial target first, then seed its exact pointer using
      // the controller's pinned Git environment, excluding inherited filters.
      writeFileSync(
        join(target.checkout, ".gitattributes"),
        "asset.bin filter=lfs diff=lfs merge=lfs -text\n",
      );
      writeFileSync(
        join(target.checkout, "asset.bin"),
        `version https://git-lfs.github.com/spec/v1\noid sha256:${digest}\nsize ${bytes.length}\n`,
      );
      pinnedGit(target.checkout, "add", ".gitattributes", "asset.bin");
      pinnedGit(
        target.checkout,
        "-c",
        "user.name=Factory Test",
        "-c",
        "user.email=factory-test@example.invalid",
        "commit",
        "-m",
        "Seed local validator pointer",
      );
      target.baseSha = pinnedGit(target.checkout, "rev-parse", "HEAD");
      target.treeSha = pinnedGit(target.checkout, "rev-parse", "HEAD^{tree}");
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
      // A singleton array coerces to the same hex string under RegExp.test;
      // the actual nonempty hydrated baseline must still refuse its shape.
      let malformedReviewCalls = 0;
      for (const digest of [
        [evidence.worktreeObservation.postHydrationStatus.porcelainSha256],
        1,
        null,
        {},
      ]) {
        const invalid = structuredClone(evidence);
        invalid.worktreeObservation.postHydrationStatus.porcelainSha256 =
          digest;
        await assert.rejects(
          reviewAcceptance({
            model: {
              async reviewResult() {
                malformedReviewCalls++;
                throw new Error("Should not submit malformed observation");
              },
            },
            checkout: target.checkout,
            baseSha: target.baseSha,
            commit: target.baseSha,
            evidence: invalid,
            criteria: ["Commands preserve post-hydration status."],
            sources: [],
          }),
          /canonical exact-tree evidence/,
        );
      }
      assert.equal(malformedReviewCalls, 0);
      // Raw porcelain preserves staged vs unstaged columns and trailing bytes.
      assert.equal(
        evidence.worktreeObservation.postHydrationStatus.porcelainSha256,
        hash(" M asset.bin\n"),
      );
      await assert.rejects(
        validate(
          [
            "git -c filter.lfs.process= -c filter.lfs.clean=cat -c filter.lfs.required=false add asset.bin",
          ],
          selected,
          store,
        ),
        (error) => {
          assert.deepEqual(mutationDetail(error), {
            paths: [
              { phase: "before", status: " M", path: "asset.bin" },
              { phase: "after", status: "M ", path: "asset.bin" },
            ],
            omittedRecords: 0,
          });
          return true;
        },
      );
      await assert.rejects(
        validate(["printf generated > generated.txt"], selected, store),
        (error) => {
          assert.deepEqual(mutationDetail(error), {
            paths: [{ phase: "after", status: "??", path: "generated.txt" }],
            omittedRecords: 0,
          });
          return true;
        },
      );
      await assert.rejects(
        validate(["printf bad > asset.bin"], selected, store),
        /could not restore selected LFS bytes/,
      );
    },
    { "base.txt": "public baseline\n" },
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
        const state = await application.runObjective(1);
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
