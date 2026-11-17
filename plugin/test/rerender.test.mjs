import "./temp.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { resolveInputs } from "../scripts/lib/inputs.mjs";
import { keptArgs, keptNotify, pickRunner, settingsReport, workflowSettings, workflowText } from "../scripts/setup.mjs";

const PLUGIN = join(import.meta.dirname, "..");
const template = readFileSync(join(PLUGIN, "workflow-template.yml"), "utf8");
const LATEST = "v0.7.121";

/** setup --apply workflow's render with the network answers given: `explicit` the command line, `text` the existing file. */
function render(explicit, { text = null, notify = null, defaultBranch = "main" } = {}) {
  const before = text ? workflowSettings(text) : null;
  const args = { ...keptArgs(before, explicit, template), ...explicit };
  const inputs = resolveInputs({ args, env: {} });
  const sandbox = String(args.sandbox || "");
  const runsOn = sandbox ? null : pickRunner(args.runs_on, {}, {}).runsOn;
  const out = workflowText({ template, inputs, args, explicit, before, latest: LATEST, notify: keptNotify(before, explicit) || notify || "", runsOn, ciWorkflow: args.ci_workflow || "CI", defaultBranch });
  return { text: out, before, after: workflowSettings(out), report: settingsReport(before, workflowSettings(out), explicit) };
}

const CUSTOM = {
  harness: "codex",
  credential: "plan",
  max_concurrent: "2",
  daily_usd: "50",
  max_usd: "20",
  timeout_minutes: "90",
  auto_merge: "false",
  setup: "scripts/ci/setup.sh",
  install: "none",
  validation: "npm run check, npm test, npm run test:db",
  budget_command: "node scripts/budget.mjs",
  protected_paths: "scripts/ci/setup.sh, .github/",
  ci_checks: "quality, tests",
  maintainers: "alice#77,bob#88",
  runs_on: "[self-hosted, linux]",
  ci_workflow: "Quality",
  node_version: "24",
};

test("a re-render with no options keeps every setting a custom render states, on both routes", () => {
  for (const extra of [{}, { sandbox: "vercel", image_refresh: "nightly", sandbox_idle_days: "3" }]) {
    const first = render({ ...CUSTOM, ...extra }, { notify: "kirk#318831919" });
    assert.equal(first.after.env.PENDULUM_MAX_USD, "20");
    // The launch gate (sandbox route) holds the maintainer ids; the runner route has none.
    assert.deepEqual(first.after.ids, extra.sandbox ? [318831919, 77, 88] : []);
    const again = render({}, { text: first.text });
    assert.deepEqual(again.after, first.after, `route ${extra.sandbox || "runner"}`);
    assert.equal(again.text, first.text);
    assert.deepEqual(again.report.filter((l) => !l.startsWith("kept ")), []);
  }
});

test("the real case: the scratch repository's workflow at 96ce800 keeps its validation, setup, checks, notify, plan credential, caps and timeout", () => {
  const text = readFileSync(join(PLUGIN, "test/fixtures/scratch-96ce800.yml"), "utf8");
  const r = render({}, { text });
  // Every setting the file states stays; one the template gained since the file was written comes in at its default.
  assert.deepEqual(r.after.env, { ...r.before.env, PENDULUM_IMAGE_MAX_AGE_DAYS: "7" });
  for (const [k, v] of Object.entries({
    PENDULUM_VALIDATION: "npm run check, npm test, npm run test:db",
    PENDULUM_SETUP: "scripts/ci/setup.sh",
    PENDULUM_CI_CHECKS: "quality",
    PENDULUM_PROTECTED_PATHS: "scripts/ci/setup.sh",
    PENDULUM_NOTIFY: "kirkmarple-clockgrove#318831919",
    PENDULUM_CREDENTIAL: "plan",
    PENDULUM_MAX_CONCURRENT: "2",
    PENDULUM_DAILY_USD: "50",
    PENDULUM_MAX_USD: "20",
    PENDULUM_TIMEOUT_MINUTES: "90",
    PENDULUM_SANDBOX: "vercel",
  }))
    assert.equal(r.after.env[k], v, k);
  assert.deepEqual(r.after.ids, [318831919]);
  assert.equal(r.after.ciWorkflow, "Quality");
  // The new template's jobs (the launch gate's tick output, the dequeued trigger) need this release's Action.
  assert.equal(r.after.action, `clockgrove/pendulum@${LATEST}`);
  assert.match(r.text, /types: \[labeled, ready_for_review, closed, dequeued\]/);
  assert.deepEqual(r.report, [
    `kept ${Object.keys(r.before.env).join(", ")}, launch gate maintainer ids, CI workflow`,
    `changed action "clockgrove/pendulum@v0.7.106" -> "clockgrove/pendulum@${LATEST}" (the newest release: the template is that release's)`,
    'new in this template PENDULUM_IMAGE_MAX_AGE_DAYS="7"',
  ]);
});

