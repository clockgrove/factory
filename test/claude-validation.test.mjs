import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { LocalContentStore } from "../dist/content/local.js";
import { createCodexHome } from "../dist/codex-planning-isolation.js";
import {
  factoryShellAuthorized,
  runSandboxedCommand,
} from "../dist/execution/claude-shell.js";
import { CodexHarness } from "../dist/execution/local.js";
import { copyOwnedFile } from "../dist/execution/claude-files.js";
import {
  checkWorkHandoff,
  runDeclaredValidation,
  workerFilesTree,
  workerValidationCommands,
} from "../dist/execution/claude-validation.js";
import {
  assertCommandSandboxConfig,
  commandSandboxAvailability,
  commandSandboxStatus,
  STRICT_COMMAND_SANDBOX,
  sandboxedCommand,
} from "../dist/execution/sandbox.js";
import { ClaudeAgentSdkHarness } from "../dist/execution/claude.js";
import {
  launchWorker,
  sandboxBubblewrap,
  workerSandboxRecords,
} from "../dist/execution/worker-process.js";
import { faultOf } from "../dist/fault.js";
import {
  linuxProcessIdentity,
  nativeProcessOwner,
  processGroupExists,
  stopRecordedSandboxes,
  subprocessAsync,
  UnsettledSubprocessError,
} from "../dist/process.js";
import { validateTree, validateWorkItem } from "../dist/validation.js";

const status = (worktree) =>
  execFileSync("git", ["-C", worktree, "status", "--porcelain"], {
    encoding: "utf8",
  });

// A host directory outside every temporary directory: the repository's
// ignored `.factory`.
const outsideTemporary = () => {
  const parent = new URL("../.factory/", import.meta.url).pathname;
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, "sandbox-"));
};

test("declared validation runs on a snapshot and leaves the worktree unchanged", async () => {
  const worktree = join(
    mkdtempSync(join(tmpdir(), "factory-worker-validation-")),
    "worktree",
  );
  execFileSync("git", ["init", "-q", worktree]);
  writeFileSync(join(worktree, "a.txt"), "original\n");
  // A dependency's selected LFS member: the tree holds only its pointer.
  const asset = Buffer.from("selected asset bytes\n");
  const member = {
    itemId: "dependency",
    setId: "set",
    role: "image",
    destination: "asset.bin",
    digest: createHash("sha256").update(asset).digest("hex"),
    bytes: asset.length,
    mediaType: "application/octet-stream",
  };
  writeFileSync(
    join(worktree, ".gitattributes"),
    "asset.bin filter=lfs diff=lfs merge=lfs -text\n",
  );
  writeFileSync(
    join(worktree, "asset.bin"),
    `version https://git-lfs.github.com/spec/v1\noid sha256:${member.digest}\nsize ${member.bytes}\n`,
  );
  execFileSync("git", [
    "-C",
    worktree,
    "add",
    "a.txt",
    ".gitattributes",
    "asset.bin",
  ]);
  execFileSync("git", [
    "-C",
    worktree,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-qm",
    "base",
  ]);
  writeFileSync(join(worktree, "a.txt"), "changed\n");
  writeFileSync(join(worktree, "new.txt"), "new\n");
  // Private staging stays out of the snapshot, as it does in collection.
  mkdirSync(join(worktree, ".factory-inputs"));
  writeFileSync(join(worktree, ".factory-inputs", "source-0"), "private\n");
  writeFileSync(join(worktree, ".factory-handoff.json"), "{}\n");
  const before = status(worktree);
  const passed = await runDeclaredValidation(
    worktree,
    [
      "grep -q changed a.txt",
      "test -f new.txt",
      "test ! -e .factory-inputs",
      "test ! -e .factory-handoff.json",
      // Each run gets its own empty TMPDIR, as a capture run does.
      'case "$TMPDIR" in */factory-validation-*) test -z "$(ls -A "$TMPDIR")" ;; *) exit 1 ;; esac',
    ],
    1,
  );
  assert.equal(passed.passed, true, passed.text);
  assert.equal(passed.tree, await workerFilesTree(worktree));
  const failed = await runDeclaredValidation(
    worktree,
    ["echo marker-output; exit 3"],
    2,
  );
  assert.equal(failed.passed, false);
  assert.match(failed.text, /marker-output/);
  // The controller-staged member's bytes are restored by digest, as
  // controller validation restores them; without them the pointer remains.
  const store = join(dirname(worktree), "staged-lfs");
  new LocalContentStore(store).putBytes(asset, member);
  const restore = ["grep -qx 'selected asset bytes' asset.bin"];
  const restored = await runDeclaredValidation(worktree, restore, 3, {
    members: [member],
    store,
  });
  assert.equal(restored.passed, true, restored.text);
  assert.equal(
    (await runDeclaredValidation(worktree, restore, 4)).passed,
    false,
  );
  assert.equal(status(worktree), before);
  // An edit after the passing run leaves the final files unvalidated.
  writeFileSync(join(worktree, "new.txt"), "edited\n");
  assert.notEqual(await workerFilesTree(worktree), passed.tree);
  assert.equal(readFileSync(join(worktree, "a.txt"), "utf8"), "changed\n");
  assert.equal(existsSync(`${worktree}.validation/1`), false);
  // Validation decodes the handoff as collection will and names what is wrong.
  const handoff = { peers: [], acceptance: ["a.txt holds the change"] };
  writeFileSync(
    join(worktree, ".factory-handoff.json"),
    JSON.stringify({
      summary: "done",
      notes: [{ kind: "verification", criterionIndex: 0, text: "a.txt:1" }],
    }),
  );
  const rejected = checkWorkHandoff(worktree, handoff);
  assert.equal(rejected.passed, false);
  assert.match(rejected.text, /unexpected top-level key "summary"/);
  assert.match(
    rejected.text,
    /note 0: unexpected key "text"; missing key summary, paths, consumerIndices\n/,
  );
  writeFileSync(
    join(worktree, ".factory-handoff.json"),
    JSON.stringify({
      notes: [
        {
          kind: "verification",
          criterionIndex: 0,
          summary: "changed: a.txt:1",
          paths: ["a.txt"],
          consumerIndices: [],
        },
      ],
    }),
  );
  const decoded = checkWorkHandoff(worktree, handoff);
  assert.equal(decoded.passed, true);
  // Self-review sees the exact criterion beside the note for its index.
  assert.match(
    decoded.criteria,
    /\n\[0\] a\.txt holds the change\nnote \[0\]: changed: a\.txt:1$/,
  );
  // Ignored files a run produces under owned paths come back to the checkout;
  // tracked changes, ignored directories and unowned files do not.
  writeFileSync(join(worktree, ".gitignore"), "*.actual.json\ncache/\n");
  const produce = (value) =>
    `mkdir -p own/cache other && printf ${value} > own/x.actual.json && printf c > own/cache/c.json && printf o > other/o.actual.json && printf t > a.txt && exit 1`;
  const outputs = {
    ownedPaths: ["own/", "a.txt"],
    excluded: new Set(),
  };
  const tracked = status(worktree);
  const first = await runDeclaredValidation(
    worktree,
    [produce("one")],
    5,
    undefined,
    outputs,
  );
  assert.equal(first.passed, false);
  assert.equal(
    readFileSync(join(worktree, "own/x.actual.json"), "utf8"),
    "one",
  );
  assert.match(first.text, /\n- own\/x\.actual\.json \(3 bytes\)\n/);
  assert.match(
    first.text,
    /not returned because Git tracks them[^\n]*\n- a\.txt\n/,
  );
  assert.match(
    first.text,
    /Ignored directories, contents not returned:\n- own\/cache\/$/m,
  );
  assert.equal(existsSync(join(worktree, "own/cache")), false);
  assert.equal(existsSync(join(worktree, "other")), false);
  assert.equal(readFileSync(join(worktree, "a.txt"), "utf8"), "changed\n");
  assert.equal(status(worktree), tracked);
  // Each run replaces the copy it produced, including a continuation's stale one.
  writeFileSync(join(worktree, "own/x.actual.json"), "stale");
  const replaced = await runDeclaredValidation(
    worktree,
    [produce("two")],
    6,
    undefined,
    outputs,
  );
  assert.equal(
    readFileSync(join(worktree, "own/x.actual.json"), "utf8"),
    "two",
  );
  assert.match(
    replaced.text,
    /\n- own\/x\.actual\.json \(3 bytes, replaced the earlier copy\)\n/,
  );
  assert.equal(status(worktree), tracked);
  // Without a shell, the worker commits a returned file with copy_file: the
  // exact bytes of a long single line, never passed through the model.
  const golden = Buffer.from(`{"v":"${"x".repeat(1_500_000)}"}`);
  writeFileSync(join(worktree, "own/big.actual.json"), golden);
  const sha256 = createHash("sha256").update(golden).digest("hex");
  assert.deepEqual(
    copyOwnedFile(
      worktree,
      outputs.ownedPaths,
      "own/big.actual.json",
      "own/goldens/big.json",
    ),
    {
      from: "own/big.actual.json",
      to: "own/goldens/big.json",
      bytes: golden.length,
      sha256,
    },
  );
  assert.deepEqual(
    readFileSync(join(worktree, "own/goldens/big.json")),
    golden,
  );
  assert.match(status(worktree), /^\?\? own\/$/m);
  // A copy replaces an owned file in place and reaches tracked sources too.
  copyOwnedFile(worktree, outputs.ownedPaths, "own/x.actual.json", "a.txt");
  assert.equal(readFileSync(join(worktree, "a.txt"), "utf8"), "two");
  writeFileSync(join(worktree, "a.txt"), "changed\n");
  // Unowned or escaping destinations, Git metadata, links on either side
  // and oversized sources are refused, and nothing is written.
  const refused = (from, to, message) =>
    assert.throws(
      () => copyOwnedFile(worktree, outputs.ownedPaths, from, to),
      message,
    );
  refused("own/x.actual.json", "new.txt", /new\.txt is not owned/);
  refused("own/x.actual.json", "own/../new.txt", /normalized path/);
  refused("own/x.actual.json", `${dirname(worktree)}/out`, /outside/);
  refused("own/x.actual.json", "own/.git/config", /Git metadata/);
  symlinkSync("../new.txt", join(worktree, "own/link.json"));
  refused(
    "own/link.json",
    "own/y.json",
    /own\/link\.json is not a regular file/,
  );
  refused("own/x.actual.json", "own/link.json", /own\/link\.json exists/);
  linkSync(join(worktree, "new.txt"), join(worktree, "own/hard.json"));
  refused("own/x.actual.json", "own/hard.json", /hard link/);
  symlinkSync("..", join(worktree, "own/up"));
  refused("own/up/new.txt", "own/y.json", /real directories/);
  refused("own/x.actual.json", "own/up/a.txt", /real directories/);
  truncateSync(join(worktree, "own/big.actual.json"), 16 * 1024 * 1024 + 1);
  refused("own/big.actual.json", "own/y.json", /over the 16 MiB copy bound/);
  assert.equal(existsSync(join(worktree, "own/y.json")), false);
  assert.equal(readFileSync(join(worktree, "new.txt"), "utf8"), "edited\n");
  assert.equal(readFileSync(join(worktree, "a.txt"), "utf8"), "changed\n");
  rmSync(dirname(worktree), { recursive: true, force: true });
});

