import "./temp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

test("outbox: a red first seen on Factory's own catch-up merge gets a fix pass that is not the change's last (#10)", async () => {
  const { validationLoop } = await import("../scripts/lib/session.mjs");
  const r = repos();
  const box = await withWorkflow(r);
  box.author = { name: "factory[bot]", email: "1+factory[bot]@users.noreply.github.com" };
  r.put(r.work, "app.txt", "v2\n");
  r.run(r.work, "commit", "-q", "-m", "work");
  const work = r.run(r.work, "rev-parse", "HEAD");
  r.put(r.other, ".github/workflows/ci.yml", "on: push # v2\n");
  r.run(r.other, "commit", "-q", "-m", "ci v2");
  r.run(r.other, "push", "-q", "origin", "HEAD:main");
  assert.equal(await box.push(), true, box.error);
  const merge = r.run(r.origin, "rev-parse", "factory/1");
  assert.equal(r.run(r.work, "rev-parse", "HEAD"), merge, "the checkout took Factory's merge");
  assert.equal(box.caughtUp(merge), true, "Factory recorded its own merge");
  assert.equal(box.caughtUp(work), false, "the agent's head is not Factory's merge");
  // The last allowed pass (maxPasses 1) is red on the merge: it still gets its fix run. Under a minute left, the fix
  // run is reached but never started (the loop returns the time cap instead of running a harness).
  const loop = () => validationLoop({ checkout: r.work, commands: ["false"], harness: "codex", maxUsd: 0, session: {}, taskCard: "", env: { ...process.env, ...quiet }, deadlineAt: Date.now() + 30_000, maxPasses: 1, outbox: box });
  const onMerge = await loop();
  assert.deepEqual(onMerge.harness, { timedOut: true }, "the red on the catch-up merge went on to a fix run");
  assert.equal(onMerge.passes, 1);
  // The agent's own commit on top of the merge is the change's: red on the last pass, it stops there as before.
  r.put(r.work, "app.txt", "v3\n");
  r.run(r.work, "commit", "-q", "-m", "fix");
  assert.equal(await box.push(), true, box.error);
  const fix = r.run(r.origin, "rev-parse", "factory/1");
  assert.equal(box.merged, null);
  assert.equal(box.caughtUp(fix), false);
  const onFix = await loop();
  assert.equal(onFix.harness, undefined, "no fix run past the last pass");
  assert.equal(onFix.green, false);
  assert.equal(onFix.passes, 1);
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

/**
 * #73: a reused checkout whose earlier stage installed the Git LFS filters (required), and whose own git cannot reach LFS
 * storage, as the agent's sandbox cannot (no credential). With git-lfs: the real filters, set up by lfsSetup, and an
 * endpoint that does not exist. Without it: a stand-in required filter that fails as git-lfs does with no credential,
 * unless told to skip the smudge. `media` puts an LFS file into origin: its object in origin's store, its pointer
 * committed on `branch` by someone else. Returns {real, media}.
 */
async function lfsCheckout(r) {
  const real = !!(await lfsVersion());
  r.put(r.other, ".gitattributes", "assets/** filter=lfs diff=lfs merge=lfs -text\n");
  r.run(r.other, "commit", "-q", "-m", "lfs");
  r.run(r.other, "push", "-q", "origin", "HEAD:main");
  if (real) {
    const box = await open(r);
    await box.feed();
    assert.deepEqual(await box.putOn("refs/remotes/origin/main"), { code: 0, error: "" });
    assert.equal((await box.lfsSetup(box.base)).used, true);
    r.run(r.work, "config", "lfs.url", `file://${join(r.root, "no-lfs-storage")}`);
  } else {
    const fake = join(r.root, "fake-lfs-smudge");
    writeFileSync(fake, `#!/bin/sh\nif [ "$GIT_LFS_SKIP_SMUDGE" = 1 ]; then exec cat; fi\necho "fatal: could not read Username for 'https://github.com': terminal prompts disabled" >&2\nexit 1\n`, { mode: 0o755 });
    r.run(r.work, "config", "filter.lfs.smudge", fake);
    r.run(r.work, "config", "filter.lfs.clean", "cat");
    r.run(r.work, "config", "filter.lfs.required", "true");
  }
  const media = (branch, file) => {
    const bytes = randomBytes(3000);
    const oid = createHash("sha256").update(bytes).digest("hex");
    const store = join(r.origin, "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4));
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, oid), bytes);
    r.run(r.other, "fetch", "-q", "origin");
    r.run(r.other, "checkout", "-q", "-B", branch, `origin/${branch}`);
    r.put(r.other, file, `${POINTER_HEAD}\noid sha256:${oid}\nsize 3000\n`);
    r.run(r.other, "commit", "-q", "--no-verify", "-m", `media ${file}`);
    r.run(r.other, "push", "-q", "origin", `HEAD:${branch}`);
    return bytes;
  };
  return { real, media };
}

test("outbox: a resumed checkout with Git LFS filters is put on a branch that gained media it lacks; the media arrives by the hand-over (#73)", async () => {
  const r = repos();
  const { real, media } = await lfsCheckout(r);
  // The first stage: the branch from main, one commit, pushed.
  const box1 = await open(r);
  await box1.feed();
  assert.deepEqual(await box1.putOn("refs/remotes/origin/main"), { code: 0, error: "" });
  r.put(r.work, "app.txt", "v2\n");
  r.run(r.work, "commit", "-q", "-m", "work");
  assert.equal(await box1.push(), true, box1.error);
  // Meanwhile the branch gains media whose object the checkout's store lacks.
  const bytes = media("factory/1", "assets/a.bin");
  const head = r.run(r.other, "rev-parse", "HEAD");
  // The resumed run: Factory's checkout leaves a pointer file and asks LFS storage for nothing.
  const box2 = await open(r);
  await box2.feed();
  assert.deepEqual(await box2.putOn("refs/remotes/origin/factory/1"), { code: 0, error: "" });
  assert.equal(r.run(r.work, "rev-parse", "HEAD"), head);
  assert.match(readFileSync(join(r.work, "assets/a.bin"), "utf8"), /^version https:\/\/git-lfs\.github\.com\/spec\/v1\n/);
  if (!real) return;
  // Then the hand-over: the object from Factory's mirror, the real file in the checkout, nothing shown as changed.
  assert.deepEqual(await box2.lfsSetup(box2.expected()), { used: true, ok: true, reason: "", warning: "" });
  assert.deepEqual(readFileSync(join(r.work, "assets/a.bin")), bytes);
  assert.equal(r.run(r.work, "status", "--porcelain", "--untracked-files=no"), "");
});

test("outbox: the checkout takes Factory's catch-up merge of a default branch that gained Git LFS media, then the media (#73)", async () => {
  const r = repos();
  const { real, media } = await lfsCheckout(r);
  const box = await withWorkflow(r);
  r.put(r.work, "app.txt", "v2\n");
  r.run(r.work, "commit", "-q", "-m", "work");
  // Mid-run: the default branch gains media and changes the workflow file, so Factory merges it in before the push.
  const bytes = media("main", "assets/b.bin");
  r.put(r.other, ".github/workflows/ci.yml", "on: push # v2\n");
  r.run(r.other, "commit", "-q", "-m", "ci v2");
  r.run(r.other, "push", "-q", "origin", "HEAD:main");
  assert.equal(await box.push(), true, box.error);
  assert.ok(box.merged, "Factory merged the default branch");
  assert.equal(box.synced, true, "the checkout took the merge");
  assert.equal(r.run(r.work, "rev-parse", "HEAD"), r.run(r.origin, "rev-parse", "factory/1"));
  assert.equal(box.lfsWarning, "");
  if (real) assert.deepEqual(readFileSync(join(r.work, "assets/b.bin")), bytes);
  else assert.match(readFileSync(join(r.work, "assets/b.bin"), "utf8"), /^version https:\/\/git-lfs\.github\.com\/spec\/v1\n/);
});

const isPointer = (r, file) => readFileSync(join(r.work, file), "utf8").startsWith(`${POINTER_HEAD}\n`);
const inStore = (r, bytes) => {
  const oid = createHash("sha256").update(bytes).digest("hex");
  try {
    return readFileSync(join(r.work, ".git", "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4), oid)).equals(bytes);
  } catch {
    return false;
  }
};

/** What a git command the harness runs in the checkout said (stdout and stderr), when it must fail. */
const failing = (r, ...a) => {
  try {
    execFileSync("git", ["-C", r.work, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...quiet } });
  } catch (e) {
    return `${e.stdout || ""}${e.stderr || ""}`;
  }
  assert.fail(`git ${a.join(" ")} succeeded`);
};

/** The first stage on factory/1: the branch from main, one commit of app.txt, pushed. */
async function firstStage(r) {
  const box = await open(r);
  await box.feed();
  assert.deepEqual(await box.putOn("refs/remotes/origin/main"), { code: 0, error: "" });
  r.put(r.work, "app.txt", "branch\n");
  r.run(r.work, "commit", "-q", "-m", "work");
  assert.equal(await box.push(), true, box.error);
}

test("outbox: rebase mode puts the checkout on Factory's rebase with the default branch's new media (#76)", async (t) => {
  if (!(await lfsVersion())) return t.skip("git-lfs is not installed");
  const r = repos();
  const { media } = await lfsCheckout(r);
  await firstStage(r);
  // The resumed stage starts, then the default branch gains media (a sibling merged) and Factory rebases onto it.
  const box = await open(r);
  await box.feed();
  assert.deepEqual(await box.putOn("refs/remotes/origin/factory/1"), { code: 0, error: "" });
  assert.equal((await box.lfsSetup(box.expected())).warning, "");
  const bytes = media("main", "assets/b.bin");
  await box.refresh();
  const sha = await box.rebase({ name: "factory", email: "f@f" });
  assert.equal(await box.push({ sha }), true, box.error);
  const on = await box.putOnRebased(sha);
  assert.deepEqual(on, { code: 0, error: "", warning: "" });
  assert.equal(r.run(r.work, "rev-parse", "HEAD"), sha);
  assert.deepEqual(readFileSync(join(r.work, "assets/b.bin")), bytes);
  assert.equal(r.run(r.work, "status", "--porcelain", "--untracked-files=no"), "");
});

test("outbox: lfsHandOver does nothing without LFS routing, and says so when routing arrived after setup or git-lfs is missing (#76)", async (t) => {
  const r = repos();
  await firstStage(r);
  // Neither the branch nor the default branch routes anything through LFS: nothing to do, nothing to say.
  const box = await open(r);
  await box.feed();
  assert.deepEqual(await box.putOn("refs/remotes/origin/factory/1"), { code: 0, error: "" });
  assert.deepEqual(await box.lfsSetup(box.expected()), { used: false, ok: true, reason: "", warning: "" });
  assert.deepEqual(await box.lfsHandOver(box.expected()), { used: false, warning: "" });
  // Mid-stage the default branch starts routing media through LFS; Factory's rebase brings it in.
  const bytes = randomBytes(3000);
  const oid = createHash("sha256").update(bytes).digest("hex");
  mkdirSync(join(r.origin, "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4)), { recursive: true });
  writeFileSync(join(r.origin, "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4), oid), bytes);
  r.run(r.other, "pull", "-q", "origin", "main");
  r.put(r.other, ".gitattributes", "assets/** filter=lfs diff=lfs merge=lfs -text\n");
  r.put(r.other, "assets/c.bin", `${POINTER_HEAD}\noid sha256:${oid}\nsize 3000\n`);
  r.run(r.other, "commit", "-q", "--no-verify", "-m", "lfs media");
  r.run(r.other, "push", "-q", "origin", "HEAD:main");
  await box.refresh();
  const sha = await box.rebase({ name: "factory", email: "f@f" });
  assert.equal(await box.push({ sha }), true, box.error);
  const config = readFileSync(join(r.work, ".git", "config"), "utf8");
  if (await lfsVersion()) {
    const on = await box.putOnRebased(sha);
    assert.equal(on.code, 0, on.error);
    assert.match(on.warning, /^[0-9a-f]{7} routes files through Git LFS, which this stage's checkout was not set up for: its objects are in the checkout's store and the files stay pointers/);
    assert.equal(readFileSync(join(r.work, ".git", "config"), "utf8"), config, "the pinned git config is left alone");
    assert.ok(isPointer(r, "assets/c.bin"));
    assert.ok(inStore(r, bytes), "the object is delivered to the checkout's store");
  }
  // No git-lfs where Factory runs: said, not silent.
  const bin = mkdtempSync(join(r.root, "bin-"));
  symlinkSync(execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim(), join(bin, "git"));
  const path = process.env.PATH;
  process.env.PATH = bin;
  try {
    if (await lfsVersion()) return t.skip("git-lfs sits beside git here: it cannot be hidden");
    const h = await box.lfsHandOver(sha);
    assert.equal(h.used, true);
    assert.match(h.warning, /routes files through Git LFS and git-lfs is not installed here; they stay pointer files$/);
  } finally {
    process.env.PATH = path;
  }
});

test("outbox: a conflict pass's own rebase onto a default branch with new media downloads nothing (#76)", async (t) => {
  if (!(await lfsVersion())) return t.skip("git-lfs is not installed");
  const r = repos();
  const { media } = await lfsCheckout(r);
  await firstStage(r);
  // Someone else's commits on the branch change its media twice: a rebase replays the first version too.
  const v1 = media("factory/1", "assets/a.bin");
  const v2 = media("factory/1", "assets/a.bin");
  // The default branch gains media and a change of app.txt that conflicts with the branch's.
  const b = media("main", "assets/b.bin");
  r.put(r.other, "app.txt", "main\n");
  r.run(r.other, "commit", "-q", "-m", "main's app");
  r.run(r.other, "push", "-q", "origin", "HEAD:main");
  // The send-back stage: Factory's rebase conflicts, so the harness rebases in the checkout itself.
  const box = await open(r);
  await box.feed();
  assert.deepEqual(await box.putOn("refs/remotes/origin/factory/1"), { code: 0, error: "" });
  assert.equal((await box.lfsSetup(box.expected())).warning, "");
  assert.equal(await box.rebase({ name: "factory", email: "f@f" }), null, "Factory's rebase conflicts");
  assert.ok(inStore(r, v1) && inStore(r, v2) && inStore(r, b), "every object the rebase can check out is in the store");
  // The harness's git, as it would run it: no credential, LFS storage out of reach (lfsCheckout), filters required.
  const said = failing(r, "rebase", "refs/remotes/origin/main");
  assert.match(said, /CONFLICT \(content\): Merge conflict in app\.txt/, "the rebase stops on app.txt");
  assert.doesNotMatch(said, /smudge|filter/, "not on media");
  writeFileSync(join(r.work, "app.txt"), "both\n");
  r.run(r.work, "add", "app.txt");
  r.run(r.work, "-c", "core.editor=true", "rebase", "--continue");
  assert.equal(r.run(r.work, "rev-parse", "HEAD~3"), r.run(r.origin, "rev-parse", "main"));
  assert.deepEqual(readFileSync(join(r.work, "assets/a.bin")), v2);
  assert.deepEqual(readFileSync(join(r.work, "assets/b.bin")), b);
});

test("outbox: a catch-up merge that conflicts leaves the default branch's media in the checkout's store for the conflict pass (#76)", async (t) => {
  if (!(await lfsVersion())) return t.skip("git-lfs is not installed");
  const r = repos();
  const { media } = await lfsCheckout(r);
  const box = await withWorkflow(r);
  r.put(r.work, "app.txt", "branch\n");
  r.run(r.work, "commit", "-q", "-m", "work");
  // Mid-run the default branch gains media, changes the workflow file and changes app.txt the other way.
  const bytes = media("main", "assets/b.bin");
  r.put(r.other, ".github/workflows/ci.yml", "on: push # v2\n");
  r.put(r.other, "app.txt", "main\n");
  r.run(r.other, "commit", "-q", "-m", "ci v2, main's app");
  r.run(r.other, "push", "-q", "origin", "HEAD:main");
  assert.equal(await box.push(), false);
  assert.ok(box.conflict, "Factory's merge conflicts: the harness resolves it");
  assert.equal(box.lfsWarning, "");
  assert.ok(inStore(r, bytes));
  // The conflict pass: the default branch handed over, the harness merges it in the checkout.
  await box.feed();
  const said = failing(r, "merge", "--no-edit", "refs/remotes/origin/main");
  assert.match(said, /CONFLICT \(content\): Merge conflict in app\.txt/, "the merge stops on app.txt");
  assert.doesNotMatch(said, /smudge|filter/, "not on media");
  assert.deepEqual(readFileSync(join(r.work, "assets/b.bin")), bytes);
  // A stage past its end hands nothing over and says so.
  const late = await open(r, { deadlineAt: Date.now() - 1 });
  assert.deepEqual(await late.lfsHandOver(null), { used: true, warning: "no time was left in the stage to hand the Git LFS objects over; no time was left in the stage for git lfs checkout; the files stay pointers" });
});

test("outbox: the hand-over downloads only what the checkout's store lacks by oid and size, within the local media limit, and says when time cut git lfs checkout (#79)", async (t) => {
  if (!(await lfsVersion())) return t.skip("git-lfs is not installed");
  const r = repos();
  const { media } = await lfsCheckout(r);
  await firstStage(r);
  const a = media("factory/1", "assets/a.bin");
  const b = media("factory/1", "assets/b.bin");
  const stage = async (extra = {}) => {
    const box = await open(r, extra);
    await box.feed();
    assert.deepEqual(await box.putOn("refs/remotes/origin/factory/1"), { code: 0, error: "" });
    return box;
  };
  const box1 = await stage();
  assert.equal((await box1.lfsSetup(box1.expected())).warning, "");
  assert.ok(inStore(r, a) && inStore(r, b));
  // The next stage in the same clone. a.bin's object is gone from LFS storage: a stage that downloaded it again would
  // fail. The branch gains c.bin, whose oid the checkout's store holds with the wrong size: it is downloaded and
  // replaced, not taken by its name.
  const oid = (bytes) => createHash("sha256").update(bytes).digest("hex");
  rmSync(join(r.origin, "lfs", "objects", oid(a).slice(0, 2), oid(a).slice(2, 4), oid(a)));
  const c = media("factory/1", "assets/c.bin");
  mkdirSync(join(r.work, ".git", "lfs", "objects", oid(c).slice(0, 2), oid(c).slice(2, 4)), { recursive: true });
  writeFileSync(join(r.work, ".git", "lfs", "objects", oid(c).slice(0, 2), oid(c).slice(2, 4), oid(c)), c.subarray(0, 100));
  const box2 = await stage();
  assert.deepEqual(await box2.lfsSetup(box2.expected()), { used: true, ok: true, reason: "", warning: "" });
  assert.ok(inStore(r, a) && inStore(r, b) && inStore(r, c));
  for (const [f, bytes] of [["a", a], ["b", b], ["c", c]]) assert.deepEqual(readFileSync(join(r.work, `assets/${f}.bin`)), bytes);
  // Time runs out before git lfs checkout: said, not skipped silently.
  assert.match((await box2.lfsHandOver(box2.expected(), { timeoutMs: 1 })).warning, /no time was left in the stage for git lfs checkout; the files stay pointers$/);
  // Locally, what a stage downloads counts against FACTORY_LOCAL_MEDIA_MAX_MB.
  const d = media("factory/1", "assets/d.bin");
  process.env.FACTORY_LOCAL_MEDIA_MAX_MB = "0.001";
  try {
    const box3 = await stage({ local: true });
    const lfs = await box3.lfsSetup(box3.expected());
    assert.match(lfs.warning, /^the Git LFS media to download is 0\.0 MB \(1 object\(s\)\), over the local limit of 0\.001 MB \(FACTORY_LOCAL_MEDIA_MAX_MB\)/);
    assert.ok(isPointer(r, "assets/d.bin") && !inStore(r, d));
    assert.deepEqual(readFileSync(join(r.work, "assets/a.bin")), a, "what the store had is still checked out");
  } finally {
    delete process.env.FACTORY_LOCAL_MEDIA_MAX_MB;
  }
});
