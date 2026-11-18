// The outbox after a send-back's conflict pass: what the rebase left (rebaseLeft) and whether the branch's work survived
// it (the rebase check: #243, #362, #452, #515). Real git repositories throughout (fixtures/outbox.mjs).
import "./temp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JUDGE_AT_ONCE, JUDGE_PATH_MAX_BYTES } from "../scripts/lib/outbox.mjs";
import { KEPT_QUESTION, keptInput, openKeptCheck } from "../scripts/lib/kept.mjs";
import { open, quiet, repos } from "./fixtures/outbox.mjs";

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
  r.run(r.work, "push", "-q", "origin", "HEAD:pendulum/1");
  r.put(r.other, "app.txt", "theirs\n");
  r.put(r.other, "b.txt", "theirs-b\n");
  r.put(r.other, "c.txt", "same\n");
  r.run(r.other, "commit", "-q", "-m", "sibling");
  r.run(r.other, "push", "-q", "origin", "HEAD:main");
  const box = await open(r);
  const from = box.expected();
  assert.equal(await box.rebase({ name: "pendulum", email: "f@f" }), null, "Pendulum's own rebase conflicts");
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
      const path = /^File:\n<<<BEGIN [0-9a-f]{16}>>>\n(.+)\n<<<END [0-9a-f]{16}>>>\n/.exec(input)[1];
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
  assert.equal(skipped.left, `the branch it left drops the Objective's change to 1 path(s): app.txt (${c1}): hunk 1 of 1 (@@ -1 +1 @@): the decision model (fake/model) judged it lost at 0.90`);
  // With no key, the commit match names c1 as before.
  const keyless = await conflictPass(skip);
  assert.match(keyless.left, /^the branch it left drops 1 of the Objective's commit\(s\) \([0-9a-f]{7}\); with an AI Gateway key Pendulum decides this on content$/);
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
  r.run(r.work, "push", "-q", "origin", "HEAD:pendulum/1");
  r.put(r.other, "doc.txt", "theirs-doc\n");
  r.run(r.other, "commit", "-q", "-m", "sibling");
  r.run(r.other, "push", "-q", "origin", "HEAD:main");
  const box = await open(r);
  const from = box.expected();
  assert.equal(await box.rebase({ name: "pendulum", email: "f@f" }), null);
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
  r.run(r.work, "push", "-q", "origin", "HEAD:pendulum/1");
  r.put(r.other, "app.txt", lines(3, "L3 main"));
  r.put(r.other, "old.txt", "old, edited\n");
  r.put(r.other, "registry.txt", "old.txt\n");
  if (confOnMain) r.put(r.other, "conf.txt", "a=main\n");
  r.run(r.other, "commit", "-q", "-m", "sibling");
  r.run(r.other, "push", "-q", "origin", "HEAD:main");
  const box = await open(r);
  const from = box.expected();
  assert.equal(await box.rebase({ name: "pendulum", email: "f@f" }), null, "Pendulum's own rebase conflicts");
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
  assert.equal(done.r.run(done.r.origin, "rev-parse", "pendulum/1"), done.r.run(done.r.work, "rev-parse", "HEAD"));
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
  assert.equal(lost.left, `the branch it left drops the Objective's change to 1 path(s): conf.txt (${c1}): hunk 1 of 1 (@@ -1 +1 @@): the decision model (fake/model) judged it lost at 0.90`);
  assert.deepEqual(asked.map((a) => a.path), ["conf.txt"], "only conf.txt is not the branch's version");
  const { input, question } = asked[0];
  assert.equal(question, KEPT_QUESTION);
  const tag = /<<<BEGIN ([0-9a-f]{16})>>>/.exec(input)[1];
  // One hunk of the branch's change from the conflict's base, asked against the whole file as the head has it.
  assert.equal(input, `File:\n<<<BEGIN ${tag}>>>\nconf.txt\n<<<END ${tag}>>>\n\nHunk 1 of 1 of the branch's change to the file:\n<<<BEGIN ${tag}>>>\n@@ -1 +1 @@\n-a=1\n+a=objective\n<<<END ${tag}>>>\n\nThe whole file as the rebased branch has it:\n<<<BEGIN ${tag}>>>\na=main\n<<<END ${tag}>>>`, "the head has main's conf.txt");
  // The worker's guard Blocks with it, and nothing goes out.
  const { sendBackGuard } = await import("../scripts/worker.mjs");
  const why = await sendBackGuard({ outbox: lost.box, onto: { from: lost.from, base: lost.onto, files: ["conf.txt", "old.txt"] }, defaultBranch: "main", judge });
  assert.ok(why.endsWith(`: ${lost.left}; nothing of it was pushed`), why);
  assert.equal(await lost.box.push(), false);
  assert.equal(lost.r.run(lost.r.origin, "rev-parse", "pendulum/1"), lost.from, "the branch on GitHub is as it was");
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
  assert.match(kept.asked[0].input, /The whole file as the rebased branch has it:\n<<<BEGIN [0-9a-f]{16}>>>\na=main-and-objective\n<<<END/);

  const unsure = await rebasedBranch(reshape, fakeJudge({ "conf.txt": 0.6 }).judge);
  assert.match(unsure.left, /: conf\.txt \([0-9a-f]{7}\): hunk 1 of 1 \(@@ -1 \+1 @@\): the decision model \(fake\/model\) said kept at 0\.60, under 0\.7$/);
  const unanswered = await rebasedBranch(reshape, fakeJudge({}, "error").judge);
  assert.match(unanswered.left, /: conf\.txt \([0-9a-f]{7}\): hunk 1 of 1 \(@@ -1 \+1 @@\): the decision model gave no answer \(unavailable\)$/);

  // A decider that throws is no answer either; with no key there is no judge at all.
  const thrown = openKeptCheck({ inputs: {}, decider: { decide: async () => { throw new Error("boom"); } } });
  assert.deepEqual(await thrown.judge({ path: "x", hunks: [{ at: 1, text: "@@ -0,0 +1 @@\n+x" }], file: "" }), { kept: false, lost: false, why: "the decision model gave no answer (vendor)" });
  assert.equal(openKeptCheck({ inputs: {}, env: { GITHUB_ACTIONS: "true" } }), null);
});

