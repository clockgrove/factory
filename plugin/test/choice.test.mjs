// An Objective's harness and models (#224): labels on its issue override the repository's defaults for it alone.
import "./temp.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { choiceLabels, choiceOf, chosenInputs, ranWith, routeProblem } from "../scripts/lib/choice.mjs";
import { resolveInputs } from "../scripts/lib/inputs.mjs";
import { pendulumBuild } from "../scripts/lib/release.mjs";
import { CHOICE_FIX, choiceTrusted, objectiveSha, planTextState } from "../scripts/lib/objective-trust.mjs";
import { setMaintainers } from "../scripts/lib/logic.mjs";
import { missingCredential, stageEnvironment } from "../scripts/launch.mjs";

/** The Pendulum build a stage of this checkout records (#565 W6): its release at its tag, else with its commit. */
const PENDULUM_VERSION = pendulumBuild();

const repo = { owner: "acme", name: "app", full: "acme/app" };
const ENV = { GITHUB_REPOSITORY: "acme/app", PENDULUM_HARNESS: "claude", PENDULUM_MODEL: "claude-opus-5-5", PENDULUM_SUBAGENT_MODEL: "claude-sonnet-5-5", PENDULUM_REVIEWER_MODEL: "claude-fable-5-2" };
const pick = (r) => ({ harness: r.harness, model: r.model, subagentModel: r.subagentModel, reviewerModel: r.reviewerModel });

test("choice labels: one of each kind sets that input; none is the repository's defaults; other labels are not choices", () => {
  assert.deepEqual(choiceOf(["pendulum:objective", "P1"]), { ok: true, choice: {}, labels: [] });
  const c = choiceOf([{ name: "pendulum:objective" }, { name: "pendulum:harness:Codex" }, { name: "pendulum:model:gpt-6.1-terra" }, { name: "pendulum:subagent-model:gpt-6-luna" }, { name: "pendulum:reviewer-model:gpt-6.1-sol" }]);
  assert.equal(c.ok, true);
  assert.deepEqual(c.choice, { harness: "codex", model: "gpt-6.1-terra", subagent_model: "gpt-6-luna", reviewer_model: "gpt-6.1-sol" });
  assert.deepEqual(c.labels, ["pendulum:harness:Codex", "pendulum:model:gpt-6.1-terra", "pendulum:reviewer-model:gpt-6.1-sol", "pendulum:subagent-model:gpt-6-luna"], "sorted: the set the plan's record covers");
  assert.deepEqual(choiceLabels(["pendulum:objective", "pendulum:restart", "pendulum:model:x"]), ["pendulum:model:x"]);
});

test("chosenInputs: no label is the defaults; a harness label takes that harness's defaults; a model label overrides only its own input", () => {
  assert.deepEqual(pick(chosenInputs({ env: ENV }).inputs), pick(resolveInputs({ env: ENV })), "an issue with no label runs on the defaults, as today");
  const codex = chosenInputs({ env: { ...ENV, PENDULUM_EFFORT: "high" }, choice: { harness: "codex" } }).inputs;
  assert.deepEqual(pick(codex), { harness: "codex", model: "gpt-6.1-sol", subagentModel: "gpt-6.1-sol", reviewerModel: "gpt-6.1-sol" });
  assert.equal(codex.effort, "", "the env block's effort is its own harness's");
  assert.equal(codex.reviewerEffort, "high", "Codex's own reviewer effort");
  const sonnet = chosenInputs({ env: ENV, choice: { model: "claude-sonnet-5-5" } }).inputs;
  assert.deepEqual(pick(sonnet), { harness: "claude", model: "claude-sonnet-5-5", subagentModel: "claude-sonnet-5-5", reviewerModel: "claude-fable-5-2" });
  // Two Objectives at once on one repository, on two worker models and one on another harness: no workflow edit.
  const runs = [{}, { model: "claude-haiku-5-5" }, { harness: "copilot" }].map((choice) => chosenInputs({ env: ENV, choice }).inputs);
  assert.deepEqual(runs.map((r) => `${r.harness}/${r.model}`), ["claude/claude-opus-5-5", "claude/claude-haiku-5-5", "copilot/"]);
  // The manual run's harness input is the run's default; the issue's label wins over it.
  assert.equal(chosenInputs({ env: { ...ENV, PENDULUM_INPUT_HARNESS: "copilot" }, choice: { harness: "codex" } }).inputs.harness, "codex");
  assert.equal(chosenInputs({ env: { ...ENV, PENDULUM_INPUT_HARNESS: "copilot" } }).inputs.harness, "copilot");
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
  const labels = ["pendulum:objective", "pendulum:model:claude-sonnet-5-5"];
  const ok = await choiceTrusted(repo, 7, labels, {}, timeline({ "pendulum:model:claude-sonnet-5-5": person("dev") }));
  assert.deepEqual([ok.ok, ok.choice], [true, { model: "claude-sonnet-5-5" }]);
  const stranger = await choiceTrusted(repo, 7, labels, {}, timeline({ "pendulum:model:claude-sonnet-5-5": person("reader") }));
  assert.equal(stranger.ok, false);
  assert.match(stranger.reason, /^`pendulum:model:claude-sonnet-5-5` was applied by `reader`, who cannot push to acme\/app and is not a pinned maintainer/);
  assert.equal(stranger.fix, CHOICE_FIX);
  assert.equal((await choiceTrusted(repo, 7, labels, {}, timeline({ "pendulum:model:claude-sonnet-5-5": { login: "kirk", id: 2, type: "Bot" } }))).ok, false, "an App never vouches, whatever its login");
  assert.match((await choiceTrusted(repo, 7, labels, {}, timeline({}))).reason, /who applied `pendulum:model:claude-sonnet-5-5` could not be read/);
  setMaintainers("acme/app", ["boss#42"]);
  try {
    assert.equal((await choiceTrusted(repo, 7, labels, {}, timeline({ "pendulum:model:claude-sonnet-5-5": person("boss", 42) }))).ok, true, "a pinned maintainer by id");
  } finally {
    setMaintainers("other/repo", []);
  }
  const none = await choiceTrusted(repo, 7, ["pendulum:objective"], {}, { labelers: async () => assert.fail("no choice label: no timeline read") });
  assert.deepEqual(none, { ok: true, choice: {}, labels: [], hosts: [], foundation: false });
  assert.equal((await choiceTrusted(repo, 7, ["pendulum:model:a", "pendulum:model:b"], {}, { labelers: async () => assert.fail("refused on the names first") })).ok, false);
});

