// An Objective's own network hosts (#278): a `factory:host:<host>` label a person who can push applied opens that host to
// that Objective's sandboxes alone, on every route; the plan's record covers it, and the progress comment and doctor
// name it.
import "./temp.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HOST_PREFIX, LABEL_MAX, choiceLabels, choiceOf, hostsOf, hostsProblem, ranWith } from "../scripts/lib/choice.mjs";
import { CHOICE_FIX, EDITED_REASON, choiceGate, choiceTrusted, editedSincePlan, objectiveInputs, objectiveSha, planTextState } from "../scripts/lib/objective-trust.mjs";
import { claudeRunner, codexRunner, copilotRunner, harnessCommand } from "../scripts/lib/harness.mjs";
import { LOCAL_DOMAINS, gitPinFile, isSandboxHost, openStageHosts, openedStageHosts, pinGitDir, runnerDomains } from "../scripts/lib/local.mjs";
import { BACKENDS } from "../scripts/lib/backend.mjs";
import { deniedHostsFix, harnessMarker, setSelf } from "../scripts/lib/logic.mjs";
import { hostsLine, progressReporter, writeUsage } from "../scripts/lib/session.mjs";
import { repoOf } from "../scripts/lib/github.mjs";
import { objectiveHostChecks } from "../scripts/doctor.mjs";

const repo = { owner: "acme", name: "app", full: "acme/app" };
const ROOT = join(import.meta.dirname, "..", "..");
const ENV = { GITHUB_REPOSITORY: "acme/app", FACTORY_HARNESS: "claude", FACTORY_MODEL: "claude-opus-5-5", FACTORY_SUBAGENT_MODEL: "claude-sonnet-5-5", FACTORY_REVIEWER_MODEL: "claude-fable-5-2" };
const AGENT = { user: "factory-agent", uid: 1002, home: "/home/factory-agent", tmp: "/home/factory-agent/tmp", allow: new Set() };
const CLONE = "/home/factory-agent/repo";
const HF = "factory:host:huggingface.co";

const person = (login, id = 1) => ({ login, id, type: "User" });
const perms = { kirk: "admin", dev: "write", reader: "read", triager: "triage" };
const timeline = (by) => ({ labelers: async (_, n, names) => (assert.equal(n, 7), Object.fromEntries(names.filter((l) => by[l]).map((l) => [l, { at: "2026-11-14T10:00:00Z", actor: by[l] }]))), permission: async (_, login) => perms[login] ?? null });

