#!/usr/bin/env node
// Pendulum setup: apply the GitHub fixes doctor names, on consent.
//   node scripts/setup.mjs [--repo OWNER/NAME] --yes [--apply app|labels|project|protection|default-token|workflow|all]  (several: repeat --apply, or a,b;
//                          all, the default, is every step but app and default-token, which run only when named)
//                          [--preset first-run]   the workflow's settings for a first run (PRESETS); a flag beside it wins
//                          [--secret-scope repo|org] [--replace]   where the app step saves the App's secrets (default: the
//                                                                    repository); --replace overwrites ones already there
//                          [--ci-checks "Quality,Tests"] [--merge-queue false] [--harness claude] [--out .github/workflows/pendulum.yml]
//                          [--action clockgrove/pendulum@vX.Y.Z]   (default: the latest Pendulum release)   the `uses:` the workflow calls (a path inside the repo works: owner/repo/dir@ref)
//                          [--sandbox vercel [--ci-workflow NAME]]   stages run in a cloud sandbox, started by launch jobs (docs/ADAPTERS.md)
//                          [--runs-on RUNNER] [--ci-workflow NAME]   the work and review jobs' runner (Linux); default: the Linux runner
//                                                                    of the CI workflow's (NAME, else the one on pull_request) job that runs
//                                                                    setup or validation, else a required check's, else ubuntu-latest.
//                                                                    Doctor's runner check compares against the one on pull_request.
//                          [--add-account [HARNESS:]NAME] [--remove-account NAME]   (repeat either, or a,b) the accounts GitHub
//                                                                    Actions and the cloud sandbox run on (PENDULUM_ACCOUNTS); a NAME alone
//                                                                    is the workflow's harness's; adding to a harness with none declared
//                                                                    keeps its usual account (named after it) first, as its default
//                          [--accounts JSON]   the whole declaration, {"claude": ["claude", "claude-2"]}; `--accounts=` clears it
//                          [--auto-account on|off]   PENDULUM_AUTO_ACCOUNT: automatic account choice
//                                                                    With none of these a re-render keeps the file's two lines; the workflow
//                                                                    step's note names each new secret to save (docs/INSTALL.md, Several accounts).
// Without --repo, the repository is the origin remote of the clone (--checkout, else here), as `pendulum serve` finds it.
// Without --yes it prints what each step would do and exits. Outside the app step it verifies the App whose app_id and
// app_private_key it is given (or PENDULUM_APP_TOKEN) and tells the adopter the App's permissions.
//   app         a new GitHub App from a pre-filled definition (GitHub's App Manifest flow, lib/app-manifest.mjs): the
//               browser posts it to GitHub, GitHub redirects back to a listener on 127.0.0.1, the code becomes the
//               App's id and key, saved as the PENDULUM_APP_ID and PENDULUM_APP_PRIVATE_KEY secrets with `gh secret set`
//               on stdin and the id as the repository variable PENDULUM_APP_ID (`gh variable set`; `pendulum report`
//               reads it) and as its local copy (~/.config/pendulum/repos/<owner>/<name>.json, lib/app-id.mjs), and the
//               browser goes on to the install page. Only when named: `all` leaves it out.
//   labels      pendulum:objective, the state labels, P0..P2
//   project     the Pendulum Project (v2) with Status = Queued, Running, In review, Blocked, Done (GraphQL)
//   protection  the "pendulum" ruleset on the default branch: merge queue, required checks,
//               no deletion, no force push (rulesets REST API).
//               Rulesets and repository settings need `administration`, which the App does not
//               have: this step runs with the user's own `gh` login (an admin), never the App.
//   default-token  the repository's default GITHUB_TOKEN set to read-only (PUT actions/permissions/workflow), which
//               doctor requires; the dry run names the workflows that run on that default and get a read-only token,
//               and those that set their own permissions:, which it leaves alone. No workflow file changes. gh login.
//               Only when named: `all` leaves it out, so a repin's `setup --yes` never changes a repository-wide setting.
//   workflow    .github/workflows/pendulum.yml from workflow-template.yml with the inputs given: the work and review
//               jobs, or with --sandbox the launch jobs and their triggers (a comment, a finished CI run). Over an
//               existing file it keeps every setting that file states (env values, the launch gate's maintainer ids,
//               the runner, the CI workflow, a pinned Action other than an older Pendulum release) unless a flag gives
//               one (`--name=` clears one), and prints what it kept and changed.
import { pathToFileURL } from "node:url";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { appPermissionsText, mintInstallationToken } from "./lib/app-token.mjs";
import { APP_SECRETS, appName, appPreflight, createAppFromManifest, manifestPermissions, saveAppIdVariable, webOrigin } from "./lib/app-manifest.mjs";
import { saveLocalAppId } from "./lib/app-id.mjs";
import { PLUGIN_ROOT } from "./lib/checkout.mjs";
import { cloneRepo } from "./lib/local.mjs";
import { COLUMNS, createProject, ensureLabel, ensureRuleset, findProject, getRepo, graphql, listRulesets, projectTitle, repoOf, requiredChecks, rest } from "./lib/github.mjs";
import { DEFAULTS, PENDULUM_VERSION, SECRET_INPUTS, VARIABLE_SETTINGS, mask, parseArgs, resolveInputs } from "./lib/inputs.mjs";
import { ADAPTERS } from "./lib/adapters/sandbox.mjs";
import { parseMaintainer, protectedPaths, unprotectedFiles } from "./lib/logic.mjs";
import { ciRunner, ciWorkflowTriggers, neededSecrets, pinRow, secretReferences, runnerLabels, setupRuns, unreadableRunners } from "./doctor.mjs";
import { parseYaml, workflowEvents, writeGrants } from "./lib/yaml.mjs";
import { ACCOUNT_HARNESSES, ROUTE_AUTO_ENV, ROUTE_CREDENTIAL_INPUTS, routeAccounts, routeAccountsText, routeCredentialRef, validAccountName } from "./lib/accounts.mjs";

