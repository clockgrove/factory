#!/usr/bin/env node
// Factory doctor: the checks under "Doctor" in PLAN.md, each PASS, WARN or FAIL
// with the fix. Changes nothing.
//   node scripts/doctor.mjs --repo OWNER/NAME [--json] [--checkout DIR] [--probe] [--local]
// Runs from the plugin (`/factory doctor`) and, through jobChecks(), as the first
// step of every worker job, where a FAIL Blocks the Objective with that line.
import { platform } from "node:os";
import { pathToFileURL } from "node:url";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { APP_PERMISSIONS_TEXT, mintInstallationToken, noticeAppExtra } from "./lib/app-token.mjs";
import { PLUGIN_ROOT, installCommand } from "./lib/checkout.mjs";
import { CLI, credentialEnv, harnessCommand, hasApiCredential } from "./lib/harness.mjs";
import { COLUMNS, collaboratorPermission, findProject, getRepo, listRulesets, repoOf, rest } from "./lib/github.mjs";
import { mask, parseArgs, resolveInputs } from "./lib/inputs.mjs";
import { commandText, parseMaintainer, protectedPaths, refusalReason, selfLogin, setupFiles, unprotectedFiles } from "./lib/logic.mjs";
import { exec, onPath } from "./lib/proc.mjs";
import { backend } from "./lib/backend.mjs";
import { lfsVersion, usesLfs } from "./lib/lfs.mjs";
import { readWorkflowEnv } from "./lib/local.mjs";
import { grantsWrite, parseYaml, workflowEvents } from "./lib/yaml.mjs";
import { AGENT_HOME, AGENT_USER, agentHomeProblem, agentLauncher } from "./lib/agent.mjs";
import { parseUsage } from "./lib/usage.mjs";

const check = (name, status, detail = "", fix = "") => ({ name, status, detail, fix });
const PASS = (n, d) => check(n, "PASS", d);
const WARN = (n, d, f) => check(n, "WARN", d, f);
const FAIL = (n, d, f) => check(n, "FAIL", d, f);

/** The one-page cap for a skill (PLAN.md: each skill is at most a page); the only place the number lives. */
export const SKILL_PAGE = { lines: 60, words: 700 };

const HOSTED_CEILING = 360;
const SELF_HOSTED_CEILING = 5 * 24 * 60;

// ------------------------------------------------------------ credentials

/**
 * Claude Code off local mode (Actions, a cloud sandbox): its Bash commands, and the repository's code and dependencies
 * they run, can read its model credential. Claude Code withholds it only from commands in its own bubblewrap sandbox,
 * which those routes do not run (PLAN.md, Credentials and billing). Codex and Copilot withhold it on every route, and
 * local mode runs Claude's commands in its sandbox.
 */
export function claudeShellCheck({ harness, local }) {
  if (harness !== "claude" || local) return null;
  return WARN("claude shell credential", "on Actions and in a cloud sandbox, Claude Code's Bash commands (and the repository code and dependencies they run) can read ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN: Claude Code withholds it only inside its own bubblewrap sandbox, which these routes do not run", "accept it (docs/PLAN.md, Credentials and billing), run Claude Objectives in local mode, or use codex or copilot, which withhold their credential on every route");
}

export async function credentialChecks({ inputs, env = process.env, probe = false, local = backend(env).name === "local" }) {
  const out = [];
  const h = inputs.harness;
  if (!CLI[h]) return [FAIL("harness", `unknown harness ${h}`, "set harness to claude, codex or copilot")];
  const shell = claudeShellCheck({ harness: h, local });
  // A developer's run: the job's credential is a secret (checked by name under secrets); here the CLI's own login runs.
  const planToken = h === "claude" && (inputs.claudeCodeOauthToken || env.CLAUDE_CODE_OAUTH_TOKEN);
  const localFallback = !env.GITHUB_ACTIONS && ((inputs.credential === "api" && !hasApiCredential({ harness: h, inputs, env })) || (inputs.credential === "plan" && !planToken));
  if (inputs.credential === "login" || localFallback) {
    out.push(env.GITHUB_ACTIONS ? FAIL(`${h} credential`, "credential: login inside Actions", "use api (ANTHROPIC_API_KEY, CODEX_API_KEY or the job token) or plan on your own repository") : WARN(`${h} credential`, `the ${CLI[h].bin} CLI's own login on this machine${localFallback ? " (no API credential present; local fallback)" : ""}`, "a developer's run; unattended runs bill an API credential"));
    if (shell) out.push(shell);
    if (probe) out.push(await probeHarness({ inputs, env }));
    return out;
  }
  if (h === "claude") {
    const key = inputs.anthropicApiKey || env.ANTHROPIC_API_KEY;
    const oauth = inputs.claudeCodeOauthToken || env.CLAUDE_CODE_OAUTH_TOKEN;
    const fed = !!(env.ACTIONS_ID_TOKEN_REQUEST_URL && inputs.anthropicOidcExchangeUrl);
    if (inputs.credential === "plan") {
      if (!oauth) out.push(FAIL("claude credential", "credential: plan but CLAUDE_CODE_OAUTH_TOKEN is absent", "claude setup-token, then gh secret set CLAUDE_CODE_OAUTH_TOKEN; or credential: api"));
      else out.push(WARN("claude credential", "plan token in use", "plan limits assume ordinary individual use; use only on your own repository"));
      if (key) out.push(WARN("claude credential", "ANTHROPIC_API_KEY is also set and silently wins over the plan token", "remove one of them"));
    } else if (key) out.push(PASS("claude credential", "ANTHROPIC_API_KEY present"));
    else if (fed) out.push(PASS("claude credential", "workload identity federation configured (id-token: write, exchange URL set)"));
    else out.push(FAIL("claude credential", "no ANTHROPIC_API_KEY and no federation", "gh secret set ANTHROPIC_API_KEY, or add id-token: write and anthropic_oidc_exchange_url"));
    if (inputs.credential !== "plan" && oauth) out.push(WARN("claude credential", "CLAUDE_CODE_OAUTH_TOKEN is set on an api run", "remove it; a present API key silently wins, but a plan token must never reach unattended runs"));
    if (shell) out.push(shell);
  }
  if (h === "codex") {
    // Codex's JSONL names no model, so the worker prices tokens by the `model` input; without it the row is unmetered.
    if (!inputs.model) out.push(WARN("codex model", "no model input", "set model (for example gpt-6.1-sol) so Codex tokens are priced; the CLI's default is not reported in its output"));
    const key = inputs.codexApiKey || env.CODEX_API_KEY;
    if (!key) out.push(FAIL("codex credential", "CODEX_API_KEY absent", "gh secret set CODEX_API_KEY; the action passes it to the harness step only"));
    else if (env.CODEX_API_KEY && env.GITHUB_ACTIONS && !env.FACTORY_INPUT_CODEX_API_KEY) out.push(WARN("codex credential", "CODEX_API_KEY is a job-level variable", "pass it as the codex_api_key input so only the harness child sees it"));
    else out.push(PASS("codex credential", "CODEX_API_KEY present, step-scoped"));
  }
  if (h === "copilot") {
    const tok = inputs.copilotGithubToken || env.COPILOT_GITHUB_TOKEN;
    if (!tok) out.push(FAIL("copilot credential", "no token for Copilot", "set copilot_github_token: a fine-grained token with only the Copilot Requests permission (gh secret set COPILOT_GITHUB_TOKEN); the job's own token is never used, since it can write"));
    else out.push(await copilotWriteProbe({ repo: inputs.repo, token: tok }));
  }
  if (probe) out.push(await probeHarness({ inputs, env }));
  return out;
}

/**
 * The Copilot token must not write to the repository: Copilot runs as the harness, which holds no GitHub write access,
 * and adopters often supply a classic token. Three requests no token can complete (each body is invalid) are refused
 * with 422 where the token may write issues, pull requests or contents, and 403 or 404 where it may not. Any other
 * answer FAILs: the token is not shown to be read-only.
 */
