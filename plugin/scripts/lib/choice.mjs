// An Objective's harness and models (#224). The workflow's PENDULUM_HARNESS, PENDULUM_MODEL, PENDULUM_SUBAGENT_MODEL and
// PENDULUM_REVIEWER_MODEL are the repository's defaults; a label on the issue overrides the matching one for that
// Objective only, and an issue with none runs on the defaults. Labels, not the body: who applied each one is on the
// issue's timeline (objective-trust.mjs choiceTrusted), and the plan's record covers them (objective-trust.mjs
// objectiveSha), so one added, removed or changed after the plan stops the Objective like an edit.
// A `pendulum:host:<host>` label (#278) opens one more network host to that Objective's sandboxes alone, under the same
// rule: it counts once a person who can push applied it, and the plan's record covers it.
import { DEFAULTS, resolveInputs } from "./inputs.mjs";
import { CODEX_PRICES, bareModel, codexRow } from "./usage.mjs";
import { isSandboxHost, wildcardRefusal } from "./local.mjs";

export const HARNESSES = ["claude", "codex", "copilot"];
/** Each choice's label prefix, keyed by the input it overrides; the rest of the name is the harness or the model id. */
export const CHOICE_PREFIXES = Object.freeze({ harness: "pendulum:harness:", model: "pendulum:model:", subagent_model: "pendulum:subagent-model:", reviewer_model: "pendulum:reviewer-model:" });
/**
 * GitHub's limit on a label name's length, which it enforces itself when the label is made: an id fits in 50 less its
 * prefix (33 for a harness, 35 for a worker model, 26 for a sub-agent or reviewer model). USAGE.md says so.
 */
export const LABEL_MAX = 50;
/**
 * The label that marks an Objective as a foundation (#275): later work builds on what it adds, so its review gets a
 * second pass that checks the shared contracts the diff changes against their callers (review.mjs foundationPrompt).
 * Trusted as the choice labels are (objective-trust.mjs choiceTrusted); not in the plan's record, since it changes only
 * the review, which reads it when it starts.
 */
export const FOUNDATION_LABEL = "pendulum:foundation";
/** The foundation label's own name among `names` (names, or GitHub's label objects), or null. */
export const foundationLabel = (names = []) => (names || []).map((n) => (typeof n === "string" ? n : n?.name)).find((n) => typeof n === "string" && n.trim().toLowerCase() === FOUNDATION_LABEL) ?? null;

/**
 * The prefix of an experiment label (#545): `pendulum:experiment:<name>` tags an Objective as one of a named experiment's
 * arms, for `pendulum report --compare`. It changes nothing Pendulum runs (it is no choice label and not in the plan's
 * record); the report counts it only when the person who last applied it can push (objective-trust.mjs labelsVouched).
 * A name is letters, digits, `.`, `_` and `-`, and fits in LABEL_MAX less the prefix (30 characters).
 */
export const EXPERIMENT_PREFIX = "pendulum:experiment:";
export const EXPERIMENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,29}$/;
/** Whether a label name is an experiment label. */
export const isExperimentLabel = (name) => typeof name === "string" && name.toLowerCase().startsWith(EXPERIMENT_PREFIX) && EXPERIMENT_NAME.test(name.slice(EXPERIMENT_PREFIX.length));

/** The words a reason uses for each choice. */
const WHAT = { harness: "harness", model: "worker model", subagent_model: "sub-agent model", reviewer_model: "reviewer model" };
const tick = (s) => `\`${s}\``;

/**
 * The prefix of a host label: `pendulum:host:huggingface.co` lets this Objective's sandboxes reach huggingface.co, and
 * `pendulum:host:*.hf.co` its subdomains. A host fits in LABEL_MAX less the prefix (36 characters).
 */
export const HOST_PREFIX = "pendulum:host:";
const kindOf = (name) => Object.entries(CHOICE_PREFIXES).find(([, p]) => String(name ?? "").toLowerCase().startsWith(p))?.[0] ?? null;
const isHostLabel = (name) => String(name ?? "").toLowerCase().startsWith(HOST_PREFIX);
/** Whether a label name is one of the four choice labels or a host label: what the plan's record and the trust check cover. */
export const isChoiceLabel = (name) => kindOf(name) !== null || isHostLabel(name);
/** The choice and host labels among `names` (names, or GitHub's label objects), sorted: the set the plan's record covers. */
export const choiceLabels = (names = []) => [...new Set((names || []).map((n) => (typeof n === "string" ? n : n?.name)).filter((n) => typeof n === "string" && isChoiceLabel(n)))].sort();

