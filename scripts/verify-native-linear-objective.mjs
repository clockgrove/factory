/** Installed native linear-stack cascade, takeover and cancellation qualification. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  assertQualificationNamespace,
  boundedPolicy,
  main as installedMain,
  modelTokenLimit,
  qualificationNamespace,
  qualificationNamespaceMarker,
  qualificationPaths,
} from "./verify-live-objective.mjs";
import {
  assertQualificationMergeProof,
  readQualificationMergeProofForIdentity,
} from "./qualification-merge-proof.mjs";
import {
  assertQualificationCheckpoint,
  nativeProofReader,
  nativeQualificationEvents,
} from "./qualification-sibling-refresh-proof.mjs";
import { assertNativeScopes, observeNativeScopes } from "./qualification-native-scopes.mjs";
import {
  isQualificationModelMarker,
  qualificationModelAccounting,
} from "./qualification-model-accounting.mjs";
import { assertFaultControllerAuthority, parseUnitObservation } from "./verify-local-faults.mjs";

const scope = "installed-local-native-linear-stack";
const cases = new Set(["cascade", "response-loss-restart", "active-cancellation"]);
const terminal = new Set(["completed", "cancelled", "escalated"]);
const terminalEvents = new Map([
  ["completed", "FactoryRunCompleted"],
  ["cancelled", "FactoryRunCancelled"],
  ["escalated", "FactoryRunEscalated"],
]);
const harnessFiles = [
  "verify-native-linear-objective.mjs",
  "verify-live-objective.mjs",
  "qualification-merge-proof.mjs",
  "qualification-sibling-refresh-proof.mjs",
  "qualification-native-scopes.mjs",
  "qualification-model-accounting.mjs",
  "qualification-reservation-authority.mjs",
  "verify-local-faults.mjs",
];
const hash = (value) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
const canonical = (value) =>
  value && typeof value === "object"
    ? Array.isArray(value)
      ? `[${value.map(canonical).join(",")}]`
      : `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
          .join(",")}}`
    : JSON.stringify(value);
const one = (values, message) => {
  assert.equal(values.length, 1, message);
  return values[0];
};

function reviewIdentity(publication, validation, published, kind) {
  return {
    kind,
    runId: publication.runId,
    objective: publication.objective,
    workItem: publication.workItem,
    attempt: publication.attempt,
    artifactDigest: published.artifactDigest,
    baseSha: validation.baseSha,
    outputTreeSha: validation.outputTreeSha,
    evidenceDigest: validation.evidenceDigest,
    ...(kind === "rebase" ? { headSha: publication.headSha } : {}),
  };
}

function reviewDemand(publication, identity) {
  const identityDigest = hash(canonical(identity));
  const suffix =
    identity.kind === "artifact" ? `artifact-${identityDigest}` : `rebase-${identityDigest}`;
  return {
    identityDigest,
    demand: {
      kind: "checkpoint",
      ref:
        `refs/clockgrove-factory/reviews/objective-${publication.objective}/` +
        `work-item-${publication.workItem}/attempt-${publication.attempt}/` +
        suffix,
      path: ".clockgrove-factory/control/semantic-review.json",
      maxBytes: 65_536,
    },
  };
}

function publicationReview(publication, validation, published, publicationIndex) {
  const kind = publicationIndex === 0 ? "artifact" : "rebase";
  const identity = reviewIdentity(publication, validation, published, kind);
  const { identityDigest, demand } = reviewDemand(publication, identity);
  return {
    identity,
    identityDigest,
    demand,
    usageId: `${kind === "artifact" ? "review" : "rebase-review"}-${identityDigest}`,
  };
}

function mergeCandidateIdentity(sourcePublication, publication) {
  return {
    runId: publication.runId,
    objective: publication.objective,
    workItem: publication.workItem,
    attempt: publication.attempt,
    pullRequest: publication.pullRequest,
    sourceHeadSha: sourcePublication.headSha,
    sourceExactHeadValidationDigest: sourcePublication.exactHeadValidationDigest,
    targetBaseSha: publication.baseSha,
    deliveryHeadSha: publication.headSha,
  };
}

function mergeCandidateDemand(sourcePublication, publication) {
  const identity = mergeCandidateIdentity(sourcePublication, publication);
  const identityDigest = hash(JSON.stringify(identity));
  return {
    identity,
    identityDigest,
    demand: {
      kind: "checkpoint",
      ref:
        `refs/clockgrove-factory/merge-candidates/objective-${publication.objective}/` +
        `work-item-${publication.workItem}/attempt-${publication.attempt}/` +
        `candidate-${identityDigest}`,
      path: ".clockgrove-factory/control/merge-candidate.json",
      maxBytes: 512 * 1024,
    },
  };
}

function integrationReview(publication, candidate) {
  const identity = {
    kind: "integration-candidate",
    runId: publication.runId,
    objective: publication.objective,
    workItem: publication.workItem,
    attempt: publication.attempt,
    artifactDigest: candidate.validation.artifactDigest,
    baseSha: publication.baseSha,
    outputTreeSha: candidate.validation.outputTreeSha,
    evidenceDigest: candidate.validation.digest,
    headSha: publication.headSha,
  };
  const identityDigest = hash(canonical(identity));
  return {
    identity,
    identityDigest,
    usageId: `integration-review-${identityDigest}`,
    demand: {
      kind: "checkpoint",
      ref:
        `refs/clockgrove-factory/reviews/objective-${publication.objective}/` +
        `work-item-${publication.workItem}/attempt-${publication.attempt}/` +
        `integration-candidate-${identityDigest}`,
      path: ".clockgrove-factory/control/semantic-review.json",
      maxBytes: 65_536,
    },
  };
}

function assertReviewDocument(review, expected) {
  assert.equal(review.protocol, "clockgrove.factory/review-checkpoint-v1");
  assert.equal(review.identityDigest, expected.identityDigest);
  assert.deepEqual(review.identity, expected.identity);
  assert.equal(review.review.accepted, true);
  assert.deepEqual(review.review.unmetCriteria, []);
  for (const name of ["inputTokens", "outputTokens"])
    assert.ok(
      Number.isSafeInteger(review.usage?.[name]) && review.usage[name] > 0,
      `review ${name} must be a positive exact counter`,
    );
  if (review.usage.cachedInputTokens !== undefined)
    assert.ok(
      Number.isSafeInteger(review.usage.cachedInputTokens) &&
        review.usage.cachedInputTokens >= 0 &&
        review.usage.cachedInputTokens <= review.usage.inputTokens,
      "review cached input counter is invalid",
    );
}

function exactHeadValidationDigest(publication, validation) {
  assert.equal(validation.passed, true, "published validation did not pass");
  const binding = {
    protocol: "clockgrove.factory/exact-head-validation-v1",
    validationDigest: validation.evidenceDigest,
    baseSha: validation.baseSha,
    outputTreeSha: validation.outputTreeSha,
    publishedHeadSha: publication.headSha,
  };
  return hash(JSON.stringify(binding));
}
function harnessIdentity() {
  return harnessFiles.map((file) => ({
    file,
    sha256: createHash("sha256")
      .update(readFileSync(new URL(file, import.meta.url)))
      .digest("hex"),
  }));
}

function command(name, arguments_, cwd, trim = true) {
  const result = spawnSync(name, arguments_, {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.ok(
    !result.error && result.status === 0,
    `${name} ${arguments_.join(" ")} failed: ${(result.stderr || result.error?.message || "").trim()}`,
  );
  return trim ? result.stdout.trim() : result.stdout;
}

function systemdPort() {
  return {
    unit: () => `clockgrove-qualification-sentinel-${randomUUID()}.service`,
    run: (file, args, accept = [0]) => {
      const result = spawnSync(file, args, {
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 2 * 1024 * 1024,
      });
      assert.ok(
        !result.error && accept.includes(result.status),
        `${file} ${args.join(" ")} failed`,
      );
      return result.stdout.trim();
    },
    now: () => new Date().toISOString(),
  };
}

function observeSentinelUnit(unit, port) {
  return parseUnitObservation(
    unit,
    port.run(
      "systemctl",
      [
        "--user",
        "show",
        unit,
        "--property=Id,LoadState,ActiveState,SubState,ControlGroup,Job,InvocationID,KillMode",
        "--no-pager",
      ],
      [0, 1, 4],
    ),
    port.now(),
  );
}

function controllerProcessPort() {
  return {
    pid: (unit) =>
      Number(command("systemctl", ["--user", "show", unit, "--property=MainPID", "--value"])),
    argv: (pid) => readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean),
    bundle: (path) => {
      const canonical = realpathSync(path);
      return {
        path: canonical,
        sha256: createHash("sha256").update(readFileSync(canonical)).digest("hex"),
      };
    },
  };
}

export function assertNativeLinearControllerAuthority(
  controller,
  evidence,
  checkout,
  port = controllerProcessPort(),
) {
  const candidate = evidence.installedCandidate;
  assert.ok(candidate, "retained installed candidate authority is unavailable");
  const pid = port.pid(controller.unit);
  assert.ok(Number.isSafeInteger(pid) && pid > 0, "active controller PID unavailable");
  const runningArgv = port.argv(pid);
  const surfaces = candidate.artifactAuthority?.factoryBundleSurfaces;
  assert.ok(Array.isArray(surfaces) && surfaces.length === 2, "controller surfaces unavailable");
  assert.deepEqual(
    surfaces.map(({ surface }) => surface).sort(),
    ["npm", "plugin-cache"],
    "controller install surfaces differ",
  );
  assert.match(candidate.installReceiptIdentity ?? "", /^sha256:[a-f0-9]{64}$/);
  assert.match(candidate.factoryArtifactIdentity ?? "", /^sha256:[a-f0-9]{64}$/);
  const expectedDigest = candidate.factoryArtifactIdentity.slice("sha256:".length);
  for (const surface of surfaces) {
    assert.ok(surface.path.startsWith("/"), "controller surface path must be absolute");
    assert.equal(surface.sha256, expectedDigest, "controller surface digest differs");
    assert.equal(
      surface.installReceiptIdentity,
      candidate.installReceiptIdentity,
      "controller surface receipt differs",
    );
  }
  assert.ok(Array.isArray(runningArgv) && runningArgv.length === 9, "controller argv differs");
  const observedBundle = port.bundle(runningArgv[1]);
  const matches = surfaces.filter((surface) => surface.path === observedBundle.path);
  assert.equal(matches.length, 1, "running controller bundle is outside retained install surfaces");
  const selected = matches[0];
  assert.equal(observedBundle.sha256, selected.sha256, "running controller bundle digest differs");
  const authority = {
    artifactIdentity: candidate.factoryArtifactIdentity,
    launcher: realpathSync(process.execPath),
    bundle: selected.path,
    repository: evidence.repository,
    checkout,
    runningArgv,
  };
  assertFaultControllerAuthority(controller, authority);
  return {
    pid,
    ...authority,
    installSurface: selected.surface,
    authenticatedDigest: `sha256:${observedBundle.sha256}`,
    expectedReceiptIdentity: candidate.installReceiptIdentity,
  };
}

export function startNativeLinearSentinel(port = systemdPort()) {
  const unit = port.unit();
  assert.match(unit, /^clockgrove-qualification-sentinel-[a-f0-9-]+\.service$/);
  port.run("systemd-run", [
    "--user",
    "--unit",
    unit,
    "--collect",
    "--property=Type=exec",
    "--property=KillMode=control-group",
    "/usr/bin/sleep",
    "3600",
  ]);
  const started = observeSentinelUnit(unit, port);
  assert.equal(started.status, "active", "unrelated sentinel did not become active");
  return started;
}

export function assertNativeLinearSentinelAlive(started, port = systemdPort()) {
  const observed = observeSentinelUnit(started.unit, port);
  assert.equal(observed.status, "active", "unrelated sentinel is not active");
  assert.equal(observed.invocationId, started.invocationId, "unrelated sentinel was replaced");
  assert.equal(
    observed.controlGroupDigest,
    started.controlGroupDigest,
    "unrelated sentinel control group changed",
  );
  return observed;
}

export function stopNativeLinearSentinel(started, port = systemdPort()) {
  port.run("systemctl", ["--user", "stop", started.unit], [0, 1, 4]);
  const stopped = observeSentinelUnit(started.unit, port);
  assert.equal(stopped.status, "absent", "unrelated sentinel did not stop exactly");
  return stopped;
}

function assertCommittedHarness(evidence) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  assert.equal(
    command("git", ["rev-parse", "HEAD"], root),
    evidence.preflight.harness.sourceCommit,
    "native linear qualifier source commit changed",
  );
  for (const entry of harnessIdentity())
    assert.equal(
      createHash("sha256")
        .update(command("git", ["show", `HEAD:scripts/${entry.file}`], root, false))
        .digest("hex"),
      entry.sha256,
      "native linear qualifier source is not the committed candidate",
    );
}

export function nativeLinearObjectiveBody(namespace) {
  const paths = qualificationPaths(namespace);
  return `Build three tiny dependency-free ESM modules with node:test tests as one linear native delivery stack.

Qualification namespace: ${namespace}
${qualificationNamespaceMarker(namespace)}

Compile exactly three Work Items in this order. The first is the only root. The second depends only on the first and continues its delivery stack. The third depends only on the second and continues the same stack. Do not create siblings, joins, or another delivery group. Keep each module and its tests in that Work Item's allowed paths. Do not modify package.json or existing tests.

1. ${paths.sourceDirectory}/clamp.js exports clamp(value, min, max): return value bounded inclusively to min and max; throw RangeError when min > max. Add ${paths.testDirectory}/clamp.test.js covering below, within, above, equal bounds, and inverted bounds. Validate with node --test ${paths.testDirectory}/clamp.test.js.
2. ${paths.sourceDirectory}/slugify.js imports clamp and exports slugify(text, maxLength = 48): lowercase ASCII text, replace each run of non-ASCII-alphanumeric characters with one hyphen, remove leading and trailing hyphens, then truncate to clamp(maxLength, 0, 48) characters and remove a trailing hyphen. Add ${paths.testDirectory}/slugify.test.js covering spaces, punctuation, repeated separators, empty input, uppercase, truncation, and zero length. Validate both first and second layers with node --test ${paths.testDirectory}/clamp.test.js ${paths.testDirectory}/slugify.test.js.
3. ${paths.sourceDirectory}/describe.js imports clamp and slugify and exports describe(name, value, min, max), returning slugify(name) + ':' + clamp(value, min, max). Add ${paths.testDirectory}/describe.test.js: describe(' Hello World ', 12, 0, 10) equals 'hello-world:10', and inverted bounds propagate RangeError. Validate the complete stack with npm test.

No dependencies, services, credentials, cloud workers, workflows, or network access are needed by these modules. Preserve all existing modules and tests.`;
}

function authenticatedEventsFromComments(comments, actor, objective) {
  assert.ok(comments.length <= 2_000, "native qualification comment bound exceeded");
  const events = [];
  for (const comment of comments) {
    if (
      comment.user?.id !== actor.id ||
      comment.user?.login?.toLowerCase() !== actor.login.toLowerCase()
    )
      continue;
    for (const match of (comment.body ?? "").matchAll(
      /<!-- clockgrove-factory:event\n([\s\S]*?)\n-->/g,
    )) {
      const event = JSON.parse(match[1]);
      assert.equal(event.objective, objective, "native qualification receipt changed Objective");
      events.push(event);
    }
  }
  return events;
}

async function list(request, route, parameters) {
  const values = [];
  for (let page = 1; page <= 20; page += 1) {
    const { data } = await request(route, { ...parameters, per_page: 100, page });
    assert.ok(Array.isArray(data), "native qualification pagination response is malformed");
    values.push(...data);
    assert.ok(values.length <= 2_000, "native qualification observation bound exceeded");
    if (data.length < 100) return values;
  }
  assert.fail("native qualification pagination exceeded twenty pages");
}

async function observeControllerRun({ call, request, evidence, owner, repo }) {
  const children = await list(
    request,
    "GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues",
    { issue_number: evidence.objective.number },
  );
  const comments = [];
  for (const issue of [evidence.objective, ...children])
    comments.push(
      ...(await list(request, "GET /repos/{owner}/{repo}/issues/{issue_number}/comments", {
        issue_number: issue.number,
      })),
    );
  const status = await call("factory_status", {
    owner,
    repo,
    objectiveNumber: evidence.objective.number,
  });
  return {
    events: authenticatedEventsFromComments(comments, evidence.actor, evidence.objective.number),
    status,
  };
}

function finalState(status) {
  return status?.run?.availability === "observed" && terminal.has(status.run.state)
    ? status.run.state
    : null;
}

function controllerGeneration(event) {
  assert.ok(event && event.event === "ControllerObserved", "controller generation is unavailable");
  assert.equal(
    event.observationScope,
    "repository-controller",
    "controller observation scope changed",
  );
  assert.ok(
    typeof event.controllerId === "string" && event.controllerId.length > 0,
    "controller identity is unavailable",
  );
  assert.ok(Number.isSafeInteger(event.epoch) && event.epoch > 0, "controller epoch is invalid");
  assert.match(event.controllerPolicyDigest, /^[a-f0-9]{64}$/);
  assert.ok(Number.isSafeInteger(Date.parse(event.expiresAt)), "controller expiry is invalid");
  assert.ok(
    Date.parse(event.expiresAt) > Date.parse(event.at),
    "controller observation is expired",
  );
  for (const field of ["protocolMin", "protocolMax", "writerHolder"])
    assert.ok(typeof event[field] === "string" && event[field].length > 0, `${field} is invalid`);
  assert.ok(
    Number.isSafeInteger(event.writerEpoch) && event.writerEpoch > 0,
    "controller writer epoch is invalid",
  );
  assert.match(event.writerPolicyDigest, /^[a-f0-9]{64}$/);
  const writerOperationId = hash([
    event.objective,
    event.runId,
    event.writerHolder,
    event.writerEpoch,
    event.writerPolicyDigest,
    event.sequence,
  ]);
  assert.equal(
    event.writerOperationId,
    writerOperationId,
    "controller writer operation is invalid",
  );
  return {
    controllerId: event.controllerId,
    epoch: event.epoch,
    expiresAt: event.expiresAt,
    controllerPolicyDigest: event.controllerPolicyDigest,
    protocolMin: event.protocolMin,
    protocolMax: event.protocolMax,
    writerHolder: event.writerHolder,
    writerEpoch: event.writerEpoch,
    writerPolicyDigest: event.writerPolicyDigest,
    writerOperationId: event.writerOperationId,
  };
}

function revalidatedProgress(events, runId) {
  const own = events
    .filter((event) => event.runId === runId)
    .sort((left, right) => left.sequence - right.sequence);
  for (const invalidated of own.filter((event) => event.event === "ValidationInvalidated")) {
    const publications = own.filter(
      (event) =>
        event.event === "PublicationRecorded" &&
        event.workItem === invalidated.workItem &&
        event.attempt === invalidated.attempt &&
        event.sequence > invalidated.sequence &&
        event.headSha !== invalidated.headSha,
    );
    assert.ok(publications.length <= 1, "intervention publication is repeated");
    const publication = publications[0];
    if (!publication) continue;
    const validations = own.filter(
      (event) =>
        event.event === "ValidationRecorded" &&
        event.workItem === publication.workItem &&
        event.attempt === publication.attempt &&
        event.evidenceDigest === publication.validationDigest &&
        event.baseSha === publication.baseSha &&
        event.sequence > invalidated.sequence &&
        event.sequence < publication.sequence,
    );
    assert.ok(validations.length <= 1, "intervention validation is repeated");
    const validation = validations[0];
    if (!validation) continue;
    const publishedEvents = own.filter(
      (event) =>
        event.event === "AttemptPublished" &&
        event.workItem === publication.workItem &&
        event.attempt === publication.attempt &&
        event.headSha === publication.headSha &&
        event.sequence > validation.sequence &&
        event.sequence < publication.sequence,
    );
    assert.ok(publishedEvents.length <= 1, "intervention publication attempt is repeated");
    const published = publishedEvents[0];
    if (!published) continue;
    const review = publicationReview(publication, validation, published, 1);
    const reviewUsages = own.filter(
      (event) =>
        event.event === "BudgetReconciled" &&
        event.runId === publication.runId &&
        event.objective === publication.objective &&
        event.workItem === publication.workItem &&
        event.attempt === publication.attempt &&
        event.phase === "management" &&
        event.unit === "model_tokens" &&
        event.usageId === review.usageId &&
        event.sequence > validation.sequence &&
        event.sequence < publication.sequence,
    );
    assert.ok(reviewUsages.length <= 1, "intervention review accounting is repeated");
    const reviewUsage = reviewUsages[0];
    if (!reviewUsage) continue;
    const durableOperations = own.filter(
      (event) => event.event === "IntegrationCompleted" && event.sequence < invalidated.sequence,
    );
    if (durableOperations.length !== 1) continue;
    const durableOperation = durableOperations[0];
    const integrated = own.filter(
      (event) =>
        event.event === "AttemptIntegrated" &&
        event.workItem === durableOperation.workItem &&
        event.attempt === durableOperation.attempt &&
        event.sequence > durableOperation.sequence &&
        event.sequence < invalidated.sequence &&
        event.headSha === invalidated.invalidatedByHeadSha,
    );
    if (integrated.length !== 1) continue;
    const predecessor = publication
      ? own
          .filter(
            (event) =>
              event.event === "ControllerObserved" &&
              event.observationScope === "repository-controller" &&
              event.sequence < publication.sequence,
          )
          .sort((left, right) => right.sequence - left.sequence)[0]
      : undefined;
    if (publication && durableOperation && predecessor)
      return {
        workItem: invalidated.workItem,
        attempt: invalidated.attempt,
        invalidationSequence: invalidated.sequence,
        invalidatedHeadSha: invalidated.headSha,
        invalidatedByItem: invalidated.invalidatedByItem,
        invalidatedByHeadSha: invalidated.invalidatedByHeadSha,
        durableHeadSha: publication.headSha,
        validationSequence: validation.sequence,
        validationDigest: validation.evidenceDigest,
        outputTreeSha: validation.outputTreeSha,
        reviewIdentityDigest: review.identityDigest,
        reviewUsageId: reviewUsage.usageId,
        reviewUsageSequence: reviewUsage.sequence,
        attemptPublicationSequence: published.sequence,
        artifactDigest: published.artifactDigest,
        publicationSequence: publication.sequence,
        operationId: durableOperation.operationId,
        integratedWorkItem: durableOperation.workItem,
        integrationSourceHeadSha: durableOperation.headSha,
        integrationHeadSha: integrated[0].headSha,
        integrationCompletedSequence: durableOperation.sequence,
        attemptIntegratedSequence: integrated[0].sequence,
        controllerGeneration: controllerGeneration(predecessor),
      };
  }
  return null;
}

/** Controller cases are single-shot. A returned restart response is deliberately
 * discarded once, then the runner relies only on authenticated takeover history. */
