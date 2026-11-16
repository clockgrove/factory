import "./temp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { POINTER_HEAD, lfsVersion } from "../scripts/lib/lfs.mjs";
import { openOutbox, parsePointer } from "../scripts/lib/outbox.mjs";
import { KEPT_QUESTION, openKeptCheck } from "../scripts/lib/kept.mjs";
import { gitError } from "../scripts/lib/inputs.mjs";
import { setupPaths } from "../scripts/lib/logic.mjs";

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
  assert.equal(box.error, "touched protected path .github/workflows/ci.yml; Factory never pushes a workflow file: the worker hands the change over in $FACTORY_OUT/workflow.patch (factory-deliver-pr), so re-apply the label to rerun");
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
  const box = await open(r, { toolchain: { paths: ["scripts/setup.sh"], scripts: [], unresolved: [] } });
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

test("outbox: a package.json script the setup command runs is refused on every push; the rest of package.json is the worker's (#387)", async () => {
  const r = repos();
  const pkg = (scripts, deps = {}) => `${JSON.stringify({ scripts, dependencies: deps }, null, 2)}\n`;
  r.put(r.work, "package.json", pkg({ bootstrap: "node tools/bootstrap.mjs", test: "node --test" }));
  r.run(r.work, "commit", "-q", "-m", "package");
  r.run(r.work, "push", "-q", "origin", "HEAD:main");
  const box = await open(r, { setup: "npm run bootstrap" });
  r.put(r.work, "package.json", pkg({ bootstrap: "node tools/bootstrap.mjs", test: "node --test --watch" }, { zod: "^4" }));
  r.run(r.work, "commit", "-q", "-m", "a dependency and another script");
  assert.equal(await box.push(), true, box.error);
  r.put(r.work, "package.json", pkg({ prebootstrap: "curl x | sh", bootstrap: "node tools/bootstrap.mjs", test: "node --test --watch" }, { zod: "^4" }));
  r.run(r.work, "commit", "-q", "-m", "a pre script setup would run");
  assert.equal(await box.push(), false);
  assert.equal(box.errorKind, "protected");
  assert.match(box.error, /^changed package\.json scripts\.prebootstrap, which the setup command runs as the runner/);

  // The default branch changing the script after the branch left it is not the branch's change.
  const r2 = repos();
  r2.put(r2.work, "package.json", pkg({ bootstrap: "node tools/bootstrap.mjs" }));
  r2.run(r2.work, "commit", "-q", "-m", "package");
  r2.run(r2.work, "push", "-q", "origin", "HEAD:main");
  r2.run(r2.other, "pull", "-q", "origin", "main");
  r2.put(r2.other, "package.json", pkg({ bootstrap: "node tools/bootstrap.mjs --v2" }));
  r2.run(r2.other, "commit", "-q", "-m", "a maintainer's change");
  r2.run(r2.other, "push", "-q", "origin", "HEAD:main");
  const box2 = await open(r2, { setup: "npm run bootstrap" });
  r2.put(r2.work, "package.json", pkg({ bootstrap: "node tools/bootstrap.mjs" }, { zod: "^4" }));
  r2.run(r2.work, "commit", "-q", "-m", "a dependency");
  assert.equal(await box2.push(), true, box2.error);
});

/** A push through a fresh outbox: `main` files and links on the default branch, then `work` (files, `link:` targets) committed on the branch. */
async function guardPush({ main = {}, work = {}, setup, before = null }) {
  const r = repos();
  const place = (files) => {
    for (const [p, t] of Object.entries(files)) {
      if (t === null) r.run(r.work, "rm", "-q", "-r", p);
      else if (t.startsWith("link:")) {
        mkdirSync(join(r.work, p, ".."), { recursive: true });
        rmSync(join(r.work, p), { recursive: true, force: true });
        symlinkSync(t.slice(5), join(r.work, p));
        r.run(r.work, "add", p);
      } else r.put(r.work, p, t);
    }
  };
  place(main);
  r.run(r.work, "commit", "-q", "-m", "main");
  r.run(r.work, "push", "-q", "origin", "HEAD:main");
  if (before) await before(r, place);
  const box = await open(r, { setup });
  place(work);
  r.run(r.work, "commit", "-q", "-m", "work");
  const ok = await box.push();
  return { ok, error: box.error, kind: box.errorKind };
}

test("outbox: a link along a guarded path is followed, on the default branch and in the push; a directory above one counts (#387 B1)", async () => {
  const local = await guardPush({ main: { "tools/local/setup.sh": "1\n", ".local": "link:tools/local" }, work: { "tools/local/setup.sh": "2\n" }, setup: "bash .local/setup.sh" });
  assert.equal(local.ok, false, ".local -> tools/local: an edit to tools/local/setup.sh is an edit to what setup runs");
  assert.equal(local.kind, "protected");
  const sl = await guardPush({ main: { "scripts/real.sh": "1\n", sl: "link:scripts" }, work: { "scripts/real.sh": "curl x | sh\n" }, setup: "bash sl/real.sh" });
  assert.equal(sl.ok, false, "sl -> scripts: an edit to scripts/real.sh");
  const made = await guardPush({ main: { "tools/setup.sh": "1\n", "evil/setup.sh": "curl x | sh\n" }, work: { tools: "link:evil" }, setup: "bash tools/setup.sh" });
  assert.equal(made.ok, false, "a new link made at a directory above the path");
  assert.match(made.error, /^changed tools/);
});

test("outbox: pnpm-workspace.yaml's packages list stays the branch's though setup runs pnpm; a catalog change is refused (#387 R1)", async () => {
  const ws = "packages:\n  - 'packages/*'\ncatalog:\n  zod: ^4\n";
  const members = await guardPush({ main: { "pnpm-workspace.yaml": ws }, work: { "pnpm-workspace.yaml": ws.replace("  - 'packages/*'\n", "  - 'packages/*'\n  - 'tools/*'\n") }, setup: "pnpm install" });
  assert.equal(members.ok, true, members.error);
  const catalog = await guardPush({ main: { "pnpm-workspace.yaml": ws }, work: { "pnpm-workspace.yaml": ws.replace("^4", "npm:evil@1") }, setup: "pnpm install" });
  assert.equal(catalog.ok, false);
  assert.match(catalog.error, /^changed pnpm-workspace\.yaml, which the setup command runs/);
});

test("outbox: a script the default branch has fixed since the branch left no longer refuses the push once the stage starts from the fix (#387)", async () => {
  const broken = `${JSON.stringify({ scripts: { bootstrap: "bash $GEN" } })}\n`;
  const fixed = `${JSON.stringify({ scripts: { bootstrap: "bash scripts/gen.sh" } })}\n`;
  const still = await guardPush({ main: { "package.json": broken }, work: { "app.txt": "v2\n" }, setup: "npm run bootstrap" });
  assert.equal(still.ok, false, "unresolved where the branch left and at the start");
  const moved = await guardPush({
    main: { "package.json": broken },
    work: { "app.txt": "v2\n" },
    setup: "npm run bootstrap",
    // The default branch fixes it, and the branch, already pushed, carries the same fix (its stage start) unmerged.
    before: async (r, place) => {
      r.run(r.work, "fetch", "-q", "origin");
      r.run(r.work, "checkout", "-q", "-b", "trunk-fix", "origin/main");
      place({ "package.json": fixed });
      r.run(r.work, "commit", "-q", "-m", "fix");
      r.run(r.work, "push", "-q", "origin", "HEAD:main");
      r.run(r.work, "checkout", "-q", "factory/1");
      place({ "package.json": fixed });
      r.run(r.work, "commit", "-q", "-m", "same fix");
      r.run(r.work, "push", "-q", "origin", "HEAD:factory/1");
    },
  });
  assert.equal(moved.ok, true, moved.error);
});