/**
 * The choice the issue's labels make: {ok: true, choice, labels}, `choice` holding `harness`, `model`, `subagent_model` and
 * `reviewer_model` as the labels set them (an input name each, as a flag sets it), or {ok: false, labels, reason, fix} for
 * two labels of one kind, a harness Pendulum does not run, or a label naming nothing. Decided on the names alone.
 */
export function choiceOf(names = []) {
  const labels = choiceLabels(names);
  const by = {};
  for (const l of labels) if (kindOf(l)) (by[kindOf(l)] ||= []).push(l);
  const choice = {};
  for (const kind of Object.keys(CHOICE_PREFIXES)) {
    const list = by[kind];
    if (!list) continue;
    if (list.length > 1) return { ok: false, labels, reason: `the issue has ${list.length} ${WHAT[kind]} labels (${list.map(tick).join(", ")}), so Pendulum cannot tell which one this Objective runs on`, fix: "Keep one of them, then resume through Draft." };
    const value = list[0].slice(CHOICE_PREFIXES[kind].length).trim();
    if (!value) return { ok: false, labels, reason: `${tick(list[0])} names no ${WHAT[kind]}`, fix: `Name one after the prefix (${tick(`${CHOICE_PREFIXES[kind]}<${kind === "harness" ? "name" : "id"}>`)}) or remove the label, then resume through Draft.` };
    if (kind === "harness") {
      const h = value.toLowerCase();
      if (!HARNESSES.includes(h)) return { ok: false, labels, reason: `${tick(list[0])} names no harness Pendulum runs (${HARNESSES.join(", ")})`, fix: `Use \`pendulum:harness:claude\`, \`pendulum:harness:codex\` or \`pendulum:harness:copilot\`, then resume through Draft.` };
      choice.harness = h;
    } else choice[kind] = value;
  }
  return { ok: true, choice, labels };
}

/**
 * The hosts the issue's host labels open for this Objective: {ok: true, hosts, labels} (`hosts` lower case, sorted, once
 * each; `labels` the host labels), or {ok: false, labels, reason, fix} for a label that names no host a sandbox enforces as
 * written (local.mjs isSandboxHost: a host name or `*.` and one; never an IP address, a port, a scheme or path,
 * `localhost`, or `*.` over a public suffix). Decided on the names alone; who applied each is objective-trust.mjs choiceTrusted's check.
 */
export function hostsOf(names = []) {
  const labels = choiceLabels(names).filter(isHostLabel);
  const hosts = new Set();
  for (const l of labels) {
    const host = l.slice(HOST_PREFIX.length).trim().toLowerCase();
    const refusal = host.startsWith("*.") && isSandboxHost(host.slice(2)) ? wildcardRefusal(host.slice(2)) : null;
    if (refusal) return { ok: false, labels, reason: `${tick(l)} opens every site under \`${host.slice(2)}\`, and the Public Suffix List names \`${refusal.rule}\` there a public suffix anyone can register a name under`, fix: `Name each host it needs, as \`pendulum:host:app.${host.slice(2)}\`, or remove the label, then resume through Draft.` };
    if (!isSandboxHost(host)) return { ok: false, labels, reason: `${tick(l)} names no host Pendulum's sandboxes can allow`, fix: `Name one host after the prefix, as \`pendulum:host:example.com\` or \`pendulum:host:*.example.com\` (no scheme, port, path, IP address or localhost), or remove the label, then resume through Draft.` };
    hosts.add(host);
  }
  return { ok: true, hosts: [...hosts].sort(), labels };
}

/**
 * Why `harness` cannot run `model` within Pendulum's caps, {reason, fix}, or null when it can: decided before any spend.
 * Claude Code takes any id and reports its dollars itself: whether its login serves the model is the API's answer. For the
 * worker and reviewer model that is a refusal before any token is billed, which the stage Blocks on (usage.mjs
 * providerRefusal); for a sub-agent's, the sub-agent's refusal, at which the stage stops the run and Blocks naming the
 * label (usage.mjs subAgentRefusal). Codex runs a model Pendulum
 * prices (codex-prices.json): with no price row max_usd could not stop its runs; a provider prefix (`openai/`) is the
 * AI Gateway's form only. Copilot takes its own catalog's names,
 * which vary by account and which Pendulum cannot read before a run: only the form is checked here (no provider prefix or spaces).
 */
