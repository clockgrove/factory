#!/usr/bin/env node
// Factory doctor: the checks under "Doctor" in PLAN.md, each PASS, WARN or FAIL
// with the fix. Changes nothing.
//   node scripts/doctor.mjs --repo OWNER/NAME [--json] [--checkout DIR] [--probe]
// Runs from the plugin (`/factory doctor`) and, through jobChecks(), as the first
// step of every worker job, where a FAIL Blocks the Objective with that line.
import { pathToFileURL } from "node:url";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { mintInstallationToken } from "./lib/app-token.mjs";
import { ACTION_ROOT, installCommand } from "./lib/checkout.mjs";
import { CLI, credentialEnv, harnessCommand, hasApiCredential } from "./lib/harness.mjs";
import { COLUMNS, collaboratorPermission, findProject, getRepo, listRulesets, repoOf, rest } from "./lib/github.mjs";
import { mask, parseArgs, resolveInputs } from "./lib/inputs.mjs";
import { protectedPaths } from "./lib/logic.mjs";
import { exec, onPath } from "./lib/proc.mjs";
import { parseUsage } from "./lib/usage.mjs";

const check = (name, status, detail = "", fix = "") => ({ name, status, detail, fix });
const PASS = (n, d) => check(n, "PASS", d);
const WARN = (n, d, f) => check(n, "WARN", d, f);
const FAIL = (n, d, f) => check(n, "FAIL", d, f);

const HOSTED_CEILING = 360;
const SELF_HOSTED_CEILING = 5 * 24 * 60;

// ------------------------------------------------------------ credentials

export async function credentialChecks({ inputs, env = process.env, probe = false }) {
  const out = [];
  const h = inputs.harness;
  if (!CLI[h]) return [FAIL("harness", `unknown harness ${h}`, "set harness to claude, codex or copilot")];
  const localFallback = !env.GITHUB_ACTIONS && inputs.credential === "api" && !hasApiCredential({ harness: h, inputs, env });
  if (inputs.credential === "login" || localFallback) {
    out.push(env.GITHUB_ACTIONS ? FAIL(`${h} credential`, "credential: login inside Actions", "use api (ANTHROPIC_API_KEY, CODEX_API_KEY or the job token) or plan on your own repository") : WARN(`${h} credential`, `the ${CLI[h].bin} CLI's own login on this machine${localFallback ? " (no API credential present; local fallback)" : ""}`, "a developer's run; unattended runs bill an API credential"));
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
  }
  if (h === "codex") {
    const key = inputs.codexApiKey || env.CODEX_API_KEY;
    if (!key) out.push(FAIL("codex credential", "CODEX_API_KEY absent", "gh secret set CODEX_API_KEY; the action passes it to the harness step only"));
    else if (env.CODEX_API_KEY && env.GITHUB_ACTIONS && !env.FACTORY_INPUT_CODEX_API_KEY) out.push(WARN("codex credential", "CODEX_API_KEY is a job-level variable", "pass it as the codex_api_key input so only the harness child sees it"));
    else out.push(PASS("codex credential", "CODEX_API_KEY present, step-scoped"));
  }
  if (h === "copilot") {
    if (env.COPILOT_GITHUB_TOKEN) out.push(PASS("copilot credential", "COPILOT_GITHUB_TOKEN present (bills the token owner's seat)"));
    else if (inputs.githubToken) {
      const r = await exec("sh", ["-c", "copilot --version"], { env: { ...env, COPILOT_GITHUB_TOKEN: inputs.githubToken } }).catch(() => ({ code: 1 }));
      out.push(r.code === 0 ? PASS("copilot credential", "job token in use; copilot-requests: write must be on the job and the org policy must allow CLI billing") : WARN("copilot credential", "copilot CLI not runnable here", "install @github/copilot on the runner"));
    } else out.push(FAIL("copilot credential", "no token for Copilot", "permissions: copilot-requests: write on the worker job"));
  }
  if (probe) out.push(await probeHarness({ inputs, env }));
  return out;
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
  if (r.code !== 0 && !rec.ok) return FAIL(`${h} probe`, `exit ${r.code}: ${String(r.stderr).slice(-200).trim()}`, "check the credential and the CLI version");
  const usage = rec.usd !== null ? `$${rec.usd}` : rec.tokens.input !== null ? `${rec.tokens.input} input tokens, ${rec.basis}` : "no usage output";
  return (rec.usd !== null || rec.tokens.input !== null || h === "copilot" ? PASS : WARN)(`${h} probe`, `model ${rec.model ?? "default"}, ${usage}`, "usage output missing: update the CLI");
}

