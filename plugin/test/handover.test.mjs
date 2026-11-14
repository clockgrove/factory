// The workflow hand-over (#226): Factory never pushes a change under .github/workflows/; the worker hands it over in
// $FACTORY_OUT/workflow.patch and Factory publishes it for a person to apply. Real git for the outbox's check and the
// person's one command; a fetch fake for GitHub.
import "./temp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PLUGIN_ROOT } from "../scripts/lib/checkout.mjs";
import { FACTORY_PROTECTED, decideExit, protectedPaths, renderTaskCard, setSelf, taskCardValues } from "../scripts/lib/logic.mjs";
import { HANDOVER_LABEL, handoverNotice, handoverOf, handoverProblem, handoverSection, patchFiles, plannedWorkflows, withoutHandover, workflowPathsNamed } from "../scripts/lib/handover.mjs";
import { OUT_FILES, handoverChecker, handoverUpFront, inFiles, publishPr, sanitize } from "../scripts/lib/handoff.mjs";
import { openOutbox } from "../scripts/lib/outbox.mjs";
import { configureGit } from "../scripts/lib/session.mjs";

const quiet = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const env = { ...process.env, ...quiet };
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", env }).trim();
const repo = { owner: "acme", name: "app", full: "acme/app" };

/** An origin whose main has a workflow and an app file, and a clone on factory/7 with a workflow change made and a patch of it. */
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
  const patch = execFileSync("git", ["-C", work, "diff", "--", ".github/workflows"], { encoding: "utf8", env });
  git(work, "reset", "-q", "--", ".github/workflows");
  git(work, "checkout", "--", ".github/workflows");
  git(work, "clean", "-qfd", "--", ".github/workflows");
  return { root, origin, work, patch };
}

const openBox = (r) => openOutbox({ branch: "factory/7", defaultBranch: "main", checkout: r.work, remote: r.origin, agentEnv: env, protectedList: [".github/"], base: r.root });

test("hand-over: the paths an issue names and a plan's Needs-Workflow lines, never other text", () => {
  assert.deepEqual(workflowPathsNamed("Add a macOS leg to .github/workflows/ci.yml and a new `.github/workflows/release.yml`."), [".github/workflows/ci.yml", ".github/workflows/release.yml"]);
  assert.deepEqual(workflowPathsNamed("Anything under .github/workflows/ needs a person."), [".github/workflows/"]);
  assert.deepEqual(workflowPathsNamed("Run the tests in CI on macOS. docs/.github/workflows-notes.md, x.github/workflows/a.yml"), []);
  const plan = "## Checklist\n1. Needs-Workflow: `.github/workflows/release.yml` builds and attests\n- **Needs-Workflow:** .github/workflows/ci.yml, the macOS leg\nNeeds-Workflow: none\nNeeds-Workflow: src/ci.yml\n```\nNeeds-Workflow: .github/workflows/fenced.yml\n```\n";
  assert.deepEqual(plannedWorkflows(plan), [".github/workflows/release.yml", ".github/workflows/ci.yml"]);
});

test("hand-over: a patch goes out only as git's own diff of workflow files, with nothing the PR body or the command would misread", () => {
  const ok = "diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml\n--- a/.github/workflows/ci.yml\n+++ b/.github/workflows/ci.yml\n@@ -1 +1 @@\n-a\n+b\n";
  const files = [".github/workflows/ci.yml"];
  assert.equal(handoverProblem(ok, { files }), "");
  assert.match(handoverProblem(`Why: macOS\n${ok}`, { files }), /is not a git diff/);
  assert.match(handoverProblem(ok, { files: [...files, "app.txt"] }), /changes app\.txt outside \.github\/workflows\/; commit those/);
  assert.match(handoverProblem(ok.replace("+b", "+<!-- factory:7:review -->"), { files }), /HTML comment opener/);
  assert.match(handoverProblem(`${ok}WORKFLOW_PATCH_END\n`, { files }), /carries the line WORKFLOW_PATCH_END/);
  assert.match(handoverProblem(ok.replace("+b", "+b\r"), { files }), /carriage returns/);
  assert.match(handoverProblem(`${ok}new file mode 120000\n`, { files }), /symlink or a submodule/);
  assert.match(handoverProblem(ok, { files, binary: true }), /binary/);
  assert.match(handoverProblem(ok + "+x\n".repeat(16_000), { files }), /over 30000/);
  assert.match(handoverProblem(ok, { files: [] }), /changes no file/);
});

