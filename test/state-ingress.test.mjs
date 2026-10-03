import { createHash } from "node:crypto";
import { coverageObligations } from "../dist/qa.js";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { parseFactoryState } from "../dist/state.js";
import { readState, statePath } from "../dist/state-store.js";
import { workItemReviewObservations } from "../dist/validation.js";
import { assetSelectionDigest } from "../dist/media.js";
import { CONTROLLER_CAPABILITIES_DIGEST } from "../dist/controller-capabilities.js";
import { defaultAutonomy } from "../dist/index.js";

const repository = "example/disposable";
const objective = 42;
const sha = "a".repeat(40);

function state() {
  return {
    schemaVersion: 4,
    repository,
    objective,
    runId: "run-1",
    configDigest: "b".repeat(64),
    autonomy: structuredClone(defaultAutonomy),
    baseSha: sha,
    graph: {
      objective,
      baseSha: sha,
      coverage: [
        {
          ...coverageObligations("File exists", ["File exists"])[0],
          itemId: "asset",
          proof: { kind: "final-review" },
          environment: {
            kind: "local",
            readiness: "available",
            probe: "",
            preparedBy: "",
          },
        },
      ],
      items: [
        {
          id: "asset",
          title: "Create asset",
          goal: "Create one asset",
          brief: "Use the fixture",
          acceptance: ["File exists"],
          nonGoals: ["No deployment"],
          citations: [{ path: "OBJECTIVE", heading: "Goal" }],
          dependencies: [],
          ownedPaths: ["approved/image.png"],
          resources: [],
          validation: [
            {
              command: "test -s approved/image.png",
              provenance: "source-declared",
              source: "OBJECTIVE",
            },
          ],
          sourceAssets: [],
          expectedOutputRoles: ["image"],
          minimumAssetSets: 1,
          requiredLfsRoles: [],
        },
      ],
    },
    issueByItemId: { asset: 43 },
    work: { asset: { status: "pending" } },
  };
}

function selectedLfsState() {
  const selected = state();
  const treeSha = "c".repeat(40);
  const digest = "a".repeat(64);
  const set = {
    id: "candidate-a",
    members: [
      {
        role: "image",
        destination: "approved/image.png",
        ref: { digest, bytes: 77, mediaType: "image/png" },
      },
    ],
    provenance: {
      source: "public fixture",
      rights: "public",
      visibility: "repository",
      lineage: [],
    },
    evidence: { harnessIdentity: "test", resultDigest: "e".repeat(64) },
  };
  selected.graph.items[0].requiredLfsRoles = ["image"];
  selected.work.asset = {
    status: "running",
    step: "deliver",
    baseSha: sha,
    treeSha,
    assets: [set],
    selectedAssetSet: set.id,
    selectionDigest: assetSelectionDigest(set),
    selection: {
      actor: "test",
      at: "2026-09-27T00:00:00Z",
      destinations: [{ role: "image", path: "approved/image.png", digest }],
      downstreamItems: [],
    },
    validation: {
      treeSha,
      commands: [
        {
          index: 0,
          command: "test -s approved/image.png",
          passed: true,
          exitCode: 0,
          treeSha,
        },
      ],
      selectedLfs: [
        {
          treeSha,
          destination: "approved/image.png",
          digest,
          bytes: 77,
          filter: "lfs",
        },
      ],
    },
  };
  return selected;
}

function withFinalValidation(selected) {
  selected.integratedSha = "d".repeat(40);
  selected.objectiveCommands = ["test -s approved/image.png"];
  const set = selected.work.asset.assets[0];
  selected.finalValidation = {
    criteria: [
      {
        criterion: "File exists",
        verdict: "pass",
        detail: "Fixture final acceptance",
      },
    ],
    ...structuredClone(selected.work.asset.validation),
    hydrationReceipt: {
      schemaVersion: 1,
      controllerCapabilitiesDigest: CONTROLLER_CAPABILITIES_DIGEST,
      integratedSha: selected.integratedSha,
      integratedTreeSha: selected.work.asset.treeSha,
      members: set.members.map((member) => ({
        itemId: "asset",
        setId: set.id,
        role: member.role,
        destination: member.destination,
        expectedBytes: member.ref.bytes,
        observedBytes: member.ref.bytes,
        expectedDigest: member.ref.digest,
        observedDigest: member.ref.digest,
        passed: true,
      })),
      passed: true,
    },
    passed: true,
  };
  return selected;
}

