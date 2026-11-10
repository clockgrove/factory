import "./temp.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
    assert.equal(first.after.env.FACTORY_MAX_USD, "20");
    // The launch gate (sandbox route) holds the maintainer ids; the runner route has none.
    assert.deepEqual(first.after.ids, extra.sandbox ? [318831919, 77, 88] : []);
    const again = render({}, { text: first.text });
    assert.deepEqual(again.after, first.after, `route ${extra.sandbox || "runner"}`);
    assert.equal(again.text, first.text);
    assert.deepEqual(again.report.filter((l) => !l.startsWith("kept ")), []);
  }
});

test("the real case: factory-scratch's factory.yml at 96ce800 keeps its validation, setup, checks, notify, plan credential, caps and timeout", () => {
  const text = readFileSync(join(PLUGIN, "test/fixtures/factory-scratch-96ce800.yml"), "utf8");
  const r = render({}, { text });
  assert.deepEqual(r.after.env, r.before.env);
  for (const [k, v] of Object.entries({
    FACTORY_VALIDATION: "npm run check, npm test, npm run test:db",
    FACTORY_SETUP: "scripts/ci/setup.sh",
    FACTORY_CI_CHECKS: "quality",
    FACTORY_PROTECTED_PATHS: "scripts/ci/setup.sh",
    FACTORY_NOTIFY: "kirkmarple-clockgrove#318831919",
    FACTORY_CREDENTIAL: "plan",
    FACTORY_MAX_CONCURRENT: "2",
    FACTORY_DAILY_USD: "50",
    FACTORY_MAX_USD: "20",
    FACTORY_TIMEOUT_MINUTES: "90",
    FACTORY_SANDBOX: "vercel",
  }))
    assert.equal(r.after.env[k], v, k);
  assert.deepEqual(r.after.ids, [318831919]);
  assert.equal(r.after.ciWorkflow, "Quality");
  // The new template's jobs (the launch gate's tick output, the dequeued trigger) need this release's Action.
  assert.equal(r.after.action, `clockgrove/factory@${LATEST}`);
  assert.match(r.text, /types: \[labeled, ready_for_review, closed, dequeued\]/);
  assert.deepEqual(r.report, [
    `kept ${Object.keys(r.before.env).join(", ")}, launch gate maintainer ids, CI workflow`,
    `changed action "clockgrove/factory@v0.7.106" -> "clockgrove/factory@${LATEST}" (the newest release: the template is that release's)`,
  ]);
});

test("an option on the command line wins over the existing file, and the report names it", () => {
  const first = render({ ...CUSTOM, sandbox: "vercel" }, { notify: "kirk#318831919" });
  const r = render({ max_usd: "10", setup: "", notify: "carol" }, { text: first.text, notify: "carol#99" });
  assert.equal(r.after.env.FACTORY_MAX_USD, "10");
  assert.equal(r.after.env.FACTORY_SETUP, "");
  assert.equal(r.after.env.FACTORY_NOTIFY, "carol#99");
  assert.equal(r.after.env.FACTORY_DAILY_USD, "50");
  // The old notify id goes with the old notify; the other maintainers stay.
  assert.deepEqual(r.after.ids, [99, 77, 88]);
  const changed = r.report.find((l) => l.startsWith("changed "));
  assert.match(changed, /FACTORY_MAX_USD "20" -> "10" \(--max-usd\)/);
  assert.match(changed, /FACTORY_SETUP "scripts\/ci\/setup.sh" -> "" \(--setup\)/);
  assert.match(changed, /launch gate maintainer ids "318831919,77,88" -> "99,77,88" \(--notify\)/);
  // A new harness takes its own models, not the file's.
  const moved = render({ harness: "claude" }, { text: first.text });
  assert.equal(moved.after.env.FACTORY_MODEL, "claude-opus-5-5");
  assert.equal(moved.after.env.FACTORY_MAX_USD, "20");
  // --sandbox= leaves the sandbox route: its keys are reported as dropped, the runner kept from no file.
  const off = render({ sandbox: "" }, { text: render({ ...CUSTOM, sandbox: "vercel" }).text });
  assert.equal(off.after.env.FACTORY_SANDBOX, undefined);
  assert.ok(off.report.includes("dropped FACTORY_SANDBOX (--sandbox)"));
  assert.ok(off.report.some((l) => l.startsWith("dropped (not on this route) FACTORY_SANDBOX_VCPUS,")));
});

