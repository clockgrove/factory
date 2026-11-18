import "./temp.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RETRY } from "../scripts/lib/github.mjs";
import { harnessMarker, ledgerMarker, setSelf, spendMarker } from "../scripts/lib/logic.mjs";
import { PENDULUM_VERSION } from "../scripts/lib/inputs.mjs";
import { RATIO_WORDS, rateRatios, rateTables, renderReport, reportCheck } from "../scripts/lib/report.mjs";
import { COMMANDS, parseArgs, reportCommand } from "../scripts/local.mjs";
import { codexPrice } from "../scripts/lib/usage.mjs";

// Model-usage proposals (#547): `pendulum report --rates` computes the only cross-model figure Pendulum gives, a ratio of
// one vendor's published rates on the recorded token mix, with no dollar unit; the report skill's proposals mode writes
// the prose, as a named model's judgement citing the rows it read.

RETRY.sleep = async () => {};

const REPO = { owner: "acme", name: "app", full: "acme/app" };
const ME = { login: "kirkmarple-clockgrove", id: 1, type: "User" };
const BOT = { login: "clockgrove-pendulum[bot]", type: "Bot" };
const issueUrl = (n) => `https://api.github.com/repos/${REPO.full}/issues/${n}`;
const NOW = Date.parse("2026-11-18T00:00:00Z");
/** The price table as the file holds it, read here on its own, not through the code under test. */
const TABLE = JSON.parse(readFileSync(join(import.meta.dirname, "..", "scripts", "lib", "codex-prices.json"), "utf8"));
const SKILL_DIR = join(import.meta.dirname, "..", "skills", "pendulum-report");

let nextId = 7000;
/**
 * One merged Objective of one local stage by Pendulum's own login: its progress comment with its harness line, spend line
 * and per-pass ledger line (#543), so the report reads its model and tokens with no artifact.
 */
function objective(w, n, { h, model, usd, billing, tokens }) {
  w.issues.push({ number: n, title: `Objective ${n}`, state: "closed", labels: [{ name: "pendulum:objective" }], created_at: "2026-11-17T01:00:00Z", user: ME });
  const ledger = [{ label: "work-1", model, effort: "medium", started: "2026-11-17T02:00:00Z", ended: "2026-11-17T02:10:00Z", usd, usdUnknown: 0, usdUnknownWhy: [], billing, usdByBilling: { [billing]: usd }, tokens }];
  const body = [`<!-- pendulum:${n}:progress:work:local-${n} -->`, "Pendulum work: started.", harnessMarker(h, model, { worker: model, subagent: null, reviewer: null, labels: [] }), spendMarker(usd, { usdByBilling: { [billing]: usd }, billing }), ledgerMarker(ledger, { model, version: PENDULUM_VERSION, published: [model] })].join("\n");
  w.comments.push({ id: (nextId += 1), issue_url: issueUrl(n), user: ME, author_association: "OWNER", created_at: "2026-11-17T02:00:00Z", updated_at: "2026-11-17T02:10:00Z", body });
  w.pulls.push({ number: n + 1000, head: { ref: `pendulum/${n}`, repo: { id: 1 } }, base: { repo: { id: 1 } }, created_at: "2026-11-17T02:05:00Z", merged_at: "2026-11-17T02:20:00Z", state: "closed" });
}

/** A fake GitHub answering the reads `pendulum report --issue` makes, one page each. */
function fakeFetch(w) {
  const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  return async (url, init = {}) => {
    const u = new URL(url);
    const p = u.pathname.replace(`/repos/${REPO.full}`, "");
    if ((init.method || "GET") !== "GET") return json({ message: "a report writes nothing" }, 405);
    if (u.pathname === "/user") return json(ME);
    let m = /^\/issues\/(\d+)\/comments$/.exec(p);
    if (m) return json(w.comments.filter((c) => c.issue_url === issueUrl(Number(m[1]))));
    m = /^\/issues\/(\d+)$/.exec(p);
    if (m) {
      const i = w.issues.find((x) => x.number === Number(m[1]));
      return i ? json({ ...i, comments: w.comments.filter((c) => c.issue_url === issueUrl(i.number)).length }) : json({ message: "Not Found" }, 404);
    }
    if (p === "/pulls") return json(w.pulls.filter((x) => `${REPO.owner}:${x.head.ref}` === u.searchParams.get("head")));
    if (p === "/actions/artifacts") {
      const list = (u.searchParams.has("name") ? w.artifacts[u.searchParams.get("name")] || [] : Object.values(w.artifacts).flat()).map(({ record, ...a }) => a);
      return json({ total_count: list.length, artifacts: list });
    }
    return json({ message: "Not Found" }, 404);
  };
}

