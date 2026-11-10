#!/usr/bin/env node
// baseline.mjs: one line that says how Factory is doing on a repository, from the standing scorecard.
//
//   node bench/baseline.mjs --scorecard FILE [--repo OWNER/NAME] [--last N] [--since DATE] [--label NAME] [--append]
//
// Prints the median and the p25..p75 spread of model minutes, turns, cost, CI wait and setup per
// merged Objective, and the walk-away rate, over the chosen rows. `--append` adds the line to the
// scorecard's `baselines` list under `--label` so a wave's before and after is one command.
import { readFileSync, writeFileSync } from "node:fs";
import { baselineOf, formatBaseline } from "./lib/baseline.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const file = opt("scorecard");
if (!file) {
  console.error("usage: node bench/baseline.mjs --scorecard FILE [--repo OWNER/NAME] [--last N] [--since DATE] [--label NAME] [--append]");
  process.exit(64);
}
const card = JSON.parse(readFileSync(file, "utf8"));
const line = baselineOf(card.rows || [], { repo: opt("repo"), last: opt("last") ? Number(opt("last")) : null, since: opt("since"), label: opt("label", new Date().toISOString().slice(0, 10)) });
if (!line.rows) {
  console.error("nothing to baseline: no merged rows matched");
  process.exit(65);
}
process.stdout.write(formatBaseline(line));
if (args.includes("--append")) {
  card.baselines = [...(card.baselines || []).filter((b) => b.label !== line.label), line];
  writeFileSync(file, `${JSON.stringify(card, null, 1)}\n`);
  console.error(`appended baseline "${line.label}" to ${file}`);
}