test("declared commands run in an OS sandbox that hides the host and keeps loopback", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "factory-command-sandbox-"));
  const worktree = join(root, "worktree");
  execFileSync("git", ["init", "-q", worktree]);
  writeFileSync(join(worktree, "a.txt"), "base\n");
  // A dependency-free npm project, so the exact install runs offline.
  const manifest = { name: "sandboxed", version: "1.0.0" };
  writeFileSync(join(worktree, "package.json"), JSON.stringify(manifest));
  writeFileSync(
    join(worktree, "package-lock.json"),
    JSON.stringify({
      ...manifest,
      lockfileVersion: 3,
      requires: true,
      packages: { "": manifest },
    }),
  );
  execFileSync("git", [
    "-C",
    worktree,
    "add",
    "a.txt",
    "package.json",
    "package-lock.json",
  ]);
  execFileSync("git", [
    "-C",
    worktree,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-qm",
    "base",
  ]);
  // Host secrets a hostile test script would look for, and a host directory
  // outside the checkout it would try to write.
  const home = process.env.HOME;
  const secrets = [
    join(home, ".claude", ".credentials.json"),
    join(home, ".ssh", "id_ed25519"),
    join(home, ".config", "gh", "hosts.yml"),
    join(process.env.XDG_STATE_HOME, "clockgrove-factory", "state.json"),
  ];
  for (const path of secrets) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "secret\n");
  }
  const outside = join(root, "outside");
  mkdirSync(outside);
  // A package store lies outside the shared temporary directories.
  const stores = outsideTemporary();
  t.after(() => rmSync(stores, { recursive: true, force: true }));
  const store = join(stores, "package-store");
  const quote = (path) => `'${path}'`;
  const policy = {
    required: true,
    network: "package-install",
    packageStore: store,
    readOnlyPaths: [],
  };
  const result = await runDeclaredValidation(
    worktree,
    [
      // The verified install, run first, may write the shared store.
      "npm ci --ignore-scripts",
      // Each escape must fail inside the sandbox, so each command passes.
      ...secrets.map((path) => `! cat ${quote(path)}`),
      `! ls ${quote(home)}`,
      `! ls ${quote(join(process.env.XDG_STATE_HOME, "clockgrove-factory"))}`,
      `! touch ${quote(join(outside, "escape"))}`,
      // The checkout's .git cannot be repointed.
      "! sh -c 'echo gitdir: /tmp >> .git'",
      // No host process is visible or signalable.
      `! kill -0 ${process.pid}`,
      // Only loopback: no route off the host, even for a command the
      // package-install policy does not name.
      `test "$(tail -n +3 /proc/net/dev | cut -d: -f1 | tr -d ' ')" = lo`,
      // A private, writable HOME; the shared package store is read-only to
      // every command but the install.
      `test "$HOME" != ${quote(home)} && touch "$HOME/ok"`,
      'test -d "$npm_config_cache" && ! touch "$npm_config_cache/marker"',
      // Normal work: read the checkout, write ignored files, serve loopback.
      "grep -qx base a.txt && git status --porcelain >/dev/null",
      `node -e 'const s=require("net").createServer(c=>c.end("ok")).listen(0,"127.0.0.1",()=>require("net").connect(s.address().port,"127.0.0.1").on("data",d=>{s.close();process.exit(String(d)==="ok"?0:1)}))'`,
    ],
    1,
    undefined,
    undefined,
    policy,
    { sourceDeclared: ["npm ci --ignore-scripts"] },
  );
  assert.equal(result.passed, true, result.text);
  assert.equal(existsSync(join(outside, "escape")), false);
  assert.equal(existsSync(join(store, "npm", "marker")), false);
  const logs = () => readdirSync(join(store, "npm", "_logs")).length;
  const written = logs();
  assert.ok(written > 0);
  // A candidate that changes package-manager configuration loses that: its
  // install neither writes the store nor reaches the network.
  writeFileSync(join(worktree, ".npmrc"), "registry=http://127.0.0.1:9/\n");
  await runDeclaredValidation(
    worktree,
    ["npm ci --ignore-scripts"],
    3,
    undefined,
    undefined,
    policy,
    { sourceDeclared: ["npm ci --ignore-scripts"] },
  );
  assert.equal(logs(), written);
  for (const path of secrets)
    assert.equal(readFileSync(path, "utf8"), "secret\n");
  // A command that does reach a host secret fails the run.
  const leaked = await runDeclaredValidation(
    worktree,
    [`cat ${quote(secrets[0])}`],
    2,
  );
  assert.equal(leaked.passed, false);
  assert.doesNotMatch(leaked.text, /secret/);
});