export function modelProblem(harness, model, { gateway = false } = {}) {
  const m = String(model ?? "").trim();
  const other = (h) => HARNESSES.filter((x) => x !== h).map((x) => tick(`pendulum:harness:${x}`)).join(" or ");
  if (harness === "claude") return null;
  if (harness === "codex") {
    if (m.includes("/") && !gateway) return { reason: `${tick(m)} has a provider prefix, which only the AI Gateway takes, and this repository runs Codex on CODEX_API_KEY`, fix: `Name the model without its prefix (${tick(bareModel(m))}).` };
    const row = codexRow(CODEX_PRICES, m);
    if (row.rate) return null;
    const some = Object.keys(CODEX_PRICES.perMillion).slice(0, 3).map(tick).join(", ");
    const what = row.why === "price-ended" ? `${tick(bareModel(m))} is priced in Pendulum's Codex price table at OpenAI's promotional rate for ${tick(row.id)}, which ended ${CODEX_PRICES.perMillion[row.id].until}` : `${tick(bareModel(m))} has no row in Pendulum's Codex price table`;
    return { reason: `${what}, so max_usd could not stop its runs`, fix: `Name a model the table prices (${some}, …: plugin/scripts/lib/codex-prices.json), or choose the harness that runs ${tick(m)} with ${other("codex")}.` };
  }
  if (harness === "copilot") {
    if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(m)) return null;
    return { reason: `Copilot names its models without a provider prefix or spaces, and ${tick(m)} is not such a name`, fix: "Name the model as `copilot --model` takes it, or `auto`." };
  }
  return { reason: `no harness ${tick(harness)}`, fix: `Use one of ${HARNESSES.join(", ")}.` };
}

/** The inputs an Objective's choice sets (inputs.mjs resolveInputs): its harness, and the models and efforts that go with it. */
export const CHOSEN_FIELDS = ["harness", "model", "effort", "subagentModel", "reviewerModel", "reviewerEffort", "reviewerFallback"];

/** The settings that belong to a harness: a switch of harness takes the new one's own defaults for each. */
const HARNESS_BOUND = ["model", "subagent_model", "reviewer_model", "reviewer_effort", "effort"];
const FIELD = { model: "model", subagent_model: "subagentModel", reviewer_model: "reviewerModel" };

/**
 * The harness and models this Objective runs on: the repository's defaults (`env`, the workflow's env block; `args`, a
 * stage's flags) with the labels' `choice` as the strongest input. A harness label naming another harness than the run's
 * takes that harness's own defaults for the models and efforts no label names, whatever a flag, `with:` or the env block
 * set for the run's; one naming the workflow's own harness (PENDULUM_HARNESS) keeps the env block's. Returns {ok, inputs} (the CHOSEN_FIELDS only), or {ok: false, reason, fix} naming the label,
 * or the harness label whose defaults these are, when the harness cannot run a model (modelProblem). `gateway`: whether
 * Codex has the AI Gateway key, when `env` no longer holds it (the launcher).
 */
export function chosenInputs({ args = {}, env = process.env, choice = {}, gateway } = {}) {
  const base = resolveInputs({ args, env });
  const switched = !!choice.harness && choice.harness !== base.harness;
  // The run's harness's models and efforts are not the chosen harness's: a run's own (a flag, `with:`) always go; the
  // workflow's env block's go unless the label names the workflow's own harness (a manual run that overrode it).
  const workflowHarness = String(env.PENDULUM_HARNESS || DEFAULTS.harness).trim().toLowerCase();
  const keepWorkflow = choice.harness === workflowHarness;
  const bound = (name) => switched && HARNESS_BOUND.some((n) => name === n || name === `PENDULUM_INPUT_${n.toUpperCase()}` || (!keepWorkflow && name === `PENDULUM_${n.toUpperCase()}`));
  const keep = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !bound(k)));
  const r = resolveInputs({ args: { ...keep(args), ...choice }, env: keep(env) });
  const viaGateway = gateway ?? !!r.codexGatewayKey;
  for (const kind of Object.keys(FIELD)) {
    const m = choice[kind] || (switched ? r[FIELD[kind]] : "");
    if (!m) continue;
    const p = modelProblem(r.harness, m, { gateway: viaGateway });
    const label = choice[kind] ? `${CHOICE_PREFIXES[kind]}${m}` : `${CHOICE_PREFIXES.harness}${choice.harness}`;
    if (p) return { ok: false, reason: `${tick(label)} asks ${r.harness} for a model it cannot run here${choice[kind] ? "" : ` (its ${WHAT[kind]}, ${tick(m)})`}: ${p.reason}`, fix: `${p.fix} Then resume through Draft.` };
  }
  return { ok: true, inputs: Object.fromEntries(CHOSEN_FIELDS.map((k) => [k, r[k]])) };
}

