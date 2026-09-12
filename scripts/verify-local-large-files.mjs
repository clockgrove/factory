/** Explicit installed large-file qualification. No opt-in means no actions.
 * Preparation and execution are separate; this runner never publishes a fixture
 * baseline or invents worker/transfer receipts. Live evidence is private.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  mkdtempSync,
  readSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkpointAuthority,
  checkpointReady,
  checkpointFacts,
  checkpointCompletionReady,
  main as checkpointMain,
} from "./verify-local-checkpoint-restart.mjs";
import { qualificationNamespaceMarker } from "./verify-live-objective.mjs";
import {
  LARGE_FILE_RECIPE_VERSION,
  LARGE_FILE_VALIDATION_COMMAND,
  LARGE_FILE_VALIDATION_SCRIPT,
  largeFileObjectiveBody,
  largeFileValidationRecipe,
  observeLargeFileTree,
  largeFilePaths,
  assertLargeFileFinalTree,
  assertLargeFileArtifact,
} from "./qualification-large-files.mjs";
import { observeArtifactTransfer } from "./qualification-artifact-transfer.mjs";
import { createLargeFileRefusalPorts } from "./qualification-large-file-refusals.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const canonical = (value) =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
          .join(",")}}`
      : JSON.stringify(value);
const cases = new Set([
  "transfer-restart",
  "lfs-missing-tool",
  "lfs-missing-object",
  "scope",
  "secret",
  "symlink",
]);
const terminal = new Set(["FactoryRunCompleted", "FactoryRunCancelled", "FactoryRunEscalated"]);
const one = (rows, message = "one exact qualification receipt required") => {
  assert.equal(rows.length, 1, message);
  return rows[0];
};
const safePath = (path) => {
  assert.match(path ?? "", /^\/[A-Za-z0-9_./-]+$/);
  assert.equal(resolve(path), path);
  return path;
};

export function largeFileAuthority(env) {
  if (env.FACTORY_LOCAL_LARGE_FILES !== "1") return null;
  const scenario = env.FACTORY_LARGE_FILE_CASE;
  assert.ok(cases.has(scenario), "an explicit supported large-file case is required");
  assert.ok(env.FACTORY_LARGE_FILE_MAX_MODEL_TOKENS, "explicit scenario allowance required");
  const actions =
    scenario === "transfer-restart"
      ? "start,create,arm-transfer-intent,activate,pause,restart,resume,stop"
      : scenario.startsWith("lfs-")
        ? "create,compile-refusal"
        : "start,create,activate,stop";
  if (env.FACTORY_LARGE_FILE_PHASE === "exercise")
    assert.equal(
      env.FACTORY_LARGE_FILE_ACK,
      `${env.FACTORY_LARGE_FILE_REPOSITORY}:${env.FACTORY_LARGE_FILE_CONTROLLER_UNIT}:${scenario}:${actions}`,
      "explicit scenario, lifecycle and fault authority required",
    );
  const mapped = {
    ...env,
    FACTORY_LOCAL_CHECKPOINT_RESTART: "1",
    FACTORY_CHECKPOINT_BACKEND: "app-server",
    FACTORY_CHECKPOINT_PHASE: env.FACTORY_LARGE_FILE_PHASE,
    FACTORY_CHECKPOINT_REPOSITORY: env.FACTORY_LARGE_FILE_REPOSITORY,
    FACTORY_CHECKPOINT_CHECKOUT: env.FACTORY_LARGE_FILE_CHECKOUT,
    FACTORY_CHECKPOINT_CONTROLLER_UNIT: env.FACTORY_LARGE_FILE_CONTROLLER_UNIT,
    FACTORY_CHECKPOINT_NAMESPACE: env.FACTORY_LARGE_FILE_NAMESPACE,
    FACTORY_CHECKPOINT_MAX_MODEL_TOKENS: env.FACTORY_LARGE_FILE_MAX_MODEL_TOKENS,
    FACTORY_CHECKPOINT_EVIDENCE: env.FACTORY_LARGE_FILE_EVIDENCE,
    // The broader lifecycle is authorized above by the exact scenario ACK; this
    // mapping reuses the existing authority validator, not an authorization bypass.
    FACTORY_CHECKPOINT_ACK: `${env.FACTORY_LARGE_FILE_REPOSITORY}:${env.FACTORY_LARGE_FILE_CONTROLLER_UNIT}:start,arm-terminal-artifact-hold,pause,restart,resume,stop`,
  };
  const authority = checkpointAuthority(mapped);
  assert.ok(authority);
  // The shared checkpoint policy also fences replacement during transfer restart.
  assert.equal(authority.policy.maxAttemptsPerItem, 1);
  return {
    ...authority,
    largeFile: {
      scenario,
      fixture: safePath(env.FACTORY_LARGE_FILE_FIXTURE),
      fixtureDigest: env.FACTORY_LARGE_FILE_FIXTURE_SHA256,
    },
  };
}

function privateDocument(path, maxBytes = 1048576) {
  safePath(path);
  const directory = lstatSync(dirname(path));
  assert.ok(directory.isDirectory() && !directory.isSymbolicLink());
  assert.equal(directory.uid, process.getuid());
  assert.equal(directory.mode & 0o777, 0o700);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    assert.ok(before.isFile() && before.size <= maxBytes && before.nlink === 1);
    assert.equal(before.uid, process.getuid());
    assert.equal(before.mode & 0o777, 0o600);
    const bytes = Buffer.alloc(before.size + 1);
    assert.equal(readSync(fd, bytes, 0, bytes.length, 0), before.size);
    const after = fstatSync(fd);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(after.ctimeMs, before.ctimeMs);
    const content = bytes.subarray(0, before.size);
    return { value: JSON.parse(content.toString("utf8")), digest: hash(content) };
  } finally {
    closeSync(fd);
  }
}

export function transferArmPath(unit, invocationId, uid = process.getuid()) {
  assert.match(unit, /^clockgrove-factory-[a-f0-9]{16}\.service$/);
  assert.match(invocationId, /^[a-f0-9]{32}$/);
  return join(
    tmpdir(),
    `factory-artifact-transfer-checkpoints-${uid}`,
    `${hash(`${unit}\0${invocationId}`)}.json`,
  );
}

export function largeFileTransferArm(authority, producer, objective, baseSha) {
  assert.equal(authority.largeFile.scenario, "transfer-restart");
  const objectiveTimeoutMinutes = authority.policy.objectiveTimeoutMinutes,
    workItemTimeoutMinutes = authority.policy.workItemTimeoutMinutes;
  assert.ok(Number.isInteger(objectiveTimeoutMinutes) && objectiveTimeoutMinutes >= 1);
  assert.ok(Number.isInteger(workItemTimeoutMinutes) && workItemTimeoutMinutes >= 1);
  return {
    protocol: "clockgrove.factory/artifact-transfer-checkpoint-arm-v2",
    repository: authority.repository,
    objective,
    activationRequestId: `${authority.namespace}-activate`,
    policyDigest: hash(canonical(authority.policy)),
    baseSha,
    unit: producer.unit,
    invocationId: producer.invocationId,
    hostIdentity: producer.hostIdentity,
    producerPid: producer.pid,
    producerStartTicks: producer.startTicks,
    minPayloadBytes: 5 * 1024 * 1024 + 1,
    eligibilityDurationMs: objectiveTimeoutMinutes * 60_000,
    holdDurationMs: workItemTimeoutMinutes * 60_000,
  };
}

export function transferHoldReady(observation, authority, arm) {
  const witness = observation.transferCheckpoint;
  if (!witness) return false;
  const events = observation.receipts.map(({ event }) => event);
  const start = one(events.filter((event) => event.event === "FactoryRunStarted"));
  assert.equal(start.activationRequestId, `${authority.namespace}-activate`);
  assert.deepEqual(start.policy, authority.policy);
  assert.equal(start.repository, authority.repository);
  assert.equal(start.runId, observation.status.run.runId);
  assert.ok(
    [
      "clockgrove.factory/artifact-transfer-checkpoint-reached-v1",
      "clockgrove.factory/artifact-transfer-checkpoint-reached-v2",
    ].includes(witness.protocol),
  );
  assert.equal(witness.armDigest, arm.digest);
  assert.equal(witness.runId, start.runId);
  assert.equal(witness.policyDigest, start.policyDigest);
  assert.equal(witness.objective, start.objective);
  const reserved = one(events.filter((event) => event.event === "AttemptReserved"));
  assert.equal(reserved.attempt, 1);
  assert.equal(reserved.backend, "codex-app-server/local-worktree");
  for (const key of [
    "runId",
    "objective",
    "workItem",
    "attempt",
    "directorEpoch",
    "policyDigest",
    "baseSha",
  ])
    assert.equal(witness[key], reserved[key]);
  assert.deepEqual(witness.batch, reserved.localScopeBatch);
  assert.ok(witness.payloadBytes > 5 * 1024 * 1024);
  const started = one(events.filter((event) => event.event === "AttemptStarted"));
  assert.equal(started.workItem, reserved.workItem);
  assert.equal(started.attempt, 1);
  const model = one(
    events.filter(
      (event) =>
        event.event === "BudgetReconciled" &&
        event.workItem === reserved.workItem &&
        event.attempt === 1 &&
        event.phase === "execution" &&
        event.unit === "model_tokens",
    ),
  );
  assert.equal(witness.terminal.modelTokens, model.amount);
  assert.equal(witness.terminal.usageId, model.usageId);
  assert.equal(model.usageId, `worker-${reserved.workItem}-1`);
  assert.ok(
    !events.some(
      (event) =>
        terminal.has(event.event) ||
        [
          "AttemptSucceeded",
          "AttemptCollected",
          "AttemptFailed",
          "AttemptDeferred",
          "AttemptCancelled",
          "ValidationRecorded",
          "PublicationRecorded",
        ].includes(event.event),
    ),
    "transfer boundary already passed or original attempt failed",
  );
  one(
    events.filter(
      (event) =>
        event.event === "RunPauseRequested" && event.requestId === `${authority.namespace}-pause`,
    ),
  );
  return true;
}

export async function runLargeFileScenario(port, authority) {
  const before = await port.preflight();
  if (authority.phase === "preflight") return { result: "preflight-only", before };
  const scenario = authority.largeFile.scenario;
  if (scenario.startsWith("lfs-")) {
    await port.action("create");
    const refusal = await port.compileRefusal();
    return { result: "passed", scope: "installed-pre-compilation-refusal-only", refusal };
  }
  await port.action("start");
  const original = await port.controller("active");
  await port.action("create");
  if (scenario !== "transfer-restart") {
    await port.action("activate");
    const stoppedRun = await port.poll("expected-artifact-refusal", (value) =>
      value.receipts.some(({ event }) => terminal.has(event.event)),
    );
    const refusal = await port.artifactRefusal(stoppedRun);
    const scopes = await port.absence(stoppedRun, [original], true);
    await port.controller("active", original);
    await port.action("stop");
    const stopped = await port.controller("inactive");
    return { result: "passed", scope: "installed-artifact-refusal-only", refusal, scopes, stopped };
  }
  const arm = await port.armTransfer(original);
  await port.action("activate");
  await port.poll("worker-start", (value) =>
    value.receipts.some(({ event }) => event.event === "AttemptStarted"),
  );
  await port.action("pause");
  const held = await port.poll("transfer-intent-hold", (value) =>
    transferHoldReady(value, authority, arm),
  );
  const intent = await port.transferProof(held, "intent", held.transferCheckpoint);
  const stable = held.receipts
    .map(({ event }) => event)
    .filter((event) => ["attempt", "budget", "graph"].includes(event.kind));
  await port.checkpoint({
    checkpoint: held,
    facts: { runId: held.status.run.runId, stable },
    original,
    intent,
  });
  await port.controller("active", original);
  await port.action("restart");
  const replacement = await port.controller("active");
  assert.notEqual(replacement.invocationId, original.invocationId);
  assert.equal(replacement.hostIdentity, original.hostIdentity);
  await port.takeover(held);
  const paused = await port.poll("recovered-transfer-pause", (value) =>
    checkpointReady(value, authority, port.pauseRequestId),
  );
  const facts = checkpointFacts(paused, authority, port.pauseRequestId);
  assert.equal(facts.runId, held.status.run.runId);
  for (const event of stable)
    assert.ok(
      facts.stable.some((candidate) => canonical(candidate) === canonical(event)),
      "original receipt changed during transfer recovery",
    );
  const ready = await port.transferProof(paused, "ready", held.transferCheckpoint);
  assert.equal(ready.artifactDigest, intent.artifactDigest);
  assert.equal(ready.intentOid, intent.intentOid);
  const scopes = await port.absence(paused, [original, replacement]);
  await port.controller("active", replacement);
  await port.action("resume");
  const completed = await port.poll("completed", (value) =>
    checkpointCompletionReady(value, authority, port.pauseRequestId),
  );
  const final = checkpointFacts(completed, authority, port.pauseRequestId, false);
  assert.equal(final.runId, facts.runId);
  await port.finalProof(completed, original, replacement);
  const finalScopes = await port.absence(completed, [original, replacement]);
  await port.controller("active", replacement);
  await port.action("stop");
  const stopped = await port.controller("inactive");
  return {
    result: "passed",
    scope: "installed-large-file-transfer-and-lfs-preservation",
    original,
    replacement,
    intent,
    ready,
    scopes,
    final,
    finalScopes,
    stopped,
  };
}

function exclusiveJson(path, value, maximum = 64 * 1024 * 1024) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  assert.ok(bytes.length <= maximum, "qualification evidence exceeds its byte bound");
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
  return { path, bytes: bytes.length, sha256: hash(bytes) };
}

function checkedFixture(authority) {
  assert.match(authority.largeFile.fixtureDigest ?? "", /^[a-f0-9]{64}$/);
  const document = privateDocument(authority.largeFile.fixture);
  assert.equal(document.digest, authority.largeFile.fixtureDigest, "fixture descriptor changed");
  const fixture = document.value;
  assert.equal(fixture.version, LARGE_FILE_RECIPE_VERSION);
  assert.equal(fixture.namespace, authority.namespace);
  assert.deepEqual(fixture.paths, largeFilePaths(authority.namespace));
  assert.match(fixture.baseSha, /^[a-f0-9]{40}$/);
  assert.match(fixture.baseTreeSha, /^[a-f0-9]{40}$/);
  assert.match(fixture.sourceBaseSha, /^[a-f0-9]{40}$/);
  assert.match(fixture.sourceTreeSha, /^[a-f0-9]{40}$/);
  assert.equal(fixture.root, dirname(authority.largeFile.fixture));
  assert.equal(realpathSync(fixture.root), fixture.root);
  assert.equal(realpathSync(fixture.repository), fixture.repository);
  assert.ok(fixture.repository.startsWith(`${fixture.root}/`));
  assert.equal(fixture.lfs.length, 2);
  assert.equal(fixture.expected.length, 4);
  assert.deepEqual(fixture.validation, {
    command: LARGE_FILE_VALIDATION_COMMAND,
    script: LARGE_FILE_VALIDATION_SCRIPT,
    recipe: largeFileValidationRecipe(authority.namespace),
    packagePath: "package.json",
    sourcePackageDigest: fixture.validation?.sourcePackageDigest,
    packageDigest: fixture.validation?.packageDigest,
  });
  assert.match(fixture.validation.sourcePackageDigest, /^[a-f0-9]{64}$/);
  assert.match(fixture.validation.packageDigest, /^[a-f0-9]{64}$/);
  return fixture;
}

function objectiveBody(authority) {
  const fixture = checkedFixture(authority);
  const scenario = authority.largeFile.scenario;
  let body = largeFileObjectiveBody(authority.namespace);
  if (["scope", "secret", "symlink"].includes(scenario)) {
    body =
      `Exercise the committed bounded negative-artifact fixture for ${scenario}. ` +
      `Create exactly one Work Item, with no dependencies, which invokes node ${fixture.paths.recipe} ${scenario}. ` +
      `Do not alter the recipe, baseline test, attributes or LFS pointers. ` +
      `Allowed output path is only ${fixture.paths.payload}. Do not repair or normalize the deliberately invalid fixture output. ` +
      `This is synthetic qualification content, not a real credential or an authorization to change any other path. ` +
      `Validation command: ${LARGE_FILE_VALIDATION_COMMAND}, the repository's committed Vitest entry point. ` +
      `Factory is expected to reject the produced artifact; do not fabricate a successful artifact or change the acceptance boundary.\n`;
  }
  return `${body}\n${qualificationNamespaceMarker(authority.namespace)}\n`;
}

function verifyBaseline({ authority, evidence, command }) {
  const fixture = checkedFixture(authority);
  const pinnedBlob = (treeish, path) => {
    assert.match(treeish, /^[a-f0-9]{40}$/);
    assert.match(path, /^[A-Za-z0-9_./-]+$/);
    const raw = spawnSync(
      "git",
      ["-c", "core.hooksPath=/dev/null", "cat-file", "blob", `${treeish}:${path}`],
      {
        cwd: authority.checkout,
        encoding: null,
        timeout: 15000,
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_NO_LAZY_FETCH: "1",
        },
      },
    );
    assert.equal(raw.status, 0, "pinned baseline blob unavailable");
    return raw.stdout;
  };
  assert.equal(
    fixture.sourceBaseSha,
    evidence.sourceCommit,
    "fixture source must match the exact committed qualification harness candidate",
  );
  assert.equal(
    evidence.base,
    fixture.baseSha,
    "publish the exact prepared baseline before this scenario",
  );
  assert.equal(
    command("git", ["rev-parse", `${fixture.baseSha}^{tree}`], authority.checkout),
    fixture.baseTreeSha,
  );
  assert.equal(
    command("git", ["rev-parse", `${fixture.baseSha}^`], authority.checkout),
    fixture.sourceBaseSha,
  );
  assert.equal(
    command("git", ["rev-parse", `${fixture.sourceBaseSha}^{tree}`], authority.checkout),
    fixture.sourceTreeSha,
  );
  const sourcePackage = pinnedBlob(fixture.sourceBaseSha, "package.json");
  const fixturePackage = pinnedBlob(fixture.baseSha, "package.json");
  assert.equal(hash(sourcePackage), fixture.validation.sourcePackageDigest);
  assert.equal(hash(fixturePackage), fixture.validation.packageDigest);
  const sourcePackageJson = JSON.parse(sourcePackage.toString("utf8"));
  const packageJson = JSON.parse(fixturePackage.toString("utf8"));
  assert.equal(
    sourcePackageJson.scripts?.test,
    "vitest run",
    "version-2 large-file fixture requires the committed Vitest npm test recipe",
  );
  assert.equal(sourcePackageJson.scripts[LARGE_FILE_VALIDATION_SCRIPT], undefined);
  const expectedPackageJson = structuredClone(sourcePackageJson);
  expectedPackageJson.scripts[LARGE_FILE_VALIDATION_SCRIPT] = largeFileValidationRecipe(
    fixture.namespace,
  );
  assert.deepEqual(
    packageJson,
    expectedPackageJson,
    "fixture package changed beyond its scoped test recipe",
  );
  for (const entry of fixture.baseline) {
    assert.ok(entry.path.startsWith(`${fixture.paths.prefix}/`));
    const raw = pinnedBlob(fixture.baseSha, entry.path);
    assert.equal(raw.length, entry.bytes);
    assert.equal(hash(raw), entry.digest);
    const index = command(
      "git",
      ["ls-tree", fixture.baseSha, "--", entry.path],
      authority.checkout,
    );
    assert.ok(index.startsWith(`${entry.mode} blob `));
  }
  // This scenario intentionally has exactly two synthetic pointers. An inherited
  // pointer would need its own provisioned content and cannot silently count as
  // demonstrated by this fixture's cache proof. Inspect raw blobs, not filters.
  const listing = command("git", ["ls-tree", "-r", "-l", "-z", fixture.baseSha], authority.checkout)
    .split("\0")
    .filter(Boolean);
  assert.ok(listing.length <= 5000, "fixture baseline exceeds bounded file inventory");
  const pointers = [];
  for (const row of listing) {
    const match = /^(\d{6}) (blob|commit) ([a-f0-9]{40}) +([0-9]+|-)\t(.+)$/s.exec(row);
    assert.ok(match, "unrecognized raw tree entry");
    const [, mode, type, oid, size, path] = match;
    assert.ok(
      type === "blob" && ["100644", "100755"].includes(mode),
      "fixture source must be regular files",
    );
    if (Number(size) >= 1024) continue;
    const content = command("git", ["cat-file", "blob", oid], authority.checkout);
    if (
      /^version https:\/\/(?:git-lfs\.github\.com\/spec\/v1|hawser\.github\.com\/spec\/v1)(?:\r?\n|$)/.test(
        content,
      )
    )
      pointers.push(path);
  }
  assert.deepEqual(
    pointers.sort(),
    fixture.lfs.map(({ path }) => path).sort(),
    "fixture source contains additional LFS assets; prepare a baseline containing only the two qualified pointers",
  );
  const scenario = authority.largeFile.scenario;
  const toolAvailable = (process.env.PATH ?? "")
    .split(":")
    .filter((path) => path.startsWith("/"))
    .some((path) => {
      try {
        const file = lstatSync(realpathSync(join(path, "git-lfs")));
        return file.isFile() && (file.mode & 0o111) !== 0;
      } catch {
        return false;
      }
    });
  assert.equal(
    toolAvailable,
    scenario !== "lfs-missing-tool",
    "LFS tool precondition does not match the scenario",
  );
  const gitDirectory = command(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    authority.checkout,
  );
  let missing = 0;
  const cache = fixture.lfs.map((asset) => {
    assert.match(asset.oid, /^[a-f0-9]{64}$/);
    const path = join(
      gitDirectory,
      "lfs",
      "objects",
      asset.oid.slice(0, 2),
      asset.oid.slice(2, 4),
      asset.oid,
    );
    try {
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const meta = fstatSync(fd);
        assert.ok(meta.isFile());
        assert.equal(meta.size, asset.size);
        assert.ok(meta.size <= 1024 * 1024, "qualification LFS object unexpectedly large");
        const bytes = Buffer.alloc(meta.size + 1);
        assert.equal(readSync(fd, bytes, 0, bytes.length, 0), meta.size);
        assert.equal(hash(bytes.subarray(0, meta.size)), asset.oid);
      } finally {
        closeSync(fd);
      }
      return { oid: asset.oid, state: "verified-local" };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      missing++;
      return { oid: asset.oid, state: "absent" };
    }
  });
  assert.equal(
    missing > 0,
    scenario === "lfs-missing-object",
    "LFS object precondition does not match the scenario",
  );
  evidence.largeFileFixture = {
    descriptorSha256: authority.largeFile.fixtureDigest,
    baseSha: fixture.baseSha,
    baseTreeSha: fixture.baseTreeSha,
    namespace: fixture.namespace,
    toolAvailable,
    cache,
    baseline: fixture.baseline,
  };
  return fixture;
}

function readOnlyMirror(context, shas) {
  const { authority, command } = context;
  assert.ok(shas.length > 0 && shas.length <= 8);
  for (const sha of shas) assert.match(sha, /^[a-f0-9]{40}$/);
  const root = mkdtempSync(join(dirname(authority.evidence), "large-file-raw-git-"));
  const token = command("gh", ["auth", "token"], authority.checkout);
  assert.ok(token && token.length <= 4096);
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    LANG: "C.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
  };
  for (const args of [
    ["init", "--quiet"],
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "fetch.fsckObjects=true",
      "fetch",
      "--depth=1",
      "--no-tags",
      "--no-write-fetch-head",
      "--no-recurse-submodules",
      `https://github.com/${authority.repository}.git`,
      ...new Set(shas),
    ],
  ]) {
    const result = spawnSync("git", args, {
      cwd: root,
      env,
      timeout: 120000,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    assert.equal(result.status, 0, "bounded raw Git evidence read failed");
  }
  return root;
}

function verifyFinalBehavior(context, fixture, repository, commitSha) {
  const root = mkdtempSync(join(dirname(context.authority.evidence), "large-file-final-behavior-"));
  for (const file of [...fixture.baseline, ...fixture.expected]) {
    assert.ok(file.path.startsWith(`${fixture.paths.prefix}/`));
    assert.ok(file.path.split("/").every((part) => part && part !== "." && part !== ".."));
    const result = spawnSync(
      "git",
      ["-c", "core.hooksPath=/dev/null", "cat-file", "blob", `${commitSha}:${file.path}`],
      {
        cwd: repository,
        encoding: null,
        timeout: 15000,
        maxBuffer: 12 * 1024 * 1024,
        env: {
          PATH: process.env.PATH,
          HOME: root,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_NO_LAZY_FETCH: "1",
        },
      },
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout.length, file.bytes);
    assert.equal(hash(result.stdout), file.digest);
    const path = join(root, file.path);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      file.mode === "100755" ? 0o755 : 0o644,
    );
    try {
      writeSync(fd, result.stdout);
    } finally {
      closeSync(fd);
    }
  }
  const result = spawnSync(
    "/usr/bin/unshare",
    [
      "--user",
      "--map-root-user",
      "--net",
      "--fork",
      "--kill-child=TERM",
      realpathSync(process.execPath),
      "--permission",
      `--allow-fs-read=${root}`,
      "--test-isolation=none",
      "--test",
      fixture.paths.test,
    ],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      env: { PATH: "/usr/bin:/bin", HOME: root, LANG: "C.UTF-8" },
    },
  );
  context.evidence.largeFileBehavior = {
    root,
    commitSha,
    exitCode: result.status,
    output: (result.stdout ?? "").slice(-65536),
    error: (result.stderr ?? "").slice(-8192),
    boundary:
      "credential-free, network-isolated Node permission boundary; read-only verified fixture files",
  };
  context.save();
  assert.equal(result.status, 0, "independent final large-file behavior failed");
}

export function largeFileExtension(authority) {
  let fixture;
  return {
    authority,
    scope: "installed-large-file-qualification",
    harnessPaths: [
      "verify-local-large-files.mjs",
      "qualification-large-files.mjs",
      "qualification-large-files-recipe.mjs",
      "qualification-artifact-transfer.mjs",
      "qualification-large-file-refusals.mjs",
      "qualification-reservation-authority.mjs",
    ].map((path) => `scripts/${path}`),
    objectiveBody,
    preflight(context) {
      context.evidence.largeFileStage = "baseline-preflight";
      context.save();
      fixture = verifyBaseline(context);
      context.evidence.largeFileStage = "preflight-complete";
    },
    observe({ observation, evidence }) {
      if (!evidence.transferArm) return;
      try {
        observation.transferCheckpoint = privateDocument(
          `${evidence.transferArm.path}.reached`,
          16384,
        ).value;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    },
    extendPort(context) {
      // Port assembly precedes the base runner's preflight. Load the pinned
      // descriptor here; preflight independently verifies the published baseline.
      fixture = checkedFixture(authority);
      const { port, evidence, save, request } = context;
      const readyProofs = new Map();
      let priorIntent;
      const stage = (value) => {
        evidence.largeFileStage = value;
        save();
      };
      const retainedProof = (value, label) => {
        const path = join(dirname(authority.evidence), `${authority.namespace}-${label}.json`);
        const saved = exclusiveJson(path, value.proof);
        (evidence.largeFileTransferProofs ??= []).push({ ...saved, summary: value.summary });
        save();
      };
      const verifyTransfer = async (observation, phase, witness, workItem = witness?.workItem) => {
        stage(`transfer-${phase}-proof`);
        const value = await observeArtifactTransfer(request, observation, authority, {
          workItem,
          phase,
          ...(witness ? { witness } : {}),
          ...(phase === "ready" && witness ? { priorIntent: priorIntent.proof } : {}),
        });
        retainedProof(value, `${phase}-${workItem}`);
        if (phase === "intent") priorIntent = value;
        else readyProofs.set(workItem, value);
        return value;
      };
      return {
        ...port,
        // Refusal ports bind the observed base and created Objective. Neither
        // exists during assembly; construct them only after preflight/create.
        async compileRefusal() {
          return createLargeFileRefusalPorts(context, fixture).compileRefusal();
        },
        async artifactRefusal(observation) {
          return createLargeFileRefusalPorts(context, fixture).artifactRefusal(observation);
        },
        async armTransfer(original) {
          assert.equal(authority.largeFile.scenario, "transfer-restart");
          assert.ok(!evidence.transferArm, "uncertain transfer arm may not be repeated");
          await port.controller("active", original);
          const path = transferArmPath(original.unit, original.invocationId);
          try {
            mkdirSync(dirname(path), { mode: 0o700 });
          } catch (error) {
            if (error.code !== "EEXIST") throw error;
          }
          assert.equal(realpathSync(dirname(path)), dirname(path));
          const info = lstatSync(dirname(path));
          assert.ok(info.isDirectory() && !info.isSymbolicLink());
          assert.equal(info.uid, process.getuid());
          assert.equal(info.mode & 0o777, 0o700);
          const arm = largeFileTransferArm(
            authority,
            original,
            evidence.objective.number,
            evidence.base,
          );
          const bytes = Buffer.from(JSON.stringify(arm));
          evidence.transferArm = {
            path,
            arm,
            digest: hash(bytes),
            requestedAt: new Date().toISOString(),
          };
          stage("arm-transfer-intent");
          const fd = openSync(
            path,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o600,
          );
          try {
            writeSync(fd, bytes);
          } finally {
            closeSync(fd);
          }
          evidence.transferArm.writtenAt = new Date().toISOString();
          save();
          return evidence.transferArm;
        },
        async transferProof(observation, phase, witness) {
          const value = await verifyTransfer(observation, phase, witness);
          return value.summary;
        },
        async finalProof(observation, original, replacement) {
          stage("final-delivery-proof");
          await port.finalProof(observation, original, replacement);
          const events = observation.receipts.map(({ event }) => event);
          const publications = events
            .filter((event) => event.event === "PublicationRecorded")
            .sort((left, right) => left.sequence - right.sequence);
          assert.equal(publications.length, 3);
          const integrations = events
            .filter((event) => event.event === "AttemptIntegrated")
            .sort((left, right) => left.sequence - right.sequence);
          assert.equal(integrations.length, 3);
          const finalSha = integrations.at(-1).headSha;
          const info = (await request("GET /repos/{owner}/{repo}")).data;
          assert.equal(
            (await request("GET /repos/{owner}/{repo}/commits/{ref}", { ref: info.default_branch }))
              .data.sha,
            finalSha,
          );
          const repository = readOnlyMirror(context, [
            ...new Set([
              evidence.base,
              finalSha,
              ...publications.flatMap((entry) => [entry.baseSha, entry.headSha]),
            ]),
          ]);
          evidence.largeFileGitEvidence = { repository, finalSha, fixtureBase: evidence.base };
          save();
          for (const [index, publication] of publications.entries()) {
            const phase = ["payload", "metadata", "join"][index];
            const transfer =
              readyProofs.get(publication.workItem) ??
              (await verifyTransfer(observation, "ready", undefined, publication.workItem));
            assert.equal(transfer.artifact.baseSha, publication.baseSha);
            assert.equal(transfer.artifact.digest, transfer.summary.artifactDigest);
            const observed = observeLargeFileTree({
              repository,
              treeish: publication.headSha,
              fixture,
              baseSha: publication.baseSha,
              patch: transfer.patch,
            });
            const result = assertLargeFileArtifact({
              fixture,
              artifact: transfer.artifact,
              observation: observed,
              patch: transfer.patch,
              phase,
            });
            (evidence.largeFileArtifactProofs ??= []).push({
              publication,
              observation: observed,
              result,
            });
            save();
          }
          const finalTree = observeLargeFileTree({ repository, treeish: finalSha, fixture });
          evidence.largeFileFinalTree = assertLargeFileFinalTree({
            fixture,
            observation: finalTree,
          });
          save();
          verifyFinalBehavior(context, fixture, repository, finalSha);
          assert.equal(checkedFixture(authority).baseSha, fixture.baseSha);
          stage("final-large-file-proof-complete");
        },
      };
    },
  };
}

export async function main(env = process.env) {
  const authority = largeFileAuthority(env);
  if (!authority) {
    console.log("Not exercised: explicit installed large-file qualification opt-in required.");
    return;
  }
  await checkpointMain(env, runLargeFileScenario, largeFileExtension(authority));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch {
    process.exitCode = 2;
    console.error(
      "Large-file qualification prerequisites unavailable; no automatic execution or retry.",
    );
  }
}