test("host-side Git never enters a nested repository sandboxed code could write", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-nested-git-"));
  const marker = join(root, "ran-outside-the-sandbox");
  const git = (cwd, ...args) =>
    execFileSync(
      "git",
      [
        "-C",
        cwd,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        ...args,
      ],
      { encoding: "utf8" },
    );
  // A nested repository whose clean filter runs a program: host-side Git
  // runs it once a gitlink in the index makes it recurse.
  const plant = (directory) =>
    [
      `mkdir -p '${directory}'`,
      `cd '${directory}'`,
      "git init -q",
      "echo '* filter=evil' > .gitattributes && echo data > f",
      "git add . && git -c user.name=t -c user.email=t@e commit -qm n",
      `git config filter.evil.clean "sh -c 'touch ${marker}; cat'"`,
      "touch -d '2000-01-01' f",
    ].join(" && ");
  const repository = (name) => {
    const path = join(root, name);
    execFileSync("git", ["init", "-q", path]);
    writeFileSync(join(path, "a.txt"), "base\n");
    git(path, "add", "a.txt");
    git(path, "commit", "-qm", "base");
    return path;
  };
  // Route 1: a worker's embedded repository would become a gitlink in the
  // Validate snapshot; the snapshot is refused before Git stages it.
  const first = repository("embedded");
  execFileSync("sh", ["-c", plant(join(first, "x"))]);
  const embedded = await runDeclaredValidation(first, ["true"], 1).catch(
    (error) => error,
  );
  assert.match(String(embedded.message ?? embedded.text), /nested Git entry/);
  assert.equal(existsSync(marker), false);
  rmSync(join(first, "x"), { recursive: true, force: true });
  // A validation command that plants one in its checkout leaves no gitlink:
  // host-side status after it never enters the repository.
  const planted = await runDeclaredValidation(
    first,
    [plant("y"), "git status --porcelain >/dev/null"],
    2,
  );
  assert.equal(planted.passed, false);
  assert.match(planted.text, /modified the result tree/);
  assert.equal(existsSync(marker), false);
  // Route 2: a base with a submodule gitlink gets no Validate, a worker's
  // repository behind it is refused before Git stages, and no tree with a
  // gitlink is validated.
  const second = repository("submodule");
  git(
    second,
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${git(second, "rev-parse", "HEAD").trim()},sub`,
  );
  git(second, "commit", "-qm", "submodule");
  assert.deepEqual(
    workerValidationCommands({
      config: { tools: ["Validate"], allowedTools: ["Validate"] },
      request: {
        worktree: second,
        item: { validation: [{ command: "true" }] },
      },
    }),
    [],
  );
  execFileSync("sh", ["-c", plant(join(second, "sub"))]);
  const behindGitlink = await runDeclaredValidation(second, ["true"], 3).catch(
    (error) => error,
  );
  assert.match(
    String(behindGitlink.message ?? behindGitlink.text),
    /nested Git entry/,
  );
  assert.equal(existsSync(marker), false);
  rmSync(join(second, "sub"), { recursive: true, force: true });
  await assert.rejects(
    validateTree(
      second,
      join(root, "validation"),
      git(second, "rev-parse", "HEAD").trim(),
      git(second, "rev-parse", "HEAD^{tree}").trim(),
      ["true"],
    ),
    /submodule gitlinks/,
  );
  assert.equal(existsSync(marker), false);
  // Nor does it hash more than collection could retain into the shared
  // object store: a sparse file counts at its apparent size.
  const bounded = repository("bounded");
  const objects = () => git(bounded, "count-objects", "-v");
  const stored = objects();
  const bounds = { maxBytes: 1024 * 1024, maxFiles: 2 };
  truncateSync(join(bounded, "a.txt"), 2 * 1024 ** 3);
  await assert.rejects(
    workerFilesTree(bounded, bounds),
    /Worker snapshot exceeds the admitted byte bound/,
  );
  git(bounded, "checkout", "--", "a.txt");
  for (const name of ["b", "c", "d"]) writeFileSync(join(bounded, name), name);
  await assert.rejects(
    workerFilesTree(bounded, bounds),
    /Worker snapshot exceeds the admitted file bound/,
  );
  for (const name of ["b", "c", "d"]) rmSync(join(bounded, name));
  // A name that is not UTF-8 cannot pass as another path lstat misses.
  const raw = Buffer.concat([Buffer.from(`${bounded}/`), Buffer.from([0xff])]);
  writeFileSync(raw, "");
  truncateSync(raw, 50 * 1024 * 1024);
  await assert.rejects(
    workerFilesTree(bounded, bounds),
    /Worker snapshot has an unsafe path/,
  );
  rmSync(raw);
  // Without admitted checkpoint bounds the default ones apply: 2 GiB.
  truncateSync(join(bounded, "a.txt"), 2 * 1024 ** 3 + 1);
  await assert.rejects(
    workerFilesTree(bounded),
    /Worker snapshot exceeds the admitted byte bound: 2147483649 bytes, at most 2147483648/,
  );
  git(bounded, "checkout", "--", "a.txt");
  // sandbox.limits sets them without checkpoint bounds.
  truncateSync(join(bounded, "a.txt"), 17 * 1024 ** 2);
  await assert.rejects(
    runDeclaredValidation(bounded, ["true"], 9, undefined, undefined, {
      ...STRICT_COMMAND_SANDBOX,
      limits: { ...STRICT_COMMAND_SANDBOX.limits, candidateMiB: 16 },
    }),
    /Worker snapshot exceeds the admitted byte bound: 17825792 bytes, at most 16777216/,
  );
  git(bounded, "checkout", "--", "a.txt");
  assert.equal(objects(), stored);
  // The candidate's own attributes decide nothing: a file Git LFS's
  // filter would take still lands on disk, so it counts.
  writeFileSync(
    join(bounded, ".gitattributes"),
    "*.bin filter=lfs diff=lfs merge=lfs -text\n",
  );
  git(bounded, "config", "filter.lfs.clean", "git-lfs clean -- %f");
  git(bounded, "config", "filter.lfs.process", "git-lfs filter-process");
  writeFileSync(join(bounded, "media.bin"), Buffer.alloc(2 * 1024 ** 2, 1));
  await assert.rejects(
    workerFilesTree(bounded, bounds),
    /Worker snapshot exceeds the admitted byte bound: \d+ bytes/,
  );
  rmSync(join(bounded, "media.bin"));
  rmSync(join(bounded, ".gitattributes"));
  // Preallocated blocks beyond a file's size count.
  if (existsSync("/usr/bin/fallocate")) {
    writeFileSync(join(bounded, "reserved"), "");
    execFileSync("fallocate", [
      "--keep-size",
      "-l",
      "2M",
      join(bounded, "reserved"),
    ]);
    await assert.rejects(
      workerFilesTree(bounded, bounds),
      /Worker snapshot exceeds the admitted byte bound: 2097152 bytes/,
    );
    rmSync(join(bounded, "reserved"));
  }
  // A directory the worker made unreadable is its fault, found before
  // host-side Git reads the checkout. Root reads it anyway.
  if (process.getuid() !== 0) {
    mkdirSync(join(bounded, "locked"));
    chmodSync(join(bounded, "locked"), 0);
    await assert.rejects(
      workerFilesTree(bounded),
      /Worker left an unreadable path: locked/,
    );
    chmodSync(join(bounded, "locked"), 0o755);
  }
});

test("a verified install reaches only its configured registry, and commands are resource-limited", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "factory-install-network-"));
  const stores = outsideTemporary();
  t.after(() => rmSync(stores, { recursive: true, force: true }));
  // Real dependency tarballs served on host loopback, standing in for the
  // configured registry: only an install in the host's network reaches it.
  const tarballs = {};
  for (const name of ["dep", "added", "foreign", "merged"]) {
    const pack = join(root, "pack", name);
    mkdirSync(join(pack, "package"), { recursive: true });
    writeFileSync(
      join(pack, "package", "package.json"),
      JSON.stringify({ name, version: "1.0.0" }),
    );
    execFileSync("tar", ["-czf", join(pack, "p.tgz"), "-C", pack, "package"]);
    tarballs[name] = readFileSync(join(pack, "p.tgz"));
  }
  const requests = [];
  // npm also asks the registry for audits and its own version.
  const fetched = () => requests.filter((url) => url.includes(".tgz"));
  const server = createServer((request, response) => {
    requests.push(request.url);
    const name = request.url.split("/")[1];
    response.end(tarballs[name] ?? "");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const registry = `http://127.0.0.1:${server.address().port}/`;
    const integrity = (bytes) =>
      `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    const write = (worktree, dependencies) => {
      const manifest = {
        name: "installing",
        version: "1.0.0",
        dependencies: Object.fromEntries(
          Object.keys(dependencies).map((name) => [name, "1.0.0"]),
        ),
      };
      writeFileSync(join(worktree, "package.json"), JSON.stringify(manifest));
      writeFileSync(
        join(worktree, "package-lock.json"),
        JSON.stringify({
          name: "installing",
          version: "1.0.0",
          lockfileVersion: 3,
          requires: true,
          packages: {
            "": manifest,
            ...Object.fromEntries(
              Object.entries(dependencies).map(([name, resolved]) => [
                `node_modules/${name}`,
                {
                  version: "1.0.0",
                  resolved,
                  integrity: integrity(tarballs[name]),
                },
              ]),
            ),
          },
        }),
      );
    };
    const worktree = join(root, "worktree");
    execFileSync("git", ["init", "-q", worktree]);
    const commit = (message) => {
      execFileSync("git", ["-C", worktree, "add", "."]);
      execFileSync("git", [
        "-C",
        worktree,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-qm",
        message,
      ]);
      const read = (revision) =>
        execFileSync("git", ["-C", worktree, "rev-parse", revision], {
          encoding: "utf8",
        }).trim();
      return { commit: read("HEAD"), tree: read("HEAD^{tree}") };
    };
    // The base configures the registry; its lockfile resolves there.
    // No fetch retries, so an offline install fails at once.
    writeFileSync(
      join(worktree, ".npmrc"),
      `registry=${registry}\nfetch-retries=0\n`,
    );
    writeFileSync(join(worktree, ".gitignore"), "node_modules/\n");
    write(worktree, { dep: `${registry}dep/-/dep-1.0.0.tgz` });
    const base = commit("base");
    const install = "npm ci --ignore-scripts";
    const sandbox = {
      required: true,
      network: "package-install",
      packageStore: join(stores, "store"),
      readOnlyPaths: [],
      limits: { tmpMiB: 64, processes: 512 },
    };
    // The caller that verified these package inputs passes the base, as
    // validateWorkItem, final validation and readiness do.
    const validate = (target, number, commands = [install]) =>
      validateTree(
        worktree,
        join(root, `validation-${number}`),
        target.commit,
        target.tree,
        commands,
        undefined,
        undefined,
        [],
        undefined,
        base.commit,
        false,
        undefined,
        undefined,
        undefined,
        {
          ...sandbox,
          packageInputsVerified: true,
          packageInputsBase: base.commit,
        },
      );
    const limited = [
      `test "$(awk '/Max processes/{print $3}' /proc/self/limits)" = 512`,
      ...(commandSandboxAvailability().tmpfsSize
        ? [`test "$(df -k /tmp | awk 'NR==2{print $2}')" = 65536`]
        : []),
    ];
    // The base lockfile: the install fetches from the registry.
    await validate(base, 1, [install, ...limited]);
    assert.deepEqual(fetched(), ["/dep/-/dep-1.0.0.tgz"]);
    // A candidate adding a dependency from the configured registry still
    // reaches it.
    write(worktree, {
      dep: `${registry}dep/-/dep-1.0.0.tgz`,
      added: `${registry}added/-/added-1.0.0.tgz`,
    });
    await validate(commit("add a registry dependency"), 2);
    assert.deepEqual(fetched(), [
      "/dep/-/dep-1.0.0.tgz",
      "/added/-/added-1.0.0.tgz",
    ]);
    // One naming a tarball on another host installs offline: no request
    // leaves, and the install fails where it connects (npm retries).
    write(worktree, {
      dep: `${registry}dep/-/dep-1.0.0.tgz`,
      foreign: `http://localhost:${server.address().port}/foreign/x.tgz?repository-contents`,
    });
    const before = requests.length;
    await assert.rejects(
      validate(commit("add a foreign tarball"), 3),
      /ECONNREFUSED/,
    );
    assert.equal(requests.length, before);
    // A pnpm lockfile hiding a foreign tarball behind a YAML merge key (which
    // pnpm's reader applies and YAML 1.2 does not) keeps the install offline,
    // although the npm lockfile alone would be allowed.
    write(worktree, {
      dep: `${registry}dep/-/dep-1.0.0.tgz`,
      merged: `${registry}merged/-/merged-1.0.0.tgz`,
    });
    writeFileSync(
      join(worktree, "pnpm-lock.yaml"),
      [
        "lockfileVersion: '9.0'",
        "packages:",
        "  merged@1.0.0:",
        "    resolution:",
        `      integrity: ${integrity(tarballs.merged)}`,
        `      <<: {tarball: 'http://localhost:${server.address().port}/merged/x.tgz'}`,
        "",
      ].join("\n"),
    );
    await assert.rejects(
      validate(commit("hide a tarball behind a merge key"), 4),
      /ECONNREFUSED/,
    );
    assert.equal(requests.length, before);
    // An accepted base without package configuration, and a predecessor
    // Work Item's unaccepted output that adds its own registry. A dependent
    // item that keeps it passes the package-input check, but installs
    // offline even with nothing stored: the network grant compares with the
    // accepted base.
    rmSync(join(worktree, "pnpm-lock.yaml"));
    rmSync(join(worktree, ".npmrc"));
    write(worktree, { dep: `${registry}dep/-/dep-1.0.0.tgz` });
    const accepted = commit("accepted base without configuration");
    writeFileSync(
      join(worktree, ".npmrc"),
      `registry=http://localhost:${server.address().port}/\nfetch-retries=0\n`,
    );
    const predecessor = commit("name a registry");
    writeFileSync(join(worktree, "a.txt"), "dependent\n");
    const dependent = commit("dependent item");
    await assert.rejects(
      validateWorkItem(
        worktree,
        join(root, "validation-5"),
        {
          kind: "work",
          ownedPaths: ["a.txt"],
          validation: [{ command: install, provenance: "source-declared" }],
        },
        dependent.commit,
        dependent.tree,
        accepted.commit,
        undefined,
        undefined,
        predecessor.commit,
        [],
        undefined,
        [],
        undefined,
        false,
        [],
        { ...sandbox, packageStore: join(stores, "empty-store") },
      ),
      /ECONNREFUSED/,
    );
    assert.equal(requests.length, before);
  } finally {
    server.close();
  }
});

