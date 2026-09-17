import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalChecksumBytes } from "../scripts/release-integrity.mjs";

const version = "2.0.27-beta.0";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

describe("release artifact generation", () => {
  const roots: string[] = [];
  const write = (root: string, path: string, value: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), value);
  };
  const git = (root: string, ...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const fixture = (
    overrides: {
      version?: string;
      tag?: string;
      lockVersion?: string;
      missingBundle?: boolean;
      pluginVersion?: string;
      pluginName?: string;
    } = {},
  ) => {
    const root = mkdtempSync(join(tmpdir(), "factory-release-artifacts-"));
    roots.push(root);
    const selectedVersion = overrides.version ?? version;
    const bundle = "console.log('fixture');\n";
    write(
      root,
      "package.json",
      `${JSON.stringify(
        {
          name: "@clockgrove/factory",
          version: selectedVersion,
          description: "fixture",
          license: "MIT",
          type: "module",
          files: ["dist/", "THIRD_PARTY_NOTICES.txt"],
          repository: { type: "git", url: "git+https://github.com/clockgrove/factory.git" },
          publishConfig: { access: "public", tag: overrides.tag ?? "beta" },
        },
        null,
        2,
      )}\n`,
    );
    const lockVersion = overrides.lockVersion ?? selectedVersion;
    write(
      root,
      "package-lock.json",
      `${JSON.stringify(
        {
          name: "@clockgrove/factory",
          version: lockVersion,
          lockfileVersion: 3,
          requires: true,
          packages: {
            "": { name: "@clockgrove/factory", version: lockVersion, license: "MIT" },
          },
        },
        null,
        2,
      )}\n`,
    );
    const pluginVersion = overrides.pluginVersion ?? selectedVersion;
    const pluginName = overrides.pluginName ?? "factory";
    write(root, "plugin.json", JSON.stringify({ name: pluginName, version: pluginVersion }));
    write(
      root,
      ".codex-plugin/plugin.json",
      JSON.stringify({ name: pluginName, version: pluginVersion }),
    );
    write(
      root,
      ".claude-plugin/plugin.json",
      JSON.stringify({ name: pluginName, version: pluginVersion }),
    );
    write(
      root,
      ".github/plugin/marketplace.json",
      JSON.stringify({
        metadata: { version: pluginVersion },
        plugins: [{ name: pluginName, version: pluginVersion }],
      }),
    );
    if (!overrides.missingBundle) write(root, "dist/factory.js", bundle);
    write(
      root,
      "dist/bundle-inventory.json",
      `${JSON.stringify({
        protocol: "clockgrove.factory/bundle-inventory-v1",
        bundles: [{ file: "factory.js", bytes: bundle.length, sha256: hash(bundle) }],
        components: [],
      })}\n`,
    );
    write(root, "THIRD_PARTY_NOTICES.txt", "fixture notices\n");
    write(root, ".gitignore", "release/\n.release.tmp-*/\n.npm-cache/\n");
    mkdirSync(join(root, "scripts"));
    for (const script of ["create-release-artifacts.mjs", "release-integrity.mjs"])
      copyFileSync(new URL(`../scripts/${script}`, import.meta.url), join(root, "scripts", script));
    git(root, "init", "--initial-branch=main", "-q");
    git(root, "add", ".");
    git(
      root,
      "-c",
      "user.name=Release Test",
      "-c",
      "user.email=release@example.test",
      "commit",
      "-qm",
      "fixture",
    );
    return root;
  };
  const generate = (root: string) =>
    spawnSync(process.execPath, [join(root, "scripts/create-release-artifacts.mjs")], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, FACTORY_NPM_CACHE: join(root, ".npm-cache") },
    });

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("creates one clean prerelease candidate with authenticated SBOM and checksums", () => {
    const root = fixture();
    const result = generate(root);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(git(root, "status", "--porcelain")).toBe("");
    const manifest = JSON.parse(readFileSync(join(root, "release/release-manifest.json"), "utf8"));
    expect(manifest).toMatchObject({
      name: "@clockgrove/factory",
      version,
      distTag: "beta",
      provenance: { sourceCommit: git(root, "rev-parse", "HEAD"), sourceDirty: false },
      checksums: { file: "SHA256SUMS" },
    });
    const sbom = JSON.parse(readFileSync(join(root, "release", manifest.sbom.file), "utf8"));
    expect(sbom.metadata.component).toMatchObject({ name: "@clockgrove/factory", version });
    const expectedChecksums = [manifest.tarball, manifest.sbom, manifest.provenance]
      .map(({ file, sha256 }: { file: string; sha256: string }) => `${sha256}  ${file}`)
      .join("\n");
    expect(readFileSync(join(root, "release/SHA256SUMS"), "utf8")).toBe(`${expectedChecksums}\n`);
    expect(manifest.checksums.sha256).toBe(hash(`${expectedChecksums}\n`));
  });

  it.each([
    ["stable version", { version: "2.0.27" }, /SemVer prerelease/],
    ["invalid numeric prerelease", { version: "2.0.27-01" }, /SemVer prerelease/],
    ["latest tag", { tag: "latest" }, /npm beta dist-tag/],
    ["stale lockfile", { lockVersion: "2.0.26" }, /package-lock root identity/],
    ["stale plugin manifest", { pluginVersion: "2.0.26" }, /version differs/],
    ["wrong plugin name", { pluginName: "other" }, /release names differ/],
  ] as const)("refuses a %s before creating output", (_name, overrides, diagnostic) => {
    const root = fixture(overrides);
    const result = generate(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(diagnostic);
    expect(existsSync(join(root, "release"))).toBe(false);
  });

  it("refuses dirty source and existing output without replacing either", () => {
    const dirtyRoot = fixture();
    write(dirtyRoot, "dirty.txt", "uncommitted\n");
    const dirty = generate(dirtyRoot);
    expect(dirty.status).not.toBe(0);
    expect(dirty.stderr).toContain("clean Git worktree");
    expect(existsSync(join(dirtyRoot, "release"))).toBe(false);

    const existingRoot = fixture();
    write(existingRoot, "release/existing.txt", "retain\n");
    const existing = generate(existingRoot);
    expect(existing.status).not.toBe(0);
    expect(existing.stderr).toContain("release output already exists");
    expect(readFileSync(join(existingRoot, "release/existing.txt"), "utf8")).toBe("retain\n");
  });

  it("removes transient staging when generation fails", () => {
    const root = fixture({ missingBundle: true });
    const result = generate(root);
    expect(result.status).not.toBe(0);
    expect(existsSync(join(root, "release"))).toBe(false);
    expect(
      execFileSync("find", [root, "-maxdepth", "1", "-name", ".release.tmp-*"], {
        encoding: "utf8",
      }).trim(),
    ).toBe("");
  });

  it.each(["line\nbreak.tgz", "line\rbreak.tgz", "windows\\path.tgz", "control\u0001.tgz"])(
    "refuses a checksum filename that can change record structure: %j",
    (file) => {
      expect(() => canonicalChecksumBytes([{ file, sha256: "0".repeat(64) }])).toThrow(
        /filename is invalid/,
      );
    },
  );
});