/** `pendulum report` through its real command line and command, on the fake: {code, json, md}. */
async function report(w, args) {
  const run = async (json) => {
    const parsed = parseArgs(["report", "--repo", REPO.full, "--checkout", tmpdir(), "--app", "2271", ...(json ? ["--json"] : []), ...args]);
    let out = "";
    const realFetch = globalThis.fetch;
    const saved = process.env.GITHUB_API_URL;
    process.env.GITHUB_API_URL = "https://github.test";
    globalThis.fetch = fakeFetch(w);
    try {
      const code = await reportCommand(parsed.flags, { out: (t) => (out += t), err: () => {}, token: "t", download: async (_repo, a) => Object.values(w.artifacts).flat().find((x) => x.id === a.id)?.record ?? null, now: NOW });
      return { code, out };
    } finally {
      globalThis.fetch = realFetch;
      setSelf(null);
      if (saved === undefined) delete process.env.GITHUB_API_URL;
      else process.env.GITHUB_API_URL = saved;
    }
  };
  const j = await run(true);
  const md = await run(false);
  return { code: j.code, json: JSON.parse(j.out), md: md.out };
}

/** `tokens` weighed at `model`'s row of the table as the file holds it (its standard rates), computed here on its own. */
function weightOf(model, t) {
  const r = TABLE.perMillion[model];
  return (t.input - t.cached - t.written) * r.input + t.cached * r.cached + t.written * (r.write ?? r.input) + t.output * r.output;
}
const r6 = (x) => Math.round(x * 1e6) / 1e6;
/** The ratio of two models' dollars for `tokens` as the cost join prices them (codexPrice), the reference for every ratio. */
const priced = (cand, own, tokens) => r6(codexPrice(TABLE, cand, tokens, { at: NOW }).usd / codexPrice(TABLE, own, tokens, { at: NOW }).usd);

/**
 * One merged Objective of one Actions stage by Pendulum's App: its progress comment with its harness line and no spend
 * line, its tokens (with their long-context share) and sub-agent threads in its usage record, read from its artifact.
 */
function actionsObjective(w, n, { model, tokens, subAgents = null }) {
  const run = (nextId += 1);
  w.issues.push({ number: n, title: `Objective ${n}`, state: "closed", labels: [{ name: "pendulum:objective" }], created_at: "2026-11-17T01:00:00Z", user: ME });
  w.comments.push({ id: (nextId += 1), issue_url: issueUrl(n), user: BOT, author_association: "CONTRIBUTOR", performed_via_github_app: { id: 2271, slug: "clockgrove-pendulum" }, created_at: "2026-11-17T02:00:00Z", updated_at: "2026-11-17T02:10:00Z", body: [`<!-- pendulum:${n}:progress:work:${run} -->`, "Pendulum work: started.", harnessMarker("codex", model, { worker: model, subagent: subAgents ? subAgents[0].model : null, reviewer: null, labels: [] })].join("\n") });
  const record = { harness: "codex", model, usd: 1, usdByBilling: { api: 1 }, billing: "api", runs: 1, exit: "delivered", progressRun: String(run), started: "2026-11-17T02:00:00Z", ended: "2026-11-17T02:10:00Z", tokens, ...(subAgents ? { subAgents } : {}), ran: { pendulum: PENDULUM_VERSION } };
  (w.artifacts[`pendulum-usage-${n}`] ||= []).push({ id: run, name: `pendulum-usage-${n}`, expired: false, created_at: "2026-11-17T02:10:00Z", workflow_run: { id: run, repository_id: 1, head_repository_id: 1 }, record });
  w.pulls.push({ number: n + 1000, head: { ref: `pendulum/${n}`, repo: { id: 1 } }, base: { repo: { id: 1 } }, created_at: "2026-11-17T02:05:00Z", merged_at: "2026-11-17T02:20:00Z", state: "closed" });
}

const SOL = { input: 200_000, output: 10_000, cached: 120_000, written: 20_000 };
const world = () => {
  const w = { issues: [], comments: [], pulls: [], artifacts: {} };
  objective(w, 41, { h: "codex", model: "gpt-6-sol", usd: 0.294, billing: "api", tokens: SOL });
  objective(w, 42, { h: "claude", model: "claude-opus-5-5", usd: 2.5, billing: "subscription", tokens: { input: 900_000, output: 40_000, cached: 700_000, written: 150_000 } });
  return w;
};

