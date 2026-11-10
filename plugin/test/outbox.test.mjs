import "./temp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { POINTER_HEAD, lfsVersion } from "../scripts/lib/lfs.mjs";
import { gitError, openOutbox, parsePointer } from "../scripts/lib/outbox.mjs";

const quiet = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

/** An origin with main, a clone the agent works in, and a second clone for someone else's pushes. */
function repos() {
  const root = mkdtempSync(join(tmpdir(), "factory-outbox-"));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  const other = join(root, "other");
  const run = (cwd, ...a) => execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8", env: { ...process.env, ...quiet } }).trim();
  const put = (cwd, file, text) => {
    mkdirSync(join(cwd, file, ".."), { recursive: true });
    writeFileSync(join(cwd, file), text);
    run(cwd, "add", file);
  };
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["clone", "-q", origin, work], { env: { ...process.env, ...quiet } });
  put(work, "app.txt", "v1\n");
  run(work, "commit", "-q", "-m", "base");
  run(work, "push", "-q", "origin", "HEAD:main");
  execFileSync("git", ["clone", "-q", origin, other], { env: { ...process.env, ...quiet } });
  run(work, "checkout", "-q", "-b", "factory/1");
  return { root, origin, work, other, run, put };
}

const open = (r, extra = {}) => openOutbox({ branch: "factory/1", defaultBranch: "main", checkout: r.work, remote: r.origin, agentEnv: { ...process.env, ...quiet }, protectedList: [".github/"], base: r.root, ...extra });

test("outbox: the branch goes from the agent's checkout through Factory's mirror to the remote, leased and read back", async () => {
  const r = repos();
  const box = await open(r);
  assert.equal(box.expected(), "", "a new branch: the lease says it must not exist yet");
  r.put(r.work, "app.txt", "v2\n");
  r.run(r.work, "commit", "-q", "-m", "work");
  assert.equal(await box.push(), true, box.error);
  const head = r.run(r.work, "rev-parse", "HEAD");
  assert.equal(r.run(r.origin, "rev-parse", "factory/1"), head);
  assert.equal(box.expected(), head);
  assert.deepEqual(await box.delta(), { count: 1, files: ["app.txt"], head });
  // Nothing new: nothing pushed, still true.
  assert.equal(await box.push(), true);
  // A rewind to an earlier commit the mirror has needs no bundle, and the lease carries it.
  r.put(r.work, "app.txt", "v3\n");
  r.run(r.work, "commit", "-q", "-m", "more");
  assert.equal(await box.push(), true, box.error);
  r.run(r.work, "reset", "-q", "--hard", head);
  assert.equal(await box.push(), true, box.error);
  assert.equal(r.run(r.origin, "rev-parse", "factory/1"), head);
});

test("outbox: someone else's push since Factory's last one is never overwritten; the refusal is sticky", async () => {
  const r = repos();
  const box = await open(r);
  r.put(r.work, "app.txt", "v2\n");
  r.run(r.work, "commit", "-q", "-m", "work");
  assert.equal(await box.push(), true, box.error);
  r.run(r.other, "fetch", "-q", "origin", "factory/1");
  r.run(r.other, "checkout", "-q", "-b", "factory/1", "origin/factory/1");
  r.put(r.other, "other.txt", "x\n");
  r.run(r.other, "commit", "-q", "-m", "someone else");
  r.run(r.other, "push", "-q", "origin", "factory/1");
  const theirs = r.run(r.other, "rev-parse", "HEAD");
  r.put(r.work, "app.txt", "v3\n");
  r.run(r.work, "commit", "-q", "--amend", "-m", "rewritten");
  assert.equal(await box.push(), false);
  assert.match(box.error, /^push rejected: .*stale info|^push rejected: /);
  assert.equal(r.run(r.origin, "rev-parse", "factory/1"), theirs, "their commit stays");
  assert.equal(await box.push(), false, "a rejected push Blocks the stage: no retry");
});

test("outbox: a protected path or a plain blob LFS should hold is refused before anything is sent; only this stage's changes count", async () => {
  const r = repos();
  // main gains a workflow after the branch was cut; a rebase takes it, which is not the stage's change.
  r.put(r.other, ".github/workflows/ci.yml", "on: push\n");
  r.run(r.other, "commit", "-q", "-m", "ci on main");
  r.run(r.other, "push", "-q", "origin", "HEAD:main");
  const box = await open(r);
  r.run(r.work, "fetch", "-q", "origin", "main");
  r.run(r.work, "rebase", "-q", "origin/main");
  r.put(r.work, "app.txt", "v2\n");
  r.run(r.work, "commit", "-q", "-m", "work");
  assert.equal(await box.push(), true, box.error);
  r.put(r.work, ".github/workflows/ci.yml", "on: [push, pull_request]\n");
  r.run(r.work, "commit", "-q", "-m", "widen ci");
  const before = r.run(r.origin, "rev-parse", "factory/1");
  assert.equal(await box.push(), false);
  assert.equal(box.error, "touched protected path .github/workflows/ci.yml");
  assert.equal(r.run(r.origin, "rev-parse", "factory/1"), before);

  const r2 = repos();
  r2.put(r2.work, ".gitattributes", "assets/** filter=lfs diff=lfs merge=lfs -text\n");
  r2.put(r2.work, "assets/a.bin", randomBytes(4000).toString("hex"));
  r2.run(r2.work, "commit", "-q", "--no-verify", "-m", "media as a plain blob");
  const box2 = await open(r2);
  assert.equal(await box2.push(), false);
  assert.equal(box2.lfsRefused, true);
  assert.match(box2.error, /plain git blobs .*assets\/a\.bin/);
});