export const LABELS = [
  ["pendulum:objective", "1D76DB", "An Objective for Pendulum to build unattended"],
  ["pendulum:running", "0E8A16", "Pendulum worker running (fallback for the Project card)"],
  ["pendulum:in-review", "FBCA04", "Pendulum PR open, reviewer pass pending or done"],
  ["pendulum:blocked", "B60205", "Pendulum stopped; see the Blocked comment"],
  ["pendulum:question", "D93F0B", "Pendulum opened a draft PR with a question"],
  ["pendulum:review", "C5DEF5", "Applied by the Pendulum App to trigger the review job"],
  ["pendulum:restart", "5319E7", "Restart this Objective from the issue's current text (any state)"],
  ["pendulum:draft", "D4C5F9", "A draft Objective: Pendulum never runs it while this label is on"],
  ["pendulum:handover", "BFD4F2", "A person applies the workflow change Pendulum handed over, then removes this label"],
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

/**
 * setup's board step: `{note, id}`, `id` the board's node id (made now, or found with every column), which setup writes
 * into the workflow as PENDULUM_PROJECT; null on a repository a user owns, which gets no board. The board is the one
 * `project` names (the id the workflow records) when it is linked to this repository, else the one titled
 * "Pendulum: <repo>" (findProject), else a new one.
 */
export async function applyProjectStep(repo, opts, { project = "" } = {}) {
  // A personal account's board is out of every GitHub App's reach (Projects is an organization permission, #199).
  if ((await getRepo(repo, opts)).owner?.type === "User") return { note: "skipped: a repository a user owns gets no board Pendulum can move; labels carry each Objective's state", id: null };
  const recorded = String(project || "").trim();
  const existing = (recorded && (await findProject(repo, { ...opts, project: recorded }))) || (await findProject(repo, { ...opts, project: "" }));
  if (existing) {
    const names = (existing.field?.options || []).map((o) => o.name);
    const missing = COLUMNS.filter((c) => !names.includes(c));
    if (!missing.length) return { note: `project "${existing.title}" already has ${COLUMNS.join(", ")}`, id: existing.id };
    // Add the missing options, keeping the existing ones (and their ids) in place.
    const colors = { Queued: "GRAY", Running: "BLUE", "In review": "YELLOW", Blocked: "RED", Done: "GREEN" };
    const all = [...existing.field.options.map((o) => ({ name: o.name, color: o.color || "GRAY", description: o.description || "" })), ...missing.map((name) => ({ name, color: colors[name], description: "" }))];
    const literal = all.map((o) => `{name: ${JSON.stringify(o.name)}, color: ${o.color}, description: ${JSON.stringify(o.description)}}`).join(", ");
    await graphql(`mutation($f: ID!) { updateProjectV2Field(input: {fieldId: $f, singleSelectOptions: [${literal}]}) { projectV2Field { ... on ProjectV2SingleSelectField { id } } } }`, { f: existing.field.id }, opts);
    return { note: `added ${missing.join(", ")} to project "${existing.title}"`, id: existing.id };
  }
  const p = await createProject(repo, opts);
  return { note: `created project "${projectTitle(repo)}" (#${p.number}) with ${COLUMNS.join(", ")} and linked it to ${repo.full}`, id: p.id };
}

/**
 * Why GitHub offers no merge queue on this repository, from its own record, or null when it may: GitHub offers one on a
 * repository an organization owns (public, or private on Enterprise Cloud), never on one a user owns. A private
 * organization repository outside Enterprise Cloud is not told apart here: GitHub refuses the rule, and applyProtection
 * then makes the ruleset without it.
 */
export const noQueueReason = (repoData) => (repoData?.owner?.type && repoData.owner.type !== "Organization" ? "GitHub offers no merge queue on a repository a user owns" : null);

/** Whether the repository's `pendulum` ruleset holds a merge_queue rule now. */
async function rulesetHasQueue(repo, opts) {
  const existing = (await listRulesets(repo, opts)).find((r) => r.name === "pendulum");
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
  // A squash commit's message is the PR's title and body (Pendulum's own text), never the branch's commit messages.
  await rest(`repos/${repo.full}`, { ...opts, method: "PATCH", body: { squash_merge_commit_title: "PR_TITLE", squash_merge_commit_message: "PR_BODY" } });
  return `ruleset "pendulum" on ${branch}: ${why ? `no merge queue (${why}; Pendulum runs on strict required checks), ` : "merge queue, "}${ciChecks.length ? `required checks ${ciChecks.join(", ")}` : "no required checks (pass --ci-checks)"}, no deletion or force push; squash commits take the PR's title and body`;
}

/** Whether a workflow run is another than Pendulum's own or GitHub's dynamic ones (code scanning's default setup). */
const ciRun = (r) => !/(^|\/)pendulum\.ya?ml$/.test(r?.path || "") && !/^dynamic\//.test(r?.path || "");

/**
 * Candidate required checks for a person to choose from, never applied by setup itself (a guess is no decision):
 * `{candidates, source, left}`, read as the user's own gh login. The candidates are the jobs that passed on the latest
 * pull request's head in its pull_request workflows, by the names GitHub gave their checks; else, with none, the jobs of
 * the workflows on pull_request, less those whose check name GitHub gives only when they run (`left`: a matrix, a called
 * workflow, a name from an expression). Each is `{name, workflow, marks}`, `marks` naming why it may not suit: its
 * workflow has no merge_group trigger while a merge queue is in play (`queue`), or a paths: filter on pull_request.
 */
export async function ciCheckCandidates(repo, opts, { queue = false } = {}) {
  const docs = new Map();
  const docOf = async (path) => {
    if (!docs.has(path)) {
      let doc = null;
      try {
        doc = parseYaml(String(await rest(`repos/${repo.full}/contents/${path}`, { ...opts, raw: "Accept: application/vnd.github.raw+json" })));
      } catch {
        // marked below as unread
      }
      docs.set(path, doc);
    }
    return docs.get(path);
  };
  const marks = (doc) => {
    if (!doc) return ["its workflow file could not be read on the default branch"];
    const out = [];
    if (queue && !workflowEvents(doc).includes("merge_group")) out.push("its workflow has no merge_group trigger, so it never reports in the merge queue and a queued pull request waits for it until the queue times out");
    const on = doc.on ?? doc.true;
    const pr = on && typeof on === "object" && !Array.isArray(on) ? on.pull_request : null;
    if (pr && typeof pr === "object" && (pr.paths !== undefined || pr["paths-ignore"] !== undefined)) out.push("its workflow has a paths filter on pull_request, so a pull request outside those paths never gets it and cannot merge");
    return out;
  };
  const out = [];
  const left = [];
  let source = "";
  const runs = (await rest(`repos/${repo.full}/actions/runs?event=pull_request&per_page=30`, opts).catch(() => null))?.workflow_runs || [];
  const latest = runs.find(ciRun);
  if (latest) {
    for (const r of runs.filter((x) => ciRun(x) && x.head_sha === latest.head_sha)) {
      const jobs = (await rest(`repos/${repo.full}/actions/runs/${r.id}/jobs?per_page=100`, { ...opts, paginate: true }).catch(() => [])) || [];
      const passed = jobs.filter((j) => j?.name && j.conclusion === "success");
      if (passed.length) {
        const m = marks(await docOf(r.path));
        for (const j of passed) out.push({ name: j.name, workflow: r.name, marks: m });
      }
    }
    const pr = latest.pull_requests?.[0]?.number;
    source = `the checks that passed on ${pr ? `pull request #${pr}` : `pull request head ${String(latest.head_sha).slice(0, 7)}`}`;
  }
  if (!out.length) {
    const list = (await rest(`repos/${repo.full}/actions/workflows?per_page=100`, { ...opts, paginate: true }).catch(() => [])) || [];
    for (const w of list) {
      if (!ciRun(w) || w.state !== "active") continue;
      const doc = await docOf(w.path);
      if (!doc || !workflowEvents(doc).includes("pull_request")) continue;
      const m = marks(doc);
      for (const [id, j] of Object.entries(doc.jobs && typeof doc.jobs === "object" ? doc.jobs : {})) {
        if (j?.strategy?.matrix || typeof j?.uses === "string" || (typeof j?.name === "string" && j.name.includes("${{"))) left.push(`${id} (${w.name})`);
        else out.push({ name: typeof j?.name === "string" ? j.name : id, workflow: w.name, marks: m });
      }
    }
    source = "the job names of the workflows on pull_request (no pull request has passed them yet)";
  }
  const seen = new Set();
  return { candidates: out.filter((c) => !seen.has(c.name) && seen.add(c.name)), source, left };
}

/** The protection preview's account of the candidates: each with its workflow and marks, and how to apply some. */
export function candidatesText({ candidates, source, left }) {
  if (!candidates.length && !left.length) return "; no candidates found: pass --ci-checks with the checks your CI reports on pull requests";
  const each = candidates.map((c) => `${JSON.stringify(c.name)} (${c.workflow}${c.marks.length ? `; ${c.marks.join("; ")}` : ""})`);
  return `; candidates, from ${source}, none applied until you name them: ${each.join(", ") || "none"}${left.length ? `; their check names known only once they run: ${left.join(", ")}` : ""}; to require some, run this step again with --ci-checks "<the names, comma-separated>"`;
}

/** `login#id` for the workflow's notify user, so Pendulum trusts the account and not whoever holds the login later. */
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

/** The env keys the template sets from an input: PENDULUM_<KEY> to the input it renders (`PENDULUM_MAX_USD` to max_usd). */
export function templateEnvInputs(template) {
  const map = new Map();
  for (const m of template.matchAll(/^ {2}(PENDULUM_[A-Z0-9_]+): \{\{([a-z0-9_]+)\}\}/gm)) map.set(m[1], m[2]);
  return map;
}

/** Every env key the template writes on either route (runner jobs or launch jobs), a board's id included. */
const templateEnvKeys = (template) => new Set(Object.keys(parseYaml(renderWorkflow(template, { sandbox: "vercel", project: "PVT_x", action: "clockgrove/pendulum@v0.0.0" })).env || {}));

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
 * The settings a pendulum.yml states, read as YAML: its env block (each value as a string), the launch gate's maintainer
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
    actions: thirdPartyActions(doc, text),
  };
}

/** Every `uses:` value in a parsed workflow, wherever it sits (a step's, a reusable workflow job's). */
export const usesOf = (node) => (Array.isArray(node) ? node.flatMap(usesOf) : node && typeof node === "object" ? Object.entries(node).flatMap(([k, v]) => (k === "uses" && typeof v === "string" ? [v.trim()] : usesOf(v))) : []);

