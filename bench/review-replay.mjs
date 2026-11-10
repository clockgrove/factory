#!/usr/bin/env node
/**
 * `node bench/review-replay.mjs`: replay the private review set with the 0.6 reviewer
 * (the review-pr skill as the pinned reviewer agent) and score its comments against the
 * set's labels. PLAN.md: no skill line changes without a replay-set run.
 *
 *   --set DIR               the replay set (records/, labels.json, seeded/, inputs/, plans/)
 *   --repo DIR              a clone of the reviewed repository holding every record's commits
 *                           (git fetch <set>/objects.bundle 'refs/*:refs/bundle/*')
 *   --plugin DIR            the plugin whose prompt, skills and agents are reviewed (default: ../plugin);
 *                           the scoring is always this checkout's, so an older plugin is a fair baseline
 *   --model NAME            the reviewer model (default: the plugin's pinned reviewer)
 *   --effort LEVEL          --effort for Claude (default: the reviewer_effort Factory passes)
 *   --seeded                add the seeded records (one planted defect each)
 *   --only ID ...           only these records
 *   --concurrency N         reviews at once (default 2)
 *   --timeout-minutes N     each review's bound (default 20)
 *   --label NAME            the results' name (default: 06-<model>)
 *   --fresh                 review again what earlier results hold
 *
 * A record is one Work Item's candidate (base..commit) with its acceptance criteria. The
 * reviewer gets the Objective's goal, the criteria as numbered acceptance entries, a minimal
 * PR body (validation results from the record) and the diff; it reads the candidate tree.
 * Scoring per record: a labelled defect is HIT when a comment names one of its criteria
 * ("acceptance N", 1-based) or sits on a file its evidence names; every other comment is
 * NOISE. The scorecard reports recall over defects, noise per record, cost and time.
 * Results: <set>/results/<label>/<id>.json and scorecard.json. Exit 0 scored; 64 usage.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const here = resolve(new URL(".", import.meta.url).pathname);

const { values } = parseArgs({
  options: {
    set: { type: "string" },
    repo: { type: "string" },
    plugin: { type: "string" },
    model: { type: "string" },
    effort: { type: "string" },
    seeded: { type: "boolean" },
    only: { type: "string", multiple: true },
    concurrency: { type: "string" },
    "timeout-minutes": { type: "string" },
    label: { type: "string" },
    fresh: { type: "boolean" },
  },
});
const usage = (m) => {
  process.stderr.write(`${m}\nSee the header of bench/review-replay.mjs.\n`);
  process.exit(64);
};
if (!values.set || !values.repo) usage("Give --set DIR and --repo DIR");
const set = resolve(values.set);
const repo = resolve(values.repo);
const plugin = resolve(values.plugin ?? join(here, "..", "plugin"));
const scripts = join(plugin, "scripts", "lib");
const { installPlugin } = await import(pathToFileURL(join(scripts, "checkout.mjs")).href);
const { runHarness, scrubbedEnv } = await import(pathToFileURL(join(scripts, "harness.mjs")).href);
// Scoring (what Factory would post from an answer) comes from this checkout, never --plugin: both sides of an A/B are
// scored by the same code, and an older plugin without these exports still runs as a baseline.
const own = join(here, "..", "plugin", "scripts", "lib");
const { acceptanceEntries, parseReview } = await import(pathToFileURL(join(own, "logic.mjs")).href);
const { reviewPost } = await import(pathToFileURL(join(own, "handoff.mjs")).href);
const { reviewerPrompt } = await import(pathToFileURL(join(plugin, "scripts", "review.mjs")).href);
const { MODEL_DEFAULTS } = await import(pathToFileURL(join(scripts, "inputs.mjs")).href);

const model = values.model ?? MODEL_DEFAULTS.claude.reviewer_model;
const effort = values.effort ?? MODEL_DEFAULTS.claude.reviewer_effort;
const label = values.label ?? `06-${model}${effort ? `-${effort}` : ""}`;
const concurrency = Math.max(1, Number(values.concurrency ?? 2));
const timeoutMs = Math.max(1, Number(values["timeout-minutes"] ?? 20)) * 60_000;
const out = join(set, "results", label);
mkdirSync(out, { recursive: true });

/** The set's records, each with its labels (labels.json for recorded reviews; inline for seeded). */
function loadSet() {
  const labels = JSON.parse(readFileSync(join(set, "labels.json"), "utf8"));
  const records = [];
  for (const f of readdirSync(join(set, "records")).filter((n) => n.endsWith(".json")).sort()) {
    const r = JSON.parse(readFileSync(join(set, "records", f), "utf8"));
    if (r.replay === false) continue;
    records.push({ ...r, labels: labels[r.id] ?? { refusals: [], defects: [] }, seeded: null });
  }
  if (values.seeded && existsSync(join(set, "seeded", "records"))) {
    for (const f of readdirSync(join(set, "seeded", "records")).filter((n) => n.endsWith(".json")).sort()) {
      const r = JSON.parse(readFileSync(join(set, "seeded", "records", f), "utf8"));
      records.push({ ...r, labels: r.labels ?? { refusals: [], defects: [] } });
    }
  }
  return values.only?.length ? records.filter((r) => values.only.includes(r.id)) : records;
}