test("hand-over: Factory's mirror reads the patch with git and checks it applies to the branch as GitHub has it", async () => {
  const r = repos();
  writeFileSync(join(r.work, "app.txt"), "v2\n");
  git(r.work, "commit", "-qam", "work");
  const box = await openBox(r);
  assert.equal(await box.push(), true, box.error);
  assert.deepEqual(await box.handover(r.patch), { ok: true });
  // A change outside .github/workflows/ is the worker's to commit, read from git's numstat (a rename's both sides too).
  const app = "diff --git a/app.txt b/app.txt\n--- a/app.txt\n+++ b/app.txt\n@@ -1 +1 @@\n-v2\n+v3\n";
  assert.match((await box.handover(r.patch + app)).problem, /changes app\.txt outside/);
  const rename = "diff --git a/.github/workflows/ci.yml b/ci.yml\nsimilarity index 100%\nrename from .github/workflows/ci.yml\nrename to ci.yml\n";
  assert.match((await box.handover(rename)).problem, /changes ci\.yml outside/);
  // A patch made against another version of the file does not apply.
  assert.match((await box.handover(r.patch.replace("-on: push", "-on: schedule"))).problem, /does not apply to factory\/7 as GitHub has it/);
  assert.match((await box.handover("diff --git nonsense\n")).problem, /is no patch git can read|changes no file/);
  // With nothing pushed, the default branch's tree is the one it must apply to.
  const fresh = repos();
  const box2 = await openBox(fresh);
  assert.deepEqual(await box2.handover(fresh.patch), { ok: true });
});

test("hand-over: the section a person runs applies the patch on a new branch from the default branch and opens its PR, in one step", () => {
  const r = repos();
  const section = handoverSection({ issue: 7, patch: r.patch, defaultBranch: "main" });
  assert.equal(handoverOf(section, 7), r.patch, "Factory reads back exactly what it published");
  assert.deepEqual(patchFiles(r.patch), [".github/workflows/ci.yml", ".github/workflows/release.yml"]);
  // The fenced command, as a person copies it, run in a fresh clone with a recording `gh`.
  const lines = section.split("\n");
  const open = lines.findIndex((l) => /^`{3,}sh$/.test(l));
  const fence = lines[open].replace(/sh$/, "");
  const command = lines.slice(open + 1, lines.indexOf(fence, open + 1)).join("\n");
  const person = join(r.root, "person");
  execFileSync("git", ["clone", "-q", r.origin, person], { env });
  const bin = join(r.root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "$@" > ${JSON.stringify(join(r.root, "gh-args"))}\n`);
  chmodSync(join(bin, "gh"), 0o755);
  execFileSync("bash", ["-c", command], { cwd: person, env: { ...env, PATH: `${bin}:${process.env.PATH}` }, stdio: "pipe" });
  assert.equal(git(r.origin, "show", "factory-workflow/7:.github/workflows/ci.yml"), "name: ci\non: [push, pull_request]");
  assert.equal(git(r.origin, "show", "factory-workflow/7:.github/workflows/release.yml"), "name: release\non: workflow_dispatch");
  assert.equal(git(r.origin, "log", "-1", "--format=%s", "factory-workflow/7"), "#7: the workflow change Factory handed over");
  assert.equal(readFileSync(join(r.root, "gh-args"), "utf8").trim(), "pr create --fill");
  // A backtick run in the patch gets a longer fence, so the block stays one block.
  assert.match(handoverSection({ issue: 7, patch: r.patch.replace("name: release", "name: ````x"), defaultBranch: "main" }), /^`{5}sh$/m);
});

test("hand-over: $FACTORY_IN carries the PR's patch apart from its body; a copy of Factory's section in harness text is cut", () => {
  const r = repos();
  const body = `## Acceptance\n- done\n\n${handoverSection({ issue: 7, patch: r.patch, defaultBranch: "main" })}\n\nCloses #7\n`;
  const files = inFiles({ issue: 7, issueTitle: "t", issueBody: "b", pr: { title: "#7: t", body } });
  assert.equal(files["workflow.patch"], r.patch);
  assert.equal(files["pr.md"], "#7: t\n\n## Acceptance\n- done\n");
  assert.equal(withoutHandover(sanitize(body), 7), "## Acceptance\n- done", "the marker as sanitize leaves it");
  assert.ok(OUT_FILES.includes("workflow.patch"));
  assert.equal(inFiles({ issue: 7, issueTitle: "t", issueBody: "b", pr: { title: "#7: t", body: "plain" } })["workflow.patch"], undefined);
});

/** A fetch fake over acme/app: the PR (`pr`, null for none), comments, and every write recorded as METHOD path body. */
function fakeApi({ pr = null, comments = [] } = {}) {
  const writes = [];
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
      return json({});
    }
    if (path === "/pulls") return json(pr ? [pr] : []);
    if (/\/comments$/.test(path)) return json(comments);
    return json({ message: "Not Found" }, 404);
  };
  return {
    writes,
    restore() {
      globalThis.fetch = real;
      if (saved === undefined) delete process.env.GITHUB_API_URL;
      else process.env.GITHUB_API_URL = saved;
    },
  };
}

