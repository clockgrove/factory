import "./temp.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { resolveInputs } from "../scripts/lib/inputs.mjs";
import { routeAccounts } from "../scripts/lib/accounts.mjs";
import { secretReferences } from "../scripts/doctor.mjs";
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