/** The Objective's goal text from inputs/<n>.json's shown blocks, for the issue text. */
function objectiveText(objective) {
  const f = join(set, "inputs", `${objective}.json`);
  if (!existsSync(f)) return "";
  const blocks = JSON.parse(readFileSync(f, "utf8")).shown?.blocks ?? [];
  const lines = [];
  for (const b of blocks) {
    if (b.kind === "heading") lines.push(`${"#".repeat(Math.min(6, (b.level ?? 2) + 1))} ${b.text}`);
    else if (b.kind === "text") lines.push(b.text);
    else if (b.kind === "list" && Array.isArray(b.items)) lines.push(...b.items.map((i) => `- ${typeof i === "string" ? i : i.text ?? JSON.stringify(i)}`));
  }
  return lines.join("\n\n");
}

function issueBody(r) {
  const goal = objectiveText(r.objective);
  const acceptance = r.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n");
  return `${goal}\n\n## Acceptance (this Work Item: ${r.item})\n${acceptance}\n`;
}

function prBody(r) {
  const results = (r.validation?.results ?? []).map((v) => `- \`${v.command}\`: ${v.passed ? "passed" : `failed (exit ${v.exitCode})`}`).join("\n");
  return `## Acceptance\n${r.criteria.map((c, i) => `| ${i + 1} | ${c.slice(0, 120)} | see diff | see diff |`).join("\n")}\n\n## Validation\n${results || "- (not recorded)"}\n\n## Fake-only proofs\nnone recorded\n\n## Design checklist\nNot recorded in this replay (the candidate predates this PR form); do not comment on its absence.\n\n## Assumptions\nNot recorded in this replay; comment only on assumptions visible in the diff.\n\n## Undone\nnone\n`;
}

async function git(args, cwd = repo) {
  const { stdout } = await run("git", args, { cwd, maxBuffer: 256 * 1024 * 1024 });
  return stdout;
}

