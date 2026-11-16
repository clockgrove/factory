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
const { NO_ACCOUNT, accountLabelNote, validAccountName, chatgptLogin, routeAccounts, routeAccountsText, routeCredentialRef, routeSecretSuffix } = await import("../scripts/lib/accounts.mjs");
const { accountStep, stageAccount } = await import("../scripts/objective-account.mjs");
const { accountGate, routeAccountCheck } = await import("../scripts/lib/objective-trust.mjs");
const { keptArgs, pickRunner, workflowSettings, workflowText } = await import("../scripts/setup.mjs");
const { resolveInputs } = await import("../scripts/lib/inputs.mjs");
const { Evaluator, Lexer, Parser, data: exprData } = await import("../vendor/@actions/expressions/dist/index.js");
const { parseYaml } = await import("../scripts/lib/yaml.mjs");
const { missingCredential, stageEnvironment } = await import("../scripts/launch.mjs");
const { credentialEnv } = await import("../scripts/lib/harness.mjs");
const { credentialChecks, neededSecrets, routeAccountChecks, secretChecks, secretReferences, workflowSecretChecks } = await import("../scripts/doctor.mjs");

RETRY.sleep = async () => {};
const ROOT = join(import.meta.dirname, "..", "..");
const REPO = { owner: "acme", name: "app", full: "acme/app" };
const ACCOUNTS = JSON.stringify({ claude: ["claude", "claude-2"], codex: ["codex-2"] });
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KEY = privateKey.export({ type: "pkcs1", format: "pem" });

/**
 * A GitHub for Objective #8 and its PR #9: the issue's labels, each applied by `by[label]` (kirk, who can push, unless
 * named), any more timeline `events`, the App's token mint (each request's permissions in `minted`), the repository's
 * secret names (`secrets`), the PR's labels and comments (Factory's own as `factory-test[bot]`), and every request made,
 * in `reads`. Label and comment writes change that state.
 */
async function withGitHub({ labels = ["factory:objective"], by = {}, events = [], secrets = [], prLabels = ["factory:review"], comments = [] }, fn) {
  const reads = [];
  const state = { issue: new Set(labels), pr: new Set(prLabels), comments: [...comments], minted: [] };
  let id = 500;
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || "GET";
    const p = u.pathname;
    reads.push(`${method} ${p}`);
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    const body = init.body ? JSON.parse(init.body) : null;
    if (p === "/app") return json({ slug: "factory-test", name: "Factory test" });
    if (p === "/repos/acme/app/installation") return json({ id: 3, permissions: { issues: "write", metadata: "read", contents: "write", pull_requests: "write" }, account: { type: "Organization" } });
    if (method === "POST" && p === "/app/installations/3/access_tokens") return state.minted.push(body.permissions), json({ token: "ghs_fakeminted0000", expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: body.permissions, repositories: [{ full_name: "acme/app" }] }, 201);
    if (p === "/repos/acme/app/issues/8") return json({ number: 8, state: "open", labels: [...state.issue].map((name) => ({ name })) });
    if (p === "/repos/acme/app/issues/8/timeline") return json([...labels.map((name, i) => ({ event: "labeled", label: { name }, created_at: new Date(Date.UTC(2026, 10, 15, 0, i)).toISOString(), actor: { login: by[name] || "kirk", type: "User", id: 7 } })), ...events]);
    const perm = /^\/repos\/acme\/app\/collaborators\/([^/]+)\/permission$/.exec(p);
    if (perm) return json({ permission: perm[1] === "kirk" ? "write" : "read" });
    if (p === "/repos/acme/app/actions/secrets") return json({ secrets: secrets.map((name) => ({ name })) });
    if (p === "/repos/acme/app/actions/organization-secrets") return json({ message: "no organization" }, 422);
    const lab = /^\/repos\/acme\/app\/issues\/(8|9)\/labels(?:\/(.+))?$/.exec(p);
    if (lab) {
      const set = lab[1] === "8" ? state.issue : state.pr;
      if (method === "DELETE") return set.delete(decodeURIComponent(lab[2])) ? json([]) : json({ message: "Label does not exist" }, 404);
      if (method === "POST") return body.labels.forEach((l) => set.add(l)), json([...set].map((name) => ({ name })));
    }
    if (p === "/repos/acme/app/issues/9/comments" && method === "GET") return json(state.comments);
    if (p === "/repos/acme/app/issues/9/comments" && method === "POST") return state.comments.push({ id: ++id, user: { login: "factory-test[bot]", type: "Bot" }, body: body.body, created_at: new Date().toISOString() }), json(state.comments.at(-1), 201);
    const one = /^\/repos\/acme\/app\/issues\/comments\/(\d+)$/.exec(p);
    if (one && method === "DELETE") return (state.comments = state.comments.filter((c) => c.id !== Number(one[1]))), new Response(null, { status: 204 });
    if (one && method === "PATCH") return json(Object.assign(state.comments.find((c) => c.id === Number(one[1])), { body: body.body }));
    if (p.endsWith("/graphql")) return json({ data: { repository: null, viewer: { login: "factory-test[bot]" } } });
    return json({ message: "Not Found" }, 404);
  };
  try {
    return await fn(reads, state);
  } finally {
    globalThis.fetch = real;
  }
}

/** The account step as the Action runs it (accountStep: the App's token minted, then stageAccount), its outputs read back. */
async function runStep({ labels, by, events, accounts = ACCOUNTS, rendered = routeAccountsText(accounts), harness = "claude", issue = "8", branch = "none" }) {
  const out = join(mkdtempSync(join(tmpdir(), "acct-")), "output");
  writeFileSync(out, "");
  const env = { GITHUB_REPOSITORY: "acme/app", GITHUB_OUTPUT: out, FACTORY_ACCOUNTS: accounts, FACTORY_RENDERED_ACCOUNTS: rendered, FACTORY_HARNESS: harness, FACTORY_INPUT_APP_ID: "12", FACTORY_INPUT_APP_PRIVATE_KEY: KEY };
  let reads;
  let minted;
  await withGitHub({ labels, by, events }, (r, st) => ((reads = r), (minted = st.minted), accountStep({ args: { repo: "acme/app", issue, branch }, env })));
  return { minted, outputs: Object.fromEntries(readFileSync(out, "utf8").trim().split("\n").map((l) => l.split(/=(.*)/s).slice(0, 2))), reads };
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
    ['{"claude": ["claude-2"], "claude": ["claude-3"]}', /names a harness twice/],
    ['{"claude": ["claude-2"], "\\u0063laude": ["claude-3"]}', /names a harness twice/],
  ]) {
    const r = routeAccounts(text);
    assert.equal(r.ok, false, text);
    assert.match(r.problem, why, text);
    assert.ok(!r.problem.includes("Claude_2") && !r.problem.includes("gemini"), "the value is not echoed");
  }
});