// ----------------------------------------------------------------- github

export async function githubChecks({ inputs, repo, token, app, env = process.env }) {
  const out = [];
  if (!token) {
    out.push(FAIL("app token", "no installation token", "set FACTORY_APP_ID and FACTORY_APP_PRIVATE_KEY secrets and pass them as app_id / app_private_key"));
    return out;
  }
  if (app?.appSlug) {
    out.push(app.missing?.length ? FAIL("app permissions", `missing ${app.missing.join(", ")}`, `edit the App's repository permissions (contents, pull requests, issues, projects: write) and accept the new permissions on the installation`) : PASS("app permissions", `${app.appSlug}: contents, pull requests, issues, projects`));
    if (app.extra?.length) out.push(WARN("app permissions", `extra permissions granted: ${app.extra.join(", ")}`, "remove them; Factory needs four, and workflows must stay off"));
  } else out.push(PASS("app token", "FACTORY_APP_TOKEN supplied; permissions not verified"));

  // The job token: read-only on code. Visible only inside Actions, through the workflow file.
  const wf = findWorkflow(inputs, env);
  if (wf) {
    const text = readFileSync(wf, "utf8");
    const ro = /contents:\s*read/.test(text) && !/contents:\s*write/.test(text);
    out.push(ro ? PASS("job token", "contents: read in the workflow") : FAIL("job token", "the workflow grants contents: write", "set permissions: contents: read; writes go through the App"));
    if (/pull_request_target|on:\s*\n\s*pull_request\s*:/.test(text) && !/factory:review/.test(text)) out.push(WARN("workflow triggers", "pull_request trigger without the factory:review label guard", "the review job must be guarded by the label the App applies"));
  }

  const repoData = await getRepo(repo, { token });
  const branch = repoData.default_branch;
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
  // Without the queue a single Objective still merges on CI plus auto-merge; what is lost is the integrated
  // re-run that catches a conflict after a sibling merges, so concurrent Objectives need it (PLAN.md).
  out.push(queue ? PASS("merge queue", `on for ${branch}`) : checks.length ? WARN("merge queue", `no merge_queue rule on ${branch}; required checks gate merges, but concurrent Objectives are not re-tested on the integrated head`, "node scripts/setup.mjs --apply protection (or Settings > Rules)") : FAIL("merge queue", `no merge_queue rule on ${branch}`, "node scripts/setup.mjs --apply protection (or Settings > Rules)"));
  out.push(checks.length ? PASS("required checks", checks.join(", ")) : FAIL("required checks", `none required on ${branch}`, "require the CI workflow's checks: setup --apply protection --ci-checks <names>"));
  if (!repoData.allow_auto_merge && inputs.autoMerge) out.push(FAIL("auto-merge", "repository setting Allow auto-merge is off", "setup --apply protection turns it on, or Settings > General"));
  // Listing workflows needs `actions: read`: the job token's (workflow-template.yml), never the App's.
  const ci = await ciWorkflowTriggers(repo, { token: inputs.githubToken || token });
  if (ci.error) out.push(WARN("ci workflow", `could not list workflows (${ci.error})`, "give the job token actions: read (permissions: in the workflow), or run doctor with a gh login that can read Actions"));
  else if (!ci.found) out.push(FAIL("ci workflow", "no workflow listens on pull_request", "add a CI workflow on pull_request and merge_group; the queue needs checks on its commit"));
  else if (!ci.mergeGroup) out.push(FAIL("ci workflow", `${ci.name} listens on pull_request but not merge_group`, `add "merge_group:" under on: in ${ci.path}`));
  else out.push(PASS("ci workflow", `${ci.name} on pull_request and merge_group`));

  const label = await rest(`repos/${repo.full}/labels/${encodeURIComponent(inputs.objectiveLabel)}`, { token }).catch(() => null);
  out.push(label ? PASS("label", inputs.objectiveLabel) : FAIL("label", `${inputs.objectiveLabel} missing`, "setup --apply labels"));
  const project = await findProject(repo, { token }).catch(() => null);
  if (!project) out.push(FAIL("project board", "no Factory project linked to the repository", "setup --apply project"));
  else {
    const names = (project.field?.options || []).map((o) => o.name);
    const missing = COLUMNS.filter((c) => !names.includes(c));
    out.push(missing.length ? FAIL("project board", `${project.title} lacks ${missing.join(", ")}`, "setup --apply project adds the Status options") : PASS("project board", `${project.title}: ${COLUMNS.join(", ")}`));
  }
  if (inputs.notify) {
    const perm = await collaboratorPermission(repo, inputs.notify, { token });
    out.push(perm && perm !== "none" ? PASS("notify", `@${inputs.notify} has ${perm}`) : FAIL("notify", `@${inputs.notify} has no access to the repository`, "set notify to a collaborator's handle"));
  } else out.push(WARN("notify", "empty", "set notify so Blocked and Question reach a phone"));
  return out;
}

