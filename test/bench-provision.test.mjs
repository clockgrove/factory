// A dry run of bench/provision.mjs prints every GitHub, Git and setup action
// of a benchmark run, in order, and does none: with no gh or git on PATH it
// still succeeds and leaves no run directory behind. Base patches are
// applied with Git for real, on an invented source repository, with GitHub
// and Factory stood in for.
import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import {
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
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadDefinition } from "../bench/lib/definition.mjs";
import { handFixCommits } from "../bench/lib/grade.mjs";
import { HOME_ENV } from "../bench/lib/home.mjs";
import {
  carryReviewArtifacts,
  cherryPick,
  defaultRunId,
  enableOnlyKeptWorkflows,
  harnessRun,
  provision,
  Runner,
  resolveFactory,
  runCapacity,
  seedMemory,
  setupArgs,
  shareCapacity,
  withFileLock,
} from "../bench/lib/provision.mjs";
import { EXAMPLE } from "./bench-fixture.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "bench-provision-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const host = join(dir, "host.json");
writeFileSync(
  host,
  JSON.stringify({
    benchRoot: join(dir, "bench"),
    workDir: join(dir, "work"),
    cacheDir: join(dir, "cache"),
    sourceState: join(dir, "state"),
    toolchain: "/opt/toolchain",
    githubApp: { id: "1", keyPath: join(dir, "app.pem") },
    operator: "operator-login",
  }),
);
// Git only, to read the candidate checkout's commit: no gh.
const bin = join(dir, "bin");
mkdirSync(bin);
symlinkSync(
  process.env.PATH.split(":")
    .map((p) => join(p, "git"))
    .find((p) => existsSync(p)),
  join(bin, "git"),
);
// Definitions and results live in a bench home outside the repository.
const home = join(dir, "bench-home");
mkdirSync(join(home, "benchmarks"), { recursive: true });
writeFileSync(
  join(home, "benchmarks", "acme-widgets-42.json"),
  readFileSync(EXAMPLE),
);
const dryEnv = { ...process.env, PATH: bin };
delete dryEnv[HOME_ENV];
/** bench/provision.mjs's argv for a dry run of the example, with `extra`. */
const dryArgv = (...extra) => [
  join(root, "bench", "provision.mjs"),
  "--bench-home",
  home,
  "--benchmark",
  "acme-widgets-42",
  "--host",
  host,
  "--factory",
  join(root, "dist", "cli.js"),
  "--dry-run",
  ...extra,
];
/** The run record a dry run's output ends with. */
const dryRecord = (out) =>
  JSON.parse(out.slice(out.indexOf("The run record would be:\n") + 25));

test("a dry run prints the whole provisioning and touches nothing", () => {
  const run = spawnSync(process.execPath, dryArgv("--run-id", "t1"), {
    encoding: "utf8",
    env: dryEnv,
  });
  assert.equal(run.status, 0, run.stderr);
  const out = run.stdout;
  const repo = "acme/bench-widgets-42-t1";
  // This checkout's build is a candidate, recorded with its commit and build digest.
  assert.match(out, /"kind": "candidate"/);
  assert.match(out, /"commit": "[0-9a-f]{40}"/);
  assert.match(out, /"distSha256": "[0-9a-f]{64}"/);
  // The record names the definition it ran and where run.mjs scores it into.
  assert.ok(
    out.includes(
      `"definitionFile": ${JSON.stringify(join(home, "benchmarks", "acme-widgets-42.json"))}`,
    ),
    out,
  );
  assert.ok(
    out.includes(`"resultsDir": ${JSON.stringify(join(home, "results"))}`),
    out,
  );
  // And the capacity setup is given, and the base patch it applies.
  const record = dryRecord(out);
  assert.deepEqual(record.capacity, {
    workers: 4,
    validations: 2,
    memoryMib: 16384,
    share: null,
  });
  assert.deepEqual(record.basePatches, [
    {
      ...loadDefinition(EXAMPLE).basePatches[0],
      applied: "<the base with 89abcde>",
    },
  ]);
  assert.deepEqual(
    record.reviewArtifacts,
    loadDefinition(EXAMPLE).factory.reviewArtifacts,
  );
  const steps = [
    "check: read acme/widgets#42",
    "would: check its title and body digest (d0f6c906d9b1)",
    `would: hold ${join(dir, "cache", "acme__widgets.lock")} while cloning and fetching`,
    "git clone --no-checkout https://github.com/acme/widgets.git",
    "would: fetch the base 0123456",
    "would: fetch the base patch 89abcde",
    "would: apply the base patch 89abcde (the source's fix of a flaky export test",
    `gh repo create ${repo} --private`,
    `gh api -X PUT repos/${repo}/actions/permissions -F enabled=false`,
    "-F allow_merge_commit=true -F allow_squash_merge=true -F allow_rebase_merge=false -F allow_auto_merge=false -F delete_branch_on_merge=true",
    "would: push the base with its 1 patch(es) as main",
    `push --no-verify https://github.com/${repo}.git '<the base with 89abcde>:refs/heads/main'`,
    "lfs push --object-id",
    "would: mirror the ruleset protect-main",
    `gh variable set TEST_RUNNER --repo ${repo} --body <acme/widgets's value>`,
    "check: the base tree's workflow files",
    "-F enabled=true -f allowed_actions=all",
    "would: disable every workflow but .github/workflows/test.yml",
    "workflows again: only .github/workflows/test.yml active",
    "would: create the Project Factory bench acme-widgets-42 t1",
    "--name 'Factory admission' --data-type TEXT",
    `gh label create factory:objective --repo ${repo}`,
    "would: configure Factory (setup)",
    "--codex-network host --sandbox-network package-install --read-only-path /opt/toolchain/browsers",
    "--toolchain-path /opt/toolchain/node-24/bin",
    // The definition's capacity.
    "--objective-tokens 40000000 --day-tokens 80000000 --workers 4 --validations 2 --memory-mib 16384 --json",
    // Setup has no option for them: written into the file it wrote.
    `would: carry the definition's 1 reviewArtifacts selector(s) into ${join(dir, "bench", "acme-widgets-42", "t1", "factory.json")}`,
    "would: seed memory from",
    "without #42's entries or any from 2031-03-04T09:00:00Z on",
    "would: start the background service (setup --background)",
    "--background --json",
    "would: file the Objective",
    "would: check the filed body against the digest",
  ];
  let at = 0;
  for (const step of steps) {
    const found = out.indexOf(step, at);
    assert.ok(found >= 0, `missing, or out of order: ${step}\n${out}`);
    at = found;
  }
  // The service runs on its own configuration and state, never ~/.config/factory.
  assert.match(
    out,
    /FACTORY_CONFIG=\S+\/bench\/acme-widgets-42\/t1\/factory\.json FACTORY_STATE_DIR=\S+\/bench\/acme-widgets-42\/t1\/state factory setup/,
  );
  assert.ok(!existsSync(join(dir, "bench")), "a dry run creates nothing");
  assert.ok(!existsSync(join(dir, "cache")), "a dry run creates nothing");
  assert.ok(!existsSync(join(home, "results")), "a dry run creates nothing");
});

