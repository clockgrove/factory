// Factory runs no repository hooks, so Git LFS's pre-push hook does not
// upload the objects behind a worker's LFS pointers. Delivery finds the
// pointers a result adds and pushes their objects before the branch.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RegularDelivery } from "../dist/delivery/regular.js";
import { addsLfsPointers } from "../dist/media.js";
import { createTarget, git } from "./support/integration-fixture.mjs";

function commitIn(checkout, files) {
  const worktree = `${checkout}-work-${Object.keys(files).length}`;
  git(checkout, "worktree", "add", "-q", "--detach", worktree, "HEAD");
  for (const [path, bytes] of Object.entries(files))
    writeFileSync(join(worktree, path), bytes);
  git(worktree, "add", "-A");
  git(
    worktree,
    "-c",
    "user.name=Worker",
    "-c",
    "user.email=worker@example.invalid",
    "commit",
    "-q",
    "-m",
    "Worker result",
  );
  return git(worktree, "rev-parse", "HEAD");
}

test("delivery pushes the LFS objects of a worker's LFS-tracked files", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-lfs-delivery-"));
  try {
    const target = createTarget(root, {
      ".gitattributes": "*.bin filter=lfs diff=lfs merge=lfs -text\n",
    });
    // The repository's own configuration sets up the LFS filter (and, for
    // plain git, its pre-push hook).
    git(target.checkout, "lfs", "install", "--local");
    const model = Buffer.from("model bytes that belong in LFS\n");
    const digest = createHash("sha256").update(model).digest("hex");
    const commit = commitIn(target.checkout, { "model.bin": model });
    assert.match(
      git(target.checkout, "show", `${commit}:model.bin`),
      /^version https:\/\/git-lfs\.github\.com\/spec\/v1/,
    );
    assert.equal(
      await addsLfsPointers(target.checkout, target.baseSha, commit),
      true,
    );
    const delivery = new RegularDelivery(target.checkout, {
      defaultBranch: async () => "main",
      findOpenPullRequest: async () => undefined,
      publish: async () => ({ number: 7, headSha: commit }),
    });
    const result = await delivery.publish({
      item: { id: "model", title: "Add the model" },
      baseSha: target.baseSha,
      treeSha: git(target.checkout, "rev-parse", `${commit}^{tree}`),
      changeRef: commit,
      branch: "factory/objective-1/model",
      // Not a selected AssetSet: only the pointer scan finds the object.
      lfs: false,
    });
    assert.equal(result.headSha, commit);
    assert.equal(
      existsSync(
        join(
          target.origin,
          "lfs",
          "objects",
          digest.slice(0, 2),
          digest.slice(2, 4),
          digest,
        ),
      ),
      true,
      "the LFS object reached the remote with the branch",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a result without LFS pointers needs no LFS push", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-lfs-delivery-"));
  try {
    const target = createTarget(root);
    // Small files, including one that only resembles a pointer header.
    const commit = commitIn(target.checkout, {
      "notes.txt": "plain text\n",
      "almost.txt": "version https://git-lfs.github.com/spec/v1\nno oid\n",
    });
    assert.equal(
      await addsLfsPointers(target.checkout, target.baseSha, commit),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