test("env keys the template does not write, their comment lines, and hand-set values of fixed ones, survive a re-render", () => {
  const first = render({ ...CUSTOM, sandbox: "vercel" });
  const edited = first.text
    .replace("  FACTORY_SANDBOX_VCPUS: 2 #", "  FACTORY_SANDBOX_VCPUS: 4 #")
    .replace("  FACTORY_MAINTAINERS: alice#77,bob#88", "  FACTORY_MAINTAINERS: dave#55")
    .replace(/^env:\n/m, "env:\n  FACTORY_EFFORT: high\n  # Local mode runs the short set.\n  # (two lines of note)\n  FACTORY_LOCAL_VALIDATION: 'pnpm check, parallel: pnpm test' # quoted\n  # setup alone first\n");
  const r = render({}, { text: edited });
  assert.equal(r.after.env.FACTORY_SANDBOX_VCPUS, "4");
  assert.equal(r.after.env.FACTORY_EFFORT, "high");
  assert.equal(r.after.env.FACTORY_MAINTAINERS, "dave#55");
  assert.equal(r.after.env.FACTORY_LOCAL_VALIDATION, "pnpm check, parallel: pnpm test");
  assert.ok(r.after.ids.includes(55));
  assert.deepEqual(r.after.env, workflowSettings(edited).env);
  // Each hand-written comment stays directly above its key, the extra key's own line (quoting, trailing note) as written.
  assert.match(r.text, /\n  # Local mode runs the short set\.\n  # \(two lines of note\)\n  FACTORY_LOCAL_VALIDATION: 'pnpm check, parallel: pnpm test' # quoted\n/);
  assert.match(r.text, /\n  # setup alone first\n  FACTORY_HARNESS: /);
  // And stay put, once, on the next re-render.
  assert.equal(render({}, { text: r.text }).text, r.text);
});

test("a validation with parallel: marks is quoted once and stays the same value across re-renders", () => {
  const validation = "parallel: npm test, npm run lint";
  for (const extra of [{}, { sandbox: "vercel" }]) {
    const first = render({ ...CUSTOM, ...extra, validation });
    assert.equal(first.after.env.FACTORY_VALIDATION, validation);
    const second = render({}, { text: first.text });
    const third = render({}, { text: second.text });
    assert.equal(second.after.env.FACTORY_VALIDATION, validation);
    assert.equal(third.text, first.text);
  }
});

test("--maintainers replaces or clears the file's FACTORY_MAINTAINERS, and the gate and the env agree", () => {
  const first = render({ ...CUSTOM, sandbox: "vercel", maintainers: "dave#55" }, { notify: "kirk#1" });
  assert.equal(first.after.env.FACTORY_MAINTAINERS, "dave#55");
  const r = render({ maintainers: "bob#66" }, { text: first.text });
  assert.equal(r.after.env.FACTORY_MAINTAINERS, "bob#66");
  assert.deepEqual(r.after.ids, [1, 66]);
  assert.match(r.report.find((l) => l.startsWith("changed ")), /FACTORY_MAINTAINERS "dave#55" -> "bob#66" \(--maintainers\)/);
  assert.ok(!r.report.find((l) => l.startsWith("kept ")).includes("FACTORY_MAINTAINERS"));
  const cleared = render({ maintainers: "" }, { text: first.text });
  assert.equal(cleared.after.env.FACTORY_MAINTAINERS, undefined);
  assert.deepEqual(cleared.after.ids, [1]);
  assert.ok(cleared.report.includes("dropped FACTORY_MAINTAINERS (--maintainers)"));
  // A file without the line gets it from the flag, so the runtime trusts whom the gate lets through.
  const none = render({ maintainers: "erin#9" }, { text: first.text.replace("  FACTORY_MAINTAINERS: dave#55\n", "") });
  assert.equal(none.after.env.FACTORY_MAINTAINERS, "erin#9");
  assert.match(none.report.find((l) => l.startsWith("changed ")), /FACTORY_MAINTAINERS \(none\) -> "erin#9" \(--maintainers\)/);
});

test("a new --harness drops the file's efforts with its models; the same harness keeps them", () => {
  const text = render(CUSTOM).text.replace(/^env:\n/m, "env:\n  FACTORY_EFFORT: xhigh\n  FACTORY_REVIEWER_EFFORT: high\n");
  const moved = render({ harness: "claude" }, { text });
  assert.equal(moved.after.env.FACTORY_EFFORT, undefined);
  assert.equal(moved.after.env.FACTORY_REVIEWER_EFFORT, undefined);
  assert.ok(moved.report.some((l) => l.startsWith("dropped FACTORY_EFFORT (--harness") && l.includes("FACTORY_REVIEWER_EFFORT (--harness")));
  assert.match(moved.report.find((l) => l.startsWith("changed ")), /FACTORY_MODEL "gpt-6.1-sol" -> "claude-opus-5-5" \(--harness/);
  // An --effort given with the move is written.
  assert.equal(render({ harness: "claude", effort: "low" }, { text }).after.env.FACTORY_EFFORT, "low");
  const same = render({ harness: "codex" }, { text });
  assert.equal(same.after.env.FACTORY_EFFORT, "xhigh");
  assert.equal(same.after.env.FACTORY_REVIEWER_EFFORT, "high");
});

test("a custom Action pin is kept; an older Factory release moves to the newest; a newer one stays", () => {
  const base = render(CUSTOM).text;
  for (const [pin, want] of [
    ["clockgrove/factory@main", "clockgrove/factory@main"],
    ["me/fork@v1", "me/fork@v1"],
    ["clockgrove/factory@v0.7.99", `clockgrove/factory@${LATEST}`],
    ["clockgrove/factory@v0.8.0", "clockgrove/factory@v0.8.0"],
    // A floating pin of an older line moves; one on the newest line already tracks it.
    ["clockgrove/factory@v0.6", `clockgrove/factory@${LATEST}`],
    ["clockgrove/factory@v0.7", "clockgrove/factory@v0.7"],
    ["clockgrove/factory@v0", "clockgrove/factory@v0"],
  ])
    assert.equal(render({}, { text: base.replaceAll(`clockgrove/factory@${LATEST}`, pin) }).after.action, want, pin);
  assert.equal(render({ version: "v0.7.120" }, { text: base }).after.action, "clockgrove/factory@v0.7.120");
});

test("a credential or setup-only flag never lands in the workflow env; the file's own line stays", () => {
  const first = render({ ...CUSTOM });
  const edited = first.text.replace(/^env:\n/m, "env:\n  FACTORY_APP_ID: ${{ secrets.FACTORY_APP_ID }}\n  FACTORY_APP_PRIVATE_KEY: ${{ secrets.FACTORY_APP_PRIVATE_KEY }}\n");
  const r = render({ app_id: "123456", app_private_key: "-----BEGIN KEY-----x", repo: "o/n" }, { text: edited });
  assert.equal(r.after.env.FACTORY_APP_ID, "${{ secrets.FACTORY_APP_ID }}");
  assert.equal(r.after.env.FACTORY_APP_PRIVATE_KEY, "${{ secrets.FACTORY_APP_PRIVATE_KEY }}");
  assert.doesNotMatch(r.text, /123456|BEGIN KEY/);
});
