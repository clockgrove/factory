#!/usr/bin/env node
/**
 * A stand-in grader for the invented acme-widgets-42 benchmark: what a
 * benchmark's frozen grader does, on the run repository fixtureRepository
 * builds (generate.mjs). It keeps the grader contract (bench/lib/grade.mjs):
 * it runs in the checkout, reads BENCH_TREE, BENCH_COMMIT and
 * BENCH_DEFINITION, and writes its verdicts and a metric to BENCH_OUT. Its
 * verdicts are mixed: three criteria pass, one fails and one it can't
 * judge. It refuses
 * (exit 3) a checkout that isn't BENCH_COMMIT or that goes past the
 * Objective's end.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const { BENCH_TREE, BENCH_COMMIT, BENCH_DEFINITION, BENCH_OUT } = process.env;
const refuse = (why) => {
  process.stderr.write(`stand-in grader: ${why}\n`);
  process.exit(3);
};
if (!BENCH_TREE || !BENCH_COMMIT || !BENCH_DEFINITION || !BENCH_OUT)
  refuse("BENCH_TREE, BENCH_COMMIT, BENCH_DEFINITION and BENCH_OUT are needed");
if (realpathSync(process.cwd()) !== realpathSync(BENCH_TREE))
  refuse(`not run in the checkout: ${process.cwd()}`);
const head = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
if (head !== BENCH_COMMIT) refuse(`checked out ${head}, not ${BENCH_COMMIT}`);
if (existsSync("CHANGELOG.md")) refuse("the checkout is past the run's end");
if (!JSON.parse(readFileSync(BENCH_DEFINITION, "utf8")).id)
  refuse("BENCH_DEFINITION is no definition");

const read = (path) =>
  existsSync(join(BENCH_TREE, path))
    ? readFileSync(join(BENCH_TREE, path), "utf8")
    : "";
const check = (id, text, passed, evidence) => ({
  id,
  text,
  verdict: passed ? "pass" : "fail",
  method: "read the source",
  evidence,
});
const exporter = read("src/api/export.ts");
writeFileSync(
  BENCH_OUT,
  JSON.stringify({
    graderVersion: "acme-widgets-42 stand-in 1",
    criteria: [
      check(
        "tokenizer-splits",
        "A query splits into field, operator and value tokens",
        read("src/query/tokenizer.ts").includes("tokenize"),
        "src/query/tokenizer.ts exports tokenize",
      ),
      check(
        "api-q",
        "GET /widgets takes a q parameter",
        /\bq\b/.test(read("src/api/widgets.ts")),
        "src/api/widgets.ts takes q",
      ),
      check(
        "csv-quoted",
        "Values with commas are quoted",
        exporter.includes("quote"),
        { file: "src/api/export.ts", looked: "quote" },
      ),
      check(
        "csv-limit",
        "An export over 10,000 rows is refused",
        /10_?000/.test(exporter),
        "src/api/export.ts has no row limit",
      ),
      {
        id: "smoke-starts",
        text: "The release build starts",
        verdict: "unknown",
        method: "start the release build",
        evidence: "no display to start it on",
      },
    ],
    // What a grader measures besides its verdicts (#2224): here, a fixed
    // share of the export's mutants the delivered tests kill.
    metrics: { mutationScore: 0.75 },
  }),
);
