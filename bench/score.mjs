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
 *   --read N=ok|defect     the owner's read of issue N's merged diff (kept across --append)
 *   --baseline REF         the ref the judge compares each merged head with;
 *                          the row carries the pair for bench/judge.mjs
 *   --bot LOGIN            another machine login to ignore (the App's
 *                          `<slug>[bot]` and any `*[bot]` are ignored already)
 *   --label NAME           the Objective label (default factory:objective)
 *   --clock-after DATE     start each clock at the first label event at or
 *                          after DATE (an issue an earlier Factory ran under
 *                          the same label keeps its old events; this floors them)
 *   --check CMD            validation command(s) for the grade-auto line
 *   --no-jobs              skip the job log (runner minutes become unknown)
 *   --out FILE             write the rows as JSON to FILE
 *   --md FILE              write the Markdown table to FILE (default: printed)
 *   --append FILE          merge the rows into a standing scorecard.json,
 *                          replacing rows of the same repository and issue
 *                          (hand-filled quality.escapes and quality.read are kept)
 *   --snapshot FILE        write every GitHub answer used (a fixture)
 *   --replay FILE          score from such a snapshot instead of GitHub
 *   --print                print the JSON rows to stdout too
 *   --token TOKEN          a GitHub token (default: GH_TOKEN, GITHUB_TOKEN, the gh login)
 *   --prices FILE          a price table other than bench/prices.json
 *
 * Exit codes: 0 scored; 64 usage; 65 nothing to score; 70 GitHub failed.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { collectObjective, listObjectives, recordingApi, snapshotApi, usageFromDir } from "./lib/collect.mjs";
import { loadPrices } from "./lib/cost.mjs";
import { downloadArtifact, ghApi, ghGraphql } from "./lib/gh.mjs";
import { markdownTable, OBJECTIVE_LABEL, scoreObjective } from "./lib/objective.mjs";
import { existsSync as fileExists } from "node:fs";

/** Rows merged into a standing scorecard: same repository and issue replaces; others are kept; the owner's hand-filled quality fields survive. */
export function appendScorecard(standing, rows) {
  const card = standing && typeof standing === "object" ? standing : { version: 1, rows: [] };
  const old = (r) => (card.rows || []).find((o) => o.repository === r.repository && o.issue === r.issue);
  const merged = rows.map((r) => {
    const o = old(r);
    if (!o?.quality) return r;
    const quality = { ...r.quality };
    if (!(quality.escapes || []).length && (o.quality.escapes || []).length) quality.escapes = o.quality.escapes;
    if ((quality.read === undefined || quality.read === "unread") && o.quality.read !== undefined && o.quality.read !== "unread") quality.read = o.quality.read;
    return { ...r, quality };
  });
  const kept = (card.rows || []).filter((r) => !rows.some((n) => n.repository === r.repository && n.issue === r.issue));
  return { version: 1, updatedAt: new Date().toISOString(), rows: [...kept, ...merged].sort((a, b) => a.repository.localeCompare(b.repository) || a.issue - b.issue) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      repo: { type: "string" },
      issue: { type: "string", multiple: true },
      since: { type: "string" },
      usage: { type: "string" },
      minutes: { type: "string", multiple: true },
      read: { type: "string", multiple: true },
      baseline: { type: "string" },
      bot: { type: "string", multiple: true },
      label: { type: "string" },
      "clock-after": { type: "string" },
      check: { type: "string", multiple: true },
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
  if (values["clock-after"] && Number.isNaN(Date.parse(values["clock-after"]))) usage("--clock-after takes a date, such as 2026-11-03");
  const clockAfter = values["clock-after"] ? new Date(values["clock-after"]).toISOString() : null;
  const minutes = {};
  for (const m of values.minutes ?? []) {
    const match = /^(\d+)=(\d+(?:\.\d+)?)$/.exec(m);
    if (!match) usage(`--minutes takes ISSUE=MINUTES, not ${m}`);
    minutes[Number(match[1])] = Number(match[2]);
  }
  const reads = {};
  for (const r of values.read ?? []) {
    const match = /^(\d+)=(ok|defect|unread)$/.exec(r);
    if (!match) usage(`--read takes ISSUE=ok|defect|unread, not ${r}`);
    reads[Number(match[1])] = match[2];
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
  // The skills the rows ran on: bench/skills.json's digest (node bench/skills.mjs records it).
  const skillsFile = resolve(import.meta.dirname, "skills.json");
  const skills = fileExists(skillsFile) ? (() => { const s = JSON.parse(readFileSync(skillsFile, "utf8")); return { digest: s.digest, recordedAt: s.recordedAt ?? null }; })() : null;

  const calls = {};
  const live = (path, opts) => ghApi(path, { ...opts, token });
  const api = snapshot ? snapshotApi(snapshot) : values.snapshot ? recordingApi(live, calls) : live;
  const graphql = snapshot ? null : (q, v) => ghGraphql(q, v, { token });
  const download = snapshot || values.usage ? null : (repoFull, artifact) => downloadArtifact(repoFull, artifact, { token });

  const usageDir = values.usage ? resolve(values.usage) : null;
  const usageFor = (issue) => {
    if (!usageDir) return null;
    const per = `${usageDir}/${issue}`;
    const dir = existsSync(per) ? per : usageDir;
    return usageFromDir(dir, { readdir: readdirSync, read: (f) => readFileSync(f, "utf8"), isDir: (f) => statSync(f).isDirectory() });
  };

  const rows = [];
  try {
    const numbers = issues.length ? issues : await listObjectives(api, repo, { since: values.since, label });
    if (!numbers.length) {
      process.stderr.write(`no ${label} issue in ${repo} closed${values.since ? ` since ${values.since}` : ""}, Blocked, Question, In review or Running\n`);
      process.exit(65);
    }
    for (const issue of numbers) {
      const collected = snapshot?.collected?.[issue] ?? (await collectObjective(api, repo, issue, { download, usage: usageFor(issue), jobs: !values["no-jobs"], graphql }));
      if (usageDir && snapshot) collected.usage = usageFor(issue) ?? collected.usage;
      collected.harness = collected.usage.find((r) => r.harness)?.harness ?? collected.harness ?? null;
      if (values.snapshot) (calls.__collected ??= {})[issue] = collected;
      rows.push(scoreObjective(collected, { prices, minutes: minutes[issue], read: reads[issue], baseline: values.baseline ?? null, bots, label, clockAfter, checks: values.check ?? [], skills }));
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
