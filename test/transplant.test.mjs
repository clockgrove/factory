import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  agentSessionContinuation,
  planningSessionInputDigest,
} from "../dist/agent-session.js";
import {
  CODEX_SOURCE_READ_CONFIG,
  createCodexHome,
} from "../dist/codex-planning-isolation.js";
import { CodexPlanningTransport } from "../dist/compiler/codex-transport.js";
import {
  renderCompilationCall,
  renderDiagnosisCall,
  renderGraphReviewCall,
  StructuredPlanningModel,
} from "../dist/compiler/model.js";
import {
  generatePlannerStructured,
  renderPlanningInstructions,
} from "../dist/compiler/planning.js";
import { structuredRequestDigest } from "../dist/compiler/transport.js";
import {
  deliveredPlanningSources,
  materializePlanningSources,
  planningSourceDirectory,
} from "../dist/compiler/source-delivery.js";
import {
  hydrateWorkerInputSources,
  planningGraphView,
  planningSources,
  reviewGraphView,
} from "../dist/compiler/sources.js";
import {
  CONTROLLER_CAPABILITIES_DIGEST,
  installedControllerCapabilities,
} from "../dist/controller-capabilities.js";
import { deliveryDescription } from "../dist/delivery/description.js";
import { transplantIndependentChange } from "../dist/delivery/transplant.js";
import { graphDigest } from "../dist/graph-amendments.js";
import { validPromptSections } from "../dist/prompt-bytes.js";
import { coverageObligations } from "../dist/qa.js";
import { resolveAutonomy } from "../dist/repair-policy.js";
import {
  gitChangeEvidenceSources,
  resultChangePacket,
} from "../dist/result-evidence.js";
import {
  renderReviewPacketChoices,
  reviewPacket,
} from "../dist/review-evidence.js";
import {
  SemanticAcceptanceFailure,
  semanticRefusalDetail,
} from "../dist/semantic-refusal.js";
import { validateWorkItem } from "../dist/validation.js";
import {
  actionableReadiness,
  diagnosisFiles,
  recordWorkFailure,
  repairEvidence,
  workRepairDiagnosisRequest,
} from "../dist/work-repair.js";

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
  }).trim();
}

