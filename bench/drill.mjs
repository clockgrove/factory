#!/usr/bin/env node
/**
 * `node bench/drill.mjs --repo OWNER/NAME --count N`: the adopter drill. Files N small,
 * fresh Objectives on a scratch repository (each a one-function addition over the
 * repository's `greet`, named uniquely), lets the Action take them (the opened-issue tick,
 * or `--dispatch` to fire one manually), waits until every one is closed or Blocked, then
 * scores them with bench/score.mjs. Exit 0 when every Objective merged with no human
 * input; 1 otherwise; 64 usage. What took a night by hand on Nov 2 runs in ~15 minutes.
 *
 *   --repo OWNER/NAME        the scratch adopter (never Factory's own repository, never a product repository)
 *   --set small|medium|conflict  small: one-function additions over greet (default); conflict: two
 *                            small Objectives that must both add a line at the end of README.md's
 *                            API list, so the second to merge conflicts and is sent back to rebase;
 *                            medium: the fixed
 *                            five-Objective set over the notes CLI (a format, a command, a column with
 *                            its migration, a rule, a tagged similarity search), each several files with
 *                            unit and database tests, suffixed so repeated runs never collide
 *   --count N                Objectives to file (default 2 for small, 5 for medium)
 *   --dispatch               fire `gh workflow run factory.yml` after filing (when the opened tick is not trusted)
 *   --local                  also label each Objective factory:local, so a local loop (plugin/scripts/local.mjs serve)
 *                            takes it and the Actions path leaves it alone
 *   --wait-minutes N         give up after N minutes (default 40)
 *   --type NAME              the native issue type to set (default Feature; "" to skip)
 *   --usage DIR              where to download the usage artifacts for scoring (default a temp dir)
 *   --out FILE               the drill's JSON report (default stdout)
 */
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { promisify } from "node:util";