test("a run's HOME, TMPDIR and checkout growth stay within the sandbox's disk budget", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "factory-disk-budget-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const worktree = join(root, "worktree");
  execFileSync("git", ["init", "-q", worktree]);
  writeFileSync(join(worktree, ".gitignore"), "out/\n");
  // A dependency-free npm project, so the exact install runs offline.
  const manifest = { name: "budgeted", version: "1.0.0" };
  writeFileSync(join(worktree, "package.json"), JSON.stringify(manifest));
  writeFileSync(
    join(worktree, "package-lock.json"),
    JSON.stringify({
      ...manifest,
      lockfileVersion: 3,
      requires: true,
      packages: { "": manifest },
    }),
  );
  // The repository's own files are not growth: 24 MiB, over every limit.
  writeFileSync(join(worktree, "data.bin"), Buffer.alloc(24 * 1024 ** 2));
  execFileSync("git", ["-C", worktree, "add", "."]);
  execFileSync("git", [
    "-C",
    worktree,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-qm",
    "base",
  ]);
  const read = (revision) =>
    execFileSync("git", ["-C", worktree, "rev-parse", revision], {
      encoding: "utf8",
    }).trim();
  const sandbox = {
    ...STRICT_COMMAND_SANDBOX,
    limits: {
      ...STRICT_COMMAND_SANDBOX.limits,
      tmpMiB: 16,
      homeMiB: 16,
      checkoutMiB: 16,
      files: 1024,
    },
  };
  let runs = 0;
  const validate = (commands, policy = sandbox) =>
    validateTree(
      worktree,
      join(root, `validation-${++runs}`),
      read("HEAD"),
      read("HEAD^{tree}"),
      commands,
      undefined,
      undefined,
      [],
      undefined,
      read("HEAD"),
      false,
      undefined,
      undefined,
      undefined,
      policy,
    );
  const write = (path, mebibytes) =>
    `head -c ${mebibytes * 1024 * 1024} /dev/zero > ${path}`;
  // Within the budget: HOME, TMPDIR and the checkout's ignored output.
  const passed = await validate([
    write('"$HOME/cache"', 12),
    write('"$TMPDIR/scratch"', 12),
    `mkdir out && ${write("out/build", 12)}`,
    "test -s data.bin",
  ]);
  assert.equal(passed.commands.length, 4);
  // Past it the command failed, a candidate's work fault naming the limit.
  // HOME, TMPDIR and the checkout last the run, so commands add up.
  for (const [commands, over] of [
    [
      [write('"$HOME/a"', 9), write('"$HOME/b"', 9)],
      /HOME holds 18\.0 MiB, more than sandbox\.limits\.homeMiB \(16 MiB\)/,
    ],
    [
      [write('"$TMPDIR/a"', 17)],
      /TMPDIR holds 17\.0 MiB, more than sandbox\.limits\.tmpMiB \(16 MiB\)/,
    ],
    [
      ["mkdir out", write("out/a", 9), write("out/b", 9)],
      /the checkout grew by 18\.0 MiB, more than sandbox\.limits\.checkoutMiB \(16 MiB\)/,
    ],
    [
      ["mkdir out && cd out && seq 1 1100 | xargs touch"],
      /checkout growth, HOME and TMPDIR hold more than sandbox\.limits\.files \(1024\) files/,
    ],
    // Preallocated blocks beyond a file's size count too.
    ...(existsSync("/usr/bin/fallocate")
      ? [
          [
            ["mkdir out && : > out/a && fallocate --keep-size -l 17M out/a"],
            /the checkout grew by 17\.0 MiB/,
          ],
        ]
      : []),
  ]) {
    const failure = await validate(commands).catch((error) => error);
    assert.match(
      String(failure.message),
      /^Validation command failed \(disk budget\): .*: the sandbox disk budget is exceeded: /,
    );
    assert.match(String(failure.message), over);
    assert.equal(faultOf(failure)?.kind, "work");
  }
  // The verified install on the accepted base's package inputs, run first
  // with an empty HOME, is the environment's, as when it fails (#839): it
  // repeats, charging no repair. (A policy that lets HOME hold nothing.)
  const empty = {
    ...sandbox,
    limits: { ...sandbox.limits, homeMiB: 0 },
  };
  const install = await validate(["npm ci --ignore-scripts"], {
    ...empty,
    packageInputsVerified: true,
  }).catch((error) => error);
  assert.match(
    String(install.message),
    /^Validation command failed \(disk budget\): npm ci --ignore-scripts: the sandbox disk budget is exceeded: HOME holds/,
  );
  assert.equal(faultOf(install)?.kind, "transient");
  // The same install after other commands, or unverified, is the candidate's.
  const later = await validate(["true", "npm ci --ignore-scripts"], {
    ...empty,
    packageInputsVerified: true,
  }).catch((error) => error);
  assert.match(String(later.message), /disk budget.*HOME holds/);
  assert.equal(faultOf(later)?.kind, "work");
  // The private /tmp is a sized tmpfs where bubblewrap can size one: there
  // the write itself fails.
  if (commandSandboxAvailability().tmpfsSize)
    await assert.rejects(
      validate([write("/tmp/a", 17)]),
      /Validation command failed \(1\).*No space left on device/s,
    );
  // A worker's shell keeps its HOME and checkout between calls: the call
  // that leaves them over the budget reports it, and the next can clean up.
  execFileSync("git", ["-C", worktree, "worktree", "add", "-q", "../shell"]);
  const shell = (command) =>
    runSandboxedCommand({
      worktree: join(root, "shell"),
      root: join(root, "shell.root"),
      command,
      timeoutMs: 60_000,
      policy: sandbox,
    });
  assert.equal((await shell(write('"$HOME/a"', 9))).exitCode, 0);
  await assert.rejects(
    shell(write('"$HOME/b"', 9)),
    /^Error: the command ran, but the sandbox disk budget is exceeded: HOME holds 18\.0 MiB/,
  );
  assert.equal((await shell('rm "$HOME/b"')).exitCode, 0);
  await assert.rejects(
    shell(`mkdir out && ${write("out/a", 17)}`),
    /the checkout grew by 17\.0 MiB/,
  );
  assert.equal((await shell("rm -r out")).exitCode, 0);
  // A command stopped at its deadline is measured too.
  await assert.rejects(
    runSandboxedCommand({
      worktree: join(root, "shell"),
      root: join(root, "shell.root"),
      command: `${write('"$TMPDIR/a"', 17)} && sleep 30`,
      timeoutMs: 2_000,
      policy: sandbox,
    }),
    /the command ran, but the sandbox disk budget is exceeded: TMPDIR holds 17\.0 MiB/,
  );
  assert.equal((await shell('rm "$TMPDIR/a"')).exitCode, 0);
  // Worker Validate counts an over-budget command that exited 0 as failed.
  const declared = await runDeclaredValidation(
    join(root, "shell"),
    [write('"$HOME/a"', 17)],
    1,
    undefined,
    undefined,
    sandbox,
  );
  assert.equal(declared.passed, false);
  assert.equal(declared.failed, 1);
  assert.match(declared.text, /HOME holds 17\.0 MiB/);
  // The limits are validated strictly.
  for (const limits of [
    { homeMiB: 8 },
    { checkoutMiB: 1.5 },
    { candidateMiB: 8 },
    { disk: 1 },
  ])
    assert.throws(
      () => assertCommandSandboxConfig({ limits }),
      /sandbox\.limits/,
    );
  assertCommandSandboxConfig({
    limits: {
      homeMiB: 16,
      checkoutMiB: 16,
      files: 1024,
      candidateMiB: 16,
      candidateFiles: 1024,
    },
  });
});

