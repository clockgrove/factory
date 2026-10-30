// A failed command's output keeps its errors wherever they are (#2201).
// Live, a check that ran a linter and then a compiler printed its compiler
// errors between pages of the linter's warnings; worker Validate kept the
// first line and the tail, so the worker saw only warnings and never why
// its check failed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../dist/config.js";
import { CAPTURE_OFF, RunLog } from "../dist/log.js";
import { correction } from "../dist/repair.js";
import { failureExcerpt, headAndTail } from "../dist/text.js";
import {
  SelfValidation,
  VALIDATE_RESULT_CHARS,
} from "../dist/work/self-validate.js";
import {
  configured,
  installation,
  item,
  plan,
  REPO,
  tempDir,
} from "./helpers.mjs";

const git = (cwd, ...args) => {
  const result = spawnSync(
    "git",
    ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

function loaded() {
  const inst = installation();
  configured(inst, "http://127.0.0.1:1");
  const saved = process.env.FACTORY_CONFIG;
  process.env.FACTORY_CONFIG = inst.env.FACTORY_CONFIG;
  try {
    return { ...loadConfig(REPO), logs: inst.logs };
  } finally {
    if (saved === undefined) delete process.env.FACTORY_CONFIG;
    else process.env.FACTORY_CONFIG = saved;
  }
}

const warnings = (from, count) =>
  Array.from(
    { length: count },
    (_, index) =>
      `src/module${from + index}.ts:12:5 lint/suspicious/noExplicitAny  Unexpected any. Specify a different type.`,
  ).join("\n");
const ERRORS = [
  "src/feature.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
  "src/feature.ts(9,1): error TS2304: Cannot find name 'missingThing'.",
];
/**
 * A linter's warnings with code frames whose source mentions an error, in
 * box-drawing characters that take three bytes each in UTF-8.
 */
const codeFrames = (from, count) =>
  Array.from({ length: count }, (_, index) =>
    [
      `src/module${from + index}.ts:10:23 lint/suspicious/noExplicitAny ${"━".repeat(80)}`,
      "",
      "  ! Unexpected any. Specify a different type.",
      "",
      "     9 │ try { run(); }",
      "  > 10 │ } catch (error: any) {",
      "       │                 ^^^",
      "    11 │   log(error.message);",
      "",
      "  i any disables many type checking rules. Its use should be avoided.",
      "",
    ].join("\n"),
  ).join("\n");
/** A test run's passing tests, which name errors, around one failure. */
const passing = Array.from(
  { length: 600 },
  (_, n) => `  ✓ returns an error when input ${n} is invalid (2ms)`,
).join("\n");
const FAILED_TEST = [
  "  ✗ parses the config",
  "    AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:",
];
const testRun = `> test\n${passing}\n${FAILED_TEST.join("\n")}\n    at TestContext.<anonymous> (test/config.test.js:12:5)\n${passing}\n# fail 1\n`;
/** A linter's warnings, then a compiler's errors, then more warnings. */
const flooded = `> check\n${warnings(0, 400)}\n${ERRORS[0]}\n  3 const total: number = "none";\n${ERRORS[1]}\nFound 2 errors in 1 file.\n${warnings(400, 400)}\n`;

test("failureExcerpt keeps the errors between pages of warnings, the start and the end, within its bound, and says what it cut (#2201)", () => {
  assert.ok(flooded.length > 60_000, String(flooded.length));
  // Head and tail alone lose them.
  const old = headAndTail(flooded, 300, 8_000);
  for (const error of ERRORS) assert.ok(!old.includes(error));
  for (const chars of [1_000, 8_000, 10_000, 30_000]) {
    const excerpt = failureExcerpt(flooded, chars);
    assert.ok(excerpt.length <= chars, `${excerpt.length} > ${chars}`);
    for (const error of ERRORS)
      assert.ok(excerpt.includes(error), `${chars}: ${excerpt}`);
    assert.ok(excerpt.startsWith("> check\n"), excerpt.slice(0, 200));
    assert.match(excerpt, /\n\[\d+ characters omitted\]\n/);
    assert.match(
      excerpt,
      /\n\[Cut to fit: \d+ of \d+ characters omitted\. Kept: the start, the end, and \d+ (?:line that looks|lines that look) like errors or failures, each with the lines around it\.\]$/,
    );
    // The end of the output is kept, before the note.
    const lastWarning = warnings(799, 1);
    if (chars >= 8_000) assert.ok(excerpt.includes(lastWarning));
  }
  // With room, each error keeps the lines around it.
  const roomy = failureExcerpt(flooded, 30_000);
  assert.ok(
    roomy.includes(
      `${ERRORS[0]}\n  3 const total: number = "none";\n${ERRORS[1]}\nFound 2 errors in 1 file.`,
    ),
  );
  // What it says it omitted is what it left out.
  const [, omitted, length] = roomy.match(
    /Cut to fit: (\d+) of (\d+) characters omitted/,
  );
  assert.equal(Number(length), flooded.length);
  const gaps = [...roomy.matchAll(/\n\[(\d+) characters omitted\]\n/g)];
  assert.equal(
    gaps.reduce((sum, [, n]) => sum + Number(n), 0),
    Number(omitted),
  );
});

test("failureExcerpt leaves short output as it is, keeps the start and the end of output with no failure lines, and stays bounded on any output", () => {
  assert.equal(failureExcerpt("error: short\n", 1_000), "error: short\n");
  const quiet = warnings(0, 1_000);
  const plain = failureExcerpt(quiet, 10_000);
  assert.ok(plain.length <= 10_000);
  assert.ok(plain.startsWith(warnings(0, 1)));
  assert.ok(plain.includes(warnings(999, 1)));
  assert.match(plain, /Kept: the start, the end\.\]$/);
  // Every line a failure, a minified line, stack frames, a 1 MB output.
  const cases = [
    Array.from({ length: 5_000 }, (_, n) => `FAIL test ${n}`).join("\n"),
    `${"x".repeat(50_000)}\nerror: ${"y".repeat(50_000)}\n${"z".repeat(50_000)}`,
    `${warnings(0, 300)}\nTypeError: boom\n${"    at frame (src/a.js:1:1)\n".repeat(40)}${warnings(300, 300)}`,
    `${warnings(0, 6_000)}\nnpm ERR! code 1\n${warnings(6_000, 6_000)}`,
  ];
  for (const text of cases)
    for (const chars of [1_000, 8_000, 30_000, 128_000]) {
      const excerpt = failureExcerpt(text, chars);
      assert.ok(excerpt.length <= chars, `${excerpt.length} > ${chars}`);
    }
  // A stack trace keeps its frames after the error.
  const traced = failureExcerpt(cases[2], 8_000);
  assert.ok(
    traced.includes(
      `TypeError: boom\n${"    at frame (src/a.js:1:1)\n".repeat(12)}`,
    ),
    traced,
  );
  assert.ok(failureExcerpt(cases[3], 30_000).includes("npm ERR! code 1"));
});

test("failureExcerpt keeps the errors before lines that only mention one: code frames of error-handling code and passing tests named for errors (#2201)", () => {
  for (const before of [20, 40, 100, 300]) {
    const text = `> check\n${codeFrames(0, before)}\n${ERRORS[0]}\n${ERRORS[1]}\nFound 2 errors in 1 file.\n${codeFrames(before, 300)}\n`;
    for (const chars of [8_000, 10_000, 30_000]) {
      const excerpt = failureExcerpt(text, chars);
      assert.ok(excerpt.length <= chars, `${excerpt.length} > ${chars}`);
      for (const error of ERRORS)
        assert.ok(excerpt.includes(error), `${before}, ${chars}: ${excerpt}`);
      // Only the errors, and their summary, are taken for failures.
      assert.match(excerpt, /and [1-3] lines? that looks? like errors/);
    }
  }
  for (const chars of [8_000, 30_000]) {
    const excerpt = failureExcerpt(testRun, chars);
    assert.ok(excerpt.length <= chars, `${excerpt.length} > ${chars}`);
    assert.ok(
      excerpt.includes(`${FAILED_TEST.join("\n")}\n    at TestContext`),
      excerpt,
    );
  }
  // A line that only mentions a failure is kept with the room left.
  const mention = `${warnings(0, 400)}\nwarning: 3 tests were skipped after a failing setup\n${warnings(400, 400)}`;
  assert.ok(
    failureExcerpt(mention, 8_000).includes(
      "warning: 3 tests were skipped after a failing setup",
    ),
  );
});

test("a repair's correction carries the errors of a failed command's output between pages of warnings (#2201)", async () => {
  const result = await correction({
    finding: {
      kind: "failure",
      detail: `Validation command failed (1): pnpm check: ${flooded}`,
    },
    operatorAnswer: "Fix the type errors.",
    prior: [],
  });
  assert.equal(result.kind, "correction");
  assert.ok(result.correction.failure.length <= 8_000);
  for (const error of ERRORS) {
    assert.ok(result.correction.failure.includes(error));
    assert.ok(result.finding.includes(error));
  }
});

/** A worker's Validate of a check that prints `output` and fails. */
async function validated(output) {
  const { sandbox, logs } = loaded();
  const worktree = join(tempDir("factory-validate-errors-"), "w");
  mkdirSync(join(worktree, "src"), { recursive: true });
  git(worktree, "init", "--quiet");
  writeFileSync(join(worktree, "flooded.txt"), output);
  writeFileSync(join(worktree, "check.sh"), "cat flooded.txt\nexit 1\n");
  git(worktree, "add", ".");
  git(worktree, "commit", "--quiet", "-m", "base");
  const base = git(worktree, "rev-parse", "HEAD");
  writeFileSync(join(worktree, "src", "feature.js"), "exports.feature = 1;\n");
  const checked = item("feature", {
    ownedPaths: ["src/feature.js"],
    validation: [{ command: "sh check.sh" }],
  });
  const log = new RunLog(logs, "2026-01-01T00-00-00-000Z-1", CAPTURE_OFF, []);
  const signal = AbortSignal.timeout(120_000);
  const validator = new SelfValidation(
    {
      worktree,
      item: checked,
      base,
      signal,
      log: () => {},
      runFile: (kind) => log.runFile(1, `item:feature:work#1.${kind}`),
    },
    {
      sandbox,
      plan: plan([checked], { base }),
      blocks: [],
      repository: REPO,
      commandTimeoutMs: 60_000,
    },
    signal,
  );
  const run = await validator.call();
  assert.equal(run.isError, false, run.text);
  return run;
}

test("a worker's Validate shows a failed command's errors that sit in the middle of more than 30,000 characters of warnings, within VALIDATE_RESULT_CHARS (#2201)", async () => {
  const run = await validated(flooded);
  assert.ok(
    run.text.startsWith(
      "Validation failed. Fix this before you finish.\nsh check.sh failed:\n",
    ),
    run.text.slice(0, 500),
  );
  assert.ok(run.text.length <= VALIDATE_RESULT_CHARS, String(run.text.length));
  for (const error of ERRORS) assert.ok(run.text.includes(error), run.text);
  assert.ok(run.text.includes("Found 2 errors in 1 file."));
  // The end of the output, and what was cut.
  assert.ok(run.text.includes(warnings(799, 1)));
  assert.match(run.text, /\n\[\d+ characters omitted\]\n/);
  assert.match(run.text, /\[Cut to fit: \d+ of \d+ characters omitted\./);
  // More of the output than the old 8,000-character tail: what the result
  // leaves.
  assert.ok(run.text.length > 20_000, String(run.text.length));
  assert.ok(
    Buffer.byteLength(run.text) <= VALIDATE_RESULT_CHARS,
    String(Buffer.byteLength(run.text)),
  );
});

test("a worker's Validate of output that takes several bytes a character stays within VALIDATE_RESULT_CHARS bytes, which Codex counts, and keeps the errors (#2201)", async () => {
  const output = `> check\n${codeFrames(0, 120)}\n${ERRORS[0]}\n${ERRORS[1]}\nFound 2 errors in 1 file.\n${codeFrames(120, 120)}\n`;
  assert.ok(Buffer.byteLength(output) > 1.3 * output.length);
  const run = await validated(output);
  assert.ok(
    Buffer.byteLength(run.text) <= VALIDATE_RESULT_CHARS,
    String(Buffer.byteLength(run.text)),
  );
  for (const error of ERRORS) assert.ok(run.text.includes(error), run.text);
  assert.ok(run.text.includes("src/module239.ts:10:23"), run.text);
});