/**
 * #362: main renames a.txt to b.txt and edits the line the branch's c1 edits, so Pendulum's rebase conflicts; with
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
  r.run(r.work, "push", "-q", "origin", "HEAD:pendulum/1");
  r.run(r.other, "mv", "a.txt", "b.txt");
  r.put(r.other, "b.txt", text({ 2: "main 2" }));
  r.run(r.other, "commit", "-q", "-m", "main renames a.txt");
  r.run(r.other, "push", "-q", "origin", "HEAD:main");
  const box = await open(r);
  const from = box.expected();
  assert.equal(await box.rebase({ name: "pendulum", email: "f@f" }), null, "Pendulum's own rebase conflicts");
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
  assert.equal(single.left, "the branch it left drops the Objective's change to 1 path(s): b.txt: hunk 1 of 1 (@@ -1,5 +1,5 @@): the decision model (fake/model) judged it lost at 0.90");
  assert.deepEqual(one.asked.map((a) => a.path), ["b.txt"]);
  assert.match(one.asked[0].input, /\+objective 2/, "the branch's change, followed across the rename");

  const two = fakeJudge({}, "lost");
  const both = await renamedUnder(true, two.judge);
  assert.match(both.r.run(both.r.work, "show", "HEAD:b.txt"), /objective 10/, "c2's line is in the head");
  assert.match(both.left, /^the branch it left drops the Objective's change to 1 path\(s\): b\.txt: hunk 1 of 2 \(@@ -1,5 \+1,5 @@\): the decision model/);
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
    r.run(r.work, "push", "-q", "origin", "HEAD:pendulum/1");
    r.put(r.other, "img.bin", bin("main"));
    r.run(r.other, "commit", "-q", "-m", "main");
    r.run(r.other, "push", "-q", "origin", "HEAD:main");
    const box = await open(r);
    const from = box.expected();
    assert.equal(await box.rebase({ name: "pendulum", email: "f@f" }), null);
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
async function sentBack({ base, commits, main, outbox = {} }) {
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
  r.run(r.work, "push", "-q", "origin", "HEAD:pendulum/1");
  apply(r.other, main);
  r.run(r.other, "commit", "-q", "-m", "main");
  r.run(r.other, "push", "-q", "origin", "HEAD:main");
  const box = await open(r, outbox);
  const from = box.expected();
  assert.equal(await box.rebase({ name: "pendulum", email: "f@f" }), null, "Pendulum's own rebase conflicts");
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
  assert.match(left, /^the branch it left drops the Objective's change to 1 path\(s\): y\.txt: hunk 1 of 1 \(@@ [^)]* @@\): the decision model \(fake\/model\) judged it lost at 0\.90$/);
  const y = j.asked.find((a) => a.path === "y.txt").input;
  assert.match(y, /^File:\n<<<BEGIN [0-9a-f]{16}>>>\ny\.txt\n/);
  assert.match(y, /\nHunk 1 of 1 of what merging the branch's change into the file would still change:\n<<<BEGIN [0-9a-f]{16}>>>\n@@ [^\n]*\n[\s\S]*-line 2\n\+objective 2\n/, "the model sees the edit the head lacks, under the file's name");

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
  assert.match(await t.box.rebaseLeft({ from: t.from, onto: t.onto, judge: j.judge }), /^the branch it left drops the Objective's change to 1 path\(s\): new\.txt \([0-9a-f]{7}\): hunk 1 of 1 \(@@ -0,0 \+1 @@\): the decision model \(fake\/model\) judged it lost at 0\.90$/);
  assert.match(j.asked.find((x) => x.path === "new.txt").input, /would still change:\n<<<BEGIN [0-9a-f]{16}>>>\n@@ -0,0 \+1 @@\n\+brand new\n<<<END [0-9a-f]{16}>>>\n\nThe whole file as the rebased branch has it:\n<<<BEGIN [0-9a-f]{16}>>>\n\(no such file in the rebased branch\)\n/);
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
    assert.equal(await done.box.rebaseLeft({ from: done.from, onto: done.onto, judge }), "Pendulum could not compare the rebased branch with the branch before it: git 2.34.1 has no `git merge-tree --merge-base` (git 2.40 or later)");
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
  assert.equal(r.run(r.origin, "rev-parse", "pendulum/1"), from, "the branch on GitHub is as it was");
  const pr = { exists: true, draft: false, body: "Closes #1" };
  assert.equal(decideExit({ harness: { ok: false, timedOut: true }, pr, commits: 0, unresolved, pushRejected: box.error !== unresolved ? box.error : "" }).reason, "time cap reached");
  // The worker calls the guard for every send-back conflict, caps or not.
  const src = readFileSync(join(import.meta.dirname, "..", "scripts", "worker.mjs"), "utf8");
  assert.match(src, /\n {2}const keptCheck = rebaseOnto \? openKeptCheck\(\{ inputs, stage: decisionStage \}\) : null;\n {2}const unresolved = await sendBackGuard\(\{ outbox, onto: rebaseOnto, defaultBranch, judge: keptCheck\?\.judge \?\? null, progress, limited: keptCheck\?\.limited \?\? null, issue \}\);\n {2}let pushed = await outbox\.push\(\);/);
});

/**
 * #452: a fake decision model that reads what it is given the way a model can be sure of: numbered hunks of the
 * branch's change and the file (or each hunk's lines of it) they are judged against. A hunk is kept when each line it
 * adds is in the file as written or adapted (a line holding every word of it: another argument, a wrapper) and each
 * line it removes, unless it re-adds its words, is not back in that form; `kept` 0.95 when every hunk is, else `lost`
 * 0.95. Anything else, such as whole-file diffs of the branch, the default branch and the head interleaved, gets the
 * unsure `kept` at 0.23 the real model gave in the issue.
 */
