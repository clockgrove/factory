import "./temp.mjs";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Several accounts on GitHub Actions and the cloud sandbox (#267). GitHub is a fetch stand-in at this URL, set before the
// App-token client reads it; every secret value here is a fake.
process.env.GITHUB_API_URL = "https://github.test";
const { RETRY } = await import("../scripts/lib/github.mjs");
const { NO_SECRET, accountLabelNote, chatgptLogin, routeAccounts, routeSecretSuffix, routeSuffixes } = await import("../scripts/lib/accounts.mjs");
const { accountStep, stageAccount } = await import("../scripts/objective-account.mjs");
const { accountGate, routeAccountCheck } = await import("../scripts/lib/objective-trust.mjs");
const { renderWorkflow } = await import("../scripts/setup.mjs");
const { parseYaml } = await import("../scripts/lib/yaml.mjs");
const { missingCredential, stageEnvironment } = await import("../scripts/launch.mjs");
const { credentialEnv } = await import("../scripts/lib/harness.mjs");
const { credentialChecks, neededSecrets, routeAccountChecks, secretChecks } = await import("../scripts/doctor.mjs");

RETRY.sleep = async () => {};
const ROOT = join(import.meta.dirname, "..", "..");
const REPO = { owner: "acme", name: "app", full: "acme/app" };
const ACCOUNTS = JSON.stringify({ claude: ["claude", "claude-2"], codex: ["codex-2"] });
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KEY = privateKey.export({ type: "pkcs1", format: "pem" });

/**
 * A GitHub for Objective #8: its labels, each applied by `by[label]` (kirk, who can push, unless named), the App's token
 * mint, the repository's secret names (`secrets`), and every request made, in `reads`.
 */
async function withGitHub({ labels = ["factory:objective"], by = {}, secrets = [] }, fn) {
  const reads = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || "GET";
    const p = u.pathname;
    reads.push(`${method} ${p}`);
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (p === "/app") return json({ slug: "factory-test", name: "Factory test" });
    if (p === "/repos/acme/app/installation") return json({ id: 3, permissions: { issues: "write", metadata: "read", contents: "write", pull_requests: "write" }, account: { type: "Organization" } });
    if (method === "POST" && p === "/app/installations/3/access_tokens") return json({ token: "ghs_fakeminted0000", expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: JSON.parse(init.body).permissions, repositories: [{ full_name: "acme/app" }] }, 201);
    if (p === "/repos/acme/app/issues/8") return json({ number: 8, state: "open", labels: labels.map((name) => ({ name })) });
    if (p === "/repos/acme/app/issues/8/timeline") return json(labels.map((name, i) => ({ event: "labeled", label: { name }, created_at: new Date(Date.UTC(2026, 10, 15, 0, i)).toISOString(), actor: { login: by[name] || "kirk", type: "User", id: 7 } })));
    const perm = /^\/repos\/acme\/app\/collaborators\/([^/]+)\/permission$/.exec(p);
    if (perm) return json({ permission: perm[1] === "kirk" ? "write" : "read" });
    if (p === "/repos/acme/app/actions/secrets") return json({ secrets: secrets.map((name) => ({ name })) });
    if (p === "/repos/acme/app/actions/organization-secrets") return json({ message: "no organization" }, 422);
    return json({ message: "Not Found" }, 404);
  };
  try {
    return await fn(reads);
  } finally {
    globalThis.fetch = real;
  }
}

/** The account step as the Action runs it (accountStep: the App's token minted, then stageAccount), its outputs read back. */
async function runStep({ labels, by, accounts = ACCOUNTS, harness = "claude", issue = "8", branch = "none" }) {
  const out = join(mkdtempSync(join(tmpdir(), "acct-")), "output");
  writeFileSync(out, "");
  const env = { GITHUB_REPOSITORY: "acme/app", GITHUB_OUTPUT: out, FACTORY_ACCOUNTS: accounts, FACTORY_HARNESS: harness, FACTORY_INPUT_APP_ID: "12", FACTORY_INPUT_APP_PRIVATE_KEY: KEY };
  let reads;
  await withGitHub({ labels, by }, (r) => ((reads = r), accountStep({ args: { repo: "acme/app", issue, branch }, env })));
  return { outputs: Object.fromEntries(readFileSync(out, "utf8").trim().split("\n").map((l) => l.split(/=(.*)/s).slice(0, 2))), reads };
}