test("persisted state validates identities and graph/work keys before use", () => {
  assert.equal(
    parseFactoryState(state(), repository, objective).work.asset.status,
    "pending",
  );
  const wrongGraph = state();
  wrongGraph.graph.items[0].dependencies = ["missing"];
  assert.throws(
    () => parseFactoryState(wrongGraph, repository, objective),
    /unknown dependency/,
  );
  const wrongWork = state();
  wrongWork.work = { other: { status: "pending" } };
  assert.throws(
    () => parseFactoryState(wrongWork, repository, objective),
    /work\.asset/,
  );
  const invalidStart = state();
  invalidStart.work.asset.startedAt = "not-a-time";
  assert.throws(
    () => parseFactoryState(invalidStart, repository, objective),
    /invalid startedAt/,
  );
  const invalidExecutionBase = state();
  invalidExecutionBase.work.asset.executionBaseSha = "not-a-sha";
  assert.throws(
    () => parseFactoryState(invalidExecutionBase, repository, objective),
    /executionBaseSha must be a SHA-1/,
  );
  const invalidIntegratedStart = state();
  invalidIntegratedStart.work.asset.integratedShaAtStart = "not-a-sha";
  assert.throws(
    () => parseFactoryState(invalidIntegratedStart, repository, objective),
    /integratedShaAtStart must be a SHA-1/,
  );
  const authenticationRequired = state();
  authenticationRequired.work.asset = {
    status: "failed",
    error: "Authentication required",
    authentication: { provider: "codex", command: "codex login" },
  };
  assert.deepEqual(
    parseFactoryState(authenticationRequired, repository, objective).work.asset
      .authentication,
    { provider: "codex", command: "codex login" },
  );
  authenticationRequired.work.asset.status = "pending";
  assert.throws(
    () => parseFactoryState(authenticationRequired, repository, objective),
    /authentication request requires failed status/,
  );
});

test("schemaVersion 4 state requires ordered exact-tree command receipts", () => {
  for (const schemaVersion of [1, 2, 3]) {
    const previousVersion = state();
    previousVersion.schemaVersion = schemaVersion;
    const preserved = structuredClone(previousVersion);
    assert.throws(
      () => parseFactoryState(previousVersion, repository, objective),
      /schema version/,
    );
    assert.deepEqual(
      previousVersion,
      preserved,
      "unsupported historical state remains unchanged",
    );
  }

  const treeSha = "c".repeat(40);
  const valid = state();
  valid.work.asset = {
    status: "running",
    step: "deliver",
    baseSha: sha,
    treeSha,
    validation: {
      treeSha,
      commands: [
        {
          index: 0,
          command: "test -s approved/image.png",
          passed: true,
          exitCode: 0,
          treeSha,
        },
      ],
    },
  };
  assert.equal(
    parseFactoryState(valid, repository, objective).work.asset.validation
      .commands[0].treeSha,
    treeSha,
  );

  for (const mutate of [
    (receipt) => delete receipt.index,
    (receipt) => {
      receipt.index = 1;
    },
    (receipt) => {
      receipt.treeSha = "d".repeat(40);
    },
    (receipt) => delete receipt.exitCode,
  ]) {
    const invalid = structuredClone(valid);
    mutate(invalid.work.asset.validation.commands[0]);
    assert.throws(
      () => parseFactoryState(invalid, repository, objective),
      /not bound to the exact tree and order/,
    );
  }

  const legacyReceipt = structuredClone(valid);
  const selected = selectedLfsState();
  parseFactoryState(selected, repository, objective);
  for (const change of [
    { treeSha: "d".repeat(40) },
    { destination: "../escape" },
    { digest: "bad" },
    { bytes: -1 },
    { filter: "text" },
  ]) {
    const invalid = structuredClone(selected);
    Object.assign(invalid.work.asset.validation.selectedLfs[0], change);
    assert.throws(
      () => parseFactoryState(invalid, repository, objective),
      /Selected LFS validation evidence/,
    );
  }
  legacyReceipt.work.asset.validation.commands = [
    { command: "test -s approved/image.png", passed: true },
  ];
  assert.throws(
    () => parseFactoryState(legacyReceipt, repository, objective),
    /not bound to the exact tree and order/,
  );

  const substitutedCommand = structuredClone(valid);
  substitutedCommand.work.asset.validation.commands[0].command = "true";
  assert.throws(
    () => parseFactoryState(substitutedCommand, repository, objective),
    /validation receipts differ from declared commands/,
  );

  const mismatchedResultTree = structuredClone(valid);
  mismatchedResultTree.work.asset.treeSha = "e".repeat(40);
  assert.throws(
    () => parseFactoryState(mismatchedResultTree, repository, objective),
    /validation tree differs from result tree/,
  );
  const missingResultTree = structuredClone(valid);
  delete missingResultTree.work.asset.treeSha;
  assert.throws(
    () => parseFactoryState(missingResultTree, repository, objective),
    /validation tree differs from result tree/,
  );

  const final = state();
  final.objectiveCommands = ["test -s approved/image.png"];
  final.finalValidation = {
    criteria: [
      {
        criterion: "File exists",
        verdict: "pass",
        detail: "Fixture final acceptance",
      },
    ],
    treeSha,
    commands: [
      {
        index: 0,
        command: "test -s approved/image.png",
        passed: true,
        exitCode: 0,
        treeSha,
      },
    ],
    passed: true,
  };
  assert.equal(
    parseFactoryState(final, repository, objective).finalValidation.commands[0]
      .command,
    "test -s approved/image.png",
  );
  const substitutedFinalCommand = structuredClone(final);
  substitutedFinalCommand.finalValidation.commands[0].command = "true";
  assert.throws(
    () => parseFactoryState(substitutedFinalCommand, repository, objective),
    /Final validation receipts differ from declared Objective commands/,
  );
});

