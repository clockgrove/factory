#!/usr/bin/env node
// Pendulum doctor: the checks under "Doctor" in PLAN.md, each PASS, WARN or FAIL
// with the fix. Changes nothing.
//   node scripts/doctor.mjs [--repo OWNER/NAME] [--checkout CLONE] [--json] [--probe] [--run-setup] [--local] [--verbose]
//   (`pendulum doctor` runs it with --local; without --repo, the repository is the clone's origin remote)
// Runs from the plugin (`/pendulum doctor`) and, through jobChecks(), as the first
// step of every worker job, where a FAIL Blocks the Objective with that line.
import { homedir, platform } from "node:os";
import { pathToFileURL } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { appPermissionsText, mintInstallationToken, noticeAppExtra } from "./lib/app-token.mjs";
import { PLUGIN_ROOT, installChoice, installCommand } from "./lib/checkout.mjs";
import { CLI, GATEWAY_CODEX_URL, MODEL_SECRET_KEYS, claudeLocalCheck, codexGatewayOf, codexRunner, copilotRunner, copilotSandboxCheck, credentialEnv, harnessCommand, hasApiCredential, scrubbedEnv } from "./lib/harness.mjs";
import { TOOLCHAIN_RULE, claudeEnvText, localPackageManager, localToolchain, localTools, packageManagerOf, pinnedVersion, prepareCopilotHome, repositoryTools, stageCommands } from "./lib/copilot-runner.mjs";
import { tarAsAgent, untarAsAgent } from "./lib/untar.mjs";
import { preparePendulumHome, realRoots, runnerLaunch } from "./lib/claude-runner.mjs";
import { CODEX_RUNNER_HOME, CONFINEMENT_PROBE, DECOY_LAUNCH, PROBE_MARKER, offListHost, resetCodexState } from "./lib/codex-runner.mjs";
import { randomBytes } from "node:crypto";
import { COLUMNS, collaboratorPermission, findProject, getRepo, ghLoginToken, listRulesets, repoOf, rest, organizationVariableNames, repositoryVariables } from "./lib/github.mjs";
import { APP_ID_VARIABLE, appIdVariable, PENDULUM_VERSION, GUESS_MAX_HOURS, guessHoursMs, localLimits, machineSettings, input, mask, readFlags, resolveInputs, workflowDriftLines, workflowSettings, appliedLayers, ignoredLines, layerLines, organizationVariablesLine, settingLayers } from "./lib/inputs.mjs";
import { REVIEW_LABEL, commandRefs, commandText, parseMaintainer, protectedPaths, refusalReason, selfLogin, setupGuard, unprotectedFiles } from "./lib/logic.mjs";
import { SAFE_PATH, agentUser, exec, onPath, whichSync } from "./lib/proc.mjs";
import { RELAYED_NAME } from "./lib/gateway-relay.mjs";
import { crossOs, workflowProblem } from "./lib/cross-os.mjs";
import { unrelayedGatewayKeys } from "./lib/worker-relay.mjs";
import { backend } from "./lib/backend.mjs";
import { lfsVersion, usesLfs } from "./lib/lfs.mjs";
import { ROUTE_CREDENTIAL_INPUTS, ROUTE_SECRETS, accountEnv, accountSecretText, accountToken, chatgptLogin, defaultAccount, jobLevelCredentials, loadAccounts, routeAccounts, routeAccountsText, routeAutoSetting, routeCredentialEnv, routeCredentialSecrets, routeInputs, routeSecretSuffix, routeStageAccount, sandboxRoots } from "./lib/accounts.mjs";
import { LOCAL_DOMAINS, PREVIOUS_NAME, TOKEN_LINK_FIX, pendulumKeyDir, previousKeyDirProblem, cloneRepo, codexLocalConfig, tokenLinkDetail, codexWrapper, credentialPaths, committedWorkflowEnv, droppedDomains, gitGuardScript, harnessInstall, harnessLogins, harnessOuterSettings, localBaseEnv, localToken, loginsExposedBy, ownLogin, ownLoginProblems, outerProbe, sandboxDroppedHosts, readWorkflowEnv, stageTemp, stageTmpBase, workflowEnv } from "./lib/local.mjs";
import { parseYaml, workflowEvents, writeGrants } from "./lib/yaml.mjs";
import { appIdSetLine, appIdWhyText, learnAppId } from "./lib/app-id.mjs";
import { AGENT_HOME, AGENT_USER, agentHomeProblem, agentLauncher } from "./lib/agent.mjs";
import { parseUsage, promoCodex, unpricedCodex } from "./lib/usage.mjs";
import { CHOICE_PREFIXES, HOST_PREFIX, hostsOf } from "./lib/choice.mjs";
import { TRIAGE_MODEL, triageKey } from "./lib/triage.mjs";
import { DRIFT_MODEL } from "./lib/drift.mjs";
import { deciderKind } from "./lib/decider.mjs";
import { MERGE_BASE_GIT, gitAtLeast, gitVersion } from "./lib/outbox.mjs";
import { HOLDS_LABEL, HOLDS_TITLE } from "./lib/route-holds.mjs";
import { publishOn, sealKey, sealKeyProblem, transcriptPolicy } from "./lib/seal.mjs";
import { Lexer, Parser } from "../vendor/@actions/expressions/dist/index.js";
import { forEachChild, parse as parseShell } from "../vendor/unbash/dist/parser.js";
import { ContextAccess, IndexAccess, Literal } from "../vendor/@actions/expressions/dist/ast.js";
import { TokenType } from "../vendor/@actions/expressions/dist/lexer.js";
import { dropOwned } from "./lib/fsafe.mjs";
import { limitsLine, loopCap, machineBudget, machineLimits, pressureLine, readPressure, saturation, slotHolders, slotsDir } from "./lib/machine.mjs";
import { REFUSAL_TEXT, nameLabel, parseWorkerSecrets, refusedEntry, secretLabel, parseSecretValues, workerSecrets } from "./lib/worker-secrets.mjs";

const check = (name, status, detail = "", fix = "") => ({ name, status, detail, fix });
const PASS = (n, d) => check(n, "PASS", d);
const WARN = (n, d, f) => check(n, "WARN", d, f);
const FAIL = (n, d, f) => check(n, "FAIL", d, f);

/** The one-page cap for a skill (PLAN.md: each skill is at most a page); the only place the number lives. */
export const SKILL_PAGE = { lines: 60, words: 700 };

const HOSTED_CEILING = 360;
const SELF_HOSTED_CEILING = 5 * 24 * 60;

// ------------------------------------------------------------ credentials

/** The `codex tier` row of a repository whose Codex runs on CODEX_API_KEY (OpenAI's pricing page, read 2026-11-16). */
const CODEX_TIER_ROW = {
  detail: "Codex's dollars are its tokens at OpenAI's Standard rates: they assume the OpenAI project's Service Tier is Standard. Codex reports no tier, so a project set to Fast is billed 2× those rates (2.5× on gpt-5.5, 1.8× on gpt-5-mini) and Pendulum cannot see it",
  fix: "keep the key's OpenAI project on the Standard Service Tier (platform.openai.com, Settings, Project, General); Pendulum's Codex runs never ask for Fast",
};

/** The `claude credential` row of a repository on `credential: plan` (docs/INSTALL.md, Claude on your subscription). */
const PLAN_ROW = {
  detail: "credential: plan: Claude stages run on your subscription's CLAUDE_CODE_OAUTH_TOKEN secret",
  fix: "plan limits assume ordinary individual use: use it only on your own repository, never for a product; Pendulum does not check whose repository it is (docs/INSTALL.md, Claude on your subscription)",
};

export async function credentialChecks({ inputs: asked, env: given = process.env, probe = false, local = backend(given).name === "local", now = Date.now() }) {
  // On an account its credential is the step's own input alone (lib/accounts.mjs routeInputs), as the stage runs it.
  const inputs = routeInputs(asked, given);
  const out = [];
  const h = inputs.harness;
  if (!CLI[h]) return [FAIL("harness", `unknown harness ${h}`, "set harness to claude, codex or copilot")];
  // On an account (#267, lib/accounts.mjs routeStageAccount): only its step-scoped input counts, as harness.mjs
  // credentialEnv reads it, and every credential line names that account's own secret (accountSecretText), so a fix
  // never sets the default account's.
  const account = routeStageAccount(given);
  const env = routeCredentialEnv(given);
  // A FAIL's line and any fix name the account's secret; a PASS or WARN row says what is there, as it is named.
  const named = (c) => (account && / credential$/.test(c.name) ? { ...c, detail: c.status === "FAIL" ? accountSecretText(c.detail, given, h) : c.detail, fix: c.fix ? accountSecretText(c.fix, given, h) : c.fix } : c);
  // Job-level credential variables (the default account's, or a gateway key) a stage on an account never uses: named.
  const jobLevel = account ? jobLevelCredentials(given) : [];
  if (jobLevel.length) out.push(WARN(`${h} credential`, `${jobLevel.join(", ")} ${jobLevel.length === 1 ? "is a job-level variable" : "are job-level variables"}, which a stage on account \`${account}\` never uses`, "remove them from the workflow's env block: each account's credential is its own secret, passed to the stage's step as its input"));
  // A developer's run: the job's credential is a secret (checked by name under secrets); here the CLI's own login runs.
  const planToken = h === "claude" && (inputs.claudeCodeOauthToken || env.CLAUDE_CODE_OAUTH_TOKEN);
  // A person's shell checking a repository on the Actions route with `credential: plan`: the stages run on the
  // CLAUDE_CODE_OAUTH_TOKEN secret (secretChecks checks it by name), which this shell never holds.
  if (h === "claude" && inputs.credential === "plan" && !planToken && !env.GITHUB_ACTIONS && !local) {
    out.push(WARN("claude credential", PLAN_ROW.detail, PLAN_ROW.fix));
    if (probe) out.push(await probeHarness({ inputs: { ...inputs, credential: "login" }, env }));
    return out;
  }
  const localFallback = !env.GITHUB_ACTIONS && ((inputs.credential === "api" && !hasApiCredential({ harness: h, inputs, env })) || (inputs.credential === "plan" && !planToken));
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
      else out.push(WARN("claude credential", PLAN_ROW.detail, PLAN_ROW.fix));
      // credentialEnv gives the harness the plan token alone, so a key beside it is never used.
      if (key) out.push(WARN("claude credential", "ANTHROPIC_API_KEY is also set and goes unused: credential: plan runs on CLAUDE_CODE_OAUTH_TOKEN alone", "delete the ANTHROPIC_API_KEY secret, or set credential: api to bill it instead"));
    } else if (key) out.push(PASS("claude credential", "ANTHROPIC_API_KEY present"));
    else if (fed) out.push(PASS("claude credential", "workload identity federation configured (id-token: write, exchange URL set)"));
    else if (account) out.push(FAIL("claude credential", "no ANTHROPIC_API_KEY for this account", "gh secret set ANTHROPIC_API_KEY (or CLAUDE_CODE_OAUTH_TOKEN with credential: plan); an account takes no federation"));
    else out.push(FAIL("claude credential", "no ANTHROPIC_API_KEY and no federation", "gh secret set ANTHROPIC_API_KEY, or add id-token: write and anthropic_oidc_exchange_url"));
    if (inputs.credential !== "plan" && oauth) out.push(WARN("claude credential", "CLAUDE_CODE_OAUTH_TOKEN is set on an api run", "remove it; a present API key silently wins, but a plan token must never reach unattended runs"));
  }
  if (h === "codex") {
    // Codex's JSONL names no model, so the worker prices tokens by the `model` input; without it the row is of unknown cost.
    if (!inputs.model) out.push(WARN("codex model", "no model input", "set model (for example gpt-6.1-sol) so Codex tokens are priced; the CLI's default is not reported in its output"));
    for (const m of new Set([inputs.model, inputs.reviewerModel, inputs.subagentModel].filter(Boolean))) {
      // A promotional rate: WARN in the week before it ends, FAIL once it has (its runs are then of unknown cost).
      const promo = promoCodex("codex", m, { at: now });
      const unpriced = unpricedCodex("codex", m, { gateway: !!inputs.codexGatewayKey, at: now });
      if (promo) out.push(check("codex model", promo.status, promo.detail, "upgrade Pendulum to a release whose plugin/scripts/lib/codex-prices.json has OpenAI's current rate for it, or use another model with a row there"));
      else if (unpriced) out.push(WARN("codex model", unpriced, "use a model with a row in plugin/scripts/lib/codex-prices.json, or set a budget on the provider key"));
    }
    const key = inputs.codexApiKey || env.CODEX_API_KEY;
    const gateway = inputs.codexGatewayKey;
    // A ChatGPT login never runs on GitHub Actions or the cloud sandbox (harness.mjs CODEX_LOGIN_REFUSED, #267).
    if (env.GITHUB_ACTIONS && [gateway, key].some(chatgptLogin)) out.push(FAIL("codex credential", "the Codex credential is a ChatGPT login (an auth.json or its access token), not an API key", "OpenAI advises an API key for CI: set CODEX_API_KEY or PENDULUM_CODEX_GATEWAY_KEY to one, or run that account in local mode"));
    else if (gateway) {
      if (env.PENDULUM_CODEX_GATEWAY_KEY && env.GITHUB_ACTIONS && !env.PENDULUM_INPUT_CODEX_GATEWAY_KEY) out.push(WARN("codex credential", "PENDULUM_CODEX_GATEWAY_KEY is a job-level variable", "pass it as the codex_gateway_key input so only the harness child sees it"));
      else out.push(PASS("codex credential", `PENDULUM_CODEX_GATEWAY_KEY present, step-scoped: Codex runs through the Vercel AI Gateway${key ? "; CODEX_API_KEY is set too and goes unused (the gateway key wins)" : ""}`));
      // Unused, but a job-level CODEX_API_KEY is still in the job's environment for every step.
      if (env.CODEX_API_KEY && env.GITHUB_ACTIONS && !env.PENDULUM_INPUT_CODEX_API_KEY) out.push(WARN("codex credential", "CODEX_API_KEY is a job-level variable (unused: the gateway key wins)", "remove it from the job's env, or pass it as the codex_api_key input"));
      if (probe) out.push(await gatewayKeyProbe(gateway));
    } else if (!key) out.push(FAIL("codex credential", "no Codex credential: PENDULUM_CODEX_GATEWAY_KEY and CODEX_API_KEY absent", "gh secret set PENDULUM_CODEX_GATEWAY_KEY (a Vercel AI Gateway key with a budget) or CODEX_API_KEY; the action passes it to the harness step only"));
    else if (env.CODEX_API_KEY && env.GITHUB_ACTIONS && !env.PENDULUM_INPUT_CODEX_API_KEY) out.push(WARN("codex credential", "CODEX_API_KEY is a job-level variable", "pass it as the codex_api_key input so only the harness child sees it"));
    else out.push(PASS("codex credential", "CODEX_API_KEY present, step-scoped"));
    // Codex reports no service tier, and an OpenAI project can make Fast its default for every request that names none
    // (Pendulum's never do): the Codex price table's dollars assume Standard (codex-prices.json).
    if (key && !gateway && !(env.GITHUB_ACTIONS && chatgptLogin(key))) out.push(WARN("codex tier", CODEX_TIER_ROW.detail, CODEX_TIER_ROW.fix));
  }
  if (h === "copilot") {
    const tok = inputs.copilotGithubToken || env.COPILOT_GITHUB_TOKEN;
    if (!tok) out.push(FAIL("copilot credential", "no token for Copilot", "gh secret set COPILOT_GITHUB_TOKEN to a fine-grained token with only the Copilot Requests permission (the job's own token can write, so it is never used)"));
    else out.push(await copilotWriteProbe({ repo: inputs.repo, token: tok }));
  }
  if (probe) out.push(await probeHarness({ inputs, env: given }));
  return out.map(named);
}

/**
 * The repository's harness and models (the workflow's env block, or this shell's in local mode): its defaults, which an
 * Objective's harness and model labels override for that Objective alone (lib/choice.mjs).
 */
export function defaultsCheck(inputs) {
  const m = (v) => v || `${inputs.harness}'s own default`;
  return PASS("defaults", `harness ${inputs.harness}, worker ${m(inputs.model)}, sub-agents ${m(inputs.subagentModel)}, reviewer ${m(inputs.reviewerModel)}: the repository's defaults; an Objective overrides any of them for itself with a ${Object.values(CHOICE_PREFIXES).map((p) => `${p}<${p === CHOICE_PREFIXES.harness ? "name" : "id"}>`).join(", ")} label (docs/USAGE.md); one on another harness needs that harness's credential too, and Blocks naming it when it is missing`);
}

/**
 * The limits a person owns in force (#423, inputs.mjs OWNER_LIMITS), from the settings as a stage reads them (`inputs`,
 * resolveInputs): one PASS; in local mode with the local stage's settings (`stage`, local.mjs baseEnv's) the two local
 * ones as well, and a WARN when the outage bound (PENDULUM_LOCAL_OUTAGE_HOURS) is not under the claim pause
 * (claim_pause_hours), so the dispatcher's Block would come first and name a quiet claim rather than the outage, or when
 * the in-place wait (PENDULUM_LOCAL_WAIT_MINUTES) is not under the outage bound, so a stage that waits it out ends paused
 * already past the bound and is Blocked at once. The wait's own maximum keeps it under the least claim pause.
 */
export function ownerLimitChecks({ inputs, local = false, stage = {} }) {
  const h = (ms) => `${Number((ms / 3600_000).toFixed(2))} h`;
  const min = (ms) => `${Number((ms / 60_000).toFixed(2))} min`;
  const { stall } = inputs;
  const lines = [
    `a usage limit waited out in place ${inputs.usageLimitWaits} time(s) per pass, and on Actions and the cloud sandbox a reset over ${min(inputs.usageLimitMoveMs)} away moves to a free account`,
    `a quiet local claim Blocked after ${h(inputs.claimPauseMs)}`,
    `a sibling waited for ${h(inputs.siblingWaitMs)} at most`,
    `${inputs.maxParts} part(s) per Objective at most`,
    `a queue check's step hung past ${stall.factor} x its normal duration and at least ${min(stall.floorMs)} over it, a queue commit with no CI begun stalled after ${min(stall.queueMs)}`,
  ];
  const own = local ? localLimits(stage) : null;
  if (own) lines.push(`a local stage waits in place ${min(own.waitMs)}, and an Objective paused on one outage Blocks after ${h(own.outageMs)}`);
  const rows = [PASS("owner limits", `${lines.join("; ")} (the settings in docs/INSTALL.md and docs/LOCAL.md)`)];
  if (own && own.waitMs >= own.outageMs) rows.push(WARN("owner limits", `PENDULUM_LOCAL_WAIT_MINUTES (${min(own.waitMs)}) is not under PENDULUM_LOCAL_OUTAGE_HOURS (${h(own.outageMs)}), so a stage that waits out an outage in place ends paused past the outage bound and is Blocked at once`, "lower PENDULUM_LOCAL_WAIT_MINUTES under PENDULUM_LOCAL_OUTAGE_HOURS, or raise PENDULUM_LOCAL_OUTAGE_HOURS"));
  if (own && own.outageMs >= inputs.claimPauseMs) rows.push(WARN("owner limits", `PENDULUM_LOCAL_OUTAGE_HOURS (${h(own.outageMs)}) is not under claim_pause_hours (${h(inputs.claimPauseMs)}), so a long outage meets the dispatcher's Block for a quiet claim first, which does not name the outage`, "lower PENDULUM_LOCAL_OUTAGE_HOURS under claim_pause_hours, or raise claim_pause_hours"));
  return rows;
}

/**
 * The gateway relay (lib/gateway-relay.mjs), when the worker secrets carry the AI Gateway key: it is relayed, never handed
 * over, so a harness the relay does not reach yet, or a machine without its forwarder's tools, Blocks every stage.
 */
export function gatewayRelayChecks({ inputs, env = process.env, which = whichSync }) {
  // An AI Gateway key under any other name (another case, or a gateway key's value): withheld from the worker.
  const values = parseSecretValues(inputs.workerSecretValues);
  const ws = workerSecrets({ spec: inputs.workerSecrets, lookup: (src) => values.get(src) ?? (env.GITHUB_ACTIONS ? undefined : env[src]), pendulumKey: "" });
  const odd = unrelayedGatewayKeys(ws.env);
  const out = odd.length ? [WARN("gateway relay", `${odd.map(nameLabel).join(", ")}: an AI Gateway key under a name other than ${RELAYED_NAME}, so the worker never gets it (a gateway key is only ever relayed)`, `opt the key in as ${RELAYED_NAME}=SOURCE, the one name Pendulum relays`)] : [];
  if (!parseWorkerSecrets(inputs.workerSecrets).entries.some((e) => e.name === RELAYED_NAME)) return out;
  const missing = ["bwrap", "socat"].filter((b) => !which(b, { PATH: SAFE_PATH }) && !(env.GITHUB_ACTIONS ? null : which(b, env)));
  return [...out, missing.length ? WARN("gateway relay", `${RELAYED_NAME} is relayed through a forwarder in each command's sandbox, which needs ${missing.join(" and ")} here: every stage Blocks before its run`, `install ${missing.map((b) => (b === "bwrap" ? "bubblewrap" : b)).join(" ")} (the Action does on GitHub's hosted runners)`) : PASS("gateway relay", `${RELAYED_NAME} stays in Pendulum's process; the worker's shell gets a relay token and PENDULUM_GATEWAY_URL, and each call counts against max_usd`)];
}