/**
 * The actions a workflow calls besides Pendulum and its own local ones, `{"owner/repo": [ref, ...]}` with each ref's
 * version comment where its line has one (`3d3c42e5… # v7.0.1` gives `3d3c42e5…`, version `v7.0.1`): what a
 * re-render resets to the release's pins, which an adopter's Dependabot may have moved.
 */
export function thirdPartyActions(doc, text = "") {
  const versions = {};
  for (const line of String(text).split("\n")) {
    const m = /^\s*(?:-\s+)?uses:\s*(\S+)\s+#\s*(v\d[\w.-]*)\s*$/.exec(line);
    if (m) versions[m[1]] = m[2];
  }
  const out = {};
  for (const uses of usesOf(doc)) {
    const at = uses.lastIndexOf("@");
    if (uses.startsWith("./") || uses.startsWith("docker://") || at < 0 || uses.startsWith("clockgrove/pendulum@")) continue;
    const name = uses.slice(0, at);
    const ref = { ref: uses.slice(at + 1), version: versions[uses] ?? null };
    out[name] = [...(out[name] || []), ref].filter((r, i, all) => all.findIndex((o) => o.ref === r.ref) === i).sort((a, b) => a.ref.localeCompare(b.ref));
  }
  return out;
}

const refText = ({ ref, version }) => `${/^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 12) : ref}${version ? ` (${version})` : ""}`;

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

/** Whether --harness names another harness than the existing file's PENDULUM_HARNESS. */
const harnessMoved = (before, explicit) => Boolean(before) && explicit.harness !== undefined && String(explicit.harness).trim().toLowerCase() !== String(before.env.PENDULUM_HARNESS || "").trim().toLowerCase();

/** The input an env key carries (PENDULUM_MAX_USD to max_usd). */
const inputOfKey = (key) => key.replace(/^PENDULUM_/, "").toLowerCase();

/**
 * The inputs a re-render keeps from the existing file's settings (`before`, workflowSettings's), as flags: each env value
 * the template renders from an input, PENDULUM_MAINTAINERS, the work job's runner and the CI workflow. A flag on the
 * command line (`explicit`) wins, `--name=` included (it clears the value); a new --harness drops the file's models.
 */
export function keptArgs(before, explicit, template) {
  if (!before) return {};
  const out = {};
  const inputsOf = templateEnvInputs(template);
  inputsOf.set("PENDULUM_MAINTAINERS", "maintainers");
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

/** A Pendulum release pin's numbers: [X, Y, Z] for vX.Y.Z, and the floating vX.Y and vX as [X, Y] and [X]. */
const releaseOf = (action) =>
  /^clockgrove\/pendulum@v(\d+)(?:\.(\d+)(?:\.(\d+))?)?$/
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
 * The Action the file calls: --action, else --version, else the existing file's own pin, except a Pendulum release older
 * than the newest, a floating vX.Y or vX of an older line included (the template is the newest release's: its jobs call
 * modes an older Action lacks), else the newest release.
 */
export function workflowAction({ explicit, before, latest }) {
  if (explicit.action) return explicit.action;
  if (explicit.version) return `clockgrove/pendulum@${explicit.version}`;
  const newest = `clockgrove/pendulum@${latest}`;
  const had = before?.action;
  if (!had) return newest;
  const [a, b] = [releaseOf(had), releaseOf(newest)];
  return a && b && olderRelease(a, b) ? newest : had;
}

/** The values of a comma-separated, repeatable flag's (`--add-account a --add-account b,c`), trimmed, empty ones dropped. */
const listOf = (value) => (Array.isArray(value) ? value : value === undefined ? [] : [value]).flatMap((v) => String(v).split(",")).map((v) => v.trim()).filter(Boolean);

/**
 * The accounts setup renders for GitHub Actions and the cloud sandbox (#551), from the existing file's PENDULUM_ACCOUNTS
 * and PENDULUM_AUTO_ACCOUNT and the options `explicit` gives: --accounts (the whole declaration; `--accounts=` clears
 * it), then --add-account (`name`, of `harness`, the workflow's, or `harness:name`; added to a harness that declares
 * none after the account named after it, its usual one, so that one stays its default on the usual secrets) and
 * --remove-account (a declared name; one that leaves a harness only its usual account takes that harness out, unless
 * the file declares it so), and --auto-account on|off. A result that names the same accounts as the file keeps the
 * file's own line. The result is checked as the jobs read it
 * (accounts.mjs routeAccounts): an option's declaration it refuses throws its problem. {declared, accounts, set, given}:
 * `declared` routeAccounts's, `accounts` the PENDULUM_ACCOUNTS text the jobs are rendered for, `set` the env lines an
 * option sets (`""` drops the line), `given` whether an accounts option was given. With no option, `set` is empty and
 * the file's two lines stay as they are.
 */
export function accountSettings({ before = null, explicit = {}, harness = "claude" }) {
  const file = before?.env.PENDULUM_ACCOUNTS ?? "";
  const adds = listOf(explicit.add_account);
  const removes = listOf(explicit.remove_account);
  const given = explicit.accounts !== undefined || adds.length > 0 || removes.length > 0;
  const auto = explicit.auto_account === undefined ? null : String(explicit.auto_account).trim().toLowerCase();
  if (auto !== null && auto !== "on" && auto !== "off") throw new Error("--auto-account: on or off");
  const autoSet = auto === null ? {} : { [ROUTE_AUTO_ENV]: auto === "on" ? "1" : "" };
  const base = explicit.accounts !== undefined ? String(explicit.accounts) : file;
  const first = routeAccounts(base);
  if (!first.ok) throw new Error(explicit.accounts !== undefined ? `--accounts: ${first.problem}` : `${first.problem}: fix PENDULUM_ACCOUNTS in the workflow's env block, or set it with setup's --accounts (docs/INSTALL.md, Several accounts), then render again`);
  if (!given) return { declared: first, accounts: file, set: autoSet, given };
  const lists = Object.fromEntries(Object.entries(first.accounts).map(([h, l]) => [h, [...l]]));
  for (const entry of adds) {
    const at = entry.indexOf(":");
    const [h, name] = at < 0 ? [harness, entry] : [entry.slice(0, at).trim().toLowerCase(), entry.slice(at + 1).trim()];
    if (!ACCOUNT_HARNESSES.includes(h)) throw new Error(`--add-account: an entry names a harness Pendulum does not run (${ACCOUNT_HARNESSES.join(", ")})`);
    if (!lists[h].length) lists[h].push(h);
    lists[h].push(name);
  }
  const removedFrom = new Set();
  for (const name of removes) {
    const h = ACCOUNT_HARNESSES.find((x) => lists[x].includes(name));
    if (!h) throw new Error(`--remove-account: PENDULUM_ACCOUNTS declares no account ${validAccountName(name) ? `\`${name}\`` : "by that name"}`);
    lists[h] = lists[h].filter((n) => n !== name);
    removedFrom.add(h);
  }
  // A removal that leaves a harness only its usual account leaves what declaring none for it means, so that harness
  // goes, unless the file itself declares it so (`{"claude": ["claude"]}` stays as the file has it).
  const own = routeAccounts(file);
  for (const h of removedFrom) if (lists[h].length === 1 && lists[h][0] === h && !(own.ok && own.accounts[h].length === 1 && own.accounts[h][0] === h)) lists[h] = [];
  const kept = Object.fromEntries(Object.entries(lists).filter(([, l]) => l.length));
  const text = Object.keys(kept).length ? JSON.stringify(kept) : "";
  const declared = routeAccounts(text);
  if (!declared.ok) throw new Error(`${["accounts", "add_account", "remove_account"].filter((n) => explicit[n] !== undefined).map((n) => `--${n.replace(/_/g, "-")}`).join(", ")}: ${declared.problem}`);
  const accounts = routeAccountsText(text);
  // The same accounts as the file's, declared or not: its own line stays, byte for byte.
  if (own.ok && accounts === routeAccountsText(file)) return { declared, accounts: file, set: autoSet, given };
  return { declared, accounts, set: { PENDULUM_ACCOUNTS: accounts, ...autoSet }, given };
}

/** A harness credential's secret, its usual name or an account's (accounts.mjs routeSecretSuffix). */
const CREDENTIAL_SECRET = new RegExp(`^(${Object.values(ROUTE_CREDENTIAL_INPUTS).map((c) => c.secret).join("|")})(_[A-Z0-9_]+)?$`);
const USUAL_SECRETS = new Set(Object.values(ROUTE_CREDENTIAL_INPUTS).map((c) => c.secret));
/** The harness credential secrets a workflow's text names (doctor.mjs secretReferences), sorted. */
const credentialSecrets = (text) => [...secretReferences(text || "").names].filter((n) => CREDENTIAL_SECRET.test(n)).sort();

/**
 * What an accounts option changes in the secrets: `add`, the ones the jobs need under the new declaration `now` that
 * they did not under `was` (doctor.mjs neededSecrets: `wasInputs` the existing file's harness and credential; a list
 * entry is met by any one of its names, Codex's gateway key or API key), and `gone`, the harness credential secrets the
 * old workflow text names and the new one does not, so a secret the rendered jobs still name is never called unused.
 */
export function accountSecretChanges({ inputs, was = "", now = "", wasInputs = inputs, oldText = "", newText = "" }) {
  const names = (i, a) => neededSecrets(i, a).slice(2).map((n) => [].concat(n).join(" or "));
  const before = names(wasInputs, was);
  const still = new Set(credentialSecrets(newText));
  return { add: names(inputs, now).filter((n) => !before.includes(n)), gone: credentialSecrets(oldText).filter((n) => !still.has(n)) };
}

/**
 * The workflow step's line for an accounts option: the accounts, each new secret to save at `gh secret set`'s prompt (a
 * harness's usual one only if not already set), and the secrets the rendered jobs stop naming (`oldText`, the existing
 * file; `newText`, the rendered one).
 */
export function accountsNote({ inputs, before, acc, oldText = "", newText = "" }) {
  if (!acc.given) return "";
  const wasInputs = { harness: before?.env.PENDULUM_HARNESS || inputs.harness, credential: String(before?.env.PENDULUM_CREDENTIAL || inputs.credential).toLowerCase() };
  const { add, gone } = accountSecretChanges({ inputs, was: before?.env.PENDULUM_ACCOUNTS ?? "", now: acc.accounts, wasInputs, oldText, newText });
  const each = Object.entries(acc.declared.accounts).filter(([, l]) => l.length).map(([h, l]) => `${h}: ${l.join(", ")} (default ${l[0]})`);
  const usual = (n) => n.split(" or ").every((x) => USUAL_SECRETS.has(x));
  return [
    `accounts ${each.length ? each.join("; ") : "none declared: every job runs on the usual secrets"}`,
    add.length && `save ${add.map((n) => (usual(n) ? `${n} (if not already set)` : n)).join(", ")} with \`gh secret set NAME\`, pasting the value at its prompt (never --body)`,
    gone.length && `the jobs no longer name ${gone.join(", ")} (delete with \`gh secret delete NAME\` once nothing else uses it)`,
  ].filter(Boolean).join("; ");
}

/**
 * The rendered pendulum.yml (no network): `inputs` resolved from the flags with the kept settings under them, `notify` the
 * pinned login#id, `runsOn` the runner label (runner route), `defaultBranch` the repository's (sandbox route). The launch
 * gate keeps the existing file's maintainer ids beside the pinned ones unless --maintainers names others (a new --notify
 * drops the old notify id). Env keys the existing file has and the template does not are kept at the env block's end.
 */
export function workflowText({ template, inputs, args, explicit = args, before = null, latest, notify, runsOn = null, ciWorkflow, defaultBranch = "", protectedPaths: protectedList = inputs.protectedAdditions }) {
  const sandbox = String(args.sandbox || "").trim().toLowerCase();
  // The accounts the file declares (PENDULUM_ACCOUNTS, only the file sets it), as an accounts option changes them: the
  // jobs name their secrets.
  const acc = accountSettings({ before, explicit, harness: inputs.harness });
  const declared = acc.declared;
  const oldNotifyId = parseMaintainer(before?.env.PENDULUM_NOTIFY || "")?.id ?? null;
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
    max_objective_usd: inputs.maxObjectiveUsd ? String(inputs.maxObjectiveUsd) : "",
    timeout_minutes: String(inputs.timeoutMinutes),
    auto_merge: String(inputs.autoMerge),
    publish_transcripts: String(inputs.publishTranscripts),
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
    protected_paths: protectedList.join(", "),
    ci_checks: inputs.ciChecks.join(", "),
    node_version: args.node_version || "22",
    time_zone: inputs.timeZone,
    project: String(args.project || "").trim(),
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
    image_max_age_days: String(inputs.imageMaxAgeDays),
    sandbox_idle_days: String(inputs.sandboxIdleDays),
    sweep_max_destroys: String(inputs.sweepMaxDestroys),
    // The declaration the credential inputs below are rendered for: the account steps pick none under another.
    rendered_accounts: routeAccountsText(acc.accounts),
  };
  return withFileEnv(accountCredentials(renderWorkflow(template, values), declared), { template, before, explicit, set: acc.set });
}

