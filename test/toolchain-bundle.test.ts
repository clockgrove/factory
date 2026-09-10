import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { sha256Tree, sha256TreeSync } from "../src/runtime/toolchain-bundle.js";

describe("managed runtime tree identity", () => {
  it("uses canonical code-unit path order and ignores ambient extraction modes", async () => {
    const left = await mkdtemp(join(tmpdir(), "factory-tree-left-"));
    const right = await mkdtemp(join(tmpdir(), "factory-tree-right-"));
    const paths = ["z-file", "A-file", "a.file", "_-file"];
    for (const path of paths) await writeFile(join(left, path), `content:${path}`);
    for (const path of [...paths].reverse()) await writeFile(join(right, path), `content:${path}`);
    for (const path of paths) {
      await chmod(join(left, path), 0o600);
      await chmod(join(right, path), 0o755);
    }
    const digest = await sha256Tree(left);
    expect(await sha256Tree(right)).toBe(digest);
    expect(sha256TreeSync(left)).toBe(digest);
    expect(sha256TreeSync(right)).toBe(digest);
  });
});