const run = promisify(execFile);
const here = resolve(new URL(".", import.meta.url).pathname);
const { values } = parseArgs({
  options: { repo: { type: "string" }, set: { type: "string" }, count: { type: "string" }, dispatch: { type: "boolean" }, local: { type: "boolean" }, "wait-minutes": { type: "string" }, type: { type: "string" }, usage: { type: "string" }, out: { type: "string" } },
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
/** The medium set: five Objectives of real size over the notes CLI, each adding files at a discovered extension point. */
const MEDIUM = [
  (sfx) => ({
    title: `Add the ${sfx} export format to notes list`,
    body: `## Goal
A caller can list notes as plain lines: \`notes list --format ${sfx}\` prints one line per note.

## Acceptance
- \`src/export/${sfx}.mjs\` exports \`format(rows)\`: one line per note, \`<id><TAB><title><TAB><tags joined by ;>\`, lines joined by newlines, no trailing newline, an empty list giving an empty string.
- \`notes list --format ${sfx}\` reaches it through discovery; no discovery module changes.
- \`test/${sfx}.export.test.mjs\` proves two rows and the empty list with exact values under \`node:test\`.
- \`test/db/${sfx}.db.test.mjs\` adds two notes on a fresh schema (\`test/db/helpers.mjs\`) and proves the format over \`list()\`.
- \`npm run check\`, \`npm test\` and \`npm run test:db\` pass; no other file changes.

## Sources
- \`src/export/json.mjs\`, \`src/export/table.mjs\`, \`test/export.test.mjs\`, \`test/db/notes.db.test.mjs\` (the patterns)
- \`AGENTS.md\`

## Context
Filed by the Factory adopter drill (bench/drill.mjs, medium set) at ${new Date().toISOString()}. Recorded decision: tags are joined by a semicolon with no spaces; the tab is U+0009; titles and tags are printed as stored, with no escaping.
`,
  }),
  (sfx) => ({
    title: `Add the ${sfx} command: the newest titles in one line`,
    body: `## Goal
A caller can see the newest note titles at a glance: \`notes ${sfx} --limit N\` prints the N most recent titles in one line.

## Acceptance
- \`src/commands/${sfx}.mjs\` exports \`run(client, args)\`: parses \`--limit\` with \`node:util\` \`parseArgs\` (default 5), returns the newest N titles joined by \` | \` (space, bar, space), newest first; an empty store returns an empty string.
- A \`--limit\` that is not a positive integer throws an error with \`code\` \`BAD_ARGS\`.
- \`test/${sfx}.command.test.mjs\` proves the \`BAD_ARGS\` case without a database under \`node:test\`.
- \`test/db/${sfx}.db.test.mjs\` adds three notes on a fresh schema and proves order and the limit with exact values.
- \`npm run check\`, \`npm test\` and \`npm run test:db\` pass; no other file changes.

## Sources
- \`src/commands/list.mjs\`, \`src/commands/remove.mjs\`, \`src/notes.mjs\`, \`test/db/notes.db.test.mjs\` (the patterns)
- \`AGENTS.md\`

## Context
Filed by the Factory adopter drill (bench/drill.mjs, medium set) at ${new Date().toISOString()}. Recorded decision: the separator is exactly one space, one vertical bar, one space; \`list()\` from \`src/notes.mjs\` supplies the rows.
`,
  }),
  (sfx) => ({
    title: `Add a ${sfx}_count column with a bump-${sfx} command`,
    body: `## Goal
A note can carry a counter: \`notes bump-${sfx} <id>\` increments it and prints the new value.

## Acceptance
- A new migration \`migrations/${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}_${sfx}.sql\` adds \`${sfx}_count INTEGER NOT NULL DEFAULT 0\` to \`notes\`; no existing migration changes.
- \`src/commands/bump-${sfx}.mjs\` exports \`run(client, args)\`: increments \`${sfx}_count\` for the note whose id is \`args[0]\` and returns \`#<id> ${sfx}_count=<new value>\`; a missing or non-integer id throws with \`code\` \`BAD_ID\`; an unknown id returns \`no note #<id>\`.
- \`test/db/${sfx}.db.test.mjs\` proves on a fresh schema: a new note starts at 0, two bumps give 2, an unknown id gives the no-note line, and the BAD_ID case.
- \`npm run check\`, \`npm test\` and \`npm run test:db\` pass; no other file changes.

## Sources
- \`migrations/20261106000000_notes.sql\`, \`src/db.mjs\`, \`src/commands/remove.mjs\`, \`test/db/helpers.mjs\` (the patterns)
- \`AGENTS.md\`

## Context
Filed by the Factory adopter drill (bench/drill.mjs, medium set) at ${new Date().toISOString()}. Recorded decision: the counter is a plain integer column with no upper bound; the migration name's timestamp prefix is the one given above.
`,
  }),
  (sfx) => ({
    title: `Add the ${sfx} rule: titles may not contain the word ${sfx}`,
    body: `## Goal
A note whose title contains the word \`${sfx}\` is refused at \`notes add\`.

## Acceptance
- \`src/rules/${sfx}.mjs\` exports \`code\` \`${sfx.toUpperCase()}\` and \`check(note)\`: returns \`title contains ${sfx}\` when the title contains \`${sfx}\` as a whitespace-separated word, case-insensitive, else null; a longer word that contains it passes.
- \`test/${sfx}.rule.test.mjs\` proves the word, the word in another case, a longer word containing it, and a missing title under \`node:test\` without a database.
- \`test/db/${sfx}.db.test.mjs\` proves on a fresh schema that \`add()\` rejects a title containing the word with that code and accepts one without it.
- \`npm run check\`, \`npm test\` and \`npm run test:db\` pass; no other file changes.

## Sources
- \`src/rules/title-required.mjs\`, \`src/rules.mjs\`, \`test/db/notes.db.test.mjs\` (the patterns)
- \`AGENTS.md\`

## Context
Filed by the Factory adopter drill (bench/drill.mjs, medium set) at ${new Date().toISOString()}. Recorded decision: a missing title is the title-required rule's business, so \`check\` returns null for a non-string title.
`,
  }),
  (sfx) => ({
    title: `Add the ${sfx} command: similarity search within a tag`,
    body: `## Goal
A caller can find the nearest notes among those carrying a tag: \`notes ${sfx} --tag T --embedding 1,2,3 [--k N]\`.

## Acceptance
- \`src/commands/${sfx}.mjs\` exports \`run(client, args)\`: queries the \`k\` notes carrying \`tag\` with an embedding itself, nearest first by Euclidean distance then by id, without changing \`src/notes.mjs\`; parses \`--tag\`, \`--embedding\` and \`--k\` (default 3) with \`parseArgs\`, prints one line per result as \`#<id> <title> (<distance to 3 decimals>)\`; a missing \`--tag\` or \`--embedding\` throws with \`code\` \`BAD_ARGS\`.
- \`test/db/${sfx}.db.test.mjs\` proves on a fresh schema: a tagged near note comes first, an untagged nearer note is excluded, and \`k\` caps the rows.
- \`test/${sfx}.command.test.mjs\` proves the \`BAD_ARGS\` cases without a database.
- \`npm run check\`, \`npm test\` and \`npm run test:db\` pass; no other file changes.

## Sources
- \`src/notes.mjs\` (\`similar\`), \`src/commands/similar.mjs\`, \`test/db/notes.db.test.mjs\` (the patterns)
- \`AGENTS.md\`

## Context
Filed by the Factory adopter drill (bench/drill.mjs, medium set) at ${new Date().toISOString()}. Recorded decision: the tag filter is \`tag = ANY(tags)\`; distance is pgvector's \`<->\`.
`,
  }),
];
const objectives = Array.from({ length: count }, (_, i) => {
  if (set === "medium") {
    const o = MEDIUM[i % MEDIUM.length](`m${stamp}${i}`);
    return { title: o.title, body: o.body, fn: `m${stamp}${i}` };
  }
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
  const url = await gh("issue", "create", "-R", repo, "--title", o.title, "--body-file", file, "--label", "factory:objective", "--label", "P1", ...(values.local ? ["--label", "factory:local"] : []));
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
    else if (labels.includes("factory:question")) state.set(f.number, "question");
  }
  process.stderr.write(`${new Date().toISOString().slice(11, 19)} ${filed.map((f) => `#${f.number}:${state.get(f.number)}`).join(" ")}\n`);
}

/** Score with bench/score.mjs from the uploaded artifacts. */
const usageDir = values.usage ? resolve(values.usage) : mkdtempSync(join(tmpdir(), "factory-drill-usage-"));
for (const f of filed) {
  for (const a of [`factory-usage-${f.number}`, `factory-usage-${f.number}-review`]) {
    await run("gh", ["run", "download", "-R", repo, "-n", a, "-D", join(usageDir, String(f.number), a)]).catch(() => {});
  }
}
const scoreArgs = ["--repo", repo, ...filed.flatMap((f) => ["--issue", String(f.number)]), "--usage", usageDir, "--out", join(usageDir, "score.json")];
let rows = [];
try {
  await run("node", [join(here, "score.mjs"), ...scoreArgs], { maxBuffer: 64 * 1024 * 1024 });
  rows = JSON.parse((await import("node:fs")).readFileSync(join(usageDir, "score.json"), "utf8")).rows;
} catch (e) {
  process.stderr.write(`scoring failed: ${e.message.slice(0, 200)}\n`);
}
const report = {
  repo,
  filed,
  outcome: filed.map((f) => ({ number: f.number, state: state.get(f.number), row: rows.find((r) => r.issue === f.number) ?? null })),
  merged: filed.filter((f) => state.get(f.number) === "closed").length,
  walkAway: rows.filter((r) => r.walkAway?.value).length,
  usd: Math.round(rows.reduce((s, r) => s + (r.cost?.usd || 0), 0) * 100) / 100,
  wallMinutes: rows.map((r) => r.wallMinutes),
  finishedAt: new Date().toISOString(),
};
const text = `${JSON.stringify(report, null, 2)}\n`;
if (values.out) writeFileSync(values.out, text);
else process.stdout.write(text);
process.stderr.write(`drill: ${report.merged}/${filed.length} merged, ${report.walkAway} walk-away, $${report.usd}\n`);
process.exit(report.merged === filed.length && report.walkAway === filed.length ? 0 : 1);
