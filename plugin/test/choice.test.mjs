// An Objective's harness and models (#224): labels on its issue override the repository's defaults for it alone.
import "./temp.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CHOICE_PREFIXES, LABEL_MAX, choiceLabels, choiceOf, chosenInputs, harnessVersionFor, modelProblem, ranWith, routeProblem } from "../scripts/lib/choice.mjs";
import { MODEL_DEFAULTS, resolveInputs } from "../scripts/lib/inputs.mjs";
import { CODEX_PRICES } from "../scripts/lib/usage.mjs";
import { CHOICE_FIX, choiceGate, choiceTrusted, editedSincePlan, objectiveInputs, objectiveSha, planTextState } from "../scripts/lib/objective-trust.mjs";
import { harnessMarker, setMaintainers, setSelf } from "../scripts/lib/logic.mjs";
import { issueTextChangedAt, labelersOf } from "../scripts/lib/github.mjs";
import { missingCredential, stageEnvironment } from "../scripts/launch.mjs";
import { labelHarness } from "../scripts/objective-harness.mjs";
import { defaultsCheck } from "../scripts/doctor.mjs";
import { parseYaml } from "../scripts/lib/yaml.mjs";

const repo = { owner: "acme", name: "app", full: "acme/app" };
const ROOT = join(import.meta.dirname, "..", "..");
const ENV = { GITHUB_REPOSITORY: "acme/app", FACTORY_HARNESS: "claude", FACTORY_MODEL: "claude-opus-5-5", FACTORY_SUBAGENT_MODEL: "claude-sonnet-5-5", FACTORY_REVIEWER_MODEL: "claude-fable-5-2" };
const pick = (r) => ({ harness: r.harness, model: r.model, subagentModel: r.subagentModel, reviewerModel: r.reviewerModel });

test("choice labels: one of each kind sets that input; none is the repository's defaults; other labels are not choices", () => {
  assert.deepEqual(choiceOf(["factory:objective", "P1"]), { ok: true, choice: {}, labels: [] });
  const c = choiceOf([{ name: "factory:objective" }, { name: "factory:harness:Codex" }, { name: "factory:model:gpt-6.1-terra" }, { name: "factory:subagent-model:gpt-6-luna" }, { name: "factory:reviewer-model:gpt-6.1-sol" }]);
  assert.equal(c.ok, true);
  assert.deepEqual(c.choice, { harness: "codex", model: "gpt-6.1-terra", subagent_model: "gpt-6-luna", reviewer_model: "gpt-6.1-sol" });
  assert.deepEqual(c.labels, ["factory:harness:Codex", "factory:model:gpt-6.1-terra", "factory:reviewer-model:gpt-6.1-sol", "factory:subagent-model:gpt-6-luna"], "sorted: the set the plan's record covers");
  assert.deepEqual(choiceLabels(["factory:objective", "factory:restart", "factory:model:x"]), ["factory:model:x"]);
});

test("choice labels: two of one kind, an unknown harness or an empty id is refused, naming the labels", () => {
  const two = choiceOf(["factory:model:claude-opus-5-5", "factory:model:claude-sonnet-5-5"]);
  assert.equal(two.ok, false);
  assert.match(two.reason, /2 worker model labels \(`factory:model:claude-opus-5-5`, `factory:model:claude-sonnet-5-5`\)/);
  assert.match(two.fix, /Keep one/);
  const h = choiceOf(["factory:harness:gemini"]);
  assert.match(h.reason, /`factory:harness:gemini` names no harness Factory runs/);
  assert.match(choiceOf(["factory:reviewer-model:"]).reason, /names no reviewer model/);
  assert.equal(choiceOf(["factory:harness:claude", "factory:harness:codex"]).ok, false);
});

test("label names: every model in Factory's defaults and price tables fits GitHub's 50 characters for every kind", () => {
  const claude = Object.keys(JSON.parse(readFileSync(join(ROOT, "plugin", "scripts", "lib", "claude-prices.json"), "utf8")).perMillion);
  const ids = new Set([...Object.values(MODEL_DEFAULTS).flatMap((d) => [d.model, d.subagent_model, d.reviewer_model]).filter(Boolean), ...claude, ...Object.keys(CODEX_PRICES.perMillion)]);
  for (const id of ids) for (const kind of ["model", "subagent_model", "reviewer_model"]) assert.ok(`${CHOICE_PREFIXES[kind]}${id}`.length <= LABEL_MAX, `${kind} ${id}`);
  assert.deepEqual(Object.fromEntries(Object.entries(CHOICE_PREFIXES).map(([k, p]) => [k, LABEL_MAX - p.length])), { harness: 34, model: 36, subagent_model: 27, reviewer_model: 27 }, "the room USAGE.md states");
});