export async function copilotWriteProbe({ repo, token }) {
  if (!repo) return FAIL("copilot token", "no repository to probe", "run doctor with --repo");
  // Each is checked for permission before its body (git/refs, for one, validates the body first: not a probe).
  const probe = (path, method = "POST") => rest(`repos/${repo}/${path}`, { token, method, body: {} }).then(() => 201, (e) => e.status || 0);
  const got = { issues: await probe("issues"), "pull requests": await probe("pulls"), contents: await probe("contents/.factory-write-probe", "PUT") };
  const writes = Object.entries(got).filter(([, st]) => st === 422 || st === 201).map(([k]) => k);
  if (writes.length) return FAIL("copilot token", `the Copilot token can write ${writes.join(", ")} in ${repo}`, "use a fine-grained token with only the Copilot Requests permission and no repository access");
  const unclear = Object.entries(got).filter(([, st]) => st !== 403 && st !== 404);
  if (unclear.length) return FAIL("copilot token", `the write probes answered ${unclear.map(([k, st]) => `${k} HTTP ${st || "nothing"}`).join(", ")}`, "check the token: it must be refused (403 or 404) on every repository write");
  return PASS("copilot token", `cannot write issues, pull requests or contents in ${repo}`);
}

/** One-call probe: the resolved model and whether usage output is present. */
export async function probeHarness({ inputs, env = process.env }) {
  const h = inputs.harness;
  const bin = await onPath(CLI[h].bin);
  if (!bin) return FAIL(`${h} cli`, `${CLI[h].bin} not on PATH`, `npm install -g ${CLI[h].pkg}`);
  let cred;
  try {
    cred = await credentialEnv({ harness: h, credential: inputs.credential, inputs, env });
  } catch (e) {
    return FAIL(`${h} probe`, e.message, "see the credential line above");
  }
  const { cmd, args, stdin } = harnessCommand({ harness: h, model: inputs.model, prompt: "Reply with the single word ok.", maxUsd: 0.5 });
  const r = await exec(cmd, args, { env: { ...env, ...cred.env }, input: stdin, timeoutMs: 180_000 });
  const rec = parseUsage(h, r.stdout, inputs.model || null, r.code ?? 1);
  if (rec.refusal) return FAIL(`${h} probe`, refusalReason(rec.refusal), "an Objective would Block on the same refusal: fix the credential's account or the model setting first");
  if (r.code !== 0 && !rec.ok) return FAIL(`${h} probe`, `exit ${r.code}: ${String(r.stderr).slice(-200).trim()}`, "check the credential and the CLI version");
  const usage = rec.usd !== null ? `$${rec.usd}` : rec.tokens.input !== null ? `${rec.tokens.input} input tokens, ${rec.basis}` : "no usage output";
  return (rec.usd !== null || rec.tokens.input !== null || h === "copilot" ? PASS : WARN)(`${h} probe`, `model ${rec.model ?? "default"}, ${usage}`, "usage output missing: update the CLI");
}

// ----------------------------------------------------------------- github

/** The secrets a job needs, by name: the App's two and the harness credential the workflow names. */
export function neededSecrets(inputs) {
  const cred = { claude: inputs.credential === "plan" ? ["CLAUDE_CODE_OAUTH_TOKEN"] : ["ANTHROPIC_API_KEY"], codex: ["CODEX_API_KEY"], copilot: ["COPILOT_GITHUB_TOKEN"] }[inputs.harness] || [];
  return ["FACTORY_APP_ID", "FACTORY_APP_PRIVATE_KEY", ...cred];
}

async function secretChecks({ inputs, repo }) {
  const names = new Set();
  try {
    for (const path of [`repos/${repo.full}/actions/secrets`, `repos/${repo.full}/actions/organization-secrets`]) {
      for (const s of (await rest(`${path}?per_page=100`, {}))?.secrets || []) names.add(s.name);
    }
  } catch (e) {
    return [WARN("secrets", `could not list secret names (${String(e.message).slice(0, 100)})`, "run doctor with a gh login that administers the repository")];
  }
  const missing = neededSecrets(inputs).filter((n) => !names.has(n));
  return [missing.length ? FAIL("secrets", `missing ${missing.join(", ")} (repository, or organization secrets visible to it)`, "add them: gh secret set NAME, or at the organization with --repos") : PASS("secrets", `${neededSecrets(inputs).join(", ")} exist; the job mints the App token`)];
}

/**
 * With a cloud sandbox and the vendor's credentials in this run: the snapshot storage now, this repository's and the
 * vendor project's, against the plan's limit when the vendor's API states one (Vercel's does not: its HTTP 402 is the
 * only sign). WARN at 80% of a stated limit. Without the credentials (a developer's run) nothing is read; the sweep job's
 * summary shows the same numbers every run.
 */
export async function sandboxStorageChecks({ inputs, repo, token = null, repoId = null }) {
  if (!inputs.sandbox || !inputs.vercelToken || !inputs.vercelTeamId || !inputs.vercelProjectId) return [];
  try {
    const { openSandbox } = await import("./lib/adapters/sandbox.mjs");
    const { storageReport, storageLine } = await import("./sweep.mjs");
    const adapter = await openSandbox(inputs.sandbox, { VERCEL_TOKEN: inputs.vercelToken, VERCEL_TEAM_ID: inputs.vercelTeamId, VERCEL_PROJECT_ID: inputs.vercelProjectId });
    const r = await storageReport(adapter, repoId ?? (await getRepo(repo, { token })).id);
    const limit = r.project?.limitBytes;
    if (Number.isFinite(limit) && limit > 0 && r.project.bytes >= 0.8 * limit) return [WARN("sandbox storage", storageLine(r), "run the sweep (workflow_dispatch with sweep: true), or raise the vendor plan")];
    return [PASS("sandbox storage", storageLine(r))];
  } catch (e) {
    return [WARN("sandbox storage", `not read (${e.code ?? e.status ?? "error"})`, "check the vendor's credentials")];
  }
}

/**
 * The App's granted permissions against the one list (app-token.mjs APP_PERMISSIONS): FAIL on a missing one, a read
 * included (checks and statuses: required checks are unreadable without them); WARN on workflows write and on anything
 * else beyond the list. Actions read is optional (cloud-sandbox logs), never extra.
 */
export function appPermissionChecks(app) {
  const out = [];
  out.push(app.missing?.length ? FAIL("app permissions", `missing ${app.missing.join(", ")}`, `edit the App's repository permissions (${APP_PERMISSIONS_TEXT}) and accept the new permissions on the installation`) : PASS("app permissions", `${app.appSlug}: ${APP_PERMISSIONS_TEXT}`));
  // Workflows write would let a branch change the workflow its own review job runs, including whom Factory trusts.
  // A warning, not a Block: an installed App with it keeps working until a person turns it off.
  if (app.extra?.some((p) => /workflow/i.test(p))) out.push(WARN("app permissions", `the App can write workflows (extra: ${app.extra.join(", ")})`, "turn the App's workflows permission off: a worker branch could change the workflow its review runs, and with it whom Factory trusts"));
  else if (app.extra?.length) out.push(WARN("app permissions", `extra permissions granted: ${app.extra.join(", ")}`, `remove them; Factory needs ${APP_PERMISSIONS_TEXT}`));
  return out;
}

