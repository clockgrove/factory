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
/** A linter's warnings, then a compiler's errors, then more warnings. */
const flooded = `> check\n${warnings(0, 400)}\n${ERRORS[0]}\n  3 const total: number = "none";\n${ERRORS[1]}\nFound 2 errors in 1 file.\n${warnings(400, 400)}\n`;

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