test("selected LFS item and final receipts must match selected required members", () => {
  for (const scope of ["item", "final"]) {
    const valid =
      scope === "final"
        ? withFinalValidation(selectedLfsState())
        : selectedLfsState();
    if (scope === "final") delete valid.work.asset.validation.selectedLfs;
    const receipt = (value) =>
      scope === "final" ? value.finalValidation : value.work.asset.validation;
    assert.deepEqual(parseFactoryState(valid, repository, objective), valid);
    for (const change of [
      { destination: "approved/other.png" },
      { digest: "f".repeat(64) },
      { bytes: 78 },
    ]) {
      const invalid = structuredClone(valid);
      Object.assign(receipt(invalid).selectedLfs[0], change);
      assert.throws(
        () => parseFactoryState(invalid, repository, objective),
        /Selected LFS validation evidence.*selected member/,
        `${scope}: ${JSON.stringify(change)}`,
      );
    }
    for (const missing of ["selection", "required-role"]) {
      const invalid = structuredClone(valid);
      if (missing === "selection") {
        delete invalid.work.asset.selectedAssetSet;
        delete invalid.work.asset.selectionDigest;
        delete invalid.work.asset.selection;
        if (scope === "final") delete invalid.finalValidation.hydrationReceipt;
      } else invalid.graph.items[0].requiredLfsRoles = [];
      assert.throws(
        () => parseFactoryState(invalid, repository, objective),
        /Selected LFS validation evidence.*selected member/,
        `${scope}: ${missing}`,
      );
    }
    // Older states without these optional receipts retain their existing meaning.
    delete receipt(valid).selectedLfs;
    assert.doesNotThrow(() => parseFactoryState(valid, repository, objective));
  }
});

test("item receipts may reference selected dependency or already-present sibling members", () => {
  for (const dependencies of [["asset"], []]) {
    const valid = selectedLfsState();
    valid.graph.items.push({
      ...structuredClone(valid.graph.items[0]),
      id: "consumer",
      dependencies,
      ownedPaths: ["consumer.txt"],
      requiredLfsRoles: [],
      expectedOutputRoles: [],
      minimumAssetSets: 0,
    });
    valid.issueByItemId.consumer = 44;
    valid.work.consumer = {
      status: "running",
      step: "deliver",
      baseSha: sha,
      treeSha: valid.work.asset.treeSha,
      validation: structuredClone(valid.work.asset.validation),
    };
    assert.deepEqual(parseFactoryState(valid, repository, objective), valid);
    valid.work.consumer.validation.selectedLfs[0].bytes++;
    assert.throws(
      () => parseFactoryState(valid, repository, objective),
      /Selected LFS validation evidence.*selected member/,
    );
  }
});

test("schemaVersion 4 state rejects legacy source paths and accepts explicit bindings", () => {
  const legacy = state();
  legacy.graph.items[0].sourceAssets = ["assets/source.png"];
  assert.throws(
    () => parseFactoryState(legacy, repository, objective),
    /sourceAssets are invalid/,
  );
  const bound = state();
  bound.graph.items[0].sourceAssets = [
    {
      path: "assets/source.blend",
      role: "mesh",
      mediaType: "application/x-blender",
      visibility: "repository",
    },
  ];
  assert.equal(
    parseFactoryState(bound, repository, objective).graph.items[0]
      .sourceAssets[0].role,
    "mesh",
  );
});

test("legacy attempts expose missing immutable start provenance explicitly", () => {
  const legacy = state();
  legacy.work.asset = {
    status: "running",
    step: "validate",
    attempt: "11111111-1111-4111-8111-111111111111",
    startedAt: "2026-09-24T00:00:00.000Z",
    baseSha: sha,
  };
  const parsed = parseFactoryState(legacy, repository, objective);
  const observations = JSON.parse(
    workItemReviewObservations(parsed, parsed.graph.items[0], {
      kind: "regular",
    }),
  );
  assert.equal(observations.attempts[0].executionBaseCommitSha, null);
  assert.deepEqual(observations.attempts[0].integrationAtStart, {
    recorded: false,
  });
  assert.equal(observations.attempts[0].resultCommitSha, null);
  assert.equal(observations.attempts[0].resultTreeSha, null);
});

test("review observations do not confuse a replay base with attempt provenance", () => {
  const replayed = state();
  const replayBase = "c".repeat(40);
  replayed.integratedSha = replayBase;
  replayed.graph.items[0].acceptance = [
    `asset starts at ${sha} independently of peer before either result integrates`,
  ];
  replayed.graph.items.push({
    ...structuredClone(replayed.graph.items[0]),
    id: "peer",
    title: "Create peer",
    acceptance: ["Peer exists"],
    ownedPaths: ["approved/peer.png"],
  });
  replayed.issueByItemId.peer = 44;
  replayed.work.asset = {
    status: "running",
    step: "validate",
    attempt: "11111111-1111-4111-8111-111111111111",
    startedAt: "2026-09-24T00:00:00.000Z",
    executionBaseSha: sha,
    integratedShaAtStart: null,
    baseSha: replayBase,
    changeRef: "d".repeat(40),
  };
  replayed.work.peer = {
    status: "done",
    attempt: "22222222-2222-4222-8222-222222222222",
    startedAt: "2026-09-24T00:00:00.010Z",
    executionBaseSha: sha,
    integratedShaAtStart: null,
    baseSha: sha,
    changeRef: "e".repeat(40),
    integratedSha: replayBase,
  };
  const parsed = parseFactoryState(replayed, repository, objective);
  const observations = JSON.parse(
    workItemReviewObservations(parsed, parsed.graph.items[0], {
      kind: "regular",
    }),
  );
  const attempts = Object.fromEntries(
    observations.attempts.map((attempt) => [attempt.id, attempt]),
  );
  assert.equal(observations.currentIntegratedCommitSha, replayBase);
  assert.equal(attempts.asset.executionBaseCommitSha, sha);
  assert.deepEqual(attempts.asset.integrationAtStart, {
    recorded: true,
    integratedCommitSha: null,
  });
  assert.equal(attempts.asset.integratedCommitSha, null);
  assert.equal(attempts.asset.resultCommitSha, "d".repeat(40));
  assert.equal(attempts.asset.resultTreeSha, null);
  assert.equal(attempts.peer.executionBaseCommitSha, sha);
  assert.deepEqual(attempts.peer.integrationAtStart, {
    recorded: true,
    integratedCommitSha: null,
  });
  assert.equal(attempts.peer.integratedCommitSha, replayBase);
  assert.equal(attempts.peer.resultCommitSha, "e".repeat(40));
  assert.equal(attempts.peer.resultTreeSha, null);
  assert.ok(!("baseSha" in attempts.asset));
});

