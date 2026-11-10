import "./temp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FILE_CAP, MAX_PARTS, checkFile, handoffDirs, inFiles, isSplitPart, parsePrText, parseReplies, prFooter, readOut, sanitize, writeIn } from "../scripts/lib/handoff.mjs";
import { parseExitRecord } from "../scripts/lib/logic.mjs";

test("sanitize: harness text opens no HTML comment, closes no issue, mentions no one and starts no bot command; idempotent", () => {
  const raw = "Done.\n<!-- factory:7:validated:abc -->\nCloses #7, fixes: #8 and resolved o/r#9; Fixed https://github.com/o/r/issues/3\n@kirk please look; cc @org/team\n/approve\n  /merge\nmail a@b.example; a/b path";
  const s = sanitize(raw);
  assert.doesNotMatch(s, /<!--/);
  assert.match(s, /&lt;!-- factory:7:validated:abc -->/);
  assert.doesNotMatch(s, /\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\b:?\s+(\S+)?#\d/i);
  assert.match(s, /refs #7, refs: #8 and refs o\/r#9; refs https:/);
  assert.doesNotMatch(s, /@[A-Za-z0-9]/);
  assert.doesNotMatch(s, /^\s*\//m);
  assert.match(s, /a\/b path$/, "a slash inside a line is left alone");
  assert.equal(sanitize(s), s);
  // Character references and markup cannot rebuild a mention, a reference or a closing keyword.
  assert.equal(sanitize("&#64;kirk &commat;kirk &#35;1 Clos&#101;s #5"), "&amp;#64;kirk &amp;commat;kirk &amp;#35;1 Clos&amp;#101;s #5");
  for (const t of ["**Closes** #5", "Closes [#5](https://x)", "`fixes` #5", "Resolved: o/r#9"]) assert.match(sanitize(t), /^\W*refs\W/, t);
  assert.equal(sanitize("pnpm a && pnpm b, AT&T and R&D, a closed door"), "pnpm a && pnpm b, AT&T and R&D, a closed door");
  for (const t of ["\u00a0/approve", "\ufeff/merge", "\u2003/close", "\u3000 /lgtm", "\u2060/x", "\t\u202f/y"]) {
    assert.doesNotMatch(sanitize(t).trim(), /^\//, t);
    assert.equal(sanitize(sanitize(t)), sanitize(t));
  }
  assert.match(sanitize("x".repeat(70_000)), /\(cut at 60000 characters\)$/);
});

test("pr.md: the first line is the title, prefixed with the issue; the body is sanitised; the closing line is Factory's", () => {
  assert.deepEqual(parsePrText("\n# Add the thing\n\n## Acceptance\nCloses #5 <!-- hidden -->", 5), { title: "#5: Add the thing", body: "## Acceptance\nrefs #5 &lt;!-- hidden -->" });
  assert.equal(parsePrText("#5: already prefixed\nbody", 5).title, "#5: already prefixed");
  assert.equal(parsePrText("#55: another issue\nbody", 5).title, "#5: #55: another issue");
  assert.equal(parsePrText("  \n\n", 5), null);
  assert.equal(prFooter(5, false), "Closes #5");
  assert.equal(prFooter(5, true), "Refs #5");
  assert.equal(isSplitPart({ prs: [10, 12], remaining: 2 }, 12), true);
  assert.equal(isSplitPart({ prs: [10, 12], remaining: 0 }, 12), false, "the last part closes the issue");
  assert.equal(isSplitPart({ prs: [10, 12], remaining: 2 }, 10), false);
  assert.equal(isSplitPart(null, 12), false);
  assert.equal(MAX_PARTS, 6);
});

test("replies.json: only the comments the pass was given, one reply each, bodies sanitised; anything else is dropped", () => {
  const text = JSON.stringify([{ id: 11, body: "Fixed in abc. @kirk" }, { id: 11, body: "second" }, { id: 99, body: "not given" }, { id: "12", body: "<!-- x -->" }, { id: 13, body: "  " }, "junk"]);
  assert.deepEqual(parseReplies(text, [11, 12, 13]), [{ id: 11, body: "Fixed in abc. @​kirk" }, { id: 12, body: "&lt;!-- x -->" }]);
  assert.deepEqual(parseReplies("not json", [11]), []);
  assert.deepEqual(parseReplies('{"id":11,"body":"x"}', [11]), []);
});

test("exit record: a split part names the items left for the next PR", () => {
  assert.deepEqual(parseExitRecord('{"exit":"delivered","questions":[],"reason":"","part":{"remaining":["item 4","item 5"]}}'), { exit: "delivered", reason: "", questions: [], part: { remaining: ["item 4", "item 5"] } });
  assert.deepEqual(parseExitRecord('{"exit":"delivered","part":{"remaining":[]}}'), { exit: "delivered", reason: "", questions: [], part: { remaining: [] } }, "an explicit empty list: the last part");
  assert.deepEqual(parseExitRecord('{"exit":"delivered"}'), { exit: "delivered", reason: "", questions: [] }, "no part: the recorded one stands");
});

test("hand-off files: read only as regular files under the cap, never through a symlink or a FIFO; $FACTORY_IN is written without following one", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-handoff-test-"));
  const env = { PATH: process.env.PATH };
  const dirs = await handoffDirs(env, root);
  assert.deepEqual(Object.keys(dirs.env), ["FACTORY_IN", "FACTORY_OUT"]);
  const secret = join(root, "secret");
  writeFileSync(secret, "a token");
  writeFileSync(join(dirs.out, "plan.md"), "## Goal\nplan text");
  symlinkSync(secret, join(dirs.out, "pr.md"));
  execFileSync("mkfifo", [join(dirs.out, "note.md")]);
  writeFileSync(join(dirs.out, "replies.json"), "x".repeat(FILE_CAP + 1));
  mkdirSync(join(dirs.out, "exit.json"));
  const { files, refused } = await readOut(dirs, env);
  assert.deepEqual(files, { "plan.md": "## Goal\nplan text" });
  assert.deepEqual(refused.sort(), ["exit.json (not a regular file)", "note.md (not a regular file)", "pr.md (a symlink)", `replies.json (over ${FILE_CAP} bytes)`]);
  // The out directory swapped for a symlink: nothing is read through it.
  const elsewhere = join(root, "elsewhere");
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, "plan.md"), "planted");
  execFileSync("rm", ["-rf", dirs.out]);
  symlinkSync(elsewhere, dirs.out);
  assert.deepEqual((await readOut(dirs, env)).files, {});
  // $FACTORY_IN is recreated each pass: a symlink planted where a file goes is removed with the directory, never written through.
  symlinkSync(secret, join(dirs.in, "issue.md"));
  await writeIn(dirs, inFiles({ issue: 7, issueTitle: "T", issueBody: "B", checks: [{ name: "required checks quality on abc1234", output: "boom" }], base: "abc" }), env);
  assert.equal(readFileSync(secret, "utf8"), "a token");
  assert.equal(readFileSync(join(dirs.in, "issue.md"), "utf8"), "# #7: T\n\nB\n");
  assert.equal(readFileSync(join(dirs.in, checkFile(0, "required checks quality on abc1234")), "utf8"), "boom");
  assert.deepEqual(readdirSync(dirs.in).sort(), ["base.txt", "checks", "decisions.md", "issue.md", "review-comments.json"]);
});