test("outbox: a fix pass's toolchain change outside its fence is refused; put back, the fix is pushed", async () => {
  const r = repos();
  r.put(r.work, ".nvmrc", "22\n");
  r.put(r.work, "package.json", "{}\n");
  r.put(r.work, "package-lock.json", "{}\n");
  r.run(r.work, "commit", "-q", "-m", "pins");
  r.run(r.work, "push", "-q", "origin", "HEAD:main");
  const box = await open(r);
  r.put(r.work, "app.txt", "v2\n");
  r.run(r.work, "commit", "-q", "-m", "work");
  assert.equal(await box.push(), true, box.error);
  assert.deepEqual(await box.outside(), [], "no fence before a fix pass");
  // The first fix pass: the plan and the red name app.txt only.
  await box.fence({ plan: "1. owns `app.txt`", texts: ["Objective: fix app", "FAIL app.txt:1 expected v3"] });
  const since = box.fenceStart();
  r.put(r.work, "app.txt", "v3\n");
  r.put(r.work, ".nvmrc", "20\n");
  r.put(r.work, "scripts/get-toolchain.sh", "curl x\n");
  r.run(r.work, "commit", "-q", "-m", "fix, and the toolchain");
  assert.deepEqual(await box.outside(), [".nvmrc", "scripts/get-toolchain.sh"]);
  // Put back, as the corrective turn asks: only the fix remains, and it is pushed.
  r.run(r.work, "checkout", since, "--", ".nvmrc");
  r.run(r.work, "rm", "-q", "scripts/get-toolchain.sh");
  r.run(r.work, "commit", "-q", "-m", "put the toolchain back");
  assert.deepEqual(await box.outside(), []);
  assert.equal(await box.push(), true, box.error);
  // A later fix pass's plan text does not widen the fence; its red does.
  await box.fence({ plan: "now owns `.nvmrc`", texts: ["npm error `package-lock.json` is out of sync"] });
  r.put(r.work, "package-lock.json", "{\"v\":2}\n");
  r.put(r.work, ".nvmrc", "18\n");
  r.run(r.work, "commit", "-q", "-m", "second fix");
  const before = r.run(r.origin, "rev-parse", "factory/1");
  assert.equal(await box.push(), false);
  assert.match(box.error, /^a fix pass changed \.nvmrc \(toolchain, lockfile or CI configuration\), which neither the plan nor the failing check names/);
  assert.equal(r.run(r.origin, "rev-parse", "factory/1"), before, "nothing of the refused pass reaches GitHub");
  assert.equal(await box.push(), false, "refused for good: the stage Blocks");

  // What the default branch changed since the branch was cut, taken in by the fix pass, is not the pass's.
  const r2 = repos();
  r2.put(r2.work, "app.txt", "v2\n");
  r2.run(r2.work, "commit", "-q", "-m", "work");
  r2.run(r2.work, "push", "-q", "origin", "HEAD:factory/1");
  r2.put(r2.other, "yarn.lock", "lock\n");
  r2.run(r2.other, "commit", "-q", "-m", "lock on main");
  r2.run(r2.other, "push", "-q", "origin", "HEAD:main");
  const box2 = await open(r2);
  await box2.fence({ texts: ["red in app.txt"] });
  r2.run(r2.work, "fetch", "-q", "origin", "main");
  r2.run(r2.work, "rebase", "-q", "origin/main");
  assert.deepEqual(await box2.outside(), []);
  assert.equal(await box2.push(), true, box2.error);
});

test("outbox: a fix pass that adds a dependency pushes each manifest with its own lockfile; a lockfile alone is refused", async () => {
  const r = repos();
  for (const [f, t] of [["web/package.json", "{}\n"], ["web/package-lock.json", "{}\n"], ["api/package.json", "{}\n"], ["api/yarn.lock", "# yarn\n"], ["py/pyproject.toml", "[project]\n"], ["py/uv.lock", "version = 1\n"], ["Cargo.toml", "[package]\n"], ["Cargo.lock", "version = 4\n"]]) r.put(r.work, f, t);
  r.run(r.work, "commit", "-q", "-m", "manifests");
  r.run(r.work, "push", "-q", "origin", "HEAD:main");
  const box = await open(r);
  r.put(r.work, "app.txt", "v2\n");
  r.run(r.work, "commit", "-q", "-m", "work");
  assert.equal(await box.push(), true, box.error);
  // The red names none of the manifests or lockfiles; the fix adds a dependency in three ecosystems.
  await box.fence({ plan: "1. owns `app.txt`", texts: ["FAIL app.txt:1 cannot find module zod"] });
  r.put(r.work, "app.txt", "v3\n");
  r.put(r.work, "web/package.json", '{"dependencies":{"zod":"^4"}}\n');
  r.put(r.work, "web/package-lock.json", '{"packages":{"node_modules/zod":{}}}\n');
  r.put(r.work, "py/pyproject.toml", '[project]\ndependencies = ["httpx"]\n');
  r.put(r.work, "py/uv.lock", 'version = 1\n[[package]]\nname = "httpx"\n');
  r.put(r.work, "Cargo.toml", '[package]\n[dependencies]\nserde = "1"\n');
  r.put(r.work, "Cargo.lock", 'version = 4\n[[package]]\nname = "serde"\n');
  r.run(r.work, "commit", "-q", "-m", "fix: add the dependencies");
  assert.deepEqual(await box.outside(), []);
  assert.equal(await box.push(), true, box.error);
  // A lockfile whose manifest the pass did not change and nothing names: refused, and nothing of it is pushed.
  r.put(r.work, "api/yarn.lock", "# yarn\nleft-pad@1\n");
  r.run(r.work, "commit", "-q", "-m", "relock api");
  assert.deepEqual(await box.outside(), ["api/yarn.lock"]);
  const before = r.run(r.origin, "rev-parse", "factory/1");
  assert.equal(await box.push(), false);
  assert.match(box.error, /^a fix pass changed api\/yarn\.lock \(toolchain, lockfile or CI configuration\)/);
  assert.equal(r.run(r.origin, "rev-parse", "factory/1"), before);
});