test("review observations expose the exact dependency result head", () => {
  const predecessor = state();
  const predecessorHead = "f".repeat(40);
  predecessor.graph.items[0].dependencies = ["foundation"];
  predecessor.graph.items[0].acceptance = [
    "asset uses foundation as its exact predecessor base",
  ];
  predecessor.graph.items.unshift({
    ...structuredClone(predecessor.graph.items[0]),
    id: "foundation",
    title: "Create foundation",
    acceptance: ["Foundation exists"],
    dependencies: [],
    ownedPaths: ["approved/foundation.txt"],
  });
  predecessor.graph.items.push({
    ...structuredClone(predecessor.graph.items[0]),
    id: "unrelated",
    title: "Create unrelated",
    acceptance: ["Unrelated exists"],
    dependencies: [],
    ownedPaths: ["approved/unrelated.txt"],
  });
  predecessor.issueByItemId = { foundation: 43, asset: 44, unrelated: 45 };
  predecessor.work = {
    foundation: {
      status: "published",
      attempt: "11111111-1111-4111-8111-111111111111",
      startedAt: "2026-09-24T00:00:00.000Z",
      executionBaseSha: sha,
      integratedShaAtStart: null,
      baseSha: sha,
      changeRef: predecessorHead,
      pullRequest: 46,
    },
    asset: {
      status: "running",
      step: "validate",
      attempt: "22222222-2222-4222-8222-222222222222",
      startedAt: "2026-09-24T00:00:01.000Z",
      executionBaseSha: predecessorHead,
      integratedShaAtStart: null,
      baseSha: predecessorHead,
      changeRef: "1".repeat(40),
    },
    unrelated: { status: "pending" },
  };
  const parsed = parseFactoryState(predecessor, repository, objective);
  const reviewed = parsed.graph.items.find((item) => item.id === "asset");
  const observations = JSON.parse(
    workItemReviewObservations(parsed, reviewed, {
      kind: "native-stack",
      unitId: "foundation",
      layerNumber: 2,
      layerCount: 2,
      predecessorItemId: "foundation",
    }),
  );
  const attempts = Object.fromEntries(
    observations.attempts.map((attempt) => [attempt.id, attempt]),
  );
  assert.deepEqual(Object.keys(attempts).sort(), ["asset", "foundation"]);
  assert.equal(attempts.foundation.resultCommitSha, predecessorHead);
  assert.equal(attempts.foundation.resultTreeSha, null);
  assert.equal(attempts.asset.executionBaseCommitSha, predecessorHead);
  assert.ok(!("baseSha" in attempts.asset));
});

test("review observations expose declared ownership and resources for named peers", () => {
  const concurrent = state();
  concurrent.graph.items[0].id = "rc-lfs-policy";
  concurrent.graph.coverage[0].itemId = "rc-lfs-policy";
  concurrent.graph.items[0].title = "Verify LFS policy";
  concurrent.graph.items[0].acceptance = [
    "rc-lfs-policy may run in parallel with rc-stack-foundation because their ownership and resources are disjoint",
  ];
  concurrent.graph.items[0].ownedPaths = [".gitattributes"];
  concurrent.graph.items[0].resources = ["git-lfs-policy"];
  concurrent.graph.items.push({
    ...structuredClone(concurrent.graph.items[0]),
    id: "rc-stack-foundation",
    title: "Build stack foundation",
    acceptance: ["Foundation exists"],
    ownedPaths: ["stack/foundation.txt"],
    resources: ["stack-foundation"],
  });
  concurrent.graph.items.push({
    ...structuredClone(concurrent.graph.items[0]),
    id: "unrelated",
    title: "Unrelated",
    acceptance: ["Unrelated exists"],
    ownedPaths: ["unrelated.txt"],
    resources: ["unrelated-resource"],
  });
  concurrent.issueByItemId = {
    "rc-lfs-policy": 43,
    "rc-stack-foundation": 44,
    unrelated: 45,
  };
  concurrent.work = {
    "rc-lfs-policy": { status: "pending" },
    "rc-stack-foundation": { status: "pending" },
    unrelated: { status: "pending" },
  };
  const parsed = parseFactoryState(concurrent, repository, objective);
  const observations = JSON.parse(
    workItemReviewObservations(parsed, parsed.graph.items[0], {
      kind: "regular",
    }),
  );
  const attempts = Object.fromEntries(
    observations.attempts.map((attempt) => [attempt.id, attempt]),
  );
  assert.deepEqual(Object.keys(attempts).sort(), [
    "rc-lfs-policy",
    "rc-stack-foundation",
  ]);
  assert.deepEqual(attempts["rc-lfs-policy"].ownedPaths, [".gitattributes"]);
  assert.deepEqual(attempts["rc-lfs-policy"].resources, ["git-lfs-policy"]);
  assert.deepEqual(attempts["rc-stack-foundation"].ownedPaths, [
    "stack/foundation.txt",
  ]);
  assert.deepEqual(attempts["rc-stack-foundation"].resources, [
    "stack-foundation",
  ]);
});

