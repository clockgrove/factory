/** Installed native linear-stack cascade, takeover and cancellation qualification. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  assertQualificationNamespace,
  assertRecordedQualificationPolicy,
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

function revalidatedProgress(events, runId) {
  const own = events.filter((event) => event.runId === runId);
  for (const invalidated of own.filter((event) => event.event === "ValidationInvalidated")) {
    const publication = own.find(
      (event) =>
        event.event === "PublicationRecorded" &&
        event.workItem === invalidated.workItem &&
        event.attempt === invalidated.attempt &&
        event.sequence > invalidated.sequence &&
        event.headSha !== invalidated.headSha,
    );
    const durableOperation = own
      .filter(
        (event) => event.event === "IntegrationCompleted" && event.sequence < invalidated.sequence,
      )
      .sort((left, right) => right.sequence - left.sequence)[0];
    if (publication && durableOperation)
      return {
        workItem: invalidated.workItem,
        invalidatedHeadSha: invalidated.headSha,
        durableHeadSha: publication.headSha,
        publicationSequence: publication.sequence,
        operationId: durableOperation.operationId,
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
    if (state && !evidence.nativeLinearIntervention)
      throw new Error("native run ended before its bounded intervention");
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

function assertExactReview(proof, events) {
  const validation = proof.validation;
  const publication = proof.publication;
  const published = one(
    events.filter(
      (event) =>
        event.event === "AttemptPublished" &&
        event.workItem === publication.workItem &&
        event.attempt === publication.attempt &&
        event.headSha === publication.headSha,
    ),
    "revalidated head publication is missing or repeated",
  );
  const identity = {
    kind: "rebase",
    runId: publication.runId,
    objective: publication.objective,
    workItem: publication.workItem,
    attempt: publication.attempt,
    artifactDigest: published.artifactDigest,
    baseSha: validation.baseSha,
    outputTreeSha: validation.outputTreeSha,
    evidenceDigest: validation.evidenceDigest,
    headSha: publication.headSha,
  };
  const identityDigest = hash(canonical(identity));
  const demand = {
    kind: "checkpoint",
    ref:
      `refs/clockgrove-factory/reviews/objective-${publication.objective}/` +
      `work-item-${publication.workItem}/attempt-${publication.attempt}/` +
      `rebase-${identityDigest}`,
    path: ".clockgrove-factory/control/semantic-review.json",
    maxBytes: 65_536,
  };
  assert.deepEqual(proof.reviewDemand, demand, "rebase review demand changed");
  const review = assertQualificationCheckpoint(proof.reviewRead, demand, validation.baseSha);
  assert.equal(review.protocol, "clockgrove.factory/review-checkpoint-v1");
  assert.equal(review.identityDigest, identityDigest);
  assert.deepEqual(review.identity, identity);
  assert.equal(review.review.accepted, true);
  assert.deepEqual(review.review.unmetCriteria, []);
  const usage = one(
    events.filter(
      (event) =>
        event.event === "BudgetReconciled" &&
        event.workItem === publication.workItem &&
        event.attempt === publication.attempt &&
        event.phase === "management" &&
        event.unit === "model_tokens" &&
        event.usageId === `rebase-review-${identityDigest}`,
    ),
    "rebase review accounting is missing or repeated",
  );
  assert.equal(usage.amount, review.usage.inputTokens + review.usage.outputTokens);
  assert.ok(usage.sequence < publication.sequence, "review accounting follows publication");
  return identityDigest;
}

export async function observeNativeLinearProofs({ evidence, request }) {
  const events = nativeQualificationEvents(evidence);
  const read = nativeProofReader(request);
  evidence.nativeLinearProofs = [];
  evidence.mergeProofs = [];
  if (evidence.runResult.status !== "completed") return [];
  for (const { position, publications } of publicationsByPosition(events)) {
    const publication = publications.at(-1);
    const validation = one(
      events.filter(
        (event) =>
          event.event === "ValidationRecorded" &&
          event.workItem === publication.workItem &&
          event.attempt === publication.attempt &&
          event.evidenceDigest === publication.validationDigest &&
          event.baseSha === publication.baseSha,
      ),
      "final native publication validation is missing or repeated",
    );
    const commitDemand = { kind: "commit", oid: publication.headSha };
    const commitRead = await read(commitDemand);
    const record = { position, publication, validation, commitDemand, commitRead };
    if (publications.length > 1) {
      const published = one(
        events.filter(
          (event) =>
            event.event === "AttemptPublished" &&
            event.workItem === publication.workItem &&
            event.attempt === publication.attempt &&
            event.headSha === publication.headSha,
        ),
        "final native publication attempt is missing or repeated",
      );
      const identity = {
        kind: "rebase",
        runId: publication.runId,
        objective: publication.objective,
        workItem: publication.workItem,
        attempt: publication.attempt,
        artifactDigest: published.artifactDigest,
        baseSha: validation.baseSha,
        outputTreeSha: validation.outputTreeSha,
        evidenceDigest: validation.evidenceDigest,
        headSha: publication.headSha,
      };
      const identityDigest = hash(canonical(identity));
      record.reviewDemand = {
        kind: "checkpoint",
        ref:
          `refs/clockgrove-factory/reviews/objective-${publication.objective}/` +
          `work-item-${publication.workItem}/attempt-${publication.attempt}/` +
          `rebase-${identityDigest}`,
        path: ".clockgrove-factory/control/semantic-review.json",
        maxBytes: 65_536,
      };
      record.reviewRead = await read(record.reviewDemand);
    }
    evidence.nativeLinearProofs.push(record);
    const integration = one(
      events.filter(
        (event) =>
          event.event === "AttemptIntegrated" &&
          event.workItem === publication.workItem &&
          event.attempt === publication.attempt,
      ),
      "native integration is missing or repeated",
    );
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
    evidence.mergeProofs.push(await readQualificationMergeProofForIdentity({ request }, expected));
  }
  return evidence.mergeProofs;
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
      testOutput,
      behaviorOutput,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function assertNoOpenLiabilities(events) {
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
    (event) => event.event === "BudgetReserved" && event.unit !== "model_tokens",
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
  for (const prefix of ["integration-validation-", "rebase-review-"]) {
    const usage = events.filter(
      (event) =>
        event.event === "BudgetReconciled" &&
        typeof event.usageId === "string" &&
        event.usageId.startsWith(prefix),
    );
    assert.equal(usage.length, 3, `${prefix} accounting does not cover the complete cascade`);
    assert.equal(
      new Set(usage.map((event) => event.usageId)).size,
      usage.length,
      `${prefix} accounting was duplicated`,
    );
    assert.ok(usage.every((event) => Number.isSafeInteger(event.amount) && event.amount >= 0));
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

export function assertNativeLinearLifecycle(evidence, caseName = evidence.nativeLinearCase) {
  assert.ok(cases.has(caseName), "unknown native linear qualification case");
  assert.equal(evidence.scope, `${scope}-${caseName}`);
  assertQualificationNamespace(evidence);
  assert.deepEqual(evidence.finishedInstalledArtifact, evidence.installedArtifact);
  assert.deepEqual(evidence.nativeLinearHarness, harnessIdentity());
  assertNativeScopes(evidence);
  if (caseName !== "cascade") {
    const controller = evidence.nativeLinearController;
    for (const observation of [controller?.before, controller?.after])
      assert.ok(
        observation?.installed && observation.active && observation.healthy,
        "installed controller was not healthy across the qualification",
      );
    assert.equal(controller.before.unit, controller.after.unit);
    assert.equal(controller.before.executableIdentity, controller.after.executableIdentity);
    assert.equal(
      controller.before.currentExecutableIdentity,
      controller.after.currentExecutableIdentity,
    );
  }
  const events = nativeQualificationEvents(evidence);
  const start = one(
    events.filter((event) => event.event === "FactoryRunStarted"),
    "native run start is missing or repeated",
  );
  assert.equal(start.runId, evidence.runResult.runId);
  assert.deepEqual(start.policy, evidence.policy);
  assertRecordedQualificationPolicy(
    start.policy,
    boundedPolicy("stacked-prs", evidence.policy.economics.maxModelTokens),
  );
  const delivery = one(
    events.filter((event) => event.event === "DeliverySelected"),
    "native delivery selection is missing or repeated",
  );
  assert.equal(delivery.requested, "stacked-prs");
  assert.equal(delivery.selected, "native-stacks");
  const groups = assertLinearTopology(evidence, events);
  assertNoOpenLiabilities(events);
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
  assert.equal(evidence.status.run.state, expectedState);
  one(
    events.filter((event) => event.event === terminalEvents.get(expectedState)),
    "native terminal receipt is missing or repeated",
  );

  if (caseName === "active-cancellation") {
    const intervention = evidence.nativeLinearIntervention;
    assert.equal(intervention?.case, caseName);
    const cancellation = one(
      events.filter(
        (event) =>
          event.event === "FactoryRunCancellationRequested" &&
          event.requestId === intervention.requestId,
      ),
      "native cancellation request is missing or repeated",
    );
    assert.ok(
      events.some(
        (event) => event.event === "AttemptIntegrated" && event.sequence < cancellation.sequence,
      ),
      "active cancellation did not preserve partial native completion",
    );
    assert.ok(
      !events.some(
        (event) =>
          ["AttemptIntegrated", "PublicationRecorded", "StackLinked"].includes(event.event) &&
          event.sequence > cancellation.sequence,
      ),
      "native delivery advanced after durable cancellation",
    );
    assert.ok(evidence.pulls.length > 0, "active cancellation observed no owned pull requests");
    assert.ok(
      evidence.pulls.every((pull) => pull.state === "closed"),
      "owned PR cleanup incomplete",
    );
    return;
  }

  assertNativeLinearHistory(events);

  assert.equal(evidence.objective.state, "closed");
  assert.ok(evidence.children.every((child) => child.state === "closed"));
  assert.ok(evidence.status.workItems.every((item) => item.state === "done"));
  assert.equal(evidence.nativeLinearProofs.length, 3);
  assert.equal(evidence.mergeProofs.length, 3);
  for (const [index, group] of groups.entries()) {
    const finalPublication = group.publications.at(-1);
    const proof = one(
      evidence.nativeLinearProofs.filter((entry) => entry.position === index),
      "native exact-head proof coverage differs",
    );
    assert.deepEqual(proof.publication, finalPublication);
    assert.deepEqual(proof.commitDemand, { kind: "commit", oid: finalPublication.headSha });
    assert.equal(proof.commitRead.oid, finalPublication.headSha);
    assert.deepEqual(proof.commitRead.parentOids, [proof.validation.baseSha]);
    assert.equal(proof.commitRead.treeOid, proof.validation.outputTreeSha);
    assert.equal(proof.validation.evidenceDigest, finalPublication.validationDigest);
    assert.equal(proof.validation.baseSha, finalPublication.baseSha);
    if (index > 0) {
      assert.ok(
        group.publications.length >= index + 1,
        "descendant was not revalidated per lower change",
      );
      assertExactReview(proof, events);
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
    const before = events.filter(
      (event) => event.event === "ControllerObserved" && event.sequence < trigger.sequence,
    );
    const after = events.filter(
      (event) =>
        event.event === "ControllerObserved" &&
        event.sequence > trigger.sequence &&
        before.every((prior) => prior.controllerId !== event.controllerId),
    );
    assert.ok(before.length > 0 && after.length > 0, "controller takeover was not authenticated");
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
    privateEvidence: true,
    policy,
    namespace,
    objectiveBody: nativeLinearObjectiveBody(namespace),
    beforeRun: async ({ evidence, call, checkout, owner, repo, tools }) => {
      assertCommittedHarness(evidence);
      evidence.nativeLinearCase = caseName;
      evidence.nativeLinearHarness = harnessIdentity();
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
      evidence.nativeLinearController = { before: controller };
    },
    afterRun: async ({ evidence, request, save, call, checkout, owner, repo }) => {
      assertCommittedHarness(evidence);
      if (evidence.runResult.status !== "completed")
        await observeNativeLinearProofs({ evidence, request });
      if (caseName !== "cascade")
        evidence.nativeLinearController.after = await call("factory_controller_status", {
          owner,
          repo,
          repository: checkout,
          requestId: `${evidence.qualificationNamespace}-controller-final`,
        });
      observeNativeScopes(evidence);
      save();
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
  await run(qualification);
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
