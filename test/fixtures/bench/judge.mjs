#!/usr/bin/env node
/**
 * A stand-in pairwise judge for the invented acme-widgets-42 benchmark: what
 * a benchmark's frozen judge does, on two final trees of the run repository
 * fixtureRepository builds (generate.mjs). It keeps the judge contract
 * (bench/lib/judge.mjs): it reads BENCH_TREE_A, BENCH_TREE_B,
 * BENCH_OBJECTIVE and BENCH_DEFINITION, and writes its choice to BENCH_OUT.
 * Its preferences are fixed: on intent, the tree whose CSV export quotes
 * values (the Objective asks for it), or with `prefer-plain` the one that
 * doesn't; on quality, the shorter export. Equal trees tie. It refuses
 * (exit 3) a tree with its Git history. With STAND_IN_JUDGE_LOG set, it
 * appends what it was given to that file, one JSON line per call.
 */
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const {
  BENCH_TREE_A,
  BENCH_TREE_B,
  BENCH_OBJECTIVE,
  BENCH_DEFINITION,
  BENCH_OUT,
  STAND_IN_JUDGE_LOG,
} = process.env;
const refuse = (why) => {
  process.stderr.write(`stand-in judge: ${why}\n`);
  process.exit(3);
};
if (
  !BENCH_TREE_A ||
  !BENCH_TREE_B ||
  !BENCH_OBJECTIVE ||
  !BENCH_DEFINITION ||
  !BENCH_OUT
)
  refuse(
    "BENCH_TREE_A, BENCH_TREE_B, BENCH_OBJECTIVE, BENCH_DEFINITION and BENCH_OUT are needed",
  );
for (const tree of [BENCH_TREE_A, BENCH_TREE_B])
  if (existsSync(join(tree, ".git"))) refuse(`${tree} has its Git history`);
const definition = JSON.parse(readFileSync(BENCH_DEFINITION, "utf8"));
if (!definition.id) refuse("BENCH_DEFINITION is no definition");
const objective = readFileSync(BENCH_OBJECTIVE, "utf8");

const exporter = (tree) => {
  const file = join(tree, "src/api/export.ts");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
};
const [a, b] = [exporter(BENCH_TREE_A), exporter(BENCH_TREE_B)];
const prefer = (scoreA, scoreB) =>
  scoreA === scoreB ? "tie" : scoreA > scoreB ? "A" : "B";
const quoted = (text) => (text.includes("quote") ? 1 : 0);
const plain = process.argv.includes("prefer-plain");
const intent = plain
  ? prefer(1 - quoted(a), 1 - quoted(b))
  : prefer(quoted(a), quoted(b));
const quality = prefer(-a.split("\n").length, -b.split("\n").length);
if (STAND_IN_JUDGE_LOG)
  appendFileSync(
    STAND_IN_JUDGE_LOG,
    `${JSON.stringify({
      env: process.env,
      cwd: process.cwd(),
      objective,
      definition: Object.keys(definition),
      graders: existsSync(join(dirname(BENCH_DEFINITION), "..", "graders")),
      quoted: { A: quoted(a), B: quoted(b) },
    })}\n`,
  );
writeFileSync(
  BENCH_OUT,
  JSON.stringify({
    judgeVersion: "acme-widgets-42 stand-in judge 1",
    intent,
    quality,
    reasons: {
      intent: plain
        ? "prefers the export that leaves values as they are"
        : "the Objective asks for quoted values",
      quality: "the shorter export",
    },
  }),
);
