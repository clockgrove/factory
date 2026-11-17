import "./temp.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveInputs } from "../scripts/lib/inputs.mjs";
import { routeAccounts } from "../scripts/lib/accounts.mjs";
import { secretReferences, workflowSecretChecks } from "../scripts/doctor.mjs";
import { keptArgs, pickRunner, settingsReport, workflowSettings, workflowText } from "../scripts/setup.mjs";

// Setup adds and removes the accounts of GitHub Actions and the cloud sandbox (#551): its options set PENDULUM_ACCOUNTS
// and PENDULUM_AUTO_ACCOUNT in the rendered workflow, checked as the jobs read them, and the jobs name each account's
// secrets; with no option a re-render keeps the file's lines.

const PLUGIN = join(import.meta.dirname, "..");
const template = readFileSync(join(PLUGIN, "workflow-template.yml"), "utf8");

/** setup --apply workflow's render with the network answers given: `explicit` the command line, `text` the existing file. */
function render(explicit, text = null) {
  const before = text ? workflowSettings(text) : null;
  const args = { ...keptArgs(before, explicit, template), ...explicit };
  const out = workflowText({ template, inputs: resolveInputs({ args, env: {} }), args, explicit, before, latest: "v0.10.1", notify: "", runsOn: pickRunner(args.runs_on, {}, {}).runsOn, ciWorkflow: "CI", defaultBranch: "main" });
  return { text: out, after: workflowSettings(out), report: settingsReport(before, workflowSettings(out), explicit) };
}

/** The account secrets (any name with an account suffix, or a harness credential's usual name) the rendered jobs name. */
const accountSecrets = (text) => [...secretReferences(text).names].filter((n) => /^(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|CODEX_API_KEY|PENDULUM_CODEX_GATEWAY_KEY|COPILOT_GITHUB_TOKEN)/.test(n)).sort();
const USUAL = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CODEX_API_KEY", "COPILOT_GITHUB_TOKEN", "PENDULUM_CODEX_GATEWAY_KEY"];
const rowOf = (text, name) => workflowSecretChecks(text).find((c) => c.name === name);

test("setup's account options render the accounts and name each account's secrets; an account named after its harness keeps the usual ones", () => {
  for (const sandbox of [{}, { sandbox: "vercel" }]) {
    const first = render({ ...sandbox });
    // A second Claude account: the usual one stays first, the default, on the usual secrets.
    const two = render({ add_account: "claude-2", auto_account: "on" }, first.text);
    assert.equal(two.after.env.PENDULUM_ACCOUNTS, JSON.stringify({ claude: ["claude", "claude-2"] }));
    assert.equal(two.after.env.PENDULUM_AUTO_ACCOUNT, "1");
    assert.deepEqual(accountSecrets(two.text), [...USUAL, "ANTHROPIC_API_KEY_CLAUDE_2", "CLAUDE_CODE_OAUTH_TOKEN_CLAUDE_2"].sort(), sandbox.sandbox || "runner");
    assert.equal(rowOf(two.text, "workflow accounts").status, "PASS", "doctor: the jobs were rendered for the declared accounts");
    assert.ok(two.report.some((l) => l.includes("PENDULUM_ACCOUNTS (none) ->") && l.includes("(--add-account)")), two.report.join("\n"));
    // The whole declaration, every harness, on a first render.
    const all = render({ ...sandbox, accounts: '{"claude": ["claude-b"], "codex": ["codex", "codex-2"], "copilot": ["copilot-x"]}' });
    assert.equal(all.after.env.PENDULUM_ACCOUNTS, JSON.stringify({ claude: ["claude-b"], codex: ["codex", "codex-2"], copilot: ["copilot-x"] }));
    assert.deepEqual(accountSecrets(all.text), ["ANTHROPIC_API_KEY_CLAUDE_B", "CLAUDE_CODE_OAUTH_TOKEN_CLAUDE_B", "CODEX_API_KEY", "CODEX_API_KEY_CODEX_2", "COPILOT_GITHUB_TOKEN_COPILOT_X", "PENDULUM_CODEX_GATEWAY_KEY", "PENDULUM_CODEX_GATEWAY_KEY_CODEX_2"]);
    assert.equal(rowOf(all.text, "workflow accounts").status, "PASS");
    // The workflow's harness takes a bare name; another harness's account names it.
    const codex = render({ harness: "codex", add_account: ["codex-2", "copilot:copilot-2"] });
    assert.equal(codex.after.env.PENDULUM_ACCOUNTS, JSON.stringify({ codex: ["codex", "codex-2"], copilot: ["copilot", "copilot-2"] }));
  }
});

test("setup refuses an account set the jobs would refuse, with routeAccounts's own line", () => {
  for (const bad of ["{not json", '["claude"]', '{"gemini": ["g"]}', '{"claude": "claude-2"}', '{"claude": ["Claude_2"]}', '{"claude": ["c"], "codex": ["c"]}', '{"claude": ["codex"]}']) {
    const { problem } = routeAccounts(bad);
    assert.ok(problem, bad);
    assert.throws(() => render({ accounts: bad }), (e) => e.message === `--accounts: ${problem}`, bad);
  }
  const first = render({}).text;
  assert.throws(() => render({ add_account: "codex" }, first), (e) => e.message.includes(routeAccounts('{"claude": ["claude", "codex"]}').problem));
  assert.throws(() => render({ add_account: "claude" }, first), (e) => e.message.includes(routeAccounts('{"claude": ["claude", "claude"]}').problem));
  assert.throws(() => render({ add_account: "gemini:g-2" }, first), /--add-account: an entry names a harness Pendulum does not run/);
  assert.throws(() => render({ remove_account: "claude-2" }, first), /--remove-account: PENDULUM_ACCOUNTS declares no account `claude-2`/);
  assert.throws(() => render({ auto_account: "1" }, first), /--auto-account: on or off/);
});

