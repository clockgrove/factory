import { compilerCitationChoices } from "../dist/compiler.js";
import { compilerWire } from "../dist/compiler-wire.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { composePlanning } from "../dist/application.js";
import { CompletedModelInvocationError } from "../dist/contracts.js";
import {
  compilePlan,
  PlanValidationError,
  resolvePlan,
  verifyPlanCandidate,
} from "../dist/compiler.js";
import { stateRoot } from "../dist/config.js";
import { readDiagnostics } from "../dist/diagnostics.js";
import { statePath } from "../dist/state-store.js";
import { withCoverage } from "./support/coverage.mjs";
import {
  createTarget,
  factoryConfig,
  makeApplication,
} from "./support/integration-fixture.mjs";

function graph(
  baseSha,
  citation = { path: "OBJECTIVE", heading: "Acceptance" },
) {
  return {
    objective: 1,
    baseSha,
    items: [
      {
        id: "one",
        title: "One",
        goal: "Write one.txt",
        acceptance: ["one.txt exists"],
        nonGoals: ["No deployment"],
        citations: [citation],
        dependencies: [],
        ownedPaths: ["one.txt"],
        resources: [],
        validation: [
          {
            command: "test -s one.txt",
            provenance: "source-declared",
            source: "OBJECTIVE",
          },
        ],
        brief: "Write one.txt",
        sourceAssets: [],
        expectedOutputRoles: [],
        minimumAssetSets: 0,
        requiredLfsRoles: [],
      },
    ],
  };
}

const body = `# Objective

## Acceptance
- \`test -s one.txt\`

## Planning sources
- \`docs/plan.md#Wave 0\`
`;