/**
 * The worker secrets (lib/worker-secrets.mjs), when `worker_secrets` names any: each refused entry, each SOURCE with no
 * value here and each value equal to Pendulum's own AI Gateway key (compared in constant time, in this process; the worker
 * withholds it) is a WARN; else one PASS naming what reaches the worker's shell. Values: `worker_secret_values` (a job,
 * a stage), else, off Actions, this shell's variables (a developer's doctor run for local mode). Names only, never a value.
 */
/** The PENDULUM_LOCAL_ENV names that are a worker secret's NAME or SOURCE (`spec`, worker_secrets). */
export function localEnvWorkerNames(spec, localEnv) {
  const named = new Set(parseWorkerSecrets(spec).entries.flatMap((e) => [e.name, e.source]));
  return String(localEnv || "").split(/[\s,]+/).filter((n) => n && named.has(n));
}

export function workerSecretChecks({ inputs, env = process.env, pendulumKey = () => triageKey({ inputs, env }) }) {
  if (!String(inputs.workerSecrets || "").trim()) return [];
  const values = parseSecretValues(inputs.workerSecretValues);
  const ws = workerSecrets({ spec: inputs.workerSecrets, lookup: (s) => values.get(s) ?? (env.GITHUB_ACTIONS ? undefined : env[s]), pendulumKey: pendulumKey() });
  const out = [];
  for (const r of ws.refused) out.push(WARN("worker secrets", `refused ${refusedEntry(r)}: ${REFUSAL_TEXT[r.code]}`, "remove it from worker_secrets (PENDULUM_WORKER_SECRETS); pass a key of its own as NAME=SOURCE"));
  if (ws.missing.length) out.push(WARN("worker secrets", `no value here for ${ws.missing.map(nameLabel).join(", ")}`, "on Actions and in a cloud sandbox add a SOURCE=value line for each to the repository secret PENDULUM_WORKER_SECRET_VALUES (the workflow passes it as worker_secret_values); in local mode export each in the shell that runs pendulum serve"));
  if (ws.pendulumKey.length) out.push(WARN("worker secrets", `${ws.pendulumKey.map(nameLabel).join(", ")}: the same value as Pendulum's own AI Gateway key, so the worker does not get it`, "give the worker a dedicated key with a budget of its own (docs/PLAN.md, Worker secrets); Pendulum's AI_GATEWAY_API_KEY stays Pendulum's"));
  const given = ws.entries.filter((e) => ws.env[e.name] !== undefined);
  // PENDULUM_LOCAL_ENV naming a worker secret would hand it to every local stage's every command (lib/local.mjs
  // localBaseEnv leaves such names out; the warning says why the stage does not get it).
  const shared = localEnvWorkerNames(inputs.workerSecrets, env.PENDULUM_LOCAL_ENV);
  if (shared.length) out.push(WARN("worker secrets", `PENDULUM_LOCAL_ENV names ${shared.map(nameLabel).join(", ")}, a worker secret: local mode leaves it out of every stage's environment, so only the worker's shell gets it`, "remove it from PENDULUM_LOCAL_ENV; worker_secrets alone opts it in"));
  // Pendulum redacts and masks only values of eight characters or more (inputs.mjs secretForms): a shorter one would mask
  // ordinary text, so it goes unprotected.
  const short = given.filter((e) => ws.env[e.name].length < 8);
  if (short.length) out.push(WARN("worker secrets", `${short.map((e) => nameLabel(e.name)).join(", ")}: a value under 8 characters, which Pendulum cannot redact or mask in what it posts, stores or pushes`, "use a real key: a gateway key is far longer"));
  if (given.length && !out.length) out.push(PASS("worker secrets", `${given.map(secretLabel).join(", ")} reach the worker's shell; any code it runs can spend them, so each must be a dedicated key with a budget`));
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
  const got = { issues: await probe("issues"), "pull requests": await probe("pulls"), contents: await probe("contents/.pendulum-write-probe", "PUT") };
  const writes = Object.entries(got).filter(([, st]) => st === 422 || st === 201).map(([k]) => k);
  if (writes.length) return FAIL("copilot token", `the Copilot token can write ${writes.join(", ")} in ${repo}`, "use a fine-grained token with only the Copilot Requests permission and no repository access");
  const unclear = Object.entries(got).filter(([, st]) => st !== 403 && st !== 404);
  if (unclear.length) return FAIL("copilot token", `the write probes answered ${unclear.map(([k, st]) => `${k} HTTP ${st || "nothing"}`).join(", ")}`, "check the token: it must be refused (403 or 404) on every repository write");
  return PASS("copilot token", `cannot write issues, pull requests or contents in ${repo}`);
}

/**
 * The Codex gateway key, checked for free: the gateway's Codex model list (`GET /codex/v1/models`, which Codex itself
 * reads at start) with the key bills nothing. 401 or 403 FAIL (the key is rejected); any other non-200 or no answer WARN.
 */