/**
 * The rendered `text` with each stage step's credential input (`anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}`,
 * accounts.mjs ROUTE_CREDENTIAL_INPUTS) naming every declared account's secret by its fixed name and passing the one of
 * the account the job's account step picked (accounts.mjs routeCredentialRef), when `declared` (routeAccounts) declares
 * accounts; unchanged with none. A secret is never looked up by a computed name: GitHub would then send the runner every
 * secret the repository and its organization hold.
 */
export function accountCredentials(text, declared) {
  if (!declared?.declared) return text;
  const line = new RegExp(`^(\\s+)(${Object.keys(ROUTE_CREDENTIAL_INPUTS).join("|")}): \\$\\{\\{ secrets\\.([A-Z_]+) \\}\\}`, "gm");
  return text.replace(line, (m, indent, input, secret) => (secret === ROUTE_CREDENTIAL_INPUTS[input].secret ? `${indent}${input}: ${routeCredentialRef(input, declared)}` : m));
}

/**
 * The rendered text with what the existing file's env block holds beyond the template: the comment lines directly above
 * each key, and the keys the template does not write (at the env block's end, as the file spells them). A flag for such
 * a key's input wins (`--maintainers=` drops PENDULUM_MAINTAINERS), --maintainers writes PENDULUM_MAINTAINERS when the
 * file has none (the runtime trusts maintainers from it), and a new --harness drops the file's efforts.
 */
/** Inputs a re-render never writes into the workflow env from a flag: credentials and setup-only inputs. */
const NOT_ENV_INPUTS = new Set([...SECRET_INPUTS, "repo", "app_id", "mode", "issue", "pr", "action"]);

