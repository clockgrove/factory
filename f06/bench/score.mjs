#!/usr/bin/env node
/**
 * `node bench/score.mjs`: the four job-one numbers per Objective, read from
 * GitHub (REST through `gh api`) and the usage artifact the worker job
 * uploads. One row per Objective; the standing scorecard is their union.
 *
 *   node bench/score.mjs --repo OWNER/NAME --issue N [--issue M ...]
 *   node bench/score.mjs --repo OWNER/NAME --since 2026-11-01     every closed factory:objective issue
 *
 *   --usage DIR            result.json / events.jsonl files to read instead of
 *                          downloading artifacts (one artifact's unzip, or
 *                          <DIR>/<issue>/ per issue); works without a token
 *   --minutes N=M          operator minutes for issue N, from a stopwatch
 *   --baseline REF         the ref the judge compares each merged head with;
 *                          the row carries the pair for bench/judge.mjs
 *   --bot LOGIN            another machine login to ignore (the App's
 *                          `<slug>[bot]` and any `*[bot]` are ignored already)
 *   --label NAME           the Objective label (default factory:objective)
 *   --no-jobs              skip the job log (runner minutes become unknown)
 *   --out FILE             the rows as JSON (default: scorecard.json beside
 *                          --append, else stdout with --print)
 *   --md FILE              the Markdown table (default: printed)
 *   --append FILE          merge the rows into a standing scorecard.json,
 *                          replacing rows of the same repository and issue
 *   --snapshot FILE        write every GitHub answer used (a fixture)
 *   --replay FILE          score from such a snapshot instead of GitHub
 *   --print                print the JSON rows to stdout too
 *
 * Exit codes: 0 scored; 64 usage; 65 nothing to score; 70 GitHub failed.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { collectObjective, listObjectives, recordingApi, snapshotApi, usageFromDir } from "./lib/collect.mjs";
import { loadPrices } from "./lib/cost.mjs";
import { downloadArtifact, ghApi } from "./lib/gh.mjs";
import { markdownTable, OBJECTIVE_LABEL, scoreObjective } from "./lib/objective.mjs";

export { appendScorecard };

const { values } = parseArgs({
  options: {
    repo: { type: "string" },
    issue: { type: "string", multiple: true },
    since: { type: "string" },
    usage: { type: "string" },
    minutes: { type: "string", multiple: true },
    baseline: { type: "string" },
    bot: { type: "string", multiple: true },
    label: { type: "string" },
    "no-jobs": { type: "boolean" },
    out: { type: "string" },
    md: { type: "string" },
    append: { type: "string" },
    snapshot: { type: "string" },
    replay: { type: "string" },
    print: { type: "boolean" },
    token: { type: "string" },
    prices: { type: "string" },
  },
});

const usage = (message) => {
  process.stderr.write(`${message}\nSee the header of bench/score.mjs for usage.\n`);
  process.exit(64);
};

/** Rows merged into a standing scorecard: same repository and issue replaces; others are kept. */
function appendScorecard(standing, rows) {
  const card = standing && typeof standing === "object" ? standing : { version: 1, rows: [] };
  const kept = (card.rows || []).filter((r) => !rows.some((n) => n.repository === r.repository && n.issue === r.issue));
  return { version: 1, updatedAt: new Date().toISOString(), rows: [...kept, ...rows].sort((a, b) => a.repository.localeCompare(b.repository) || a.issue - b.issue) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let snapshot = null;
  if (values.replay) {
    try {
      snapshot = JSON.parse(readFileSync(values.replay, "utf8"));
    } catch (error) {
      usage(`--replay: ${error.message}`);
    }
  }
  const repo = values.repo ?? snapshot?.repository;
  if (!repo || !/^[^/]+\/[^/]+$/.test(repo)) usage("Give --repo OWNER/NAME");
  const issues = (values.issue ?? (snapshot?.issues ? snapshot.issues.map(String) : [])).map((n) => Number(n));
  if (issues.some((n) => !Number.isSafeInteger(n) || n <= 0)) usage("--issue takes issue numbers");
  if (!issues.length && !values.since) usage("Give --issue N (one or more) or --since DATE");
  if (values.since && Number.isNaN(Date.parse(values.since))) usage("--since takes a date, such as 2026-11-01");
  const minutes = {};
  for (const m of values.minutes ?? []) {
    const match = /^(\d+)=(\d+(?:\.\d+)?)$/.exec(m);
    if (!match) usage(`--minutes takes ISSUE=MINUTES, not ${m}`);
    minutes[Number(match[1])] = Number(match[2]);
  }
  let prices;
  try {
    prices = loadPrices(values.prices ? resolve(values.prices) : undefined);
  } catch (error) {
    usage(error.message);
  }
  const bots = new Set(values.bot ?? []);
  const label = values.label ?? OBJECTIVE_LABEL;
  const token = values.token ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? null;

  const calls = {};
  const live = (path, opts) => ghApi(path, { ...opts, token });
  const api = snapshot ? snapshotApi(snapshot) : values.snapshot ? recordingApi(live, calls) : live;
  const download = snapshot || values.usage ? null : (repoFull, id) => downloadArtifact(repoFull, id, { token });

  const usageDir = values.usage ? resolve(values.usage) : null;
  const usageFor = (issue) => {
    if (!usageDir) return null;
    const per = `${usageDir}/${issue}`;
    const dir = existsSync(per) ? per : usageDir;
    return usageFromDir(dir, { readdir: readdirSync, read: (f) => readFileSync(f, "utf8") });
  };

  const rows = [];
  try {
    const numbers = issues.length ? issues : await listObjectives(api, repo, { since: values.since, label });
    if (!numbers.length) {
      process.stderr.write(`no closed ${label} issue in ${repo}${values.since ? ` since ${values.since}` : ""}\n`);
      process.exit(65);
    }
    for (const issue of numbers) {
      const collected = snapshot?.collected?.[issue] ?? (await collectObjective(api, repo, issue, { download, usage: usageFor(issue), jobs: !values["no-jobs"] }));
      if (usageDir && snapshot) collected.usage = usageFor(issue) ?? collected.usage;
      collected.harness = collected.usage.find((r) => r.harness)?.harness ?? collected.harness ?? null;
      if (values.snapshot) (calls.__collected ??= {})[issue] = collected;
      rows.push(scoreObjective(collected, { prices, minutes: minutes[issue], baseline: values.baseline ?? null, bots, label }));
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(70);
  }

  if (values.snapshot) {
    const { __collected, ...rest } = calls;
    writeFileSync(values.snapshot, `${JSON.stringify({ repository: repo, issues: rows.map((r) => r.issue), calls: rest, collected: __collected }, null, 2)}\n`);
  }
  const md = markdownTable(rows);
  if (values.md) writeFileSync(values.md, md);
  else process.stdout.write(md);
  if (values.append) {
    let standing = null;
    if (existsSync(values.append)) standing = JSON.parse(readFileSync(values.append, "utf8"));
    mkdirSync(dirname(resolve(values.append)), { recursive: true });
    writeFileSync(values.append, `${JSON.stringify(appendScorecard(standing, rows), null, 2)}\n`);
    process.stderr.write(`${values.append}: ${rows.length} row(s) merged into the standing scorecard\n`);
  }
  const json = `${JSON.stringify({ version: 1, repository: repo, scoredAt: new Date().toISOString(), rows }, null, 2)}\n`;
  if (values.out) {
    mkdirSync(dirname(resolve(values.out)), { recursive: true });
    writeFileSync(values.out, json);
  }
  if (values.print) process.stdout.write(values.md ? json : `\n${json}`);
}