test("with no accounts option a re-render keeps the file's accounts lines and their comments; --auto-account alone changes only its own", () => {
  const first = render({}).text;
  const hand = first.replace(/^env:\n/m, "env:\n  # the team's second subscription\n  PENDULUM_ACCOUNTS: '{\"claude\": [\"claude\", \"claude-2\"]}'\n  PENDULUM_AUTO_ACCOUNT: \"1\"\n");
  const declared = render({}, hand);
  const again = render({}, declared.text);
  assert.equal(again.text, declared.text, "a re-render with no option changes nothing");
  assert.match(declared.text, /^ {2}# the team's second subscription\n {2}PENDULUM_ACCOUNTS: '\{"claude": \["claude", "claude-2"\]\}'$/m);
  assert.match(declared.text, /^ {2}PENDULUM_AUTO_ACCOUNT: "1"$/m);
  assert.ok(accountSecrets(declared.text).includes("ANTHROPIC_API_KEY_CLAUDE_2"));
  const off = render({ auto_account: "off" }, declared.text);
  assert.equal(off.after.env.PENDULUM_AUTO_ACCOUNT, undefined, "off: the line goes (unset is off)");
  assert.match(off.text, /^ {2}PENDULUM_ACCOUNTS: '\{"claude": \["claude", "claude-2"\]\}'$/m, "the accounts line is the file's own");
  assert.ok(off.report.some((l) => l === "dropped PENDULUM_AUTO_ACCOUNT (--auto-account)"), off.report.join("\n"));
  // An option over a file's line keeps the comments above it.
  const three = render({ add_account: "claude-3" }, declared.text);
  assert.match(three.text, /^ {2}# the team's second subscription\n {2}PENDULUM_ACCOUNTS: '\{"claude":\["claude","claude-2","claude-3"\]\}'$/m);
});

test("removing an account drops its secret names from every job; removing the last added one gives back the workflow with none declared", () => {
  const none = render({}).text;
  const three = render({ add_account: "claude-2,claude-3" }, none);
  assert.ok(accountSecrets(three.text).includes("ANTHROPIC_API_KEY_CLAUDE_2"));
  const two = render({ remove_account: "claude-2" }, three.text);
  assert.equal(two.after.env.PENDULUM_ACCOUNTS, JSON.stringify({ claude: ["claude", "claude-3"] }));
  assert.deepEqual(accountSecrets(two.text), [...USUAL, "ANTHROPIC_API_KEY_CLAUDE_3", "CLAUDE_CODE_OAUTH_TOKEN_CLAUDE_3"].sort());
  assert.ok(two.report.some((l) => l.includes("(--remove-account)")), two.report.join("\n"));
  const back = render({ remove_account: ["claude-3"] }, two.text);
  assert.equal(back.after.env.PENDULUM_ACCOUNTS, undefined);
  assert.deepEqual(accountSecrets(back.text), USUAL);
  assert.equal(back.text, none);
  // `--accounts=` clears a declaration whole.
  assert.equal(render({ accounts: "" }, three.text).text, none);
});

test("setup's command line: repeated --add-account flags all count, the dry run names the new secrets to save at the prompt, and a refused set exits 1 with its line", () => {
  const dir = mkdtempSync(join(tmpdir(), "acct-"));
  const out = join(dir, "pendulum.yml");
  writeFileSync(out, render({}).text);
  const env = { PATH: process.env.PATH, HOME: dir, TMPDIR: process.env.TMPDIR };
  const run = (...args) => spawnSync(process.execPath, [join(PLUGIN, "scripts", "setup.mjs"), "--repo", "acme/app", "--apply", "workflow", "--out", out, ...args], { cwd: dir, env, encoding: "utf8" });
  const dry = run("--add-account", "claude-2", "--add-account", "codex:codex-2");
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /accounts claude: claude, claude-2 \(default claude\); codex: codex, codex-2 \(default codex\)/);
  assert.match(dry.stdout, /save ANTHROPIC_API_KEY_CLAUDE_2, PENDULUM_CODEX_GATEWAY_KEY or CODEX_API_KEY, PENDULUM_CODEX_GATEWAY_KEY_CODEX_2 or CODEX_API_KEY_CODEX_2 with `gh secret set NAME`, pasting the value at its prompt \(never --body\)/);
  const plan = run("--add-account", "claude-2", "--credential", "plan");
  assert.match(plan.stdout, /save CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN_CLAUDE_2 with/, "a plan credential names the plan token's secrets");
  assert.match(plan.stdout, /no longer named: ANTHROPIC_API_KEY/);
  const bad = run("--accounts", '{"claude": ["codex"]}');
  assert.equal(bad.status, 1);
  assert.equal(bad.stderr.trim(), `[pendulum] setup failed: --accounts: ${routeAccounts('{"claude": ["codex"]}').problem}`);
  assert.equal(run("--remove-account").stderr.trim(), "[pendulum] setup failed: --remove-account: name the account");
  assert.equal(readFileSync(out, "utf8"), render({}).text, "a dry run writes nothing");
});
