// An Objective's own network hosts (#278): a `pendulum:host:<host>` label a person who can push applied opens that host to
// that Objective's sandboxes alone, on every route; the plan's record covers it, and the progress comment and doctor
// name it.
import "./temp.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HOST_PREFIX, LABEL_MAX, choiceLabels, choiceOf, hostsOf } from "../scripts/lib/choice.mjs";
import { CHOICE_FIX, EDITED_REASON, choiceGate, choiceTrusted, editedSincePlan, objectiveInputs, objectiveSha, planTextState } from "../scripts/lib/objective-trust.mjs";
import { claudeRunner, codexRunner, copilotRunner, harnessCommand } from "../scripts/lib/harness.mjs";
import { LOCAL_DOMAINS, gitPinFile, isSandboxHost, suffixRuleUnder, openStageHosts, openedStageHosts, pinGitDir, runnerDomains } from "../scripts/lib/local.mjs";
import { BACKENDS } from "../scripts/lib/backend.mjs";
import { setSelf } from "../scripts/lib/logic.mjs";

const repo = { owner: "acme", name: "app", full: "acme/app" };
const ENV = { GITHUB_REPOSITORY: "acme/app", PENDULUM_HARNESS: "claude", PENDULUM_MODEL: "claude-opus-5-5", PENDULUM_SUBAGENT_MODEL: "claude-sonnet-5-5", PENDULUM_REVIEWER_MODEL: "claude-fable-5-2" };
const AGENT = { user: "pendulum-agent", uid: 1002, home: "/home/pendulum-agent", tmp: "/home/pendulum-agent/tmp", allow: new Set() };
const CLONE = "/home/pendulum-agent/repo";
const HF = "pendulum:host:huggingface.co";

const person = (login, id = 1) => ({ login, id, type: "User" });
const perms = { kirk: "admin", dev: "write", reader: "read", triager: "triage" };
const timeline = (by) => ({ labelers: async (_, n, names) => (assert.equal(n, 7), Object.fromEntries(names.filter((l) => by[l]).map((l) => [l, { at: "2026-11-14T10:00:00Z", actor: by[l] }]))), permission: async (_, login) => perms[login] ?? null });