/** Find a workflow (other than factory.yml) with pull_request and merge_group triggers. */
async function ciWorkflowTriggers(repo, opts) {
  let list;
  try {
    list = (await rest(`repos/${repo.full}/actions/workflows?per_page=100`, opts))?.workflows || [];
  } catch (e) {
    return { found: false, error: `${e.status || ""} ${e.message.slice(0, 120)}`.trim() };
  }
  let found = null;
  for (const w of list) {
    if (/factory\.ya?ml$/.test(w.path) || w.state !== "active") continue;
    const raw = await rest(`repos/${repo.full}/contents/${w.path}`, { ...opts, raw: "Accept: application/vnd.github.raw+json" }).catch(() => "");
    const text = String(raw || "");
    const pr = /^\s*pull_request\s*:/m.test(text) || /on:\s*\[[^\]]*pull_request/.test(text);
    const mg = /^\s*merge_group\s*:/m.test(text) || /on:\s*\[[^\]]*merge_group/.test(text);
    if (pr) {
      found = { found: true, name: w.name, path: w.path, mergeGroup: mg };
      if (mg) return found;
    }
  }
  return found || { found: false };
}

function findWorkflow(inputs, env) {
  const root = env.GITHUB_WORKSPACE || process.cwd();
  const ref = env.GITHUB_WORKFLOW_REF;
  if (ref) {
    const m = /\/(\.github\/workflows\/[^@]+)@/.exec(ref);
    if (m && existsSync(join(root, m[1]))) return join(root, m[1]);
  }
  const f = join(root, ".github", "workflows", "factory.yml");
  return existsSync(f) ? f : null;
}

// ------------------------------------------------------------- repository

