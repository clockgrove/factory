#!/usr/bin/env node
/**
 * `node bench/grade-auto.mjs`: grade any Objective's result (#2273), with
 * a grader, a quality reviewer, an adversary and a verifier, each a
 * headless agent (bench/lib/grade-auto.mjs).
 *
 *   Standalone:   --repo DIR --commit SHA --base SHA --objective FILE --out FILE
 *   As a grader:  a definition's `grader.command`, such as
 *                 `node bench/grade-auto.mjs --evidence DIR`: the checkout,
 *                 commit, output and Objective come from BENCH_TREE,
 *                 BENCH_COMMIT, BENCH_OUT and BENCH_OBJECTIVE, the base
 *                 from BENCH_BASE (past the definition's base patches),
 *                 else BENCH_DEFINITION's `source.base`, and the declared
 *                 checks from its `factory.requiredCommands`. A flag wins.
 *
 *   --evidence DIR              each role's prompt, transcript and answer
 *                               (default: beside --out, <out>.evidence/)
 *   --cli PATH                  the agent CLI (default: claude)
 *   --model NAME, --effort LEVEL  the agents' model and effort (default:
 *                               claude-sonnet-5-5, high)
 *   --install CMD               the repository's install command, run in
 *                               each role's scratch checkout
 *   --check CMD ...             the repository's declared checks
 *   --votes N                   grader votes per criterion (default: 3)
 *   --max-findings N            findings the verifier reproduces (default: 20)
 *   --timeout-minutes N         the whole run (default: 30)
 *   --role-timeout-minutes N    each role (default: 30)
 *
 * Exit codes: 0 graded; 1 no grader vote split the acceptance into
 * criteria (the output is written, with `error`); 64 usage. Stopped by a
 * signal, it kills every role first and dies of it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { autoGrade, DEFAULTS } from "./lib/grade-auto.mjs";

const { values } = parseArgs({
  options: {
    repo: { type: "string" },
    commit: { type: "string" },
    base: { type: "string" },
    objective: { type: "string" },
    out: { type: "string" },
    evidence: { type: "string" },
    cli: { type: "string" },
    model: { type: "string" },
    effort: { type: "string" },
    install: { type: "string" },
    check: { type: "string", multiple: true },
    votes: { type: "string" },
    "max-findings": { type: "string" },
    "timeout-minutes": { type: "string" },
    "role-timeout-minutes": { type: "string" },
  },
});

const usage = (message) => {
  process.stderr.write(
    `${message}\nSee the header of bench/grade-auto.mjs for usage.\n`,
  );
  process.exit(64);
};

const env = process.env;
let definition = null;
if (env.BENCH_DEFINITION)
  try {
    definition = JSON.parse(readFileSync(env.BENCH_DEFINITION, "utf8"));
  } catch (error) {
    usage(`BENCH_DEFINITION: ${error.message}`);
  }
const repo = values.repo ?? env.BENCH_TREE;
const commit = values.commit ?? env.BENCH_COMMIT ?? "HEAD";
// A graded card's BENCH_BASE is past the base patches provisioning applied,
// which aren't the run's change; the definition's source.base is not.
const base = values.base ?? env.BENCH_BASE ?? definition?.source?.base;
const patched =
  !values.base && !env.BENCH_BASE && definition?.basePatches?.length;
const objective = values.objective ?? env.BENCH_OBJECTIVE;
const out = values.out ?? env.BENCH_OUT;
for (const [flag, value] of [
  ["repo", repo],
  ["base", base],
  ["objective", objective],
  ["out", out],
])
  if (!value) usage(`Give --${flag}`);

/** A flag's number, more than 0 (whole when `whole`), or the default. */
const number = (flag, fallback, whole = true) => {
  if (values[flag] === undefined) return fallback;
  const n = Number(values[flag]);
  if (!(n > 0) || (whole && !Number.isSafeInteger(n)))
    usage(`--${flag} takes a ${whole ? "whole " : ""}number more than 0`);
  return n;
};

let text;
try {
  text = readFileSync(objective, "utf8");
} catch (error) {
  usage(`--objective: ${error.message}`);
}
let output;
try {
  output = await autoGrade({
    repo: resolve(repo),
    commit,
    base,
    objective: text,
    evidence: resolve(
      values.evidence ?? `${out.replace(/\.json$/, "")}.evidence`,
    ),
    cli: values.cli ?? DEFAULTS.cli,
    model: values.model ?? DEFAULTS.model,
    effort: values.effort ?? DEFAULTS.effort,
    install: values.install ?? null,
    checks: values.check ?? definition?.factory?.requiredCommands ?? [],
    votes: number("votes", DEFAULTS.votes),
    maxFindings: number("max-findings", DEFAULTS.maxFindings),
    timeoutMinutes: number("timeout-minutes", DEFAULTS.timeoutMinutes, false),
    roleTimeoutMinutes: number(
      "role-timeout-minutes",
      DEFAULTS.roleTimeoutMinutes,
      false,
    ),
  });
} catch (error) {
  usage(error.message);
}
if (patched)
  output.warnings.push(
    `the base is the definition's source.base, before its ${definition.basePatches.length} base patch(es): their changes are graded as the run's (give --base)`,
  );
writeFileSync(out, `${JSON.stringify(output, null, 2)}\n`);
const { criteria, findings } = output;
process.stdout.write(
  output.error
    ? `${out}\n${output.error}\n`
    : `${out}\n${criteria.filter((c) => c.verdict === "pass").length} of ${criteria.length} criteria passed; ${findings ? `${findings.length} verified finding(s), ${findings.filter((f) => f.severity === "defect").length} defect(s)` : "the findings are unknown"}\n`,
);
if (output.error) process.exit(1);