function hunkReader() {
  const asked = [];
  const words = (l) => l.match(/[A-Za-z0-9_]+/g) || [];
  const holds = (line, w) => w.length > 0 && w.every((x) => words(line).includes(x));
  const decider = {
    name: "fake",
    model: "fake/model",
    async decide(input, question) {
      const blocks = [...input.matchAll(/(?:^|\n)([^\n]*):\n<<<BEGIN ([0-9a-f]{16})>>>\n([\s\S]*?)\n<<<END \2>>>/g)].map((m) => ({ title: m[1], text: m[3] }));
      const hunks = blocks.filter((b) => /^Hunk \d+ of \d+ /.test(b.title));
      asked.push({ input, question, hunks: hunks.map((h) => Number(/^Hunk (\d+)/.exec(h.title)[1])) });
      if (question.name !== "hunks_kept" || !hunks.length) return { verdict: "kept", confidence: 0.23 };
      const whole = blocks.find((b) => b.title === "The whole file as the rebased branch has it");
      const kept = hunks.every((h) => {
        const at = /^Hunk (\d+)/.exec(h.title)[1];
        const file = (whole ?? blocks.find((b) => b.title.endsWith(`around where hunk ${at} applies`))).text.split("\n");
        const lines = h.text.split("\n").slice(1);
        const added = lines.filter((l) => l.startsWith("+")).map((l) => words(l.slice(1)));
        const removed = lines.filter((l) => l.startsWith("-")).map((l) => words(l.slice(1)));
        const present = added.every((w) => !w.length || file.some((f) => holds(f, w)));
        const back = removed.some((w) => w.length && !added.some((a) => w.every((x) => a.includes(x))) && file.some((f) => holds(f, w)));
        return present && !back;
      });
      return { verdict: kept ? "kept" : "lost", confidence: 0.95 };
    },
  };
  return { asked, judge: openKeptCheck({ inputs: { triageModel: "fake/model" }, decider }).judge };
}

/**
 * #452: the branch changes TTL and adds markStale after isStale; main changes TTL too and adds touch() at the same place,
 * so the rebase conflicts on stale.ts. `resolve` writes the worker's resolution; with `adapt`, a second commit adapts
 * markStale to main's code: one of its lines gets another argument, and a new line calls main's touch().
 */
const staleBase = ["const TTL = 60;", "const LIMIT = 10;", "const UNIT = 1000;", "const NAME = \"stale\";", "const KIND = \"item\";", "", "export function isStale(item, now) {", "  return now - item.at > TTL;", "}", "", "// helpers", "// more helpers", "// end", ""];
const markStale = ["export function markStale(items, now) {", "  return items.filter((i) => isStale(i, now)).map((i) => ({ ...i, stale: true }));", "}"];
const touch = ["export function touch(item, now) {", "  return { ...item, at: now };", "}"];
const staleFile = (ttl, ...adds) => [`const TTL = ${ttl};`, ...staleBase.slice(1, 10), ...adds.flatMap((a) => [...a, ""]), ...staleBase.slice(10)].join("\n");

async function staleConflict(resolve, { adapt = false, outbox = {} } = {}) {
  const t = await sentBack({ base: { "src/stale.ts": staleBase.join("\n") }, commits: [{ "src/stale.ts": staleFile(300, markStale) }], main: { "src/stale.ts": staleFile(120, touch) }, outbox });
  assert.throws(() => t.go("rebase", "-q", "origin/main"));
  writeFileSync(join(t.r.work, "src/stale.ts"), resolve);
  t.go("add", "src/stale.ts");
  t.go("rebase", "--continue");
  if (adapt) {
    const text = readFileSync(join(t.r.work, "src/stale.ts"), "utf8").replace("  return items.filter((i) => isStale(i, now))", "  items = items.map((i) => touch(i, now));\n  return items.filter((i) => isStale(i, now, TTL))");
    writeFileSync(join(t.r.work, "src/stale.ts"), text);
    t.go("commit", "-q", "-am", "Adapt markStale to main's touch()");
  }
  return t;
}

