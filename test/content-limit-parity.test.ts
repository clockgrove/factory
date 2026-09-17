import { describe, expect, it } from "vitest";

import { IsolatedValidationCaptureRequestSchema } from "../src/backends/sandbox-common.js";
import { ArtifactFileSchema } from "../src/execution/artifact-content.js";
import { canonicalLfsPointer } from "../src/execution/artifacts.js";
import { MAX_PRODUCT_FILE_BYTES } from "../src/protocol/limits.js";
import { RepositoryCaptureRuntimeRequestSchema } from "../src/validation/local-capture-runtime.js";
import { RepositoryCaptureCollectedFileSchema } from "../src/validation/repository-capture.js";

const digest = "a".repeat(64);

describe("canonical product-file byte limit", () => {
  it("uses one 100 MiB boundary across artifacts, LFS, and capture transports", () => {
    expect(MAX_PRODUCT_FILE_BYTES).toBe(104_857_600);
    for (const bytes of [MAX_PRODUCT_FILE_BYTES - 1, MAX_PRODUCT_FILE_BYTES]) {
      expect(() =>
        ArtifactFileSchema.parse({
          path: "result.bin",
          action: "write",
          mode: "100644",
          bytes,
          digest,
          mediaType: "application/octet-stream",
          generated: true,
        }),
      ).not.toThrow();
      expect(() => canonicalLfsPointer(digest, bytes)).not.toThrow();
      expect(() =>
        RepositoryCaptureCollectedFileSchema.parse({
          recipeId: "capture",
          roleId: "result",
          path: "result.bin",
          mediaType: "application/octet-stream",
          bytes,
          digest,
        }),
      ).not.toThrow();
      expect(() =>
        RepositoryCaptureRuntimeRequestSchema.parse({
          protocol: "clockgrove.factory/repository-capture-request",
          validationInvocationDigest: digest,
          recipes: [
            {
              id: "capture",
              digest,
              command: { recipeId: "recipe", recipeDigest: digest, command: "npm run capture" },
              scenario: { id: "fixed", fixture: null, seed: null },
              outputs: [
                {
                  roleId: "result",
                  mediaType: "application/octet-stream",
                  maxBytes: bytes,
                  path: "result.bin",
                },
              ],
            },
          ],
          maximumTotalBytes: bytes,
        }),
      ).not.toThrow();
      expect(() =>
        IsolatedValidationCaptureRequestSchema.parse({
          protocol: "clockgrove.factory/repository-capture-request",
          validationInvocationDigest: digest,
          environmentIdentity: `fixture@sha256:${digest}`,
          validationDeadline: "2026-09-17T00:01:00.000Z",
          recipes: [
            {
              id: "capture",
              digest,
              command: "npm run capture",
              scenario: { id: "fixed", fixture: null, seed: null },
              outputs: [
                {
                  roleId: "result",
                  mediaType: "application/octet-stream",
                  maxBytes: bytes,
                },
              ],
              comparison: {
                kind: "exact",
                outputRoleId: "result",
                expectedDescriptorDigest: digest,
              },
            },
          ],
          maximumTotalBytes: bytes,
        }),
      ).not.toThrow();
    }
  });

  it("rejects limit plus one everywhere", () => {
    const bytes = MAX_PRODUCT_FILE_BYTES + 1;
    expect(() =>
      ArtifactFileSchema.parse({
        path: "result.bin",
        action: "write",
        mode: "100644",
        bytes,
        digest,
        mediaType: "application/octet-stream",
        generated: true,
      }),
    ).toThrow();
    expect(() => canonicalLfsPointer(digest, bytes)).toThrow(/invalid LFS object size/);
    expect(() =>
      RepositoryCaptureCollectedFileSchema.parse({
        recipeId: "capture",
        roleId: "result",
        path: "result.bin",
        mediaType: "application/octet-stream",
        bytes,
        digest,
      }),
    ).toThrow();
    expect(() =>
      RepositoryCaptureRuntimeRequestSchema.parse({
        protocol: "clockgrove.factory/repository-capture-request",
        validationInvocationDigest: digest,
        recipes: [
          {
            id: "capture",
            digest,
            command: { recipeId: "recipe", recipeDigest: digest, command: "npm run capture" },
            scenario: { id: "fixed", fixture: null, seed: null },
            outputs: [
              {
                roleId: "result",
                mediaType: "application/octet-stream",
                maxBytes: bytes,
                path: "result.bin",
              },
            ],
          },
        ],
        maximumTotalBytes: MAX_PRODUCT_FILE_BYTES,
      }),
    ).toThrow();
    expect(() =>
      IsolatedValidationCaptureRequestSchema.parse({
        protocol: "clockgrove.factory/repository-capture-request",
        validationInvocationDigest: digest,
        environmentIdentity: `fixture@sha256:${digest}`,
        validationDeadline: "2026-09-17T00:01:00.000Z",
        recipes: [
          {
            id: "capture",
            digest,
            command: "npm run capture",
            scenario: { id: "fixed", fixture: null, seed: null },
            outputs: [
              {
                roleId: "result",
                mediaType: "application/octet-stream",
                maxBytes: bytes,
              },
            ],
            comparison: {
              kind: "exact",
              outputRoleId: "result",
              expectedDescriptorDigest: digest,
            },
          },
        ],
        maximumTotalBytes: MAX_PRODUCT_FILE_BYTES,
      }),
    ).toThrow();
  });
});