test("the accounts declaration is a JSON object of each harness's account names; anything else is refused naming why, never echoing it (#267)", () => {
  assert.deepEqual(routeAccounts(""), { ok: true, declared: false, accounts: { claude: [], codex: [], copilot: [] } });
  assert.deepEqual(routeAccounts(undefined).declared, false);
  assert.deepEqual(routeAccounts(ACCOUNTS), { ok: true, declared: true, accounts: { claude: ["claude", "claude-2"], codex: ["codex-2"], copilot: [] } });
  for (const [text, why] of [
    ["claude-2", /not valid JSON/],
    ['["claude-2"]', /not a JSON object/],
    ['{"gemini": ["g"]}', /harness Factory does not run/],
    ['{"claude": "claude-2"}', /not a list/],
    ['{"claude": ["Claude_2"]}', /lowercase letters, digits and hyphens/],
    ['{"claude": ["a"], "codex": ["a"]}', /declares `a` twice/],
    ['{"claude": ["codex"]}', /another harness's name/],
  ]) {
    const r = routeAccounts(text);
    assert.equal(r.ok, false, text);
    assert.match(r.problem, why, text);
    assert.ok(!r.problem.includes("Claude_2") && !r.problem.includes("gemini"), "the value is not echoed");
  }
});

test("each account's secrets carry its own suffix; the account named after its harness is today's secrets, and a stage's other harnesses resolve none (#267)", () => {
  assert.equal(routeSecretSuffix("claude", "claude"), "");
  assert.equal(routeSecretSuffix("claude-2", "claude"), "_CLAUDE_2");
  assert.equal(routeSecretSuffix("work-a-1", "codex"), "_WORK_A_1");
  assert.deepEqual(routeSuffixes({ name: "claude-2", harness: "claude" }), { claude: "_CLAUDE_2", codex: NO_SECRET, copilot: NO_SECRET });
  assert.deepEqual(routeSuffixes({ name: "codex", harness: "codex" }), { claude: NO_SECRET, codex: "", copilot: NO_SECRET });
  assert.deepEqual(routeSuffixes(null), { claude: NO_SECRET, codex: NO_SECRET, copilot: NO_SECRET });
  assert.ok(!/^[A-Za-z0-9_]*$/.test(`ANTHROPIC_API_KEY${NO_SECRET}`), "no secret can have the name a NO_SECRET lookup makes");
});

test("the account step picks the trusted label's account, else the harness's default, and names no account for a label it cannot act on (#267)", async () => {
  // A trusted pin: that account, its own suffix for its harness, none for the others. Read-only token, narrowed.
  const pinned = await runStep({ labels: ["factory:objective", "factory:account:claude-2"] });
  assert.deepEqual(pinned.outputs, { account: "claude-2", suffix_claude: "_CLAUDE_2", suffix_codex: NO_SECRET, suffix_copilot: NO_SECRET });
  assert.ok(pinned.reads.includes("GET /repos/acme/app/issues/8/timeline"), "the labeler is read");
  // No label: the harness's first declared account, on today's secrets (it is named after the harness).
  const plain = await runStep({ labels: ["factory:objective"] });
  assert.deepEqual(plain.outputs, { account: "claude", suffix_claude: "", suffix_codex: NO_SECRET, suffix_copilot: NO_SECRET });
  assert.ok(!plain.reads.some((r) => r.endsWith("/timeline")), "no label: no timeline read");
  // A harness label: that harness's default account.
  const codex = await runStep({ labels: ["factory:objective", "factory:harness:codex"] });
  assert.deepEqual(codex.outputs, { account: "codex-2", suffix_claude: NO_SECRET, suffix_codex: "_CODEX_2", suffix_copilot: NO_SECRET });
  // A review job names its PR's branch, not the issue.
  const review = await runStep({ labels: ["factory:objective", "factory:account:claude-2"], issue: "0", branch: "factory/8" });
  assert.equal(review.outputs.account, "claude-2");
  // No account: a labeler who cannot push, a name no account of the harness has, another harness's account, two labels.
  for (const [labels, by] of [
    [["factory:objective", "factory:account:claude-2"], { "factory:account:claude-2": "stranger" }],
    [["factory:objective", "factory:account:claude-9"], {}],
    [["factory:objective", "factory:account:codex-2"], {}],
    [["factory:objective", "factory:account:claude", "factory:account:claude-2"], {}],
  ]) {
    const r = await runStep({ labels, by });
    assert.deepEqual(r.outputs, { account: "", suffix_claude: NO_SECRET, suffix_codex: NO_SECRET, suffix_copilot: NO_SECRET }, labels.join(" "));
  }
});

/** The rendered workflow's jobs whose stage step takes a harness credential, with the step that starts the stage. */
function stageJobs(sandbox) {
  const template = readFileSync(join(ROOT, "plugin", "workflow-template.yml"), "utf8");
  const text = renderWorkflow(template, { sandbox: sandbox ? "vercel" : "", action: "clockgrove/factory@v0.9.99", default_branch: { raw: '"main"' }, maintainer_ids: { raw: "" }, ci_workflow: "ci" });
  const wf = parseYaml(text);
  const jobs = Object.entries(wf.jobs).filter(([, j]) => (j.steps || []).some((s) => s?.with?.anthropic_api_key !== undefined));
  return { text, jobs };
}

/** GitHub's evaluation of the template's one lookup form, `secrets[format('NAME{0}', steps.account.outputs.KEY)]`. */
function resolve(expr, secrets, outputs) {
  const m = /^\$\{\{ secrets\[format\('([A-Z_]+)\{0\}', steps\.account\.outputs\.(suffix_[a-z]+)\)\] \}\}$/.exec(String(expr).trim());
  assert.ok(m, `a credential input is a per-account lookup: ${expr}`);
  return secrets[`${m[1]}${outputs[m[2]] ?? ""}`] ?? "";
}

const CREDENTIALS = ["anthropic_api_key", "claude_code_oauth_token", "codex_api_key", "codex_gateway_key", "copilot_github_token"];

test("every stage job picks its account first and passes only that account's secrets; with none declared, exactly today's (#267)", async () => {
  // Every secret of every account, fake values.
  const secrets = { ANTHROPIC_API_KEY: "fake-claude-default", CLAUDE_CODE_OAUTH_TOKEN: "fake-claude-plan", ANTHROPIC_API_KEY_CLAUDE_2: "fake-claude-2", CLAUDE_CODE_OAUTH_TOKEN_CLAUDE_2: "fake-claude-2-plan", CODEX_API_KEY: "fake-codex-default", CODEX_API_KEY_CODEX_2: "fake-codex-2", FACTORY_CODEX_GATEWAY_KEY_CODEX_2: "fake-codex-2-gw", COPILOT_GITHUB_TOKEN: "fake-copilot" };
  const pinned = (await runStep({ labels: ["factory:objective", "factory:account:claude-2"] })).outputs;
  const none = (await runStep({ labels: ["factory:objective", "factory:account:claude-9"] })).outputs;
  for (const sandbox of [false, true]) {
    const { text, jobs } = stageJobs(sandbox);
    assert.deepEqual(jobs.map(([n]) => n).sort(), sandbox ? ["launch", "launch-event"] : ["review", "work"]);
    // No credential secret is named outright anywhere: each is a lookup by the account's suffix.
    assert.doesNotMatch(text, /secrets\.(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|CODEX_API_KEY|FACTORY_CODEX_GATEWAY_KEY|COPILOT_GITHUB_TOKEN)\b/);
    for (const [name, job] of jobs) {
      const at = job.steps.findIndex((s) => s?.with?.anthropic_api_key !== undefined);
      const step = job.steps[at];
      const pick = job.steps.findIndex((s) => s?.id === "account");
      assert.ok(pick >= 0 && pick < at, `${name}: the account step comes first`);
      assert.equal(job.steps[pick].if, "env.FACTORY_ACCOUNTS != ''", `${name}: it runs only with accounts declared`);
      assert.equal(job.steps[pick].with.mode, "account");
      assert.equal(job.steps[pick].with.anthropic_api_key, undefined, `${name}: the account step gets no credential`);
      assert.equal(step.with.account, "${{ steps.account.outputs.account }}", `${name}: the stage is told its account`);
      const given = (outputs) => Object.fromEntries(CREDENTIALS.map((k) => [k, resolve(step.with[k], secrets, outputs)]));
      // Accounts declared, pinned to claude-2: claude-2's secrets alone.
      assert.deepEqual(given(pinned), { anthropic_api_key: "fake-claude-2", claude_code_oauth_token: "fake-claude-2-plan", codex_api_key: "", codex_gateway_key: "", copilot_github_token: "" }, name);
      // No account could be picked: no secret at all.
      assert.deepEqual(Object.values(given(none)).filter(Boolean), [], name);
      // None declared (the account step skipped, its outputs empty): today's secrets, as before.
      assert.deepEqual(given({}), { anthropic_api_key: "fake-claude-default", claude_code_oauth_token: "fake-claude-plan", codex_api_key: "fake-codex-default", codex_gateway_key: "", copilot_github_token: "fake-copilot" }, name);
    }
  }
  // The Action's account mode runs before any install and records the picked account for the stage.
  const action = readFileSync(join(ROOT, "action.yml"), "utf8");
  assert.match(action, /inputs\.mode != 'watch' && inputs\.mode != 'account'/, "no harness install in account mode");
  assert.match(action, /FACTORY_STAGE_ACCOUNT: \$\{\{ inputs\.account \}\}/);
  assert.match(action, /account\)\s+node "\$FACTORY_PLUGIN_ROOT\/scripts\/objective-account\.mjs"/);
});