export async function executeNativeLinearControllerCase({
  caseName,
  call,
  request,
  evidence,
  owner,
  repo,
  checkout,
  runRequest,
  save = () => {},
  observe = () => observeControllerRun({ call, request, evidence, owner, repo }),
  wait = sleep,
  maximumObservations = 900,
}) {
  assert.ok(["response-loss-restart", "active-cancellation"].includes(caseName));
  assert.equal(runRequest.tool, "factory_activate");
  assert.ok(!evidence.nativeLinearIntervention, "native intervention must never be repeated");
  await call(runRequest.tool, runRequest.arguments);
  let runId;
  for (let count = 0; count < maximumObservations; count += 1) {
    const observation = await observe();
    const start = observation.events.find(
      (event) =>
        event.event === "FactoryRunStarted" &&
        event.activationRequestId === runRequest.arguments.requestId,
    );
    if (start) {
      runId ??= start.runId;
      assert.equal(start.runId, runId, "activation started more than one run");
    }
    const state = finalState(observation.status);
    if (state && !evidence.nativeLinearIntervention) {
      assert.ok(runId, "terminal controller run has no activation-bound run identity");
      evidence.nativeLinearEarlyTerminal = { runId, status: state };
      save();
      return { objective: evidence.objective.number, runId, status: state };
    }
    if (!evidence.nativeLinearIntervention && runId) {
      const progress = revalidatedProgress(observation.events, runId);
      if (progress) {
        const requestId = `${evidence.qualificationNamespace}-${caseName}`;
        evidence.nativeLinearIntervention = {
          case: caseName,
          requestId,
          runId,
          progress,
          requested: true,
          responseLost: false,
        };
        save();
        if (caseName === "response-loss-restart") {
          let acknowledged = false;
          try {
            await call("factory_controller_restart", {
              owner,
              repo,
              repository: checkout,
              requestId,
            });
            acknowledged = true;
            throw new Error("injected response loss after acknowledged controller restart");
          } catch (error) {
            if (!acknowledged) throw error;
          }
          // Never repeat the mutation after losing the acknowledged response:
          // authenticated controller history is the recovery surface.
          evidence.nativeLinearIntervention.responseLost = true;
        } else {
          await call("factory_cancel", {
            owner,
            repo,
            objectiveNumber: evidence.objective.number,
            requestId,
            reason: "Installed native linear-stack active cancellation qualification",
          });
        }
        save();
      }
    }
    if (state) {
      assert.ok(runId, "terminal controller run has no activation-bound run identity");
      const expected = caseName === "response-loss-restart" ? "completed" : "cancelled";
      assert.equal(state, expected, `native ${caseName} ended ${state}`);
      assert.ok(evidence.nativeLinearIntervention, "run ended before intervention");
      return { objective: evidence.objective.number, runId, status: state };
    }
    await wait(3_000);
  }
  throw new Error("native controller qualification observation deadline exceeded");
}

