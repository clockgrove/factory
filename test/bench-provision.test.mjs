// A dry run of bench/provision.mjs prints every GitHub, Git and setup action
// of a benchmark run, in order, and does none: with no gh or git on PATH it
// still succeeds and leaves no run directory behind.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
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
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadDefinition } from "../bench/lib/definition.mjs";
import { HOME_ENV } from "../bench/lib/home.mjs";
import {
  enableOnlyKeptWorkflows,
  harnessRun,
  Runner,
  resolveFactory,
  seedMemory,
} from "../bench/lib/provision.mjs";
import { EXAMPLE } from "./bench-fixture.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "bench-provision-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("a dry run prints the whole provisioning and touches nothing", () => {
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
  const git = process.env.PATH.split(":")
    .map((p) => join(p, "git"))
    .find((p) => existsSync(p));
  symlinkSync(git, join(bin, "git"));
  // Definitions and results live in a bench home outside the repository.
  const home = join(dir, "bench-home");
  mkdirSync(join(home, "benchmarks"), { recursive: true });
  writeFileSync(
    join(home, "benchmarks", "acme-widgets-42.json"),
    readFileSync(EXAMPLE),
  );
  const env = { ...process.env, PATH: bin };
  delete env[HOME_ENV];
  const run = spawnSync(
    process.execPath,
    [
      join(root, "bench", "provision.mjs"),
      "--bench-home",
      home,
      "--benchmark",
      "acme-widgets-42",
      "--host",
      host,
      "--factory",
      join(root, "dist", "cli.js"),
      "--run-id",
      "t1",
      "--dry-run",
    ],
    { encoding: "utf8", env },
  );
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
  const steps = [
    "check: read acme/widgets#42",
    "would: check its title and body digest (d0f6c906d9b1)",
    "git clone --no-checkout https://github.com/acme/widgets.git",
    `gh repo create ${repo} --private`,
    `gh api -X PUT repos/${repo}/actions/permissions -F enabled=false`,
    "-F allow_merge_commit=true -F allow_squash_merge=true -F allow_rebase_merge=false -F allow_auto_merge=false -F delete_branch_on_merge=true",
    `push --no-verify https://github.com/${repo}.git 0123456789abcdef0123456789abcdef01234567:refs/heads/main`,
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
    "--objective-tokens 40000000 --day-tokens 80000000 --json",
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
  assert.ok(!existsSync(join(home, "results")), "a dry run creates nothing");
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
