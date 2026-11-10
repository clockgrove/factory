#!/usr/bin/env node
/**
 * `node bench/drill.mjs --repo OWNER/NAME --count N`: the adopter drill. Files N small,
 * fresh Objectives on a scratch repository (each a one-function addition over the
 * repository's `greet`, named uniquely), lets the Action take them (the opened-issue tick,
 * or `--dispatch` to fire one manually), waits until every one is closed or Blocked, then
 * scores them with bench/score.mjs. Exit 0 when every Objective merged with no human
 * input; 1 otherwise; 64 usage.
 *
 *   --repo OWNER/NAME        the scratch adopter (never Factory's own repository, never a product repository)
 *   --set small|medium|conflict  small: one-function additions over greet (default); conflict: two
 *                            small Objectives that must both add a line at the end of README.md's
 *                            API list, so the second to merge conflicts and is sent back to rebase;
 *                            medium: the fixed
 *                            five-Objective set over the notes CLI (a format, a command, a column with
 *                            its migration, a rule, a tagged similarity search), each several files with
 *                            unit and database tests, suffixed so repeated runs never collide; every one changes
 *                            the scratch adopter alone
 *   --count N                Objectives to file (default 2 for small, 5 for medium)
 *   --dispatch               fire `gh workflow run factory.yml` after filing (when the opened tick is not trusted)
 *   --local                  also label each Objective factory:local, so a local loop (plugin/scripts/local.mjs serve)
 *                            takes it and the Actions path leaves it alone
 *   --local-dir CLONE        with --local: the developer clone the local loop runs from; its .factory/ usage
 *                            records are scored instead of Actions artifacts
 *   --wait-minutes N         give up after N minutes (default 40)
 *   --usage-wait-minutes N   after an Objective ends (merged, Blocked, Question), wait up to N minutes for the
 *                            usage artifact of each stage Factory ran (lib/collect.mjs usagePending; default 10),
 *                            then score it, naming any still missing in the report's `usageMissing`
 *   --stall-minutes N        passed to bench/score.mjs: a merge idle longer than N minutes after Factory's last
 *                            action is a stall, not a walk-away (default 60)
 *   --type NAME              the native issue type to set (default Feature; "" to skip)
 *   --usage DIR              where to download the usage artifacts for scoring (default a temp dir)
 *   --out FILE               the drill's JSON report (default stdout)
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { promisify } from "node:util";
import { awaitUsage } from "./lib/collect.mjs";
import { ghApi } from "./lib/gh.mjs";
import { mediumObjectives } from "./lib/medium.mjs";

const run = promisify(execFile);
const here = resolve(new URL(".", import.meta.url).pathname);
const { values } = parseArgs({
  options: { repo: { type: "string" }, set: { type: "string" }, count: { type: "string" }, dispatch: { type: "boolean" }, local: { type: "boolean" }, "local-dir": { type: "string" }, "wait-minutes": { type: "string" }, "usage-wait-minutes": { type: "string" }, "stall-minutes": { type: "string" }, type: { type: "string" }, usage: { type: "string" }, out: { type: "string" } },
});
const usage = (m) => {
  process.stderr.write(`${m}\nSee the header of bench/drill.mjs.\n`);
  process.exit(64);
};
if (!values.repo || !/^[^/]+\/[^/]+$/.test(values.repo)) usage("Give --repo OWNER/NAME");
if (/^clockgrove\/(factory|clockgrove)$/.test(values.repo)) usage("the drill runs only on a scratch repository");
const repo = values.repo;
const set = values.set ?? "small";
if (!["small", "medium", "conflict"].includes(set)) usage("--set is small, medium or conflict");
const count = Math.max(1, Number(values.count ?? (set === "medium" ? 5 : 2)));
const waitMs = Math.max(1, Number(values["wait-minutes"] ?? 40)) * 60_000;
const usageWaitMs = Math.max(0, Number(values["usage-wait-minutes"] ?? 10)) * 60_000;
if (!Number.isFinite(usageWaitMs)) usage("--usage-wait-minutes takes a number of minutes");
if (values["stall-minutes"] !== undefined && !(Number(values["stall-minutes"]) > 0)) usage("--stall-minutes takes a positive number of minutes");
const type = values.type ?? "Feature";
const gh = async (...args) => (await run("gh", args, { maxBuffer: 64 * 1024 * 1024 })).stdout.trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fresh, concrete Objectives: one function over `greet` each, named with a stamp so repeated drills never collide. */
const stamp = new Date().toISOString().slice(5, 16).replace(/[-:T]/g, "");
const SHAPES = [
  { fn: (s) => `twice${s}`, goal: "returns greet(name) repeated twice with one space between", ex1: "Hello, Ada. Hello, Ada.", ex2: "Hello. Hello.", decision: "the two copies are joined by exactly one space" },
  { fn: (s) => `bracket${s}`, goal: "returns greet(name) wrapped in square brackets", ex1: "[Hello, Ada.]", ex2: "[Hello.]", decision: "no space inside the brackets" },
  { fn: (s) => `shoutCount${s}`, goal: "returns the number of characters in greet(name) that are letters", ex1: "8", ex2: "5", decision: "only Unicode letters count; punctuation and spaces do not" },
  { fn: (s) => `last${s}`, goal: "returns the last word of greet(name) without its trailing period", ex1: "Ada", ex2: "Hello", decision: "a word is a whitespace-separated token" },
  { fn: (s) => `quote${s}`, goal: "returns greet(name) in double quotes", ex1: "\"Hello, Ada.\"", ex2: "\"Hello.\"", decision: "ASCII double quotes" },
  { fn: (s) => `star${s}`, goal: "returns greet(name) with every space replaced by an asterisk", ex1: "Hello,*Ada.", ex2: "Hello.", decision: "only U+0020 is replaced" },
];
const objectives = set === "medium" ? mediumObjectives(count, stamp) : Array.from({ length: count }, (_, i) => {
  const shape = SHAPES[i % SHAPES.length];
  const fn = shape.fn(`${stamp}${i}`);
  if (set === "conflict") {
    const body = `## Goal
A caller can get a transformed greeting: \`${fn}(name)\` ${shape.goal}, and the README lists it.

## Acceptance
- \`src/${fn}.mjs\` exports \`${fn}(name)\` built on \`greet\` from \`src/greet.mjs\`: \`${fn}("Ada")\` is \`${shape.ex1}\`; \`${fn}("")\` is \`${shape.ex2}\`.
- \`test/${fn}.test.mjs\` proves both cases with exact values under \`node:test\`, one \`test()\` per case.
- README.md's API list gains one bullet for \`${fn}(name)\` as its last item, in the same form as the bullets above it; no other README line changes.
- \`npm run check\` and \`npm test\` pass; no other file changes.

## Sources
- \`src/greet.mjs\`, \`test/greet.test.mjs\` and README.md's API list (the patterns)
- \`AGENTS.md\`

## Context
Filed by the Factory adopter drill (bench/drill.mjs, conflict set) at ${new Date().toISOString()}. Recorded decision: ${shape.decision}. Another Objective filed with this one adds its own bullet at the same place; keep both when they meet.
`;
    return { title: `Add ${fn}(name) over greet(name) and list it`, body, fn };
  }
  const body = `## Goal
A caller can get a transformed greeting: \`${fn}(name)\` ${shape.goal}.

## Acceptance
- \`src/${fn}.mjs\` exports \`${fn}(name)\` built on \`greet\` from \`src/greet.mjs\`: \`${fn}("Ada")\` is \`${shape.ex1}\`; \`${fn}("")\` is \`${shape.ex2}\`.
- \`test/${fn}.test.mjs\` proves both cases with exact values under \`node:test\`, one \`test()\` per case.
- \`npm run check\` and \`npm test\` pass; no other file changes (the README is left alone so parallel drill Objectives never conflict).

## Sources
- \`src/greet.mjs\` and \`test/greet.test.mjs\` (the pattern)
- \`AGENTS.md\`

## Context
Filed by the Factory adopter drill (bench/drill.mjs) at ${new Date().toISOString()}. Keep the change to the two files named above. Recorded decision: ${shape.decision}.
`;
  return { title: `Add ${fn}(name) over greet(name)`, body, fn };
});