// --- several runs at once -----------------------------------------------------

/** `node bench/provision.mjs ARGV` without waiting, so runs overlap. */
const provisionAsync = (argv) =>
  new Promise((resolve) => {
    execFile(
      process.execPath,
      argv,
      { encoding: "utf8", env: dryEnv },
      (error, stdout, stderr) =>
        resolve({ status: error ? (error.code ?? 1) : 0, stdout, stderr }),
    );
  });

test("runs provisioned at once with the default run id get their own ids", async () => {
  const runs = await Promise.all(
    [1, 2, 3].map(() => provisionAsync(dryArgv())),
  );
  const ids = runs.map((run) => {
    assert.equal(run.status, 0, run.stderr);
    return /^Dry run: nothing is created\. acme-widgets-42 run (\S+) on /.exec(
      run.stdout,
    )?.[1];
  });
  for (const id of ids) assert.match(id, /^\d{8}-\d{4}-[0-9a-f]{6}$/);
  assert.equal(new Set(ids).size, 3, ids.join(", "));
  // Each its own repository.
  assert.equal(
    new Set(runs.map((run) => dryRecord(run.stdout).repository)).size,
    3,
  );
  // The same minute, told apart.
  const at = new Date("2031-03-04T09:00:00Z");
  assert.notEqual(defaultRunId(at), defaultRunId(at));
  assert.match(defaultRunId(at), /^20310304-0900-[0-9a-f]{6}$/);
});

test("a run's capacity: the definition's, then --share, then each flag", async () => {
  const definition = loadDefinition(EXAMPLE);
  const resources = { cpus: 24, memoryMiB: 47104 };
  // About a third of the host each: Factory's formulas over 8 CPUs and a third of the memory.
  assert.deepEqual(shareCapacity(3, resources), {
    workers: 4,
    validations: 2,
    memoryMib: 14336,
  });
  // Never below Factory's own floors.
  assert.deepEqual(shareCapacity(24, resources), {
    workers: 2,
    validations: 2,
    memoryMib: 1792,
  });
  assert.deepEqual(runCapacity(definition), {
    workers: 4,
    validations: 2,
    memoryMib: 16384,
    share: null,
  });
  assert.deepEqual(
    runCapacity(definition, { share: 2, workers: 3 }, resources),
    { workers: 3, validations: 3, memoryMib: 21504, share: 2 },
  );
  // A definition without capacity leaves the rest to Factory.
  const bare = { factory: { ...definition.factory, capacity: undefined } };
  assert.deepEqual(runCapacity(bare, { validations: 1 }), {
    validations: 1,
    share: null,
  });
  const args = setupArgs(
    definition,
    { toolchain: "/t" },
    {
      repository: "acme/bench-widgets-42-c",
      checkout: "/work/c",
      projectId: "PVT_c",
      capacity: { validations: 1, share: null },
    },
  );
  assert.deepEqual(args.slice(args.indexOf("--day-tokens")), [
    "--day-tokens",
    "80000000",
    "--validations",
    "1",
  ]);
  // A share of the whole host is Factory's own default for it.
  const { hostDefaults } = await import(join(root, "dist", "capacity.js"));
  const host = hostDefaults();
  assert.deepEqual(shareCapacity(1), {
    workers: host.workers,
    validations: host.validations,
    memoryMib: host.budgetMiB,
  });
  // The flags reach setup through provisioning.
  const run = spawnSync(
    process.execPath,
    dryArgv("--run-id", "c1", "--share", "2", "--workers", "3"),
    { encoding: "utf8", env: dryEnv },
  );
  assert.equal(run.status, 0, run.stderr);
  const expected = { ...shareCapacity(2), workers: 3 };
  assert.ok(
    run.stdout.includes(
      `--day-tokens 80000000 --workers 3 --validations ${expected.validations} --memory-mib ${expected.memoryMib} --json`,
    ),
    run.stdout,
  );
  assert.deepEqual(dryRecord(run.stdout).capacity, { ...expected, share: 2 });
  for (const bad of [
    ["--share", "0"],
    ["--memory-mib", "100"],
    ["--workers", "two"],
  ]) {
    const refused = spawnSync(
      process.execPath,
      dryArgv("--run-id", "c2", ...bad),
      { encoding: "utf8", env: dryEnv },
    );
    assert.equal(refused.status, 64, refused.stderr);
    assert.match(
      refused.stderr,
      new RegExp(`^${bad[0]} ${bad[1]}: a whole number`),
    );
  }
});