test("a worker's shell runs in its checkout inside the same sandbox, bounded", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-worker-shell-"));
  const repository = join(root, "repository");
  execFileSync("git", ["init", "-q", repository]);
  writeFileSync(join(repository, "a.txt"), "base\n");
  execFileSync("git", ["-C", repository, "add", "a.txt"]);
  execFileSync("git", [
    "-C",
    repository,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-qm",
    "base",
  ]);
  // A worker's checkout is a linked worktree, as Factory creates it.
  const worktree = join(root, "worktree");
  execFileSync("git", ["-C", repository, "worktree", "add", "-q", worktree]);
  const secret = join(process.env.HOME, ".claude", ".credentials.json");
  mkdirSync(dirname(secret), { recursive: true });
  writeFileSync(secret, "secret\n");
  const run = (command, timeoutMs = 60_000) =>
    runSandboxedCommand({
      worktree,
      root: `${worktree}.shell`,
      command,
      timeoutMs,
      policy: STRICT_COMMAND_SANDBOX,
    });
  // Normal work: compute, write the checkout, read Git, keep HOME between calls.
  const hashed = await run(
    'sha256sum a.txt > a.sha && cat a.sha && git status --porcelain && echo kept > "$HOME/note"',
  );
  assert.equal(hashed.exitCode, 0, hashed.output);
  const digest = createHash("sha256").update("base\n").digest("hex");
  assert.match(hashed.output, new RegExp(`${digest}  a.txt\n\\?\\? a.sha\n`));
  assert.equal(
    readFileSync(join(worktree, "a.sha"), "utf8"),
    `${digest}  a.txt\n`,
  );
  assert.equal((await run('cat "$HOME/note"')).output, "kept\n");
  // Escapes fail: host secrets, .git, the network, the controller.
  for (const escape of [
    `! cat '${secret}'`,
    "! sh -c 'echo gitdir: /tmp >> .git'",
    // Under /tmp this lands in the sandbox's private /tmp; elsewhere it is
    // refused. Either way the host file never appears (checked below).
    `touch '${join(repository, "escape")}' 2>/dev/null || true`,
    `! kill -0 ${process.pid}`,
    `i="$(tail -n +3 /proc/net/dev | cut -d: -f1 | tr -d ' ')"; echo "$i"; test "$i" = lo`,
  ]) {
    const attempt = await run(escape);
    assert.equal(attempt.exitCode, 0, `${escape}\n${attempt.output}`);
  }
  assert.equal(existsSync(join(repository, "escape")), false);
  // A nonzero exit is reported, not thrown.
  assert.equal((await run("exit 7")).exitCode, 7);
  // Wall time is bounded: everything the command started is stopped.
  const stopped = await run("sleep 31.25 & sleep 31.25", 1_000);
  assert.equal(stopped.timedOut, true);
  assert.equal(
    execFileSync("ps", ["-eo", "args"], { encoding: "utf8" })
      .split("\n")
      .some((line) => line.trim() === "sleep 31.25"),
    false,
  );
  // Output is bounded to its start and end.
  const long = await run(
    "head -c 2000000 /dev/zero | tr '\\0' x; echo; echo last",
  );
  assert.equal(long.exitCode, 0);
  assert.ok(long.output.length < 300_000);
  assert.match(long.output, /bytes of output omitted/);
  assert.match(long.output, /last\n$/);
});