test("#452: a conflict pass that keeps the branch's change and adapts it to main's new code is judged kept, in one question for the path, and pushed", async () => {
  const t = await staleConflict(staleFile(300, touch, markStale), { adapt: true });
  assert.match(t.r.run(t.r.work, "show", "HEAD:src/stale.ts"), /isStale\(i, now, TTL\)/, "a line of the branch's change, adapted");
  const { asked, judge } = hunkReader();
  const { sendBackGuard } = await import("../scripts/worker.mjs");
  assert.equal(await sendBackGuard({ outbox: t.box, onto: { from: t.from, base: t.onto, files: ["src/stale.ts"] }, defaultBranch: "main", judge }), "");
  // One question for the path: both hunks of the branch's change (its TTL line, its markStale), then the whole resolved
  // file, which holds main's touch() and the worker's adaptation beside the branch's lines.
  assert.equal(asked.length, 1);
  const [{ input, question, hunks }] = asked;
  assert.equal(question, KEPT_QUESTION);
  assert.deepEqual(hunks, [1, 2]);
  assert.match(input, /^File:\n<<<BEGIN [0-9a-f]{16}>>>\nsrc\/stale\.ts\n<<<END [0-9a-f]{16}>>>\n\nHunk 1 of 2 of the branch's change to the file:\n<<<BEGIN [0-9a-f]{16}>>>\n@@ [^\n]*\n-const TTL = 60;\n\+const TTL = 300;\n[\s\S]*\n\nHunk 2 of 2 of the branch's change to the file:\n[\s\S]*\+export function markStale/);
  assert.match(input, /\n\nThe whole file as the rebased branch has it:\n<<<BEGIN [0-9a-f]{16}>>>\nconst TTL = 300;\n[\s\S]*export function touch[\s\S]*items = items\.map\(\(i\) => touch\(i, now\)\);\n {2}return items\.filter\(\(i\) => isStale\(i, now, TTL\)\)[\s\S]*\n<<<END [0-9a-f]{16}>>>$/);
  assert.equal(await t.box.push(), true, t.box.error);
  assert.equal(t.r.run(t.r.origin, "rev-parse", "pendulum/1"), t.r.run(t.r.work, "rev-parse", "HEAD"));
});

