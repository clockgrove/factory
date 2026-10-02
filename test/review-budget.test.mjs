import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  objectiveReviewEvidence,
  workItemReviewEvidence,
} from "../dist/validation.js";
import { createTarget, git } from "./support/integration-fixture.mjs";

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "factory-actual-review-budget-"));
  const saved = process.env.FACTORY_RESULT_REVIEW_TEXT_BUDGET_BYTES;
  try {
    const target = createTarget(root);
    const state = { baseSha: target.baseSha, graph: { items: [] }, work: {} };
    let head = target.baseSha;
    const append = (id, files, dependencies = []) => {
      const item = {
        id,
        title: id,
        acceptance: [`${id} result is present`],
        dependencies,
        ownedPaths: Object.keys(files),
        validation: [],
      };
      state.graph.items.push(item);
      git(target.checkout, "checkout", "--detach", head);
      for (const [path, content] of Object.entries(files))
        writeFileSync(join(target.checkout, path), content);
      git(target.checkout, "add", "--all");
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
        validation: { treeSha: tree, commands: [] },
      };
      head = integrated;
      state.integratedSha = integrated;
      return item;
    };
    const final = (budget) => {
      process.env.FACTORY_RESULT_REVIEW_TEXT_BUDGET_BYTES = String(budget);
      return objectiveReviewEvidence({
        state,
        checkout: target.checkout,
        candidateCommitSha: head,
        candidateTreeSha: git(target.checkout, "rev-parse", `${head}^{tree}`),
      }).evidence;
    };
    run({ append, final, state, checkout: target.checkout });
  } finally {
    if (saved === undefined)
      delete process.env.FACTORY_RESULT_REVIEW_TEXT_BUDGET_BYTES;
    else process.env.FACTORY_RESULT_REVIEW_TEXT_BUDGET_BYTES = saved;
    rmSync(root, { recursive: true, force: true });
  }
}

function patchBytes(evidence) {
  return evidence.reduce(
    (total, entry) =>
      total +
      [
        ...entry.content.matchAll(
          /--- Exact patch [^\n]* ---\n([\s\S]*?)(?=\n--- Exact patch |$)/g,
        ),
      ].reduce((sum, match) => sum + Buffer.byteLength(match[1]), 0),
    0,
  );
}

test("uneven files use the available budget rather than per-file shares", () => {
  fixture(({ append, final }) => {
    append("foundation", {
      "a-large.txt": "large line\n".repeat(1800),
      "z-small.txt": "small\n",
    });
    const evidence = final(24000);
    assert.ok(evidence.every((entry) => entry.complete));
    assert.ok(patchBytes(evidence) > 18000);
    assert.ok(patchBytes(evidence) <= 24000);
  });
});

test("ordinary final and dependency packets share actual bytes across uneven items", () => {
  fixture(({ append, final, state, checkout }) => {
    append("foundation", { "large.txt": "large line\n".repeat(1800) });
    append("policy", { "policy.txt": "policy\n" });
    const integration = append(
      "integration",
      { "integration.txt": "integration\n" },
      ["foundation", "policy"],
    );
    const evidence = final(24000);
    assert.ok(evidence.every((entry) => entry.complete));
    assert.ok(patchBytes(evidence) <= 24000);
    const dependencies = workItemReviewEvidence({
      state,
      item: integration,
      checkout,
      delivery: "regular",
    }).filter((entry) => entry.path.startsWith("Work Item Git delta:"));
    assert.ok(dependencies.every((entry) => entry.complete));
    assert.ok(patchBytes(dependencies) <= 24000);
  });
});

test("oversized UTF-8 patches stay bounded and explicit omissions retain identities", () => {
  fixture(({ append, final }) => {
    append("foundation", {
      "a-large.txt": "界🙂\n".repeat(1800),
      "z-small.txt": "small\n",
    });
    append("integration", { "integration.txt": "integration\n" });
    for (const budget of [1, 221, 222, 223, 224, 225, 1000]) {
      const evidence = final(budget);
      assert.ok(evidence.some((entry) => !entry.complete));
      assert.ok(
        patchBytes(evidence) <= budget,
        `${patchBytes(evidence)} > ${budget}`,
      );
      for (const entry of evidence.filter((source) =>
        source.path.startsWith("Work Item Git delta:"),
      )) {
        assert.doesNotMatch(entry.content, /�/);
        const metadata = JSON.parse(entry.content.split("\n")[0]);
        assert.match(metadata.resultTreeSha, /^[a-f0-9]{40}$/);
        assert.ok(metadata.changes?.length > 0 || metadata.file?.path);
      }
    }
  });
});

test("a complete file delta stays independently available beside a truncated sibling", () => {
  fixture(({ append, final }) => {
    append("foundation", {
      "a-small.txt": "independent small proof\n",
      "z-large.txt": "large sibling\n".repeat(1800),
    });
    const evidence = final(1000);
    const descriptors = evidence.find(
      (entry) => entry.path === "Work Item Git delta: foundation",
    );
    const small = evidence.find((entry) =>
      entry.path.endsWith('file "a-small.txt"'),
    );
    const large = evidence.find((entry) =>
      entry.path.endsWith('file "z-large.txt"'),
    );
    assert.equal(descriptors.complete, true);
    assert.equal(JSON.parse(descriptors.content).contentComplete, false);
    assert.equal(small.complete, true);
    assert.equal(large.complete, false);
    assert.match(small.content, /independent small proof/);
    assert.doesNotMatch(descriptors.content, /independent small proof/);
    assert.equal(
      JSON.parse(small.content.split("\n")[0]).resultTreeSha,
      JSON.parse(descriptors.content).resultTreeSha,
    );
    assert.equal(
      JSON.parse(small.content.split("\n")[0]).file.path,
      "a-small.txt",
    );
    assert.ok(patchBytes(evidence) <= 1000);
  });
});
