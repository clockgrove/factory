// An Objective's harness and models (#224). The workflow's FACTORY_HARNESS, FACTORY_MODEL, FACTORY_SUBAGENT_MODEL and
// FACTORY_REVIEWER_MODEL are the repository's defaults; a label on the issue overrides the matching one for that
// Objective only, and an issue with none runs on the defaults. Labels, not the body: who applied each one is on the
// issue's timeline (objective-trust.mjs choiceTrusted), and the plan's record covers them (objective-trust.mjs
// objectiveSha), so one added, removed or changed after the plan stops the Objective like an edit.
import { DEFAULTS, MODEL_DEFAULTS, resolveInputs } from "./inputs.mjs";
import { CODEX_PRICES, bareModel, codexRate } from "./usage.mjs";

export const HARNESSES = ["claude", "codex", "copilot"];
/** Each choice's label prefix, keyed by the input it overrides; the rest of the name is the harness or the model id. */
export const CHOICE_PREFIXES = Object.freeze({ harness: "factory:harness:", model: "factory:model:", subagent_model: "factory:subagent-model:", reviewer_model: "factory:reviewer-model:" });
/**
 * GitHub's limit on a label name's length, which it enforces itself when the label is made: an id fits in 50 less its
 * prefix (34 for a harness, 36 for a worker model, 27 for a sub-agent or reviewer model). USAGE.md says so.
 */
export const LABEL_MAX = 50;
/** The words a reason uses for each choice. */
const WHAT = { harness: "harness", model: "worker model", subagent_model: "sub-agent model", reviewer_model: "reviewer model" };
const tick = (s) => `\`${s}\``;

const kindOf = (name) => Object.entries(CHOICE_PREFIXES).find(([, p]) => String(name ?? "").toLowerCase().startsWith(p))?.[0] ?? null;
/** Whether a label name is one of the four choice labels. */
export const isChoiceLabel = (name) => kindOf(name) !== null;
/** The choice labels among `names` (names, or GitHub's label objects), sorted: the set the plan's record covers. */
export const choiceLabels = (names = []) => [...new Set((names || []).map((n) => (typeof n === "string" ? n : n?.name)).filter((n) => typeof n === "string" && isChoiceLabel(n)))].sort();

/**
 * The choice the issue's labels make: {ok: true, choice, labels}, `choice` holding `harness`, `model`, `subagent_model` and
 * `reviewer_model` as the labels set them (an input name each, as a flag sets it), or {ok: false, labels, reason, fix} for
 * two labels of one kind, a harness Factory does not run, or a label naming nothing. Decided on the names alone.
 */
export function choiceOf(names = []) {
  const labels = choiceLabels(names);
  const by = {};
  for (const l of labels) (by[kindOf(l)] ||= []).push(l);
  const choice = {};
  for (const kind of Object.keys(CHOICE_PREFIXES)) {
    const list = by[kind];
    if (!list) continue;
    if (list.length > 1) return { ok: false, labels, reason: `the issue has ${list.length} ${WHAT[kind]} labels (${list.map(tick).join(", ")}), so Factory cannot tell which one this Objective runs on`, fix: "Keep one of them, then re-apply `factory:objective`." };
    const value = list[0].slice(CHOICE_PREFIXES[kind].length).trim();
    if (!value) return { ok: false, labels, reason: `${tick(list[0])} names no ${WHAT[kind]}`, fix: `Name one after the prefix (${tick(`${CHOICE_PREFIXES[kind]}<${kind === "harness" ? "name" : "id"}>`)}) or remove the label, then re-apply \`factory:objective\`.` };
    if (kind === "harness") {
      const h = value.toLowerCase();
      if (!HARNESSES.includes(h)) return { ok: false, labels, reason: `${tick(list[0])} names no harness Factory runs (${HARNESSES.join(", ")})`, fix: `Use \`factory:harness:claude\`, \`factory:harness:codex\` or \`factory:harness:copilot\`, then re-apply \`factory:objective\`.` };
      choice.harness = h;
    } else choice[kind] = value;
  }
  return { ok: true, choice, labels };
}

const CLAUDE_ALIASES = new Set(["fable", "opus", "sonnet", "haiku"]);

/**
 * Why `harness` cannot run `model` within Factory's caps, {reason, fix}, or null when it can: decided on the id's form
 * and Factory's price table, before any spend. Claude Code runs Anthropic's models (a `claude-` id or one of its aliases)
 * and reports its dollars itself. Codex runs a model Factory prices (codex-prices.json): with no price row max_usd could
 * not stop its runs; a provider prefix (`openai/`) is the AI Gateway's form only. Copilot takes its own catalog's names,
 * which vary by account and which Factory cannot read before a run: only the form is checked here (no provider prefix or spaces).
 */