test("a killed worker's command sandbox is stopped and proved gone before the worker is ceased", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "factory-sandbox-cessation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // A worker launched as the Claude worker is: it records its sandboxes as
  // the Claude worker does, then its shell runs one command.
  const dist = new URL("../dist/", import.meta.url).href;
  const script = join(root, "worker.mjs");
  writeFileSync(
    script,
    [
      'import { readFileSync } from "node:fs";',
      `import { recordSandboxesIn } from "${dist}process.js";`,
      `import { runSandboxedCommand } from "${dist}execution/claude-shell.js";`,
      `import { STRICT_COMMAND_SANDBOX } from "${dist}execution/sandbox.js";`,
      `import { workerSandboxRecords } from "${dist}execution/worker-process.js";`,
      "const [requestPath, resultPath] = process.argv.slice(2);",
      'const { worktree, command } = JSON.parse(readFileSync(requestPath, "utf8"));',
      "recordSandboxesIn(workerSandboxRecords(resultPath));",
      "const result = await runSandboxedCommand({ worktree, root: `${worktree}.shell`, command, timeoutMs: 120_000, policy: STRICT_COMMAND_SANDBOX });",
      "process.exitCode = result.exitCode ?? 1;",
    ].join("\n"),
  );
  const harnessRoot = join(root, "harness");
  const harness = new ClaudeAgentSdkHarness(harnessRoot, {});
  let attempts = 0;
  const start = async (command) => {
    const identity = `attempt-${++attempts}`;
    const worktree = join(root, identity);
    execFileSync("git", ["init", "-q", worktree]);
    const data = await launchWorker({
      root: harnessRoot,
      identity,
      input: { worktree, command },
      script,
      env: process.env,
      label: "Test",
    });
    const cancel = () => harness.cancel({ identity, data });
    return {
      data,
      worktree,
      records: workerSandboxRecords(data.resultPath),
      cancel,
    };
  };
  const alive = ({ pid, startTime }) => {
    const current = linuxProcessIdentity(pid);
    return current?.startTime === startTime && current.state !== "Z";
  };
  const wait = () => new Promise((resolve) => setTimeout(resolve, 20));
  // The command runs, and its record names bubblewrap and the init.
  const running = async (worker) => {
    for (;;) {
      if (existsSync(join(worker.worktree, "started"))) {
        const names = readdirSync(worker.records).filter((name) =>
          name.endsWith(".json"),
        );
        assert.equal(names.length, 1);
        const record = JSON.parse(
          readFileSync(join(worker.records, names[0]), "utf8"),
        );
        if (record.init) return record;
      }
      assert.ok(alive(worker.data), readFileSync(worker.data.logPath, "utf8"));
      await wait();
    }
  };
  const gone = (record) =>
    !alive(record.owner) &&
    !alive(record.init) &&
    !processGroupExists(record.owner.group) &&
    !execFileSync("ps", ["-eo", "args"], { encoding: "utf8" })
      .split("\n")
      .some((line) => line.trim() === "sleep 31.75");
  const command = "touch started && exec sleep 31.75";

  // The worker is SIGKILLed while its command runs. The sandbox is detached
  // in bubblewrap's own group, so the worker's group never covers it; the
  // cancel finds its record, and returns with the sandbox gone and the record
  // removed. --die-with-parent usually ends the sandbox first, so this does
  // not show the race the proof closes; the next case shows the stop itself.
  const killed = await start(command);
  const record = await running(killed);
  assert.equal(record.owner.group, record.owner.pid);
  assert.notEqual(record.owner.group, killed.data.pid);
  assert.equal(linuxProcessIdentity(record.init.pid).group, record.owner.group);
  process.kill(killed.data.pid, "SIGKILL");
  await killed.cancel();
  assert.ok(gone(record));
  assert.equal(existsSync(killed.records), false);

  // The controller's proof itself stops a live sandbox by its verified
  // identity: here the worker still runs, so nothing else would end it.
  const live = await start(command);
  const liveRecord = await running(live);
  await stopRecordedSandboxes(live.records, sandboxBubblewrap);
  assert.ok(gone(liveRecord));
  await live.cancel();

  // A recorded identity that no longer matches (the pid now names another
  // process, which leads its own group) is never signalled: the outcome is
  // unknown until that group is gone. So is one that matches but runs
  // another executable than bubblewrap, and, within this boot, a spawn the
  // worker may have been killed during, before it recorded bubblewrap's
  // identity. Such a spawn from an earlier boot is gone.
  const other = spawn("sleep", ["29.25"], { detached: true, stdio: "ignore" });
  t.after(() => {
    try {
      process.kill(-other.pid, "SIGKILL");
    } catch {}
  });
  const owner = nativeProcessOwner(other.pid);
  const stale = String(Number(owner.startTime) - 1);
  const reused = join(root, "reused.sandboxes");
  mkdirSync(reused);
  writeFileSync(
    join(reused, "a.json"),
    JSON.stringify({
      owner: { ...owner, startTime: stale },
      init: { pid: other.pid, startTime: stale },
    }),
  );
  const unknown = (error) => error instanceof UnsettledSubprocessError;
  const stop = (directory) =>
    stopRecordedSandboxes(directory, sandboxBubblewrap);
  await assert.rejects(stop(reused), unknown);
  assert.ok(alive(owner));
  assert.ok(existsSync(join(reused, "a.json")));
  const otherExecutable = join(root, "other-executable.sandboxes");
  mkdirSync(otherExecutable);
  writeFileSync(join(otherExecutable, "a.json"), JSON.stringify({ owner }));
  await assert.rejects(stop(otherExecutable), unknown);
  assert.ok(alive(owner));
  assert.ok(existsSync(join(otherExecutable, "a.json")));
  const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  const inFlight = join(root, "in-flight.sandboxes");
  mkdirSync(inFlight);
  writeFileSync(join(inFlight, "a.json"), JSON.stringify({ boot }));
  await assert.rejects(stop(inFlight), unknown);
  assert.ok(existsSync(join(inFlight, "a.json")));
  const earlierBoot = join(root, "earlier-boot.sandboxes");
  mkdirSync(earlierBoot);
  writeFileSync(
    join(earlierBoot, "a.json"),
    JSON.stringify({ boot: "00000000-0000-0000-0000-000000000000" }),
  );
  await stop(earlierBoot);
  assert.equal(existsSync(earlierBoot), false);
  process.kill(-other.pid, "SIGKILL");
  while (processGroupExists(owner.group)) await wait();
  await stop(reused);
  assert.equal(existsSync(reused), false);

  // A command that ends normally: the worker removes its record itself.
  const done = await start("touch started");
  while (alive(done.data)) await wait();
  assert.ok(existsSync(join(done.worktree, "started")));
  assert.deepEqual(readdirSync(done.records), []);
  await done.cancel();
  assert.equal(existsSync(done.records), false);
});