export async function githubChecks({ inputs, repo, token, app, notice = false, env = process.env, job = !!env.GITHUB_ACTIONS }) {
  const out = [];
  if (!token && env.GITHUB_ACTIONS) {
    out.push(FAIL("app token", "no installation token", "set FACTORY_APP_ID and FACTORY_APP_PRIVATE_KEY secrets and pass them as app_id / app_private_key"));
    return out;
  }
  // A developer's run: the job mints the App token, so here the secrets are checked by name (the repository's and the
  // organization's visible to it), and GitHub is read with the developer's own gh login.
  if (!token) out.push(...(await secretChecks({ inputs, repo })));
  else if (app?.appSlug) {
    out.push(...appPermissionChecks(app));
  } else if (token) out.push(PASS("app token", backend().name === "local" ? "local mode's token for this repository; permissions not verified" : "FACTORY_APP_TOKEN supplied; permissions not verified"));

  // The workflow as the default branch on GitHub has it (what the next run uses), not a local copy that may be behind.
  const repoData = await getRepo(repo, { token });
  const branch = repoData.default_branch;
  const wfRead = await workflowText({ repo, branch, token, env });
  out.push(...wfRead.checks);
  const text = wfRead.text;
  // The job token: read-only on code. Visible only inside Actions, through the workflow file.
  if (text !== null) {
    const ro = /contents:\s*read/.test(text) && !/contents:\s*write/.test(text);
    out.push(ro ? PASS("job token", "contents: read in the workflow") : FAIL("job token", "the workflow grants contents: write", "set permissions: contents: read; writes go through the App"));
    // A pin older than local mode does not know factory:local, so its jobs would also run Objectives a local loop holds.
    const pin = /uses:\s*clockgrove\/factory@v(\d+)\.(\d+)\.(\d+)\b/.exec(text);
    if (pin) {
      const [maj, min, pat] = pin.slice(1).map(Number);
      const old = maj === 0 && (min < 7 || (min === 7 && pat < 14));
      out.push(old ? FAIL("factory pin", `the workflow calls clockgrove/factory@v${pin.slice(1).join(".")}, older than v0.7.14`, "pin the latest release; older Actions run Objectives labelled factory:local too") : PASS("factory pin", `clockgrove/factory@v${pin.slice(1).join(".")}`));
    }
    if (/pull_request_target|on:\s*\n\s*pull_request\s*:/.test(text) && !/factory:review/.test(text)) out.push(WARN("workflow triggers", "pull_request trigger without the factory:review label guard", "the review job must be guarded by the label the App applies"));
    out.push(mergeTickCheck(text, env, { job }));
    out.push(ownedTickCheck(text, env, { job }));
  }
  out.push(...(await workflowTokenChecks({ repo, token: inputs.githubToken || token })));

  const rulesets = await listRulesets(repo, { token });
  let queue = false;
  let checks = [];
  for (const r of rulesets) {
    if (r.target !== "branch" || r.enforcement !== "active") continue;
    const full = await rest(`repos/${repo.full}/rulesets/${r.id}`, { token }).catch(() => null);
    const inc = full?.conditions?.ref_name?.include || [];
    if (!inc.some((i) => i === `refs/heads/${branch}` || i === "~DEFAULT_BRANCH")) continue;
    for (const rule of full.rules || []) {
      if (rule.type === "merge_queue") queue = true;
      if (rule.type === "required_status_checks") checks.push(...(rule.parameters?.required_status_checks || []).map((c) => c.context));
    }
  }
  if (!queue) {
    const bp = await rest(`repos/${repo.full}/branches/${encodeURIComponent(branch)}/protection`, { token }).catch(() => null);
    if (bp?.required_status_checks?.contexts?.length) checks.push(...bp.required_status_checks.contexts);
  }
  checks = [...new Set(checks)];
  // Without the queue a single Objective still merges once its required checks are green; what is lost is the integrated
  // re-run that catches a conflict after a sibling merges, so concurrent Objectives need it (PLAN.md).
  out.push(queue ? PASS("merge queue", `on for ${branch}`) : checks.length ? WARN("merge queue", `no merge_queue rule on ${branch}; required checks gate merges, but concurrent Objectives are not re-tested on the integrated head`, "node scripts/setup.mjs --apply protection (or Settings > Rules)") : FAIL("merge queue", `no merge_queue rule on ${branch}`, "node scripts/setup.mjs --apply protection (or Settings > Rules)"));
  // Only a merge queue drops PRs: without one, the dequeued run never fires and the policy is not read.
  if (queue) out.push(...approvalPolicyCheck(await rest(`repos/${repo.full}/actions/permissions/fork-pr-contributor-approval`, { token: inputs.githubToken || token }).catch((e) => ({ error: e.status || "error" }))));
  out.push(checks.length ? PASS("required checks", checks.join(", ")) : FAIL("required checks", `none required on ${branch}`, "require the CI workflow's checks: setup --apply protection --ci-checks <names>"));
  // The merge queue squashes with the repository's defaults: the branch's commit messages would land on the default
  // branch, where a closing keyword in one closes that issue. Factory's own merge sets its message itself.
  const squash = [repoData.squash_merge_commit_title, repoData.squash_merge_commit_message];
  if (queue && ((squash[0] && squash[0] !== "PR_TITLE") || (squash[1] && !["PR_BODY", "BLANK"].includes(squash[1])))) out.push(FAIL("squash message", `squash commits default to ${squash.join(" and ")}`, "setup --apply protection sets them to the PR's title and body (Settings > General > Pull Requests > Allow squash merging: Default to pull request title and description)"));
  // Listing workflows needs `actions: read`: the job token's (workflow-template.yml), never the App's.
  const ci = await ciWorkflowTriggers(repo, { token: inputs.githubToken || token });
  if (ci.error) out.push(WARN("ci workflow", `could not list workflows (${ci.error})`, "give the job token actions: read (permissions: in the workflow), or run doctor with a gh login that can read Actions"));
  else if (!ci.found) out.push(FAIL("ci workflow", "no workflow listens on pull_request", "add a CI workflow on pull_request and merge_group; the queue needs checks on its commit"));
  else if (!ci.mergeGroup) out.push((queue ? FAIL : WARN)("ci workflow", `${ci.name} listens on pull_request but not merge_group${queue ? "" : " (needed only with a merge queue)"}`, `add "merge_group:" under on: in ${ci.path}`));
  else out.push(PASS("ci workflow", `${ci.name} on pull_request and merge_group`));
  const runner = text !== null ? runnerMatchCheck(text, ci, { commands: [inputs.setup, ...inputs.validation], checks: [...checks, ...inputs.ciChecks] }) : null;
  if (runner) out.push(runner);
  // Sandbox mode resumes a stage on workflow_run, which filters by workflow name: a name no workflow has never fires.
  const wanted = (() => {
    try {
      const w = text !== null ? parseYaml(text)?.on?.workflow_run?.workflows : null;
      return Array.isArray(w) ? w.map(String) : [];
    } catch {
      return [];
    }
  })();
  if (wanted.length) {
    const names = await rest(`repos/${repo.full}/actions/workflows?per_page=100`, { token: inputs.githubToken || token }).then((r) => (r?.workflows || []).map((w) => w.name), () => null);
    const missing = names ? wanted.filter((n) => !names.includes(n)) : [];
    if (!names) out.push(WARN("ci workflow name", "could not list workflows to check the workflow_run filter", "give the job token actions: read"));
    else out.push(missing.length ? FAIL("ci workflow name", `workflow_run waits for ${missing.join(", ")}, which no workflow is named`, "re-run setup --apply workflow --sandbox <vendor> --ci-workflow <your CI workflow's name>") : PASS("ci workflow name", `workflow_run waits for ${wanted.join(", ")}`));
  }
  if (ci.factoryParses === false) out.push(FAIL("workflow file", "GitHub cannot parse .github/workflows/factory.yml (it lists the file by its path, not its name) and runs none of it", "fix its YAML; quote a value that holds \": \", such as validation commands marked parallel:"));

  const label = await rest(`repos/${repo.full}/labels/${encodeURIComponent(inputs.objectiveLabel)}`, { token }).catch(() => null);
  out.push(label ? PASS("label", inputs.objectiveLabel) : FAIL("label", `${inputs.objectiveLabel} missing`, "setup --apply labels"));
  const project = await findProject(repo, { token }).catch(() => null);
  // A local loop's token is scoped to the one repository and usually cannot see an organisation's projects: the
  // board is then out of view, card moves are skipped, and the labels carry the state, as the dispatcher already does.
  // A local token is scoped to one repository: an organisation's board may be out of its sight with or without an error
  // (an empty list), and labels carry the state either way.
  if (!project && backend().name === "local") out.push(WARN("project board", "not visible to the local token; cards will not move and labels carry the state", "grant the token the organisation's Projects read and write permission to move cards"));
  else if (!project) out.push(FAIL("project board", "no Factory project linked to the repository", "setup --apply project"));
  else {
    const names = (project.field?.options || []).map((o) => o.name);
    const missing = COLUMNS.filter((c) => !names.includes(c));
    out.push(missing.length ? FAIL("project board", `${project.title} lacks ${missing.join(", ")}`, "setup --apply project adds the Status options") : PASS("project board", `${project.title}: ${COLUMNS.join(", ")}`));
  }
  // Maintainers are trusted by numeric id (logic.mjs setMaintainers): a bare login is trusted for nothing.
  const unpinned = inputs.maintainers.map(parseMaintainer).filter((m) => m && !m.id);
  if (unpinned.length) {
    const pins = [];
    for (const m of unpinned) {
      const u = await rest(`users/${encodeURIComponent(m.login)}`, { token }).catch(() => null);
      pins.push(u?.id ? `${u.login}#${u.id}` : `${m.login}#<id>`);
    }
    out.push(WARN("maintainers", `named without a user id, so not trusted: ${unpinned.map((m) => m.login).join(", ")}`, `write each as login#id in FACTORY_NOTIFY and FACTORY_MAINTAINERS: ${pins.join(", ")} (an id outlives a rename; a login renamed away could be registered by anyone)`));
  }
  if (inputs.notify) {
    const perm = await collaboratorPermission(repo, inputs.notify, { token });
    out.push(perm && perm !== "none" ? PASS("notify", `@${inputs.notify} has ${perm}`) : FAIL("notify", `@${inputs.notify} has no access to the repository`, "set notify to a collaborator's handle"));
  } else out.push(WARN("notify", "empty", "set notify so Blocked and Question reach a phone"));
  out.push(...noticeChecks({ inputs, notice }));
  return out;
}

