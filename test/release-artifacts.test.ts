import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalChecksumBytes } from "../scripts/release-integrity.mjs";
import { candidateCommands } from "../scripts/verify-candidate.mjs";

const version = "2.0.27-beta.0";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
type MutableCandidateReceipt = {
  commit: string;
  tree: string;
  subjects: Array<{ path: string; sha256: string }>;
};

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
      skipCandidateReceipt?: boolean;
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
    write(root, "dist/factory.js", bundle);
    write(root, "dist/mcp-server.js", "console.log('mcp fixture');\n");
    const inventoryBundle = overrides.missingBundle ? "missing.js" : "factory.js";
    write(
      root,
      "dist/bundle-inventory.json",
      `${JSON.stringify({
        protocol: "clockgrove.factory/bundle-inventory-v1",
        bundles: [{ file: inventoryBundle, bytes: bundle.length, sha256: hash(bundle) }],
        components: [],
      })}\n`,
    );
    write(root, "THIRD_PARTY_NOTICES.txt", "fixture notices\n");
    write(root, ".gitignore", "release/\n.release.tmp-*/\n.npm-cache/\n");
    mkdirSync(join(root, "scripts"));
    for (const script of [
      "create-release-artifacts.mjs",
      "release-integrity.mjs",
      "verification-receipt.mjs",
      "verify-candidate.mjs",
    ])
      copyFileSync(new URL(`../scripts/${script}`, import.meta.url), join(root, "scripts", script));
    write(
      root,
      "scripts/verify-release-preflight.mjs",
      `import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
const log = process.env.FACTORY_TEST_CANDIDATE_COMMAND_LOG;
mkdirSync(dirname(log), { recursive: true });
appendFileSync(log, JSON.stringify({ command: process.execPath, args: ["scripts/verify-release-preflight.mjs"] }) + "\\n");
`,
    );
    write(
      root,
      "bin/npm",
      `#!/usr/bin/env node
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") {
  process.stdout.write("11.19.0\\n");
} else {
  const log = process.env.FACTORY_TEST_CANDIDATE_COMMAND_LOG;
  mkdirSync(dirname(log), { recursive: true });
  appendFileSync(log, JSON.stringify({ command: "npm", args }) + "\\n");
}
`,
    );
    chmodSync(join(root, "bin/npm"), 0o700);
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
    if (!overrides.skipCandidateReceipt) {
      const subjects = [
        "package.json",
        "package-lock.json",
        "dist/factory.js",
        "dist/mcp-server.js",
        "dist/bundle-inventory.json",
      ].map((path) => ({ path, sha256: hash(readFileSync(join(root, path))) }));
      write(
        root,
        "release/evidence/candidate-deterministic.json",
        `${JSON.stringify(
          {
            kind: "factory-exact-commit-verification",
            gate: "verify:candidate",
            status: "passed",
            commit: git(root, "rev-parse", "HEAD"),
            tree: git(root, "rev-parse", "HEAD^{tree}"),
            subjects,
          },
          null,
          2,
        )}\n`,
      );
    }
    return root;
  };
  const generate = (root: string, env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [join(root, "scripts/create-release-artifacts.mjs")], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, FACTORY_NPM_CACHE: join(root, ".npm-cache"), ...env },
    });
  const verify = (root: string) => {
    const log = join(root, ".npm-cache/candidate-commands.jsonl");
    const result = spawnSync(process.execPath, [join(root, "scripts/verify-candidate.mjs")], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${join(root, "bin")}${delimiter}${process.env.PATH ?? ""}`,
        FACTORY_TEST_CANDIDATE_COMMAND_LOG: log,
      },
    });
    return { result, log };
  };
  const receiptPath = (root: string) => join(root, "release/evidence/candidate-deterministic.json");
  const mutateReceipt = (root: string, mutate: (receipt: MutableCandidateReceipt) => void) => {
    const path = receiptPath(root);
    const receipt = JSON.parse(readFileSync(path, "utf8")) as MutableCandidateReceipt;
    mutate(receipt);
    writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`);
  };
  const transientDirectories = (root: string) =>
    execFileSync("find", [root, "-maxdepth", "1", "-name", ".release.tmp-*"], {
      encoding: "utf8",
    }).trim();

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("consumes the default receipt from the production candidate verifier CLI", () => {
    const root = fixture({ skipCandidateReceipt: true });
    const verified = verify(root);
    expect(verified.result.stderr).toBe("");
    expect(verified.result.status).toBe(0);
    const commands = readFileSync(verified.log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(commands).toEqual(
      candidateCommands.map(([command, args]) => ({ command, args: [...args] })),
    );
    const receipt = JSON.parse(readFileSync(receiptPath(root), "utf8"));
    expect(receipt).toMatchObject({
      kind: "factory-exact-commit-verification",
      gate: "verify:candidate",
      status: "passed",
      commit: git(root, "rev-parse", "HEAD"),
      tree: git(root, "rev-parse", "HEAD^{tree}"),
    });
    const candidateReceipt = readFileSync(receiptPath(root));
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
    expect(readFileSync(receiptPath(root))).toEqual(candidateReceipt);
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
    expect(existsSync(receiptPath(root))).toBe(true);
    expect(existsSync(join(root, "release/release-manifest.json"))).toBe(false);
  });

  it("refuses dirty source and arbitrary existing output without replacing either", () => {
    const dirtyRoot = fixture();
    write(dirtyRoot, "dirty.txt", "uncommitted\n");
    const dirty = generate(dirtyRoot);
    expect(dirty.status).not.toBe(0);
    expect(dirty.stderr).toContain("clean Git worktree");
    expect(existsSync(receiptPath(dirtyRoot))).toBe(true);
    expect(existsSync(join(dirtyRoot, "release/release-manifest.json"))).toBe(false);

    const existingRoot = fixture();
    write(existingRoot, "release/existing.txt", "retain\n");
    const existing = generate(existingRoot);
    expect(existing.status).not.toBe(0);
    expect(existing.stderr).toContain("only the candidate evidence directory");
    expect(readFileSync(join(existingRoot, "release/existing.txt"), "utf8")).toBe("retain\n");
    expect(existsSync(receiptPath(existingRoot))).toBe(true);
  });

  it("preserves candidate evidence and removes transient staging when generation fails", () => {
    const root = fixture({ missingBundle: true });
    const candidateReceipt = readFileSync(receiptPath(root));
    const result = generate(root);
    expect(result.status).not.toBe(0);
    expect(readFileSync(receiptPath(root))).toEqual(candidateReceipt);
    expect(existsSync(join(root, "release/release-manifest.json"))).toBe(false);
    expect(transientDirectories(root)).toBe("");
  });

  it("restores candidate evidence byte for byte when the final swap fails", () => {
    const root = fixture();
    const candidateReceipt = readFileSync(receiptPath(root));
    const result = generate(root, {
      NODE_ENV: "test",
      FACTORY_TEST_RELEASE_FINAL_SWAP_FAILURE: "1",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("injected final release artifact swap failure");
    expect(readFileSync(receiptPath(root))).toEqual(candidateReceipt);
    expect(existsSync(join(root, "release/release-manifest.json"))).toBe(false);
    expect(transientDirectories(root)).toBe("");
  });

  it("reports success and retains the backup when cleanup fails after the committed swap", () => {
    const root = fixture();
    const candidateReceipt = readFileSync(receiptPath(root));
    const result = generate(root, {
      NODE_ENV: "test",
      FACTORY_TEST_RELEASE_BACKUP_CLEANUP_FAILURE: "1",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("created release artifacts");
    expect(result.stderr).toContain(
      "warning: release artifacts committed; previous evidence backup cleanup is incomplete",
    );
    expect(readFileSync(receiptPath(root))).toEqual(candidateReceipt);
    expect(existsSync(join(root, "release/release-manifest.json"))).toBe(true);
    expect(git(root, "status", "--porcelain", "--untracked-files=all")).toBe("");
    const backups = readdirSync(root).filter(
      (entry) => entry.startsWith(".release.tmp-") && entry.endsWith("-previous"),
    );
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(root, backups[0]!, "evidence/candidate-deterministic.json"))).toEqual(
      candidateReceipt,
    );
  });

  it("refuses a completed artifact set without changing it", () => {
    const root = fixture();
    expect(generate(root).status).toBe(0);
    const manifestPath = join(root, "release/release-manifest.json");
    const manifest = readFileSync(manifestPath);
    const receipt = readFileSync(receiptPath(root));
    const repeated = generate(root);
    expect(repeated.status).not.toBe(0);
    expect(repeated.stderr).toContain("only the candidate evidence directory");
    expect(readFileSync(manifestPath)).toEqual(manifest);
    expect(readFileSync(receiptPath(root))).toEqual(receipt);
  });

  it.each([
    ["commit", (receipt: MutableCandidateReceipt) => (receipt.commit = "0".repeat(40))],
    ["tree", (receipt: MutableCandidateReceipt) => (receipt.tree = "0".repeat(40))],
    [
      "subject",
      (receipt: MutableCandidateReceipt) => (receipt.subjects[0]!.sha256 = "0".repeat(64)),
    ],
  ])("rejects a stale candidate %s before artifact generation", (_name, mutate) => {
    const root = fixture();
    mutateReceipt(root, mutate);
    const staleReceipt = readFileSync(receiptPath(root));
    const result = generate(root);
    expect(result.status).not.toBe(0);
    expect(readFileSync(receiptPath(root))).toEqual(staleReceipt);
    expect(existsSync(join(root, "release/release-manifest.json"))).toBe(false);
    expect(transientDirectories(root)).toBe("");
  });

  it.each(["missing", "malformed", "directory", "symlink"])(
    "rejects %s candidate evidence without changing the release root",
    (fault) => {
      const root = fixture();
      const path = receiptPath(root);
      if (fault === "missing") rmSync(path);
      if (fault === "malformed") writeFileSync(path, "{not-json\n");
      if (fault === "directory") {
        rmSync(path);
        mkdirSync(path);
      }
      if (fault === "symlink") {
        const target = join(root, "candidate-receipt-target.json");
        writeFileSync(target, readFileSync(path));
        rmSync(path);
        symlinkSync(target, path);
      }
      const result = generate(root);
      expect(result.status).not.toBe(0);
      expect(existsSync(join(root, "release/release-manifest.json"))).toBe(false);
      expect(transientDirectories(root)).toBe("");
    },
  );

  it.each(["line\nbreak.tgz", "line\rbreak.tgz", "windows\\path.tgz", "control\u0001.tgz"])(
    "refuses a checksum filename that can change record structure: %j",
    (file) => {
      expect(() => canonicalChecksumBytes([{ file, sha256: "0".repeat(64) }])).toThrow(
        /filename is invalid/,
      );
    },
  );
});