test("independent prepared change is replayed on the observed integration head", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-transplant-"));
  try {
    git(root, "init", "-b", "main");
    git(root, "config", "user.name", "Fixture");
    git(root, "config", "user.email", "fixture@example.test");
    writeFileSync(join(root, "base.txt"), "base\n");
    git(root, "add", ".");
    git(root, "commit", "-m", "base");
    const base = git(root, "rev-parse", "HEAD");

    writeFileSync(join(root, "left.txt"), "left\n");
    git(root, "add", ".");
    git(root, "commit", "-m", "left");
    const integrated = git(root, "rev-parse", "HEAD");

    git(root, "checkout", "--detach", base);
    writeFileSync(join(root, "right.txt"), "right\n");
    writeFileSync(join(root, "aa-unrelated.txt"), "x".repeat(127_500));
    const failedTest =
      "// Candidate test context.\n".repeat(40) +
      'console.error("z-failing.test.mjs:7: retained candidate failure"); process.exit(1);\n';
    writeFileSync(join(root, "z-failing.test.mjs"), failedTest);
    writeFileSync(
      join(root, "large.txt"),
      "Unavailable in the bounded diagnosis.\n".repeat(3000),
    );
    git(root, "add", ".");
    git(root, "commit", "-m", "right");
    const prepared = git(root, "rev-parse", "HEAD");

    const replayed = await transplantIndependentChange(
      root,
      base,
      prepared,
      integrated,
    );
    assert.equal(git(root, "rev-parse", `${replayed.changeRef}^`), integrated);
    assert.equal(
      git(root, "rev-parse", `${replayed.changeRef}^{tree}`),
      replayed.treeSha,
    );
    assert.equal(git(root, "show", `${replayed.changeRef}:left.txt`), "left");
    assert.equal(git(root, "show", `${replayed.changeRef}:right.txt`), "right");
    const description = deliveryDescription(root, {
      item: { goal: "Add the independent right-hand note.", validation: [] },
      baseSha: integrated,
      ...replayed,
    });
    assert.match(description, /Adds <code>right\.txt<\/code>/);
    assert.doesNotMatch(description, /left\.txt/);
    assert.match(description, /receipts are unavailable/);
    // Exercise the diagnosis producer on this real replayed Git candidate and
    // fresh passing subprocess receipts; no provider response is manufactured.
    const objective =
      "Preserve the right-hand note. Validation: git diff --exit-code\n";
    const sources = [
      { path: "OBJECTIVE", content: objective },
      {
        path: "base.txt",
        content: execFileSync("git", ["-C", root, "show", `${base}:base.txt`], {
          encoding: "utf8",
        }),
      },
    ];
    const item = {
      id: "right",
      title: "Right note",
      goal: "Preserve the right-hand note",
      acceptance: [
        "The right note preserves the required content",
        "The right note keeps its final newline",
      ],
      nonGoals: ["No authority changes"],
      citations: [{ path: "OBJECTIVE" }, { path: "base.txt" }],
      dependencies: [],
      ownedPaths: [
        "right.txt",
        "large.txt",
        "aa-unrelated.txt",
        "z-failing.test.mjs",
      ],
      validation: [
        {
          command: "git diff --exit-code",
          provenance: "source-declared",
          source: "OBJECTIVE",
        },
      ],
      brief: "Implement the original note contract.",
      inputSources: sources.map(({ content, ...source }) => ({
        ...source,
        sha256: createHash("sha256").update(content).digest("hex"),
        bytes: Buffer.byteLength(content),
      })),
    };
    const graph = { objective: 1, baseSha: base, items: [item], coverage: [] };
    const validation = await validateWorkItem(
      root,
      join(root, "validation"),
      item,
      replayed.changeRef,
      replayed.treeSha,
      base,
    );
    assert.equal(validation.commands[0].exitCode, 0);
    const delta = gitChangeEvidenceSources(
      resultChangePacket(root, integrated, replayed.changeRef, 200_000).change,
      {
        path: "Exact Git change packet",
        metadata: {
          baseCommitSha: integrated,
          resultCommitSha: replayed.changeRef,
          resultTreeSha: replayed.treeSha,
        },
      },
    );
    const packet = reviewPacket(item.acceptance, [
      { ...sources[0], origin: "source" },
      ...delta.map((source) => ({ ...source, origin: "controller" })),
    ]);
    const references = packet.evidence
      .filter(
        (entry) =>
          entry.path === "OBJECTIVE" ||
          entry.path === 'Exact Git change packet file "right.txt"',
      )
      .map(({ content, reusableBody, ...reference }) => reference);
    const finding = {
      criterionId: packet.criteria[0].id,
      verdict: "refuse",
      evidenceIds: references.map((entry) => entry.id),
      detail: "The exact candidate note needs an owned correction.",
      question: "",
    };
    const refusal = {
      treeSha: replayed.treeSha,
      criterion: item.acceptance[0],
      source: "model",
      finding,
      evidence: references,
    };
    const state = {
      repository: "integration/transplant",
      objective: 1,
      runId: "real-transplant-diagnosis",
      configDigest: "retained",
      baseSha: base,
      graph,
      autonomy: resolveAutonomy({ allowances: { implementationRepairs: 1 } }),
      work: {
        right: {
          status: "failed",
          step: "validate",
          attempt: "replayed-right",
          baseSha: integrated,
          executionBaseSha: integrated,
          graphRevisionDigest: graphDigest(graph),
          ...replayed,
          validation,
        },
      },
    };
    // One review reports every refused criterion, so one repair sees them all;
    // several refusals need the full diagnosis evidence, not the focused one.
    const both = structuredClone(state);
    const refusals = {
      ...refusal,
      others: [
        {
          criterion: item.acceptance[1],
          finding: {
            ...finding,
            criterionId: packet.criteria[1].id,
            detail: "The candidate note drops its final newline.",
          },
          evidence: references,
        },
      ],
    };
    recordWorkFailure(
      both,
      item.id,
      new SemanticAcceptanceFailure(semanticRefusalDetail(refusals), refusals),
    );
    assert.match(
      both.work.right.recovery.failure.detail,
      /required content: .*\n\nAcceptance criterion disproved: The right note keeps its final newline: /s,
    );
    const bothEvidence = repairEvidence(
      both,
      item,
      diagnosisFiles(both, item, root),
    );
    assert.notEqual(
      workRepairDiagnosisRequest({
        state: both,
        item,
        evidence: bothEvidence,
        sources,
        checkout: root,
      }).workRepairDiagnosis.mode,
      "focused-semantic-refusal",
    );
    recordWorkFailure(
      state,
      item.id,
      new SemanticAcceptanceFailure(semanticRefusalDetail(refusal), refusal),
    );
    const evidence = repairEvidence(
      state,
      item,
      diagnosisFiles(state, item, root),
    );
    const before = JSON.stringify({ state, sources, evidence });
    const request = workRepairDiagnosisRequest({
      state,
      item,
      evidence,
      sources,
      checkout: root,
    });
    assert.equal(request.workRepairDiagnosis.mode, "focused-semantic-refusal");
    assert.deepEqual(request.workRepairDiagnosis.sourceIndices, [0]);
    const payload = JSON.parse(
      request.objective.slice(request.objective.lastIndexOf("\n{") + 1),
    );
    assert.deepEqual(payload.item, (({ inputSources, ...rest }) => rest)(item));
    assert.deepEqual(payload.failure, state.work.right.recovery.failure);
    assert.deepEqual(payload.repairEvidence.slice(0, 2), evidence.slice(0, 2));
    const rightIndex = evidence.findIndex(
      (entry) => entry.path === "right.txt",
    );
    const unavailableIndex = evidence.findIndex(
      (entry) => entry.path === "large.txt",
    );
    assert.equal(evidence[rightIndex].content, "right\n");
    assert.equal(evidence[unavailableIndex].complete, false);
    assert.deepEqual(payload.repairEvidence[rightIndex], evidence[rightIndex]);
    assert.equal(payload.repairEvidence[unavailableIndex].content, undefined);
    assert.equal(
      payload.repairEvidence[unavailableIndex].contentDelivery,
      "omitted",
    );
    const call = renderDiagnosisCall(request);
    assert.equal(
      validPromptSections(call.promptSections, Buffer.byteLength(call.prompt)),
      true,
    );
    assert.deepEqual(call.planningSources.suppliedSourceIndices, [0]);
    const deliveredByFocusedDiagnosis = deliveredPlanningSources(
      request.baseSha,
      request.sources,
      call.planningSources.suppliedSourceIndices,
    );
    assert.deepEqual(
      deliveredByFocusedDiagnosis.sources.map((source) => source.path),
      [request.sources[0].path],
    );
    const focusedArtifacts = mkdtempSync(
      join(tmpdir(), "factory-focused-source-artifacts-"),
    );
    try {
      const catalog = materializePlanningSources(
        planningSourceDirectory(
          focusedArtifacts,
          request.baseSha,
          request.sources,
        ),
        request.baseSha,
        request.sources,
        deliveredPlanningSources(request.baseSha, request.sources),
      );
      const referenced = renderDiagnosisCall(request, catalog);
      const sourceView = JSON.parse(
        referenced.prompt
          .split("Pinned sources:\n")[1]
          .split("\nWork Item diagnosis delivery:")[0],
      );
      assert.equal(sourceView[0].contentDelivery, "complete");
      assert.equal(sourceView[0].content, undefined);
      assert.equal(sourceView[0].contentFile.complete, true);
      assert.equal(sourceView[1].contentDelivery, "omitted");
      assert.equal(sourceView[1].content, undefined);
      assert.equal(sourceView[1].contentFile, undefined);
      assert.equal(referenced.sourcePacket, call.sourcePacket);
      assert.ok(referenced.prompt.includes('"content":"right\\n"'));
      assert.ok(
        referenced.prompt.includes(
          "Only delivered complete evidence may ground actionable output",
        ),
      );
    } finally {
      rmSync(focusedArtifacts, { recursive: true, force: true });
    }
    assert.ok(call.prompt.includes('"contentDelivery":"omitted"'));
    assert.ok(call.prompt.includes('"content":"right\\n"'));
    assert.ok(!call.prompt.includes("JavaScript string start/length"));
    assert.ok(!call.prompt.includes("what change to the plan or Objective"));
    const answer = {
      diagnosis: "Offline readiness binding check",
      correction: "Correct the owned note",
      decision: "repair",
      predecessor: "",
      path: "right.txt",
      readiness: "actionable",
      prerequisites: [],
      question: "",
      evidenceIndices: [0, 1, rightIndex],
      commandAssessments: [],
      requestedFiles: [],
    };
    const canonicalReady = actionableReadiness(
      state,
      item,
      answer,
      evidence,
      root,
    );
    assert.equal(typeof canonicalReady, "object");
    assert.deepEqual(
      actionableReadiness(
        state,
        item,
        answer,
        evidence,
        root,
        request.workRepairDiagnosis.evidenceIndices,
      ),
      canonicalReady,
    );
    assert.equal(
      typeof actionableReadiness(
        state,
        item,
        {
          ...answer,
          evidenceIndices: [...answer.evidenceIndices, unavailableIndex],
        },
        evidence,
        root,
        request.workRepairDiagnosis.evidenceIndices,
      ),
      "string",
    );
    // A file an earlier answer named is read whole beyond the candidate
    // bound, so the next ask has it instead of stopping for the operator.
    const asked = structuredClone(state);
    asked.work.right.recovery.diagnosisInvocation = {
      id: "asked-again",
      submitted: false,
      rejected: [
        {
          id: "asked-first",
          response: { ...answer, path: "large.txt", requestedFiles: [] },
        },
      ],
    };
    const askedEvidence = repairEvidence(
      asked,
      item,
      diagnosisFiles(asked, item, root),
    );
    assert.equal(askedEvidence[2].path, "large.txt");
    assert.equal(askedEvidence[2].complete, true);
    assert.equal(
      typeof actionableReadiness(
        asked,
        item,
        { ...answer, path: "large.txt", evidenceIndices: [0, 1, 2] },
        askedEvidence,
        root,
      ),
      "object",
    );
    const unmapped = structuredClone(state);
    unmapped.work.right.recovery.failure.semanticRefusal.evidence[1].path =
      'Exact Git change packet file "missing.txt"';
    // A missing mapped file must not be silently selected through refusal prose.
    assert.equal(
      workRepairDiagnosisRequest({
        state: unmapped,
        item,
        evidence,
        sources,
        checkout: root,
      }).workRepairDiagnosis.mode,
      "complete",
    );
    assert.equal(
      workRepairDiagnosisRequest({ state, item, evidence, sources })
        .workRepairDiagnosis.mode,
      "complete",
    );
    assert.throws(
      () =>
        renderDiagnosisCall({
          ...request,
          sources: [{ ...sources[0], content: "rebound" }],
        }),
      /canonical inputs/,
    );
    assert.equal(JSON.stringify({ state, sources, evidence }), before);
    // The late-listed small test fits the existing budget, but only when its
    // actual failed subprocess path precedes the unrelated 127.5 KB file.
    const commandState = structuredClone(state);
    commandState.configDigest = createHash("sha256")
      .update("retained")
      .digest("hex");
    const commandItem = commandState.graph.items[0];
    commandItem.validation = [
      { command: "node z-failing.test.mjs", provenance: "source-declared" },
    ];
    const commandWork = commandState.work.right;
    delete commandWork.recovery;
    delete commandWork.validation;
    commandWork.graphRevisionDigest = graphDigest(commandState.graph);
    let actualFailure;
    try {
      await validateWorkItem(
        root,
        join(root, "failed-validation"),
        commandItem,
        replayed.changeRef,
        replayed.treeSha,
        base,
      );
      assert.fail("The candidate test must fail");
    } catch (error) {
      actualFailure = error;
    }
    recordWorkFailure(commandState, commandItem.id, actualFailure);
    assert.equal(
      commandWork.failedValidation.evidence.commands[0].passed,
      false,
    );
    const commandEvidence = repairEvidence(
      commandState,
      commandItem,
      diagnosisFiles(commandState, commandItem, root),
    );
    assert.equal(commandEvidence[2].path, "z-failing.test.mjs");
    assert.equal(commandEvidence[2].content, failedTest);
    assert.equal(commandEvidence[2].complete, true);
    assert.equal(
      commandEvidence.find((entry) => entry.path === "aa-unrelated.txt")
        .complete,
      false,
    );
    const commandRequest = workRepairDiagnosisRequest({
      state: commandState,
      item: commandItem,
      evidence: commandEvidence,
      sources,
      checkout: root,
    });
    const commandCall = renderDiagnosisCall(commandRequest);
    assert.ok(commandCall.prompt.includes(JSON.stringify(failedTest)));
    assert.deepEqual(commandCall.schema.required, request.schema.required);
    const commandAnswer = {
      ...answer,
      path: "z-failing.test.mjs",
      evidenceIndices: [0, 1, 2],
      commandAssessments: [{ commandIndex: 0, disposition: "owned-change" }],
    };
    assert.equal(
      typeof actionableReadiness(
        commandState,
        commandItem,
        commandAnswer,
        commandEvidence,
        root,
        commandRequest.workRepairDiagnosis.evidenceIndices,
      ),
      "object",
    );
    assert.equal(
      typeof actionableReadiness(
        commandState,
        commandItem,
        { ...commandAnswer, evidenceIndices: [0, 1] },
        commandEvidence,
        root,
        commandRequest.workRepairDiagnosis.evidenceIndices,
      ),
      "string",
    );
    // Presentation cannot silently bind a different failure or candidate.
    const rebound = structuredClone(commandState);
    rebound.work.right.treeSha = "0".repeat(40);
    assert.throws(
      () => diagnosisFiles(rebound, commandItem, root),
      /capture|candidate|validation/i,
    );
    await assert.rejects(() =>
      transplantIndependentChange(root, integrated, prepared, base),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retained graph amendments render exact pinned inputs once and keep canonical definitions", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-amendment-input-"));
  const privateSources = mkdtempSync(
    join(tmpdir(), "factory-planner-source-read-"),
  );
  try {
    git(root, "init", "-b", "main");
    git(root, "config", "user.name", "Fixture");
    git(root, "config", "user.email", "fixture@example.test");
    git(
      root,
      "remote",
      "add",
      "origin",
      "https://github.com/factory-qualification/compiler-inputs.git",
    );
    const content =
      "# API\n\n" +
      readFileSync(new URL("../src/contracts.ts", import.meta.url), "utf8");
    writeFileSync(
      join(root, "contract.md"),
      content + "\n# Appendix\n\nKeep this separate source section.\n",
    );
    writeFileSync(
      join(root, "additional.txt"),
      'Literal "quotes" and Unicode λ.\n\n',
    );
    writeFileSync(
      join(root, "duplicate.txt"),
      readFileSync(join(root, "contract.md")),
    );
    writeFileSync(join(root, "empty.txt"), "");
    git(root, "add", ".");
    git(root, "commit", "-m", "pin complete public API source");
    const baseSha = git(root, "rev-parse", "HEAD");
    const body =
      "## Acceptance\n- Preserve every required interface.\n\n## Sources\n- contract.md\n- duplicate.txt\n";
    const sources = planningSources(body, baseSha, root);
    const obligations = coverageObligations(body, [
      "Preserve every required interface.",
    ]);
    const currentGraph = {
      objective: 1,
      baseSha,
      items: Array.from({ length: 40 }, (_, index) => ({
        id: `part-${index}`,
        title: `Part ${index}`,
        goal: "Preserve the complete API contract",
        acceptance: ["Preserve every required interface."],
        nonGoals: ["No provider changes"],
        citations: [{ path: "contract.md", heading: "API" }],
        dependencies: [],
        ownedPaths: [`part-${index}.ts`],
        validation: [],
        brief: "Implement the owned API consumer.",
      })),
      coverage: [
        {
          ...obligations[0],
          itemId: "part-0",
          proof: { kind: "result-semantic", acceptanceIndex: 0 },
          environment: {
            kind: "local",
            readiness: "available",
            probe: "",
            preparedBy: "",
          },
        },
      ],
      requiredPreIntegrationChecks: [
        {
          checkName: "quality",
          source: {
            path: "contract.md",
            digest: createHash("sha256")
              .update(
                sources.find((source) => source.path === "contract.md").content,
              )
              .digest("hex"),
          },
        },
      ],
    };
    hydrateWorkerInputSources(currentGraph, sources, root);
    const before = JSON.stringify(currentGraph);
    const amendment = {
      currentGraph,
      discovery: { paths: ["additional.ts"] },
      immutableItemIds: currentGraph.items.map((item) => item.id),
      reattemptItemId: "part-0",
    };
    const instructions = renderPlanningInstructions(
      body,
      sources,
      [],
      amendment,
    );
    const request = {
      objective: body,
      baseSha,
      sources,
      compileContext: {
        objectiveNumber: 1,
        instructions,
        previousGraph: currentGraph,
        immutableItemIds: amendment.immutableItemIds,
        reattemptItemId: "part-0",
      },
      coverageObligations: obligations,
      controllerCapabilities: installedControllerCapabilities(),
      controllerCapabilitiesDigest: CONTROLLER_CAPABILITIES_DIGEST,
    };
    const { wire, call } = renderCompilationCall(request);
    assert.equal(
      validPromptSections(call.promptSections, Buffer.byteLength(call.prompt)),
      true,
    );
    const sourceRoot = planningSourceDirectory(
      privateSources,
      baseSha,
      sources,
    );
    const sourceFiles = materializePlanningSources(
      sourceRoot,
      baseSha,
      sources,
      deliveredPlanningSources(baseSha, sources),
    );
    assert.ok(
      new Set(sourceFiles.files.map((file) => file.file)).size <
        sourceFiles.files.length,
    );
    const resumed = renderCompilationCall(request, sourceFiles);
    // The actual retained Git fixture keeps amendment rules, while an initial
    // request omits only instructions whose typed capabilities are absent.
    assert.match(call.prompt, /Retained amendments:/);
    assert.doesNotMatch(call.prompt, /Execution profiles:/);
    const initialRequest = {
      ...request,
      compileContext: {
        objectiveNumber: 1,
        instructions: renderPlanningInstructions(body, sources, []),
      },
    };
    const initial = renderCompilationCall(initialRequest);
    const initialFiles = renderCompilationCall(initialRequest, sourceFiles);
    assert.doesNotMatch(initial.call.prompt, /Retained amendments:/);
    assert.doesNotMatch(initial.call.prompt, /Execution profiles:/);
    assert.match(
      initial.call.prompt,
      /Assign owned paths from supplied source\/script facts/,
    );
    assert.match(
      initialFiles.call.prompt,
      /no live checkout, Git metadata or network access is available/,
    );
    assert.doesNotMatch(
      initialFiles.call.prompt,
      /You cannot read the repository/,
    );
    for (const emitted of [initial, initialFiles]) {
      // Empty input assets do not make potential media or QA output illegal.
      assert.match(emitted.call.prompt, /Media:/);
      assert.match(emitted.call.prompt, /Read-only QA has no implementation/);
      const kinds = emitted.wire.schema.properties.items.items.anyOf;
      assert.ok(kinds.some((kind) => kind.properties.kind.enum.includes("qa")));
      assert.ok(kinds.some((kind) => kind.required.includes("media")));
    }
    assert.deepEqual(initialFiles.wire.schema, initial.wire.schema);
    assert.equal(initialFiles.wire.data.contextId, initial.wire.data.contextId);
    const { validateConfig } = await import("../dist/config.js");
    const { executionProfileChoices } = await import(
      "../dist/execution-profiles.js"
    );
    const model = { model: "gpt-6.1-sol", reasoningEffort: "medium" };
    const profileConfig = validateConfig({
      schemaVersion: 1,
      repository: "factory-qualification/compiler-inputs",
      checkout: root,
      planning: { kind: "codex-sdk", planner: model, reviewer: model },
      execution: {
        kind: "local",
        concurrency: 1,
        defaultProfile: "local",
        profiles: {
          local: {
            description: "The approved local implementation profile",
            harness: { kind: "codex-sdk", ...model },
          },
        },
      },
      delivery: { kind: "regular" },
      policy: { network: "off", allowedSecretNames: [] },
    });
    const profiled = renderCompilationCall({
      ...initialRequest,
      executionProfiles: executionProfileChoices(profileConfig),
    });
    assert.match(profiled.call.prompt, /Execution profiles:/);
    for (const kind of profiled.wire.schema.properties.items.items.anyOf.filter(
      (kind) => kind.properties.kind.enum.includes("work"),
    )) {
      assert.deepEqual(kind.properties.executionProfile.properties.id.enum, [
        "local",
      ]);
    }
    assert.equal(
      validPromptSections(
        resumed.call.promptSections,
        Buffer.byteLength(resumed.call.prompt),
      ),
      true,
    );
    assert.equal(
      resumed.call.exportedEvidenceFileBytes,
      [...new Set(sourceFiles.files.map((file) => file.file))].reduce(
        (sum, file) => sum + readFileSync(join(sourceRoot, file)).byteLength,
        0,
      ),
    );
    const resumedChoices = JSON.parse(
      resumed.call.prompt.split("Compiler choices (JSON data):\n")[1],
    );
    assert.deepEqual(
      resumedChoices.sources.map((source) => source.contentFile.sourceIndex),
      sources.map((_, index) => index),
    );
    assert.equal(
      resumedChoices.sources.some((source) => Object.hasOwn(source, "lines")),
      false,
    );
    assert.deepEqual(resumed.wire.schema, wire.schema);
    assert.equal(resumed.wire.data.contextId, wire.data.contextId);
    assert.equal(resumed.call.sourcePacket, call.sourcePacket);
    assert.ok(
      Buffer.byteLength(resumed.call.prompt) <
        Buffer.byteLength(call.prompt) - 10_000,
    );
    for (const [index, source] of sources.entries()) {
      const file = sourceFiles.files[index];
      const restored = readFileSync(join(sourceRoot, file.file), "utf8");
      assert.equal(restored, source.content);
      assert.equal(file.bytes, Buffer.byteLength(source.content));
      assert.equal(file.lineCount, source.content.split("\n").length);
      assert.equal(
        file.digest,
        createHash("sha256").update(restored).digest("hex"),
      );
    }
    // Native compaction needs no transcript rewrite: missing artifact bytes hydrate
    // from the original pinned sources, while an altered existing file is refused.
    const missing = join(sourceRoot, sourceFiles.files[1].file);
    rmSync(missing);
    assert.equal(
      renderCompilationCall(request, sourceFiles).call.prompt,
      resumed.call.prompt,
    );
    rmSync(missing);
    const outsideSource = join(privateSources, "outside-source.txt");
    writeFileSync(outsideSource, sources[1].content);
    symlinkSync(outsideSource, missing);
    assert.throws(
      () => renderCompilationCall(request, sourceFiles),
      /Immutable planning source/,
    );
    rmSync(missing);
    const extra = join(sourceRoot, "pinned", "outside.txt");
    writeFileSync(extra, "noncanonical data");
    assert.throws(
      () => renderCompilationCall(request, sourceFiles),
      /noncanonical data/,
    );
    rmSync(extra);
    assert.equal(
      renderCompilationCall(request, sourceFiles).call.prompt,
      resumed.call.prompt,
    );
    assert.equal(readFileSync(missing, "utf8"), sources[1].content);
    chmodSync(missing, 0o600);
    writeFileSync(missing, "altered source bytes");
    assert.throws(
      () => renderCompilationCall(request, sourceFiles),
      /Immutable planning source/,
    );
    rmSync(missing);
    assert.equal(
      renderCompilationCall(request, sourceFiles).call.prompt,
      resumed.call.prompt,
    );
    assert.throws(
      () =>
        renderCompilationCall(request, {
          ...sourceFiles,
          baseSha: "f".repeat(40),
        }),
      /differs from complete pinned sources/,
    );
    const additional = ["additional.txt", "empty.txt"].map((path) => ({
      path,
      content: execFileSync("git", ["-C", root, "show", `${baseSha}:${path}`], {
        encoding: "utf8",
      }),
    }));
    const expanded = [...sources, ...additional];
    const expandedFiles = materializePlanningSources(
      planningSourceDirectory(privateSources, baseSha, expanded),
      baseSha,
      expanded,
      deliveredPlanningSources(baseSha, sources),
    );
    assert.deepEqual(
      expandedFiles.reusedSourceIndices,
      sourceFiles.reusedSourceIndices,
    );
    const expandedCall = renderCompilationCall(
      { ...request, sources: expanded },
      expandedFiles,
    );
    const expandedChoices = JSON.parse(
      expandedCall.call.prompt.split("Compiler choices (JSON data):\n")[1],
    );
    for (const [offset, source] of additional.entries()) {
      const file = expandedChoices.sources.at(offset - 2).contentFile;
      assert.equal(
        readFileSync(join(expandedFiles.root, file.file), "utf8"),
        source.content,
      );
    }
    assert.equal(expandedFiles.files.at(-1).bytes, 0);
    assert.equal(expandedFiles.files.at(-1).lineCount, 1);
    const rejectedGraph = structuredClone(currentGraph);
    rejectedGraph.items[0].inputSources.push({
      path: "unmatched.txt",
      heading: "",
      sha256: createHash("sha256")
        .update("An unmatched source remains its exact identity.\n")
        .digest("hex"),
      bytes: 48,
    });
    const diagnosisRequest = {
      ...request,
      purpose: "diagnosis",
      schema: { type: "object" },
      rejectedGraph,
    };
    const canonicalDiagnosis = JSON.stringify(diagnosisRequest);
    const diagnosis = renderDiagnosisCall(diagnosisRequest, sourceFiles);
    assert.ok(diagnosis.prompt.includes('"contentFile"'));
    assert.equal(
      diagnosis.sourcePacket,
      renderDiagnosisCall(diagnosisRequest).sourcePacket,
    );
    for (const delivery of [
      undefined,
      sourceFiles,
      { ...sourceFiles, reusedSourceIndices: [] },
    ]) {
      const emitted = renderDiagnosisCall(diagnosisRequest, delivery);
      const graphView = JSON.parse(
        emitted.prompt
          .split("Rejected canonical graph (null when unavailable):\n")[1]
          .split("\n")[0],
      );
      assert.deepEqual(graphView, planningGraphView(rejectedGraph, sources));
      for (const [index, item] of graphView.items.entries()) {
        const original = rejectedGraph.items[index];
        const referenced = item.inputSources[0];
        const span = referenced.sourceSpan;
        assert.equal(referenced.content, undefined);
        assert.equal(
          createHash("sha256")
            .update(
              sources[span.sourceIndex].content.slice(
                span.start,
                span.start + span.length,
              ),
            )
            .digest("hex"),
          original.inputSources[0].sha256,
        );
        assert.equal(span.contentDigest, original.inputSources[0].sha256);
        assert.deepEqual(
          { ...item, inputSources: original.inputSources },
          original,
        );
      }
      assert.deepEqual(
        graphView.items[0].inputSources.at(-1),
        rejectedGraph.items[0].inputSources.at(-1),
      );
      assert.deepEqual(
        JSON.parse(emitted.sourcePacket).rejectedGraph,
        rejectedGraph,
      );
      assert.equal(JSON.stringify(diagnosisRequest), canonicalDiagnosis);
      assert.equal(
        validPromptSections(
          emitted.promptSections,
          Buffer.byteLength(emitted.prompt),
        ),
        true,
      );
    }
    const evidence = reviewPacket(
      [],
      sources.map((source) => ({ ...source, origin: "source" })),
    );
    const review = renderGraphReviewCall({
      reviewPacket: evidence,
      objective: body,
      baseSha,
      sources,
      graph: currentGraph,
      commands: [],
      finalCommands: [],
      amendment: {
        previousGraph: currentGraph,
        proposal: amendment.discovery,
        work: {},
      },
      controllerCapabilities: installedControllerCapabilities(),
      controllerCapabilitiesDigest: CONTROLLER_CAPABILITIES_DIGEST,
    });
    for (const request of [call, review]) {
      assert.ok(
        Buffer.byteLength(request.prompt) +
          Buffer.byteLength(JSON.stringify(request.schema)) <
          1_048_576,
      );
    }
    assert.deepEqual(
      wire.data.sources.map((source) =>
        source.lines.map((line) => line.text).join("\n"),
      ),
      sources.map((source) => source.content),
    );
    // Bodies are literal blocks; the packet-local choices keep their identities.
    for (const entry of evidence.evidence)
      assert.ok(review.prompt.includes(`>>>\n${entry.content}\n<<<`));
    assert.ok(
      review.prompt.includes(
        JSON.stringify(
          JSON.parse(renderReviewPacketChoices(evidence)).evidence.map(
            (entry) => ({
              ...entry,
              content: { block: `evidence ${entry.evidenceIndex}` },
            }),
          ),
        ),
      ),
    );
    const view = planningGraphView(currentGraph, sources);
    for (const [index, item] of view.items.entries()) {
      const input = item.inputSources[0];
      const span = input.sourceSpan;
      const selected = sources[span.sourceIndex].content.slice(
        span.start,
        span.start + span.length,
      );
      assert.equal(
        createHash("sha256").update(selected).digest("hex"),
        currentGraph.items[index].inputSources[0].sha256,
      );
      assert.equal(input.heading, "API");
      assert.ok(span.length < sources[span.sourceIndex].content.length);
      assert.equal(
        createHash("sha256").update(selected).digest("hex"),
        span.contentDigest,
      );
      assert.equal(
        createHash("sha256")
          .update(sources[span.sourceIndex].content)
          .digest("hex"),
        span.sourceDigest,
      );
      assert.deepEqual(
        { ...item, inputSources: currentGraph.items[index].inputSources },
        currentGraph.items[index],
      );
    }
    assert.deepEqual(view.coverage, currentGraph.coverage);
    const choices = {
      contextId: wire.data.contextId,
      decisionRequired: null,
      requiredPreIntegrationChecks: [],
      sourceObligations: [],
      items: currentGraph.items.map((item, index) => ({
        kind: "retained",
        id: item.id,
        ...(index === 0 ? { addedOwnedPaths: ["additional.ts"] } : {}),
      })),
      coverage: [
        {
          itemId: currentGraph.items[0].id,
          proof: { kind: "result-semantic", acceptanceIndex: 0 },
          environment: {
            kind: "local",
            readiness: "available",
            probeValidationIndex: null,
            prerequisiteValidationIndices: [],
            preparedBy: "",
          },
        },
      ],
    };
    const decoded = wire.decode(choices);
    assert.deepEqual(resumed.wire.decode(choices), decoded);
    assert.deepEqual(decoded.items[0], {
      ...currentGraph.items[0],
      ownedPaths: ["part-0.ts", "additional.ts"],
    });
    assert.deepEqual(decoded.items.slice(1), currentGraph.items.slice(1));
    assert.equal(JSON.stringify(currentGraph), before);
    const wrongHeading = structuredClone(currentGraph);
    wrongHeading.items[0].inputSources[0].heading = "Appendix";
    // A body substring alone never proves the retained citation's scope.
    assert.deepEqual(
      planningGraphView(wrongHeading, sources).items[0].inputSources,
      wrongHeading.items[0].inputSources,
    );
    const unmatched = structuredClone(currentGraph);
    unmatched.items[0].inputSources[0].sha256 = "0".repeat(64);
    assert.deepEqual(
      planningGraphView(unmatched, sources).items[0].inputSources,
      unmatched.items[0].inputSources,
    );
    writeFileSync(
      join(root, "contract.md"),
      content + "\nChanged pinned requirement.\n",
    );
    git(root, "add", "contract.md");
    git(root, "commit", "-m", "change the pinned source baseline");
    const changedBase = git(root, "rev-parse", "HEAD");
    const changedSources = planningSources(body, changedBase, root);
    const changedFiles = materializePlanningSources(
      planningSourceDirectory(privateSources, changedBase, changedSources),
      changedBase,
      changedSources,
      deliveredPlanningSources(baseSha, sources),
    );
    assert.deepEqual(changedFiles.reusedSourceIndices, []);
    const changedRequest = {
      ...request,
      baseSha: changedBase,
      sources: changedSources,
      compileContext: {
        objectiveNumber: 1,
        instructions: "Plan the changed baseline.",
      },
    };
    const changedCall = renderCompilationCall(changedRequest, changedFiles);
    const changedChoices = JSON.parse(
      changedCall.call.prompt.split("Compiler choices (JSON data):\n")[1],
    );
    assert.deepEqual(
      changedChoices.sources.map((source) =>
        readFileSync(join(changedFiles.root, source.contentFile.file), "utf8"),
      ),
      changedSources.map((source) => source.content),
    );
    // A fresh default exec call exports complete files before rendering, with
    // no provider or repository access. Settlement owns their entire lifetime.
    const selection = { model: "gpt-6.1", reasoningEffort: "medium" };
    const transport = new CodexPlanningTransport(
      root,
      selection,
      selection,
      undefined,
      [],
    );
    assert.equal(transport.settings("planner").sourceArtifacts, true);
    let freshRoot;
    await transport.withSourceDelivery(request, async (delivery) => {
      freshRoot = delivery.root;
      assert.deepEqual(delivery.reusedSourceIndices, []);
      const fresh = renderCompilationCall(request, delivery);
      assert.deepEqual(fresh.wire.schema, wire.schema);
      assert.equal(fresh.call.sourcePacket, call.sourcePacket);
      const choices = JSON.parse(
        fresh.call.prompt.split("Compiler choices (JSON data):\n")[1],
      );
      assert.ok(
        choices.sources.every(
          (source) => source.contentFile && !Object.hasOwn(source, "lines"),
        ),
      );
      assert.ok(!fresh.call.prompt.includes(content));
      for (const file of delivery.files)
        assert.equal(
          readFileSync(join(delivery.root, file.file), "utf8"),
          sources[file.sourceIndex].content,
        );
    });
    assert.equal(existsSync(freshRoot), false);
    // The actual native transport rebinds that same authenticated home before
    // its already-aborted native admission. No provider or fake process runs.
    const invocation = {
      invocationId: "fresh-source-aborted",
      phase: "compile",
      ordinal: 1,
    };
    let abortedRoot;
    const abortedTurn = { response: "", ended: false };
    await assert.rejects(
      transport.withSourceDelivery(request, async (delivery) => {
        abortedRoot = delivery.root;
        const { call } = renderCompilationCall(request, delivery);
        await transport.run({
          ...call,
          invocation,
          turn: abortedTurn,
          signal: AbortSignal.abort(
            new Error("Real before-dispatch cancellation"),
          ),
        });
      }),
      /before-dispatch cancellation/,
    );
    assert.equal(abortedTurn.stopped, true);
    assert.equal(abortedTurn.nativeInvocationStarted, undefined);
    assert.equal(existsSync(abortedRoot), false);
    // Ordinary application composition supplies a private session root and a
    // controller header. It adopts the same pre-render home, then records and
    // releases the genuinely cancelled turn without reaching the provider.
    const retainedTransport = new CodexPlanningTransport(
      root,
      selection,
      selection,
      undefined,
      [],
      join(privateSources, "sessions"),
    );
    let lastCheckpoint;
    let retainedRoot;
    const header = {
      scope: {
        repository: "factory-qualification/fresh-source",
        objective: 1,
        runId: "fresh-read",
        configDigest: "f".repeat(64),
        role: "planning",
        planningInputDigest: "e".repeat(64),
      },
      identity: "fresh-planner",
      checkpoint: (ref) => {
        lastCheckpoint = ref;
      },
    };
    await assert.rejects(
      retainedTransport.withSourceDelivery(
        { ...request, session: header },
        async (delivery) => {
          retainedRoot = delivery.root;
          const { call } = renderCompilationCall(
            { ...request, session: header },
            delivery,
          );
          await retainedTransport.run({
            ...call,
            invocation,
            turn: { response: "", ended: false },
            signal: AbortSignal.abort(
              new Error("Retained before-dispatch cancellation"),
            ),
          });
        },
      ),
      /Retained before-dispatch cancellation/,
    );
    assert.equal(lastCheckpoint.status, "released");
    assert.equal(lastCheckpoint.currentTurn.resources, "settled");
    assert.equal(lastCheckpoint.data.sourceDelivery.bodyDelivery, "all-files");
    assert.equal(existsSync(retainedRoot), false);
    let refusedRoot;
    await assert.rejects(
      transport.withSourceDelivery(request, async (delivery) => {
        refusedRoot = delivery.root;
        throw new Error("Actual pre-admission refusal");
      }),
      /pre-admission refusal/,
    );
    assert.equal(existsSync(refusedRoot), false);
    const explicitInline = new CodexPlanningTransport(
      root,
      selection,
      selection,
      undefined,
      [],
      undefined,
      "exec",
      false,
    );
    await explicitInline.withSourceDelivery(request, async (delivery) =>
      assert.equal(delivery, undefined),
    );
    const toolFree = new CodexPlanningTransport(
      root,
      selection,
      selection,
      undefined,
      [],
      undefined,
      "app-server",
    );
    await toolFree.withSourceDelivery(request, async (delivery) =>
      assert.equal(delivery, undefined),
    );
    const graphRequest = {
      reviewPacket: evidence,
      objective: body,
      baseSha,
      sources,
      graph: currentGraph,
      commands: [],
      finalCommands: [],
      controllerCapabilities: installedControllerCapabilities(),
      controllerCapabilitiesDigest: CONTROLLER_CAPABILITIES_DIGEST,
    };
    let graphRoot;
    await transport.withGraphReviewFiles(evidence, async (files, directory) => {
      graphRoot = directory;
      assert.equal(files.length, evidence.evidence.length);
      const byFile = renderGraphReviewCall(graphRequest, files, directory);
      assert.deepEqual(
        byFile.schema,
        renderGraphReviewCall(graphRequest).schema,
      );
      assert.equal(
        byFile.sourcePacket,
        renderGraphReviewCall(graphRequest).sourcePacket,
      );
      assert.equal(byFile.tree, directory);
      assert.ok(!existsSync(join(directory, ".git")));
      assert.ok(!byFile.prompt.includes(content));
      for (const file of files)
        assert.equal(
          readFileSync(join(directory, file.path), "utf8"),
          evidence.evidence[file.evidenceIndex].content,
        );
      const first = files[0];
      chmodSync(join(directory, first.path), 0o600);
      writeFileSync(join(directory, first.path), "altered evidence");
      assert.throws(
        () => renderGraphReviewCall(graphRequest, files, directory),
        /differs from its canonical evidence/,
      );
    });
    assert.equal(existsSync(graphRoot), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(privateSources, { recursive: true, force: true });
  }
});

