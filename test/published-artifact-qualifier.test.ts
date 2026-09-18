import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseQualificationInstallReceipt } from "../scripts/qualification-install-identity.mjs";
import {
  assertContainedPath,
  assertLinuxNativePath,
  assessPublishedPreflight,
  qualificationInstallReceipt,
  qualifyPublishedArtifacts,
  strictPublishedEnvironment,
  verifyPublishedTarball,
  verifyRetainedRelease,
} from "../scripts/verify-published-artifacts.mjs";
import { canonicalChecksumBytes, sha256 } from "../scripts/release-integrity.mjs";

const version = "2.0.27-beta.0";
const commit = "a".repeat(40);
const inventorySha256 = "b".repeat(64);
const factoryBundleSha256 = "e".repeat(64);
const mcpServerBundleSha256 = "f".repeat(64);
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
  toolPreflight: ReturnType<typeof vi.fn>;
  sourcePreflight: ReturnType<typeof vi.fn>;
  install: ReturnType<typeof vi.fn>;
  proveControllerAbsence: ReturnType<typeof vi.fn>;
  cleanupIncomplete: ReturnType<typeof vi.fn>;
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
      { file: "factory.js", bytes: 100, sha256: factoryBundleSha256 },
      { file: "mcp-server.js", bytes: 200, sha256: mcpServerBundleSha256 },
    ],
  };
}

function writeInstallReceipt(root: string): { receiptPath: string; receiptSha256: string } {
  mkdirSync(root, { mode: 0o700 });
  chmodSync(root, 0o700);
  const receipt = qualificationInstallReceipt({
    sourceCommit: commit,
    version,
    tarballFile: `clockgrove-factory-${version}.tgz`,
    tarballSha256: sha256(tarball),
    npmPrefix: join(root, "npm"),
    factoryCli: join(root, "npm/bin/factory"),
    codexHome: join(root, "codex-home"),
    codexCli: "/usr/bin/codex",
    pluginArchive: join(root, `factory-plugin-${commit}.tar`),
    pluginArchiveSha256: "1".repeat(64),
    installedPluginRoot: join(root, "codex-home/plugins/factory"),
    listedPluginSource: join(root, "plugin-marketplace"),
    bundleInventorySha256: inventorySha256,
    factoryBundleSha256,
    mcpServerBundleSha256,
    controllerLauncherIdentity: `sha256:${factoryBundleSha256}`,
  });
  const receiptPath = join(root, "install-identities.txt");
  writeFileSync(receiptPath, receipt, { mode: 0o600 });
  return { receiptPath, receiptSha256: sha256(Buffer.from(receipt)) };
}

function port(manifest: TestManifest, overrides: Partial<TestPort> = {}): TestPort {
  return {
    registryDocument: vi.fn(async () => npmDocument(manifest)),
    remoteTag: vi.fn(async () => tag()),
    toolPreflight: vi.fn(async () => ({
      npm: "/usr/bin/npm",
      codex: "/usr/bin/codex",
      git: "/usr/bin/git",
    })),
    sourcePreflight: vi.fn(async (release) => ({ sourceRoot: dirname(release.directory) })),
    install: vi.fn(async ({ root }) => ({
      ...writeInstallReceipt(root),
      npmIdentity: identity(),
      pluginIdentity: identity(),
      surfaces: {
        npm: { command: "factory --version", version },
        plugin: { server: "factory", version, tools: 20 },
      },
    })),
    proveControllerAbsence: vi.fn(async () => ({ absent: true })),
    cleanupIncomplete: vi.fn(async () => ({ preserved: true })),
    host: vi.fn(() => ({ platform: "linux", architecture: "x64", release: "fixture" })),
    ...overrides,
  };
}