/**
 * Branch code runs in CI, so CI's own token must not write: the repository's default workflow token is read-only, and no
 * workflow that runs on `pull_request`, `pull_request_target` or `merge_group` asks for contents, pull-requests, issues
 * or actions write. Each workflow is parsed (lib/yaml.mjs); one doctor cannot read, or cannot parse, FAILs. When the
 * default cannot be read with this token, every such workflow must set read-only permissions itself. Factory's own
 * workflow is the exception: it runs branch code only as the agent uid, which cannot read the job's env.
 */
export async function workflowTokenChecks({ repo, token }) {
  const out = [];
  const perms = await rest(`repos/${repo.full}/actions/permissions/workflow`, { token }).catch((e) => ({ error: e.status || e.message }));
  const defaultRead = perms?.error ? null : perms?.default_workflow_permissions === "read";
  if (perms?.error) out.push(WARN("default workflow token", `could not read the repository's default (${perms.error}; it needs admin), so every pull_request and merge_group workflow must set read-only permissions itself`, "run doctor with a gh login that administers the repository, or check Settings > Actions > Workflow permissions: read"));
  else if (!defaultRead) out.push(FAIL("default workflow token", `the default GITHUB_TOKEN can write (${perms?.default_workflow_permissions})`, "Settings > Actions > General > Workflow permissions: Read repository contents and packages permissions"));
  else out.push(PASS("default workflow token", "read-only by default"));
  let list;
  try {
    list = (await rest(`repos/${repo.full}/actions/workflows?per_page=100`, { token }))?.workflows || [];
  } catch (e) {
    return [...out, FAIL("ci token", `could not list workflows (${e.status || e.message})`, "give the job token actions: read")];
  }
  const bad = [];
  for (const w of list) {
    // Factory's own workflow; GitHub's dynamic ones (code scanning's default setup), which are no file in the repository.
    if (/(^|\/)factory\.ya?ml$/.test(w.path) || /^dynamic\//.test(w.path)) continue;
    let doc;
    try {
      doc = parseYaml(String(await rest(`repos/${repo.full}/contents/${w.path}`, { token, raw: "Accept: application/vnd.github.raw+json" })));
    } catch (e) {
      // Listed but not on the default branch (it ran from a branch once): nothing runs from it on the default branch, and
      // a branch Factory pushes cannot add one (.github/ is a protected path).
      if (e.status === 404) continue;
      bad.push(`${w.path} (${e.status ? `HTTP ${e.status}` : String(e.message).slice(0, 80)})`);
      continue;
    }
    if (!workflowEvents(doc).some((e) => ["pull_request", "pull_request_target", "merge_group"].includes(e))) continue;
    const top = grantsWrite(doc?.permissions);
    const topWrites = top === null ? defaultRead !== true : top;
    if (top === null && defaultRead !== true) bad.push(`${w.path} (no read-only permissions of its own${defaultRead === false ? "; the default can write" : ""})`);
    else if (topWrites) bad.push(`${w.path} (top-level permissions write)`);
    for (const [name, job] of Object.entries(doc?.jobs || {})) {
      const g = grantsWrite(job?.permissions);
      if (g === true) bad.push(`${w.path} job ${name} (permissions write)`);
    }
  }
  out.push(bad.length ? FAIL("ci token", `branch code would run with a token that can write: ${bad.join("; ")}`, "set permissions: contents: read (and no pull-requests, issues or actions write) on every workflow that runs on pull_request or merge_group") : PASS("ci token", "no pull_request or merge_group workflow can write"));
  return out;
}

/** A `runs-on` value as one comparable label: the literal runner, or a label list as JSON; null for an expression. */
export function runnerLabel(r) {
  if (typeof r === "string") return r.trim() && !r.includes("${{") ? r.trim() : null;
  if (Array.isArray(r) && r.length && r.every((l) => typeof l === "string" && l.trim() && !l.includes("${{"))) return JSON.stringify(r.map((l) => l.trim()));
  return null;
}

/**
 * A runnerLabel as its labels; null when it cannot be read: a label that starts with `[` but is no JSON list of labels
 * (a quoted `runs-on: "[self-hosted"`). Never throws.
 */
export function runnerLabels(label) {
  if (typeof label !== "string" || !label) return null;
  if (!label.startsWith("[")) return [label];
  try {
    const l = JSON.parse(label);
    return Array.isArray(l) && l.length && l.every((x) => typeof x === "string" && x) ? l : null;
  } catch {
    return null;
  }
}

/** GitHub's container-only runners (ubuntu-slim: one vCPU in a container, no systemd or cgroup v2 of its own). */
export function containerRunner(label) {
  return (runnerLabels(label) || []).some((l) => /^ubuntu-slim($|-)/i.test(l));
}

/**
 * Factory's runner jobs need Linux: the agent launcher wants systemd-run, or unshare with cgroup v2 (runnerChecks).
 * Linux here is GitHub's ubuntu-* images, a label that names linux, or a self-hosted label list that includes linux;
 * not a container-only runner, and not a label that cannot be read.
 */
export function linuxRunner(label) {
  const labels = runnerLabels(label);
  if (!labels || containerRunner(label)) return false;
  return labels.some((l) => /^ubuntu-/i.test(l) || /(^|[-_])linux([-_]|$)/i.test(l));
}

/** The distinct runner labels among `labels` that cannot be read (runnerLabels). */
export function unreadableRunners(labels) {
  return [...new Set(labels.filter((l) => l && !runnerLabels(l)))];
}

/** A workflow's jobs: `check` (the job's name, else its id), `runner` (runnerLabel) and the text of its `run` steps. */
export function workflowJobs(text) {
  let doc;
  try {
    doc = parseYaml(text);
  } catch {
    return [];
  }
  return Object.entries(doc?.jobs || {}).map(([id, job]) => ({
    check: typeof job?.name === "string" && !job.name.includes("${{") ? job.name : id,
    runner: runnerLabel(job?.["runs-on"]),
    commands: (Array.isArray(job?.steps) ? job.steps : []).map((s) => (typeof s?.run === "string" ? s.run : "")).filter(Boolean),
  }));
}

/**
 * The CI runner Factory's work and review jobs should use: among the CI workflow's Linux jobs, the one that runs the
 * setup command or a validation command, else a required check's job, else (when the Linux runners differ) one pinned
 * to an image version rather than a `-latest` alias, else the first. Container-only runners and labels that cannot
 * be read are not Linux jobs (linuxRunner). `ci`: ciWorkflowTriggers's result. Null when the CI has no Linux job with
 * a literal runner. `linux`: the distinct Linux runners; `job`: the job picked and why.
 */
export function ciRunner(ci, { commands = [], checks = [] } = {}) {
  const jobs = (ci?.found ? ci.jobs || [] : []).filter((j) => linuxRunner(j.runner));
  const linux = [...new Set(jobs.map((j) => j.runner))];
  if (!linux.length) return null;
  for (const c of commands.map((x) => commandText(x).trim()).filter((x) => x && x !== "none")) {
    const j = jobs.find((job) => job.commands.some((r) => r.includes(c)));
    if (j) return { runner: j.runner, linux, job: `its ${j.check} job, which runs ${c}` };
  }
  const req = jobs.find((j) => checks.some((c) => c === j.check || c.startsWith(`${j.check} (`)));
  if (req) return { runner: req.runner, linux, job: `its ${req.check} job, a required check` };
  const j = (linux.length > 1 && jobs.find((x) => !/-latest"?\]?$/.test(x.runner))) || jobs[0];
  return { runner: j.runner, linux, job: `its ${j.check} job` };
}

/**
 * Factory's runner-path jobs (work, review) run the repository's setup command, so they need the runner its CI uses:
 * `ubuntu-latest` moves to a new image under them while a pinned CI keeps passing (#2600). A warning: the owner may
 * pick another runner on purpose. It also warns on a container-only runner and on a runner label it cannot read
 * (either side). Nothing to compare in sandbox mode (no runner jobs) or when the CI has no Linux job with a literal
 * runner. `ci` is the workflow on pull_request (githubChecks): a render made with setup's
 * `--ci-workflow NAME` is compared against that workflow, not NAME. `hints`: ciRunner's.
 */
export function runnerMatchCheck(factoryText, ci, hints = {}) {
  let jobs;
  try {
    jobs = parseYaml(factoryText)?.jobs || {};
  } catch {
    return null;
  }
  const mine = [...new Set(["work", "review"].map((j) => runnerLabel(jobs[j]?.["runs-on"])).filter(Boolean))];
  if (!mine.length) return null;
  const unread = unreadableRunners([...mine, ...(ci?.found ? (ci.jobs || []).map((j) => j.runner) : [])]);
  const slim = mine.filter(containerRunner);
  const want = ciRunner(ci, hints);
  // A container runner and an unreadable label have their own clause; `off` names the other mismatches only.
  const off = want ? mine.filter((r) => r !== want.runner && !containerRunner(r) && runnerLabels(r)) : [];
  const all = want?.linux.length > 1 ? ` (its Linux jobs use ${want.linux.join(", ")})` : "";
  const fix = want ? `set runs-on of the work and review jobs to ${want.runner} (setup --apply workflow renders it by default)` : "set runs-on of the work and review jobs to a full Linux runner such as ubuntu-latest";
  const warns = [];
  if (unread.length) warns.push(`could not read the runner label ${unread.map((l) => JSON.stringify(l)).join(", ")}`);
  if (slim.length) warns.push(`work and review run on ${slim.join(", ")}, a container runner without systemd or cgroup v2, where the launcher checks fail`);
  if (off.length) warns.push(`work and review run on ${off.join(", ")}; ${ci.name} runs setup on ${want.runner}, ${want.job}${all}`);
  if (warns.length) {
    const keep = off.length && !slim.length && !unread.length ? `, or keep ${off[0]} if setup is known to pass there` : "";
    return WARN("runner", warns.join("; "), `${unread.length ? "write runs-on as one label or a YAML list of labels; " : ""}${fix}${keep}`);
  }
  return want ? PASS("runner", `work and review run on ${want.runner}, as ${ci.name} does (${want.job})`) : null;
}

/**
 * Find a workflow (other than factory.yml) with pull_request and merge_group triggers, or with `name`, the workflow of
 * that name. `jobs`: its jobs (workflowJobs).
 */
export async function ciWorkflowTriggers(repo, opts, { name = "" } = {}) {
  let list;
  try {
    list = (await rest(`repos/${repo.full}/actions/workflows?per_page=100`, opts))?.workflows || [];
  } catch (e) {
    return { found: false, error: `${e.status || ""} ${e.message.slice(0, 120)}`.trim() };
  }
  let found = null;
  // GitHub lists a workflow file it cannot parse under its path instead of its name, and runs nothing from it.
  const factory = list.find((w) => /(^|\/)factory\.ya?ml$/.test(w.path));
  const factoryParses = factory ? factory.name !== factory.path : null;
  for (const w of list) {
    if (/factory\.ya?ml$/.test(w.path) || w.state !== "active") continue;
    const named = Boolean(name) && w.name === name;
    if (name && !named) continue;
    const raw = await rest(`repos/${repo.full}/contents/${w.path}`, { ...opts, raw: "Accept: application/vnd.github.raw+json" }).catch(() => "");
    const text = String(raw || "");
    const pr = /^\s*pull_request\s*:/m.test(text) || /on:\s*\[[^\]]*pull_request/.test(text);
    const mg = /^\s*merge_group\s*:/m.test(text) || /on:\s*\[[^\]]*merge_group/.test(text);
    if (pr || named) {
      found = { found: true, name: w.name, path: w.path, mergeGroup: mg, jobs: workflowJobs(text), factoryParses };
      if (mg || named) return found;
    }
  }
  return found || { found: false, factoryParses };
}

/**
 * Whether the installed workflow carries the merge pass's event ticks (workflow-template.yml): `dequeued` among the
 * pull_request types (a queue drop), the queue-watch job (a queue commit with no check), CI finishing (workflow_run),
 * and with a sandbox the launch-tick job. A workflow rendered before them leaves a dropped or stalled PR to the cron.
 * FAIL from a person's doctor run; WARN inside a run on any route (Actions, local, sandbox), where a FAIL would Block
 * every Objective until the re-render.
 */
export function mergeTickCheck(text, env = process.env, { job = !!env.GITHUB_ACTIONS } = {}) {
  let doc = null;
  try {
    doc = parseYaml(text);
  } catch {
    return WARN("merge ticks", "the workflow file could not be parsed here", "re-run setup --apply workflow");
  }
  const on = doc?.on ?? doc?.true ?? {};
  const types = on?.pull_request?.types;
  const jobs = doc?.jobs && typeof doc.jobs === "object" ? doc.jobs : {};
  const sandbox = !!jobs["launch-gate"];
  const missing = [
    ...(Array.isArray(types) && !types.map(String).includes("dequeued") ? ["pull_request dequeued"] : []),
    ...(jobs["queue-watch"] ? [] : ["the queue-watch job"]),
    ...(on?.workflow_run ? [] : ["workflow_run"]),
    ...(sandbox && !jobs["launch-tick"] ? ["the launch-tick job"] : []),
  ];
  if (!missing.length) return PASS("merge ticks", "a queue drop, a stalled queue commit and finished CI tick the merge pass");
  return (job ? WARN : FAIL)("merge ticks", `the workflow lacks ${missing.join(", ")}: a dropped or stalled merge queue PR waits for the cron`, "re-run setup --apply workflow and commit the result");
}

/**
 * Whether the installed workflow carries the dispatcher's own ticks (workflow-template.yml): any issue closing (it may
 * block an Objective), the wake job (a stage's lease end, a quota retry, the UTC day's turn, one retry), and with a
 * sandbox the launch job's tick on its own failure. A workflow rendered before them leaves those waits to GitHub's cron,
 * which fires late or not at all. FAIL from a person's doctor run; WARN inside a run, as mergeTickCheck.
 */
export function ownedTickCheck(text, env = process.env, { job = !!env.GITHUB_ACTIONS } = {}) {
  let doc = null;
  try {
    doc = parseYaml(text);
  } catch {
    return WARN("dispatcher ticks", "the workflow file could not be parsed here", "re-run setup --apply workflow");
  }
  const on = doc?.on ?? doc?.true ?? {};
  const jobs = doc?.jobs && typeof doc.jobs === "object" ? doc.jobs : {};
  const ticks = (j) => (jobs[j]?.steps || []).some((s) => /gh workflow run factory\.yml/.test(s?.run || "") && /steps\.f\.outcome != 'success'/.test(String(s?.if || "")));
  const missing = [
    ...((on?.issues?.types || []).map(String).includes("closed") && /action == 'closed' \|\|/.test(String(jobs.dispatch?.if || "")) ? [] : ["a dispatcher tick on a closed issue"]),
    ...(jobs.wake && on?.workflow_dispatch?.inputs?.wake ? [] : ["the wake job"]),
    ...(jobs["launch-gate"] && !(ticks("launch") && ticks("launch-event")) ? ["the launch jobs' tick on a failed launch"] : []),
  ];
  if (!missing.length) return PASS("dispatcher ticks", "a closed issue, a failed launch and the waits only time ends tick the dispatcher on time");
  return (job ? WARN : FAIL)("dispatcher ticks", `the workflow lacks ${missing.join(", ")}: those waits last until GitHub's cron fires, often hours late`, "re-run setup --apply workflow and commit the result");
}

/** The approval policies under which GitHub can hold a run whose actor is the merge queue's bot (#2683: all_external_contributors did). */
const HOLDS_QUEUE_BOT = new Set(["all_external_contributors", "first_time_contributors"]);

/**
 * The repository's approval policy for outside contributors' runs (`approval_policy` of
 * actions/permissions/fork-pr-contributor-approval), against the `pull_request` `dequeued` run GitHub starts when the
 * merge queue drops a PR: its actor is github-merge-queue[bot], which a strict policy holds for approval, so that run
 * never re-enqueues anything. A WARN, not a FAIL: recovery runs from the queue-watch job's own workflow_dispatch, which
 * nothing holds. Unread (`{error}`: it needs admin) is a WARN that says so.
 */
export function approvalPolicyCheck(read) {
  const policy = read?.approval_policy;
  if (typeof policy !== "string" || !policy) return [WARN("dequeue approval", `unread (needs admin${Number.isInteger(read?.error) ? `; HTTP ${read.error}` : ""}): the approval policy for outside contributors could hold the run GitHub starts when the merge queue drops a PR`, "nothing to change: recovery runs from the queue-watch job either way; run doctor with a gh login that administers the repository to read the policy")];
  if (HOLDS_QUEUE_BOT.has(policy)) return [WARN("dequeue approval", `the approval policy for outside contributors (${policy}) can hold the run GitHub starts when the merge queue drops a PR (its actor, github-merge-queue[bot], counts as one), and a held run re-enqueues nothing`, "nothing to change: recovery runs from the queue-watch job, which watches each queued PR until it leaves and ticks the dispatcher with workflow_dispatch; keep that job (re-run setup --apply workflow if the merge ticks check names it missing)")];
  return [PASS("dequeue approval", `the approval policy for outside contributors (${policy}) does not hold the merge queue's dequeued run`)];
}

/** The running workflow's path in the repository (Actions names it), else Factory's own. */
function workflowPath(env) {
  const m = /\/(\.github\/workflows\/[^@]+)@/.exec(env.GITHUB_WORKFLOW_REF || "");
  return m ? m[1] : ".github/workflows/factory.yml";
}

/** The Factory ref a workflow calls (a release tag, or a commit shortened), or "". */
const pinOf = (text) => {
  const ref = /uses:\s*clockgrove\/factory@([\w.\-/]+)/.exec(text || "")?.[1] || "";
  return /^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 7) : ref;
};

/**
 * The workflow doctor checks: read from the default branch on GitHub, which is what the next run uses. A local copy
 * (the workspace on Actions, the developer's clone otherwise) is read only when GitHub's cannot be; outside Actions one
 * that differs from GitHub's is noted, since local mode reads its settings from it. `read` fetches a path's text at a
 * ref, for tests. Returns {text (null when there is none), checks}.
 */
export async function workflowText({ repo, branch, token, env = process.env, root = env.GITHUB_WORKSPACE || process.cwd(), read = null }) {
  const path = workflowPath(env);
  const file = join(root, path);
  const local = existsSync(file) ? readFileSync(file, "utf8") : null;
  let remote = null;
  let status = 0;
  try {
    remote = String(read ? await read(path, branch) : await rest(`repos/${repo.full}/contents/${path}?ref=${encodeURIComponent(branch)}`, { token, raw: "Accept: application/vnd.github.raw+json" }));
  } catch (e) {
    status = e.status || 0;
  }
  if (remote === null) {
    if (status === 404) return { text: null, checks: local !== null ? [WARN("workflow file", `${path} is in this copy but not on ${branch} on GitHub`, `merge it to ${branch}; runs use the default branch's workflow`)] : [] };
    return { text: local, checks: [WARN("workflow file", `${path} could not be read from ${branch} on GitHub (${status ? `HTTP ${status}` : "error"})${local !== null ? "; the checks read the local copy" : ""}`, "give the token contents: read, or run doctor with a gh login that can read the repository")] };
  }
  const checks = [];
  if (!env.GITHUB_ACTIONS && local !== null && local !== remote) {
    const [here, there] = [pinOf(local), pinOf(remote)];
    checks.push(WARN("workflow copy", `this clone's ${path} differs from ${branch} on GitHub${here !== there ? ` (it pins ${here || "no Factory ref"}, GitHub ${there || "no Factory ref"})` : ""}; the checks read GitHub's`, `pull ${branch} into this clone: local mode reads its settings from the clone's copy`));
  }
  return { text: remote, checks };
}

// ------------------------------------------------------------- repository

export async function repositoryChecks({ inputs, checkout, env = process.env, runSetup = false, local = false }) {
  const out = [];
  if (!checkout || !existsSync(join(checkout, ".git"))) return [WARN("repository", "no checkout to inspect", "run from a clone or pass --checkout")];
  const install = installCommand(checkout, inputs.install);
  out.push(install ? PASS("lockfile", install.split("||")[0].trim()) : WARN("lockfile", "no lockfile recognised", "set install: <command> or install: none"));
  const pkg = existsSync(join(checkout, "package.json")) ? JSON.parse(readFileSync(join(checkout, "package.json"), "utf8")) : null;
  for (const cmd of inputs.validation.map(commandText)) {
    // `pnpm <script>` / `pnpm run <script>` must name a package.json script; `pnpm exec|dlx|x|-r|--filter …` and
    // `env …` prefixes are not scripts and are only warned about when their binary is absent here.
    const m = /^(?:pnpm|npm|yarn)\s+(?:run\s+)?([\w:.-]+)/.exec(cmd);
    const notScript = m && /^(exec|dlx|x|test|install|i|ci|-.*)$/.test(m[1]) && !pkg?.scripts?.[m[1]];
    if (m && pkg && !notScript) {
      out.push(pkg.scripts?.[m[1]] ? PASS("validation", cmd) : FAIL("validation", `${cmd}: no script "${m[1]}" in package.json`, "fix the validation input or add the script"));
    } else {
      const bin = cmd.split(/\s+/)[0];
      const local = existsSync(join(checkout, bin));
      out.push(local || (await onPath(bin)) ? PASS("validation", cmd) : WARN("validation", `${cmd}: ${bin} not found here`, "it may exist on the runner after setup"));
    }
  }
  if (!inputs.validation.length) out.push(WARN("validation", "no validation commands", "set validation: so Factory has a feedback loop"));
  if (inputs.setup) {
    if (runSetup) {
      const r = await exec("bash", ["-eo", "pipefail", "-c", inputs.setup], { cwd: checkout, env, timeoutMs: 20 * 60_000 });
      out.push(r.code === 0 ? PASS("setup", inputs.setup) : FAIL("setup", `${inputs.setup} exited ${r.code}`, "fix the setup command"));
    } else {
      const bin = inputs.setup.split(/\s+/)[0];
      out.push(existsSync(join(checkout, bin)) || (await onPath(bin)) ? PASS("setup", `${inputs.setup} (present; run with --run-setup to execute)`) : FAIL("setup", `${bin} not found`, "fix the setup command"));
    }
  }
  // `local`: the developer's own checkout in local mode (doctor --local). A worker job's checkout in local mode is the
  // agent's clone, which local.mjs init() has already covered from the developer's checkout.
  if (local) out.push(...localDatabaseChecks({ checkout, env }));
  const list = protectedPaths(inputs.protectedAdditions);
  const absent = list.filter((p) => !existsSync(join(checkout, p.replace(/\/$/, ""))));
  out.push(absent.length ? WARN("protected paths", `absent: ${absent.join(", ")}`, "the list still applies; absent paths cannot be touched") : PASS("protected paths", list.join(", ")));
  out.push(...setupFilesCheck({ inputs, checkout, list }));
  const skillsDir = join(checkout, ".agents", "skills");
  if (existsSync(skillsDir)) {
    for (const name of readdirSync(skillsDir)) {
      const f = join(skillsDir, name, "SKILL.md");
      if (!existsSync(f)) continue;
      const text = readFileSync(f, "utf8");
      const fm = /^---\n([\s\S]*?)\n---/.exec(text);
      const okFm = fm && /^name:\s*\S/m.test(fm[1]) && /^description:\s*\S/m.test(fm[1]);
      const lines = text.split("\n").length;
      const words = text.split(/\s+/).filter(Boolean).length;
      if (!okFm) out.push(FAIL("repository skill", `${name}: frontmatter needs name and description`, `edit ${f}`));
      else if (lines > SKILL_PAGE.lines || words > SKILL_PAGE.words) out.push(WARN("repository skill", `${name}: ${lines} lines, ${words} words`, `one page per skill: at most ${SKILL_PAGE.lines} lines and ${SKILL_PAGE.words} words`));
      else out.push(PASS("repository skill", `${name} (${lines} lines)`));
    }
  }
  // Git LFS: a repository whose .gitattributes routes files through LFS needs git-lfs where the worker runs, or its
  // media would be committed as plain blobs (the commit hook refuses them) and nothing would upload on push.
  if (await usesLfs(checkout)) {
    const v = await lfsVersion(env);
    out.push(v ? PASS("git lfs", v) : FAIL("git lfs", ".gitattributes uses Git LFS and git-lfs is not installed", "install git-lfs on the runner or machine (apt-get install git-lfs; GitHub-hosted runners ship it)"));
  }
  return out;
}

/**
 * The repository files the setup command names (logic.mjs setupFiles: `scripts/ci/setup.sh`, `bash -e ./x.sh &&
 * scripts/ci/toolchain.sh`), each a file in `checkout`. Setup runs them as the runner beside the App's key on every
 * route (as root into the image every stage starts from, with a sandbox), so a worker's commit must not change them.
 */
export function setupScripts(setup, checkout) {
  return setupFiles(setup, (p) => {
    try {
      return statSync(join(checkout, p)).isFile();
    } catch {
      return false;
    }
  });
}

/**
 * Setup runs as the runner beside the App's key on every route (with sudo on Actions, as root into a sandbox's image), so
 * every repository file its command names must be a protected path: otherwise a worker's change to it, once merged, runs
 * there. FAIL, in a job too: the run Blocks before an unprotected setup runs.
 */
export function setupFilesCheck({ inputs, checkout, list = protectedPaths(inputs.protectedAdditions) }) {
  const named = setupScripts(inputs.setup, checkout);
  if (!named.length) return [];
  const bare = unprotectedFiles(named, list);
  if (bare.length) return [FAIL("setup files", `the setup command runs ${bare.join(", ")} as the runner, beside the App's key, and no protected path covers it: a worker's merged change to it would run there`, `add ${bare.map((f) => `/${f}`).join(", ")} to protected_paths (FACTORY_PROTECTED_PATHS in .github/workflows/factory.yml; a leading / protects it at the root only); setup --apply workflow adds it`)];
  return [PASS("setup files", `${named.join(", ")} protected (the files the command names; what they read, such as a Makefile or package.json script, is not)`)];
}

// ------------------------------------------------------------------ runner

export async function runnerChecks({ inputs, env = process.env }) {
  const out = [];
  const bin = await onPath(CLI[inputs.harness]?.bin || "");
  out.push(bin ? PASS("harness cli", bin) : FAIL("harness cli", `${CLI[inputs.harness]?.bin} not installed`, `the action installs ${CLI[inputs.harness]?.pkg}; on a laptop: npm install -g ${CLI[inputs.harness]?.pkg}`));
  const selfHosted = env.RUNNER_ENVIRONMENT === "self-hosted";
  const ceiling = selfHosted ? SELF_HOSTED_CEILING : HOSTED_CEILING;
  out.push(inputs.timeoutMinutes <= ceiling ? PASS("timeout", `${inputs.timeoutMinutes} min under the ${ceiling} min ceiling`) : FAIL("timeout", `${inputs.timeoutMinutes} min exceeds the ${selfHosted ? "self-hosted" : "hosted"} ceiling of ${ceiling}`, "lower timeout_minutes or move to a self-hosted runner"));
  // A sandbox vendor's session cap is not checked here: it is the vendor plan's, which only the vendor's answer at a
  // stage's start shows. The launcher fits each stage to the session granted (launch.mjs createSession).
  out.push((await onPath("gh")) ? PASS("gh", "present") : FAIL("gh", "gh not on PATH", "install the GitHub CLI"));
  // On Actions the harness runs as its own uid in a transient systemd unit (lib/agent.mjs): passwordless sudo and
  // systemd-run, which GitHub's hosted runners have.
  if (env.GITHUB_ACTIONS) {
    const s = await exec("/usr/bin/sudo", ["-n", "/usr/bin/true"], { env: { PATH: "/usr/bin:/bin" } }).catch(() => ({ code: 1 }));
    out.push(s.code === 0 ? PASS("sudo", "passwordless sudo for the agent uid") : FAIL("sudo", `sudo -n fails on this ${selfHosted ? "self-hosted " : ""}runner`, "give the runner's user passwordless sudo (Factory creates the factory-agent user and runs the harness as it)"));
    const launcher = await agentLauncher();
    out.push(launcher ? PASS("agent launcher", launcher === "systemd" ? "systemd-run (a transient unit per command)" : "unshare, setpriv and a cgroup v2 group (no systemd here)") : FAIL("agent launcher", "neither systemd-run nor unshare with a cgroup v2 hierarchy", "run on a runner with systemd, or a Linux machine with util-linux and cgroup v2"));
    const home = await agentHomeProblem();
    out.push(home ? FAIL("agent home", home, `remove that user or give it the home ${AGENT_HOME}: Factory wipes that path before each job`) : PASS("agent home", `${AGENT_USER} at ${AGENT_HOME}`));
  }
  out.push((await onPath("git")) ? PASS("git", "present") : FAIL("git", "git not on PATH", "install git"));
  return out;
}

/**
 * Local mode writes as the operator, and GitHub notifies no one of their own @mention: when that login is the notify
 * user, a Blocked or Question reaches no one unless the Factory App posts it (#2522). `notice`: an App is configured.
 */
export function noticeChecks({ inputs, notice, local = backend().name === "local", self = selfLogin() }) {
  if (!local || !inputs.notify) return [];
  if (notice) return [PASS("notices", "posted as the Factory App, so the @mention notifies")];
  if (self && self === inputs.notify.toLowerCase()) return [WARN("notices", `local notices post as @${inputs.notify}, the notify user, and GitHub notifies no one of their own @mention`, "set FACTORY_LOCAL_APP_ID and FACTORY_LOCAL_APP_KEY (the Factory App's id and the path of its private key under ~/.config/factory) so notices post as the App")];
  return [];
}

/** npm packages that are Postgres clients: a package that depends on one talks to a Postgres server. */
const PG_CLIENTS = new Set(["pg", "pg-native", "pg-promise", "postgres", "slonik"]);
/** The last path segment of a container image that runs a Postgres server. */
const PG_IMAGES = new Set(["postgres", "postgresql", "pgvector", "postgis", "timescaledb", "timescaledb-ha"]);
/** At most this many workspace package directories are read. */
const WORKSPACE_CAP = 500;

const comma = (v) => String(v || "").split(/\r?\n|,/).map((s) => s.trim()).filter(Boolean);
const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};
/** The real subdirectories of `dir` (no symlinks, no dot directories, no node_modules), by name. */
const subdirs = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".") && d.name !== "node_modules").map((d) => d.name);
  } catch {
    return [];
  }
};

