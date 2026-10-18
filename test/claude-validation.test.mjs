import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
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
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { LocalContentStore } from "../dist/content/local.js";
import { copyOwnedFile } from "../dist/execution/claude-files.js";
import {
  checkWorkHandoff,
  runDeclaredValidation,
  workerFilesTree,
} from "../dist/execution/claude-validation.js";

const status = (worktree) =>
  execFileSync("git", ["-C", worktree, "status", "--porcelain"], {
    encoding: "utf8",
  });

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

test("declared commands run in an OS sandbox that hides the host and keeps loopback", async () => {
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
  const store = join(root, "package-store");
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
