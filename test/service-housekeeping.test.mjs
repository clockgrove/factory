// The real service, as a real process, on real files: the run logs it
// rotates, a knowledge store that can't open, and defaultHead's fetches in
// its checkout.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  closedPort,
  configured,
  githubOrigin,
  installation,
  REPO,
  seed,
  serve,
  status,
  stopped,
  tempDir,
  until,
} from "./helpers.mjs";

test("logs keep the newest runs, each with its captures", async () => {
  const inst = installation();
  const dir = join(inst.logs, "5");
  mkdirSync(dir, { recursive: true });
  const old = new Date(Date.now() - 60 * 60 * 1000);
  for (let i = 0; i < 25; i++) {
    const run = `2026-01-01T00-00-${String(i).padStart(2, "0")}`;
    writeFileSync(join(dir, `${run}.jsonl`), "{}\n");
    // Every other run captured a call: its directory goes with its run.
    if (i % 2) {
      mkdirSync(join(dir, `${run}.captures`));
      writeFileSync(join(dir, `${run}.captures`, "c.json"), "{}");
      utimesSync(join(dir, `${run}.captures`), old, old);
    }
    // Run 1 was written to minutes ago (a dream call still running): kept.
    if (i !== 1) utimesSync(join(dir, `${run}.jsonl`), old, old);
  }
  const service = serve(inst);
  await until(() => status(inst).service === "running", "service");
  await stopped(service);
  const kept = readdirSync(dir).sort();
  const runs = kept.filter((name) => name.endsWith(".jsonl"));
  assert.equal(runs.length, 21, "the 20 newest and the live one");
  assert.equal(runs[0], "2026-01-01T00-00-01.jsonl");
  assert.equal(runs[1], "2026-01-01T00-00-05.jsonl");
  assert.equal(
    kept.length,
    33,
    "the 11 kept odd runs keep their captures, and the rotated record",
  );
  // Each removed run is recorded, so a reader can say it is gone.
  assert.deepEqual(
    readFileSync(join(dir, "rotated"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).run),
    [0, 2, 3, 4].map((i) => `2026-01-01T00-00-0${i}`),
  );
  // The service's own events went to a file named by its run id.
  assert.ok(
    readdirSync(join(inst.logs, "0")).some((name) =>
      /^\d{4}-\d\d-\d\dT[\d-]+Z-\d+\.jsonl$/.test(name),
    ),
  );
});

test("a knowledge store that can't open never holds back retirement", async () => {
  const inst = installation();
  configured(inst, `http://127.0.0.1:${await closedPort()}`);
  seed(inst, 14, "done");
  // node:sqlite missing, as on Node before 22.13: every observation fails.
  const service = serve(inst, undefined, ["--no-experimental-sqlite"]);
  await until(
    () => existsSync(join(inst.objectives, "finished", "14.json")),
    "the move to finished/",
  );
  const logs = readdirSync(join(inst.logs, "14"))
    .map((name) => readFileSync(join(inst.logs, "14", name), "utf8"))
    .join("");
  assert.match(logs, /"observe-failed"/, "the observation is retried");
  await stopped(service);
});

test("concurrent defaultHead calls in one checkout all see the moved default branch, and none fetches once origin moves", async () => {
  const { defaultHead, GitRefusal } = await import("../dist/git.js");
  const dir = tempDir("factory-fetch-");
  const git = (cwd, ...args) => {
    const result = spawnSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", ...args],
      { cwd, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(dir, "init", "--quiet", "--bare", "-b", "main", "origin.git");
  git(dir, "clone", "--quiet", "origin.git", "work");
  const work = join(dir, "work");
  git(work, "commit", "--quiet", "--allow-empty", "-m", "0");
  git(work, "push", "--quiet", "origin", "HEAD:main");
  git(dir, "clone", "--quiet", "origin.git", "checkout");
  const checkout = join(dir, "checkout");
  githubOrigin(checkout, join(dir, "origin.git"));
  for (let round = 1; round <= 3; round++) {
    // The default branch moves, as every merge moves it.
    git(work, "commit", "--quiet", "--allow-empty", "-m", String(round));
    git(work, "push", "--quiet", "origin", "HEAD:main");
    const head = git(work, "rev-parse", "HEAD");
    const heads = await Promise.all(
      Array.from({ length: 8 }, () =>
        defaultHead(checkout, REPO, AbortSignal.timeout(60_000)),
      ),
    );
    assert.deepEqual(heads, Array(8).fill(head), `round ${round}`);
  }
  // Origin moved to another repository: no fetch, a refusal naming the fix.
  githubOrigin(checkout, join(dir, "origin.git"), "someone/else");
  await assert.rejects(
    defaultHead(checkout, REPO, AbortSignal.timeout(60_000)),
    (error) =>
      error instanceof GitRefusal &&
      /does not match configured repository drill\/target/.test(
        error.message,
      ) &&
      /Point origin's fetch and push URLs/.test(error.fix),
  );
});