test("#452: a conflict pass that drops the branch's addition, or keeps main's line where the branch changed it, is still Blocked, naming the hunk asked alone", async () => {
  const { sendBackGuard } = await import("../scripts/worker.mjs");
  // Dropped: main's file as it is, the branch's markStale gone. The path's question is not kept, so each hunk is asked
  // alone, in order, up to the first not kept.
  const dropped = await staleConflict(staleFile(300, touch));
  const d = hunkReader();
  const why = await sendBackGuard({ outbox: dropped.box, onto: { from: dropped.from, base: dropped.onto, files: ["src/stale.ts"] }, defaultBranch: "main", judge: d.judge });
  assert.match(why, /: the branch it left drops the Objective's change to 1 path\(s\): src\/stale\.ts \([0-9a-f]{7}\): hunk 2 of 2 \(@@ -[0-9,]+ \+[0-9,]+ @@\): the decision model \(fake\/model\) judged it lost at 0\.95; nothing of it was pushed$/);
  assert.deepEqual(d.asked.map((a) => a.hunks), [[1, 2], [1], [2]]);
  assert.equal(await dropped.box.push(), false);
  // Replaced by main's version: markStale kept, main's TTL where the branch changed it.
  const replaced = await staleConflict(staleFile(120, touch, markStale));
  const r = hunkReader();
  assert.match(await replaced.box.rebaseLeft({ from: replaced.from, onto: replaced.onto, judge: r.judge }), /: src\/stale\.ts \([0-9a-f]{7}\): hunk 1 of 2 \(@@ -1[0-9,]* \+1[0-9,]* @@\): the decision model \(fake\/model\) judged it lost at 0\.95$/);
  assert.deepEqual(r.asked.map((a) => a.hunks), [[1, 2], [1]]);
});

test("#452: a branch's deletion the resolution undoes by keeping main's edit of the line is Blocked", async () => {
  const base = ["start();", "dangerous();", "finish();", ""].join("\n");
  const t = await sentBack({ base: { "run.js": base }, commits: [{ "run.js": ["start();", "finish();", ""].join("\n") }], main: { "run.js": ["start();", "dangerous(true);", "finish();", ""].join("\n") } });
  assert.throws(() => t.go("rebase", "-q", "origin/main"));
  t.go("checkout", "-q", "--ours", "run.js");
  t.go("add", "run.js");
  t.go("-c", "core.editor=true", "rebase", "--continue");
  const { asked, judge } = hunkReader();
  assert.match(await t.box.rebaseLeft({ from: t.from, onto: t.onto, judge }), /: run\.js \([0-9a-f]{7}\): hunk 1 of 1 \(@@ -1,3 \+1,2 @@\): the decision model \(fake\/model\) judged it lost at 0\.95$/);
  assert.match(asked[0].input, /\n-dangerous\(\);\n/);
});

test("#452: a change with no hunk is decided exactly: a binary base rewritten as text, and a rename the head deleted, are named; neither side is no loss", async () => {
  // The base holds a NUL; the branch and main both rewrite it as text; the worker takes main's side.
  const bin = await sentBack({ base: { "data.txt": "a\0b\n" }, commits: [{ "data.txt": "objective\n" }], main: { "data.txt": "main\n" } });
  assert.throws(() => bin.go("rebase", "-q", "origin/main"));
  bin.go("checkout", "-q", "--ours", "data.txt");
  bin.go("add", "data.txt");
  bin.go("-c", "core.editor=true", "rebase", "--continue");
  const j1 = hunkReader();
  assert.match(await bin.box.rebaseLeft({ from: bin.from, onto: bin.onto, judge: j1.judge }), /: data\.txt \([0-9a-f]{7}\): a binary or Git LFS file that is not the branch's version$/);
  assert.deepEqual(j1.asked, []);
  // The branch renames a.txt to b.txt; main removes a.txt; the worker deletes b.txt.
  const moved = await sentBack({ base: { "a.txt": lines12() }, commits: [(cwd, r) => r.run(cwd, "mv", "a.txt", "b.txt")], main: { "a.txt": null } });
  assert.throws(() => moved.go("rebase", "-q", "origin/main"));
  moved.go("rm", "-q", "--ignore-unmatch", "b.txt", "a.txt");
  moved.go("-c", "core.editor=true", "rebase", "--continue");
  const j2 = hunkReader();
  assert.match(await moved.box.rebaseLeft({ from: moved.from, onto: moved.onto, judge: j2.judge }), /: b\.txt \([0-9a-f]{7}\): the branch's change puts the file here, and the head has no such file$/);
  assert.deepEqual(j2.asked, []);
});

test("#452: the rebase check shows a file over its limit as the lines around each hunk, carried to where the head has them, every added line included", async () => {
  const big = (edits = {}, top = []) => [...top, ...Array.from({ length: 2000 }, (_, i) => edits[i + 1] ?? `line ${i + 1} of the long module`)].join("\n") + "\n";
  const shift = Array.from({ length: 100 }, (_, i) => `main's new line ${i + 1}`);
  const t = await sentBack({ base: { "big.txt": big() }, commits: [{ "big.txt": big({ 1500: "objective line 1500" }) }], main: { "big.txt": big({ 1500: "main line 1500" }, shift) } });
  assert.throws(() => t.go("rebase", "-q", "origin/main"));
  writeFileSync(join(t.r.work, "big.txt"), big({ 1500: "objective line 1500\nmain line 1500" }, shift));
  t.go("add", "big.txt");
  t.go("rebase", "--continue");
  const { asked, judge } = hunkReader();
  assert.equal(await t.box.rebaseLeft({ from: t.from, onto: t.onto, judge }), "");
  assert.equal(asked.length, 1);
  // The hunk's base lines 1497 to 1503 are 1597 to 1604 of the head (main's 100 new lines above, its own line beside
  // the branch's): 60 lines either side of them.
  const m = /\nLines (\d+) to (\d+) of the (\d+) the file has in the rebased branch, around where hunk 1 applies:\n<<<BEGIN [0-9a-f]{16}>>>\n([\s\S]*?)\n<<<END/.exec(asked[0].input);
  assert.ok(m, asked[0].input.slice(0, 400));
  assert.deepEqual(m.slice(1, 4).map(Number), [1537, 1664, 2101]);
  assert.match(m[4], /^line 1437 of the long module\n[\s\S]*\nobjective line 1500\nmain line 1500\n[\s\S]*\nline 1563 of the long module$/);
  assert.doesNotMatch(asked[0].input, /The whole file/);

  // The head with main's line only: the hunk's line is not in its window.
  const lost = await sentBack({ base: { "big.txt": big() }, commits: [{ "big.txt": big({ 1500: "objective line 1500" }) }], main: { "big.txt": big({ 1500: "main line 1500" }, shift) } });
  assert.throws(() => lost.go("rebase", "-q", "origin/main"));
  lost.go("checkout", "-q", "--ours", "big.txt");
  lost.go("add", "big.txt");
  lost.go("-c", "core.editor=true", "rebase", "--continue");
  assert.match(await lost.box.rebaseLeft({ from: lost.from, onto: lost.onto, judge: hunkReader().judge }), /: big\.txt \([0-9a-f]{7}\): hunk 1 of 1 \(@@ -1497,7 \+1497,7 @@\): the decision model \(fake\/model\) judged it lost at 0\.95$/);

  // The branch appends 200 lines where main appends 5: the window reaches the last of the branch's lines.
  const tail = Array.from({ length: 200 }, (_, i) => `objective tail ${i + 1}`);
  const mainTail = Array.from({ length: 5 }, (_, i) => `main tail ${i + 1}`);
  const app = await sentBack({ base: { "big.txt": big() }, commits: [{ "big.txt": big() + tail.join("\n") + "\n" }], main: { "big.txt": big() + mainTail.join("\n") + "\n" } });
  assert.throws(() => app.go("rebase", "-q", "origin/main"));
  writeFileSync(join(app.r.work, "big.txt"), big() + [...mainTail, ...tail].join("\n") + "\n");
  app.go("add", "big.txt");
  app.go("rebase", "--continue");
  const a = hunkReader();
  assert.equal(await app.box.rebaseLeft({ from: app.from, onto: app.onto, judge: a.judge }), "");
  assert.match(a.asked[0].input, /\nobjective tail 200\n<<<END/);

  // Both add the file (the hunk has no old line): the branch's 700 lines first in the head, main's 1,500 after them. The
  // window starts at the file's first line and reaches past the branch's last.
  const added = (who, n) => Array.from({ length: n }, (_, i) => `${who} line ${i + 1} of the added module`).join("\n") + "\n";
  const both = await sentBack({ base: { "keep.txt": "keep\n" }, commits: [{ "new.txt": added("branch", 700) }], main: { "new.txt": added("main", 1500) } });
  assert.throws(() => both.go("rebase", "-q", "origin/main"));
  writeFileSync(join(both.r.work, "new.txt"), added("branch", 700) + added("main", 1500));
  both.go("add", "new.txt");
  both.go("rebase", "--continue");
  const b = hunkReader();
  assert.equal(await both.box.rebaseLeft({ from: both.from, onto: both.onto, judge: b.judge }), "");
  assert.match(b.asked[0].input, /\nLines 1 to 760 of the 2200 the file has in the rebased branch, around where hunk 1 applies:\n<<<BEGIN [0-9a-f]{16}>>>\nbranch line 1 of the added module\n[\s\S]*\nbranch line 700 of the added module\n/);
});

/**
 * #515: a long doc table (1,200 rows) the branch edits every tenth row of, while main adds an introduction above it and
 * edits row 600 too, so the rebase conflicts there. `resolve` gets the rows and returns the worker's resolved file.
 */
const tableRow = (i, note = `notes for row ${i} of the table`) => `| model-${i} | provider-${i % 7} | ${i * 3} tokens | ${note} |`;
const table = (edit = () => null, intro = []) => [...intro, "| model | provider | context | notes |", "| --- | --- | --- | --- |", ...Array.from({ length: 1200 }, (_, k) => tableRow(k + 1, edit(k + 1) ?? undefined))].join("\n") + "\n";
const branchNote = (i) => (i % 10 === 0 ? `branch note ${i}, checked against the vendor page` : null);
const intro = Array.from({ length: 20 }, (_, i) => `Main's introduction, line ${i + 1}.`);

async function tableConflict(resolved) {
  const t = await sentBack({ base: { "docs/models.md": table() }, commits: [{ "docs/models.md": table(branchNote) }], main: { "docs/models.md": table((i) => (i === 600 ? "main note 600" : null), intro) } });
  assert.throws(() => t.go("rebase", "-q", "origin/main"));
  writeFileSync(join(t.r.work, "docs/models.md"), resolved);
  t.go("add", "docs/models.md");
  t.go("-c", "core.editor=true", "rebase", "--continue");
  return t;
}

const bothNotes = (i) => (i === 600 ? "branch note 600, checked against the vendor page; main note 600" : branchNote(i));

test("#515: a long doc table both sides edited, over 32 KiB of the branch's diff, is judged in groups of hunks and kept when every added line survives", async () => {
  const t = await tableConflict(table(bothNotes, intro));
  const branchDiff = t.r.run(t.r.work, "diff", `${t.onto}~1`, t.from, "--", "docs/models.md");
  assert.ok(Buffer.byteLength(branchDiff) > JUDGE_PATH_MAX_BYTES, `the branch's diff is ${Buffer.byteLength(branchDiff)} bytes`);
  const { asked, judge } = hunkReader();
  assert.equal(await t.box.rebaseLeft({ from: t.from, onto: t.onto, judge }), "");
  // Too large for one question: groups of hunks in order, each with the lines around its hunks and under the bound,
  // every one of the 120 hunks asked once; kept, so no hunk is asked alone.
  assert.ok(asked.length > 1 && asked.length < 120, `${asked.length} question(s)`);
  assert.deepEqual(asked.flatMap((a) => a.hunks).sort((x, y) => x - y), Array.from({ length: 120 }, (_, i) => i + 1));
  for (const a of asked) {
    assert.ok(Buffer.byteLength(a.input) <= JUDGE_PATH_MAX_BYTES, `a question of ${Buffer.byteLength(a.input)} bytes`);
    assert.deepEqual(a.hunks, Array.from({ length: a.hunks.length }, (_, i) => a.hunks[0] + i), "a group is a run of hunks");
  }
  const at600 = asked.find((a) => a.hunks.includes(60));
  assert.match(at600.input, /\+\| model-600 \|[^\n]*branch note 600, checked against the vendor page \|\n[\s\S]*around where hunk 60 applies:\n[\s\S]*\| model-600 \|[^\n]*branch note 600, checked against the vendor page; main note 600 \|/);
  // The worker's join drops one of the branch's rows: Blocked, naming that hunk; only the group holding it is asked
  // hunk by hunk, up to that hunk.
  const dropped = await tableConflict(table((i) => (i === 900 ? null : bothNotes(i)), intro));
  const d = hunkReader();
  assert.match(await dropped.box.rebaseLeft({ from: dropped.from, onto: dropped.onto, judge: d.judge }), /: docs\/models\.md \([0-9a-f]{7}\): hunk 90 of 120 \(@@ -89[0-9],7 \+89[0-9],7 @@\): the decision model \(fake\/model\) judged it lost at 0\.95$/);
  const group = d.asked.find((a) => a.hunks.length > 1 && a.hunks.includes(90)).hunks;
  const alone = d.asked.filter((a) => a.hunks.length === 1).map((a) => a.hunks[0]);
  assert.deepEqual(alone, group.filter((h) => h <= 90));
});

test("#515: at a realistic time per question, the 120-hunk table is judged well inside the check's time", async () => {
  // 10 s a question against the check's 3 minutes, scaled down 100 times: 100 ms a question, 1.8 s in all. Asked hunk by
  // hunk, one after another, it would need 12 s.
  const t = await tableConflict(table(bothNotes, intro));
  const { asked, judge } = hunkReader();
  let now = 0;
  let most = 0;
  const slow = async (item) => {
    most = Math.max(most, ++now);
    await new Promise((done) => setTimeout(done, 100));
    now--;
    return judge(item);
  };
  assert.equal(await t.box.rebaseLeft({ from: t.from, onto: t.onto, judge: slow, maxMs: 1800 }), "");
  assert.ok(most <= JUDGE_AT_ONCE && most > 1, `${most} at once`);
  assert.deepEqual(asked.flatMap((a) => a.hunks).sort((x, y) => x - y), Array.from({ length: 120 }, (_, i) => i + 1));
});

test("#515: a hunk over 32 KiB whose question with the file fits 64 KiB is judged (the #364 shape: a long rewrite of a file under 32 KiB)", async () => {
  const rows = (n, word, from = 1) => Array.from({ length: n }, (_, i) => `| ${word} row ${String(i + from).padStart(4, "0")} | column |`);
  const baseText = [...rows(600, "old"), ...rows(200, "kept", 601)].join("\n") + "\n";
  const branchRows = rows(600, "branch");
  const t = await sentBack({ base: { "docs/models.md": baseText }, commits: [{ "docs/models.md": [...branchRows, ...rows(200, "kept", 601)].join("\n") + "\n" }], main: { "docs/models.md": ["| main row 0001 | column |", ...rows(599, "old", 2), ...rows(200, "kept", 601)].join("\n") + "\n" } });
  assert.throws(() => t.go("rebase", "-q", "origin/main"));
  const resolved = [`${branchRows[0]} main row 0001 |`, ...branchRows.slice(1), ...rows(200, "kept", 601)].join("\n") + "\n";
  writeFileSync(join(t.r.work, "docs/models.md"), resolved);
  t.go("add", "docs/models.md");
  t.go("-c", "core.editor=true", "rebase", "--continue");
  const { asked, judge } = hunkReader();
  assert.equal(await t.box.rebaseLeft({ from: t.from, onto: t.onto, judge }), "");
  assert.equal(asked.length, 1);
  const hunk = /\nHunk 1 of 1 [^\n]*:\n<<<BEGIN [0-9a-f]{16}>>>\n([\s\S]*?)\n<<<END/.exec(asked[0].input)[1];
  assert.ok(Buffer.byteLength(hunk) > 32 * 1024 && Buffer.byteLength(resolved) < 32 * 1024, `a hunk of ${Buffer.byteLength(hunk)} bytes, a file of ${Buffer.byteLength(resolved)}`);
  assert.ok(Buffer.byteLength(asked[0].input) <= JUDGE_PATH_MAX_BYTES);
});

test("#515: a hunk whose own question is over 64 KiB is not judged, naming that hunk; the path's other hunks are not asked", async () => {
  // The branch rewrites 600 rows in a row (one hunk over 32 KiB) and row 1100 alone (a small hunk).
  const rewrite = (i) => (i <= 600 ? `rewritten row ${i}, with a much longer note than the table had before it` : i === 1100 ? "branch note 1100" : null);
  const t = await sentBack({ base: { "docs/models.md": table() }, commits: [{ "docs/models.md": table(rewrite) }], main: { "docs/models.md": table((i) => (i === 1100 ? "main note 1100" : null), intro) } });
  assert.throws(() => t.go("rebase", "-q", "origin/main"));
  writeFileSync(join(t.r.work, "docs/models.md"), table((i) => (i === 1100 ? "branch note 1100; main note 1100" : rewrite(i)), intro));
  t.go("add", "docs/models.md");
  t.go("-c", "core.editor=true", "rebase", "--continue");
  const { asked, judge } = hunkReader();
  assert.match(await t.box.rebaseLeft({ from: t.from, onto: t.onto, judge }), new RegExp(`: docs/models\\.md \\([0-9a-f]{7}\\): hunk 1 of 2 \\(@@ -1,605 \\+1,605 @@\\): not judged: the hunk with the lines around it is over ${JUDGE_PATH_MAX_BYTES / 1024} KiB$`));
  assert.deepEqual(asked, []);
});

test("#452: the file a hunk is judged against: an empty file is shown empty, a missing one as missing", () => {
  const hunks = [{ at: 1, text: "@@ -1 +0,0 @@\n-x" }];
  assert.match(keptInput({ path: "a", hunks, file: "" }, "t"), /The whole file as the rebased branch has it:\n<<<BEGIN t>>>\n\(an empty file\)\n<<<END t>>>$/);
  assert.match(keptInput({ path: "a", hunks, file: null }, "t"), /The whole file as the rebased branch has it:\n<<<BEGIN t>>>\n\(no such file in the rebased branch\)\n<<<END t>>>$/);
});

test("#452: in local mode a conflict pass the check cannot pass is kept on a branch of the Objective's clone, the Block says how to deliver it, and a later push removes it", async () => {
  const { sendBackGuard } = await import("../scripts/worker.mjs");
  for (const say of [0.23, "error"]) {
    const t = await staleConflict(staleFile(300, touch, markStale), { adapt: true, outbox: { local: true } });
    const head = t.r.run(t.r.work, "rev-parse", "HEAD");
    const why = await sendBackGuard({ outbox: t.box, onto: { from: t.from, base: t.onto, files: ["src/stale.ts"] }, defaultBranch: "main", judge: fakeJudge({}, say).judge, issue: 1 });
    assert.ok(
      why.endsWith(
        `; nothing of it was pushed; the conflict pass's result is kept as ${head} on the branch \`pendulum/1-conflict-pass\` of the Objective's local clone (\`.pendulum/1/repo\`). To deliver it, first check that it keeps the Objective's change and touches no secret or protected path (Pendulum's push checks did not run on it), then run \`git push --force-with-lease origin pendulum/1-conflict-pass:pendulum/1\` in that clone and re-apply the Objective's label: the stages after it validate and review that head like any other`,
      ),
      why,
    );
    assert.equal(await t.box.push(), false);
    assert.equal(t.r.run(t.r.origin, "rev-parse", "pendulum/1"), t.from, "the branch on GitHub is as it was");
    // The next stage puts the clone back on the branch as GitHub has it; the conflict pass's head stays on its branch.
    t.r.run(t.r.work, "fetch", "-q", "origin", "pendulum/1:refs/remotes/origin/pendulum/1");
    assert.equal((await t.box.putOn("refs/remotes/origin/pendulum/1")).code, 0);
    assert.equal(t.r.run(t.r.work, "rev-parse", "HEAD"), t.from);
    assert.equal(t.r.run(t.r.work, "rev-parse", "pendulum/1-conflict-pass"), head);
    if (say !== "error") continue;
    // A later stage's push supersedes it: the branch goes.
    const later = await open(t.r, { local: true });
    t.r.put(t.r.work, "more.txt", "more\n");
    t.r.run(t.r.work, "commit", "-q", "-m", "more");
    assert.equal(await later.push(), true, later.error);
    assert.throws(() => t.r.run(t.r.work, "rev-parse", "--verify", "-q", "pendulum/1-conflict-pass"));
  }
  // The branch checked out elsewhere: git cannot move it, and the Block says the result was not kept.
  const busy = await staleConflict(staleFile(300, touch, markStale), { adapt: true, outbox: { local: true } });
  busy.r.run(busy.r.work, "branch", "pendulum/1-conflict-pass", busy.from);
  busy.r.run(busy.r.work, "worktree", "add", "-q", join(busy.r.root, "wt"), "pendulum/1-conflict-pass");
  const why2 = await sendBackGuard({ outbox: busy.box, onto: { from: busy.from, base: busy.onto, files: ["src/stale.ts"] }, defaultBranch: "main", judge: fakeJudge({}, 0.23).judge, issue: 1 });
  assert.ok(why2.endsWith("; nothing of it was pushed; its result could not be kept on a branch of the Objective's local clone (`.pendulum/1/repo`) (the local loop's log says why)"), why2);
  // Nothing to keep (a merge left in progress): an earlier kept branch is removed, so none stands for this Block, which
  // says so.
  const stuck = await staleConflict(staleFile(300, touch, markStale), { outbox: { local: true } });
  stuck.r.run(stuck.r.work, "branch", "pendulum/1-conflict-pass", stuck.from);
  stuck.go("checkout", "-q", "-b", "side", "HEAD~1");
  writeFileSync(join(stuck.r.work, "x.txt"), "x\n");
  stuck.go("add", "x.txt");
  stuck.go("commit", "-q", "-m", "x");
  stuck.go("checkout", "-q", "-");
  writeFileSync(join(stuck.r.work, "x.txt"), "y\n");
  stuck.go("add", "x.txt");
  stuck.go("commit", "-q", "-m", "y");
  assert.throws(() => stuck.go("merge", "side"));
  assert.match(await sendBackGuard({ outbox: stuck.box, onto: { from: stuck.from, base: stuck.onto, files: ["src/stale.ts"] }, defaultBranch: "main", judge: fakeJudge().judge, issue: 1 }), /: the conflict pass left a merge in progress; nothing of it was pushed; this pass left nothing to keep, so the result of an earlier one kept on the branch `pendulum\/1-conflict-pass` of the Objective's local clone \(`\.pendulum\/1\/repo`\) was removed$/);
  assert.throws(() => stuck.r.run(stuck.r.work, "rev-parse", "--verify", "-q", "pendulum/1-conflict-pass"));
  // On Actions the runner keeps nothing: no branch, and the Block says only that nothing was pushed.
  const a = await staleConflict(staleFile(300, touch, markStale), { adapt: true });
  const why = await sendBackGuard({ outbox: a.box, onto: { from: a.from, base: a.onto, files: ["src/stale.ts"] }, defaultBranch: "main", judge: fakeJudge({}, 0.23).judge });
  assert.ok(why.endsWith("; nothing of it was pushed"), why);
  assert.throws(() => a.r.run(a.r.work, "rev-parse", "--verify", "-q", "pendulum/1-conflict-pass"));
});

/** #452: a decider that answers the whole path's question with `whole` and each hunk asked alone with `alone`. */
function wholeThenAlone(whole, alone) {
  const asked = [];
  const decider = {
    name: "fake",
    model: "fake/model",
    async decide(input) {
      const n = (input.match(/\nHunk \d+ of \d+ /g) || []).length;
      asked.push(n);
      return n > 1 ? whole : alone;
    },
  };
  return { asked, judge: openKeptCheck({ inputs: { triageModel: "fake/model" }, decider }).judge };
}

test("#452: a sure `lost` for the whole path stands though every hunk asked alone reads kept; an unsure one gives way to them", async () => {
  const { sendBackGuard } = await import("../scripts/worker.mjs");
  // Sure lost for the whole (0.95, over the 0.7 floor), each hunk alone kept: still Blocked, nothing pushed.
  const dropped = await staleConflict(staleFile(300, touch));
  const sure = wholeThenAlone({ verdict: "lost", confidence: 0.95 }, { verdict: "kept", confidence: 0.8 });
  const why = await sendBackGuard({ outbox: dropped.box, onto: { from: dropped.from, base: dropped.onto, files: ["src/stale.ts"] }, defaultBranch: "main", judge: sure.judge });
  assert.match(why, /: src\/stale\.ts \([0-9a-f]{7}\): the decision model \(fake\/model\) judged it lost at 0\.95 for the file as a whole, though no hunk asked alone was; nothing of it was pushed$/);
  assert.deepEqual(sure.asked, [2, 1, 1]);
  assert.equal(await dropped.box.push(), false);
  // Unsure for the whole (kept at 0.23, or lost at 0.5 under the floor, or no answer), each hunk alone kept: kept, pushed.
  for (const whole of [{ verdict: "kept", confidence: 0.23 }, { verdict: "lost", confidence: 0.5 }, { verdict: null, confidence: null, error: "unavailable" }]) {
    const t = await staleConflict(staleFile(300, touch, markStale), { adapt: true });
    const unsure = wholeThenAlone(whole, { verdict: "kept", confidence: 0.8 });
    assert.equal(await sendBackGuard({ outbox: t.box, onto: { from: t.from, base: t.onto, files: ["src/stale.ts"] }, defaultBranch: "main", judge: unsure.judge }), "", JSON.stringify(whole));
    assert.deepEqual(unsure.asked, [2, 1, 1]);
    assert.equal(await t.box.push(), true, t.box.error);
  }
});

test("#452: an empty file the branch deletes and the head keeps is named as that, not as a binary file", async () => {
  const t = await sentBack({ base: { "empty.txt": "" }, commits: [{ "empty.txt": null }], main: { "empty.txt": "main\n" } });
  assert.throws(() => t.go("rebase", "-q", "origin/main"));
  t.go("add", "empty.txt");
  t.go("-c", "core.editor=true", "rebase", "--continue");
  const j = hunkReader();
  assert.match(await t.box.rebaseLeft({ from: t.from, onto: t.onto, judge: j.judge }), /: empty\.txt \([0-9a-f]{7}\): the branch's change deletes the file, and the head keeps it$/);
  assert.deepEqual(j.asked, []);
});