test("hand-over: the PR carries Factory's section before its closing line; the issue gets the label and the notice; undefined keeps it, empty drops it", async () => {
  const r = repos();
  setSelf("acme-factory[bot]");
  let api = fakeApi();
  try {
    const out = await publishPr(repo, { branch: "factory/7", base: "main", issue: 7, issueTitle: "t", prText: "#7: t\n\n## Undone\n- the release workflow: handed over", handover: r.patch }, { token: "t" });
    const created = api.writes.find((w) => w.path === "/pulls");
    assert.match(created.body.body, /^## Undone\n- the release workflow: handed over\n\n<!-- factory:7:handover -->\n## Workflow hand-over\n/);
    assert.match(created.body.body, /\nWORKFLOW_PATCH_END\n`{3}\n\nCloses #7\n$/);
    assert.equal(handoverOf(out.body, 7), r.patch);
    assert.deepEqual(api.writes.find((w) => w.path === "/issues/7/labels").body, { labels: [HANDOVER_LABEL] });
    const notice = api.writes.find((w) => w.path === "/issues/7/comments");
    assert.match(notice.body.body, /^<!-- factory:7:handover -->\nFactory: PR #70 carries a workflow hand-over for `\.github\/workflows\/ci\.yml`, `\.github\/workflows\/release\.yml`\./);
  } finally {
    api.restore();
  }
  // A pass that left no workflow.patch: the PR keeps its section, and the issue is not touched again.
  const carried = { number: 70, title: "#7: t", body: `old\n\n${handoverSection({ issue: 7, patch: r.patch, defaultBranch: "main" })}\n\nCloses #7\n` };
  api = fakeApi({ pr: carried });
  try {
    const out = await publishPr(repo, { branch: "factory/7", base: "main", issue: 7, prText: "#7: t\n\nnew", pr: carried }, { token: "t" });
    assert.equal(handoverOf(out.body, 7), r.patch);
    assert.match(out.body, /^new\n\n<!-- factory:7:handover -->/);
    assert.deepEqual(api.writes.map((w) => `${w.method} ${w.path}`), ["PATCH /pulls/70"]);
  } finally {
    api.restore();
  }
  // An empty workflow.patch: no hand-over now, so the section, the label and the notice's claim go.
  api = fakeApi({ pr: carried });
  try {
    const out = await publishPr(repo, { branch: "factory/7", base: "main", issue: 7, prText: "#7: t\n\nnew", pr: carried, handover: "" }, { token: "t" });
    assert.equal(out.body, "new\n\nCloses #7\n");
    assert.deepEqual(api.writes.map((w) => `${w.method} ${w.path}`), ["PATCH /pulls/70", `DELETE /issues/7/labels/${HANDOVER_LABEL}`, "POST /issues/7/comments"]);
    assert.equal(api.writes.at(-1).body.body, "<!-- factory:7:handover -->\nFactory: PR #70 carries no workflow hand-over.");
  } finally {
    api.restore();
  }
});

test("hand-over: before any harness, an issue naming workflow files gets the notice once; a notice Factory already wrote stands", async () => {
  setSelf("acme-factory[bot]");
  let api = fakeApi();
  try {
    assert.equal(await handoverUpFront(repo, 7, { named: [] }, { token: "t" }), false);
    assert.equal(await handoverUpFront(repo, 7, { named: [".github/workflows/ci.yml"] }, { token: "t" }), true);
    assert.equal(api.writes.length, 1);
    assert.equal(api.writes[0].body.body, `<!-- factory:7:handover -->\n${handoverNotice({ named: [".github/workflows/ci.yml"] })}`);
    assert.match(api.writes[0].body.body, /text names `\.github\/workflows\/ci\.yml`\. Factory never pushes a change under `\.github\/workflows\/`.*the worker hands that part over: the PR carries the exact patch and why/);
  } finally {
    api.restore();
  }
  api = fakeApi({ comments: [{ id: 1, user: { login: "acme-factory[bot]", type: "Bot" }, body: "<!-- factory:7:handover -->\nFactory: PR #70 carries a workflow hand-over" }] });
  try {
    assert.equal(await handoverUpFront(repo, 7, { named: [".github/workflows/ci.yml"], from: "plan" }, { token: "t" }), false);
    assert.deepEqual(api.writes, []);
  } finally {
    api.restore();
  }
});

test("hand-over: the checker gives the patch, none, or keeps the PR's, and names a refused one for the Block", async () => {
  let files = {};
  const box = { handover: async (t) => (t.includes("app.txt") ? { ok: false, problem: "changes app.txt outside .github/workflows/; commit those" } : { ok: true }) };
  const c = handoverChecker(() => files, box);
  assert.equal(await c.now(), undefined, "no file: the PR keeps what it carries");
  files = { "workflow.patch": "  \n" };
  assert.equal(await c.now(), "");
  files = { "workflow.patch": "diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml" };
  assert.equal(await c.now(), "diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml\n");
  assert.equal(c.refused(), "");
  files = { "workflow.patch": "diff --git a/app.txt b/app.txt\n" };
  assert.equal(await c.now(), undefined);
  assert.equal(c.refused(), "the workflow hand-over ($FACTORY_OUT/workflow.patch) changes app.txt outside .github/workflows/; commit those; Factory did not publish it");
});

test("hand-over: the exit Blocks on a refused hand-over; a run that left only a hand-over Blocks as a setting, not the work", () => {
  const ok = { ok: true };
  const pr = { exists: true, draft: false, body: "" };
  assert.deepEqual(decideExit({ harness: ok, pr, commits: 2, validation: { passes: 1, green: true }, handoverRefused: "the workflow hand-over ($FACTORY_OUT/workflow.patch) carries a binary change; Factory did not publish it" }), { exit: "blocked", reason: "the workflow hand-over ($FACTORY_OUT/workflow.patch) carries a binary change; Factory did not publish it", cause: "work" });
  assert.deepEqual(decideExit({ harness: ok, pr, commits: 2, validation: { passes: 1, green: true } }), { exit: "delivered", reason: "" }, "a PR with a hand-over is delivered like any other");
  assert.deepEqual(decideExit({ harness: ok, pr: null, commits: 0, record: { exit: "delivered", questions: [] }, handoverOnly: true }), { exit: "blocked", reason: "the whole change is a workflow hand-over, which Factory never pushes: a person applies it with the command in the hand-over comment on this issue", cause: "setup" });
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
  assert.match(card, /- `workflow\.patch`: only when the Objective needs a change under `\.github\/workflows\/`, which Factory never pushes: that change as `git diff` writes it, kept out of your commits, for a person to apply \(factory-deliver-pr\)\. `\$FACTORY_IN\/workflow\.patch` is the one the PR carries now\./);
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
  assert.match(worker, /if \(decision\.exit === "blocked" && !pr && !delta\.count && handoverLeft\) await handoverOnIssue\(/);
  const review = src("review.mjs");
  assert.match(review, /const handover = handoverChecker\(\(\) => io\.files\(\), outbox\);\n\s+const publish = async \(current\) => publishPr\(repo, \{[^\n]*handover: await handover\.now\(\) \}/);
  assert.match(review, /handoverRefused: handover\.refused\(\),/);
  const local = src("local.mjs");
  const deliver = local.slice(local.indexOf("async function deliver("));
  assert.match(deliver, /const checker = handoverChecker\(\(\) => files, outbox\);/);
  assert.match(deliver, /publishPr\(repo, \{[^\n]*pr: open, handover \}, opts\)/);
  assert.match(deliver, /await handoverOnIssue\(repo, \{ issue, patch: handover, defaultBranch \}, opts\);/);
});