test("a run provisioned again keeps the capacity its service was set up with", () => {
  const definition = loadDefinition(EXAMPLE);
  const recorded = { workers: 2, validations: 2, memoryMib: 6144, share: 6 };
  // Setup changes only the values it is given, so without flags the run
  // keeps what it recorded, never the definition's; a flag given again
  // changes its value and the share stays.
  assert.deepEqual(runCapacity(definition, {}, undefined, recorded), recorded);
  assert.deepEqual(
    runCapacity(definition, { workers: 3 }, undefined, recorded),
    { ...recorded, workers: 3 },
  );
  // Through provisioning, carried on with only --run-id.
  const runDir = join(dir, "bench", "acme-widgets-42", "r1");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "run.json"),
    JSON.stringify({
      runId: "r1",
      issue: 42,
      capacity: recorded,
      provisionedAt: "2031-03-04T09:05:00.000Z",
      queuedAt: "2031-03-04T09:06:00.000Z",
    }),
  );
  try {
    const again = spawnSync(process.execPath, dryArgv("--run-id", "r1"), {
      encoding: "utf8",
      env: dryEnv,
    });
    assert.equal(again.status, 0, again.stderr);
    assert.ok(
      again.stdout.includes(
        "--day-tokens 80000000 --workers 2 --validations 2 --memory-mib 6144 --json",
      ),
      again.stdout,
    );
    assert.doesNotMatch(again.stdout, /The capacity changes/);
    const record = dryRecord(again.stdout);
    assert.deepEqual(record.capacity, recorded);
    // When it was first provisioned and queued stays.
    assert.equal(record.provisionedAt, "2031-03-04T09:05:00.000Z");
    assert.equal(record.queuedAt, "2031-03-04T09:06:00.000Z");
    // A flag given again changes that value, and says so.
    const changed = spawnSync(
      process.execPath,
      dryArgv("--run-id", "r1", "--workers", "3"),
      { encoding: "utf8", env: dryEnv },
    );
    assert.equal(changed.status, 0, changed.stderr);
    assert.match(
      changed.stdout,
      /^The capacity changes from \{"workers":2,.*\} to \{"workers":3,"validations":2,"memoryMib":6144,"share":6\}$/m,
    );
    assert.deepEqual(dryRecord(changed.stdout).capacity, {
      ...recorded,
      workers: 3,
    });
  } finally {
    rmSync(join(dir, "bench"), { recursive: true, force: true });
  }
});

test("the cache lock lets one holder in at a time and takes over a dead holder's", async () => {
  const lock = join(dir, "cache.lock");
  const held = [];
  let inside = 0;
  await Promise.all(
    [1, 2, 3].map((n) =>
      withFileLock(
        lock,
        async () => {
          inside += 1;
          held.push(inside);
          await new Promise((resolve) => setTimeout(resolve, 20));
          inside -= 1;
          return n;
        },
        { pollMs: 5 },
      ),
    ),
  );
  assert.deepEqual(held, [1, 1, 1]);
  assert.ok(!existsSync(lock), "released");
  // A holder that is gone: taken over.
  const gone = spawnSync(process.execPath, ["-e", "process.pid"]).pid;
  writeFileSync(lock, `${gone}\n`);
  assert.equal(await withFileLock(lock, () => "taken"), "taken");
  // A live holder past the wait: named.
  writeFileSync(lock, `${process.pid}\n`);
  await assert.rejects(
    withFileLock(lock, () => "never", { waitMs: 30, pollMs: 5 }),
    new RegExp(
      `cache\\.lock is still held by process ${process.pid} after 0 s`,
    ),
  );
  rmSync(lock);
});

/** `node bench/<script> ...args` without the environment's bench home. */
function benchCli(script, args) {
  const env = { ...process.env };
  delete env[HOME_ENV];
  return spawnSync(process.execPath, [join(root, "bench", script), ...args], {
    encoding: "utf8",
    env,
  });
}