test("report --rates: each ratio is exact against the published table, within one vendor, and carries no dollar figure", async () => {
  const { code, json: r, md } = await report(world(), ["--issue", "41,42", "--rates", "gpt-6.1-terra,claude-fable-5-2", "--rates", "gpt-6-luna,gpt-6-sol"]);
  assert.equal(code, 0);
  assert.equal(r.rates.words, RATIO_WORDS);
  assert.equal(r.rates.usable, true, "#569 V11: a ratio was weighed");
  assert.match(RATIO_WORDS, /^ratio of published rates on the recorded token mix \(no dollar unit\)$/);
  assert.deepEqual(r.rates.candidates, ["gpt-6.1-terra", "claude-fable-5-2", "gpt-6-luna", "gpt-6-sol"]);
  // The recorded mix is the model's tokens; each ratio is the candidate's rates over the model's own, on that mix.
  assert.deepEqual(r.breakdowns.model.find((x) => x.key === "gpt-6-sol").tokens, SOL);
  const base = weightOf("gpt-6-sol", SOL);
  assert.deepEqual(
    r.rates.items.map((x) => [x.model, x.candidate, x.vendor, x.ratio]),
    [
      ["gpt-6-sol", "gpt-6.1-terra", "openai", r6(weightOf("gpt-6.1-terra", SOL) / base)],
      ["gpt-6-sol", "gpt-6-luna", "openai", r6(weightOf("gpt-6-luna", SOL) / base)],
    ],
  );
  // By hand from the table: sol 60k x 2 + 120k x 0.2 + 20k x 2.5 + 10k x 10 = 294k; luna 6k + 1.2k + 2.5k + 5k = 14.7k.
  assert.equal(r.rates.items[1].ratio, 0.05);
  assert.deepEqual(r.rates.items[0].mix, { uncached: 60_000, cached: 120_000, written: 20_000, output: 10_000 });
  assert.match(r.rates.basis, new RegExp(`^openai's published rates from codex-prices\\.json dated ${TABLE.date}, the long-context share at the long-context rates$`));
  // Never across vendors: an Anthropic model has no published table of Pendulum's, as a candidate or as the recorded
  // model; and a candidate that is the recorded model is said, not weighed against itself.
  assert.deepEqual(
    r.rates.skipped.map((x) => [x.model, x.candidate, x.why]),
    [
      [null, "claude-fable-5-2", "no-rate-table"],
      ["gpt-6-sol", "gpt-6-sol", "same-model"],
      ["claude-opus-5-5", null, "no-rate-table"],
    ],
  );
  // No dollar figure: no `usd` field, no dollar sign, in the JSON or in the Markdown section.
  assert.ok(!/usd|\$/i.test(JSON.stringify(r.rates)), JSON.stringify(r.rates));
  const section = md.slice(md.indexOf("## Rate ratios"), md.indexOf("## Source"));
  assert.ok(section.includes(RATIO_WORDS) && section.includes("| gpt-6-sol | gpt-6-luna | 0.05× |"), section);
  assert.ok(!section.includes("$"), section);
  // Without --rates, none.
  assert.equal((await report(world(), ["--issue", "41"])).json.rates, null);
});

test("report --rates: the long-context share is weighed at each tier as the cost join prices it, sub-agent threads under their own model, an alias once", async () => {
  const w = { issues: [], comments: [], pulls: [], artifacts: {} };
  // #43: a gpt-6-sol stage over the long-context threshold with a known long share, and a gpt-6-luna sub-agent thread.
  const long = { input: 400_000, cached: 200_000, written: 0, output: 20_000 };
  const thread = { input: 200_000, cached: 100_000, written: 0, output: 20_000 };
  actionsObjective(w, 43, { model: "gpt-6-sol", tokens: { input: 1_000_000, cached: 400_000, written: 100_000, output: 100_000, long }, subAgents: [{ id: "t1", model: "gpt-6-luna", tokens: thread }] });
  // #44: a gpt-6-luna stage over the threshold whose share was read and is zero (`long` present, all zeros).
  actionsObjective(w, 44, { model: "gpt-6-luna", tokens: { input: 300_000, cached: 0, written: 0, output: 10_000, long: { input: 0, cached: 0, written: 0, output: 0 } } });
  const { json: r } = await report(w, ["--issue", "43,44", "--rates", "gpt-6.1-terra,gpt-5.4-mini,gpt-5.6,gpt-5.6-sol"]);
  // An alias and the model it names are one candidate, the first name given.
  assert.deepEqual(r.rates.candidates, ["gpt-6.1-terra", "gpt-5.4-mini", "gpt-5.6"]);
  // sol's mix is its stage less the thread, the long share all its own (the thread's input is under the threshold).
  const sol = { input: 800_000, cached: 300_000, written: 100_000, output: 80_000, long };
  const luna = { input: 500_000, cached: 100_000, written: 0, output: 30_000, long: { input: 0, cached: 0, written: 0, output: 0 } };
  const item = (m, c) => r.rates.items.find((x) => x.model === m && x.candidate === c);
  assert.equal(item("gpt-6-sol", "gpt-6.1-terra").ratio, priced("gpt-6.1-terra", "gpt-6-sol", sol));
  assert.equal(item("gpt-6-sol", "gpt-6.1-terra").ratio, r6(1.2 / 2.45), "by hand: terra $1.20 and sol $2.45 at both tiers");
  assert.notEqual(item("gpt-6-sol", "gpt-6.1-terra").ratio, r6(weightOf("gpt-6.1-terra", sol) / weightOf("gpt-6-sol", sol)), "not the standard rates alone");
  assert.deepEqual(item("gpt-6-sol", "gpt-6.1-terra").long, { uncached: 200_000, cached: 200_000, written: 0, output: 20_000 });
  assert.equal(item("gpt-6-sol", "gpt-5.6").ratio, priced("gpt-5.6-sol", "gpt-6-sol", sol));
  assert.equal(item("gpt-6-sol", "gpt-5.6").candidateRateOf, "gpt-5.6-sol");
  // luna's mix is #44's stage and #43's thread; a share present but zero is weighed, even against a model with no long rates.
  for (const c of ["gpt-6.1-terra", "gpt-5.4-mini"]) assert.equal(item("gpt-6-luna", c).ratio, priced(c, "gpt-6-luna", luna), c);
  // A long share that is not zero against a model with no long-context rates: no ratio.
  assert.deepEqual(
    r.rates.skipped.map((x) => [x.model, x.candidate, x.why]),
    [["gpt-6-sol", "gpt-5.4-mini", "long-context"]],
  );
});