/**
 * The harness CLI version to install: the repository's pin (`harness_version`) for the harness it was set for, the one
 * the workflow's env block names (`defaultHarness`, inputs.mjs workflowHarness); `latest` for another one, chosen by an
 * Objective's harness label, a run's override or a repository variable.
 */
export const harnessVersionFor = (harness, defaultHarness, version) => (harness === defaultHarness && version ? version : "latest");

/**
 * Why a stage cannot run on `harness` where its route prepared another (`prepared`: PENDULUM_STAGE_HARNESS, the harness the
 * Action installed, the launcher gave the sandbox the credential of, or the local loop set the sandbox up for), or null.
 */
export function routeProblem(prepared, harness) {
  const p = String(prepared ?? "").trim().toLowerCase();
  if (!p || p === harness) return null;
  return { reason: `this stage was prepared for ${p} (its CLI, credential and sandbox) but the Objective now runs on ${harness}: its harness label changed while the stage started`, fix: "Resume through Draft: the next stage is prepared for the harness the labels name." };
}

/**
 * What a stage records of the harness, models and reasoning efforts it ran and the hosts its labels opened (the usage
 * record's `ran`, the progress comment's harness line), and in local mode the account it ran on (`account`:
 * PENDULUM_STAGE_ACCOUNT, accounts.mjs), by name only.
 */
export const ranWith = (inputs, labels = [], account = null) => {
  const h = hostsOf(labels);
  return { harness: inputs.harness, worker: inputs.model || null, subagent: inputs.subagentModel || null, reviewer: inputs.reviewerModel || null, labels: choiceLabels(labels), hosts: h.ok ? h.hosts : [], effort: inputs.effort || null, reviewerEffort: inputs.reviewerEffort || null, ...(stageAccountName(account) ? { account } : {}) };
};
/**
 * The three models of a stage's `ran` (ranWith), each as `seen` has it where `seen` has the role (usage.mjs copilotRan:
 * the one model Copilot's own stream names, or null for more than one), else as `ran` has it, null for none.
 */
export const ranModels = (ran, seen = null) => Object.fromEntries(["worker", "subagent", "reviewer"].map((k) => [k, seen && Object.hasOwn(seen, k) ? seen[k] : (ran?.[k] ?? null)]));
/** An account name as accounts.mjs allows one (a harness's own name included), else null: nothing else is recorded. */
export const stageAccountName = (name) => (typeof name === "string" && name.length <= LABEL_MAX - "pendulum:account:".length && /^[a-z0-9][a-z0-9-]*$/.test(name) ? name : null);

/**
 * Why a stage cannot run with the hosts its labels now open where its route prepared its sandboxes for others
 * (`prepared`: PENDULUM_STAGE_HOSTS, the hosts local mode's loop opened for this stage, comma separated; undefined on a
 * route whose stage opens its own), or null. A host label added or removed while the stage started.
 */
export function hostsProblem(prepared, hosts = []) {
  if (prepared === undefined || prepared === null) return null;
  const was = [...new Set(String(prepared).split(",").map((h) => h.trim()).filter(Boolean))].sort();
  if (was.join(",") === [...hosts].sort().join(",")) return null;
  return { reason: `this stage's sandboxes were set up for the hosts ${was.length ? was.map(tick).join(", ") : "of no host label"} but the Objective's host labels now name ${hosts.length ? hosts.map(tick).join(", ") : "none"}: a \`pendulum:host:\` label changed while the stage started`, fix: "Resume through Draft: the next stage's sandboxes are set up for the hosts the labels name." };
}