function withFileEnv(text, { template, before, explicit, set = {} }) {
  const known = templateEnvKeys(template);
  const moved = harnessMoved(before, explicit);
  const lines = before?.lines || {};
  const extra = [];
  // A line an option sets (`set`, accountSettings's: JSON in single quotes, `"1"`), its comments kept; "" drops it.
  const setLine = (k) => ({ k, v: set[k], comments: lines[k]?.comments || [], line: `${k}: ${k === "PENDULUM_ACCOUNTS" ? `'${set[k]}'` : JSON.stringify(set[k])}` });
  for (const [k, v] of Object.entries(before?.env || {})) {
    const name = inputOfKey(k);
    if (known.has(k)) continue;
    if (Object.hasOwn(set, k)) {
      if (set[k]) extra.push(setLine(k));
      continue;
    }
    // A flag wins over a file's extra env line only for a workflow setting: a credential or a setup-only input given on
    // the command line (an App key, the repo) is never written into pendulum.yml; the file's own line stays.
    if (Object.hasOwn(DEFAULTS, name) && explicit[name] !== undefined && !NOT_ENV_INPUTS.has(name)) {
      const given = String(explicit[name]).trim();
      if (given) extra.push({ k, v: given, comments: lines[k]?.comments || [] });
    } else if (!(moved && MODEL_INPUTS.has(name))) extra.push({ k, v, comments: lines[k]?.comments || [], line: lines[k]?.line });
  }
  for (const k of Object.keys(set)) if (set[k] && !Object.hasOwn(before?.env || {}, k)) extra.push(setLine(k));
  const maintainers = String(explicit.maintainers ?? "").trim();
  if (maintainers && !Object.hasOwn(before?.env || {}, "PENDULUM_MAINTAINERS")) extra.push({ k: "PENDULUM_MAINTAINERS", v: maintainers, comments: [] });
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
  const preset = PRESETS[explicit.preset] || {};
  const flag = (name) => (Object.hasOwn(preset, name) && String(explicit[name]) === preset[name] ? `--preset ${explicit.preset}` : `--${name.replace(/_/g, "-")}`);
  // PENDULUM_ACCOUNTS has three options (accountSettings): each one given is named.
  const accountFlags = ["accounts", "add_account", "remove_account"].filter((n) => explicit[n] !== undefined).map((n) => `--${n.replace(/_/g, "-")}`);
  const why = (name) => (name === "accounts" && accountFlags.length ? ` (${accountFlags.join(", ")})` : explicit[name] !== undefined ? ` (${flag(name)})` : moved && MODEL_INPUTS.has(name) ? " (--harness: the new harness's default)" : "");
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
  // The other actions' pins are the release's: a re-render undoes a pin the repository's Dependabot moved.
  const [was, now] = [before.actions || {}, after.actions || {}];
  const moves = [...new Set([...Object.keys(was), ...Object.keys(now)])].sort().flatMap((name) => {
    const [a, b] = [(was[name] || []).map(refText).join(", "), (now[name] || []).map(refText).join(", ")];
    return a === b ? [] : [`${name} ${a || "(none)"} -> ${b || "(none)"}`];
  });
  if (moves.length) changed.push(`third-party actions ${moves.join(", ")} (the release's pins: the template is that release's)`);
  else if (Object.keys(now).length) kept.push("third-party actions");
  return [
    kept.length && `kept ${kept.join(", ")}`,
    changed.length && `changed ${changed.join("; ")}`,
    added.length && `new in this template ${added.join(", ")}`,
    byFlag.length && `dropped ${byFlag.map((k) => `${k}${why(inputOfKey(k))}`).join(", ")}`,
    dropped.length && `dropped (not on this route) ${dropped.join(", ")}`,
  ].filter(Boolean);
}

/** The existing file's PENDULUM_NOTIFY when it is login#id and no --notify is given (its id stays pinned), else null. */
export function keptNotify(before, explicit) {
  const filed = explicit.notify === undefined ? parseMaintainer(before?.env.PENDULUM_NOTIFY || "") : null;
  return filed?.id ? `${filed.login}#${filed.id}` : null;
}

/**
 * What setup runs, on every route: each repository file its command names (doctor.mjs setupRuns) joins the protected
 * paths unless one already covers it, anchored at the root (`/build.mjs`, logic.mjs protectedCovers) so a file of the
 * same name deeper in the tree stays the worker's. {scripts, unresolved, adding, protectedList}: `scripts` the files
 * named, `unresolved` what the command may run that cannot be named (doctor FAILs on it), and the list to render as
 * PENDULUM_PROTECTED_PATHS.
 */
export async function protectSetup(inputs, checkout) {
  const { files: scripts, guard } = await setupRuns(inputs.setup, checkout);
  const unresolved = guard.unresolved;
  const adding = unprotectedFiles(scripts, protectedPaths(inputs.protectedAdditions)).map((f) => `/${f}`);
  return { scripts, unresolved, adding, protectedList: [...inputs.protectedAdditions, ...adding] };
}

/**
 * The runner note's clause when doctor's runner row will warn on the runner setup picked from `ci` (the --ci-workflow
 * workflow), else "": doctor compares against the workflows on pull_request that make the branch's required checks
 * (else the one on pull_request), read as doctor reads them (the required checks, not PENDULUM_CI_CHECKS), and told
 * apart from `ci` by path.
 */
export async function doctorRunnerNote({ repo, opts, ci, runsOn, hints, ciChecks = [] }) {
  const required = await requiredChecks(repo, opts).catch(() => []);
  const pr = await ciWorkflowTriggers(repo, opts, { checks: required }).catch(() => ({}));
  const paths = pr.paths ?? (pr.path ? [pr.path] : []);
  if (!pr.found || (paths.length === 1 && paths[0] === ci.path)) return "";
  const theirs = ciRunner(pr, { ...hints, checks: [...required, ...ciChecks] });
  if (!theirs || theirs.runner === runsOn) return "";
  return `; doctor compares against ${pr.name} (${required.length ? "the workflows on pull_request that make the required checks" : "the workflow on pull_request"}), which runs on ${theirs.runner}, so it will warn`;
}

async function applyWorkflow({ inputs, args, explicit, before, template, checkout, latest, repo, opts }) {
  const notify = keptNotify(before, explicit) || (await pinnedLogin(inputs.notify));
  const sandbox = String(args.sandbox || "").trim().toLowerCase();
  if (sandbox && !Object.hasOwn(ADAPTERS, sandbox)) throw new Error(`--sandbox ${sandbox}: no such adapter (have: ${Object.keys(ADAPTERS).join(", ")})`);
  // CI finishing on a pendulum/ branch resumes a waiting stage (sandbox) or ticks the dispatcher's merge pass (both
  // routes): CI on Actions is named in workflow_run's filter. The runner jobs take the CI workflow's runner unless
  // --runs-on picks one.
  const readCi = !args.ci_workflow || (!sandbox && !args.runs_on);
  const ci = readCi ? await ciWorkflowTriggers(repo, opts, { name: args.ci_workflow || "" }).catch(() => ({})) : {};
  const ciWorkflow = args.ci_workflow || ci.name || "CI";
  // The same hints doctor's runner check uses: the setup and validation commands, and the required checks.
  const hints = { commands: [inputs.setup, ...inputs.validation], checks: sandbox || inputs.ciChecks.length || !ci.found ? inputs.ciChecks : await requiredChecks(repo, opts).catch(() => []) };
  const runner = sandbox ? null : pickRunner(args.runs_on, ci, hints, explicit.runs_on === undefined && args.runs_on ? "kept from the existing file" : "--runs-on");
  // Doctor compares against another workflow than --ci-workflow may name: say so when they disagree.
  if (runner && args.ci_workflow && ci.found) runner.note += await doctorRunnerNote({ repo, opts, ci, runsOn: runner.runsOn, hints, ciChecks: inputs.ciChecks });
  const { scripts, unresolved, adding, protectedList } = await protectSetup(inputs, checkout);
  const defaultBranch = sandbox ? (await getRepo(repo, opts)).default_branch : "";
  const out = resolve(args.out || join(checkout, ".github", "workflows", "pendulum.yml"));
  const text = workflowText({ template, inputs, args, explicit, before, latest, notify, runsOn: runner?.runsOn, ciWorkflow, defaultBranch, protectedPaths: protectedList });
  const accounts = accountsNote({ inputs, before, acc: accountSettings({ before, explicit, harness: inputs.harness }), oldText: existsSync(out) ? readFileSync(out, "utf8") : "", newText: text });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text);
  const added = unresolved.length
    ? `; WARNING: the setup command runs ${unresolved.join(", ")}, which cannot be resolved to repository files, so nothing keeps a worker from changing what it runs and doctor FAILs; name each file literally or move the command into a script file`
    : adding.length
    ? `; added ${adding.join(", ")} to PENDULUM_PROTECTED_PATHS (setup runs it as the runner beside the App's key${sandbox ? ", as root into the image every stage starts from" : ""}, so a worker's commit may not change it)`
    : sandbox && inputs.setup && !scripts.length
      ? `; WARNING: no repository file found in the setup command to protect; with a sandbox setup runs as root into every stage's image, so add the files it runs to --protected-paths`
      : "";
  const report = settingsReport(before, workflowSettings(text), explicit).map((l) => `\n  ${l}`).join("");
  return `wrote ${out}${runner ? `; ${runner.note}` : ""}${added}; commit it on the default branch to start the cron (through a pull request once the ruleset is on: direct pushes to a protected branch are refused)${accounts ? `\n  ${accounts}` : ""}${report}`;
}

/** The newest Pendulum release tag, so a new install never pins a stale one; this plugin's own version offline. */
/**
 * setup's project step as main runs it: the board (applyProjectStep, by the id the workflow records first), its id put in
 * `args.project` for the workflow step to write as PENDULUM_PROJECT (a --project flag wins). Only the workflow step
 * writes the file: run without it, a board id the file does not record yet is named in the note with how to record it.
 * Returns the step's note.
 */
