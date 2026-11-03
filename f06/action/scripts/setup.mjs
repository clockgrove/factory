#!/usr/bin/env node
// Factory setup: apply the GitHub fixes doctor names, on consent.
//   node scripts/setup.mjs --repo OWNER/NAME --yes [--apply labels|project|protection|workflow|all]
//                          [--ci-checks "Quality,Tests"] [--merge-queue false] [--harness claude] [--out .github/workflows/factory.yml]
//                          [--action clockgrove/factory@v1]   the `uses:` the workflow calls (a path inside the repo works: owner/repo/dir@ref)
// Without --yes it prints what each step would do and exits. It never creates a
// GitHub App: it verifies the one whose app_id and app_private_key it is given
// (or FACTORY_APP_TOKEN) and tells the adopter the App's permissions.
//   labels      factory:objective, the state labels, P0..P2
//   project     the Factory Project (v2) with Status = Queued, Running, In review, Blocked, Done (GraphQL)
//   protection  the "factory" ruleset on the default branch: merge queue, required checks,
//               no deletion, no force push; plus Allow auto-merge on the repository (rulesets REST API).
//               Rulesets and repository settings need `administration`, which the App does not
//               have: this step runs with the user's own `gh` login (an admin), never the App.
//   workflow    .github/workflows/factory.yml from workflow-template.yml with the inputs given
import { pathToFileURL } from "node:url";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { mintInstallationToken } from "./lib/app-token.mjs";
import { ACTION_ROOT } from "./lib/checkout.mjs";
import { COLUMNS, createProject, ensureLabel, ensureRuleset, findProject, getRepo, graphql, repoOf, rest } from "./lib/github.mjs";
import { DEFAULTS, mask, parseArgs, resolveInputs } from "./lib/inputs.mjs";

export const LABELS = [
  ["factory:objective", "1D76DB", "An Objective for Factory to build unattended"],
  ["factory:running", "0E8A16", "Factory worker running (fallback for the Project card)"],
  ["factory:in-review", "FBCA04", "Factory PR open, reviewer pass pending or done"],
  ["factory:blocked", "B60205", "Factory stopped; see the Blocked comment"],
  ["factory:question", "D93F0B", "Factory opened a draft PR with a question"],
  ["factory:review", "C5DEF5", "Applied by the Factory App to trigger the review job"],
  ["P0", "B60205", "Priority 0"],
  ["P1", "D93F0B", "Priority 1"],
  ["P2", "FBCA04", "Priority 2"],
];

/** Render workflow-template.yml: `{{key}}` from inputs, with the script default when empty. */
export function renderWorkflow(template, values) {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    let v = values[key];
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

async function applyProject(repo, opts) {
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

async function applyProtection(repo, { ciChecks, autoMerge, queue }, opts) {
  const data = await getRepo(repo, opts);
  const branch = data.default_branch;
  await ensureRuleset(repo, { branch, checks: ciChecks, queue }, opts);
  let note = `ruleset "factory" on ${branch}: ${queue ? "merge queue, " : "no merge queue (--merge-queue false), "}${ciChecks.length ? `required checks ${ciChecks.join(", ")}` : "no required checks (pass --ci-checks)"}, no deletion or force push`;
  if (autoMerge && !data.allow_auto_merge) {
    await rest(`repos/${repo.full}`, { ...opts, method: "PATCH", body: { allow_auto_merge: true } });
    note += "; Allow auto-merge turned on";
  }
  return note;
}

function applyWorkflow({ inputs, args, checkout }) {
  const template = readFileSync(join(ACTION_ROOT, "workflow-template.yml"), "utf8");
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
    notify: inputs.notify,
    runs_on: args.runs_on || "ubuntu-latest",
    setup: inputs.setup,
    validation: inputs.validation.join(", "),
    budget_command: inputs.budgetCommand,
    protected_paths: inputs.protectedAdditions.join(", "),
    ci_checks: inputs.ciChecks.join(", "),
    action: args.action || `clockgrove/factory@${args.version || "v1"}`,
  };
  const out = resolve(args.out || join(checkout, ".github", "workflows", "factory.yml"));
  const text = renderWorkflow(template, values);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text);
  return `wrote ${out}; commit it on the default branch to start the cron`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputs = resolveInputs({ args });
  if (!inputs.repo) throw new Error("--repo OWNER/NAME is required");
  const repo = repoOf(inputs.repo);
  const checkout = resolve(args.checkout || process.cwd());
  const steps = (args.apply || "all") === "all" ? ["labels", "project", "protection", "workflow"] : String(args.apply).split(",").map((s) => s.trim());
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
    if (app.missing.length) throw new Error(`the App lacks ${app.missing.join(", ")}; fix its permissions before setup`);
  }
  if (!token && yes) process.stdout.write("no App credentials given: GitHub steps run as your gh login\n");
  const opts = { token };
  const plan = {
    labels: `create the labels ${LABELS.map(([n]) => n).join(", ")} when absent`,
    project: `create the Factory Project (v2) with Status ${COLUMNS.join(", ")} and link it, or add missing columns`,
    protection: `create or update the "factory" ruleset on the default branch (merge queue, required checks ${inputs.ciChecks.join(", ") || "(none given: pass --ci-checks)"}, no deletion or force push) and turn on Allow auto-merge${inputs.autoMerge ? "" : " (skipped: auto_merge false)"}; runs as your gh login (needs admin), not the App`,
    workflow: `write ${args.out || ".github/workflows/factory.yml"} from workflow-template.yml`,
  };
  if (!yes) {
    process.stdout.write(`Dry run for ${repo.full}. Pass --yes to apply:\n`);
    for (const s of steps) process.stdout.write(`  ${s}: ${plan[s] || "unknown step"}\n`);
    return;
  }
  for (const s of steps) {
    let note;
    if (s === "labels") note = await applyLabels(repo, opts);
    else if (s === "project") note = await applyProject(repo, opts);
    else if (s === "protection") note = await applyProtection(repo, { ciChecks: inputs.ciChecks, autoMerge: inputs.autoMerge, queue: args.merge_queue !== "false" }, { token: null });
    else if (s === "workflow") note = applyWorkflow({ inputs, args, checkout });
    else throw new Error(`unknown step ${s}`);
    process.stdout.write(`${s}: ${note}\n`);
  }
  process.stdout.write(`done; run node ${join(ACTION_ROOT, "scripts/doctor.mjs")} --repo ${repo.full} to confirm\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    process.stderr.write(`[factory] setup failed: ${e.message}\n`);
    process.exit(1);
  });
}

