// The outbox after a send-back's conflict pass: what the rebase left (rebaseLeft) and whether the branch's work survived
// it (the rebase check: #243, #362, #452, #515). Real git repositories throughout (fixtures/outbox.mjs).
import "./temp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { JUDGE_PATH_MAX_BYTES } from "../scripts/lib/outbox.mjs";
import { KEPT_QUESTION, openKeptCheck } from "../scripts/lib/kept.mjs";
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

test("outbox: rebaseLeft reads what a send-back's conflict pass left: resolved, aborted, stopped mid-rebase, or a commit skipped (#243, #362)", async () => {
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

  // Aborted: the branch is as it was, not on main.
  const aborted = await conflictPass(async ({ go }) => go("rebase", "--abort"));
  assert.equal(aborted.left, "the branch it left is not rebased onto it");

  // Stopped on the first commit: HEAD is main itself, with the rebase in progress.
  const first = await conflictPass(async () => {});
  assert.equal(first.left, "the conflict pass left a rebase in progress");

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
  assert.ok(skipped.left.includes(`app.txt (${c1})`), skipped.left);
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

test("#452: in local mode a conflict pass the check cannot pass is kept on a branch of the Objective's clone, and nothing of it is pushed", async () => {
  const { sendBackGuard } = await import("../scripts/worker.mjs");
  const t = await staleConflict(staleFile(300, touch, markStale), { adapt: true, outbox: { local: true } });
  const head = t.r.run(t.r.work, "rev-parse", "HEAD");
  const why = await sendBackGuard({ outbox: t.box, onto: { from: t.from, base: t.onto, files: ["src/stale.ts"] }, defaultBranch: "main", judge: fakeJudge({}, 0.23).judge, issue: 1 });
  assert.ok(why.includes("pendulum/1-conflict-pass"), why);
  assert.equal(await t.box.push(), false);
  assert.equal(t.r.run(t.r.origin, "rev-parse", "pendulum/1"), t.from, "the branch on GitHub is as it was");
  // The next stage puts the clone back on the branch as GitHub has it; the conflict pass's head stays on its branch.
  t.r.run(t.r.work, "fetch", "-q", "origin", "pendulum/1:refs/remotes/origin/pendulum/1");
  assert.equal((await t.box.putOn("refs/remotes/origin/pendulum/1")).code, 0);
  assert.equal(t.r.run(t.r.work, "rev-parse", "HEAD"), t.from);
  assert.equal(t.r.run(t.r.work, "rev-parse", "pendulum/1-conflict-pass"), head);
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