test("rateRatios: two vendors' models are never weighed together; an ended promotional rate, an unknown long share, unsplit sub-agents and missing tokens give no ratio", () => {
  // A second vendor's table, so the rule is tested where it could break: its models are never weighed against OpenAI's.
  const other = { vendor: "anthropic", file: "test-table.json", table: { date: "2026-11-17", perMillion: { "claude-opus-5-5": { input: 5, cached: 0.5, write: 6.25, output: 25 }, "claude-sonnet-5-5": { input: 3, cached: 0.3, write: 3.75, output: 15 } } } };
  const tables = [...rateTables(TABLE), other];
  const none = { input: 0, cached: 0, written: 0, output: 0 };
  const mixes = [
    { key: "gpt-6-sol", tokens: SOL, long: none, why: [] },
    { key: "claude-opus-5-5", tokens: { input: 1000, output: 100, cached: 0, written: 0 }, long: null, why: [] },
    { key: "gpt-6.1-terra", tokens: { input: null, output: null, cached: null, written: null }, long: none, why: ["no-tokens"] },
    { key: "gpt-6-luna", tokens: SOL, long: none, why: ["sub-agents"] },
    { key: "gpt-6.1-sol", tokens: SOL, long: null, why: [] },
    { key: null, tokens: SOL, long: none, why: [] },
    { key: "decisions", tokens: SOL, long: none, why: [] },
  ];
  const r = rateRatios(mixes, ["gpt-6.1-terra", "claude-sonnet-5-5", "gpt-5.6-sol"], tables, { at: "2026-12-01T00:00:00Z" });
  assert.deepEqual(
    r.items.map((x) => [x.model, x.candidate, x.vendor]),
    [
      ["gpt-6-sol", "gpt-6.1-terra", "openai"],
      ["claude-opus-5-5", "claude-sonnet-5-5", "anthropic"],
    ],
  );
  // Two models with no long-context rates weigh every token at the standard rates, their share unknown or not.
  assert.equal(r.items[1].ratio, r6((1000 * 3 + 100 * 15) / (1000 * 5 + 100 * 25)));
  assert.deepEqual(
    r.skipped.map((x) => [x.model, x.candidate, x.why]),
    [
      [null, "gpt-5.6-sol", "price-ended"],
      ["gpt-6-sol", "claude-sonnet-5-5", "other-vendor"],
      ["claude-opus-5-5", "gpt-6.1-terra", "other-vendor"],
      ["gpt-6.1-terra", null, "no-tokens"],
      ["gpt-6-luna", null, "sub-agents"],
      ["gpt-6.1-sol", "gpt-6.1-terra", "long-context"],
      ["gpt-6.1-sol", "claude-sonnet-5-5", "other-vendor"],
    ],
  );
  for (const x of r.skipped) assert.equal(typeof x.text, "string");
  assert.ok(!/usd|\$/i.test(JSON.stringify(r)));
  // Before its end the promotional rate is the published one.
  assert.deepEqual(
    rateRatios(mixes.slice(0, 1), ["gpt-5.6-sol"], tables, { at: "2026-11-17T00:00:00Z" }).items.map((x) => [x.candidate, x.ratio]),
    [["gpt-5.6-sol", r6(weightOf("gpt-5.6-sol", SOL) / weightOf("gpt-6-sol", SOL))]],
  );
});