test("an option on the command line wins over the existing file, and the report names it", () => {
  const first = render({ ...CUSTOM, sandbox: "vercel" }, { notify: "kirk#318831919" });
  const r = render({ max_usd: "10", setup: "", notify: "carol" }, { text: first.text, notify: "carol#99" });
  assert.equal(r.after.env.PENDULUM_MAX_USD, "10");
  assert.equal(r.after.env.PENDULUM_SETUP, "");
  assert.equal(r.after.env.PENDULUM_NOTIFY, "carol#99");
  assert.equal(r.after.env.PENDULUM_DAILY_USD, "50");
  // The old notify id goes with the old notify; the other maintainers stay.
  assert.deepEqual(r.after.ids, [99, 77, 88]);
  const changed = r.report.find((l) => l.startsWith("changed "));
  assert.match(changed, /PENDULUM_MAX_USD "20" -> "10" \(--max-usd\)/);
  assert.match(changed, /PENDULUM_SETUP "scripts\/ci\/setup.sh" -> "" \(--setup\)/);
  assert.match(changed, /launch gate maintainer ids "318831919,77,88" -> "99,77,88" \(--notify\)/);
  // A new harness takes its own models, not the file's.
  const moved = render({ harness: "claude" }, { text: first.text });
  assert.equal(moved.after.env.PENDULUM_MODEL, "claude-opus-5-5");
  assert.equal(moved.after.env.PENDULUM_MAX_USD, "20");
  // --sandbox= leaves the sandbox route: its keys are reported as dropped, the runner kept from no file.
  const off = render({ sandbox: "" }, { text: render({ ...CUSTOM, sandbox: "vercel" }).text });
  assert.equal(off.after.env.PENDULUM_SANDBOX, undefined);
  assert.ok(off.report.includes("dropped PENDULUM_SANDBOX (--sandbox)"));
  assert.ok(off.report.some((l) => l.startsWith("dropped (not on this route) PENDULUM_SANDBOX_VCPUS,")));
});

