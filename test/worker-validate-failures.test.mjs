// A planned validation command the worker's own Validate fails is evidence
// an amendment can replace it on (#2199). Live (Codex, a replay), the plan
// gave a Work Item a command that split a document at its first `---`, a
// Markdown table's separator row, so it could never pass. The worker's
// Validate found it and the worker proposed the one-token fix, but only a
// command the validate step had failed was replaceable: the amendment was
// rejected twice, operator approval included, and the item had to fail the
// validate step first. Validate now keeps each failed command, how it ended
// and its output, until a later run passes it, and the worker's finished
// result carries them into the item's `workerValidateFailed` fact
// (planning/amendments.ts reads it). Claude's, Codex's and Copilot's workers
// all return them from the same SelfValidation.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../dist/config.js";
import { CAPTURE_OFF, RunLog } from "../dist/log.js";
import { SelfValidation, validateFailed } from "../dist/work/self-validate.js";
import { workerFailedKept } from "../dist/work/step-work.js";
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

const { sandbox, logs } = loaded();
const ACCEPTED_AT = "2026-01-01T00:00:00.000Z";
const PRESENT = "test -f docs/guide.md";
// Counts the section's mentions: grep exits 1, printing 0, when it has none.
const SECTION = "grep -c Rollout docs/guide.md";
const guide = item("guide", {
  ownedPaths: ["docs/guide.md"],
  validation: [{ command: PRESENT }, { command: SECTION }],
});

test("the worker's Validate keeps a failed command, how it ended and its output until a later run passes it, and its finished result keeps them as the item's workerValidateFailed fact (#2199)", async () => {
  const worktree = join(tempDir("factory-worker-failures-"), "w");
  mkdirSync(join(worktree, "docs"), { recursive: true });
  git(worktree, "init", "--quiet");
  writeFileSync(join(worktree, "README.md"), "base\n");
  git(worktree, "add", ".");
  git(worktree, "commit", "--quiet", "-m", "base");
  const base = git(worktree, "rev-parse", "HEAD");
  writeFileSync(join(worktree, "docs", "guide.md"), "# Guide\n");
  const log = new RunLog(logs, "2026-01-01T00-00-00-000Z-1", CAPTURE_OFF, []);
  const signal = AbortSignal.timeout(120_000);
  const validator = new SelfValidation(
    {
      worktree,
      item: guide,
      base,
      signal,
      log: () => {},
      runFile: (kind) => log.runFile(1, `item:guide:work#1.${kind}`),
    },
    {
      sandbox,
      plan: plan([guide], { base }),
      blocks: [],
      repository: REPO,
      commandTimeoutMs: 60_000,
    },
    signal,
  );
  const failed = await validator.call();
  assert.equal(failed.isError, false, failed.text);
  assert.ok(failed.text.startsWith("Validation failed."), failed.text);
  // The command that passed first is no evidence; the one that failed is.
  const failures = validator.failures();
  assert.equal(failures.length, 1, JSON.stringify(failures));
  const [failure] = failures;
  assert.equal(failure.command, SECTION);
  assert.equal(failure.exit, "1");
  assert.ok(
    failure.output.startsWith(`Validation command failed (1): ${SECTION}: `),
    failure.output,
  );
  assert.deepEqual(validateFailed(validator), { validateFailed: failures });
  // A worker run that finished with them keeps them under the plan
  // accepted now.
  const state = { kept: { "plan:acceptedAt": ACCEPTED_AT } };
  assert.deepEqual(workerFailedKept(state, "guide", failures), {
    "item:guide:workerValidateFailed": { plan: ACCEPTED_AT, failures },
  });

  // Once a run passes the command, it can pass: nothing is kept, and the
  // next finished run deletes the fact.
  writeFileSync(join(worktree, "docs", "guide.md"), "# Guide\n\nRollout\n");
  const passed = await validator.call();
  assert.ok(passed.text.startsWith("All 2 declared"), passed.text);
  assert.deepEqual(validator.failures(), []);
  assert.deepEqual(validateFailed(validator), {});
  assert.deepEqual(validateFailed(undefined), {});
  assert.deepEqual(workerFailedKept(state, "guide", undefined), {
    "item:guide:workerValidateFailed": null,
  });
});