test("outbox: a fix pass that adds a dependency to a workspace member pushes the root lockfile; the declaration counts as it stood at the fence", async () => {
  const r = repos();
  for (const [f, t] of [["pnpm-workspace.yaml", "packages:\n  - 'packages/*'\n"], ["package.json", '{"private":true}\n'], ["pnpm-lock.yaml", "lockfileVersion: '9.0'\n"], ["packages/x/package.json", "{}\n"], ["tools/y/package.json", "{}\n"], ["rs/Cargo.toml", '[workspace]\nmembers = ["crates/*"]\n'], ["rs/Cargo.lock", "version = 4\n"], ["rs/crates/a/Cargo.toml", "[package]\n"]]) r.put(r.work, f, t);
  r.run(r.work, "commit", "-q", "-m", "workspaces");
  r.run(r.work, "push", "-q", "origin", "HEAD:main");
  const box = await open(r);
  r.put(r.work, "app.txt", "v2\n");
  r.run(r.work, "commit", "-q", "-m", "work");
  assert.equal(await box.push(), true, box.error);
  await box.fence({ plan: "1. owns `app.txt`", texts: ["FAIL app.txt:1 cannot find module zod"] });
  // The root lockfile alone, in each workspace: refused.
  r.put(r.work, "pnpm-lock.yaml", "lockfileVersion: '9.0'\nleft-pad: 1\n");
  r.put(r.work, "rs/Cargo.lock", 'version = 4\n[[package]]\nname = "serde"\n');
  r.run(r.work, "commit", "-q", "-m", "relock");
  assert.deepEqual(await box.outside(), ["pnpm-lock.yaml", "rs/Cargo.lock"]);
  // A manifest the declaration did not list at the fence, though the pass adds it to the declaration: still refused.
  r.put(r.work, "pnpm-workspace.yaml", "packages:\n  - 'packages/*'\n  - 'tools/*'\n");
  r.put(r.work, "tools/y/package.json", '{"dependencies":{"zod":"^4"}}\n');
  r.run(r.work, "commit", "-q", "-m", "widen the workspace");
  assert.deepEqual(await box.outside(), ["pnpm-lock.yaml", "rs/Cargo.lock"]);
  // A listed member's manifest: its workspace's root lockfile is in scope, and the push goes through.
  r.put(r.work, "packages/x/package.json", '{"dependencies":{"zod":"^4"}}\n');
  r.put(r.work, "rs/crates/a/Cargo.toml", '[package]\n[dependencies]\nserde = "1"\n');
  r.run(r.work, "commit", "-q", "-m", "fix: add the dependencies");
  assert.deepEqual(await box.outside(), []);
  assert.equal(await box.push(), true, box.error);
});

test("outbox: a fix pass may change pnpm-workspace.yaml's packages list, read where the fence starts and at the head; a settings change is refused", async () => {
  const r = repos();
  const base = "packages:\n  - 'packages/*'\nonlyBuiltDependencies:\n  - esbuild\n";
  r.put(r.work, "pnpm-workspace.yaml", base);
  r.run(r.work, "commit", "-q", "-m", "workspace");
  r.run(r.work, "push", "-q", "origin", "HEAD:main");
  const box = await open(r);
  r.put(r.work, "app.txt", "v2\n");
  r.run(r.work, "commit", "-q", "-m", "work");
  assert.equal(await box.push(), true, box.error);
  await box.fence({ plan: "1. owns `app.txt`", texts: ["FAIL app.txt:1 expected v3"] });
  const since = box.fenceStart();
  // The packages list alone, a new file with packages alone: allowed.
  r.put(r.work, "pnpm-workspace.yaml", base.replace("  - 'packages/*'\n", "  - 'packages/*'\n  - 'tools/*'\n"));
  r.put(r.work, "web/pnpm-workspace.yaml", "packages:\n  - 'apps/*'\n");
  r.run(r.work, "commit", "-q", "-m", "widen the workspace");
  assert.deepEqual(await box.outside(), []);
  // A setting too, or a new file with one: refused.
  r.put(r.work, "pnpm-workspace.yaml", base.replace("  - esbuild\n", "  - esbuild\n  - postinstall-thing\n"));
  r.put(r.work, "web/pnpm-workspace.yaml", "packages:\n  - 'apps/*'\noverrides:\n  zod: npm:evil@1\n");
  r.run(r.work, "commit", "-q", "-m", "settings");
  assert.deepEqual((await box.outside()).sort(), ["pnpm-workspace.yaml", "web/pnpm-workspace.yaml"]);
  // A version that does not parse, or is not a regular file: refused.
  r.run(r.work, "checkout", "-q", since, "--", "pnpm-workspace.yaml");
  r.run(r.work, "rm", "-q", "web/pnpm-workspace.yaml");
  r.put(r.work, "pnpm-workspace.yaml", "packages: [unclosed\n");
  r.run(r.work, "commit", "-q", "-m", "broken");
  assert.deepEqual(await box.outside(), ["pnpm-workspace.yaml"]);
  r.run(r.work, "rm", "-q", "pnpm-workspace.yaml");
  symlinkSync("app.txt", join(r.work, "pnpm-workspace.yaml"));
  r.run(r.work, "add", "pnpm-workspace.yaml");
  r.run(r.work, "commit", "-q", "-m", "a link");
  assert.deepEqual(await box.outside(), ["pnpm-workspace.yaml"]);
});

