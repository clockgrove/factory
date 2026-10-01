import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  archivePaths,
  tagProtection,
  testCounts,
  verifyProtection,
} from "../scripts/release.mjs";

test("release guard refuses broader scopes, bypass actors and missing deletion protection", () => {
  const expected = tagProtection("1.2.3");
  verifyProtection(
    { ...expected, rules: [...expected.rules].reverse() },
    expected,
  );
  for (const change of [
    { enforcement: "disabled" },
    { target: "branch" },
    { bypass_actors: [{ actor_id: 1 }] },
    { conditions: { ref_name: { include: ["refs/tags/*"], exclude: [] } } },
    { rules: [{ type: "update" }] },
  ])
    assert.throws(() => verifyProtection({ ...expected, ...change }, expected));
  assert.throws(() => tagProtection("1.2.3/other"));
});

test("installed gate rejects zero tests, skipped cases and incomplete test accounting", () => {
  const output =
    "# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0";
  assert.equal(testCounts(output).tests, 2);
  for (const bad of [
    output.replace("# skipped 0", "# skipped 1"),
    output.replace("# pass 2", "# pass 1"),
    output.replace("# tests 2", "# tests 0"),
    output.replace("# todo 0", ""),
    `${output}\n# pass 2`,
  ])
    assert.throws(() => testCounts(bad));
});

test("archive gate rejects absolute paths and parent traversal", () => {
  assert.equal(
    archivePaths("package/README.md\npackage/dist/cli.js\n").length,
    2,
  );
  for (const bad of ["/tmp/file", "package/../file", "other/file", ""])
    assert.throws(() => archivePaths(bad));
});