// One command as validation launches it, and its run.
const launchIn = (root, command, readOnlyPaths) =>
  sandboxedCommand({
    command,
    checkout: join(root, "worktree"),
    temporary: join(root, "tmp"),
    home: join(root, "home"),
    env: { PATH: process.env.PATH },
    network: false,
    packageInstall: false,
    policy: { ...STRICT_COMMAND_SANDBOX, readOnlyPaths },
  });
const runIn = (root, launch) =>
  subprocessAsync(launch.file, launch.args, {
    cwd: join(root, "worktree"),
    env: launch.env,
    bubblewrap: launch.bubblewrap,
  });
const sandboxRoot = (t) => {
  const root = mkdtempSync(join(tmpdir(), "factory-sandbox-setup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ["tmp", "home"]) mkdirSync(join(root, name));
  execFileSync("git", ["init", "-q", join(root, "worktree")]);
  return root;
};

test("a sandbox that cannot be set up is a configuration fault, not the command's failure", {
  skip: new URL("..", import.meta.url).pathname.startsWith(`${tmpdir()}/`),
}, async (t) => {
  const root = sandboxRoot(t);
  const tools = outsideTemporary();
  t.after(() => rmSync(tools, { recursive: true, force: true }));
  // A command that runs and fails is the command's failure.
  const failed = await runIn(
    root,
    launchIn(root, `test -d '${tools}' && exit 1`, [tools]),
  );
  assert.equal(failed.status, 1);
  // A mount source that vanishes after the arguments were built: bubblewrap
  // exits 1 before the command runs, which is the host's fault (#1573).
  const launch = launchIn(root, "exit 0", [tools]);
  rmSync(tools, { recursive: true });
  const error = await runIn(root, launch).then(
    () => assert.fail("a sandbox that could not be set up ran"),
    (error) => error,
  );
  assert.equal(faultOf(error).kind, "config");
  assert.match(error.message, /could not be set up \(bubblewrap exit 1\)/);
  assert.match(error.message, /Can't find source path/);
});

test("no toolchain or read-only path mounts the host's /tmp or its sockets", {
  skip:
    process.geteuid?.() === 0 ||
    new URL("..", import.meta.url).pathname.startsWith(`${tmpdir()}/`),
}, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "factory-sandbox-mounts-"));
  const tools = outsideTemporary();
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(tools, { recursive: true, force: true });
  });
  const worktree = join(root, "worktree");
  execFileSync("git", ["init", "-q", worktree]);
  // A PATH tool that links to a file directly in /tmp would make /tmp a
  // toolchain root; a link loop names no tool the operator can follow.
  const marker = join(tmpdir(), `factory-host-${basename(root)}`);
  writeFileSync(marker, "host\n");
  t.after(() => rmSync(marker, { force: true }));
  symlinkSync(marker, join(tools, "host-tool"));
  symlinkSync(join(tools, "loop-b"), join(tools, "loop-a"));
  symlinkSync(join(tools, "loop-a"), join(tools, "loop-b"));
  const originalPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = originalPath;
  });
  const run = (command, policy = STRICT_COMMAND_SANDBOX) =>
    runSandboxedCommand({
      worktree,
      root: `${worktree}.shell`,
      command,
      timeoutMs: 60_000,
      policy,
    });
  process.env.PATH = `${tools}:${originalPath}`;
  const hidden = await run(`! test -e '${marker}'`);
  assert.equal(hidden.exitCode, 0, hidden.output);
  // A PATH directory in /tmp is refused, not mounted.
  const temporaryBin = join(root, "bin");
  mkdirSync(temporaryBin);
  process.env.PATH = `${temporaryBin}:${originalPath}`;
  await assert.rejects(run("true"), /PATH entry .* shared temporary/);
  process.env.PATH = originalPath;
  // So is any read-only path under /tmp, where host sockets live (#1574).
  const sockets = join(root, "sockets");
  mkdirSync(sockets);
  await assert.rejects(
    run("true", { ...STRICT_COMMAND_SANDBOX, readOnlyPaths: [sockets] }),
    /sandbox\.readOnlyPaths entry .* shared temporary/,
  );
  // And a package store there, which another user could create first; it
  // is refused before it is created. One that others can write is refused.
  const store = join(root, "store");
  await assert.rejects(
    run("true", { ...STRICT_COMMAND_SANDBOX, packageStore: store }),
    /sandbox\.packageStore .* shared temporary/,
  );
  assert.equal(existsSync(store), false);
  // So is one reached through a link into /tmp, or under a directory others
  // can write, before anything is created there.
  symlinkSync(root, join(tools, "into-tmp"));
  await assert.rejects(
    run("true", {
      ...STRICT_COMMAND_SANDBOX,
      packageStore: join(tools, "into-tmp", "linked", "store"),
    }),
    /sandbox\.packageStore .* shared temporary/,
  );
  assert.equal(existsSync(join(root, "linked")), false);
  const open = join(tools, "open");
  mkdirSync(open);
  chmodSync(open, 0o777);
  await assert.rejects(
    run("true", {
      ...STRICT_COMMAND_SANDBOX,
      packageStore: join(open, "nested", "store"),
    }),
    /sandbox\.packageStore .* which others can write/,
  );
  assert.equal(existsSync(join(open, "nested")), false);
  const writable = join(tools, "store");
  mkdirSync(writable);
  chmodSync(writable, 0o777);
  await assert.rejects(
    run("true", { ...STRICT_COMMAND_SANDBOX, packageStore: writable }),
    /sandbox\.packageStore .* group- or world-writable/,
  );
});