test("host labels: each names one host a sandbox enforces as written, lower case, once; other labels open nothing", () => {
  assert.deepEqual(hostsOf(["pendulum:objective", "pendulum:model:x"]), { ok: true, hosts: [], labels: [] });
  const h = hostsOf([{ name: "pendulum:objective" }, { name: "pendulum:host:HuggingFace.co" }, { name: "pendulum:host:*.hf.co" }, { name: "pendulum:host:huggingface.co" }]);
  assert.deepEqual(h, { ok: true, hosts: ["*.hf.co", "huggingface.co"], labels: ["pendulum:host:*.hf.co", "pendulum:host:HuggingFace.co", "pendulum:host:huggingface.co"] });
  for (const bad of ["1.2.3.4", "localhost", "api.localhost", "example.com:443", "https://example.com", "example.com/path", "*.com", "*example.com", "a.*.example.com", "", "*", "[::1]", "ex ample.com"]) {
    const r = hostsOf([`${HOST_PREFIX}${bad}`]);
    assert.equal(r.ok, false, bad);
    assert.match(r.reason, /names no host Pendulum's sandboxes can allow/, bad);
    assert.match(r.fix, /`pendulum:host:example\.com`/);
  }
  assert.equal(LABEL_MAX - HOST_PREFIX.length, 36, "the room USAGE.md states");
  // A host label is no harness or model choice: the harness label still reads, whatever host labels sit beside it.
  assert.deepEqual(choiceOf(["pendulum:harness:codex", HF, "pendulum:host:1.2.3.4"]).choice, { harness: "codex" });
  assert.deepEqual(choiceLabels(["pendulum:objective", HF, "pendulum:model:m"]), ["pendulum:host:huggingface.co", "pendulum:model:m"], "the set the plan's record and the trust check cover");
});

test("host labels: a wildcard over a public suffix, or over a name with one below it (the Public Suffix List, private section included), is refused; one over an organisation's name opens", () => {
  for (const suffix of ["co.uk", "github.io", "vercel.app", "s3.amazonaws.com", "pages.dev"]) {
    const r = hostsOf([`${HOST_PREFIX}*.${suffix}`]);
    assert.equal(r.ok, false, suffix);
    assert.ok(r.reason.includes(`opens every site under \`${suffix}\`, and the Public Suffix List names \`${suffix}\` there a public suffix`), `${suffix}: ${r.reason}`);
    assert.equal(isSandboxHost(`*.${suffix}`), false, "the runner's own filter drops it too");
  }
  // A wildcard over a parent of public suffixes covers anyone's bucket or storage account under them.
  for (const parent of ["amazonaws.com", "windows.net", "core.windows.net"]) {
    const r = hostsOf([`${HOST_PREFIX}*.${parent}`]);
    assert.equal(r.ok, false, parent);
    const rule = suffixRuleUnder(parent);
    assert.ok(typeof rule === "string" && rule.endsWith(`.${parent}`), `the rule it names lies below ${parent}: ${rule}`);
    assert.ok(r.reason.includes(`opens every site under \`${parent}\`, and the Public Suffix List names \`${rule}\` there`), `${parent}: ${r.reason}`);
    assert.equal(isSandboxHost(`*.${parent}`), false, parent);
  }
  // One organisation's name under such a suffix, or the suffix's own host, is a host like any other; so is a name an
  // exception rule takes back out of a wildcard rule (`!city.kawasaki.jp` out of `*.kawasaki.jp`), and one under a
  // top-level name the list does not hold.
  for (const ok of ["*.clockgrove.github.io", "*.example.co.uk", "*.hf.co", "github.io", "*.mybucket.s3.amazonaws.com", "*.city.kawasaki.jp", "*.build.internal"]) assert.deepEqual(hostsOf([`${HOST_PREFIX}${ok}`]).hosts, [ok], ok);
  // A wildcard over a top-level name alone is no host entry at all.
  for (const tld of ["*.com", "*.internal"]) assert.match(hostsOf([`${HOST_PREFIX}${tld}`]).reason, /names no host Pendulum's sandboxes can allow/, tld);
});

test("a host label counts only when the person who last applied it can push or is a pinned maintainer; a bad name is refused before any read", async () => {
  const labels = ["pendulum:objective", HF];
  const ok = await choiceTrusted(repo, 7, labels, {}, timeline({ [HF]: person("dev") }));
  assert.deepEqual([ok.ok, ok.hosts, ok.labels, ok.choice], [true, ["huggingface.co"], [HF], {}]);
  for (const who of ["reader", "triager"]) {
    const no = await choiceTrusted(repo, 7, labels, {}, timeline({ [HF]: person(who) }));
    assert.equal(no.ok, false, who);
    assert.match(no.reason, new RegExp(`^\`pendulum:host:huggingface\\.co\` was applied by \`${who}\`, who cannot push`));
    assert.equal(no.fix, CHOICE_FIX);
  }
  assert.equal((await choiceTrusted(repo, 7, labels, {}, timeline({ [HF]: { login: "kirk", id: 2, type: "Bot" } }))).ok, false, "an App never vouches");
  assert.match((await choiceTrusted(repo, 7, labels, {}, timeline({}))).reason, /who applied `pendulum:host:huggingface\.co` could not be read/);
  const bad = await choiceTrusted(repo, 7, ["pendulum:host:10.0.0.1"], {}, { labelers: async () => assert.fail("refused on the name first") });
  assert.equal(bad.ok, false);
  assert.deepEqual(await choiceTrusted(repo, 7, ["pendulum:objective"], {}, { labelers: async () => assert.fail("no label, no read") }), { ok: true, choice: {}, labels: [], hosts: [], foundation: false });
  const both = await objectiveInputs({ repo, issue: 7, env: ENV, opts: {}, gh: { issue: async () => ({ labels: [{ name: "pendulum:harness:codex" }, { name: HF }] }), ...timeline({ "pendulum:harness:codex": person("kirk"), [HF]: person("dev") }) } });
  assert.deepEqual([both.ok, both.inputs.harness, both.hosts], [true, "codex", ["huggingface.co"]]);
});

test("a host label added, removed or changed after the plan is an edit", async () => {
  const plain = objectiveSha("Objective", "Build the thing.");
  const hf = objectiveSha("Objective", "Build the thing.", [HF]);
  assert.notEqual(hf, plain);
  assert.notEqual(objectiveSha("Objective", "Build the thing.", ["pendulum:host:*.hf.co"]), hf);
  assert.equal(planTextState({ sha: hf, plan: { at: "2026-11-14T10:00:00Z", record: { sha256: plain, label: "2026-11-14T09:00:00Z" } }, labeledAt: "2026-11-14T09:00:00Z" }), "changed");
  assert.match(EDITED_REASON, /`pendulum:host:`/);
  setSelf("pendulum-app[bot]");
  const plan = async () => ({ at: "2026-11-14T10:00:00Z", own: true, text: "## Plan", record: { sha256: plain, label: null } });
  const read = (labels) => ({ gh: { graphql: async () => ({ repository: { issue: { title: "Objective", body: "Build the thing.", labels: { nodes: labels.map((name) => ({ name })) } } } }) }, read: plan });
  assert.equal(await editedSincePlan(repo, 7, {}, read(["pendulum:objective"])), "same");
  assert.equal(await editedSincePlan(repo, 7, {}, read(["pendulum:objective", HF])), "changed", "the merge's check sees it too");
});

test("Actions and the cloud sandbox: every harness's runner sandbox adds the opened hosts, and only once the stage opened them", () => {
  openStageHosts([]);
  const env = { PENDULUM_INPUT_ALLOWED_DOMAINS: "pypi.org" };
  const before = [claudeRunner({ harness: "claude", agent: AGENT, clone: CLONE, env, services: [] }), codexRunner({ harness: "codex", agent: AGENT, clone: CLONE, env }), copilotRunner({ harness: "copilot", agent: AGENT, clone: CLONE, env })];
  for (const r of before) assert.deepEqual(r.domains, [...LOCAL_DOMAINS, "pypi.org"], "no host label: the repository's list alone");
  try {
    openStageHosts(["huggingface.co", "*.hf.co", "127.0.0.1", "localhost"]);
    assert.deepEqual(openedStageHosts(), ["huggingface.co", "*.hf.co"], "never an address or a loopback name");
    const claude = claudeRunner({ harness: "claude", agent: AGENT, clone: CLONE, env, services: [] });
    const codex = codexRunner({ harness: "codex", agent: AGENT, clone: CLONE, env });
    const copilot = copilotRunner({ harness: "copilot", agent: AGENT, clone: CLONE, env });
    for (const r of [claude, codex, copilot]) assert.deepEqual(r.domains, [...LOCAL_DOMAINS, "pypi.org", "huggingface.co", "*.hf.co"]);
    const settings = JSON.parse((({ args }) => args[args.indexOf("--settings") + 1])(harnessCommand({ harness: "claude", model: "m", prompt: "p", runner: claude })));
    assert.ok(settings.sandbox.network.allowedDomains.includes("huggingface.co"), "Claude Code's own sandbox settings");
    codex.present = new Set();
    assert.ok(harnessCommand({ harness: "codex", model: "m", prompt: "p", runner: codex }).args.some((a) => a.includes('"huggingface.co"')), "Codex's network profile");
    // The Block for a host its sandbox still denies leaves out the ones the labels opened, and offers the label first.
    assert.equal(BACKENDS.actions.sandbox.deniedFix(["huggingface.co"], env, "claude"), null);
    const fix = BACKENDS.actions.sandbox.deniedFix(["cdn-lfs.hf.co", "models.example.org"], env, "codex");
    assert.match(fix, /denied `models\.example\.org`\. If the Objective needs it, a person who can push applies `pendulum:host:models\.example\.org` to this issue, which opens it to this Objective alone, then resumes through Draft\. To open it to every Objective, add it to the Pendulum workflow's `allowed_domains` input/);
  } finally {
    openStageHosts([]);
  }
  assert.deepEqual(runnerDomains("pypi.org"), [...LOCAL_DOMAINS, "pypi.org"], "doctor and every other caller without hosts: unchanged");
});

/** A Local loop over a fresh developer clone, as the choice tests make one. */
async function loopFor(dev) {
  const { Local } = await import("../scripts/local.mjs");
  const local = Object.assign(Object.create(Local.prototype), { dev, harness: "claude", repoFull: "acme/app", repo, wf: { PENDULUM_LOCAL_DOMAINS: "pypi.org" }, opts: { token: "t" }, stopping: false, firstSetup: new Map(), children: new Set() });
  for (const n of [8, 9]) {
    mkdirSync(join(local.ws(n), "repo", ".git"), { recursive: true });
    pinGitDir(join(local.ws(n), "repo"), gitPinFile(local.ws(n)));
  }
  return local;
}

test("local mode, the real path: one Objective's stage gets its hosts in every sandbox it sets up; another Objective's never does", async () => {
  const dev = mkdtempSync(join(tmpdir(), "hosts-"));
  const stageTmp = mkdtempSync(join(tmpdir(), "stage-"));
  const local = await loopFor(dev);
  const env = (n, hosts) => {
    const usage = join(local.ws(n), `usage-work-${n}`);
    mkdirSync(usage, { recursive: true });
    return local.stageEnv(n, usage, join(local.ws(n), "repo"), stageTmp, "worker.mjs", "claude", hosts);
  };
  try {
    const own = env(8, ["huggingface.co"]);
    assert.equal(own.PENDULUM_STAGE_HOSTS, "huggingface.co");
    const sandbox = JSON.parse(own.PENDULUM_LOCAL_SANDBOX);
    assert.deepEqual(sandbox.domains, [...LOCAL_DOMAINS, "pypi.org", "huggingface.co"], "the harness's own sandbox");
    assert.ok(JSON.parse(readFileSync(own.PENDULUM_LOCAL_SRT, "utf8")).network.allowedDomains.includes("huggingface.co"), "Pendulum's own commands (validation) in the stage");
    assert.deepEqual(JSON.parse(readFileSync(own.PENDULUM_LOCAL_SRT_GIT, "utf8")).network.allowedDomains, [], "Pendulum's git: no network still");
    if (own.PENDULUM_LOCAL_SRT_HARNESS) assert.ok(JSON.parse(readFileSync(own.PENDULUM_LOCAL_SRT_HARNESS, "utf8")).network.allowedDomains.includes("huggingface.co"), "the harness's outer sandbox");
    const other = env(9, []);
    assert.equal(other.PENDULUM_STAGE_HOSTS, "");
    assert.deepEqual(JSON.parse(other.PENDULUM_LOCAL_SANDBOX).domains, [...LOCAL_DOMAINS, "pypi.org"], "another Objective on the same loop: the repository's list alone");
    assert.ok(!JSON.parse(readFileSync(other.PENDULUM_LOCAL_SRT, "utf8")).network.allowedDomains.includes("huggingface.co"));
    // A Copilot stage's policy file carries them too.
    const copilot = local.harnessEnv(8, [stageTmp], join(local.ws(8), "repo"), join(local.ws(8), "usage-work-8"), null, "copilot", local.domains(["huggingface.co"]));
    assert.ok(readFileSync(join(copilot.COPILOT_HOME, "settings.json"), "utf8").includes("huggingface.co"));
  } finally {
    rmSync(dev, { recursive: true, force: true });
    rmSync(stageTmp, { recursive: true, force: true });
  }
});

test("choiceGate: the hosts the stage opens, and a Block when local mode set its sandboxes up for others", async () => {
  const applied = [];
  const gate = (env) => choiceGate({ repo, issue: 7, labels: [HF], env, pr: null, notify: "boss", opts: {}, apply: async (_, e) => applied.push(e), stage: "work", gh: timeline({ [HF]: person("dev") }) });
  const runner = await gate(ENV);
  assert.deepEqual([runner.ok, runner.hosts], [true, ["huggingface.co"]], "a runner's stage opens its own: nothing prepared");
  assert.deepEqual((await gate({ ...ENV, PENDULUM_STAGE_HOSTS: "huggingface.co" })).hosts, ["huggingface.co"], "the loop set it up for the same hosts");
  const moved = await gate({ ...ENV, PENDULUM_STAGE_HOSTS: "" });
  assert.equal(moved.ok, false, "the label was applied after the loop set the sandboxes up");
  assert.deepEqual([applied[0].exit, applied[0].cause, applied[0].stage], ["blocked", "setup", "work"]);
});
