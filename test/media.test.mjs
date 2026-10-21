// Isolated even when run with a bare `node --test`, not only via npm test.
import "./isolate-env.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalContentStore } from "../dist/content/local.js";
import {
  assertAssetCaptureReceipt,
  captureAssetSets,
  materializeAssetSet,
} from "../dist/media.js";

function git(path, ...args) {
  return execFileSync("git", ["-C", path, ...args], {
    encoding: "utf8",
  }).trim();
}

test("a complete selected AssetSet is retained by digest and committed through the target LFS rule", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-media-test-"));
  try {
    const checkout = join(root, "target");
    mkdirSync(checkout);
    git(checkout, "init", "-b", "main");
    writeFileSync(
      join(checkout, ".gitattributes"),
      "approved/*.png filter=lfs diff=lfs merge=lfs -text\n",
    );
    git(checkout, "add", ".gitattributes");
    git(
      checkout,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "LFS policy",
    );
    const base = git(checkout, "rev-parse", "HEAD");
    const staging = join(root, "staging");
    const item = {
      id: "media",
      ownedPaths: ["approved/selected.png", "approved/selected.json"],
      expectedOutputRoles: ["image", "metadata"],
      requiredLfsRoles: ["image"],
    };
    const source = readFileSync(
      new URL(
        "./fixtures/disposable-target/assets/source.png",
        import.meta.url,
      ),
    );
    const sets = ["first", "second"].map((id) => {
      const directory = join(staging, ".factory-media", id);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "image.png"), source);
      writeFileSync(join(directory, "metadata.json"), JSON.stringify({ id }));
      return {
        id,
        members: [
          {
            role: "image",
            path: `.factory-media/${id}/image.png`,
            mediaType: "image/png",
            destination: "approved/selected.png",
          },
          {
            role: "metadata",
            path: `.factory-media/${id}/metadata.json`,
            mediaType: "application/json",
            destination: "approved/selected.json",
          },
        ],
        provenance: {
          source: "assets/source.png",
          rights: "fixture authored for this test",
          visibility: "repository",
          lineage: ["assets/source.png"],
        },
      };
    });
    const store = new LocalContentStore(join(root, "content"));
    const originalManifest = Buffer.from(
      "  " + JSON.stringify({ sets }, null, 2) + "\n\n",
    );
    writeFileSync(join(staging, ".factory-assets.json"), originalManifest);
    const captured = await captureAssetSets(store, staging, item, sets, {
      harness: "integration-filesystem",
    });
    assert.equal(captured.length, 2);
    assert.equal(existsSync(join(staging, ".factory-media")), false);
    assert.deepEqual(captured[0].manifestRef, captured[1].manifestRef);
    for (const set of captured) {
      assertAssetCaptureReceipt(set);
      assert.equal(set.capture.declarationDigest, set.manifestRef.digest);
      assert.equal(set.manifestRef.bytes, originalManifest.length);
    }
    rmSync(join(staging, ".factory-assets.json"));
    assert.deepEqual(
      store.readBytes(captured[0].manifestRef),
      originalManifest,
    );
    assert.deepEqual(
      store.readBytes(captured[1].manifestRef),
      originalManifest,
    );
    const rebound = structuredClone(captured[0]);
    rebound.manifestRef.digest = "0".repeat(64);
    assert.throws(
      () => assertAssetCaptureReceipt(rebound),
      /original manifest/,
    );
    assert.equal(
      captured[0].members[0].ref.digest,
      createHash("sha256").update(source).digest("hex"),
    );
    const selected = await materializeAssetSet({
      checkout,
      workRoot: join(root, "worktrees"),
      baseCommit: base,
      item,
      set: captured[1],
      store,
    });
    const pointer = git(
      checkout,
      "show",
      `${selected.changeRef}:approved/selected.png`,
    );
    assert.match(pointer, /version https:\/\/git-lfs.github.com\/spec\/v1/);
    assert.match(pointer, new RegExp(captured[1].members[0].ref.digest));
    assert.equal(
      git(checkout, "show", `${selected.changeRef}:approved/selected.json`),
      '{"id":"second"}',
    );
    assert.notEqual(selected.changeRef, base);
    const rejectedStaging = join(root, "rejected-staging");
    mkdirSync(rejectedStaging);
    const malformedOriginal = Buffer.from('  {"sets": [\n');
    writeFileSync(
      join(rejectedStaging, ".factory-assets.json"),
      malformedOriginal,
    );
    let rejectedOriginal;
    await assert.rejects(
      captureAssetSets(
        store,
        rejectedStaging,
        item,
        sets,
        { harness: "integration-filesystem" },
        [],
        (original) => {
          rejectedOriginal = original;
        },
      ),
      /JSON/,
    );
    assert.equal(rejectedOriginal.path, ".factory-assets.json");
    rmSync(rejectedStaging, { recursive: true });
    assert.deepEqual(store.readBytes(rejectedOriginal.ref), malformedOriginal);
    const duplicateStaging = join(root, "duplicate-staging");
    for (const set of sets) {
      const directory = join(duplicateStaging, ".factory-media", set.id);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "image.png"), source);
      writeFileSync(join(directory, "metadata.json"), '{"id":"same"}');
    }
    writeFileSync(
      join(duplicateStaging, ".factory-assets.json"),
      originalManifest,
    );
    await assert.rejects(
      captureAssetSets(store, duplicateStaging, item, sets, {
        harness: "integration-filesystem",
      }),
      /distinct content/,
    );
    assert.equal(
      existsSync(
        join(duplicateStaging, ".factory-media", "first", "image.png"),
      ),
      true,
    );
    assert.equal(
      existsSync(
        join(duplicateStaging, ".factory-media", "second", "image.png"),
      ),
      true,
    );
    const unsafeStaging = join(root, "unsafe-staging");
    mkdirSync(unsafeStaging);
    // The same deliberately invalid fixture value exercised by the real
    // scanner integration; this is not an account credential.
    const unsafeOriginal = Buffer.from(
      JSON.stringify({
        sets,
        credentialFixture: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      }),
    );
    writeFileSync(join(unsafeStaging, ".factory-assets.json"), unsafeOriginal);
    let checkpointedUnsafeOriginal = false;
    await assert.rejects(
      captureAssetSets(
        store,
        unsafeStaging,
        item,
        sets,
        {
          harness: "integration-filesystem",
        },
        [],
        () => {
          checkpointedUnsafeOriginal = true;
        },
      ),
      /Secretlint found suspected secret/,
    );
    assert.equal(checkpointedUnsafeOriginal, false);
    assert.throws(
      () =>
        store.readBytes({
          digest: createHash("sha256").update(unsafeOriginal).digest("hex"),
          bytes: unsafeOriginal.length,
          mediaType: "application/json",
        }),
      /ENOENT/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