async function fixture(name, callback) {
  const root = mkdtempSync(join(tmpdir(), `factory-plan-${name}-`));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, "state");
  try {
    return await callback(root);
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

test("read-only plan uses pinned selected heading despite dirty checkout", async () => {
  await fixture("pinned", async (root) => {
    const target = createTarget(root, {
      "docs/plan.md":
        "# Plan\n\n## Wave 0\nCanonical obligation\n\n## Wave 1\nUnselected text\n",
    });
    const descriptor = {
      config: factoryConfig(target.checkout, "example/pinned-plan"),
      graph: graph(target.baseSha, { path: "docs/plan.md", heading: "Wave 0" }),
      objectiveBody: body,
      fakeRoot: join(root, "fake"),
      actions: {},
    };
    assert.equal(existsSync(stateRoot(descriptor.config.repository)), false);
    composePlanning(descriptor.config);
    assert.equal(existsSync(stateRoot(descriptor.config.repository)), false);
    const { application, github } = makeApplication(descriptor);
    writeFileSync(
      join(target.checkout, "docs/plan.md"),
      "# Plan\n\n## Wave 0\nDirty replacement\n",
    );
    const candidate = await application.planObjective(1);
    assert.equal(candidate.review.status, "clean");
    assert.equal(candidate.commands[0].hostExecution, "authorized");
    assert.equal(candidate.graphDigest.length, 64);
    assert.match(
      candidate.sources.find((source) => source.path === "docs/plan.md")
        .content,
      /Canonical obligation/,
    );
    assert.doesNotMatch(
      candidate.sources.find((source) => source.path === "docs/plan.md")
        .content,
      /Unselected text|Dirty replacement/,
    );
    assert.equal(existsSync(statePath(descriptor.config.repository, 1)), false);
    assert.equal(Object.keys(github.state().issues).length, 0);
    const installationDigest = createHash("sha256")
      .update(JSON.stringify(descriptor.config))
      .digest("hex");
    verifyPlanCandidate(
      candidate,
      1,
      body,
      target.baseSha,
      target.checkout,
      installationDigest,
    );
    assert.throws(
      () =>
        verifyPlanCandidate(
          candidate,
          1,
          body.replace("# Objective", "# Changed Objective"),
          target.baseSha,
          target.checkout,
          installationDigest,
        ),
      /differs from the current Objective/,
    );
  });
});

test("compiler schema binds citations to exact supplied path and bare heading pairs", async () => {
  await fixture("citation-schema", async (root) => {
    const target = createTarget(root, {
      "docs/plan.md": "# Plan\n\n## Wave 0\nCanonical obligation\n",
      "docs/plain.txt": "Canonical source without a Markdown heading\n",
    });
    const objective = body.replace(
      "- `docs/plan.md#Wave 0`",
      "- `docs/plan.md#Wave 0`\n- `docs/plain.txt`",
    );
    const requests = [];
    const model = {
      async generateStructured(request) {
        requests.push(structuredClone(request));
        return withCoverage(request, graph(target.baseSha));
      },
      async reviewGraph(request) {
        return {
          packetId: request.reviewPacket.id,
          findings: [],
        };
      },
    };

    const candidate = await compilePlan(
      1,
      objective,
      target.baseSha,
      target.checkout,
      model,
    );
    assert.equal(candidate.review.status, "clean");
    assert.equal(requests.length, 1);

    const choices = compilerCitationChoices(requests[0].sources);
    const allows = (path, heading) =>
      choices.some(
        (choice) => choice.path === path && choice.heading === heading,
      );
    assert.ok(allows("OBJECTIVE", "Acceptance"));
    assert.ok(allows("docs/plan.md", "Wave 0"));
    assert.equal(
      allows("docs/plan.md", ""),
      false,
      "a selected heading packet must not grant whole-source authority",
    );
    assert.ok(allows("docs/plain.txt", ""));
    assert.equal(allows("docs/plan.md", "Acceptance"), false);
    assert.equal(
      choices.some((choice) => choice.heading.startsWith("#")),
      false,
    );
  });
});

test("compiler rejects a whole-source citation when only one heading was supplied", async () => {
  await fixture("citation-selected-heading", async (root) => {
    const target = createTarget(root, {
      "docs/plan.md":
        "# Plan\n\n## Wave 0\nCanonical obligation\n\n## Wave 1\nNot supplied\n",
    });
    await assert.rejects(
      compilePlan(1, body, target.baseSha, target.checkout, {
        async generateStructured(request) {
          return withCoverage(
            request,
            graph(target.baseSha, {
              path: "docs/plan.md",
              heading: "",
            }),
          );
        },
        async reviewGraph() {
          throw new Error("review should not run");
        },
      }),
      /unavailable pinned section/,
    );
  });
});

test("compiler rejects a Markdown-prefixed citation heading without normalization", async () => {
  await fixture("citation-marker", async (root) => {
    const target = createTarget(root, {
      "docs/plan.md": "# Plan\n\n## Wave 0\nCanonical obligation\n",
    });
    const observations = [];
    await assert.rejects(
      compilePlan(
        1,
        body,
        target.baseSha,
        target.checkout,
        {
          async generateStructured(request) {
            return withCoverage(
              request,
              graph(target.baseSha, {
                path: "OBJECTIVE",
                heading: "## Acceptance",
              }),
            );
          },
          async reviewGraph() {
            throw new Error("review should not run");
          },
        },
        undefined,
        (event) => observations.push(event),
      ),
      /unavailable pinned section/,
    );
    assert.ok(
      observations.some(
        (event) =>
          event.type === "response-invalid" &&
          event.failureClass === "semantic-validation" &&
          event.failureField === "one",
      ),
    );
  });
});

test("compiler rejects terminal line separators in section and whole-source citations", async () => {
  await fixture("citation-terminal-lines", async (root) => {
    const target = createTarget(root, {
      "docs/plan.md": "# Plan\n\n## Wave 0\nCanonical obligation\n",
      "docs/plain.txt": "Canonical source without a Markdown heading\n",
    });
    const objective = body.replace(
      "- `docs/plan.md#Wave 0`",
      "- `docs/plan.md#Wave 0`\n- `docs/plain.txt`",
    );
    const terminalLineSeparators = ["\n", "\r", "\r\n", "\u2028", "\u2029"];
    for (const separator of terminalLineSeparators) {
      for (const citation of [
        { path: "OBJECTIVE", heading: `Acceptance${separator}` },
        { path: "docs/plain.txt", heading: separator },
      ]) {
        await assert.rejects(
          compilePlan(1, objective, target.baseSha, target.checkout, {
            async generateStructured(request) {
              return withCoverage(request, graph(target.baseSha, citation));
            },
            async reviewGraph() {
              throw new Error("review should not run");
            },
          }),
          /unavailable pinned section/,
        );
      }
    }
  });
});

test("preview shows an undeclared command as blocked before host execution", async () => {
  await fixture("command", async (root) => {
    const target = createTarget(root, {
      "docs/plan.md": "# Plan\n\n## Wave 0\nCanonical obligation\n",
    });
    // The criterion does not require the command, so only authority blocks it.
    const declared = body.replace(
      "- `test -s one.txt`",
      "- one.txt exists\n\n## Validation\n- `test -s one.txt`",
    );
    const invented = graph(target.baseSha);
    invented.items[0].validation[0].command = "test -s one";
    const model = {
      async generateStructured(request) {
        return withCoverage(request, invented);
      },
      async reviewGraph(request) {
        return {
          packetId: request.reviewPacket.id,
          findings: [],
        };
      },
    };
    const candidate = await compilePlan(
      1,
      declared,
      target.baseSha,
      target.checkout,
      model,
    );
    assert.equal(candidate.commands[0].hostExecution, "blocked");
    assert.throws(
      () =>
        verifyPlanCandidate(
          candidate,
          1,
          declared,
          target.baseSha,
          target.checkout,
        ),
      /without established host execution authority/,
    );
  });
});

test("planning rejects missing selected heading without mutating run state", async () => {
  await fixture("missing", async (root) => {
    const target = createTarget(root, { "docs/plan.md": "# Plan\n" });
    const model = {
      async generateStructured(request) {
        throw new Error("model should not run");
      },
      async reviewGraph() {
        throw new Error("review should not run");
      },
    };
    await assert.rejects(
      compilePlan(1, body, target.baseSha, target.checkout, model),
      /0 headings named Wave 0/,
    );
    const descriptor = {
      config: factoryConfig(target.checkout, "example/missing-plan"),
      graph: graph(target.baseSha),
      objectiveBody: body,
      fakeRoot: join(root, "fake"),
      actions: {},
    };
    const { application } = makeApplication(descriptor);
    await assert.rejects(
      application.runObjective(1),
      /0 headings named Wave 0/,
    );
    assert.ok(
      readDiagnostics(descriptor.config.repository, 1).some(
        (event) =>
          event.operation === "objective-run" &&
          event.outcome === "failed" &&
          /0 headings named Wave 0/.test(event.detail),
      ),
    );
    assert.equal(existsSync(statePath("example/missing-plan", 1)), false);
  });
});

test("read-only planning diagnostics redact configured secret values", async () => {
  await fixture("planning-secret", async (root) => {
    const target = createTarget(root, {
      "docs/plan.md": "# Plan\n\n## Wave 0\nCanonical obligation\n",
    });
    const config = factoryConfig(target.checkout, "example/planning-secret");
    config.policy.allowedSecretNames = ["FACTORY_PLANNING_TEST_SECRET"];
    const previousSecret = process.env.FACTORY_PLANNING_TEST_SECRET;
    process.env.FACTORY_PLANNING_TEST_SECRET = "private-planning-secret";
    try {
      const planningModel = {
        async generateStructured(request) {
          return withCoverage(request, graph(target.baseSha));
        },
        async reviewGraph(request) {
          request.invocation.observe({
            invocationId: request.invocation.invocationId,
            phase: request.invocation.phase,
            ordinal: request.invocation.ordinal,
            type: "failed",
            failureClass: "provider",
            usageAvailable: false,
            detail: "provider exposed private-planning-secret",
          });
          // A provider answer that completed and failed: an invalid review.
          throw new CompletedModelInvocationError(
            "provider exposed private-planning-secret",
          );
        },
      };
      const { application } = makeApplication({
        config,
        graph: graph(target.baseSha),
        objectiveBody: body,
        fakeRoot: join(root, "fake"),
        actions: {},
        planningModel,
      });
      const candidate = await application.planObjective(1);
      assert.equal(candidate.review.status, "needs-human");
      const diagnostics = readDiagnostics(config.repository, 1);
      assert.doesNotMatch(
        JSON.stringify(diagnostics),
        /private-planning-secret/,
      );
      assert.ok(
        diagnostics.some(
          (event) =>
            event.operation === "model-invocation" &&
            event.metadata.phase === "graph-review" &&
            /REDACTED/.test(event.detail),
        ),
      );
    } finally {
      if (previousSecret === undefined)
        delete process.env.FACTORY_PLANNING_TEST_SECRET;
      else process.env.FACTORY_PLANNING_TEST_SECRET = previousSecret;
    }
  });
});

test("one sourced review finding permits one revision and re-review", async () => {
  await fixture("review", async (root) => {
    const target = createTarget(root, {
      "docs/plan.md": "# Plan\n\n## Wave 0\nCanonical obligation\n",
    });
    const calls = [];
    const model = {
      async generateStructured(request) {
        calls.push({
          type: "compile",
          objective: request.objective,
          invocation: request.invocation,
        });
        return withCoverage(request, graph(target.baseSha));
      },
      async reviewGraph(request) {
        calls.push({ type: "review", invocation: request.invocation });
        return {
          packetId: request.reviewPacket.id,
          findings:
            calls.filter((call) => call.type === "review").length === 1
              ? [
                  {
                    evidenceIndices: [
                      request.reviewPacket.evidence.findIndex(
                        (e) => e.path === "OBJECTIVE",
                      ),
                    ],
                    detail: "Missing obligation",
                    question: "Which requirement owns this obligation?",
                  },
                ]
              : [],
        };
      },
    };
    const candidate = await compilePlan(
      1,
      body,
      target.baseSha,
      target.checkout,
      model,
    );
    assert.equal(candidate.review.status, "clean");
    assert.equal(candidate.review.revisions, 1);
    assert.deepEqual(
      calls.map((call) => call.type),
      ["compile", "review", "compile", "review"],
    );
    assert.match(calls[2].objective, /Missing obligation/);
    assert.deepEqual(
      calls.map((call) => [call.invocation.phase, call.invocation.ordinal]),
      [
        ["compile", 0],
        ["graph-review", 0],
        ["compile", 1],
        ["graph-review", 1],
      ],
    );
    assert.equal(
      new Set(calls.map((call) => call.invocation.invocationId)).size,
      4,
    );
  });
});

test("graph review identifies the exact supplied section among duplicate paths", async () => {
  await fixture("review-duplicate-path", async (root) => {
    const target = createTarget(root, {
      "docs/plan.md":
        "# Plan\n\n## Earlier\nEarlier obligation\n\n## Later\nLater-only obligation\n",
    });
    const duplicatePathBody = `# Objective

## Acceptance
- \`test -s one.txt\`

## Planning sources
- \`docs/plan.md#Earlier\`
- \`docs/plan.md#Later\`
`;
    const observations = [];
    let reviews = 0;
    const candidate = await compilePlan(
      1,
      duplicatePathBody,
      target.baseSha,
      target.checkout,
      {
        async generateStructured(request) {
          return withCoverage(request, graph(target.baseSha));
        },
        async reviewGraph(request) {
          reviews += 1;
          return {
            packetId: request.reviewPacket.id,
            findings:
              reviews === 1
                ? [
                    {
                      evidenceIndices: [
                        request.reviewPacket.evidence.findIndex(
                          (e) =>
                            e.content.includes("Later-only obligation") &&
                            e.path === "docs/plan.md",
                        ),
                      ],
                      detail: "The later obligation is missing",
                      question: "Which Work Item owns the later obligation?",
                    },
                  ]
                : [],
          };
        },
      },
      undefined,
      (event) => observations.push(event),
    );
    const matchingSources = candidate.sources.filter(
      (source) => source.path === "docs/plan.md",
    );
    assert.equal(matchingSources.length, 2);
    assert.doesNotMatch(matchingSources[0].content, /Later-only obligation/);
    assert.match(matchingSources[1].content, /Later-only obligation/);
    assert.equal(candidate.review.status, "clean");
    assert.equal(candidate.review.revisions, 1);
    assert.equal(
      observations.some((event) => event.type === "response-invalid"),
      false,
    );
  });
});

test("review and verification bind controller capabilities, commands, and installation config", async () => {
  await fixture("review-packet", async (root) => {
    const target = createTarget(root, {
      "docs/plan.md": "# Plan\n\n## Wave 0\nCanonical obligation\n",
    });
    const generated = [];
    const reviewed = [];
    const model = {
      async generateStructured(request) {
        generated.push(structuredClone(request));
        return withCoverage(request, graph(target.baseSha));
      },
      async reviewGraph(request) {
        reviewed.push(structuredClone(request));
        return {
          packetId: request.reviewPacket.id,
          findings: [],
        };
      },
    };
    const installationDigest = "c".repeat(64);
    const candidate = await compilePlan(
      1,
      body,
      target.baseSha,
      target.checkout,
      model,
      installationDigest,
    );
    assert.equal(reviewed.length, 1);
    assert.equal(generated.length, 1);
    assert.deepEqual(
      generated[0].controllerCapabilities,
      candidate.controllerCapabilities,
    );
    assert.equal(
      generated[0].controllerCapabilitiesDigest,
      candidate.controllerCapabilitiesDigest,
    );
    assert.deepEqual(
      reviewed[0].controllerCapabilities,
      candidate.controllerCapabilities,
    );
    assert.equal(
      reviewed[0].controllerCapabilitiesDigest,
      candidate.controllerCapabilitiesDigest,
    );
    assert.equal(candidate.controllerCapabilities.schemaVersion, 1);
    assert.equal(candidate.controllerCapabilitiesDigest.length, 64);
    assert.deepEqual(reviewed[0].commands, candidate.commands);
    assert.deepEqual(reviewed[0].finalCommands, candidate.finalCommands);
    assert.equal(reviewed[0].objective, body);
    assert.equal(candidate.packetDigest.length, 64);
    assert.equal(candidate.reviewDigest.length, 64);
    assert.equal(candidate.configDigest, installationDigest);
    verifyPlanCandidate(
      candidate,
      1,
      body,
      target.baseSha,
      target.checkout,
      installationDigest,
    );
    for (const mutated of [
      { ...candidate, finalCommands: ["test -s invented.txt"] },
      { ...candidate, commands: [] },
      { ...candidate, packetDigest: "d".repeat(64) },
      { ...candidate, reviewDigest: "d".repeat(64) },
    ]) {
      assert.throws(
        () =>
          verifyPlanCandidate(
            mutated,
            1,
            body,
            target.baseSha,
            target.checkout,
            installationDigest,
          ),
        /differs from the current Objective/,
      );
    }
    for (const mutated of [
      { ...candidate, controllerCapabilities: undefined },
      {
        ...candidate,
        controllerCapabilities: {
          ...candidate.controllerCapabilities,
          schemaVersion: 2,
        },
      },
      {
        ...candidate,
        controllerCapabilitiesDigest: "f".repeat(64),
      },
    ]) {
      assert.throws(
        () =>
          verifyPlanCandidate(
            mutated,
            1,
            body,
            target.baseSha,
            target.checkout,
            installationDigest,
          ),
        /controller capabilities differ from the installed Factory artifact/,
      );
    }
    assert.throws(
      () =>
        verifyPlanCandidate(
          candidate,
          1,
          body,
          target.baseSha,
          target.checkout,
          "e".repeat(64),
        ),
      /differs from the current Objective/,
    );
  });
});

test("unresolved review asks one human question and records a specific decision", async () => {
  await fixture("decision", async (root) => {
    const target = createTarget(root, {
      "docs/plan.md": "# Plan\n\n## Wave 0\nCanonical obligation\n",
    });
    let reviewCount = 0;
    const model = {
      async generateStructured(request) {
        return withCoverage(request, graph(target.baseSha));
      },
      async reviewGraph(request) {
        reviewCount += 1;
        return {
          packetId: request.reviewPacket.id,
          findings: [
            {
              evidenceIndices: [
                request.reviewPacket.evidence.findIndex(
                  (e) => e.path === "OBJECTIVE",
                ),
              ],
              detail: "Authority unresolved",
              question: "Which source authorizes this?",
            },
          ],
        };
      },
    };
    const candidate = await compilePlan(
      1,
      body,
      target.baseSha,
      target.checkout,
      model,
    );
    assert.equal(candidate.review.status, "needs-human");
    assert.equal(reviewCount, 2);
    assert.equal(candidate.review.findings[0].evidence[0].path, "OBJECTIVE");
    assert.match(
      candidate.review.findings[0].evidence[0].digest,
      /^[a-f0-9]{64}$/,
    );
    assert.equal(candidate.review.findings[0].evidence[0].content, undefined);
    assert.throws(
      () =>
        verifyPlanCandidate(
          {
            ...candidate,
            review: { ...candidate.review, status: "clean", findings: [] },
          },
          1,
          body,
          target.baseSha,
          target.checkout,
        ),
      /differs from the current Objective/,
    );
    assert.throws(
      () =>
        verifyPlanCandidate(
          candidate,
          1,
          body,
          target.baseSha,
          target.checkout,
        ),
      /specific human source decision/,
    );
    const decided = await resolvePlan(
      candidate,
      1,
      body,
      target.baseSha,
      target.checkout,
      {
        actor: "test operator",
        outcome: "accept",
        answer: "Use the Objective Acceptance section",
        reason: "The target owner confirmed this source",
      },
    );
    assert.equal(decided.review.status, "human-accepted");
    assert.equal(
      decided.humanDecision.question,
      "Which source authorizes this?",
    );
    assert.ok(decided.humanDecision.at);
    assert.equal(decided.humanDecision.reviewDigest, candidate.reviewDigest);
    assert.equal(reviewCount, 2);
    verifyPlanCandidate(decided, 1, body, target.baseSha, target.checkout);
    assert.throws(
      () =>
        verifyPlanCandidate(
          {
            ...decided,
            review: {
              ...decided.review,
              findings: [
                {
                  ...decided.review.findings[0],
                  question: "A different unresolved question?",
                },
              ],
            },
          },
          1,
          body,
          target.baseSha,
          target.checkout,
        ),
      /differs from the current Objective/,
    );
  });
});

test("malformed graph review pauses on the pinned graph and an explicit decision does not re-review", async () => {
  await fixture("malformed-review", async (root) => {
    const target = createTarget(root, {
      "docs/plan.md": "# Plan\n\n## Wave 0\nCanonical obligation\n",
    });
    let generationCount = 0;
    let reviewCount = 0;
    const observations = [];
    const model = {
      async generateStructured(request) {
        generationCount += 1;
        return withCoverage(request, graph(target.baseSha));
      },
      async reviewGraph(request) {
        reviewCount += 1;
        return {
          packetId: request.reviewPacket.id,
          findings: [
            {
              evidenceIndices: ["not-in-this-packet"],
              detail: "Unsupported finding",
              question: "Approve this?",
            },
          ],
        };
      },
    };
    const candidate = await compilePlan(
      1,
      body,
      target.baseSha,
      target.checkout,
      model,
      undefined,
      (event) => observations.push(event),
    );
    assert.equal(candidate.review.status, "needs-human");
    assert.equal(candidate.review.findings.length, 0);
    assert.match(
      candidate.review.failure.detail,
      /evidence index is invalid for this packet/,
    );
    assert.match(candidate.review.failure.question, /pinned Factory plan/);
    assert.match(
      candidate.review.failure.question,
      new RegExp(candidate.packetDigest),
    );
    assert.equal(generationCount, 1);
    assert.equal(reviewCount, 1);
    assert.ok(
      observations.some(
        (event) =>
          event.type === "response-invalid" &&
          event.phase === "graph-review" &&
          event.failureClass === "review-protocol" &&
          event.failureField === "findings" &&
          event.failureReason === "invalid" &&
          event.failureSource === undefined,
      ),
    );
    assert.throws(
      () =>
        verifyPlanCandidate(
          candidate,
          1,
          body,
          target.baseSha,
          target.checkout,
        ),
      /specific human source decision/,
    );
    const decided = await resolvePlan(
      candidate,
      1,
      body,
      target.baseSha,
      target.checkout,
      {
        actor: "test operator",
        outcome: "accept",
        answer:
          "I inspected the exact graph and accept these obligations and edges",
        reason: "Manual comparison with the pinned Objective",
      },
    );
    assert.equal(decided.review.status, "human-accepted");
    assert.equal(decided.graphDigest, candidate.graphDigest);
    assert.equal(decided.reviewDigest, candidate.reviewDigest);
    assert.equal(decided.humanDecision.reviewDigest, candidate.reviewDigest);
    assert.equal(generationCount, 1);
    assert.equal(reviewCount, 1);
    verifyPlanCandidate(decided, 1, body, target.baseSha, target.checkout);
    assert.throws(
      () =>
        verifyPlanCandidate(
          {
            ...decided,
            humanDecision: { ...decided.humanDecision, actor: "" },
          },
          1,
          body,
          target.baseSha,
          target.checkout,
        ),
      /specific human source decision/,
    );
    assert.throws(
      () =>
        verifyPlanCandidate(
          {
            ...decided,
            humanDecision: {
              ...decided.humanDecision,
              reviewDigest: "wrong",
            },
          },
          1,
          body,
          target.baseSha,
          target.checkout,
        ),
      /differs|specific human source decision/,
    );
  });
});

test("graph review rejects malformed protocol fields without retaining finding content", async () => {
  await fixture("review-rejections", async (root) => {
    const target = createTarget(root, {
      "docs/plan.md": "# Plan\n\n## Wave 0\nCanonical obligation\n",
    });
    const privateContent = "private-review-content";
    const cases = [
      () => privateContent,
      () => ({
        evidenceIndices: [privateContent],
        detail: "detail",
        question: "question",
      }),
      () => ({ evidenceIndices: [], detail: "detail", question: "question" }),
      (id) => ({
        evidenceIndices: [id, id],
        detail: "detail",
        question: "question",
      }),
      (id) => ({ evidenceIndices: [id], detail: " ", question: "question" }),
      (id) => ({
        evidenceIndices: [id],
        detail: "detail",
        question: "question",
        quote: privateContent,
      }),
    ];
    for (const makeFinding of cases) {
      const observations = [];
      const candidate = await compilePlan(
        1,
        body,
        target.baseSha,
        target.checkout,
        {
          async generateStructured(request) {
            return withCoverage(request, graph(target.baseSha));
          },
          async reviewGraph(request) {
            return {
              packetId: request.reviewPacket.id,
              findings: [makeFinding(0)],
            };
          },
        },
        undefined,
        (event) => observations.push(event),
      );
      assert.equal(candidate.review.status, "needs-human");
      assert.deepEqual(candidate.review.findings, []);
      assert.match(candidate.review.failure.detail, /could not be validated/);
      assert.doesNotMatch(
        JSON.stringify({ candidate, observations }),
        new RegExp(privateContent),
      );
      assert.deepEqual(
        observations
          .filter((event) => event.type === "response-invalid")
          .map((event) => ({
            field: event.failureField,
            reason: event.failureReason,
            source: event.failureSource,
          })),
        [{ field: "findings", reason: "invalid", source: undefined }],
      );
    }
  });
});

test("graph review asks about a finding without a question from its detail", async () => {
  await fixture("review-no-question", async (root) => {
    const target = createTarget(root, {
      "docs/plan.md": "# Plan\n\n## Wave 0\nCanonical obligation\n",
    });
    const requests = [];
    let reviews = 0;
    const candidate = await compilePlan(
      1,
      body,
      target.baseSha,
      target.checkout,
      {
        async generateStructured(request) {
          requests.push(request);
          return withCoverage(request, graph(target.baseSha));
        },
        async reviewGraph(request) {
          return {
            packetId: request.reviewPacket.id,
            findings:
              reviews++ === 0
                ? [
                    {
                      evidenceIndices: [0],
                      detail: "Name the missing owner.",
                      question: " ",
                    },
                  ]
                : [],
          };
        },
      },
    );
    assert.equal(candidate.review.status, "clean");
    assert.equal(candidate.review.revisions, 1);
    assert.equal(requests.length, 2);
    assert.match(
      requests[1].compileContext.instructions,
      /Name the missing owner\./,
    );
    assert.match(
      requests[1].compileContext.instructions,
      /"source":"independent review".*"question":"How should the plan change to fix this: Name the missing owner\?"/,
    );
  });
});

test("a plan refused by deterministic validation spends the one revision with the error as a finding", async () => {
  await fixture("validation-revision", async (root) => {
    const target = createTarget(root, {
      "docs/plan.md": "# Plan\n\n## Wave 0\nCanonical obligation\n",
    });
    const refused = (baseSha) => {
      const value = graph(baseSha);
      value.items[0].ownedPaths = ["/absolute/one.txt"];
      return value;
    };
    for (const reviewFinds of [false, true]) {
      const requests = [];
      const observations = [];
      let reviews = 0;
      const candidate = await compilePlan(
        1,
        body,
        target.baseSha,
        target.checkout,
        {
          async generateStructured(request) {
            requests.push(request);
            return withCoverage(
              request,
              requests.length === 1
                ? refused(target.baseSha)
                : graph(target.baseSha),
            );
          },
          async reviewGraph(request) {
            reviews++;
            return {
              packetId: request.reviewPacket.id,
              findings: reviewFinds
                ? [
                    {
                      evidenceIndices: [0],
                      detail: "A material defect remains.",
                      question: "Which owner is intended?",
                    },
                  ]
                : [],
            };
          },
        },
        undefined,
        (event) => observations.push(event),
      );
      // The first compile is refused; the second receives the refusal as a
      // finding and is reviewed once. No second revision follows a finding.
      assert.equal(requests.length, 2);
      assert.equal(reviews, 1);
      assert.equal(requests[0].compileContext.instructions, "");
      assert.match(
        requests[1].compileContext.instructions,
        /"source":"Factory check","detail":"Work Item one has invalid ownership path .*\/absolute\/one\.txt/,
      );
      assert.deepEqual(
        requests.map((request) => request.invocation.ordinal),
        [0, 1],
      );
      assert.ok(
        observations.some(
          (event) =>
            event.type === "response-invalid" &&
            event.failureClass === "semantic-validation",
        ),
      );
      assert.equal(candidate.review.revisions, 1);
      assert.deepEqual(candidate.graph.items[0].ownedPaths, ["one.txt"]);
      assert.equal(
        candidate.review.status,
        reviewFinds ? "needs-human" : "clean",
      );
    }
  });
});

test("a refused plan revision still fails compilation", async () => {
  await fixture("validation-revision-refused", async (root) => {
    const target = createTarget(root, {
      "docs/plan.md": "# Plan\n\n## Wave 0\nCanonical obligation\n",
    });
    let generated = 0;
    let reviews = 0;
    await assert.rejects(
      compilePlan(1, body, target.baseSha, target.checkout, {
        async generateStructured(request) {
          generated++;
          const value = graph(target.baseSha);
          value.items[0].ownedPaths = ["/absolute/one.txt"];
          return withCoverage(request, value);
        },
        async reviewGraph() {
          reviews++;
          throw new Error("A refused plan is never reviewed");
        },
      }),
      (error) =>
        error instanceof PlanValidationError &&
        /\/absolute\/one\.txt/.test(error.message),
    );
    assert.equal(generated, 2);
    assert.equal(reviews, 0);
  });
});

test("graph review requires an array and accepts an explicit clean empty review", async () => {
  await fixture("review-top-level", async (root) => {
    const target = createTarget(root, {
      "docs/plan.md": "# Plan\n\n## Wave 0\nCanonical obligation\n",
    });
    const invalidObservations = [];
    const invalid = await compilePlan(
      1,
      body,
      target.baseSha,
      target.checkout,
      {
        async generateStructured(request) {
          return withCoverage(request, graph(target.baseSha));
        },
        async reviewGraph(request) {
          return {
            packetId: request.reviewPacket.id,
            findings: null,
          };
        },
      },
      undefined,
      (event) => invalidObservations.push(event),
    );
    assert.equal(invalid.review.status, "needs-human");
    assert.match(
      invalid.review.failure.detail,
      /exact packetId and a findings array/,
    );
    assert.ok(
      invalidObservations.some(
        (event) =>
          event.type === "response-invalid" &&
          event.failureField === "findings" &&
          event.failureReason === "invalid",
      ),
    );

    const cleanObservations = [];
    const clean = await compilePlan(
      1,
      body,
      target.baseSha,
      target.checkout,
      {
        async generateStructured(request) {
          return withCoverage(request, graph(target.baseSha));
        },
        async reviewGraph(request) {
          return {
            packetId: request.reviewPacket.id,
            findings: [],
          };
        },
      },
      undefined,
      (event) => cleanObservations.push(event),
    );
    assert.equal(clean.review.status, "clean");
    assert.deepEqual(clean.review.findings, []);
    assert.equal(
      cleanObservations.some((event) => event.type === "response-invalid"),
      false,
    );
  });
});

test("compiler rejects wildcard ownership before independent review with actionable diagnostics", async () => {
  await fixture("ownership-grammar", async (root) => {
    const target = createTarget(root, {
      "docs/plan.md": "# Plan\n\n## Wave 0\nCanonical obligation\n",
    });
    let reviews = 0;
    for (const path of ["packages/example/**", "src/?.ts"]) {
      await assert.rejects(
        compilePlan(1, body, target.baseSha, target.checkout, {
          async generateStructured(request) {
            assert.match(
              compilerWire(request, compilerCitationChoices(request.sources))
                .schema.properties.items.items.anyOf[0].properties.ownedPaths
                .items.description,
              /no wildcard/,
            );
            const proposed = graph(target.baseSha);
            proposed.items[0].ownedPaths = [path];
            return withCoverage(request, proposed);
          },
          async reviewGraph(request) {
            reviews++;
            return {
              packetId: request.reviewPacket.id,
              findings: [],
            };
          },
        }),
        /Work Item one has invalid ownership path.*Wildcards \* and \? are unsupported/,
      );
    }
    assert.equal(reviews, 0);
  });
});
