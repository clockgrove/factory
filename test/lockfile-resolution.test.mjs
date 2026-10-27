// clockgrove/clockgrove#826: an Objective that moved dependencies held at
// planning, since no worker has the network to resolve pnpm-lock.yaml and
// the frozen install refuses a stale one. Factory now resolves it itself,
// as the install runs, and commits it on the candidate (#2095). Real Git
// and the real sandbox; a stand-in pnpm on the PATH plays the registry.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../dist/config.js";
import { CAPTURE_OFF, RunLog } from "../dist/log.js";
import { resolutionNetworkRefusal } from "../dist/package-network.js";
import { validationEnvironmentNote } from "../dist/planning/facts.js";
import { lockfileRef, validateTree } from "../dist/validate.js";
import { candidate } from "../dist/work/steps.js";
import { configured, installation, item, REPO, tempDir } from "./helpers.mjs";

const BOOTSTRAP = "pnpm install --frozen-lockfile --ignore-scripts";

// The sandbox mounts PATH directories read-only, never one in a shared
// temporary directory, so the stand-in lives beside the tests (ignored).
const tools = mkdtempSync(
  join(dirname(fileURLToPath(import.meta.url)), ".tools-"),
);
after(() => rmSync(tools, { recursive: true, force: true }));
writeFileSync(
  join(tools, "fake-pnpm.cjs"),
  `const { readFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2).join(" ");
const dependencies = JSON.parse(readFileSync("package.json", "utf8")).dependencies ?? {};
const names = Object.keys(dependencies).sort();
const expected = [
  "lockfileVersion: '9.0'",
  "importers:",
  "  .:",
  "    dependencies:",
  ...names.flatMap((name) => ["      " + name + ":", "        specifier: " + dependencies[name], "        version: " + dependencies[name]]),
  "packages:",
  ...names.flatMap((name) => ["  " + name + "@" + dependencies[name] + ":", "    resolution: {integrity: sha512-AAAA}"]),
  "",
].join("\\n");
if (args === "install --frozen-lockfile --ignore-scripts") {
  if (readFileSync("pnpm-lock.yaml", "utf8") === expected) process.exit(0);
  console.error(' ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date with package.json');
  process.exit(1);
}
if (args === "install --lockfile-only --no-frozen-lockfile --ignore-scripts") {
  if (process.env.pnpm_config_ignore_scripts !== "true") process.exit(2);
  for (const name of names)
    if (dependencies[name] === "9.9.9") {
      console.error(" ERR_PNPM_NO_MATCHING_VERSION  No matching version found for " + name + "@9.9.9 published before the minimumReleaseAge of 1440 minutes");
      process.exit(1);
    }
  writeFileSync("pnpm-lock.yaml", expected);
  process.exit(0);
}
console.error("unexpected pnpm " + args);
process.exit(3);
`,
);
writeFileSync(
  join(tools, "pnpm"),
  `#!/bin/sh\nexec node "${join(tools, "fake-pnpm.cjs")}" "$@"\n`,
);
chmodSync(join(tools, "pnpm"), 0o755);
process.env.PATH = `${tools}:${process.env.PATH}`;

/** The lockfile the stand-in writes for `dependencies`. */
function lockfile(dependencies) {
  const names = Object.keys(dependencies).sort();
  return [
    "lockfileVersion: '9.0'",
    "importers:",
    "  .:",
    "    dependencies:",
    ...names.flatMap((name) => [
      `      ${name}:`,
      `        specifier: ${dependencies[name]}`,
      `        version: ${dependencies[name]}`,
    ]),
    "packages:",
    ...names.flatMap((name) => [
      `  ${name}@${dependencies[name]}:`,
      "    resolution: {integrity: sha512-AAAA}",
    ]),
    "",
  ].join("\n");
}

