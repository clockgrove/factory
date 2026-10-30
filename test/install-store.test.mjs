// clockgrove/factory#2169: every validation ran the frozen install from an
// empty package store, a minute each in clockgrove/clockgrove#800, six
// times in one worker turn. A Work Item's validations now keep the install's
// store beside the item's worktree, reused while the install's inputs keep
// their key, and the frozen install still runs every time. Real Git and the
// real sandbox; a stand-in pnpm on the PATH counts what it fetched.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../dist/config.js";
import { CAPTURE_OFF, RunLog } from "../dist/log.js";
import { sandboxAvailable } from "../dist/sandbox.js";
import { installKey, keptStore, validateTree } from "../dist/validate.js";
import { SelfValidation } from "../dist/work/self-validate.js";
import { qaValidateStep, validateStep } from "../dist/work/steps.js";
import {
  addWorktree,
  installStorePath,
  removeWorktree,
  worktreePath,
} from "../dist/worktree.js";
import {
  configured,
  githubOrigin,
  installation,
  item,
  plan,
  REPO,
  tempDir,
} from "./helpers.mjs";

const BOOTSTRAP = "pnpm install --frozen-lockfile --ignore-scripts";
const NPM_BOOTSTRAP = "npm ci --ignore-scripts";

// The sandbox mounts PATH directories read-only, never one in a shared
// temporary directory, so the stand-in lives beside the tests (ignored).
const tools = mkdtempSync(
  join(dirname(fileURLToPath(import.meta.url)), ".tools-"),
);
after(() => rmSync(tools, { recursive: true, force: true }));
// The frozen install: each `name@version` line of the lockfile is a
// package, fetched into the store unless the store has it; a lockfile that
// says "broken" is refused, as pnpm refuses one that doesn't match.
writeFileSync(
  join(tools, "fake-pnpm.cjs"),
  `const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(2).join(" ");
if (args !== "install --frozen-lockfile --ignore-scripts") {
  console.error("unexpected pnpm " + args);
  process.exit(3);
}
if (process.env.pnpm_config_ignore_scripts !== "true") process.exit(2);
const lock = readFileSync("pnpm-lock.yaml", "utf8");
if (lock.includes("broken")) {
  console.error(" ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with \\"frozen-lockfile\\" because pnpm-lock.yaml is not up to date");
  process.exit(1);
}
const store = process.env.pnpm_config_store_dir;
mkdirSync(store, { recursive: true });
let reused = 0;
let downloaded = 0;
for (const name of lock.split("\\n").filter((line) => line.includes("@"))) {
  const file = join(store, name.replaceAll("/", "+"));
  if (existsSync(file)) reused++;
  else {
    // A "big" package takes 2 MiB of the store.
    writeFileSync(file, name.includes("big") ? Buffer.alloc(2 * 1024 ** 2) : name);
    downloaded++;
  }
}
console.log("store " + store);
console.log("Progress: resolved " + (reused + downloaded) + ", reused " + reused + ", downloaded " + downloaded + ", done");
`,
);
writeFileSync(
  join(tools, "pnpm"),
  `#!/bin/sh\nexec node "${join(tools, "fake-pnpm.cjs")}" "$@"\n`,
);
chmodSync(join(tools, "pnpm"), 0o755);
process.env.PATH = `${tools}:${process.env.PATH}`;

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
  for (const [path, content] of Object.entries(files)) {
    const target = join(checkout, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  git(checkout, "add", ".");
  git(checkout, "commit", "--quiet", "-m", "change");
  return git(checkout, "rev-parse", "HEAD");
}

const BASE = {
  ".gitignore": "node_modules\n",
  "package.json": `${JSON.stringify({ name: "target", private: true })}\n`,
  "pnpm-lock.yaml": "left-pad@1.0.0\nis-number@7.0.0\n",
  "src/index.js": "export {};\n",
};

/** A target clone with the base committed, and its base commit. */
function target() {
  const checkout = tempDir("factory-install-store-");
  git(checkout, "init", "--quiet");
  return { checkout, base: commit(checkout, BASE) };
}

function sandboxConfig(fields = {}) {
  const inst = installation();
  configured(inst, "http://127.0.0.1:1");
  process.env.FACTORY_CONFIG = inst.env.FACTORY_CONFIG;
  const config = loadConfig(REPO);
  delete process.env.FACTORY_CONFIG;
  const sandbox = { ...config.sandbox, network: "off", ...fields };
  return { inst, config: { ...config, sandbox }, sandbox };
}

/**
 * Validates `built` on `checkout` as a Work Item's validation does, with
 * `commands` and the item's kept store beside the checkout (`store`, else
 * none). The events validation logged come back.
 */
async function validate(
  checkout,
  base,
  built,
  { commands = [BOOTSTRAP], store = `${checkout}.packages`, sandbox } = {},
) {
  const configured = sandbox ?? sandboxConfig();
  const log = new RunLog(
    configured.inst.logs,
    "2026-01-01T00-00-00-000Z-1",
    CAPTURE_OFF,
    [],
  );
  const events = [];
  const work = item("a", {
    ownedPaths: ["src/**"],
    validation: commands.map((command) => ({ command })),
  });
  const result = await validateTree({
    checkout,
    repository: REPO,
    directory: `${checkout}.validation`,
    ...(store ? { installStore: store } : {}),
    commit: built,
    item: work,
    plan: { base, items: [work], coverage: [], finalCommands: [] },
    blocks: [],
    base,
    sandbox: configured.sandbox,
    commandTimeoutMs: 60_000,
    signal: AbortSignal.timeout(120_000),
    log: (event) => events.push(event),
    runFile: (kind) => log.runFile(1, `item:a:validate#1.${kind}`),
  });
  return { result, events };
}

/** The install's `validation-command` event's store and its counts. */
function install({ result, events }) {
  assert.equal(result.kind, "passed", JSON.stringify(result).slice(0, 1500));
  const started = events.find(
    (event) => event.event === "validation-command" && event.index === 0,
  );
  const [, reused, downloaded] =
    /reused (\d+), downloaded (\d+)/.exec(result.results[0].tail) ?? [];
  return {
    installStore: started.installStore,
    reused: Number(reused),
    downloaded: Number(downloaded),
    store: /^store (.*)$/m.exec(result.results[0].tail)?.[1],
  };
}

const sandboxed = sandboxAvailable().available;
const skip = sandboxed ? false : "needs the command sandbox (bubblewrap)";

test("an unchanged lockfile reuses the item's store, and the frozen install still runs every time", {
  skip,
}, async () => {
  const { checkout, base } = target();
  const built = commit(checkout, { "src/index.js": "export const a = 1;\n" });
  const first = install(await validate(checkout, base, built));
  assert.deepEqual(
    { ...first, store: undefined },
    { installStore: "new", reused: 0, downloaded: 2, store: undefined },
  );
  // The store is Factory's, beside the worktree: never in the checkout or
  // the install's private HOME.
  assert.equal(
    first.store,
    join(`${checkout}.packages`, "cache", "pnpm-store"),
  );
  assert.equal(statSync(`${checkout}.packages`).mode & 0o777, 0o700);
  // The same commit again (the worker's Validate, then the validate step):
  // the install runs, frozen, and fetches nothing.
  const again = await validate(checkout, base, built);
  assert.deepEqual(
    { ...install(again), store: undefined },
    { installStore: "reused", reused: 2, downloaded: 0, store: undefined },
  );
  assert.equal(
    again.events.filter(
      (event) => event.event === "validation-result" && event.index === 0,
    ).length,
    1,
  );
  // A change that leaves every dependency input alone keeps the key.
  const repaired = commit(checkout, {
    "src/index.js": "export const a = 2;\n",
  });
  assert.equal(
    install(await validate(checkout, base, repaired)).installStore,
    "reused",
  );
});

test("a changed lockfile reinstalls from an empty store, and a broken one still fails", {
  skip,
}, async () => {
  const { checkout, base } = target();
  const built = commit(checkout, { "src/index.js": "export const a = 1;\n" });
  install(await validate(checkout, base, built));
  const store = join(`${checkout}.packages`, "cache", "pnpm-store");
  assert.equal(readdirSync(store).length, 2);
  // The result's own dependency change: a new key, so nothing an earlier
  // install fetched is kept, and the install proves the change.
  const moved = commit(checkout, {
    "pnpm-lock.yaml": "left-pad@1.0.0\nis-number@7.0.0\nzod@4.0.0\n",
  });
  assert.deepEqual(
    { ...install(await validate(checkout, base, moved)), store: undefined },
    { installStore: "new", reused: 0, downloaded: 3, store: undefined },
  );
  // A lockfile the frozen install refuses fails, warm store or not.
  const broken = commit(checkout, { "pnpm-lock.yaml": "broken\n" });
  const { result, events } = await validate(checkout, base, broken);
  assert.equal(result.kind, "failed", JSON.stringify(result).slice(0, 1500));
  assert.equal(result.failed?.command, BOOTSTRAP);
  assert.match(result.output, /ERR_PNPM_OUTDATED_LOCKFILE/);
  assert.equal(
    events.find((event) => event.event === "validation-command").installStore,
    "new",
  );
});

test("a worker's own Validate keeps the store beside its worktree, the one the validate step reuses", {
  skip,
}, async () => {
  // Every provider's Validate is this one (Claude's, Copilot's, and
  // Codex's through codex-validate.ts).
  const { inst, sandbox } = sandboxConfig();
  const log = new RunLog(
    inst.logs,
    "2026-01-01T00-00-00-000Z-1",
    CAPTURE_OFF,
    [],
  );
  const { checkout: worktree, base } = target();
  writeFileSync(join(worktree, "src/index.js"), "export const a = 1;\n");
  const work = item("a", {
    ownedPaths: ["src/**"],
    validation: [{ command: BOOTSTRAP }],
  });
  const signal = AbortSignal.timeout(120_000);
  const events = [];
  const validator = new SelfValidation(
    {
      worktree,
      item: work,
      base,
      signal,
      log: (event) => events.push(event),
      runFile: (kind) => log.runFile(1, `item:a:work#1.${kind}`),
    },
    {
      sandbox,
      plan: { base, items: [work], coverage: [], finalCommands: [] },
      blocks: [],
      repository: REPO,
      commandTimeoutMs: 60_000,
    },
    signal,
  );
  for (let run = 0; run < 2; run++) {
    const answer = await validator.call();
    assert.equal(answer.isError, false, answer.text);
    assert.ok(answer.text.startsWith("All 1 declared"), answer.text);
  }
  assert.deepEqual(
    events
      .filter((event) => event.event === "validation-command")
      .map((event) => event.installStore),
    ["new", "reused"],
  );
  assert.equal(
    readdirSync(join(`${worktree}.packages`, "cache", "pnpm-store")).length,
    2,
  );
  // The validate step, on the worker's collected result: the same inputs.
  const collected = commit(worktree, {});
  assert.equal(
    install(await validate(worktree, base, collected)).installStore,
    "reused",
  );
});

test("only the install writes the kept store: a later command can't reach it", {
  skip,
}, async () => {
  const { checkout, base } = target();
  const built = commit(checkout, { "src/index.js": "export const a = 1;\n" });
  const kept = `${checkout}.packages`;
  const poison = join(kept, "cache", "poison");
  // It can't write there, and no variable names the store.
  const later = `! sh -c 'echo poisoned > ${poison}' 2>/dev/null && ! printenv | grep -qF '${kept}'`;
  const { result } = await validate(checkout, base, built, {
    commands: [BOOTSTRAP, later],
  });
  assert.equal(result.kind, "passed", JSON.stringify(result).slice(0, 1500));
  assert.equal(result.results.length, 2);
  assert.equal(existsSync(poison), false);
  assert.equal(readdirSync(join(kept, "cache", "pnpm-store")).length, 2);
  // The key sits outside what the install may write.
  assert.ok(existsSync(join(`${checkout}.packages`, "key")));
});

test("with the operator's sandbox.packageStore, or with no kept store, nothing is kept beside the worktree", {
  skip,
}, async () => {
  const { checkout, base } = target();
  const built = commit(checkout, { "src/index.js": "export const a = 1;\n" });
  // Never in a shared temporary directory, which the sandbox refuses.
  const shared = mkdtempSync(
    join(dirname(fileURLToPath(import.meta.url)), ".tools-store-"),
  );
  after(() => rmSync(shared, { recursive: true, force: true }));
  const operator = install(
    await validate(checkout, base, built, {
      sandbox: sandboxConfig({ packageStore: shared }),
    }),
  );
  assert.equal(operator.installStore, undefined);
  assert.equal(operator.store, join(shared, "pnpm-store"));
  assert.equal(existsSync(`${checkout}.packages`), false);
  // Final validation passes no store: each install's is its own HOME's.
  const none = install(await validate(checkout, base, built, { store: null }));
  assert.equal(none.installStore, undefined);
  assert.match(none.store, /factory-install-home-[^/]+\/\.cache\/pnpm-store$/);
  assert.equal(none.downloaded, 2);
});

test("the install key covers the command and every dependency input, nothing else", async () => {
  const { checkout } = target();
  const signal = AbortSignal.timeout(30_000);
  const key = (commit, command = BOOTSTRAP) =>
    installKey(checkout, commit, command, signal);
  const base = git(checkout, "rev-parse", "HEAD");
  const original = await key(base);
  assert.match(original, /^[0-9a-f]{64}$/);
  // Source, docs and tests leave it.
  const source = commit(checkout, {
    "src/index.js": "export const b = 1;\n",
    "README.md": "# target\n",
  });
  assert.equal(await key(source), original);
  // The command, and each kind of input, change it.
  assert.notEqual(await key(source, NPM_BOOTSTRAP), original);
  let previous = original;
  for (const files of [
    { "pnpm-lock.yaml": "left-pad@1.0.1\n" },
    {
      "package.json": `${JSON.stringify({ name: "target", version: "2.0.0" })}\n`,
    },
    { "packages/a/package.json": "{}\n" },
    { "pnpm-workspace.yaml": "packages: [packages/*]\n" },
    { ".npmrc": "registry=https://registry.example.com/\n" },
    { "package-lock.json": "{}\n" },
  ]) {
    const next = await key(commit(checkout, files));
    assert.notEqual(next, previous, JSON.stringify(files));
    previous = next;
  }
});

test("removing an item's worktree removes its kept store", async () => {
  const { checkout, base } = target();
  const worktree = join(tempDir("factory-items-"), "a");
  const signal = AbortSignal.timeout(30_000);
  await addWorktree(checkout, worktree, base, signal);
  await keptStore(`${worktree}.packages`, "a".repeat(64));
  writeFileSync(join(`${worktree}.packages`, "cache", "package"), "fetched");
  await removeWorktree(checkout, worktree, signal);
  assert.equal(existsSync(`${worktree}.packages`), false);
  assert.equal(existsSync(worktree), false);
});

test("a kept store is reused only under its own key", async () => {
  const directory = join(tempDir("factory-kept-"), "item.packages");
  const fresh = await keptStore(directory, "a".repeat(64));
  assert.deepEqual(fresh, { root: join(directory, "cache"), reused: false });
  writeFileSync(join(fresh.root, "package"), "fetched");
  assert.deepEqual(await keptStore(directory, "a".repeat(64)), {
    root: fresh.root,
    reused: true,
  });
  assert.ok(existsSync(join(fresh.root, "package")));
  // Another key empties it first.
  assert.deepEqual(await keptStore(directory, "b".repeat(64)), {
    root: fresh.root,
    reused: false,
  });
  assert.deepEqual(readdirSync(fresh.root), []);
  assert.equal(readFileSync(join(directory, "key"), "utf8"), "b".repeat(64));
  // A store whose cache is gone isn't reused, whatever its key says.
  rmSync(fresh.root, { recursive: true });
  assert.equal((await keptStore(directory, "b".repeat(64))).reused, false);
});

// A package from the checkout (a `file:` tarball) is served from the store
// by the lockfile's integrity, never read again: a result that changed
// only the vendored tarball installed the old package from a kept store,
// where an empty one fails the integrity check.
const VENDORED = {
  "package.json": `${JSON.stringify({
    name: "target",
    private: true,
    dependencies: { foo: "file:vendor/foo-1.0.0.tgz" },
  })}\n`,
  "pnpm-lock.yaml":
    "left-pad@1.0.0\nfoo@file:vendor/foo-1.0.0.tgz\n  resolution: {integrity: sha512-v1, tarball: file:vendor/foo-1.0.0.tgz}\n",
  "vendor/foo-1.0.0.tgz": "v1",
};

test("a vendored tarball the result changed alone keys the install anew", async () => {
  const { checkout } = target();
  const signal = AbortSignal.timeout(30_000);
  const key = (commit) => installKey(checkout, commit, BOOTSTRAP, signal);
  const vendored = commit(checkout, VENDORED);
  const original = await key(vendored);
  // The same tree keeps its key.
  assert.equal(await key(vendored), original);
  // The tarball's bytes changed, the manifest and lockfile left alone.
  const changed = commit(checkout, { "vendor/foo-1.0.0.tgz": "v2" });
  assert.notEqual(await key(changed), original);
  // With a local package, any file of the tree keys it: only the very same
  // tree reuses the store.
  const source = commit(checkout, { "src/index.js": "export const b = 1;\n" });
  assert.notEqual(await key(source), await key(changed));
  // Without one, the key still covers the dependency inputs alone.
  const { checkout: plain, base } = target();
  const edited = commit(plain, { "src/index.js": "export const c = 1;\n" });
  assert.equal(
    await installKey(plain, edited, BOOTSTRAP, signal),
    await installKey(plain, base, BOOTSTRAP, signal),
  );
});

test("a changed vendored tarball installs from an empty store", {
  skip,
}, async () => {
  const { checkout } = target();
  const base = commit(checkout, VENDORED);
  const built = commit(checkout, { "src/index.js": "export const a = 1;\n" });
  assert.equal(
    install(await validate(checkout, base, built)).installStore,
    "new",
  );
  assert.equal(
    install(await validate(checkout, base, built)).installStore,
    "reused",
  );
  const changed = commit(checkout, { "vendor/foo-1.0.0.tgz": "v2" });
  assert.deepEqual(
    { ...install(await validate(checkout, base, changed)), store: undefined },
    { installStore: "new", reused: 0, downloaded: 2, store: undefined },
  );
});

test("the kept store counts against the install's HOME budget, and one over it is not kept", {
  skip,
}, async () => {
  const { checkout } = target();
  // The base's own lockfile: the install's failure is the environment's.
  const base = commit(checkout, {
    "pnpm-lock.yaml": "left-pad@1.0.0\nbig@1.0.0\n",
  });
  const built = commit(checkout, { "src/index.js": "export const a = 1;\n" });
  const tight = sandboxConfig();
  tight.sandbox.limits = { ...tight.sandbox.limits, homeMiB: 1 };
  const { result } = await validate(checkout, base, built, { sandbox: tight });
  assert.equal(result.kind, "retry", JSON.stringify(result).slice(0, 1500));
  assert.match(
    result.reason,
    /Validation command failed \(disk budget\).*HOME and the install's package store hold 2\.0 MiB, more than sandbox\.limits\.homeMiB \(1 MiB\)/s,
  );
  assert.equal(existsSync(installStorePath(checkout)), false);
  // Within the budget, the next install starts from an empty store.
  assert.deepEqual(
    { ...install(await validate(checkout, base, built)), store: undefined },
    { installStore: "new", reused: 0, downloaded: 2, store: undefined },
  );
  // Files count too: the store's entries against sandbox.limits.files.
  const few = sandboxConfig();
  few.sandbox.limits = { ...few.sandbox.limits, files: 1 };
  rmSync(installStorePath(checkout), { recursive: true });
  const counted = await validate(checkout, base, built, { sandbox: few });
  assert.equal(counted.result.kind, "retry");
  assert.match(
    counted.result.reason,
    /HOME, the install's package store and TMPDIR hold more than sandbox\.limits\.files \(1\) files/,
  );
  assert.equal(existsSync(installStorePath(checkout)), false);
});

/** The step context and dependencies a Work Item's steps run with. */
function stepRun(config, state, events) {
  const log = new RunLog(
    config.inst.logs,
    "2026-01-01T00-00-00-000Z-1",
    CAPTURE_OFF,
    [],
  );
  const workDir = tempDir("factory-work-");
  return {
    workDir,
    deps: {
      config: { ...config.config, checkout: config.checkout },
      workDir: () => workDir,
      github: {},
    },
    context: {
      state,
      signal: AbortSignal.timeout(120_000),
      log: (event) => events.push(event),
      runFile: (kind) => log.runFile(1, `item:a:validate#1.${kind}`),
      // The validate step keeps its latest result (#2174); these tests
      // read only the install's events.
      keep: () => {},
    },
  };
}

const installEvents = (events) =>
  events
    .filter(
      (event) => event.event === "validation-command" && event.index === 0,
    )
    .map((event) => event.installStore);

test("the validate step reuses the store the worker's Validate filled beside the item's worktree", {
  skip,
}, async () => {
  const configured = sandboxConfig();
  const { checkout, base } = target();
  const work = item("a", {
    ownedPaths: ["src/**"],
    validation: [{ command: BOOTSTRAP }],
  });
  const accepted = plan([work], { base });
  const state = {
    issue: 7,
    done: { check: { shown: { blocks: [] } }, plan: accepted },
    kept: {},
  };
  const events = [];
  const { workDir, deps, context } = stepRun(
    { ...configured, checkout },
    state,
    events,
  );
  // The worker's worktree, where the work step put it, and its Validate.
  const worktree = worktreePath(workDir, state.issue, work.id);
  await addWorktree(checkout, worktree, base, context.signal);
  writeFileSync(join(worktree, "src/index.js"), "export const a = 1;\n");
  const validator = new SelfValidation(
    { ...context, worktree, item: work, base },
    {
      sandbox: configured.sandbox,
      plan: accepted,
      blocks: [],
      repository: REPO,
      commandTimeoutMs: 60_000,
    },
    context.signal,
  );
  const answer = await validator.call();
  assert.equal(answer.isError, false, answer.text);
  // The work step's collected result, then the validate step on it.
  const collected = commit(worktree, {});
  state.done["item:a:work"] = {
    base,
    commit: collected,
    tree: git(worktree, "rev-parse", "HEAD^{tree}"),
    notes: [],
    sets: [],
  };
  const outcome = await validateStep(work, context, deps, undefined);
  assert.equal(outcome.kind, "done", JSON.stringify(outcome).slice(0, 1500));
  assert.deepEqual(installEvents(events), ["new", "reused"]);
  assert.equal(
    readdirSync(join(installStorePath(worktree), "cache", "pnpm-store")).length,
    2,
  );
});

test("a QA item's validate step keeps its store beside the item's worktree, reused when it runs again", {
  skip,
}, async () => {
  const configured = sandboxConfig();
  // The default branch, served by a bare origin: QA checks its head.
  const root = tempDir("factory-qa-");
  const bare = join(root, "origin.git");
  git(root, "init", "--quiet", "--bare", "-b", "main", bare);
  git(root, "clone", "--quiet", bare, "checkout");
  const checkout = join(root, "checkout");
  const base = commit(checkout, BASE);
  git(checkout, "push", "--quiet", "origin", "HEAD:main");
  githubOrigin(checkout, bare);
  const qa = item("q", {
    kind: "qa",
    validation: [{ command: BOOTSTRAP }],
  });
  const state = {
    issue: 8,
    done: { check: { shown: { blocks: [] } }, plan: plan([qa], { base }) },
    kept: {},
  };
  const events = [];
  const { workDir, deps, context } = stepRun(
    { ...configured, checkout },
    state,
    events,
  );
  for (let run = 0; run < 2; run++) {
    const outcome = await qaValidateStep(qa, context, deps);
    assert.equal(outcome.kind, "done", JSON.stringify(outcome).slice(0, 1500));
  }
  assert.deepEqual(installEvents(events), ["new", "reused"]);
  const kept = installStorePath(worktreePath(workDir, state.issue, qa.id));
  assert.equal(readdirSync(join(kept, "cache", "pnpm-store")).length, 2);
});