test("regular and native review observations expose validated capture and CLI selection receipts", () => {
  const selected = state();
  selected.graph.items[0].acceptance = [
    "Factory captures a complete candidate under .factory-media from .factory-assets.json and an operator selects it through the installed CLI.",
  ];
  const digest = "d".repeat(64);
  const set = {
    id: "candidate-a",
    inputs: [
      {
        binding: {
          kind: "repository",
          path: "assets/source.png",
          role: "image",
          mediaType: "image/png",
          visibility: "repository",
        },
        ref: { digest, bytes: 77, mediaType: "image/png" },
      },
      {
        binding: {
          kind: "repository",
          path: "assets/source.json",
          role: "metadata",
          mediaType: "application/json",
          visibility: "repository",
        },
        ref: {
          digest: "a".repeat(64),
          bytes: 12,
          mediaType: "application/json",
        },
      },
    ],
    members: [
      {
        role: "image",
        ref: { digest, bytes: 77, mediaType: "image/png" },
        destination: "approved/image.png",
      },
    ],
    provenance: {
      source: "assets/source.png",
      rights: "public fixture",
      visibility: "repository",
      lineage: ["assets/source.png"],
    },
    evidence: {
      harnessIdentity: "thread-1",
      resultDigest: "e".repeat(64),
    },
    capture: {
      authority: "factory-controller",
      declarationPath: ".factory-assets.json",
      declarationDigest: "f".repeat(64),
      declarationProvenance: {
        source: "assets/source.png",
        rights: "public fixture",
        visibility: "repository",
        lineage: ["assets/source.png"],
      },
      mediaRoot: ".factory-media",
      complete: true,
      setId: "candidate-a",
      inputs: [
        {
          binding: {
            kind: "repository",
            path: "assets/source.png",
            role: "image",
            mediaType: "image/png",
            visibility: "repository",
          },
          ref: { digest, bytes: 77, mediaType: "image/png" },
        },
        {
          binding: {
            kind: "repository",
            path: "assets/source.json",
            role: "metadata",
            mediaType: "application/json",
            visibility: "repository",
          },
          ref: {
            digest: "a".repeat(64),
            bytes: 12,
            mediaType: "application/json",
          },
        },
      ],
      members: [
        {
          role: "image",
          stagingPath: ".factory-media/candidate-a/source.png",
          destination: "approved/image.png",
          digest,
          bytes: 77,
          mediaType: "image/png",
        },
      ],
    },
  };
  selected.graph.items[0].sourceAssets = set.inputs.map((input) =>
    structuredClone(input.binding),
  );
  selected.work.asset = {
    status: "running",
    step: "validate",
    attempt: "11111111-1111-4111-8111-111111111111",
    startedAt: "2026-09-25T00:00:00.000Z",
    executionBaseSha: sha,
    integratedShaAtStart: null,
    baseSha: sha,
    changeRef: "c".repeat(40),
    treeSha: "d".repeat(40),
    assets: [set],
    selectedAssetSet: set.id,
    selectionDigest: assetSelectionDigest(set),
    selection: {
      actor: "test-operator",
      at: "2026-09-25T00:01:00.000Z",
      reason: "reviewed exact candidate",
      surface: "factory-cli",
      destinations: [{ role: "image", path: "approved/image.png", digest }],
      downstreamItems: [],
    },
  };
  const parsed = parseFactoryState(selected, repository, objective);
  const item = parsed.graph.items[0];
  const asset = parsed.work.asset.assets[0];
  const regular = JSON.parse(
    workItemReviewObservations(parsed, item, { kind: "regular" }, asset),
  );
  const native = JSON.parse(
    workItemReviewObservations(
      parsed,
      item,
      {
        kind: "native-stack",
        unitId: "media",
        layerNumber: 1,
        layerCount: 1,
        predecessorItemId: null,
      },
      asset,
    ),
  );
  assert.deepEqual(regular.assetCaptureReceipts, [set.capture]);
  assert.deepEqual(native.assetCaptureReceipts, regular.assetCaptureReceipts);
  assert.equal(regular.assetSelectionReceipt.authority, "factory-controller");
  assert.equal(regular.assetSelectionReceipt.surface, "factory-cli");
  assert.equal(regular.assetSelectionReceipt.setId, "candidate-a");
  assert.equal(
    regular.assetSelectionReceipt.selectionDigest,
    assetSelectionDigest(set),
  );
  assert.deepEqual(native.assetSelectionReceipt, regular.assetSelectionReceipt);

  const injected = structuredClone(selected);
  injected.work.asset.selection.authority = "harness";
  injected.work.asset.selection.setId = "candidate-z";
  injected.work.asset.selection.selectionDigest = "0".repeat(64);
  injected.work.asset.assets[0].claimedControllerReview = true;
  injected.work.asset.assets[0].members[0].claimedControllerReview = true;
  injected.work.asset.assets[0].inputs[0].binding.claimedControllerReview = true;
  injected.work.asset.assets[0].provenance.claimedControllerReview = true;
  injected.work.asset.assets[0].provenance.claimedAuthority = true;
  injected.work.asset.assets[0].evidence.claimedControllerReview = true;
  injected.work.asset.assets[0].capture.claimedCliOrigin = true;
  injected.work.asset.assets[0].capture.members[0].claimedCliOrigin = true;
  injected.work.asset.selectionDigest = assetSelectionDigest(
    injected.work.asset.assets[0],
  );
  const parsedInjected = parseFactoryState(injected, repository, objective);
  const injectedObservations = JSON.parse(
    workItemReviewObservations(
      parsedInjected,
      parsedInjected.graph.items[0],
      { kind: "regular" },
      parsedInjected.work.asset.assets[0],
    ),
  );
  const injectedReceipt = injectedObservations.assetSelectionReceipt;
  assert.equal(injectedReceipt.authority, "factory-controller");
  assert.equal(injectedReceipt.setId, "candidate-a");
  assert.equal(
    injectedReceipt.selectionDigest,
    assetSelectionDigest(parsedInjected.work.asset.assets[0]),
  );
  assert.notEqual(injectedReceipt.selectionDigest, "0".repeat(64));
  assert.equal("claimedAuthority" in injectedReceipt.destinations[0], false);
  assert.equal(
    "claimedCliOrigin" in injectedObservations.assetCaptureReceipts[0],
    false,
  );
  assert.equal(
    "claimedAuthority" in
      injectedObservations.assetCaptureReceipts[0].declarationProvenance,
    false,
  );
  assert.equal(
    "claimedCliOrigin" in
      injectedObservations.assetCaptureReceipts[0].members[0],
    false,
  );
  assert.equal(
    "claimedCliOrigin" in injectedObservations.selectedAsset.capture,
    false,
  );
  assert.equal(
    "claimedControllerReview" in injectedObservations.selectedAsset,
    false,
  );
  assert.equal(
    "claimedControllerReview" in injectedObservations.selectedAsset.members[0],
    false,
  );
  assert.equal(
    "claimedControllerReview" in
      injectedObservations.selectedAsset.inputs[0].binding,
    false,
  );
  assert.equal(
    "claimedControllerReview" in injectedObservations.selectedAsset.provenance,
    false,
  );
  assert.equal(
    "claimedControllerReview" in injectedObservations.selectedAsset.evidence,
    false,
  );

  const injectedDestination = structuredClone(selected);
  injectedDestination.work.asset.selection.destinations[0].claimedAuthority =
    "harness";
  assert.throws(
    () => parseFactoryState(injectedDestination, repository, objective),
    /selection destinations differ/,
  );
  const projectedDestination = JSON.parse(
    workItemReviewObservations(
      injectedDestination,
      injectedDestination.graph.items[0],
      { kind: "regular" },
      injectedDestination.work.asset.assets[0],
    ),
  ).assetSelectionReceipt.destinations[0];
  assert.equal("claimedAuthority" in projectedDestination, false);

  const missing = structuredClone(selected);
  delete missing.work.asset.assets[0].capture;
  missing.work.asset.selectionDigest = assetSelectionDigest(
    missing.work.asset.assets[0],
  );
  const legacy = parseFactoryState(missing, repository, objective);
  assert.deepEqual(
    JSON.parse(
      workItemReviewObservations(
        legacy,
        legacy.graph.items[0],
        { kind: "regular" },
        legacy.work.asset.assets[0],
      ),
    ).assetCaptureReceipts,
    [null],
  );

  const forged = structuredClone(selected);
  forged.work.asset.assets[0].capture.members[0].stagingPath = "elsewhere.png";
  assert.throws(
    () => parseFactoryState(forged, repository, objective),
    /capture receipt differs/,
  );
  const inputReceiptMutations = [
    (candidate) => delete candidate.capture.inputs,
    (candidate) => (candidate.capture.inputs[0].ref.digest = "0".repeat(64)),
    (candidate) => (candidate.capture.inputs[0].ref.bytes = 76),
    (candidate) =>
      (candidate.capture.inputs[0].ref.mediaType = "application/octet-stream"),
    (candidate) =>
      (candidate.capture.inputs[0].binding.path = "assets/other.png"),
    (candidate) => candidate.capture.inputs.reverse(),
    (candidate) => (candidate.capture.inputs[0].claimedAuthority = true),
  ];
  for (const mutate of inputReceiptMutations) {
    const candidate = structuredClone(selected.work.asset.assets[0]);
    mutate(candidate);
    const tampered = structuredClone(selected);
    tampered.work.asset.assets[0] = candidate;
    assert.throws(
      () => parseFactoryState(tampered, repository, objective),
      /input receipt differs/,
    );
  }
  const crossSet = structuredClone(selected);
  const secondSet = structuredClone(set);
  secondSet.id = "candidate-b";
  secondSet.capture.setId = "candidate-b";
  secondSet.inputs[0].ref.digest = "0".repeat(64);
  secondSet.capture.inputs[0].ref.digest = "0".repeat(64);
  crossSet.work.asset.assets.push(secondSet);
  assert.throws(
    () => parseFactoryState(crossSet, repository, objective),
    /inputs differ across candidate sets/,
  );
  const reboundInput = structuredClone(selected);
  reboundInput.work.asset.assets[0].inputs[0].binding.path = "assets/other.png";
  reboundInput.work.asset.assets[0].capture.inputs[0].binding.path =
    "assets/other.png";
  assert.throws(
    () => parseFactoryState(reboundInput, repository, objective),
    /inputs differ from accepted source bindings/,
  );
  const partialDeclaration = structuredClone(selected);
  delete partialDeclaration.work.asset.assets[0].capture.declarationDigest;
  assert.throws(
    () => parseFactoryState(partialDeclaration, repository, objective),
    /declaration receipt is invalid/,
  );
  const mismatchedDeclaration = structuredClone(selected);
  mismatchedDeclaration.work.asset.assets[0].capture.declarationProvenance.source =
    "different/source.png";
  assert.throws(
    () => parseFactoryState(mismatchedDeclaration, repository, objective),
    /declaration receipt is invalid/,
  );
  const unrecognizedDeclaration = structuredClone(selected);
  unrecognizedDeclaration.work.asset.assets[0].capture.declarationProvenance.claimedAuthority = true;
  assert.throws(
    () => parseFactoryState(unrecognizedDeclaration, repository, objective),
    /declaration receipt is invalid/,
  );
  const wrongSurface = structuredClone(selected);
  wrongSurface.work.asset.selection.surface = "browser";
  assert.throws(
    () => parseFactoryState(wrongSurface, repository, objective),
    /Selection surface is invalid/,
  );
});

