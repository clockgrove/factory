// CI splits the test files across shards with scripts/test-partition.mjs,
// balanced by the seconds test/timings.json says each took. The test-files
// reporter lists what each shard ran, and package-gate fails unless
// scripts/test-shards.mjs finds every test/*.test.mjs file ran once: a lost
// shard or a split that drops or repeats a file is never a green run. The
// test-durations reporter writes what each file took, and
// scripts/test-timings.mjs refreshes the timings from a run's shards.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
const TIMINGS = script("test-timings.mjs");
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

test("the partition balances the shards by the seconds each file took, a file without timings counting their median", () => {
  // e has no timing, so it counts 5.5, the median of 4, 5, 6 and 10; a
  // timing for a file that is gone counts for nothing. One at a time, a
  // shard takes the sum of its seconds. Longest first, each to the shard
  // that would finish soonest: a, b, e, c, d. Each shard lists its files in
  // name order, the order node --test starts them in.
  const root = suite({
    "test/a.test.mjs": 10,
    "test/b.test.mjs": 6,
    "test/c.test.mjs": 5,
    "test/d.test.mjs": 4,
    "test/gone.test.mjs": 100,
  });
  assert.deepEqual(partition(root, 1, 2, 1), [
    "test/a.test.mjs",
    "test/c.test.mjs",
  ]);
  assert.deepEqual(partition(root, 2, 2, 1), [
    "test/b.test.mjs",
    "test/d.test.mjs",
    "test/e.test.mjs",
  ]);
  assert.match(
    node(root, PARTITION, "2", "2", "1").stderr,
    /shard 2 of 2: 3 test files, about 16 s at 1 at a time/,
  );
  // The longest file takes a shard to itself.
  assert.deepEqual(partition(root, 1, 3, 1), ["test/a.test.mjs"]);
  assert.deepEqual(partition(root, 2, 3, 1), [
    "test/b.test.mjs",
    "test/d.test.mjs",
  ]);
  assert.deepEqual(partition(root, 3, 3, 1), [
    "test/c.test.mjs",
    "test/e.test.mjs",
  ]);
  // Files timed at 0 s, under a tenth of a second, still spread out.
  const instant = suite(Object.fromEntries(FILES.map((file) => [file, 0])));
  assert.deepEqual(partition(instant, 1, 2), [
    "test/a.test.mjs",
    "test/c.test.mjs",
    "test/e.test.mjs",
  ]);
  assert.deepEqual(partition(instant, 2, 2), [
    "test/b.test.mjs",
    "test/d.test.mjs",
  ]);
});

test("node --test starts a shard's files in name order, whatever order it is given them in", () => {
  const root = tempDir("factory-shards-");
  mkdirSync(join(root, "test"));
  const log = join(root, "started.txt");
  for (const name of ["a", "b", "c"])
    writeFileSync(
      join(root, "test", `${name}.test.mjs`),
      `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(log)}, "${name}\\n");\n`,
    );
  const run = node(
    root,
    "--test",
    "--test-concurrency=1",
    "test/c.test.mjs",
    "test/a.test.mjs",
    "test/b.test.mjs",
  );
  assert.equal(run.status, 0, run.stderr);
  assert.equal(readFileSync(log, "utf8"), "a\nb\nc\n");
});

test("the partition counts a long file that sorts last starting late, after the shorter ones before it", () => {
  // e takes 3 s and sorts last. One at a time, c and d join it, 4 s a
  // shard either way. Two at a time, that shard would run c and d first
  // and start e at 1 s, so it would end at 4 s with the other at 2 s.
  // With only c ahead of it, e starts at once, and both shards end at 3 s.
  const root = suite({
    "test/a.test.mjs": 2,
    "test/b.test.mjs": 2,
    "test/c.test.mjs": 1,
    "test/d.test.mjs": 1,
    "test/e.test.mjs": 3,
  });
  assert.deepEqual(partition(root, 1, 2, 1), [
    "test/c.test.mjs",
    "test/d.test.mjs",
    "test/e.test.mjs",
  ]);
  assert.deepEqual(partition(root, 2, 2, 1), [
    "test/a.test.mjs",
    "test/b.test.mjs",
  ]);
  assert.deepEqual(partition(root, 1, 2, 2), [
    "test/c.test.mjs",
    "test/e.test.mjs",
  ]);
  assert.deepEqual(partition(root, 2, 2, 2), [
    "test/a.test.mjs",
    "test/b.test.mjs",
    "test/d.test.mjs",
  ]);
  for (const i of ["1", "2"])
    assert.match(
      node(root, PARTITION, i, "2", "2").stderr,
      new RegExp(`shard ${i} of 2: \\d test files, about 3 s at 2 at a time`),
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

test("a run's durations refresh the timings, which then balance its shards", () => {
  const root = suite();
  const runs = [1, 2].map((i) => shard(root, i, 2).durations);
  // Each shard timed the files it ran, the one with no tests too.
  for (const [i, durations] of runs.entries()) {
    const took = JSON.parse(readFileSync(durations, "utf8"));
    assert.deepEqual(Object.keys(took), partition(root, i + 1, 2).sort());
    for (const seconds of Object.values(took))
      assert.ok(seconds > 0 && seconds < 60, String(seconds));
  }
  const refresh = node(root, TIMINGS, ...runs);
  assert.equal(refresh.status, 0, refresh.stderr);
  assert.match(refresh.stdout, /5 test files from 2 shards/);
  const timings = JSON.parse(
    readFileSync(join(root, "test", "timings.json"), "utf8"),
  );
  assert.deepEqual(Object.keys(timings), FILES);
  for (const seconds of Object.values(timings))
    assert.equal(seconds, Math.round(seconds * 10) / 10);
  const lists = [1, 2].map((i) => shard(root, i, 2).list);
  assert.equal(check(root, lists).status, 0);
  assert.equal(node(root, TIMINGS).status, 2);
});