test("provisioning refuses without a results directory, before anything else", () => {
  const refused = benchCli("provision.mjs", [
    "--benchmark",
    EXAMPLE,
    "--host",
    join(dir, "no-host.json"),
    "--factory",
    join(root, "dist", "cli.js"),
    "--dry-run",
  ]);
  assert.equal(refused.status, 64, refused.stderr);
  assert.match(
    refused.stderr,
    /Where to score the run into: no results directory\./,
  );
  assert.equal(refused.stdout, "");
});

test("run.mjs refuses a run whose definition it can't load, without a stack", () => {
  const runDir = join(dir, "run-nope");
  mkdirSync(runDir);
  writeFileSync(
    join(runDir, "run.json"),
    JSON.stringify({
      issue: 42,
      benchmark: "nope",
      resultsDir: join(dir, "run-nope-results"),
    }),
  );
  const refused = benchCli("run.mjs", ["--run-dir", runDir]);
  assert.equal(refused.status, 64, refused.stderr);
  assert.match(refused.stderr, /^Benchmark nope: no definitions directory/);
  assert.doesNotMatch(refused.stderr, /\n\s+at /);
});

// --- the workflows: nothing deploy-capable may stay enabled ------------------

const definition = loadDefinition(EXAMPLE);
const REPO = "acme/bench-widgets-42-w";
const BASE_FILES = [
  ".github/workflows/deploy.yml",
  ".github/workflows/nightly.yml",
  ".github/workflows/test.yml",
  ".github/workflows/release.yml",
];
const listing = (states) =>
  BASE_FILES.map(
    (path, i) => `${i + 1} ${states[path] ?? "active"} ${path}`,
  ).join("\n");

/** A Runner that answers each command from `respond(argv, n)`, n counting the workflow listings. */
class StubRunner extends Runner {
  constructor(respond) {
    super({ dryRun: false, print: () => {} });
    this.calls = [];
    this.listings = 0;
    this.respond = respond;
  }

  run(argv) {
    this.calls.push(Runner.shown(argv));
    if (argv.includes("ls-tree")) return BASE_FILES.join("\n");
    if (argv.some((a) => a.endsWith("/actions/workflows"))) {
      this.listings += 1;
      return this.respond(argv, this.listings);
    }
    return "";
  }
}

const enable = (runner) =>
  enableOnlyKeptWorkflows({
    def: definition,
    repository: REPO,
    cache: "/cache",
    runner,
  });
const actionsOn = (runner) =>
  runner.calls.filter((c) => c.includes("/actions/permissions")).at(-1);