test("modelProblem: each harness runs only what it can within Factory's caps, decided before any spend", () => {
  for (const m of ["claude-opus-5-5", "claude-sonnet-5-5[1m]", "opus", "fable"]) assert.equal(modelProblem("claude", m), null, m);
  const gpt = modelProblem("claude", "gpt-6.1-sol");
  assert.match(gpt.reason, /Claude Code runs Anthropic's Claude models, and `gpt-6.1-sol` is not one/);
  assert.match(gpt.fix, /`factory:harness:codex` or `factory:harness:copilot`/);
  for (const m of ["gpt-6.1-sol", "gpt-5.5-2026-04-23"]) assert.equal(modelProblem("codex", m), null, m);
  assert.match(modelProblem("codex", "gpt-9-nova").reason, /no row in Factory's Codex price table, so max_usd could not stop its runs/);
  assert.match(modelProblem("codex", "claude-opus-5-5").fix, /codex-prices\.json/);
  assert.match(modelProblem("codex", "openai/gpt-6.1-sol").reason, /provider prefix, which only the AI Gateway takes/);
  assert.equal(modelProblem("codex", "openai/gpt-6.1-sol", { gateway: true }), null);
  for (const m of ["claude-sonnet-4.5", "gpt-5.1", "auto"]) assert.equal(modelProblem("copilot", m), null, m);
  assert.match(modelProblem("copilot", "openai/gpt-5").reason, /without a provider prefix/);
});

test("chosenInputs: no label is the defaults; a harness label takes that harness's defaults; a model label overrides only its own input", () => {
  assert.deepEqual(pick(chosenInputs({ env: ENV }).inputs), pick(resolveInputs({ env: ENV })), "an issue with no label runs on the defaults, as today");
  const codex = chosenInputs({ env: { ...ENV, FACTORY_EFFORT: "high" }, choice: { harness: "codex" } }).inputs;
  assert.deepEqual(pick(codex), { harness: "codex", model: "gpt-6.1-sol", subagentModel: "gpt-6.1-sol", reviewerModel: "gpt-6.1-sol" });
  assert.equal(codex.effort, "", "the env block's effort is its own harness's");
  assert.equal(codex.reviewerEffort, "high", "Codex's own reviewer effort");
  const sonnet = chosenInputs({ env: ENV, choice: { model: "claude-sonnet-5-5" } }).inputs;
  assert.deepEqual(pick(sonnet), { harness: "claude", model: "claude-sonnet-5-5", subagentModel: "claude-sonnet-5-5", reviewerModel: "claude-fable-5-2" });
  // Two Objectives at once on one repository, on two worker models and one on another harness: no workflow edit.
  const runs = [{}, { model: "claude-haiku-5-5" }, { harness: "copilot" }].map((choice) => chosenInputs({ env: ENV, choice }).inputs);
  assert.deepEqual(runs.map((r) => `${r.harness}/${r.model}`), ["claude/claude-opus-5-5", "claude/claude-haiku-5-5", "copilot/"]);
  // The manual run's harness input is the run's default; the issue's label wins over it.
  assert.equal(chosenInputs({ env: { ...ENV, FACTORY_INPUT_HARNESS: "copilot" }, choice: { harness: "codex" } }).inputs.harness, "codex");
  assert.equal(chosenInputs({ env: { ...ENV, FACTORY_INPUT_HARNESS: "copilot" } }).inputs.harness, "copilot");
});

test("chosenInputs: a model the chosen harness cannot run is refused, naming the label and the fix", () => {
  const r = chosenInputs({ env: ENV, choice: { model: "gpt-6.1-sol" } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /^`factory:model:gpt-6.1-sol` asks claude for a model it cannot run here/);
  assert.match(r.fix, /factory:harness:codex.*re-apply `factory:objective`/);
  assert.equal(chosenInputs({ env: ENV, choice: { harness: "codex", model: "gpt-6.1-sol" } }).ok, true, "with the harness that runs it");
  assert.match(chosenInputs({ env: ENV, choice: { harness: "codex", reviewer_model: "gpt-9-nova" } }).reason, /`factory:reviewer-model:gpt-9-nova`/);
  assert.equal(chosenInputs({ env: { ...ENV, FACTORY_CODEX_GATEWAY_KEY: "k" }, choice: { harness: "codex", model: "openai/gpt-6.1-sol" } }).ok, true);
});

test("routeProblem: a stage prepared for another harness than its labels now name Blocks; none prepared, or the same, runs", () => {
  assert.equal(routeProblem("", "codex"), null);
  assert.equal(routeProblem("codex", "codex"), null);
  assert.match(routeProblem("claude", "codex").reason, /prepared for claude .* now runs on codex/);
});

/** The REST timeline's actors. */
const person = (login, id = 1) => ({ login, id, type: "User" });
const perms = { kirk: "admin", dev: "write", reader: "read" };
const timeline = (by) => ({ labelers: async (_, n, names) => (assert.equal(n, 7), Object.fromEntries(names.filter((l) => by[l]).map((l) => [l, { at: "2026-11-14T10:00:00Z", actor: by[l] }]))), permission: async (_, login) => perms[login] ?? null });

test("choiceTrusted: a label counts only when the person who last applied it can push or is a pinned maintainer", async () => {
  const labels = ["factory:objective", "factory:model:claude-sonnet-5-5"];
  const ok = await choiceTrusted(repo, 7, labels, {}, timeline({ "factory:model:claude-sonnet-5-5": person("dev") }));
  assert.deepEqual([ok.ok, ok.choice], [true, { model: "claude-sonnet-5-5" }]);
  const stranger = await choiceTrusted(repo, 7, labels, {}, timeline({ "factory:model:claude-sonnet-5-5": person("reader") }));
  assert.equal(stranger.ok, false);
  assert.match(stranger.reason, /^`factory:model:claude-sonnet-5-5` was applied by `reader`, who cannot push to acme\/app and is not a pinned maintainer/);
  assert.equal(stranger.fix, CHOICE_FIX);
  assert.equal((await choiceTrusted(repo, 7, labels, {}, timeline({ "factory:model:claude-sonnet-5-5": { login: "kirk", id: 2, type: "Bot" } }))).ok, false, "an App never vouches, whatever its login");
  assert.match((await choiceTrusted(repo, 7, labels, {}, timeline({}))).reason, /who applied `factory:model:claude-sonnet-5-5` could not be read/);
  setMaintainers("acme/app", ["boss#42"]);
  try {
    assert.equal((await choiceTrusted(repo, 7, labels, {}, timeline({ "factory:model:claude-sonnet-5-5": person("boss", 42) }))).ok, true, "a pinned maintainer by id");
  } finally {
    setMaintainers("other/repo", []);
  }
  const none = await choiceTrusted(repo, 7, ["factory:objective"], {}, { labelers: async () => assert.fail("no choice label: no timeline read") });
  assert.deepEqual(none, { ok: true, choice: {}, labels: [] });
  assert.equal((await choiceTrusted(repo, 7, ["factory:model:a", "factory:model:b"], {}, { labelers: async () => assert.fail("refused on the names first") })).ok, false);
});

test("choiceGate: a refusal Blocks before any harness (cause setup, the label named); a choice runs on its inputs", async () => {
  const applied = [];
  const before = [];
  const gate = (labels, by, env = ENV) => choiceGate({ repo, issue: 7, labels, env, pr: { number: 9 }, notify: "boss", opts: {}, apply: async (_, e) => applied.push(e), before: async () => before.push(1), stage: "work", gh: timeline(by) });
  const bad = await gate(["factory:model:claude-sonnet-5-5"], { "factory:model:claude-sonnet-5-5": person("reader") });
  assert.equal(bad.ok, false);
  assert.deepEqual([applied[0].exit, applied[0].cause, applied[0].stage, applied[0].fix, applied[0].pr.number, before.length], ["blocked", "setup", "work", CHOICE_FIX, 9, 1]);
  assert.match(applied[0].reason, /`factory:model:claude-sonnet-5-5`/);
  const good = await gate(["factory:harness:codex"], { "factory:harness:codex": person("kirk") });
  assert.deepEqual([good.ok, good.inputs.harness, good.inputs.model, good.labels], [true, "codex", "gpt-6.1-sol", ["factory:harness:codex"]]);
  applied.length = 0;
  const moved = await gate(["factory:harness:codex"], { "factory:harness:codex": person("kirk") }, { ...ENV, FACTORY_STAGE_HARNESS: "claude" });
  assert.equal(moved.ok, false, "the job installed claude; its labels now name codex");
  assert.match(applied[0].reason, /prepared for claude/);
  assert.match(applied[0].fix, /Re-apply `factory:objective`/);
});

test("objectiveInputs: the launcher's and the local loop's read, from the issue's labels now", async () => {
  const gh = { issue: async () => ({ labels: [{ name: "factory:objective" }, { name: "factory:harness:copilot" }] }), ...timeline({ "factory:harness:copilot": person("dev") }) };
  const r = await objectiveInputs({ repo, issue: 7, env: ENV, opts: {}, gh });
  assert.deepEqual([r.ok, r.inputs.harness, r.labels], [true, "copilot", ["factory:harness:copilot"]]);
  const no = await objectiveInputs({ repo, issue: 7, env: ENV, opts: {}, gh: { ...gh, ...timeline({ "factory:harness:copilot": person("reader") }) } });
  assert.equal(no.ok, false);
});

test("the plan's record covers the harness and model labels: one added, removed or changed after the plan is an edit", () => {
  const plain = objectiveSha("Objective", "Build the thing.");
  assert.equal(objectiveSha("Objective", "Build the thing.", ["factory:objective", "P1"]), plain, "other labels change nothing, so a plan made before these labels keeps its record");
  const sonnet = objectiveSha("Objective", "Build the thing.", ["factory:model:claude-sonnet-5-5"]);
  assert.notEqual(sonnet, plain);
  assert.notEqual(objectiveSha("Objective", "Build the thing.", ["factory:model:claude-opus-5-5"]), sonnet);
  assert.equal(objectiveSha("Objective", "Build the thing.", ["factory:harness:claude", "factory:model:x"]), objectiveSha("Objective", "Build the thing.", ["factory:model:x", "factory:harness:claude"]), "order does not matter");
  const plan = { at: "2026-11-14T10:00:00Z", record: { sha256: plain, label: "2026-11-14T09:00:00Z" } };
  assert.equal(planTextState({ sha: sonnet, plan, labeledAt: "2026-11-14T09:00:00Z" }), "changed");
  assert.equal(planTextState({ sha: sonnet, plan, labeledAt: "2026-11-14T11:00:00Z", work: true }), "replan", "started again after the change: planned again on the new choice");
});

test("editedSincePlan: the merge's check reads the labels with the text", async () => {
  setSelf("factory-app[bot]");
  const plan = async () => ({ at: "2026-11-14T10:00:00Z", own: true, text: "## Plan", record: { sha256: objectiveSha("Objective", "Build the thing."), label: null } });
  const issue = (labels) => ({ gh: { graphql: async (q) => (assert.match(q, /labels\(first: 100\)/), { repository: { issue: { title: "Objective", body: "Build the thing.", labels: { nodes: labels.map((name) => ({ name })) } } } }) }, read: plan });
  assert.equal(await editedSincePlan(repo, 7, {}, issue(["factory:objective"])), false);
  assert.equal(await editedSincePlan(repo, 7, {}, issue(["factory:objective", "factory:reviewer-model:claude-opus-5-5"])), true);
});

/** GitHub's REST timeline, from a fetch fake. */
async function withTimeline(events, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(events), { status: 200, headers: { "content-type": "application/json" } });
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

test("the timeline: who last applied each label, and when the text or a choice label last changed", async () => {
  const ev = (event, name, at, login = "dev") => ({ event, label: { name }, created_at: `2026-11-14T${at}:00Z`, actor: { login, id: 3, type: "User" } });
  const events = [ev("labeled", "factory:model:a", "09:00", "reader"), ev("labeled", "factory:model:a", "10:00", "dev"), ev("labeled", "factory:objective", "11:00"), ev("unlabeled", "factory:harness:codex", "10:30"), { event: "renamed", created_at: "2026-11-14T08:00:00Z" }];
  const by = await withTimeline(events, () => labelersOf(repo, 7, ["factory:model:a", "factory:harness:codex"], { token: "t" }));
  assert.deepEqual(Object.keys(by), ["factory:model:a"]);
  assert.deepEqual([by["factory:model:a"].at, by["factory:model:a"].actor.login], ["2026-11-14T10:00:00Z", "dev"], "the latest application");
  assert.equal(await withTimeline(events, () => issueTextChangedAt(repo, 7, { token: "t" }, (n) => n.startsWith("factory:harness:") || n.startsWith("factory:model:"))), "2026-11-14T10:30:00Z", "a choice label's removal counts; factory:objective does not");
  assert.equal(await withTimeline(events, () => issueTextChangedAt(repo, 7, { token: "t" })), "2026-11-14T08:00:00Z", "with no label predicate, the rename alone");
});

test("the Action installs the harness the label names: read before the install, the stage told what was installed", async () => {
  const issue = (labels) => async (_, n) => (assert.equal(n, 12), { labels: labels.map((name) => ({ name })) });
  assert.equal(await labelHarness({ repo, issue: 12, read: { issue: issue(["factory:objective", "factory:harness:copilot"]) } }), "copilot");
  assert.equal(await labelHarness({ repo, branch: "factory/12", read: { issue: issue(["factory:harness:codex"]) } }), "codex", "a review job finds its issue from its PR's branch, with no PR read");
  assert.equal(await labelHarness({ repo, issue: 12, read: { issue: issue(["factory:harness:codex", "factory:harness:claude"]) } }), "", "two: the default, and the stage Blocks");
  assert.equal(await labelHarness({ repo, issue: 12, read: { issue: issue(["factory:objective"]) } }), "");
  assert.equal(await labelHarness({ repo, branch: "feature/x", read: { issue: async () => assert.fail("no Factory branch: nothing read") } }), "");
  const steps = parseYaml(readFileSync(join(ROOT, "action.yml"), "utf8")).runs.steps;
  const at = (id) => steps.findIndex((s) => s.id === id);
  assert.ok(at("choice") >= 0 && at("choice") < at("install") && at("install") < at("run"), "the label is read before the install, the install before the run");
  assert.match(steps[at("choice")].if, /inputs\.mode == 'work' \|\| inputs\.mode == 'review'/);
  assert.equal(steps[at("install")].env.FACTORY_CHOSEN_HARNESS, "${{ steps.choice.outputs.harness }}");
  assert.match(steps[at("install")].run, /DEFAULT_HARNESS="\$\{FACTORY_INPUT_HARNESS:-\$\{FACTORY_HARNESS:-claude\}\}"\n\s*HARNESS="\$\{FACTORY_CHOSEN_HARNESS:-\$DEFAULT_HARNESS\}"/, "the label, then with:, then the env block");
  assert.match(steps[at("choice")].run, /--branch "\$\{GITHUB_HEAD_REF:-none\}"/, "the review job's branch from its event");
  assert.doesNotMatch(readFileSync(join(ROOT, "plugin", "scripts", "objective-harness.mjs"), "utf8"), /pulls\//, "no pull request read: the job token may not have pull-requests access");
  assert.match(steps[at("install")].run, /echo "harness=\$HARNESS" >> "\$GITHUB_OUTPUT"/);
  assert.equal(steps[at("run")].env.FACTORY_STAGE_HARNESS, "${{ steps.install.outputs.harness }}");
});

test("the launcher hands the stage the chosen harness's credential alone and names it as prepared, the repository's defaults kept, and Blocks first without one", () => {
  const defaults = chosenInputs({ env: ENV }).inputs;
  const inputs = { ...chosenInputs({ env: ENV, choice: { harness: "copilot" } }).inputs, anthropicApiKey: "an", copilotGithubToken: "cp", codexApiKey: "cx" };
  const out = stageEnvironment({ inputs, defaults, env: ENV, stage: "work", issue: 7, claim: "c", tokens: { write: "w" } });
  assert.deepEqual([out.FACTORY_HARNESS, out.FACTORY_MODEL, out.FACTORY_STAGE_HARNESS, out.FACTORY_INPUT_COPILOT_GITHUB_TOKEN], ["claude", "claude-opus-5-5", "copilot", "cp"], "the defaults as the workflow sets them; the labels' harness only as prepared");
  for (const k of ["FACTORY_INPUT_ANTHROPIC_API_KEY", "FACTORY_INPUT_CODEX_API_KEY"]) assert.equal(k in out, false, k);
  assert.equal(missingCredential(inputs), null);
  const none = missingCredential({ harness: "codex", anthropicApiKey: "an" });
  assert.match(none.reason, /no codex credential reached the launch job/);
  assert.match(none.fix, /FACTORY_CODEX_GATEWAY_KEY or CODEX_API_KEY/);
});

test("a label removed between the launcher's read and the stage's is seen by the stage: it runs on the defaults, or Blocks when its harness was the label's", () => {
  const defaults = chosenInputs({ env: ENV }).inputs;
  const stageOf = (choice) => stageEnvironment({ inputs: { ...chosenInputs({ env: ENV, choice }).inputs, anthropicApiKey: "an", codexApiKey: "cx" }, defaults, env: ENV, stage: "work", issue: 7, claim: "c", tokens: { write: "w" } });
  // The launcher read `factory:model:claude-sonnet-5-5`; the stage reads no label: the repository's model, labels none.
  const modelEnv = stageOf({ model: "claude-sonnet-5-5" });
  const now = chosenInputs({ env: modelEnv, choice: {} });
  assert.deepEqual([now.inputs.harness, now.inputs.model, routeProblem(modelEnv.FACTORY_STAGE_HARNESS, now.inputs.harness)], ["claude", "claude-opus-5-5", null]);
  // The launcher read `factory:harness:codex`; the stage reads no label: prepared for codex, the defaults say claude.
  const harnessEnv = stageOf({ harness: "codex" });
  assert.match(routeProblem(harnessEnv.FACTORY_STAGE_HARNESS, chosenInputs({ env: harnessEnv, choice: {} }).inputs.harness).reason, /prepared for codex/);
  assert.equal(routeProblem(harnessEnv.FACTORY_STAGE_HARNESS, chosenInputs({ env: harnessEnv, choice: { harness: "codex" } }).inputs.harness), null, "the label still there: it runs");
});

test("chosenInputs: a harness label never inherits the default harness's models, from any source; their check names the harness label", () => {
  // The env block names no harness but sets a Claude model: the default harness is Claude, and Codex takes its own models.
  const env = { GITHUB_REPOSITORY: "acme/app", FACTORY_MODEL: "claude-opus-5-5", FACTORY_INPUT_REVIEWER_MODEL: "claude-fable-5-2", FACTORY_EFFORT: "high" };
  const codex = chosenInputs({ env, choice: { harness: "codex" } });
  assert.deepEqual([codex.ok, codex.inputs.model, codex.inputs.reviewerModel, codex.inputs.effort], [true, "gpt-6.1-sol", "gpt-6.1-sol", ""]);
  assert.equal(chosenInputs({ env, choice: { harness: "claude" } }).inputs.model, "claude-opus-5-5", "the default harness keeps the repository's models");
  assert.equal(chosenInputs({ env, choice: { harness: "codex", model: "gpt-6.1-terra" } }).inputs.model, "gpt-6.1-terra");
});

test("the gateway key the launcher holds counts though its environment no longer has it", async () => {
  const gh = { issue: async () => ({ labels: [{ name: "factory:harness:codex" }, { name: "factory:model:openai/gpt-6.1-sol" }] }), ...timeline({ "factory:harness:codex": person("dev"), "factory:model:openai/gpt-6.1-sol": person("dev") }) };
  assert.equal((await objectiveInputs({ repo, issue: 7, env: ENV, opts: {}, gh })).ok, false, "without it: refused");
  assert.equal((await objectiveInputs({ repo, issue: 7, env: ENV, opts: {}, gh, gateway: true })).ok, true);
  const src = readFileSync(join(ROOT, "plugin", "scripts", "launch.mjs"), "utf8");
  assert.match(src, /objectiveInputs\(\{[^)]*gateway: !!inputs\.codexGatewayKey/, "the launcher passes its own");
});

test("the harness CLI version pin is for the repository's harness only", () => {
  assert.equal(harnessVersionFor("claude", "claude", "2.1.140"), "2.1.140");
  assert.equal(harnessVersionFor("codex", "claude", "2.1.140"), "latest", "a label's harness: its latest, never Claude Code's pin");
  assert.equal(harnessVersionFor("claude", "claude", ""), "latest");
  const steps = parseYaml(readFileSync(join(ROOT, "action.yml"), "utf8")).runs.steps;
  const install = steps.find((s) => s.id === "install").run;
  assert.match(install, /if \[ -n "\$FACTORY_CHOSEN_HARNESS" \] && \[ "\$FACTORY_CHOSEN_HARNESS" != "\$DEFAULT_HARNESS" \]; then VERSION=latest; fi/, "the Action likewise");
});

test("what ran is recorded: the progress comment's harness line and doctor's defaults line", () => {
  const ran = ranWith(chosenInputs({ env: ENV, choice: { model: "claude-sonnet-5-5" } }).inputs, ["factory:model:claude-sonnet-5-5", "factory:objective"]);
  const line = harnessMarker("claude", "claude-sonnet-5-5", ran);
  assert.deepEqual(JSON.parse(/^<!-- factory:harness (.*) -->$/.exec(line)[1]), { harness: "claude", model: "claude-sonnet-5-5", models: { worker: "claude-sonnet-5-5", subagent: "claude-sonnet-5-5", reviewer: "claude-fable-5-2" }, labels: ["factory:model:claude-sonnet-5-5"] });
  assert.equal(harnessMarker("codex", "gpt-6.1-sol"), '<!-- factory:harness {"harness":"codex","model":"gpt-6.1-sol"} -->', "without `ran`, the line as before");
  const d = defaultsCheck(resolveInputs({ env: ENV }));
  assert.equal(d.status, "PASS");
  assert.match(d.detail, /^harness claude, worker claude-opus-5-5, sub-agents claude-sonnet-5-5, reviewer claude-fable-5-2: the repository's defaults; an Objective overrides any of them/);
  for (const p of Object.values(CHOICE_PREFIXES)) assert.ok(d.detail.includes(p), p);
});

test("the work and review stages: the choice after the trust and plan checks, then doctor for that harness, all before any harness", () => {
  for (const file of ["worker.mjs", "review.mjs"]) {
    const src = readFileSync(join(ROOT, "plugin", "scripts", file), "utf8");
    const run = src.indexOf("async function run()");
    const at = (s) => src.indexOf(s, run);
    assert.ok(at("await authorGate(") < at("await planGate(") && at("await planGate(") < at("await choiceGate("), file);
    assert.match(src.slice(at("await choiceGate("), at("await choiceGate(") + 700), /if \(!chosen\.ok\) \{\n\s+log\(chosen\.reason\);\n\s+await finish\("blocked", chosen\.reason\);\n\s+return;\n\s+\}\n\s+Object\.assign\(inputs, chosen\.inputs\);/, `${file} stops on a refusal, else runs on the choice`);
    for (const later of ["jobChecks(", "installPlugin(", "credentialEnv(", "openHandoff(", "runHarness(", "validationLoop("]) {
      const i = at(later);
      assert.ok(i === -1 || i > at("await choiceGate("), `${file}: ${later} only after the choice`);
    }
  }
});

test("local mode: a harness this machine cannot run Blocks before the stage's sandbox is set up; one it can is set up for that harness", async () => {
  const { Local, harnessProblems } = await import("../scripts/local.mjs");
  const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { pinGitDir, gitPinFile } = await import("../scripts/lib/local.mjs");
  const dev = mkdtempSync(join(tmpdir(), "choice-"));
  const local = Object.assign(Object.create(Local.prototype), { dev, harness: "claude", stopping: false, firstSetup: new Map(), children: new Set() });
  mkdirSync(join(local.ws(8), "repo", ".git"), { recursive: true });
  pinGitDir(join(local.ws(8), "repo"), gitPinFile(local.ws(8)));
  const blocked = [];
  local.block = async (...a) => blocked.push(a);
  const setUp = [];
  local.stageEnv = (...a) => {
    setUp.push(a[5]);
    throw Object.assign(new Error("stop here"), { code: "outer-sandbox" });
  };
  try {
    local.harnessFor = async () => ({ ok: false, reason: "local mode on this machine cannot run copilot, which this Objective's `factory:harness:copilot` label asks for: copilot is not on PATH", fix: "Set that harness up" });
    const r = await local.stage(8, "work", "worker.mjs", []);
    assert.equal(r.exit, "blocked");
    assert.deepEqual(blocked, [[8, "work", "local mode on this machine cannot run copilot, which this Objective's `factory:harness:copilot` label asks for: copilot is not on PATH", { fix: "Set that harness up" }]]);
    assert.deepEqual(setUp, [], "nothing set up for it");
    local.harnessFor = async () => ({ ok: true, harness: "codex" });
    await local.stage(8, "work", "worker.mjs", []);
    assert.deepEqual(setUp, ["codex"], "the stage's sandbox is set up for the Objective's harness, not the loop's");
  } finally {
    rmSync(dev, { recursive: true, force: true });
  }
  // What it checks for another harness: its CLI on PATH (and for Copilot its token and sandbox tools).
  const path = process.env.PATH;
  process.env.PATH = dev;
  try {
    assert.deepEqual(harnessProblems("codex", ""), ["codex is not on PATH"]);
    assert.ok(harnessProblems("copilot", "").some((p) => /no Copilot token/.test(p)));
    assert.deepEqual(harnessProblems("gemini", ""), ["unknown harness gemini"]);
    const loop = Object.assign(Object.create(Local.prototype), { dev, harness: "claude" });
    assert.deepEqual(loop.harnessReady("claude"), [], "the loop's own harness passed at its start");
    assert.deepEqual(loop.harnessReady("codex"), ["codex is not on PATH"]);
  } finally {
    process.env.PATH = path;
  }
});

test("the usage record names the models the stage ran on and the labels that chose them", async () => {
  const { writeUsage } = await import("../scripts/lib/session.mjs");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "ran-"));
  const inputs = chosenInputs({ env: ENV, choice: { harness: "codex", model: "gpt-6.1-terra" } }).inputs;
  const r = writeUsage(dir, { harness: inputs.harness, model: inputs.model, records: [], passes: 0, exit: "blocked", reason: "x", credentialBasis: null, ran: ranWith(inputs, ["factory:harness:codex", "factory:model:gpt-6.1-terra"]) });
  const stored = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
  assert.deepEqual(stored.ran, { worker: "gpt-6.1-terra", subagent: "gpt-6.1-sol", reviewer: "gpt-6.1-sol", labels: ["factory:harness:codex", "factory:model:gpt-6.1-terra"] });
  assert.deepEqual(r.ran, stored.ran);
});

test("local mode, the real path: stageEnv sets the stage up for the harness it is given, the loop's own without one; a Copilot Objective on a Claude loop gets Copilot's home and token", async () => {
  const { Local } = await import("../scripts/local.mjs");
  const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { pinGitDir, gitPinFile } = await import("../scripts/lib/local.mjs");
  const dev = mkdtempSync(join(tmpdir(), "real-"));
  const local = Object.assign(Object.create(Local.prototype), { dev, harness: "claude", repoFull: "o/r", wf: {}, stopping: false, firstSetup: new Map(), children: new Set() });
  const clone = join(local.ws(8), "repo");
  mkdirSync(join(clone, ".git"), { recursive: true });
  pinGitDir(clone, gitPinFile(local.ws(8)));
  const usage = join(local.ws(8), "usage-work-1");
  mkdirSync(usage, { recursive: true });
  const stageTmp = mkdtempSync(join(tmpdir(), "stage-"));
  const token = process.env.COPILOT_GITHUB_TOKEN;
  process.env.COPILOT_GITHUB_TOKEN = "copilot-test-token";
  try {
    const given = local.stageEnv(8, usage, clone, stageTmp, "worker.mjs", "claude");
    assert.deepEqual([given.FACTORY_STAGE_HARNESS, given.FACTORY_HARNESS], ["claude", "claude"]);
    assert.equal(local.stageEnv(8, usage, clone, stageTmp, "worker.mjs").FACTORY_STAGE_HARNESS, "claude", "no sixth argument: the loop's harness");
    // Copilot's own part of the stage env, for a Copilot-labelled Objective on this Claude loop (stageEnv adds it, with Copilot's outer sandbox, which only some hosts start).
    const extra = local.harnessEnv(8, [stageTmp], clone, usage, null, "copilot");
    assert.equal(extra.COPILOT_HOME, join(local.ws(8), ".sandbox", "copilot-home"));
    assert.equal(extra.COPILOT_GITHUB_TOKEN, "copilot-test-token", "the token the loop reads for Copilot, though its own harness is Claude");
    assert.deepEqual(local.harnessEnv(8, [stageTmp], clone, usage, null), {}, "the loop's own Claude: nothing of Copilot's");
  } finally {
    if (token === undefined) delete process.env.COPILOT_GITHUB_TOKEN;
    else process.env.COPILOT_GITHUB_TOKEN = token;
    rmSync(dev, { recursive: true, force: true });
    rmSync(stageTmp, { recursive: true, force: true });
  }
});

test("local mode, the real path: harnessFor reads the issue's labels and their appliers from GitHub, and refuses a stranger's label", async () => {
  const { Local } = await import("../scripts/local.mjs");
  const loop = Object.assign(Object.create(Local.prototype), { dev: "/nonexistent", harness: "claude", repoFull: "acme/app", repo, wf: {}, opts: { token: "t" } });
  const labels = ["factory:objective", "factory:model:claude-sonnet-5-5"];
  const real = globalThis.fetch;
  const run = async (applier) => {
    globalThis.fetch = async (url) => {
      const u = String(url);
      const json = (v) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
      if (/\/user$/.test(u)) return json({ login: "me", type: "User" });
      if (/\/collaborators\?/.test(u)) return json([{ login: "dev" }]);
      if (/\/collaborators\/[^/]+\/permission$/.test(u)) return json({ permission: /\/dev\//.test(u) ? "write" : "read" });
      if (/\/issues\/8\/timeline/.test(u)) return json([{ event: "labeled", label: { name: labels[1] }, created_at: "2026-11-14T10:00:00Z", actor: { login: applier, id: 5, type: "User" } }]);
      if (/\/issues\/8$/.test(u)) return json({ number: 8, labels: labels.map((name) => ({ name })) });
      throw new Error(`unexpected ${u}`);
    };
    try {
      return await loop.harnessFor(8);
    } finally {
      globalThis.fetch = real;
    }
  };
  assert.deepEqual(await run("dev"), { ok: true, harness: "claude" });
  const refused = await run("reader");
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /`factory:model:claude-sonnet-5-5` was applied by `reader`/);
});

test("the review job checks the chosen harness's credential and Blocks with its fix before anything is set up, never a crash", async () => {
  const src = readFileSync(join(ROOT, "plugin", "scripts", "review.mjs"), "utf8");
  const run = src.indexOf("async function run()");
  const at = (x) => src.indexOf(x, run);
  const check = at("await credentialChecks({ inputs })");
  assert.ok(check > at("Object.assign(inputs, chosen.inputs)"), "for the chosen harness");
  for (const later of ["openOutbox(", "installPlugin(", "credentialEnv("]) assert.ok(at(later) > check, later);
  assert.match(src.slice(check, check + 700), /status === "FAIL"[\s\S]*exit: "blocked", reason, cause: "setup"[\s\S]*await finish\("blocked", reason\);\n\s+return;/);
  const { credentialChecks } = await import("../scripts/doctor.mjs");
  const fails = (await credentialChecks({ inputs: { ...resolveInputs({ env: { GITHUB_REPOSITORY: "acme/app" } }), ...chosenInputs({ env: ENV, choice: { harness: "codex" } }).inputs, codexApiKey: "", codexGatewayKey: "" }, env: { GITHUB_ACTIONS: "true" } })).filter((c) => c.status === "FAIL");
  assert.match(fails[0]?.fix ?? "", /gh secret set FACTORY_CODEX_GATEWAY_KEY/, "the fix names the secret");
});

test("chosenInputs: a label naming the workflow's own harness on a manual run that overrode it keeps the workflow's models, not the run's", () => {
  const env = { ...ENV, FACTORY_MODEL: "claude-sonnet-5-5", FACTORY_INPUT_HARNESS: "codex", FACTORY_INPUT_REVIEWER_MODEL: "gpt-6.1-terra" };
  const r = chosenInputs({ env, choice: { harness: "claude" } });
  assert.deepEqual([r.ok, r.inputs.harness, r.inputs.model, r.inputs.reviewerModel], [true, "claude", "claude-sonnet-5-5", "claude-fable-5-2"], "the env block's Claude models; the run's Codex reviewer model gone");
  assert.equal(chosenInputs({ env, choice: { harness: "copilot" } }).inputs.model, "", "another harness again: its own defaults");
});

test("the launcher takes the repository's defaults once, before any start applies an Objective's labels, and records the stage's harness", () => {
  const src = readFileSync(join(ROOT, "plugin", "scripts", "launch.mjs"), "utf8");
  assert.match(src, /const run = \{ inputs, defaults: Object\.fromEntries\(CHOSEN_FIELDS\.map\(\(k\) => \[k, inputs\[k\]\]\)\),/, "taken with the run");
  assert.doesNotMatch(src, /run\.defaults =/, "never again from `inputs`, which a start has changed");
  assert.match(src, /Object\.assign\(inputs, run\.defaults, chosen\.inputs\)/);
  assert.match(src, /const base = \{ vendor: inputs\.sandbox, stage, harness: inputs\.harness,/, "the stage's harness on its record");
});