test("settled planning conversation from an earlier source-read profile gets a fresh diagnosis", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-profile-update-"));
  const sessions = mkdtempSync(join(tmpdir(), "factory-profile-sessions-"));
  try {
    git(root, "init", "-b", "main");
    git(root, "config", "user.name", "Fixture");
    git(root, "config", "user.email", "fixture@example.test");
    writeFileSync(
      join(root, "notes.md"),
      "# Notes\n\nKeep the final newline.\n",
    );
    git(root, "add", ".");
    git(root, "commit", "-m", "pin source");
    const baseSha = git(root, "rev-parse", "HEAD");
    const body =
      "## Acceptance\n- Notes keep their newline.\n\n## Sources\n- notes.md\n";
    const sources = planningSources(body, baseSha, root);
    const state = {
      schemaVersion: 18,
      kind: "preparing",
      repository: "factory-qualification/profile-update",
      objective: 1,
      runId: randomUUID(),
      configDigest: "f".repeat(64),
      baseSha,
      objectiveBodyDigest: createHash("sha256").update(body).digest("hex"),
      sourcePacketDigest: createHash("sha256")
        .update(JSON.stringify(sources))
        .digest("hex"),
      approvedPlaybookPin: null,
    };
    const selection = { model: "gpt-6.1", reasoningEffort: "medium" };
    const transport = new CodexPlanningTransport(
      root,
      selection,
      selection,
      undefined,
      [],
      sessions,
    );
    // The settled conversation was admitted before the current base
    // instructions joined the source-read profile; only that line differs.
    const legacyConfig = CODEX_SOURCE_READ_CONFIG.replace(
      /^instructions =.*\n/m,
      "",
    );
    assert.notEqual(legacyConfig, CODEX_SOURCE_READ_CONFIG);
    const legacyDigest = createHash("sha256")
      .update(
        JSON.stringify([
          selection,
          transport.adapter,
          "planner",
          "read-only",
          "never",
          legacyConfig,
          "pinned-source-read-v1",
        ]),
      )
      .digest("hex");
    const scope = {
      repository: state.repository,
      objective: 1,
      runId: state.runId,
      configDigest: state.configDigest,
      role: "planning",
      planningInputDigest: planningSessionInputDigest(state),
    };
    const identity = randomUUID();
    const legacy = {
      scope,
      adapter: transport.adapter,
      identity,
      data: {
        sessionRoot: join(resolve(sessions), identity),
        threadId: randomUUID(),
        selectionDigest: legacyDigest,
        transport: "exec",
        sourceReadProfile: "pinned-source-read-v1",
        usage: { inputTokens: 11, outputTokens: 7 },
      },
      turn: 1,
      currentTurn: {
        invocationId: "compile-before-update",
        requestDigest: "a".repeat(64),
        dispatch: "submitted",
        terminal: "completed",
        resources: "settled",
      },
      status: "ready",
    };
    const legacyHome = createCodexHome({
      root: legacy.data.sessionRoot,
      owner: createHash("sha256")
        .update(
          JSON.stringify([scope, identity, transport.adapter, legacyDigest]),
        )
        .digest("hex"),
      config: legacyConfig,
    });
    const legacyConfigPath = join(legacyHome.env.CODEX_HOME, "config.toml");
    const legacyBytes = readFileSync(legacyConfigPath);
    const key = JSON.stringify(["planning", null, scope.planningInputDigest]);
    state.agentSessions = { [key]: structuredClone(legacy) };
    const save = () => {};
    const diagnosis = (invocation) => ({
      purpose: "diagnosis",
      objective: "Classify this planning failure from the supplied sources.",
      baseSha,
      sources,
      controllerCapabilities: installedControllerCapabilities(),
      controllerCapabilitiesDigest: CONTROLLER_CAPABILITIES_DIGEST,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "diagnosis", "correction"],
        properties: {
          kind: { type: "string" },
          diagnosis: { type: "string" },
          correction: { type: "string" },
        },
      },
      invocation,
    });
    const untouched = JSON.stringify(state);
    const continuation = () =>
      agentSessionContinuation(state, "planning", undefined, save);
    // Planning continuation, unresolved turns and unauthenticated owners keep
    // refusing before any checkpoint, with a precise reason.
    assert.throws(
      () =>
        transport.sourceDelivery({
          ...diagnosis(),
          purpose: undefined,
          session: continuation(),
        }),
      /earlier source-read profile.*fresh conversation.*factory repair/,
    );
    const active = continuation();
    active.retained = {
      ...legacy,
      status: "in-flight",
      currentTurn: {
        ...legacy.currentTurn,
        terminal: undefined,
        resources: "active",
      },
    };
    assert.throws(
      () => transport.sourceDelivery({ ...diagnosis(), session: active }),
      /active, unknown or owned by another scope.*no turn is replayed/,
    );
    const foreign = continuation();
    foreign.retained = {
      ...legacy,
      data: { ...legacy.data, selectionDigest: "0".repeat(64) },
    };
    assert.throws(
      () => transport.sourceDelivery({ ...diagnosis(), session: foreign }),
      /does not match its recorded owner/,
    );
    assert.equal(JSON.stringify(state), untouched);

    // Automatic diagnosis retires the settled conversation unchanged and
    // admits a fresh one with the complete pinned sources inline. It stops at
    // the real pre-native admission, so no provider runs.
    let admitted;
    const request = diagnosis({
      invocationId: "diagnosis-after-update",
      phase: "diagnosis",
      ordinal: 0,
      beforeProviderDispatch: async () => {
        admitted = structuredClone(state);
        throw new Error("Stop before native dispatch");
      },
    });
    await assert.rejects(
      generatePlannerStructured(
        new StructuredPlanningModel(transport),
        state,
        save,
        request,
      ),
      /Stop before native dispatch/,
    );
    const fresh = admitted.agentSessions[key];
    assert.notEqual(fresh.identity, identity);
    assert.equal(fresh.turn, 1);
    assert.equal(fresh.status, "in-flight");
    assert.equal(fresh.currentTurn.dispatch, "submitted");
    assert.equal(fresh.data.sourceReadProfile, "pinned-source-read-v1");
    assert.notEqual(fresh.data.selectionDigest, legacyDigest);
    assert.equal(fresh.data.sourceDelivery, null);
    const inline = renderDiagnosisCall(request);
    assert.ok(inline.prompt.includes("Keep the final newline."));
    assert.equal(
      fresh.currentTurn.requestDigest,
      structuredRequestDigest(inline.prompt, request.schema),
    );
    const retired = [{ ...legacy, status: "unavailable" }];
    assert.deepEqual(admitted.agentSessionHistory, retired);
    assert.deepEqual(state.agentSessionHistory, retired);
    assert.equal(state.agentSessions[key].identity, fresh.identity);
    assert.equal(state.agentSessions[key].status, "released");
    assert.equal(existsSync(fresh.data.sessionRoot), false);
    assert.deepEqual(readFileSync(legacyConfigPath), legacyBytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(sessions, { recursive: true, force: true });
  }
});

