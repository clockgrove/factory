import { describe, expect, it } from "vitest";
import {
  assertQualificationEvidenceValue,
  boundedQualificationEvidenceText,
  largeFileRefusalEvidenceBytes,
  MAX_LARGE_FILE_REFUSAL_EVIDENCE_BYTES,
  MAX_ORDINARY_QUALIFICATION_EVIDENCE_BYTES,
} from "../scripts/qualification-evidence-boundary.mjs";

describe("qualification evidence persistence boundary", () => {
  const wrapperWithStringBytes = (key: string, nested: boolean, target: number) => {
    const empty = nested ? { [key]: { proof: "" } } : { [key]: "" };
    const overhead = Buffer.byteLength(JSON.stringify(empty, null, 2));
    return "x".repeat(target - overhead);
  };

  it("retains the ordinary cap and derives the extended envelope from exact persisted parts", () => {
    const token = `github_pat_${"a".repeat(30)}`;
    const evidence = {
      protocol: "fixture",
      ordinary: "o".repeat(1024),
      largeFileRefusal: { protocol: "refusal-v1", proof: "p".repeat(4096) },
    };
    const text = boundedQualificationEvidenceText(evidence, token, {
      allowLargeFileRefusal: true,
    });
    expect(JSON.parse(text)).toEqual(evidence);
    expect(Buffer.byteLength(`${text}\n`)).toBeLessThanOrEqual(
      MAX_ORDINARY_QUALIFICATION_EVIDENCE_BYTES + MAX_LARGE_FILE_REFUSAL_EVIDENCE_BYTES,
    );
    expect(largeFileRefusalEvidenceBytes(evidence.largeFileRefusal)).toBeGreaterThan(4096);
  });

  it("rejects an oversized or credential-bearing extension even when the property exists", () => {
    expect(() =>
      boundedQualificationEvidenceText(
        {
          protocol: "fixture",
          largeFileRefusal: { proof: "x".repeat(MAX_LARGE_FILE_REFUSAL_EVIDENCE_BYTES) },
        },
        "redact-me",
        { allowLargeFileRefusal: true },
      ),
    ).toThrow(/refusal evidence exceeds bound/);
    expect(() =>
      boundedQualificationEvidenceText(
        {
          protocol: "fixture",
          largeFileRefusal: { proof: `authorization: bearer ${"x".repeat(32)}` },
        },
        "redact-me",
        { allowLargeFileRefusal: true },
      ),
    ).toThrow(/credential/);
  });

  it("preserves the exact ordinary cap and does not grant extension budget from a property", () => {
    const ordinary = wrapperWithStringBytes(
      "ordinary",
      false,
      MAX_ORDINARY_QUALIFICATION_EVIDENCE_BYTES - 1,
    );
    expect(
      Buffer.byteLength(`${boundedQualificationEvidenceText({ ordinary }, "redact-me")}\n`),
    ).toBe(MAX_ORDINARY_QUALIFICATION_EVIDENCE_BYTES);
    expect(() =>
      boundedQualificationEvidenceText({ ordinary: `${ordinary}x` }, "redact-me"),
    ).toThrow(/qualification evidence exceeds bound/);
    expect(() =>
      boundedQualificationEvidenceText(
        { largeFileRefusal: { proof: "valid but untrusted" } },
        "redact-me",
      ),
    ).toThrow(/not authorized/);
  });

  it("counts the exact pretty-printed extension at its cap and composes the full envelope", () => {
    const proof = wrapperWithStringBytes(
      "largeFileRefusal",
      true,
      MAX_LARGE_FILE_REFUSAL_EVIDENCE_BYTES,
    );
    expect(largeFileRefusalEvidenceBytes({ proof })).toBe(MAX_LARGE_FILE_REFUSAL_EVIDENCE_BYTES);
    expect(() => largeFileRefusalEvidenceBytes({ proof: `${proof}x` })).toThrow(/exceeds bound/);

    const ordinary = wrapperWithStringBytes(
      "ordinary",
      false,
      MAX_ORDINARY_QUALIFICATION_EVIDENCE_BYTES - 1,
    );
    const text = boundedQualificationEvidenceText(
      { ordinary, largeFileRefusal: { proof } },
      "redact-me",
      { allowLargeFileRefusal: true },
    );
    expect(Buffer.byteLength(`${text}\n`)).toBeLessThanOrEqual(
      MAX_ORDINARY_QUALIFICATION_EVIDENCE_BYTES + MAX_LARGE_FILE_REFUSAL_EVIDENCE_BYTES,
    );
  });

  it("uses the compact shared validator for ordinary refusal subdocuments", () => {
    expect(assertQualificationEvidenceValue({ safe: true }, 32, "fixture")).toEqual({
      safe: true,
    });
    expect(() =>
      assertQualificationEvidenceValue({ unsafe: "sk-abcdefghijklmnopqrstuvwxyz" }, 1024),
    ).toThrow(/credential/);
  });
});