async function setType(number) {
  if (!type) return;
  const [owner, name] = repo.split("/");
  const q = `{ repository(owner:"${owner}", name:"${name}") { issueTypes(first:20) { nodes { id name } } issue(number:${number}) { id } } }`;
  const d = JSON.parse(await gh("api", "graphql", "-f", `query=${q}`)).data.repository;
  const t = d.issueTypes.nodes.find((n) => n.name === type);
  if (!t) throw new Error(`no issue type ${type} on ${repo}`);
  await gh("api", "graphql", "-f", `query=mutation { updateIssue(input: { id: "${d.issue.id}", issueTypeId: "${t.id}" }) { issue { number } } }`);
}

const filed = [];
for (const o of objectives) {
  const dir = mkdtempSync(join(tmpdir(), "factory-drill-"));
  const file = join(dir, "body.md");
  writeFileSync(file, o.body);
  let url;
  try {
    url = await gh("issue", "create", "-R", repo, "--title", o.title, "--body-file", file, "--label", "factory:objective", "--label", "P1", ...(values.local ? ["--label", "factory:local"] : []));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const number = Number(url.split("/").pop());
  await setType(number);
  filed.push({ number, title: o.title, url, filedAt: new Date().toISOString() });
  process.stderr.write(`filed #${number} ${o.title}\n`);
}
if (values.dispatch) {
  await gh("workflow", "run", "factory.yml", "-R", repo);
  process.stderr.write("dispatched\n");
}

/** Wait until each issue is closed (merged) or Blocked (label) or the deadline passes. */
const deadline = Date.now() + waitMs;
const state = new Map(filed.map((f) => [f.number, "open"]));
while (Date.now() < deadline && [...state.values()].some((s) => s === "open")) {
  await sleep(30_000);
  for (const f of filed) {
    if (state.get(f.number) !== "open") continue;
    const v = JSON.parse(await gh("issue", "view", String(f.number), "-R", repo, "--json", "state,labels"));
    const labels = v.labels.map((l) => l.name);
    if (v.state === "CLOSED") state.set(f.number, "closed");
    else if (labels.includes("factory:blocked")) state.set(f.number, "blocked");
    else if (labels.includes("factory:question")) state.set(f.number, "question");
  }
  process.stderr.write(`${new Date().toISOString().slice(11, 19)} ${filed.map((f) => `#${f.number}:${state.get(f.number)}`).join(" ")}\n`);
}

/** Score with bench/score.mjs from the uploaded artifacts, or, for a local loop, from its usage records on the box. */
const usageDir = values.usage ? resolve(values.usage) : mkdtempSync(join(tmpdir(), "factory-drill-usage-"));
mkdirSync(usageDir, { recursive: true });
// A local loop uploads no artifacts: its records sit in <clone>/.factory/<issue>/usage-*/ (plugin/scripts/local.mjs).
const localDir = values.local && values["local-dir"] ? join(resolve(values["local-dir"]), ".factory") : null;
const localUsage = localDir && existsSync(localDir) ? localDir : localDir ? usageDir : null;
const usageMissing = {};
if (!localDir) {
  // An Objective that ended (merged, Blocked, Question) may still be uploading its last stage's usage: the label lands
  // first and the artifact seconds later (on the sandbox path, from a launcher run). Wait for every stage's artifact,
  // up to --usage-wait-minutes, then download what exists; what never came is named, and its row says it is missing.
  // An Objective still running at the deadline is not waited for, but what its finished stages uploaded is downloaded
  // and scored, and its running stage is named in usageMissing (`(still running)`): its dollars are a floor.
  const ended = filed.filter((f) => state.get(f.number) !== "open").map((f) => f.number);
  // Each artifact in its own directory (`<id>-<name>`), so two runs' artifacts of one name are both read.
  const fetch = async (issue, a) => {
    const dir = join(usageDir, String(issue), `${a.id}-${a.name}`);
    try {
      await run("gh", ["run", "download", String(a.workflow_run), "-R", repo, "-n", a.name, "-D", dir], { maxBuffer: 64 * 1024 * 1024 });
    } catch (e) {
      rmSync(dir, { recursive: true, force: true });
      throw e;
    }
  };
  Object.assign(usageMissing, (await awaitUsage(ghApi, repo, filed.map((f) => f.number), { ended, waitMs: usageWaitMs, sleep, fetch, log: (l) => process.stderr.write(`${l}\n`) })).missing);
}
const scoreArgs = ["--repo", repo, ...filed.flatMap((f) => ["--issue", String(f.number)]), "--usage", localUsage ?? usageDir, "--out", join(usageDir, "score.json"), ...(values["stall-minutes"] !== undefined ? ["--stall-minutes", values["stall-minutes"]] : [])];
let rows = [];
let scoring = null;
try {
  await run("node", [join(here, "score.mjs"), ...scoreArgs], { maxBuffer: 64 * 1024 * 1024 });
  rows = JSON.parse(readFileSync(join(usageDir, "score.json"), "utf8")).rows;
} catch (e) {
  scoring = `score.mjs failed: exit ${e.code ?? "?"}`;
  process.stderr.write(`scoring failed: ${String(e.stderr || e.message).slice(0, 300)}\n`);
}
const report = {
  repo,
  filed,
  outcome: filed.map((f) => ({ number: f.number, state: state.get(f.number), row: rows.find((r) => r.issue === f.number) ?? null })),
  merged: filed.filter((f) => state.get(f.number) === "closed").length,
  walkAway: rows.filter((r) => r.walkAway?.value).length,
  stalled: rows.filter((r) => r.walkAway?.stall).map((r) => ({ issue: r.issue, ...r.walkAway.stall })),
  usageMissing,
  scoring,
  usd: Math.round(rows.reduce((s, r) => s + (r.cost?.usd || 0), 0) * 100) / 100,
  wallMinutes: rows.map((r) => r.wallMinutes),
  finishedAt: new Date().toISOString(),
};
const text = `${JSON.stringify(report, null, 2)}\n`;
if (values.out) writeFileSync(values.out, text);
else process.stdout.write(text);
process.stderr.write(`drill: ${report.merged}/${filed.length} merged, ${report.walkAway} walk-away, ${report.stalled.length} stalled, $${report.usd}${Object.keys(usageMissing).length ? `; usage missing for ${Object.keys(usageMissing).map((n) => `#${n}`).join(", ")}` : ""}\n`);
process.exit(report.merged === filed.length && report.walkAway === filed.length ? 0 : 1);