test("env keys the template does not write, their comment lines, and hand-set values of fixed ones, survive a re-render", () => {
  const first = render({ ...CUSTOM, sandbox: "vercel" });
  const edited = first.text
    .replace("  PENDULUM_SANDBOX_VCPUS: 2 #", "  PENDULUM_SANDBOX_VCPUS: 4 #")
    .replace("  PENDULUM_MAINTAINERS: alice#77,bob#88", "  PENDULUM_MAINTAINERS: dave#55")
    .replace(/^env:\n/m, "env:\n  PENDULUM_EFFORT: high\n  # Local mode runs the short set.\n  # (two lines of note)\n  PENDULUM_LOCAL_VALIDATION: 'pnpm check, parallel: pnpm test' # quoted\n  # setup alone first\n");
  const r = render({}, { text: edited });
  assert.equal(r.after.env.PENDULUM_SANDBOX_VCPUS, "4");
  assert.equal(r.after.env.PENDULUM_EFFORT, "high");
  assert.equal(r.after.env.PENDULUM_MAINTAINERS, "dave#55");
  assert.equal(r.after.env.PENDULUM_LOCAL_VALIDATION, "pnpm check, parallel: pnpm test");
  assert.ok(r.after.ids.includes(55));
  assert.deepEqual(r.after.env, workflowSettings(edited).env);
  // Each hand-written comment stays directly above its key, the extra key's own line (quoting, trailing note) as written.
  assert.match(r.text, /\n  # Local mode runs the short set\.\n  # \(two lines of note\)\n  PENDULUM_LOCAL_VALIDATION: 'pnpm check, parallel: pnpm test' # quoted\n/);
  assert.match(r.text, /\n  # setup alone first\n  PENDULUM_HARNESS: /);
  // And stay put, once, on the next re-render.
  assert.equal(render({}, { text: r.text }).text, r.text);
});

test("a validation with parallel: marks is quoted once and stays the same value across re-renders", () => {
  const validation = "parallel: npm test, npm run lint";
  for (const extra of [{}, { sandbox: "vercel" }]) {
    const first = render({ ...CUSTOM, ...extra, validation });
    assert.equal(first.after.env.PENDULUM_VALIDATION, validation);
    const second = render({}, { text: first.text });
    const third = render({}, { text: second.text });
    assert.equal(second.after.env.PENDULUM_VALIDATION, validation);
    assert.equal(third.text, first.text);
  }
});

test("--maintainers replaces or clears the file's PENDULUM_MAINTAINERS, and the gate and the env agree", () => {
  const first = render({ ...CUSTOM, sandbox: "vercel", maintainers: "dave#55" }, { notify: "kirk#1" });
  assert.equal(first.after.env.PENDULUM_MAINTAINERS, "dave#55");
  const r = render({ maintainers: "bob#66" }, { text: first.text });
  assert.equal(r.after.env.PENDULUM_MAINTAINERS, "bob#66");
  assert.deepEqual(r.after.ids, [1, 66]);
  assert.match(r.report.find((l) => l.startsWith("changed ")), /PENDULUM_MAINTAINERS "dave#55" -> "bob#66" \(--maintainers\)/);
  assert.ok(!r.report.find((l) => l.startsWith("kept ")).includes("PENDULUM_MAINTAINERS"));
  const cleared = render({ maintainers: "" }, { text: first.text });
  assert.equal(cleared.after.env.PENDULUM_MAINTAINERS, undefined);
  assert.deepEqual(cleared.after.ids, [1]);
  assert.ok(cleared.report.includes("dropped PENDULUM_MAINTAINERS (--maintainers)"));
  // A file without the line gets it from the flag, so the runtime trusts whom the gate lets through.
  const none = render({ maintainers: "erin#9" }, { text: first.text.replace("  PENDULUM_MAINTAINERS: dave#55\n", "") });
  assert.equal(none.after.env.PENDULUM_MAINTAINERS, "erin#9");
  assert.match(none.report.find((l) => l.startsWith("changed ")), /PENDULUM_MAINTAINERS \(none\) -> "erin#9" \(--maintainers\)/);
});

test("a new --harness drops the file's efforts with its models; the same harness keeps them", () => {
  const text = render(CUSTOM).text.replace(/^env:\n/m, "env:\n  PENDULUM_EFFORT: xhigh\n  PENDULUM_REVIEWER_EFFORT: high\n");
  const moved = render({ harness: "claude" }, { text });
  assert.equal(moved.after.env.PENDULUM_EFFORT, undefined);
  assert.equal(moved.after.env.PENDULUM_REVIEWER_EFFORT, undefined);
  assert.ok(moved.report.some((l) => l.startsWith("dropped PENDULUM_EFFORT (--harness") && l.includes("PENDULUM_REVIEWER_EFFORT (--harness")));
  assert.match(moved.report.find((l) => l.startsWith("changed ")), /PENDULUM_MODEL "gpt-6.1-sol" -> "claude-opus-5-5" \(--harness/);
  // An --effort given with the move is written.
  assert.equal(render({ harness: "claude", effort: "low" }, { text }).after.env.PENDULUM_EFFORT, "low");
  const same = render({ harness: "codex" }, { text });
  assert.equal(same.after.env.PENDULUM_EFFORT, "xhigh");
  assert.equal(same.after.env.PENDULUM_REVIEWER_EFFORT, "high");
});

test("a custom Action pin is kept; an older Pendulum release moves to the newest; a newer one stays", () => {
  const base = render(CUSTOM).text;
  for (const [pin, want] of [
    ["clockgrove/pendulum@main", "clockgrove/pendulum@main"],
    ["me/fork@v1", "me/fork@v1"],
    ["clockgrove/pendulum@v0.7.99", `clockgrove/pendulum@${LATEST}`],
    ["clockgrove/pendulum@v0.8.0", "clockgrove/pendulum@v0.8.0"],
    // A floating pin of an older line moves; one on the newest line already tracks it.
    ["clockgrove/pendulum@v0.6", `clockgrove/pendulum@${LATEST}`],
    ["clockgrove/pendulum@v0.7", "clockgrove/pendulum@v0.7"],
    ["clockgrove/pendulum@v0", "clockgrove/pendulum@v0"],
  ])
    assert.equal(render({}, { text: base.replaceAll(`clockgrove/pendulum@${LATEST}`, pin) }).after.action, want, pin);
  assert.equal(render({ version: "v0.7.120" }, { text: base }).after.action, "clockgrove/pendulum@v0.7.120");
});

test("a credential or setup-only flag never lands in the workflow env; the file's own line stays", () => {
  const first = render({ ...CUSTOM });
  const edited = first.text.replace(/^env:\n/m, "env:\n  PENDULUM_APP_ID: ${{ secrets.PENDULUM_APP_ID }}\n  PENDULUM_APP_PRIVATE_KEY: ${{ secrets.PENDULUM_APP_PRIVATE_KEY }}\n");
  const r = render({ app_id: "123456", app_private_key: "-----BEGIN KEY-----x", repo: "o/n" }, { text: edited });
  assert.equal(r.after.env.PENDULUM_APP_ID, "${{ secrets.PENDULUM_APP_ID }}");
  assert.equal(r.after.env.PENDULUM_APP_PRIVATE_KEY, "${{ secrets.PENDULUM_APP_PRIVATE_KEY }}");
  assert.doesNotMatch(r.text, /123456|BEGIN KEY/);
});

test("setup's protection step: no merge queue on a user's repository, and a ruleset without one where GitHub refuses the rule", async () => {
  const { applyProtection, noQueueReason } = await import("../scripts/setup.mjs");
  assert.equal(noQueueReason({ owner: { type: "User" } }), "GitHub offers no merge queue on a repository a user owns");
  assert.equal(noQueueReason({ owner: { type: "Organization" } }), null);
  const realFetch = globalThis.fetch;
  const saved = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = "https://github.test";
  const run = async (ownerType, refuseQueue, queue = true, { priv = false, existing = null } = {}) => {
    const sent = [];
    globalThis.fetch = async (url, init = {}) => {
      const u = new URL(url);
      const method = init.method || "GET";
      const body = init.body ? JSON.parse(init.body) : undefined;
      const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
      if (method === "GET" && u.pathname === "/repos/o/r") return json({ default_branch: "main", private: priv, owner: { type: ownerType } });
      if (method === "GET" && u.pathname === "/repos/o/r/rulesets") return json(existing ? [{ id: 7, name: "pendulum" }] : []);
      if (method === "GET" && u.pathname === "/repos/o/r/rulesets/7") return json({ id: 7, rules: existing.map((type) => ({ type })) });
      if ((method === "POST" && u.pathname === "/repos/o/r/rulesets") || (method === "PUT" && u.pathname === "/repos/o/r/rulesets/7")) {
        const types = body.rules.map((x) => x.type);
        sent.push(`${method} ${types.includes("merge_queue") ? "queue" : "no-queue"}`);
        if (refuseQueue && types.includes("merge_queue")) return json({ message: "Validation Failed", errors: ["merge_queue is not available"] }, 422);
        return json({ id: 7 });
      }
      if (method === "PATCH" && u.pathname === "/repos/o/r") return json({});
      return json({ message: `unexpected ${method} ${u.pathname}` }, 500);
    };
    const note = await applyProtection({ owner: "o", name: "r", full: "o/r" }, { ciChecks: ["quality"], queue }, { token: "t" });
    return { sent, note };
  };
  try {
    const user = await run("User", false);
    assert.deepEqual(user.sent, ["POST no-queue"], "a user's repository: one ruleset, no queue rule");
    assert.match(user.note, /no merge queue \(GitHub offers no merge queue on a repository a user owns; Pendulum runs on strict required checks\)/);
    const org = await run("Organization", false);
    assert.deepEqual(org.sent, ["POST queue"]);
    assert.match(org.note, /: merge queue, required checks quality/);
    const refused = await run("Organization", true, true, { priv: true });
    assert.deepEqual(refused.sent, ["POST queue", "POST no-queue"], "a private organization repository refused: tried with the queue, then made without it");
    assert.match(refused.note, /no merge queue \(GitHub refused a merge queue on this private repository: .*Validation Failed/);
    // GitHub offers a queue on every public organization repository: a 422 there is a real error, never a quiet fallback.
    await assert.rejects(run("Organization", true, true, { priv: false }), /422|Validation Failed/);
    // A queue stood before: a refusal now surfaces, and the working queue is not removed.
    const before = run("Organization", true, true, { priv: true, existing: ["merge_queue", "required_status_checks"] });
    await assert.rejects(before, /422|Validation Failed/);
    const kept = await run("Organization", false, true, { existing: ["merge_queue"] });
    assert.deepEqual(kept.sent, ["PUT queue"], "an existing ruleset is updated in place, queue kept");
    const off = await run("Organization", false, false);
    assert.deepEqual(off.sent, ["POST no-queue"]);
    assert.match(off.note, /no merge queue \(--merge-queue false/);
  } finally {
    globalThis.fetch = realFetch;
    if (saved === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = saved;
  }
});

test("the board's node id setup records is written as PENDULUM_PROJECT and kept by a re-render; none is written before one is recorded", () => {
  const first = render({ project: "PVT_board1" }, { notify: "kirk#318831919" });
  assert.equal(first.after.env.PENDULUM_PROJECT, "PVT_board1");
  assert.equal((first.text.match(/PENDULUM_PROJECT:/g) || []).length, 1);
  const again = render({}, { text: first.text });
  assert.equal(again.text, first.text, "kept, once");
  assert.ok(!("PENDULUM_PROJECT" in render({}, { notify: "kirk#318831919" }).after.env), "no empty line before a board is made");
});

test("findProject finds the board by the node id the settings record, never by a title or a column; without one, by its exact title only", async () => {
  const { findProject } = await import("../scripts/lib/github.mjs");
  const realFetch = globalThis.fetch;
  const saved = { url: process.env.GITHUB_GRAPHQL_URL, project: process.env.PENDULUM_PROJECT };
  process.env.GITHUB_GRAPHQL_URL = "https://github.test/graphql";
  delete process.env.PENDULUM_PROJECT;
  const board = (id, title, options = ["Queued", "Running", "In review", "Blocked", "Done"]) => ({ id, title, number: 1, field: { id: `F_${id}`, options: options.map((name) => ({ id: name, name })) } });
  // The repository links three boards: another team's titled "Pendulum", one with a Queued column, and Pendulum's own,
  // renamed by a person. GitHub answers a node by its id, with the repositories it is linked to; `elsewhere` is another
  // repository's board in the same organization (a workflow copied from there names it).
  const linked = [board("PVT_other", "Pendulum"), board("PVT_kanban", "Team kanban"), board("PVT_ours", "Our pipeline")];
  const elsewhere = { ...board("PVT_theirs", "Pendulum: api"), repositories: { nodes: [{ id: "R_2" }] } };
  const queries = [];
  globalThis.fetch = async (url, init = {}) => {
    const { query, variables } = JSON.parse(init.body);
    queries.push(query.includes("node(id:") ? "node" : "linked");
    // `PVT_big` and `PVT_wide` are linked to 150 repositories each, two pages: this one on the second page of `PVT_big`, on neither of `PVT_wide`'s.
    const many = { PVT_big: "R_1", PVT_wide: "R_3" };
    if (many[variables.id]) {
      const page = variables.after === "c1" ? { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [...Array.from({ length: 49 }, (_, i) => ({ id: `R_x${100 + i}` })), { id: many[variables.id] }] } : { pageInfo: { hasNextPage: true, endCursor: "c1" }, nodes: Array.from({ length: 100 }, (_, i) => ({ id: `R_x${i}` })) };
      return new Response(JSON.stringify({ data: { node: { ...board(variables.id, "Board"), repositories: page }, repository: { id: "R_1" } } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const node = variables.id === elsewhere.id ? elsewhere : linked.find((b) => b.id === variables.id);
    const data = query.includes("node(id:") ? { node: node ? { repositories: { nodes: [{ id: "R_1" }] }, ...node } : null, repository: { id: "R_1" } } : { repository: { id: "R_1", projectsV2: { nodes: linked } } };
    return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const repo = { owner: "o", name: "app", full: "o/app" };
  try {
    assert.equal((await findProject(repo, { token: "t", project: "PVT_ours" })).id, "PVT_ours", "by identity, whatever its title");
    assert.deepEqual(queries, ["node"]);
    process.env.PENDULUM_PROJECT = "PVT_ours";
    assert.equal((await findProject(repo, { token: "t" })).repositoryId, "R_1", "on Actions, from the workflow's env block");
    assert.equal(await findProject(repo, { token: "t", project: "PVT_gone" }), null, "a recorded id that names no board is no board");
    assert.equal(await findProject(repo, { token: "t", project: "PVT_theirs" }), null, "nor one naming another repository's board");
    assert.ok(!("repositories" in (await findProject(repo, { token: "t", project: "PVT_ours" }))));
    // A board linked to many repositories: every page is read until this one shows, and none past the last.
    queries.length = 0;
    const big = await findProject(repo, { token: "t", project: "PVT_big" });
    assert.deepEqual([big?.id, big?.repositoryId, "repositories" in (big || {})], ["PVT_big", "R_1", false], "linked on its second page");
    assert.deepEqual(queries, ["node", "node"]);
    assert.equal(await findProject(repo, { token: "t", project: "PVT_wide" }), null, "not linked on any page");
    delete process.env.PENDULUM_PROJECT;
    // No id recorded: only the exact title setup gives a board; a board titled "Pendulum" or one with a Queued column is not it.
    queries.length = 0;
    const none = await findProject(repo, { token: "t" }).catch(() => null);
    assert.equal(none?.id ?? null, null);
    linked.push(board("PVT_titled", "Pendulum: app"));
    assert.equal((await findProject(repo, { token: "t" })).id, "PVT_titled");
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of [["GITHUB_GRAPHQL_URL", saved.url], ["PENDULUM_PROJECT", saved.project]]) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test("setup's project step takes the board the workflow records only when it is this repository's, and names an id the workflow does not record yet", async () => {
  const { projectStep } = await import("../scripts/setup.mjs");
  const realFetch = globalThis.fetch;
  const saved = { api: process.env.GITHUB_API_URL, gql: process.env.GITHUB_GRAPHQL_URL, project: process.env.PENDULUM_PROJECT };
  process.env.GITHUB_API_URL = "https://github.test";
  process.env.GITHUB_GRAPHQL_URL = "https://github.test/graphql";
  delete process.env.PENDULUM_PROJECT;
  const cols = { id: "F", options: ["Queued", "Running", "In review", "Blocked", "Done"].map((name) => ({ id: name, name })) };
  // This repository (R_1) has its own board, titled by setup; the workflow was copied from another repository and names
  // that one's board (linked to R_2), then a re-render keeps it.
  const boards = { PVT_theirs: { id: "PVT_theirs", title: "Pendulum: api", number: 1, field: cols, repositories: { nodes: [{ id: "R_2" }] } }, PVT_ours: { id: "PVT_ours", title: "Pendulum: app", number: 2, field: cols, repositories: { nodes: [{ id: "R_1" }] } } };
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
    if (u.pathname === "/repos/o/app") return json({ default_branch: "main", owner: { type: "Organization" } });
    const { query, variables } = JSON.parse(init.body);
    if (query.includes("node(id:")) return json({ data: { node: boards[variables.id] ?? null, repository: { id: "R_1" } } });
    if (query.includes("projectsV2(first: 20) {")) return json({ data: { repository: { id: "R_1", projectsV2: { nodes: [boards.PVT_ours] } } } });
    return json({ data: {} });
  };
  const dir = mkdtempSync(join(tmpdir(), "proj-"));
  const outPath = join(dir, ".github", "workflows", "pendulum.yml");
  mkdirSync(dirname(outPath), { recursive: true });
  const repo = { owner: "o", name: "app", full: "o/app" };
  try {
    writeFileSync(outPath, "name: Pendulum\non: {}\nenv:\n  PENDULUM_PROJECT: PVT_theirs\njobs: {}\n");
    // With the workflow step: the id goes to the workflow through args, this repository's board, not the copied one.
    const args = { project: "PVT_theirs" };
    assert.match(await projectStep({ repo, opts: { token: "t" }, args, explicit: {}, steps: ["project", "workflow"], outPath, checkout: dir }), /project "Pendulum: app" already has/);
    assert.equal(args.project, "PVT_ours");
    // Without it: the note says the workflow does not record the id yet, and how to record it.
    const alone = await projectStep({ repo, opts: { token: "t" }, args: {}, explicit: {}, steps: ["project"], outPath, checkout: dir });
    assert.match(alone, /the workflow does not record its id yet: run setup with --apply project,workflow, or set PENDULUM_PROJECT: PVT_ours in the env block of \.github\/workflows\/pendulum\.yml/);
    // Once recorded, nothing more to say.
    writeFileSync(outPath, "name: Pendulum\non: {}\nenv:\n  PENDULUM_PROJECT: PVT_ours\njobs: {}\n");
    assert.doesNotMatch(await projectStep({ repo, opts: { token: "t" }, args: {}, explicit: {}, steps: ["project"], outPath, checkout: dir }), /does not record/);
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of [["GITHUB_API_URL", saved.api], ["GITHUB_GRAPHQL_URL", saved.gql], ["PENDULUM_PROJECT", saved.project]]) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test("setup's project step skips the board on a repository a user owns: no GitHub App can move its cards (#199)", async () => {
  const { applyProjectStep } = await import("../scripts/setup.mjs");
  const realFetch = globalThis.fetch;
  const saved = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = "https://github.test";
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    calls.push(`${init.method || "GET"} ${u.pathname}`);
    if (u.pathname === "/repos/me/app") return new Response(JSON.stringify({ default_branch: "main", owner: { type: "User" } }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ message: "unexpected" }), { status: 500, headers: { "content-type": "application/json" } });
  };
  try {
    const { note, id } = await applyProjectStep({ owner: "me", name: "app", full: "me/app" }, { token: "t" });
    assert.equal(id, null);
    assert.match(note, /^skipped: a repository a user owns gets no board/);
    assert.deepEqual(calls, ["GET /repos/me/app"], "no project query or mutation");
  } finally {
    globalThis.fetch = realFetch;
    if (saved === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = saved;
  }
});
