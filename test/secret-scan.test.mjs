import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const scanner = resolve(
  import.meta.dirname,
  "../dist/execution/secret-scan.js",
);
const recommended = JSON.stringify({
  rules: [{ id: "@secretlint/secretlint-rule-preset-recommend" }],
});
const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

test("isolated scanner preserves literal files, binary detection and masked errors", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-secret-scan-"));
  const scan = (source, config = recommended) =>
    spawnSync(process.execPath, [scanner, source, config], {
      cwd: root,
      encoding: "utf8",
    });
  try {
    const clean = join(root, "clean.txt");
    writeFileSync(clean, "Public credential-free scanner fixture.\n");
    assert.equal(scan(clean).status, 0);
    // Neither target config discovery nor ignore rules may skip supplied bytes.
    writeFileSync(
      join(root, ".secretlintrc.json"),
      JSON.stringify({ rules: [] }),
    );
    writeFileSync(join(root, ".gitignore"), "*\n");
    writeFileSync(join(root, ".secretlintignore"), "*\n");
    const literal = join(root, "literal[1]*.txt");
    writeFileSync(literal, `GITHUB_TOKEN=${secret}\n`);
    const refused = scan(literal);
    assert.equal(refused.status, 1);
    assert.match(refused.stdout, /@secretlint\/secretlint-rule-github/);
    assert.ok(!`${refused.stdout}${refused.stderr}`.includes(secret));
    const binary = join(root, "payload.bin");
    const bytes = Buffer.alloc(4 * 1024 * 1024, 65);
    bytes.write(`GITHUB_TOKEN=${secret}\n`, bytes.length - 64);
    writeFileSync(binary, bytes);
    assert.equal(scan(binary).status, 1);
    const unavailable = scan(join(root, "missing.txt"));
    assert.equal(unavailable.status, 2);
    assert.equal(unavailable.stdout, "");
    assert.equal(unavailable.stderr, "Secretlint scan unavailable\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