test("a failed workflow listing stops provisioning and turns Actions off again", () => {
  const runner = new StubRunner(() => {
    const error = new Error("Command failed");
    error.stderr = "HTTP 502: Bad Gateway";
    throw error;
  });
  assert.throws(() => enable(runner), /Couldn't read .*workflows.*HTTP 502/s);
  assert.ok(!runner.calls.some((c) => c.endsWith("/disable")));
  assert.match(actionsOn(runner), /enabled=false$/);
});

test("an empty listing, while the base has workflows, is refused", () => {
  const runner = new StubRunner(() => "");
  assert.throws(
    () => enable(runner),
    /doesn't name \.github\/workflows\/deploy\.yml, .*release\.yml of the base tree/,
  );
  assert.match(actionsOn(runner), /enabled=false$/);
});

test("a workflow still active after disabling is refused", () => {
  const runner = new StubRunner((_, n) =>
    // The disable of deploy.yml didn't take.
    n === 1
      ? listing({})
      : listing({
          ".github/workflows/nightly.yml": "disabled_manually",
          ".github/workflows/release.yml": "disabled_manually",
        }),
  );
  assert.throws(
    () => enable(runner),
    /still has active workflows that aren't kept: \.github\/workflows\/deploy\.yml$/,
  );
  assert.match(actionsOn(runner), /enabled=false$/);
});

test("only the kept workflows stay active", () => {
  const off = {
    ".github/workflows/deploy.yml": "disabled_manually",
    ".github/workflows/nightly.yml": "disabled_manually",
    ".github/workflows/release.yml": "disabled_manually",
  };
  const runner = new StubRunner((_, n) =>
    n === 1 ? listing({}) : listing(off),
  );
  enable(runner);
  assert.deepEqual(
    runner.calls.filter((c) => c.endsWith("/disable")),
    [1, 2, 4].map(
      (id) => `gh api -X PUT repos/${REPO}/actions/workflows/${id}/disable`,
    ),
  );
  assert.equal(runner.listings, 2);
  assert.match(actionsOn(runner), /enabled=true -f allowed_actions=all$/);
});

// --- memory is cut at an instant, whatever form the time is written in ------

test("memory is seeded without the Objective's entries or any made at or after the cut", async () => {
  const source = join(dir, "knowledge.sqlite");
  const db = new DatabaseSync(source);
  db.exec(
    "CREATE TABLE memory (id TEXT PRIMARY KEY, objective INTEGER NOT NULL, created TEXT NOT NULL); CREATE TABLE memory_text (id TEXT)",
  );
  const add = db.prepare("INSERT INTO memory VALUES (?, ?, ?)");
  const text = db.prepare("INSERT INTO memory_text VALUES (?)");
  for (const [id, objective, created] of [
    ["before-17", 17, "2031-03-03T22:59:00.000Z"],
    ["before-30", 30, "2031-03-04T08:30:00.000Z"],
    ["the-objective", 42, "2031-03-03T10:00:00.000Z"],
    ["just-after", 54, "2031-03-04T09:00:00.500Z"],
    ["after", 1, "2031-03-04T10:00:00.000Z"],
  ]) {
    add.run(id, objective, created);
    text.run(id);
  }
  db.close();
  // The same instant in UTC and with an offset: the same cut.
  for (const [n, before] of [
    [1, "2031-03-04T09:00:00Z"],
    [2, "2031-03-04T04:00:00-05:00"],
  ]) {
    const target = join(dir, `seeded-${n}`, "knowledge.sqlite");
    assert.deepEqual(await seedMemory(source, target, 42, before), {
      kept: 2,
      removed: 3,
    });
    const seeded = new DatabaseSync(target, { readOnly: true });
    assert.deepEqual(
      seeded
        .prepare("SELECT id FROM memory_text ORDER BY id")
        .all()
        .map((row) => row.id),
      ["before-17", "before-30"],
    );
    seeded.close();
  }
});

// --- which Factory ran --------------------------------------------------------

test("a build is classed by where it lives, and its dist/ digest is recorded", () => {
  const checkout = join(dir, "factory-checkout");
  mkdirSync(join(checkout, "dist"), { recursive: true });
  writeFileSync(join(checkout, "package.json"), '{"version":"9.9.9"}');
  writeFileSync(join(checkout, ".gitignore"), "dist/\n");
  writeFileSync(join(checkout, "dist", "cli.js"), "// build 1\n");
  const git = (...args) =>
    execFileSync(
      "git",
      ["-C", checkout, "-c", "user.name=t", "-c", "user.email=t@t", ...args],
      { encoding: "utf8" },
    ).trim();
  git("init", "-q");
  git("add", ".");
  git("commit", "-qm", "init");
  const commit = git("rev-parse", "HEAD");
  // A checkout's built CLI, given as a file, is the candidate it is.
  const byFile = resolveFactory(join(checkout, "dist", "cli.js"));
  assert.equal(byFile.kind, "candidate");
  assert.equal(byFile.commit, commit);
  assert.equal(byFile.version, "9.9.9");
  assert.equal(byFile.dirty, false);
  assert.match(byFile.distSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(resolveFactory(checkout), byFile);
  // dist/ is ignored: a rebuild leaves the commit clean but changes the digest.
  writeFileSync(join(checkout, "dist", "cli.js"), "// build 2\n");
  const rebuilt = resolveFactory(checkout);
  assert.equal(rebuilt.dirty, false);
  assert.notEqual(rebuilt.distSha256, byFile.distSha256);
  // Scoring sees the change.
  const run = harnessRun({
    runId: "r",
    label: "r",
    group: "g",
    repository: REPO,
    factory: byFile,
  });
  assert.equal(run.factory.distSha256, byFile.distSha256);
  assert.equal(run.factory.distSha256Now, rebuilt.distSha256);
  // A record from before base patches has none.
  assert.deepEqual(run.basePatches, []);

  // An installed package is a release.
  const installed = join(dir, "lib", "node_modules", "@clockgrove", "factory");
  mkdirSync(join(installed, "dist"), { recursive: true });
  writeFileSync(join(installed, "package.json"), '{"version":"0.5.9"}');
  writeFileSync(join(installed, "dist", "cli.js"), "// release\n");
  const release = resolveFactory(join(installed, "dist", "cli.js"));
  assert.equal(release.kind, "release");
  assert.equal(release.commit, null);
  assert.equal(release.version, "0.5.9");
});

// --- base patches: on the base before the Objective is queued ----------------

/** `git ARGS` in `cwd`, as the invented source's developer at `at`. */
function gitAt(cwd, at, ...args) {
  const date = `${Math.floor(Date.parse(at) / 1000)} +0000`;
  return execFileSync(
    "git",
    [
      "-C",
      cwd,
      "-c",
      "user.name=Widgets Dev",
      "-c",
      "user.email=dev@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
}

/**
 * The invented source, acme/widgets, in `at`: the base, then on main the
 * Objective's change to the README, the fix of a flaky test (a patch that
 * applies on the base) and a README edit over the Objective's (one that
 * doesn't).
 */
function sourceRepository(at) {
  mkdirSync(at, { recursive: true });
  gitAt(at, "2031-03-04T08:00:00Z", "init", "--quiet", "--initial-branch=main");
  const commit = (when, files, message) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(at, path)), { recursive: true });
      writeFileSync(join(at, path), text);
    }
    gitAt(at, when, "add", "--all");
    gitAt(at, when, "commit", "--quiet", "--message", message);
    return gitAt(at, when, "rev-parse", "HEAD");
  };
  const base = commit(
    "2031-03-04T08:00:00Z",
    {
      "README.md": "# widgets\n",
      ".github/workflows/test.yml": "on: push\n",
      "test/export.test.js": "retries(0);\n",
    },
    "Widgets",
  );
  commit(
    "2031-03-04T12:00:00Z",
    { "README.md": "# widgets\n\nQueries and CSV export.\n" },
    "Query widgets and export them as CSV",
  );
  const fix = commit(
    "2031-03-05T09:00:00Z",
    { "test/export.test.js": "retries(2);\n" },
    "Retry the flaky export test",
  );
  const clash = commit(
    "2031-03-05T10:00:00Z",
    { "README.md": "# widgets\n\nQueries, CSV and JSON export.\n" },
    "Mention the JSON export",
  );
  return { at, base, fix, clash };
}

