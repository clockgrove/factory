import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cachePayload,
  materializePayload,
  releaseAllArtifactContent,
} from "../src/execution/artifact-content.js";
import {
  retainScopedArtifact,
  withArtifactContentScope,
} from "../src/execution/artifact-content-scope.js";
import { normalizeArtifact, payloadPatchMarker } from "../src/execution/artifacts.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
}));

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await releaseAllArtifactContent();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function source(text: string) {
  const root = await fs.mkdtemp(join(tmpdir(), "factory-scope-test-"));
  roots.push(root);
  const path = join(root, "source");
  await fs.writeFile(path, text);
  return { root, path };
}
const latch = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("real independent content owner scopes", () => {
  it("protects duplicate payload bytes across nested owners and releases after the last owner", async () => {
    const input = await source("shared payload");
    let payload!: Awaited<ReturnType<typeof cachePayload>>;
    await withArtifactContentScope(async () => {
      payload = await cachePayload(input.path);
      const artifact = normalizeArtifact({
        baseSha: "a".repeat(40),
        patch: payloadPatchMarker(payload),
        payload,
        changedPaths: [],
        outcome: "succeeded",
      });
      retainScopedArtifact(artifact);
      retainScopedArtifact(artifact);
      await withArtifactContentScope(async () => {
        const duplicate = await cachePayload(input.path);
        expect(duplicate.digest).toBe(payload.digest);
        await materializePayload(duplicate, join(input.root, "nested"));
      });
      await materializePayload(payload, join(input.root, "outer"));
      await expect(releaseAllArtifactContent()).rejects.toThrow("active");
    });
    await expect(materializePayload(payload, join(input.root, "expired"))).rejects.toThrow(
      "unavailable",
    );
  });

  it("does not sweep another owner's active empty capture root", async () => {
    const first = await source("first"),
      second = await source("different payload");
    const allocated = latch(),
      finishWrite = latch();
    const write = fs.writeFile;
    let intercept = false;
    vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      if (intercept && typeof args[0] === "string" && /^[a-f0-9]{64}$/.test(basename(args[0]))) {
        intercept = false;
        allocated.resolve();
        await finishWrite.promise;
      }
      return write(...args);
    });
    const finishFirst = latch(),
      firstReady = latch();
    const a = withArtifactContentScope(async () => {
      await cachePayload(first.path);
      firstReady.resolve();
      await finishFirst.promise;
    });
    await firstReady.promise;
    intercept = true;
    const b = withArtifactContentScope(async () => {
      const payload = await cachePayload(second.path);
      await materializePayload(payload, join(second.root, "copy"));
      expect(await fs.readFile(join(second.root, "copy"), "utf8")).toBe("different payload");
    });
    await allocated.promise;
    finishFirst.resolve();
    await a;
    finishWrite.resolve();
    await b;
  });

  it("cleans captured output on operation failure without hiding the original error", async () => {
    const input = await source("failed owner");
    const error = new Error("original failure");
    let payload!: Awaited<ReturnType<typeof cachePayload>>;
    await expect(
      withArtifactContentScope(async () => {
        payload = await cachePayload(input.path);
        throw error;
      }),
    ).rejects.toBe(error);
    await expect(materializePayload(payload, join(input.root, "missing"))).rejects.toThrow(
      "unavailable",
    );
  });
});