export function modelProblem(harness, model, { gateway = false } = {}) {
  const m = String(model ?? "").trim();
  const other = (h) => HARNESSES.filter((x) => x !== h).map((x) => tick(`factory:harness:${x}`)).join(" or ");
  if (harness === "claude") {
    const bare = m.replace(/\[1m\]$/i, "");
    if (/^claude-[a-z0-9][a-z0-9.-]*$/i.test(bare) || CLAUDE_ALIASES.has(bare.toLowerCase())) return null;
    return { reason: `Claude Code runs Anthropic's Claude models, and ${tick(m)} is not one`, fix: `Name a Claude model (such as \`${MODEL_DEFAULTS.claude.model}\`), or choose the harness that runs ${tick(m)} with ${other("claude")}.` };
  }
  if (harness === "codex") {
    if (m.includes("/") && !gateway) return { reason: `${tick(m)} has a provider prefix, which only the AI Gateway takes, and this repository runs Codex on CODEX_API_KEY`, fix: `Name the model without its prefix (${tick(bareModel(m))}).` };
    if (codexRate(CODEX_PRICES, m)) return null;
    const some = Object.keys(CODEX_PRICES.perMillion).slice(0, 3).map(tick).join(", ");
    return { reason: `${tick(bareModel(m))} has no row in Factory's Codex price table, so max_usd could not stop its runs`, fix: `Name a model the table prices (${some}, …: plugin/scripts/lib/codex-prices.json), or choose the harness that runs ${tick(m)} with ${other("codex")}.` };
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
 * set for the run's; one naming the workflow's own harness (FACTORY_HARNESS) keeps the env block's. Returns {ok, inputs} (the CHOSEN_FIELDS only), or {ok: false, reason, fix} naming the label,
 * or the harness label whose defaults these are, when the harness cannot run a model (modelProblem). `gateway`: whether
 * Codex has the AI Gateway key, when `env` no longer holds it (the launcher).
 */
export function chosenInputs({ args = {}, env = process.env, choice = {}, gateway } = {}) {
  const base = resolveInputs({ args, env });
  const switched = !!choice.harness && choice.harness !== base.harness;
  // The run's harness's models and efforts are not the chosen harness's: a run's own (a flag, `with:`) always go; the
  // workflow's env block's go unless the label names the workflow's own harness (a manual run that overrode it).
  const workflowHarness = String(env.FACTORY_HARNESS || DEFAULTS.harness).trim().toLowerCase();
  const keepWorkflow = choice.harness === workflowHarness;
  const bound = (name) => switched && HARNESS_BOUND.some((n) => name === n || name === `FACTORY_INPUT_${n.toUpperCase()}` || (!keepWorkflow && name === `FACTORY_${n.toUpperCase()}`));
  const keep = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !bound(k)));
  const r = resolveInputs({ args: { ...keep(args), ...choice }, env: keep(env) });
  const viaGateway = gateway ?? !!r.codexGatewayKey;
  for (const kind of Object.keys(FIELD)) {
    const m = choice[kind] || (switched ? r[FIELD[kind]] : "");
    if (!m) continue;
    const p = modelProblem(r.harness, m, { gateway: viaGateway });
    const label = choice[kind] ? `${CHOICE_PREFIXES[kind]}${m}` : `${CHOICE_PREFIXES.harness}${choice.harness}`;
    if (p) return { ok: false, reason: `${tick(label)} asks ${r.harness} for a model it cannot run here${choice[kind] ? "" : ` (its ${WHAT[kind]}, ${tick(m)})`}: ${p.reason}`, fix: `${p.fix} Then re-apply \`factory:objective\`.` };
  }
  return { ok: true, inputs: Object.fromEntries(CHOSEN_FIELDS.map((k) => [k, r[k]])) };
}

/**
 * The harness CLI version to install: the repository's pin (`harness_version`) for the harness it was set for, the
 * repository's default (`defaultHarness`); `latest` for another one an Objective's harness label chose.
 */
export const harnessVersionFor = (harness, defaultHarness, version) => (harness === defaultHarness && version ? version : "latest");

/**
 * Why a stage cannot run on `harness` where its route prepared another (`prepared`: FACTORY_STAGE_HARNESS, the harness the
 * Action installed, the launcher gave the sandbox the credential of, or the local loop set the sandbox up for), or null.
 */
export function routeProblem(prepared, harness) {
  const p = String(prepared ?? "").trim().toLowerCase();
  if (!p || p === harness) return null;
  return { reason: `this stage was prepared for ${p} (its CLI, credential and sandbox) but the Objective now runs on ${harness}: its harness label changed while the stage started`, fix: "Re-apply `factory:objective`: the next stage is prepared for the harness the labels name." };
}

/** What a stage records of the harness and models it ran (the usage record's `choice`, the progress comment's harness line). */
export const ranWith = (inputs, labels = []) => ({ harness: inputs.harness, worker: inputs.model || null, subagent: inputs.subagentModel || null, reviewer: inputs.reviewerModel || null, labels: choiceLabels(labels) });
