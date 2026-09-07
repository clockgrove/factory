/** Small deterministic fixtures and raw-object proofs; not installed execution evidence. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { qualificationNamespace, qualificationNamespaceMarker } from "./verify-live-objective.mjs";
import { deduplicateQualificationReceipts } from "./qualification-receipts.mjs";
import { qualificationModelAccounting } from "./qualification-model-accounting.mjs";

export const failureHash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const failureBlob = (bytes) => createHash("sha1").update(`blob ${Buffer.byteLength(bytes)}\0`).update(bytes).digest("hex");
const one = (rows, message) => { assert.equal(rows.length, 1, message); return rows[0]; };
const sha = (value) => assert.match(value, /^[a-f0-9]{40}$/);

export function failureFixture(namespace, scenario) {
  assert.equal(typeof namespace, "string");
  qualificationNamespace(namespace);
  assert.ok(["failed-validation", "real-conflict"].includes(scenario));
  const prefix = `factory-faults/${namespace}`;
  const paths = { payload: `${prefix}/value.txt`, recipe: `${prefix}/recipe.mjs`, test: `${prefix}/value.test.mjs` };
  const output = scenario === "failed-validation" ? "invalid\n" : "worker\n";
  const files = {
    [paths.payload]: "baseline\n",
    [paths.recipe]: `import { writeFileSync } from 'node:fs';\nwriteFileSync(new URL('./value.txt', import.meta.url), ${JSON.stringify(output)});\n`,
    [paths.test]: `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';\ntest('immutable qualification value', () => {\n  const value = readFileSync(new URL('./value.txt', import.meta.url), 'utf8');\n  assert.ok(['baseline\\n', 'worker\\n'].includes(value), 'factory-qualification-invalid-value');\n});\n`,
  };
  return { protocol: "clockgrove.factory/failure-conflict-fixture-v1", namespace, scenario, paths, files, output,
    competing: "operator\n", validationCommand: `node --test ${paths.test}`, recipeCommand: `node ${paths.recipe}` };
}

export function failureObjectiveBody(namespace, scenario) {
  const fixture = failureFixture(namespace, scenario);
  return `# Explicit installed ${scenario} qualification\n\n${qualificationNamespaceMarker(namespace)}\n\n` +
    `Create exactly one Work Item, with no dependencies, to run the existing committed command \`${fixture.recipeCommand}\`. ` +
    `The only allowed write path is \`${fixture.paths.payload}\`; its exact resulting bytes must be ${JSON.stringify(fixture.output)}. ` +
    `Do not edit the recipe, test, package scripts, or any other file. Do not repair intentional qualification failures. ` +
    `The independent validation plan must contain exactly \`${fixture.validationCommand}\`. ` +
    `This is an explicitly authorized negative fixture: ${scenario === "failed-validation" ? "the unchanged validation must fail, and Factory must refuse publication" : "the completed worker output will be retained before an independently authorized competing trunk edit"}. ` +
    `Do not publish, merge, call Factory tools, or change GitHub settings.\n`;
}

// The source repository is only an object donor. No checkout, filters, hooks, fetch,
// inherited Git environment, or mutation of its index/config/ref is performed.
const gitOptions = ["--no-optional-locks", "--no-replace-objects", "--literal-pathspecs", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "credential.helper="];
export function rawFailureGit(repository, args, input, extraEnv = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_") && name !== "NODE_OPTIONS"));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0", ...extraEnv });
  const result = spawnSync("git", [...gitOptions, "-C", repository, ...args], { env, input, encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
  assert.ok(!result.error && !result.signal, "bounded raw Git operation unavailable");
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
const git = (repository, args, input, env) => {
  const result = rawFailureGit(repository, args, input, env);
  assert.equal(result.status, 0, "exact raw Git object operation failed");
  return result.stdout.trim();
};

export function assertFailureFixture(repository, baseSha, fixture) {
  sha(baseSha);
  assert.deepEqual(fixture, failureFixture(fixture.namespace, fixture.scenario));
  assert.equal(git(repository, ["rev-parse", "--verify", `${baseSha}^{commit}`]), baseSha);
  for (const [path, content] of Object.entries(fixture.files)) {
    const line = git(repository, ["ls-tree", baseSha, "--", path]);
    assert.equal(line, `100644 blob ${failureBlob(content)}\t${path}`, "committed fixture bytes/mode differ");
  }
  const packageBytes = git(repository, ["cat-file", "blob", `${baseSha}:package.json`]);
  assert.equal(JSON.parse(packageBytes).scripts?.test, "node --test", "fixture requires the existing grounded bare Node test entrypoint");
  return { baseSha, baseTreeSha: git(repository, ["rev-parse", `${baseSha}^{tree}`]), fixtureDigest: failureHash(JSON.stringify(fixture)) };
}

/** Independently applies actual authenticated worker bytes and proves a real same-line conflict. */
export function proveFailureContent({ repository, baseSha, artifact, fixture }) {
  const baseline = assertFailureFixture(repository, baseSha, fixture);
  assert.equal(artifact.baseSha, baseSha);
  assert.deepEqual(artifact.changedPaths, [fixture.paths.payload]);
  assert.equal(artifact.outcome, "succeeded");
  assert.equal(artifact.payload, undefined, "small fixture cannot use a display-only payload marker");
  assert.ok(typeof artifact.patch === "string" && Buffer.byteLength(artifact.patch) <= 16384);
  const root = mkdtempSync(join(tmpdir(), "factory-failure-objects-"));
  try {
    const template = join(root, "empty-template");
    mkdirSync(template, { mode: 0o700 });
    git(root, ["init", "--bare", `--template=${template}`, "."]);
    const objects = resolve(repository, git(repository, ["rev-parse", "--git-path", "objects"]));
    assert.ok(!objects.includes(":") && !objects.includes("\n"));
    const env = { GIT_ALTERNATE_OBJECT_DIRECTORIES: objects, GIT_INDEX_FILE: join(root, "private-index"),
      GIT_AUTHOR_NAME: "Factory qualification", GIT_AUTHOR_EMAIL: "qualification@example.invalid", GIT_COMMITTER_NAME: "Factory qualification", GIT_COMMITTER_EMAIL: "qualification@example.invalid", GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" };
    git(root, ["read-tree", baseSha], undefined, env);
    git(root, ["apply", "--cached", "--binary", "--whitespace=nowarn", "-"], artifact.patch, env);
    const workerTree = git(root, ["write-tree"], undefined, env);
    assert.equal(git(root, ["diff-tree", "--no-commit-id", "--name-only", "-r", baseline.baseTreeSha, workerTree], undefined, env), fixture.paths.payload);
    assert.equal(git(root, ["ls-tree", workerTree, "--", fixture.paths.payload], undefined, env), `100644 blob ${failureBlob(fixture.output)}\t${fixture.paths.payload}`);
    const result = { ...baseline, artifactDigest: artifact.digest, patchDigest: failureHash(artifact.patch), path: fixture.paths.payload, workerTree,
      baseBlob: failureBlob(fixture.files[fixture.paths.payload]), workerBlob: failureBlob(fixture.output) };
    if (fixture.scenario === "failed-validation") return result;
    const workerCommit = git(root, ["commit-tree", workerTree, "-p", baseSha], "Actual retained worker tree\n", env);
    git(root, ["read-tree", baseSha], undefined, env);
    const competingBlob = git(root, ["hash-object", "-w", "--stdin"], fixture.competing, env);
    git(root, ["update-index", "--add", "--cacheinfo", `100644,${competingBlob},${fixture.paths.payload}`], undefined, env);
    const competingTree = git(root, ["write-tree"], undefined, env);
    const competingCommit = git(root, ["commit-tree", competingTree, "-p", baseSha], "Competing qualification tree\n", env);
    const merge = rawFailureGit(root, ["merge-tree", "--write-tree", "--messages", workerCommit, competingCommit], undefined, env);
    assert.equal(merge.status, 1, "actual retained worker output does not conflict");
    assert.ok(merge.stdout.includes(`CONFLICT (content): Merge conflict in ${fixture.paths.payload}`), "expected same-file content conflict unavailable");
    assert.equal(merge.stderr, "");
    return { ...result, workerCommit, competingBlob, competingTree, competingCommit,
      conflict: { exitCode: 1, output: merge.stdout, outputDigest: failureHash(merge.stdout), boundary: "raw Git three-way content conflict; no filesystem application" } };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

export function failureEvents(observation, authority) {
  const events = deduplicateQualificationReceipts(observation.receipts).map(({ event }) => event);
  const start = one(events.filter((event) => event.event === "FactoryRunStarted"), "one original run required");
  assert.equal(start.runId, observation.status.run.runId);
  assert.equal(start.activationRequestId, `${authority.namespace}-activate`);
  assert.deepEqual(start.policy, authority.policy);
  assert.equal(start.repository, authority.repository);
  const run = events.filter((event) => event.runId === start.runId);
  const reserved = one(run.filter((event) => event.event === "AttemptReserved"), "one original attempt, no replacement");
  const started = one(run.filter((event) => event.event === "AttemptStarted"), "actual worker execution required");
  assert.equal(reserved.attempt, 1);
  assert.equal(reserved.backend, "codex-app-server/local-worktree");
  for (const key of ["runId", "objective", "workItem", "attempt", "baseSha", "policyDigest", "directorEpoch", "backend"]) assert.equal(started[key], reserved[key]);
  assert.equal(reserved.policyDigest, start.policyDigest);
  assert.equal(reserved.baseSha, authority.failure.baseSha);
  assert.equal(one(observation.children, "exactly one compiled Work Item required").number, reserved.workItem);
  const compiled = one(run.filter((event) => event.event === "GraphCompiled"), "one original compiled graph required");
  const projected = one(run.filter((event) => event.event === "GraphProjected"), "one original projection required");
  assert.equal(compiled.graphSize, 1); assert.equal(projected.graphSize, 1);
  assert.equal(compiled.graphDigest, projected.graphDigest);
  assert.equal(compiled.baseSha, reserved.baseSha);
  assert.ok(started.sequence > reserved.sequence);
  assert.ok(!run.some((event) => ["PublicationRecorded", "AttemptPublished", "AttemptIntegrated", "AttemptValidated", "FactoryRunCompleted"].includes(event.event)), "negative case reached publication/integration");
  return { run, start, reserved, started };
}

export function assertFailureAccounting(run) {
  const model = qualificationModelAccounting(run, { requireMarkers: true });
  assert.equal(model.unresolved.length, 0, "unknown model invocation cannot be qualified");
  const actual = run.filter((event) => event.event === "BudgetReconciled");
  const identity = (event) => JSON.stringify([event.runId, event.objective, event.workItem, event.attempt, event.phase, event.unit, event.usageId]);
  const keys = new Set();
  for (const event of actual) {
    assert.ok(Number.isSafeInteger(event.amount) && event.amount >= 0);
    assert.notEqual(event.usageEvidence, "conservative-reservation", "complete measured accounting required");
    assert.ok(!keys.has(identity(event)), "duplicate actual accounting identity");
    keys.add(identity(event));
  }
  for (const reserved of run.filter((event) => event.event === "BudgetReserved" && !event.modelInvocationId))
    one(actual.filter((event) => identity(event) === identity(reserved)), "unreconciled native budget");
  assert.ok(model.usage.some((event) => event.phase === "management") && model.usage.some((event) => event.phase === "execution"));
  assert.ok(actual.some((event) => event.unit === "local_milliseconds" && event.phase === "execution"));
  return { modelTokens: model.total, actual };
}

export function assertFailedValidation(observation, authority, fixture) {
  const { run, reserved, started } = failureEvents(observation, authority);
  const validation = one(run.filter((event) => event.event === "ValidationRecorded"), "actual failed validation receipt required");
  assert.equal(validation.passed, false);
  for (const key of ["workItem", "attempt", "baseSha"]) assert.equal(validation[key], reserved[key]);
  sha(validation.outputTreeSha);
  assert.match(validation.evidenceDigest, /^[a-f0-9]{64}$/);
  assert.ok(validation.sequence > started.sequence);
  const failed = one(run.filter((event) => event.event === "AttemptFailed"), "failed validation attempt required");
  assert.ok(failed.sequence > validation.sequence);
  const expected = `validation failed (1): ${fixture.validationCommand}`;
  assert.ok(failed.reason === expected || failed.reason?.startsWith(`${expected}\nOutput tail:\n`), "attempt failed at a different boundary");
  assert.ok(failed.reason.includes("factory-qualification-invalid-value"), "immutable assertion diagnostic missing");
  one(run.filter((event) => event.event === "FactoryRunEscalated"), "bounded escalation required");
  assert.ok(!run.some((event) => event.phase === "management" && String(event.usageId ?? "").startsWith("review-")), "failed validation reached semantic review");
  const accounting = assertFailureAccounting(run);
  assert.ok(accounting.actual.some((event) => event.unit === "validation_milliseconds"));
  for (const capacity of run.filter((event) => event.event === "CapacityReserved"))
    one(run.filter((event) => event.event === "CapacityReconciled" && event.workItem === capacity.workItem && event.attempt === capacity.attempt && event.phase === capacity.phase && event.backend === capacity.backend), "capacity cleanup accounting incomplete");
  return { runId: reserved.runId, workItem: reserved.workItem, validation, accounting };
}

export function assertConflictPreserved(before, after, authority, cancelled = false) {
  const original = failureEvents(before, authority), final = failureEvents(after, authority);
  assert.deepEqual(final.start, original.start);
  const kinds = new Set(["attempt", "budget", "validation", "publication", "graph"]);
  assert.deepEqual(final.run.filter((event) => kinds.has(event.kind)), original.run.filter((event) => kinds.has(event.kind)), "conflict continuation repeated or changed work/accounting");
  assert.ok(!final.run.some((event) => event.event === "FactoryRunEscalated"), "unexpected terminal escalation");
  if (cancelled) {
    const request = one(final.run.filter((event) => event.event === "FactoryRunCancellationRequested" && event.requestId === `${authority.namespace}-cancel`), "exact cleanup cancellation request required");
    const terminal = one(final.run.filter((event) => event.event === "FactoryRunCancelled"), "same-run cancellation completion required");
    assert.ok(terminal.sequence > request.sequence);
  } else assert.ok(!final.run.some((event) => event.event === "FactoryRunCancelled"), "terminal runs are not continuation fixtures");
  return assertFailureAccounting(final.run);
}
