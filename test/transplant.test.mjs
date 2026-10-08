import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  renderCompilationCall,
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
    writeFileSync(join(root, "contract.md"), content);
    git(root, "add", ".");
    git(root, "commit", "-m", "pin complete public API source");
    const baseSha = git(root, "rev-parse", "HEAD");
    const body =
      "## Acceptance\n- Preserve every required interface.\n\n## Sources\n- contract.md#API\n";
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
            digest: createHash("sha256").update(content).digest("hex"),
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
        coverage:
          index === 0
            ? [
                {
                  obligationIndex: 0,
                  proof: { kind: "result-semantic", acceptanceIndex: 0 },
                  environment: {
                    kind: "local",
                    readiness: "available",
                    probeValidationIndex: null,
                    prerequisiteValidationIndices: [],
                    preparedBy: "",
                  },
                },
              ]
            : [],
        ...(index === 0 ? { addedOwnedPaths: ["additional.ts"] } : {}),
      })),
    });
    assert.deepEqual(decoded.items[0], {
      ...currentGraph.items[0],
      ownedPaths: ["part-0.ts", "additional.ts"],
    });
    assert.deepEqual(decoded.items.slice(1), currentGraph.items.slice(1));
    assert.equal(JSON.stringify(currentGraph), before);
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