export async function projectStep({ repo, opts, args, explicit, steps, outPath, checkout }) {
  const recorded = String(args.project || "").trim() || recordedProject(outPath);
  const p = await applyProjectStep(repo, opts, { project: recorded });
  if (p.id && explicit.project === undefined) args.project = p.id;
  if (!p.id || steps.includes("workflow") || p.id === recordedProject(outPath)) return p.note;
  return `${p.note}; the workflow does not record its id yet: run setup with --apply project,workflow, or set PENDULUM_PROJECT: ${p.id} in the env block of ${relative(checkout, outPath)}`;
}

/** The board id the workflow file at `path` records (PENDULUM_PROJECT), or "" with none, no file or one that does not parse. */
export function recordedProject(path) {
  try {
    return existsSync(path) ? String(workflowSettings(readFileSync(path, "utf8")).env?.PENDULUM_PROJECT || "").trim() : "";
  } catch {
    return "";
  }
}

export async function latestRelease() {
  const tag = await rest("repos/clockgrove/pendulum/releases/latest", {}).then((r) => r?.tag_name, () => null);
  // A tag before the first Pendulum release is the product under its previous name (doctor.mjs pinRow): never pinned.
  return /^v\d+\.\d+\.\d+$/.test(tag || "") && pinRow(tag).status === "PASS" ? tag : `v${PENDULUM_VERSION}`;
}

/** What the App step does, for the dry run. */
export function appPlan(repoData, secretScope = "repo") {
  const userAccount = repoData.owner?.type === "User";
  const perms = Object.entries(manifestPermissions({ userAccount })).map(([k, v]) => `${k}: ${v}`).join(", ");
  return `create the GitHub App "${appName(repoData.name)}" for ${repoData.owner.login} from a pre-filled definition in your browser (permissions ${perms}; nothing else, never workflows; webhook inactive), save its id and private key as ${secretScope === "org" ? `${repoData.owner.login}'s organization secrets, shared with ${repoData.name} only,` : "the repository's secrets"} ${APP_SECRETS.id} and ${APP_SECRETS.key} with gh secret set (never printed or written to a file) and its id as the repository variable ${APP_SECRETS.id} (gh variable set) and as a local copy for \`pendulum report\` (~/.config/pendulum/repos/${repoData.full_name}.json), then open its install page; it first checks your gh login can save them and refuses to overwrite ones already there without --replace`;
}

/**
 * setup's App step: the pre-flight, then the manifest flow (lib/app-manifest.mjs); its note names the App and the
 * install page. The pre-flight's refusal stops it before the browser opens, so no App is made that cannot be kept.
 */
async function applyApp(repo, repoData, secretScope, { replace = false } = {}) {
  const web = webOrigin();
  const env = process.env;
  const org = secretScope === "org";
  const problems = await appPreflight(repo, repoData, { org, replace, env });
  if (problems.length) throw new Error(`the app step made nothing: ${problems.join("; ")}`);
  const app = await createAppFromManifest(repo, repoData, { org, web, env });
  // The id beside the secret, as the repository variable `pendulum report` reads: a failure leaves the App and its secrets.
  const unsaved = await saveAppIdVariable(repo, app.appId, { env });
  const variable = unsaved ? `; the repository variable ${APP_SECRETS.id} was not saved (${unsaved}): save it with \`gh variable set ${APP_SECRETS.id} --repo ${repo.full} --body ${app.appId}\`` : ` and its id as the repository variable ${APP_SECRETS.id}`;
  // And as its readable local copy beside local mode's token (lib/app-id.mjs), which `pendulum report` takes when the
  // variable cannot be read: a failure leaves the rest.
  let copy;
  try {
    copy = `; its id's local copy for \`pendulum report\` is ${saveLocalAppId(repo.full, app.appId).file}`;
  } catch (e) {
    copy = `; its id's local copy for \`pendulum report\` was not saved (${e.message})`;
  }
  return `created the App ${app.slug} (id ${app.appId}) for ${repoData.owner.login} and saved ${app.saved.join(" and ")} as ${secretScope === "org" ? "organization" : "repository"} secrets${variable}${copy}; install it on ${repoData.full_name} only (Only select repositories): ${app.installUrl}`;
}

/**
 * Named sets of workflow settings `--preset <name>` gives, each as the flag it stands for: a flag given beside the preset
 * wins over it. `first-run`: a low per-job cap, one stage at a time and auto-merge off, for a repository's first
 * Objectives, raised later by a re-render with the flag (`--max-usd 25`) or the repository variable.
 */
export const PRESETS = {
  "first-run": { max_usd: "5", max_concurrent: "1", auto_merge: "false" },
};

/** The command line's flags with `--preset`'s settings under them; throws on a preset setup does not have. */
export function withPreset(given) {
  const name = given.preset;
  if (name === undefined) return given;
  if (!Object.hasOwn(PRESETS, name)) throw new Error(`--preset ${name}: no such preset (have: ${Object.keys(PRESETS).join(", ")})`);
  return { ...PRESETS[name], ...given };
}

/** The jobs of a parsed workflow that run on the repository's default token: every job when the file sets no top-level `permissions:`, less those that set their own; none when it sets one. */
export function defaultTokenJobs(doc) {
  if (doc?.permissions !== undefined && doc?.permissions !== null) return [];
  const jobs = doc?.jobs && typeof doc.jobs === "object" && !Array.isArray(doc.jobs) ? Object.entries(doc.jobs) : [];
  return jobs.filter(([, job]) => job?.permissions === undefined || job?.permissions === null).map(([id]) => id);
}

/** Whether a `permissions:` value asks for more than a read-only token gives: any grant yaml.mjs writeGrants names. */
export const asksWrite = (perms) => Boolean(writeGrants(perms)?.length);

/** Whether a parsed workflow, at its top level or in any job, asks for write (asksWrite). */
const workflowAsksWrite = (doc) => asksWrite(doc?.permissions) || Object.values(doc?.jobs && typeof doc.jobs === "object" ? doc.jobs : {}).some((j) => asksWrite(j?.permissions));

/** A job's `uses:` as the repository path of a local reusable workflow (`./.github/workflows/x.yml`), else null. */
const localCallee = (uses) => (typeof uses === "string" && uses.startsWith("./") ? uses.slice(2) : null);

/**
 * The repository's default workflow token and the workflows it reaches: `{current, canApprove, relies, own, reusable,
 * offBranch, unread}`. `current` is its default_workflow_permissions. `relies`: each workflow on the default branch with
 * jobs that set no permissions (defaultTokenJobs), each job `{id, calls, writes}` where `calls` names the reusable
 * workflow it calls and `writes` is whether that callee asks for write (null when it could not be read): a callee runs
 * with its caller's token, so on a read-only default it cannot get the write it asks for. `own`: each one that sets its
 * own permissions everywhere and calls nothing on the default. `reusable`: each one on `workflow_call`, whose token is
 * its caller's. `offBranch`: listed by GitHub but not on the default branch (they run from other branches, on the same
 * default). `unread`: could not be read or parsed.
 */
/** The default-token step's error for GitHub's refusal of the setting itself, read or write: what to fix. */
function tokenSettingError(e, repo, doing) {
  if (e?.status === 403 || e?.status === 404) return new Error(`${doing}: it needs a gh login that administers ${repo.full} (classic \`repo\` scope or fine-grained Administration: write) (HTTP ${e.status})`);
  if (e?.status === 409) return new Error(`${doing}: your organization or enterprise sets this; ask an owner (HTTP 409)`);
  return e;
}

