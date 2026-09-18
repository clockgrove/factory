import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assessPublishedPreflight,
  lifecycleTargetBinding,
  qualifyPublishedArtifacts,
  receiptWithDigest,
  verifyPublishedTarball,
  verifyRetainedRelease,
} from "../scripts/verify-published-artifacts.mjs";
import { canonicalChecksumBytes, sha256 } from "../scripts/release-integrity.mjs";

const version = "2.0.27-beta.0";
const commit = "a".repeat(40);
const inventorySha256 = "b".repeat(64);
const tarball = Buffer.from("published npm tarball fixture\n");
const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
const npmShasum = createHash("sha1").update(tarball).digest("hex");

interface TestManifest {
  name: string;
  version: string;
  distTag: string;
  tarball: {
    file: string;
    integrity: string;
    npmShasum: string;
    packedBytes: number;
    unpackedBytes: number;
    sha256: string;
  };
  sbom: { file: string; format: string; sha256: string };
  bundleInventory: { file: string; components: number; sha256: string };
  thirdPartyNotices: { file: string; sha256: string };
  provenance: {
    file: string;
    protocol: string;
    sha256: string;
    sourceCommit: string;
    sourceDirty: boolean;
  };
  checksums: { file: string; sha256: string };
}

interface NpmDocument {
  name: string;
  version: string;
  _metadataUrl: string;
  _distTagVersion: string;
  dist: { integrity: string; shasum: string; unpackedSize: number; tarball: string };
}

interface TestPort {
  registryDocument: ReturnType<typeof vi.fn>;
  remoteTag: ReturnType<typeof vi.fn>;
  hostPreflight: ReturnType<typeof vi.fn>;
  targetPreflight: ReturnType<typeof vi.fn>;
  install: ReturnType<typeof vi.fn>;
  cleanup: ReturnType<typeof vi.fn>;
  host: ReturnType<typeof vi.fn>;
}