function publicationsByPosition(events) {
  const values = new Map();
  for (const event of events.filter((entry) => entry.event === "PublicationRecorded")) {
    const prior = values.get(event.position) ?? [];
    prior.push(event);
    values.set(event.position, prior);
  }
  return [...values.entries()]
    .sort(([left], [right]) => left - right)
    .map(([position, publications]) => ({
      position,
      publications: publications.sort((left, right) => left.sequence - right.sequence),
    }));
}

export function assertNativeLinearReview(
  review,
  publication,
  validation,
  published,
  events,
  publicationIndex = 1,
) {
  const expected = publicationReview(publication, validation, published, publicationIndex);
  const { identity, identityDigest, usageId } = expected;
  assertReviewDocument(review, { identity, identityDigest });
  const usage = one(
    events.filter(
      (event) =>
        event.event === "BudgetReconciled" &&
        event.runId === publication.runId &&
        event.objective === publication.objective &&
        event.workItem === publication.workItem &&
        event.attempt === publication.attempt &&
        event.phase === "management" &&
        event.unit === "model_tokens" &&
        event.usageId === usageId,
    ),
    "publication review accounting is missing or repeated",
  );
  assert.equal(usage.amount, review.usage.inputTokens + review.usage.outputTokens);
  assert.ok(
    validation.sequence < usage.sequence &&
      usage.sequence < published.sequence &&
      published.sequence < publication.sequence,
    "publication review is outside its validation/publication fence",
  );
  return identityDigest;
}

function assertExactReview(proof, events) {
  const validation = proof.validation;
  const publication = proof.publication;
  const published = one(
    events.filter(
      (event) =>
        event.event === "AttemptPublished" &&
        event.workItem === publication.workItem &&
        event.attempt === publication.attempt &&
        event.headSha === publication.headSha &&
        event.sequence < publication.sequence &&
        event.sequence > validation.sequence,
    ),
    "exact head publication is missing or repeated",
  );
  const expected = publicationReview(publication, validation, published, proof.publicationIndex);
  assert.deepEqual(proof.reviewDemand, expected.demand, "publication review demand changed");
  const review = assertQualificationCheckpoint(
    proof.reviewRead,
    expected.demand,
    validation.baseSha,
  );
  return assertNativeLinearReview(
    review,
    publication,
    validation,
    published,
    events,
    proof.publicationIndex,
  );
}

export async function observeNativeLinearProofs(
  { evidence, request },
  read = nativeProofReader(request),
  readMerge = (expected) => readQualificationMergeProofForIdentity({ request }, expected),
) {
  const events = nativeQualificationEvents(evidence);
  evidence.nativeLinearProofs = [];
  evidence.mergeProofs = [];
  for (const { position, publications } of publicationsByPosition(events)) {
    const invalidations = events
      .filter(
        (event) =>
          event.event === "ValidationInvalidated" &&
          event.workItem === publications[0].workItem &&
          event.attempt === publications[0].attempt,
      )
      .sort((left, right) => left.sequence - right.sequence);
    for (const [publicationIndex, publication] of publications.entries()) {
      const invalidation = publicationIndex === 0 ? undefined : invalidations[publicationIndex - 1];
      if (publicationIndex > 0)
        assert.ok(invalidation, "changed publication has no corresponding invalidation");
      const validation = one(
        events.filter(
          (event) =>
            event.event === "ValidationRecorded" &&
            event.workItem === publication.workItem &&
            event.attempt === publication.attempt &&
            event.evidenceDigest === publication.validationDigest &&
            event.baseSha === publication.baseSha &&
            event.sequence > (invalidation?.sequence ?? -1) &&
            event.sequence < publication.sequence,
        ),
        "native publication validation is missing or repeated",
      );
      const commitDemand = { kind: "commit", oid: publication.headSha };
      const commitRead = await read(commitDemand);
      const record = {
        position,
        publicationIndex,
        publication,
        validation,
        commitDemand,
        commitRead,
        ...(invalidation ? { invalidation } : {}),
      };
      const published = one(
        events.filter(
          (event) =>
            event.event === "AttemptPublished" &&
            event.workItem === publication.workItem &&
            event.attempt === publication.attempt &&
            event.headSha === publication.headSha &&
            event.sequence > validation.sequence &&
            event.sequence < publication.sequence,
        ),
        "native publication attempt is missing or repeated",
      );
      const review = publicationReview(publication, validation, published, publicationIndex);
      record.reviewDemand = review.demand;
      record.reviewRead = await read(record.reviewDemand);
      evidence.nativeLinearProofs.push(record);
    }
    const publication = publications.at(-1);
    const integrations = events.filter(
      (event) =>
        event.event === "AttemptIntegrated" &&
        event.workItem === publication.workItem &&
        event.attempt === publication.attempt,
    );
    assert.ok(integrations.length <= 1, "native integration is repeated");
    const integration = integrations[0];
    if (!integration) continue;
    const sourcePublication = publications[0];
    const candidate = mergeCandidateDemand(sourcePublication, publication);
    const proof = one(
      evidence.nativeLinearProofs.filter(
        (entry) =>
          entry.position === position && entry.publicationIndex === publications.length - 1,
      ),
      "final native publication proof is missing or repeated",
    );
    proof.integration = integration;
    proof.sourcePublication = sourcePublication;
    proof.sourceValidation = one(
      evidence.nativeLinearProofs.filter(
        (entry) => entry.position === position && entry.publicationIndex === 0,
      ),
      "source native publication proof is missing or repeated",
    ).validation;
    proof.candidateIdentity = candidate.identity;
    proof.candidateIdentityDigest = candidate.identityDigest;
    proof.candidateDemand = candidate.demand;
    proof.candidateRead = await read(candidate.demand);
    assert.ok(
      typeof proof.candidateRead.content === "string",
      "merge candidate checkpoint content is unavailable",
    );
    const candidateDocument = JSON.parse(proof.candidateRead.content);
    const candidateReview = integrationReview(publication, candidateDocument);
    proof.candidateReviewIdentity = candidateReview.identity;
    proof.candidateReviewIdentityDigest = candidateReview.identityDigest;
    proof.candidateReviewDemand = candidateReview.demand;
    proof.candidateReviewRead = await read(candidateReview.demand);
    const pull = one(
      evidence.pulls.filter((entry) => entry.number === publication.pullRequest),
      "native PR identity is missing or repeated",
    );
    const expected = {
      runId: publication.runId,
      objective: publication.objective,
      workItem: publication.workItem,
      attempt: publication.attempt,
      pullRequestNodeId: pull.node_id,
      pullRequest: pull.number,
      repository: evidence.repository,
      repositoryNodeId: pull.base.repo.node_id,
      headSha: publication.headSha,
      mergeSha: integration.headSha,
    };
    evidence.mergeProofs.push(await readMerge(expected));
  }
  return evidence.mergeProofs;
}