export async function defaultTokenState(repo, opts) {
  let perms;
  try {
    perms = await rest(`repos/${repo.full}/actions/permissions/workflow`, opts);
  } catch (e) {
    throw tokenSettingError(e, repo, "could not read the default workflow token");
  }
  const list = (await rest(`repos/${repo.full}/actions/workflows?per_page=100`, { ...opts, paginate: true })) || [];
  const docs = new Map();
  const offBranch = [];
  const unread = [];
  for (const w of list) {
    // GitHub's dynamic workflows (code scanning's default setup) are no file in the repository.
    if (/^dynamic\//.test(w.path)) continue;
    try {
      docs.set(w.path, parseYaml(String(await rest(`repos/${repo.full}/contents/${w.path}`, { ...opts, raw: "Accept: application/vnd.github.raw+json" }))));
    } catch (e) {
      if (e.status === 404) offBranch.push(w.path);
      else unread.push(w.path);
    }
  }
  const relies = [];
  const own = [];
  const reusable = [];
  for (const [path, doc] of docs) {
    const events = workflowEvents(doc);
    if (events.includes("workflow_call")) reusable.push(path);
    const ids = defaultTokenJobs(doc);
    if (!ids.length) {
      // On its own triggers it runs with its own permissions; called, with its caller's: listed for each role it has.
      if (events.some((e) => e !== "workflow_call")) own.push(path);
      continue;
    }
    const jobs = ids.map((id) => {
      const uses = doc.jobs[id]?.uses;
      if (typeof uses !== "string") return { id, calls: null, writes: null };
      const callee = localCallee(uses);
      return { id, calls: callee || uses, writes: callee && docs.has(callee) ? workflowAsksWrite(docs.get(callee)) : null };
    });
    relies.push({ path, jobs });
  }
  return { current: perms?.default_workflow_permissions ?? null, canApprove: perms?.can_approve_pull_request_reviews, relies, own, reusable, offBranch, unread };
}

/** One job of a relying workflow, as the default-token step names it. */
const reliantJob = (j) => (!j.calls ? j.id : `${j.id}, which calls ${j.calls}${j.writes === true ? ", which asks for write: on a read-only default it cannot get it and the run fails" : j.writes === null ? " (not read here: check it asks for no write)" : ""}`);

/** The default-token step's account of the workflows: which get a read-only token after it, which it leaves alone. */
export const defaultTokenReach = ({ relies, own, reusable = [], offBranch = [], unread }) =>
  [
    relies.length ? `these set no permissions: of their own and get a read-only token: ${relies.map((r) => `${r.path} (jobs ${r.jobs.map(reliantJob).join("; ")})`).join("; ")}; one that pushes, comments, labels, releases or deploys with GITHUB_TOKEN needs permissions: added first` : "no workflow on the default branch relies on the default: each sets its own permissions:",
    own.length && `left alone (they set their own permissions:): ${own.join(", ")}`,
    reusable.length && `reusable (on: workflow_call), which run with their caller's token: ${reusable.join(", ")}`,
    offBranch.length && `not on the default branch: ${offBranch.join(", ")}; they run from other branches, which also get the read-only default; check them by hand`,
    unread.length && `could not read ${unread.join(", ")}: check them by hand`,
  ]
    .filter(Boolean)
    .join("; ");

/** setup's default-token step: the repository's default GITHUB_TOKEN made read-only (doctor's "default workflow token" row); workflow files are never changed. */
export async function applyDefaultToken(repo, opts) {
  const state = await defaultTokenState(repo, opts);
  if (state.current === "read") return "the default workflow token is already read-only; nothing changed";
  const body = { default_workflow_permissions: "read", ...(typeof state.canApprove === "boolean" ? { can_approve_pull_request_reviews: state.canApprove } : {}) };
  try {
    await rest(`repos/${repo.full}/actions/permissions/workflow`, { ...opts, method: "PUT", body });
  } catch (e) {
    throw tokenSettingError(e, repo, "the default workflow token was not changed");
  }
  return `the default workflow token is read-only now (it was ${state.current}); ${defaultTokenReach(state)}`;
}

/** The default-token step's dry-run line, after reading what it would change. */
export async function defaultTokenPlan(repo, opts) {
  let state;
  try {
    state = await defaultTokenState(repo, opts);
  } catch (e) {
    return `set the repository's default workflow token to read-only; ${e.message}`;
  }
  if (state.current === "read") return "nothing: the default workflow token is already read-only";
  return `set the repository's default workflow token (now ${state.current}) to read-only, which doctor requires; workflow files are not changed: ${defaultTokenReach(state)}; runs as your gh login (needs admin)`;
}

/**
 * The repository variables that set a preset's settings over the workflow file (Settings in layers), so the preset's
 * value does not apply while they stand: one warning clause, or "" with none; a variable that cannot be read is named.
 */
export async function presetOverrides(repo, preset, opts) {
  const keys = Object.keys(PRESETS[preset] || {}).map((k) => `PENDULUM_${k.toUpperCase()}`).filter((k) => VARIABLE_SETTINGS.has(k));
  const over = [];
  const unread = [];
  for (const k of keys) {
    try {
      const v = await rest(`repos/${repo.full}/actions/variables/${k}`, opts);
      over.push(`the repository variable ${k} (${v?.value})`);
    } catch (e) {
      if (e.status !== 404) unread.push(`the repository's variables (${e.status ? `HTTP ${e.status}` : e.message})`);
    }
  }
  // An organization's variables shared with the repository reach the Action's jobs too (INSTALL.md, Settings in layers).
  try {
    const org = (await rest(`repos/${repo.full}/actions/organization-variables?per_page=30`, { ...opts, paginate: true })) || [];
    for (const v of org) if (keys.includes(v?.name) && !over.some((o) => o.includes(` ${v.name} `))) over.push(`the organization variable ${v.name} (${v.value}), shared with this repository,`);
  } catch (e) {
    if (e.status !== 404) unread.push(`the organization variables shared with it (${e.status ? `HTTP ${e.status}` : e.message})`);
  }
  const warn = over.length ? `; WARNING: ${over.join(" and ")} ${over.length > 1 ? "set these" : "sets this"} over the workflow file, so the ${preset} preset's value does not apply while ${over.length > 1 ? "they stand" : "it stands"} (gh variable delete <name>)` : "";
  const unknown = [...new Set(unread)];
  return `${warn}${unknown.length ? `; could not read ${unknown.join(" or ")}: check no ${keys.join(" or ")} variable sets these over the preset` : ""}`;
}

/** setup's steps that `all` (or no `--apply`) runs, in the order it runs them. */
export const SETUP_STEPS = ["labels", "project", "protection", "workflow"];
/** The App step: it creates a new GitHub App each time, so it runs only when asked for by name, before the others. */
export const APP_STEP = "app";
/**
 * The default-token step: it changes a repository-wide setting every other workflow runs on, so a plain `setup --yes`
 * (a repin, a migration) never runs it; it runs only when named, and last, so its refusal skips no other step.
 */
export const DEFAULT_TOKEN_STEP = "default-token";
/** Every step in the order setup runs them: the named-only ones in their place. */
const STEP_ORDER = [APP_STEP, "labels", "project", "protection", "workflow", DEFAULT_TOKEN_STEP];
const NAMED_ONLY = [APP_STEP, DEFAULT_TOKEN_STEP];

/** Every value `argv` gives the flag `--name` (`--name a --name b`, `--name=a`), in order: parseArgs keeps the last only. */
export function flagValues(argv, name) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === `--${name}` && i + 1 < argv.length && !argv[i + 1].startsWith("--")) out.push(argv[(i += 1)]);
    else if (argv[i].startsWith(`--${name}=`)) out.push(argv[i].slice(name.length + 3));
  }
  return out;
}

/**
 * The steps `argv` asks for: every `--apply` given (`--apply a --apply b`, `--apply=a`, `--apply a,b`), in setup's own
 * order, `all` (or no `--apply`) for every step but `app` and `default-token`, which run only when named. parseArgs keeps
 * one value per flag, so the flags are read here. Throws on a step setup does not have.
 */
export function setupSteps(argv) {
  const names = listOf(flagValues(argv, "apply"));
  const unknown = names.filter((n) => n !== "all" && !STEP_ORDER.includes(n));
  if (unknown.length) throw new Error(`--apply: no step ${unknown.join(", ")}; the steps are ${STEP_ORDER.join(", ")} or all (every step but ${NAMED_ONLY.join(" and ")})`);
  const all = !names.length || names.includes("all");
  return STEP_ORDER.filter((n) => names.includes(n) || (all && SETUP_STEPS.includes(n)));
}