/**
 * The package directories a checkout declares, relative to it: the root, and each npm or Yarn `workspaces` entry and
 * pnpm-workspace.yaml `packages` entry, with `*` matched one level and `**` any depth. A plain directory walk with no
 * git and no symlink followed; a package.json elsewhere (a test fixture, a vendored copy) is not a package of this one.
 */
export function packageDirs(checkout) {
  const root = readJson(join(checkout, "package.json"));
  const ws = root?.workspaces;
  const patterns = [...(Array.isArray(ws) ? ws : Array.isArray(ws?.packages) ? ws.packages : [])];
  if (existsSync(join(checkout, "pnpm-workspace.yaml"))) {
    try {
      const pk = parseYaml(readFileSync(join(checkout, "pnpm-workspace.yaml"), "utf8"))?.packages;
      if (Array.isArray(pk)) patterns.push(...pk);
    } catch {}
  }
  const out = new Set([""]);
  const deep = (rel, acc) => {
    acc.push(rel);
    for (const d of subdirs(join(checkout, rel))) if (acc.length < WORKSPACE_CAP) deep(rel ? `${rel}/${d}` : d, acc);
    return acc;
  };
  for (const pattern of patterns) {
    if (typeof pattern !== "string" || pattern.startsWith("!")) continue;
    let dirs = [""];
    for (const seg of pattern.replace(/^\.\//, "").split("/").filter((s) => s && s !== ".")) {
      if (seg === "..") {
        dirs = [];
        break;
      }
      const glob = new RegExp("^" + seg.replace(/[.+?^$(){}|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*") + "$");
      dirs = dirs.flatMap((rel) => (seg === "**" ? deep(rel, []) : subdirs(join(checkout, rel)).filter((d) => glob.test(d)).map((d) => (rel ? `${rel}/${d}` : d)))).slice(0, WORKSPACE_CAP);
    }
    for (const d of dirs) if (out.size < WORKSPACE_CAP) out.add(d);
  }
  return [...out];
}

/**
 * What in a checkout says its checks use a Postgres server, one phrase each. Structure only, never a command's or a
 * script's text: a package.json of the root or a declared workspace (packageDirs) that depends on a Postgres client
 * package (PG_CLIENTS), a CI job under .github/workflows (Factory's own workflow aside) with a service container whose
 * image is a Postgres server (PG_IMAGES), and FACTORY_LOCAL_DB_INIT in Factory's workflow env, which is for local
 * mode's database only. Only Node clients and CI service containers are detected. Runs on the developer's own checkout
 * only, never on an agent's clone.
 */
export function databaseSignals(checkout, wf = readWorkflowEnv(checkout)) {
  const out = [];
  for (const dir of packageDirs(checkout)) {
    const rel = dir ? `${dir}/package.json` : "package.json";
    const pkg = readJson(join(checkout, rel));
    const deps = ["dependencies", "devDependencies", "optionalDependencies"].flatMap((k) => Object.keys(pkg?.[k] || {}));
    const hit = [...new Set(deps.filter((d) => PG_CLIENTS.has(d)))];
    if (hit.length) out.push(`${rel} depends on ${hit.join(", ")}`);
  }
  let workflows = [];
  try {
    workflows = readdirSync(join(checkout, ".github", "workflows"), { withFileTypes: true }).filter((d) => d.isFile() && /\.ya?ml$/.test(d.name) && !/^factory\.ya?ml$/.test(d.name)).map((d) => d.name).sort();
  } catch {}
  for (const name of workflows) {
    const rel = `.github/workflows/${name}`;
    let doc;
    try {
      doc = parseYaml(readFileSync(join(checkout, rel), "utf8"));
    } catch {
      continue;
    }
    for (const [job, spec] of Object.entries(doc?.jobs || {})) {
      for (const [svc, s] of Object.entries(spec?.services || {})) {
        const image = typeof s === "string" ? s : s?.image;
        // registry/path/name:tag@digest: the name is the last path segment, without its tag or digest.
        const base = String(image || "").split("@")[0].split("/").pop().split(":")[0];
        if (PG_IMAGES.has(base)) out.push(`${rel} job ${job} has a ${svc} service (${base})`);
      }
    }
  }
  if (wf.FACTORY_LOCAL_DB_INIT) out.push("the workflow sets FACTORY_LOCAL_DB_INIT");
  return out;
}

/**
 * Local mode's sandboxes have no route to the machine's services, so a validation command that needs Postgres fails
 * there unless FACTORY_LOCAL_DB=1 gives it a throwaway one (#2601). WARNs when the checkout declares a Postgres server
 * (databaseSignals) and FACTORY_LOCAL_DB is off; when FACTORY_LOCAL_VALIDATION is set, the WARN names the commands it
 * still runs locally, since only the owner knows whether one of them needs the database. On macOS FACTORY_LOCAL_DB=1
 * is not supported, so it WARNs there too. `env` wins over the workflow's env block `wf`, as in the local loop. Nothing to
 * say when the checkout declares no database. For the developer's own checkout (local.mjs init, doctor --local).
 */
export function localDatabaseChecks({ checkout, env = process.env, wf = readWorkflowEnv(checkout), os = platform() }) {
  const pick = (k) => env[k] ?? wf[k];
  const darwin = os === "darwin";
  if (pick("FACTORY_LOCAL_DB") === "1") {
    if (!darwin) return [PASS("local database", "FACTORY_LOCAL_DB=1: each validation command gets a throwaway Postgres")];
    return [WARN("local database", "FACTORY_LOCAL_DB=1 is set, but it is for Linux and WSL2 only: macOS's sandbox shares the box's loopback, so a throwaway database would be reachable from outside it, and a run with it in this shell does not start", "unset FACTORY_LOCAL_DB on macOS (in this shell and the workflow env) and list only the validation commands that need no database in FACTORY_LOCAL_VALIDATION")];
  }
  const signals = databaseSignals(checkout, wf);
  if (!signals.length) return [];
  const shown = signals.length > 3 ? [...signals.slice(0, 3), `${signals.length - 3} more`] : signals;
  const uses = `this repository uses Postgres (${shown.join("; ")}) and FACTORY_LOCAL_DB is off`;
  const db = "set FACTORY_LOCAL_DB=1 (a throwaway Postgres per validation command; needs the Postgres server binaries, initdb and pg_ctl)";
  const local = comma(pick("FACTORY_LOCAL_VALIDATION")).map(commandText);
  if (local.length) {
    const fix = `confirm none of those needs Postgres, and leave out of FACTORY_LOCAL_VALIDATION any that does (the required checks run it on GitHub)${darwin ? "" : `, or ${db}`}`;
    return [WARN("local database", `${uses}; FACTORY_LOCAL_VALIDATION still runs ${local.join(", ")} locally, in sandboxes with no route to this machine's services`, fix)];
  }
  const fix = darwin ? "list only the validation commands that need no database in FACTORY_LOCAL_VALIDATION (FACTORY_LOCAL_DB=1, a throwaway Postgres per command, runs on Linux and WSL2 only)" : `${db}, or list only the commands that need no database in FACTORY_LOCAL_VALIDATION`;
  return [WARN("local database", `${uses}: local mode's sandboxes have no route to this machine's services, so a validation command that needs the database fails and the run Blocks after a fix pass`, fix)];
}

/**
 * The notice App's reach (#2522), from a notice mint, for the record: the key on this box mints whatever its
 * installation grants (Factory's own App: contents and pull requests write too), while the notice token Factory mints
 * is narrowed to issues write. Informational: using Factory's own App for local notices is a supported choice.
 */
export function noticeAppCheck(minted) {
  const extra = noticeAppExtra(minted?.installationPermissions);
  const who = `${minted?.appSlug || "the App"}[bot]`;
  return PASS("notice app", extra.length ? `${who}; the App also has ${extra.join(", ")}; the notice token is narrowed to issues write` : `${who}: issues write only`);
}

/** The checks a worker job runs before spending anything. Fast: no probe, no setup execution. */
export async function jobChecks({ inputs, repo, token, app, checkout, notice = false }) {
  const out = [];
  out.push(...(await credentialChecks({ inputs })));
  out.push(...(await githubChecks({ inputs, repo, token, app, notice, job: true })));
  out.push(...(await repositoryChecks({ inputs, checkout })));
  out.push(...(await runnerChecks({ inputs })));
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const checkout = resolve(args.checkout || process.env.GITHUB_WORKSPACE || process.cwd());
  // Outside Actions the workflow's env block is not in this process: read it from the checkout (this shell still wins).
  const inputs = resolveInputs({ args, env: process.env.GITHUB_ACTIONS ? process.env : { ...readWorkflowEnv(checkout), ...process.env } });
  if (!inputs.repo) throw new Error("--repo OWNER/NAME is required");
  const repo = repoOf(inputs.repo);
  let token = inputs.appToken || null;
  let app = null;
  if (!token && inputs.appId && inputs.appPrivateKey) {
    try {
      app = await mintInstallationToken({ appId: inputs.appId, privateKey: inputs.appPrivateKey, owner: repo.owner, repo: repo.name });
      token = app.token;
      mask(token);
    } catch (e) {
      app = { error: e.message };
    }
  }
  const results = [];
  const local = args.local === "true" || backend().name === "local";
  results.push(...(await credentialChecks({ inputs, probe: !!args.probe, local })));
  if (app?.error) results.push(FAIL("app token", app.error, "check FACTORY_APP_ID, the private key, and that the App is installed on this repository"));
  results.push(...(await githubChecks({ inputs, repo, token, app })));
  results.push(...(await sandboxStorageChecks({ inputs, repo, token })));
  results.push(...(await repositoryChecks({ inputs, checkout, runSetup: !!args.run_setup, local })));
  results.push(...(await runnerChecks({ inputs })));
  const fails = results.filter((r) => r.status === "FAIL").length;
  if (args.json) process.stdout.write(`${JSON.stringify({ ready: fails === 0, failures: fails, checks: results }, null, 2)}\n`);
  else {
    for (const r of results) process.stdout.write(`${r.status.padEnd(4)} ${r.name}: ${r.detail}${r.fix && r.status !== "PASS" ? `\n     fix: ${r.fix}` : ""}\n`);
    process.stdout.write(fails ? `\n${fails} failure(s); run node ${join(PLUGIN_ROOT, "scripts/setup.mjs")} --repo ${repo.full} --yes to apply the GitHub fixes\n` : "\nready\n");
  }
  process.exit(fails ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    process.stderr.write(`[factory] doctor failed: ${e.message}\n`);
    process.exit(2);
  });
}
