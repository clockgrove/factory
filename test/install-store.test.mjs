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
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../dist/config.js";
import { CAPTURE_OFF, RunLog } from "../dist/log.js";
import { sandboxAvailable } from "../dist/sandbox.js";
import { StoreClaims, sharedStore } from "../dist/shared-install-store.js";
import { installKey, keptStore, validateTree } from "../dist/validate.js";
import { SelfValidation } from "../dist/work/self-validate.js";
import { qaValidateStep, validateStep } from "../dist/work/steps.js";
import {
  addWorktree,
  installStorePath,
  removeWorktree,
  sharedInstallStorePath,
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
 * `commands`, the item's kept store beside the checkout (`store`, else
 * none) and the Objective's shared one (`shared`, else none). The events
 * validation logged come back.
 */
async function validate(
  checkout,
  base,
  built,
  {
    commands = [BOOTSTRAP],
    store = `${checkout}.packages`,
    shared,
    sandbox,
  } = {},
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
    ...(shared ? { sharedInstallStore: shared } : {}),
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
    ...(started.installStoreShared ? { shared: true } : {}),
    reused: Number(reused),
    downloaded: Number(downloaded),
    store: /^store (.*)$/m.exec(result.results[0].tail)?.[1],
  };
}

/** The cache of the one key's store an item keeps in `directory`. */
function keptRoot(directory) {
  const keys = readdirSync(directory).filter((entry) => entry !== "keys");
  assert.equal(keys.length, 1, keys.join(", "));
  return join(directory, keys[0], "cache");
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
    join(keptRoot(`${checkout}.packages`), "pnpm-store"),
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
  const store = join(keptRoot(`${checkout}.packages`), "pnpm-store");
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

test("an item whose installs alternate between two keys reuses both stores", {
  skip,
}, async () => {
  // A candidate whose dependency change left its lockfile out of date
  // installs under its own key, refused before fetching, then under
  // Factory's resolved commit's, on every validation, since the worker's
  // Validate never commits the resolved lockfile. With one store per item,
  // each emptied the other's and the resolved install fetched everything
  // every time (#2280).
  const { checkout, base } = target();
  const own = commit(checkout, { "pnpm-lock.yaml": "broken\n" });
  const resolved = commit(checkout, {
    "pnpm-lock.yaml": "left-pad@1.0.0\nis-number@7.0.0\nzod@4.0.0\n",
  });
  const refused = async () => {
    const { result, events } = await validate(checkout, base, own);
    assert.equal(result.kind, "failed", JSON.stringify(result).slice(0, 1500));
    return events.find((event) => event.event === "validation-command")
      .installStore;
  };
  const counts = async () => {
    const { installStore, reused, downloaded } = install(
      await validate(checkout, base, resolved),
    );
    return { installStore, reused, downloaded };
  };
  assert.equal(await refused(), "new");
  assert.deepEqual(await counts(), {
    installStore: "new",
    reused: 0,
    downloaded: 3,
  });
  assert.equal(await refused(), "reused");
  assert.deepEqual(await counts(), {
    installStore: "reused",
    reused: 3,
    downloaded: 0,
  });
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
    readdirSync(join(keptRoot(`${worktree}.packages`), "pnpm-store")).length,
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
  const key = await installKey(
    checkout,
    built,
    BOOTSTRAP,
    AbortSignal.timeout(30_000),
  );
  const poison = join(kept, key, "cache", "poison");
  // It can't write there, and no variable names the store.
  const later = `! sh -c 'echo poisoned > ${poison}' 2>/dev/null && ! printenv | grep -qF '${kept}'`;
  const { result } = await validate(checkout, base, built, {
    commands: [BOOTSTRAP, later],
  });
  assert.equal(result.kind, "passed", JSON.stringify(result).slice(0, 1500));
  assert.equal(result.results.length, 2);
  assert.equal(existsSync(poison), false);
  assert.equal(readdirSync(join(kept, key, "cache", "pnpm-store")).length, 2);
  // The keys sit outside what the install may write.
  assert.equal(readFileSync(join(kept, "keys"), "utf8"), `${key}\n`);
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
  const { root } = await keptStore(`${worktree}.packages`, "a".repeat(64));
  writeFileSync(join(root, "package"), "fetched");
  await removeWorktree(checkout, worktree, signal);
  assert.equal(existsSync(`${worktree}.packages`), false);
  assert.equal(existsSync(worktree), false);
});

test("a kept store is reused only under its own key, and an item keeps its two latest keys' stores", async () => {
  const directory = join(tempDir("factory-kept-"), "item.packages");
  const [a, b, c] = ["a", "b", "c"].map((digit) => digit.repeat(64));
  // A store of the layout before #2280, one `key` beside one `cache`.
  mkdirSync(join(directory, "cache"), { recursive: true });
  writeFileSync(join(directory, "key"), a);
  const fresh = await keptStore(directory, a);
  assert.deepEqual(fresh, {
    root: join(directory, a, "cache"),
    directory: join(directory, a),
    reused: false,
  });
  assert.deepEqual(readdirSync(directory).sort(), [a, "keys"]);
  writeFileSync(join(fresh.root, "package"), "fetched");
  assert.deepEqual(await keptStore(directory, a), { ...fresh, reused: true });
  assert.ok(existsSync(join(fresh.root, "package")));
  // Another key starts from an empty store of its own, and leaves the
  // first: a candidate and Factory's resolved lockfile alternate, and each
  // reuses its own.
  const other = await keptStore(directory, b);
  assert.equal(other.reused, false);
  assert.deepEqual(readdirSync(other.root), []);
  assert.ok(existsSync(join(fresh.root, "package")));
  assert.equal((await keptStore(directory, a)).reused, true);
  assert.equal((await keptStore(directory, b)).reused, true);
  assert.equal(readFileSync(join(directory, "keys"), "utf8"), `${b}\n${a}\n`);
  // A third key removes the store least recently installed.
  assert.equal((await keptStore(directory, c)).reused, false);
  assert.deepEqual(readdirSync(directory).sort(), [b, c, "keys"]);
  assert.equal((await keptStore(directory, a)).reused, false);
  assert.deepEqual(readdirSync(join(directory, a, "cache")), []);
  // A store whose cache is gone isn't reused, whatever the keys say.
  rmSync(join(directory, a, "cache"), { recursive: true });
  assert.equal((await keptStore(directory, a)).reused, false);
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

// clockgrove/factory#2280: every pnpm lockfile's settings name
// `excludeLinksFromLockfile: false`, which ends in "file:", so every pnpm
// install was keyed by the whole tree as a vendored package's is: the store
// was reused only on the very tree that filled it (5 of 21 installs, each
// the validate step after a passing Validate on that tree).
const PNPM_LOCK = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      left-pad:
        specifier: 1.0.0
        version: 1.0.0
      is-number:
        specifier: 7.0.0
        version: 7.0.0

packages:

  is-number@7.0.0:
    resolution: {integrity: sha512-a}

  left-pad@1.0.0:
    resolution: {integrity: sha512-b}
`;

test("a pnpm lockfile's own settings never key the install by the whole tree", async () => {
  const { checkout } = target();
  const signal = AbortSignal.timeout(30_000);
  const key = (commit) => installKey(checkout, commit, BOOTSTRAP, signal);
  const locked = commit(checkout, { "pnpm-lock.yaml": PNPM_LOCK });
  const original = await key(locked);
  // A source change, as each repair makes, keeps the key.
  const source = commit(checkout, { "src/index.js": "export const b = 1;\n" });
  assert.equal(await key(source), original);
  // `file:` as a protocol still keys by the tree, wherever it is named.
  for (const named of [
    "  foo@file:vendor/foo.tgz:\n",
    "    resolution: {tarball: file:vendor/foo.tgz}\n",
    "        specifier: 'file:vendor/foo'\n",
    "        version: git+file:vendor/foo\n",
  ]) {
    const local = commit(checkout, { "pnpm-lock.yaml": PNPM_LOCK + named });
    const edited = commit(checkout, {
      "src/index.js": `export const c = ${JSON.stringify(named)};\n`,
    });
    assert.notEqual(await key(edited), await key(local), named);
  }
});

test("two validations of one item in a row reuse its store across a source change", {
  skip,
}, async () => {
  const { checkout } = target();
  const base = commit(checkout, { "pnpm-lock.yaml": PNPM_LOCK });
  const built = commit(checkout, { "src/index.js": "export const a = 1;\n" });
  assert.deepEqual(
    { ...install(await validate(checkout, base, built)), store: undefined },
    { installStore: "new", reused: 0, downloaded: 2, store: undefined },
  );
  const repaired = commit(checkout, {
    "src/index.js": "export const a = 2;\n",
  });
  assert.deepEqual(
    { ...install(await validate(checkout, base, repaired)), store: undefined },
    { installStore: "reused", reused: 2, downloaded: 0, store: undefined },
  );
});

test("items whose install inputs are their start's share the Objective's store; a changed input keeps the item's own", {
  skip,
}, async () => {
  const { checkout } = target();
  const base = commit(checkout, { "pnpm-lock.yaml": PNPM_LOCK });
  const shared = join(tempDir("factory-objective-"), ".packages");
  const validateItem = (id, built) =>
    validate(checkout, base, built, {
      store: `${checkout}-${id}.packages`,
      shared,
    });
  const first = install(
    await validateItem("a", commit(checkout, { "src/a.js": "export {};\n" })),
  );
  assert.deepEqual(
    { ...first, store: undefined },
    {
      installStore: "new",
      shared: true,
      reused: 0,
      downloaded: 2,
      store: undefined,
    },
  );
  const key = await installKey(
    checkout,
    base,
    BOOTSTRAP,
    AbortSignal.timeout(30_000),
  );
  assert.equal(first.store, join(shared, key, "cache", "pnpm-store"));
  assert.equal(statSync(join(shared, key)).mode & 0o777, 0o700);
  // Another item's first validation fetches nothing, and keeps no store of
  // its own.
  assert.deepEqual(
    {
      ...install(
        await validateItem(
          "b",
          commit(checkout, { "src/b.js": "export {};\n" }),
        ),
      ),
      store: undefined,
    },
    {
      installStore: "reused",
      shared: true,
      reused: 2,
      downloaded: 0,
      store: undefined,
    },
  );
  assert.equal(existsSync(`${checkout}-b.packages`), false);
  // An item that changed the lockfile installs from its own store, and
  // leaves the shared one as it was.
  const moved = install(
    await validateItem(
      "c",
      commit(checkout, {
        "pnpm-lock.yaml": `${PNPM_LOCK}\n  zod@4.0.0:\n    resolution: {integrity: sha512-c}\n`,
      }),
    ),
  );
  assert.deepEqual(
    { ...moved, store: undefined },
    { installStore: "new", reused: 0, downloaded: 3, store: undefined },
  );
  assert.equal(
    moved.store,
    join(keptRoot(`${checkout}-c.packages`), "pnpm-store"),
  );
  assert.deepEqual(readdirSync(shared), [key]);
  assert.equal(readdirSync(join(shared, key, "cache", "pnpm-store")).length, 2);
});

test("installs of one key at once share one store, neither emptying the other's", async () => {
  const directory = join(tempDir("factory-objective-"), ".packages");
  const key = "c".repeat(64);
  const claims = new StoreClaims();
  after(() => claims[Symbol.dispose]());
  const made = await Promise.all([
    sharedStore(directory, key, claims),
    sharedStore(directory, key, claims),
  ]);
  assert.deepEqual(
    made.map((store) => store.root),
    [join(directory, key, "cache"), join(directory, key, "cache")],
  );
  assert.deepEqual(made.map((store) => store.reused).sort(), [false, true]);
  writeFileSync(join(made[0].root, "package"), "fetched");
  assert.equal((await sharedStore(directory, key, claims)).reused, true);
  assert.ok(existsSync(join(made[0].root, "package")));
  // Nothing half-made is left beside it.
  assert.deepEqual(readdirSync(directory), [key]);
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
  // The key's store is gone; only the list of keys stays.
  assert.deepEqual(readdirSync(installStorePath(checkout)), ["keys"]);
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
  assert.deepEqual(readdirSync(installStorePath(checkout)), ["keys"]);
});

/** The step context and dependencies a Work Item's steps run with. */
function stepRun(config, state, events, root = tempDir("factory-work-")) {
  const log = new RunLog(
    config.inst.logs,
    "2026-01-01T00-00-00-000Z-1",
    CAPTURE_OFF,
    [],
  );
  // The installation's work root, with an Objective's directory under it.
  const workDir = join(root, "work", String(state.issue));
  return {
    workDir,
    deps: {
      config: { ...config.config, checkout: config.checkout },
      workDir: (issue) => join(root, "work", String(issue)),
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

test("the validate step reuses the store the worker's Validate filled", {
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
  // The worker's worktree, where the work step put it, and its Validate
  // with the Objective's shared store, as the work step gives it.
  const worktree = worktreePath(workDir, state.issue, work.id);
  const shared = sharedInstallStorePath(workDir);
  await addWorktree(checkout, worktree, base, context.signal);
  writeFileSync(join(worktree, "src/index.js"), "export const a = 1;\n");
  const validator = new SelfValidation(
    { ...context, worktree, item: work, base, sharedInstallStore: shared },
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
  // Neither changed an install input, so both used the Objective's store.
  const [key] = readdirSync(shared);
  assert.equal(readdirSync(join(shared, key, "cache", "pnpm-store")).length, 2);
  assert.equal(existsSync(installStorePath(worktree)), false);
});

test("a second Objective's first install reuses the store the first Objective's install filled", {
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
  const events = [];
  const work = tempDir("factory-work-");
  const objectives = [];
  for (const issue of [8, 9]) {
    const state = {
      issue,
      done: { check: { shown: { blocks: [] } }, plan: plan([qa], { base }) },
      kept: {},
    };
    const { workDir, deps, context } = stepRun(
      { ...configured, checkout },
      state,
      events,
      work,
    );
    const outcome = await qaValidateStep(qa, context, deps);
    assert.equal(outcome.kind, "done", JSON.stringify(outcome).slice(0, 1500));
    objectives.push(workDir);
  }
  assert.deepEqual(installEvents(events), ["new", "reused"]);
  // The head's install inputs are the base's: the installation's store,
  // beside both Objectives' work directories.
  const [first, second] = objectives;
  assert.equal(sharedInstallStorePath(first), sharedInstallStorePath(second));
  const shared = sharedInstallStorePath(first);
  assert.equal(shared, join(work, "work", ".packages"));
  const [key] = readdirSync(shared);
  assert.equal(readdirSync(join(shared, key, "cache", "pnpm-store")).length, 2);
  for (const workDir of objectives)
    assert.equal(
      existsSync(installStorePath(worktreePath(workDir, 8, qa.id))),
      false,
    );
});

test("pruning removes keys by age and by total size, never one in use or used lately", async () => {
  const directory = join(tempDir("factory-installation-"), ".packages");
  const key = (letter) => letter.repeat(64);
  const DAY = 24 * 60 * 60 * 1000;
  // A key an install used `daysAgo`, and still holds when `held`.
  const made = async (letter, daysAgo, kibibytes = 1, held = false) => {
    const claims = new StoreClaims();
    const store = await sharedStore(directory, key(letter), claims);
    writeFileSync(join(store.root, "package"), Buffer.alloc(kibibytes * 1024));
    const used = new Date(Date.now() - daysAgo * DAY);
    utimesSync(store.directory, used, used);
    if (!held) claims[Symbol.dispose]();
    return claims;
  };
  const kept = () => readdirSync(directory).sort();
  const retention = { days: 7, mib: 1024 };
  // Old and in use, old and idle, old, and used a few minutes ago.
  const inUse = await made("a", 30, 1, true);
  await made("b", 30);
  await made("c", 10);
  await made("d", 0);
  const claims = new StoreClaims();
  await sharedStore(directory, key("e"), claims, retention);
  // The idle old ones go; the one in use and the recent one stay.
  assert.deepEqual(kept(), [key("a"), key("d"), key("e")]);
  // Once its install ends, the old one goes with the next new key.
  inUse[Symbol.dispose]();
  await sharedStore(directory, key("f"), claims, retention);
  assert.deepEqual(kept(), [key("d"), key("e"), key("f")]);
  // Over the size cap, the least recently used idle keys go first, until the rest fit.
  await made("1", 3, 700);
  await made("2", 2, 700);
  await made("3", 1, 700);
  await sharedStore(directory, key("4"), claims, { days: 7, mib: 1 });
  assert.deepEqual(kept(), [key("3"), key("4"), key("d"), key("e"), key("f")]);
  claims[Symbol.dispose]();
});