test("each account's secrets carry its own suffix, the account named after its harness today's secrets, each named by its fixed name in the workflow (#267, #351)", () => {
  assert.equal(routeSecretSuffix("claude", "claude"), "");
  assert.equal(routeSecretSuffix("claude-2", "claude"), "_CLAUDE_2");
  assert.equal(routeSecretSuffix("work-a-1", "codex"), "_WORK_A_1");
  const declared = routeAccounts(ACCOUNTS);
  assert.equal(routeCredentialRef("anthropic_api_key", declared), "${{ (steps.account.outputs.account == 'claude' && secrets.ANTHROPIC_API_KEY) || (steps.account.outputs.account == 'claude-2' && secrets.ANTHROPIC_API_KEY_CLAUDE_2) || '' }}");
  assert.equal(routeCredentialRef("codex_gateway_key", declared), "${{ (steps.account.outputs.account == 'codex-2' && secrets.FACTORY_CODEX_GATEWAY_KEY_CODEX_2) || '' }}");
  assert.equal(routeCredentialRef("copilot_github_token", declared), "${{ (steps.account.outputs.account == 'copilot' && secrets.COPILOT_GITHUB_TOKEN) || '' }}", "a harness with none declared: its one account");
  assert.ok(!validAccountName(NO_ACCOUNT), "the step's no-account output is no account's name");
  assert.equal(routeAccountsText(ACCOUNTS), '{"claude":["claude","claude-2"],"codex":["codex-2"]}');
  assert.equal(routeAccountsText(' {"codex": ["codex-2"],  "claude": ["claude", "claude-2"]} '), routeAccountsText(ACCOUNTS), "the same accounts, written otherwise");
  assert.equal(routeAccountsText(""), "");
  assert.equal(routeAccountsText("{"), "");
});

test("the account step picks the trusted label's account, else the harness's default, and names no account for a label it cannot act on (#267)", async () => {
  // A trusted pin: that account. Read-only token, narrowed.
  const pinned = await runStep({ labels: ["factory:objective", "factory:account:claude-2"] });
  assert.deepEqual(pinned.outputs, { account: "claude-2" });
  assert.ok(pinned.reads.includes("GET /repos/acme/app/issues/8/timeline"), "the labeler is read");
  assert.deepEqual(pinned.minted, [{ issues: "read", metadata: "read" }], "the step's token is read-only: issues and metadata, nothing more");
  // No label: the harness's first declared account, on today's secrets (it is named after the harness).
  const plain = await runStep({ labels: ["factory:objective"] });
  assert.deepEqual(plain.outputs, { account: "claude" });
  // A pin removed by someone who cannot push still stands; removed by someone who can, the default again.
  const removal = (login) => [{ event: "labeled", label: { name: "factory:account:claude-2" }, created_at: "2026-11-15T01:00:00Z", actor: { login: "kirk", type: "User", id: 7 } }, { event: "unlabeled", label: { name: "factory:account:claude-2" }, created_at: "2026-11-15T02:00:00Z", actor: { login, type: "User", id: 9 } }];
  assert.equal((await runStep({ labels: ["factory:objective"], events: removal("stranger") })).outputs.account, "claude-2");
  assert.equal((await runStep({ labels: ["factory:objective"], events: removal("kirk") })).outputs.account, "claude");
  // A harness label: that harness's default account.
  const codex = await runStep({ labels: ["factory:objective", "factory:harness:codex"] });
  assert.deepEqual(codex.outputs, { account: "codex-2" });
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
    assert.deepEqual(r.outputs, { account: NO_ACCOUNT }, labels.join(" "));
  }
});

/** The workflow setup renders on the runner or the cloud sandbox route, re-rendered with `accounts` (FACTORY_ACCOUNTS) in its env block when given. */
function rendered({ accounts = "", sandbox = false } = {}) {
  const template = readFileSync(join(ROOT, "plugin", "workflow-template.yml"), "utf8");
  const render = (text) => {
    const before = text ? workflowSettings(text) : null;
    const args = { ...keptArgs(before, {}, template), ...(sandbox ? { sandbox: "vercel" } : {}) };
    return workflowText({ template, inputs: resolveInputs({ args, env: {} }), args, explicit: {}, before, latest: "v0.9.99", notify: "", runsOn: pickRunner(undefined, {}, {}).runsOn, ciWorkflow: "CI", defaultBranch: "main" });
  };
  const first = render(null);
  return accounts ? render(first.replace(/^env:\n/m, `env:\n  FACTORY_ACCOUNTS: '${accounts}'\n`)) : first;
}

/** The rendered workflow's jobs whose stage step takes a harness credential: [name, job, the stage step]. */
const stageJobs = (text) =>
  Object.entries(parseYaml(text).jobs)
    .map(([n, j]) => [n, j, (j.steps || []).find((st) => st?.with?.anthropic_api_key !== undefined)])
    .filter(([, , st]) => st);

/** A `with:` value as GitHub evaluates it, with its own expression library, over the `secrets` and `steps` contexts. */
function evaluate(value, context) {
  const m = /^\$\{\{([\s\S]*)\}\}$/.exec(String(value).trim());
  if (!m) return String(value);
  const expr = new Parser(new Lexer(m[1]).lex().tokens, ["secrets", "steps"], []).parse();
  return new Evaluator(expr, JSON.parse(JSON.stringify(context), exprData.reviver)).evaluate().coerceString();
}

/** action.yml's run step: each FACTORY_INPUT_<NAME> it sets from an input, by the input's name. */
function actionInputEnv() {
  const action = parseYaml(readFileSync(join(ROOT, "action.yml"), "utf8"));
  const run = action.runs.steps.find((st) => st.id === "run");
  const out = {};
  for (const [k, v] of Object.entries(run.env)) {
    const m = /^\$\{\{ inputs\.([a-z_]+) \}\}$/.exec(String(v));
    if (m) out[m[1]] = k;
  }
  return out;
}