const show = (repo, ...args) =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();

test("a base patch is cherry-picked onto the base the same way every time, or refused", () => {
  const source = sourceRepository(join(dir, "pick"));
  const applied = cherryPick(source.at, source.base, source.fix);
  // The same commit on every provisioning: a rerun pushes the same main.
  assert.equal(cherryPick(source.at, source.base, source.fix), applied);
  assert.equal(show(source.at, "rev-parse", `${applied}^`), source.base);
  assert.equal(
    show(source.at, "show", `${applied}:test/export.test.js`),
    "retries(2);",
  );
  // Only the patch: the Objective's README isn't carried with it.
  assert.equal(show(source.at, "show", `${applied}:README.md`), "# widgets");
  assert.equal(
    show(source.at, "show", "-s", "--format=%an %aI|%B", applied),
    `Widgets Dev 2031-03-05T09:00:00Z|Retry the flaky export test\n\n(cherry picked from commit ${source.fix})`,
  );
  assert.throws(
    () => cherryPick(source.at, source.base, source.clash),
    new RegExp(
      `^Error: The base patch ${source.clash} doesn't apply cleanly onto ${source.base}: it conflicts in README\\.md$`,
    ),
  );
  assert.throws(
    () => cherryPick(source.at, applied, source.fix),
    /changes nothing on [0-9a-f]+: the base has it already$/,
  );
  assert.throws(
    () => cherryPick(source.at, applied, source.base),
    /is a root commit: only a commit with one parent applies$/,
  );
});

/**
 * A Runner that runs Git for real, with GitHub's URLs in `urls` going to
 * local repositories, and stands in for gh and Factory: the test
 * repository and Project exist, the Objective is filed, setup configures
 * and writes the configuration.
 */
class StandIn extends Runner {
  constructor(urls, definition) {
    super({ dryRun: false, print: () => {} });
    this.calls = [];
    this.definition = definition;
    const entries = Object.entries(urls);
    this.gitEnv = Object.fromEntries([
      ["GIT_CONFIG_COUNT", String(entries.length)],
      ...entries.flatMap(([url, local], i) => [
        [`GIT_CONFIG_KEY_${i}`, `url.${local}.insteadOf`],
        [`GIT_CONFIG_VALUE_${i}`, url],
      ]),
    ]);
  }

  run(argv, options = {}) {
    const shown = Runner.shown(argv);
    this.calls.push(shown);
    if (argv[0] === "git")
      return super.run(argv, {
        ...options,
        env: { ...options.env, ...this.gitEnv },
      });
    if (argv[0] === process.execPath) {
      // Setup writes the run's configuration.
      const { FACTORY_CONFIG, FACTORY_REPOSITORY } = options.env;
      if (!existsSync(FACTORY_CONFIG))
        writeFileSync(
          FACTORY_CONFIG,
          JSON.stringify({ repository: FACTORY_REPOSITORY }),
        );
      return '{"status":"configured"}';
    }
    if (shown.startsWith("gh repo view"))
      return this.definition.repository.description;
    if (shown.includes("/rulesets")) return "protect-main";
    if (shown.includes("/actions/variables/")) return "runner";
    if (shown.includes("/actions/workflows"))
      return "1 active .github/workflows/test.yml";
    if (shown.startsWith("gh project list")) return "7";
    if (shown.startsWith("gh project view")) return "PVT_bench";
    if (shown.startsWith("gh issue list")) return "42";
    return "";
  }
}

const real = join(dir, "real");
const source = sourceRepository(join(real, "source"));
const realHost = {
  benchRoot: join(real, "bench"),
  workDir: join(real, "work"),
  cacheDir: join(real, "cache"),
  sourceState: join(real, "state"),
  toolchain: "/opt/toolchain",
};

/** The example on the invented source, with `patches` on its base, loaded. */
function patchedDefinition(name, patches) {
  const value = JSON.parse(readFileSync(EXAMPLE, "utf8"));
  value.source = { repository: "acme/widgets", base: source.base, lfs: false };
  value.memory = { seed: "none" };
  value.basePatches = patches;
  const file = join(real, `${name}.json`);
  mkdirSync(real, { recursive: true });
  writeFileSync(file, JSON.stringify(value));
  return loadDefinition(file);
}

/**
 * Provision run `runId` of `definition` against local repositories with
 * `factory`, standing in with a `StandInRunner`; that runner too.
 */
