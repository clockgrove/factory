import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gitAsync } from "../dist/process.js";
import { deliveryDescription } from "../dist/delivery/description.js";
import { validateTree } from "../dist/validation.js";
import {
  resultTreeInventory,
  unchangedResultByteEvidence,
} from "../dist/result-evidence.js";
import { createHash } from "node:crypto";

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
  }).trim();
}

test("controller Git ignores executable configuration shared by a worker worktree", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "factory-git-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = join(root, "checkout");
  mkdirSync(checkout);
  git(checkout, "init", "-b", "main");
  writeFileSync(join(checkout, "notes.txt"), "base\n");
  writeFileSync(join(checkout, "unchanged.txt"), "complete unchanged bytes\n");
  const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0xff, 0x0a]);
  writeFileSync(join(checkout, "source.png"), binary);
  writeFileSync(join(checkout, "empty.txt"), "");
  writeFileSync(join(checkout, "large.bin"), Buffer.alloc(24_000, 0xff));
  writeFileSync(join(checkout, "line\nnote.txt"), "literal path\n");
  symlinkSync("notes.txt", join(checkout, "note-link"));
  git(checkout, "add", ".");
  const identity = [
    "-c",
    "user.name=Factory",
    "-c",
    "user.email=factory@example.invalid",
  ];
  git(checkout, ...identity, "commit", "-m", "base");
  const baseSha = git(checkout, "rev-parse", "HEAD");
  const worker = join(root, "worker");
  git(checkout, "worktree", "add", "--detach", worker, "HEAD");
  const marker = join(root, "ran");
  const executable = join(root, "repository-program");
  writeFileSync(executable, `#!/bin/sh\necho ran >>'${marker}'\nexit 1\n`, {
    mode: 0o755,
  });
  const hooks = join(root, "hooks");
  mkdirSync(hooks);
  writeFileSync(
    join(hooks, "pre-commit"),
    `#!/bin/sh\necho hook >>'${marker}'\nexit 1\n`,
    { mode: 0o755 },
  );
  git(worker, "config", "core.fsmonitor", executable);
  git(worker, "config", "diff.external", executable);
  git(worker, "config", "core.hooksPath", hooks);
  git(worker, "config", "commit.gpgSign", "true");
  git(worker, "config", "gpg.program", executable);
  // Prove this is live executable configuration, rather than an inert input.
  git(worker, "status", "--porcelain");
  assert.equal(existsSync(marker), true);
  rmSync(marker);
  writeFileSync(join(worker, "notes.txt"), "changed\n");
  await gitAsync(worker, "status", "--porcelain");
  await gitAsync(worker, "diff");
  await gitAsync(worker, "add", "notes.txt");
  await gitAsync(worker, ...identity, "commit", "-m", "safe controller commit");
  assert.equal(existsSync(marker), false);
  assert.equal(git(worker, "show", "HEAD:notes.txt"), "changed");
  assert.doesNotMatch(git(worker, "cat-file", "commit", "HEAD"), /gpgsig/);
  const changeRef = git(worker, "rev-parse", "HEAD");
  const treeSha = git(worker, "rev-parse", "HEAD^{tree}");
  // Read planning uses exact immutable regular-blob sizes, without invoking
  // worker configuration, following symlinks or claiming contents from sizes.
  const inventory = resultTreeInventory(checkout, treeSha, 4_000);
  const inventoryFacts = JSON.parse(inventory.content);
  assert.equal(inventory.complete, true);
  assert.equal(inventoryFacts.treeSha, treeSha);
  assert.deepEqual(inventoryFacts.paths, [
    "empty.txt",
    "large.bin",
    "line\nnote.txt",
    "note-link",
    "notes.txt",
    "source.png",
    "unchanged.txt",
  ]);
  assert.deepEqual(inventoryFacts.fileSizes, [
    { path: "empty.txt", bytes: 0 },
    { path: "large.bin", bytes: 24_000 },
    { path: "line\nnote.txt", bytes: 13 },
    { path: "notes.txt", bytes: 8 },
    { path: "source.png", bytes: binary.length },
    { path: "unchanged.txt", bytes: 25 },
  ]);
  const limitedInventory = resultTreeInventory(checkout, treeSha, 100);
  assert.equal(limitedInventory.complete, false);
  assert.ok(Buffer.byteLength(limitedInventory.content) <= 100);
  const pathOnlyInventory = resultTreeInventory(checkout, treeSha, 256);
  const pathOnlyFacts = JSON.parse(pathOnlyInventory.content);
  assert.equal(pathOnlyInventory.complete, true);
  assert.deepEqual(pathOnlyFacts.paths, inventoryFacts.paths);
  assert.ok((pathOnlyFacts.fileSizes?.length ?? 0) < 6);
  assert.ok(Buffer.byteLength(pathOnlyInventory.content) <= 256);
  assert.equal(existsSync(marker), false);
  // The shared review producer reads actual immutable blobs despite hostile
  // worker Git configuration; current checkout bytes never supply the baseline.
  const comparisons = unchangedResultByteEvidence(
    checkout,
    baseSha,
    changeRef,
    16_000,
  );
  assert.ok(comparisons.textBytes <= 16_000);
  assert.ok(comparisons.rawBytes <= 48_000);
  const comparison = (path) => {
    const source = comparisons.sources.find(
      (entry) => JSON.parse(entry.content).path === path,
    );
    assert.ok(source);
    return { source, receipt: JSON.parse(source.content) };
  };
  for (const path of ["unchanged.txt", "source.png", "empty.txt"]) {
    const { source, receipt } = comparison(path);
    assert.equal(source.complete, true);
    assert.equal(receipt.byteEqual, true);
    assert.equal(receipt.comparison, "complete-raw-Git-blob-Buffer.equals");
    assert.equal(receipt.comparisonBaseCommitSha, baseSha);
    assert.equal(
      receipt.comparisonBaseTreeSha,
      git(checkout, "rev-parse", `${baseSha}^{tree}`),
    );
    assert.equal(receipt.resultCommitSha, changeRef);
    assert.equal(receipt.resultTreeSha, treeSha);
    assert.equal(receipt.base.blobOid, receipt.result.blobOid);
    assert.equal(receipt.base.byteCount, receipt.result.byteCount);
    assert.equal(receipt.base.sha256, receipt.result.sha256);
  }
  const image = comparison("source.png").receipt;
  assert.deepEqual(
    Buffer.from(image.baselineContent.content, "base64"),
    binary,
  );
  assert.equal(
    image.base.sha256,
    createHash("sha256").update(binary).digest("hex"),
  );
  assert.equal(image.baselineContent.complete, true);
  assert.equal(comparison("unchanged.txt").receipt.baselineContent, undefined);
  for (const path of ["notes.txt", "note-link", "large.bin"]) {
    const { source, receipt } = comparison(path);
    assert.equal(source.complete, false);
    assert.equal(receipt.availability, "unavailable");
    assert.equal(receipt.byteEqual, undefined);
  }
  const bounded = unchangedResultByteEvidence(
    checkout,
    baseSha,
    changeRef,
    800,
  );
  assert.ok(bounded.textBytes <= 800);
  assert.ok(bounded.sources.length > 0);
  assert.ok(bounded.sources.every((source) => source.complete === false));
  assert.match(bounded.sources[0].content, /unavailable/);
  const missing = unchangedResultByteEvidence(
    checkout,
    "0".repeat(40),
    changeRef,
    800,
  );
  assert.ok(missing.sources.every((source) => source.complete === false));
  assert.match(missing.sources[0].content, /commit unavailable/);
  assert.equal(existsSync(marker), false);
  const command = `node -e 'if (require("node:fs").readFileSync("notes.txt", "utf8") !== "changed\\n") process.exit(1)'`;
  const validation = await validateTree(
    checkout,
    join(root, "validation"),
    changeRef,
    treeSha,
    [command],
  );
  const request = {
    item: {
      goal: "Update the published note while keeping repository-provided Git programs disabled. Controller reads and commits must use the hardened Git environment so worker configuration cannot execute code.",
      validation: [{ command }],
    },
    baseSha,
    changeRef,
    treeSha,
  };
  const context = {
    repository: "example/notes",
    objective: 1,
    issue: 2,
    validation,
  };
  const body = deliveryDescription(checkout, request, context);
  t.diagnostic(body);
  assert.match(body, /https:\/\/github\.com\/example\/notes\/issues\/2/);
  assert.match(body, /https:\/\/github\.com\/example\/notes\/issues\/1/);
  assert.match(body, /Updates <code>notes\.txt<\/code>/);
  assert.match(body, /Controller validation passed on this candidate/);
  assert.ok(body.includes(command));
  assert.equal(existsSync(marker), false);
  assert.match(
    deliveryDescription(checkout, request, {
      ...context,
      validation: {
        ...validation,
        treeSha: git(checkout, "rev-parse", `${baseSha}^{tree}`),
      },
    }),
    /receipts are unavailable/,
  );
  assert.throws(
    () =>
      deliveryDescription(checkout, { ...request, treeSha: "0".repeat(40) }),
    /tree mismatch/,
  );
  assert.doesNotMatch(
    deliveryDescription(
      checkout,
      {
        ...request,
        item: {
          ...request.item,
          goal: "Configured value private-example-value",
        },
      },
      context,
      ["private-example-value"],
    ),
    /private-example-value/,
  );
});