test("report --rates: a stage whose sub-agents ran on another model and that no record splits leaves both models without a ratio", async () => {
  const w = world();
  // #45: a local Codex stage known only from its ledger line, its harness line naming a gpt-6-luna sub-agent model.
  w.issues.push({ number: 45, title: "Objective 45", state: "closed", labels: [{ name: "pendulum:objective" }], created_at: "2026-11-17T01:00:00Z", user: ME });
  const ledger = [{ label: "work-1", model: "gpt-6.1-sol", effort: "medium", started: "2026-11-17T02:00:00Z", ended: "2026-11-17T02:10:00Z", usd: 0.1, usdUnknown: 0, usdUnknownWhy: [], billing: "api", usdByBilling: { api: 0.1 }, tokens: SOL }];
  w.comments.push({ id: (nextId += 1), issue_url: issueUrl(45), user: ME, author_association: "OWNER", created_at: "2026-11-17T02:00:00Z", updated_at: "2026-11-17T02:10:00Z", body: ["<!-- pendulum:45:progress:work:local-45 -->", "Pendulum work: started.", harnessMarker("codex", "gpt-6.1-sol", { worker: "gpt-6.1-sol", subagent: "gpt-6-luna", reviewer: null, labels: [] }), spendMarker(0.1, { usdByBilling: { api: 0.1 }, billing: "api" }), ledgerMarker(ledger, { model: "gpt-6.1-sol", version: PENDULUM_VERSION, published: ["gpt-6.1-sol", "gpt-6-luna"] })].join("\n") });
  w.pulls.push({ number: 1045, head: { ref: "pendulum/45", repo: { id: 1 } }, base: { repo: { id: 1 } }, created_at: "2026-11-17T02:05:00Z", merged_at: "2026-11-17T02:20:00Z", state: "closed" });
  const { json: r } = await report(w, ["--issue", "41,45", "--rates", "gpt-6-luna"]);
  assert.deepEqual(
    r.rates.skipped.map((x) => [x.model, x.candidate, x.why]),
    [
      ["gpt-6.1-sol", null, "sub-agents"],
      ["gpt-6-luna", null, "sub-agents"],
    ],
  );
  // #41's gpt-6-sol stage ran no sub-agent model of its own, so its ratio stands.
  assert.deepEqual(r.rates.items.map((x) => [x.model, x.candidate]), [["gpt-6-sol", "gpt-6-luna"]]);
});

/** The two passes of a review stage: its review on the reviewer's model, its answer on the worker's. */
const REVIEWER = "gpt-6.1-sol";
const WORKER = "gpt-6-sol";
const REVIEW_T = { input: 150_000, output: 6_000, cached: 90_000, written: 10_000 };
const ANSWER_T = { input: 240_000, output: 18_000, cached: 200_000, written: 30_000 };
const pass = (label, model, tokens, at) => ({ label, model, effort: "medium", started: `2026-11-17T02:0${at}:00Z`, ended: `2026-11-17T02:0${at + 1}:00Z`, usd: 0.1, usdUnknown: 0, usdUnknownWhy: [], billing: "api", usdByBilling: { api: 0.1 }, tokens });
const plus = (...ts) => Object.fromEntries(["input", "output", "cached", "written"].map((k) => [k, ts.reduce((n, t) => n + t[k], 0)]));
const less = (a, b) => Object.fromEntries(["input", "output", "cached", "written"].map((k) => [k, a[k] - b[k]]));

/**
 * Objective `n`'s one Codex stage (a review on REVIEWER by default), its harness line naming its `model` and the
 * Objective's three models; `extra` its other lines.
 */
function reviewStage(w, n, { kind = "review", model = REVIEWER, subagent = null, user = ME, key = `local-${n}`, extra = [] } = {}) {
  w.issues.push({ number: n, title: `Objective ${n}`, state: "closed", labels: [{ name: "pendulum:objective" }], created_at: "2026-11-17T01:00:00Z", user: ME });
  const bot = user === BOT ? { performed_via_github_app: { id: 2271, slug: "clockgrove-pendulum" }, author_association: "CONTRIBUTOR" } : { author_association: "OWNER" };
  w.comments.push({ id: (nextId += 1), issue_url: issueUrl(n), user, ...bot, created_at: "2026-11-17T02:00:00Z", updated_at: "2026-11-17T02:10:00Z", body: [`<!-- pendulum:${n}:progress:${kind}:${key} -->`, `Pendulum ${kind}: started.`, harnessMarker("codex", model, { worker: WORKER, subagent, reviewer: REVIEWER, labels: [] }), ...extra].join("\n") });
  w.pulls.push({ number: n + 1000, head: { ref: `pendulum/${n}`, repo: { id: 1 } }, base: { repo: { id: 1 } }, created_at: "2026-11-17T02:05:00Z", merged_at: "2026-11-17T02:20:00Z", state: "closed" });
}
const empty = () => ({ issues: [], comments: [], pulls: [], artifacts: {} });
/** Each model's recorded mix in a report's rate ratios, and the ratio of `cand` to it. */
const mixOf = (r, model) => r.rates.items.find((x) => x.model === model)?.mix;
const ratioOf = (r, model, cand) => r.rates.items.find((x) => x.model === model && x.candidate === cand)?.ratio;
const partsOf = (t) => ({ uncached: t.input - t.cached - t.written, cached: t.cached, written: t.written, output: t.output });
/**
 * `model`'s ratio of `cand` in report `r` is the ratio of the two models' dollars on tokens `t` alone: exact against the
 * table's rates (every input here is under the long-context threshold), and codexPrice's to its rounding.
 */
function priceRatio(r, model, cand, t) {
  const got = ratioOf(r, model, cand);
  assert.equal(got, r6(weightOf(cand, t) / weightOf(model, t)), `${model} to ${cand}`);
  // codexPrice rounds each figure to a hundredth of a cent: the two ratios differ by no more than that rounding allows.
  const own = codexPrice(TABLE, model, t, { at: NOW }).usd;
  assert.ok(Math.abs(got - priced(cand, model, t)) <= (0.0001 * (1 + got)) / own, `${model} to ${cand}: codexPrice's ratio`);
}

