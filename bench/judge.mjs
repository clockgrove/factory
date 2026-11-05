#!/usr/bin/env node
/**
 * `node bench/judge.mjs`: the blind pairwise judge (lib/judge.mjs, kept from
 * 0.5) on two commits of one repository: which tree the judge would rather
 * have, on the Objective's intent and on code quality.
 *
 *   node bench/judge.mjs --repo DIR --a REF --b REF --objective FILE \
 *       --judge "COMMAND" [--timeout-minutes N] [--graders DIR] [--out FILE]
 *
 * `--judge` is the judge command under the 0.5 contract: run in a shell with
 * BENCH_TREE_A, BENCH_TREE_B (fresh checkouts without .git), BENCH_OBJECTIVE,
 * BENCH_DEFINITION and BENCH_OUT; it writes { judgeVersion, intent, quality,
 * reasons }, intent and quality each A, B or tie. `--graders DIR` is linked
 * beside the definition copy as the 0.5 bench home's graders/ was.
 *
 * Blind: which ref is A is decided by a hash of the two refs' names, and the
 * output unblinds it. The row from score.mjs names the pair: the merged
 * head (candidate) and --baseline.
 *
 * Exit codes: 0 judged; 64 usage; 70 the judge failed.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { blindOrder, runJudge } from "./lib/judge.mjs";

const { values } = parseArgs({
  options: {
    repo: { type: "string" },
    a: { type: "string" },
    b: { type: "string" },
    objective: { type: "string" },
    judge: { type: "string" },
    "timeout-minutes": { type: "string" },
    graders: { type: "string" },
    out: { type: "string" },
  },
});
const usage = (message) => {
  process.stderr.write(`${message}\nSee the header of bench/judge.mjs for usage.\n`);
  process.exit(64);
};
for (const flag of ["repo", "a", "b", "objective", "judge"]) if (!values[flag]) usage(`Give --${flag}`);
const repo = resolve(values.repo);
const sha = (ref) => {
  try {
    return execFileSync("git", ["-C", repo, "rev-parse", "--verify", `${ref}^{commit}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    return usage(`${ref}: ${String(error.stderr || error.message).trim()}`);
  }
};
const refs = { [values.a]: sha(values.a), [values.b]: sha(values.b) };
const [A, B] = blindOrder(values.a, values.b);
const timeoutMinutes = Number(values["timeout-minutes"] ?? 20);
if (!(timeoutMinutes > 0)) usage("--timeout-minutes takes a number more than 0");

// The 0.5 judge reads a definition file beside a graders/ directory; 0.6 gives it a stub.
const home = mkdtempSync(join(tmpdir(), "factory-judge-"));
mkdirSync(join(home, "benchmarks"));
const file = join(home, "benchmarks", "pair.json");
writeFileSync(file, `${JSON.stringify({ id: "pair", judge: { command: values.judge, timeoutMinutes } }, null, 2)}\n`);
if (values.graders) {
  // lib/judge.mjs resolves graders/ beside benchmarks/; a symlink puts the given directory there.
  symlinkSync(resolve(values.graders), join(home, "graders"));
}
const objective = resolve(values.objective);
let result;
try {
  result = await runJudge({ file, judge: { command: values.judge, timeoutMinutes } }, { repo, commit: refs[A], objective }, { repo, commit: refs[B], objective });
} catch (error) {
  result = { error: `judge failed: ${error.message}` };
} finally {
  rmSync(home, { recursive: true, force: true });
}
if (result.error) {
  process.stderr.write(`${result.error}\n`);
  process.exit(70);
}
const unblind = (choice) => (choice === "tie" ? "tie" : choice === "A" ? A : B);
const output = {
  A: { ref: A, commit: refs[A] },
  B: { ref: B, commit: refs[B] },
  judgeVersion: result.judgeVersion,
  intent: { choice: result.intent, ref: unblind(result.intent) },
  quality: { choice: result.quality, ref: unblind(result.quality) },
  reasons: result.reasons,
};
const text = `${JSON.stringify(output, null, 2)}\n`;
if (values.out) writeFileSync(values.out, text);
process.stdout.write(values.out ? `${values.out}\nintent: ${output.intent.ref}; quality: ${output.quality.ref}\n` : text);
