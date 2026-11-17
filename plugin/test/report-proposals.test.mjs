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

// Model-usage proposals (#547): `pendulum report --rates` computes the only cross-model figure Pendulum gives, a ratio of
// one vendor's published rates on the recorded token mix, with no dollar unit; the report skill's proposals mode writes
// the prose, as a named model's judgement citing the rows it read.

RETRY.sleep = async () => {};

const REPO = { owner: "acme", name: "app", full: "acme/app" };
const ME = { login: "kirkmarple-clockgrove", id: 1, type: "User" };
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
    if (p === "/actions/artifacts") return json({ total_count: 0, artifacts: [] });
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
      const code = await reportCommand(parsed.flags, { out: (t) => (out += t), err: () => {}, token: "t", download: async () => null, now: NOW });
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

const SOL = { input: 1_000_000, output: 50_000, cached: 600_000, written: 100_000 };
const world = () => {
  const w = { issues: [], comments: [], pulls: [] };
  objective(w, 41, { h: "codex", model: "gpt-6-sol", usd: 1.47, billing: "api", tokens: SOL });
  objective(w, 42, { h: "claude", model: "claude-opus-5-5", usd: 2.5, billing: "subscription", tokens: { input: 900_000, output: 40_000, cached: 700_000, written: 150_000 } });
  return w;
};

test("report --rates: each ratio is exact against the published table, within one vendor, and carries no dollar figure", async () => {
  const { code, json: r, md } = await report(world(), ["--issue", "41,42", "--rates", "gpt-6.1-terra,claude-fable-5-2", "--rates", "gpt-6-luna"]);
  assert.equal(code, 0);
  assert.equal(r.rates.words, RATIO_WORDS);
  assert.match(RATIO_WORDS, /^ratio of published rates on the recorded token mix \(no dollar unit\)$/);
  assert.deepEqual(r.rates.candidates, ["gpt-6.1-terra", "claude-fable-5-2", "gpt-6-luna"]);
  // The recorded mix is the model row's tokens; each ratio is the candidate's rates over the model's own, on that mix.
  const row = r.breakdowns.model.find((x) => x.key === "gpt-6-sol");
  assert.deepEqual(row.tokens, SOL);
  const base = weightOf("gpt-6-sol", SOL);
  assert.deepEqual(
    r.rates.items.map((x) => [x.model, x.candidate, x.vendor, x.ratio]),
    [
      ["gpt-6-sol", "gpt-6.1-terra", "openai", Math.round((weightOf("gpt-6.1-terra", SOL) / base) * 1e6) / 1e6],
      ["gpt-6-sol", "gpt-6-luna", "openai", Math.round((weightOf("gpt-6-luna", SOL) / base) * 1e6) / 1e6],
    ],
  );
  // By hand from the table: sol 300k x 2 + 600k x 0.2 + 100k x 2.5 + 50k x 10 = 1.47M; luna 30k + 6k + 12.5k + 25k = 73.5k.
  assert.equal(r.rates.items[1].ratio, 0.05);
  assert.deepEqual(r.rates.items[0].mix, { uncached: 300_000, cached: 600_000, written: 100_000, output: 50_000 });
  assert.match(r.rates.basis, new RegExp(`^openai's published standard rates \\(no long-context tier\\) from codex-prices\\.json dated ${TABLE.date}$`));
  // Never across vendors: an Anthropic model has no published table of Pendulum's, as a candidate or as the recorded model.
  assert.deepEqual(
    r.rates.skipped.map((s) => [s.model, s.candidate, s.why]),
    [
      [null, "claude-fable-5-2", "no-rate-table"],
      ["claude-opus-5-5", null, "no-rate-table"],
    ],
  );
  assert.ok(!r.rates.items.some((x) => /claude/.test(`${x.model} ${x.candidate}`)));
  // No dollar figure: no `usd` field, no dollar sign, in the JSON or in the Markdown section.
  assert.ok(!/usd|\$/i.test(JSON.stringify(r.rates)), JSON.stringify(r.rates));
  const section = md.slice(md.indexOf("## Rate ratios"), md.indexOf("## Source"));
  assert.ok(section.includes(RATIO_WORDS) && section.includes("| gpt-6-sol | gpt-6-luna | 0.05× |"), section);
  assert.ok(!section.includes("$"), section);
  // Without --rates, none.
  assert.equal((await report(world(), ["--issue", "41"])).json.rates, null);
});

test("rateRatios: a pair of two vendors' models gets no ratio, a promotional rate that ended gives none, and no tokens none", () => {
  const prices = TABLE;
  // A second vendor's table, so the rule is tested where it could break: its models are never weighed against OpenAI's.
  const other = { vendor: "anthropic", file: "test-table.json", table: { date: "2026-11-17", perMillion: { "claude-opus-5-5": { input: 5, cached: 0.5, write: 6.25, output: 25 }, "claude-sonnet-5-5": { input: 3, cached: 0.3, write: 3.75, output: 15 } } } };
  const tables = [...rateTables(prices), other];
  const rows = [
    { key: "gpt-6-sol", tokens: SOL },
    { key: "claude-opus-5-5", tokens: { input: 1000, output: 100, cached: 0, written: 0 } },
    { key: "gpt-6.1-terra", tokens: { input: null, output: null, cached: null, written: null } },
    { key: null, tokens: SOL },
    { key: "decisions", tokens: SOL },
  ];
  const r = rateRatios(rows, ["gpt-6.1-terra", "claude-sonnet-5-5", "gpt-5.6-sol"], tables, { at: "2026-12-01T00:00:00Z" });
  assert.deepEqual(
    r.items.map((x) => [x.model, x.candidate, x.vendor]),
    [
      ["gpt-6-sol", "gpt-6.1-terra", "openai"],
      ["claude-opus-5-5", "claude-sonnet-5-5", "anthropic"],
    ],
  );
  assert.equal(r.items[1].ratio, Math.round(((1000 * 3 + 100 * 15) / (1000 * 5 + 100 * 25)) * 1e6) / 1e6);
  assert.deepEqual(
    r.skipped.map((s) => [s.model, s.candidate, s.why]),
    [
      [null, "gpt-5.6-sol", "price-ended"],
      ["gpt-6-sol", "claude-sonnet-5-5", "other-vendor"],
      ["claude-opus-5-5", "gpt-6.1-terra", "other-vendor"],
      ["gpt-6.1-terra", null, "no-tokens"],
    ],
  );
  for (const s of r.skipped) assert.equal(typeof s.text, "string");
  assert.ok(!/usd|\$/i.test(JSON.stringify(r)));
  // Before its end the promotional rate is the published one.
  assert.deepEqual(
    rateRatios(rows.slice(0, 1), ["gpt-5.6-sol"], tables, { at: "2026-11-17T00:00:00Z" }).items.map((x) => [x.candidate, x.ratio]),
    [["gpt-5.6-sol", Math.round((weightOf("gpt-5.6-sol", SOL) / weightOf("gpt-6-sol", SOL)) * 1e6) / 1e6]],
  );
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
    "Run nothing",
    "no threshold",
  ]) assert.ok(page.includes(rule), `proposals.md says: ${rule}`);
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