test("report --rates: a review stage's passes on two models are split by its ledger line: each model's mix is its own passes', each ratio codexPrice's on them alone", async () => {
  const w = empty();
  const ledger = [pass("review", REVIEWER, REVIEW_T, 0), pass("answer", WORKER, ANSWER_T, 2)];
  reviewStage(w, 46, { extra: [spendMarker(0.2, { usdByBilling: { api: 0.2 }, billing: "api" }), ledgerMarker(ledger, { model: REVIEWER, version: PENDULUM_VERSION, published: [WORKER, REVIEWER] })] });
  const { json: r } = await report(w, ["--issue", "46", "--rates", "gpt-6.1-terra"]);
  assert.deepEqual(r.rates.skipped, []);
  assert.deepEqual(mixOf(r, REVIEWER), partsOf(REVIEW_T));
  assert.deepEqual(mixOf(r, WORKER), partsOf(ANSWER_T));
  priceRatio(r, REVIEWER, "gpt-6.1-terra", REVIEW_T);
  priceRatio(r, WORKER, "gpt-6.1-terra", ANSWER_T);
  // The model breakdown books each pass's dollars and tokens under its own model (#568); the stage counts once, under its own.
  assert.deepEqual(r.breakdowns.model.map((x) => [x.key, x.stages, x.cost.usd.api, x.tokens]), [[REVIEWER, 1, 0.1, REVIEW_T], [WORKER, 0, 0.1, ANSWER_T]]);
  // With a sub-agent model and no record to split its threads out, the answer pass's tokens may hold them: the worker's
  // model and the sub-agent model get no ratio; the review pass's model keeps its own.
  const subbed = empty();
  reviewStage(subbed, 46, { subagent: "gpt-6-luna", extra: [spendMarker(0.2, { usdByBilling: { api: 0.2 }, billing: "api" }), ledgerMarker(ledger, { model: REVIEWER, version: PENDULUM_VERSION, published: [WORKER, "gpt-6-luna", REVIEWER] })] });
  const { json: s } = await report(subbed, ["--issue", "46", "--rates", "gpt-6.1-terra"]);
  assert.deepEqual(s.rates.skipped.map((x) => [x.model, x.why]), [[WORKER, "sub-agents"], ["gpt-6-luna", "sub-agents"]]);
  priceRatio(s, REVIEWER, "gpt-6.1-terra", REVIEW_T);
});

test("report --rates: a Codex review stage's usage record splits the same way, each sub-agent thread out of the pass it ran in and under its own model", async () => {
  const w = empty();
  const THREAD = { input: 40_000, output: 3_000, cached: 30_000, written: 5_000 };
  const run = (nextId += 1);
  reviewStage(w, 47, { subagent: "gpt-6-luna", user: BOT, key: String(run) });
  // The answer pass's tokens hold its thread's share (codex-threads.mjs withSubAgents), as its record's do.
  const record = { harness: "codex", model: REVIEWER, usd: 0.2, usdByBilling: { api: 0.2 }, billing: "api", runs: 1, exit: "delivered", progressRun: String(run), started: "2026-11-17T02:00:00Z", ended: "2026-11-17T02:10:00Z", tokens: plus(REVIEW_T, ANSWER_T), subAgents: [{ id: "t1", model: "gpt-6-luna", tokens: THREAD, run: "answer" }], ledger: [pass("review", REVIEWER, REVIEW_T, 0), pass("answer", WORKER, ANSWER_T, 2)] };
  w.artifacts["pendulum-usage-47-review"] = [{ id: run, name: "pendulum-usage-47-review", expired: false, created_at: "2026-11-17T02:10:00Z", workflow_run: { id: run, repository_id: 1, head_repository_id: 1 }, record }];
  const { json: r } = await report(w, ["--issue", "47", "--rates", "gpt-6.1-terra"]);
  assert.deepEqual(r.rates.skipped, []);
  assert.deepEqual(mixOf(r, REVIEWER), partsOf(REVIEW_T));
  assert.deepEqual(mixOf(r, WORKER), partsOf(less(ANSWER_T, THREAD)));
  assert.deepEqual(mixOf(r, "gpt-6-luna"), partsOf(THREAD));
  priceRatio(r, REVIEWER, "gpt-6.1-terra", REVIEW_T);
  priceRatio(r, WORKER, "gpt-6.1-terra", less(ANSWER_T, THREAD));
  priceRatio(r, "gpt-6-luna", "gpt-6.1-terra", THREAD);
});