test("host labels: each names one host a sandbox enforces as written, lower case, once; other labels open nothing", () => {
  assert.deepEqual(hostsOf(["factory:objective", "factory:model:x"]), { ok: true, hosts: [], labels: [] });
  const h = hostsOf([{ name: "factory:objective" }, { name: "factory:host:HuggingFace.co" }, { name: "factory:host:*.hf.co" }, { name: "factory:host:huggingface.co" }]);
  assert.deepEqual(h, { ok: true, hosts: ["*.hf.co", "huggingface.co"], labels: ["factory:host:*.hf.co", "factory:host:HuggingFace.co", "factory:host:huggingface.co"] });
  for (const bad of ["1.2.3.4", "localhost", "api.localhost", "example.com:443", "https://example.com", "example.com/path", "*.com", "*example.com", "a.*.example.com", "", "*", "[::1]", "ex ample.com"]) {
    const r = hostsOf([`${HOST_PREFIX}${bad}`]);
    assert.equal(r.ok, false, bad);
    assert.match(r.reason, /names no host Factory's sandboxes can allow/, bad);
    assert.match(r.fix, /`factory:host:example\.com`/);
  }
  assert.equal(LABEL_MAX - HOST_PREFIX.length, 37, "the room USAGE.md states");
  // A host label is no harness or model choice: the harness label still reads, whatever host labels sit beside it.
  assert.deepEqual(choiceOf(["factory:harness:codex", HF, "factory:host:1.2.3.4"]).choice, { harness: "codex" });
  assert.deepEqual(choiceLabels(["factory:objective", HF, "factory:model:m"]), ["factory:host:huggingface.co", "factory:model:m"], "the set the plan's record and the trust check cover");
});

test("host labels: a wildcard over a public suffix (the Public Suffix List, private section included) is refused; one over an organisation's name opens", () => {
  for (const suffix of ["co.uk", "github.io", "vercel.app", "s3.amazonaws.com", "pages.dev"]) {
    const r = hostsOf([`${HOST_PREFIX}*.${suffix}`]);
    assert.equal(r.ok, false, suffix);
    assert.match(r.reason, new RegExp(`opens every site under \`${suffix.replace(/\./g, "\\.")}\`, a public suffix`), suffix);
    assert.equal(isSandboxHost(`*.${suffix}`), false, "the runner's own filter drops it too");
  }
  // One organisation's name under such a suffix, or the suffix's own host, is a host like any other.
  for (const ok of ["*.clockgrove.github.io", "*.example.co.uk", "*.hf.co", "github.io"]) assert.deepEqual(hostsOf([`${HOST_PREFIX}${ok}`]).hosts, [ok], ok);
});

test("a host label counts only when the person who last applied it can push or is a pinned maintainer; a bad name is refused before any read", async () => {
  const labels = ["factory:objective", HF];
  const ok = await choiceTrusted(repo, 7, labels, {}, timeline({ [HF]: person("dev") }));
  assert.deepEqual([ok.ok, ok.hosts, ok.labels, ok.choice], [true, ["huggingface.co"], [HF], {}]);
  for (const who of ["reader", "triager"]) {
    const no = await choiceTrusted(repo, 7, labels, {}, timeline({ [HF]: person(who) }));
    assert.equal(no.ok, false, who);
    assert.match(no.reason, new RegExp(`^\`factory:host:huggingface\\.co\` was applied by \`${who}\`, who cannot push`));
    assert.equal(no.fix, CHOICE_FIX);
  }
  assert.equal((await choiceTrusted(repo, 7, labels, {}, timeline({ [HF]: { login: "kirk", id: 2, type: "Bot" } }))).ok, false, "an App never vouches");
  assert.match((await choiceTrusted(repo, 7, labels, {}, timeline({}))).reason, /who applied `factory:host:huggingface\.co` could not be read/);
  const bad = await choiceTrusted(repo, 7, ["factory:host:10.0.0.1"], {}, { labelers: async () => assert.fail("refused on the name first") });
  assert.equal(bad.ok, false);
  assert.deepEqual(await choiceTrusted(repo, 7, ["factory:objective"], {}, { labelers: async () => assert.fail("no label, no read") }), { ok: true, choice: {}, labels: [], hosts: [], foundation: false });
  const both = await objectiveInputs({ repo, issue: 7, env: ENV, opts: {}, gh: { issue: async () => ({ labels: [{ name: "factory:harness:codex" }, { name: HF }] }), ...timeline({ "factory:harness:codex": person("kirk"), [HF]: person("dev") }) } });
  assert.deepEqual([both.ok, both.inputs.harness, both.hosts], [true, "codex", ["huggingface.co"]]);
});

test("a host label added, removed or changed after the plan is an edit", async () => {
  const plain = objectiveSha("Objective", "Build the thing.");
  const hf = objectiveSha("Objective", "Build the thing.", [HF]);
  assert.notEqual(hf, plain);
  assert.notEqual(objectiveSha("Objective", "Build the thing.", ["factory:host:*.hf.co"]), hf);
  assert.equal(planTextState({ sha: hf, plan: { at: "2026-11-14T10:00:00Z", record: { sha256: plain, label: "2026-11-14T09:00:00Z" } }, labeledAt: "2026-11-14T09:00:00Z" }), "changed");
  assert.match(EDITED_REASON, /`factory:host:`/);
  setSelf("factory-app[bot]");
  const plan = async () => ({ at: "2026-11-14T10:00:00Z", own: true, text: "## Plan", record: { sha256: plain, label: null } });
  const read = (labels) => ({ gh: { graphql: async () => ({ repository: { issue: { title: "Objective", body: "Build the thing.", labels: { nodes: labels.map((name) => ({ name })) } } } }) }, read: plan });
  assert.equal(await editedSincePlan(repo, 7, {}, read(["factory:objective"])), "same");
  assert.equal(await editedSincePlan(repo, 7, {}, read(["factory:objective", HF])), "changed", "the merge's check sees it too");
});

test("choiceGate: the hosts the stage opens, and a Block when local mode set its sandboxes up for others", async () => {
  const applied = [];
  const gate = (env) => choiceGate({ repo, issue: 7, labels: [HF], env, pr: null, notify: "boss", opts: {}, apply: async (_, e) => applied.push(e), stage: "work", gh: timeline({ [HF]: person("dev") }) });
  const runner = await gate(ENV);
  assert.deepEqual([runner.ok, runner.hosts], [true, ["huggingface.co"]], "a runner's stage opens its own: nothing prepared");
  assert.deepEqual((await gate({ ...ENV, FACTORY_STAGE_HOSTS: "huggingface.co" })).hosts, ["huggingface.co"], "the loop set it up for the same hosts");
  const moved = await gate({ ...ENV, FACTORY_STAGE_HOSTS: "" });
  assert.equal(moved.ok, false, "the label was applied after the loop set the sandboxes up");
  assert.deepEqual([applied[0].exit, applied[0].cause, applied[0].stage], ["blocked", "setup", "work"]);
  assert.match(applied[0].reason, /set up for the hosts of no host label but the Objective's host labels now name `huggingface\.co`/);
  assert.match(applied[0].fix, /Re-apply `factory:objective`/);
  assert.equal(hostsProblem(undefined, ["a.example.com"]), null);
  assert.match(hostsProblem("a.example.com,b.example.com", ["a.example.com"]).reason, /`a\.example\.com`, `b\.example\.com` but .* now name `a\.example\.com`/, "a label removed in between: the sandbox would hold a host no label opens");
});

test("Actions and the cloud sandbox: every harness's runner sandbox adds the opened hosts, and only once the stage opened them", () => {
  openStageHosts([]);
  const env = { FACTORY_INPUT_ALLOWED_DOMAINS: "pypi.org" };
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
    assert.match(fix, /denied `models\.example\.org`\. If the Objective needs it, a person who can push applies `factory:host:models\.example\.org` to this issue, which opens it to this Objective alone, then re-applies `factory:objective`\. To open it to every Objective, add it to the Factory workflow's `allowed_domains` input/);
  } finally {
    openStageHosts([]);
  }
  assert.deepEqual(runnerDomains("pypi.org"), [...LOCAL_DOMAINS, "pypi.org"], "doctor and every other caller without hosts: unchanged");
});

test("the denied-host Block offers the host label for this Objective and the setting for every Objective", () => {
  assert.equal(deniedHostsFix(["huggingface.co"]), "The local sandbox denied `huggingface.co`. If the Objective needs it, a person who can push applies `factory:host:huggingface.co` to this issue, which opens it to this Objective alone, then re-applies `factory:objective`. To open it to every Objective, add it to `FACTORY_LOCAL_DOMAINS` (a running `serve` reads it when it restarts), then re-apply `factory:objective`.");
  const long = `${"x".repeat(40)}.example.com`;
  assert.match(deniedHostsFix(["a.example.com", long]), /applies `factory:host:a\.example\.com` to this issue \(the rest are too long for a label\), which opens it/);
  assert.equal(deniedHostsFix([long]), `The local sandbox denied \`${long}\`. If the Objective needs it, add it to \`FACTORY_LOCAL_DOMAINS\` (a running \`serve\` reads it when it restarts), then re-apply \`factory:objective\`.`, "no label fits: the setting alone");
});

/** A Local loop over a fresh developer clone, as the choice tests make one. */
async function loopFor(dev) {
  const { Local } = await import("../scripts/local.mjs");
  const local = Object.assign(Object.create(Local.prototype), { dev, harness: "claude", repoFull: "acme/app", repo, wf: { FACTORY_LOCAL_DOMAINS: "pypi.org" }, opts: { token: "t" }, stopping: false, firstSetup: new Map(), children: new Set() });
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
    assert.equal(own.FACTORY_STAGE_HOSTS, "huggingface.co");
    const sandbox = JSON.parse(own.FACTORY_LOCAL_SANDBOX);
    assert.deepEqual(sandbox.domains, [...LOCAL_DOMAINS, "pypi.org", "huggingface.co"], "the harness's own sandbox");
    assert.ok(JSON.parse(readFileSync(own.FACTORY_LOCAL_SRT, "utf8")).network.allowedDomains.includes("huggingface.co"), "Factory's own commands (validation) in the stage");
    assert.deepEqual(JSON.parse(readFileSync(own.FACTORY_LOCAL_SRT_GIT, "utf8")).network.allowedDomains, [], "Factory's git: no network still");
    if (own.FACTORY_LOCAL_SRT_HARNESS) assert.ok(JSON.parse(readFileSync(own.FACTORY_LOCAL_SRT_HARNESS, "utf8")).network.allowedDomains.includes("huggingface.co"), "the harness's outer sandbox");
    const other = env(9, []);
    assert.equal(other.FACTORY_STAGE_HOSTS, "");
    assert.deepEqual(JSON.parse(other.FACTORY_LOCAL_SANDBOX).domains, [...LOCAL_DOMAINS, "pypi.org"], "another Objective on the same loop: the repository's list alone");
    assert.ok(!JSON.parse(readFileSync(other.FACTORY_LOCAL_SRT, "utf8")).network.allowedDomains.includes("huggingface.co"));
    // A Copilot stage's policy file carries them too.
    const copilot = local.harnessEnv(8, [stageTmp], join(local.ws(8), "repo"), join(local.ws(8), "usage-work-8"), null, "copilot", local.domains(["huggingface.co"]));
    assert.ok(readFileSync(join(copilot.COPILOT_HOME, "settings.json"), "utf8").includes("huggingface.co"));
  } finally {
    rmSync(dev, { recursive: true, force: true });
    rmSync(stageTmp, { recursive: true, force: true });
  }
});