function publicFixture(t, corrupt, mutate) {
  const root = mkdtempSync("/tmp/factory-release-test-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pkg = join(root, "package");
  mkdirSync(pkg);
  const contents = {
    ".codex-plugin/plugin.json": JSON.stringify({ version: "1.2.3" }),
    "skills/director/SKILL.md": "Use Factory on a target repository.\n",
    "skills/setup/SKILL.md": "Bind the target configuration.\n",
  };
  for (const [path, bytes] of Object.entries(contents)) {
    mkdirSync(join(pkg, path, ".."), { recursive: true });
    writeFileSync(join(pkg, path), bytes);
  }
  const archive = join(root, "clockgrove-factory-1.2.3.tgz");
  execFileSync("tar", ["-czf", archive, "-C", root, "package"]);
  const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const archiveSha256 = sha(readFileSync(archive));
  const sums = `${archiveSha256}  clockgrove-factory-1.2.3.tgz\n`;
  const checksum = join(root, "SHA256SUMS");
  writeFileSync(checksum, sums);
  const checkout = join(root, "marketplace");
  mkdirSync(checkout);
  const git = (...args) =>
    execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git(
    "-c",
    "user.name=Factory Test",
    "-c",
    "user.email=factory@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  );
  const source = git("rev-parse", "HEAD");
  const tree = git("rev-parse", "HEAD^{tree}");
  const record = {
    status: "LOCAL CHECKS PASS",
    counts: { tests: 1, pass: 1, fail: 0, cancelled: 0, skipped: 0, todo: 0 },
    tests: ["test/example.test.mjs"],
    testSources: [{ path: "test/example.test.mjs", sha256: "a".repeat(64) }],
    preflights: [{ name: "preflight.mjs", sha256: "b".repeat(64) }],
    installedFilesCompared: 3,
    bundled: [{ path: "node_modules/example", version: "1.0.0" }],
    repository: "clockgrove/factory",
    version: "1.2.3",
    archive: "clockgrove-factory-1.2.3.tgz",
    archiveSha256,
    archiveBytes: readFileSync(archive).length,
    checksumSha256: sha(Buffer.from(sums)),
    source,
    tree,
    rulesetId: 12,
    tagProtection: tagProtection("1.2.3"),
  };
  if (mutate === "guard")
    record.tagProtection.conditions.ref_name.include = ["refs/tags/*"];
  if (mutate === "counts") record.counts.skipped = 1;
  const acceptance = join(root, "acceptance.json");
  writeFileSync(acceptance, JSON.stringify(record));
  const fingerprint =
    "https://github.com/clockgrove/factory/issues/1#issuecomment-2";
  const prefix = "repos/clockgrove/factory/";
  const assets = [record.archive, "SHA256SUMS"].map((name) => ({
    name,
    browser_download_url: `https://github.com/clockgrove/factory/releases/download/v1.2.3/${name}`,
  }));
  const replies = {
    [`${prefix}releases/tags/v1.2.3`]: {
      draft: false,
      tag_name: "v1.2.3",
      published_at: "2026-01-01T01:00:00Z",
      html_url: "https://github.com/clockgrove/factory/releases/tag/v1.2.3",
      assets,
    },
    [`${prefix}issues/comments/2`]: {
      html_url: fingerprint,
      created_at: "2026-01-01T00:00:00Z",
      body: [
        source,
        tree,
        archiveSha256,
        record.checksumSha256,
        String(record.archiveBytes),
        `Acceptance SHA256 ${sha(readFileSync(acceptance))}.`,
      ].join(" "),
    },
    [`${prefix}git/ref/tags/v1.2.3`]: {
      object: { type: "tag", sha: "annotated" },
    },
    [`${prefix}git/tags/annotated`]: {
      object: { type: "commit", sha: source },
    },
    [`${prefix}git/commits/${source}`]: { tree: { sha: tree } },
    [`${prefix}rulesets/12`]: record.tagProtection,
  };
  const bin = join(root, "bin");
  mkdirSync(bin);
  const shim = (name, text) => {
    const path = join(bin, name);
    writeFileSync(path, `#!${process.execPath}\n${text}\n`);
    chmodSync(path, 0o755);
  };
  shim(
    "gh",
    `const replies=${JSON.stringify(replies)}; const args=process.argv.slice(2); if(args[0]!=='api'||!replies[args[1]])process.exit(3); console.log(JSON.stringify(replies[args[1]]));`,
  );
  shim(
    "curl",
    `const fs=require('node:fs'); const args=process.argv.slice(2); const name=args[args.indexOf('--output')-1].split('/').pop(); fs.copyFileSync(name==='SHA256SUMS'?${JSON.stringify(checksum)}:${JSON.stringify(archive)},args[args.indexOf('--output')+1]);`,
  );
  const plugin = {
    installed: true,
    enabled: true,
    version: "1.2.3",
    source: { ref: "v1.2.3", url: "https://github.com/clockgrove/factory.git" },
  };
  shim(
    "codex",
    `const args=process.argv.slice(2); let result; if(args[1]==='marketplace') result={installedRoot:${JSON.stringify(checkout)}}; else if(args[1]==='add')result={installedPath:${JSON.stringify(pkg)}}; else if(args[1]==='list')result={installed:[${JSON.stringify(plugin)}]}; else process.exit(4); console.log(JSON.stringify(result));`,
  );
  if (corrupt) writeFileSync(archive, "Changed public bytes");
  if (mutate === "acceptance") {
    record.preflights[0].sha256 = "c".repeat(64);
    writeFileSync(acceptance, JSON.stringify(record));
  }
  const output = join(root, "audit");
  const result = spawnSync(
    process.execPath,
    [
      resolve("scripts/release.mjs"),
      "audit",
      "--source",
      checkout,
      "--output",
      output,
      "--record",
      acceptance,
      "--fingerprint",
      fingerprint,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    },
  );
  return { result, output, acceptance };
}

test("independent audit verifies actual archive/plugin bytes and excludes timing from acceptance", (t) => {
  const { result, output, acceptance } = publicFixture(t, false);
  assert.equal(result.status, 0, result.stderr);
  const before = readFileSync(acceptance);
  assert.equal(
    JSON.parse(readFileSync(join(output, "public-verification.json"))).status,
    "PASS",
  );
  writeFileSync(join(output, "timing.json"), "Updated observation\n");
  assert(readFileSync(acceptance).equals(before));
});

test("changed public bytes fail before plugin installation and retain failure timing", (t) => {
  const { result, output } = publicFixture(t, true);
  assert.equal(result.status, 1);
  const timing = JSON.parse(readFileSync(join(output, "timing.json")));
  assert.equal(timing.status, "FAILED");
  assert(!timing.phases.some((phase) => phase.command[0] === "codex"));
});

test("changed acceptance is rejected even when all public artifact identities match", (t) => {
  const { result } = publicFixture(t, false, "acceptance");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Acceptance identity differs/);
});

test("sealed broader protection and skipped local checks cannot pass public audit", (t) => {
  for (const mutate of ["guard", "counts"]) {
    const { result, output } = publicFixture(t, false, mutate);
    assert.equal(result.status, 1);
    assert.equal(
      JSON.parse(readFileSync(join(output, "timing.json"))).status,
      "FAILED",
    );
  }
});
