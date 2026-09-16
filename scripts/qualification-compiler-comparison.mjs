import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const sha = /^[0-9a-f]{40}$/;
const digest = /^[0-9a-f]{64}$/;
const stages = new Set(["inventory", "compile", "repair", "judge"]);
const authorityMarkerPath = ".factory-issue404-qualification.json";

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  const encoded = JSON.stringify(value);
  assert.notEqual(encoded, undefined, "qualification scenario is not JSON serializable");
  return encoded;
}

export function compilerQualificationScenarioDigest(spec) {
  return createHash("sha256").update(canonical(spec)).digest("hex");
}

function exactCounter(value, label) {
  assert.ok(
    Number.isSafeInteger(value) && value >= 0,
    `${label} must be an exact nonnegative integer`,
  );
  return value;
}

function normalizeScenarioSpec(spec, role, root) {
  assert.ok(
    spec && typeof spec === "object" && !Array.isArray(spec),
    `${role} scenario spec missing`,
  );
  assert.equal(
    spec.protocol,
    "clockgrove.factory/compiler-qualification-scenario-v1",
    `${role} scenario protocol differs`,
  );
  assert.ok(spec.fixture && typeof spec.fixture === "object", `${role} fixture spec missing`);
  assert.deepEqual(
    Object.keys(spec.fixture).sort(),
    ["baseSha", "files"],
    `${role} fixture spec contains noncanonical authority metadata`,
  );
  assert.match(spec.fixture.baseSha, sha, `${role} fixture base SHA missing`);
  assert.ok(
    Array.isArray(spec.fixture.files) && spec.fixture.files.length > 0,
    `${role} fixture files missing`,
  );
  const paths = new Set();
  for (const file of spec.fixture.files) {
    assert.ok(file && typeof file === "object", `${role} fixture file invalid`);
    assert.ok(
      typeof file.path === "string" && file.path.length > 0,
      `${role} fixture path missing`,
    );
    assert.notEqual(file.path, authorityMarkerPath, `${role} authority marker entered fixture`);
    assert.ok(!paths.has(file.path), `${role} fixture path repeated`);
    paths.add(file.path);
    assert.ok(file.mode === "100644" || file.mode === "100755", `${role} fixture mode differs`);
    exactCounter(file.bytes, `${role} fixture bytes`);
    assert.match(file.sha256, digest, `${role} fixture content digest missing`);
  }
  assert.deepEqual([...paths], [...paths].sort(), `${role} fixture paths are not canonical`);
  assert.ok(spec.objective && typeof spec.objective === "object", `${role} objective missing`);
  assert.ok(
    Number.isSafeInteger(spec.objective.number) && spec.objective.number > 0,
    `${role} objective number invalid`,
  );
  assert.ok(typeof spec.objective.title === "string", `${role} objective title missing`);
  assert.ok(typeof spec.objective.body === "string", `${role} objective body missing`);
  assert.ok(
    Array.isArray(spec.allowedNetworkDestinations) &&
      spec.allowedNetworkDestinations.every((entry) => typeof entry === "string"),
    `${role} allowed network destinations missing`,
  );
  assert.ok(spec.runPolicy && typeof spec.runPolicy === "object", `${role} run policy missing`);
  assert.ok(
    spec.modelSelection && typeof spec.modelSelection === "object",
    `${role} model selection missing`,
  );
  assert.ok(
    typeof spec.modelSelection.profile === "string" && spec.modelSelection.profile.length > 0,
    `${role} model profile missing`,
  );
  assert.equal(spec.modelSelection.model, root.model, `${role} scenario model differs from arm`);
  assert.equal(
    spec.modelSelection.reasoning,
    root.reasoning,
    `${role} scenario reasoning differs from arm`,
  );
  assert.ok(
    Array.isArray(spec.responseTransformations),
    `${role} response transformations missing`,
  );
  for (const transformation of spec.responseTransformations) {
    assert.ok(
      transformation &&
        (transformation.stage === "compile" || transformation.stage === "repair") &&
        Number.isSafeInteger(transformation.revision) &&
        transformation.revision >= 0 &&
        transformation.kind === "omit-obligation" &&
        typeof transformation.obligationId === "string" &&
        transformation.obligationId.length > 0,
      `${role} response transformation invalid`,
    );
  }
  return spec;
}

function normalizeProvenance(value, role, root, scenarioSpec) {
  assert.ok(
    value && typeof value === "object" && !Array.isArray(value),
    `${role} provenance missing`,
  );
  assert.match(value.promptDigest, digest, `${role} prompt digest missing`);
  assert.match(value.schemaDigest, digest, `${role} schema digest missing`);
  assert.match(value.baseSha, /^[0-9a-f]{40,64}$/, `${role} provenance base SHA missing`);
  assert.equal(
    value.baseSha,
    scenarioSpec.fixture.baseSha,
    `${role} provenance base differs from scenario fixture`,
  );
  assert.equal(value.model, root.model, `${role} provenance model differs`);
  assert.equal(value.reasoning, root.reasoning, `${role} provenance reasoning differs`);
  return {
    promptDigest: value.promptDigest,
    schemaDigest: value.schemaDigest,
    baseSha: value.baseSha,
    model: value.model,
    reasoning: value.reasoning,
  };
}