test("outbox: what setup runs beyond the files it names is refused on push: a script's files, a path it names that is not there yet, a new package's script setup does not run is not (#387)", async () => {
  const r = repos();
  r.put(r.work, "package.json", `${JSON.stringify({ scripts: { bootstrap: "node tools/boot.mjs" } })}\n`);
  r.put(r.work, "tools/boot.mjs", "1\n");
  r.run(r.work, "commit", "-q", "-m", "package");
  r.run(r.work, "push", "-q", "origin", "HEAD:main");
  const push = async (files, setup = "npm run bootstrap && bash scripts/later.sh") => {
    const r2 = repos();
    for (const [p, t] of Object.entries({ "package.json": `${JSON.stringify({ scripts: { bootstrap: "node tools/boot.mjs" } })}\n`, "tools/boot.mjs": "1\n" })) r2.put(r2.work, p, t);
    r2.run(r2.work, "commit", "-q", "-m", "package");
    r2.run(r2.work, "push", "-q", "origin", "HEAD:main");
    const box = await open(r2, { setup });
    for (const [p, t] of Object.entries(files)) r2.put(r2.work, p, t);
    r2.run(r2.work, "commit", "-q", "-m", "work");
    const ok = await box.push();
    return { ok, error: box.error, kind: box.errorKind };
  };
  const card = await (await open(r, { setup: "npm run bootstrap" })).setupFiles();
  assert.ok(card.files.includes("tools/boot.mjs") && card.scripts.some((x) => x.name === "bootstrap"), "the outbox reads what setup runs for the cards, on the default branch");
  const script = await push({ "tools/boot.mjs": "2\n" });
  assert.equal(script.ok, false);
  assert.equal(script.kind, "protected");
  assert.match(script.error, /^changed tools\/boot\.mjs, which the setup command runs/, "a file the script setup runs names");
  const created = await push({ "scripts/later.sh": "curl x | sh\n" });
  assert.equal(created.ok, false, "a path setup names that the default branch does not hold yet");
  const member = await push({ "web/package.json": `${JSON.stringify({ scripts: { bootstrap: "curl x | sh" } })}\n`, "app.txt": "v2\n" });
  assert.equal(member.ok, true, member.error);
  const unknown = await push({ "app.txt": "v2\n" }, "bash $SETUP");
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /^the setup command runs \$SETUP .*which Factory cannot resolve/);
});