export async function repositoryChecks({ inputs, checkout, env = process.env, runSetup = false }) {
  const out = [];
  if (!checkout || !existsSync(join(checkout, ".git"))) return [WARN("repository", "no checkout to inspect", "run from a clone or pass --checkout")];
  const install = installCommand(checkout, inputs.install);
  out.push(install ? PASS("lockfile", install.split("||")[0].trim()) : WARN("lockfile", "no lockfile recognised", "set install: <command> or install: none"));
  const pkg = existsSync(join(checkout, "package.json")) ? JSON.parse(readFileSync(join(checkout, "package.json"), "utf8")) : null;
  for (const cmd of inputs.validation) {
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
  const list = protectedPaths(inputs.protectedAdditions);
  const absent = list.filter((p) => !existsSync(join(checkout, p.replace(/\/$/, ""))));
  out.push(absent.length ? WARN("protected paths", `absent: ${absent.join(", ")}`, "the list still applies; absent paths cannot be touched") : PASS("protected paths", list.join(", ")));
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
      else if (lines > 80 || words > 800) out.push(WARN("repository skill", `${name}: ${lines} lines, ${words} words`, "one page per skill"));
      else out.push(PASS("repository skill", `${name} (${lines} lines)`));
    }
  }
  return out;
}

// ------------------------------------------------------------------ runner

export async function runnerChecks({ inputs, env = process.env }) {
  const out = [];
  const bin = await onPath(CLI[inputs.harness]?.bin || "");
  out.push(bin ? PASS("harness cli", bin) : FAIL("harness cli", `${CLI[inputs.harness]?.bin} not installed`, `the action installs ${CLI[inputs.harness]?.pkg}; on a laptop: npm install -g ${CLI[inputs.harness]?.pkg}`));
  const selfHosted = env.RUNNER_ENVIRONMENT === "self-hosted";
  const ceiling = selfHosted ? SELF_HOSTED_CEILING : HOSTED_CEILING;
  out.push(inputs.timeoutMinutes <= ceiling ? PASS("timeout", `${inputs.timeoutMinutes} min under the ${ceiling} min ceiling`) : FAIL("timeout", `${inputs.timeoutMinutes} min exceeds the ${selfHosted ? "self-hosted" : "hosted"} ceiling of ${ceiling}`, "lower timeout_minutes or move to a self-hosted runner"));
  out.push((await onPath("gh")) ? PASS("gh", "present") : FAIL("gh", "gh not on PATH", "install the GitHub CLI"));
  out.push((await onPath("git")) ? PASS("git", "present") : FAIL("git", "git not on PATH", "install git"));
  return out;
}

/** The checks a worker job runs before spending anything. Fast: no probe, no setup execution. */
export async function jobChecks({ inputs, repo, token, app, checkout }) {
  const out = [];
  out.push(...(await credentialChecks({ inputs })));
  out.push(...(await githubChecks({ inputs, repo, token, app })));
  out.push(...(await repositoryChecks({ inputs, checkout })));
  out.push(...(await runnerChecks({ inputs })));
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputs = resolveInputs({ args });
  if (!inputs.repo) throw new Error("--repo OWNER/NAME is required");
  const repo = repoOf(inputs.repo);
  const checkout = resolve(args.checkout || process.env.GITHUB_WORKSPACE || process.cwd());
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
  results.push(...(await credentialChecks({ inputs, probe: !!args.probe })));
  if (app?.error) results.push(FAIL("app token", app.error, "check FACTORY_APP_ID, the private key, and that the App is installed on this repository"));
  results.push(...(await githubChecks({ inputs, repo, token, app })));
  results.push(...(await repositoryChecks({ inputs, checkout, runSetup: !!args.run_setup })));
  results.push(...(await runnerChecks({ inputs })));
  const fails = results.filter((r) => r.status === "FAIL").length;
  if (args.json) process.stdout.write(`${JSON.stringify({ ready: fails === 0, failures: fails, checks: results }, null, 2)}\n`);
  else {
    for (const r of results) process.stdout.write(`${r.status.padEnd(4)} ${r.name}: ${r.detail}${r.fix && r.status !== "PASS" ? `\n     fix: ${r.fix}` : ""}\n`);
    process.stdout.write(fails ? `\n${fails} failure(s); run node ${join(ACTION_ROOT, "scripts/setup.mjs")} --repo ${repo.full} --yes to apply the GitHub fixes\n` : "\nready\n");
  }
  process.exit(fails ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    process.stderr.write(`[factory] doctor failed: ${e.message}\n`);
    process.exit(2);
  });
}
