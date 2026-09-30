import { createHash } from "node:crypto";
import type { CoverageProof, PlanningRequest, WorkGraph } from "./contracts.js";

type Schema = {
  [key: string]: unknown;
  properties?: Record<string, Schema>;
  items?: Schema;
  required?: string[];
};
type ObjectValue = Record<string, unknown>;
export interface CompilerCitationChoice {
  path: string;
  heading: string;
  content: string;
}

function object(value: unknown, label: string): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Planner ${label} must be an object`);
  return value as ObjectValue;
}
function keys(value: ObjectValue, expected: string[], label: string): void {
  if (Object.keys(value).sort().join() !== [...expected].sort().join())
    throw new Error(`Planner ${label} has unexpected or missing fields`);
}
function index(value: unknown, length: number, label: string): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) >= length
  )
    throw new Error(`Planner ${label} is invalid`);
  return value as number;
}
const integer = (length?: number): Schema => ({
  type: "integer",
  minimum: 0,
  ...(length ? { maximum: length - 1 } : {}),
});
const strict = (properties: Record<string, Schema>): Schema => ({
  type: "object",
  additionalProperties: false,
  properties,
  required: Object.keys(properties),
});
const text: Schema = { type: "string" };
/** A transient model language: choices in, canonical controller facts out. */
export function compilerWire(
  request: PlanningRequest<unknown>,
  citations: CompilerCitationChoice[],
) {
  const context = request.compileContext;
  if (
    !context ||
    !Number.isSafeInteger(context.objectiveNumber) ||
    context.objectiveNumber < 1
  )
    throw new Error("Codex compilation requires trusted compile context");
  const obligations = request.coverageObligations ?? [];
  if (!obligations.length)
    throw new Error("Codex compilation requires controller obligations");
  const guarantees = request.controllerCapabilities.guarantees;
  const contextId = createHash("sha256")
    .update(
      JSON.stringify([
        context,
        request.baseSha,
        request.sources,
        request.executionProfiles,
        request.controllerCapabilitiesDigest,
      ]),
    )
    .digest("hex");
  const itemSchema = strict({
    kind: text,
    id: text,
    title: { ...text, minLength: 1 },
    goal: { ...text, minLength: 1 },
    acceptance: { type: "array", minItems: 1, items: text },
    nonGoals: { type: "array", minItems: 1, items: text },
    citations: {
      type: "array",
      minItems: 1,
      items: strict({ choiceIndex: integer(citations.length) }),
    },
    children: { type: "array", items: text },
    dependencies: { type: "array", items: text },
    ownedPaths: {
      type: "array",
      items: {
        ...text,
        description:
          "Literal repository-relative files or trailing-slash directory prefixes; no wildcard, absolute path, empty, dot or parent components.",
      },
    },
    priority: { type: "integer" },
    resources: { type: "array", items: text },
    validation: {
      type: "array",
      items: {
        anyOf: [
          strict({
            kind: { type: "string", enum: ["source-line"] },
            sourceIndex: integer(request.sources.length),
            lineIndex: integer(),
          }),
          strict({
            kind: { type: "string", enum: ["base-observed"] },
            command: text,
            source: text,
          }),
        ],
      },
    },
    brief: { ...text, minLength: 1 },
    sourceAssets: {
      type: "array",
      items: strict({
        kind: {
          type: "string",
          enum: ["repository", "local", "github-attachment"],
        },
        path: text,
        role: text,
        mediaType: text,
        visibility: { type: "string", enum: ["private", "repository"] },
      }),
    },
    expectedOutputRoles: { type: "array", items: text },
    minimumAssetSets: { type: "integer" },
    requiredLfsRoles: { type: "array", items: text },
  });
  if (request.executionProfiles) {
    itemSchema.properties!.executionProfile = strict({
      id: {
        type: "string",
        enum: request.executionProfiles.profiles.map((profile) => profile.id),
      },
      reason: { type: "string", minLength: 1 },
    });
    itemSchema.required!.push("executionProfile");
  }
  const environment = strict({
    kind: { type: "string", enum: ["local", "real"] },
    readiness: { type: "string", enum: ["available", "prepare", "missing"] },
    probeValidationIndex: { type: ["integer", "null"], minimum: 0 },
    preparedBy: text,
  });
  const proofForms: Record<string, Record<string, Schema>> = {
    "result-command": { validationIndex: integer() },
    "result-semantic": { acceptanceIndex: integer() },
    "integrated-command": { validationIndex: integer() },
    "integrated-semantic": { acceptanceIndex: integer() },
    "final-review": {},
    "final-controller": { guaranteeIndex: integer(guarantees.length) },
    "integrated-ci": { checkName: text },
    "published-ci": { checkName: text, dependencyIndex: integer() },
  };
  const modes: Record<string, string[]> = {
    work: [
      "result-command",
      "result-semantic",
      "final-review",
      "final-controller",
    ],
    qa: [
      "integrated-command",
      "integrated-semantic",
      "integrated-ci",
      "published-ci",
    ],
    aggregate: [
      "result-command",
      "result-semantic",
      "integrated-command",
      "integrated-semantic",
      "final-review",
      "final-controller",
    ],
  };
  const readonlyConstants = {
    ownedPaths: [],
    sourceAssets: [],
    expectedOutputRoles: [],
    requiredLfsRoles: [],
    minimumAssetSets: 0,
  };
  const readonlyFields = [
    ...Object.keys(readonlyConstants),
    "executionProfile",
  ];
  const schema = strict({
    contextId: { type: "string", enum: [contextId] },
    items: {
      type: "array",
      minItems: 1,
      items: {
        anyOf: Object.entries(modes).map(([kind, forms]) => {
          const item = structuredClone(itemSchema);
          item.properties!.kind = { type: "string", enum: [kind] };
          item.properties!.coverage = {
            type: "array",
            items: strict({
              obligationIndex: integer(obligations.length),
              proof: {
                anyOf: forms.map((form) =>
                  strict({
                    kind: { type: "string", enum: [form] },
                    ...proofForms[form],
                  }),
                ),
              },
              environment,
            }),
          };
          item.required!.push("coverage");
          if (kind !== "work") {
            for (const field of readonlyFields) delete item.properties![field];
            item.required = item.required!.filter(
              (field) => !readonlyFields.includes(field),
            );
          }
          return item;
        }),
      },
    },
  });
  const data = {
    contextId,
    instructions: context.instructions,
    obligations: obligations.map((entry, obligationIndex) => ({
      obligationIndex,
      text: entry.source.text,
    })),
    citations: citations.map(
      ({ content: _content, ...entry }, choiceIndex) => ({
        choiceIndex,
        ...entry,
      }),
    ),
    sources: request.sources.map(({ content, ...source }, sourceIndex) => ({
      sourceIndex,
      ...source,
      lines: content
        .split("\n")
        .map((text, lineIndex) => ({ lineIndex, text })),
    })),
    guarantees: guarantees.map((entry, guaranteeIndex) => ({
      guaranteeIndex,
      ...entry,
    })),
    executionProfiles: request.executionProfiles ?? null,
  };
  return {
    schema,
    data,
    decode(value: unknown): WorkGraph {
      const wire = object(value, "response");
      keys(wire, ["contextId", "items"], "response");
      if (wire.contextId !== contextId)
        throw new Error("Planner context identity differs from this request");
      if (!Array.isArray(wire.items) || !wire.items.length)
        throw new Error("Planner requires at least one Work Item");
      const graph: WorkGraph = {
        objective: context.objectiveNumber,
        baseSha: request.baseSha,
        items: [],
        coverage: [],
      };
      const seen = new Set<number>();
      for (const raw of wire.items) {
        const item = structuredClone(object(raw, "item"));
        if (typeof item.kind !== "string" || !modes[item.kind])
          throw new Error("Planner Work Item kind is invalid");
        const expected = [...itemSchema.required!, "coverage"].filter(
          (field) => item.kind === "work" || !readonlyFields.includes(field),
        );
        keys(item, expected, "item");
        if (item.kind !== "work")
          Object.assign(item, structuredClone(readonlyConstants));
        if (!Array.isArray(item.citations) || !item.citations.length)
          throw new Error("Planner item needs citations");
        const chosen = item.citations.map((value) => {
          const choice = object(value, "citation");
          keys(choice, ["choiceIndex"], "citation");
          return citations[
            index(choice.choiceIndex, citations.length, "citation choiceIndex")
          ]!;
        });
        item.citations = chosen.map(({ path, heading }) => ({ path, heading }));
        if (!Array.isArray(item.validation))
          throw new Error("Planner validation must be an array");
        item.validation = item.validation.map((value) => {
          const selection = object(value, "validation selection");
          if (selection.kind === "source-line") {
            keys(
              selection,
              ["kind", "sourceIndex", "lineIndex"],
              "source line",
            );
            const source =
              request.sources[
                index(
                  selection.sourceIndex,
                  request.sources.length,
                  "sourceIndex",
                )
              ]!;
            const lines = source.content.split("\n");
            let command = lines[
              index(selection.lineIndex, lines.length, "lineIndex")
            ]!.trim()
              .replace(/^[-*]\s+/, "")
              .trim();
            if (
              command.startsWith("`") &&
              command.endsWith("`") &&
              command.length > 1
            )
              command = command.slice(1, -1);
            if (!command)
              throw new Error("Planner source command line is empty");
            return {
              command,
              provenance: "source-declared",
              source: source.path,
            };
          }
          keys(
            selection,
            ["kind", "command", "source"],
            "base-observed command",
          );
          if (
            selection.kind !== "base-observed" ||
            typeof selection.command !== "string" ||
            typeof selection.source !== "string"
          )
            throw new Error("Planner base-observed command is invalid");
          return {
            command: selection.command,
            provenance: "base-observed",
            source: selection.source,
          };
        });
        if (!Array.isArray(item.coverage))
          throw new Error("Planner item coverage must be an array");
        const coverage = item.coverage;
        delete item.coverage;
        const owner = item as unknown as WorkGraph["items"][number];
        for (const value of coverage) {
          const entry = object(value, "coverage");
          keys(entry, ["obligationIndex", "proof", "environment"], "coverage");
          const obligationIndex = index(
            entry.obligationIndex,
            obligations.length,
            "obligationIndex",
          );
          if (seen.has(obligationIndex))
            throw new Error("Planner obligationIndex is duplicated");
          seen.add(obligationIndex);
          const obligation = obligations[obligationIndex]!;
          const proof = object(entry.proof, "proof");
          if (
            typeof proof.kind !== "string" ||
            !modes[owner.kind!]!.includes(proof.kind)
          )
            throw new Error(
              "Planner proof form is not supported by its owning node",
            );
          keys(
            proof,
            ["kind", ...Object.keys(proofForms[proof.kind]!)],
            "proof",
          );
          let canonicalProof: CoverageProof;
          switch (proof.kind) {
            case "result-command":
            case "integrated-command":
              canonicalProof = {
                kind: proof.kind,
                validationIndex: index(
                  proof.validationIndex,
                  owner.validation.length,
                  "validationIndex",
                ),
              };
              break;
            case "result-semantic":
            case "integrated-semantic":
              canonicalProof = {
                kind: proof.kind,
                acceptanceIndex: index(
                  proof.acceptanceIndex,
                  owner.acceptance.length,
                  "acceptanceIndex",
                ),
              };
              break;
            case "final-review":
              canonicalProof = { kind: "final-review" };
              break;
            case "final-controller":
              canonicalProof = {
                kind: "final-controller",
                guaranteeId:
                  guarantees[
                    index(
                      proof.guaranteeIndex,
                      guarantees.length,
                      "guaranteeIndex",
                    )
                  ]!.id,
              };
              break;
            case "integrated-ci":
            case "published-ci":
              if (
                typeof proof.checkName !== "string" ||
                !proof.checkName.trim()
              )
                throw new Error("Planner CI check name is invalid");
              canonicalProof =
                proof.kind === "published-ci"
                  ? {
                      kind: proof.kind,
                      checkName: proof.checkName,
                      targetItem:
                        owner.dependencies[
                          index(
                            proof.dependencyIndex,
                            owner.dependencies.length,
                            "dependencyIndex",
                          )
                        ]!,
                    }
                  : { kind: proof.kind, checkName: proof.checkName };
              break;
            default:
              throw new Error("Planner proof form is invalid");
          }
          const env = object(entry.environment, "environment");
          keys(
            env,
            ["kind", "readiness", "probeValidationIndex", "preparedBy"],
            "environment",
          );
          const { probeValidationIndex, ...canonicalEnvironment } = env;
          const probe =
            probeValidationIndex === null
              ? ""
              : owner.validation[
                  index(
                    probeValidationIndex,
                    owner.validation.length,
                    "probeValidationIndex",
                  )
                ]!.command;
          graph.coverage!.push({
            ...structuredClone(obligation),
            itemId: owner.id,
            proof: canonicalProof,
            environment: { ...canonicalEnvironment, probe } as NonNullable<
              WorkGraph["coverage"]
            >[number]["environment"],
          });
        }
        graph.items.push(owner);
      }
      if (seen.size !== obligations.length)
        throw new Error("Planner omitted Objective coverage");
      return graph;
    },
  };
}