describe("published-artifact qualifier", () => {
  const roots: string[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("authenticates the retained manifest, registry metadata, tarball, and immutable tag", () => {
    const fixture = releaseFixture();
    roots.push(fixture.root);
    const release = verifyRetainedRelease(fixture.releaseDirectory);
    expect(assessPublishedPreflight(release, npmDocument(fixture.manifest), tag())).toMatchObject({
      package: { name: "@clockgrove/factory", version },
      registry: { integrity, shasum: npmShasum },
      tag: { name: `v${version}`, commit },
    });
    expect(() => verifyPublishedTarball(tarball, release.manifest)).not.toThrow();
    expect(() => verifyPublishedTarball(Buffer.from("different"), release.manifest)).toThrow(
      "npm tarball size differs",
    );
  });

  it("preflights public and source authority without creating an install or lifecycle target", async () => {
    const fixture = releaseFixture();
    roots.push(fixture.root);
    const installRoot = join(fixture.root, "published-install");
    const selectedPort = port(fixture.manifest);
    const result = await qualifyPublishedArtifacts(
      { releaseDirectory: fixture.releaseDirectory, installRoot, preflightOnly: true },
      selectedPort,
    );
    expect(result).toMatchObject({
      kind: "published-artifact-preflight",
      result: "passed",
      behavior: "authenticate-and-install-only",
      controllerLifecycle: "not-permitted",
    });
    expect(existsSync(installRoot)).toBe(false);
    expect(selectedPort.install).not.toHaveBeenCalled();
    expect(selectedPort.proveControllerAbsence).not.toHaveBeenCalled();
  });

  it("retains the exact standard install authority for private smoke without claiming completion", async () => {
    const fixture = releaseFixture();
    roots.push(fixture.root);
    const installRoot = join(fixture.root, "published-install");
    const selectedPort = port(fixture.manifest);
    const result = await qualifyPublishedArtifacts(
      { releaseDirectory: fixture.releaseDirectory, installRoot },
      selectedPort,
    );
    expect(result).toMatchObject({
      kind: "published-artifact-install-handoff",
      result: "ready-for-private-smoke",
      completion: {
        status: "pending-private-smoke",
        ownerIssue: 89,
        installRootRetained: true,
      },
      factoryQualificationInstallReceipt: {
        path: join(installRoot, "install-identities.txt"),
      },
    });
    expect(existsSync(installRoot)).toBe(true);
    expect(selectedPort.proveControllerAbsence).not.toHaveBeenCalled();
    expect(selectedPort.cleanupIncomplete).not.toHaveBeenCalled();
    expect(selectedPort.install).toHaveBeenCalledWith(
      expect.not.objectContaining({ repository: expect.anything(), checkout: expect.anything() }),
    );
    const receipt = readFileSync(join(installRoot, "install-identities.txt"), "utf8");
    expect(parseQualificationInstallReceipt(receipt)).toMatchObject({
      sourceCommit: commit,
      version,
      factoryBundleSha256,
    });
    expect(receipt.length).toBeLessThan(16 * 1024);
    expect(JSON.stringify(result)).not.toContain('"result":"passed"');
  });

  it.each([
    [
      "integrity",
      (document: NpmDocument) => (document.dist.integrity = `sha512-${"A".repeat(88)}`),
    ],
    ["shasum", (document: NpmDocument) => (document.dist.shasum = "0".repeat(40))],
    ["dist-tag", (document: NpmDocument) => (document._distTagVersion = "2.0.26")],
  ])("fails closed on mismatched registry %s", async (_name, mutate) => {
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
          preflightOnly: true,
        },
        selectedPort,
      ),
    ).rejects.toThrow();
    expect(selectedPort.install).not.toHaveBeenCalled();
  });

  it("fails closed when the tag moved or changes after install", async () => {
    const fixture = releaseFixture();
    roots.push(fixture.root);
    const moved = port(fixture.manifest, {
      remoteTag: vi.fn(async () => ({ ...tag(), commit: "0".repeat(40) })),
    });
    await expect(
      qualifyPublishedArtifacts(
        {
          releaseDirectory: fixture.releaseDirectory,
          installRoot: join(fixture.root, "install-a"),
          preflightOnly: true,
        },
        moved,
      ),
    ).rejects.toThrow("remote tag moved");

    const changing = vi
      .fn()
      .mockResolvedValueOnce(tag())
      .mockResolvedValueOnce({ ...tag(), object: "0".repeat(40) });
    const selectedPort = port(fixture.manifest, { remoteTag: changing });
    const installRoot = join(fixture.root, "install-b");
    await expect(
      qualifyPublishedArtifacts(
        { releaseDirectory: fixture.releaseDirectory, installRoot },
        selectedPort,
      ),
    ).rejects.toThrow("tag changed during qualification");
    expect(selectedPort.proveControllerAbsence).toHaveBeenCalledWith(installRoot);
    expect(selectedPort.cleanupIncomplete).toHaveBeenCalledWith(installRoot);
    expect(existsSync(installRoot)).toBe(true);
  });

  it("aggregates the install error with absence-proof or cleanup failure and preserves the root", async () => {
    const fixture = releaseFixture();
    roots.push(fixture.root);
    for (const [name, overrides] of [
      [
        "proof",
        {
          proveControllerAbsence: vi.fn(async () => {
            throw new Error("controller absence unknown");
          }),
        },
      ],
      [
        "cleanup",
        {
          cleanupIncomplete: vi.fn(async () => {
            throw new Error("cleanup failed");
          }),
        },
      ],
    ] as const) {
      const installRoot = join(fixture.root, `install-${name}`);
      const selectedPort = port(fixture.manifest, {
        install: vi.fn(async () => {
          mkdirSync(installRoot, { mode: 0o700 });
          throw new Error("install failed");
        }),
        ...overrides,
      });
      let thrown: unknown;
      try {
        await qualifyPublishedArtifacts(
          { releaseDirectory: fixture.releaseDirectory, installRoot },
          selectedPort,
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AggregateError);
      expect((thrown as AggregateError).errors.map((error) => error.message)).toEqual([
        "install failed",
        expect.stringMatching(/controller absence unknown|cleanup failed/),
      ]);
      expect(existsSync(installRoot)).toBe(true);
    }
  });

  it("uses a whitelist environment and blocks ambient npm and git injection", () => {
    vi.stubEnv("NPM_CONFIG_REGISTRY", "https://mirror.example.invalid/");
    vi.stubEnv("NPM_CONFIG_SCRIPT_SHELL", "/tmp/attacker-shell");
    vi.stubEnv("GIT_CONFIG_GLOBAL", "/tmp/attacker-gitconfig");
    vi.stubEnv("GIT_SSH_COMMAND", "attacker-ssh");
    vi.stubEnv("FACTORY_PROVIDER", "ambient-provider");
    const root = mkdtempSync(join(tmpdir(), "factory-published-env-test-"));
    roots.push(root);
    const environment = strictPublishedEnvironment(root, {
      git: "/usr/bin/git",
      npm: "/usr/bin/npm",
      codex: "/usr/bin/codex",
    });
    expect(environment).toMatchObject({
      HOME: root,
      NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
      NPM_CONFIG_GLOBALCONFIG: "/dev/null",
      NPM_CONFIG_USERCONFIG: "/dev/null",
      NPM_CONFIG_SCRIPT_SHELL: "/bin/false",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_OPTIONAL_LOCKS: "0",
    });
    expect(environment.GITHUB_TOKEN).toBeUndefined();
    expect(environment.GIT_SSH_COMMAND).toBeUndefined();
    expect(environment.NPM_TOKEN).toBeUndefined();
    expect(environment.FACTORY_PROVIDER).toBeUndefined();
  });

  it("requires Linux-native canonical roots and exact path containment", async () => {
    expect(() => assertLinuxNativePath("/mnt/c/factory", "root")).toThrow("Linux-native");
    expect(() => assertContainedPath("/tmp/factory", "/tmp/factory-other/item", "item")).toThrow(
      "escapes its root",
    );
    expect(() => assertContainedPath("/tmp/factory", "/tmp/factory/item", "item")).not.toThrow();

    const fixture = releaseFixture();
    roots.push(fixture.root);
    const aliasParent = join(fixture.root, "alias-parent");
    const actualParent = join(fixture.root, "actual-parent");
    mkdirSync(actualParent);
    symlinkSync(actualParent, aliasParent);
    const selectedPort = port(fixture.manifest);
    await expect(
      qualifyPublishedArtifacts(
        {
          releaseDirectory: fixture.releaseDirectory,
          installRoot: join(aliasParent, "install"),
          preflightOnly: true,
        },
        selectedPort,
      ),
    ).rejects.toThrow("install root parent must be canonical");
    expect(selectedPort.registryDocument).not.toHaveBeenCalled();
  });
});