async function provisionLocally(
  definition,
  runId,
  capacity,
  {
    StandInRunner = StandIn,
    factory = { kind: "release", cli: "/opt/factory/dist/cli.js" },
  } = {},
) {
  const name = `bench-widgets-42-${runId}`;
  const origin = join(real, "github", `${name}.git`);
  if (!existsSync(origin))
    execFileSync("git", [
      "init",
      "--quiet",
      "--bare",
      "--initial-branch=main",
      origin,
    ]);
  const runDir = join(realHost.benchRoot, definition.id, runId);
  mkdirSync(runDir, { recursive: true });
  // Fetched and checked before: the digest check isn't what this tests.
  writeFileSync(join(runDir, "objective.md"), "The Objective\n");
  const runner = new StandInRunner(
    {
      "https://github.com/acme/widgets.git": source.at,
      [`https://github.com/acme/${name}.git`]: origin,
    },
    definition,
  );
  const provisioned = provision({
    definition,
    host: realHost,
    factory,
    runId,
    label: runId,
    group: "patched",
    capacity,
    runner,
  });
  return { provisioned, runner, origin, runDir };
}

test("provisioning applies the base patches before anything is queued, records them, and they are never hand fixes", async () => {
  const reason = "the source's later fix of the flaky export test";
  const definition = patchedDefinition("patched", [
    { commit: source.fix, reason },
  ]);
  const capacity = runCapacity(definition, { workers: 3 });
  const { provisioned, runner, origin, runDir } = await provisionLocally(
    definition,
    "p1",
    capacity,
  );
  const record = await provisioned;
  // main is the base with the patch, as the record says.
  const main = show(origin, "rev-parse", "main");
  assert.deepEqual(record.basePatches, [
    { commit: source.fix, reason, applied: main },
  ]);
  assert.equal(show(origin, "rev-parse", "main^"), source.base);
  assert.equal(show(origin, "show", "main:test/export.test.js"), "retries(2);");
  assert.deepEqual(
    JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")),
    record,
  );
  // The patch is pushed before setup runs and the Objective is looked up.
  const at = (text) => runner.calls.findIndex((call) => call.includes(text));
  assert.ok(at("push --no-verify") < at("setup --repo"));
  assert.ok(at("setup --repo") < at("gh issue list"));
  // The capacity reaches setup and the record.
  assert.deepEqual(record.capacity, {
    workers: 3,
    validations: 2,
    memoryMib: 16384,
    share: null,
  });
  assert.ok(
    runner.calls.some((call) =>
      call.endsWith(
        "--day-tokens 80000000 --workers 3 --validations 2 --memory-mib 16384 --json",
      ),
    ),
    runner.calls.join("\n"),
  );
  // Scoring gets the patches, and hand-fix detection leaves them out even
  // inside the run's window.
  assert.deepEqual(harnessRun(record).basePatches, record.basePatches);
  const window = {
    end: main,
    base: source.base,
    startedAt: "2031-03-05T00:00:00Z",
    endedAt: "2031-03-06T00:00:00Z",
    merges: new Set(),
    heads: new Set(),
  };
  assert.deepEqual(
    handFixCommits(record.checkout, window).map((fix) => fix.sha),
    [main],
  );
  assert.deepEqual(
    handFixCommits(record.checkout, { ...window, patches: new Set([main]) }),
    [],
  );
  // Provisioned again, it carries on with the same main.
  const again = await (await provisionLocally(definition, "p1", capacity))
    .provisioned;
  assert.deepEqual(again.basePatches, record.basePatches);
  assert.equal(show(origin, "rev-parse", "main"), main);
  assert.ok(!existsSync(join(realHost.cacheDir, "acme__widgets.lock")));
});

test("a base patch that doesn't apply stops provisioning before anything is pushed", async () => {
  const definition = patchedDefinition("clash", [
    { commit: source.fix, reason: "the flaky export test" },
    { commit: source.clash, reason: "a README edit over the Objective's" },
  ]);
  // Provisioned before: a rerun that stops keeps what run.mjs and scoring
  // read, and the capacity its service was set up with.
  const runDir = join(realHost.benchRoot, definition.id, "p2");
  mkdirSync(runDir, { recursive: true });
  const before = {
    issue: 42,
    capacity: { workers: 2, share: 6 },
    provisionedAt: "2031-03-04T09:05:00.000Z",
    queuedAt: "2031-03-04T09:06:00.000Z",
  };
  writeFileSync(join(runDir, "run.json"), JSON.stringify(before));
  const { provisioned, runner, origin } = await provisionLocally(
    definition,
    "p2",
    runCapacity(definition),
  );
  await assert.rejects(
    provisioned,
    new RegExp(
      `The base patch ${source.clash} doesn't apply cleanly onto [0-9a-f]{40}: it conflicts in README\\.md$`,
    ),
  );
  assert.ok(!runner.calls.some((call) => call.includes(" push ")));
  assert.ok(!runner.calls.some((call) => call.startsWith("gh ")));
  assert.throws(() => show(origin, "rev-parse", "--verify", "--quiet", "main"));
  const kept = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
  assert.deepEqual(
    Object.fromEntries(Object.keys(before).map((key) => [key, kept[key]])),
    before,
  );
  // The lock is released for the next provisioning.
  assert.ok(!existsSync(join(realHost.cacheDir, "acme__widgets.lock")));
});

// --- review artifacts: in factory.json before the service starts ------------

const [EXPORT_REPORT] = loadDefinition(EXAMPLE).factory.reviewArtifacts;
/** An invented text selector of `command`'s stdout. */
const stdoutSelector = (command) => ({
  command,
  text: { source: "package.json", stdout: { maxBytes: 4096 } },
});