test("a root controller runs no sandboxed command unless the sandbox is optional", {
  skip: process.geteuid?.() !== 0 || !commandSandboxAvailability().available,
}, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "factory-sandbox-root-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const worktree = join(root, "worktree");
  execFileSync("git", ["init", "-q", worktree]);
  // bubblewrap's namespace maps to the host's root, which owns these.
  await assert.rejects(
    runSandboxedCommand({
      worktree,
      root: `${worktree}.shell`,
      command: "cat /etc/shadow",
      timeoutMs: 60_000,
      policy: STRICT_COMMAND_SANDBOX,
    }),
    /runs as root/,
  );
  const strict = commandSandboxStatus(STRICT_COMMAND_SANDBOX);
  assert.equal(strict.mode, "unavailable");
  assert.match(strict.fix, /unprivileged user/);
  const optional = commandSandboxStatus({
    ...STRICT_COMMAND_SANDBOX,
    required: false,
  });
  assert.equal(optional.mode, "bubblewrap");
  assert.match(optional.detail, /root-only host files/);
  // Claude's shell would require the sandbox anyway, so it is withheld even
  // where the optional sandbox is available.
  assert.equal(
    factoryShellAuthorized({
      config: {
        tools: ["Write", "Validate"],
        allowedTools: ["Write", "Validate"],
      },
    }),
    false,
  );
  // Codex's own sandbox reads them too: no Codex worker starts, fresh or
  // resumed, and no Codex shell gets a permission profile.
  const rootFault = (error) =>
    error.fault?.kind === "config" && /runs as root/.test(error.message);
  const harness = new CodexHarness(join(root, "credentials"), "off", {
    model: "unused",
    reasoningEffort: "low",
  });
  await assert.rejects(
    harness.start({ worktree, commandSandbox: STRICT_COMMAND_SANDBOX }),
    rootFault,
  );
  const shell = { directory: worktree, workspace: "read", network: false };
  assert.throws(
    () => createCodexHome({ config: "", sandbox: shell }),
    rootFault,
  );
  createCodexHome({
    config: "",
    sandbox: { ...shell, required: false },
  }).dispose();
});
