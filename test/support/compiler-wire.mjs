/** Encode canonical fixtures only at the scripted SDK boundary; never use in production. */
export function compilerChoices(prompt) {
  return JSON.parse(prompt.split("\nCompiler choices (JSON data):\n")[1]);
}

export function encodeCompilerWire(input, promptOrChoices) {
  const choices =
    typeof promptOrChoices === "string"
      ? compilerChoices(promptOrChoices)
      : promptOrChoices;
  const graph = structuredClone(input);
  return {
    contextId: choices.contextId,
    items: graph.items
      .map(compilerItem)
      .map((item) => ({
        ...item,
        citations: item.citations.map((citation) => {
          if ("choiceIndex" in citation) return citation;
          const choiceIndex = choices.citations.findIndex(
            (entry) =>
              entry.path === citation.path &&
              entry.heading === citation.heading,
          );
          if (choiceIndex < 0)
            throw new Error("Fixture citation is not supplied");
          return { choiceIndex };
        }),
        validation: item.validation.map((entry) => {
          if (entry.provenance === "base-observed")
            return {
              kind: "base-observed",
              command: entry.command,
              source: entry.source,
            };
          const sourceIndex = choices.sources.findIndex(
            (source) => source.path === entry.source,
          );
          const lineIndex = choices.sources[sourceIndex]?.lines.findIndex(
            (line) => {
              let command = line.text
                .trim()
                .replace(/^[-*]\s+/, "")
                .trim();
              if (command.startsWith("`") && command.endsWith("`"))
                command = command.slice(1, -1);
              return command === entry.command;
            },
          );
          if (sourceIndex < 0 || lineIndex < 0 || lineIndex === undefined)
            throw new Error(
              `Fixture command lacks a source line: ${entry.command}`,
            );
          return { kind: "source-line", sourceIndex, lineIndex };
        }),
        coverage: (graph.coverage ?? []).flatMap((entry, coverageIndex) => {
          if (entry.itemId !== item.id) return [];
          const obligationIndex = entry.source
            ? choices.obligations.findIndex(
                (obligation) => obligation.text === entry.source.text,
              )
            : coverageIndex;
          let proof = structuredClone(entry.proof);
          if (proof.kind === "final-controller")
            proof = {
              kind: proof.kind,
              guaranteeIndex: choices.guarantees.findIndex(
                (guarantee) => guarantee.id === proof.guaranteeId,
              ),
            };
          else if (proof.kind === "published-ci")
            proof = {
              kind: proof.kind,
              checkName: proof.checkName,
              dependencyIndex: item.dependencies.indexOf(proof.targetItem),
            };
          const { probe, ...environment } = entry.environment;
          return [
            {
              obligationIndex,
              proof,
              environment: {
                ...environment,
                probeValidationIndex: probe
                  ? item.validation.findIndex(
                      (validation) => validation.command === probe,
                    )
                  : null,
              },
            },
          ];
        }),
      }))
      .map((item) => {
        if (item.kind !== "work")
          for (const field of [
            "ownedPaths",
            "sourceAssets",
            "expectedOutputRoles",
            "requiredLfsRoles",
            "minimumAssetSets",
            "executionProfile",
          ])
            delete item[field];
        if (item.kind === "aggregate") delete item.acceptance;
        return item;
      }),
  };
}

/** Complete item for transport-focused tests whose assertions cover a subset of fields. */
export function compilerItem(overrides = {}) {
  return {
    id: "work",
    kind: "work",
    priority: 0,
    title: "Work",
    goal: "Deliver result",
    brief: "Deliver result",
    acceptance: ["Result exists"],
    nonGoals: ["No deployment"],
    citations: [{ choiceIndex: 0 }],
    children: [],
    dependencies: [],
    ownedPaths: ["result.txt"],
    resources: [],
    validation: [],
    sourceAssets: [],
    expectedOutputRoles: [],
    minimumAssetSets: 0,
    requiredLfsRoles: [],
    ...overrides,
  };
}

/** Build a complete scripted transport response from this invocation's real choices. */
export function compilerResponse(prompt, items = [compilerItem()]) {
  const choices = compilerChoices(prompt);
  return {
    contextId: choices.contextId,
    items: items.map((item, index) => ({
      ...compilerItem(item),
      coverage:
        index === 0
          ? choices.obligations.map(({ obligationIndex }) => ({
              obligationIndex,
              proof: { kind: "final-review" },
              environment: {
                kind: "local",
                readiness: "available",
                probeValidationIndex: null,
                preparedBy: "",
              },
            }))
          : [],
    })),
  };
}

import { coverageObligations } from "../../dist/qa.js";
import {
  installedControllerCapabilities,
  CONTROLLER_CAPABILITIES_DIGEST,
} from "../../dist/controller-capabilities.js";
export function compilerRequest(request) {
  if (request.purpose === "diagnosis") return request;
  return {
    controllerCapabilitiesDigest: CONTROLLER_CAPABILITIES_DIGEST,
    ...request,
    controllerCapabilities: request.controllerCapabilities?.guarantees
      ? request.controllerCapabilities
      : installedControllerCapabilities(),
    compileContext: request.compileContext ?? {
      objectiveNumber: 1,
      instructions: "",
    },
    coverageObligations:
      request.coverageObligations ??
      coverageObligations(request.objective, [request.objective]),
  };
}

export function compilerObligations(prompt) {
  const choices = compilerChoices(prompt);
  const body = choices.sources
    .find((source) => source.path === "OBJECTIVE")
    .lines.map((line) => line.text)
    .join("\n");
  return coverageObligations(
    body,
    choices.obligations.map((entry) => entry.text),
  );
}