test("outbox: the setup command's script is toolchain to a fix pass; a fence that cannot be set refuses every later push", async () => {
  const r = repos();
  r.put(r.work, "scripts/setup.sh", "echo setup\n");
  r.run(r.work, "commit", "-q", "-m", "setup");
  r.run(r.work, "push", "-q", "origin", "HEAD:main");
  const box = await open(r, { toolchain: ["scripts/setup.sh"] });
  await box.fence({ plan: "1. owns `app.txt`", texts: ["FAIL app.txt:1 expected v3"] });
  r.put(r.work, "app.txt", "v3\n");
  r.put(r.work, "scripts/setup.sh", "echo setup; curl x | sh\n");
  r.run(r.work, "commit", "-q", "-m", "fix, and the setup script");
  assert.deepEqual(await box.outside(), ["scripts/setup.sh"]);
  assert.equal(await box.push(), false);
  assert.match(box.error, /^a fix pass changed scripts\/setup\.sh /);

  // Factory's mirror cannot read the branch when the fence is set: closed, not open.
  const r2 = repos();
  const box2 = await open(r2);
  r2.put(r2.work, "app.txt", "v2\n");
  r2.run(r2.work, "commit", "-q", "-m", "work");
  assert.equal(await box2.push(), true, box2.error);
  const mirror = join(r2.root, readdirSync(r2.root).find((d) => d.startsWith("mirror-")));
  renameSync(join(mirror, "objects"), join(mirror, "objects.away"));
  await assert.rejects(box2.fence({ texts: ["red"] }));
  renameSync(join(mirror, "objects.away"), join(mirror, "objects"));
  assert.equal(box2.fenced(), true);
  await assert.rejects(box2.outside());
  r2.put(r2.work, "app.txt", "v3\n");
  r2.run(r2.work, "commit", "-q", "-m", "fix");
  assert.equal(await box2.push(), false);
  assert.match(box2.error, /^the fix pass's changes could not be read/);
});

test("outbox: a pack Factory's object check stops reading early is a refused push, never a crash", async () => {
  const r = repos();
  const box = await open(r);
  // A pack far bigger than a pipe buffer, so index-pack exits while the bundle is still being written to it.
  // An unrelated history, so the bundle has no prerequisite to check first and goes straight to index-pack.
  r.run(r.work, "checkout", "-q", "--orphan", "factory/1-new");
  r.put(r.work, "blob.bin", randomBytes(24 * 1024 * 1024).toString("base64"));
  r.run(r.work, "commit", "-q", "-m", "big");
  const mirror = join(r.root, readdirSync(r.root).find((d) => d.startsWith("mirror-")));
  renameSync(join(mirror, "objects"), join(mirror, "objects.away"));
  try {
    assert.equal(await box.push(), false);
    assert.match(box.error, /bundle|object|read/, box.error);
  } finally {
    renameSync(join(mirror, "objects.away"), join(mirror, "objects"));
  }
});

test("outbox: Git LFS media is taken from the agent's store only when its bytes match the pointer", async (t) => {
  assert.deepEqual(parsePointer(`${POINTER_HEAD}\noid sha256:${"a".repeat(64)}\nsize 12\n`), { oid: "a".repeat(64), size: 12 });
  assert.deepEqual(parsePointer(`version https://hawser.github.com/spec/v1\noid sha256:${"b".repeat(64)}\nsize 3\n`), { oid: "b".repeat(64), size: 3 });
  assert.equal(parsePointer("hello"), null);
  if (!(await lfsVersion())) return t.skip("git-lfs is not installed");
  const r = repos();
  const bytes = randomBytes(5000);
  const oid = createHash("sha256").update(bytes).digest("hex");
  r.put(r.work, ".gitattributes", "assets/** filter=lfs diff=lfs merge=lfs -text\n");
  r.put(r.work, "assets/a.glb", `${POINTER_HEAD}\noid sha256:${oid}\nsize 5000\n`);
  r.run(r.work, "commit", "-q", "--no-verify", "-m", "media");
  // The store holds other bytes under that oid: refused, nothing sent.
  const store = join(r.work, ".git", "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4));
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, oid), randomBytes(5000));
  const box = await open(r);
  assert.equal(await box.push(), false);
  assert.match(box.error, /^Git LFS objects missing from the checkout's store, or not matching their pointers: /);
  assert.throws(() => r.run(r.origin, "rev-parse", "--verify", "factory/1"));
  // Over the local cap: refused with the size, before any upload.
  writeFileSync(join(store, oid), bytes);
  process.env.FACTORY_LOCAL_MEDIA_MAX_MB = "0.001";
  try {
    const box2 = await open(r, { local: true });
    assert.equal(await box2.push(), false);
    assert.match(box2.error, /^the branch's Git LFS media is 0\.0 MB \(1 object\(s\)\), over the local limit of 0\.001 MB/);
  } finally {
    delete process.env.FACTORY_LOCAL_MEDIA_MAX_MB;
  }
  // A path remote has no https LFS endpoint: Factory will not upload media anywhere but the repository's own.
  const box3 = await open(r);
  assert.equal(await box3.push(), false);
  assert.equal(box3.error, "the remote has no https Git LFS endpoint to pin the media upload to");
});

test("outbox: the checkout gets the default branch as a bundle; Factory's own clean rebase is the commit pushed; a conflict is left to the harness", async () => {
  const r = repos();
  r.put(r.work, "app.txt", "v2\n");
  r.run(r.work, "commit", "-q", "-m", "work");
  const box = await open(r);
  assert.equal(await box.push(), true, box.error);
  // main moves on; the checkout has not seen it.
  r.put(r.other, "other.txt", "x\n");
  r.run(r.other, "commit", "-q", "-m", "sibling");
  r.run(r.other, "push", "-q", "origin", "HEAD:main");
  const main = r.run(r.other, "rev-parse", "HEAD");
  const box2 = await open(r);
  assert.equal(await box2.behind(), 1);
  assert.equal(await box2.feed(), main);
  assert.equal(r.run(r.work, "rev-parse", "refs/remotes/origin/main"), main, "handed over, not fetched by Factory in the checkout");
  const sha = await box2.rebase({ name: "factory", email: "f@f" });
  assert.match(sha, /^[0-9a-f]{40}$/);
  assert.equal(await box2.push({ sha }), true, box2.error);
  assert.equal(r.run(r.origin, "rev-parse", "factory/1"), sha);
  assert.equal(r.run(r.origin, "rev-parse", "factory/1^"), main);
  // A conflicting rebase: null, nothing pushed.
  r.put(r.other, "app.txt", "theirs\n");
  r.run(r.other, "commit", "-q", "-m", "conflicting sibling");
  r.run(r.other, "push", "-q", "origin", "HEAD:main");
  const box3 = await open(r);
  assert.equal(await box3.rebase({ name: "factory", email: "f@f" }), null);
  assert.equal(r.run(r.origin, "rev-parse", "factory/1"), sha);
});

test("outbox: a malformed object in the agent's bundle is refused by Factory's own object check", async () => {
  const r = repos();
  const tree = r.run(r.work, "write-tree");
  const parent = r.run(r.work, "rev-parse", "HEAD");
  const bad = execFileSync("git", ["-C", r.work, "hash-object", "-t", "commit", "-w", "--literally", "--stdin"], { input: `tree ${tree}\nparent ${parent}\nauthor nobody\ncommitter nobody\n\nbad\n`, encoding: "utf8" }).trim();
  r.run(r.work, "update-ref", "refs/heads/factory/1", bad);
  const box = await open(r);
  assert.equal(await box.push(), false);
  assert.match(box.error, /failed Factory's object check/);
  assert.throws(() => r.run(r.origin, "rev-parse", "--verify", "factory/1"));
});

test("mergeTree: the tree of a clean merge, null on a conflict", async () => {
  const { mergeTree } = await import("../scripts/lib/outbox.mjs");
  const r = repos();
  r.put(r.work, "a.txt", "a\n");
  r.run(r.work, "commit", "-q", "-m", "ours");
  r.run(r.work, "push", "-q", "origin", "HEAD:refs/heads/factory/1");
  const ours = r.run(r.work, "rev-parse", "HEAD");
  r.put(r.other, "b.txt", "b\n");
  r.run(r.other, "commit", "-q", "-m", "theirs");
  r.run(r.other, "push", "-q", "origin", "HEAD:main");
  const theirs = r.run(r.other, "rev-parse", "HEAD");
  r.run(r.work, "fetch", "-q", "origin", "main");
  r.run(r.work, "merge", "-q", "--no-edit", "origin/main");
  assert.equal(await mergeTree({ remote: r.origin, ours, theirs, base: r.root }), r.run(r.work, "rev-parse", "HEAD^{tree}"));
  r.put(r.other, "a.txt", "conflict\n");
  r.run(r.other, "commit", "-q", "-m", "clash");
  r.run(r.other, "push", "-q", "origin", "HEAD:main");
  assert.equal(await mergeTree({ remote: r.origin, ours, theirs: r.run(r.other, "rev-parse", "HEAD"), base: r.root }), null);
});

/**
 * A pre-receive hook on the test origin that refuses a branch update as GitHub refuses a token without the Workflows
 * permission (seen live on the scratch adopter, #2579): a workflow file at the new head whose blob neither the branch's
 * old head nor any branch's head has at that path.
 */
function refuseWorkflowVersions(r) {
  const hook = join(r.origin, "hooks", "pre-receive");
  writeFileSync(
    hook,
    `#!/bin/sh
while read old new ref; do
  git ls-tree -r "$new" -- .github/workflows | while read mode type blob path; do
    seen=""
    for tip in $( [ "$old" != 0000000000000000000000000000000000000000 ] && echo "$old"; git for-each-ref --format='%(objectname)' refs/heads ); do
      [ "$(git rev-parse -q --verify "$tip:$path" 2>/dev/null)" = "$blob" ] && seen=1 && break
    done
    [ -n "$seen" ] || { echo "refusing to allow a Personal Access Token to create or update workflow \\\`$path\\\` without \\\`workflow\\\` scope" >&2; exit 1; }
  done || exit 1
done
`,
    { mode: 0o755 },
  );
}

/**
 * A proc-receive hook on the test origin for refs/heads/factory/*: it refuses every update with `reason`, which git then
 * prints on the ref's own porcelain line, as GitHub does for a workflow file a token may not write.
 */
function refuseRefLine(r, reason) {
  r.run(r.origin, "config", "receive.procReceiveRefs", "refs/heads/factory");
  writeFileSync(
    join(r.origin, "hooks", "proc-receive"),
    `#!${process.execPath}
const fs = require("node:fs");
const read = (n) => { const b = Buffer.alloc(n); let got = 0; while (got < n) got += fs.readSync(0, b, got, n - got, null); return b.toString("utf8"); };
const pkt = () => { const n = parseInt(read(4), 16); return n === 0 ? null : read(n - 4).replace(/\\n$/, ""); };
const say = (s) => fs.writeSync(1, (s === null ? "0000" : (s.length + 5).toString(16).padStart(4, "0") + s + "\\n"));
while (pkt() !== null);
say("version=1"); say(null);
const refs = [];
for (let l; (l = pkt()) !== null; ) refs.push(l.split(" ")[2]);
for (const ref of refs) say("ng " + ref + " " + ${JSON.stringify(reason)});
say(null);
`,
    { mode: 0o755 },
  );
}

/** main with a workflow file, the agent's branch cut from it, and the box opened there (the run's base). */
async function withWorkflow(r, extra = {}) {
  r.run(r.other, "pull", "-q", "origin", "main");
  r.put(r.other, ".github/workflows/ci.yml", "on: push # v1\n");
  r.run(r.other, "commit", "-q", "-m", "ci v1");
  r.run(r.other, "push", "-q", "origin", "HEAD:main");
  r.run(r.work, "fetch", "-q", "origin", "main");
  r.run(r.work, "reset", "-q", "--hard", "origin/main");
  return open(r, extra);
}

test("outbox: a default branch that changed a workflow file during the run is merged in by Factory before the push (#2579)", async () => {
  const r = repos();
  const box = await withWorkflow(r);
  r.put(r.work, "app.txt", "v2\n");
  r.run(r.work, "commit", "-q", "-m", "work");
  const work = r.run(r.work, "rev-parse", "HEAD");
  // Mid-run: the default branch changes the workflow file (a Factory pin bump, say).
  r.put(r.other, ".github/workflows/ci.yml", "on: push # v2\n");
  r.run(r.other, "commit", "-q", "-m", "ci v2");
  r.run(r.other, "push", "-q", "origin", "HEAD:main");
  const main = r.run(r.other, "rev-parse", "HEAD");
  refuseWorkflowVersions(r);
  assert.throws(() => r.run(r.work, "push", "-q", "origin", "HEAD:refs/heads/probe"), /workflow/, "the branch as it is would be refused");
  box.author = { name: "factory[bot]", email: "1+factory[bot]@users.noreply.github.com" };
  assert.equal(await box.push(), true, box.error);
  const head = r.run(r.origin, "rev-parse", "factory/1");
  assert.deepEqual(r.run(r.origin, "rev-list", "--parents", "-n", "1", head).split(" ").slice(1), [work, main], "Factory's merge: the agent's head, then the default branch");
  assert.equal(r.run(r.origin, "rev-parse", `${head}:.github/workflows/ci.yml`), r.run(r.origin, "rev-parse", `${main}:.github/workflows/ci.yml`));
  assert.equal(r.run(r.origin, "log", "-1", "--format=%an <%ae>", head), "factory[bot] <1+factory[bot]@users.noreply.github.com>");
  assert.deepEqual(box.merged, { default: main, paths: [".github/workflows/ci.yml"] });
  assert.equal(box.base, main);
  // The checkout took the merge, so the next commit builds on it and needs no second merge.
  assert.equal(box.synced, true);
  assert.equal(r.run(r.work, "rev-parse", "HEAD"), head);
  // A push with nothing new reports nothing of the last one.
  assert.equal(await box.push(), true);
  assert.equal(box.merged, null);
  r.put(r.work, "app.txt", "v3\n");
  r.run(r.work, "commit", "-q", "-m", "more");
  assert.equal(await box.push(), true, box.error);
  assert.equal(box.merged, null);
  assert.equal(r.run(r.origin, "rev-parse", "factory/1^"), head);
  // The merged-in workflow change is not the stage's: no protected-path refusal, and the delta counts from the new base.
  assert.deepEqual((await box.delta()).files, ["app.txt"]);
});

test("outbox: a checkout that cannot take Factory's merge keeps the branch on it; later pushes only move it forward", async () => {
  const r = repos();
  const box = await withWorkflow(r);
  box.author = { name: "factory[bot]", email: "1+factory[bot]@users.noreply.github.com" };
  r.put(r.work, "app.txt", "v2\n");
  r.run(r.work, "commit", "-q", "-m", "work");
  const work = r.run(r.work, "rev-parse", "HEAD");
  r.put(r.other, ".github/workflows/ci.yml", "on: push # v2\n");
  r.run(r.other, "commit", "-q", "-m", "ci v2");
  r.run(r.other, "push", "-q", "origin", "HEAD:main");
  // Uncommitted edits in the way of the fast-forward.
  writeFileSync(join(r.work, ".github/workflows/ci.yml"), "on: push # local edit\n");
  assert.equal(await box.push(), true, box.error);
  const merge = r.run(r.origin, "rev-parse", "factory/1");
  assert.equal(box.synced, false);
  assert.equal(r.run(r.work, "rev-parse", "HEAD"), work, "the checkout stayed on the agent's head");
  // Nothing new: the branch stays on Factory's merge, never a fresh merge replacing it.
  assert.equal(await box.push(), true, box.error);
  assert.equal(r.run(r.origin, "rev-parse", "factory/1"), merge);
  assert.equal(box.merged, null);
  // New commits: merged onto Factory's merge, so the push is a fast-forward of it.
  r.put(r.work, "more.txt", "x\n");
  r.run(r.work, "commit", "-q", "-m", "more");
  const more = r.run(r.work, "rev-parse", "HEAD");
  assert.equal(await box.push(), true, box.error);
  const next = r.run(r.origin, "rev-parse", "factory/1");
  assert.deepEqual(r.run(r.origin, "rev-list", "--parents", "-n", "1", next).split(" ").slice(1), [merge, more]);
  assert.equal(r.run(r.origin, "log", "-1", "--format=%an", next), "factory[bot]");
  assert.equal(r.run(r.origin, "show", `${next}:more.txt`), "x");
  assert.equal(box.synced, false, "the edits are still in the way");
  // The edits gone, the next push puts the checkout on the branch.
  r.run(r.work, "checkout", "-q", "--", ".github/workflows/ci.yml");
  assert.equal(await box.push(), true, box.error);
  assert.equal(r.run(r.origin, "rev-parse", "factory/1"), next);
  assert.equal(box.synced, true);
  assert.equal(r.run(r.work, "rev-parse", "HEAD"), next);
});

test("outbox: a commit Factory made (its rebase) is merged the same way, and the checkout is left to the caller", async () => {
  const r = repos();
  const box = await withWorkflow(r);
  r.put(r.work, "app.txt", "v2\n");
  r.run(r.work, "commit", "-q", "-m", "work");
  const work = r.run(r.work, "rev-parse", "HEAD");
  // Stands in for Factory's rebase: a commit in the mirror the push names by sha.
  assert.equal((await box.git(["fetch", "-q", r.work, "HEAD:refs/factory/made"])).code, 0);
  r.put(r.other, ".github/workflows/ci.yml", "on: push # v2\n");
  r.run(r.other, "commit", "-q", "-m", "ci v2");
  r.run(r.other, "push", "-q", "origin", "HEAD:main");
  const main = r.run(r.other, "rev-parse", "HEAD");
  assert.equal(await box.push({ sha: work }), true, box.error);
  assert.deepEqual(box.merged, { default: main, paths: [".github/workflows/ci.yml"] });
  assert.equal(r.run(r.origin, "rev-parse", "factory/1^2"), main);
  assert.equal(r.run(r.work, "rev-parse", "HEAD"), work, "the checkout is not merged into: the caller re-points it");
  assert.equal(box.synced, true);
});

test("outbox: a run with no commits of its own pushes nothing, even when the default branch changed a workflow file meanwhile", async () => {
  const r = repos();
  const box = await withWorkflow(r);
  // The harness asked a Question (or found nothing to change): the checkout is still at the base.
  r.put(r.other, ".github/workflows/ci.yml", "on: push # v2\n");
  r.run(r.other, "commit", "-q", "-m", "ci v2");
  r.run(r.other, "push", "-q", "origin", "HEAD:main");
  refuseWorkflowVersions(r);
  assert.equal(await box.push(), true, box.error);
  assert.equal(box.merged, null, "no merge of Factory's own");
  assert.equal(box.conflict, null);
  assert.equal(box.failed, false);
  assert.throws(() => r.run(r.origin, "rev-parse", "--verify", "factory/1"), "no branch on the remote, so no PR");
  assert.equal(box.expected(), "");
  assert.equal((await box.delta()).count, 0, "the run reads as one that left no commits");
  // Nor without a workflow change: a new branch that is only a default-branch commit never goes out.
  const r2 = repos();
  const box2 = await open(r2);
  assert.equal(await box2.push(), true, box2.error);
  assert.throws(() => r2.run(r2.origin, "rev-parse", "--verify", "factory/1"));
  assert.equal((await box2.delta()).count, 0);
});

test("outbox: a default branch that moved without a workflow change is not merged in", async () => {
  const r = repos();
  const box = await withWorkflow(r);
  r.put(r.work, "app.txt", "v2\n");
  r.run(r.work, "commit", "-q", "-m", "work");
  const work = r.run(r.work, "rev-parse", "HEAD");
  r.put(r.other, "other.txt", "x\n");
  r.run(r.other, "commit", "-q", "-m", "sibling");
  r.run(r.other, "push", "-q", "origin", "HEAD:main");
  assert.equal(await box.push(), true, box.error);
  assert.equal(r.run(r.origin, "rev-parse", "factory/1"), work);
  assert.equal(box.merged, null);
});

test("outbox: a new branch that conflicts with the moved default is not pushed; resolved by the harness it is, and a second conflict is refused", async () => {
  const r = repos();
  const box = await withWorkflow(r);
  r.put(r.work, "app.txt", "ours\n");
  r.run(r.work, "commit", "-q", "-m", "work");
  r.put(r.other, ".github/workflows/ci.yml", "on: push # v2\n");
  r.put(r.other, "app.txt", "theirs\n");
  r.run(r.other, "commit", "-q", "-m", "ci v2 and a clash");
  r.run(r.other, "push", "-q", "origin", "HEAD:main");
  const main = r.run(r.other, "rev-parse", "HEAD");
  assert.equal(await box.push(), false);
  assert.equal(box.failed, false, "not sticky: the harness gets the conflict");
  assert.deepEqual(box.conflict, { default: main, paths: [".github/workflows/ci.yml"] });
  assert.throws(() => r.run(r.origin, "rev-parse", "--verify", "factory/1"), "nothing pushed");
  // The conflict pass: the default branch handed over, the branch rebased onto it with the clash resolved.
  assert.equal(await box.feed(), main);
  assert.throws(() => r.run(r.work, "rebase", "-q", "origin/main"));
  r.put(r.work, "app.txt", "ours and theirs\n");
  r.run(r.work, "-c", "core.editor=true", "rebase", "--continue");
  assert.equal(await box.push(), true, box.error);
  assert.equal(box.merged, null, "already on the default branch: no merge");
  assert.equal(r.run(r.origin, "rev-parse", "factory/1^"), main);

  // Left unresolved, the second push is refused and stays refused.
  const r2 = repos();
  const box2 = await withWorkflow(r2);
  r2.put(r2.work, "app.txt", "ours\n");
  r2.run(r2.work, "commit", "-q", "-m", "work");
  r2.put(r2.other, ".github/workflows/ci.yml", "on: push # v2\n");
  r2.put(r2.other, "app.txt", "theirs\n");
  r2.run(r2.other, "commit", "-q", "-m", "ci v2 and a clash");
  r2.run(r2.other, "push", "-q", "origin", "HEAD:main");
  assert.equal(await box2.push(), false);
  assert.equal(await box2.push(), false);
  assert.equal(box2.failed, true);
  assert.match(box2.error, /^factory\/1 conflicts with main, which changed \.github\/workflows\/ci\.yml/);
});

test("outbox: an existing branch that conflicts with the moved default is pushed as it is (its PR takes the send-back)", async () => {
  const r = repos();
  const box = await withWorkflow(r);
  r.put(r.work, "app.txt", "ours\n");
  r.run(r.work, "commit", "-q", "-m", "work");
  assert.equal(await box.push(), true, box.error);
  r.put(r.other, ".github/workflows/ci.yml", "on: push # v2\n");
  r.put(r.other, "app.txt", "theirs\n");
  r.run(r.other, "commit", "-q", "-m", "ci v2 and a clash");
  r.run(r.other, "push", "-q", "origin", "HEAD:main");
  r.put(r.work, "more.txt", "x\n");
  r.run(r.work, "commit", "-q", "-m", "more");
  assert.equal(await box.push(), true, box.error);
  assert.equal(r.run(r.origin, "rev-parse", "factory/1"), r.run(r.work, "rev-parse", "HEAD"));
  assert.equal(box.conflict, null, "no conflict pass for an existing branch");
  assert.equal(box.merged, null);
});

test("outbox: a rebase or merge left in progress in the checkout is named; a clean checkout has none", async () => {
  const r = repos();
  const box = await open(r);
  assert.deepEqual(await box.inProgress(), { ops: [] });
  r.put(r.work, "app.txt", "ours\n");
  r.run(r.work, "commit", "-q", "-m", "work");
  r.put(r.other, "app.txt", "theirs\n");
  r.run(r.other, "commit", "-q", "-m", "clash");
  r.run(r.other, "push", "-q", "origin", "HEAD:main");
  r.run(r.work, "fetch", "-q", "origin", "main");
  assert.throws(() => r.run(r.work, "rebase", "-q", "origin/main"));
  assert.deepEqual(await box.inProgress(), { ops: ["rebase"] });
  r.run(r.work, "rebase", "--abort");
  assert.throws(() => r.run(r.work, "merge", "-q", "origin/main"));
  assert.deepEqual(await box.inProgress(), { ops: ["merge"] });
  r.run(r.work, "merge", "--abort");
  assert.deepEqual(await box.inProgress(), { ops: [] });
  // The caller refuses the branch: every later push is refused with its reason.
  box.block("the conflict pass left a rebase in progress in the checkout; factory/1 was not pushed");
  assert.equal(await box.push(), false);
  assert.match(box.error, /^the conflict pass left a rebase in progress/);
  assert.throws(() => r.run(r.origin, "rev-parse", "--verify", "factory/1"), "nothing pushed");
});

test("outbox: a refused push's reason is Factory's fixed text; the remote's own text goes to the job log only", async () => {
  const r = repos();
  const box = await open(r);
  writeFileSync(join(r.origin, "hooks", "pre-receive"), `#!/bin/sh\necho "GH013: rule violations for refs/heads/factory/1 at secret-path" >&2\nexit 1\n`, { mode: 0o755 });
  r.put(r.work, "app.txt", "v2\n");
  r.run(r.work, "commit", "-q", "-m", "work");
  assert.equal(await box.push(), false);
  assert.equal(box.error, "push rejected: GitHub refused refs/heads/factory/1 (remote rejected, exit 1); its message is in the job log");
  assert.doesNotMatch(box.error, /GH013|secret-path|origin\.git/);
  assert.match(box.detail, /remote rejected/);
});

test("outbox: GitHub's refusal of a workflow file is named with its cause, and its own text stays out of the reason", async () => {
  const r = repos();
  const box = await withWorkflow(r, { protectedList: [] });
  refuseRefLine(r, "refusing to allow a Personal Access Token to create or update workflow .github/workflows/ci.yml without workflow scope");
  r.put(r.work, ".github/workflows/ci.yml", "on: push # the agent's\n");
  r.run(r.work, "commit", "-q", "-m", "widen ci");
  assert.equal(await box.push(), false);
  assert.match(box.error, /^push rejected \(workflow scope\): GitHub refused factory\/1 because it changes \.github\/workflows\/ci\.yml, and Factory's token may not create or update workflow files/);
  assert.doesNotMatch(box.error, /Personal Access Token/);
  assert.match(box.detail, /refusing to allow a Personal Access Token/);
});

test("outbox: a refusal that only mentions a workflow (a remote: line, another reason) is a plain refusal", async () => {
  const r = repos();
  const box = await withWorkflow(r, { protectedList: [] });
  // The phrase on a remote: line only, the ref's line says the hook declined.
  refuseWorkflowVersions(r);
  r.put(r.work, ".github/workflows/ci.yml", "on: push # the agent's\n");
  r.run(r.work, "commit", "-q", "-m", "widen ci");
  assert.equal(await box.push(), false);
  assert.equal(box.error, "push rejected: GitHub refused refs/heads/factory/1 (remote rejected, exit 1); its message is in the job log");
  // Another reason on the ref's line that names a workflow.
  const r2 = repos();
  const box2 = await withWorkflow(r2, { protectedList: [] });
  refuseRefLine(r2, "workflow runs are disabled for this ruleset");
  r2.put(r2.work, "app.txt", "v2\n");
  r2.run(r2.work, "commit", "-q", "-m", "work");
  assert.equal(await box2.push(), false);
  assert.equal(box2.error, "push rejected: GitHub refused refs/heads/factory/1 (remote rejected, exit 1); its message is in the job log");
});

test("outbox: a resumed run puts a reused checkout on the branch even when an earlier run left changes the branch now tracks", async () => {
  const r = repos();
  // The first run: the branch from main, one commit, pushed.
  const box1 = await open(r);
  await box1.feed();
  assert.equal((await box1.agentGit(["checkout", "-q", "-B", "factory/1", "refs/remotes/origin/main"])).code, 0);
  r.put(r.work, "app.txt", "v2\n");
  r.run(r.work, "commit", "-q", "-m", "work");
  assert.equal(await box1.push(), true, box1.error);
  // What it left in the checkout: a changed tracked file, a staged new file, an untracked file at a path main adds next.
  writeFileSync(join(r.work, "app.txt"), "half-done\n");
  r.put(r.work, "staged.txt", "s\n");
  mkdirSync(join(r.work, "gen"), { recursive: true });
  writeFileSync(join(r.work, "gen", "out.txt"), "stale\n");
  // Meanwhile main gains that file and the branch merges main and moves on.
  r.put(r.other, "gen/out.txt", "generated\n");
  r.run(r.other, "commit", "-q", "-m", "main adds a generated file");
  r.run(r.other, "push", "-q", "origin", "HEAD:main");
  r.run(r.other, "fetch", "-q", "origin", "factory/1");
  r.run(r.other, "checkout", "-q", "-b", "factory/1", "origin/factory/1");
  r.run(r.other, "merge", "-q", "--no-edit", "main");
  r.put(r.other, "app.txt", "v3\n");
  r.run(r.other, "commit", "-q", "-m", "more");
  r.run(r.other, "push", "-q", "origin", "factory/1");
  const head = r.run(r.other, "rev-parse", "HEAD");
  // The resumed run, in the same checkout.
  const box2 = await open(r);
  assert.equal(box2.resumed, true);
  await box2.feed();
  const on = await box2.putOn("refs/remotes/origin/factory/1");
  assert.deepEqual(on, { code: 0, error: "" });
  assert.equal(r.run(r.work, "rev-parse", "HEAD"), head);
  assert.equal(r.run(r.work, "symbolic-ref", "--short", "HEAD"), "factory/1");
  assert.equal(r.run(r.work, "status", "--porcelain", "--untracked-files=no"), "", "the tracked tree is the branch's");
  assert.equal(r.run(r.work, "show", "HEAD:gen/out.txt"), "generated");
  assert.equal(r.run(r.work, "ls-files", "staged.txt"), "", "the staged leftover is gone");
  // A ref the checkout lacks: git's own first error line, not its last.
  const bad = await box2.putOn("refs/remotes/origin/nope");
  assert.notEqual(bad.code, 0);
  assert.match(bad.error, /nope/);
});

test("gitError: git's first error lines with the paths they list, never its closing line or a credential", () => {
  const untracked = "error: The following untracked working tree files would be overwritten by checkout:\n\tgen/out.txt\n\tgen/two.txt\nPlease move or remove them before you switch branches.\nAborting\n";
  assert.equal(gitError(untracked), "error: The following untracked working tree files would be overwritten by checkout: gen/out.txt, gen/two.txt");
  const changed = "error: Your local changes to the following files would be overwritten by checkout:\n\tapp.txt\nPlease commit your changes or stash them before you switch branches.\nAborting\n";
  assert.equal(gitError(changed), "error: Your local changes to the following files would be overwritten by checkout: app.txt");
  const many = `error: The following untracked working tree files would be overwritten by checkout:\n${Array.from({ length: 9 }, (_, i) => `\tf${i}.txt`).join("\n")}\nAborting\n`;
  assert.equal(gitError(many), "error: The following untracked working tree files would be overwritten by checkout: f0.txt, f1.txt, f2.txt, f3.txt, f4.txt (+4 more)");
  const token = "ghs_" + "a".repeat(36);
  const fatal = `warning: redirecting\nfatal: unable to access 'https://x-access-token:${token}@github.com/o/r.git/': The requested URL returned error: 403\n`;
  const said = gitError(fatal);
  assert.match(said, /^fatal: unable to access 'https:\/\/\*\*\*@github\.com\/o\/r\.git\/'/);
  assert.doesNotMatch(said, /ghs_|x-access-token/);
  assert.doesNotMatch(gitError(`fatal: bad token ${token}\n`), /ghs_/);
  assert.equal(gitError("Aborting\n"), "Aborting", "no error: line: the first line");
  assert.equal(gitError(""), "");
  assert.ok(gitError(`error: ${"x".repeat(1000)}\n`).length <= 300);
});
