import { describe, expect, it } from "vitest";

import { interpretContentsResponse } from "../src/github.js";

/**
 * Tests for reading a repository's own files, added to close Gate 3's finding
 * F2 and Gate 4's F4 (IMPLEMENTATION-PLAN.md §10.5, §10.8): no tool exposed the
 * target repository's layout or contents, so a Work Item's `scope` was compiled
 * from the Objective's prose alone. A wrong guess there does not fail at compile
 * time — it fails later as an `untouched` verdict, after an agent run has been
 * spent.
 *
 * Every case below is a response shape verified live against the contents API
 * (2026-09-02) rather than assumed, because two of them were wrong on the first
 * attempt: a directory is an array with no `type` field at all, and an empty
 * file is indistinguishable from a >1 MB file except by `size`. The point of
 * these tests is that a caller can never mistake "I could not read this" for
 * "this was empty".
 */

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");

describe("interpretContentsResponse", () => {
  it("returns the decoded text of an ordinary file", () => {
    const result = interpretContentsResponse(
      "package.json",
      { type: "file", size: 20, content: b64('{"name":"x"}') },
      40_000,
    );
    expect(result).toEqual({
      path: "package.json",
      exists: true,
      content: '{"name":"x"}',
      truncated: false,
    });
  });

  it("clips an oversized file and says so", () => {
    const result = interpretContentsResponse(
      "src/big.ts",
      { type: "file", size: 10, content: b64("abcdefghij") },
      4,
    );
    expect(result.content).toBe("abcd");
    expect(result.truncated).toBe(true);
  });

  // The first implementation checked `type` before checking for an array, so a
  // directory fell through to the size branch and was reported as too large to
  // read — wrong, and unactionable for the caller.
  it("recognises a directory, which the API returns as a bare array", () => {
    const result = interpretContentsResponse(
      "src",
      [{ name: "a.ts" }, { name: "b.ts" }],
      40_000,
    );
    expect(result.exists).toBe(true);
    expect(result.content).toBeUndefined();
    expect(result.unreadable).toContain("directory with 2 entries");
    expect(result.truncated).toBe(false);
  });

  // Gate 6 finding. `truncated: true` here meant "I refused to read this", but
  // every other use of the flag means "there is more of it" — so a caller that
  // pages or retries on `truncated` would loop forever against a directory that
  // will never yield file content.
  it("does not call a directory truncated, because nothing was truncated", () => {
    for (const body of [
      [{ name: "a.ts" }],
      { type: "symlink", size: 11, content: null, target: "../include/" },
      { type: "submodule", size: 0, content: null },
    ]) {
      const result = interpretContentsResponse("x", body, 40_000);
      expect(result.unreadable).toBeDefined();
      expect(result.truncated).toBe(false);
    }
  });

  // The opposite case, kept true: the file exists and has bytes this reader did
  // not get, which is exactly what `truncated` is for.
  it("still calls a file too large to send truncated", () => {
    const result = interpretContentsResponse(
      "assets/huge.bin",
      { type: "file", size: 2_000_000, content: "" },
      40_000,
    );
    expect(result.truncated).toBe(true);
  });

  it("returns a genuinely empty file as empty rather than unreadable", () => {
    const result = interpretContentsResponse(
      "src/.gitkeep",
      { type: "file", size: 0, content: "" },
      40_000,
    );
    expect(result.content).toBe("");
    expect(result.unreadable).toBeUndefined();
    expect(result.truncated).toBe(false);
  });

  // Same empty `content` as the case above; only `size` separates them. Reading
  // this as an empty file would tell a caller a 2 MB file contained nothing.
  it("does not report a file too large to send as an empty one", () => {
    const result = interpretContentsResponse(
      "assets/huge.bin",
      { type: "file", size: 2_000_000, content: "" },
      40_000,
    );
    expect(result.content).toBeUndefined();
    expect(result.unreadable).toContain("2000000-byte file");
    expect(result.truncated).toBe(true);
  });

  it("reports a symlink as unreadable rather than guessing", () => {
    const result = interpretContentsResponse(
      "link",
      { type: "symlink", size: 12 },
      40_000,
    );
    expect(result.unreadable).toBe("not a file (symlink)");
    expect(result.content).toBeUndefined();
  });

  // Exact response bodies from nodejs/node and git/git (2026-09-02). A review
  // claimed both of these arrive as `type: "file"` — a symlink carrying `target`
  // and a submodule carrying `submodule_git_url` — which would have meant this
  // function reported a submodule as an empty file. Probing the live API showed
  // otherwise, and these cases exist so that stays true.
  it("reports a symlink to a directory as a symlink, and says where it points", () => {
    const result = interpretContentsResponse(
      "deps/v8/third_party/ittapi/ittapi-rs/include",
      { type: "symlink", size: 11, content: null, target: "../include/" },
      40_000,
    );
    expect(result.unreadable).toBe("not a file (symlink) — points at ../include/");
    expect(result.content).toBeUndefined();
  });

  it("reports a submodule as a submodule, not as an empty file", () => {
    const result = interpretContentsResponse(
      "sha1collisiondetection",
      {
        type: "submodule",
        size: 0,
        content: null,
        submodule_git_url: "https://github.com/cr-marcstevens/sha1collisiondetection.git",
      },
      40_000,
    );
    expect(result.unreadable).toContain("not a file (submodule)");
    expect(result.unreadable).toContain("sha1collisiondetection.git");
    expect(result.content).toBeUndefined();
  });

  // The other half of the same live check: GitHub *resolves* a symlink that
  // points at a file, returning the target's real content and size with
  // `target: null`. Treating that as unreadable would refuse a file the caller
  // can perfectly well have.
  it("returns the resolved content of a symlink to a file", () => {
    const result = interpretContentsResponse(
      "deps/v8/third_party/ittapi/ittapi-rs/CMakeLists.txt",
      { type: "file", size: 2513, content: b64("cmake_minimum_required"), target: null },
      40_000,
    );
    expect(result.content).toBe("cmake_minimum_required");
    expect(result.unreadable).toBeUndefined();
  });

  it("never claims content it does not have, whatever the shape", () => {
    for (const body of [null, undefined, {}, { type: "submodule" }]) {
      const result = interpretContentsResponse("x", body, 40_000);
      expect(result.content).toBeUndefined();
      expect(result.unreadable).toBeDefined();
      expect(result.truncated).toBe(false);
    }
  });
});