test("completed replayed item can retain its original worker base in legacy state", () => {
  const completed = state();
  completed.work.asset = {
    status: "done",
    baseSha: "c".repeat(40),
    execution: {
      provider: "local",
      identity: "attempt-1",
      data: {
        request: { item: { id: "asset" }, baseSha: sha },
        adapterIdentity: "scripted-test@1",
        handle: {
          identity: "worker-1",
          data: { pid: 123, startTime: "1", resultPath: "/tmp/result" },
        },
        worktree: "/tmp/worktree",
      },
    },
  };
  assert.equal(
    parseFactoryState(completed, repository, objective).work.asset.status,
    "done",
  );
  completed.work.asset.status = "running";
  completed.work.asset.step = "validate";
  assert.throws(
    () => parseFactoryState(completed, repository, objective),
    /active attempt handle is invalid/,
  );
});

test("persisted asset and active harness identities fail closed", () => {
  const waiting = state();
  waiting.work.asset = {
    status: "waiting",
    step: "approve-asset",
    assets: [
      {
        id: "candidate-a",
        provenance: {
          source: "source.png",
          rights: "fixture",
          visibility: "repository",
          lineage: ["source.png"],
        },
        evidence: { harnessIdentity: "thread-1", resultDigest: "c".repeat(64) },
        members: [
          {
            role: "image",
            destination: "approved/image.png",
            ref: { digest: "not-a-digest", bytes: 100, mediaType: "image/png" },
          },
        ],
      },
    ],
  };
  assert.throws(
    () => parseFactoryState(waiting, repository, objective),
    /content digest/,
  );
  const running = state();
  running.work.asset = {
    status: "running",
    step: "execute",
    baseSha: sha,
    execution: {
      provider: "local",
      identity: "attempt-1",
      data: {
        request: { item: { id: "asset" }, baseSha: sha },
        adapterIdentity: "scripted-test@1",
        handle: {
          identity: "",
          data: { pid: "bad", startTime: "1", resultPath: "/tmp/result" },
        },
        worktree: "/tmp/worktree",
      },
    },
  };
  assert.throws(
    () => parseFactoryState(running, repository, objective),
    /active attempt handle/,
  );
  running.work.asset.execution.data.handle = {
    identity: "worker-1",
    data: "opaque-json-handle",
  };
  assert.equal(
    parseFactoryState(running, repository, objective).work.asset.execution.data
      .handle.data,
    "opaque-json-handle",
  );
  const missingAdapter = structuredClone(running);
  delete missingAdapter.work.asset.execution.data.adapterIdentity;
  assert.throws(
    () => parseFactoryState(missingAdapter, repository, objective),
    /active attempt handle is invalid/,
  );
});