test("local mode, the real path: harnessFor reads the host labels and who applied them from GitHub, and stage() sets the sandboxes up with them", async () => {
  const dev = mkdtempSync(join(tmpdir(), "hosts-for-"));
  const local = await loopFor(dev);
  const real = globalThis.fetch;
  const read = (applier) => {
    globalThis.fetch = async (url) => {
      const u = String(url);
      const json = (v) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
      if (/\/user$/.test(u)) return json({ login: "me", type: "User" });
      if (/\/collaborators\?/.test(u)) return json([{ login: "dev" }]);
      if (/\/collaborators\/[^/]+\/permission$/.test(u)) return json({ permission: /\/dev\//.test(u) ? "write" : "read" });
      if (/\/issues\/8\/timeline/.test(u)) return json([{ event: "labeled", label: { name: HF }, created_at: "2026-11-14T10:00:00Z", actor: { login: applier, id: 5, type: "User" } }]);
      if (/\/issues\/8$/.test(u)) return json({ number: 8, labels: [{ name: "factory:objective" }, { name: HF }] });
      throw new Error(`unexpected ${u}`);
    };
  };
  // A home of its own: harnessFor reads this machine's account declaration (lib/accounts.mjs), none here.
  const home = process.env.HOME;
  process.env.HOME = dev;
  try {
    read("dev");
    assert.deepEqual(await local.harnessFor(8), { ok: true, harness: "claude", hosts: ["huggingface.co"], account: { name: "claude", harness: "claude", declared: false } });
    read("reader");
    const refused = await local.harnessFor(8);
    assert.equal(refused.ok, false);
    assert.match(refused.reason, /`factory:host:huggingface\.co` was applied by `reader`/);
    // stage(): the hosts harnessFor read reach stageEnv, and nothing is set up on a refusal.
    const setUp = [];
    local.block = async () => {};
    local.stageEnv = (...a) => {
      setUp.push(a[6]);
      throw Object.assign(new Error("stop here"), { code: "outer-sandbox" });
    };
    local.harnessFor = async () => ({ ok: true, harness: "claude", hosts: ["huggingface.co"] });
    await local.stage(8, "work", "worker.mjs", []);
    local.harnessFor = async () => ({ ok: false, reason: "no", fix: "f" });
    await local.stage(8, "work", "worker.mjs", []);
    assert.deepEqual(setUp, [["huggingface.co"]]);
  } finally {
    process.env.HOME = home;
    globalThis.fetch = real;
    rmSync(dev, { recursive: true, force: true });
  }
});

test("the work and review stages open the hosts right after the choice check, before any harness", () => {
  for (const file of ["worker.mjs", "review.mjs"]) {
    const src = readFileSync(join(ROOT, "plugin", "scripts", file), "utf8");
    const run = src.indexOf("async function run()");
    const at = (s) => src.indexOf(s, run);
    assert.ok(at("await choiceGate(") > 0 && at("openStageHosts(chosen.hosts)") > at("await choiceGate("), file);
    for (const later of ["jobChecks(", "credentialChecks(", "runHarness(", "validationLoop("]) {
      const i = at(later);
      assert.ok(i === -1 || i > at("openStageHosts(chosen.hosts)"), `${file}: ${later} only after the hosts are open`);
    }
  }
});

test("the progress comment, the usage record and the harness line name the opened hosts", async () => {
  const inputs = { harness: "claude", model: "claude-opus-5-5", subagentModel: "claude-sonnet-5-5", reviewerModel: "claude-fable-5-2" };
  const ran = ranWith(inputs, ["factory:objective", HF]);
  assert.deepEqual([ran.labels, ran.hosts], [[HF], ["huggingface.co"]]);
  assert.deepEqual(JSON.parse(/^<!-- factory:harness (.*) -->$/.exec(harnessMarker("claude", "claude-opus-5-5", ran))[1]).hosts, ["huggingface.co"]);
  assert.ok(!harnessMarker("claude", "m", ranWith(inputs, [])).includes("hosts"), "none opened: the line as it was");
  assert.equal(hostsLine([]), "");
  const dir = mkdtempSync(join(tmpdir(), "ran-hosts-"));
  writeUsage(dir, { harness: "claude", model: "m", records: [], passes: 0, exit: "blocked", reason: "x", credentialBasis: null, ran });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "result.json"), "utf8")).ran.hosts, ["huggingface.co"]);
  rmSync(dir, { recursive: true, force: true });
  const real = globalThis.fetch;
  const posted = [];
  globalThis.fetch = async (url, init = {}) => {
    const json = (v) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
    if ((init.method || "GET") === "GET") return json([]);
    const body = JSON.parse(init.body).body;
    posted.push(body);
    return json({ id: 9, user: { login: "me", type: "User" }, body });
  };
  try {
    const progress = progressReporter(repoOf("acme/app"), 7, { token: () => "t" }, { stage: "work", runId: "1", soFar: null });
    progress.ran(ran);
    await progress("harness");
  } finally {
    globalThis.fetch = real;
  }
  assert.match(posted.at(-1), /\nNetwork: this Objective's sandboxes also reach `huggingface\.co` \(its `factory:host:` labels\)\.\n/);
});