export async function gatewayKeyProbe(key, { fetchFn = fetch } = {}) {
  let status = 0;
  try {
    status = (await fetchFn(`${GATEWAY_CODEX_URL}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) })).status;
  } catch {
    status = 0;
  }
  if (status === 200) return PASS("codex gateway key", "the Vercel AI Gateway accepts PENDULUM_CODEX_GATEWAY_KEY (its Codex model list, no charge)");
  if (status === 401 || status === 403) return FAIL("codex gateway key", `the Vercel AI Gateway refused PENDULUM_CODEX_GATEWAY_KEY (HTTP ${status})`, "make a new AI Gateway key in the Vercel team that holds the credits, then gh secret set PENDULUM_CODEX_GATEWAY_KEY");
  return WARN("codex gateway key", status ? `the gateway's model list answered HTTP ${status}` : "the gateway did not answer", "run doctor --probe again; an Objective would fail the same way if it persists");
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
  // Codex where the agent uid exists (a runner, a cloud sandbox): as the agent, in its own sandbox, as a run gets it.
  let runner = null;
  try {
    runner = h === "codex" ? await probeRunner(env) : null;
  } catch (e) {
    return FAIL(`${h} probe`, `Codex's run sandbox could not be prepared: ${String(e.message).slice(0, 200)}`, "see the codex sandbox lines above");
  }
  const { cmd, args, stdin, env: extra } = harnessCommand({ harness: h, model: inputs.model, prompt: "Reply with the single word ok.", maxUsd: 0.5, gateway: codexGatewayOf(h, cred.env), runner });
  // The job's env with every secret removed, then the one credential the harness runs on (as the worker's run gets it).
  const childEnv = { ...scrubbedEnv(env), ...cred.env, ...extra };
  const [runCmd, runArgs] = runner ? runnerLaunch(runner, cmd, args, childEnv.PATH) : [cmd, args];
  const r = await exec(runCmd, runArgs, { env: childEnv, input: stdin, timeoutMs: 180_000, ...(runner ? { cwd: runner.clone, agentExtra: [...MODEL_SECRET_KEYS, ...Object.keys(extra)] } : {}) });
  const rec = parseUsage(h, r.stdout, inputs.model || null, r.code ?? 1);
  if (rec.refusal) return FAIL(`${h} probe`, refusalReason(rec.refusal), "an Objective would Block on the same refusal: fix the credential's account or the model setting first");
  if (r.code !== 0 && !rec.ok) return FAIL(`${h} probe`, `exit ${r.code}: ${String(r.stderr).slice(-200).trim()}`, "check the credential and the CLI version");
  const usage = rec.usd !== null ? `$${rec.usd}` : rec.tokens.input !== null ? `${rec.tokens.input} input tokens, ${rec.basis}` : "no usage output";
  return (rec.usd !== null || rec.tokens.input !== null || h === "copilot" ? PASS : WARN)(`${h} probe`, `model ${rec.model ?? "default"}, ${usage}`, "usage output missing: update the CLI");
}

// ----------------------------------------------------------------- github

/**
 * The secrets a job needs, by name: the App's two and the harness credential the workflow names. An entry that is a list
 * is met by any one of its names (Codex: the gateway key or CODEX_API_KEY).
 */
export function neededSecrets(inputs, accounts = "") {
  const declared = routeAccounts(accounts);
  const kind = (h) => (h === "claude" && inputs.credential === "plan" ? "plan" : "api");
  // Each account's own (lib/accounts.mjs routeSecretSuffix, #267): the repository's harness's declared accounts, else its
  // one account on today's secrets, and every other harness's declared accounts.
  const cred = [];
  for (const h of Object.keys(ROUTE_SECRETS)) {
    const names = declared.ok && declared.accounts[h].length ? declared.accounts[h] : h === inputs.harness ? [h] : [];
    for (const name of names) for (const n of ROUTE_SECRETS[h][kind(h)]) cred.push(Array.isArray(n) ? n.map((x) => `${x}${routeSecretSuffix(name, h)}`) : `${n}${routeSecretSuffix(name, h)}`);
  }
  return ["PENDULUM_APP_ID", "PENDULUM_APP_PRIVATE_KEY", ...cred];
}

/**
 * The accounts a repository declares for GitHub Actions and the cloud sandbox (PENDULUM_ACCOUNTS in its workflow file,
 * lib/accounts.mjs routeAccounts, #267): none, a FAIL naming why the declaration cannot be used, or a PASS naming each
 * harness's accounts and how a stage's account is picked (`auto`: PENDULUM_AUTO_ACCOUNT, #268; a value that is neither 1
 * nor 0 is a WARN, and leaves it off). Names only; secretChecks checks each one's secret by name.
 */
export function routeAccountChecks(accounts = "", auto = "") {
  const d = routeAccounts(accounts);
  if (!d.ok) return [FAIL("accounts", d.problem, 're-render the workflow with setup\'s --accounts set to a JSON object of each harness\'s account names, such as {"claude": ["claude", "claude-2"]}, and merge it (docs/INSTALL.md, Several accounts)')];
  const setting = routeAutoSetting({ PENDULUM_AUTO_ACCOUNT: auto });
  const warn = setting.problem ? [WARN("automatic account choice", setting.problem, "re-render the workflow with setup's --auto-account on or off and merge it (docs/INSTALL.md, Several accounts)")] : [];
  if (!d.declared) return warn;
  const each = Object.entries(d.accounts).filter(([, l]) => l.length).map(([h, l]) => `${h}: ${l.join(", ")} (default ${l[0]})`);
  const how = setting.on ? "the one a trusted pendulum:account:<name> label pins, else a free one by automatic account choice (PENDULUM_AUTO_ACCOUNT)" : "its harness's default or the one a trusted pendulum:account:<name> label pins";
  return [PASS("accounts", `${each.join("; ")}: on GitHub Actions and the cloud sandbox each stage runs on one, ${how}, and gets only that account's secrets`), ...warn];
}
/**
 * Pendulum's account holds issue (lib/route-holds.mjs, #268), with automatic account choice on and accounts declared: a
 * WARN for more than one (only the oldest locked one is read; Pendulum retires the rest at its next usage limit) or an
 * unlocked one (on GitHub Actions its holds count for nothing), a PASS otherwise. `self`: the App's bot login when known,
 * else any bot's issue with the title counts. One labelled issues query; a failed read is a WARN.
 */
export async function holdsIssueChecks({ repo, opts = {}, accounts = "", auto = "", self = null }) {
  if (!routeAutoSetting({ PENDULUM_AUTO_ACCOUNT: auto }).on || !routeAccounts(accounts).declared) return [];
  let list;
  try {
    list = (await rest(`repos/${repo.full}/issues?labels=${encodeURIComponent(HOLDS_LABEL)}&state=all&sort=created&direction=asc&per_page=100`, opts)) || [];
  } catch (e) {
    return [WARN("account holds", `could not read Pendulum's holds issue (${String(e.message).slice(0, 100)})`, "run doctor with a token that can read the repository's issues")];
  }
  const key = (l) => String(l ?? "").toLowerCase();
  const ours = list.filter((i) => !i.pull_request && i.title === HOLDS_TITLE && (self ? key(i.user?.login) === key(self) : i.user?.type === "Bot")).sort((a, b) => a.number - b.number);
  if (!ours.length) return [PASS("account holds", "no holds issue yet: Pendulum opens it, closed and locked, at the first usage limit on an account")];
  const out = [];
  if (ours.length > 1) out.push(WARN("account holds", `${ours.length} holds issues (${ours.map((i) => `#${i.number}`).join(", ")}): only the oldest locked one is read`, "leave them: Pendulum retitles and closes the others at its next usage limit"));
  const open = ours.filter((i) => i.locked !== true);
  if (open.length) out.push(WARN("account holds", `${open.map((i) => `#${i.number}`).join(", ")} is not locked, so on GitHub Actions its holds count for nothing`, `lock it: gh issue lock ${open[0].number} --reason resolved`));
  return out.length ? out : [PASS("account holds", `#${ours[0].number}, Pendulum's own and locked`)];
}
const secretName = (n) => (Array.isArray(n) ? n.join(" or ") : n);

/** The contexts and status functions a workflow's expressions use beside the expression library's own functions. */
const EXPRESSION_CONTEXTS = ["github", "env", "vars", "secrets", "inputs", "steps", "job", "jobs", "runner", "matrix", "strategy", "needs"];
const EXPRESSION_FUNCTIONS = [...["always", "success", "failure", "cancelled"].map((name) => ({ name, minArgs: 0, maxArgs: 0 })), { name: "hashFiles", minArgs: 1, maxArgs: 255 }];

/**
 * How a workflow file's expressions read the `secrets` context, parsed with GitHub's expression library: `names`, each
 * secret named by its fixed name (`secrets.NAME`), and `dynamic`, each expression that reads it any other way (an index
 * such as `secrets[format(...)]`, or the whole context): GitHub then sends the job every repository and organization
 * secret. An expression the library cannot parse counts as dynamic when its text holds `secrets` not followed by `.NAME`.
 */
export function secretReferences(text) {
  const names = new Set();
  const dynamic = [];
  const exprs = [];
  const walk = (v, key) => {
    if (typeof v === "string") {
      for (const m of v.matchAll(/\$\{\{([\s\S]*?)\}\}/g)) exprs.push(m[1]);
      if (key === "if" && !v.includes("${{")) exprs.push(v);
    } else if (Array.isArray(v)) v.forEach((x) => walk(x));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(parseYaml(text));
  const visit = (n, parent) => {
    if (!n || typeof n !== "object") return;
    if (n instanceof ContextAccess && n.name?.lexeme?.toLowerCase() === "secrets") {
      const named = parent instanceof IndexAccess && parent.expr === n && parent.index instanceof Literal && parent.index.token?.type === TokenType.IDENTIFIER;
      if (named) names.add(String(parent.index.literal.coerceString()));
      return named;
    }
    for (const v of Object.values(n)) {
      if (Array.isArray(v)) {
        for (const x of v) if (visit(x, n) === false) return false;
      } else if (v instanceof Object && visit(v, n) === false) return false;
    }
    return true;
  };
  for (const src of exprs) {
    let ok;
    try {
      ok = visit(new Parser(new Lexer(src).lex().tokens, EXPRESSION_CONTEXTS, EXPRESSION_FUNCTIONS).parse(), null) !== false;
    } catch {
      ok = !/\bsecrets\b(?!\s*\.\s*[A-Za-z_])/i.test(src);
      for (const m of src.matchAll(/\bsecrets\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)/gi)) names.add(m[1]);
    }
    if (!ok) dynamic.push(src.trim());
  }
  return { names, dynamic };
}

/**
 * The workflow file's secret references (secretReferences): a FAIL for any expression that reads `secrets` by a
 * computed name or whole, since GitHub then sends every repository and organization secret to a job that runs
 * model-written code; with accounts declared (its env block's PENDULUM_ACCOUNTS) or rendered, a FAIL when its jobs were
 * rendered for other accounts (an account step's `rendered_accounts`, accounts.mjs routeAccountsText) or do not name a
 * declared account's secret (routeCredentialSecrets): a re-render is needed after every change to PENDULUM_ACCOUNTS.
 */
export function workflowSecretChecks(text) {
  let doc;
  try {
    doc = parseYaml(text) || {};
  } catch {
    return [];
  }
  const out = [];
  const { names, dynamic } = secretReferences(text);
  const rerender = "re-render the workflow with this release's setup (setup --apply workflow, docs/INSTALL.md, Upgrade), merge it, then run doctor";
  if (dynamic.length) out.push(FAIL("workflow secrets", `${dynamic.length} expression(s) read secrets by a computed name or whole (${dynamic[0].slice(0, 120)}), so GitHub sends every repository and organization secret to the jobs that hold them, model-written code's included`, `${rerender}: it names each secret by its fixed name`));
  else out.push(PASS("workflow secrets", "every secret is named by its fixed name, so a job gets only the secrets it names"));
  const raw = doc.env?.PENDULUM_ACCOUNTS;
  const accounts = raw == null ? "" : typeof raw === "object" ? JSON.stringify(raw) : String(raw);
  const declared = routeAccounts(accounts);
  const steps = Object.values(doc.jobs || {}).flatMap((j) => (Array.isArray(j?.steps) ? j.steps : [])).filter((st) => st?.with?.mode === "account");
  const rendered = [...new Set(steps.map((st) => routeAccountsText(st.with.rendered_accounts)))];
  if (!declared.ok || (!declared.declared && rendered.every((r) => !r))) return out;
  const want = routeAccountsText(accounts);
  const missing = declared.declared ? [...new Set(Object.keys(ROUTE_CREDENTIAL_INPUTS).flatMap((k) => routeCredentialSecrets(k, declared).map((x) => x.secret)))].filter((n) => !names.has(n)) : [];
  const stale = !steps.length || rendered.some((r) => r !== want);
  if (missing.length || stale) out.push(FAIL("workflow accounts", `${declared.declared ? "PENDULUM_ACCOUNTS declares other accounts than" : "PENDULUM_ACCOUNTS declares none, but"} the workflow's jobs were rendered for${missing.length ? `: they do not name ${missing.join(", ")}` : ""}, so a stage on ${declared.declared ? "a declared account" : "any account"} gets no credential and Blocks`, rerender));
  else if (declared.declared) out.push(PASS("workflow accounts", "the jobs name each declared account's secrets by name and pass a stage only its account's"));
  return out;
}

export async function secretChecks({ inputs, repo, accounts = "" }) {
  const names = new Set();
  try {
    for (const s of (await rest(`repos/${repo.full}/actions/secrets?per_page=100`, {}))?.secrets || []) names.add(s.name);
    // A repository a user owns has no organization: GitHub answers this list with 422, which means none, not unreadable.
    const org = await rest(`repos/${repo.full}/actions/organization-secrets?per_page=100`, {}).catch((e) => {
      if (e?.status === 422) return { secrets: [] };
      throw e;
    });
    for (const s of org?.secrets || []) names.add(s.name);
  } catch (e) {
    return [WARN("secrets", `could not list secret names (${String(e.message).slice(0, 100)})`, "run doctor with a gh login that administers the repository")];
  }
  const missing = neededSecrets(inputs, accounts).filter((n) => ![].concat(n).some((x) => names.has(x)));
  const present = neededSecrets(inputs, accounts).map((n) => [].concat(n).filter((x) => names.has(x)).join(", "));
  return [missing.length ? FAIL("secrets", `missing ${missing.map(secretName).join(", ")} (repository, or organization secrets visible to it)`, "add them: gh secret set NAME, or at the organization with --repos") : PASS("secrets", `${present.join(", ")} exist; the job mints the App token`)];
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
  // A personal account's App needs no projects (#199), so its list names none.
  const need = appPermissionsText({ userAccount: app.userAccount === true });
  out.push(app.missing?.length ? FAIL("app permissions", `missing ${app.missing.join(", ")}`, `edit the App's repository permissions (${need}) and accept the new permissions on the installation`) : PASS("app permissions", `${app.appSlug}: ${need}`));
  // Workflows write would let a branch change the workflow its own review job runs, including whom Pendulum trusts.
  // A warning, not a Block: an installed App with it keeps working until a person turns it off.
  if (app.extra?.some((p) => /workflow/i.test(p))) out.push(WARN("app permissions", `the App can write workflows (extra: ${app.extra.join(", ")})`, "turn the App's workflows permission off: a worker branch could change the workflow its review runs, and with it whom Pendulum trusts"));
  else if (app.extra?.length) out.push(WARN("app permissions", `extra permissions granted: ${app.extra.join(", ")}`, `remove them; Pendulum needs ${need}`));
  return out;
}

/**
 * Local red-check triage reruns a flaky red's failed jobs, which needs the token's Actions write (LOCAL.md). A
 * fine-grained token's permissions cannot be listed, so doctor makes a dry rerun: it asks GitHub to rerun the failed
 * jobs of workflow run 0, which no repository has, so nothing can rerun. A 403 is the token lacking Actions write: a
 * warning with the fix. A 404, GitHub's usual answer for that run, passes, saying what it saw (it does not prove the
 * permission: a token without it may get one too, and then the first flaky red's rerun is refused, said in its triage
 * line, and goes to the fix pass). Any other answer leaves it not verified, a warning.
 */
export async function rerunProbeCheck({ repo, token }) {
  const name = "triage rerun";
  const grant = "give the local token Actions read and write (LOCAL.md); without it GitHub refuses triage's rerun of a flaky red, which then goes to the fix pass or Blocks";
  let status = "an accepted request";
  try {
    await rest(`repos/${repo.full}/actions/runs/0/rerun-failed-jobs`, { token, method: "POST", body: {} });
  } catch (e) {
    if (e.status === 403 && !e.rateLimited) return WARN(name, "red-check triage is on, but the token cannot rerun CI jobs: GitHub refused a dry rerun (403)", grant);
    status = e.status || "no answer";
  }
  if (status === 404) return PASS(name, "GitHub did not refuse a dry rerun (404); a refusal at a real rerun is named in its triage line");
  return WARN(name, `not verified: GitHub answered a dry rerun with ${status}`, `red-check triage's rerun needs the token's Actions read and write; ${grant}`);
}

/**
 * The ref the workflow's first `uses: clockgrove/pendulum@<ref>` calls (a step's, or a job's), read from the parsed YAML,
 * so a commented-out line is not one and a quoted value is; "" when there is none or the file does not parse.
 */
export function pendulumRef(text) {
  let doc;
  try {
    doc = parseYaml(String(text ?? ""));
  } catch {
    return "";
  }
  const jobs = doc && typeof doc.jobs === "object" ? Object.values(doc.jobs || {}) : [];
  for (const job of jobs) {
    for (const node of [job, ...(Array.isArray(job?.steps) ? job.steps : [])]) {
      const ref = /^clockgrove\/pendulum@(\S+)$/.exec(typeof node?.uses === "string" ? node.uses.trim() : "")?.[1];
      if (ref) return ref;
    }
  }
  return "";
}

/** A `vX.Y.Z` release's numbers, or null for any other ref (a commit, a floating vX.Y, a branch). */
export const releaseOf = (ref) => /^v(\d+)\.(\d+)\.(\d+)$/.exec(String(ref || ""))?.slice(1).map(Number) ?? null;

/** The first Pendulum release: every earlier tag is the product under its previous name, which reads none of Pendulum's names. */
export const FIRST_RELEASE = [0, 10, 0];

/**
 * The `pendulum pin` row for the ref the workflow calls (pendulumRef): FAIL on a release, or a floating vX / vX.Y tag,
 * before FIRST_RELEASE; PASS on a later one; null for a branch or a commit, which is no release to compare.
 */
export function pinRow(ref) {
  const parts = /^v(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(String(ref || ""))?.slice(1).filter((n) => n !== undefined).map(Number);
  if (!parts) return null;
  const i = parts.findIndex((n, k) => n !== FIRST_RELEASE[k]);
  const first = `v${FIRST_RELEASE.join(".")}`;
  if (i >= 0 && parts[i] < FIRST_RELEASE[i]) return FAIL("pendulum pin", `the workflow calls clockgrove/pendulum@${ref}, a tag before ${first}: tags before ${first} are the product under its previous name, which reads none of Pendulum's labels, settings or markers`, `pin ${first} or later: re-render the workflow with setup --apply workflow`);
  return PASS("pendulum pin", `clockgrove/pendulum@${ref}`);
}

/** Update commands for the plugin, per harness: each marketplace is named `clockgrove` (README, Install). */
export const PLUGIN_UPDATE =
  "update the plugin, then start a new session: Claude Code `claude plugin marketplace update clockgrove && claude plugin update pendulum@clockgrove`; Codex `codex plugin marketplace upgrade clockgrove && codex plugin add pendulum@clockgrove`; Copilot `copilot plugin update pendulum@clockgrove`";

/**
 * The installed plugin (this process's, `version`) against the release the workflow pins: a session's skills and
 * scripts, and local mode's stages, are the plugin's, so one older than the pin follows an older Pendulum than the Action
 * runs. WARN when older, PASS otherwise; null when the workflow pins no `vX.Y.Z` release (a commit, a floating tag).
 */
export function pluginVersionCheck(text, version = PENDULUM_VERSION) {
  const pin = releaseOf(pendulumRef(text));
  const have = releaseOf(`v${version}`);
  if (!pin || !have) return null;
  const i = have.findIndex((n, k) => n !== pin[k]);
  const pinned = `v${pin.join(".")}`;
  if (i < 0 || have[i] > pin[i]) return PASS("plugin version", `the installed plugin is v${version}; the workflow pins clockgrove/pendulum@${pinned}`);
  return WARN("plugin version", `the installed plugin is v${version}, older than clockgrove/pendulum@${pinned}, which the workflow pins: a session's skills and local mode's stages run the older release`, PLUGIN_UPDATE);
}

/**
 * Which decider this repository's stages use (lib/decider.mjs): the AI Gateway's decision models with a usable key, else
 * the stage's own harness on its login (decision_route auto), else none. A PASS each way; a local key file Pendulum
 * refuses (any code but no-key) is a WARN, since the gateway was meant.
 */
export function deciderCheck({ inputs, env = process.env, home = homedir() }) {
  const kind = deciderKind({ inputs, env, home });
  const offText = "every red goes to the fix pass, no drift check runs, every answer commit after the review gets a review pass, a reply resolves its finding unjudged, a send-back's conflict pass is checked by matching commits, a writer's comment resumes a Question unjudged, a red after a fix pass the exact checks cannot judge Blocks, any edit to an Objective's text after its plan makes it stale, a fix pass's lockfile change outside its scope is refused unjudged, and a writer's comment no pass has read holds a reviewed PR's merge until the review stage applies it";
  if (kind.name === "off") return PASS("decision calls", kind.route === "off" ? `off (decision_route off): ${offText}` : `off: decision_route gateway and no AI Gateway key (${kind.code}), so ${offText}`);
  if (kind.name === "ai-gateway") return PASS("decision calls", `the AI Gateway's decision models (triage ${inputs.triageModel || TRIAGE_MODEL}, drift ${inputs.driftModel || DRIFT_MODEL})`);
  const harness = inputs.harness ? `the stage's own harness (${inputs.harness})` : "the stage's own harness";
  // On Copilot each such call is a prompt of its own: one premium request, billed to the seat as AI credits (#565).
  const copilot = inputs.harness === "copilot";
  const text = `${harness} on its login, one short call with no tools per question (triage, drift, the answer gate, the finding check, the rebase check, the answer check, the fix-progress check, the edit check, the fence check, the comment check, the plan-answer check): no AI Gateway key (${kind.code})${copilot ? "; on Copilot each call costs one premium request, billed to the seat as AI credits" : ""}`;
  if (kind.code !== "no-key") return WARN("decision calls", text, "fix ~/.config/pendulum/ai-gateway-key as docs/LOCAL.md says (a regular file, chmod 600, in a ~/.config/pendulum no harness can read), or remove it");
  // Pendulum's own key, never a worker secret: the worker's keys are the worker's.
  const ownKey = env.GITHUB_ACTIONS ? "the workflow's `ai_gateway_api_key` input (the repository secret AI_GATEWAY_API_KEY)" : "~/.config/pendulum/ai-gateway-key as docs/LOCAL.md says";
  if (copilot) return WARN("decision calls", text, `give Pendulum its own AI Gateway key (${ownKey}) so the gateway's decision models answer them, or set decision_route off to make none`);
  return PASS("decision calls", text);
}

/**
 * The finding check (lib/finding-check.mjs) as doctor says it: on wherever a decision call runs (deciderKind: the
 * gateway's model, or the stage's harness); with none (decision_route off, or gateway with no key) a WARN, since
 * Pendulum's reply then answers a reviewer finding unjudged.
 */
export function findingCheckRow({ inputs, env = process.env, home } = {}) {
  const kind = deciderKind({ inputs, env, ...(home ? { home } : {}) });
  if (kind.name === "ai-gateway") return PASS("finding check", "an AI Gateway key: the decision model judges each answer to a reviewer finding before its thread is resolved");
  if (kind.name === "harness") return PASS("finding check", "the stage's own harness judges each answer to a reviewer finding before its thread is resolved");
  return WARN("finding check", `off (${kind.code}): reviewer findings are not judged; Pendulum's reply answers each one`, kind.route === "off" ? "set decision_route to auto (INSTALL.md)" : env.GITHUB_ACTIONS ? "pass an AI_GATEWAY_API_KEY secret as the workflow's ai_gateway_api_key, or set decision_route to auto (PLAN.md, Red-check triage)" : "save an AI Gateway key in ~/.config/pendulum/ai-gateway-key (LOCAL.md, step 4), or set decision_route to auto");
}

/**
 * What a `permissions:` value gives the job token on repository contents: "read", "write" or "none" (a mapping without
 * `contents`, `{}` included); null when it is not set, so the level above (or the repository's default) applies; and
 * "unknown" for a value GitHub does not take.
 */
export function contentsAccess(perms) {
  if (perms === undefined || perms === null) return null;
  if (typeof perms === "string") return { "read-all": "read", "write-all": "write" }[perms.trim()] ?? "unknown";
  if (typeof perms !== "object" || Array.isArray(perms)) return "unknown";
  if (!Object.hasOwn(perms, "contents")) return "none";
  const v = typeof perms.contents === "string" ? perms.contents.trim() : "";
  return ["read", "write", "none"].includes(v) ? v : "unknown";
}

/**
 * The job token row: whether every job of pendulum.yml is read-only on repository contents, from the parsed workflow. A
 * job's own `permissions:` replaces the top level's (GitHub's rule); a job with neither gets the repository's default
 * token, which doctor does not count on (the default is a setting outside the file).
 */
export function jobTokenCheck(text) {
  const fix = "set permissions: contents: read (or none) at the top of pendulum.yml and in every job that sets its own; writes go through the App";
  let doc;
  try {
    doc = parseYaml(text);
  } catch (e) {
    return FAIL("job token", `could not read the workflow's permissions: ${e.message}`, "fix pendulum.yml's YAML");
  }
  const top = contentsAccess(doc?.permissions);
  const jobs = doc?.jobs && typeof doc.jobs === "object" && !Array.isArray(doc.jobs) ? Object.entries(doc.jobs) : [];
  const bad = [];
  for (const [id, job] of jobs.length ? jobs : [["(no jobs)", null]]) {
    const own = contentsAccess(job?.permissions);
    const access = own ?? top;
    if (access === "read" || access === "none") continue;
    const where = own === null ? "the top level's" : "its own";
    bad.push(access === null ? `${id} (no permissions here or at the top level, so the repository's default token)` : access === "write" ? `${id} (contents: write, ${where})` : `${id} (${where} permissions are no value GitHub takes)`);
  }
  return bad.length ? FAIL("job token", `a job's token may write repository contents: ${bad.join("; ")}`, fix) : PASS("job token", "every job's token reads repository contents at most");
}

/**
 * A workflow on pull_request (or pull_request_target) starts a job only for the review label the App applies: some job's
 * `if:` compares the event's label with REVIEW_LABEL. Read from the parsed jobs, so a comment naming the label is no guard.
 * Null when the workflow has no such trigger, or its YAML does not parse (the job token row FAILs on that).
 */
export function reviewGuardCheck(text) {
  let doc;
  try {
    doc = parseYaml(text);
  } catch {
    return null;
  }
  if (!workflowEvents(doc).some((e) => e === "pull_request" || e === "pull_request_target")) return null;
  const guard = `github.event.label.name == '${REVIEW_LABEL}'`;
  const jobs = doc?.jobs && typeof doc.jobs === "object" && !Array.isArray(doc.jobs) ? Object.entries(doc.jobs) : [];
  const guarded = jobs.filter(([, job]) => typeof job?.if === "string" && job.if.includes(guard)).map(([id]) => id);
  return guarded.length ? PASS("workflow triggers", `pull_request trigger; the ${REVIEW_LABEL} label guards ${guarded.join(", ")}`) : WARN("workflow triggers", `pull_request trigger without the ${REVIEW_LABEL} label guard`, `the review job must be guarded by the label the App applies: if: ${guard}`);
}

/**
 * Whether the repository variable PENDULUM_APP_ID (APP_ID_VARIABLE, which `pendulum setup` writes beside the secret) names
 * the App the job runs as (`appId`, the app_id input): `pendulum report` reads it to tell Pendulum's App's comments from
 * another App's. On Actions only, where both are in reach without a call (`variable`: the `vars` input's value). A WARN with
 * the one-time write when it is missing or names another App; no row without an App id.
 */
export function appIdVariableCheck({ variable, appId, repo }) {
  const id = String(appId ?? "").trim();
  if (!/^\d+$/.test(id)) return null;
  const fix = `gh variable set ${APP_ID_VARIABLE} --repo ${repo.full} --body <the App's numeric id, the ${APP_ID_VARIABLE} secret's value> (setup's app step writes it for a new App)`;
  if (variable === null || variable === undefined || String(variable).trim() === "") return WARN("app id variable", `the repository variable ${APP_ID_VARIABLE} is not set, so \`pendulum report\` cannot tell Pendulum's App's comments from another App's without --app`, fix);
  if (String(variable).trim() !== id) return WARN("app id variable", `the repository variable ${APP_ID_VARIABLE} names another App than the app_id input`, fix);
  return PASS("app id variable", `${APP_ID_VARIABLE} names the App the jobs run as`);
}

/**
 * Local mode (#564): the repository variable PENDULUM_APP_ID, from the variables list doctor read (`listed`), else, the
 * list refused, read alone with the gh login's token (`fallback`, unless it is `token`, the one refused), and its local
 * copy for `pendulum report` saved or brought up to date (lib/app-id.mjs learnAppId). A WARN, with the `gh variable set` line, when it is not set; a WARN when
 * neither token may read it and no local copy is there; a WARN for a copy whose place is not safe.
 */
export async function localAppIdCheck({ repo, listed, token = null, fallback = ghLoginToken, home = homedir() }) {
  const name = "app id variable";
  const fix = `${appIdSetLine(repo.full)} (setup's app step writes it for a new App)`;
  let r;
  try {
    r = await learnAppId(repo, { listed, token, fallback, home });
  } catch (e) {
    return WARN(name, `${APP_ID_VARIABLE} was not read (${e.status ? `HTTP ${e.status}` : String(e.message).slice(0, 80)})`, "run doctor again");
  }
  const copy = r.copy ? `; \`pendulum report\` takes the local copy, ${r.copy} (${r.file}), meanwhile` : "";
  if (r.problem) return WARN(name, `the local copy of Pendulum's App id for \`pendulum report\` is not taken: ${r.problem}`, "fix it as said, then run doctor again: it saves the copy");
  if (r.from === "unset") return WARN(name, `the repository variable ${APP_ID_VARIABLE} ${appIdWhyText(r)}, so \`pendulum report\` cannot tell Pendulum's App's comments from another App's without --app${copy}`, fix);
  if (r.from === "forbidden") return r.copy ? PASS(name, `${APP_ID_VARIABLE} could not be read (neither the local token nor a gh login may read the repository's variables); \`pendulum report\` takes the local copy, ${r.copy} (${r.file})`) : WARN(name, `${APP_ID_VARIABLE} could not be read: neither the local token nor a gh login may read the repository's variables, so \`pendulum report\` has no App id (app-unreadable) and no local copy was saved`, "log in with gh (gh auth login) or give the local token Variables: read, then run doctor again");
  return PASS(name, `${APP_ID_VARIABLE} is ${r.id}${r.from === "variable-gh" ? " (read with the gh login: the local token may not read it)" : ""}; its local copy for \`pendulum report\` is ${r.file}${r.saved ? " (saved now)" : ""}`);
}

export async function githubChecks({ inputs, repo, token, app, notice = false, env = process.env, job = !!env.GITHUB_ACTIONS, local = backend(env).name === "local", probeRerun = rerunProbeCheck, accounts = env.PENDULUM_ACCOUNTS }) {
  const out = [];
  if (!token && env.GITHUB_ACTIONS) {
    out.push(FAIL("app token", "no installation token", "set PENDULUM_APP_ID and PENDULUM_APP_PRIVATE_KEY secrets and pass them as app_id / app_private_key"));
    return out;
  }
  // A developer's run: the job mints the App token, so here the secrets are checked by name (the repository's and the
  // organization's visible to it), and GitHub is read with the developer's own gh login.
  if (!token) out.push(...(await secretChecks({ inputs, repo, accounts })));
  else if (app?.appSlug) {
    out.push(...appPermissionChecks(app));
  } else if (token) out.push(PASS("app token", backend().name === "local" ? "local mode's token for this repository; permissions not verified" : "PENDULUM_APP_TOKEN supplied; permissions not verified"));
  // Local red-check triage (the gateway's model with a key, else the stage's harness) reruns flaky reds with this token:
  // doctor checks it may (not in a stage), unless no decision call runs (decision_route off, or gateway with no key).
  if (local && !job && token && deciderKind({ inputs, env }).name !== "off") out.push(await probeRerun({ repo, token }));
  // Which decider answers the decision calls (red-check triage, the drift advisory): where the key is read, a job or local mode.
  if (job || local) out.push(deciderCheck({ inputs, env }));
  // Where the key is in reach (local mode's file, the job's input): whether reviewer findings are judged.
  if (local || job) out.push(findingCheckRow({ inputs, env }));

  // The workflow as the default branch on GitHub has it (what the next run uses), not a local copy that may be behind.
  const repoData = await getRepo(repo, { token });
  const branch = repoData.default_branch;
  const wfRead = await workflowText({ repo, branch, token, env });
  out.push(...wfRead.checks);
  const text = wfRead.text;
  // The job token: read-only on code. Visible only inside Actions, through the workflow file.
  if (text !== null) {
    out.push(jobTokenCheck(text));
    const pin = pinRow(pendulumRef(text));
    if (pin) out.push(pin);
    // A session's skills and scripts are the installed plugin's, not the Action's: in a job they are the same tree.
    const plugin = job ? null : pluginVersionCheck(text);
    if (plugin) out.push(plugin);
    const guard = reviewGuardCheck(text);
    if (guard) out.push(guard);
    out.push(mergeTickCheck(text, env, { job }));
    const vars = varsInputCheck(text);
    if (vars) out.push(vars);
    out.push(ownedTickCheck(text, env, { job }));
    out.push(...workflowSecretChecks(text));
    const waits = longWaitCheck(repoData);
    if (waits) out.push(waits);
  }
  // Local mode uploads no usage artifact; every other route does. In a job its own setting, else the workflow file's.
  if (!local) out.push(transcriptCheck(repoData, job ? inputs.publishTranscripts : publishOn(workflowValue(text, "PENDULUM_PUBLISH_TRANSCRIPTS"))));
  const sealRow = local ? null : sealKeyCheck({ appPrivateKey: inputs.appPrivateKey, repoFull: repo.full });
  if (sealRow) out.push(sealRow);
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
  out.push(queue ? PASS("merge queue", `on for ${branch}`) : checks.length ? WARN("merge queue", `no merge_queue rule on ${branch}; required checks gate merges, but concurrent Objectives are not re-tested on the integrated head`, repoData.owner?.type === "User" ? "GitHub offers no merge queue on a repository a user owns; keep max_concurrent low, or move it to an organization" : "node scripts/setup.mjs --apply protection (or Settings > Rules)") : FAIL("merge queue", `no merge_queue rule on ${branch}`, "node scripts/setup.mjs --apply protection (or Settings > Rules)"));
  // Only a merge queue drops PRs: without one, the dequeued run never fires and the policy is not read.
  if (queue) out.push(...approvalPolicyCheck(await rest(`repos/${repo.full}/actions/permissions/fork-pr-contributor-approval`, { token: inputs.githubToken || token }).catch((e) => ({ error: e.status || "error" }))));
  out.push(checks.length ? PASS("required checks", checks.join(", ")) : FAIL("required checks", `none required on ${branch}`, "require the CI workflow's checks: setup --apply protection --ci-checks <names>"));
  // The merge queue squashes with the repository's defaults: the branch's commit messages would land on the default
  // branch, where a closing keyword in one closes that issue. Pendulum's own merge sets its message itself.
  const squash = [repoData.squash_merge_commit_title, repoData.squash_merge_commit_message];
  if (queue && ((squash[0] && squash[0] !== "PR_TITLE") || (squash[1] && !["PR_BODY", "BLANK"].includes(squash[1])))) out.push(FAIL("squash message", `squash commits default to ${squash.join(" and ")}`, "setup --apply protection sets them to the PR's title and body (Settings > General > Pull Requests > Allow squash merging: Default to pull request title and description)"));
  // Listing workflows needs `actions: read`: the job token's (workflow-template.yml), never the App's.
  // The CI workflow is the one whose jobs make the required checks; with none required, the one on pull_request.
  const ci = await ciWorkflowTriggers(repo, { token: inputs.githubToken || token }, { checks });
  out.push(ciWorkflowCheck(ci, { queue }));
  const runner = text !== null ? runnerMatchCheck(text, ci, { commands: [inputs.setup, ...inputs.validation], checks: [...checks, ...inputs.ciChecks] }) : null;
  if (runner) out.push(runner);
  // Cross-OS CI (lib/cross-os.mjs): its workflow's dispatch trigger, the route's token, and the runner minutes' cost.
  out.push(...(await crossOsRows({ inputs, repo, branch, token, local })));
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
  if (ci.pendulumParses === false) out.push(FAIL("workflow file", "GitHub cannot parse .github/workflows/pendulum.yml (it lists the file by its path, not its name) and runs none of it", "fix its YAML; quote a value that holds \": \", such as validation commands marked parallel:"));

  const label = await rest(`repos/${repo.full}/labels/${encodeURIComponent(inputs.objectiveLabel)}`, { token }).catch(() => null);
  out.push(label ? PASS("label", inputs.objectiveLabel) : FAIL("label", `${inputs.objectiveLabel} missing`, "setup --apply labels"));
  const project = await findProject(repo, { token, project: inputs.project }).catch(() => null);
  // A local loop's token is scoped to the one repository and usually cannot see an organisation's projects: the
  // board is then out of view, card moves are skipped, and the labels carry the state, as the dispatcher already does.
  // A local token is scoped to one repository: an organisation's board may be out of its sight with or without an error
  // (an empty list), and labels carry the state either way.
  // A personal account's board is out of every GitHub App's reach (Projects is an organization permission): no board,
  // labels carry the state (#199).
  if (!project && repoData.owner?.type === "User") out.push(WARN("project board", "a repository a user owns has no board Pendulum can move: labels carry each Objective's state", "none needed; move the repository to an organization for the board"));
  else if (!project && backend().name === "local") out.push(WARN("project board", "not visible to the local token; cards will not move and labels carry the state", "grant the token the organisation's Projects read and write permission to move cards"));
  else if (!project) out.push(FAIL("project board", "no Pendulum project linked to the repository", "setup --apply project"));
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
    out.push(WARN("maintainers", `named without a user id, so not trusted: ${unpinned.map((m) => m.login).join(", ")}`, `write each as login#id in PENDULUM_NOTIFY and PENDULUM_MAINTAINERS: ${pins.join(", ")} (an id outlives a rename; a login renamed away could be registered by anyone)`));
  }
  if (inputs.notify) {
    const perm = await collaboratorPermission(repo, inputs.notify, { token });
    out.push(perm && perm !== "none" ? PASS("notify", `@${inputs.notify} has ${perm}`) : FAIL("notify", `@${inputs.notify} has no access to the repository`, "set notify to a collaborator's handle"));
  } else out.push(WARN("notify", "empty", "set notify so Blocked and Question reach a phone"));
  out.push(...noticeChecks({ inputs, notice }));
  return out;
}

/**
 * Doctor's row for the setting, from the resolved inputs, the named workflow as the default branch has it (`doc`, parsed:
 * null when it could not be read, with `readError`) and the route: off, nothing; a problem, FAIL; a workflow that cannot
 * be dispatched for the legs (cross-os.mjs workflowProblem: no `workflow_dispatch` trigger, or `permissions:` granting
 * write at the top or on any job, named), FAIL; one it could not read, WARN; else a PASS that names the legs, the token
 * that dispatches them (on the cloud sandbox route the launch-event job's, since the launcher dispatches for the stage),
 * the bound and the cost, since macOS and Windows runner minutes bill at a higher rate.
 */
export function crossOsRow(inputs, { doc = null, readError = "", route = "actions" } = {}) {
  const { setting, problem } = crossOs(inputs);
  if (!setting && !problem) return null;
  if (problem) return FAIL("cross-OS CI", problem, "set cross_os_workflow and cross_os_checks together in the workflow's env block (docs/INSTALL.md, Cross-OS CI)");
  if (doc === null) return WARN("cross-OS CI", `could not read .github/workflows/${setting.workflow}${readError ? ` (${readError})` : ""}`, "check cross_os_workflow names a workflow file on the default branch");
  const bad = workflowProblem(doc, setting.workflow);
  if (bad) return FAIL("cross-OS CI", bad, "give the workflow a `workflow_dispatch:` trigger running its macOS and Windows legs, and read-only permissions at the top and on every job: each scope `read` or `none` (contents: read), or `read-all` or `{}`; no scope at `write` and no `write-all`");
  const token = route === "local" ? "the repository token's Actions read and write" : route === "sandbox" ? "the launch-event job's `actions: write`: the launcher dispatches it for the sandbox stage" : "the work job's `actions: write`";
  return PASS("cross-OS CI", `on: the work stage runs ${setting.workflow} on each head it validates (with ${token}) and waits up to ${Math.round(setting.waitMs / 60_000)} min per head for ${setting.checks.join("; ")}; macOS and Windows runner minutes bill at a higher rate than Linux minutes`);
}

/**
 * crossOsRow for this repository: the named workflow read from the default branch (`branch`) with `token`, and the route
 * (local mode, a cloud sandbox from `inputs.sandbox`, else Actions). Nothing when the setting is off.
 */
export async function crossOsRows({ inputs, repo, branch, token, local = backend().name === "local" }) {
  const { setting } = crossOs(inputs);
  const route = local ? "local" : inputs.sandbox ? "sandbox" : "actions";
  if (!setting) {
    const row = crossOsRow(inputs, { route });
    return row ? [row] : [];
  }
  let doc = null;
  let readError = "";
  try {
    doc = parseYaml(String(await rest(`repos/${repo.full}/contents/.github/workflows/${encodeURIComponent(setting.workflow)}?ref=${encodeURIComponent(branch)}`, { token, raw: "Accept: application/vnd.github.raw+json" }))) ?? {};
  } catch (e) {
    readError = e.status ? `HTTP ${e.status}` : String(e.message || e).slice(0, 80);
  }
  return [crossOsRow(inputs, { doc, readError, route })];
}

/**
 * Branch code runs in CI, so CI's own token must not write: the repository's default workflow token is read-only, and no
 * workflow that runs on `pull_request`, `pull_request_target` or `merge_group` grants write at the top or on any job
 * (lib/yaml.mjs writeGrants: anything but `read`, `none`, `read-all` and `{}`), each grant named. Every page of the
 * workflow list is read and each workflow parsed (lib/yaml.mjs); one doctor cannot read, or cannot parse, FAILs. When
 * the default cannot be read with this token, every such workflow must set read-only permissions itself. Pendulum's own
 * workflow is the exception: it runs branch code only as the agent uid, which cannot read the job's env.
 */
export async function workflowTokenChecks({ repo, token }) {
  const out = [];
  const perms = await rest(`repos/${repo.full}/actions/permissions/workflow`, { token }).catch((e) => ({ error: e.status || e.message }));
  const defaultRead = perms?.error ? null : perms?.default_workflow_permissions === "read";
  if (perms?.error) out.push(WARN("default workflow token", `could not read the repository's default (${perms.error}; it needs admin), so every pull_request and merge_group workflow must set read-only permissions itself`, "run doctor with a gh login that administers the repository, or check Settings > Actions > Workflow permissions: read"));
  else if (!defaultRead) out.push(FAIL("default workflow token", `the default GITHUB_TOKEN can write (${perms?.default_workflow_permissions})`, "node scripts/setup.mjs --apply default-token (its dry run names the workflows the change reaches), or Settings > Actions > General > Workflow permissions: Read repository contents and packages permissions"));
  else out.push(PASS("default workflow token", "read-only by default"));
  let list;
  try {
    list = (await rest(`repos/${repo.full}/actions/workflows?per_page=100`, { token, paginate: true })) || [];
  } catch (e) {
    return [...out, FAIL("ci token", `could not list workflows (${e.status || e.message})`, "give the job token actions: read")];
  }
  const bad = [];
  for (const w of list) {
    // Pendulum's own workflow; GitHub's dynamic ones (code scanning's default setup), which are no file in the repository.
    if (/(^|\/)pendulum\.ya?ml$/.test(w.path) || /^dynamic\//.test(w.path)) continue;
    let doc;
    try {
      doc = parseYaml(String(await rest(`repos/${repo.full}/contents/${w.path}`, { token, raw: "Accept: application/vnd.github.raw+json" })));
    } catch (e) {
      // Listed but not on the default branch (it ran from a branch once): nothing runs from it on the default branch, and
      // a branch Pendulum pushes cannot add one (.github/ is a protected path).
      if (e.status === 404) continue;
      bad.push(`${w.path} (${e.status ? `HTTP ${e.status}` : String(e.message).slice(0, 80)})`);
      continue;
    }
    if (!workflowEvents(doc).some((e) => ["pull_request", "pull_request_target", "merge_group"].includes(e))) continue;
    const top = writeGrants(doc?.permissions);
    if (top === null && defaultRead !== true) bad.push(`${w.path} (no read-only permissions of its own${defaultRead === false ? "; the default can write" : ""})`);
    else if (top?.length) bad.push(`${w.path} (top-level permissions grant ${top.join(", ")})`);
    for (const [name, job] of Object.entries(doc?.jobs || {})) {
      const g = writeGrants(job?.permissions);
      if (g?.length) bad.push(`${w.path} job ${name} (permissions grant ${g.join(", ")})`);
    }
  }
  out.push(bad.length ? FAIL("ci token", `branch code would run with a token that can write: ${bad.join("; ")}`, "give every workflow that runs on pull_request or merge_group read-only permissions at the top and on every job: each scope `read` or `none` (contents: read), or `read-all` or `{}`; no scope at `write` and no `write-all`") : PASS("ci token", "no pull_request or merge_group workflow can write"));
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
 * Pendulum's runner jobs need Linux: the agent launcher wants systemd-run, or unshare with cgroup v2 (runnerChecks).
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
  try {
    return jobsOf(parseYaml(text));
  } catch {
    return [];
  }
}

/** workflowJobs of a parsed workflow. */
function jobsOf(doc) {
  return Object.entries(doc?.jobs || {}).map(([id, job]) => ({
    check: typeof job?.name === "string" && !job.name.includes("${{") ? job.name : id,
    runner: runnerLabel(job?.["runs-on"]),
    commands: (Array.isArray(job?.steps) ? job.steps : []).map((s) => (typeof s?.run === "string" ? s.run : "")).filter(Boolean),
  }));
}

/**
 * The CI runner Pendulum's work and review jobs should use: among the CI workflow's Linux jobs, the one that runs the
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
  const req = jobs.find((j) => checks.some((c) => makesCheck(j, c)));
  if (req) return { runner: req.runner, linux, job: `its ${req.check} job, a required check` };
  const j = (linux.length > 1 && jobs.find((x) => !/-latest"?\]?$/.test(x.runner))) || jobs[0];
  return { runner: j.runner, linux, job: `its ${j.check} job` };
}

/**
 * Pendulum's runner-path jobs (work, review) run the repository's setup command, so they need the runner its CI uses:
 * `ubuntu-latest` moves to a new image under them while a pinned CI keeps passing (#2600). A warning: the owner may
 * pick another runner on purpose. It also warns on a container-only runner and on a runner label it cannot read
 * (either side). Nothing to compare in sandbox mode (no runner jobs) or when the CI has no Linux job with a literal
 * runner. `ci` is the workflow that makes the required checks, else the one on pull_request (githubChecks): a render
 * made with setup's `--ci-workflow NAME` is compared against that workflow, not NAME. `hints`: ciRunner's.
 */
export function runnerMatchCheck(pendulumText, ci, hints = {}) {
  let jobs;
  try {
    jobs = parseYaml(pendulumText)?.jobs || {};
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
 * Find a workflow (other than pendulum.yml) with pull_request and merge_group triggers, or with `name`, the workflow of
 * that name, or with `checks` (the required checks' names), each check's makers by event (checkWorkflows). Each
 * workflow's `on:` is read from its parsed YAML (workflowEvents). `jobs`: its jobs (workflowJobs).
 * `unread`: the workflows that could not be read or parsed here, whose triggers are unknown (each with its reason).
 */
export async function ciWorkflowTriggers(repo, opts, { name = "", checks = [] } = {}) {
  let list;
  try {
    list = (await rest(`repos/${repo.full}/actions/workflows?per_page=100`, opts))?.workflows || [];
  } catch (e) {
    return { found: false, error: `${e.status || ""} ${e.message.slice(0, 120)}`.trim() };
  }
  if (checks.length && !name) return checkWorkflows(repo, opts, list, checks);
  let found = null;
  const unread = [];
  // GitHub lists a workflow file it cannot parse under its path instead of its name, and runs nothing from it.
  const pendulum = list.find((w) => /(^|\/)pendulum\.ya?ml$/.test(w.path));
  const pendulumParses = pendulum ? pendulum.name !== pendulum.path : null;
  for (const w of list) {
    if (/pendulum\.ya?ml$/.test(w.path) || w.state !== "active") continue;
    const named = Boolean(name) && w.name === name;
    if (name && !named) continue;
    let doc = null;
    try {
      doc = parseYaml(String(await rest(`repos/${repo.full}/contents/${w.path}`, { ...opts, raw: "Accept: application/vnd.github.raw+json" })));
    } catch (e) {
      // Listed but not on the default branch (it ran from a branch once): nothing runs from it on the default branch.
      if (e.status === 404 && !named) continue;
      unread.push(`${w.path} (${e.status ? `HTTP ${e.status}` : String(e.message).slice(0, 80)})`);
    }
    // GitHub lists a workflow it cannot parse by its path, as it also names one with no `name:`: a file that sets a
    // name and is listed by its path is one GitHub runs nothing from.
    if (doc && w.name === w.path && typeof doc.name === "string" && doc.name !== w.path && !named) continue;
    const events = workflowEvents(doc);
    const mg = events.includes("merge_group");
    if (events.includes("pull_request") || named) {
      found = { found: true, name: w.name, path: w.path, mergeGroup: mg, jobs: doc ? jobsOf(doc) : [], pendulumParses };
      if (mg || named) return { ...found, unread };
    }
  }
  return found ? { ...found, unread } : { found: false, pendulumParses, unread };
}

/** Whether a workflow job (workflowJobs) makes the check `name`: its own name, a matrix leg's, or a called workflow's job. */
const makesCheck = (job, name) => name === job.check || name.startsWith(`${job.check} (`) || name.startsWith(`${job.check} / `);

/** The events on which a check a workflow makes reaches a pull request (its own head) or the merge queue's commit. */
const PR_EVENTS = ["pull_request", "pull_request_target"];

/**
 * ciWorkflowTriggers with the required checks known, decided per check: `byCheck` holds, for each of `checks`, the
 * workflows (other than pendulum.yml) with a job that makes it (makesCheck), split by the events they run on: `pr` (on
 * pull_request or pull_request_target), `mg` (on merge_group) and `other` (neither: a release, a schedule), each a list
 * of {name, path}. A workflow on other events never counts as making a check a pull request or the queue gets. `unread`:
 * the workflows that could not be read or parsed, any of which could make any check. `found`, `name`, `path` and `jobs`
 * are the pull_request makers' (ciRunner's). The reading stops once every check has a maker on pull_request and one on
 * merge_group: no later workflow can change the row.
 */
async function checkWorkflows(repo, opts, list, checks) {
  const pendulum = list.find((w) => /(^|\/)pendulum\.ya?ml$/.test(w.path));
  const pendulumParses = pendulum ? pendulum.name !== pendulum.path : null;
  const unread = [];
  const byCheck = checks.map((check) => ({ check, pr: [], mg: [], other: [] }));
  const prMakers = [];
  for (const w of list) {
    if (byCheck.every((c) => c.pr.length && c.mg.length)) break;
    if (/pendulum\.ya?ml$/.test(w.path) || w.state !== "active") continue;
    let doc;
    try {
      doc = parseYaml(String(await rest(`repos/${repo.full}/contents/${w.path}`, { ...opts, raw: "Accept: application/vnd.github.raw+json" })));
    } catch (e) {
      // Listed but not on the default branch (it ran from a branch once): nothing runs from it on the default branch.
      if (e.status !== 404) unread.push(`${w.path} (${e.status ? `HTTP ${e.status}` : String(e.message).slice(0, 80)})`);
      continue;
    }
    // Listed by its path though it sets a name: GitHub could not parse it and runs nothing from it.
    if (w.name === w.path && typeof doc?.name === "string" && doc.name !== w.path) continue;
    const jobs = jobsOf(doc);
    const events = workflowEvents(doc);
    const onPr = events.some((e) => PR_EVENTS.includes(e));
    const onMg = events.includes("merge_group");
    const me = { name: w.name, path: w.path };
    let makes = false;
    for (const c of byCheck) {
      if (!jobs.some((j) => makesCheck(j, c.check))) continue;
      makes = true;
      if (onPr) c.pr.push(me);
      if (onMg) c.mg.push(me);
      if (!onPr && !onMg) c.other.push({ ...me, events });
    }
    if (makes && onPr) prMakers.push({ ...me, jobs });
  }
  return { found: prMakers.length > 0, name: prMakers.map((w) => w.name).join(", "), path: prMakers.map((w) => w.path).join(", "), paths: prMakers.map((w) => w.path), jobs: prMakers.flatMap((w) => w.jobs), pendulumParses, unread, checks, byCheck };
}

/**
 * The ci workflow row, from ciWorkflowTriggers's result: a workflow on pull_request and merge_group, the second needed
 * only with a merge queue (`queue`). With the required checks known (`byCheck`), each check on its own: a workflow on
 * pull_request must make it, else a pull request never gets it; with a queue, one on merge_group too, else the queue's
 * commit never does. A check no workflow doctor read makes at all is a WARN naming it, since an App's check or a
 * workflow doctor could not read may make it; and with any workflow unread, no FAIL rests on the rest either. Without
 * required checks, a workflow doctor could not read or parse may be the one listening: its triggers are unknown, so no
 * FAIL rests on it and the WARN names it.
 */
export function ciWorkflowCheck(ci, { queue = false } = {}) {
  const unread = ci.unread?.length ? `; could not read the triggers of ${ci.unread.join(", ")}` : "";
  const readFix = "make each workflow named readable to the token (contents: read) and valid YAML, then run doctor again";
  if (ci.error) return WARN("ci workflow", `could not list workflows (${ci.error})`, "give the job token actions: read (permissions: in the workflow), or run doctor with a gh login that can read Actions");
  if (ci.byCheck?.length) return requiredCheckRow(ci.byCheck, { queue, unread: ci.unread || [], readFix });
  if (!ci.found) return unread ? WARN("ci workflow", `no workflow doctor read listens on pull_request${unread}`, readFix) : FAIL("ci workflow", "no workflow listens on pull_request", "add a CI workflow on pull_request and merge_group; the queue needs checks on its commit");
  if (!ci.mergeGroup) return (queue && !unread ? FAIL : WARN)("ci workflow", `${ci.name} listens on pull_request but not merge_group${queue ? "" : " (needed only with a merge queue)"}${unread}`, `add "merge_group:" under on: in ${ci.path}${unread ? `, or ${readFix}` : ""}`);
  return PASS("ci workflow", `${ci.name} on pull_request and merge_group`);
}

const names = (ws) => [...new Set(ws.map((w) => w.name))].join(", ");
const paths = (ws) => [...new Set(ws.map((w) => w.path))].join(", ");

/** ciWorkflowCheck's row with the required checks known: each check's makers on pull_request and on merge_group. */
function requiredCheckRow(byCheck, { queue, unread, readFix }) {
  const fails = [];
  const warns = [];
  const fixes = [];
  // A check no workflow doctor read makes on any event: an App's, or an unread workflow's.
  const unknown = byCheck.filter((c) => !c.pr.length && !c.mg.length && !c.other.length);
  // Made by a workflow, but by none on pull_request: a pull request never gets it, so it is never enqueued.
  const noPr = byCheck.filter((c) => !c.pr.length && (c.mg.length || c.other.length));
  // Made on pull_request, but by no workflow on merge_group: the queue's commit never gets it.
  const noMg = byCheck.filter((c) => c.pr.length && !c.mg.length);
  const sure = unread.length ? warns : fails;
  for (const c of noPr) {
    const by = [...c.mg.map((w) => ({ ...w, events: ["merge_group"] })), ...c.other];
    sure.push(`${c.check} is made only by ${by.map((w) => `${w.name} (on ${w.events.join(", ")})`).join(", ")}, so a pull request never gets it`);
    fixes.push(c.mg.length ? `add "pull_request:" under on: in ${paths(c.mg)}` : `make ${c.check} in a workflow on pull_request (only ${paths(c.other)} makes it now, on other events)`);
  }
  for (const c of noMg) {
    (queue ? sure : warns).push(`${c.check} is made on pull_request by ${names(c.pr)} but by no workflow on merge_group${queue ? ", so the queue's commit never gets it" : " (needed only with a merge queue)"}`);
    fixes.push(`add "merge_group:" under on: in ${paths(c.pr)}`);
  }
  if (unknown.length) {
    warns.push(`no workflow doctor read makes ${unknown.map((c) => c.check).join(", ")}, so doctor cannot tell what runs ${unknown.length === 1 ? "it" : "them"} (an App's check, or a workflow doctor could not read)`);
    fixes.push(`name each required check after a CI job (its name, else its id), or make sure what makes it (an App's check) runs on${queue ? " pull_request and merge_group" : " pull_request"}`);
  }
  const unreadText = unread.length ? `; could not read the triggers of ${unread.join(", ")}` : "";
  if (unread.length && (warns.length || fails.length)) fixes.push(readFix);
  const made = byCheck.filter((c) => c.pr.length && c.mg.length);
  if (fails.length) return FAIL("ci workflow", [...fails, ...warns].join("; ") + unreadText, fixes.join("; "));
  if (warns.length) return WARN("ci workflow", warns.join("; ") + unreadText, fixes.join("; "));
  return PASS("ci workflow", `the required checks run on pull_request and merge_group: ${made.map((c) => `${c.check} (${names([...c.pr, ...c.mg])})`).join(", ")}`);
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
 * Whether every Pendulum step of the installed workflow passes the repository's variables (`vars: ${{ toJSON(vars) }}`,
 * workflow-template.yml): without it the Action's jobs have no variable layer (#284, inputs.mjs applyVariables), and a
 * variable that applies in local mode does not apply there. WARN naming the re-render; null for a file that does not parse.
 */
export function varsInputCheck(text) {
  let doc = null;
  try {
    doc = parseYaml(text);
  } catch {
    return null;
  }
  const jobs = doc?.jobs && typeof doc.jobs === "object" ? doc.jobs : {};
  const steps = Object.values(jobs).flatMap((j) => (Array.isArray(j?.steps) ? j.steps : [])).filter((st) => /^clockgrove\/pendulum@/.test(String(st?.uses ?? "")));
  if (!steps.length) return null;
  const without = steps.filter((st) => !String(st?.with?.vars ?? "").includes("toJSON(vars)")).length;
  if (!without) return PASS("variables input", "every Pendulum step passes the repository's variables");
  return WARN("variables input", `${without} of the workflow's ${steps.length} Pendulum steps pass${without === 1 ? "es" : ""} no vars, so the repository's PENDULUM_* variables do not apply on Actions there`, "re-run setup --apply workflow and commit the result");
}

/**
 * Whether the installed workflow carries the dispatcher's own ticks (workflow-template.yml): any issue closing (it may
 * block an Objective), the wake job (a stage's lease end, a quota retry, the UTC day's turn, one retry), and with a
 * sandbox the launch job's tick on its own failure, the sweep's own wakes (sweep-wake, image-wake) and the dispatcher's
 * owed image build (image_owed), and, with third-party reviewers named, an App's review on a Pendulum PR
 * (pull_request_review, filtered to a Bot reviewer), which resumes a review stage that ended waiting for one. A workflow rendered before them leaves those waits to GitHub's cron,
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
  // The sweep's wake armed by the sweep or the image job: a `<job>-wake` job ticking with that job's deadline, and the sweep running on that tick.
  const ownWake = (name) => {
    const w = jobs[`${name}-wake`];
    return !!w && String(w.needs) === name && /gh workflow run pendulum\.yml -f wake=/.test(String(w.steps?.[0]?.run || "")) && /inputs\.wake/.test(String(jobs.sweep?.if || "")) && /steps\.f\.outputs\.wake_at/.test(String(jobs[name]?.outputs?.wake_at || ""));
  };
  const owedBuild = /steps\.f\.outputs\.image_owed/.test(String(jobs.dispatch?.outputs?.image_owed || "")) && /needs\.dispatch\.outputs\.image_owed/.test(String(jobs.image?.if || ""));
  const ticks = (j) => (jobs[j]?.steps || []).some((s) => /gh workflow run pendulum\.yml/.test(s?.run || "") && /steps\.f\.outcome != 'success'/.test(String(s?.if || "")) && /exit == 'deferred'/.test(String(s?.if || "")));
  const missing = [
    ...((on?.issues?.types || []).map(String).includes("closed") && /action == 'closed' \|\|/.test(String(jobs.dispatch?.if || "")) ? [] : ["a dispatcher tick on a closed issue"]),
    ...(jobs.wake && on?.workflow_dispatch?.inputs?.wake ? [] : ["the wake job"]),
    ...(jobs["launch-gate"] && !(ticks("launch") && ticks("launch-event")) ? ["the launch jobs' tick on a failed or deferred launch"] : []),
    ...(jobs["launch-gate"] && !ownWake("sweep") ? ["the sweep's own wake (sweep-wake)"] : []),
    ...(jobs["launch-gate"] && !(ownWake("image") && /cancelled\(\)|always\(\)/.test(String(jobs["image-wake"]?.if || ""))) ? ["the sweep's wake after an image build (image-wake) that runs past a skipped dispatcher"] : []),
    ...(jobs["launch-gate"] && !owedBuild ? ["the dispatcher's owed image build (image_owed)"] : []),
    ...(thirdPartyNamed(doc, jobs) && !(on?.pull_request_review && /github\.event_name == 'pull_request_review' && github\.event\.review\.user\.type == 'Bot'/.test(String(jobs.dispatch?.if || ""))) ? ["a dispatcher tick on a third-party reviewer's review (pull_request_review, from an App only)"] : []),
  ];
  if (!missing.length) return PASS("dispatcher ticks", `a closed issue, a failed launch and the waits only time ends tick the dispatcher on time${jobs["launch-gate"] ? "; the sandbox sweep arms its own wakes and an owed image build runs on the day's first tick" : ""}`);
  return (job ? WARN : FAIL)("dispatcher ticks", `the workflow lacks ${missing.join(", ")}: an Objective whose start failed or was deferred, whose blocker closed, or whose stage died, a review waiting for a third-party reviewer, a sandbox left to sweep or an image build an earlier day left, stalls until GitHub's cron fires, often hours late`, "re-run setup --apply workflow and commit the result");
}

/** Whether the workflow names third-party reviewers: PENDULUM_THIRD_PARTY_REVIEWERS in its env block, or `third_party_reviewers` on a step. */
const thirdPartyNamed = (doc, jobs) =>
  !!String(doc?.env?.PENDULUM_THIRD_PARTY_REVIEWERS ?? "").trim() || Object.values(jobs).some((j) => (j?.steps || []).some((st) => !!String(st?.with?.third_party_reviewers ?? "").trim()));

/**
 * On a private repository the wake jobs sleep only to the short waits (a quota retry, a read retry, the sweep's minutes):
 * each sleeper bills its runner minutes there. A sandbox stage's lease end and the UTC day's turn fall back to events
 * and GitHub's cron, which can run hours late. Null on a public repository, where every wait has its wake.
 */
export function longWaitCheck(repoData) {
  if (repoData?.private !== true) return null;
  return PASS("long waits", "private repository: a sandbox stage's lease end, the UTC day's turn after daily_usd and a third-party wait's bound fall back to events and GitHub's cron (often hours late); the wake jobs sleep only to quota, read and start retries and the sweep's minutes, so no long sleeper bills runner minutes");
}

/** One setting of the workflow file's env block (`text`), or "" when the file is unread, does not parse or has none. */
function workflowValue(text, key) {
  try {
    return String(parseYaml(text ?? "")?.env?.[key] ?? "");
  } catch {
    return "";
  }
}

/**
 * What the usage artifacts publish of the agent's work (lib/seal.mjs transcriptPolicy): on a public repository (or one
 * whose visibility is unread) the event stream and the saved sessions are sealed unless publish_transcripts is on, which
 * WARNs, since anyone signed in to GitHub can then download them; a private repository's need read access to it.
 */
export function transcriptCheck(repoData, publish) {
  const isPrivate = repoData?.private === true;
  const policy = transcriptPolicy({ isPrivate, publish });
  if (policy === "published" && !isPrivate) return WARN("transcripts", "publish_transcripts is on for a public repository: anyone signed in to GitHub can download the agent's event stream and saved sessions (the files it read, the commands it ran and their output) from the usage artifacts for 90 days", "set PENDULUM_PUBLISH_TRANSCRIPTS: false in .github/workflows/pendulum.yml (setup --publish-transcripts false) unless publishing them is intended");
  if (isPrivate) return PASS("transcripts", `private repository: the usage artifacts carry the agent's event stream and saved sessions readable, to those who can read the repository${publish ? " (publish_transcripts is on: they would be readable to anyone if it turned public)" : ""}`);
  return PASS("transcripts", "public repository: the usage artifacts carry the agent's event stream and saved sessions sealed (AES-256-GCM, a key derived from the App's private key, which only this workflow's jobs hold); the usage record stays readable");
}

/**
 * Whether the usage artifacts' seal key derives from the App's private key (lib/seal.mjs sealKey): a key given that
 * does not parse FAILs (a public repository's stages would then upload their usage without the transcript and the
 * stream, and no resume could open one). Null with no key to try: a laptop, a job given an App token, a sandbox stage
 * (handed the derived key, never the App's).
 */
export function sealKeyCheck({ appPrivateKey, repoFull }) {
  if (!appPrivateKey) return null;
  const key = sealKey(appPrivateKey, repoFull);
  if (key) return PASS("seal key", "the usage artifacts' seal key derives from the App's private key");
  return FAIL("seal key", `${sealKeyProblem(appPrivateKey, key)}: a public repository's usage artifacts go up without the agent's event stream and sessions, and no fix-passes resume opens one`, "save the App's private key, the whole PEM file, as PENDULUM_APP_PRIVATE_KEY (gh secret set PENDULUM_APP_PRIVATE_KEY < key.pem)");
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

/** The running workflow's path in the repository (Actions names it), else Pendulum's own. */
function workflowPath(env) {
  const m = /\/(\.github\/workflows\/[^@]+)@/.exec(env.GITHUB_WORKFLOW_REF || "");
  return m ? m[1] : ".github/workflows/pendulum.yml";
}

/** The Pendulum ref a workflow calls (a release tag, or a commit shortened), or "". */
const pinOf = (text) => {
  const ref = pendulumRef(text);
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
    checks.push(WARN("workflow copy", `this clone's ${path} differs from ${branch} on GitHub${here !== there ? ` (it pins ${here || "no Pendulum ref"}, GitHub ${there || "no Pendulum ref"})` : ""}; the checks read GitHub's`, `pull ${branch} into this clone: local mode reads its settings from the clone's copy`));
  }
  return { text: remote, checks };
}

// ------------------------------------------------------------- repository

/**
 * The bash doctor starts: the first `bash` among the absolute PATH entries outside the checkout (the system's newest,
 * such as Homebrew's on macOS, whose /bin/bash is 3.2), else SAFE_PATH's. Never a relative entry (`.`, an empty one,
 * `node_modules/.bin`) or one in the checkout, where the repository's own file named `bash` would run. Null when there
 * is none. With the agent set up on Actions, SAFE_PATH's alone.
 */
export function systemBash(env = process.env, checkout = null) {
  const real = (d) => {
    try {
      return realpathSync(d);
    } catch {
      return resolve(d);
    }
  };
  const root = checkout ? real(checkout) : null;
  const inside = (d) => root !== null && (real(d) === root || real(d).startsWith(`${root}${sep}`));
  // On Actions with the agent set up, only the system directories, as proc.mjs runnerCommand pins every bare command.
  const dirs = agentUser() ? [] : String(env.PATH || "").split(delimiter).filter((d) => isAbsolute(d) && !inside(d));
  return whichSync("bash", { PATH: [...dirs, SAFE_PATH].join(delimiter) });
}

/**
 * Bash's own parse of `command` with the flags Pendulum runs it with (`bash -n`: read, never executed), from `/`, with
 * extglob on (a command may turn it on before the line that uses it, which a parse never runs). Null when it parses;
 * else {refused: true, message: bash's error} when bash refused it, or {refused: false, message} when bash could not
 * parse it here (none found, it did not start, or it ran out of time).
 */
export async function shellSyntax(command, { env = process.env, checkout = null } = {}) {
  const bash = systemBash(env, checkout);
  if (!bash) return { refused: false, message: "no bash found" };
  let r;
  try {
    r = await exec(bash, ["-n", "-O", "extglob", "-eo", "pipefail", "-c", command], { cwd: "/", env: { PATH: SAFE_PATH }, timeoutMs: 30_000 });
  } catch (e) {
    return { refused: false, message: `bash could not start: ${e.code || e.message}` };
  }
  if (r.code === 0) return null;
  if (r.code === null) return { refused: false, message: r.timedOut ? "bash -n timed out" : `bash -n ended on ${r.signal}` };
  return { refused: true, message: r.stderr.trim().split("\n").join("; ").slice(0, 300) || `bash -n exited ${r.code}` };
}

/** Whether a bash word is one fixed string: no expansion, substitution, glob or brace. */
const fixedWord = (w) => !w?.parts || w.parts.every((p) => p.type === "Literal" || p.type === "SingleQuoted" || p.type === "AnsiCQuoted" || (p.type === "DoubleQuoted" && (p.parts || []).every((c) => c.type === "Literal")));

/**
 * The first simple command `command` runs at its own level, read from its bash syntax tree (unbash): {first: that
 * Command node (null when it has none), functions: the functions defined before it, failing: failingFirst}, or {error}
 * when unbash reports one. A function's body runs only when called, so it is no first command.
 */
export function firstCommand(command) {
  const tree = parseShell(command);
  if (tree.errors?.length) return { error: tree.errors[0].message };
  const functions = new Set();
  let first = null;
  const visit = (n) => {
    if (first) return;
    if (n.type === "Function") return void functions.add(n.name.value);
    if (n.type === "Command" && n.name) return void (first = n);
    forEachChild(n, visit);
  };
  visit(tree);
  return { first, functions, failing: failingFirst(tree) };
}

/**
 * The simple command `bash -eo pipefail` runs first whose failure ends the shell, or null: the lead of the first
 * statement (past function definitions and bare assignments), through a subshell or brace group, never one in a `&&`
 * or `||` list, behind `!`, sent to the background or in a condition, whose failure the shell goes on past.
 */
export function failingFirst(tree) {
  const lead = (n) => {
    switch (n?.type) {
      case "Script":
      case "CompoundList": {
        const s = n.commands.find((c) => c.command?.type !== "Function" && !(c.command?.type === "Command" && !c.command.name));
        return s ? lead(s) : null;
      }
      case "Statement":
        return n.background ? null : lead(n.command);
      case "AndOr":
        return n.commands.length === 1 ? lead(n.commands[0]) : null;
      case "Pipeline":
        return n.prefixes.some((p) => p.type === "Negation") ? null : lead(n.commands[0]);
      case "Subshell":
      case "BraceGroup":
        return lead(n.body);
      case "Redirected":
        return lead(n.command);
      case "Command":
        return n.name ? n : null;
      default:
        return null;
    }
  };
  return lead(tree);
}

/** Whether the repository's .npmrc sets `if-present` to anything but false (npm and pnpm then skip a missing script). */
function ifPresent(checkout) {
  const file = join(checkout, ".npmrc");
  if (!existsSync(file)) return false;
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .some((line) => {
      const at = line.indexOf("=");
      return at > 0 && line.slice(0, at).trim() === "if-present" && line.slice(at + 1).trim() !== "false";
    });
}

/**
 * `npm run X` and `pnpm run X` fail when the checkout's package.json has no script X (yarn runs a binary named X
 * instead, so it is not judged). Only a first command of exactly that shape counts: fixed words, no assignment or
 * redirection before it (npm_config_* would change it), X no option, and for npm no option after X before `--` (npm
 * reads one such as --if-present or --workspace itself). The reason it fails, or null.
 */
export function missingScript(cmd, checkout) {
  const words = cmd.suffix.filter((w) => w.type === "Word");
  const pm = fixedWord(cmd.name) ? cmd.name.value : "";
  if (!["npm", "pnpm"].includes(pm) || cmd.prefix.length || words.length < 2 || !fixedWord(words[0]) || words[0].value !== "run" || !fixedWord(words[1]) || words[1].value.startsWith("-")) return null;
  if (pm === "npm") {
    const after = words.slice(2);
    const end = after.findIndex((w) => w.text === "--");
    if ((end < 0 ? after : after.slice(0, end)).some((w) => !fixedWord(w) || w.value.startsWith("-"))) return null;
  }
  const script = words[1].value;
  // What runs without a script: npm's own `run env`, `start` as `node server.js`, pnpm's `/regex/` for every script it
  // matches, and the repository's .npmrc if-present.
  if ((pm === "npm" && script === "env") || (script === "start" && existsSync(join(checkout, "server.js"))) || (pm === "pnpm" && script.length > 1 && script.startsWith("/") && script.endsWith("/")) || ifPresent(checkout)) return null;
  const file = join(checkout, "package.json");
  if (!existsSync(file)) return `${pm} run ${script} needs a package.json, and the checkout has none`;
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return `package.json does not parse (${e.message})`;
  }
  const scripts = pkg?.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
  return Object.hasOwn(scripts, script) ? null : `no script "${script}" in package.json`;
}

/** What bash takes `name` for in `cwd` (`type -t`: file, builtin, function…), or "" when it finds nothing. */
async function commandType(name, { cwd, env }) {
  const bash = systemBash(env, cwd);
  if (!bash) return "";
  // `type` reads PATH and the files there and runs none of them; the PATH is the command's own, as it runs in `cwd`.
  const r = await exec(bash, ["-c", 'type -t -- "$1"', "_", name], { cwd, env: { PATH: env.PATH || SAFE_PATH }, timeoutMs: 30_000 }).catch(() => null);
  return r?.code === 0 ? r.stdout.trim() : "";
}

/**
 * One command's row (setup or validation), never running it: bash parses it (`bash -n`, a refusal FAILs), a
 * `npm|pnpm run X` first command names a script package.json has (missingScript, a FAIL), and bash finds its first
 * simple command here (`type -t`; not found is a WARN, as `missing` says why it may still run). A first command that
 * is no fixed word, or that unbash cannot read, cannot be looked up: a WARN saying so.
 */
export async function commandCheck(row, command, { checkout, env = process.env, missing, pass = "" }) {
  const syntax = await shellSyntax(command, { env, checkout });
  if (syntax?.refused) return FAIL(row, `${command}: bash cannot parse it (${syntax.message})`, `fix the ${row} command: Pendulum runs it with bash -eo pipefail -c`);
  if (syntax) return WARN(row, `${command}: not parsed here (${syntax.message})`, "run doctor where bash runs");
  const read = firstCommand(command);
  if (read.error) return WARN(row, `${command}: bash parses it but doctor's parser does not (${read.error}), so its first command is not looked up`, "nothing to fix if it runs; report it to Pendulum");
  if (!read.first) return PASS(row, `${command}${pass}`);
  const name = read.first.name;
  if (!fixedWord(name)) return WARN(row, `${command}: its first command, ${name.text}, is not a fixed word, so doctor cannot look it up`, `nothing to fix if it runs; a fixed command name lets doctor check it`);
  // A missing script fails the command only where its failure ends the shell (`npm run lint || true` goes on).
  const why = read.failing === read.first ? missingScript(read.first, checkout) : null;
  if (why) return FAIL(row, `${command}: ${why}`, `fix the ${row} command or add the script`);
  const type = read.functions.has(name.value) ? "function" : await commandType(name.value, { cwd: checkout, env });
  if (!type) return WARN(row, `${command}: ${name.value} is not found here; ${missing}`, `install ${name.value}, or fix the ${row} command`);
  return PASS(row, `${command}${pass}`);
}

export async function repositoryChecks({ inputs, checkout, env = process.env, runSetup = false, local = false, wf = readWorkflowEnv(checkout) }) {
  const out = [];
  if (!checkout || !existsSync(join(checkout, ".git"))) return [WARN("repository", "no checkout to inspect", "run from a clone or pass --checkout")];
  const { source, command: install, installs: auto } = installChoice(checkout, inputs.install);
  // Each program the automatic install runs, looked up where doctor runs (a stage's install needs it on PATH).
  const noTool = [];
  for (const i of auto) if (!(await commandType(i.tool, { cwd: checkout, env }))) noTool.push(i);
  const lockfiles = auto.map((i) => `${i.lockfile}: ${i.command}`).join("; ");
  if (source === "off") out.push(PASS("lockfile", "installation is turned off by choice (install: none)"));
  else if (source === "unrecognised") out.push(WARN("lockfile", "no lockfile recognised", "set install: <command> or install: none"));
  else if (noTool.length) out.push(WARN("lockfile", `${lockfiles}; ${noTool.map((i) => `${i.tool} is not found here`).join(", ")}, so every stage's install fails unless setup installs it`, `install ${noTool.map((i) => i.tool).join(" and ")} in the setup command, or set install: to the command this repository needs (install: none skips)`));
  else out.push(PASS("lockfile", auto.length ? lockfiles : install));
  for (const cmd of inputs.validation.map(commandText)) out.push(await commandCheck("validation", cmd, { checkout, env, missing: "setup may install it" }));
  if (!inputs.validation.length) out.push(WARN("validation", "no validation commands", "set validation: so Pendulum has a feedback loop"));
  if (inputs.setup) {
    if (runSetup) {
      const r = await exec("bash", ["-eo", "pipefail", "-c", inputs.setup], { cwd: checkout, env, timeoutMs: 20 * 60_000 });
      out.push(r.code === 0 ? PASS("setup", inputs.setup) : FAIL("setup", `${inputs.setup} exited ${r.code}`, "fix the setup command"));
    } else {
      out.push(await commandCheck("setup", inputs.setup, { checkout, env, missing: "the runner may have it", pass: " (parsed and looked up; doctor did not run it: --run-setup does)" }));
    }
  }
  // `local`: the developer's own checkout in local mode (doctor --local). A worker job's checkout in local mode is the
  // agent's clone, which local.mjs init() has already covered from the developer's checkout.
  if (local) out.push(...localDatabaseChecks({ checkout, env, wf }));
  const list = protectedPaths(inputs.protectedAdditions);
  const absent = list.filter((p) => !existsSync(join(checkout, p.replace(/\/$/, ""))));
  out.push(absent.length ? WARN("protected paths", `absent: ${absent.join(", ")}`, "the list still applies; absent paths cannot be touched") : PASS("protected paths", list.join(", ")));
  out.push(...(await setupFilesCheck({ inputs, checkout, list, env })));
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
 * The setup guard's view of a checkout (logic.mjs setupGuard `io`): files read from it, its package.json files found
 * by walking it (`.git` and `node_modules` left out), its symlinks read, absolute paths into it read as its own.
 */
export function checkoutIo(checkout, env = process.env) {
  const at = (p) => join(checkout, p);
  return {
    env,
    roots: [checkout],
    read: (p) => {
      try {
        return readFileSync(at(p), "utf8");
      } catch (e) {
        return e.code === "ENOENT" || e.code === "ENOTDIR" ? null : undefined;
      }
    },
    exists: (p) => existsSync(at(p)),
    link: (p) => {
      try {
        return lstatSync(at(p)).isSymbolicLink() ? readlinkSync(at(p)) : null;
      } catch {
        return null;
      }
    },
    list: (name) => {
      const found = [];
      const walk = (dir) => {
        let entries = [];
        try {
          entries = readdirSync(join(checkout, dir), { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          const p = dir ? `${dir}/${e.name}` : e.name;
          if (e.isDirectory() && e.name !== ".git" && e.name !== "node_modules") walk(p);
          else if (e.name === name && e.isFile()) found.push(p);
        }
      };
      walk("");
      return found;
    },
  };
}

/**
 * What the setup command runs from the repository (logic.mjs setupGuard, read in `checkout`): {files, guard}, `files`
 * the regular files the command itself names (`scripts/ci/setup.sh`, `bash -e ./x.sh && scripts/ci/toolchain.sh`),
 * each to be a protected path. Setup runs as the runner beside the App's key on every route (as root into the image
 * every stage starts from, with a sandbox), so a worker's commit must not change any of it.
 */
export async function setupRuns(setup, checkout, env = process.env) {
  const guard = await setupGuard(setup, checkoutIo(checkout, env));
  const files = guard.named.filter((p) => {
    try {
      return statSync(join(checkout, p)).isFile();
    } catch {
      return false;
    }
  });
  return { files, guard };
}

/** What the setup guard does not follow, said on doctor's setup-files row whatever the command. */
export const SETUP_NOT_FOLLOWED = "Not followed, so protect them yourself: what a program reads by its own convention (a Makefile, docker compose files, the pyproject.toml uv or poetry read), what a file setup runs reads in turn (a script's own source), python -c imports and PYTHONPATH";
const listed = (xs, n = 6) => `${xs.slice(0, n).join(", ")}${xs.length > n ? ` and ${xs.length - n} more` : ""}`;

/**
 * Setup runs as the runner beside the App's key on every route (with sudo on Actions, as root into a sandbox's image), so
 * every repository file its command names must be a protected path: otherwise a worker's change to it, once merged, runs
 * there. What it may run that cannot be named (a variable, a substitution's output, a glob, a shell reading a pipe, remote
 * code), in the command or a package.json script it runs, cannot be protected at all. FAIL on either, in a job too: the
 * run Blocks before such a setup runs. The rest of what it runs (setupGuard `files` and `scripts`) needs no entry:
 * Pendulum refuses a push that changes any of it (outbox.mjs). What the `install` command may run that cannot be named
 * is a WARN: every file then counts as toolchain to a fix pass (logic.mjs fixScopeRefused).
 */
export async function setupFilesCheck({ inputs, checkout, list = protectedPaths(inputs.protectedAdditions), env = process.env }) {
  const out = [];
  const install = inputs.install && inputs.install !== "auto" && inputs.install !== "none" ? commandRefs(inputs.install, { env, roots: [checkout] }).unresolved : [];
  if (install.length) out.push(WARN("install files", `the install command runs ${listed(install)}, which Pendulum cannot resolve to repository files, so a fix pass may change no file its scope does not name`, "name each file literally in the install command, or move the command into a script file"));
  if (!inputs.setup) return out;
  const { files, guard } = await setupRuns(inputs.setup, checkout, env);
  if (guard.unresolved.length) return [FAIL("setup files", `the setup command runs ${listed(guard.unresolved, 4)}, which Pendulum cannot resolve to repository files, so it cannot keep a worker from changing what runs as the runner beside the App's key`, "name each file the setup runs literally (bash scripts/ci/setup.sh), or move the command into a script file in the repository; setup --apply workflow then protects it"), ...out];
  const bare = unprotectedFiles(files, list);
  if (bare.length) return [FAIL("setup files", `the setup command runs ${bare.join(", ")} as the runner, beside the App's key, and no protected path covers it: a worker's merged change to it would run there`, `add ${bare.map((f) => `/${f}`).join(", ")} to protected_paths (PENDULUM_PROTECTED_PATHS in .github/workflows/pendulum.yml; a leading / protects it at the root only); setup --apply workflow adds it`), ...out];
  const guarded = guard.files.filter((f) => !files.includes(f));
  const scripts = guard.scripts.map((x) => `${x.pkg === "*" ? "any package.json" : x.pkg} scripts.${x.name}`);
  const parts = [...(files.length ? [`${files.join(", ")} protected`] : []), ...(guarded.length ? [`a push changing ${listed(guarded)} is refused`] : []), ...(scripts.length ? [`and one changing ${listed(scripts)}`] : [])];
  out.unshift(PASS("setup files", `${parts.length ? `${parts.join("; ")}: what the command names or runs by name (a PATH entry, a package.json script and what it runs, an install's lifecycle scripts, a package manager's own files)` : "the command names no repository file it runs"}. ${SETUP_NOT_FOLLOWED}`));
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
  // A sandbox vendor's session cap is not checked here: it is the vendor plan's, which only the vendor's answer at a
  // stage's start shows. The launcher fits each stage to the session granted (launch.mjs createSession).
  out.push((await onPath("gh")) ? PASS("gh", "present") : FAIL("gh", "gh not on PATH", "install the GitHub CLI"));
  // On Actions the harness runs as its own uid in a transient systemd unit (lib/agent.mjs): passwordless sudo and
  // systemd-run, which GitHub's hosted runners have.
  if (env.GITHUB_ACTIONS) {
    const s = await exec("/usr/bin/sudo", ["-n", "/usr/bin/true"], { env: { PATH: "/usr/bin:/bin" } }).catch(() => ({ code: 1 }));
    out.push(s.code === 0 ? PASS("sudo", "passwordless sudo for the agent uid") : FAIL("sudo", `sudo -n fails on this ${selfHosted ? "self-hosted " : ""}runner`, "give the runner's user passwordless sudo (Pendulum creates the pendulum-agent user and runs the harness as it)"));
    const launcher = await agentLauncher();
    out.push(launcher ? PASS("agent launcher", launcher === "systemd" ? "systemd-run (a transient unit per command)" : "unshare, setpriv and a cgroup v2 group (no systemd here)") : FAIL("agent launcher", "neither systemd-run nor unshare with a cgroup v2 hierarchy", "run on a runner with systemd, or a Linux machine with util-linux and cgroup v2"));
    const home = await agentHomeProblem();
    out.push(home ? FAIL("agent home", home, `remove that user or give it the home ${AGENT_HOME}: Pendulum wipes that path before each job`) : PASS("agent home", `${AGENT_USER} at ${AGENT_HOME}`));
  }
  out.push(gitCheck(await onPath("git"), await gitVersion()));
  out.push(...(await claudeSandboxChecks({ inputs, env })));
  return out;
}

/**
 * git where Pendulum runs: present, and at least MERGE_BASE_GIT, which `git merge-tree --merge-base` needs (the rebase
 * check of a send-back's conflict pass, and what a review reads after a rebase). `version` from outbox.mjs gitVersion.
 */
export function gitCheck(present, version) {
  if (!present) return FAIL("git", "git not on PATH", "install git");
  const min = MERGE_BASE_GIT.join(".");
  if (!version) return WARN("git", "present; its version could not be read", `use git ${min} or later`);
  const v = version.join(".");
  if (gitAtLeast(version, MERGE_BASE_GIT)) return PASS("git", v);
  return WARN("git", `git ${v} is older than ${min} and has no \`git merge-tree --merge-base\`: with a decider (the AI Gateway's model, or the stage's harness) every send-back's conflict pass Blocks (with decision_route off its commits are matched), and a review after a rebase reads the whole PR again`, `install git ${min} or later`);
}

/** Per harness with a sandbox on a runner: its name in the checks, and the binaries it needs where the job runs. */
const RUNNER_SANDBOX = {
  claude: { name: "Claude Code", bins: [["bwrap", "bubblewrap"], ["socat", "socat"], ["rg", "ripgrep"]], refuses: "refuses to start without it" },
  codex: { name: "Codex", bins: [["bwrap", "bubblewrap"]], refuses: "the stage Blocks before it starts without it" },
  copilot: { name: "Copilot", bins: [["bwrap", "bubblewrap"], ["slirp4netns", "slirp4netns"], ["socat", "socat"]], refuses: "the stage Blocks before it starts without it" },
};

/** The one-time admin step a self-hosted Ubuntu runner needs for Claude Code's sandbox (the Action applies it only on GitHub's hosted runners). */
export const APPARMOR_ADMIN_STEP = "once, as an admin on the runner host: printf 'abi <abi/4.0>,\\ninclude <tunables/global>\\nprofile pendulum-bwrap /usr/bin/bwrap flags=(unconfined) {\\n  userns,\\n}\\n' | sudo tee /etc/apparmor.d/pendulum-bwrap && sudo apparmor_parser -r /etc/apparmor.d/pendulum-bwrap; where `sudo grep unpriv_bwrap /sys/kernel/security/apparmor/profiles` finds Ubuntu's bwrap-userns-restrict profile, also: sudo apparmor_parser -R /etc/apparmor.d/bwrap-userns-restrict && sudo ln -s /etc/apparmor.d/bwrap-userns-restrict /etc/apparmor.d/disable/ (docs/PLAN.md, Credentials and billing)";
/** Copilot's sandbox makes its namespaces with util-linux unshare, which its bwrap joins: the grant is unshare's. */
export const APPARMOR_UNSHARE_STEP = "once, as an admin on the runner host: printf 'abi <abi/4.0>,\\ninclude <tunables/global>\\nprofile pendulum-unshare /usr/bin/unshare flags=(unconfined) {\\n  userns,\\n}\\n' | sudo tee /etc/apparmor.d/pendulum-unshare && sudo apparmor_parser -r /etc/apparmor.d/pendulum-unshare; where `sudo grep -E 'unpriv_(bwrap|unshare)' /sys/kernel/security/apparmor/profiles` finds Ubuntu's bwrap-userns-restrict or unshare-userns-restrict profile, also unload and disable it: sudo apparmor_parser -R /etc/apparmor.d/<name> && sudo ln -s /etc/apparmor.d/<name> /etc/apparmor.d/disable/ (docs/PLAN.md, Credentials and billing)";

/**
 * Every harness on Actions and in a cloud sandbox runs its commands in its own bubblewrap sandbox (harness.mjs
 * claudeRunner, codexRunner, copilotRunner). Wherever their settings are checked: each `allowed_domains` entry they would
 * drop is a WARN. Where the job runs (a runner job, a sandbox stage): the binaries each needs, which the Action and the
 * stage's start install on Ubuntu; on a self-hosted runner, AppArmor letting bwrap (and for Copilot unshare) make user
 * namespaces, which the Action does not change there; for Codex and Copilot, the confinement probe their stage runs
 * before every start, run once (`start`), which fails where the sandbox cannot start or does not confine. Not in local
 * mode, whose own checks name them (local.mjs). `has`, `read`, `profiles` and `start` are seams for the tests.
 */
export async function claudeSandboxChecks({ inputs, env = process.env, local = backend(env).name === "local", has = onPath, read = (p) => readFileSync(p, "utf8"), profiles = apparmorProfiles, start = null, restore = sessionRestoreStart }) {
  const h = inputs.harness;
  const sb = RUNNER_SANDBOX[h];
  if (!sb || local) return [];
  const out = [];
  const dropped = droppedDomains(input("allowed_domains", { env }));
  if (dropped.length) out.push(WARN("allowed_domains", `not host names, so ${sb.name}'s sandbox does not allow them: ${dropped.map((d) => JSON.stringify(d)).join(", ")}`, "write each as a host name (example.com) or *. and one (*.example.com), comma or space separated; no scheme, port, path or IP address"));
  if (!(env.GITHUB_ACTIONS || env.PENDULUM_STAGE_SANDBOX === "1")) return out;
  const pkgs = sb.bins.map(([, pkg]) => pkg).join(" ");
  const missing = [];
  for (const [bin, pkg] of sb.bins) {
    const ok = await has(bin);
    if (!ok) missing.push(bin);
    out.push(ok ? PASS(`${h} sandbox: ${bin}`, "present") : FAIL(`${h} sandbox: ${bin}`, `${bin} not on PATH; ${sb.name} runs every command in its bubblewrap sandbox here and ${sb.refuses}`, `install ${pkg} on the runner (sudo apt-get install -y ${pkgs}; the Action does this on GitHub's hosted runners)`));
  }
  if (env.RUNNER_ENVIRONMENT === "self-hosted") {
    let restricted = false;
    try {
      restricted = read("/proc/sys/kernel/apparmor_restrict_unprivileged_userns").trim() === "1";
    } catch {
      // no such restriction on this kernel
    }
    const loaded = restricted || (await has("apparmor_parser")) ? await profiles() : "";
    // Copilot's sandbox makes its namespaces with unshare and bubblewrap joins them: the grant is unshare's, and Ubuntu's
    // restricting profiles (bwrap-userns-restrict, unshare-userns-restrict from 25.04) must not be loaded.
    const copilot = h === "copilot";
    const granted = copilot ? /^pendulum-unshare /m.test(loaded) : /^pendulum-bwrap /m.test(loaded);
    const blocks = (restricted && !granted) || /^unpriv_bwrap /m.test(loaded) || (copilot && /^unpriv_unshare /m.test(loaded));
    const step = copilot ? APPARMOR_UNSHARE_STEP : APPARMOR_ADMIN_STEP;
    out.push(blocks ? FAIL(`${h} sandbox: apparmor`, `AppArmor keeps ${copilot ? "unshare" : "bwrap"} from making the user namespaces ${sb.name}'s sandbox needs on this self-hosted runner, and the Action changes no host-wide setting off GitHub's hosted runners`, step) : PASS(`${h} sandbox: apparmor`, restricted ? `the ${copilot ? "pendulum-unshare profile lets unshare" : "pendulum-bwrap profile lets bwrap"} make user namespaces` : "no user-namespace restriction"));
  }
  // Codex's and Copilot's sandboxes, started once where the job runs (the stage checks again as the agent before every start).
  const starter = start ?? (h === "codex" ? codexSandboxStart : h === "copilot" ? copilotSandboxStart : null);
  const r = starter && (h === "codex" || h === "copilot") && !missing.length ? await starter(env) : null;
  if (r) {
    const fix = env.RUNNER_ENVIRONMENT === "self-hosted" ? (h === "copilot" ? APPARMOR_UNSHARE_STEP : APPARMOR_ADMIN_STEP) : h === "copilot" ? "give unshare unprivileged user and network namespaces (on Ubuntu the pendulum-unshare AppArmor profile, which the Action loads on GitHub's hosted runners), and slirp4netns /dev/net/tun and an iptables that can add an IPv6 table (the cloud sandbox's start sees to both)" : "give bwrap unprivileged user and network namespaces (on Ubuntu the pendulum-bwrap AppArmor profile, which the Action loads on GitHub's hosted runners)";
    out.push(r.ok ? PASS(`${h} sandbox: start`, `${sb.name}'s sandbox starts and confines here`) : FAIL(`${h} sandbox: start`, `${sb.name}'s sandbox does not start here: ${r.reason}`, fix));
  }
  // A held session put back as the agent, as every resumed stage does (lib/untar.mjs), where the agent exists.
  const back = await restore(env);
  if (back) out.push(back.ok ? PASS("session restore", "a held session is put back as the agent here") : FAIL("session restore", `a held session cannot be put back as the agent here, so a resumed stage Blocks (git-clear): ${back.reason}`, "report it with this line and the runner's OS (docs/PLAN.md, Security): the agent's confinement refuses what the unpacker needs"));
  return out;
}

/**
 * A held session's round trip where the job runs, as the agent in its temp directory: a nested directory archived with
 * tar, as Pendulum captures a session (claude-runner.mjs archiveSession), and unpacked into a fresh directory, as every
 * reset puts one back (untar.mjs). {ok, reason}, or null before the agent exists.
 */
async function sessionRestoreStart(env = process.env) {
  const agent = agentUser();
  if (!agent) return null;
  const dir = `${agent.tmp}/session-restore-check`;
  const opts = { cwd: agent.tmp, env: scrubbedEnv(env) };
  try {
    const made = await exec("/bin/sh", ["-c", 'set -e; rm -rf -- "$1"; mkdir -p -- "$1/from/s1/checkpoints" "$1/to"; echo pendulum > "$1/from/s1/checkpoints/index.md"', "sh", dir], opts);
    if (made.code !== 0) return { ok: false, reason: `the check could not be set up: ${String(made.stderr).trim().split("\n").at(-1)?.slice(0, 200) || ""}` };
    const tar = await tarAsAgent(`${dir}/from`, ["s1/checkpoints/index.md"], opts);
    if (tar.code !== 0) return { ok: false, reason: `a session could not be archived as the agent: ${String(tar.stderr).trim().split("\n").at(-1)?.slice(0, 200) || `exit ${tar.code}`}` };
    const put = await untarAsAgent(tar.stdout, `${dir}/to`, opts);
    if (put.code !== 0) return { ok: false, reason: String(put.stderr).trim().split("\n").at(-1)?.slice(0, 200) || `exit ${put.code}` };
    const got = await exec("/bin/cat", [`${dir}/to/s1/checkpoints/index.md`], opts);
    return got.code === 0 && String(got.stdout).trim() === "pendulum" ? { ok: true } : { ok: false, reason: "the unpacked session is not what was archived" };
  } finally {
    await exec("/bin/rm", ["-rf", "--", dir], opts).catch(() => {});
  }
}

/**
 * Codex's sandbox where the job runs, as the agent in its temp directory (on Actions the CLI is the agent's to run, never
 * the runner's), with the runner's profile around a throwaway directory, running the confinement probe the stage runs
 * before every start: no process may show the marker Codex's process holds, the agent's home must refuse a write, its
 * temp directory take one, and a host off the allow-list be refused. {ok, reason}, or null before the agent exists.
 */
async function codexSandboxStart(env = process.env) {
  const agent = agentUser();
  if (!agent) return null;
  const home = `${agent.tmp}/codex-sandbox-check`;
  const marker = randomBytes(16).toString("hex");
  const args = ["sandbox", ...codexLocalConfig({ clone: null, addDirs: [agent.tmp], home: agent.home, secrets: [], secretEnv: [PROBE_MARKER], denyProc: false }), "--", "/bin/sh", "-c", CONFINEMENT_PROBE, "sh", agent.home, "", agent.tmp, offListHost(LOCAL_DOMAINS), marker];
  await exec("/bin/mkdir", ["-p", home], { cwd: agent.tmp });
  const r = await exec("/bin/sh", ["-c", DECOY_LAUNCH, "sh", ...args], { cwd: agent.tmp, env: { PATH: env.PATH || "/usr/bin:/bin", CODEX_HOME: home, [PROBE_MARKER]: marker }, agentExtra: [PROBE_MARKER, "CODEX_HOME"], timeoutMs: 120_000 }).catch((e) => ({ code: 1, stderr: e.message }));
  await exec("/bin/rm", ["-rf", "--", home], { cwd: agent.tmp }).catch(() => {});
  if (r.code === 4) return { ok: false, reason: `it starts but does not confine: ${String(r.stdout).trim().split("\n").at(-1)?.slice(0, 200)}` };
  return r.code === 0 ? { ok: true } : { ok: false, reason: String(r.stderr).trim().split("\n").at(-1)?.slice(0, 200) || `exit ${r.code}` };
}

/**
 * Copilot's sandbox where the job runs, as the agent, launched as a run's Copilot is, around a throwaway directory in the
 * agent's temp directory: the confinement probe the stage runs before every start (harness.mjs copilotSandboxCheck).
 * {ok, reason}, or null before the agent exists.
 */
async function copilotSandboxStart(env = process.env) {
  const agent = agentUser();
  if (!agent) return null;
  const clone = `${agent.tmp}/copilot-sandbox-check`;
  await exec("/bin/mkdir", ["-p", clone], { cwd: agent.tmp });
  try {
    const runner = copilotRunner({ harness: "copilot", agent, clone, env });
    await prepareCopilotHome(runner, { env });
    // As before a run: a link planted at a writable root is a real directory first (claude-runner.mjs realRoots).
    await realRoots({ fix: [runner.agentTmp, ...runner.caches], check: [clone] }, runner.agentHome, scrubbedEnv(env));
    await copilotSandboxCheck(runner, scrubbedEnv(env));
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e.message).replace(/^refusing to start the harness: /, "").slice(0, 300) };
  } finally {
    await exec("/bin/rm", ["-rf", "--", clone], { cwd: agent.tmp }).catch(() => {});
  }
}

/**
 * The runner `doctor --probe` runs Codex with where the agent uid exists: the run's own sandbox and start-up (a fresh
 * CODEX_HOME, Pendulum's HOME), around a throwaway directory in the agent's temp directory. Null elsewhere.
 */
async function probeRunner(env = process.env) {
  const agent = agentUser();
  if (!agent || backend(env).name === "local") return null;
  const clone = `${agent.tmp}/codex-probe`;
  await exec("/bin/mkdir", ["-p", clone], { cwd: agent.tmp });
  const runner = { ...codexRunner({ harness: "codex", agent, clone, env }), present: new Set() };
  await preparePendulumHome(CODEX_RUNNER_HOME, "Codex");
  await resetCodexState(runner, scrubbedEnv(env));
  await realRoots({ fix: [runner.agentTmp, ...runner.caches], check: [clone] }, runner.agentHome, scrubbedEnv(env));
  return runner;
}

/** The AppArmor profiles loaded (root's to read), or "" when they cannot be read. */
async function apparmorProfiles() {
  const r = await exec("/usr/bin/sudo", ["-n", "/bin/cat", "/sys/kernel/security/apparmor/profiles"], { env: { PATH: "/usr/bin:/bin" } }).catch(() => ({ code: 1 }));
  return r.code === 0 ? String(r.stdout) : "";
}

/**
 * Local mode writes as the operator, and GitHub notifies no one of their own @mention: when that login is the notify
 * user, a Blocked or Question reaches no one unless the Pendulum App posts it (#2522). `notice`: an App is configured.
 */
export function noticeChecks({ inputs, notice, local = backend().name === "local", self = selfLogin() }) {
  if (!local || !inputs.notify) return [];
  if (notice) return [PASS("notices", "posted as the Pendulum App, so the @mention notifies")];
  if (self && self === inputs.notify.toLowerCase()) return [WARN("notices", `local notices post as @${inputs.notify}, the notify user, and GitHub notifies no one of their own @mention`, "set PENDULUM_LOCAL_APP_ID and PENDULUM_LOCAL_APP_KEY (the Pendulum App's id and the path of its private key under ~/.config/pendulum) so notices post as the App")];
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
 * package (PG_CLIENTS), a CI job under .github/workflows (Pendulum's own workflow aside) with a service container whose
 * image is a Postgres server (PG_IMAGES), and PENDULUM_LOCAL_DB_INIT in Pendulum's workflow env, which is for local
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
    workflows = readdirSync(join(checkout, ".github", "workflows"), { withFileTypes: true }).filter((d) => d.isFile() && /\.ya?ml$/.test(d.name) && !/^pendulum\.ya?ml$/.test(d.name)).map((d) => d.name).sort();
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
  if (wf.PENDULUM_LOCAL_DB_INIT) out.push("the workflow sets PENDULUM_LOCAL_DB_INIT");
  return out;
}

/**
 * Local mode's sandboxes have no route to the machine's services, so a validation command that needs Postgres fails
 * there unless PENDULUM_LOCAL_DB=1 gives it a throwaway one (#2601). WARNs when the checkout declares a Postgres server
 * (databaseSignals) and PENDULUM_LOCAL_DB is off; when PENDULUM_LOCAL_VALIDATION is set, the WARN names the commands it
 * still runs locally, since only the owner knows whether one of them needs the database. On macOS PENDULUM_LOCAL_DB=1
 * is not supported, so it WARNs there too. `env` wins over the workflow's env block `wf`, as in the local loop. Nothing to
 * say when the checkout declares no database. For the developer's own checkout (local.mjs init, doctor --local).
 */
export function localDatabaseChecks({ checkout, env = process.env, wf = readWorkflowEnv(checkout), os = platform() }) {
  const pick = (k) => env[k] ?? wf[k];
  const darwin = os === "darwin";
  if (pick("PENDULUM_LOCAL_DB") === "1") {
    if (!darwin) return [PASS("local database", "PENDULUM_LOCAL_DB=1: each validation command gets a throwaway Postgres")];
    return [WARN("local database", "PENDULUM_LOCAL_DB=1 is set, but it is for Linux and WSL2 only: macOS's sandbox shares the box's loopback, so a throwaway database would be reachable from outside it, and a run with it set (in this shell or the workflow env) does not start", "unset PENDULUM_LOCAL_DB on macOS (in this shell and the workflow env) and list only the validation commands that need no database in PENDULUM_LOCAL_VALIDATION")];
  }
  const signals = databaseSignals(checkout, wf);
  if (!signals.length) return [];
  const shown = signals.length > 3 ? [...signals.slice(0, 3), `${signals.length - 3} more`] : signals;
  const uses = `this repository uses Postgres (${shown.join("; ")}) and PENDULUM_LOCAL_DB is off`;
  const db = "set PENDULUM_LOCAL_DB=1 (a throwaway Postgres per validation command; needs the Postgres server binaries, initdb and pg_ctl)";
  const local = comma(pick("PENDULUM_LOCAL_VALIDATION")).map(commandText);
  if (local.length) {
    const fix = `confirm none of those needs Postgres, and leave out of PENDULUM_LOCAL_VALIDATION any that does (the required checks run it on GitHub)${darwin ? "" : `, or ${db}`}`;
    return [WARN("local database", `${uses}; PENDULUM_LOCAL_VALIDATION still runs ${local.join(", ")} locally, in sandboxes with no route to this machine's services`, fix)];
  }
  const fix = darwin ? "list only the validation commands that need no database in PENDULUM_LOCAL_VALIDATION (PENDULUM_LOCAL_DB=1, a throwaway Postgres per command, runs on Linux and WSL2 only)" : `${db}, or list only the commands that need no database in PENDULUM_LOCAL_VALIDATION`;
  return [WARN("local database", `${uses}: local mode's sandboxes have no route to this machine's services, so a validation command that needs the database fails and the run Blocks after a fix pass`, fix)];
}

/**
 * The notice App's reach (#2522), from a notice mint, for the record: the key on this box mints whatever its
 * installation grants (Pendulum's own App: contents and pull requests write too), while the notice token Pendulum mints
 * is narrowed to issues write. Informational: using Pendulum's own App for local notices is a supported choice.
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
  out.push(...workerSecretChecks({ inputs }));
  out.push(...gatewayRelayChecks({ inputs }));
  out.push(...(await githubChecks({ inputs, repo, token, app, notice, job: true })));
  out.push(...(await repositoryChecks({ inputs, checkout })));
  out.push(...(await runnerChecks({ inputs })));
  return out;
}

/**
 * Local mode: each PENDULUM_* name the workflow's env block sets that is no setting (inputs.mjs WORKFLOW_SETTINGS) is a
 * WARN. Local mode leaves it out of every stage: the workflow file is repository content, and such a name is Pendulum's
 * own control (#119).
 */
export function workflowEnvChecks(wf = {}) {
  const { dropped } = workflowSettings(wf);
  if (!dropped.length) return [];
  return [WARN("workflow env", `.github/workflows/pendulum.yml sets ${dropped.join(", ")}, which ${dropped.length === 1 ? "is" : "are"} no Pendulum setting: local mode ignores ${dropped.length === 1 ? "it" : "them"}`, "remove them from the workflow's env block; the settings are the Action's inputs as PENDULUM_<INPUT> and the PENDULUM_LOCAL_* ones in docs/LOCAL.md")];
}

/** The commands a local stage runs for the repository in `checkout` (copilot-runner.mjs stageCommands), install resolved. */
const localCommands = (checkout, env) => {
  const c = stageCommands(env);
  return { ...c, install: checkout ? installCommand(checkout, c.install) : null };
};

/**
 * Local mode: the stage's node, the repository's package manager and the tools its own commands run as local mode
 * resolves them for its sandboxed commands (copilot-runner.mjs localToolchain, localPackageManager, repositoryTools;
 * #111, #137, #371), one row each, so a developer can see the resolution before a run. On Linux a command word of the
 * repository's commands that Claude Code's and Copilot's commands would not find is a WARN naming each (`commands`: the
 * settings' commands, localCommands). node's version is asked of the resolved binary itself, from `/` (no repository in reach);
 * the package manager's is the one `packageManager` pins (nothing is run). A pinned package manager not resolved is a
 * FAIL (the pre-start probe would Block); one resolved but kept out of the sandboxes (it sits in or above what a sandbox
 * may write, or a credential store) a WARN. `os`: on Linux Claude Code's and Copilot's sandboxes bind them read-only.
 */
export function localToolchainRows({ checkout, env = process.env, commands = localCommands(checkout, env), os = platform(), run = (bin) => execFileSync(bin, ["--version"], { cwd: "/", env: { PATH: SAFE_PATH }, encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"] }) }) {
  const out = [];
  const off = [join(checkout, ".pendulum"), stageTmpBase()];
  const node = localToolchain({ path: env.PATH || "", off });
  if (!node) out.push(FAIL("node", "no node on PATH", "install Node.js, or activate your version manager in this shell"));
  else {
    let version = "";
    try {
      version = String(run(node.toolchain.node)).trim();
    } catch {
      // not run: the path alone
    }
    out.push(PASS("node", `${version ? `${version} ` : ""}→ ${node.toolchain.node}${os === "linux" ? (node.dirs.length ? ` (${node.dirs[0]} read-only in Claude Code's and Copilot's sandboxes)` : " (the system's)") : ""}`));
  }
  const pm = localPackageManager({ clone: checkout, path: env.PATH || "", off });
  if (pm) {
    const pinned = pinnedVersion(checkout);
    const what = `${pm.name}${pinned ? ` ${pinned}` : ""}`;
    if (!pm.real) out.push(FAIL("package manager", `${what}${pinned ? " (packageManager)" : " (by the lockfile)"} is not resolved from PATH${pm.via ? ` (${pm.via}'s shim: no install of ${pinned || "an unpinned version"} in its install directory)` : ""}; local stages Block before the run`, pm.via ? `install it with ${pm.via}${pinned ? "" : ", and pin it in package.json's packageManager"}` : `put ${pm.name} on PATH (corepack enable, or a version manager)`));
    else if (os === "linux" && !pm.dirs.length) out.push(WARN("package manager", `${what} (${pm.via}) → ${pm.real}, but it sits in or above a directory a sandbox may write, the home or a credential store, so Claude Code's and Copilot's commands cannot read it`, `install ${pm.name} elsewhere (corepack in a Node.js install, or a version manager)`));
    else out.push(PASS("package manager", `${what} (${pm.via}) → ${pm.real}`));
  }
  if (os === "linux") {
    const pmName = packageManagerOf(checkout);
    const { tools, unresolved } = repositoryTools({ clone: checkout, commands, path: env.PATH || "", off, skip: pmName ? [pmName] : [] });
    const seen = tools.map((t) => `${t.word} → ${t.real}`).join(", ");
    if (unresolved.length) out.push(WARN("repository tools", `${unresolved.map((u) => `${u.word} (${u.from}): ${u.why}`).join("; ")}; Claude Code's and Copilot's commands cannot run ${unresolved.length === 1 ? "it" : "them"}${seen ? `. Visible: ${seen}` : ""}`, "put each on PATH in the shell that starts serve, or pin its version (.tool-versions, mise.toml) where a version manager has several"));
    else if (tools.length) out.push(PASS("repository tools", `${seen} (read-only in Claude Code's and Copilot's sandboxes)`));
  }
  return out;
}

/**
 * Local mode with Claude Code on Linux: its sandbox's start and confinement (`claude sandbox: start`), by the probe every
 * local Claude Code stage runs first (harness.mjs claudeLocalCheck), around a throwaway clone (this checkout's package.json
 * only) in a directory of Pendulum's own, with the stage's toolchain and outer sandbox as a stage gets them.
 */
export async function claudeLocalStart({ checkout, env = process.env, commands = localCommands(checkout, env), check = claudeLocalCheck }) {
  const ws = mkdtempSync(join(dirname(stageTmpBase()), "doctor-"));
  const tmp = stageTemp("doctor-");
  try {
    const clone = join(ws, "repo");
    const usage = join(ws, "usage");
    const corepack = join(ws, "corepack");
    for (const d of [join(usage, "harness"), corepack]) mkdirSync(d, { recursive: true });
    await exec("git", ["init", "-q", clone], { env: { PATH: env.PATH || SAFE_PATH } });
    // What resolves the stage's tools (package.json's packageManager and scripts, the version pins), nothing else.
    for (const f of ["package.json", ".tool-versions", "mise.toml", ".mise.toml", ".python-version", ".ruby-version"]) if (existsSync(join(checkout, f))) copyFileSync(join(checkout, f), join(clone, f));
    const tools = localTools({ harness: "claude", clone, commands, path: env.PATH || "", off: [ws, join(checkout, ".pendulum"), dirname(tmp)], usageDir: usage });
    const gitBin = join(usage, "gitbin");
    mkdirSync(gitBin);
    writeFileSync(join(gitBin, "git"), gitGuardScript(realpathSync(whichSync("git"))), { mode: 0o755 });
    const claudeEnv = tools.lead.length ? join(usage, "claude-env.sh") : null;
    if (claudeEnv) writeFileSync(claudeEnv, claudeEnvText([gitBin, ...tools.lead]), { mode: 0o644 });
    const domains = [...LOCAL_DOMAINS, ...String(env.PENDULUM_LOCAL_DOMAINS || "").split(/[\s,]+/).filter(Boolean)];
    const outerOn = outerProbe("claude", { domains, env }).on;
    const outer = outerOn ? join(ws, "outer.json") : null;
    if (outer) writeFileSync(outer, JSON.stringify(harnessOuterSettings({ harness: "claude", domains, writable: [clone, tmp, corepack, join(usage, "harness")], clone, env, install: harnessInstall(whichSync("claude")) })));
    const local = { clone, addDirs: [corepack, tmp], cacheDirs: [corepack], readDirs: [usage], readOnly: [usage], domains, gitBin, toolchain: tools.probe, readable: tools.readable, ...(claudeEnv ? { claudeEnv } : {}) };
    const runEnv = { ...localBaseEnv(env), TMPDIR: tmp, CLAUDE_CODE_TMPDIR: tmp, PENDULUM_USAGE_DIR: usage, COREPACK_HOME: corepack, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0", NODE_USE_ENV_PROXY: "1" };
    await check(local, outer, runEnv);
    return PASS("claude sandbox: start", `its sandbox starts and confines here, and runs ${[tools.probe?.node ? "node" : "", tools.probe?.pm || ""].filter(Boolean).join(" and ") || "its commands"}`);
  } catch (e) {
    return FAIL("claude sandbox: start", String(e.message).replace(/^refusing to start the harness: /, "").slice(0, 300), e.rule === TOOLCHAIN_RULE ? "see the node and package manager rows" : "the probe's output is above; fix the sandbox (bubblewrap, srt) or the setting it names");
  } finally {
    rmSync(ws, { recursive: true, force: true });
    dropOwned(tmp);
  }
}

/**
 * Local mode reads the workflow's settings from the default branch's committed workflow (#122): a WARN when there is
 * none there, or when this working tree's settings differ from it (local mode uses the default branch's).
 */
export function workflowSourceChecks(working, committed) {
  if (committed.noClone) return [WARN("workflow source", "not checked: doctor runs outside a clone of the repository, so it cannot read the default branch's .github/workflows/pendulum.yml (serve reads it from its own clone)", "run doctor --local from the repository's clone to check the settings local mode uses")];
  if (committed.parseError) return [WARN("workflow source", `local mode reads its settings from the default branch's .github/workflows/pendulum.yml: ${committed.error}, so serve, run and review do not start`, `fix the YAML on ${committed.branch} (the error names the line), through a pull request`)];
  if (committed.error) return [WARN("workflow source", `local mode reads its settings from the default branch's .github/workflows/pendulum.yml: ${committed.error}, so it uses none`, "merge the workflow into the default branch (pendulum:setup writes it)")];
  const [line] = workflowDriftLines(working, committed);
  return line ? [WARN("workflow source", line, `commit the change to ${committed.branch}; local mode never reads a working tree's workflow`)] : [];
}

/**
 * Local mode: the harness logins on this machine (local.mjs harnessLogins), each hidden from every sandbox but the one a
 * stage runs on, which only its own harness process reads. A WARN names each other login inside a home of the harness's
 * (loginsExposedBy): its outer sandbox can write there, so a deny by path does not hold; and each login file of the
 * stage's own that leads into another login (ownLoginProblems), for which serve refuses the stage. Paths are named on this machine
 * only, never in an Actions log.
 */
export function localLoginChecks({ inputs, env = process.env, local, home = homedir() }) {
  if (!local || env.GITHUB_ACTIONS) return [];
  const h = inputs.harness;
  // A Copilot stage's home is one Pendulum makes for the Objective, which holds no login.
  const exposed = h === "copilot" ? [] : loginsExposedBy(h, env, home);
  const linked = h === "copilot" ? [] : ownLoginProblems(h, env, home);
  if (exposed.length || linked.length) return [...linked.map((l) => WARN("harness logins", `${l.path}: a login file of the ${h} login stages run on, which leads into another login (${l.real}), so its harness would read that login; serve refuses each stage (login-link)`, "make that login's files its own (no link into another login folder)")), ...exposed.map((e) => WARN("harness logins", `${e.path}: a harness login inside the ${h} harness's home ${e.home}, which its outer sandbox can write, so that sandbox can read it`, "move that login out of the harness's home, or point CLAUDE_CONFIG_DIR or CODEX_HOME at a folder of its own"))];
  const found = harnessLogins(home, env).filter((l) => l.files.some((p) => existsSync(p))).map((l) => l.dir);
  const own = h === "copilot" ? [] : ownLogin(h, env, home);
  const wrapper = h === "codex" ? codexWrapper(env, home) : null;
  return [...(wrapper ? [WARN("codex on PATH", `${wrapper.bin} is a script (${wrapper.real}), not Codex's own binary: if it runs the release in ${join(home, ".codex")}, Codex's sandbox cannot start on CODEX_HOME ${env.CODEX_HOME}, since that folder is hidden from it whole`, `put the link to Codex's release (${join(home, ".local", "bin", "codex")} from its installer) first on PATH`)] : []), PASS("harness logins", `${found.length ? found.join(", ") : "none found"}: hidden from every sandbox${own.length ? `; the ${h} stage's own login (${own.join(", ")}) is readable to its harness process only` : ""}`)];
}

/**
 * Local mode: the machine's stage budget every Pendulum loop here shares (lib/machine.mjs), its limits in force
 * (machineLimits), who holds its slots (pid, repository, issue and stage), and the machine's load now, with whether loops
 * here hold new starts on it. A budget setting or limit that cannot be used, a PENDULUM_LOCAL_MAX_CONCURRENT above the
 * budget (`env`: this shell's over the workflow's) and a saturated machine are WARNs. `settings`: what a local stage
 * reads (doctorSettings `stage`), for the guess when machine.json sets none. Read only: doctor removes no slot. `home`
 * and `proc` are a test's own.
 */
export function machineChecks({ env = process.env, local, home = homedir(), proc = "/proc", settings = env }) {
  if (!local || env.GITHUB_ACTIONS) return [];
  const budget = machineBudget({ home });
  const holders = slotHolders(slotsDir(home), { reap: false });
  const pressure = readPressure({ root: proc });
  const limits = machineLimits({ home });
  const sat = saturation(pressure, limits.pressure);
  const problems = limits.problems.filter((p) => p !== budget.problem);
  // The guess: machine.json's, else the repository's guess_hours, as a local stage reads it (`settings`, serve's baseEnv).
  const repoGuess = guessHoursMs(settings.PENDULUM_GUESS_HOURS) !== null;
  const inForce = { ...limits, guessMs: limits.from.guess === "setting" ? limits.guessMs : resolveInputs({ env: settings }).guessMs };
  const set = `the pressure limits from ${limits.from.pressure === "setting" ? limits.file : `Pendulum's defaults (set them in ${limits.file})`}, the guess from ${limits.from.guess === "setting" ? limits.file : repoGuess ? "the repository's PENDULUM_GUESS_HOURS" : "Pendulum's default"}`;
  const what = (h) => h.pid === undefined ? `a holder whose record cannot be read yet (${h.file})` : `pid ${h.pid} ${h.repo || "(no repository)"} ${h.issue ? `#${h.issue}` : h.pr ? `PR #${h.pr}` : "(starting)"}${h.stage ? ` ${h.stage}` : ""}`;
  const from = budget.from === "setting" ? budget.file : `from its ${budget.cpus} CPU threads and ${Math.round(budget.memBytes / 2 ** 30)} GB: a quarter of the threads, at most one per 8 GB; set it in ${budget.file}`;
  const cap = loopCap(env.PENDULUM_LOCAL_MAX_CONCURRENT, budget.stages);
  return [
    ...(cap > budget.stages ? [WARN("PENDULUM_LOCAL_MAX_CONCURRENT", `${cap} is above this machine's stage budget of ${budget.stages}, which every Pendulum loop here shares, so a loop runs at most ${budget.stages}`, `to run more stages on this machine, raise the budget: write {"stages": ${cap}} to ${budget.file}; else lower PENDULUM_LOCAL_MAX_CONCURRENT to ${budget.stages} or less`)] : []),
    budget.problem ? WARN("machine budget", `${budget.problem}, so local mode uses ${budget.stages} stage(s), from this machine's size`, `write {"stages": N} to ${budget.file}, N a positive whole number`) : PASS("machine budget", `${budget.stages} stage(s) at once on this machine, shared by every Pendulum loop here (${from})`),
    problems.length ? WARN("machine limits", `${problems.join("; ")}, so Pendulum's defaults stand for those; in force: ${limitsLine(inForce)}`, `correct ${limits.file}: "pressure" takes cpu_psi, load, memory_psi and available_gb, and "guess_hours" a list of hours, each a number above 0 and at most ${GUESS_MAX_HOURS}`) : PASS("machine limits", `${limitsLine(inForce)}; ${set}`),
    PASS("machine slots", `${holders.length} of ${budget.stages} held${holders.length ? `: ${holders.map(what).join("; ")}` : ""}`),
    sat ? WARN("machine load", `${pressureLine(pressure)}: saturated (${sat.why}), so the loops here hold new starts; a loop that holds no stage still starts one`, "wait for the load to fall, or end work outside Pendulum on this machine") : PASS("machine load", `${pressureLine(pressure)}: loops here start stages as the budget allows`),
  ];
}

/**
 * The hosts the open Objectives' host labels open to their own sandboxes (choice.mjs hostsOf), beyond the hosts every
 * Objective reaches: one PASS naming each Objective with its hosts, or that none has one; a WARN for an Objective whose
 * host label names no host a sandbox can allow (each of its stages Blocks on it). Who applied each label is every
 * stage's own check (objective-trust.mjs choiceTrusted), not read here. `list` (the open Objectives) is a test's own.
 */
export async function objectiveHostChecks({ inputs, repo, token, list = () => rest(`repos/${repo.full}/issues?state=open&labels=${encodeURIComponent(inputs.objectiveLabel)}&per_page=100`, { token, paginate: true }) }) {
  let issues;
  try {
    issues = await list();
  } catch (e) {
    return [WARN("objective hosts", `the open Objectives could not be read (${String(e?.message || e).slice(0, 160)}), so the hosts their ${HOST_PREFIX} labels open are not shown`, "run doctor again once GitHub answers")];
  }
  const shown = [];
  const out = [];
  for (const issue of Array.isArray(issues) ? issues : []) {
    if (issue?.pull_request) continue;
    const h = hostsOf(issue?.labels || []);
    if (!h.labels.length) continue;
    if (h.ok) shown.push(`#${issue.number}: ${h.hosts.join(", ")}`);
    else out.push(WARN("objective hosts", `#${issue.number}: ${h.reason}, so each of its stages Blocks`, h.fix));
  }
  const detail = shown.length ? `${shown.join("; ")}; each opened to that Objective's own sandboxes alone, and only when a person who can push applied the label` : `no open Objective has a ${HOST_PREFIX} label: every Objective's sandboxes reach the repository's hosts alone`;
  return [PASS("objective hosts", detail), ...out];
}

/**
 * Whether a declared account's login works, by its CLI's own login status (exit code only; its output, which can name the
 * person, is never read): `claude auth status` and `codex login status` on the account's folder. True, false, or null
 * when the CLI is not on PATH or did not answer.
 */
export function cliLoggedIn(account, env = process.env) {
  const bin = account.harness;
  if (!whichSync(bin)) return null;
  const args = bin === "claude" ? ["auth", "status"] : ["login", "status"];
  const r = spawnSync(bin, args, { env: accountEnv(env, account), stdio: "ignore", timeout: 30_000 });
  return r.status === 0 ? true : r.status === 1 ? false : null;
}

/**
 * Whether a declared Copilot account's token is one GitHub takes (GET /user: 200), with no write anywhere; true, false,
 * or null when GitHub did not answer. The token never leaves this process but to GitHub.
 */
export const copilotTokenWorks = (token) => rest("user", { token }).then(() => true, (e) => (e.status === 401 || e.status === 403 ? false : null));

/**
 * Local mode: each account this machine declares (lib/accounts.mjs, ~/.config/pendulum/accounts.json), named by its name
 * alone, never a path. A declaration serve would refuse is a FAIL per account, with why. Else, per account: its folder
 * owner-only (a WARN), its login hidden from every sandbox (credentialPaths covers its login files) and in no home another
 * account's harness may write (loginsExposedBy), and its login working (`loggedIn`, `tokenWorks`: seams for the tests).
 * Nothing declared: one PASS saying each harness runs on its one login.
 */
export async function localAccountChecks({ env = process.env, local, home = homedir(), checkout = null, loggedIn = cliLoggedIn, tokenWorks = copilotTokenWorks }) {
  if (!local || env.GITHUB_ACTIONS) return [];
  const loaded = loadAccounts({ home, env, roots: sandboxRoots(checkout, home) });
  const fix = "fix that entry in ~/.config/pendulum/accounts.json (docs/LOCAL.md, Accounts); serve refuses to start and each stage Blocks until then";
  if (!loaded.ok) return loaded.problems.map((p) => FAIL(`account ${p.account}`, p.why, fix));
  if (!loaded.declared) return [PASS("accounts", "none declared: each harness runs on its one login (claude, codex, copilot)")];
  const all = Object.values(loaded.accounts).flat();
  const denied = credentialPaths(home, env);
  const covered = (p) => denied.some((d) => p === d || p.startsWith(`${d}/`));
  const logins = harnessLogins(home, env);
  const out = [];
  for (const a of all) {
    const name = `account ${a.name}`;
    const rows = [];
    if (a.home && statSync(a.home).mode & 0o077) rows.push(WARN(name, `its ${a.harness === "claude" ? "Claude Code" : "Codex"} folder is open to the group or others`, "chmod 700 that folder"));
    const login = a.home ? logins.find((l) => l.harness === a.harness && l.dir === a.home) : null;
    const files = a.tokenFile ? [a.tokenFile] : (login?.files ?? [a.home]);
    if (!files.every(covered)) rows.push(FAIL(name, "its login is not hidden from every sandbox", "report it: every declared login is on the sandboxes' deny list"));
    const exposer = all.find((b) => b !== a && b.home && loginsExposedBy(b.harness, accountEnv(env, b, home), home).some((x) => x.path === a.home));
    if (exposer) rows.push(FAIL(name, `its folder is inside a home account ${exposer.name}'s harness may write, so that harness's sandbox can reach it`, fix));
    const works = a.tokenFile ? await tokenWorks(accountToken(a)) : loggedIn(a, env);
    if (works === false) rows.push(FAIL(name, a.tokenFile ? "GitHub refuses its token" : `its ${a.harness} login does not work (not logged in)`, a.tokenFile ? "save a new fine-grained token with the Copilot Requests permission to its file" : `log in on that folder: ${a.harness === "claude" ? "CLAUDE_CONFIG_DIR=<its folder> claude" : "CODEX_HOME=<its folder> codex login"}`));
    else if (works === null) rows.push(WARN(name, a.tokenFile ? "GitHub did not answer the token check" : `its login was not checked (${a.harness} is not on PATH or did not answer)`, "run doctor --local again"));
    out.push(...(rows.length ? rows : [PASS(name, `${a.harness}${loaded.accounts[a.harness][0] === a ? ", its default" : ""}: on its own path, hidden from every sandbox, login works`)]));
  }
  return out;
}

/**
 * Local mode with Codex or Copilot: each PENDULUM_LOCAL_DOMAINS entry that is no host name (a loopback name, an IP address,
 * host:port) is a WARN. serve leaves it out of their sandbox policies: Copilot drops its whole network policy for a
 * host:port entry (#106), and Codex's proxy ignores the port and admits every port of the host (#108).
 */
export function localDomainChecks({ inputs, env = process.env, local }) {
  if (!local || !["codex", "copilot"].includes(inputs.harness)) return [];
  const dropped = sandboxDroppedHosts([env.PENDULUM_LOCAL_DOMAINS || ""]);
  if (!dropped.length) return [];
  const why = inputs.harness === "copilot" ? "Copilot drops its whole network policy for such an entry" : "Codex's proxy ignores the port and would admit every port of the host";
  return [WARN("PENDULUM_LOCAL_DOMAINS", `not host names, so ${inputs.harness === "copilot" ? "Copilot's" : "Codex's"} sandbox does not allow them (serve leaves them out: ${why}): ${dropped.map((d) => JSON.stringify(d)).join(", ")}`, "write each as a host name (example.com) or *. and one (*.example.com), comma or space separated; no scheme, port, path, IP address or localhost")];
}

/**
 * The settings doctor checks with (#236, #284). On Actions they are this process's own: the workflow's env block, with
 * the repository's variables laid over it (inputs.mjs applyVariables). Off Actions the env block is not: with
 * `--checkout`, or in local mode from a clone, it is read as local mode does, from the default branch's committed
 * workflow (#122), else from the checkout; without either, from the default branch's committed workflow through
 * GitHub's contents API with `token` (else the developer's gh login). Only its settings, as local mode takes them
 * (#119): any other PENDULUM_* name there is repository content. The repository's variables go over it, listed with
 * `varsToken` (local mode's token in local mode, as serve lists them; a token that may not is a WARN with the fix, and
 * the workflow's values stand); this shell wins over both. GitHub's copy unreadable: the checkout's copy if there is
 * one, and one WARN naming the harness that leaves. `committed`: local mode's read of the clone (local.mjs
 * committedWorkflowEnv), or null. Returns {wf, committed, env, stage, inputs, layers, listed, checks}: `listed`, the
 * variables list as read (github.mjs repositoryVariables), or null; `stage`, the settings a local
 * stage reads (local.mjs baseEnv: this shell's own settings only, inputs.mjs machineSettings, over the repository's).
 */
export async function doctorSettings({ args, checkout, repo, token, varsToken = token, committed = null, env = process.env, local = false }) {
  const checks = [];
  let variables = {};
  // The list as read ({vars} or {refused: status}), for the App id row (localAppIdCheck); null when it was not read.
  let listed = null;
  if (!env.GITHUB_ACTIONS) {
    const who = local ? "the local token" : "doctor's token";
    const fix = local ? "give the local token Variables: read (docs/LOCAL.md, Set it up)" : "run doctor with a gh login that can read the repository's variables (an admin's), or with --local and local mode's token";
    try {
      const r = await repositoryVariables(repo, { token: varsToken });
      listed = r;
      if (r.refused) checks.push(WARN("repository variables", `${who} cannot read the repository's variables (HTTP ${r.refused}), so the checks take the workflow's values${local ? " and so does local mode on this machine" : ""}`, fix));
      else {
        variables = r.vars;
        const org = organizationVariablesLine(await organizationVariableNames(repo, { token: varsToken }));
        if (org) checks.push(WARN("organization variables", org, "set Pendulum's variables on the repository (gh variable set PENDULUM_<NAME> --repo OWNER/NAME) and delete the organization's"));
      }
    } catch (e) {
      checks.push(WARN("repository variables", `not read (${e.status ? `HTTP ${e.status}` : String(e.message).slice(0, 80)}), so the checks take the workflow's values`, "run doctor again"));
    }
  }
  const settle = (wf, from, more = []) => {
    const layers = env.GITHUB_ACTIONS ? (appliedLayers() ?? settingLayers({ workflow: workflowSettings(env).kept })) : settingLayers({ workflow: workflowSettings(wf).kept, variables, machine: env });
    const merged = env.GITHUB_ACTIONS ? env : { ...settingLayers({ workflow: workflowSettings(wf).kept, variables }).values, ...env };
    // What a local stage reads, as serve's baseEnv builds it: the repository's settings, under this shell's own
    // (inputs.mjs machineSettings) only.
    const stage = env.GITHUB_ACTIONS ? env : { ...settingLayers({ workflow: workflowSettings(wf).kept, variables }).values, ...machineSettings(env) };
    return { wf, committed: from, env: merged, stage, inputs: resolveInputs({ args, env: merged }), layers, listed, checks: [...more, ...checks] };
  };
  if (env.GITHUB_ACTIONS || args.checkout || (committed && !committed.noClone)) return settle(committed ? committed.wf : readWorkflowEnv(checkout), committed);
  const path = ".github/workflows/pendulum.yml";
  try {
    return settle(workflowEnv(String(await rest(`repos/${repo.full}/contents/${path}`, { token, raw: "Accept: application/vnd.github.raw+json" }))), null);
  } catch (e) {
    const here = existsSync(join(checkout, path));
    const s = settle(readWorkflowEnv(checkout), null);
    if (e.code === "WORKFLOW_PARSE") {
      s.checks.unshift(WARN("workflow settings", `the default branch's ${e.message} on GitHub, so the checks take ${here ? `${checkout}'s copy` : "no workflow's settings"} and assume harness ${s.inputs.harness}`, "fix the YAML on the default branch (the error names the line), through a pull request"));
      return s;
    }
    const status = e.status ? `HTTP ${e.status}` : String(e.message).slice(0, 80);
    s.checks.unshift(WARN("workflow settings", `${path} could not be read from the default branch on GitHub (${status}), so the checks take ${here ? `${checkout}'s copy` : "no workflow's settings"} and assume harness ${s.inputs.harness}`, "merge the workflow into the default branch (pendulum:setup writes it) and give the token contents: read, or pass --checkout with a clone of the repository"));
    return s;
  }
}

/** doctor's flags (lib/inputs.mjs readFlags: `--dir` is `--checkout`, as on `pendulum`). */
export const DOCTOR_FLAGS = { repo: { value: "OWNER/NAME" }, checkout: { value: "CLONE" }, json: "bool", probe: "bool", "run-setup": "bool", local: "bool", verbose: "bool" };
const DOCTOR_USAGE = "usage: node scripts/doctor.mjs [--repo OWNER/NAME] [--checkout CLONE] [--json] [--probe] [--run-setup] [--local] [--verbose]\n  without --repo, the repository is the clone's origin remote (the clone in --checkout, else here); --verbose names every setting left at Pendulum's defaults\n";

/**
 * doctor's command line, checked before any check runs: {help} for --help or -h anywhere, else its flags. Throws an
 * error with `usage` set for an unknown flag or an argument, a flag's missing value, or a value given to a flag that
 * takes none.
 */
export function doctorArgs(argv) {
  if (argv.some((a) => a === "--help" || a === "-h")) return { help: true };
  const fail = (why) => Object.assign(new Error(`${why}\n${DOCTOR_USAGE}`), { usage: true });
  const flags = readFlags(argv, DOCTOR_FLAGS, fail);
  if (flags._.length) throw fail(`unexpected argument ${JSON.stringify(flags._[0])}`);
  return flags;
}

/**
 * Each effective setting and the layer it came from (#284, inputs.mjs settingLayers), as one row, the ones left at
 * Pendulum's defaults named only with `verbose`; and a WARN naming the repository variables that are ignored: a setting
 * only the reviewed workflow file sets, no setting at all, or a value Pendulum would not take as given.
 */
export function settingsRows(layers, { verbose = true } = {}) {
  const lines = layerLines({ values: layers.values, from: layers.from }, { defaults: verbose });
  const ignored = ignoredLines(layers);
  const more = verbose ? "" : "; --verbose names the ones left at Pendulum's defaults too";
  return [
    PASS("settings", lines.length ? `each over the one below (Pendulum's defaults, the workflow, the repository's variables, this machine)${more}:\n       ${lines.join("\n       ")}` : `every one at Pendulum's defaults${more}`),
    ...(ignored.length ? [WARN("repository variables", ignored.join("; "), "delete or correct those variables; a setting only the workflow file sets goes in its env block, through a pull request")] : []),
  ];
}

async function main() {
  let args;
  try {
    args = doctorArgs(process.argv.slice(2));
  } catch (e) {
    if (!e.usage) throw e;
    process.stderr.write(`doctor: ${e.message}`);
    process.exit(64);
  }
  if (args.help) {
    process.stdout.write(DOCTOR_USAGE);
    return;
  }
  const checkout = resolve(args.checkout || process.env.GITHUB_WORKSPACE || process.cwd());
  const local = !!args.local || backend().name === "local";
  const found = !process.env.GITHUB_ACTIONS && local ? committedWorkflowEnv(checkout) : null;
  // The repository and the App's credentials doctorSettings reads GitHub with: this shell's, else the local workflow's.
  const pre = resolveInputs({ args, env: process.env.GITHUB_ACTIONS ? process.env : { ...workflowSettings(found ? found.wf : readWorkflowEnv(checkout)).kept, ...process.env } });
  // No --repo (nor GITHUB_REPOSITORY): the clone's origin, as `pendulum serve` finds it.
  const repo = repoOf(pre.repo || cloneRepo(checkout));
  let token = pre.appToken || null;
  let app = null;
  if (!token && pre.appId && pre.appPrivateKey) {
    try {
      app = await mintInstallationToken({ appId: pre.appId, privateKey: pre.appPrivateKey, owner: repo.owner, repo: repo.name });
      token = app.token;
      mask(token);
    } catch (e) {
      app = { error: e.message };
    }
  }
  // The variables are listed as serve lists them: with local mode's token in local mode.
  // A token file reached through a symbolic link is not read (lib/local.mjs tokenPlaceProblem): a FAIL row with its fix.
  let linked = null;
  let ownToken = "";
  // Local mode's key folder under the product's previous name: no sandbox denies it (lib/local.mjs previousKeyDirProblem).
  const previous = local ? previousKeyDirProblem(homedir()) : null;
  if (local) {
    try {
      ownToken = localToken(repo.full);
    } catch (e) {
      if (!e.link) throw e;
      linked = FAIL("local token", tokenLinkDetail(e.link), TOKEN_LINK_FIX);
    }
  }
  const varsToken = ownToken || token;
  const { wf, committed, env, stage, inputs, layers, listed, checks: source } = await doctorSettings({ args, checkout, repo, token, varsToken, committed: found, local });
  const results = [defaultsCheck(inputs), ...(previous ? [FAIL("key folder", previous, `mv ${join(homedir(), ".config", PREVIOUS_NAME)} ${pendulumKeyDir(homedir())}`)] : []), ...(linked ? [linked] : []), ...source, ...settingsRows(layers, { verbose: !!args.verbose }), ...ownerLimitChecks({ inputs, local, stage })];
  results.push(...(await credentialChecks({ inputs, probe: !!args.probe, local })));
  results.push(...workerSecretChecks({ inputs, env }));
  results.push(...gatewayRelayChecks({ inputs, env }));
  results.push(...localDomainChecks({ inputs, env, local }));
  // The login a stage of this harness runs on: its default declared account's, else this shell's (lib/accounts.mjs).
  // The clone's directory is a root a sandbox writes under only when doctor runs from one (as serve does from its own).
  const clone = found && !found.noClone ? checkout : null;
  const declared = local ? loadAccounts({ env: process.env, roots: sandboxRoots(clone) }) : null;
  results.push(...localLoginChecks({ inputs, env: declared?.ok ? accountEnv(process.env, defaultAccount(declared, inputs.harness)) : process.env, local }));
  results.push(...(await localAccountChecks({ env: process.env, local, checkout: clone })));
  results.push(...machineChecks({ env, local, settings: stage }));
  if (committed) results.push(...workflowSourceChecks(readWorkflowEnv(checkout), committed));
  if (local) results.push(...workflowEnvChecks(wf));
  if (local) results.push(...localToolchainRows({ checkout, env: process.env, commands: localCommands(checkout, env) }));
  if (local && inputs.harness === "claude" && platform() === "linux") results.push(await claudeLocalStart({ checkout, commands: localCommands(checkout, env) }));
  if (app?.error) results.push(FAIL("app token", app.error, "check PENDULUM_APP_ID, the private key, and that the App is installed on this repository"));
  const appVar = process.env.GITHUB_ACTIONS && !local ? appIdVariableCheck({ variable: appIdVariable(), appId: pre.appId, repo }) : null;
  if (appVar) results.push(appVar);
  if (local && !process.env.GITHUB_ACTIONS && listed) results.push(await localAppIdCheck({ repo, listed, token: varsToken }));
  // The accounts for GitHub Actions and the cloud sandbox: the workflow's own env block (never a variable), as its jobs read it.
  const accounts = process.env.GITHUB_ACTIONS ? process.env.PENDULUM_ACCOUNTS : wf.PENDULUM_ACCOUNTS;
  const autoAccount = process.env.GITHUB_ACTIONS ? process.env.PENDULUM_AUTO_ACCOUNT : wf.PENDULUM_AUTO_ACCOUNT;
  if (!local) results.push(...routeAccountChecks(accounts, autoAccount));
  if (!local) results.push(...(await holdsIssueChecks({ repo, opts: token ? { token } : {}, accounts, auto: autoAccount, self: app?.appSlug ? `${app.appSlug}[bot]` : selfLogin() })));
  results.push(...(await githubChecks({ inputs, repo, token, app, local, accounts })));
  results.push(...(await objectiveHostChecks({ inputs, repo, token })));
  results.push(...(await sandboxStorageChecks({ inputs, repo, token })));
  results.push(...(await repositoryChecks({ inputs, checkout, runSetup: !!args["run-setup"], local, wf })));
  results.push(...(await runnerChecks({ inputs })));
  const fails = results.filter((r) => r.status === "FAIL").length;
  if (args.json) process.stdout.write(`${JSON.stringify({ ready: fails === 0, failures: fails, checks: results }, null, 2)}\n`);
  else {
    for (const r of results) process.stdout.write(`${r.status.padEnd(4)} ${r.name}: ${r.detail}${r.fix && r.status !== "PASS" ? `\n     fix: ${r.fix}` : ""}\n`);
    process.stdout.write(doctorFooter(results, repo));
  }
  process.exit(fails ? 1 : 0);
}

/**
 * doctor's last line: "ready", or the failures and setup's command for the GitHub fixes. setup's `all` leaves out the
 * default token, a repository-wide setting the repository's other workflows run on, so a FAIL there names its own step.
 */
export function doctorFooter(results, repo) {
  const fails = results.filter((r) => r.status === "FAIL").length;
  if (!fails) return "\nready\n";
  const tokenFix = results.some((r) => r.status === "FAIL" && r.name === "default workflow token") ? `; the default workflow token needs its own step, --apply default-token, whose dry run names the workflows it reaches` : "";
  return `\n${fails} failure(s); run node ${join(PLUGIN_ROOT, "scripts/setup.mjs")} --repo ${repo.full} --yes to apply the GitHub fixes${tokenFix}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    process.stderr.write(`[pendulum] doctor failed: ${e.message}\n`);
    process.exit(2);
  });
}