const git = (cwd, ...args) => {
  const result = spawnSync(
    "git",
    ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

/** Commits `files` (path to content) on `checkout`; returns the commit. */
function commit(checkout, files) {
  for (const [path, content] of Object.entries(files))
    writeFileSync(join(checkout, path), content);
  git(checkout, "add", ".");
  git(checkout, "commit", "--quiet", "-m", "change");
  return git(checkout, "rev-parse", "HEAD");
}

const manifest = (dependencies) =>
  `${JSON.stringify({ name: "target", private: true, dependencies })}\n`;

/**
 * A base whose lockfile matches `base`, and a candidate that changes the
 * files in `change` (its dependencies, by default to `candidate`), validated
 * under sandbox.network `network`. The events validation logged come back.
 */
async function validate({
  base = { "left-pad": "1.0.0" },
  lock = base,
  candidate: dependencies = { ...base, "is-number": "7.0.0" },
  change = { "package.json": manifest(dependencies) },
  network = "host",
  commands = [BOOTSTRAP],
} = {}) {
  const inst = installation();
  configured(inst, "http://127.0.0.1:1");
  process.env.FACTORY_CONFIG = inst.env.FACTORY_CONFIG;
  const { sandbox } = loadConfig(REPO);
  delete process.env.FACTORY_CONFIG;
  const checkout = tempDir("factory-lockfile-");
  git(checkout, "init", "--quiet");
  const planned = commit(checkout, {
    "package.json": manifest(base),
    "pnpm-lock.yaml": lockfile(lock),
  });
  const built = commit(checkout, change);
  const log = new RunLog(
    inst.logs,
    "2026-01-01T00-00-00-000Z-1",
    CAPTURE_OFF,
    [],
  );
  const events = [];
  const work = item("a", {
    ownedPaths: ["package.json"],
    validation: commands.map((command) => ({ command })),
  });
  const result = await validateTree({
    checkout,
    repository: REPO,
    directory: `${checkout}.validation`,
    commit: built,
    item: work,
    plan: { base: planned, items: [work], finalCommands: [] },
    blocks: [],
    base: planned,
    lockfile: { ref: lockfileRef(1, "a") },
    sandbox: { ...sandbox, network },
    commandTimeoutMs: 60_000,
    signal: AbortSignal.timeout(120_000),
    log: (event) => events.push(event),
    runFile: (kind) => log.runFile(1, `item:a:validate#1.${kind}`),
  });
  return { result, events, checkout, planned, built };
}

const resolutions = (events) =>
  events.filter((event) => event.event === "lockfile-resolution");

test("a dependency change with a stale lockfile gets Factory's resolved lockfile, committed on the candidate, and passes the frozen install", async () => {
  const { result, events, checkout, built } = await validate({
    commands: [BOOTSTRAP, "grep -q is-number@7.0.0 *-lock.yaml"],
  });
  assert.equal(result.kind, "passed", JSON.stringify(result).slice(0, 1500));
  assert.equal(result.regenerated?.lockfile, "pnpm-lock.yaml");
  const made = result.regenerated.commit;
  // Factory's commit on the candidate, changing only the lockfile.
  assert.equal(git(checkout, "rev-parse", `${made}^`), built);
  assert.equal(git(checkout, "rev-parse", `${made}^{tree}`), result.tree);
  assert.equal(
    git(checkout, "diff", "--name-only", built, made),
    "pnpm-lock.yaml",
  );
  assert.equal(
    git(checkout, "log", "-1", "--format=%ce", made),
    "factory@users.noreply.github.com",
  );
  assert.equal(
    git(checkout, "show", `${made}:pnpm-lock.yaml`),
    lockfile({ "is-number": "7.0.0", "left-pad": "1.0.0" }).trimEnd(),
  );
  // Kept from pruning until cleanup.
  assert.equal(git(checkout, "rev-parse", lockfileRef(1, "a")), made);
  // The install ran twice: refused, then on Factory's commit.
  const installs = events.filter(
    (event) => event.event === "validation-result" && event.index === 0,
  );
  assert.deepEqual(
    installs.map((event) => event.passed),
    [false, true],
  );
  assert.equal(resolutions(events).length, 1);
  assert.equal(resolutions(events)[0].network, "host");
  assert.deepEqual(
    result.results.map((entry) => entry.command),
    [BOOTSTRAP, "grep -q is-number@7.0.0 *-lock.yaml"],
  );
});

test("with sandbox.network off, a dependency change with a stale lockfile holds, naming package-install", async () => {
  const { result, events } = await validate({ network: "off" });
  assert.equal(result.kind, "hold", JSON.stringify(result).slice(0, 1500));
  assert.match(result.question, /ERR_PNPM_OUTDATED_LOCKFILE/);
  assert.match(
    result.question,
    /factory setup --repo drill\/target --sandbox-network package-install/,
  );
  assert.deepEqual(
    result.options.map((option) => option.answer),
    ["retry", "replan", "cancel"],
  );
  assert.equal(resolutions(events).length, 0);
});

test("a resolution the repository's release-age policy refuses holds with the package manager's message", async () => {
  const { result, events, checkout } = await validate({
    candidate: { "left-pad": "1.0.0", zod: "9.9.9" },
  });
  assert.equal(result.kind, "hold", JSON.stringify(result).slice(0, 1500));
  assert.match(
    result.question,
    /ERR_PNPM_NO_MATCHING_VERSION {2}No matching version found for zod@9\.9\.9 published before the minimumReleaseAge/,
  );
  assert.match(result.question, /never relaxes that policy/);
  assert.deepEqual(
    result.options.map((option) => option.answer),
    ["retry", "replan", "cancel"],
  );
  const [done] = events.filter(
    (event) => event.event === "lockfile-resolution-result",
  );
  assert.equal(done.passed, false);
  assert.ok(done.output, "the failed resolution's output is kept");
  // Nothing was committed or pinned.
  const pinned = spawnSync(
    "git",
    ["-C", checkout, "rev-parse", "--verify", "--quiet", lockfileRef(1, "a")],
    { encoding: "utf8" },
  );
  assert.notEqual(pinned.status, 0);
});

test("a stale lockfile the candidate's dependency inputs didn't change is not resolved: the install's failure is the environment's", async () => {
  // The base's own lockfile is stale; the candidate changes a README.
  const { result, events } = await validate({
    lock: {},
    change: { "README.md": "readme\n" },
  });
  assert.equal(result.kind, "retry", JSON.stringify(result).slice(0, 1500));
  assert.match(result.reason, /ERR_PNPM_OUTDATED_LOCKFILE/);
  assert.equal(resolutions(events).length, 0);
});

test("QA and final validation never resolve a lockfile", async () => {
  const inst = installation();
  configured(inst, "http://127.0.0.1:1");
  process.env.FACTORY_CONFIG = inst.env.FACTORY_CONFIG;
  const { sandbox } = loadConfig(REPO);
  delete process.env.FACTORY_CONFIG;
  const checkout = tempDir("factory-lockfile-");
  git(checkout, "init", "--quiet");
  const planned = commit(checkout, {
    "package.json": manifest({ "left-pad": "1.0.0" }),
    "pnpm-lock.yaml": lockfile({ "left-pad": "1.0.0" }),
  });
  const head = commit(checkout, {
    "package.json": manifest({ "left-pad": "1.0.0", "is-number": "7.0.0" }),
  });
  const log = new RunLog(
    inst.logs,
    "2026-01-01T00-00-00-000Z-1",
    CAPTURE_OFF,
    [],
  );
  const events = [];
  const work = item("a", { validation: [{ command: BOOTSTRAP }] });
  const result = await validateTree({
    checkout,
    repository: REPO,
    directory: `${checkout}.validation`,
    commit: head,
    item: work,
    plan: { base: planned, items: [work], finalCommands: [] },
    blocks: [],
    sandbox: { ...sandbox, network: "host" },
    commandTimeoutMs: 60_000,
    signal: AbortSignal.timeout(120_000),
    log: (event) => events.push(event),
    runFile: (kind) => log.runFile(1, `final#1.${kind}`),
  });
  assert.equal(result.kind, "failed", JSON.stringify(result).slice(0, 1500));
  assert.equal(resolutions(events).length, 0);
});

/** A base with a registry-only pnpm lockfile, and a candidate's package.json. */
function manifests(dependencies, fields = {}) {
  const directory = tempDir("factory-resolution-network-");
  git(directory, "init", "--quiet");
  const base = commit(directory, {
    "package.json": manifest({ "left-pad": "1.0.0" }),
    "pnpm-lock.yaml": lockfile({ "left-pad": "1.0.0" }),
  });
  const changed = commit(directory, {
    "package.json": `${JSON.stringify({ name: "target", dependencies, ...fields })}\n`,
  });
  return { directory, base, changed };
}

for (const [shape, dependencies, fields] of [
  ["a registry range", { "left-pad": "^1.3.0" }],
  ["a dist-tag", { "left-pad": "latest" }],
  ["an npm alias", { pad: "npm:@scope/left-pad@^1.0.0" }],
  ["a sibling workspace package", { lib: "workspace:*" }],
  ["a pnpm catalog", { "left-pad": "catalog:" }],
  [
    "nested overrides and a $ reference",
    { "left-pad": "1.0.0" },
    { overrides: { ajv: { "fast-uri": "3.1.9" }, foo: "$left-pad" } },
  ],
])
  test(`a lockfile resolution may reach the registry for ${shape}`, async () => {
    const { directory, base, changed } = manifests(dependencies, fields);
    assert.equal(
      await resolutionNetworkRefusal(directory, base, changed),
      undefined,
    );
  });

for (const [shape, dependencies, fields] of [
  ["a hosted shorthand", { pad: "owner/left-pad" }],
  ["a git URL", { pad: "git+ssh://git@example.com/pad.git" }],
  ["a tarball URL", { pad: "https://example.com/pad.tgz" }],
  ["a file path", { pad: "file:../pad" }],
  ["an alias of a hosted package", { pad: "npm:pad@owner/left-pad" }],
  [
    "an override from a URL",
    { "left-pad": "1.0.0" },
    { resolutions: { "left-pad": "https://example.com/pad.tgz" } },
  ],
])
  test(`a lockfile resolution stays offline for ${shape}`, async () => {
    const { directory, base, changed } = manifests(dependencies, fields);
    const refusal = await resolutionNetworkRefusal(directory, base, changed);
    assert.match(refusal?.reason ?? "", /from outside the registry/);
    assert.equal(refusal.unverified, undefined);
  });

test("later steps use the validate step's commit with the resolved lockfile", () => {
  const state = {
    done: {
      "item:a:work": { commit: "work" },
      "item:a:validate": {
        tree: "t",
        commands: [],
        regenerated: { commit: "resolved", lockfile: "pnpm-lock.yaml" },
      },
      "item:b:work": { commit: "work-b" },
      "item:b:validate": { tree: "t", commands: [] },
    },
  };
  assert.equal(candidate(state, "a"), "resolved");
  assert.equal(candidate(state, "b"), "work-b");
});

test("the planner and plan review learn who resolves a dependency change's lockfile", () => {
  assert.match(
    validationEnvironmentNote(false, true),
    /Factory resolves it itself \(pnpm install --lockfile-only/,
  );
  assert.match(
    validationEnvironmentNote(false, false),
    /with sandbox.network off neither can Factory/,
  );
});