export function assertNativeLinearFinalTree(events, finalTreeSha) {
  assert.match(finalTreeSha, /^[a-f0-9]{40}$/);
  const top = publicationsByPosition(events)
    .find(({ position }) => position === 2)
    ?.publications.at(-1);
  assert.ok(top, "completed stack has no top publication");
  const validation = one(
    events.filter(
      (event) =>
        event.event === "ValidationRecorded" &&
        event.workItem === top.workItem &&
        event.attempt === top.attempt &&
        event.evidenceDigest === top.validationDigest &&
        event.baseSha === top.baseSha &&
        event.sequence < top.sequence,
    ),
    "top output validation is missing or repeated",
  );
  assert.equal(
    finalTreeSha,
    validation.outputTreeSha,
    "default-branch tree differs from the validated top output tree",
  );
  return { publication: top, validation };
}

async function verifyNativeLinearFinalArtifact({ evidence, request }) {
  if (evidence.runResult.status !== "completed") {
    evidence.nativeLinearFinalArtifact = {
      state: "not-applicable",
      reason: "active cancellation intentionally has no completed-tree claim",
    };
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), "factory-native-linear-"));
  try {
    command(
      "git",
      ["clone", "--depth", "1", `https://github.com/${evidence.repository}.git`, directory],
      tmpdir(),
    );
    const finalSha = command("git", ["rev-parse", "HEAD"], directory);
    const defaultSha = (
      await request("GET /repos/{owner}/{repo}/commits/{ref}", {
        ref: evidence.preflight.defaultBranch,
      })
    ).data.sha;
    assert.equal(finalSha, defaultSha, "verified clone is not the current default branch");
    const events = nativeQualificationEvents(evidence);
    const top = publicationsByPosition(events)
      .find(({ position }) => position === 2)
      ?.publications.at(-1);
    assert.ok(top, "completed stack has no top publication");
    const integration = one(
      events.filter(
        (event) => event.event === "AttemptIntegrated" && event.workItem === top.workItem,
      ),
      "top integration is missing or repeated",
    );
    assert.equal(finalSha, integration.headSha, "default branch does not end at top integration");
    const finalTreeSha = command("git", ["rev-parse", "HEAD^{tree}"], directory);
    const { validation } = assertNativeLinearFinalTree(events, finalTreeSha);
    const paths = qualificationPaths(evidence.qualificationNamespace);
    const testOutput = command(
      "node",
      ["--test", ...paths.files.filter((path) => path.endsWith(".test.js"))],
      directory,
    );
    const behaviorOutput = command(
      "node",
      [
        "--input-type=module",
        "-e",
        `import assert from 'node:assert/strict'; import {clamp} from './${paths.sourceDirectory}/clamp.js'; import {slugify} from './${paths.sourceDirectory}/slugify.js'; import {describe} from './${paths.sourceDirectory}/describe.js'; assert.equal(clamp(-2,0,10),0); assert.equal(slugify(' Hello, WORLD!! '),'hello-world'); assert.equal(describe(' Hello World ',12,0,10),'hello-world:10'); assert.throws(()=>describe('x',1,2,0),RangeError); console.log('Independent native linear artifact assertions passed');`,
      ],
      directory,
    );
    evidence.nativeLinearFinalArtifact = {
      state: "verified",
      finalSha,
      finalTreeSha,
      validatedTopTreeSha: validation.outputTreeSha,
      testOutput,
      behaviorOutput,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function assertNoOpenLiabilities(events) {
  const terminalAttempts = new Set(
    events
      .filter((event) =>
        ["AttemptSucceeded", "AttemptFailed", "AttemptCancelled", "AttemptIntegrated"].includes(
          event.event,
        ),
      )
      .map((event) => `${event.workItem}:${event.attempt}`),
  );
  for (const event of events.filter((entry) => entry.event === "AttemptReserved"))
    assert.ok(
      terminalAttempts.has(`${event.workItem}:${event.attempt}`),
      "native attempt liability remains open",
    );
  for (const reserved of events.filter((event) => event.event === "CapacityReserved"))
    assert.ok(
      events.some(
        (event) =>
          event.event === "CapacityReconciled" &&
          event.workItem === reserved.workItem &&
          event.attempt === reserved.attempt &&
          event.phase === reserved.phase &&
          event.backend === reserved.backend &&
          event.sequence > reserved.sequence,
      ),
      "native capacity liability remains open",
    );
  for (const reserved of events.filter(
    (event) => event.event === "BudgetReserved" && !isQualificationModelMarker(event),
  ))
    assert.ok(
      events.some(
        (event) =>
          event.event === "BudgetReconciled" &&
          event.workItem === reserved.workItem &&
          event.attempt === reserved.attempt &&
          event.phase === reserved.phase &&
          event.unit === reserved.unit &&
          event.usageId === reserved.usageId &&
          event.sequence > reserved.sequence,
      ),
      "native budget liability remains open",
    );
  const model = qualificationModelAccounting(events, { requireMarkers: true });
  assert.equal(model.unresolved.length, 0, "native model invocation remains unresolved");
  return model;
}

function assertLinearTopology(evidence, events) {
  assert.equal(evidence.children.length, 3, "native linear qualification requires three items");
  const groups = publicationsByPosition(events);
  assert.deepEqual(
    groups.map(({ position }) => position),
    [0, 1, 2],
    "native publication positions are not one linear stack",
  );
  const first = groups.map(({ publications }) => publications[0]);
  assert.equal(new Set(first.map((event) => event.unitId)).size, 1);
  assert.equal(first[0].parentItemId, undefined);
  assert.equal(first[1].parentItemId, first[0].itemId);
  assert.equal(first[2].parentItemId, first[1].itemId);
  assert.ok(first.every((event) => event.mode === "native-stacks"));
  const byItem = new Map(first.map((event) => [event.itemId, event.workItem]));
  for (const [index, publication] of first.entries()) {
    const dependency = one(
      evidence.dependencies.filter((entry) => entry.workItem === publication.workItem),
      "native dependency evidence is missing or repeated",
    );
    assert.deepEqual(
      dependency.blockedBy.map((entry) => entry.number),
      index === 0 ? [] : [byItem.get(first[index - 1].itemId)],
      "native dependency graph differs from its linear delivery topology",
    );
  }
  const links = events.filter((event) => event.event === "StackLinked");
  assert.equal(new Set(links.map((event) => event.stackNumber)).size, 1);
  for (const publication of first)
    assert.ok(
      links.some(
        (event) => event.workItem === publication.workItem && event.headSha === publication.headSha,
      ),
      "native stack linkage is incomplete",
    );
  return groups;
}

/** Event-level cascade invariant shared by online evidence assessment and
 * credential-free deterministic fault cases. */
export function assertNativeLinearHistory(events) {
  assert.ok(Array.isArray(events) && events.length <= 50_000);
  const groups = publicationsByPosition(events);
  assert.deepEqual(
    groups.map(({ position }) => position),
    [0, 1, 2],
    "native history is not one three-layer stack",
  );
  const first = groups.map(({ publications }) => publications[0]);
  const integrations = first.map((publication) =>
    one(
      events.filter(
        (event) => event.event === "AttemptIntegrated" && event.workItem === publication.workItem,
      ),
      "native integration is missing or repeated",
    ),
  );
  assert.ok(
    integrations[0].sequence < integrations[1].sequence &&
      integrations[1].sequence < integrations[2].sequence,
    "native integration did not remain bottom-up",
  );
  assert.deepEqual(
    groups.map(({ publications }) => publications.length),
    [1, 2, 3],
    "native descendants were not revalidated exactly once per lower-layer change",
  );
  for (const [position, group] of groups.entries()) {
    const invalidations = events
      .filter(
        (event) =>
          event.event === "ValidationInvalidated" &&
          event.workItem === group.publications[0].workItem,
      )
      .sort((left, right) => left.sequence - right.sequence);
    assert.equal(
      invalidations.length,
      position,
      "native descendant invalidation count differs from its depth",
    );
    assert.deepEqual(
      invalidations.map((event) => event.invalidatedByItem),
      first.slice(0, position).map((publication) => publication.itemId),
      "native descendant invalidation causes are out of order",
    );
    assert.deepEqual(
      invalidations.map((event) => event.invalidatedByHeadSha),
      integrations.slice(0, position).map((event) => event.headSha),
      "native descendant invalidation is not bound to the exact lower merge identity",
    );
    const heads = group.publications.map((publication) => publication.headSha);
    assert.equal(new Set(heads).size, heads.length, "changed native head was silently reused");
    for (const [index, invalidated] of invalidations.entries()) {
      const next = group.publications[index + 1];
      assert.equal(invalidated.headSha, group.publications[index].headSha);
      assert.notEqual(next.headSha, invalidated.headSha, "invalidated native head was delivered");
      assert.ok(
        invalidated.sequence < next.sequence && next.sequence < integrations[position].sequence,
        "native revalidation is outside its invalidation/integration fence",
      );
      one(
        events.filter(
          (event) =>
            event.event === "ValidationRecorded" &&
            event.workItem === next.workItem &&
            event.evidenceDigest === next.validationDigest &&
            event.baseSha === next.baseSha &&
            event.sequence < next.sequence,
        ),
        "changed native head validation is missing or repeated",
      );
      one(
        events.filter(
          (event) =>
            event.event === "AttemptPublished" &&
            event.workItem === next.workItem &&
            event.headSha === next.headSha &&
            event.sequence < next.sequence,
        ),
        "changed native head publication is missing or repeated",
      );
    }
  }
  assertNativeIntegrationOperation(events, groups);
  return groups;
}

export function assertNativeIntegrationOperation(events, groups = publicationsByPosition(events)) {
  const completions = events.filter((event) => event.event === "IntegrationCompleted");
  assert.equal(completions.length, 3, "native integration mutation was missing or repeated");
  const operationIds = new Set(completions.map((event) => event.operationId));
  assert.equal(operationIds.size, 1, "native cascade changed its durable operation identity");
  const operationId = completions[0].operationId;
  assert.ok(typeof operationId === "string" && operationId.length > 0);
  for (const group of groups) {
    const finalPublication = group.publications.at(-1);
    one(
      completions.filter(
        (event) =>
          event.workItem === finalPublication.workItem &&
          event.headSha === finalPublication.headSha &&
          event.operationId === operationId,
      ),
      "native integration completion differs from the final exact head",
    );
  }
  assert.ok(
    !events.some((event) =>
      ["IntegrationFailed", "IntegrationCancelled", "IntegrationRolledBack"].includes(event.event),
    ),
    "completed native cascade contains a conflicting integration outcome",
  );
  return operationId;
}

function assertValidationCheckpoint(validation) {
  assert.deepEqual(
    Object.keys(validation).sort(),
    [
      "artifactDigest",
      "baseSha",
      "commands",
      "completedAt",
      "digest",
      ...(validation.environmentIdentity === undefined ? [] : ["environmentIdentity"]),
      "outputTreeSha",
      "passed",
      "protocol",
      "startedAt",
    ].sort(),
    "candidate validation fields changed",
  );
  assert.equal(validation.protocol, "clockgrove.factory/validation-v1");
  assert.match(validation.artifactDigest, /^[a-f0-9]{64}$/);
  assert.match(validation.baseSha, /^[a-f0-9]{40}$/);
  assert.match(validation.outputTreeSha, /^[a-f0-9]{40}$/);
  assert.equal(validation.passed, true);
  assert.ok(Array.isArray(validation.commands) && validation.commands.length > 0);
  for (const command of validation.commands) {
    assert.deepEqual(
      Object.keys(command).sort(),
      ["command", "durationMs", "exitCode"],
      "candidate validation command fields changed",
    );
    assert.ok(typeof command.command === "string" && command.command.length > 0);
    assert.equal(command.exitCode, 0);
    assert.ok(Number.isSafeInteger(command.durationMs) && command.durationMs >= 0);
  }
  const duration = Date.parse(validation.completedAt) - Date.parse(validation.startedAt);
  assert.ok(Number.isSafeInteger(duration) && duration >= 0);
  const ordered = {
    protocol: validation.protocol,
    artifactDigest: validation.artifactDigest,
    baseSha: validation.baseSha,
    outputTreeSha: validation.outputTreeSha,
    commands: validation.commands,
    passed: true,
    startedAt: validation.startedAt,
    completedAt: validation.completedAt,
    ...(validation.environmentIdentity === undefined
      ? {}
      : { environmentIdentity: validation.environmentIdentity }),
  };
  assert.equal(
    validation.digest,
    hash(JSON.stringify(ordered)),
    "candidate validation digest differs",
  );
  return duration;
}

export function assertNativeLinearCandidate(proof, events) {
  const publication = proof.publication;
  const expected = mergeCandidateDemand(proof.sourcePublication, publication);
  assert.deepEqual(proof.candidateIdentity, expected.identity);
  assert.equal(proof.candidateIdentityDigest, expected.identityDigest);
  assert.deepEqual(proof.candidateDemand, expected.demand);
  const candidate = assertQualificationCheckpoint(
    proof.candidateRead,
    expected.demand,
    publication.baseSha,
  );
  assert.deepEqual(
    Object.keys(candidate).sort(),
    ["evidence", "identity", "identityDigest", "protocol", "source", "validation"],
    "merge candidate fields changed",
  );
  assert.equal(candidate.protocol, "clockgrove.factory/merge-candidate-checkpoint-v1");
  assert.deepEqual(candidate.identity, expected.identity);
  assert.equal(candidate.identityDigest, expected.identityDigest);
  const duration = assertValidationCheckpoint(candidate.validation);
  assert.equal(candidate.validation.baseSha, publication.baseSha);
  assert.equal(candidate.validation.outputTreeSha, proof.validation.outputTreeSha);
  const sourceCore = {
    protocol: "clockgrove.factory/exact-head-validation-v1",
    validationDigest: proof.sourcePublication.validationDigest,
    baseSha: proof.sourcePublication.baseSha,
    outputTreeSha: proof.sourceValidation.outputTreeSha,
    publishedHeadSha: proof.sourcePublication.headSha,
  };
  const source = { ...sourceCore, digest: hash(JSON.stringify(sourceCore)) };
  assert.deepEqual(candidate.source, source);
  const bound = {
    protocol: "clockgrove.factory/merge-candidate-validation-v1",
    sourceExactHeadValidationDigest: source.digest,
    sourceBaseSha: source.baseSha,
    sourceHeadSha: source.publishedHeadSha,
    sourceTreeSha: source.outputTreeSha,
    targetBaseSha: publication.baseSha,
    candidateOutputTreeSha: proof.validation.outputTreeSha,
    candidateArtifactDigest: candidate.validation.artifactDigest,
    candidateValidationDigest: candidate.validation.digest,
  };
  assert.deepEqual(candidate.evidence, { ...bound, digest: hash(JSON.stringify(bound)) });
  const validationUsage = one(
    events.filter(
      (event) =>
        event.event === "BudgetReconciled" &&
        event.runId === publication.runId &&
        event.objective === publication.objective &&
        event.workItem === publication.workItem &&
        event.attempt === publication.attempt &&
        event.phase === "validation" &&
        event.unit === "validation_milliseconds" &&
        event.usageId === `integration-validation-${expected.identityDigest}`,
    ),
    "integration validation accounting is missing or repeated",
  );
  assert.equal(validationUsage.amount, duration);
  assert.ok(
    publication.sequence < validationUsage.sequence &&
      validationUsage.sequence < proof.integration.sequence,
    "integration validation accounting is outside its candidate/integration fence",
  );
  const expectedReview = integrationReview(publication, candidate);
  assert.deepEqual(proof.candidateReviewIdentity, expectedReview.identity);
  assert.equal(proof.candidateReviewIdentityDigest, expectedReview.identityDigest);
  assert.deepEqual(proof.candidateReviewDemand, expectedReview.demand);
  const review = assertQualificationCheckpoint(
    proof.candidateReviewRead,
    expectedReview.demand,
    publication.baseSha,
  );
  assertReviewDocument(review, expectedReview);
  const reviewUsage = one(
    events.filter(
      (event) =>
        event.event === "BudgetReconciled" &&
        event.runId === publication.runId &&
        event.objective === publication.objective &&
        event.workItem === publication.workItem &&
        event.attempt === publication.attempt &&
        event.phase === "management" &&
        event.unit === "model_tokens" &&
        event.usageId === expectedReview.usageId,
    ),
    "integration review accounting is missing or repeated",
  );
  assert.equal(reviewUsage.amount, review.usage.inputTokens + review.usage.outputTokens);
  assert.ok(
    validationUsage.sequence < reviewUsage.sequence &&
      reviewUsage.sequence < proof.integration.sequence,
    "integration review accounting is outside its candidate/integration fence",
  );
}

function eventIdentity(event, fields) {
  return JSON.stringify(fields.map((field) => event[field]));
}

export function assertNativeLinearGenerationSets(evidence, events) {
  const proofs = evidence.nativeLinearProofs;
  const cancelled = evidence.nativeLinearCase === "active-cancellation";
  if (!cancelled)
    assert.equal(
      proofs.length,
      6,
      "native linear run must contain exactly six publication generations",
    );
  const runId = evidence.runResult.runId;
  const validationFields = [
    "runId",
    "objective",
    "workItem",
    "attempt",
    "sequence",
    "evidenceDigest",
    "baseSha",
    "outputTreeSha",
    "passed",
  ];
  const publicationFields = [
    "runId",
    "objective",
    "workItem",
    "attempt",
    "sequence",
    "headSha",
    "artifactDigest",
  ];
  const expectedValidations = proofs.map((proof) =>
    eventIdentity(proof.validation, validationFields),
  );
  const expectedPublications = proofs.map((proof) => {
    const publication = proof.publication;
    const published = one(
      events.filter(
        (event) =>
          event.event === "AttemptPublished" &&
          event.runId === runId &&
          event.workItem === publication.workItem &&
          event.attempt === publication.attempt &&
          event.headSha === publication.headSha &&
          event.sequence > proof.validation.sequence &&
          event.sequence < publication.sequence,
      ),
      "exact publication generation is missing or repeated",
    );
    return eventIdentity(published, publicationFields);
  });
  const actualValidations = events
    .filter((event) => event.runId === runId && event.event === "ValidationRecorded")
    .map((event) => eventIdentity(event, validationFields));
  const actualPublications = events
    .filter((event) => event.runId === runId && event.event === "AttemptPublished")
    .map((event) => eventIdentity(event, publicationFields));
  assert.deepEqual(
    actualValidations.sort(),
    expectedValidations.sort(),
    "unmatched validation generation",
  );
  assert.deepEqual(
    actualPublications.sort(),
    expectedPublications.sort(),
    "unmatched attempt-publication generation",
  );
  const expectedSemantic = proofs.map((proof) => {
    const publication = proof.publication;
    const published = events.find(
      (event) =>
        event.event === "AttemptPublished" &&
        event.runId === runId &&
        event.workItem === publication.workItem &&
        event.attempt === publication.attempt &&
        event.headSha === publication.headSha,
    );
    assert.ok(published, "publication generation is unavailable");
    return publicationReview(publication, proof.validation, published, proof.publicationIndex)
      .usageId;
  });
  const expectedFinals = proofs.filter((proof) => proof.integration);
  assert.equal(
    expectedFinals.length,
    cancelled ? 1 : 3,
    "native integration generation coverage differs",
  );
  const expectedIntegrationValidation = expectedFinals.map(
    (proof) => `integration-validation-${proof.candidateIdentityDigest}`,
  );
  const expectedIntegrationReview = expectedFinals.map(
    (proof) => `integration-review-${proof.candidateReviewIdentityDigest}`,
  );
  const actualUsageIds = (pattern) =>
    events
      .filter(
        (event) =>
          event.runId === runId &&
          event.event === "BudgetReconciled" &&
          typeof event.usageId === "string" &&
          pattern.test(event.usageId),
      )
      .map((event) => event.usageId)
      .sort();
  assert.deepEqual(
    actualUsageIds(/^(?:review-|rebase-review-)/),
    expectedSemantic.sort(),
    "unmatched semantic-review usage generation",
  );
  assert.deepEqual(
    actualUsageIds(/^integration-validation-/),
    expectedIntegrationValidation.sort(),
    "unmatched integration-validation usage generation",
  );
  assert.deepEqual(
    actualUsageIds(/^integration-review-/),
    expectedIntegrationReview.sort(),
    "unmatched integration-review usage generation",
  );
}

export function assertNativeLinearPublicationProofs(
  evidence,
  events,
  groups = publicationsByPosition(events),
) {
  const expectedCount = groups.reduce((sum, group) => sum + group.publications.length, 0);
  assert.equal(
    evidence.nativeLinearProofs.length,
    expectedCount,
    "native exact-head proof coverage differs",
  );
  for (const [position, group] of groups.entries())
    for (const [publicationIndex, publication] of group.publications.entries()) {
      const proof = one(
        evidence.nativeLinearProofs.filter(
          (entry) => entry.position === position && entry.publicationIndex === publicationIndex,
        ),
        "native exact-head proof coverage differs",
      );
      assert.deepEqual(proof.publication, publication);
      assert.deepEqual(proof.commitDemand, { kind: "commit", oid: publication.headSha });
      assert.equal(proof.commitRead.oid, publication.headSha);
      assert.deepEqual(proof.commitRead.parentOids, [proof.validation.baseSha]);
      assert.equal(proof.commitRead.treeOid, proof.validation.outputTreeSha);
      assert.equal(proof.validation.evidenceDigest, publication.validationDigest);
      assert.equal(proof.validation.baseSha, publication.baseSha);
      assert.equal(proof.validation.passed, true);
      assert.equal(
        publication.exactHeadValidationDigest,
        exactHeadValidationDigest(publication, proof.validation),
        "published exact-head validation binding changed",
      );
      assert.ok(proof.validation.sequence < publication.sequence);
      if (publicationIndex > 0) {
        const invalidation = group.publications[publicationIndex - 1];
        assert.equal(proof.invalidation.headSha, invalidation.headSha);
        assert.ok(proof.invalidation.sequence < proof.validation.sequence);
      }
      assertExactReview(proof, events);
      if (publicationIndex === group.publications.length - 1 && proof.integration)
        assertNativeLinearCandidate(proof, events);
    }
  assertNativeLinearGenerationSets(evidence, events);
}

export function assertNativeLinearTerminal(events, expectedState) {
  const outcomes = events.filter((event) => [...terminalEvents.values()].includes(event.event));
  const outcome = one(outcomes, "native terminal receipt is missing, repeated, or conflicting");
  assert.equal(outcome.event, terminalEvents.get(expectedState), "native terminal outcome differs");
  return outcome;
}

export function assertNativeControllerTakeover(events, trigger, expectedGeneration) {
  const observations = events
    .filter(
      (event) =>
        event.event === "ControllerObserved" && event.observationScope === "repository-controller",
    )
    .sort((left, right) => left.sequence - right.sequence);
  assert.ok(observations.length >= 2, "controller takeover history is incomplete");
  const runGeneration = controllerGeneration(observations[0]);
  for (const [index, observation] of observations.entries()) {
    const generation = controllerGeneration(observation);
    assert.equal(
      generation.controllerPolicyDigest,
      runGeneration.controllerPolicyDigest,
      "controller policy drifted within the run",
    );
    assert.equal(
      generation.protocolMin,
      runGeneration.protocolMin,
      "controller minimum protocol drifted within the run",
    );
    assert.equal(
      generation.protocolMax,
      runGeneration.protocolMax,
      "controller maximum protocol drifted within the run",
    );
    assert.equal(
      generation.writerPolicyDigest,
      runGeneration.writerPolicyDigest,
      "controller writer policy drifted within the run",
    );
    if (index > 0) {
      const prior = controllerGeneration(observations[index - 1]);
      assert.ok(generation.epoch >= prior.epoch, "controller epoch regressed");
      assert.ok(generation.writerEpoch >= prior.writerEpoch, "controller writer epoch regressed");
      if (generation.epoch === prior.epoch) {
        for (const field of [
          "controllerId",
          "expiresAt",
          "controllerPolicyDigest",
          "protocolMin",
          "protocolMax",
          "writerHolder",
          "writerEpoch",
          "writerPolicyDigest",
        ])
          assert.equal(generation[field], prior[field], `controller ${field} drifted in one epoch`);
      }
      if (generation.writerEpoch === prior.writerEpoch)
        for (const field of ["writerHolder", "writerPolicyDigest"])
          assert.equal(
            generation[field],
            prior[field],
            `controller ${field} drifted in one writer epoch`,
          );
    }
  }
  const before = observations.filter((event) => event.sequence < trigger.sequence).at(-1);
  assert.ok(before, "predecessor controller generation is missing");
  assert.deepEqual(
    controllerGeneration(before),
    expectedGeneration,
    "intervention predecessor generation changed",
  );
  const after = observations.find(
    (event) => event.sequence > trigger.sequence && event.controllerId !== before.controllerId,
  );
  assert.ok(after, "successor controller generation is missing");
  assert.ok(after.epoch > before.epoch, "successor controller epoch did not advance");
  assert.equal(
    after.controllerPolicyDigest,
    before.controllerPolicyDigest,
    "successor controller policy changed",
  );
  assert.equal(after.protocolMin, before.protocolMin, "successor minimum protocol changed");
  assert.equal(after.protocolMax, before.protocolMax, "successor maximum protocol changed");
  assert.equal(
    after.writerPolicyDigest,
    before.writerPolicyDigest,
    "successor writer policy changed",
  );
  const firstAdvancement = events
    .filter(
      (event) =>
        event.sequence > trigger.sequence &&
        [
          "AttemptPublished",
          "PublicationRecorded",
          "StackLinked",
          "IntegrationPending",
          "IntegrationCompleted",
          "AttemptIntegrated",
        ].includes(event.event),
    )
    .sort((left, right) => left.sequence - right.sequence)[0];
  assert.ok(firstAdvancement, "resumed controller made no delivery advancement");
  assert.ok(
    after.sequence < firstAdvancement.sequence,
    "successor controller was observed only after delivery resumed",
  );
  return { before: controllerGeneration(before), after: controllerGeneration(after) };
}

function assertIntegratedPrefix(evidence, events, groups, cancellation) {
  const integrations = events
    .filter((event) => event.event === "AttemptIntegrated")
    .sort((left, right) => left.sequence - right.sequence);
  assert.equal(integrations.length, 1, "cancellation requires exactly the integrated root");
  assert.ok(
    integrations.every((event) => event.sequence < cancellation.sequence),
    "native integration followed cancellation",
  );
  const positions = integrations.map((event) =>
    groups.findIndex(({ publications }) => publications[0].workItem === event.workItem),
  );
  assert.deepEqual(
    positions,
    Array.from({ length: integrations.length }, (_, index) => index),
    "accepted native work is not one exact lower prefix",
  );
  const operationIds = new Set();
  for (const [index, integration] of integrations.entries()) {
    const publication = groups[index].publications.at(-1);
    const completion = one(
      events.filter(
        (event) =>
          event.event === "IntegrationCompleted" &&
          event.workItem === publication.workItem &&
          event.headSha === publication.headSha,
      ),
      "accepted prefix integration proof is missing or repeated",
    );
    assert.ok(completion.sequence < integration.sequence);
    operationIds.add(completion.operationId);
  }
  assert.equal(operationIds.size, 1, "accepted prefix changed its durable operation identity");
  for (const integration of integrations) {
    const child = one(
      evidence.children.filter((entry) => entry.number === integration.workItem),
      "accepted prefix issue is missing or repeated",
    );
    assert.equal(child.state, "closed", "accepted prefix issue is not closed");
    const status = one(
      evidence.status.workItems.filter((entry) => entry.number === integration.workItem),
      "accepted prefix status is missing or repeated",
    );
    assert.equal(status.state, "done", "accepted prefix status is not done");
  }
  return { integrations, operationId: [...operationIds][0] };
}

export function assertNativeCancellationBoundary(
  evidence,
  events,
  groups = publicationsByPosition(events),
) {
  const intervention = evidence.nativeLinearIntervention;
  assert.equal(intervention?.case, "active-cancellation");
  const cancellation = one(
    events.filter(
      (event) =>
        event.event === "FactoryRunCancellationRequested" &&
        event.requestId === intervention.requestId,
    ),
    "native cancellation request is missing or repeated",
  );
  assert.equal(
    events.filter((event) => event.event === "FactoryRunCancellationRequested").length,
    1,
    "native cancellation contains another cancellation request",
  );
  const activationRequestId = evidence.runRequest?.arguments?.requestId;
  const activation = one(
    events.filter(
      (event) => event.event === "ActivationRequested" && event.requestId === activationRequestId,
    ),
    "native activation request is missing or repeated",
  );
  assert.equal(
    events.filter((event) => event.event === "ActivationRequested").length,
    1,
    "native cancellation contains another activation request",
  );
  assert.ok(activation.sequence < cancellation.sequence, "native activation follows cancellation");
  const forbiddenInterventions = new Set([
    "ActivationRejected",
    "ActivationCancellationRequested",
    "RunPauseRequested",
    "RunPauseAcknowledged",
    "RunResumeRequested",
    "RunDrainRequested",
    "RunDrainCompleted",
    "CloudPauseRequested",
    "WorkItemRetryRequested",
    "RecoveryRequested",
    "RecoveryConsumed",
    "RecoveryAdoptionCompleted",
    "RecoverySourcePublished",
    "RecoverySourceIntegrated",
  ]);
  assert.ok(
    !events.some((event) => forbiddenInterventions.has(event.event) || event.kind === "recovery"),
    "native cancellation contains another intervention",
  );
  const prefix = assertIntegratedPrefix(evidence, events, groups, cancellation);
  assert.equal(
    intervention.progress.operationId,
    prefix.operationId,
    "cancellation intervention changed the accepted integration operation",
  );
  const firstUnresolved = groups[prefix.integrations.length].publications[0];
  assert.equal(
    intervention.progress.workItem,
    firstUnresolved.workItem,
    "cancellation was not bound to the first unresolved descendant",
  );
  assert.equal(
    intervention.progress.integratedWorkItem,
    prefix.integrations.at(-1).workItem,
    "cancellation progress differs from the accepted lower prefix",
  );
  assert.equal(
    intervention.progress.attemptIntegratedSequence,
    prefix.integrations[0].sequence,
    "cancellation accepted-root receipt changed",
  );
  const rootCompletion = one(
    events.filter(
      (event) =>
        event.event === "IntegrationCompleted" &&
        event.workItem === intervention.progress.integratedWorkItem &&
        event.headSha === intervention.progress.integrationSourceHeadSha &&
        event.operationId === intervention.progress.operationId &&
        event.sequence === intervention.progress.integrationCompletedSequence,
    ),
    "cancellation accepted-root mutation changed",
  );
  assert.ok(rootCompletion.sequence < prefix.integrations[0].sequence);
  assert.equal(
    prefix.integrations[0].headSha,
    intervention.progress.integrationHeadSha,
    "cancellation accepted-root merge identity changed",
  );
  const invalidation = one(
    events.filter(
      (event) =>
        event.event === "ValidationInvalidated" &&
        event.workItem === intervention.progress.workItem &&
        event.attempt === intervention.progress.attempt &&
        event.sequence === intervention.progress.invalidationSequence &&
        event.headSha === intervention.progress.invalidatedHeadSha &&
        event.invalidatedByItem === intervention.progress.invalidatedByItem &&
        event.invalidatedByHeadSha === intervention.progress.invalidatedByHeadSha,
    ),
    "cancellation invalidation trigger changed",
  );
  const validation = one(
    events.filter(
      (event) =>
        event.event === "ValidationRecorded" &&
        event.workItem === intervention.progress.workItem &&
        event.attempt === intervention.progress.attempt &&
        event.sequence === intervention.progress.validationSequence &&
        event.evidenceDigest === intervention.progress.validationDigest &&
        event.outputTreeSha === intervention.progress.outputTreeSha,
    ),
    "cancellation revalidation trigger changed",
  );
  const reviewUsage = one(
    events.filter(
      (event) =>
        event.event === "BudgetReconciled" &&
        event.workItem === intervention.progress.workItem &&
        event.attempt === intervention.progress.attempt &&
        event.phase === "management" &&
        event.unit === "model_tokens" &&
        event.sequence === intervention.progress.reviewUsageSequence &&
        event.usageId === intervention.progress.reviewUsageId,
    ),
    "cancellation review accounting trigger changed",
  );
  assert.equal(reviewUsage.usageId, `rebase-review-${intervention.progress.reviewIdentityDigest}`);
  const published = one(
    events.filter(
      (event) =>
        event.event === "AttemptPublished" &&
        event.workItem === intervention.progress.workItem &&
        event.attempt === intervention.progress.attempt &&
        event.sequence === intervention.progress.attemptPublicationSequence &&
        event.headSha === intervention.progress.durableHeadSha &&
        event.artifactDigest === intervention.progress.artifactDigest,
    ),
    "cancellation attempt-publication trigger changed",
  );
  const publication = one(
    events.filter(
      (event) =>
        event.event === "PublicationRecorded" &&
        event.workItem === intervention.progress.workItem &&
        event.attempt === intervention.progress.attempt &&
        event.sequence === intervention.progress.publicationSequence &&
        event.headSha === intervention.progress.durableHeadSha &&
        event.validationDigest === intervention.progress.validationDigest,
    ),
    "cancellation republication trigger changed",
  );
  assert.ok(
    invalidation.sequence < validation.sequence &&
      validation.sequence < reviewUsage.sequence &&
      reviewUsage.sequence < published.sequence &&
      published.sequence < publication.sequence &&
      publication.sequence < cancellation.sequence,
    "cancellation intervention is outside its invalidation/republication fence",
  );
  assert.ok(
    !events.some(
      (event) =>
        [
          "AttemptIntegrated",
          "IntegrationCompleted",
          "AttemptPublished",
          "PublicationRecorded",
          "StackLinked",
          "IntegrationPending",
        ].includes(event.event) && event.sequence > cancellation.sequence,
    ),
    "native delivery advanced after durable cancellation",
  );
  const unresolved = groups.slice(prefix.integrations.length).map((group) => group.publications[0]);
  assert.ok(unresolved.length > 0, "cancellation has no unresolved descendants");
  for (const publication of unresolved) {
    assert.ok(
      !events.some(
        (event) =>
          ["IntegrationCompleted", "AttemptIntegrated"].includes(event.event) &&
          event.workItem === publication.workItem,
      ),
      "cancellation descendant resolved before the cancellation fence",
    );
    const child = one(
      evidence.children.filter((entry) => entry.number === publication.workItem),
      "cancellation descendant issue is missing or repeated",
    );
    assert.equal(child.state, "open", "cancellation descendant issue is resolved");
    const status = one(
      evidence.status.workItems.filter((entry) => entry.number === publication.workItem),
      "cancellation descendant status is missing or repeated",
    );
    assert.notEqual(status.state, "done", "cancellation descendant status is resolved");
  }
  assert.equal(
    evidence.mergeProofs.length,
    prefix.integrations.length,
    "accepted lower prefix merge-proof coverage differs",
  );
  for (const [index, integration] of prefix.integrations.entries()) {
    const finalPublication = groups[index].publications.at(-1);
    const pull = one(
      evidence.pulls.filter((entry) => entry.number === finalPublication.pullRequest),
      "accepted prefix PR identity is missing or repeated",
    );
    const mergeProof = one(
      evidence.mergeProofs.filter((entry) => entry.workItem === finalPublication.workItem),
      "accepted prefix GraphQL proof coverage differs",
    );
    assertQualificationMergeProof(mergeProof, {
      repository: evidence.repository,
      pull,
      publication: finalPublication,
      integration,
    });
  }
  assert.match(
    evidence.nativeLinearUnrelatedSentinel?.started?.unit ?? "",
    /^clockgrove-qualification-sentinel-[a-f0-9-]+\.service$/,
  );
  assert.match(
    evidence.nativeLinearUnrelatedSentinel?.started?.invocationId ?? "",
    /^[a-f0-9]{32}$/,
  );
  assert.match(
    evidence.nativeLinearUnrelatedSentinel?.started?.controlGroupDigest ?? "",
    /^[a-f0-9]{64}$/,
  );
  assert.ok(
    evidence.nativeLinearUnrelatedSentinel?.started?.status === "active" &&
      evidence.nativeLinearUnrelatedSentinel.survived?.status === "active" &&
      evidence.nativeLinearUnrelatedSentinel.survived.unit ===
        evidence.nativeLinearUnrelatedSentinel.started.unit &&
      evidence.nativeLinearUnrelatedSentinel.survived.invocationId ===
        evidence.nativeLinearUnrelatedSentinel.started.invocationId &&
      evidence.nativeLinearUnrelatedSentinel.survived.controlGroupDigest ===
        evidence.nativeLinearUnrelatedSentinel.started.controlGroupDigest &&
      evidence.nativeLinearUnrelatedSentinel.stopped?.status === "absent",
    "unrelated live sentinel survival is unproven",
  );
  return { cancellation, ...prefix };
}

export function assertNativeLinearLifecycle(evidence, caseName = evidence.nativeLinearCase) {
  assert.ok(cases.has(caseName), "unknown native linear qualification case");
  assert.equal(evidence.scope, `${scope}-${caseName}`);
  assertQualificationNamespace(evidence);
  assert.deepEqual(evidence.finishedInstalledArtifact, evidence.installedArtifact);
  assert.deepEqual(evidence.nativeLinearHarness, harnessIdentity());
  assertNativeScopes(evidence);
  if (caseName !== "cascade") {
    const controller = evidence.nativeLinearController;
    for (const observation of [controller?.before, controller?.after]) {
      assert.ok(
        observation?.status?.installed &&
          observation.status.enabled &&
          observation.status.active &&
          observation.status.healthy &&
          observation.status.launcherCurrent,
        "installed controller was not healthy across the qualification",
      );
      assert.equal(
        observation.authority.artifactIdentity,
        evidence.installedCandidate.factoryArtifactIdentity,
      );
    }
    assert.equal(controller.before.status.unit, controller.after.status.unit);
    assert.equal(
      controller.before.status.executableIdentity,
      controller.after.status.executableIdentity,
    );
    assert.equal(
      controller.before.status.currentExecutableIdentity,
      controller.after.status.currentExecutableIdentity,
    );
  }
  const events = nativeQualificationEvents(evidence);
  const start = one(
    events.filter((event) => event.event === "FactoryRunStarted"),
    "native run start is missing or repeated",
  );
  assert.equal(start.runId, evidence.runResult.runId);
  assert.deepEqual(start.policy, evidence.policy);
  const delivery = one(
    events.filter((event) => event.event === "DeliverySelected"),
    "native delivery selection is missing or repeated",
  );
  assert.equal(delivery.requested, "stacked-prs");
  assert.equal(delivery.selected, "native-stacks");
  const groups = assertLinearTopology(evidence, events);
  const model = assertNoOpenLiabilities(events);
  assert.equal(
    evidence.status.summary.economics.unresolvedModelInvocations,
    0,
    "status retains unresolved model invocations",
  );
  assert.equal(
    evidence.status.summary.economics.usage.model_tokens.availability,
    "observed",
    "status model usage is unavailable",
  );
  assert.equal(
    evidence.status.summary.economics.usage.model_tokens.value,
    model.total,
    "status model usage differs from authenticated accounting",
  );
  const attempts = events.filter((event) => event.event === "AttemptStarted");
  assert.equal(attempts.length, 3, "native linear run must execute each Work Item once");
  assert.equal(new Set(attempts.map((event) => event.workItem)).size, 3);
  assert.ok(attempts.every((event) => event.attempt === 1));
  for (const attempt of attempts)
    one(
      events.filter(
        (event) =>
          event.event === "BudgetReconciled" &&
          event.phase === "execution" &&
          event.unit === "model_tokens" &&
          event.workItem === attempt.workItem &&
          event.attempt === attempt.attempt &&
          event.amount >= 0,
      ),
      "worker accounting is missing or repeated",
    );

  const expectedState = caseName === "active-cancellation" ? "cancelled" : "completed";
  assert.equal(evidence.runResult.status, expectedState);
  assert.equal(evidence.status.run.runId, evidence.runResult.runId);
  assert.equal(evidence.status.summary.runId, evidence.runResult.runId);
  assert.equal(evidence.status.run.state, expectedState);
  assert.equal(evidence.status.summary.outcome, expectedState);
  assertNativeLinearTerminal(events, expectedState);

  if (caseName === "active-cancellation") {
    assertNativeLinearPublicationProofs(evidence, events, groups);
    assertNativeCancellationBoundary(evidence, events, groups);
    assert.ok(evidence.pulls.length > 0, "active cancellation observed no owned pull requests");
    assert.ok(
      evidence.pulls.every((pull) => pull.state === "closed"),
      "owned PR cleanup incomplete",
    );
    for (const [index, group] of groups.entries()) {
      const pull = one(
        evidence.pulls.filter((entry) => entry.number === group.publications.at(-1).pullRequest),
        "owned cancellation PR identity is missing or repeated",
      );
      if (index === 0) assert.ok(pull.merged_at, "accepted root PR lacks merged proof");
      else assert.equal(pull.merged_at, null, "unresolved descendant PR was merged");
    }
    return;
  }

  assertNativeLinearHistory(events);
  assertNativeLinearPublicationProofs(evidence, events, groups);

  assert.equal(evidence.objective.state, "closed");
  assert.ok(evidence.children.every((child) => child.state === "closed"));
  assert.ok(evidence.status.workItems.every((item) => item.state === "done"));
  assert.equal(evidence.mergeProofs.length, 3);
  for (const [index, group] of groups.entries()) {
    const finalPublication = group.publications.at(-1);
    if (index > 0) {
      assert.ok(
        group.publications.length >= index + 1,
        "descendant was not revalidated per lower change",
      );
    }
    const integration = one(
      events.filter(
        (event) =>
          event.event === "AttemptIntegrated" && event.workItem === finalPublication.workItem,
      ),
      "native integration is missing or repeated",
    );
    const pull = one(
      evidence.pulls.filter((entry) => entry.number === finalPublication.pullRequest),
      "native pull identity is missing or repeated",
    );
    const mergeProof = one(
      evidence.mergeProofs.filter((entry) => entry.workItem === finalPublication.workItem),
      "native GraphQL proof coverage differs",
    );
    assertQualificationMergeProof(mergeProof, {
      repository: evidence.repository,
      pull,
      publication: finalPublication,
      integration,
    });
    if (index > 0) {
      const invalidations = events.filter(
        (event) =>
          event.event === "ValidationInvalidated" && event.workItem === finalPublication.workItem,
      );
      assert.ok(invalidations.length >= index, "transitive descendant invalidation is incomplete");
      assert.ok(
        invalidations.every((event) => event.sequence < finalPublication.sequence),
        "descendant publication precedes invalidation",
      );
    }
  }
  const integrations = events
    .filter((event) => event.event === "AttemptIntegrated")
    .sort((left, right) => left.sequence - right.sequence);
  assert.deepEqual(
    integrations.map(
      (event) =>
        groups.find(({ publications }) => publications[0].workItem === event.workItem)?.position,
    ),
    [0, 1, 2],
    "native stack did not integrate bottom-up",
  );
  assert.ok(
    groups[1].publications.at(-1).sequence > integrations[0].sequence &&
      groups[2].publications.at(-1).sequence > integrations[1].sequence,
    "partial completion did not precede descendant revalidation",
  );
  if (caseName === "response-loss-restart") {
    const intervention = evidence.nativeLinearIntervention;
    assert.equal(intervention?.case, caseName);
    assert.equal(intervention.responseLost, true);
    assert.equal(intervention.runId, evidence.runResult.runId);
    assert.equal(
      intervention.progress.operationId,
      assertNativeIntegrationOperation(events, groups),
      "restarted controller did not adopt the same durable native operation",
    );
    const trigger = one(
      events.filter(
        (event) =>
          event.event === "PublicationRecorded" &&
          event.workItem === intervention.progress.workItem &&
          event.headSha === intervention.progress.durableHeadSha &&
          event.sequence === intervention.progress.publicationSequence,
      ),
      "restart trigger publication changed",
    );
    evidence.nativeLinearTakeover = assertNativeControllerTakeover(
      events,
      trigger,
      intervention.progress.controllerGeneration,
    );
  }
}

export function assessNativeLinearLifecycle(evidence) {
  try {
    assertNativeLinearLifecycle(evidence);
    return { result: "passed", scope: evidence.scope };
  } catch (error) {
    return {
      result: ["cancelled", "escalated"].includes(evidence?.status?.run?.state)
        ? evidence?.nativeLinearCase === "active-cancellation"
          ? "incomplete"
          : "failed"
        : "incomplete",
      scope: evidence?.scope ?? scope,
      reason: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
    };
  }
}

export function nativeLinearQualification(env) {
  if (env.FACTORY_LIVE_NATIVE_LINEAR_OBJECTIVE !== "1") return null;
  assert.ok(
    env.FACTORY_LIVE_OBJECTIVE === "1" || env.FACTORY_LIVE_OBJECTIVE_PREFLIGHT === "1",
    "shared explicit preflight or execution opt-in required",
  );
  const caseName = env.FACTORY_LIVE_NATIVE_LINEAR_CASE;
  assert.ok(cases.has(caseName), "explicit native linear qualification case required");
  assert.ok(
    !env.FACTORY_LIVE_OBJECTIVE_DELIVERY || env.FACTORY_LIVE_OBJECTIVE_DELIVERY === "stacked-prs",
    "native linear qualification cannot select regular delivery",
  );
  assert.equal(
    env.FACTORY_LIVE_NATIVE_FALLBACK_OBJECTIVE,
    undefined,
    "native unavailability belongs to the separate fallback qualification",
  );
  const namespace = qualificationNamespace(env.FACTORY_LIVE_OBJECTIVE_NAMESPACE);
  const policy = boundedPolicy(
    "stacked-prs",
    modelTokenLimit(env.FACTORY_LIVE_OBJECTIVE_MAX_MODEL_TOKENS),
  );
  const qualification = {
    scope: `${scope}-${caseName}`,
    harnessPaths: harnessFiles.map((file) => `scripts/${file}`),
    privateEvidence: true,
    policy,
    namespace,
    objectiveBody: nativeLinearObjectiveBody(namespace),
    beforeRun: async ({ evidence, call, checkout, owner, repo, tools }) => {
      assertCommittedHarness(evidence);
      evidence.nativeLinearCase = caseName;
      evidence.nativeLinearHarness = harnessIdentity();
      if (caseName === "active-cancellation") {
        evidence.nativeLinearUnrelatedSentinel = {
          started: startNativeLinearSentinel(),
        };
      }
      if (caseName === "cascade") return;
      for (const name of [
        "factory_activate",
        "factory_cancel",
        "factory_controller_restart",
        "factory_controller_status",
      ])
        assert.ok(
          tools.some((tool) => tool.name === name),
          `installed MCP server lacks ${name}`,
        );
      const controller = await call("factory_controller_status", {
        owner,
        repo,
        repository: checkout,
        requestId: `${evidence.qualificationNamespace}-controller-preflight`,
      });
      assert.ok(
        controller.installed && controller.active && controller.healthy,
        "exact installed active controller required",
      );
      evidence.nativeLinearController = {
        before: {
          status: controller,
          authority: assertNativeLinearControllerAuthority(controller, evidence, checkout),
        },
      };
    },
    afterRun: async ({ evidence, request, save, call, checkout, owner, repo }) => {
      assertCommittedHarness(evidence);
      try {
        if (evidence.runResult.status !== "completed")
          await observeNativeLinearProofs({ evidence, request });
        if (caseName !== "cascade") {
          const controller = await call("factory_controller_status", {
            owner,
            repo,
            repository: checkout,
            requestId: `${evidence.qualificationNamespace}-controller-final`,
          });
          evidence.nativeLinearController.after = {
            status: controller,
            authority: assertNativeLinearControllerAuthority(controller, evidence, checkout),
          };
        }
        if (caseName === "active-cancellation")
          evidence.nativeLinearUnrelatedSentinel.survived = assertNativeLinearSentinelAlive(
            evidence.nativeLinearUnrelatedSentinel.started,
          );
        observeNativeScopes(evidence);
      } finally {
        if (
          caseName === "active-cancellation" &&
          evidence.nativeLinearUnrelatedSentinel?.started &&
          !evidence.nativeLinearUnrelatedSentinel.stopped
        )
          evidence.nativeLinearUnrelatedSentinel.stopped = stopNativeLinearSentinel(
            evidence.nativeLinearUnrelatedSentinel.started,
          );
        save();
      }
    },
    onFailure: async ({ evidence }) => {
      if (
        caseName === "active-cancellation" &&
        evidence.nativeLinearUnrelatedSentinel?.started &&
        !evidence.nativeLinearUnrelatedSentinel.stopped
      )
        evidence.nativeLinearUnrelatedSentinel.stopped = stopNativeLinearSentinel(
          evidence.nativeLinearUnrelatedSentinel.started,
        );
    },
    observeMergeProofs: observeNativeLinearProofs,
    assessCompletion: assessNativeLinearLifecycle,
    verifyFinalArtifact: verifyNativeLinearFinalArtifact,
  };
  if (caseName !== "cascade") {
    qualification.createRunRequest = async ({ evidence, foregroundRequest }) => ({
      tool: "factory_activate",
      arguments: {
        owner: foregroundRequest.arguments.owner,
        repo: foregroundRequest.arguments.repo,
        objectiveNumber: evidence.objective.number,
        repository: foregroundRequest.arguments.repository,
        requestId: `${evidence.qualificationNamespace}-activate`,
        baseSha: evidence.base,
        policy: evidence.policy,
      },
    });
    qualification.executeRun = (hooks) => executeNativeLinearControllerCase({ caseName, ...hooks });
  }
  return qualification;
}

export async function main(env = process.env, run = installedMain) {
  const qualification = nativeLinearQualification(env);
  if (!qualification) {
    console.log(
      "Not exercised: set FACTORY_LIVE_NATIVE_LINEAR_OBJECTIVE=1 and an explicit matrix case.",
    );
    return;
  }
  await run(qualification, { env });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch {
    console.error(
      "Native linear-stack qualification incomplete; inspect private evidence. No automatic retry performed.",
    );
    process.exitCode = 2;
  }
}
