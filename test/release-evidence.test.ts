import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const gates = [
  "Linux environment matrix",
  "Live adaptive scheduling matrix",
  "Live native-stack matrix",
  "Real Daytona Objective",
  "Two real managed-agent Objectives",
  "Objective-level adversarial E2E",
];
const subjects = [
  "dist/factory.js",
  "dist/mcp-server.js",
  "dist/bundle-inventory.json",
  "package.json",
  "package-lock.json",
  ".codex-plugin/plugin.json",
];
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

describe("release evidence and publication boundary", () => {
  let root: string;
  let testedCommit: string;
  const write = (path: string, value: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), value);
  };
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const commit = () => {
    git("add", ".");
    git(
      "-c",
      "user.name=Release Test",
      "-c",
      "user.email=release@example.test",
      "commit",
      "-qm",
      "fixture",
    );
    return git("rev-parse", "HEAD");
  };
  const verify = () =>
    spawnSync(process.execPath, [join(root, "scripts/verify-publish-readiness.mjs")], {
      cwd: root,
      encoding: "utf8",
    });
  const evidence = (index: number) =>
    JSON.parse(readFileSync(join(root, `docs/release-evidence/${index}.json`), "utf8"));

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "factory-release-evidence-"));
    git("init", "--initial-branch=main", "-q");
    for (const path of subjects) write(path, `${path}\n`);
    write(
      "package.json",
      JSON.stringify({
        name: "@clockgrove/factory",
        version: "2.0.26",
        publishConfig: { tag: "latest", access: "public" },
      }),
    );
    write("THIRD_PARTY_NOTICES.txt", "fixture notices\n");
    write(".gitignore", "release/\nbin/\n");
    mkdirSync(join(root, "scripts"));
    for (const name of ["verify-publish-readiness.mjs", "publish-release.mjs"]) {
      copyFileSync(new URL(`../scripts/${name}`, import.meta.url), join(root, "scripts", name));
    }
    testedCommit = commit();
    write("docs/release-evidence/run.txt", "sanitized test output\n");
    gates.forEach((gate, index) =>
      write(
        `docs/release-evidence/${index}.json`,
        JSON.stringify({
          schema: 2,
          gate,
          status: "passed",
          commit: testedCommit,
          recordedAt: "2026-09-04T00:00:00Z",
          commands: ["fixture-live-matrix"],
          subjects: subjects.map((path) => ({
            path,
            sha256: hash(readFileSync(join(root, path))),
          })),
          artifacts: [
            { path: "docs/release-evidence/run.txt", sha256: hash("sanitized test output\n") },
          ],
        }),
      ),
    );
    write(
      "docs/CONFORMANCE.md",
      `## Verification required before publication\n\n| Gate | Status | Evidence |\n|---|---|---|\n${gates.map((gate, index) => `| ${gate} | Passed | [record](release-evidence/${index}.json) |`).join("\n")}\n`,
    );
    commit();
    git("tag", "v2.0.26");
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("accepts an evidence-only descendant without requiring a self-referencing commit", () => {
    expect(testedCommit).not.toBe(git("rev-parse", "HEAD"));
    const result = verify();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("invalidates every gate after any non-evidence source change", () => {
    write("README.md", "changed installation instructions\n");
    commit();
    expect(verify().stderr).toContain("outside evidence: README.md");
  });

  it("rejects a mismatched tested bundle digest", () => {
    const record = evidence(0);
    record.subjects[0].sha256 = "0".repeat(64);
    write("docs/release-evidence/0.json", JSON.stringify(record));
    commit();
    expect(verify().stderr).toContain("differs from the tested release subject");
  });

  it("rejects modified evidence artifacts even in an evidence-only commit", () => {
    write("docs/release-evidence/run.txt", "different output\n");
    commit();
    expect(verify().stderr).toContain("does not match its recorded SHA-256 digest");
  });

  it("rejects uncommitted evidence and missing release tags", () => {
    write("docs/release-evidence/uncommitted.txt", "not committed\n");
    expect(verify().stderr).toContain("requires a clean Git worktree");
    commit();
    git("tag", "-d", "v2.0.26");
    expect(verify().stderr).toContain("requires immutable tag v2.0.26");
  });

  const stageArtifacts = (sourceCommit: string) => {
    const tarball = { file: "factory.tgz", sha256: hash("tarball") };
    const sbom = { file: "factory.cdx.json", sha256: hash("sbom") };
    const bundleInventory = {
      file: "dist/bundle-inventory.json",
      sha256: hash(readFileSync(join(root, "dist/bundle-inventory.json"))),
    };
    const thirdPartyNotices = {
      file: "THIRD_PARTY_NOTICES.txt",
      sha256: hash(readFileSync(join(root, "THIRD_PARTY_NOTICES.txt"))),
    };
    const provenance = JSON.stringify({
      protocol: "clockgrove.factory/release-provenance-v1",
      source: { commit: sourceCommit, dirty: false },
      package: { name: "@clockgrove/factory", version: "2.0.26", distTag: "latest" },
      subjects: [tarball, sbom, bundleInventory, thirdPartyNotices],
    });
    write("release/factory.tgz", "tarball");
    write("release/factory.cdx.json", "sbom");
    write("release/factory.provenance.json", provenance);
    write(
      "release/release-manifest.json",
      JSON.stringify({
        name: "@clockgrove/factory",
        version: "2.0.26",
        distTag: "latest",
        tarball,
        sbom,
        bundleInventory,
        thirdPartyNotices,
        provenance: {
          file: "factory.provenance.json",
          sha256: hash(provenance),
          sourceCommit,
          sourceDirty: false,
        },
      }),
    );
    write(
      "bin/npm",
      `#!${process.execPath}\nprocess.stdout.write('npm-stub ' + process.argv.slice(2).join(' '));\n`,
    );
    execFileSync("chmod", ["+x", join(root, "bin/npm")]);
  };
  const publish = () =>
    spawnSync(process.execPath, [join(root, "scripts/publish-release.mjs"), "--dry-run"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}` },
    });

  it("rechecks live gates even when the publisher is invoked directly", () => {
    stageArtifacts(git("rev-parse", "HEAD"));
    const ledger = readFileSync(join(root, "docs/CONFORMANCE.md"), "utf8").replace(
      "| Passed |",
      "| Open |",
    );
    write("docs/CONFORMANCE.md", ledger);
    commit();
    const result = publish();
    expect(result.stderr).toContain("blocked by open conformance gates");
    expect(result.stdout).not.toContain("npm-stub");
  });

  it("rejects artifacts from the tested ancestor instead of the final release commit", () => {
    stageArtifacts(testedCommit);
    const result = publish();
    expect(result.stderr).toContain("not generated from the current clean release commit");
    expect(result.stdout).not.toContain("npm-stub");
  });

  it("publishes only the final provenance-bound tarball after all checks", () => {
    stageArtifacts(git("rev-parse", "HEAD"));
    const result = publish();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("npm-stub publish");
    expect(result.stdout).toContain("--tag latest --dry-run");
  });
});
