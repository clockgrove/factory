#!/usr/bin/env node
// Factory setup: apply the GitHub fixes doctor names, on consent.
//   node scripts/setup.mjs --repo OWNER/NAME --yes [--apply labels|project|protection|workflow|all]
//                          [--ci-checks "Quality,Tests"] [--merge-queue false] [--harness claude] [--out .github/workflows/factory.yml]
//                          [--action clockgrove/factory@vX.Y.Z]   (default: the latest Factory release)   the `uses:` the workflow calls (a path inside the repo works: owner/repo/dir@ref)
//                          [--sandbox vercel [--ci-workflow NAME]]   stages run in a cloud sandbox, started by launch jobs (docs/ADAPTERS.md)
//                          [--runs-on RUNNER] [--ci-workflow NAME]   the work and review jobs' runner (Linux); default: the Linux runner
//                                                                    of the CI workflow's (NAME, else the one on pull_request) job that runs
//                                                                    setup or validation, else a required check's, else ubuntu-latest.
//                                                                    Doctor's runner check compares against the one on pull_request.
// Without --yes it prints what each step would do and exits. It never creates a
// GitHub App: it verifies the one whose app_id and app_private_key it is given
// (or FACTORY_APP_TOKEN) and tells the adopter the App's permissions.
//   labels      factory:objective, the state labels, P0..P2
//   project     the Factory Project (v2) with Status = Queued, Running, In review, Blocked, Done (GraphQL)
//   protection  the "factory" ruleset on the default branch: merge queue, required checks,
//               no deletion, no force push (rulesets REST API).
//               Rulesets and repository settings need `administration`, which the App does not
//               have: this step runs with the user's own `gh` login (an admin), never the App.
//   workflow    .github/workflows/factory.yml from workflow-template.yml with the inputs given: the work and review
//               jobs, or with --sandbox the launch jobs and their triggers (a comment, a finished CI run). Over an
//               existing file it keeps every setting that file states (env values, the launch gate's maintainer ids,
//               the runner, the CI workflow, a pinned Action other than an older Factory release) unless a flag gives
//               one (`--name=` clears one), and prints what it kept and changed.
import { pathToFileURL } from "node:url";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { APP_PERMISSIONS_TEXT, mintInstallationToken } from "./lib/app-token.mjs";
import { PLUGIN_ROOT } from "./lib/checkout.mjs";
import { COLUMNS, createProject, ensureLabel, ensureRuleset, findProject, getRepo, graphql, listRulesets, repoOf, requiredChecks, rest } from "./lib/github.mjs";
import { DEFAULTS, FACTORY_VERSION, SECRET_INPUTS, mask, parseArgs, resolveInputs } from "./lib/inputs.mjs";
import { ADAPTERS } from "./lib/adapters/sandbox.mjs";
import { parseMaintainer, protectedPaths, unprotectedFiles } from "./lib/logic.mjs";
import { ciRunner, ciWorkflowTriggers, runnerLabels, setupScripts, unreadableRunners } from "./doctor.mjs";
import { parseYaml } from "./lib/yaml.mjs";

export const LABELS = [
  ["factory:objective", "1D76DB", "An Objective for Factory to build unattended"],
  ["factory:running", "0E8A16", "Factory worker running (fallback for the Project card)"],
  ["factory:in-review", "FBCA04", "Factory PR open, reviewer pass pending or done"],
  ["factory:blocked", "B60205", "Factory stopped; see the Blocked comment"],
  ["factory:question", "D93F0B", "Factory opened a draft PR with a question"],
  ["factory:review", "C5DEF5", "Applied by the Factory App to trigger the review job"],
  ["factory:restart", "5319E7", "Restart this Objective from the issue's current text (any state)"],
  ["factory:draft", "D4C5F9", "A draft Objective: Factory never runs it while this label is on"],
  ["P0", "B60205", "Priority 0"],
  ["P1", "D93F0B", "Priority 1"],
  ["P2", "FBCA04", "Priority 2"],
];

/** The numeric ids of `login#id` entries, comma-separated: what the launch gate's `if:` matches comments against. */
export const maintainerIds = (entries) => [...new Set((entries || []).map((e) => parseMaintainer(String(e || ""))?.id).filter((id) => Number.isSafeInteger(id) && id > 0))].join(",");

/**
 * Render workflow-template.yml: `{{key}}` from inputs, with the script default when empty. A section between the comment
 * lines `# {{#key}}` and `# {{/key}}` is kept only when `key` has a value, one between `# {{^key}}` and `# {{/key}}` only
 * when it has none; the comment lines themselves go. So the file holds one route (runner jobs, or launch jobs), never both.
 */
