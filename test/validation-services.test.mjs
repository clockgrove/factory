// Validation's throwaway services (#2291): every validation run (the
// validate step's, a worker's Validate, QA's, final validation's: all
// validateTree) starts the configured services fresh and empty for itself,
// and stops them when it ends. A real key-value server over a Unix socket,
// as `sandbox.services` configures it, and real validation runs of a real
// repository.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { CAPTURE_OFF, RunLog } from "../dist/log.js";
import { validateTree } from "../dist/validate.js";
import {
  closedPort,
  item,
  kvAsk,
  plan,
  servicesSandbox,
  tempDir,
} from "./helpers.mjs";

// The sandbox mounts the PATH's toolchains: this node, not a version shim.
process.env.PATH = `${dirname(process.execPath)}:/bin:/usr/bin`;

const git = (cwd, ...args) => {
  const result = spawnSync(
    "git",
    ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

/** A repository with a base and a candidate commit on it. */
function repository() {
  const checkout = tempDir("factory-validation-services-");
  git(checkout, "init", "--quiet");
  writeFileSync(join(checkout, "a.txt"), "a\n");
  git(checkout, "add", ".");
  git(checkout, "commit", "--quiet", "-m", "base");
  const base = git(checkout, "rev-parse", "HEAD");
  writeFileSync(join(checkout, "a.txt"), "b\n");
  git(checkout, "commit", "--quiet", "-am", "candidate");
  return { checkout, base, candidate: git(checkout, "rev-parse", "HEAD") };
}

const log = new RunLog(
  tempDir("factory-validation-services-logs-"),
  "2026-01-01T00-00-00-000Z-1",
  CAPTURE_OFF,
);

/**
 * Validate the candidate as Work Item `a` with `commands`, in `directory`,
 * under `sandbox`.
 */
function validate(target, directory, sandbox, commands) {
  const work = item("a", {
    validation: commands.map((command) => ({ command })),
  });
  return validateTree({
    checkout: target.checkout,
    repository: "example/target",
    directory: join(target.checkout, "..", directory),
    commit: target.candidate,
    item: work,
    plan: plan([work], { base: target.base }),
    blocks: [],
    base: target.base,
    sandbox,
    commandTimeoutMs: 60_000,
    signal: AbortSignal.timeout(120_000),
    log: () => {},
    runFile: (kind) => log.runFile(1, `item:a:validate#1.${kind}`),
  });
}

/** The services directories this process has now. */
const directories = () =>
  readdirSync(tmpdir()).filter((entry) =>
    entry.startsWith(`factory-services-${process.pid}-`),
  );

/**
 * A run's commands: the service starts empty, keeps what this run sets,
 * and `value` is still there after the other run had time to set its own.
 */
const commands = (value) => [
  `test "$(${kvAsk("get x")})" = none`,
  `test "$(${kvAsk(`set x ${value}`)})" = ${value} && sleep 1 && test "$(${kvAsk("get x")})" = ${value}`,
];

test("each validation run gets its own fresh services, passes only with them up, and stops them at its end (#2291)", async () => {
  const target = repository();
  const sandbox = servicesSandbox(await closedPort());
  // Two runs at once, then a third: each sees only its own service.
  const [first, second] = await Promise.all([
    validate(target, "first.validation", sandbox, commands("first")),
    validate(target, "second.validation", sandbox, commands("second")),
  ]);
  assert.equal(first.kind, "passed", JSON.stringify(first));
  assert.equal(second.kind, "passed", JSON.stringify(second));
  const third = await validate(
    target,
    "third.validation",
    sandbox,
    commands("third"),
  );
  assert.equal(third.kind, "passed", JSON.stringify(third));
  assert.deepEqual(directories(), [], "a run left its services directory");

  // Without the service the same commands fail: nothing else answers.
  const without = await validate(
    target,
    "without.validation",
    { ...sandbox, services: undefined },
    commands("without"),
  );
  assert.equal(without.kind, "failed", JSON.stringify(without));

  // A service that doesn't start holds with its output; no command runs.
  const broken = await validate(
    target,
    "broken.validation",
    {
      ...sandbox,
      services: {
        kv: {
          ...sandbox.services.kv,
          start: "echo no-such-server >&2; exit 4",
        },
      },
    },
    ["false"],
  );
  assert.equal(broken.kind, "hold", JSON.stringify(broken));
  assert.match(
    broken.question,
    /validation's service kv exited before it was ready \(exit 4\): no-such-server/,
  );
  assert.deepEqual(directories(), []);
});

test("each group of a validation's independent commands gets its own services (#2290)", async () => {
  const target = repository();
  const sandbox = servicesSandbox(await closedPort());
  const work = item("a", {
    validation: ["g0", "g1"].map((value, index) => ({
      command: commands(value).join(" && "),
      ...(index && { after: [] }),
    })),
  });
  const events = [];
  const result = await validateTree({
    checkout: target.checkout,
    repository: "example/target",
    directory: join(target.checkout, "..", "groups.validation"),
    commit: target.candidate,
    item: work,
    plan: plan([work], { base: target.base }),
    blocks: [],
    base: target.base,
    sandbox,
    commandTimeoutMs: 60_000,
    signal: AbortSignal.timeout(120_000),
    log: (event) => events.push(event),
    runFile: (kind) => log.runFile(1, `item:a:validate#2.${kind}`),
  });
  // Both groups ran at once, and each found its service empty: one
  // shared, or the run in declared order, sees the other's value.
  assert.equal(result.kind, "passed", JSON.stringify(result));
  const kinds = events.map((event) => event.event);
  assert.ok(kinds.includes("validation-groups"));
  assert.ok(!kinds.includes("validation-groups-rerun"));
  assert.deepEqual(directories(), []);
});