function normalizeArm(input, role) {
  assert.ok(
    input && typeof input === "object" && !Array.isArray(input),
    `${role} is not an object`,
  );
  assert.match(input.candidateSha, sha, `${role} candidate SHA must be exact`);
  assert.ok(typeof input.model === "string" && input.model.length > 0, `${role} model missing`);
  assert.ok(
    typeof input.reasoning === "string" && input.reasoning.length > 0,
    `${role} reasoning missing`,
  );
  assert.ok(Array.isArray(input.cases) && input.cases.length > 0, `${role} cases missing`);
  const seenScenarios = new Set();
  return {
    commitSha: input.candidateSha,
    model: input.model,
    reasoning: input.reasoning,
    scenarios: input.cases
      .map((scenario) => {
        assert.ok(scenario && typeof scenario === "object", `${role} scenario is not an object`);
        assert.ok(
          typeof scenario.name === "string" && scenario.name.length > 0,
          `${role} scenario name missing`,
        );
        const scenarioSpec = normalizeScenarioSpec(scenario.scenarioSpec, role, input);
        assert.match(scenario.scenarioDigest, digest, `${role} scenario digest missing`);
        assert.equal(
          scenario.scenarioDigest,
          compilerQualificationScenarioDigest(scenarioSpec),
          `${role} scenario digest differs from its full spec`,
        );
        assert.ok(!seenScenarios.has(scenario.name), `${role} scenario name repeated`);
        seenScenarios.add(scenario.name);
        assert.equal(scenario.status, "accepted", `${role} scenario did not accept`);
        assert.equal(
          scenario.sourceBaseSha,
          scenarioSpec.fixture.baseSha,
          `${role} scenario source base differs from its fixture`,
        );
        assert.ok(Array.isArray(scenario.transcripts), `${role} scenario transcripts missing`);
        assert.ok(
          Array.isArray(scenario.tokenUsageByStage),
          `${role} scenario token usage missing`,
        );
        const transcriptByStage = new Map();
        for (const transcript of scenario.transcripts) {
          const key = `${transcript.stage}:${transcript.revision}`;
          assert.ok(stages.has(transcript.stage), `${role} transcript stage invalid`);
          exactCounter(transcript.revision, `${role} transcript revision`);
          assert.ok(!transcriptByStage.has(key), `${role} transcript stage repeated`);
          assert.ok(
            typeof transcript.modelInvocationId === "string" &&
              transcript.modelInvocationId.length > 0,
            `${role} invocation identity missing`,
          );
          transcriptByStage.set(key, {
            modelInvocationId: transcript.modelInvocationId,
            promptBytes: exactCounter(transcript.promptBytes, `${role} prompt bytes`),
            provenance: normalizeProvenance(transcript.provenance, role, input, scenarioSpec),
          });
        }
        const measured = scenario.tokenUsageByStage.map((entry) => {
          const key = `${entry.stage}:${entry.revision}`;
          assert.ok(stages.has(entry.stage), `${role} usage stage invalid`);
          exactCounter(entry.revision, `${role} usage revision`);
          assert.ok(transcriptByStage.has(key), `${role} usage has no bound transcript`);
          const transcript = transcriptByStage.get(key);
          assert.equal(entry.tokens?.availability, "observed", `${role} token usage unavailable`);
          assert.equal(
            entry.tokens.cachedInputAvailability,
            "observed",
            `${role} cached token usage unavailable`,
          );
          const inputTokens = exactCounter(entry.tokens.inputTokens, `${role} input tokens`);
          const outputTokens = exactCounter(entry.tokens.outputTokens, `${role} output tokens`);
          const cachedInputTokens = exactCounter(
            entry.tokens.cachedInputTokens,
            `${role} cached input tokens`,
          );
          assert.ok(cachedInputTokens <= inputTokens, `${role} cached tokens exceed input tokens`);
          transcriptByStage.delete(key);
          return {
            stage: entry.stage,
            revision: entry.revision,
            modelInvocationId: transcript.modelInvocationId,
            promptBytes: transcript.promptBytes,
            provenance: transcript.provenance,
            inputTokens,
            outputTokens,
            cachedInputTokens,
          };
        });
        assert.equal(transcriptByStage.size, 0, `${role} transcript has no exact usage record`);
        return {
          name: scenario.name,
          scenarioSpec,
          scenarioDigest: scenario.scenarioDigest,
          stages: measured,
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
}

function totals(scenario) {
  return scenario.stages.reduce(
    (sum, stage) => ({
      calls: sum.calls + 1,
      promptBytes: sum.promptBytes + stage.promptBytes,
      inputTokens: sum.inputTokens + stage.inputTokens,
      outputTokens: sum.outputTokens + stage.outputTokens,
      cachedInputTokens: sum.cachedInputTokens + stage.cachedInputTokens,
    }),
    { calls: 0, promptBytes: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
  );
}

function delta(candidate, baseline) {
  return Object.fromEntries(
    Object.keys(candidate).map((key) => [key, candidate[key] - baseline[key]]),
  );
}

function stageComparisons(baseline, candidate) {
  const baselineByKey = new Map(
    baseline.stages.map((stage) => [`${stage.stage}:${stage.revision}`, stage]),
  );
  const candidateByKey = new Map(
    candidate.stages.map((stage) => [`${stage.stage}:${stage.revision}`, stage]),
  );
  return [...new Set([...baselineByKey.keys(), ...candidateByKey.keys()])].sort().map((key) => {
    const baselineStage = baselineByKey.get(key) ?? null;
    const candidateStage = candidateByKey.get(key) ?? null;
    return {
      key,
      baseline: baselineStage,
      candidate: candidateStage,
      delta:
        baselineStage && candidateStage
          ? delta(
              {
                promptBytes: candidateStage.promptBytes,
                inputTokens: candidateStage.inputTokens,
                outputTokens: candidateStage.outputTokens,
                cachedInputTokens: candidateStage.cachedInputTokens,
              },
              {
                promptBytes: baselineStage.promptBytes,
                inputTokens: baselineStage.inputTokens,
                outputTokens: baselineStage.outputTokens,
                cachedInputTokens: baselineStage.cachedInputTokens,
              },
            )
          : null,
    };
  });
}

export function compareCompilerQualificationPair(baselineInput, candidateInput) {
  const candidate = normalizeArm(candidateInput, "candidate");
  if (baselineInput === null)
    return {
      protocol: "clockgrove.factory/compiler-paired-qualification-v1",
      status: "unavailable",
      candidate,
      baseline: null,
      reason: "no authoritative exact-token baseline artifact was supplied",
      nextAction:
        "run the identical live scenarios once at each exact SHA with the same model and reasoning, then compare both retained artifacts",
    };
  const baseline = normalizeArm(baselineInput, "baseline");
  assert.notEqual(
    baseline.commitSha,
    candidate.commitSha,
    "baseline and candidate SHAs must differ",
  );
  assert.equal(baseline.model, candidate.model, "paired model differs");
  assert.equal(baseline.reasoning, candidate.reasoning, "paired reasoning differs");
  assert.deepEqual(
    baseline.scenarios.map(({ name, scenarioSpec, scenarioDigest }) => ({
      name,
      scenarioSpec,
      scenarioDigest,
    })),
    candidate.scenarios.map(({ name, scenarioSpec, scenarioDigest }) => ({
      name,
      scenarioSpec,
      scenarioDigest,
    })),
    "paired scenarios differ",
  );
  return {
    protocol: "clockgrove.factory/compiler-paired-qualification-v1",
    status: "measured",
    baselineSha: baseline.commitSha,
    candidateSha: candidate.commitSha,
    model: candidate.model,
    reasoning: candidate.reasoning,
    scenarios: candidate.scenarios.map((candidateScenario, index) => {
      const baselineScenario = baseline.scenarios[index];
      const baselineTotals = totals(baselineScenario);
      const candidateTotals = totals(candidateScenario);
      return {
        name: candidateScenario.name,
        scenarioSpec: candidateScenario.scenarioSpec,
        scenarioDigest: candidateScenario.scenarioDigest,
        stageComparisons: stageComparisons(baselineScenario, candidateScenario),
        baseline: { stages: baselineScenario.stages, totals: baselineTotals },
        candidate: { stages: candidateScenario.stages, totals: candidateTotals },
        delta: delta(candidateTotals, baselineTotals),
      };
    }),
    tradeoff:
      "Token and prompt deltas are exact observations for this paired run; elapsed time, quality, and future provider caching are outside this comparison.",
  };
}

async function main() {
  const [baselinePath, candidatePath] = process.argv.slice(2);
  assert.ok(
    baselinePath && candidatePath,
    "usage: qualification-compiler-comparison.mjs <baseline.json|-> <candidate.json>",
  );
  const baseline = baselinePath === "-" ? null : JSON.parse(await readFile(baselinePath, "utf8"));
  const candidate = JSON.parse(await readFile(candidatePath, "utf8"));
  process.stdout.write(
    `${JSON.stringify(compareCompilerQualificationPair(baseline, candidate), null, 2)}\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