test("doctor names each open Objective's hosts, and warns of a host label no sandbox can allow", async () => {
  const inputs = { objectiveLabel: "factory:objective" };
  const list = async () => [{ number: 228, labels: [{ name: "factory:objective" }, { name: HF }, { name: "factory:host:*.hf.co" }] }, { number: 229, labels: [{ name: "factory:objective" }] }, { number: 230, labels: [{ name: "factory:host:10.0.0.1" }] }, { number: 231, pull_request: {}, labels: [{ name: HF }] }];
  const rows = await objectiveHostChecks({ inputs, repo, token: "t", list });
  assert.deepEqual(rows.map((r) => `${r.name}:${r.status}`), ["objective hosts:PASS", "objective hosts:WARN"]);
  assert.match(rows[0].detail, /^#228: \*\.hf\.co, huggingface\.co; each opened to that Objective's own sandboxes alone/);
  assert.match(rows[1].detail, /^#230: `factory:host:10\.0\.0\.1` names no host/);
  assert.match((await objectiveHostChecks({ inputs, repo, token: "t", list: async () => [] }))[0].detail, /^no open Objective has a factory:host: label/);
  assert.equal((await objectiveHostChecks({ inputs, repo, token: "t", list: async () => Promise.reject(new Error("503")) }))[0].status, "WARN");
});
