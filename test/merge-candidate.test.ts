import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  bindMergeCandidateValidation,
  verifyMergeCandidateSquash,
  verifyMergeCandidateValidation,
  type MergeCandidateValidationEvidence,
} from "../src/publication/merge-candidate.js";
import { createValidationEvidence } from "../src/validation/evidence.js";
import { bindValidationToPublishedHead } from "../src/validation/plan.js";

const sha = (value: string) => value.repeat(40);
const digest = (value: string) => value.repeat(64);
function fixture() {
  const source = bindValidationToPublishedHead({
    validation: { passed: true, digest: digest("a"), baseSha: sha("a"), outputTreeSha: sha("b") },
    publishedBaseSha: sha("a"),
    publishedTreeSha: sha("b"),
    publishedHeadSha: sha("c"),
  });
  const validation = createValidationEvidence({
    protocol: "clockgrove.factory/validation-v1",
    artifactDigest: digest("d"),
    baseSha: sha("d"),
    outputTreeSha: sha("e"),
    commands: [{ command: "npm test", exitCode: 0, durationMs: 5 }],
    passed: true,
    startedAt: "2026-09-05T00:00:00Z",
    completedAt: "2026-09-05T00:00:01Z",
  });
  const evidence = bindMergeCandidateValidation({ source, validation });
  const store = {
    readCommit: vi.fn(async (oid: string) => ({
      oid,
      parentOids: [sha("d")],
      treeOid: sha("e"),
      message: "merge",
      serverTime: new Date(),
    })),
  };
  return { source, validation, evidence, store };
}
function resign<T extends { digest: string }>(input: T): T {
  const { digest: _digest, ...fields } = input;
  return { ...input, digest: createHash("sha256").update(JSON.stringify(fields)).digest("hex") };
}

