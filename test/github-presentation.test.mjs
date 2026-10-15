import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  factoryAuthorityDigest,
  factoryConfigDigest,
  githubProgressSettings,
  githubProjectStatusSettings,
  validateConfig,
} from "../dist/config.js";
import { renderWorkItemProgress } from "../dist/github-progress.js";
import {
  assertGitHubProgressProjection,
  progressDigest,
} from "../dist/github-progress-state.js";
import { discoveredStatusOptions } from "../dist/github-project-state.js";

const target = mkdtempSync(join(tmpdir(), "factory-presentation-target-"));
execFileSync("git", ["init", "-q", target]);
execFileSync("git", [
  "-C",
  target,
  "remote",
  "add",
  "origin",
  "https://github.com/example/target.git",
]);

const base = {
  schemaVersion: 1,
  repository: "example/target",
  checkout: target,
  planning: {
    kind: "codex-sdk",
    planner: { model: "gpt-6.1-sol", reasoningEffort: "high" },
    reviewer: { model: "gpt-6.1-sol", reasoningEffort: "high" },
  },
  execution: {
    kind: "local",
    harness: {
      kind: "codex-sdk",
      model: "gpt-6.1-sol",
      reasoningEffort: "medium",
    },
  },
  delivery: { kind: "regular" },
  policy: { network: "host", allowedSecretNames: [] },
};
const queue = {
  pollSeconds: 60,
  project: {
    repository: "example/target",
    projectId: "PVT_project",
    metadataFieldId: "PVTF_metadata",
    orderFieldId: "PVTF_order",
    controlItemId: "PVTI_control",
    factoryManagedFields: true,
  },
};

test("GitHub progress and Project status are on by default and opt out without rebinding runs", () => {
  const plain = validateConfig(structuredClone(base));
  assert.deepEqual(githubProgressSettings(plain), {
    repository: "example/target",
    includeQuestions: false,
    explicit: false,
  });
  // No queue Project: nothing to discover.
  assert.equal(githubProjectStatusSettings(plain), undefined);
  const queued = validateConfig({ ...structuredClone(base), queue });
  assert.deepEqual(githubProjectStatusSettings(queued), {
    kind: "discover",
    repository: "example/target",
    projectId: "PVT_project",
    reservedFieldIds: ["PVTF_metadata", "PVTF_order"],
  });
  const optedOut = validateConfig({
    ...structuredClone(base),
    queue,
    githubManagement: {
      progress: { enabled: false },
      projectStatus: { enabled: false },
    },
  });
  assert.equal(githubProgressSettings(optedOut), undefined);
  assert.equal(githubProjectStatusSettings(optedOut), undefined);
  const explicit = validateConfig({
    ...structuredClone(base),
    githubManagement: {
      progress: {
        enabled: true,
        repository: "example/target",
        includeQuestions: true,
      },
    },
  });
  assert.equal(githubProgressSettings(explicit)?.includeQuestions, true);
  // Presentation never enters either digest, so toggling it keeps a started run's binding.
  for (const config of [optedOut, explicit])
    assert.equal(factoryConfigDigest(config), factoryConfigDigest(plain));
  assert.equal(
    factoryAuthorityDigest(
      validateConfig({
        ...structuredClone(base),
        queue,
        githubManagement: { progress: { enabled: false } },
      }),
    ),
    factoryAuthorityDigest(queued),
  );
});

test("the default Project Status options are found by name, or reported missing", () => {
  const board = [
    { id: "todo", name: "Todo" },
    { id: "doing", name: "In progress" },
    { id: "done", name: "Done" },
  ];
  assert.deepEqual(discoveredStatusOptions(board), {
    planning: "doing",
    running: "doing",
    review: "doing",
    "needs-human": "doing",
    stopped: "todo",
    accepted: "done",
  });
  assert.equal(
    discoveredStatusOptions([...board, { id: "blocked", name: "Blocked" }])?.[
      "needs-human"
    ],
    "blocked",
  );
  // Without an accepted option there is no complete mapping: the gap is reported.
  assert.equal(discoveredStatusOptions(board.slice(0, 2)), undefined);
});

test("a Work Item transition comment carries structured facts and its exact binding", () => {
  const snapshotId = "3f2b8c1e-7a4d-4e5f-9b6a-1c2d3e4f5a6b";
  const configDigest = "a".repeat(64);
  const body = renderWorkItemProgress({
    repository: "example/target",
    objective: 450,
    item: { id: "world-pack-sdk", issue: 451 },
    runId: "run-1",
    snapshotId,
    configDigest,
    observedAt: "2026-10-15T05:00:00.000Z",
    status: "running",
    step: "validate",
    attempt: "129e9822-240c-4805-b914-e7b9c55f46f5",
    outage: { step: "execute", retryAt: "2026-10-15T08:10:00.000Z" },
    failure: "implementation",
    coordinator: "running",
  });
  assert.ok(
    body.startsWith(
      `<!-- factory:item-progress;objective=450;item=world-pack-sdk;run=run-1;snapshot=${snapshotId} -->\n`,
    ),
  );
  assert.match(body, /\*\*Validating\*\* · attempt 129e9822/);
  assert.match(body, /next try after 2026-10-15T08:10:00.000Z/);
  assert.match(body, /Last failure: implementation\./);
  const projection = {
    requests: [
      {
        snapshotId,
        body,
        bodyDigest: progressDigest(body),
        actorId: 7,
        observedAt: "2026-10-15T05:00:00.000Z",
        presentationDigest: "b".repeat(64),
      },
    ],
  };
  const context = {
    repository: "example/target",
    objective: 450,
    runId: "run-1",
    configDigest,
  };
  assertGitHubProgressProjection(projection, {
    ...context,
    item: { id: "world-pack-sdk", issue: 451 },
  });
  // The same comment does not validate as another item's or as the Objective's.
  assert.throws(
    () =>
      assertGitHubProgressProjection(projection, {
        ...context,
        item: { id: "world-pack-sdk", issue: 452 },
      }),
    /binding/,
  );
  assert.throws(
    () => assertGitHubProgressProjection(projection, context),
    /binding/,
  );
});