test("compiler retrieves scoped immutable bodies and retains exact bounded context", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "factory-context-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { mkdirSync } = await import("node:fs");
  const { LocalContentStore } = await import("../dist/content/local.js");
  const {
    assertContextFactsResolved,
    assertHumanPlanningDependency,
    assertPlanningLookupRecord,
    assertPlanningMemoryProjection,
    assertPlanningContextPacket,
    contextMatch,
    contextDigest,
    initializeContextLookup,
    resolveContextRequests,
    retainContextPacket,
  } = await import("../dist/compiler/context.js");
  const checkout = join(root, "target");
  mkdirSync(checkout);
  git(checkout, "init", "-q");
  git(checkout, "config", "user.email", "test@example.invalid");
  git(checkout, "config", "user.name", "Factory integration");
  mkdirSync(join(checkout, "api"));
  writeFileSync(
    join(checkout, "api", "contract.txt"),
    "version one\ncomplete interface body\n",
  );
  writeFileSync(join(checkout, "secret.txt"), "outside admitted selector\n");
  const tabPath = "api/tab\tcontract.txt";
  writeFileSync(join(checkout, tabPath), "literal tab filename body\n");
  // A large Markdown file gets a heading outline in the map; fenced lines
  // are not headings.
  mkdirSync(join(checkout, "docs"));
  writeFileSync(
    join(checkout, "docs", "guide.md"),
    `# Guide\n${"body text\n".repeat(2000)}## Setup\n\`\`\`sh\n# not a heading\n\`\`\`\n${"more text\n".repeat(2000)}### Details\n`,
  );
  mkdirSync(join(checkout, "unrelated"));
  for (let index = 0; index < 500; index++)
    writeFileSync(
      join(
        checkout,
        "unrelated",
        `${String(index).padStart(4, "0")}-${"x".repeat(120)}.txt`,
      ),
      "unrelated body\n",
    );

  git(checkout, "add", ".");
  const historicalBody =
    "version zero\nhistoricalinputneedle\n" +
    "original complete historical interface detail\n".repeat(80);
  writeFileSync(join(checkout, "api", "contract.txt"), historicalBody);
  git(checkout, "add", "api/contract.txt");
  git(checkout, "commit", "-qm", "original historical context");
  const historicalBase = git(checkout, "rev-parse", "HEAD");
  writeFileSync(
    join(checkout, "api", "contract.txt"),
    "version one\ncomplete interface body\n",
  );
  git(checkout, "add", "api/contract.txt");
  git(checkout, "commit", "-qm", "immutable context baseline");
  const baseSha = git(checkout, "rev-parse", "HEAD");
  const store = new LocalContentStore(join(root, "private-content"));
  const originalBody = "version one\ncomplete interface body\n";
  const originalBlob = git(
    checkout,
    "rev-parse",
    `${baseSha}:api/contract.txt`,
  );
  const replacementBlob = execFileSync(
    "git",
    ["-C", checkout, "hash-object", "-w", "--stdin"],
    { input: "replacement body\n", encoding: "utf8" },
  ).trim();
  git(checkout, "replace", originalBlob, replacementBlob);
  const { createPlanningContextResolver } = await import(
    "../dist/compiler/context-runtime.js"
  );
  const { validateConfig, stateRoot, factoryConfigDigest } = await import(
    "../dist/config.js"
  );
  git(
    checkout,
    "remote",
    "add",
    "origin",
    "https://github.com/factory-qualification/compiler-context.git",
  );
  const enabledBody = "## Adaptive workflow\nenabled\n";
  const model = { model: "gpt-6.1-sol", reasoningEffort: "medium" };
  const config = validateConfig({
    schemaVersion: 1,
    repository: "factory-qualification/compiler-context",
    checkout,
    planning: { kind: "codex-sdk", planner: model, reviewer: model },
    execution: {
      kind: "local",
      concurrency: 1,
      harness: { kind: "codex-sdk", ...model },
    },
    delivery: { kind: "regular" },
    policy: { network: "off", allowedSecretNames: [] },
    planningContext: {
      enabled: true,
      bounds: {
        maxRounds: 3,
        maxRequestsPerRound: 4,
        maxResults: 8,
        maxBytes: 4096,
        maxElapsedMs: 5000,
        maxProviderCalls: 1,
      },
      selectors: ["api/"],
      memory: false,
    },
  });
  const runtimeInput = {
    config,
    objective: 1,
    runId: "scoped-context-integration",
    baseSha,
    objectiveBody: enabledBody,
    sources: [
      { path: "OBJECTIVE", content: enabledBody },
      { path: "api/contract.txt", content: originalBody },
    ],
    contentStore: store,
  };
  assert.equal(
    createPlanningContextResolver({
      ...runtimeInput,
      objectiveBody: "Static Objective",
    }),
    undefined,
  );
  assert.equal(
    createPlanningContextResolver({
      ...runtimeInput,
      objectiveBody: "## Adaptive workflow\ndisabled\n",
    }),
    undefined,
  );
  const { planningContext: _planningContext, ...staticConfig } = config;
  assert.throws(
    () =>
      createPlanningContextResolver({ ...runtimeInput, config: staticConfig }),
    /admit planningContext/,
  );
  const runtimeResolver = createPlanningContextResolver(runtimeInput);
  // Repository files are read with the planner's tools over the exported
  // base tree; the packet keeps only the discovery selector ceiling.
  const repositoryCeiling = runtimeResolver.catalog.find(
    (collection) => collection.id === "repository",
  );
  assert.deepEqual(repositoryCeiling.selectors, ["api/"]);
  assert.deepEqual(repositoryCeiling.operations, []);
  const initialLookup = await initializeContextLookup(runtimeResolver);
  assert.deepEqual(initialLookup.packet.automatic, []);
  assert.equal(initialLookup.providerCalls, 0);
  assert.equal(initialLookup.packet.bounds.maxProviderCalls, 1);
  const remaining = {
    maxResults: 8,
    maxBytes: 4096,
    deadlineAt: Date.now() + 5000,
  };
  const exactSource = await runtimeResolver.resolve(
    {
      id: "pinned",
      operation: "read",
      collection: "pinned-sources",
      selector: "1",
      query: "",
      required: true,
      reason: "Read the already supplied immutable interface",
    },
    remaining,
  );
  assert.equal(exactSource.disposition, "complete");
  assert.equal(exactSource.matches[0].content, originalBody);
  assert.equal(exactSource.matches[0].provenance.sourceIndex, 1);
  const memoryConfig = validateConfig({
    ...config,
    planningContext: { ...config.planningContext, memory: true },
  });
  const memoryResolver = createPlanningContextResolver({
    ...runtimeInput,
    config: memoryConfig,
  });
  const { LocalRepositoryMemory } = await import(
    "../dist/repository-memory.js"
  );
  const retainedMemory = new LocalRepositoryMemory(
    stateRoot(config.repository),
    config.repository,
  );
  const memoryAccess = {
    repository: config.repository,
    visibility: ["repository", "private"],
  };
  const sourceReference = retainedMemory
    .metadata({ access: memoryAccess, limit: 8 })
    .entries.find(
      (entry) =>
        entry.record.kind === "reference" &&
        entry.record.sources.some(
          (source) => source.path === "api/contract.txt",
        ),
    );
  assert.ok(
    sourceReference,
    "the actual supplied source reference survives in repository memory",
  );
  const retainedSource = retainedMemory.read({
    access: memoryAccess,
    id: sourceReference.binding.id,
    maxBytes: 4096,
  });
  assert.equal(retainedSource.content[0].text, originalBody);
  assert.ok(
    !memoryResolver.catalog
      .find((collection) => collection.id === "memory")
      .selectors.includes(sourceReference.binding.id),
    "already supplied source identity is excluded before ranking or body reads",
  );
  const automaticMemory = await initializeContextLookup(memoryResolver);
  assert.ok(
    automaticMemory.packet.automatic.every((result) =>
      result.matches.every(
        (match) => match.identity !== `memory:${sourceReference.binding.id}`,
      ),
    ),
    "automatic delivery does not reload an already supplied source body",
  );
  const memoryPinned = await memoryResolver.resolve(
    { ...exactSource.request, id: "memory-pinned" },
    remaining,
  );
  assert.equal(memoryPinned.disposition, "complete");
  assert.equal(memoryPinned.matches[0].content, originalBody);

  const rankedConfig = validateConfig({
    ...memoryConfig,
    planningContext: {
      ...memoryConfig.planningContext,
      bounds: {
        ...memoryConfig.planningContext.bounds,
        maxResults: 64,
        maxBytes: 131072,
        maxElapsedMs: 30000,
      },
    },
  });
  // Retain actual older Git bytes from four original observations. Their
  // immutable manifests differ, but the underlying historical body is equal.
  const { retainPlanningSourceMemory } = await import(
    "../dist/repository-memory.js"
  );
  const historyBindings = Array.from(
    { length: 4 },
    (_, index) =>
      retainPlanningSourceMemory({
        repository: config.repository,
        objective: 1,
        runId: `historical-source-observation-${index}`,
        baseSha: historicalBase,
        treeSha: git(checkout, "rev-parse", `${historicalBase}^{tree}`),
        configDigest: factoryConfigDigest(rankedConfig),
        sources: [
          {
            path: "api/contract.txt",
            heading: "",
            content: execFileSync(
              "git",
              ["-C", checkout, "show", `${historicalBase}:api/contract.txt`],
              { encoding: "utf8" },
            ),
          },
        ],
      })[0],
  );
  const historicalRecord = retainedMemory.read({
    access: memoryAccess,
    id: historyBindings[0].id,
  });
  const memoryBodies = new LocalContentStore(
    join(stateRoot(config.repository), "content"),
  );
  const difference = execFileSync(
    "git",
    ["-C", checkout, "diff", historicalBase, baseSha, "--", "api/contract.txt"],
    { encoding: "utf8" },
  );
  const differenceRef = memoryBodies.putBytes(Buffer.from(difference), {
    mediaType: "text/plain; charset=utf-8",
  });
  const correction = retainedMemory.retain({
    ...historicalRecord.record,
    kind: "diagnosed-correction",
    producer: {
      objective: 1,
      runId: "actual-source-difference",
      status: "observed-git-source-difference",
    },
    summary:
      "Adaptive workflow api interface: observed complete historical/current Git difference",
    bodies: [
      {
        role: "observed-source-difference",
        ref: differenceRef,
        availability: "retained",
      },
    ],
  });
  const dedupResolver = createPlanningContextResolver({
    ...runtimeInput,
    config: rankedConfig,
  });
  const dedupRecord = await initializeContextLookup(dedupResolver);
  const automaticResult = dedupRecord.packet.automatic.find(
    (result) => result.request.id === "automatic-relevant-memory",
  );
  assert.ok(
    automaticResult.matches.some(
      (match) => match.identity === `memory:${correction.id}`,
    ),
    "genuine source-difference observations are not suppressed with machine snapshots",
  );
  assert.ok(
    historyBindings.every(
      (binding) =>
        !automaticResult.matches.some(
          (match) => match.identity === `memory:${binding.id}`,
        ),
    ),
    "automatic context omits historical machine snapshots of the exact supplied selection",
  );
  const explicitSameQuery = await resolveContextRequests(
    dedupRecord,
    dedupResolver,
    [{ ...automaticResult.request, id: "deliberate-history-query" }],
  );
  assert.ok(
    historyBindings.every((binding) =>
      explicitSameQuery[0].matches.some(
        (match) => match.identity === `memory:${binding.id}`,
      ),
    ),
    "explicit history lookup does not reuse the filtered automatic cache",
  );
  const historicalSearch = {
    ...automaticResult.request,
    id: "automatic-relevant-memory",
    query: "historicalinputneedle",
  };
  const historyResult = await dedupResolver.resolve(historicalSearch, {
    maxResults: 8,
    maxBytes: 32768,
    deadlineAt: Date.now() + 5000,
  });
  assert.equal(historyResult.disposition, "stale");
  assert.equal(
    historyResult.matches.filter((match) =>
      historyBindings.some(
        (binding) => match.identity === `memory:${binding.id}`,
      ),
    ).length,
    4,
    "model chosen automatic ID does not change explicit retrieval semantics",
  );
  const projections = historyResult.matches.map((match) =>
    JSON.parse(match.content),
  );
  assert.equal(
    projections.filter(
      (projection) => projection.content[0].text === historicalBody,
    ).length,
    1,
  );
  assert.equal(
    projections.filter(
      (projection) => projection.content[0].reuseRef?.kind === "context-match",
    ).length,
    3,
  );
  assert.deepEqual(
    new Set(
      historyResult.matches
        .filter((match) =>
          historyBindings.some(
            (binding) => match.identity === `memory:${binding.id}`,
          ),
        )
        .map((match) => match.provenance.manifestRef.digest),
    ),
    new Set(historyBindings.map((binding) => binding.manifestRef.digest)),
    "every original manifest and its stale provenance survives projection",
  );
  assert.doesNotThrow(() => assertPlanningMemoryProjection(historyResult));
  const inlineHistoryIndex = projections.findIndex(
    (projection) => projection.content[0].text === historicalBody,
  );
  const aliasHistoryIndex = projections.findIndex(
    (projection) => projection.content[0].reuseRef,
  );
  const dangling = {
    ...historyResult,
    matches: historyResult.matches.filter(
      (_, index) => index !== inlineHistoryIndex,
    ),
  };
  assert.throws(
    () => assertPlanningMemoryProjection(dangling),
    /lacks earlier exact bytes/,
  );
  const changed = structuredClone(projections[aliasHistoryIndex]);
  changed.content[0].reuseRef.digest = "0".repeat(64);
  const wrongVersion = {
    ...historyResult,
    matches: [
      historyResult.matches[inlineHistoryIndex],
      contextMatch(
        historyResult.matches[aliasHistoryIndex].identity,
        JSON.stringify(changed),
        historyResult.matches[aliasHistoryIndex].provenance,
      ),
    ],
  };
  assert.throws(
    () => assertPlanningMemoryProjection(wrongVersion),
    /lacks earlier exact bytes/,
  );
  const exactHistory = await dedupResolver.resolve(
    {
      ...historicalSearch,
      id: "exact-history",
      operation: "read",
      selector: historyBindings[0].id,
      query: "",
    },
    { maxResults: 8, maxBytes: 32768, deadlineAt: Date.now() + 5000 },
  );
  assert.equal(exactHistory.disposition, "stale");
  assert.equal(
    JSON.parse(exactHistory.matches[0].content).content[0].text,
    historicalBody,
    "exact-ID history remains a complete standalone original body",
  );
  assert.ok(exactHistory.matches[0].provenance.gaps.length);
  assert.equal(
    retainedMemory
      .search({
        access: memoryAccess,
        query: "historicalinputneedle",
        scope: { kinds: ["reference"] },
        limit: 4,
        maxBytes: Buffer.byteLength(historicalBody),
      })
      .filter((result) => result.content[0]?.text === historicalBody).length,
    4,
    "duplicate underlying bytes consume the admitted body allowance once",
  );

  retainedMemory.retain({
    ...historicalRecord.record,
    kind: "observation",
    summary: "repeatedbodyrole",
  });
  retainedMemory.retain({
    ...historicalRecord.record,
    kind: "observation",
    summary: Array(8).fill("repeatedbodyrole").join(" "),
    bodies: [
      {
        role: "source",
        ref: historicalRecord.content[0].ref,
        availability: "retained",
      },
      {
        role: "source",
        ref: retainedSource.content[0].ref,
        availability: "retained",
      },
    ],
  });
  const repeatedRoles = await dedupResolver.resolve(
    {
      ...historicalSearch,
      id: "repeated-body-roles",
      query: "repeatedbodyrole",
    },
    { maxResults: 8, maxBytes: 32768, deadlineAt: Date.now() + 5000 },
  );
  assert.equal(repeatedRoles.matches.length, 2);
  assert.equal(JSON.parse(repeatedRoles.matches[0].content).content.length, 2);
  assert.ok(JSON.parse(repeatedRoles.matches[1].content).content[0].reuseRef);
  assert.doesNotThrow(
    () => assertPlanningMemoryProjection(repeatedRoles),
    "repeated original body roles still resolve the exact referenced digest",
  );

  // Actual mixed semantic advice retains its source grounding without repeating
  // complete bytes already supplied in this request.
  const handoff = retainedMemory.retain({
    ...sourceReference.record,
    kind: "handoff",
    authority: "advisory",
    producer: {
      objective: 1,
      runId: "observed-interface-handoff",
      status: "observed-git-source-difference",
    },
    summary:
      "mixedhandoffneedle: complete interface and observed Git difference",
    bindings: {
      ...sourceReference.record.bindings,
      environment: { configDigest: factoryConfigDigest(rankedConfig) },
    },
    bodies: [
      { role: "handoff", ref: differenceRef, availability: "retained" },
      {
        role: "source:api/contract.txt",
        ref: retainedSource.content[0].ref,
        availability: "retained",
      },
    ],
    sources: [
      {
        identity: "repository:api/contract.txt",
        complete: true,
        ref: retainedSource.content[0].ref,
      },
    ],
  });
  const mixedResolver = createPlanningContextResolver({
    ...runtimeInput,
    config: rankedConfig,
  });
  const mixed = await mixedResolver.resolve(
    { ...historicalSearch, id: "mixed-handoff", query: "mixedhandoffneedle" },
    { maxResults: 8, maxBytes: 32768, deadlineAt: Date.now() + 5000 },
  );
  assert.equal(mixed.matches.length, 1);
  const mixedProjection = JSON.parse(mixed.matches[0].content);
  assert.equal(mixedProjection.content[0].text, difference);
  assert.deepEqual(mixedProjection.content[1].reuseRef, {
    kind: "supplied-source",
    sourceIndex: 1,
    path: "api/contract.txt",
    digest: retainedSource.content[0].ref.digest,
  });
  assert.equal(
    mixed.matches[0].provenance.manifestRef.digest,
    handoff.manifestRef.digest,
  );
  assert.equal(mixedProjection.record.authority, "advisory");
  assert.doesNotThrow(() =>
    assertPlanningMemoryProjection(mixed, runtimeInput.sources),
  );
  assert.throws(
    () => assertPlanningMemoryProjection(mixed, [runtimeInput.sources[0]]),
    /exact supplied source bytes/,
  );
  assert.throws(
    () =>
      assertPlanningMemoryProjection(
        mixed,
        runtimeInput.sources.map((source) => ({
          ...source,
          content: `${source.content}changed`,
        })),
      ),
    /exact supplied source bytes/,
  );
  assert.throws(
    () =>
      assertPlanningMemoryProjection(
        mixed,
        runtimeInput.sources.map((source) => ({
          ...source,
          heading: "different literal section",
        })),
      ),
    /exact supplied source bytes/,
  );
  const { planningMemoryMatches } = await import(
    "../dist/compiler/context-runtime.js"
  );
  const originalMixed = retainedMemory.read({
    access: memoryAccess,
    id: handoff.id,
  });
  for (const incomplete of [
    { ...originalMixed.record.sources[0], complete: false },
    {
      ...originalMixed.record.sources[0],
      heading: "different literal section",
    },
    {
      ...originalMixed.record.sources[0],
      ref: {
        ...originalMixed.record.sources[0].ref,
        mediaType: "application/json",
      },
    },
  ]) {
    const matches = planningMemoryMatches(
      [
        {
          ...originalMixed,
          record: { ...originalMixed.record, sources: [incomplete] },
        },
      ],
      runtimeInput.sources,
      false,
    );
    assert.equal(
      JSON.parse(matches[0].content).content[1].text,
      originalBody,
      "incomplete or different selections cannot reuse complete supplied bytes",
    );
  }
  const exactMixed = await mixedResolver.resolve(
    {
      ...mixed.request,
      id: "standalone-handoff",
      operation: "read",
      selector: handoff.id,
      query: "",
    },
    { maxResults: 8, maxBytes: 32768, deadlineAt: Date.now() + 5000 },
  );
  assert.equal(
    JSON.parse(exactMixed.matches[0].content).content[1].text,
    originalBody,
  );
  const mixedPacket = {
    ...dedupRecord.packet,
    automatic: [mixed],
    batches: [],
  };
  assert.doesNotThrow(() =>
    assertPlanningContextPacket(mixedPacket, runtimeInput.sources),
  );
  const { planningReviewEvidence } = await import(
    "../dist/compiler/packets.js"
  );
  const reviewRequest = {
    objective: enabledBody,
    baseSha,
    sources: runtimeInput.sources,
    graph: { items: [] },
    commands: [],
    finalCommands: [],
    contextLookup: mixedPacket,
    controllerCapabilities: installedControllerCapabilities(),
    controllerCapabilitiesDigest: CONTROLLER_CAPABILITIES_DIGEST,
  };
  const mixedReviewPacket = reviewPacket(
    [],
    planningReviewEvidence(reviewRequest),
  );
  const mixedReview = renderGraphReviewCall({
    ...reviewRequest,
    reviewPacket: mixedReviewPacket,
  });
  assert.ok(
    mixedReview.prompt.includes('"pinnedSourceIndex":1,"evidenceIndex":2'),
  );
  const mixedGraph = {
    items: [
      {
        id: "selected",
        inputSources: [
          {
            path: "api/contract.txt",
            sha256: createHash("sha256").update(originalBody).digest("hex"),
            bytes: Buffer.byteLength(originalBody),
          },
        ],
      },
    ],
  };
  const reviewedView = reviewGraphView(mixedGraph, mixedReviewPacket.evidence);
  const selectedInput = reviewedView.items[0].inputSources[0];
  assert.equal(selectedInput.sourceSpan, undefined);
  assert.equal(selectedInput.evidenceSpan.evidenceIndex, 2);
  assert.equal(
    selectedInput.evidenceSpan.evidenceId,
    mixedReviewPacket.evidence[2].id,
  );
  assert.equal(selectedInput.evidenceSpan.path, "api/contract.txt");
  assert.equal(
    mixedReviewPacket.evidence[2].content.slice(
      selectedInput.evidenceSpan.start,
      selectedInput.evidenceSpan.start + selectedInput.evidenceSpan.length,
    ),
    originalBody,
  );
  assert.equal(
    planningGraphView(mixedGraph, runtimeInput.sources).items[0].inputSources[0]
      .sourceSpan.sourceIndex,
    1,
  );
  assert.throws(
    () =>
      reviewGraphView(
        mixedGraph,
        mixedReviewPacket.evidence.map((entry, index) =>
          index === 2 ? { ...entry, complete: false } : entry,
        ),
      ),
    /complete authenticated evidence/,
  );
  assert.throws(
    () =>
      reviewGraphView(
        mixedGraph,
        mixedReviewPacket.evidence.map((entry, index) =>
          index === 2 ? { ...entry, digest: "0".repeat(64) } : entry,
        ),
      ),
    /complete authenticated evidence/,
  );
  const unmatched = {
    items: [
      {
        id: "unmatched",
        inputSources: [
          { path: "missing.txt", sha256: "0".repeat(64), bytes: 22 },
        ],
      },
    ],
  };
  assert.deepEqual(
    reviewGraphView(unmatched, mixedReviewPacket.evidence),
    unmatched,
  );
  assert.throws(
    () =>
      renderGraphReviewCall({
        ...reviewRequest,
        reviewPacket: reviewPacket([], []),
      }),
    /complete source review evidence/,
  );

  const observedSource = sourceReference.record;
  const observation = (summary) => ({
    ...observedSource,
    kind: "observation",
    createdAt: new Date().toISOString(),
    summary,
    bindings: {
      ...observedSource.bindings,
      environment: { configDigest: factoryConfigDigest(rankedConfig) },
    },
  });
  const relevantSummary =
    "Adaptive workflow enabled: api interface version one, complete body; scopedretrievalneedle";
  const relevant = retainedMemory.retain(observation(relevantSummary));
  for (let index = 0; index < 66; index++)
    retainedMemory.retain(
      observation(`Observed immutable interface body, receipt ${index}`),
    );
  const rankedResolver = createPlanningContextResolver({
    ...runtimeInput,
    config: rankedConfig,
  });
  const rankedCatalog = rankedResolver.catalog.find(
    (collection) => collection.id === "memory",
  );
  assert.equal(rankedCatalog.completeness, "incomplete");
  assert.equal(rankedCatalog.selectors.length, 65);
  assert.ok(
    !rankedCatalog.selectors.includes(relevant.id),
    "the older relevant observation falls outside the newest 64 displayed manifests",
  );
  assert.ok(!rankedCatalog.selectors.includes(sourceReference.binding.id));
  const rankedRecord = await initializeContextLookup(rankedResolver);
  const relevantAutomatic = rankedRecord.packet.automatic
    .flatMap((result) => result.matches)
    .find((match) => match.identity === `memory:${relevant.id}`);
  assert.ok(
    relevantAutomatic,
    "automatic relevance ranking supplies the older exact body despite preview truncation",
  );
  assert.equal(
    JSON.parse(relevantAutomatic.content).content[0].reuseRef.sourceIndex,
    1,
  );
  assert.ok(
    rankedRecord.packet.automatic.every((result) =>
      result.matches.every(
        (match) => match.identity !== `memory:${sourceReference.binding.id}`,
      ),
    ),
  );
  const focusedSearch = {
    id: "focused-memory-search",
    operation: "search",
    collection: "memory",
    selector: "",
    query: "scopedretrievalneedle",
    required: true,
    reason: "Retrieve the exact earlier observed interface fact",
  };
  const rankedBatch = await resolveContextRequests(
    rankedRecord,
    rankedResolver,
    [
      focusedSearch,
      {
        ...focusedSearch,
        id: "absent-memory-search",
        query: "unobservedretrievalneedle",
      },
      {
        ...focusedSearch,
        id: "older-memory-read",
        operation: "read",
        selector: relevant.id,
        query: "",
      },
    ],
  );
  assert.equal(rankedBatch[0].disposition, "complete");
  assert.equal(rankedBatch[0].matches.length, 1);
  assert.equal(rankedBatch[0].matches[0].identity, `memory:${relevant.id}`);
  assert.equal(rankedBatch[1].disposition, "no-match");
  assert.equal(rankedBatch[2].disposition, "complete");
  assert.equal(
    JSON.parse(rankedBatch[2].matches[0].content).content[0].text,
    originalBody,
  );
  rankedRecord.packet.batches.push(rankedBatch);
  assert.throws(
    () => assertContextFactsResolved(rankedRecord.packet),
    /actual supplied source bytes/,
  );
  assert.doesNotThrow(() =>
    assertContextFactsResolved(rankedRecord.packet, runtimeInput.sources),
  );

  const memoryStore = new LocalContentStore(
    join(stateRoot(config.repository), "content"),
  );
  const outsideRef = memoryStore.putBytes(
    execFileSync("git", ["-C", checkout, "show", `${baseSha}:secret.txt`]),
    { mediaType: "text/plain; charset=utf-8" },
  );
  const outsideMemory = retainedMemory.retain({
    ...observation("Observed a file outside the admitted source selectors"),
    bodies: [
      { role: "observed-file", ref: outsideRef, availability: "retained" },
    ],
    sources: [
      {
        identity: "secret.txt#",
        path: "secret.txt",
        complete: true,
        ref: outsideRef,
      },
    ],
    bindings: { paths: [{ path: "secret.txt", digest: outsideRef.digest }] },
  });
  const rankedRemaining = {
    maxResults: 8,
    maxBytes: 131072,
    deadlineAt: Date.now() + 30000,
  };
  for (const selector of ["invalid-memory-identity", outsideMemory.id]) {
    const deniedMemory = await rankedResolver.resolve(
      {
        ...focusedSearch,
        id: `denied-${selector}`,
        operation: "read",
        selector,
        query: "",
      },
      rankedRemaining,
    );
    assert.equal(deniedMemory.disposition, "denied");
    assert.deepEqual(deniedMemory.matches, []);
  }

  const outside = await runtimeResolver.resolve(
    {
      id: "outside",
      operation: "read",
      collection: "repository",
      selector: "secret.txt",
      query: "",
      required: false,
      reason: "Verify scoped denial",
    },
    remaining,
  );
  assert.equal(outside.disposition, "denied");
  const required = {
    id: "contract",
    operation: "read",
    collection: "pinned-sources",
    selector: "1",
    query: "",
    required: true,
    reason: "Missing material interface body",
  };
  const resolver = runtimeResolver;
  const record = await initializeContextLookup(resolver);
  record.packet.batches.push(
    await resolveContextRequests(record, resolver, [required]),
  );
  assertContextFactsResolved(record.packet);
  assert.equal(record.packet.batches[0][0].matches[0].content, originalBody);
  writeFileSync(
    join(checkout, "api", "contract.txt"),
    "uncommitted changed body\n",
  );
  const results = await resolveContextRequests(record, resolver, [
    { ...required, id: "reused" },
    {
      ...required,
      id: "repository-read",
      collection: "repository",
      selector: "api/contract.txt",
      required: false,
    },
  ]);
  assert.match(results[0].detail, /Reused retained exact result/);
  assert.equal(results[0].matches[0].content, originalBody);
  assert.equal(results[1].disposition, "denied");
  record.packet.batches.push(results);
  record.requestDigests.push(contextDigest(results.map((r) => r.request)));
  await retainContextPacket(record, store);
  const restarted = JSON.parse(JSON.stringify(record));
  assertPlanningLookupRecord(restarted);
  const persisted = await store.open(restarted.packetRef);
  const persistedBytes = await new Response(persisted).text();
  assert.equal(persistedBytes, JSON.stringify(restarted.packet));
  await store.verify(restarted.packetRef);
  assertContextFactsResolved(restarted.packet);
  assert.throws(
    () =>
      assertHumanPlanningDependency(
        {
          kind: "human-dependency",
          dependencyKind: "unavailable-context",
          requestIds: ["contract"],
          question: "Supply the interface body",
          detail: "The body was read completely",
        },
        restarted.packet,
      ),
    /still-unresolved required lookup result/,
  );
  assert.doesNotThrow(() =>
    assertHumanPlanningDependency(
      {
        kind: "human-dependency",
        dependencyKind: "human-choice",
        requestIds: [],
        question: "Which new entries should the interface contain?",
        detail: "Choosing new entries is a human decision",
      },
      restarted.packet,
    ),
  );

  const missing = await resolveContextRequests(restarted, resolver, [
    { ...required, id: "missing-body", selector: "9" },
  ]);
  restarted.packet.batches.push(missing);
  await retainContextPacket(restarted, store);
  assert.throws(
    () => assertContextFactsResolved(restarted.packet),
    /Mandatory planning facts remain unknown/,
  );
  const expired = JSON.parse(JSON.stringify(record.packet));
  for (const result of [...expired.automatic, ...expired.batches.flat()]) {
    for (const match of result.matches)
      match.provenance.validUntil = "2000-01-01T00:00:00.000Z";
  }
  assert.throws(
    () => assertContextFactsResolved(expired),
    /Mandatory planning facts remain unknown/,
  );

  // The planner's read tree: exact base bytes from the pinned object store,
  // ignoring replace refs, GIT_DIR and the dirty worktree; a bounded map.
  const { repositoryMap, writeRepositoryTree } = await import(
    "../dist/compiler/repository-tree.js"
  );
  const readRoot = join(root, "planning-read-root");
  mkdirSync(readRoot);
  writeFileSync(join(checkout, tabPath), "dirty tab filename body\n");
  const oldGitDir = process.env.GIT_DIR;
  try {
    process.env.GIT_DIR = join(root, "unrelated-git-directory");
    writeRepositoryTree(checkout, baseSha, readRoot);
  } finally {
    if (oldGitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = oldGitDir;
  }
  assert.equal(
    readFileSync(join(readRoot, "repository", "api", "contract.txt"), "utf8"),
    originalBody,
  );
  assert.equal(
    readFileSync(join(readRoot, "repository", tabPath), "utf8"),
    "literal tab filename body\n",
  );
  assert.equal(existsSync(join(readRoot, "repository", ".git")), false);
  const map = repositoryMap(checkout, baseSha);
  assert.equal(map, repositoryMap(checkout, baseSha));
  assert.match(map, new RegExp(`Repository map at base ${baseSha}`));
  assert.match(map, /^api\/contract\.txt\t36$/m);
  assert.ok(Buffer.byteLength(map) <= 49_152 + 8192);
  assert.match(map, /more paths are not listed/);
  assert.match(
    map,
    /^docs\/guide\.md\n1\t# Guide\n2002\t## Setup\n4006\t### Details\n/m,
  );
  assert.doesNotMatch(map, /not a heading/);
});