test("state ingress rejects an attempt handle pointing outside Factory state", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-state-ingress-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = root;
  try {
    const value = state();
    value.work.asset = {
      status: "running",
      step: "execute",
      baseSha: sha,
      execution: {
        provider: "local",
        identity: "attempt-1",
        data: {
          request: { item: { id: "asset" }, baseSha: sha },
          adapterIdentity: "scripted-test@1",
          worktree: "/tmp/foreign-worktree",
          handle: {
            identity: "worker-1",
            data: {
              pid: 123,
              startTime: "1",
              requestPath: "/tmp/request",
              resultPath: "/tmp/result",
              logPath: "/tmp/log",
            },
          },
        },
      },
    };
    const path = statePath(repository, objective);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value));
    assert.throws(
      () => readState(repository, objective),
      /outside Factory state/,
    );
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("retained discovery review binds current attempt and result, omitting absent or stale captures", () => {
  const captured = state();
  captured.work.asset = {
    status: "running",
    step: "validate",
    attempt: "11111111-1111-4111-8111-111111111111",
    baseSha: sha,
    executionBaseSha: sha,
    changeRef: "c".repeat(40),
    treeSha: "d".repeat(40),
    discovery: {
      attempt: "11111111-1111-4111-8111-111111111111",
      scope: "backlog",
      reason: "Observed independent verification gap",
      evidence: ["Exact worker observation"],
      ownership: ["read-only verification"],
      acceptance: ["Requested independent semantic check"],
      dependencies: ["predecessor"],
    },
  };
  const parsed = parseFactoryState(
    JSON.parse(JSON.stringify(captured)),
    repository,
    objective,
  );
  for (const delivery of [
    { kind: "regular" },
    {
      kind: "native-stack",
      unitId: "asset",
      layerNumber: 1,
      layerCount: 1,
      predecessorItemId: null,
    },
  ]) {
    const observation = () =>
      JSON.parse(
        workItemReviewObservations(parsed, parsed.graph.items[0], delivery),
      ).harnessDiscovery;
    const discovery = observation();
    assert.equal(discovery.attemptId, parsed.work.asset.attempt);
    assert.equal(discovery.resultCommitSha, parsed.work.asset.changeRef);
    assert.equal(discovery.resultTreeSha, parsed.work.asset.treeSha);
    assert.equal(discovery.contentOrigin, "harness-declared-proposal");
    const { attempt, ...proposal } = parsed.work.asset.discovery;
    assert.deepEqual(discovery.proposal, proposal);
    parsed.work.asset.discovery.attempt =
      "22222222-2222-4222-8222-222222222222";
    assert.equal(observation(), null);
    parsed.work.asset.discovery.attempt = attempt;
    const tree = parsed.work.asset.treeSha;
    delete parsed.work.asset.treeSha;
    assert.equal(observation(), null);
    parsed.work.asset.treeSha = tree;
  }
  delete parsed.work.asset.discovery;
  assert.equal(
    JSON.parse(
      workItemReviewObservations(parsed, parsed.graph.items[0], {
        kind: "regular",
      }),
    ).harnessDiscovery,
    null,
  );
});

