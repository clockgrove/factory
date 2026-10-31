// CI splits the test files across shards with scripts/test-partition.mjs,
// balanced by the seconds test/timings.json says each took. The test-files
// reporter lists what each shard ran, and package-gate fails unless
// scripts/test-shards.mjs finds every test/*.test.mjs file ran once: a lost
// shard or a split that drops or repeats a file is never a green run.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers.mjs";

const script = (name) =>
  fileURLToPath(new URL(`../scripts/${name}`, import.meta.url));
const REPORTER = script("test-files.mjs");
const DURATIONS = script("test-durations.mjs");
const CHECK = script("test-shards.mjs");
const PARTITION = script("test-partition.mjs");
const FILES = ["a", "b", "c", "d", "e"].map((name) => `test/${name}.test.mjs`);

// This file's own runner marks its children; a nested run must not be one.
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;

/**
 * A checkout with five test files, the last with no tests of its own (still
 * a file its shard ran), and a helper that is not one. `timings`, if given,
 * is its test/timings.json.
 */
function suite(timings) {
  const root = tempDir("factory-shards-");
  mkdirSync(join(root, "test"));
  for (const file of FILES.slice(0, -1))
    writeFileSync(
      join(root, file),
      'import { test } from "node:test";\ntest("passes", () => {});\n',
    );
  writeFileSync(join(root, FILES.at(-1)), "export {};\n");
  writeFileSync(join(root, "test", "helper.mjs"), "export const one = 1;\n");
  if (timings)
    writeFileSync(join(root, "test", "timings.json"), JSON.stringify(timings));
  return root;
}

function node(root, ...args) {
  return spawnSync(process.execPath, args, {
    cwd: root,
    env,
    encoding: "utf8",
  });
}

/**
 * The files shard `i/n` runs, as scripts/test-partition.mjs prints them,
 * for a node --test that runs `c` at a time (by default, its own default).
 */
function partition(root, i, n, c) {
  const run = node(root, PARTITION, ...[i, n, c ?? []].flat().map(String));
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.split("\n").filter(Boolean);
}

/**
 * Run shard `i/n` as CI does; returns the paths of its list of files and
 * of the seconds they took.
 */
function shard(root, i, n) {
  const list = join(root, `files-${i}-of-${n}.txt`);
  const durations = join(root, `durations-${i}-of-${n}.json`);
  const run = node(
    root,
    "--test",
    `--test-reporter=${REPORTER}`,
    `--test-reporter-destination=${list}`,
    `--test-reporter=${DURATIONS}`,
    `--test-reporter-destination=${durations}`,
    ...partition(root, i, n),
  );
  assert.equal(run.status, 0, run.stderr);
  return { list, durations };
}

function check(root, lists) {
  return node(root, CHECK, ...lists);
}

test("shards that split the test files between them pass the check", () => {
  const root = suite();
  for (const n of [1, 2, 3, 4]) {
    const lists = Array.from(
      { length: n },
      (_, i) => shard(root, i + 1, n).list,
    );
    const run = check(root, lists);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, new RegExp(`5 test files across ${n} shards`));
  }
});

test("a lost shard, a file run twice or a stray file fails the check", () => {
  const root = suite();
  const first = shard(root, 1, 2).list;
  const second = shard(root, 2, 2).list;

  // With no timings, every file counts the same: a, c and e, then b and d.
  const lost = check(root, [first]);
  assert.equal(lost.status, 1);
  assert.match(lost.stderr, /^test\/b\.test\.mjs ran in no shard$/m);
  assert.match(lost.stderr, /^test\/d\.test\.mjs ran in no shard$/m);

  const twice = check(root, [first, second, first]);
  assert.equal(twice.status, 1);
  assert.match(twice.stderr, /^test\/a\.test\.mjs ran in 2 shards: /m);

  const stray = join(root, "stray.txt");
  writeFileSync(stray, "test/helper.mjs\n");
  const extra = check(root, [first, second, stray]);
  assert.equal(extra.status, 1);
  assert.match(
    extra.stderr,
    /ran test\/helper\.mjs, not a test\/\*\.test\.mjs/,
  );
});

test("a shard with no files, or no shard, is refused rather than run", () => {
  const root = suite();
  // node --test given no files would run every file again.
  const empty = node(root, PARTITION, "6", "6");
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /shard 6 of 6 has no test files/);
  for (const args of [
    [],
    ["0", "2"],
    ["3", "2"],
    ["1"],
    ["x", "2"],
    ["1", "2", "0"],
    ["1", "2", "x"],
    ["1", "2", "3", "4"],
  ])
    assert.equal(node(root, PARTITION, ...args).status, 2, args.join(" "));
});
