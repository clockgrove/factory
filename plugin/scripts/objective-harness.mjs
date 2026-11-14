#!/usr/bin/env node
// The harness a work or review job installs (action.yml): the one the Objective's `factory:harness:<name>` label names,
// read with the job's own token before the install, so the job installs that CLI rather than the repository's default.
// Only the label's name is read here: the stage checks who applied it and Blocks when the harness it runs on is not the
// one this job installed (objective-trust.mjs choiceGate, FACTORY_STAGE_HARNESS).
//   node scripts/objective-harness.mjs --repo OWNER/NAME (--issue N | --branch factory/N)
// Writes `harness=<name>` to $GITHUB_OUTPUT: empty when no single harness label names one, or the read failed. The review
// job names its PR's branch (GITHUB_HEAD_REF, from the event): no pull request read, which its token may not be allowed.
import { pathToFileURL } from "node:url";
import { choiceOf } from "./lib/choice.mjs";
import { getIssue, repoOf } from "./lib/github.mjs";
import { log, parseArgs, setOutput } from "./lib/inputs.mjs";

/**
 * The harness the Objective's labels name, or "" for the repository's default: its issue (`issue`, or the one a
 * factory/<issue> `branch` is for) through choice.mjs choiceOf. `read` (issue) is a test's own.
 */
export async function labelHarness({ repo, issue = null, branch = "", opts, read = {} }) {
  const n = Number(issue) || Number(/^factory\/(\d+)$/.exec(String(branch || ""))?.[1]) || null;
  if (!n) return "";
  const c = choiceOf((await (read.issue ?? getIssue)(repo, n, opts))?.labels || []);
  return c.ok && c.choice.harness ? c.choice.harness : "";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let harness = "";
  try {
    harness = await labelHarness({ repo: repoOf(args.repo || process.env.GITHUB_REPOSITORY), issue: args.issue, branch: args.branch, opts: { token: process.env.GITHUB_TOKEN } });
  } catch (e) {
    log(`warning: the Objective's harness label could not be read (${String(e?.message || e).slice(0, 160)}); installing the repository's default, and the stage Blocks if its label names another`);
  }
  setOutput("harness", harness);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