const CREDENTIALS = ["anthropic_api_key", "claude_code_oauth_token", "codex_api_key", "codex_gateway_key", "copilot_github_token"];
const ALL_ACCOUNTS = JSON.stringify({ claude: ["claude", "claude-2"], codex: ["codex", "codex-2"], copilot: ["copilot-2"] });
// v0.9.32's rendered workflow (the last before #267): the secrets each job names, on each route.
const V0932_RUNNER = { dispatch: ["FACTORY_APP_ID", "FACTORY_APP_PRIVATE_KEY"], "queue-watch": ["FACTORY_APP_ID", "FACTORY_APP_PRIVATE_KEY"], work: ["AI_GATEWAY_API_KEY", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CODEX_API_KEY", "COPILOT_GITHUB_TOKEN", "FACTORY_APP_ID", "FACTORY_APP_PRIVATE_KEY", "FACTORY_CODEX_GATEWAY_KEY", "FACTORY_WORKER_SECRET_VALUES"] };
V0932_RUNNER.review = V0932_RUNNER.work;
const VERCEL = ["VERCEL_PROJECT_ID", "VERCEL_TEAM_ID", "VERCEL_TOKEN"];
const V0932_SANDBOX = { dispatch: V0932_RUNNER.dispatch, "queue-watch": V0932_RUNNER.dispatch, launch: [...V0932_RUNNER.work, ...VERCEL].sort(), "launch-gate": V0932_RUNNER.dispatch, "launch-event": [...V0932_RUNNER.work, ...VERCEL].sort(), image: [...V0932_RUNNER.dispatch, ...VERCEL].sort(), sweep: [...V0932_RUNNER.dispatch, ...VERCEL].sort() };

test("no workflow Factory renders reads a secret by a computed name, so GitHub sends a job only the secrets it names (#351)", () => {
  const template = readFileSync(join(ROOT, "plugin", "workflow-template.yml"), "utf8");
  assert.doesNotMatch(template, /secrets\s*\[/, "the template indexes no secret");
  for (const accounts of ["", ACCOUNTS, ALL_ACCOUNTS]) {
    for (const sandbox of [false, true]) {
      const text = rendered({ accounts, sandbox });
      const at = `${accounts || "no accounts"}, ${sandbox ? "sandbox" : "runner"}`;
      assert.doesNotMatch(text, /secrets\s*\[/, at);
      assert.doesNotMatch(text, /toJSON\(\s*secrets\s*\)/i, at);
      assert.deepEqual(secretReferences(text).dynamic, [], at);
      assert.deepEqual(workflowSecretChecks(text).filter((c) => c.status !== "PASS"), [], at);
    }
  }
});

test("with no accounts declared, the rendered workflow names exactly v0.9.32's secrets, each stage's credentials by their usual names (#351)", () => {
  for (const sandbox of [false, true]) {
    const text = rendered({ sandbox });
    const wf = parseYaml(text);
    const named = Object.fromEntries(
      Object.entries(wf.jobs)
        .map(([n, j]) => [n, [...new Set([...JSON.stringify(j).matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]))].sort()])
        .filter(([, l]) => l.length),
    );
    assert.deepEqual(named, sandbox ? V0932_SANDBOX : V0932_RUNNER);
    const usual = { anthropic_api_key: "ANTHROPIC_API_KEY", claude_code_oauth_token: "CLAUDE_CODE_OAUTH_TOKEN", codex_api_key: "CODEX_API_KEY", codex_gateway_key: "FACTORY_CODEX_GATEWAY_KEY", copilot_github_token: "COPILOT_GITHUB_TOKEN" };
    for (const [name, , step] of stageJobs(text)) for (const k of CREDENTIALS) assert.equal(step.with[k], `\${{ secrets.${usual[k]} }}`, `${name} ${k}`);
  }
});

test("with accounts declared, each stage job picks its account first and its step's environment holds that account's credential alone (#267, #351)", async () => {
  // Every secret of every account, fake values.
  const secrets = { ANTHROPIC_API_KEY: "fake-claude-default", CLAUDE_CODE_OAUTH_TOKEN: "fake-claude-plan", ANTHROPIC_API_KEY_CLAUDE_2: "fake-claude-2", CLAUDE_CODE_OAUTH_TOKEN_CLAUDE_2: "fake-claude-2-plan", CODEX_API_KEY: "fake-codex-default", CODEX_API_KEY_CODEX_2: "fake-codex-2", FACTORY_CODEX_GATEWAY_KEY_CODEX_2: "fake-codex-2-gw", COPILOT_GITHUB_TOKEN: "fake-copilot" };
  const pinned = (await runStep({ labels: ["factory:objective", "factory:account:claude-2"] })).outputs;
  const none = (await runStep({ labels: ["factory:objective", "factory:account:claude-9"] })).outputs;
  const codex = (await runStep({ labels: ["factory:objective", "factory:harness:codex"] })).outputs;
  const toEnv = actionInputEnv();
  assert.equal(toEnv.anthropic_api_key, "FACTORY_INPUT_ANTHROPIC_API_KEY");
  for (const sandbox of [false, true]) {
    const text = rendered({ accounts: ACCOUNTS, sandbox });
    const jobs = stageJobs(text);
    assert.deepEqual(jobs.map(([n]) => n).sort(), sandbox ? ["launch", "launch-event"] : ["review", "work"]);
    for (const [name, job, step] of jobs) {
      const pick = job.steps.findIndex((st) => st?.id === "account");
      assert.ok(pick >= 0 && pick < job.steps.indexOf(step), `${name}: the account step comes first`);
      assert.equal(job.steps[pick].if, "env.FACTORY_ACCOUNTS != ''", `${name}: it runs only with accounts declared`);
      assert.equal(job.steps[pick].with.mode, "account");
      assert.equal(job.steps[pick].with.rendered_accounts, routeAccountsText(ACCOUNTS), `${name}: it knows the accounts the step below was rendered for`);
      assert.deepEqual(Object.keys(job.steps[pick].with).filter((k) => CREDENTIALS.includes(k)), [], `${name}: the account step gets no credential`);
      assert.equal(step.with.account, "${{ steps.account.outputs.account }}", `${name}: the stage is told its account`);
      // The step's environment as action.yml builds it from the evaluated inputs, then the inputs the stage resolves.
      const stepEnv = (outputs) => {
        const ctx = { secrets, steps: { account: { outputs } } };
        const env = { GITHUB_ACTIONS: "true", FACTORY_ACCOUNTS: ACCOUNTS, FACTORY_STAGE_ACCOUNT: evaluate(step.with.account, ctx) };
        for (const k of CREDENTIALS) env[toEnv[k]] = evaluate(step.with[k], ctx);
        return env;
      };
      const held = (env) => Object.values(env).filter((v) => Object.values(secrets).includes(v));
      // Pinned to claude-2: claude-2's secrets alone, in the step and in the harness's environment.
      const env = stepEnv(pinned);
      assert.deepEqual(held(env).sort(), ["fake-claude-2", "fake-claude-2-plan"], name);
      const inputs = resolveInputs({ args: {}, env });
      assert.deepEqual((await credentialEnv({ harness: "claude", credential: "api", inputs, env })).env, { ANTHROPIC_API_KEY: "fake-claude-2" }, name);
      assert.deepEqual((await credentialEnv({ harness: "claude", credential: "plan", inputs, env })).env, { CLAUDE_CODE_OAUTH_TOKEN: "fake-claude-2-plan" }, name);
      // A Codex stage on codex-2: its two secrets alone; no account could be picked: none at all.
      assert.deepEqual(held(stepEnv(codex)).sort(), ["fake-codex-2", "fake-codex-2-gw"], name);
      assert.deepEqual(held(stepEnv(none)), [], name);
      // The default account, named after its harness: today's secret alone.
      assert.deepEqual(held(stepEnv({ account: "claude" })).sort(), ["fake-claude-default", "fake-claude-plan"], name);
    }
  }
  // The Action's account mode runs before any install and records the picked account for the stage.
  const action = readFileSync(join(ROOT, "action.yml"), "utf8");
  assert.match(action, /inputs\.mode != 'watch' && inputs\.mode != 'account'/, "no harness install in account mode");
  assert.match(action, /FACTORY_STAGE_ACCOUNT: \$\{\{ inputs\.account \}\}/);
  assert.match(action, /account\)\s+node "\$FACTORY_PLUGIN_ROOT\/scripts\/objective-account\.mjs"/);
});

test("a workflow rendered for other accounts than FACTORY_ACCOUNTS declares passes no credential: the account step picks none and the stage asks for a re-render (#351)", async () => {
  // A third account added to the env block without a re-render: its secret is named nowhere in the jobs.
  const more = JSON.stringify({ claude: ["claude", "claude-2", "claude-3"], codex: ["codex-2"] });
  const stale = await runStep({ labels: ["factory:objective", "factory:account:claude-3"], accounts: more, rendered: routeAccountsText(ACCOUNTS) });
  assert.deepEqual(stale.outputs, { account: "" });
  assert.ok(!stale.reads.includes("GET /repos/acme/app/issues/8"), "decided before any read of the Objective");
  // Declared by hand in a workflow rendered with none.
  assert.deepEqual((await runStep({ labels: ["factory:objective"], rendered: "" })).outputs, { account: "" });
  // The same accounts written otherwise still match.
  assert.deepEqual((await runStep({ labels: ["factory:objective"], rendered: '{"codex":["codex-2"],"claude":["claude","claude-2"]}' })).outputs, { account: "claude" });
  const applied = [];
  await withGitHub({ labels: ["factory:objective"] }, () => accountGate({ repo: REPO, issue: 8, harness: "claude", labels: ["factory:objective"], env: { FACTORY_ACCOUNTS: more, FACTORY_STAGE_ACCOUNT: "" }, opts: { token: "t" }, apply: async (_r, e) => applied.push(e), stage: "work" }));
  assert.match(applied[0].reason, /declares accounts \(FACTORY_ACCOUNTS\), but its workflow was not rendered for them/);
  assert.match(applied[0].fix, /Re-render the workflow .* after every change to FACTORY_ACCOUNTS/);
  // Doctor: the re-render it needs, and the exposure of a workflow that reads secrets by a computed name (v0.9.33's).
  const text = rendered({ accounts: ACCOUNTS }).replace(`FACTORY_ACCOUNTS: '${ACCOUNTS}'`, `FACTORY_ACCOUNTS: '${more}'`);
  const [, accounts] = workflowSecretChecks(text);
  assert.equal(accounts.status, "FAIL");
  assert.match(accounts.detail, /do not name ANTHROPIC_API_KEY_CLAUDE_3, CLAUDE_CODE_OAUTH_TOKEN_CLAUDE_3/);
  assert.match(accounts.fix, /re-render the workflow/);
  const removed = rendered({ accounts: ACCOUNTS }).replace(`  FACTORY_ACCOUNTS: '${ACCOUNTS}'\n`, "");
  assert.match(workflowSecretChecks(removed).find((c) => c.name === "workflow accounts").detail, /FACTORY_ACCOUNTS declares none, but the workflow's jobs were rendered for/);
  const handAdded = rendered({}).replace(/^env:\n/m, `env:\n  FACTORY_ACCOUNTS: '${ACCOUNTS}'\n`);
  assert.equal(workflowSecretChecks(handAdded).find((c) => c.name === "workflow accounts").status, "FAIL");
  assert.equal(workflowSecretChecks(rendered({ accounts: ACCOUNTS })).find((c) => c.name === "workflow accounts").status, "PASS");
  assert.equal(workflowSecretChecks(rendered({})).find((c) => c.name === "workflow accounts"), undefined, "none declared or rendered: no row");
  const exposed = rendered({}).replace("${{ secrets.ANTHROPIC_API_KEY }}", "${{ secrets[format('ANTHROPIC_API_KEY{0}', steps.account.outputs.suffix_claude)] }}");
  const [fail] = workflowSecretChecks(exposed);
  assert.equal(fail.status, "FAIL");
  assert.match(fail.detail, /^1 expression\(s\) read secrets by a computed name or whole .*every repository and organization secret/);
  assert.equal(workflowSecretChecks(rendered({}).replace("${{ secrets.ANTHROPIC_API_KEY }}", "${{ toJSON(secrets) }}"))[0].status, "FAIL", "the whole context");
  assert.equal(workflowSecretChecks(rendered({}).replace("${{ secrets.ANTHROPIC_API_KEY }}", "${{ secrets['ANTHROPIC_API_KEY'] }}"))[0].status, "FAIL", "any index, even a fixed one");
});

test("the stage runs only on the account it was prepared with: a changed or unusable pin Blocks before any harness; none declared is today's route (#267)", async () => {
  const gate = async (labels, env, by = {}) => {
    const applied = [];
    const r = await withGitHub({ labels, by }, () => accountGate({ repo: REPO, issue: 8, harness: "claude", labels, env, opts: { token: "t" }, apply: async (_repo, e) => applied.push(e), stage: "work" }));
    return { r, applied };
  };
  const pin = ["factory:objective", "factory:account:claude-2"];
  const ok = await gate(pin, { FACTORY_ACCOUNTS: ACCOUNTS, FACTORY_STAGE_ACCOUNT: "claude-2" });
  assert.deepEqual(ok.r, { ok: true, account: "claude-2", note: "", pinned: true });
  assert.deepEqual(ok.applied, []);
  const moved = await gate(pin, { FACTORY_ACCOUNTS: ACCOUNTS, FACTORY_STAGE_ACCOUNT: "claude" });
  assert.equal(moved.r.ok, false);
  assert.match(moved.applied[0].reason, /prepared with account `claude`'s credential, but the Objective's labels now pick `claude-2`/);
  assert.deepEqual([moved.applied[0].exit, moved.applied[0].cause], ["blocked", "setup"]);
  const old = await gate(["factory:objective"], { FACTORY_ACCOUNTS: ACCOUNTS, FACTORY_STAGE_ACCOUNT: "" });
  assert.match(old.applied[0].reason, /its workflow was not rendered for them/);
  assert.match(old.applied[0].fix, /Re-render the workflow/);
  const stranger = await gate(pin, { FACTORY_ACCOUNTS: ACCOUNTS, FACTORY_STAGE_ACCOUNT: "" }, { "factory:account:claude-2": "stranger" });
  assert.match(stranger.applied[0].reason, /`factory:account:claude-2` was applied by `stranger`, who cannot push/);
  // The step ran and picked none: named so, not as a workflow with no account step.
  const none = await gate(pin, { FACTORY_ACCOUNTS: ACCOUNTS, FACTORY_STAGE_ACCOUNT: NO_ACCOUNT });
  assert.match(none.applied[0].reason, /the job's account step picked no account/);
  assert.doesNotMatch(none.applied[0].reason, /not rendered/);
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

test("two account labels never Block on these routes: a review takes its label off and waits, the dispatcher puts it back once one is left, and a work stage goes back to Queued (#267)", async () => {
  const { setSelf } = await import("../scripts/lib/logic.mjs");
  const { accountWaitOf, accountWaitResume } = await import("../scripts/lib/account-wait.mjs");
  setSelf("factory-test[bot]");
  const two = ["factory:objective", "factory:in-review", "factory:account:claude", "factory:account:claude-2"];
  const env = { FACTORY_ACCOUNTS: ACCOUNTS, FACTORY_STAGE_ACCOUNT: "claude" };
  await withGitHub({ labels: two }, async (_reads, st) => {
    const applied = [];
    const r = await accountGate({ repo: REPO, issue: 8, harness: "claude", labels: two, env, pr: { number: 9 }, opts: { token: "t" }, apply: async (_r, e) => applied.push(e), stage: "review" });
    assert.equal(r.ok, false);
    assert.match(r.wait, /both pin this Objective to an account.*the review waits for one to be left/);
    assert.deepEqual(applied, [], "no Block");
    assert.ok(!st.pr.has("factory:review"), "the review label is off");
    const wait = accountWaitOf(st.comments, 8);
    assert.ok(wait, "the wait is recorded on the PR, as Factory's own comment");
    // Still two: the dispatcher leaves it waiting.
    assert.equal(await accountWaitResume({ repo: REPO, pr: 9, wait, labels: [...st.issue], opts: { token: "t" } }), "waiting");
    assert.ok(!st.pr.has("factory:review"));
    // One left: the label goes back and the record goes.
    st.issue.delete("factory:account:claude");
    assert.equal(await accountWaitResume({ repo: REPO, pr: 9, wait, labels: [...st.issue], labelledAt: "2026-01-01T00:00:00Z", opts: { token: "t" } }), "resumed");
    assert.ok(st.pr.has("factory:review"));
    assert.equal(accountWaitOf(st.comments, 8), null);
    // A pasted marker by anyone else is no record.
    assert.equal(accountWaitOf([{ id: 1, user: { login: "stranger", type: "User" }, body: "<!-- factory:8:account-wait -->" }], 8), null);
  });
  // A work stage that met them as it started: back to Queued, where the dispatcher holds it; no Block.
  await withGitHub({ labels: ["factory:objective", "factory:running", "factory:account:claude", "factory:account:claude-2"] }, async (_reads, st) => {
    const applied = [];
    const r = await accountGate({ repo: REPO, issue: 8, harness: "claude", labels: [...st.issue], env, opts: { token: "t" }, apply: async (_r, e) => applied.push(e), stage: "work" });
    assert.match(r.wait, /back to Queued until one is left/);
    assert.deepEqual(applied, []);
    assert.ok(!st.issue.has("factory:running"));
  });
  for (const script of ["worker.mjs", "review.mjs"]) {
    const src = readFileSync(join(ROOT, "plugin", "scripts", script), "utf8");
    assert.match(src, new RegExp(`if \\(acct\\.wait\\) \\{\\n\\s+log\\(acct\\.wait\\);\\n\\s+await finish\\("${script === "worker.mjs" ? "skipped" : "waiting"}", acct\\.wait\\);`), `${script}: the wait ends the stage, with no Block`);
  }
});

test("on an account, a missing or unusable credential is named as that account's secret on every harness, and only the step's input counts (#267)", async () => {
  const on = (account) => ({ GITHUB_ACTIONS: "true", FACTORY_ACCOUNTS: JSON.stringify({ claude: ["claude", "claude-2"], codex: ["codex", "codex-2"], copilot: ["copilot", "copilot-2"] }), FACTORY_STAGE_ACCOUNT: account });
  // A job-level variable of the default account's, and federation, never stand in for the account's own input.
  const dflt = { ANTHROPIC_API_KEY: "fake-default", CLAUDE_CODE_OAUTH_TOKEN: "fake-default-plan", CODEX_API_KEY: "sk-fake-default", COPILOT_GITHUB_TOKEN: "github_pat_default", ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.test" };
  await assert.rejects(credentialEnv({ harness: "claude", credential: "api", inputs: { anthropicOidcExchangeUrl: "https://x.test" }, env: { ...on("claude-2"), ...dflt } }), /set ANTHROPIC_API_KEY_CLAUDE_2 \(or CLAUDE_CODE_OAUTH_TOKEN_CLAUDE_2 with credential: plan\)$/);
  await assert.rejects(credentialEnv({ harness: "claude", credential: "plan", inputs: {}, env: { ...on("claude-2"), ...dflt } }), /CLAUDE_CODE_OAUTH_TOKEN_CLAUDE_2/);
  await assert.rejects(credentialEnv({ harness: "codex", credential: "api", inputs: {}, env: { ...on("codex-2"), ...dflt } }), /CODEX_API_KEY_CODEX_2 \(or FACTORY_CODEX_GATEWAY_KEY_CODEX_2\)/);
  await assert.rejects(credentialEnv({ harness: "copilot", credential: "api", inputs: {}, env: { ...on("copilot-2"), ...dflt } }), /COPILOT_GITHUB_TOKEN_COPILOT_2/);
  assert.deepEqual((await credentialEnv({ harness: "claude", credential: "plan", inputs: { claudeCodeOauthToken: "fake-claude-2-plan" }, env: { ...on("claude-2"), ...dflt, FACTORY_INPUT_CLAUDE_CODE_OAUTH_TOKEN: "fake-claude-2-plan" } })).env, { CLAUDE_CODE_OAUTH_TOKEN: "fake-claude-2-plan" });
  // The env block's FACTORY_<NAME> (a job-level variable resolveInputs falls back to) never stands in for the step's input.
  const { resolveInputs } = await import("../scripts/lib/inputs.mjs");
  const { routeInputs } = await import("../scripts/lib/accounts.mjs");
  const gw = { ...on("codex-2"), FACTORY_CODEX_GATEWAY_KEY: "vck_fake_default_gateway", FACTORY_INPUT_CODEX_API_KEY: "sk-fake-codex-2", FACTORY_HARNESS: "codex" };
  const gwInputs = routeInputs(resolveInputs({ args: {}, env: gw }), gw);
  assert.equal(gwInputs.codexGatewayKey, "", "a job-level gateway key does not beat the account's own key");
  assert.deepEqual((await credentialEnv({ harness: "codex", credential: "api", inputs: resolveInputs({ args: {}, env: gw }), env: gw })).env, { CODEX_API_KEY: "sk-fake-codex-2" });
  const dfltKey = { ...on("claude-2"), FACTORY_ANTHROPIC_API_KEY: "fake-default-in-env-block" };
  assert.equal(resolveInputs({ args: {}, env: dfltKey }).anthropicApiKey, "fake-default-in-env-block", "resolveInputs alone would take it");
  await assert.rejects(credentialEnv({ harness: "claude", credential: "api", inputs: resolveInputs({ args: {}, env: dfltKey }), env: dfltKey }), /ANTHROPIC_API_KEY_CLAUDE_2/, "the account's secret missing: it Blocks, never runs on the default's");
  const blocked = (await credentialChecks({ inputs: resolveInputs({ args: {}, env: dfltKey }), env: dfltKey, local: false })).filter((c) => c.status === "FAIL");
  assert.match(blocked[0].fix, /ANTHROPIC_API_KEY_CLAUDE_2/);
  // Doctor still names a job-level gateway key on an account, and its PASS row says what is there, unrenamed.
  const gwChecks = await credentialChecks({ inputs: { ...resolveInputs({ args: {}, env: gw }), model: "gpt-6.1-sol" }, env: gw, local: false });
  assert.ok(gwChecks.some((c) => c.status === "WARN" && /FACTORY_CODEX_GATEWAY_KEY is a job-level variable, which a stage on account `codex-2` never uses/.test(c.detail)));
  assert.ok(gwChecks.some((c) => c.status === "PASS" && c.detail === "CODEX_API_KEY present, step-scoped"), "a PASS row is not renamed");
  // The account named after its harness: today's names, still its own input alone.
  await assert.rejects(credentialEnv({ harness: "codex", credential: "api", inputs: {}, env: { ...on("codex"), ...dflt } }), /set CODEX_API_KEY \(or FACTORY_CODEX_GATEWAY_KEY\)/);
  // No accounts declared: today's fallbacks.
  assert.deepEqual((await credentialEnv({ harness: "claude", credential: "api", inputs: {}, env: { GITHUB_ACTIONS: "true", ANTHROPIC_API_KEY: "fake-default" } })).env, { ANTHROPIC_API_KEY: "fake-default" });
  // Doctor's lines (the job checks, the review stage's credential check) name the account's secret too.
  const fails = async (harness, credential, account) => (await credentialChecks({ inputs: { harness, credential, model: "gpt-6.1-sol" }, env: { ...on(account), ...dflt }, local: false })).filter((c) => c.status === "FAIL");
  const [plan] = await fails("claude", "plan", "claude-2");
  assert.match(plan.fix, /gh secret set CLAUDE_CODE_OAUTH_TOKEN_CLAUDE_2/);
  assert.doesNotMatch(`${plan.detail} ${plan.fix}`, /CLAUDE_CODE_OAUTH_TOKEN(?!_CLAUDE_2)/);
  const [api] = await fails("claude", "api", "claude-2");
  assert.match(api.fix, /gh secret set ANTHROPIC_API_KEY_CLAUDE_2/);
  assert.doesNotMatch(api.fix, /id-token/, "an account takes no federation");
  const [codex] = await fails("codex", "api", "codex-2");
  assert.match(codex.fix, /FACTORY_CODEX_GATEWAY_KEY_CODEX_2 .* or CODEX_API_KEY_CODEX_2/);
  const [copilot] = await fails("copilot", "api", "copilot-2");
  assert.match(copilot.fix, /gh secret set COPILOT_GITHUB_TOKEN_COPILOT_2/);
});

test("the launcher refuses a ChatGPT-login Codex credential before any sandbox is started (#267)", async () => {
  const { refusedCredential } = await import("../scripts/launch.mjs");
  const jwt = `${Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url")}.${Buffer.from("{}").toString("base64url")}.c2ln`;
  assert.match(refusedCredential({ harness: "codex", codexApiKey: jwt }).reason, /ChatGPT login/);
  assert.match(refusedCredential({ harness: "codex", codexGatewayKey: '{"tokens":{}}' }).reason, /ChatGPT login/);
  assert.equal(refusedCredential({ harness: "codex", codexApiKey: "sk-proj-fake" }), null);
  assert.equal(refusedCredential({ harness: "claude", claudeCodeOauthToken: jwt }), null, "only Codex logins are refused");
  // Checked beside the missing credential, before the claim and any sandbox call.
  const src = readFileSync(join(ROOT, "plugin", "scripts", "launch.mjs"), "utf8");
  const check = src.indexOf("missingCredential(inputs, acct.account) || refusedCredential(inputs)");
  assert.ok(check > 0 && check < src.indexOf("const claim = randomBytes(6)"), "before the claim and the sandbox");
});

test("a narrowed App token that would hold none of the asked permissions is not minted (#267)", async () => {
  const { mintInstallationToken } = await import("../scripts/lib/app-token.mjs");
  await withGitHub({}, async (_r, st) => {
    await assert.rejects(mintInstallationToken({ appId: "12", privateKey: KEY, owner: "acme", repo: "app", narrowTo: { checks: "read" } }), /grants none of checks/);
    assert.deepEqual(st.minted, [], "no token asked for");
  });
});

test("the dispatcher's tick puts a waiting review's label back once one account label is left, and not before (#267)", async () => {
  const { dispatch } = await import("../scripts/dispatch.mjs");
  const { setSelf } = await import("../scripts/lib/logic.mjs");
  const run = async (labels) => {
    setSelf("factory-test[bot]");
    const issue = { number: 8, state: "open", labels: labels.map((name) => ({ name })), body: "", updated_at: new Date().toISOString(), user: { login: "kirk" } };
    const pr = { number: 9, state: "open", draft: false, labels: [], head: { ref: "factory/8", sha: "abc1234" }, base: { ref: "main" }, mergeable: true, mergeable_state: "clean" };
    const comments = [{ id: 77, user: { login: "factory-test[bot]", type: "Bot" }, body: "<!-- factory:8:account-wait -->\nFactory: waiting", created_at: new Date().toISOString() }];
    const writes = [];
    const real = globalThis.fetch;
    const saved = process.env.FACTORY_ACCOUNTS;
    process.env.FACTORY_ACCOUNTS = ACCOUNTS;
    globalThis.fetch = async (url, init = {}) => {
      const u = new URL(url);
      const method = init.method || "GET";
      const p = u.pathname;
      const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
      if (method !== "GET" && !p.endsWith("/graphql")) writes.push(`${method} ${p}`);
      if (p.endsWith("/graphql")) return json({ data: { viewer: { login: "factory-test[bot]" }, repository: null } });
      if (p === "/user") return json({ login: "kirk", type: "User" });
      if (p === "/repos/acme/app/issues") return json(u.searchParams.get("state") === "closed" ? [] : [issue]);
      if (p === "/repos/acme/app/pulls") return json(u.searchParams.get("head") === "acme:factory/8" ? [pr] : []);
      if (p === "/repos/acme/app/pulls/9") return json(pr);
      if (p === "/repos/acme/app/issues/9/comments" && method === "GET") return json(comments);
      if (/\/actions\/workflows\/[^/]+\/runs$/.test(p)) return json({ workflow_runs: [] });
      if (/\/(timeline|comments|collaborators|reviews|commits|check-runs|status)$/.test(p)) return json([]);
      if (method !== "GET") return method === "DELETE" ? new Response(null, { status: 204 }) : json({}, 200);
      return json({ message: "Not Found" }, 404);
    };
    try {
      const r = await dispatch({ repo: "acme/app", objectiveLabel: "factory:objective", maxConcurrent: 5, dailyUsd: 0, ciChecks: [], timeoutMinutes: 60 }, { token: "t" });
      return { r, writes };
    } finally {
      globalThis.fetch = real;
      if (saved === undefined) delete process.env.FACTORY_ACCOUNTS;
      else process.env.FACTORY_ACCOUNTS = saved;
    }
  };
  const still = await run(["factory:objective", "factory:in-review", "factory:account:claude", "factory:account:claude-2"]);
  assert.deepEqual(still.r.accountResumed, []);
  assert.ok(!still.writes.some((w) => w === "POST /repos/acme/app/issues/9/labels"), "two left: the label stays off");
  const one = await run(["factory:objective", "factory:in-review", "factory:account:claude-2"]);
  assert.deepEqual(one.r.accountResumed, [8]);
  assert.ok(one.writes.includes("POST /repos/acme/app/issues/9/labels"), "the review label goes back on");
  assert.ok(one.writes.includes("DELETE /repos/acme/app/issues/comments/77"), "the wait record goes");
});

test("with no account label on, the pin is the pusher's newest still standing, a replaced one never back; a non-pusher neither moves nor wedges it, and the stage reads no timeline when the step prepared the default (#267)", async () => {
  const { trustedRoutePin } = await import("../scripts/lib/objective-trust.mjs");
  const ev = (event, name, login, min) => ({ event, label: { name }, created_at: new Date(Date.UTC(2026, 10, 15, 1, min)).toISOString(), actor: { login, type: "User", id: login === "kirk" ? 7 : 9 } });
  // A is not the default account, so a pin kept is told apart from the default.
  const A = "factory:account:claude-2";
  const B = "factory:account:claude";
  const pinOf = (events) => withGitHub({ labels: [], events }, () => trustedRoutePin(REPO, 8, { token: "t" }));
  // (b) A pusher applies A, then B, then removes B; a stranger removes A: A.
  const kept = [ev("labeled", A, "kirk", 1), ev("labeled", B, "kirk", 2), ev("unlabeled", B, "kirk", 3), ev("unlabeled", A, "stranger", 4)];
  assert.equal(await pinOf(kept), A);
  assert.equal((await runStep({ labels: ["factory:objective"], events: kept })).outputs.account, "claude-2");
  // (a) A pusher pins A, a stranger removes it, the pusher pins B, the stranger removes B: B, never two (no wedge, no loop).
  const probed = [ev("labeled", A, "kirk", 1), ev("unlabeled", A, "stranger", 2), ev("labeled", B, "kirk", 3), ev("unlabeled", B, "stranger", 4)];
  assert.equal(await pinOf(probed), B);
  assert.equal((await runStep({ labels: ["factory:objective"], events: probed })).outputs.account, "claude");
  // (c) A pin the pusher replaced never comes back: A off by a stranger, B on and off by the pusher: the default.
  assert.equal(await pinOf([ev("labeled", A, "kirk", 1), ev("unlabeled", A, "stranger", 2), ev("labeled", B, "kirk", 3), ev("unlabeled", B, "kirk", 4)]), null);
  // (d) A and B both on by the pusher, a stranger removes both: B, the newest, not a wait.
  assert.equal(await pinOf([ev("labeled", A, "kirk", 1), ev("labeled", B, "kirk", 2), ev("unlabeled", A, "stranger", 3), ev("unlabeled", B, "stranger", 4)]), B);
  // (e) A stranger's application or removal alone changes nothing.
  assert.equal(await pinOf([ev("labeled", A, "kirk", 1), ev("labeled", B, "stranger", 2), ev("unlabeled", B, "stranger", 3), ev("unlabeled", A, "stranger", 4)]), A);
  assert.equal(await pinOf([ev("labeled", A, "stranger", 1), ev("unlabeled", A, "stranger", 2)]), null);
  assert.equal(await pinOf([ev("labeled", A, "kirk", 1), ev("unlabeled", A, "kirk", 2)]), null);
  const c = await withGitHub({ labels: ["factory:objective"], events: probed }, () => routeAccountCheck({ repo: REPO, issue: 8, harness: "claude", labels: ["factory:objective"], env: { FACTORY_ACCOUNTS: ACCOUNTS, FACTORY_STAGE_ACCOUNT: NO_ACCOUNT }, opts: { token: "t" } }));
  assert.equal(c.wait, undefined, "the history never makes it wait");
  // The step prepared the harness's default: the stage and the launcher take its answer, with no timeline read.
  const reads = await withGitHub({ labels: ["factory:objective"] }, async (r) => {
    const ok = await routeAccountCheck({ repo: REPO, issue: 8, harness: "claude", labels: ["factory:objective"], env: { FACTORY_ACCOUNTS: ACCOUNTS, FACTORY_STAGE_ACCOUNT: "claude" }, opts: { token: "t" } });
    assert.equal(ok.account, "claude");
    return r;
  });
  assert.deepEqual(reads, [], "no read at all");
});

test("a stale account-wait record resumes nothing: a review label put on since means its wait is over, and the record goes (#267)", async () => {
  const { setSelf } = await import("../scripts/lib/logic.mjs");
  const { accountWaitOf, accountWaitResume } = await import("../scripts/lib/account-wait.mjs");
  setSelf("factory-test[bot]");
  const record = { id: 41, user: { login: "factory-test[bot]", type: "Bot" }, body: "<!-- factory:8:account-wait -->\nFactory: waiting", created_at: "2026-11-15T01:00:00Z", updated_at: "2026-11-15T01:00:00Z" };
  await withGitHub({ prLabels: [], comments: [record] }, async (_r, st) => {
    const wait = accountWaitOf(st.comments, 8);
    assert.deepEqual(wait, { id: 41, at: "2026-11-15T01:00:00Z" });
    // The label went on at 02:00 (a resume whose record delete failed, or a person) and came off since, for another wait.
    assert.equal(await accountWaitResume({ repo: REPO, pr: 9, wait, labels: ["factory:objective"], labelledAt: "2026-11-15T02:00:00Z", opts: { token: "t" } }), "stale");
    assert.ok(!st.pr.has("factory:review"), "nothing resumed");
    assert.equal(accountWaitOf(st.comments, 8), null, "the stale record is gone");
  });
});

test("a work stage that meets two labels with an open PR goes back to In review, and the dispatcher sends nothing back while two are on (#267)", async () => {
  const two = ["factory:objective", "factory:running", "factory:account:claude", "factory:account:claude-2"];
  const env = { FACTORY_ACCOUNTS: ACCOUNTS, FACTORY_STAGE_ACCOUNT: "claude" };
  await withGitHub({ labels: two }, async (_reads, st) => {
    const applied = [];
    const r = await accountGate({ repo: REPO, issue: 8, harness: "claude", labels: two, env, pr: { number: 9, state: "open", draft: false }, opts: { token: "t" }, apply: async (_r, e) => applied.push(e), stage: "work" });
    assert.match(r.wait, /back to In review until one is left/);
    assert.deepEqual(applied, []);
    assert.ok(st.issue.has("factory:in-review") && !st.issue.has("factory:running"), "In review again, its PR and branch as they were");
  });
  // A draft PR (a Question or Block relabelled) is no send-back: Queued, re-run from its branch when picked.
  await withGitHub({ labels: two }, async (_reads, st) => {
    const r = await accountGate({ repo: REPO, issue: 8, harness: "claude", labels: two, env, pr: { number: 9, state: "open", draft: true }, opts: { token: "t" }, apply: async () => {}, stage: "work" });
    assert.match(r.wait, /back to Queued until one is left/);
    assert.ok(!st.issue.has("factory:in-review") && !st.issue.has("factory:running"));
  });
  // The dispatcher: an In-review PR that needs a rebase is not sent back to a work stage while two labels are on.
  const { dispatch } = await import("../scripts/dispatch.mjs");
  const { setSelf } = await import("../scripts/lib/logic.mjs");
  const tick = async (labels) => {
    setSelf("factory-test[bot]");
    const issue = { number: 8, state: "open", labels: labels.map((name) => ({ name })), body: "", updated_at: new Date().toISOString(), user: { login: "kirk" } };
    const pr = { number: 9, state: "open", draft: false, labels: [], head: { ref: "factory/8", sha: "abc1234" }, base: { ref: "main" }, mergeable: false, mergeable_state: "dirty" };
    const real = globalThis.fetch;
    const saved = process.env.FACTORY_ACCOUNTS;
    process.env.FACTORY_ACCOUNTS = ACCOUNTS;
    globalThis.fetch = async (url, init = {}) => {
      const u = new URL(url);
      const method = init.method || "GET";
      const p = u.pathname;
      const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
      if (p.endsWith("/graphql")) return json({ data: { viewer: { login: "factory-test[bot]" }, repository: null } });
      if (p === "/user") return json({ login: "kirk", type: "User" });
      if (p === "/repos/acme/app/issues") return json(u.searchParams.get("state") === "closed" ? [] : [issue]);
      if (p === "/repos/acme/app/pulls") return json(u.searchParams.get("head") === "acme:factory/8" ? [pr] : []);
      if (p === "/repos/acme/app/pulls/9") return json(pr);
      if (/\/actions\/workflows\/[^/]+\/runs$/.test(p)) return json({ workflow_runs: [] });
      if (/\/(timeline|comments|collaborators|reviews|commits|check-runs|status|rulesets)$/.test(p)) return json([]);
      if (method !== "GET") return json({}, 200);
      return json({ message: "Not Found" }, 404);
    };
    try {
      return await dispatch({ repo: "acme/app", objectiveLabel: "factory:objective", maxConcurrent: 5, dailyUsd: 0, ciChecks: [], timeoutMinutes: 60 }, { token: "t" });
    } finally {
      globalThis.fetch = real;
      if (saved === undefined) delete process.env.FACTORY_ACCOUNTS;
      else process.env.FACTORY_ACCOUNTS = saved;
    }
  };
  const held = await tick(["factory:objective", "factory:in-review", "factory:account:claude", "factory:account:claude-2"]);
  assert.deepEqual([held.sentBack, held.ready], [[], []], "two labels: no send-back");
  const sent = await tick(["factory:objective", "factory:in-review", "factory:account:claude-2"]);
  assert.deepEqual(sent.sentBack, [8], "one label: sent back as ever");
});