for (const scope of ["work", "final"])
  test(`${scope} validation ingress rejects malformed or mismatched positive worktree observations`, () => {
    const valid =
      scope === "final"
        ? withFinalValidation(selectedLfsState())
        : selectedLfsState();
    const receipt = (value) =>
      scope === "final" ? value.finalValidation : value.work.asset.validation;
    receipt(valid).worktreeObservation = {
      treeSha: receipt(valid).treeSha,
      initialStatus: "clean",
      postHydrationStatus: {
        porcelainSha256: createHash("sha256").update("").digest("hex"),
        empty: true,
      },
      postCommandStatus: "unchanged",
      selectedLfsMembers: 1,
      subprocessOwnership: "settled",
    };
    assert.doesNotThrow(() => parseFactoryState(valid, repository, objective));
    for (const mutate of [
      (observation) => {
        observation.treeSha = "0".repeat(40);
      },
      (observation) => {
        observation.initialStatus = "dirty";
      },
      (observation) => {
        observation.postCommandStatus = "changed";
      },
      (observation) => {
        observation.subprocessOwnership = "unknown";
      },
      (observation) => {
        observation.selectedLfsMembers = 0;
      },
      (observation) => {
        observation.postHydrationStatus.empty = false;
      },
      (observation) => {
        observation.extraClaim = true;
      },
      (observation) => {
        observation.postHydrationStatus.extraClaim = true;
      },
    ]) {
      const invalid = structuredClone(valid);
      mutate(receipt(invalid).worktreeObservation);
      assert.throws(
        () => parseFactoryState(invalid, repository, objective),
        /canonical exact-tree evidence/,
      );
    }
    const hydrated = structuredClone(valid);
    receipt(hydrated).worktreeObservation.postHydrationStatus = {
      porcelainSha256: createHash("sha256")
        .update(" M approved/image.png\n")
        .digest("hex"),
      empty: false,
    };
    assert.doesNotThrow(() =>
      parseFactoryState(hydrated, repository, objective),
    );
    for (const digest of [
      [
        receipt(hydrated).worktreeObservation.postHydrationStatus
          .porcelainSha256,
      ],
      1,
      null,
      {},
    ]) {
      const invalid = structuredClone(hydrated);
      receipt(invalid).worktreeObservation.postHydrationStatus.porcelainSha256 =
        digest;
      assert.throws(
        () => parseFactoryState(invalid, repository, objective),
        /canonical exact-tree evidence/,
      );
    }
    delete receipt(valid).worktreeObservation;
    assert.equal(
      receipt(parseFactoryState(valid, repository, objective))
        .worktreeObservation,
      undefined,
    );
  });