test("the stage runs only on the account it was prepared with: a changed or unusable pin Blocks before any harness; none declared is today's route (#267)", async () => {
  const gate = async (labels, env, by = {}) => {
    const applied = [];
    const r = await withGitHub({ labels, by }, () => accountGate({ repo: REPO, issue: 8, harness: "claude", labels, env, opts: { token: "t" }, apply: async (_repo, e) => applied.push(e), stage: "work" }));
    return { r, applied };
  };
  const pin = ["factory:objective", "factory:account:claude-2"];
  const ok = await gate(pin, { FACTORY_ACCOUNTS: ACCOUNTS, FACTORY_STAGE_ACCOUNT: "claude-2" });
  assert.deepEqual(ok.r, { ok: true, account: "claude-2", note: "" });
  assert.deepEqual(ok.applied, []);
  const moved = await gate(pin, { FACTORY_ACCOUNTS: ACCOUNTS, FACTORY_STAGE_ACCOUNT: "claude" });
  assert.equal(moved.r.ok, false);
  assert.match(moved.applied[0].reason, /prepared with account `claude`'s credential, but the Objective's labels now pick `claude-2`/);
  assert.deepEqual([moved.applied[0].exit, moved.applied[0].cause], ["blocked", "setup"]);
  const old = await gate(["factory:objective"], { FACTORY_ACCOUNTS: ACCOUNTS, FACTORY_STAGE_ACCOUNT: "" });
  assert.match(old.applied[0].reason, /its workflow picked none for this stage/);
  assert.match(old.applied[0].fix, /Re-render the workflow/);
  const stranger = await gate(pin, { FACTORY_ACCOUNTS: ACCOUNTS, FACTORY_STAGE_ACCOUNT: "" }, { "factory:account:claude-2": "stranger" });
  assert.match(stranger.applied[0].reason, /`factory:account:claude-2` was applied by `stranger`, who cannot push/);
  const two = await gate([...pin, "factory:account:claude"], { FACTORY_ACCOUNTS: ACCOUNTS, FACTORY_STAGE_ACCOUNT: "" });
  assert.match(two.applied[0].reason, /both pin this Objective to an account/);
  const bad = await gate(["factory:objective"], { FACTORY_ACCOUNTS: "{", FACTORY_STAGE_ACCOUNT: "" });
  assert.match(bad.applied[0].reason, /FACTORY_ACCOUNTS is not valid JSON/);
  // None declared: today's single credential, the label only noted.
  const today = await gate(pin, { FACTORY_STAGE_ACCOUNT: "" });
  assert.equal(today.r.ok, true);
  assert.equal(today.r.account, null);
  assert.match(today.r.note, /declares no accounts for GitHub Actions and the cloud sandbox/);
  assert.equal((await gate(["factory:objective"], {})).r.note, "");
  // Local mode's loop picks its own.
  assert.deepEqual(await accountGate({ local: true, labels: pin, env: { FACTORY_ACCOUNTS: ACCOUNTS } }), { ok: true, account: null, note: "" });
  assert.equal(accountLabelNote(pin, false, true), "", "accounts declared: the label pins, no note");
});