test("the definition's selectors are added to factory.json once, after those it has", () => {
  const other = stdoutSelector("npm run lint");
  const file = join(dir, "carry.json");
  writeFileSync(
    file,
    `${JSON.stringify({ repository: "acme/bench-widgets-42-a", reviewArtifacts: [other] }, null, 2)}\n`,
  );
  assert.equal(carryReviewArtifacts(file, [EXPORT_REPORT]), true);
  const written = readFileSync(file, "utf8");
  assert.deepEqual(JSON.parse(written).reviewArtifacts, [other, EXPORT_REPORT]);
  // Again, its keys in another order: the same selector, so nothing changes.
  const reordered = {
    text: EXPORT_REPORT.text,
    command: EXPORT_REPORT.command,
  };
  assert.equal(carryReviewArtifacts(file, [reordered]), false);
  assert.equal(readFileSync(file, "utf8"), written);
  // A merge Factory's loader refuses leaves the file as it was.
  const seven = [1, 2, 3, 4, 5, 6, 7].map((n) =>
    stdoutSelector(`npm run check-${n}`),
  );
  assert.throws(
    () => carryReviewArtifacts(file, seven),
    /can't be added to \S+carry\.json: reviewArtifacts must be a list of at most 8 selectors$/,
  );
  assert.equal(readFileSync(file, "utf8"), written);
});

const setupHome = join(dir, "setup-home");
mkdirSync(setupHome);

/**
 * The stand-in, with Factory's own setup run offline: no gh, no provider
 * login and a home of its own, so it reports itself blocked on GitHub and
 * the provider, after it has written and loaded the configuration. It is
 * given `--background` without it, which would start a service: setup
 * writes the file the same way with it. Each setup is recorded with the
 * file's reviewArtifacts before it ran and its own status.
 */
class FactorySetup extends StandIn {
  setups = [];

  run(argv, options = {}) {
    if (argv[0] !== process.execPath) return super.run(argv, options);
    this.calls.push(Runner.shown(argv));
    const { FACTORY_CONFIG, FACTORY_STATE_DIR, FACTORY_REPOSITORY } =
      options.env;
    const before = existsSync(FACTORY_CONFIG)
      ? JSON.parse(readFileSync(FACTORY_CONFIG, "utf8")).reviewArtifacts
      : undefined;
    const ran = spawnSync(
      process.execPath,
      argv.slice(1).filter((arg) => arg !== "--background"),
      {
        encoding: "utf8",
        env: {
          HOME: setupHome,
          PATH: bin,
          FACTORY_CONFIG,
          FACTORY_STATE_DIR,
          FACTORY_REPOSITORY,
        },
      },
    );
    const { status, problems } = JSON.parse(ran.stdout);
    this.setups.push({
      background: argv.includes("--background"),
      before,
      status,
      problems,
    });
    return '{"status":"configured"}';
  }
}

test("provisioning writes the definition's reviewArtifacts into factory.json before the service starts, and setup keeps them", async () => {
  const definition = patchedDefinition("artifacts", []);
  assert.deepEqual(definition.factory.reviewArtifacts, [EXPORT_REPORT]);
  const factory = { kind: "candidate", cli: join(root, "dist", "cli.js") };
  const { provisioned, runner, runDir } = await provisionLocally(
    definition,
    "a1",
    runCapacity(definition),
    { StandInRunner: FactorySetup, factory },
  );
  const record = await provisioned;
  const config = join(runDir, "factory.json");
  const written = readFileSync(config, "utf8");
  // In the file before the service starts, and still there after setup ran again.
  assert.deepEqual(JSON.parse(written).reviewArtifacts, [EXPORT_REPORT]);
  assert.deepEqual(
    runner.setups.map(({ background, before }) => ({ background, before })),
    [
      { background: false, before: undefined },
      { background: true, before: [EXPORT_REPORT] },
    ],
  );
  // Factory loaded the file each time: it stops at GitHub and the provider, never at the configuration.
  for (const { status, problems } of runner.setups) {
    assert.equal(status, "blocked");
    assert.ok(
      problems.every((problem) => !/reviewArtifacts/.test(problem)),
      problems.join("\n"),
    );
  }
  assert.deepEqual(record.reviewArtifacts, [EXPORT_REPORT]);
  assert.deepEqual(
    JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")).reviewArtifacts,
    [EXPORT_REPORT],
  );

  // Provisioned again, the file is unchanged.
  const again = await provisionLocally(
    definition,
    "a1",
    runCapacity(definition),
    { StandInRunner: FactorySetup, factory },
  );
  assert.deepEqual((await again.provisioned).reviewArtifacts, [EXPORT_REPORT]);
  assert.equal(readFileSync(config, "utf8"), written);
  // With a new capacity, setup writes the file again and keeps the key.
  const more = await provisionLocally(
    definition,
    "a1",
    runCapacity(definition, { workers: 3 }),
    { StandInRunner: FactorySetup, factory },
  );
  await more.provisioned;
  const rewritten = JSON.parse(readFileSync(config, "utf8"));
  assert.equal(rewritten.execution.workers, 3);
  assert.deepEqual(rewritten.reviewArtifacts, [EXPORT_REPORT]);
});