test("report --rates: a review stage whose passes' models no ledger names gives its model and the worker's no ratio (`pass-models`)", async () => {
  // A usage record with no ledger, and a ledger line that names the review pass's model alone.
  const w = empty();
  const run = (nextId += 1);
  reviewStage(w, 48, { user: BOT, key: String(run) });
  const record = { harness: "codex", model: REVIEWER, usd: 0.2, usdByBilling: { api: 0.2 }, billing: "api", runs: 1, exit: "delivered", progressRun: String(run), started: "2026-11-17T02:00:00Z", ended: "2026-11-17T02:10:00Z", tokens: plus(REVIEW_T, ANSWER_T) };
  w.artifacts["pendulum-usage-48-review"] = [{ id: run, name: "pendulum-usage-48-review", expired: false, created_at: "2026-11-17T02:10:00Z", workflow_run: { id: run, repository_id: 1, head_repository_id: 1 }, record }];
  reviewStage(w, 49, { extra: [spendMarker(0.2, { usdByBilling: { api: 0.2 }, billing: "api" }), ledgerMarker([pass("review", REVIEWER, REVIEW_T, 0), pass("answer", WORKER, ANSWER_T, 2)], { model: REVIEWER, version: PENDULUM_VERSION, published: [REVIEWER] })] });
  for (const n of ["48", "49"]) {
    const { json: r } = await report(w, ["--issue", n, "--rates", "gpt-6.1-terra"]);
    assert.deepEqual(r.rates.items, [], n);
    // #569 V11: nothing could be weighed, and the report says so in a field of its own, and in the Markdown.
    assert.equal(r.rates.usable, false, n);
    assert.match(renderReport(r), /^No ratio could be weighed: each model and candidate below says why\.$/m, n);
    assert.deepEqual(r.rates.skipped.map((x) => [x.model, x.why]).sort(), [[WORKER, "pass-models"], [REVIEWER, "pass-models"]].sort(), n);
  }
});

test("report --rates: a stage's decision records are in no model's mix, from its ledger line or its usage record", async () => {
  const DECIDED = { input: 30_000, output: 2_000, cached: 0, written: 0 };
  const ledger = [pass("work-1", WORKER, ANSWER_T, 0), { ...pass("triage", "gpt-6-luna", DECIDED, 2), decision: true, calls: 2 }];
  const w = empty();
  reviewStage(w, 50, { kind: "work", model: WORKER, extra: [spendMarker(0.2, { usdByBilling: { api: 0.2 }, billing: "api" }), ledgerMarker(ledger, { model: WORKER, version: PENDULUM_VERSION, published: [WORKER, "gpt-6-luna", REVIEWER] })] });
  // The same stage on Actions: its record's tokens hold its decision record's (session.mjs writeUsage).
  const run = (nextId += 1);
  reviewStage(w, 51, { kind: "work", model: WORKER, user: BOT, key: String(run) });
  const record = { harness: "codex", model: WORKER, usd: 0.2, usdByBilling: { api: 0.2 }, billing: "api", runs: 1, exit: "delivered", progressRun: String(run), started: "2026-11-17T02:00:00Z", ended: "2026-11-17T02:10:00Z", tokens: plus(ANSWER_T, DECIDED), ledger };
  w.artifacts["pendulum-usage-51"] = [{ id: run, name: "pendulum-usage-51", expired: false, created_at: "2026-11-17T02:10:00Z", workflow_run: { id: run, repository_id: 1, head_repository_id: 1 }, record }];
  for (const n of ["50", "51"]) {
    const { json: r } = await report(w, ["--issue", n, "--rates", "gpt-6.1-terra"]);
    assert.deepEqual(r.rates.skipped, [], n);
    assert.deepEqual(r.rates.items.map((x) => x.model), [WORKER], n);
    assert.deepEqual(mixOf(r, WORKER), partsOf(ANSWER_T), n);
    priceRatio(r, WORKER, "gpt-6.1-terra", ANSWER_T);
  }
});

test("report --rates: a stage whose ledger names another model than its harness line is under the ledger's model; an alias of its own is its own, named by the table's row", async () => {
  const w = empty();
  // The harness line names the worker's model; every pass of its ledger ran on another.
  reviewStage(w, 52, { kind: "work", model: WORKER, extra: [spendMarker(0.1, { usdByBilling: { api: 0.1 }, billing: "api" }), ledgerMarker([pass("work-1", REVIEWER, ANSWER_T, 0)], { model: WORKER, version: PENDULUM_VERSION, published: [WORKER, REVIEWER] })] });
  const { json: r } = await report(w, ["--issue", "52", "--rates", "gpt-6.1-terra"]);
  assert.deepEqual(r.rates.skipped, []);
  assert.deepEqual(r.rates.items.map((x) => x.model), [REVIEWER]);
  assert.deepEqual(mixOf(r, REVIEWER), partsOf(ANSWER_T));
  priceRatio(r, REVIEWER, "gpt-6.1-terra", ANSWER_T);
  // A ledger naming the price table's row of the harness line's alias (gpt-5.6 is gpt-5.6-sol): one model, under the
  // row's id (report.mjs modelName).
  const alias = empty();
  reviewStage(alias, 53, { kind: "work", model: "gpt-5.6", extra: [spendMarker(0.1, { usdByBilling: { api: 0.1 }, billing: "api" }), ledgerMarker([pass("work-1", "gpt-5.6-sol", ANSWER_T, 0)], { model: "gpt-5.6", version: PENDULUM_VERSION, published: ["gpt-5.6", "gpt-5.6-sol"] })] });
  const { json: a } = await report(alias, ["--issue", "53", "--rates", "gpt-6.1-terra"]);
  assert.deepEqual([...new Set([...a.rates.items, ...a.rates.skipped].map((x) => x.model).filter(Boolean))], ["gpt-5.6-sol"]);
});