function write(path: string, value: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

function releaseFixture(): { root: string; releaseDirectory: string; manifest: TestManifest } {
  const root = mkdtempSync(join(tmpdir(), "factory-published-qualifier-test-"));
  const releaseDirectory = join(root, "release");
  mkdirSync(releaseDirectory);
  const sbom = Buffer.from("{}\n");
  const provenance = {
    protocol: "clockgrove.factory/release-provenance-v1",
    source: {
      repository: "https://github.com/clockgrove/factory.git",
      commit,
      dirty: false,
    },
    package: { name: "@clockgrove/factory", version, distTag: "beta" },
    subjects: [] as Array<{ file: string; sha256: string }>,
  };
  const provenanceFile = `factory-${version}.provenance.json`;
  const tarballFile = `clockgrove-factory-${version}.tgz`;
  const sbomFile = `factory-${version}.cdx.json`;
  const notices = { file: "THIRD_PARTY_NOTICES.txt", sha256: "c".repeat(64) };
  const descriptors = {
    tarball: {
      file: tarballFile,
      integrity,
      npmShasum,
      packedBytes: tarball.length,
      unpackedBytes: 4096,
      sha256: sha256(tarball),
    },
    sbom: { file: sbomFile, format: "CycloneDX 1.5", sha256: sha256(sbom) },
    bundleInventory: {
      file: "dist/bundle-inventory.json",
      components: 4,
      sha256: inventorySha256,
    },
    thirdPartyNotices: notices,
  };
  provenance.subjects = [
    descriptors.tarball,
    descriptors.sbom,
    descriptors.bundleInventory,
    notices,
  ];
  const provenanceBytes = Buffer.from(`${JSON.stringify(provenance, null, 2)}\n`);
  const provenanceDescriptor = {
    file: provenanceFile,
    protocol: provenance.protocol,
    sha256: sha256(provenanceBytes),
    sourceCommit: commit,
    sourceDirty: false,
  };
  const checksums = canonicalChecksumBytes([
    descriptors.tarball,
    descriptors.sbom,
    provenanceDescriptor,
  ]);
  const manifest = {
    name: "@clockgrove/factory",
    version,
    distTag: "beta",
    ...descriptors,
    provenance: provenanceDescriptor,
    checksums: { file: "SHA256SUMS", sha256: sha256(checksums) },
  };
  write(join(releaseDirectory, tarballFile), tarball);
  write(join(releaseDirectory, sbomFile), sbom);
  write(join(releaseDirectory, provenanceFile), provenanceBytes);
  write(join(releaseDirectory, "SHA256SUMS"), checksums);
  write(join(releaseDirectory, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { root, releaseDirectory, manifest };
}

function npmDocument(manifest: TestManifest): NpmDocument {
  return {
    name: manifest.name,
    version: manifest.version,
    _metadataUrl: `https://registry.npmjs.org/%40clockgrove%2ffactory/${version}`,
    _distTagVersion: version,
    dist: {
      integrity: manifest.tarball.integrity,
      shasum: manifest.tarball.npmShasum,
      unpackedSize: manifest.tarball.unpackedBytes,
      tarball: `https://registry.npmjs.org/@clockgrove/factory/-/${manifest.tarball.file}`,
    },
  };
}

function tag() {
  return {
    name: `v${version}`,
    object: "d".repeat(40),
    commit,
    url: `https://github.com/clockgrove/factory/tree/v${version}`,
  };
}

function identity() {
  return {
    version,
    inventorySha256,
    bundles: [
      { file: "factory.js", bytes: 100, sha256: "e".repeat(64) },
      { file: "mcp-server.js", bytes: 200, sha256: "f".repeat(64) },
    ],
  };
}

function port(manifest: TestManifest, overrides: Partial<TestPort> = {}): TestPort {
  return {
    registryDocument: vi.fn(async () => npmDocument(manifest)),
    remoteTag: vi.fn(async () => tag()),
    hostPreflight: vi.fn(async () => undefined),
    targetPreflight: vi.fn(async () => ({
      controllerAbsent: true,
      codexCommand: "codex",
      managerVersion: "259",
    })),
    install: vi.fn(async () => ({
      npmIdentity: identity(),
      pluginIdentity: identity(),
      surfaces: {
        npm: { command: "factory --version", version },
        plugin: { server: "factory", version, tools: 20 },
      },
      lifecycle: {
        results: [
          { operation: "install" },
          { operation: "status" },
          { operation: "restart" },
          { operation: "status-after-restart" },
          { operation: "uninstall" },
        ],
        cleanup: { installed: true, enabled: true, active: true },
      },
    })),
    cleanup: vi.fn(() => undefined),
    host: vi.fn(() => ({ platform: "linux", architecture: "x64", release: "fixture" })),
    ...overrides,
  };
}

describe("published-artifact qualifier", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("authenticates retained manifest, checksums, provenance, npm metadata, and tag", () => {
    const fixture = releaseFixture();
    roots.push(fixture.root);
    const release = verifyRetainedRelease(fixture.releaseDirectory);

    expect(assessPublishedPreflight(release, npmDocument(fixture.manifest), tag())).toMatchObject({
      package: { name: "@clockgrove/factory", version },
      registry: { integrity, shasum: npmShasum },
      tag: { name: `v${version}`, commit },
    });
    expect(release.releaseManifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(() => verifyPublishedTarball(tarball, release.manifest)).not.toThrow();
    expect(() => verifyPublishedTarball(Buffer.from("different"), release.manifest)).toThrow(
      "npm tarball size differs",
    );
  });

  it("performs a read-only preflight without installing or creating the root", async () => {
    const fixture = releaseFixture();
    roots.push(fixture.root);
    const installRoot = join(fixture.root, "published-install");
    const selectedPort = port(fixture.manifest);

    const result = await qualifyPublishedArtifacts(
      {
        releaseDirectory: fixture.releaseDirectory,
        installRoot,
        repository: "private/example",
        checkout: "/home/example/private",
        preflightOnly: true,
      },
      selectedPort,
    );

    expect(result).toMatchObject({
      kind: "published-artifact-preflight",
      result: "passed",
      version,
      lifecycleTargetBinding: lifecycleTargetBinding("private/example", "/home/example/private"),
    });
    expect(selectedPort.install).not.toHaveBeenCalled();
    expect(selectedPort.cleanup).not.toHaveBeenCalled();
    expect(selectedPort.targetPreflight).toHaveBeenCalledWith(
      "private/example",
      "/home/example/private",
      "codex",
    );
  });

  it("emits one bounded digest-bearing receipt only after complete cleanup", async () => {
    const fixture = releaseFixture();
    roots.push(fixture.root);
    const installRoot = join(fixture.root, "published-install");
    const output = join(fixture.root, "evidence", "published.json");
    const selectedPort = port(fixture.manifest);
    const binding = lifecycleTargetBinding("private/example", "/home/example/private");

    const result = await qualifyPublishedArtifacts(
      {
        releaseDirectory: fixture.releaseDirectory,
        installRoot,
        repository: "private/example",
        checkout: "/home/example/private",
        lifecycleAck: binding,
        output,
      },
      selectedPort,
    );

    expect(selectedPort.install).toHaveBeenCalledTimes(1);
    expect(selectedPort.cleanup).toHaveBeenCalledWith(installRoot);
    expect(selectedPort.remoteTag).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      kind: "published-artifact-qualification",
      result: "passed",
      source: { commit, tag: `v${version}` },
      release: { bundleInventorySha256: inventorySha256 },
      privateSmokeHandoff: { targetBinding: binding, status: "artifact-authority-ready" },
      cleanup: { controllerAbsent: true, installRootRemoved: true },
    });
    const receipt = JSON.parse(readFileSync(output, "utf8"));
    const expected = receiptWithDigest(receipt);
    expect(receipt.receiptDigest).toBe(expected.receiptDigest);
    expect(readFileSync(output).length).toBeLessThan(128 * 1024);
    expect(readFileSync(output, "utf8")).not.toContain("private/example");
    expect(readFileSync(output, "utf8")).not.toContain("/home/example/private");
  });

  it.each([
    [
      "registry integrity",
      (document: NpmDocument) => (document.dist.integrity = `sha512-${"A".repeat(88)}`),
    ],
    ["registry shasum", (document: NpmDocument) => (document.dist.shasum = "0".repeat(40))],
    ["registry dist-tag", (document: NpmDocument) => (document._distTagVersion = "2.0.26")],
  ])("fails closed on a mismatched %s", async (_name, mutate) => {
    const fixture = releaseFixture();
    roots.push(fixture.root);
    const document = npmDocument(fixture.manifest);
    mutate(document);
    const selectedPort = port(fixture.manifest, {
      registryDocument: vi.fn(async () => document),
    });

    await expect(
      qualifyPublishedArtifacts(
        {
          releaseDirectory: fixture.releaseDirectory,
          installRoot: join(fixture.root, "install"),
          repository: "private/example",
          checkout: "/home/example/private",
          preflightOnly: true,
        },
        selectedPort,
      ),
    ).rejects.toThrow(/npm registry/);
    expect(selectedPort.install).not.toHaveBeenCalled();
  });

  it("reports an unavailable publication without installing", async () => {
    const fixture = releaseFixture();
    roots.push(fixture.root);
    const selectedPort = port(fixture.manifest, {
      registryDocument: vi.fn(async () => {
        throw new Error(`published npm package @clockgrove/factory@${version} is unavailable`);
      }),
    });

    await expect(
      qualifyPublishedArtifacts(
        {
          releaseDirectory: fixture.releaseDirectory,
          installRoot: join(fixture.root, "install"),
          repository: "private/example",
          checkout: "/home/example/private",
          preflightOnly: true,
        },
        selectedPort,
      ),
    ).rejects.toThrow("published npm package");
    expect(selectedPort.remoteTag).not.toHaveBeenCalled();
    expect(selectedPort.install).not.toHaveBeenCalled();
  });

  it("fails closed when the tag moved or changes during qualification", async () => {
    const fixture = releaseFixture();
    roots.push(fixture.root);
    const movedPort = port(fixture.manifest, {
      remoteTag: vi.fn(async () => ({ ...tag(), commit: "0".repeat(40) })),
    });
    await expect(
      qualifyPublishedArtifacts(
        {
          releaseDirectory: fixture.releaseDirectory,
          installRoot: join(fixture.root, "install-a"),
          repository: "private/example",
          checkout: "/home/example/private",
          preflightOnly: true,
        },
        movedPort,
      ),
    ).rejects.toThrow("remote tag moved");

    const changing = vi
      .fn()
      .mockResolvedValueOnce(tag())
      .mockResolvedValueOnce({ ...tag(), object: "0".repeat(40) });
    const changingPort = port(fixture.manifest, { remoteTag: changing });
    await expect(
      qualifyPublishedArtifacts(
        {
          releaseDirectory: fixture.releaseDirectory,
          installRoot: join(fixture.root, "install-b"),
          repository: "private/example",
          checkout: "/home/example/private",
          lifecycleAck: lifecycleTargetBinding("private/example", "/home/example/private"),
          output: join(fixture.root, "receipt.json"),
        },
        changingPort,
      ),
    ).rejects.toThrow("tag changed during qualification");
    expect(changingPort.cleanup).toHaveBeenCalledTimes(1);
  });

  it("rejects dirty or aliased install roots before public resolution", async () => {
    const fixture = releaseFixture();
    roots.push(fixture.root);
    const dirty = join(fixture.root, "dirty");
    mkdirSync(dirty);
    write(join(dirty, "retained.txt"), "keep\n");
    const selectedPort = port(fixture.manifest);
    await expect(
      qualifyPublishedArtifacts(
        {
          releaseDirectory: fixture.releaseDirectory,
          installRoot: dirty,
          repository: "private/example",
          checkout: "/home/example/private",
          preflightOnly: true,
        },
        selectedPort,
      ),
    ).rejects.toThrow("install root must be absent");

    const aliased = join(fixture.root, "alias");
    symlinkSync(fixture.releaseDirectory, aliased);
    await expect(
      qualifyPublishedArtifacts(
        {
          releaseDirectory: fixture.releaseDirectory,
          installRoot: aliased,
          repository: "private/example",
          checkout: "/home/example/private",
          preflightOnly: true,
        },
        selectedPort,
      ),
    ).rejects.toThrow("install root must be absent");
    expect(selectedPort.registryDocument).not.toHaveBeenCalled();
  });

  it("does not write success when lifecycle or root cleanup is incomplete", async () => {
    const fixture = releaseFixture();
    roots.push(fixture.root);
    const output = join(fixture.root, "receipt.json");
    const incomplete = port(fixture.manifest);
    incomplete.install.mockResolvedValueOnce({
      npmIdentity: identity(),
      pluginIdentity: identity(),
      surfaces: {},
      lifecycle: { results: [], cleanup: { installed: false, enabled: true, active: true } },
    });
    await expect(
      qualifyPublishedArtifacts(
        {
          releaseDirectory: fixture.releaseDirectory,
          installRoot: join(fixture.root, "install-a"),
          repository: "private/example",
          checkout: "/home/example/private",
          lifecycleAck: lifecycleTargetBinding("private/example", "/home/example/private"),
          output,
        },
        incomplete,
      ),
    ).rejects.toThrow("controller cleanup is incomplete");
    expect(() => readFileSync(output)).toThrow();

    const failedCleanup = port(fixture.manifest, {
      cleanup: vi.fn(() => {
        throw new Error("root cleanup incomplete");
      }),
    });
    await expect(
      qualifyPublishedArtifacts(
        {
          releaseDirectory: fixture.releaseDirectory,
          installRoot: join(fixture.root, "install-b"),
          repository: "private/example",
          checkout: "/home/example/private",
          lifecycleAck: lifecycleTargetBinding("private/example", "/home/example/private"),
          output,
        },
        failedCleanup,
      ),
    ).rejects.toThrow("root cleanup incomplete");
    expect(() => readFileSync(output)).toThrow();
  });
});