async function reviewOne(r) {
  const resultFile = join(out, `${r.id}.json`);
  if (!values.fresh && existsSync(resultFile)) {
    const prev = JSON.parse(readFileSync(resultFile, "utf8"));
    if (!prev.error) return prev;
  }
  const wt = join(set, "results", "cache", "06", r.id);
  if (!existsSync(wt)) {
    mkdirSync(join(set, "results", "cache", "06"), { recursive: true });
    await git(["worktree", "add", "--detach", wt, r.candidate.commit]);
  }
  installPlugin(wt, plugin, { harness: "claude" });
  const diff = await git(["diff", `${r.candidate.base}..${r.candidate.commit}`]);
  const prompt = reviewerPrompt({ issue: r.objective, issueTitle: `${r.item} (Objective #${r.objective})`, issueBody: issueBody(r), prBody: prBody(r), diff, harness: "claude" });
  const env = scrubbedEnv(process.env, { CI: "true" });
  const started = Date.now();
  const rec = await runHarness({ harness: "claude", model, effort, prompt, maxUsd: 5, agent: "reviewer", cwd: wt, env, timeoutMs, eventsFile: join(out, "events", `${r.id}.jsonl`), label: r.id });
  // What Factory would post: the reviewer's comments plus one per entry it judged not met without one; never the placeholder.
  const review = rec.ok ? parseReview(rec.finalText || "") : { comments: [], acceptance: null, parsed: false };
  const post = rec.ok && review.parsed ? reviewPost({ issue: r.objective, review, diff, entries: acceptanceEntries(issueBody(r)) }) : null;
  const comments = post && !post.placeholder ? post.comments : [];
  const result = { id: r.id, model, effort, ok: rec.ok, error: rec.error ?? null, usd: rec.usd, tokens: rec.tokens, turns: rec.turns, durationMs: Date.now() - started, comments, acceptance: review.acceptance, diffBytes: diff.length };
  writeFileSync(resultFile, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

/** HIT/NOISE per record. A comment names "acceptance N" (or "criterion N", "entry N"); a defect's evidence names files. */
function score(r, result) {
  const criteriaOf = (body) => [...String(body).matchAll(/\b(?:acceptance|criterion|criteria|entry|entries)\s+(\d+)(?:\s*(?:,|and|&)\s*(\d+))*/gi)].flatMap((m) => m.slice(1).filter(Boolean).map(Number));
  const files = (defect) => [...String(defect.evidence ?? "").matchAll(/([\w./-]+\.(?:ts|tsx|mjs|js|md|json|sql|yml|yaml))/g)].map((m) => m[1]);
  const defects = r.labels?.defects ?? [];
  const hits = [];
  const matched = new Set();
  for (const d of defects) {
    const wanted = new Set((d.criteria ?? []).filter((c) => typeof c === "number").map((c) => c + 1));
    const names = files(d);
    const by = result.comments.filter((c, i) => {
      const named = criteriaOf(c.body).some((n) => wanted.has(n));
      const onFile = names.some((f) => c.path === f || c.path.endsWith(`/${f}`) || f.endsWith(`/${c.path}`));
      if (named || onFile) matched.add(i);
      return named || onFile;
    });
    hits.push({ defect: d.id, hit: by.length > 0, by: by.map((c) => `${c.path}:${c.line}`) });
  }
  const noise = result.comments.filter((c, i) => !matched.has(i) && !/^\s*no findings\b/i.test(c.body));
  return { defects: defects.length, hits: hits.filter((h) => h.hit).length, detail: hits, comments: result.comments.length, noise: noise.length, noiseBodies: noise.map((c) => `${c.path}:${c.line} ${c.body.slice(0, 120)}`) };
}

const records = loadSet();
if (!records.length) usage("no records selected");
process.stderr.write(`${records.length} record(s) on ${model}${effort ? ` at ${effort}` : ""}, ${concurrency} at once → ${out}\n`);
const results = [];
let next = 0;
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (next < records.length) {
      const r = records[next++];
      try {
        const res = await reviewOne(r);
        results.push({ record: r, result: res });
        process.stderr.write(`  ${r.id}: ${res.ok ? `${res.comments.length} comment(s), $${res.usd ?? "?"}` : `FAILED ${res.error}`}\n`);
      } catch (e) {
        results.push({ record: r, result: { id: r.id, ok: false, error: e.message, comments: [], usd: null } });
        process.stderr.write(`  ${r.id}: ERROR ${e.message.slice(0, 160)}\n`);
      }
    }
  }),
);
const rows = results.map(({ record, result }) => ({ id: record.id, seeded: !!record.seeded, ok: result.ok, usd: result.usd, durationMs: result.durationMs, ...score(record, result) }));
const sum = (k) => rows.reduce((s, x) => s + (Number(x[k]) || 0), 0);
const recorded = rows.filter((x) => !x.seeded);
const seeded = rows.filter((x) => x.seeded);
const summary = {
  label,
  model,
  effort,
  records: rows.length,
  reviewed: rows.filter((x) => x.ok).length,
  errors: rows.filter((x) => !x.ok).length,
  defects: sum("defects"),
  hits: sum("hits"),
  recall: sum("defects") ? Math.round((sum("hits") / sum("defects")) * 100) / 100 : null,
  seededRecall: seeded.reduce((s, x) => s + x.defects, 0) ? Math.round((seeded.reduce((s, x) => s + x.hits, 0) / seeded.reduce((s, x) => s + x.defects, 0)) * 100) / 100 : null,
  comments: sum("comments"),
  noise: sum("noise"),
  noisePerRecord: rows.length ? Math.round((sum("noise") / rows.length) * 100) / 100 : null,
  cleanRecordsWithNoise: recorded.filter((x) => x.defects === 0 && x.noise > 0).length,
  usd: Math.round(sum("usd") * 100) / 100,
  minutes: Math.round(sum("durationMs") / 6000) / 10,
  scoredAt: new Date().toISOString(),
};
writeFileSync(join(out, "scorecard.json"), `${JSON.stringify({ summary, rows }, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