test("the plan's record covers the harness and model labels: one added, removed or changed after the plan is an edit", () => {
  const plain = objectiveSha("Objective", "Build the thing.");
  assert.equal(objectiveSha("Objective", "Build the thing.", ["pendulum:objective", "P1"]), plain, "other labels change nothing, so a plan made before these labels keeps its record");
  const sonnet = objectiveSha("Objective", "Build the thing.", ["pendulum:model:claude-sonnet-5-5"]);
  assert.notEqual(sonnet, plain);
  assert.notEqual(objectiveSha("Objective", "Build the thing.", ["pendulum:model:claude-opus-5-5"]), sonnet);
  assert.equal(objectiveSha("Objective", "Build the thing.", ["pendulum:harness:claude", "pendulum:model:x"]), objectiveSha("Objective", "Build the thing.", ["pendulum:model:x", "pendulum:harness:claude"]), "order does not matter");
  const plan = { at: "2026-11-14T10:00:00Z", record: { sha256: plain, label: "2026-11-14T09:00:00Z" } };
  assert.equal(planTextState({ sha: sonnet, plan, labeledAt: "2026-11-14T09:00:00Z" }), "changed");
  assert.equal(planTextState({ sha: sonnet, plan, labeledAt: "2026-11-14T11:00:00Z", work: true }), "replan", "started again after the change: planned again on the new choice");
});

test("the launcher hands the stage the chosen harness's credential alone and names it as prepared, the repository's defaults kept, and Blocks first without one", () => {
  const defaults = chosenInputs({ env: ENV }).inputs;
  const inputs = { ...chosenInputs({ env: ENV, choice: { harness: "copilot" } }).inputs, anthropicApiKey: "an", copilotGithubToken: "cp", codexApiKey: "cx" };
  const out = stageEnvironment({ inputs, defaults, env: ENV, stage: "work", issue: 7, claim: "c", tokens: { write: "w" } });
  assert.deepEqual([out.PENDULUM_HARNESS, out.PENDULUM_MODEL, out.PENDULUM_STAGE_HARNESS, out.PENDULUM_INPUT_COPILOT_GITHUB_TOKEN], ["claude", "claude-opus-5-5", "copilot", "cp"], "the defaults as the workflow sets them; the labels' harness only as prepared");
  for (const k of ["PENDULUM_INPUT_ANTHROPIC_API_KEY", "PENDULUM_INPUT_CODEX_API_KEY"]) assert.equal(k in out, false, k);
  assert.equal(missingCredential(inputs), null);
  const none = missingCredential({ harness: "codex", anthropicApiKey: "an" });
  assert.match(none.reason, /no codex credential reached the launch job/);
  assert.match(none.fix, /PENDULUM_CODEX_GATEWAY_KEY or CODEX_API_KEY/);
});

test("the usage record names the models the stage ran on and the labels that chose them", async () => {
  const { writeUsage } = await import("../scripts/lib/session.mjs");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "ran-"));
  const inputs = chosenInputs({ env: ENV, choice: { harness: "codex", model: "gpt-6.1-terra" } }).inputs;
  const r = writeUsage(dir, { harness: inputs.harness, model: inputs.model, records: [], passes: 0, exit: "blocked", reason: "x", credentialBasis: null, ran: ranWith(inputs, ["pendulum:harness:codex", "pendulum:model:gpt-6.1-terra"]) });
  const stored = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
  assert.deepEqual(stored.ran, { worker: "gpt-6.1-terra", subagent: "gpt-6.1-sol", reviewer: "gpt-6.1-sol", labels: ["pendulum:harness:codex", "pendulum:model:gpt-6.1-terra"], hosts: [], effort: null, reviewerEffort: "high", pendulum: PENDULUM_VERSION });
  assert.deepEqual(r.ran, stored.ran);
});

test("local mode, the real path: harnessFor reads the issue's labels and their appliers from GitHub, and refuses a stranger's label", async () => {
  const { Local } = await import("../scripts/local.mjs");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const loop = Object.assign(Object.create(Local.prototype), { dev: "/nonexistent", harness: "claude", repoFull: "acme/app", repo, wf: {}, opts: { token: "t" } });
  const labels = ["pendulum:objective", "pendulum:model:claude-sonnet-5-5"];
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
    // A home of its own: harnessFor reads this machine's account declaration (lib/accounts.mjs), none here.
    const home = process.env.HOME;
    process.env.HOME = mkdtempSync(join(tmpdir(), "choice-home-"));
    try {
      return await loop.harnessFor(8);
    } finally {
      process.env.HOME = home;
      globalThis.fetch = real;
    }
  };
  assert.deepEqual(await run("dev"), { ok: true, harness: "claude", hosts: [], account: { name: "claude", harness: "claude", declared: false } }, "nothing declared here: the account named after the harness");
  const refused = await run("reader");
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /`pendulum:model:claude-sonnet-5-5` was applied by `reader`/);
});