export function renderWorkflow(template, values) {
  const out = [];
  let keep = true;
  for (const line of template.split("\n")) {
    const open = /^\s*# \{\{([#^])([a-zA-Z0-9_]+)\}\}\s*$/.exec(line);
    if (open) {
      const has = values[open[2]] !== undefined && values[open[2]] !== null && values[open[2]] !== "";
      keep = open[1] === "#" ? has : !has;
      continue;
    }
    if (/^\s*# \{\{\/[a-zA-Z0-9_]+\}\}\s*$/.test(line)) {
      keep = true;
      continue;
    }
    if (keep) out.push(line);
  }
  return out.join("\n").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    let v = values[key];
    // `{raw}`: text the caller already made valid YAML (a JSON string), inserted as it is.
    if (v && typeof v === "object" && typeof v.raw === "string") return v.raw;
    if (v === undefined || v === null || v === "") v = key in DEFAULTS ? DEFAULTS[key] : "";
    return yamlScalar(String(v));
  });
}

/** Quote a value when YAML would misread it bare (empty, colon-space, hash, leading symbol). */
export function yamlScalar(v) {
  if (v === "" || /(^[\s!&*?|>%@`'"{}[\],-])|(: )|( #)|(^(true|false|null|yes|no|on|off)$)|(:$)|\s$/i.test(v)) return JSON.stringify(v);
  return v;
}

async function applyLabels(repo, opts) {
  const made = [];
  for (const [name, color, description] of LABELS) if (await ensureLabel(repo, name, color, description, opts)) made.push(name);
  return made.length ? `created ${made.join(", ")}` : "all labels present";
}

export async function applyProjectStep(repo, opts) {
  // A personal account's board is out of every GitHub App's reach (Projects is an organization permission, #199).
  if ((await getRepo(repo, opts)).owner?.type === "User") return "skipped: a repository a user owns gets no board Factory can move; labels carry each Objective's state";
  const existing = await findProject(repo, opts);
  if (existing) {
    const names = (existing.field?.options || []).map((o) => o.name);
    const missing = COLUMNS.filter((c) => !names.includes(c));
    if (!missing.length) return `project "${existing.title}" already has ${COLUMNS.join(", ")}`;
    // Add the missing options, keeping the existing ones (and their ids) in place.
    const colors = { Queued: "GRAY", Running: "BLUE", "In review": "YELLOW", Blocked: "RED", Done: "GREEN" };
    const all = [...existing.field.options.map((o) => ({ name: o.name, color: o.color || "GRAY", description: o.description || "" })), ...missing.map((name) => ({ name, color: colors[name], description: "" }))];
    const literal = all.map((o) => `{name: ${JSON.stringify(o.name)}, color: ${o.color}, description: ${JSON.stringify(o.description)}}`).join(", ");
    await graphql(`mutation($f: ID!) { updateProjectV2Field(input: {fieldId: $f, singleSelectOptions: [${literal}]}) { projectV2Field { ... on ProjectV2SingleSelectField { id } } } }`, { f: existing.field.id }, opts);
    return `added ${missing.join(", ")} to project "${existing.title}"`;
  }
  const p = await createProject(repo, opts);
  return `created project "Factory" (#${p.number}) with ${COLUMNS.join(", ")} and linked it to ${repo.full}`;
}

/**
 * Why GitHub offers no merge queue on this repository, from its own record, or null when it may: GitHub offers one on a
 * repository an organization owns (public, or private on Enterprise Cloud), never on one a user owns. A private
 * organization repository outside Enterprise Cloud is not told apart here: GitHub refuses the rule, and applyProtection
 * then makes the ruleset without it.
 */
export const noQueueReason = (repoData) => (repoData?.owner?.type && repoData.owner.type !== "Organization" ? "GitHub offers no merge queue on a repository a user owns" : null);

/** Whether the repository's `factory` ruleset holds a merge_queue rule now. */
async function rulesetHasQueue(repo, opts) {
  const existing = (await listRulesets(repo, opts)).find((r) => r.name === "factory");
  if (!existing) return false;
  const full = await rest(`repos/${repo.full}/rulesets/${existing.id}`, opts);
  return (full?.rules || []).some((r) => r.type === "merge_queue");
}

export async function applyProtection(repo, { ciChecks, queue }, opts) {
  const repoData = await getRepo(repo, opts);
  const branch = repoData.default_branch;
  let why = queue ? noQueueReason(repoData) : "--merge-queue false";
  if (queue && !why) {
    // Whether GitHub took a queue here before: then a refusal now is a real error, never "not offered".
    const hadQueue = await rulesetHasQueue(repo, opts).catch(() => true);
    try {
      await ensureRuleset(repo, { branch, checks: ciChecks, queue: true }, opts);
    } catch (e) {
      // Only a private organization repository can lack a queue (outside Enterprise Cloud); GitHub offers one on every
      // public organization repository, so a 422 there, or where a queue stood before, is a real error and surfaces.
      if (e?.status !== 422 || repoData.private !== true || hadQueue) throw e;
      why = `GitHub refused a merge queue on this private repository: ${String(e.message || "").slice(0, 160)}`;
    }
  }
  if (why) await ensureRuleset(repo, { branch, checks: ciChecks, queue: false }, opts);
  // A squash commit's message is the PR's title and body (Factory's own text), never the branch's commit messages.
  await rest(`repos/${repo.full}`, { ...opts, method: "PATCH", body: { squash_merge_commit_title: "PR_TITLE", squash_merge_commit_message: "PR_BODY" } });
  return `ruleset "factory" on ${branch}: ${why ? `no merge queue (${why}; Factory runs on strict required checks), ` : "merge queue, "}${ciChecks.length ? `required checks ${ciChecks.join(", ")}` : "no required checks (pass --ci-checks)"}, no deletion or force push; squash commits take the PR's title and body`;
}

/** `login#id` for the workflow's notify user, so Factory trusts the account and not whoever holds the login later. */
async function pinnedLogin(login) {
  if (!login) return "";
  const u = await rest(`users/${encodeURIComponent(login)}`, {}).catch(() => null);
  return u?.id ? `${u.login}#${u.id}` : login;
}

/**
 * The runner for the work and review jobs, which run the repository's setup command and need Linux: `--runs-on` when
 * given, else the CI workflow's Linux runner (doctor's ciRunner: the job that runs setup or validation, else a required
 * check's; never a container-only runner such as ubuntu-slim), else ubuntu-latest. `ci`: ciWorkflowTriggers's result.
 * `note` says which (`source` names where a given runsOn came from), for setup's output. Never throws on a runner label.
 */
export function pickRunner(runsOn, ci, hints = {}, source = "--runs-on") {
  if (runsOn) {
    const label = runsOnLabel(runsOn);
    const unread = runnerLabels(label) ? "" : `; could not read the runner label ${JSON.stringify(label)}, so it renders as one quoted label: write a YAML list such as [self-hosted, linux]`;
    return { runsOn: label, note: `work and review jobs run on ${label} (${source})${unread}` };
  }
  const want = ciRunner(ci, hints);
  const unread = unreadableRunners(ci?.found ? (ci.jobs || []).map((j) => j.runner) : []);
  const skipped = unread.length ? `; could not read the runner label ${unread.map((l) => JSON.stringify(l)).join(", ")}, so it was skipped` : "";
  if (!want) return { runsOn: "ubuntu-latest", note: `work and review jobs run on ubuntu-latest: ${ci?.found ? `${ci.name} names no full Linux runner` : "no CI workflow read"}${skipped}; pass --runs-on <runner> to pin the Linux runner your CI uses` };
  const others = want.linux.length > 1 ? `; its Linux jobs also use ${want.linux.filter((r) => r !== want.runner).join(", ")}: pass --runs-on to pick another` : "";
  return { runsOn: want.runner, note: `work and review jobs run on ${want.runner}, the runner of ${ci.name}'s ${want.job.replace(/^its /, "")}${others}${skipped}` };
}

/**
 * A `--runs-on` value as a runner label (doctor's runnerLabel form): one label as it is, a label list typed as JSON or
 * as a YAML flow sequence (`[self-hosted, linux]`) as a JSON list. A `[` value that is neither stays as it is, which
 * runnerLabels cannot read.
 */
export function runsOnLabel(value) {
  const v = String(value || "").trim();
  if (!v.startsWith("[")) return v;
  if (runnerLabels(v)) return JSON.stringify(runnerLabels(v));
  let list;
  try {
    list = parseYaml(`runs-on: ${v}`)?.["runs-on"];
  } catch {
    return v;
  }
  if (!Array.isArray(list) || !list.length || !list.every((l) => typeof l === "string" && l.trim() && !l.includes("${{"))) return v;
  return JSON.stringify(list.map((l) => l.trim()));
}

/** The workflow template's runs_on value: a label list (JSON) as a YAML flow sequence, any other label a scalar. */
export function runsOnValue(label) {
  return label?.startsWith("[") && runnerLabels(label) ? { raw: label } : label || "ubuntu-latest";
}

/** The env keys the template sets from an input: FACTORY_<KEY> to the input it renders (`FACTORY_MAX_USD` to max_usd). */
export function templateEnvInputs(template) {
  const map = new Map();
  for (const m of template.matchAll(/^ {2}(FACTORY_[A-Z0-9_]+): \{\{([a-z0-9_]+)\}\}/gm)) map.set(m[1], m[2]);
  return map;
}

/** Every env key the template writes on either route (runner jobs or launch jobs). */
const templateEnvKeys = (template) => new Set(Object.keys(parseYaml(renderWorkflow(template, { sandbox: "vercel", action: "clockgrove/factory@v0.0.0" })).env || {}));

/** The numeric ids in a launch gate's `fromJSON('[...]')` lists (the maintainer ids; the association list holds none). */
export function gateIds(expr) {
  const ids = [];
  for (const m of String(expr || "").matchAll(/fromJSON\('((?:[^']|'')*)'\)/g)) {
    let list;
    try {
      list = JSON.parse(m[1].replace(/''/g, "'"));
    } catch {
      continue;
    }
    if (Array.isArray(list)) for (const v of list) if (Number.isSafeInteger(v) && v > 0) ids.push(v);
  }
  return [...new Set(ids)];
}

/**
 * The settings a factory.yml states, read as YAML: its env block (each value as a string), the launch gate's maintainer
 * ids, the work job's runner (a label list as JSON), the Action its dispatch step calls and the CI workflow it waits on.
 * Throws on a file the YAML reader cannot read, so a re-render never silently starts from defaults.
 */
export function workflowSettings(text) {
  const doc = parseYaml(text) || {};
  const env = {};
  for (const [k, v] of Object.entries(doc.env || {})) env[k] = v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  const jobs = doc.jobs || {};
  const runsOn = jobs.work?.["runs-on"];
  const step = (jobs.dispatch?.steps || []).find((s) => s?.id === "f");
  const ci = doc.on?.workflow_run?.workflows;
  return {
    env,
    lines: envLines(text),
    ids: gateIds(jobs["launch-gate"]?.if),
    runsOn: Array.isArray(runsOn) ? JSON.stringify(runsOn.map(String)) : runsOn == null ? null : String(runsOn),
    action: typeof step?.uses === "string" ? step.uses : null,
    ciWorkflow: Array.isArray(ci) && ci.length ? String(ci[0]) : null,
  };
}

/**
 * Each top-level env key's line as the file writes it and the comment lines directly above it (no blank line between),
 * so a re-render keeps hand-written notes and the exact spelling of keys the template does not write.
 */
export function envLines(text) {
  const out = {};
  const lines = String(text).split("\n");
  const start = lines.findIndex((l) => /^env:\s*(#.*)?$/.test(l));
  if (start < 0) return out;
  let comments = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const key = /^\s+([A-Za-z_][A-Za-z0-9_]*):/.exec(line);
    if (key) {
      out[key[1]] = { line, comments };
      comments = [];
    } else if (/^\s+#/.test(line)) comments.push(line);
    else comments = [];
  }
  return out;
}

/** Inputs that hold a harness's models: a re-render that moves to another harness takes that harness's defaults. */
const MODEL_INPUTS = new Set(["model", "subagent_model", "reviewer_model", "reviewer_effort", "effort"]);

/** Whether --harness names another harness than the existing file's FACTORY_HARNESS. */
const harnessMoved = (before, explicit) => Boolean(before) && explicit.harness !== undefined && String(explicit.harness).trim().toLowerCase() !== String(before.env.FACTORY_HARNESS || "").trim().toLowerCase();

/** The input an env key carries (FACTORY_MAX_USD to max_usd). */
const inputOfKey = (key) => key.replace(/^FACTORY_/, "").toLowerCase();

/**
 * The inputs a re-render keeps from the existing file's settings (`before`, workflowSettings's), as flags: each env value
 * the template renders from an input, FACTORY_MAINTAINERS, the work job's runner and the CI workflow. A flag on the
 * command line (`explicit`) wins, `--name=` included (it clears the value); a new --harness drops the file's models.
 */
export function keptArgs(before, explicit, template) {
  if (!before) return {};
  const out = {};
  const inputsOf = templateEnvInputs(template);
  inputsOf.set("FACTORY_MAINTAINERS", "maintainers");
  const moved = harnessMoved(before, explicit);
  for (const [key, value] of Object.entries(before.env)) {
    const name = inputsOf.get(key);
    if (!name || explicit[name] !== undefined || (moved && MODEL_INPUTS.has(name))) continue;
    out[name] = value;
  }
  if (before.runsOn && explicit.runs_on === undefined) out.runs_on = before.runsOn;
  if (before.ciWorkflow && explicit.ci_workflow === undefined) out.ci_workflow = before.ciWorkflow;
  return out;
}

/** A Factory release pin's numbers: [X, Y, Z] for vX.Y.Z, and the floating vX.Y and vX as [X, Y] and [X]. */
const releaseOf = (action) =>
  /^clockgrove\/factory@v(\d+)(?:\.(\d+)(?:\.(\d+))?)?$/
    .exec(String(action || ""))
    ?.slice(1)
    .filter((n) => n !== undefined)
    .map(Number) ?? null;
/** `a` is older than `b` on the numbers `a` names: a floating v0.6 is older than v0.7.121, a floating v0.7 is not. */
const olderRelease = (a, b) => {
  const i = a.findIndex((n, k) => n !== b[k]);
  return i >= 0 && a[i] < b[i];
};

/**
 * The Action the file calls: --action, else --version, else the existing file's own pin, except a Factory release older
 * than the newest, a floating vX.Y or vX of an older line included (the template is the newest release's: its jobs call
 * modes an older Action lacks), else the newest release.
 */
export function workflowAction({ explicit, before, latest }) {
  if (explicit.action) return explicit.action;
  if (explicit.version) return `clockgrove/factory@${explicit.version}`;
  const newest = `clockgrove/factory@${latest}`;
  const had = before?.action;
  if (!had) return newest;
  const [a, b] = [releaseOf(had), releaseOf(newest)];
  return a && b && olderRelease(a, b) ? newest : had;
}

/**
 * The rendered factory.yml (no network): `inputs` resolved from the flags with the kept settings under them, `notify` the
 * pinned login#id, `runsOn` the runner label (runner route), `defaultBranch` the repository's (sandbox route). The launch
 * gate keeps the existing file's maintainer ids beside the pinned ones unless --maintainers names others (a new --notify
 * drops the old notify id). Env keys the existing file has and the template does not are kept at the env block's end.
 */
export function workflowText({ template, inputs, args, explicit = args, before = null, latest, notify, runsOn = null, ciWorkflow, defaultBranch = "", protectedPaths = inputs.protectedAdditions }) {
  const sandbox = String(args.sandbox || "").trim().toLowerCase();
  const oldNotifyId = parseMaintainer(before?.env.FACTORY_NOTIFY || "")?.id ?? null;
  const keptIds = before && explicit.maintainers === undefined ? before.ids.filter((id) => explicit.notify === undefined || id !== oldNotifyId) : [];
  const ids = [...new Set([...maintainerIds([notify, ...inputs.maintainers]).split(",").filter(Boolean), ...keptIds.map(String)])];
  const values = {
    harness: inputs.harness,
    model: inputs.model,
    subagent_model: inputs.subagentModel,
    reviewer_model: inputs.reviewerModel,
    max_concurrent: String(inputs.maxConcurrent),
    daily_usd: String(inputs.dailyUsd),
    max_usd: String(inputs.maxUsd),
    timeout_minutes: String(inputs.timeoutMinutes),
    auto_merge: String(inputs.autoMerge),
    credential: inputs.credential,
    notify,
    // A self-hosted label list (ciRunner and runsOnLabel give it as JSON) is a YAML flow sequence as it is; any other
    // label (one that starts with `[` but is no list among them) is a quoted scalar.
    runs_on: runsOnValue(runsOn),
    setup: inputs.setup,
    install: inputs.install,
    // `parallel: ` marks would make a plain YAML value a mapping: renderWorkflow's yamlScalar quotes it, once.
    validation: inputs.validation.join(", "),
    budget_command: inputs.budgetCommand,
    protected_paths: protectedPaths.join(", "),
    ci_checks: inputs.ciChecks.join(", "),
    node_version: args.node_version || "22",
    action: workflowAction({ explicit, before, latest }),
    sandbox,
    sandbox_vcpus: String(args.sandbox_vcpus || "").trim() || "2",
    ci_workflow: ciWorkflow,
    // The pinned maintainers' numeric ids (login#id), so the launch gate lets their comments through whatever
    // association GitHub shows for them; digits and commas only, inside the gate's fromJSON('[...]').
    maintainer_ids: { raw: ids.join(",") },
    // The image job rebuilds the sandbox image on a push to this branch (lib/image.mjs).
    default_branch: sandbox ? { raw: JSON.stringify(defaultBranch) } : "",
    image_refresh: inputs.imageRefresh,
    image_daily_minutes: String(inputs.imageDailyMinutes),
    sandbox_idle_days: String(inputs.sandboxIdleDays),
    sweep_max_destroys: String(inputs.sweepMaxDestroys),
  };
  return withFileEnv(renderWorkflow(template, values), { template, before, explicit });
}

/**
 * The rendered text with what the existing file's env block holds beyond the template: the comment lines directly above
 * each key, and the keys the template does not write (at the env block's end, as the file spells them). A flag for such
 * a key's input wins (`--maintainers=` drops FACTORY_MAINTAINERS), --maintainers writes FACTORY_MAINTAINERS when the
 * file has none (the runtime trusts maintainers from it), and a new --harness drops the file's efforts.
 */
/** Inputs a re-render never writes into the workflow env from a flag: credentials and setup-only inputs. */
const NOT_ENV_INPUTS = new Set([...SECRET_INPUTS, "repo", "app_id", "mode", "issue", "pr", "action"]);

function withFileEnv(text, { template, before, explicit }) {
  const known = templateEnvKeys(template);
  const moved = harnessMoved(before, explicit);
  const lines = before?.lines || {};
  const extra = [];
  for (const [k, v] of Object.entries(before?.env || {})) {
    const name = inputOfKey(k);
    if (known.has(k)) continue;
    // A flag wins over a file's extra env line only for a workflow setting: a credential or a setup-only input given on
    // the command line (an App key, the repo) is never written into factory.yml; the file's own line stays.
    if (Object.hasOwn(DEFAULTS, name) && explicit[name] !== undefined && !NOT_ENV_INPUTS.has(name)) {
      const given = String(explicit[name]).trim();
      if (given) extra.push({ k, v: given, comments: lines[k]?.comments || [] });
    } else if (!(moved && MODEL_INPUTS.has(name))) extra.push({ k, v, comments: lines[k]?.comments || [], line: lines[k]?.line });
  }
  const maintainers = String(explicit.maintainers ?? "").trim();
  if (maintainers && !Object.hasOwn(before?.env || {}, "FACTORY_MAINTAINERS")) extra.push({ k: "FACTORY_MAINTAINERS", v: maintainers, comments: [] });
  const out = text.split("\n");
  const start = out.indexOf("env:");
  if (start < 0) return text;
  let end = start;
  for (let i = start + 1; i < out.length && (out[i].startsWith(" ") || !out[i].trim()); i += 1) if (/^ {2}\S/.test(out[i])) end = i;
  // The file's own line when it reads back as the same value on one line (its quoting and trailing comment kept).
  const lineOf = ({ k, v, line }) => {
    const own = line?.trim();
    if (own && !/:\s*[|>]/.test(own)) {
      try {
        const read = parseYaml(own)?.[k];
        if (read !== undefined && (read === null ? "" : typeof read === "object" ? JSON.stringify(read) : String(read)) === v) return `  ${own}`;
      } catch {
        // not one line of YAML on its own: written from the value below
      }
    }
    return `  ${k}: ${yamlScalar(v)}`;
  };
  out.splice(end + 1, 0, ...extra.flatMap((e) => [...e.comments.map((c) => `  ${c.trim()}`), lineOf(e)]));
  // Hand-written comments above a key the template writes go back above that key (not twice).
  for (let i = end; i > start; i -= 1) {
    const key = /^ {2}([A-Za-z_][A-Za-z0-9_]*):/.exec(out[i])?.[1];
    const comments = key && known.has(key) ? (lines[key]?.comments || []).map((c) => `  ${c.trim()}`) : [];
    if (comments.length && out.slice(i - comments.length, i).join("\n") !== comments.join("\n")) out.splice(i, 0, ...comments);
  }
  return out.join("\n");
}

/**
 * What a re-render kept and changed, one line each: env keys by name when kept, `KEY "old" -> "new"` when changed (with
 * the flag that changed it), keys the new template adds or the new route drops, and the gate's ids, runner, Action and
 * CI workflow when they moved. Empty for a first render.
 */
export function settingsReport(before, after, explicit = {}) {
  if (!before) return [];
  const kept = [];
  const changed = [];
  const added = [];
  const moved = harnessMoved(before, explicit);
  const why = (name) => (explicit[name] !== undefined ? ` (--${name.replace(/_/g, "-")})` : moved && MODEL_INPUTS.has(name) ? " (--harness: the new harness's default)" : "");
  for (const [k, v] of Object.entries(after.env)) {
    const reason = why(inputOfKey(k));
    if (Object.hasOwn(before.env, k) && before.env[k] === v) kept.push(k);
    else if (Object.hasOwn(before.env, k) || reason) changed.push(`${k} ${Object.hasOwn(before.env, k) ? JSON.stringify(before.env[k]) : "(none)"} -> ${JSON.stringify(v)}${reason}`);
    else added.push(`${k}=${JSON.stringify(v)}`);
  }
  const gone = Object.keys(before.env).filter((k) => !Object.hasOwn(after.env, k));
  const byFlag = gone.filter((k) => why(inputOfKey(k)));
  const dropped = gone.filter((k) => !byFlag.includes(k));
  const other = [
    ["launch gate maintainer ids", before.ids.join(","), after.ids.join(","), explicit.maintainers !== undefined ? " (--maintainers)" : explicit.notify !== undefined ? " (--notify)" : ""],
    ["runs-on", before.runsOn, after.runsOn, why("runs_on")],
    ["action", before.action, after.action, explicit.action || explicit.version ? " (--action)" : " (the newest release: the template is that release's)"],
    ["CI workflow", before.ciWorkflow, after.ciWorkflow, why("ci_workflow")],
  ];
  for (const [name, a, b, reason] of other) {
    if ((a ?? "") === (b ?? "")) {
      if (a) kept.push(name);
    } else changed.push(`${name} ${JSON.stringify(a ?? "")} -> ${JSON.stringify(b ?? "")}${reason}`);
  }
  return [
    kept.length && `kept ${kept.join(", ")}`,
    changed.length && `changed ${changed.join("; ")}`,
    added.length && `new in this template ${added.join(", ")}`,
    byFlag.length && `dropped ${byFlag.map((k) => `${k}${why(inputOfKey(k))}`).join(", ")}`,
    dropped.length && `dropped (not on this route) ${dropped.join(", ")}`,
  ].filter(Boolean);
}

/** The existing file's FACTORY_NOTIFY when it is login#id and no --notify is given (its id stays pinned), else null. */
export function keptNotify(before, explicit) {
  const filed = explicit.notify === undefined ? parseMaintainer(before?.env.FACTORY_NOTIFY || "") : null;
  return filed?.id ? `${filed.login}#${filed.id}` : null;
}

/**
 * What setup runs, on every route: each repository file its command names (doctor.mjs setupScripts) joins the protected
 * paths unless one already covers it, anchored at the root (`/build.mjs`, logic.mjs protectedCovers) so a file of the
 * same name deeper in the tree stays the worker's. {scripts, adding, protectedList}: the list to render as
 * FACTORY_PROTECTED_PATHS.
 */
export function protectSetup(inputs, checkout) {
  const scripts = setupScripts(inputs.setup, checkout);
  const adding = unprotectedFiles(scripts, protectedPaths(inputs.protectedAdditions)).map((f) => `/${f}`);
  return { scripts, adding, protectedList: [...inputs.protectedAdditions, ...adding] };
}

async function applyWorkflow({ inputs, args, explicit, before, template, checkout, latest, repo, opts }) {
  const notify = keptNotify(before, explicit) || (await pinnedLogin(inputs.notify));
  const sandbox = String(args.sandbox || "").trim().toLowerCase();
  if (sandbox && !Object.hasOwn(ADAPTERS, sandbox)) throw new Error(`--sandbox ${sandbox}: no such adapter (have: ${Object.keys(ADAPTERS).join(", ")})`);
  // CI finishing on a factory/ branch resumes a waiting stage (sandbox) or ticks the dispatcher's merge pass (both
  // routes): CI on Actions is named in workflow_run's filter. The runner jobs take the CI workflow's runner unless
  // --runs-on picks one.
  const readCi = !args.ci_workflow || (!sandbox && !args.runs_on);
  const ci = readCi ? await ciWorkflowTriggers(repo, opts, { name: args.ci_workflow || "" }).catch(() => ({})) : {};
  const ciWorkflow = args.ci_workflow || ci.name || "CI";
  // The same hints doctor's runner check uses: the setup and validation commands, and the required checks.
  const hints = { commands: [inputs.setup, ...inputs.validation], checks: sandbox || inputs.ciChecks.length || !ci.found ? inputs.ciChecks : await requiredChecks(repo, opts).catch(() => []) };
  const runner = sandbox ? null : pickRunner(args.runs_on, ci, hints, explicit.runs_on === undefined && args.runs_on ? "kept from the existing file" : "--runs-on");
  // Doctor compares against the workflow on pull_request, which --ci-workflow may not name: say so when they disagree.
  if (runner && args.ci_workflow && ci.found) {
    const pr = await ciWorkflowTriggers(repo, opts).catch(() => ({}));
    const theirs = pr.found && pr.name !== ci.name ? ciRunner(pr, hints) : null;
    if (theirs && theirs.runner !== runner.runsOn) runner.note += `; doctor compares against ${pr.name} (the workflow on pull_request), which runs on ${theirs.runner}, so it will warn`;
  }
  const { scripts, adding, protectedList } = protectSetup(inputs, checkout);
  const defaultBranch = sandbox ? (await getRepo(repo, opts)).default_branch : "";
  const out = resolve(args.out || join(checkout, ".github", "workflows", "factory.yml"));
  const text = workflowText({ template, inputs, args, explicit, before, latest, notify, runsOn: runner?.runsOn, ciWorkflow, defaultBranch, protectedPaths: protectedList });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text);
  const added = adding.length
    ? `; added ${adding.join(", ")} to FACTORY_PROTECTED_PATHS (setup runs it as the runner beside the App's key${sandbox ? ", as root into the image every stage starts from" : ""}, so a worker's commit may not change it)`
    : sandbox && inputs.setup && !scripts.length
      ? `; WARNING: no repository file found in the setup command to protect; with a sandbox setup runs as root into every stage's image, so add the files it runs to --protected-paths`
      : "";
  const report = settingsReport(before, workflowSettings(text), explicit).map((l) => `\n  ${l}`).join("");
  return `wrote ${out}${runner ? `; ${runner.note}` : ""}${added}; commit it on the default branch to start the cron (through a pull request once the ruleset is on: direct pushes to a protected branch are refused)${report}`;
}

/** The newest Factory release tag, so a new install never pins a stale one; this plugin's own version offline. */
async function latestRelease() {
  const tag = await rest("repos/clockgrove/factory/releases/latest", {}).then((r) => r?.tag_name, () => null);
  return /^v\d+\.\d+\.\d+$/.test(tag || "") ? tag : `v${FACTORY_VERSION}`;
}

async function main() {
  const explicit = parseArgs(process.argv.slice(2));
  const checkout = resolve(explicit.checkout || process.cwd());
  const steps = (explicit.apply || "all") === "all" ? ["labels", "project", "protection", "workflow"] : String(explicit.apply).split(",").map((s) => s.trim());
  // A re-render keeps what the existing file states (its env block, the gate's ids, the runner, the CI workflow and a
  // pinned Action); a flag still wins. The protection step's required checks come from the same settings.
  const template = readFileSync(join(PLUGIN_ROOT, "workflow-template.yml"), "utf8");
  const outPath = resolve(explicit.out || join(checkout, ".github", "workflows", "factory.yml"));
  let before = null;
  if (existsSync(outPath) && steps.some((s) => s === "workflow" || s === "protection")) {
    try {
      before = workflowSettings(readFileSync(outPath, "utf8"));
    } catch (e) {
      throw new Error(`could not read ${outPath} as YAML (${e.message}): fix it, or move it away to render from the defaults`);
    }
  }
  const args = { ...keptArgs(before, explicit, template), ...explicit };
  const inputs = resolveInputs({ args });
  if (!inputs.repo) throw new Error("--repo OWNER/NAME is required");
  const repo = repoOf(inputs.repo);
  const yes = args.yes === "true";
  // Labels, the board and the ruleset are created with the App when its credentials are given, else with the
  // user's own gh login (a developer running /factory setup); the App is verified, never created.
  let token = inputs.appToken || null;
  if (!token && inputs.appId && inputs.appPrivateKey) {
    // (the App is optional here; its absence is reported above)
    const app = await mintInstallationToken({ appId: inputs.appId, privateKey: inputs.appPrivateKey, owner: repo.owner, repo: repo.name });
    token = app.token;
    mask(token);
    process.stdout.write(`App ${app.appSlug}: installation ${app.installationId}${app.missing.length ? `; MISSING ${app.missing.join(", ")}` : "; permissions ok"}${app.extra.length ? `; extra ${app.extra.join(", ")}` : ""}\n`);
    if (app.missing.length) throw new Error(`the App lacks ${app.missing.join(", ")}; fix its permissions (${APP_PERMISSIONS_TEXT}) before setup`);
  }
  if (!token && yes) process.stdout.write("no App credentials given: GitHub steps run as your gh login\n");
  const opts = { token };
  const plan = {
    labels: `create the labels ${LABELS.map(([n]) => n).join(", ")} when absent`,
    project: `create the Factory Project (v2) with Status ${COLUMNS.join(", ")} and link it, or add missing columns (none on a repository a user owns: no GitHub App can move its cards)`,
    protection: `create or update the "factory" ruleset on the default branch (a merge queue where GitHub offers one, required checks ${inputs.ciChecks.join(", ") || "(none given: pass --ci-checks)"}, no deletion or force push) and set squash commits to take the PR's title and body; runs as your gh login (needs admin), not the App`,
    workflow: `write ${args.out || ".github/workflows/factory.yml"} from workflow-template.yml${args.sandbox ? ` with launch jobs for the ${args.sandbox} sandbox (secrets VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID)` : ""}${before ? `, keeping the settings the existing file states unless a flag gives one` : ""}`,
  };
  if (!yes) {
    process.stdout.write(`Dry run for ${repo.full}. Pass --yes to apply:\n`);
    for (const s of steps) process.stdout.write(`  ${s}: ${plan[s] || "unknown step"}\n`);
    return;
  }
  for (const s of steps) {
    let note;
    if (s === "labels") note = await applyLabels(repo, opts);
    else if (s === "project") note = await applyProjectStep(repo, opts);
    else if (s === "protection") note = await applyProtection(repo, { ciChecks: inputs.ciChecks, queue: args.merge_queue !== "false" }, { token: null });
    else if (s === "workflow") note = await applyWorkflow({ inputs, args, explicit, before, template, checkout, latest: await latestRelease(), repo, opts });
    else throw new Error(`unknown step ${s}`);
    process.stdout.write(`${s}: ${note}\n`);
  }
  process.stdout.write(`done; run node ${join(PLUGIN_ROOT, "scripts/doctor.mjs")} --repo ${repo.full} to confirm\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    process.stderr.write(`[factory] setup failed: ${e.message}\n`);
    process.exit(1);
  });
}

