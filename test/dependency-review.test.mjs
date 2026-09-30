import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { workItemReviewEvidence } from "../dist/validation.js";
import { createTarget, git } from "./support/integration-fixture.mjs";

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "factory-dependency-review-"));
  try {
    const target = createTarget(root);
    const state = { baseSha: target.baseSha, graph: { items: [] }, work: {} };
    let head = target.baseSha;
    const append = (id, dependencies, path, text) => {
      const item = {
        id,
        title: id,
        acceptance: [`${path} exists`],
        dependencies,
        ownedPaths: [path],
        validation: [{ command: `test -f ${path}` }],
      };
      state.graph.items.push(item);
      git(target.checkout, "checkout", "--detach", head);
      mkdirSync(dirname(join(target.checkout, path)), { recursive: true });
      writeFileSync(join(target.checkout, path), text);
      git(target.checkout, "add", path);
      git(
        target.checkout,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-m",
        `Factory: ${id}`,
      );
      const commit = git(target.checkout, "rev-parse", "HEAD");
      const tree = git(target.checkout, "rev-parse", "HEAD^{tree}");
      const integrated = git(
        target.checkout,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit-tree",
        tree,
        "-p",
        head,
        "-p",
        commit,
        "-m",
        `Merge ${id}`,
      );
      state.work[id] = {
        status: "done",
        executionBaseSha: head,
        integratedShaAtStart: head,
        baseSha: head,
        changeRef: commit,
        treeSha: tree,
        integratedSha: integrated,
        pullRequest: state.graph.items.length,
        validation: {
          treeSha: tree,
          commands: [
            {
              index: 0,
              command: item.validation[0].command,
              passed: true,
              exitCode: 0,
              treeSha: tree,
            },
          ],
          criteria: [{ detail: "prior-model-verdict-not-authority" }],
        },
      };
      head = integrated;
      return item;
    };
    const foundation = append(
      "foundation",
      [],
      "scripts/check.mjs",
      "// actual predecessor test implementation\n".repeat(100),
    );
    append("unrelated", [], "unrelated.txt", "must not be evidence\n");
    const policy = append(
      "policy",
      [],
      ".gitattributes",
      "assets/image.bin filter=lfs diff=lfs merge=lfs -text\n",
    );
    const media = append(
      "media",
      ["policy"],
      "assets/image.bin",
      "selected bytes\n",
    );
    const integration = append(
      "integration",
      ["foundation", "media"],
      "result.md",
      "usage note\n",
    );
    const request = {
      state,
      item: integration,
      checkout: target.checkout,
      delivery: "regular",
    };
    run({ request, foundation, policy, media, integration });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("declared dependency closure excludes unrelated work and keeps historical receipts distinct", () => {
  fixture(({ request, media }) => {
    const evidence = workItemReviewEvidence(request);
    const proof = JSON.parse(
      evidence.find((entry) => entry.path === "Completed dependency results")
        .content,
    );
    assert.deepEqual(
      proof.work.map((entry) => entry.id),
      ["foundation", "policy", "media"],
    );
    assert.doesNotMatch(
      JSON.stringify(evidence),
      /must not be evidence|prior-model-verdict-not-authority/,
    );
    for (const record of proof.work) {
      assert.notEqual(
        record.validationTreeSha,
        request.state.work.integration.treeSha,
      );
      assert.equal(record.validationCommands[0].treeSha, record.resultTreeSha);
      assert.ok(record.integratedCommitSha);
    }
    const mediaEvidence = workItemReviewEvidence({ ...request, item: media });
    assert.deepEqual(
      JSON.parse(
        mediaEvidence.find(
          (entry) => entry.path === "Completed dependency results",
        ).content,
      ).work.map((entry) => entry.id),
      ["policy"],
    );
    // Historical receipts remain bound to their original result tree.
    assert.equal(
      proof.work[0].resultTreeSha,
      request.state.work.foundation.treeSha,
    );
  });
});

test("dependency projection rejects unavailable, mismatched and non-ancestral proof", () => {
  fixture(({ request }) => {
    for (const [mutate, expected] of [
      [
        (s) => {
          s.work.policy.status = "waiting";
        },
        /completed delivery result/,
      ],
      [
        (s) => {
          delete s.work.policy.validation;
        },
        /complete result-review identity/,
      ],
      [
        (s) => {
          s.work.policy.treeSha = s.work.foundation.treeSha;
        },
        /commit\/tree mismatch/,
      ],
      [
        (s) => {
          s.work.policy.validation.commands[0].treeSha =
            s.work.foundation.treeSha;
        },
        /exact result tree and order/,
      ],
      [
        (s) => {
          s.work.policy.validation.commands = [];
        },
        /commands differ/,
      ],
      [
        (s) => {
          s.work.policy.validation.commands[0].command = "invented";
        },
        /commands differ/,
      ],
      [
        (s) => {
          s.work.integration.baseSha = s.baseSha;
        },
        /result in reviewed base/,
      ],
      [
        (s) => {
          s.work.policy.integratedSha = s.work.policy.changeRef;
        },
        /not bound to the exact delivered result head/,
      ],
      [
        (s) => {
          s.graph.items.find((i) => i.id === "policy").ownedPaths = [
            "elsewhere",
          ];
        },
        /outside accepted ownership/,
      ],
    ]) {
      const state = structuredClone(request.state);
      mutate(state);
      assert.throws(
        () => workItemReviewEvidence({ ...request, state }),
        expected,
      );
    }
  });
});

test("dependency patches retain explicit bounded incompleteness", () => {
  const saved = process.env.FACTORY_RESULT_REVIEW_TEXT_BUDGET_BYTES;
  process.env.FACTORY_RESULT_REVIEW_TEXT_BUDGET_BYTES = "128";
  try {
    fixture(({ request }) => {
      const evidence = workItemReviewEvidence(request);
      const delta = evidence.find(
        (entry) => entry.path === "Work Item Git delta: foundation",
      );
      assert.equal(delta.complete, true);
      assert.equal(JSON.parse(delta.content).contentComplete, false);
      assert.ok(
        evidence.some(
          (entry) =>
            entry.path.startsWith(`${delta.path} file `) &&
            entry.complete === false,
        ),
      );
      assert.match(delta.content, /"truncated":true/);
      const records = JSON.parse(
        evidence.find((entry) => entry.path === "Completed dependency results")
          .content,
      );
      assert.equal(records.work[0].validationCommands[0].passed, true);
      assert.equal(records.work[0].evidenceSource, delta.path);
    });
  } finally {
    if (saved === undefined)
      delete process.env.FACTORY_RESULT_REVIEW_TEXT_BUDGET_BYTES;
    else process.env.FACTORY_RESULT_REVIEW_TEXT_BUDGET_BYTES = saved;
  }
});
