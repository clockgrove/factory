import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("dependency notices ignore Factory-only versions and retain dependency/license freshness", (t) => {
  const root = mkdtempSync(join(tmpdir(), "factory-dependency-notices-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of [
    "scripts/generate-notices.mjs",
    "node_modules/@openai/codex-sdk/LICENSE",
    "node_modules/@anthropic-ai/claude-agent-sdk/LICENSE.md",
    "node_modules/koffi/LICENSE.txt",
    "licenses/GitHub-Copilot-SDK-MIT.txt",
  ]) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(source, path), target);
  }
  const license = join(root, "node_modules/public-fixture/LICENSE");
  mkdirSync(dirname(license), { recursive: true });
  copyFileSync(join(source, "licenses/MIT-SPDX.txt"), license);
  const lock = {
    name: "factory-notices-fixture",
    version: "1.0.0",
    lockfileVersion: 3,
    packages: {
      "": { name: "factory-notices-fixture", version: "1.0.0" },
      "node_modules/public-fixture": { version: "2.0.0", license: "MIT" },
    },
  };
  const writeVersions = (version) => {
    lock.version = version;
    lock.packages[""].version = version;
    writeFileSync(join(root, "package.json"), JSON.stringify({ version }));
    writeFileSync(join(root, "package-lock.json"), JSON.stringify(lock));
  };
  const generate = (...args) =>
    spawnSync(
      process.execPath,
      [join(root, "scripts/generate-notices.mjs"), ...args],
      {
        encoding: "utf8",
      },
    );
  const succeeds = (result) => assert.equal(result.status, 0, result.stderr);
  const stale = (result) => {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /THIRD_PARTY_NOTICES\.md is stale/);
  };
  writeVersions("1.0.0");
  succeeds(generate());
  const notice = join(root, "THIRD_PARTY_NOTICES.md");
  const original = readFileSync(notice);
  writeVersions("1.0.1");
  succeeds(generate("--check"));
  succeeds(generate());
  assert.deepEqual(readFileSync(notice), original);

  lock.packages["node_modules/public-fixture"].version = "2.0.1";
  writeVersions("1.0.1");
  stale(generate("--check"));
  succeeds(generate());
  succeeds(generate("--check"));
  assert.match(readFileSync(notice, "utf8"), /public-fixture.*2\.0\.1/);

  writeFileSync(
    license,
    readFileSync(license, "utf8") + "\nChanged fixture notice.\n",
  );
  stale(generate("--check"));
  succeeds(generate());
  succeeds(generate("--check"));
  assert.match(readFileSync(notice, "utf8"), /Changed fixture notice\./);

  delete lock.packages["node_modules/public-fixture"].license;
  writeVersions("1.0.1");
  const missing = generate("--check");
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Production dependency licenses must be known/);
});