describe("merge candidate evidence", () => {
  it("keeps the unchanged PR head proof separate from its new target base and candidate tree", () => {
    const f = fixture();
    const original = structuredClone(f.source);
    expect(f.evidence.sourceHeadSha).toBe(sha("c"));
    expect(f.evidence.sourceTreeSha).toBe(sha("b"));
    expect(f.evidence.candidateOutputTreeSha).toBe(sha("e"));
    expect(f.evidence.sourceBaseSha).not.toBe(f.evidence.targetBaseSha);
    verifyMergeCandidateValidation(f.evidence, f.source, sha("d"));
    expect(f.source).toEqual(original);
    expect(Object.keys(f.evidence)).not.toContain("publishedHeadSha");
  });
  it("has canonical identity independent of candidate object property order", () => {
    const f = fixture();
    const reversed = Object.fromEntries(
      Object.entries(f.evidence).reverse(),
    ) as MergeCandidateValidationEvidence;
    expect(() => verifyMergeCandidateValidation(reversed, f.source)).not.toThrow();
    expect(bindMergeCandidateValidation({ source: f.source, validation: f.validation })).toEqual(
      f.evidence,
    );
  });
  it.each([
    "sourceExactHeadValidationDigest",
    "sourceBaseSha",
    "sourceHeadSha",
    "sourceTreeSha",
    "targetBaseSha",
    "candidateOutputTreeSha",
    "candidateArtifactDigest",
    "candidateValidationDigest",
    "digest",
  ])("rejects tampered %s", (field) => {
    const f = fixture();
    const value = field.toLowerCase().includes("digest") ? digest("f") : sha("f");
    expect(() =>
      verifyMergeCandidateValidation({ ...f.evidence, [field]: value }, f.source),
    ).toThrow();
  });
  it.each([
    "protocol",
    "sourceExactHeadValidationDigest",
    "sourceBaseSha",
    "sourceHeadSha",
    "sourceTreeSha",
    "targetBaseSha",
    "candidateOutputTreeSha",
    "candidateArtifactDigest",
    "candidateValidationDigest",
    "digest",
  ])("rejects malformed %s", (field) => {
    const f = fixture();
    expect(() =>
      verifyMergeCandidateValidation({ ...f.evidence, [field]: "invalid" }, f.source),
    ).toThrow();
  });
  it("rejects unknown evidence fields instead of laundering data into a proof", () => {
    const f = fixture();
    expect(() =>
      verifyMergeCandidateValidation(
        { ...f.evidence, unexpected: true } as MergeCandidateValidationEvidence,
        f.source,
      ),
    ).toThrow();
  });
  it.each(["sourceExactHeadValidationDigest", "sourceBaseSha", "sourceHeadSha", "sourceTreeSha"])(
    "rejects rehashed mismatched source binding %s",
    (field) => {
      const f = fixture();
      const value = field.endsWith("Digest") ? digest("f") : sha("f");
      expect(() =>
        verifyMergeCandidateValidation(resign({ ...f.evidence, [field]: value }), f.source),
      ).toThrow("original published head");
    },
  );
  it.each([
    "digest",
    "protocol",
    "baseSha",
    "outputTreeSha",
    "publishedHeadSha",
    "validationDigest",
  ])("rejects invalid source proof %s even when outer evidence is self-consistent", (field) => {
    const f = fixture();
    const source = { ...f.source, [field]: "invalid" };
    expect(() => bindMergeCandidateValidation({ ...f, source })).toThrow();
    expect(() => verifyMergeCandidateValidation(f.evidence, source)).toThrow();
  });
  it("rejects a rehashed wrong source protocol", () => {
    const f = fixture();
    const source = resign({ ...f.source, protocol: "wrong" as typeof f.source.protocol });
    expect(() => bindMergeCandidateValidation({ ...f, source })).toThrow();
  });
  it("rejects failed validation even with a valid full validation digest", () => {
    const f = fixture();
    const { digest: _digest, ...fields } = f.validation;
    const validation = createValidationEvidence({ ...fields, passed: false });
    expect(() => bindMergeCandidateValidation({ ...f, validation })).toThrow("did not pass");
  });
  it.each(["failed-command", "failure-reason", "reversed-time"])(
    "rejects self-consistently hashed contradictory passing validation: %s",
    (kind) => {
      const f = fixture();
      const { digest: _digest, ...fields } = f.validation;
      const validation = resign(
        createValidationEvidence({
          ...fields,
          ...(kind === "failed-command"
            ? { commands: [{ command: "npm test", exitCode: 1, durationMs: 5 }] }
            : {}),
          ...(kind === "failure-reason" ? { failureReason: "failed" } : {}),
          ...(kind === "reversed-time" ? { completedAt: "2026-09-04T23:59:59Z" } : {}),
        }),
      );
      expect(() => bindMergeCandidateValidation({ source: f.source, validation })).toThrow(
        "contradictory outcome",
      );
    },
  );
  it.each(["baseSha", "outputTreeSha", "artifactDigest", "digest", "protocol"])(
    "verifies full candidate validation before binding %s",
    (field) => {
      const f = fixture();
      expect(() =>
        bindMergeCandidateValidation({ ...f, validation: { ...f.validation, [field]: "invalid" } }),
      ).toThrow();
    },
  );
  it("detects valid-shaped full validation tampering", () => {
    const f = fixture();
    expect(() =>
      bindMergeCandidateValidation({
        ...f,
        validation: { ...f.validation, outputTreeSha: sha("f") },
      }),
    ).toThrow("digest mismatch");
  });
  it("rejects unchanged target base and mismatched expected target", () => {
    const f = fixture();
    const { digest: _digest, ...fields } = f.validation;
    expect(() =>
      bindMergeCandidateValidation({
        ...f,
        validation: createValidationEvidence({ ...fields, baseSha: f.source.baseSha }),
      }),
    ).toThrow("changed target base");
    expect(() => verifyMergeCandidateValidation(f.evidence, f.source, sha("f"))).toThrow(
      "expected base",
    );
    expect(() => verifyMergeCandidateValidation(f.evidence, f.source, "invalid")).toThrow();
  });
  it("verifies the actual squash candidate tree and singleton target parent", async () => {
    const f = fixture();
    await expect(
      verifyMergeCandidateSquash(f.store, f.source, f.evidence, sha("f")),
    ).resolves.toBeUndefined();
    expect(f.store.readCommit).toHaveBeenCalledExactlyOnceWith(sha("f"));
  });
  it.each(["old-base", "old-tree", "other-tree", "merge-parents", "no-parent", "wrong-oid"])(
    "rejects squash %s",
    async (kind) => {
      const f = fixture();
      f.store.readCommit.mockResolvedValue({
        oid: kind === "wrong-oid" ? sha("a") : sha("f"),
        parentOids:
          kind === "old-base"
            ? [sha("a")]
            : kind === "merge-parents"
              ? [sha("d"), sha("c")]
              : kind === "no-parent"
                ? []
                : [sha("d")],
        treeOid: kind === "old-tree" ? sha("b") : kind === "other-tree" ? sha("f") : sha("e"),
        message: "merge",
        serverTime: new Date(),
      });
      await expect(
        verifyMergeCandidateSquash(f.store, f.source, f.evidence, sha("f")),
      ).rejects.toThrow("merge candidate tree");
    },
  );
  it("rejects invalid proof or commit SHA before any store read", async () => {
    const f = fixture();
    await expect(
      verifyMergeCandidateSquash(
        f.store,
        f.source,
        { ...f.evidence, digest: digest("f") },
        sha("f"),
      ),
    ).rejects.toThrow();
    await expect(
      verifyMergeCandidateSquash(f.store, f.source, f.evidence, "invalid"),
    ).rejects.toThrow();
    expect(f.store.readCommit).not.toHaveBeenCalled();
  });
});