test("the launcher checks the account before any sandbox spend, names that account's secret when its credential is missing, and hands the stage its account (#267)", async () => {
  const pin = ["factory:objective", "factory:account:claude-2"];
  const c = await withGitHub({ labels: pin }, () => routeAccountCheck({ repo: REPO, issue: 8, harness: "claude", labels: pin, env: { FACTORY_ACCOUNTS: ACCOUNTS, FACTORY_STAGE_ACCOUNT: "claude" }, opts: { token: "t" } }));
  assert.match(c.refusal.reason, /labels now pick `claude-2`/);
  const miss = missingCredential({ harness: "claude" }, "claude-2");
  assert.match(miss.reason, /no claude credential of account `claude-2` reached the launch job/);
  assert.match(miss.fix, /ANTHROPIC_API_KEY_CLAUDE_2 \(CLAUDE_CODE_OAUTH_TOKEN_CLAUDE_2 with credential: plan\)/);
  assert.match(missingCredential({ harness: "codex" }, "codex").fix, /FACTORY_CODEX_GATEWAY_KEY or CODEX_API_KEY \(gh/, "the account named after its harness: today's names");
  const env = stageEnvironment({ inputs: { harness: "claude", claudeCodeOauthToken: "fake-claude-2-plan" }, env: { FACTORY_ACCOUNTS: ACCOUNTS, FACTORY_STAGE_ACCOUNT: "claude-2", FACTORY_INPUT_ACCOUNT: "claude-2" }, stage: "work", issue: 8, claim: "c1", tokens: { write: "ghs_w" } });
  assert.equal(env.FACTORY_STAGE_ACCOUNT, "claude-2");
  assert.equal(env.FACTORY_ACCOUNTS, ACCOUNTS);
  assert.equal(env.FACTORY_ACCOUNT, undefined, "the account step's input is no setting the stage takes");
  assert.equal(env.FACTORY_INPUT_CLAUDE_CODE_OAUTH_TOKEN, "fake-claude-2-plan");
  assert.deepEqual(Object.keys(env).filter((k) => /API_KEY|OAUTH|GITHUB_TOKEN|GATEWAY_KEY/.test(k)), ["FACTORY_INPUT_CLAUDE_CODE_OAUTH_TOKEN"], "one credential");
});

test("a ChatGPT-login Codex credential is refused on GitHub Actions and the cloud sandbox; an API key, a plan token and a Copilot token run (#267)", async () => {
  const jwt = `${Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url")}.${Buffer.from("{}").toString("base64url")}.c2ln`;
  const authJson = JSON.stringify({ OPENAI_API_KEY: null, tokens: { access_token: "x", refresh_token: "y" } });
  assert.equal(chatgptLogin(jwt), true);
  assert.equal(chatgptLogin(authJson), true);
  assert.equal(chatgptLogin("sk-proj-fakefakefake"), false);
  assert.equal(chatgptLogin("vck_fakefakefake"), false);
  const actions = { GITHUB_ACTIONS: "true" };
  for (const v of [jwt, authJson]) {
    await assert.rejects(credentialEnv({ harness: "codex", credential: "api", inputs: { codexApiKey: v }, env: actions }), /ChatGPT login/);
    await assert.rejects(credentialEnv({ harness: "codex", credential: "api", inputs: { codexGatewayKey: v }, env: actions }), /ChatGPT login/);
    const checks = await credentialChecks({ inputs: { harness: "codex", model: "gpt-6.1-sol", codexApiKey: v }, env: actions, local: false });
    assert.ok(checks.some((c) => c.status === "FAIL" && /ChatGPT login/.test(c.detail) && !c.detail.includes(v)), "doctor fails it, never printing it");
  }
  assert.deepEqual((await credentialEnv({ harness: "codex", credential: "api", inputs: { codexApiKey: "sk-proj-fakefakefake" }, env: actions })).env, { CODEX_API_KEY: "sk-proj-fakefakefake" });
  assert.deepEqual((await credentialEnv({ harness: "claude", credential: "plan", inputs: { claudeCodeOauthToken: "sk-ant-oat-fake" }, env: actions })).env, { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-fake" });
  assert.deepEqual((await credentialEnv({ harness: "copilot", credential: "api", inputs: { copilotGithubToken: "github_pat_fake" }, env: actions })).env, { COPILOT_GITHUB_TOKEN: "github_pat_fake" });
});

test("doctor checks each declared account's secret by name, and the declaration itself (#267)", async () => {
  const inputs = { harness: "claude", credential: "plan" };
  assert.deepEqual(neededSecrets(inputs), ["FACTORY_APP_ID", "FACTORY_APP_PRIVATE_KEY", "CLAUDE_CODE_OAUTH_TOKEN"], "none declared: today's");
  assert.deepEqual(neededSecrets(inputs, ACCOUNTS), ["FACTORY_APP_ID", "FACTORY_APP_PRIVATE_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_CLAUDE_2", ["FACTORY_CODEX_GATEWAY_KEY_CODEX_2", "CODEX_API_KEY_CODEX_2"]]);
  const [fail] = await withGitHub({ secrets: ["FACTORY_APP_ID", "FACTORY_APP_PRIVATE_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CODEX_API_KEY_CODEX_2"] }, () => secretChecks({ inputs, repo: REPO, accounts: ACCOUNTS }));
  assert.equal(fail.status, "FAIL");
  assert.match(fail.detail, /^missing CLAUDE_CODE_OAUTH_TOKEN_CLAUDE_2 /);
  const [pass] = await withGitHub({ secrets: ["FACTORY_APP_ID", "FACTORY_APP_PRIVATE_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_CLAUDE_2", "CODEX_API_KEY_CODEX_2"] }, () => secretChecks({ inputs, repo: REPO, accounts: ACCOUNTS }));
  assert.equal(pass.status, "PASS");
  assert.deepEqual(routeAccountChecks(""), []);
  assert.equal(routeAccountChecks("{").at(0).status, "FAIL");
  assert.match(routeAccountChecks(ACCOUNTS)[0].detail, /claude: claude, claude-2 \(default claude\); codex: codex-2 \(default codex-2\)/);
});

test("the dispatcher holds an Objective with two account labels Queued on these routes, never Blocking it (#267)", async () => {
  const { dispatch } = await import("../scripts/dispatch.mjs");
  const issue = (number, labels) => ({ number, state: "open", labels: ["factory:objective", ...labels].map((name) => ({ name })), body: "", updated_at: new Date().toISOString(), user: { login: "maintainer" } });
  const open = [issue(5, ["factory:account:claude", "factory:account:claude-2"]), issue(6, [])];
  const real = globalThis.fetch;
  const saved = process.env.FACTORY_ACCOUNTS;
  const writes = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || "GET";
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (method !== "GET" && !u.pathname.endsWith("/graphql")) writes.push(`${method} ${u.pathname}`);
    if (u.pathname === "/user") return json({ login: "maintainer", type: "User" });
    if (u.pathname === "/repos/acme/app/issues") return json(u.searchParams.get("state") === "closed" ? [] : open);
    if (/\/actions\/workflows\/[^/]+\/runs$/.test(u.pathname)) return json({ workflow_runs: [] });
    if (/\/(timeline|comments)$/.test(u.pathname) || u.pathname.endsWith("/collaborators") || u.pathname === "/repos/acme/app/pulls") return json([]);
    if (method !== "GET") return json({}, 200);
    return json({ message: "Not Found" }, 404);
  };
  try {
    const run = async (accounts) => {
      if (accounts === undefined) delete process.env.FACTORY_ACCOUNTS;
      else process.env.FACTORY_ACCOUNTS = accounts;
      return dispatch({ repo: "acme/app", objectiveLabel: "factory:objective", maxConcurrent: 5, dailyUsd: 0, ciChecks: [], timeoutMinutes: 60 }, { token: "t" });
    };
    const held = await run(ACCOUNTS);
    assert.deepEqual(held.ready, [6]);
    assert.match(held.skipped.find((s) => s.number === 5).reason, /both pin this Objective to an account, so no stage of it starts until one is left/);
    assert.ok(!writes.some((w) => w.startsWith("POST /repos/acme/app/issues/5/comments")), "no Block for it");
    // None declared: the labels do nothing here, and it is picked as ever.
    assert.deepEqual((await run(undefined)).ready.sort(), [5, 6]);
  } finally {
    globalThis.fetch = real;
    if (saved === undefined) delete process.env.FACTORY_ACCOUNTS;
    else process.env.FACTORY_ACCOUNTS = saved;
  }
});

test("the accounts are the workflow file's alone: no repository variable or local setting takes them, and a re-render keeps them (#267)", async () => {
  const { OTHER_ROUTE_SETTINGS, WORKFLOW_SETTINGS, resolveInputs } = await import("../scripts/lib/inputs.mjs");
  const { keptArgs, pickRunner, workflowSettings, workflowText } = await import("../scripts/setup.mjs");
  assert.ok(!WORKFLOW_SETTINGS.has("FACTORY_ACCOUNTS"), "no setting a variable layer or local mode takes");
  assert.ok(OTHER_ROUTE_SETTINGS.has("FACTORY_ACCOUNTS"), "local mode drops it without a warning");
  const template = readFileSync(join(ROOT, "plugin", "workflow-template.yml"), "utf8");
  const render = (text) => {
    const before = text ? workflowSettings(text) : null;
    const args = keptArgs(before, {}, template);
    const inputs = resolveInputs({ args, env: {} });
    return workflowText({ template, inputs, args, explicit: {}, before, latest: "v0.9.99", notify: "", runsOn: pickRunner(undefined, {}, {}).runsOn, ciWorkflow: "CI", defaultBranch: "main" });
  };
  const declared = render(null).replace(/^env:\n/m, `env:\n  FACTORY_ACCOUNTS: '${ACCOUNTS}'\n`);
  assert.equal(workflowSettings(render(declared)).env.FACTORY_ACCOUNTS, ACCOUNTS);
});