async function main() {
  // A preset's settings count as flags given: a re-render takes them over the file's, and a flag beside it wins.
  const explicit = withPreset(parseArgs(process.argv.slice(2)));
  // The account flags may repeat: every value counts.
  for (const flag of ["add-account", "remove-account"]) {
    const key = flag.replace(/-/g, "_");
    if (explicit[key] === undefined) continue;
    explicit[key] = flagValues(process.argv.slice(2), flag);
    if (!explicit[key].length || explicit[key].some((v) => !listOf(v).length)) throw new Error(`--${flag}: name the account`);
  }
  const checkout = resolve(explicit.checkout || process.cwd());
  const steps = setupSteps(process.argv.slice(2));
  // Only the workflow step writes the accounts: an accounts option without it would change nothing.
  const accountFlags = ["accounts", "add_account", "remove_account", "auto_account"].filter((n) => explicit[n] !== undefined);
  if (accountFlags.length && !steps.includes("workflow")) throw new Error(`${accountFlags.map((n) => `--${n.replace(/_/g, "-")}`).join(", ")}: only the workflow step writes the accounts; add --apply workflow`);
  // A re-render keeps what the existing file states (its env block, the gate's ids, the runner, the CI workflow and a
  // pinned Action); a flag still wins. The protection step's required checks come from the same settings.
  const template = readFileSync(join(PLUGIN_ROOT, "workflow-template.yml"), "utf8");
  const outPath = resolve(explicit.out || join(checkout, ".github", "workflows", "pendulum.yml"));
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
  // No --repo (nor GITHUB_REPOSITORY): the clone's origin, as `pendulum serve` finds it.
  const repo = repoOf(inputs.repo || cloneRepo(checkout));
  const yes = args.yes === "true";
  // Labels, the board and the ruleset are created with the App when its credentials are given, else with the
  // user's own gh login (a developer running /pendulum setup); the App is verified, never created.
  let token = inputs.appToken || null;
  if (!token && inputs.appId && inputs.appPrivateKey) {
    // (the App is optional here; its absence is reported above)
    const app = await mintInstallationToken({ appId: inputs.appId, privateKey: inputs.appPrivateKey, owner: repo.owner, repo: repo.name });
    token = app.token;
    mask(token);
    process.stdout.write(`App ${app.appSlug}: installation ${app.installationId}${app.missing.length ? `; MISSING ${app.missing.join(", ")}` : "; permissions ok"}${app.extra.length ? `; extra ${app.extra.join(", ")}` : ""}\n`);
    if (app.missing.length) throw new Error(`the App lacks ${app.missing.join(", ")}; fix its permissions (${appPermissionsText({ userAccount: app.userAccount })}) before setup`);
  }
  if (!token && yes && steps.some((st) => st !== APP_STEP)) process.stdout.write("no App credentials given: GitHub steps run as your gh login\n");
  const opts = { token };
  const secretScope = String(args.secret_scope || "repo");
  if (steps.includes(APP_STEP) && !["repo", "org"].includes(secretScope)) throw new Error(`--secret-scope ${secretScope}: repo or org`);
  // The App step reads the repository (its owner and ids) with the user's own gh login: no App exists yet.
  const repoData = steps.includes(APP_STEP) ? await getRepo(repo, { token: null }) : null;
  if (repoData && secretScope === "org" && repoData.owner?.type !== "Organization") throw new Error(`--secret-scope org: ${repo.owner} is no organization; the secrets go on the repository`);
  // The protection step's required checks: --ci-checks (`--ci-checks=` clears them), else the workflow file's, else the
  // branch's existing required checks, which are exact. Anything else is only a candidate the person names to apply.
  let protectionChecks = inputs.ciChecks;
  let checksFrom = explicit.ci_checks !== undefined ? (inputs.ciChecks.length ? "--ci-checks" : "--ci-checks= clears them") : inputs.ciChecks.length ? "the workflow file's PENDULUM_CI_CHECKS" : "";
  let candidates = "";
  if (steps.includes("protection") && explicit.ci_checks === undefined && !inputs.ciChecks.length) {
    const required = await requiredChecks(repo, { token: null }).catch(() => []);
    if (required.length) {
      protectionChecks = required;
      checksFrom = "the default branch's required checks, kept";
    } else {
      const repoInfo = await getRepo(repo, { token: null }).catch(() => null);
      const queue = args.merge_queue !== "false" && !noQueueReason(repoInfo);
      candidates = candidatesText(await ciCheckCandidates(repo, { token: null }, { queue }));
    }
  }
  const checksText = protectionChecks.length ? `${protectionChecks.join(", ")} (from ${checksFrom})` : `none${checksFrom ? ` (${checksFrom})` : ""}${candidates}`;
  const presetNote = args.preset && steps.includes("workflow") ? await presetOverrides(repo, args.preset, { token: null }) : "";
  // An accounts option is checked before anything is applied, and the dry run names the accounts and their secrets.
  // The secrets the jobs would name do not hang on the repository's answers (the runner, notify, the release): a render
  // with stand-ins for those names them.
  const dryAcc = steps.includes("workflow") ? accountSettings({ before, explicit, harness: inputs.harness }) : null;
  const dryText = () => workflowText({ template, inputs, args, explicit, before, latest: `v${PENDULUM_VERSION}`, notify: "", ciWorkflow: args.ci_workflow || "CI", defaultBranch: "main" });
  const accountsLine = dryAcc?.given ? accountsNote({ inputs, before, acc: dryAcc, oldText: existsSync(outPath) ? readFileSync(outPath, "utf8") : "", newText: dryText() }) : "";
  const plan = {
    app: repoData && appPlan(repoData, secretScope),
    labels: `create the labels ${LABELS.map(([n]) => n).join(", ")} when absent`,
    project: `create the Pendulum Project (v2) with Status ${COLUMNS.join(", ")} and link it, or add missing columns (none on a repository a user owns: no GitHub App can move its cards)`,
    protection: `create or update the "pendulum" ruleset on the default branch (a merge queue where GitHub offers one, required checks ${checksText}, no deletion or force push) and set squash commits to take the PR's title and body; runs as your gh login (needs admin), not the App`,
    "default-token": null,
    workflow: `write ${args.out || ".github/workflows/pendulum.yml"} from workflow-template.yml${args.preset ? ` with the ${args.preset} preset (${Object.entries(PRESETS[args.preset]).map(([k, v]) => `${k} ${v}`).join(", ")}; a flag beside it wins)${presetNote}` : ""}${args.sandbox ? ` with launch jobs for the ${args.sandbox} sandbox (secrets VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID)` : ""}${before ? `, keeping the settings the existing file states unless a flag gives one` : ""}${accountsLine ? `; ${accountsLine}` : ""}`,
  };
  if (!yes) {
    // The default token's line reads which workflows the change reaches, as the user's own gh login (it needs admin).
    if (steps.includes(DEFAULT_TOKEN_STEP)) plan["default-token"] = await defaultTokenPlan(repo, { token: null });
    process.stdout.write(`Dry run for ${repo.full}. Pass --yes to apply:\n`);
    for (const s of steps) process.stdout.write(`  ${s}: ${plan[s] || "unknown step"}\n`);
    return;
  }
  for (const s of steps) {
    let note;
    if (s === APP_STEP) note = await applyApp(repo, repoData, secretScope, { replace: args.replace === "true" });
    else if (s === "labels") note = await applyLabels(repo, opts);
    else if (s === "project") note = await projectStep({ repo, opts, args, explicit, steps, outPath, checkout });
    else if (s === "protection") note = `${await applyProtection(repo, { ciChecks: protectionChecks, queue: args.merge_queue !== "false" }, { token: null })}${protectionChecks.length ? ` (checks from ${checksFrom})` : checksFrom ? ` (${checksFrom})` : candidates}`;
    // Repository Actions settings need administration, which the App does not have: the user's own gh login.
    else if (s === DEFAULT_TOKEN_STEP) note = await applyDefaultToken(repo, { token: null });
    else if (s === "workflow") note = `${await applyWorkflow({ inputs, args, explicit, before, template, checkout, latest: await latestRelease(), repo, opts })}${presetNote}`;
    else throw new Error(`unknown step ${s}`);
    process.stdout.write(`${s}: ${note}\n`);
  }
  process.stdout.write(`done; run node ${join(PLUGIN_ROOT, "scripts/doctor.mjs")} --repo ${repo.full} to confirm\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    process.stderr.write(`[pendulum] setup failed: ${e.message}\n`);
    process.exit(1);
  });
}

