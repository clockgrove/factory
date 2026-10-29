// A dry run of bench/provision.mjs prints every GitHub, Git and setup action
// of a benchmark run, in order, and does none: with no gh or git on PATH it
// still succeeds and leaves no run directory behind.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { loadDefinition } from "../bench/lib/definition.mjs";
import {
  enableOnlyKeptWorkflows,
  harnessRun,
  Runner,
  resolveFactory,
  seedMemory,
} from "../bench/lib/provision.mjs";

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
  const run = spawnSync(
    process.execPath,
    [
      join(root, "bench", "provision.mjs"),
      "--benchmark",
      "clockgrove-800",
      "--host",
      host,
      "--factory",
      join(root, "dist", "cli.js"),
      "--run-id",
      "t1",
      "--dry-run",
    ],
    { encoding: "utf8", env: { ...process.env, PATH: bin } },
  );
  assert.equal(run.status, 0, run.stderr);
  const out = run.stdout;
  const repo = "clockgrove/bench-clockgrove-800-t1";
  // This checkout's build is a candidate, recorded with its commit and build digest.
  assert.match(out, /"kind": "candidate"/);
  assert.match(out, /"commit": "[0-9a-f]{40}"/);
  assert.match(out, /"distSha256": "[0-9a-f]{64}"/);
  const steps = [
    "check: read clockgrove/clockgrove#800",
    "would: check its title and body digest (e22ce1842efc)",
    "git clone --no-checkout https://github.com/clockgrove/clockgrove.git",
    `gh repo create ${repo} --private`,
    `gh api -X PUT repos/${repo}/actions/permissions -F enabled=false`,
    "-F allow_merge_commit=true -F allow_squash_merge=true -F allow_rebase_merge=true -F allow_auto_merge=false -F delete_branch_on_merge=false",
    `push --no-verify https://github.com/${repo}.git 46a206678b4b8446aeb162553b07151647a28536:refs/heads/main`,
    "lfs push --object-id",
    "would: mirror the ruleset protected-main",
    `gh variable set QUALITY_RUNNER --repo ${repo} --body <clockgrove/clockgrove's value>`,
    "check: the base tree's workflow files",
    "-F enabled=true -f allowed_actions=all",
    "would: disable every workflow but .github/workflows/quality.yml",
    "workflows again: only .github/workflows/quality.yml active",
    "would: create the Project Factory bench clockgrove-800 t1",
    "--name 'Factory admission' --data-type TEXT",
    `gh label create factory:objective --repo ${repo}`,
    "would: configure Factory (setup)",
    "--codex-network host --sandbox-network package-install --read-only-path /opt/toolchain/ms-playwright",
    "--toolchain-path /opt/toolchain/postgresql-18.6/bin",
    "--objective-tokens 200000000 --day-tokens 400000000 --json",
    "would: seed memory from",
    "without #800's entries or any from 2026-10-28T11:06:00Z on",
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
    /FACTORY_CONFIG=\S+\/bench\/clockgrove-800\/t1\/factory\.json FACTORY_STATE_DIR=\S+\/bench\/clockgrove-800\/t1\/state factory setup/,
  );
  assert.ok(!existsSync(join(dir, "bench")), "a dry run creates nothing");
});

// --- the workflows: nothing deploy-capable may stay enabled ------------------

const definition = loadDefinition("clockgrove-800");
const REPO = "clockgrove/bench-clockgrove-800-w";
const BASE_FILES = [
  ".github/workflows/deploy.yml",
  ".github/workflows/qualification.yml",
  ".github/workflows/quality.yml",
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
          ".github/workflows/qualification.yml": "disabled_manually",
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
    ".github/workflows/qualification.yml": "disabled_manually",
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
    ["before-799", 799, "2026-10-27T22:59:00.000Z"],
    ["before-830", 830, "2026-10-28T00:30:00.000Z"],
    ["the-objective", 800, "2026-10-27T10:00:00.000Z"],
    ["just-after", 854, "2026-10-28T01:00:00.500Z"],
    ["after", 1, "2026-10-28T02:00:00.000Z"],
  ]) {
    add.run(id, objective, created);
    text.run(id);
  }
  db.close();
  // The same instant in UTC and with an offset: the same cut.
  for (const [n, before] of [
    [1, "2026-10-28T01:00:00Z"],
    [2, "2026-10-27T20:00:00-05:00"],
  ]) {
    const target = join(dir, `seeded-${n}`, "knowledge.sqlite");
    assert.deepEqual(await seedMemory(source, target, 800, before), {
      kept: 2,
      removed: 3,
    });
    const seeded = new DatabaseSync(target, { readOnly: true });
    assert.deepEqual(
      seeded
        .prepare("SELECT id FROM memory_text ORDER BY id")
        .all()
        .map((row) => row.id),
      ["before-799", "before-830"],
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