test("outbox: a fix pass may not change the install command's package.json script, and with a command Factory cannot resolve, no file out of scope (#387)", async () => {
  const r = repos();
  r.put(r.work, "package.json", '{"scripts":{"deps":"node deps.mjs"}}\n');
  r.run(r.work, "commit", "-q", "-m", "package");
  r.run(r.work, "push", "-q", "origin", "HEAD:main");
  const box = await open(r, { toolchain: setupPaths({ install: "npm run deps" }) });
  await box.fence({ plan: "1. owns `app.txt`", texts: ["FAIL app.txt:1 expected v3"] });
  r.put(r.work, "app.txt", "v3\n");
  r.put(r.work, "package.json", '{"scripts":{"deps":"true"}}\n');
  r.run(r.work, "commit", "-q", "-m", "fix, and skip the install");
  assert.deepEqual(await box.outside(), ["package.json scripts.deps"]);

  const r2 = repos();
  const unknown = setupPaths({ setup: "bash $SETUP" });
  const box2 = await open(r2, { toolchain: unknown });
  await box2.fence({ plan: "1. owns `app.txt`", texts: ["FAIL app.txt:1 expected v3"] });
  r2.put(r2.work, "app.txt", "v3\n");
  r2.put(r2.work, "lib/util.sh", "echo\n");
  r2.run(r2.work, "commit", "-q", "-m", "fix, and a file setup may run");
  assert.deepEqual(await box2.outside(), ["lib/util.sh"]);
  assert.equal(await box2.push(), false);
  assert.match(box2.error, /The setup or install command runs \$SETUP .*which Factory cannot resolve/);
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
  // #318: git's cause, and no path on this machine (index-pack can name the mirror's pack).
  assert.match(box.error, /^the agent's bundle failed Factory's object check \(exit \d+\): .*fatal: fsck error in packed object; (this machine's|the job) log has its output$/);
  assert.ok(!box.error.includes(r.root), box.error);
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

test("outbox: Factory records its own catch-up merge, and a red on it goes on to a fix pass (#10)", async () => {
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
  // The red on the merge goes on to its fix run. Under a minute left, the fix run is reached but never started (the
  // loop returns the time cap instead of running a harness). That such a red is never judged for progress: triage.test.mjs.
  const onMerge = await validationLoop({ checkout: r.work, commands: ["false"], harness: "codex", maxUsd: 0, session: {}, taskCard: "", env: { ...process.env, ...quiet }, deadlineAt: Date.now() + 30_000, outbox: box });
  assert.deepEqual(onMerge.harness, { timedOut: true }, "the red on the catch-up merge went on to a fix run");
  assert.equal(onMerge.passes, 1);
  // The agent's own commit on top of the merge is the change's, not Factory's merge.
  r.put(r.work, "app.txt", "v3\n");
  r.run(r.work, "commit", "-q", "-m", "fix");
  assert.equal(await box.push(), true, box.error);
  const fix = r.run(r.origin, "rev-parse", "factory/1");
  assert.equal(box.merged, null);
  assert.equal(box.caughtUp(fix), false);
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

test("#318: a failed git command Blocks with git's cause, every absolute path on this machine replaced; the log has it all", async () => {
  const { commandFailed, logName, logTo, withoutLocalPaths } = await import("../scripts/lib/inputs.mjs");
  const { exec } = await import("../scripts/lib/proc.mjs");
  const { createServer } = await import("node:http");
  const r = repos();
  const env = { ...process.env, ...quiet, GIT_TERMINAL_PROMPT: "0" };
  const lines = [];
  logTo({ write: (l) => lines.push(l) });
  // A server that refuses every credential, as GitHub does a revoked token.
  const server = createServer((_, res) => res.writeHead(401, { "WWW-Authenticate": 'Basic realm="x"' }).end());
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const outside = join(mkdtempSync(join(tmpdir(), "srv-")), "checkout");
  let missing, denied, gone;
  try {
    missing = commandFailed("git fetch in Factory's mirror failed", await exec("git", ["-C", r.work, "fetch", "-q", "origin", "refs/heads/nope"], { env })).message;
    denied = commandFailed("the branch on GitHub could not be read", await exec("git", ["-c", "credential.helper=", "ls-remote", `http://x-access-token:not-a-real-token@127.0.0.1:${server.address().port}/acme/app.git`], { env })).message;
    gone = commandFailed("git status in the checkout failed", await exec("git", ["-C", outside, "status"], { env })).message;
  } finally {
    logTo(null);
    server.close();
  }
  const pointer = "; (this machine's|the job) log has its output$";
  assert.match(missing, new RegExp(`^git fetch in Factory's mirror failed \\(exit 128\\): fatal: couldn't find remote ref refs/heads/nope${pointer}`), "a missing ref keeps its cause");
  assert.match(denied, new RegExp(`^the branch on GitHub could not be read \\(exit 128\\): fatal: Authentication failed for 'http://127\\.0\\.0\\.1:\\d+/acme/app\\.git/'${pointer}`), "an auth failure keeps its cause");
  assert.doesNotMatch(denied, /not-a-real-token/);
  assert.match(gone, new RegExp(`fatal: cannot change to '<path>': No such file or directory${pointer}`), "a path outside the home is replaced");
  assert.ok(!gone.includes(outside));
  assert.ok(lines.some((l) => l.includes(outside)), "the log has the path");
  assert.equal(withoutLocalPaths("error: unable to unlink /srv/app/.git/index.lock; see https://github.com/o/r and gen/a.png"), "error: unable to unlink <path>; see https://github.com/o/r and gen/a.png");
  // A quoted path whole, its spaces and commas included; a file: URL is a path.
  assert.equal(withoutLocalPaths("fatal: Unable to create '/srv/my repo/.git/index.lock': File exists."), "fatal: Unable to create '<path>': File exists.");
  assert.equal(withoutLocalPaths('error: cannot open "/home/Kirk Marple/clone/a, b.txt": denied'), 'error: cannot open "<path>": denied');
  assert.equal(withoutLocalPaths("error: /srv/a/x.txt, /srv/b/y.txt and gen/a.png"), "error: <path>, <path> and gen/a.png");
  assert.equal(withoutLocalPaths("fatal: repository 'file:///home/kirk/work/mirror/' not found"), "fatal: repository '<path>' not found");
  assert.equal(withoutLocalPaths("fetch file:///srv/m.git failed"), "fetch <path> failed");
  assert.equal(logName({ FACTORY_LOCAL: "1", GITHUB_ACTIONS: "true" }), "this machine's log");
  assert.equal(logName({ GITHUB_ACTIONS: "true" }), "the job log");
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

test("outbox: the hand-over downloads only what the checkout's store lacks by oid and size, and says when time cut git lfs checkout (#79)", async (t) => {
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
});

test("outbox: a large working set is handed over whole: FACTORY_LOCAL_MEDIA_MAX_MB caps what a branch pushes, not what a stage downloads (#79)", async (t) => {
  if (!(await lfsVersion())) return t.skip("git-lfs is not installed");
  const r = repos();
  await lfsCheckout(r);
  // main gains 40 media files, far over the local limit set below.
  const files = [];
  r.run(r.other, "pull", "-q", "origin", "main");
  for (let i = 0; i < 40; i += 1) {
    const bytes = randomBytes(3000);
    const oid = createHash("sha256").update(bytes).digest("hex");
    mkdirSync(join(r.origin, "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4)), { recursive: true });
    writeFileSync(join(r.origin, "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4), oid), bytes);
    r.put(r.other, `assets/m${i}.bin`, `${POINTER_HEAD}\noid sha256:${oid}\nsize 3000\n`);
    files.push([`assets/m${i}.bin`, bytes]);
  }
  r.run(r.other, "commit", "-q", "--no-verify", "-m", "much media");
  r.run(r.other, "push", "-q", "origin", "HEAD:main");
  process.env.FACTORY_LOCAL_MEDIA_MAX_MB = "0.001";
  try {
    const box = await open(r, { local: true });
    await box.feed();
    assert.deepEqual(await box.putOn("refs/remotes/origin/main"), { code: 0, error: "" });
    assert.deepEqual(await box.lfsSetup(box.base), { used: true, ok: true, reason: "", warning: "" });
    for (const [f, bytes] of files) assert.deepEqual(readFileSync(join(r.work, f)), bytes, f);
  } finally {
    delete process.env.FACTORY_LOCAL_MEDIA_MAX_MB;
  }
});

test("outbox: a tree read the hand-over cannot take whole is said, not dropped silently (#79)", async (t) => {
  if (!(await lfsVersion())) return t.skip("git-lfs is not installed");
  const r = repos();
  const { media } = await lfsCheckout(r);
  media("main", "assets/a.bin");
  const box = await open(r, { readMaxBytes: 64 });
  await box.feed();
  assert.deepEqual(await box.putOn("refs/remotes/origin/main"), { code: 0, error: "" });
  const lfs = await box.lfsSetup(box.base);
  assert.match(lfs.warning, /^the tree of [0-9a-f]{7} could not be read whole \(over 64 bytes\), so some Git LFS files may stay pointers/);
});

test("outbox: a branch's lfs.fetchinclude does not filter the hand-over's download (#79)", async (t) => {
  if (!(await lfsVersion())) return t.skip("git-lfs is not installed");
  const r = repos();
  const { media } = await lfsCheckout(r);
  const box = await open(r);
  await box.feed();
  assert.deepEqual(await box.putOn("refs/remotes/origin/main"), { code: 0, error: "" });
  assert.equal((await box.lfsSetup(box.base)).warning, "");
  // The branch's .lfsconfig limits fetches to paths no media has; once pushed, Factory's mirror reads it from its HEAD.
  r.put(r.work, ".lfsconfig", "[lfs]\n\tfetchinclude = nothing/**\n");
  r.run(r.work, "commit", "-q", "-m", "fetch filter");
  assert.equal(await box.push(), true, box.error);
  const bytes = media("main", "assets/b.bin");
  await box.refresh();
  assert.deepEqual(await box.lfsHandOver(null), { used: true, warning: "" });
  assert.ok(inStore(r, bytes), "the default branch's media is in the checkout's store");
});

/**
 * #243: a send-back whose rebase conflicts. The branch has three commits (app.txt, b.txt, c.txt); main changed app.txt
 * and b.txt the other way and added the same c.txt, so git drops that commit as already upstream. The worker's
 * conflict pass then ends in `pass` in the checkout; rebaseLeft says whether that is the branch rebased onto main.
 */
async function conflictPass(pass, judge = null) {
  const r = repos();
  r.put(r.work, "app.txt", "ours\n");
  r.run(r.work, "commit", "-q", "-m", "c1");
  r.put(r.work, "b.txt", "ours-b\n");
  r.run(r.work, "commit", "-q", "-m", "c2");
  r.put(r.work, "c.txt", "same\n");
  r.run(r.work, "commit", "-q", "-m", "c3");
  r.run(r.work, "push", "-q", "origin", "HEAD:factory/1");
  r.put(r.other, "app.txt", "theirs\n");
  r.put(r.other, "b.txt", "theirs-b\n");
  r.put(r.other, "c.txt", "same\n");
  r.run(r.other, "commit", "-q", "-m", "sibling");
  r.run(r.other, "push", "-q", "origin", "HEAD:main");
  const box = await open(r);
  const from = box.expected();
  assert.equal(await box.rebase({ name: "factory", email: "f@f" }), null, "Factory's own rebase conflicts");
  const onto = box.base;
  r.run(r.work, "fetch", "-q", "origin", "main");
  assert.throws(() => r.run(r.work, "rebase", "-q", "origin/main"), "the conflict pass meets the conflict on c1");
  const resolve = (file, text) => {
    writeFileSync(join(r.work, file), text);
    r.run(r.work, "add", file);
  };
  const go = (...a) => execFileSync("git", ["-C", r.work, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8", env: { ...process.env, ...quiet, GIT_EDITOR: "true" }, stdio: "pipe" });
  await pass({ resolve, go, r });
  return { box, r, from, onto, left: await box.rebaseLeft({ from, onto, judge }) };
}

/**
 * A fake decision client behind the real judge (kept.mjs openKeptCheck): it answers each path's question from
 * `verdicts` (a path to "kept", "lost", "error" or a confidence for "kept"; any other path gets `fallback`) and records
 * what it was asked.
 */
function fakeJudge(verdicts = {}, fallback = "kept") {
  const asked = [];
  const decider = {
    name: "fake",
    model: "fake/model",
    async decide(input, question) {
      const path = /\nFile:\n<<<BEGIN [0-9a-f]{16}>>>\n(.+)\n<<<END [0-9a-f]{16}>>>\n/.exec(input)[1];
      asked.push({ path, input, question });
      const v = verdicts[path] ?? fallback;
      if (v === "error") return { verdict: null, confidence: null, error: "unavailable" };
      return typeof v === "number" ? { verdict: "kept", confidence: v } : { verdict: v, confidence: 0.9 };
    },
  };
  return { asked, judge: openKeptCheck({ inputs: { triageModel: "fake/model" }, decider }).judge };
}

test("outbox: rebaseLeft reads what a send-back's conflict pass left: resolved, aborted, stopped on the first or second commit, or a commit skipped (#243, #362)", async () => {
  // Resolved: both conflicts resolved and the rebase finished; c3 dropped by git as already upstream is no loss. The
  // resolutions reshaped app.txt and b.txt, so the decision model is asked about those two paths only, and says kept.
  const resolve2 = async ({ resolve, go }) => {
    resolve("app.txt", "ours and theirs\n");
    assert.throws(() => go("rebase", "--continue"), "c2 conflicts next");
    resolve("b.txt", "ours-b and theirs-b\n");
    go("rebase", "--continue");
  };
  const kept = fakeJudge();
  const ok = await conflictPass(resolve2, kept.judge);
  assert.equal(ok.left, "", ok.left);
  assert.deepEqual(kept.asked.map((a) => a.path).sort(), ["app.txt", "b.txt"], "asked about the reshaped paths only");
  assert.equal(await ok.box.push(), true, ok.box.error);

  // The same resolution with no decision model (no key): the commits are matched as before, and it goes out.
  const unjudged = await conflictPass(resolve2);
  assert.equal(unjudged.left, "", unjudged.left);

  // Aborted: the branch is as it was, not on main.
  const aborted = await conflictPass(async ({ go }) => go("rebase", "--abort"));
  assert.equal(aborted.left, "the branch it left is not rebased onto it");

  // Stopped on the first commit: HEAD is main itself, with the rebase in progress.
  const first = await conflictPass(async () => {});
  assert.equal(first.left, "the conflict pass left a rebase in progress");

  // Stopped on the second: HEAD is main plus c1, which a push would have sent as the whole branch.
  const second = await conflictPass(async ({ resolve, go }) => {
    resolve("app.txt", "ours and theirs\n");
    assert.throws(() => go("rebase", "--continue"));
  });
  assert.equal(second.left, "the conflict pass left a rebase in progress");

  // Skipped: c1 dropped with `rebase --skip`, c2 resolved, the rebase finished. Contains main, yet c1's change to
  // app.txt is lost: the decision model says so, and the Block names the path and the commit.
  const skip = async ({ resolve, go }) => {
    assert.throws(() => go("rebase", "--skip"));
    resolve("b.txt", "ours-b and theirs-b\n");
    go("rebase", "--continue");
  };
  const lost = fakeJudge({ "app.txt": "lost" });
  const skipped = await conflictPass(skip, lost.judge);
  const c1 = skipped.r.run(skipped.r.work, "rev-parse", "--short=7", `${skipped.from}~2`);
  assert.equal(skipped.left, `the branch it left drops the Objective's change to 1 path(s): app.txt (${c1}): the decision model (fake/model) judged it lost at 0.90`);
  // With no key, the commit match names c1 as before.
  const keyless = await conflictPass(skip);
  assert.match(keyless.left, /^the branch it left drops 1 of the Objective's commit\(s\) \([0-9a-f]{7}\); with an AI Gateway key Factory decides this on content$/);
});

test("outbox: rebaseLeft checks the base the rebase was onto, not one the default branch moved to since (a catch-up merge) (#243)", async () => {
  const { judge } = fakeJudge();
  const done = await conflictPass(async ({ resolve, go }) => {
    resolve("app.txt", "ours and theirs\n");
    assert.throws(() => go("rebase", "--continue"));
    resolve("b.txt", "ours-b and theirs-b\n");
    go("rebase", "--continue");
  }, judge);
  // main moves again (a workflow change a push would merge in): the outbox's base moves with it.
  done.r.put(done.r.other, ".github/workflows/ci.yml", "on: push\n");
  done.r.run(done.r.other, "commit", "-q", "-m", "workflow");
  done.r.run(done.r.other, "push", "-q", "origin", "HEAD:main");
  await done.box.refresh();
  assert.notEqual(done.box.base, done.onto);
  assert.ok((await done.box.behind()) > 0, "counted against the moved base, the branch reads behind");
  assert.equal(await done.box.rebaseLeft({ from: done.from, onto: done.onto, judge }), "", "yet it is rebased onto the base it was sent for");
});

test("outbox: rebaseLeft counts a dropped commit as upstream only when its patch is in the head, and an empty commit as no counterpart (#243)", async () => {
  // c1 changes app.txt, c2 changes doc.txt (which main changed too: the conflict), c3 undoes c1. The pass resolves c2
  // and then drops the undo: whole-file, app.txt is main's again in c3, yet the head still carries c1's change.
  const r = repos();
  r.put(r.work, "doc.txt", "d1\n");
  r.run(r.work, "commit", "-q", "-m", "doc");
  r.run(r.work, "push", "-q", "origin", "HEAD:main");
  r.run(r.other, "pull", "-q", "origin", "main");
  r.put(r.work, "app.txt", "ours\n");
  r.run(r.work, "commit", "-q", "-m", "c1");
  r.put(r.work, "doc.txt", "ours-doc\n");
  r.run(r.work, "commit", "-q", "-m", "c2");
  r.put(r.work, "app.txt", "v1\n");
  r.run(r.work, "commit", "-q", "-m", "c3 undoes c1");
  r.run(r.work, "push", "-q", "origin", "HEAD:factory/1");
  r.put(r.other, "doc.txt", "theirs-doc\n");
  r.run(r.other, "commit", "-q", "-m", "sibling");
  r.run(r.other, "push", "-q", "origin", "HEAD:main");
  const box = await open(r);
  const from = box.expected();
  assert.equal(await box.rebase({ name: "factory", email: "f@f" }), null);
  const onto = box.base;
  const go = (...a) => execFileSync("git", ["-C", r.work, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8", env: { ...process.env, ...quiet, GIT_EDITOR: "true" }, stdio: "pipe" });
  go("fetch", "-q", "origin", "main");
  assert.throws(() => go("rebase", "-q", "origin/main"));
  writeFileSync(join(r.work, "doc.txt"), "ours and theirs\n");
  go("add", "doc.txt");
  go("rebase", "--continue");
  go("reset", "-q", "--hard", "HEAD~1");
  assert.equal(readFileSync(join(r.work, "app.txt"), "utf8"), "ours\n", "the head carries c1's change without its undo");
  assert.match(await box.rebaseLeft({ from, onto }), /^the branch it left drops 1 of the Objective's commit\(s\)/);

  // A forged empty commit with c3's author, time and subject (`commit --allow-empty -C`) is no counterpart for it.
  go("commit", "-q", "--allow-empty", "-C", from);
  assert.match(await box.rebaseLeft({ from, onto }), /^the branch it left drops 1 of the Objective's commit\(s\)/);
  // The undo kept: the branch is whole.
  go("reset", "-q", "--hard", "HEAD~1");
  go("cherry-pick", from);
  assert.equal(await box.rebaseLeft({ from, onto }), "");

  // With a decision model it is decided on the branch's net change, which leaves app.txt as main has it: dropping the
  // undo keeps c1's change in the head, an extra change for the review to read, and no change of the branch is lost.
  const { asked, judge } = fakeJudge();
  go("reset", "-q", "--hard", "HEAD~1");
  assert.equal(await box.rebaseLeft({ from, onto, judge }), "");
  assert.deepEqual(asked.map((x) => x.path), ["doc.txt"], "only the reshaped doc.txt is asked about");
  // Said on the progress comment, not a Block.
  assert.equal(box.rebaseNote, "the branch's commits changed app.txt and undid it, yet the head changes it: an extra change for the review, not a loss");
  const { sendBackGuard } = await import("../scripts/worker.mjs");
  const said = [];
  assert.equal(await sendBackGuard({ outbox: box, onto: { from, base: onto, files: ["doc.txt"] }, defaultBranch: "main", judge, progress: async (line) => said.push(line) }), "");
  assert.deepEqual(said, [`rebase check: ${box.rebaseNote}`]);
  // Without a key the commit match Blocks the same head: then no note goes up.
  const quiet2 = [];
  assert.match(await sendBackGuard({ outbox: box, onto: { from, base: onto, files: ["doc.txt"] }, defaultBranch: "main", judge: null, progress: async (line) => quiet2.push(line) }), /drops 1 of the Objective's commit/);
  assert.deepEqual(quiet2, []);
});

/**
 * #362: a branch of two commits whose rebase onto main conflicts. c1 changes line 6 of app.txt (main changed line 3:
 * no conflict, but the context of c1's patch moved) and conf.txt (which main changes too with `confOnMain`: a conflict);
 * c2 deletes old.txt, which main edited and listed in registry.txt (a conflict). Returns what `pass` left, read by
 * rebaseLeft with `judge`.
 */
async function rebasedBranch(pass, judge = null, { confOnMain = true } = {}) {
  const r = repos();
  const lines = (at, text) => Array.from({ length: 10 }, (_, i) => (i + 1 === at ? text : `l${i + 1}`)).join("\n") + "\n";
  r.put(r.work, "app.txt", lines(0));
  r.put(r.work, "conf.txt", "a=1\n");
  r.put(r.work, "old.txt", "old\n");
  r.run(r.work, "commit", "-q", "-m", "base files");
  r.run(r.work, "push", "-q", "origin", "HEAD:main");
  r.run(r.other, "pull", "-q", "origin", "main");
  r.put(r.work, "app.txt", lines(6, "L6 objective"));
  r.put(r.work, "conf.txt", "a=objective\n");
  r.run(r.work, "commit", "-q", "-m", "c1");
  r.run(r.work, "rm", "-q", "old.txt");
  r.run(r.work, "commit", "-q", "-m", "c2 removes old.txt");
  r.run(r.work, "push", "-q", "origin", "HEAD:factory/1");
  r.put(r.other, "app.txt", lines(3, "L3 main"));
  r.put(r.other, "old.txt", "old, edited\n");
  r.put(r.other, "registry.txt", "old.txt\n");
  if (confOnMain) r.put(r.other, "conf.txt", "a=main\n");
  r.run(r.other, "commit", "-q", "-m", "sibling");
  r.run(r.other, "push", "-q", "origin", "HEAD:main");
  const box = await open(r);
  const from = box.expected();
  assert.equal(await box.rebase({ name: "factory", email: "f@f" }), null, "Factory's own rebase conflicts");
  const onto = box.base;
  const go = (...a) => execFileSync("git", ["-C", r.work, "-c", "user.email=w@w", "-c", "user.name=w", ...a], { encoding: "utf8", env: { ...process.env, ...quiet, GIT_EDITOR: "true" }, stdio: "pipe" });
  go("fetch", "-q", "origin", "main");
  await pass({ go, r, from });
  return { box, r, from, onto, left: await box.rebaseLeft({ from, onto, judge }) };
}

test("outbox: a squashed rebase that keeps the Objective's work, with a commit joining it to main's, is delivered on content alone (#362)", async () => {
  const { asked, judge } = fakeJudge({}, "lost");
  const squash = async ({ go, r }) => {
    // c2 conflicts with main's edit of old.txt: the Objective deletes it.
    assert.throws(() => go("rebase", "-q", "origin/main"));
    go("rm", "-q", "old.txt");
    go("rebase", "--continue");
    // Squashed under the worker's own name and time, then a commit taking old.txt out of main's registry.
    go("reset", "-q", "--soft", "origin/main");
    go("commit", "-q", "-m", "The Objective's work");
    writeFileSync(join(r.work, "registry.txt"), "");
    go("commit", "-q", "-am", "Join main's registry");
  };
  const done = await rebasedBranch(squash, judge, { confOnMain: false });
  assert.equal(done.left, "", done.left);
  assert.deepEqual(asked, [], "every change is in the head as written: no decision model call");
  assert.equal(await done.box.push(), true, done.box.error);
  assert.equal(done.r.run(done.r.origin, "rev-parse", "factory/1"), done.r.run(done.r.work, "rev-parse", "HEAD"));
  // No key: decided on content all the same, before any commit match.
  assert.equal((await rebasedBranch(squash, null, { confOnMain: false })).left, "");
});

test("outbox: a resolution that keeps a commit but takes main's side of its conflict drops its change, named by the decision model (#362)", async () => {
  const takeMain = async ({ go }) => {
    // Rebased with each commit's author, time and subject kept; c1's conflict on conf.txt resolved as main has it.
    assert.throws(() => go("rebase", "-q", "origin/main"));
    go("checkout", "-q", "--ours", "conf.txt");
    go("add", "conf.txt");
    assert.throws(() => go("rebase", "--continue"));
    go("rm", "-q", "old.txt");
    go("rebase", "--continue");
  };
  const { asked, judge } = fakeJudge({}, "lost");
  const lost = await rebasedBranch(takeMain, judge);
  const c1 = lost.r.run(lost.r.work, "rev-parse", "--short=7", `${lost.from}~1`);
  assert.equal(lost.left, `the branch it left drops the Objective's change to 1 path(s): conf.txt (${c1}): the decision model (fake/model) judged it lost at 0.90`);
  assert.deepEqual(asked.map((a) => a.path), ["conf.txt"], "only conf.txt is not the branch's version");
  const { input, question } = asked[0];
  assert.equal(question, KEPT_QUESTION);
  const tag = /<<<BEGIN ([0-9a-f]{16})>>>/.exec(input)[1];
  assert.match(input, new RegExp(`^The rebase conflicted on this file:\\nFile:\\n<<<BEGIN ${tag}>>>\\nconf\\.txt\\n<<<END ${tag}>>>\\n\\nThe branch's change before the rebase:\\n<<<BEGIN ${tag}>>>\\ndiff --git[\\s\\S]*\\+a=objective\\n<<<END ${tag}>>>\\n`));
  assert.match(input, /The default branch's change since the branch split from it:\n<<<BEGIN [0-9a-f]{16}>>>\ndiff --git[\s\S]*\+a=main\n<<<END/);
  assert.match(input, /The rebased branch's change against the default branch's head:\n<<<BEGIN [0-9a-f]{16}>>>\n\(no change\)\n<<<END [0-9a-f]{16}>>>$/, "the head has main's conf.txt");
  // The worker's guard Blocks with it, and nothing goes out.
  const { sendBackGuard } = await import("../scripts/worker.mjs");
  const why = await sendBackGuard({ outbox: lost.box, onto: { from: lost.from, base: lost.onto, files: ["conf.txt", "old.txt"] }, defaultBranch: "main", judge });
  assert.ok(why.endsWith(`: ${lost.left}; nothing of it was pushed`), why);
  assert.equal(await lost.box.push(), false);
  assert.equal(lost.r.run(lost.r.origin, "rev-parse", "factory/1"), lost.from, "the branch on GitHub is as it was");
});

test("outbox: a path the conflict reshaped goes to the decision model: kept at the floor or more is delivered, anything else is named (#362)", async () => {
  const reshape = async ({ go, r }) => {
    assert.throws(() => go("rebase", "-q", "origin/main"));
    writeFileSync(join(r.work, "conf.txt"), "a=main-and-objective\n");
    go("add", "conf.txt");
    assert.throws(() => go("rebase", "--continue"));
    go("rm", "-q", "old.txt");
    go("rebase", "--continue");
    go("reset", "-q", "--soft", "origin/main");
    go("commit", "-q", "-m", "squashed");
  };
  const kept = fakeJudge();
  const ok = await rebasedBranch(reshape, kept.judge);
  assert.equal(ok.left, "", ok.left);
  assert.deepEqual(kept.asked.map((a) => a.path), ["conf.txt"]);
  assert.match(kept.asked[0].input, /rebased branch's change against the default branch's head:\n<<<BEGIN [0-9a-f]{16}>>>\ndiff --git[\s\S]*\+a=main-and-objective/);

  const unsure = await rebasedBranch(reshape, fakeJudge({ "conf.txt": 0.6 }).judge);
  assert.match(unsure.left, /: conf\.txt \([0-9a-f]{7}\): the decision model \(fake\/model\) said kept at 0\.60, under 0\.7$/);
  const unanswered = await rebasedBranch(reshape, fakeJudge({}, "error").judge);
  assert.match(unanswered.left, /: conf\.txt \([0-9a-f]{7}\): the decision model gave no answer \(unavailable\)$/);

  // A decider that throws is no answer either; with no key there is no judge at all.
  const thrown = openKeptCheck({ inputs: {}, decider: { decide: async () => { throw new Error("boom"); } } });
  assert.deepEqual(await thrown.judge({ path: "x", branch: "", base: "", head: "" }), { kept: false, why: "the decision model gave no answer (vendor)" });
  assert.equal(openKeptCheck({ inputs: {}, env: { GITHUB_ACTIONS: "true" } }), null);
});

/**
 * #362: main renames a.txt to b.txt and edits the line the branch's c1 edits, so Factory's rebase conflicts; with
 * `two`, the branch's c2 edits another line of it too. The worker skips c1.
 */
async function renamedUnder(two, judge) {
  const r = repos();
  const text = (edits) => Array.from({ length: 12 }, (_, i) => edits[i + 1] ?? `line ${i + 1}`).join("\n") + "\n";
  r.put(r.work, "a.txt", text({}));
  r.run(r.work, "commit", "-q", "-m", "a.txt");
  r.run(r.work, "push", "-q", "origin", "HEAD:main");
  r.run(r.other, "pull", "-q", "origin", "main");
  r.put(r.work, "a.txt", text({ 2: "objective 2" }));
  r.run(r.work, "commit", "-q", "-m", "c1");
  if (two) {
    r.put(r.work, "a.txt", text({ 2: "objective 2", 10: "objective 10" }));
    r.run(r.work, "commit", "-q", "-m", "c2");
  }
  r.run(r.work, "push", "-q", "origin", "HEAD:factory/1");
  r.run(r.other, "mv", "a.txt", "b.txt");
  r.put(r.other, "b.txt", text({ 2: "main 2" }));
  r.run(r.other, "commit", "-q", "-m", "main renames a.txt");
  r.run(r.other, "push", "-q", "origin", "HEAD:main");
  const box = await open(r);
  const from = box.expected();
  assert.equal(await box.rebase({ name: "factory", email: "f@f" }), null, "Factory's own rebase conflicts");
  const onto = box.base;
  const go = (...a) => execFileSync("git", ["-C", r.work, "-c", "user.email=w@w", "-c", "user.name=w", ...a], { encoding: "utf8", env: { ...process.env, ...quiet, GIT_EDITOR: "true" }, stdio: "pipe" });
  go("fetch", "-q", "origin", "main");
  assert.throws(() => go("rebase", "-q", "origin/main"));
  if (two) assert.doesNotThrow(() => go("rebase", "--skip"), "c2 follows the rename onto b.txt");
  else go("rebase", "--skip");
  return { r, from, left: await box.rebaseLeft({ from, onto, judge }) };
}

test("outbox: a commit skipped under main's rename of its file is found in the file's new name, one commit or two (#362)", async () => {
  const one = fakeJudge({}, "lost");
  const single = await renamedUnder(false, one.judge);
  assert.equal(single.r.run(single.r.work, "rev-parse", "HEAD^{tree}"), single.r.run(single.r.work, "rev-parse", "origin/main^{tree}"), "the head is main");
  assert.equal(single.left, "the branch it left drops the Objective's change to 1 path(s): b.txt: the decision model (fake/model) judged it lost at 0.90");
  assert.deepEqual(one.asked.map((a) => a.path), ["b.txt"]);
  assert.match(one.asked[0].input, /\+objective 2/, "the branch's change, followed across the rename");

  const two = fakeJudge({}, "lost");
  const both = await renamedUnder(true, two.judge);
  assert.match(both.r.run(both.r.work, "show", "HEAD:b.txt"), /objective 10/, "c2's line is in the head");
  assert.match(both.left, /^the branch it left drops the Objective's change to 1 path\(s\): b\.txt: the decision model/);
  assert.match(two.asked[0].input, /\+objective 2/);

  // No key: the commit match finds c1 missing.
  assert.match((await renamedUnder(false, null)).left, /^the branch it left drops 1 of the Objective's commit\(s\)/);
});

test("outbox: a binary file the conflict left is decided exactly, never by the decision model (#362)", async () => {
  const bin = (t) => Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(t)]);
  const run = async (side) => {
    const r = repos();
    r.put(r.work, "img.bin", bin("base"));
    r.run(r.work, "commit", "-q", "-m", "img");
    r.run(r.work, "push", "-q", "origin", "HEAD:main");
    r.run(r.other, "pull", "-q", "origin", "main");
    r.put(r.work, "img.bin", bin("objective"));
    r.run(r.work, "commit", "-q", "-m", "c1");
    r.run(r.work, "push", "-q", "origin", "HEAD:factory/1");
    r.put(r.other, "img.bin", bin("main"));
    r.run(r.other, "commit", "-q", "-m", "main");
    r.run(r.other, "push", "-q", "origin", "HEAD:main");
    const box = await open(r);
    const from = box.expected();
    assert.equal(await box.rebase({ name: "factory", email: "f@f" }), null);
    const onto = box.base;
    const go = (...a) => execFileSync("git", ["-C", r.work, "-c", "user.email=w@w", "-c", "user.name=w", ...a], { encoding: "utf8", env: { ...process.env, ...quiet, GIT_EDITOR: "true" }, stdio: "pipe" });
    go("fetch", "-q", "origin", "main");
    assert.throws(() => go("rebase", "-q", "origin/main"));
    go("checkout", "-q", side, "img.bin");
    go("add", "img.bin");
    go("-c", "core.editor=true", "rebase", "--continue");
    const j = fakeJudge();
    return { left: await box.rebaseLeft({ from, onto, judge: j.judge }), asked: j.asked };
  };
  // In a rebase, --theirs is the commit being replayed: the branch's version.
  const branch = await run("--theirs");
  assert.equal(branch.left, "");
  const main = await run("--ours");
  assert.match(main.left, /: img\.bin \([0-9a-f]{7}\): a binary or Git LFS file that is not the branch's version$/);
  assert.deepEqual([...branch.asked, ...main.asked], [], "never asked");
});

/**
 * A send-back whose rebase conflicts: main gets `base`, the branch one commit per entry of `commits` (each a map of
 * path to text, null to delete, or a function of the clone for a git step), and main then `main`. Returns the outbox,
 * the branch's head before (`from`), the base (`onto`) and the worker's git, with the default branch fetched.
 */
async function sentBack({ base, commits, main }) {
  const r = repos();
  const apply = (cwd, files) => {
    if (typeof files === "function") return files(cwd, r);
    for (const [f, t] of Object.entries(files)) {
      if (t === null) r.run(cwd, "rm", "-q", f);
      else r.put(cwd, f, t);
    }
  };
  apply(r.work, base);
  r.run(r.work, "commit", "-q", "-m", "base");
  r.run(r.work, "push", "-q", "origin", "HEAD:main");
  r.run(r.other, "pull", "-q", "origin", "main");
  commits.forEach((c, i) => {
    apply(r.work, c);
    r.run(r.work, "commit", "-q", "-m", `c${i + 1}`);
  });
  r.run(r.work, "push", "-q", "origin", "HEAD:factory/1");
  apply(r.other, main);
  r.run(r.other, "commit", "-q", "-m", "main");
  r.run(r.other, "push", "-q", "origin", "HEAD:main");
  const box = await open(r);
  const from = box.expected();
  assert.equal(await box.rebase({ name: "factory", email: "f@f" }), null, "Factory's own rebase conflicts");
  const go = (...a) => execFileSync("git", ["-C", r.work, "-c", "user.email=w@w", "-c", "user.name=w", ...a], { encoding: "utf8", env: { ...process.env, ...quiet, GIT_EDITOR: "true" }, stdio: "pipe" });
  go("fetch", "-q", "origin", "main");
  return { r, box, from, onto: box.base, go };
}

const lines12 = (edits = {}) => Array.from({ length: 12 }, (_, i) => edits[i + 1] ?? `line ${i + 1}`).join("\n") + "\n";

test("outbox: a file the worker renamed in the head, dropping the branch's edit, is judged on what the merge would still change, and a rename against the branch's is Blocked exactly (#362)", async () => {
  // The branch edits x.txt; the worker resolves conf.txt, then moves x.txt to y.txt without the edit.
  const moved = await sentBack({ base: { "x.txt": lines12(), "conf.txt": "a=1\n" }, commits: [{ "x.txt": lines12({ 2: "objective 2" }), "conf.txt": "a=objective\n" }], main: { "conf.txt": "a=main\n" } });
  assert.throws(() => moved.go("rebase", "-q", "origin/main"));
  writeFileSync(join(moved.r.work, "conf.txt"), "a=main-and-objective\n");
  moved.go("add", "conf.txt");
  moved.go("rebase", "--continue");
  moved.go("mv", "x.txt", "y.txt");
  writeFileSync(join(moved.r.work, "y.txt"), lines12());
  moved.go("commit", "-q", "-am", "move x.txt");
  const j = fakeJudge({ "conf.txt": "kept" }, "lost");
  const left = await moved.box.rebaseLeft({ from: moved.from, onto: moved.onto, judge: j.judge });
  assert.match(left, /^the branch it left drops the Objective's change to 1 path\(s\): y\.txt: the decision model \(fake\/model\) judged it lost at 0\.90$/);
  const y = j.asked.find((a) => a.path === "y.txt").input;
  assert.match(y, /^The rebase did not conflict on this file:/);
  assert.match(y, /What merging the branch's change into the rebased branch would still change[^\n]*:\n<<<BEGIN [0-9a-f]{16}>>>\ndiff --git a\/y\.txt b\/y\.txt\n[\s\S]*-line 2\n\+objective 2\n/, "the model sees the edit the head lacks, under the file's name");

  // Rename against rename: the branch moves x.txt to z.txt with its edit; the worker's head moves it on to y.txt and
  // drops the edit. git cannot merge the branch's change into y.txt: Blocked exactly, never asked.
  const both = await sentBack({
    base: { "x.txt": lines12(), "conf.txt": "a=1\n" },
    commits: [
      (cwd, r) => {
        r.run(cwd, "mv", "x.txt", "z.txt");
        r.put(cwd, "z.txt", lines12({ 2: "objective 2" }));
        r.put(cwd, "conf.txt", "a=objective\n");
      },
    ],
    main: { "conf.txt": "a=main\n" },
  });
  assert.throws(() => both.go("rebase", "-q", "origin/main"));
  writeFileSync(join(both.r.work, "conf.txt"), "a=main-and-objective\n");
  both.go("add", "conf.txt");
  both.go("rebase", "--continue");
  both.go("mv", "z.txt", "y.txt");
  writeFileSync(join(both.r.work, "y.txt"), lines12());
  both.go("commit", "-q", "-am", "move z.txt");
  const k = fakeJudge({ "conf.txt": "kept" }, "kept");
  const left2 = await both.box.rebaseLeft({ from: both.from, onto: both.onto, judge: k.judge });
  assert.equal(left2, "the branch it left drops the Objective's change to 1 path(s): y.txt: the head renamed or removed it where git cannot merge the branch's change into it");
  assert.ok(!k.asked.some((a) => a.path === "y.txt"), "never asked about y.txt");
});

test("outbox: a file the head has with the branch's content but not its mode is named exactly, never asked (#362)", async () => {
  const t = await sentBack({
    base: { "run.sh": "echo hi\n", "conf.txt": "a=1\n" },
    commits: [
      (cwd, r) => {
        r.put(cwd, "conf.txt", "a=objective\n");
        chmodSync(join(cwd, "run.sh"), 0o755);
        r.run(cwd, "add", "run.sh");
      },
    ],
    main: { "conf.txt": "a=main\n" },
  });
  assert.throws(() => t.go("rebase", "-q", "origin/main"));
  writeFileSync(join(t.r.work, "conf.txt"), "a=main-and-objective\n");
  t.go("add", "conf.txt");
  t.go("rebase", "--continue");
  const j = fakeJudge();
  assert.equal(await t.box.rebaseLeft({ from: t.from, onto: t.onto, judge: j.judge }), "", "the mode kept: delivered");
  chmodSync(join(t.r.work, "run.sh"), 0o644);
  t.go("commit", "-q", "-am", "drop the exec bit");
  const k = fakeJudge();
  const c1 = t.r.run(t.r.work, "rev-parse", "--short=7", t.from);
  assert.equal(await t.box.rebaseLeft({ from: t.from, onto: t.onto, judge: k.judge }), `the branch it left drops the Objective's change to 1 path(s): run.sh (${c1}): its file mode is 100644, the branch's change makes it 100755`);
  assert.deepEqual(k.asked.map((a) => a.path), ["conf.txt"]);
});

test("outbox: a lost exec bit is named on its own, whether the content was hand-merged in a conflict or reshaped without one (#362)", async () => {
  const exec = (cwd, f) => {
    chmodSync(join(cwd, f), 0o755);
  };
  // The branch makes run.sh executable and edits its line 2; main edits line 2 too. The worker takes main's file and
  // hand-merges the line: the content is the model's to judge, the mode is not.
  const a = await sentBack({
    base: { "run.sh": lines12() },
    commits: [
      (cwd, r) => {
        writeFileSync(join(cwd, "run.sh"), lines12({ 2: "objective 2" }));
        exec(cwd, "run.sh");
        r.run(cwd, "add", "run.sh");
      },
    ],
    main: { "run.sh": lines12({ 2: "main 2" }) },
  });
  assert.throws(() => a.go("rebase", "-q", "origin/main"));
  a.go("checkout", "-q", "--ours", "run.sh");
  writeFileSync(join(a.r.work, "run.sh"), lines12({ 2: "main and objective 2" }));
  a.go("add", "run.sh");
  a.go("rebase", "--continue");
  assert.equal(a.r.run(a.r.work, "ls-tree", "HEAD", "run.sh").split(" ")[0], "100644");
  const ja = fakeJudge();
  const c1 = a.r.run(a.r.work, "rev-parse", "--short=7", a.from);
  assert.equal(await a.box.rebaseLeft({ from: a.from, onto: a.onto, judge: ja.judge }), `the branch it left drops the Objective's change to 1 path(s): run.sh (${c1}): its file mode is 100644, the branch's change makes it 100755`);
  assert.deepEqual(ja.asked, []);

  // No conflict on tool.sh (the conflict is conf.txt's): the worker reshapes its lines and drops the bit.
  const b = await sentBack({
    base: { "tool.sh": lines12(), "conf.txt": "a=1\n" },
    commits: [
      (cwd, r) => {
        writeFileSync(join(cwd, "tool.sh"), lines12({ 2: "objective 2" }));
        exec(cwd, "tool.sh");
        r.put(cwd, "conf.txt", "a=objective\n");
        r.run(cwd, "add", "tool.sh");
      },
    ],
    main: { "tool.sh": lines12({ 9: "main 9" }), "conf.txt": "a=main\n" },
  });
  assert.throws(() => b.go("rebase", "-q", "origin/main"));
  writeFileSync(join(b.r.work, "conf.txt"), "a=main-and-objective\n");
  b.go("add", "conf.txt");
  b.go("rebase", "--continue");
  writeFileSync(join(b.r.work, "tool.sh"), lines12({ 2: "objective two", 9: "main 9" }));
  chmodSync(join(b.r.work, "tool.sh"), 0o644);
  b.go("commit", "-q", "-am", "reshape tool.sh");
  const jb = fakeJudge();
  assert.match(await b.box.rebaseLeft({ from: b.from, onto: b.onto, judge: jb.judge }), /^the branch it left drops the Objective's change to 1 path\(s\): tool\.sh \([0-9a-f]{7}\): its file mode is 100644, the branch's change makes it 100755$/);
  assert.deepEqual(jb.asked.map((x) => x.path), ["conf.txt"]);
});

test("outbox: a submodule bump the head reset is named exactly, never asked (#362)", async () => {
  const r = repos();
  const ids = [r.run(r.work, "rev-parse", "HEAD")];
  r.put(r.work, "x.txt", "x\n");
  r.run(r.work, "commit", "-q", "-m", "second");
  ids.push(r.run(r.work, "rev-parse", "HEAD"));
  const link = (cwd, run, id) => run(cwd, "update-index", "--add", "--cacheinfo", `160000,${id},sub`);
  const u = await sentBack({
    base: (cwd, rr) => {
      rr.put(cwd, "conf.txt", "a=1\n");
      link(cwd, rr.run, ids[0]);
    },
    commits: [
      (cwd, rr) => {
        rr.put(cwd, "conf.txt", "a=objective\n");
        link(cwd, rr.run, ids[1]);
      },
    ],
    main: { "conf.txt": "a=main\n" },
  });
  assert.throws(() => u.go("rebase", "-q", "origin/main"));
  writeFileSync(join(u.r.work, "conf.txt"), "a=main-and-objective\n");
  u.go("add", "conf.txt");
  u.go("rebase", "--continue");
  const j0 = fakeJudge();
  assert.equal(await u.box.rebaseLeft({ from: u.from, onto: u.onto, judge: j0.judge }), "", "the bump kept: delivered");
  u.go("update-index", "--cacheinfo", `160000,${ids[0]},sub`);
  u.go("commit", "-q", "-m", "reset the submodule");
  const j = fakeJudge();
  assert.match(await u.box.rebaseLeft({ from: u.from, onto: u.onto, judge: j.judge }), /^the branch it left drops the Objective's change to 1 path\(s\): sub \([0-9a-f]{7}\): a submodule or symlink that is not the branch's version$/);
  assert.deepEqual(j.asked.map((x) => x.path), ["conf.txt"]);
});

test("outbox: a file the branch added that the head dropped goes to the decision model with the whole addition (#362)", async () => {
  const t = await sentBack({ base: { "conf.txt": "a=1\n" }, commits: [{ "conf.txt": "a=objective\n", "new.txt": "brand new\n" }], main: { "conf.txt": "a=main\n" } });
  assert.throws(() => t.go("rebase", "-q", "origin/main"));
  writeFileSync(join(t.r.work, "conf.txt"), "a=main-and-objective\n");
  t.go("add", "conf.txt");
  t.go("rebase", "--continue");
  t.go("rm", "-q", "new.txt");
  t.go("commit", "-q", "-m", "drop new.txt");
  const j = fakeJudge({ "conf.txt": "kept" }, "lost");
  assert.match(await t.box.rebaseLeft({ from: t.from, onto: t.onto, judge: j.judge }), /^the branch it left drops the Objective's change to 1 path\(s\): new\.txt \([0-9a-f]{7}\): the decision model \(fake\/model\) judged it lost at 0\.90$/);
  assert.match(j.asked.find((x) => x.path === "new.txt").input, /would still change[^\n]*:\n<<<BEGIN [0-9a-f]{16}>>>\ndiff --git a\/new\.txt b\/new\.txt\n[\s\S]*\+brand new/);
});

test("outbox: under a rename against a rename, the branch's file kept at the default branch's name is no loss (#362)", async () => {
  const t = await sentBack({
    base: { "x.txt": lines12() },
    commits: [
      (cwd, r) => {
        r.run(cwd, "mv", "x.txt", "z.txt");
        r.put(cwd, "z.txt", lines12({ 2: "objective 2" }));
      },
    ],
    main: (cwd, r) => r.run(cwd, "mv", "x.txt", "y.txt"),
  });
  assert.throws(() => t.go("rebase", "-q", "origin/main"));
  const mine = readFileSync(join(t.r.work, "z.txt"), "utf8");
  t.go("rm", "-q", "--cached", "z.txt");
  rmSync(join(t.r.work, "z.txt"));
  writeFileSync(join(t.r.work, "y.txt"), mine);
  t.go("add", "-A");
  t.go("rebase", "--continue");
  const j = fakeJudge({ "y.txt": "kept" }, "lost");
  assert.equal(await t.box.rebaseLeft({ from: t.from, onto: t.onto, judge: j.judge }), "");
  assert.ok(!j.asked.some((x) => x.path === "z.txt"), "z.txt's content is in the head under y.txt: decided exactly");
});

test("outbox: a conflict across nine files, each resolved, is judged path by path and delivered (#362)", async () => {
  const files = (v) => Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`f${i + 1}.txt`, `${v}\n`]));
  const t = await sentBack({ base: files("v"), commits: [files("objective")], main: files("main") });
  assert.throws(() => t.go("rebase", "-q", "origin/main"));
  for (let i = 1; i <= 9; i += 1) writeFileSync(join(t.r.work, `f${i}.txt`), "main and objective\n");
  t.go("add", "-A");
  t.go("rebase", "--continue");
  const j = fakeJudge();
  assert.equal(await t.box.rebaseLeft({ from: t.from, onto: t.onto, judge: j.judge }), "");
  assert.equal(j.asked.length, 9);
});

test("outbox: a git with no merge-tree --merge-base: named in the Block with a decision model, the commit match without one (#362)", async () => {
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const bin = mkdtempSync(join(tmpdir(), "old-git-"));
  writeFileSync(join(bin, "git"), `#!/bin/sh\nfor a in "$@"; do case "$a" in merge-tree) echo "error: unknown option" >&2; exit 129;; version) echo "git version 2.34.1"; exit 0;; esac; done\nexec ${real} "$@"\n`, { mode: 0o755 });
  const { judge } = fakeJudge();
  const done = await conflictPass(async ({ resolve, go }) => {
    resolve("app.txt", "ours and theirs\n");
    assert.throws(() => go("rebase", "--continue"));
    resolve("b.txt", "ours-b and theirs-b\n");
    go("rebase", "--continue");
  }, judge);
  assert.equal(done.left, "");
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    assert.equal(await done.box.rebaseLeft({ from: done.from, onto: done.onto, judge }), "Factory could not compare the rebased branch with the branch before it: git 2.34.1 has no `git merge-tree --merge-base` (git 2.40 or later)");
    assert.equal(await done.box.rebaseLeft({ from: done.from, onto: done.onto }), "", "key-less, the commits still match");
  } finally {
    process.env.PATH = path;
    rmSync(bin, { recursive: true, force: true });
  }
});

test("worker: a send-back's conflict pass ended by a cap mid-rebase pushes nothing; the cap stays the Block's reason (#243)", async () => {
  const { sendBackGuard } = await import("../scripts/worker.mjs");
  const { decideExit } = await import("../scripts/lib/logic.mjs");
  // The time cap stopped the pass on its first conflict: HEAD is main itself, with the rebase in progress.
  const { box, r, from, onto } = await conflictPass(async () => {});
  const unresolved = await sendBackGuard({ outbox: box, onto: { from, base: onto, files: ["app.txt"] }, defaultBranch: "main" });
  assert.match(unresolved, /in `app\.txt`: the conflict pass left a rebase in progress; nothing of it was pushed$/);
  assert.equal(await box.push(), false, "nothing goes out");
  assert.equal(r.run(r.origin, "rev-parse", "factory/1"), from, "the branch on GitHub is as it was");
  const pr = { exists: true, draft: false, body: "Closes #1" };
  assert.equal(decideExit({ harness: { ok: false, timedOut: true }, pr, commits: 0, unresolved, pushRejected: box.error !== unresolved ? box.error : "" }).reason, "time cap reached");
  // The worker calls the guard for every send-back conflict, caps or not.
  const src = readFileSync(join(import.meta.dirname, "..", "scripts", "worker.mjs"), "utf8");
  assert.match(src, /\n {2}const keptCheck = rebaseOnto \? openKeptCheck\(\{ inputs, stage: decisionStage \}\) : null;\n {2}const unresolved = await sendBackGuard\(\{ outbox, onto: rebaseOnto, defaultBranch, judge: keptCheck\?\.judge \?\? null, progress, limited: keptCheck\?\.limited \?\? null \}\);\n {2}let pushed = await outbox\.push\(\);/);
});
