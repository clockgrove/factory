import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  renderCompilationCall,
  renderDiagnosisCall,
  renderGraphReviewCall,
} from "../dist/compiler/model.js";
import { renderPlanningInstructions } from "../dist/compiler/planning.js";
import {
  hydrateWorkerInputSources,
  planningGraphView,
  planningSources,
} from "../dist/compiler/sources.js";
import {
  CONTROLLER_CAPABILITIES_DIGEST,
  installedControllerCapabilities,
} from "../dist/controller-capabilities.js";
import { deliveryDescription } from "../dist/delivery/description.js";
import { transplantIndependentChange } from "../dist/delivery/transplant.js";
import { coverageObligations } from "../dist/qa.js";
import {
  renderReviewPacketChoices,
  reviewPacket,
} from "../dist/review-evidence.js";
import { graphDigest } from "../dist/graph-amendments.js";
import { resolveAutonomy } from "../dist/repair-policy.js";
import {
  gitChangeEvidenceSources,
  resultChangePacket,
} from "../dist/result-evidence.js";
import { SemanticAcceptanceFailure } from "../dist/semantic-refusal.js";
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
      acceptance: ["The right note preserves the required content"],
      nonGoals: ["No authority changes"],
      citations: [{ path: "OBJECTIVE" }, { path: "base.txt" }],
      dependencies: [],
      ownedPaths: ["right.txt", "large.txt"],
      validation: [
        {
          command: "git diff --exit-code",
          provenance: "source-declared",
          source: "OBJECTIVE",
        },
      ],
      brief: "Implement the original note contract.",
      inputSources: sources,
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
    recordWorkFailure(
      state,
      item.id,
      new SemanticAcceptanceFailure(
        `Acceptance criterion disproved: ${item.acceptance[0]}: ${finding.detail}`,
        {
          treeSha: replayed.treeSha,
          criterion: item.acceptance[0],
          source: "model",
          finding,
          evidence: references,
        },
      ),
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
    await assert.rejects(() =>
      transplantIndependentChange(root, integrated, prepared, base),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retained graph amendments render exact pinned inputs once and keep canonical definitions", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-amendment-input-"));
  try {
    git(root, "init", "-b", "main");
    git(root, "config", "user.name", "Fixture");
    git(root, "config", "user.email", "fixture@example.test");
    const content =
      "# API\n\n" +
      readFileSync(new URL("../src/contracts.ts", import.meta.url), "utf8");
    writeFileSync(
      join(root, "contract.md"),
      content + "\n# Appendix\n\nKeep this separate source section.\n",
    );
    git(root, "add", ".");
    git(root, "commit", "-m", "pin complete public API source");
    const baseSha = git(root, "rev-parse", "HEAD");
    const body =
      "## Acceptance\n- Preserve every required interface.\n\n## Sources\n- contract.md\n";
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
            text: content,
          },
        },
      ],
    };
    hydrateWorkerInputSources(currentGraph, sources);
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
    const { wire, call } = renderCompilationCall({
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
    });
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
    // The old duplicated amendment alone exceeded the demonstrated adapter ceiling.
    assert.ok(Buffer.byteLength(before) > 1_048_576);
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
    assert.ok(review.prompt.includes(renderReviewPacketChoices(evidence)));
    const view = planningGraphView(currentGraph, sources);
    for (const [index, item] of view.items.entries()) {
      const input = item.inputSources[0];
      const span = input.sourceSpan;
      const selected = sources[span.sourceIndex].content.slice(
        span.start,
        span.start + span.length,
      );
      assert.equal(selected, currentGraph.items[index].inputSources[0].content);
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
    const decoded = wire.decode({
      contextId: wire.data.contextId,
      requiredPreIntegrationChecks: [],
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
    });
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
    unmatched.items[0].inputSources[0].content +=
      "not supplied by the pinned source";
    assert.deepEqual(
      planningGraphView(unmatched, sources).items[0].inputSources,
      unmatched.items[0].inputSources,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