test("report --rates: the command line takes model ids only", () => {
  assert.equal(reportCheck({ rates: ["gpt-6.1-terra,gpt-6-luna"] }), null);
  assert.match(reportCheck({ rates: ["gpt 6"] }), /^--rates takes model ids/);
  assert.match(reportCheck({ rates: [","] }), /^--rates takes model ids/);
  assert.throws(() => parseArgs(["report", "--rates", "$5"]), /--rates takes model ids/);
});

test("the report skill's proposals: on request only, a named model's judgement citing its rows, no counterfactual dollars, every command real", () => {
  const skill = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8");
  const page = readFileSync(join(SKILL_DIR, "proposals.md"), "utf8");
  // The skill reaches the page only when the user asks.
  assert.match(skill, /Only when the user asks[^\n]*\[proposals\.md\]\(proposals\.md\)/);
  for (const rule of [
    // Never a counterfactual dollar figure, in any form, and a ratio only as the report gives it.
    "**No counterfactual dollars, ever.**",
    "Never write what a model, an effort or a setting would have cost, saved or spent",
    "A rate ratio only from `rates.items`",
    "never across vendors",
    // Every figure cites its row; the output is marked as a judgement and names its model.
    "Cite every figure by the exact JSON path of the row it came from",
    "a figure with no row cited is left out",
    "Proposals: a judgement by <model>, not a figure of Pendulum's. Rows read:",
    "`claude-fable-5-2`",
    // Nothing runs unattended, and hot spots stay ranked facts.
    "or would cost, save or spend",
    'never as a percentage, "cheaper" or a saving',
    // Nothing runs unattended, and hot spots stay ranked facts. The session runs only the report, which reads; the
    // sub-agent that writes the proposals runs nothing.
    "Run nothing but `pendulum report` itself, which only reads",
    "You, the session, run every `pendulum report` the proposals read first",
    "the sub-agent runs nothing",
    "no threshold",
    // The replay is Claude Code's alone, on Pendulum's own set; candidates are the price table's rows.
    "the replay runs Claude Code only, on that set",
    "`<plugin root>/scripts/lib/codex-prices.json`",
  ]) assert.ok(page.includes(rule), `proposals.md says: ${rule}`);
  // Every A/B label the page names is one USAGE.md's label table sets, and it names each of them with what it sets.
  const usage = readFileSync(join(import.meta.dirname, "..", "..", "docs", "USAGE.md"), "utf8");
  const labels = [...usage.matchAll(/^\| `(pendulum:(?:harness|model|subagent-model|reviewer-model):<[a-z]+>)`/gm)].map((m) => m[1]);
  assert.deepEqual(labels.sort(), ["pendulum:harness:<name>", "pendulum:model:<id>", "pendulum:reviewer-model:<id>", "pendulum:subagent-model:<id>"]);
  for (const l of labels) assert.match(page, new RegExp(`^\\s+- \`${l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\`: .+\\(\`PENDULUM_[A-Z_]+\``, "m"), `proposals.md lists ${l} with what it sets`);
  for (const [l] of page.matchAll(/pendulum:(?:harness|model|subagent-model|reviewer-model|effort):<[a-z]+>/g)) assert.ok(labels.includes(l), `${l} is a label USAGE.md names`);
  // The four parts, in order.
  const parts = ["**Observation**", "**Hypothesis**", "**Experiment**", "**Command**"].map((p) => page.indexOf(p));
  assert.ok(parts.every((i, k) => i > 0 && (k === 0 || i > parts[k - 1])), "observation, hypothesis, experiment, command in order");
  // Every `pendulum report` flag the page names is one the command takes, and each bench script it names exists with the
  // flags it gives (bench/skills.mjs --check holds the paths to the checkout).
  const flags = Object.keys(COMMANDS.report.flags);
  for (const [line] of page.matchAll(/`pendulum report[^`]*`/g)) for (const [, f] of line.matchAll(/--([a-z-]+)/g)) assert.ok(flags.includes(f), `pendulum report --${f}`);
  for (const [line, script] of page.matchAll(/`node <pendulum clone>\/bench\/([a-z-]+\.mjs)[^`]*`/g)) {
    const src = readFileSync(join(import.meta.dirname, "..", "..", "bench", script), "utf8");
    for (const [, f] of line.matchAll(/--([a-z-]+)/g)) assert.match(src, new RegExp(`[{,\\s]"?${f}"?: \\{ type:`), `${script} --${f}`);
  }
  assert.ok(page.includes("bench/review-replay.mjs") && page.includes("bench/drill.mjs") && page.includes("pendulum:experiment:") && page.includes("pendulum report --compare"));
});
