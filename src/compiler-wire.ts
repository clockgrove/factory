import { createHash } from "node:crypto";
import {
  assertPlanningExecutionBounds,
  type CoverageProof,
  type PlanningRequest,
  type WorkGraph,
} from "./contracts.js";
import { ownsPath } from "./ownership.js";
import { aggregateAcceptance } from "./qa.js";
import { assertWorkItemFields, validValidationCommand } from "./scheduler.js";

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

/**
 * A well-formed response whose choices Factory refuses: an index out of range,
 * or an unavailable owner or preparation dependency.
 * The planner can revise these, unlike a response of the wrong shape.
 */
export class PlannerChoiceError extends Error {
  override readonly name = "PlannerChoiceError";
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
    throw new PlannerChoiceError(`Planner ${label} is invalid`);
  return value as number;
}
function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))
    throw new Error(`Planner ${label} must be an array of strings`);
  return value as string[];
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

/** Shared compilation/diagnosis meaning; no probe result or extra authority. */
export const COMPILER_READINESS_GUIDANCE =
  "Same-owner source-authorized setup followed by the unchanged real readiness probe uses available with empty preparedBy and ordered prerequisiteValidationIndices before probeValidationIndex. available describes that sequence for checking in the actual fresh checkout before implementation; it never claims the probe already passed or grants authority. prepare is exclusively preparation supplied by an actual declared dependency named in preparedBy, not a synonym for the owner's setup commands. Unknown runtime readiness alone does not require an operator decision when this authorized sequence can establish it. Correct a generated mismatch as planning-output only within permitted repair classes and recorded attempt limits; do not invent a dependency, waive the probe or claim readiness. Ask the operator for an actual missing source fact, permission, capability or human-owned choice.";

/** A transient model language: choices in, canonical controller facts out. */
export function compilerWire(
  request: PlanningRequest<unknown>,
  citations: CompilerCitationChoice[],
) {
  if (request.executionBounds)
    assertPlanningExecutionBounds(request.executionBounds);
  const context = request.compileContext;
  if (
    !context ||
    !Number.isSafeInteger(context.objectiveNumber) ||
    context.objectiveNumber < 1
  )
    throw new Error("Codex compilation requires trusted compile context");
  const retainedItems = new Map<string, WorkGraph["items"][number]>();
  for (const id of context.immutableItemIds ?? []) {
    const previous = context.previousGraph;
    const item = previous?.items.find((entry) => entry.id === id);
    if (
      !item ||
      retainedItems.has(id) ||
      previous?.objective !== context.objectiveNumber ||
      previous.baseSha !== request.baseSha
    )
      throw new Error(
        "Planner retained item lacks trusted current-graph identity",
      );
    retainedItems.set(id, structuredClone(item));
  }
  // The failed attempt that proposed this amendment runs again: its retained
  // choice may add owned paths, and nothing else of it changes.
  const reattempt = retainedItems.get(context.reattemptItemId ?? "")?.id;
  const obligations = request.coverageObligations ?? [];
  if (!obligations.length)
    throw new Error("Codex compilation requires controller obligations");
  const guarantees = request.controllerCapabilities.guarantees;
  const contextId = createHash("sha256")
    .update(
      JSON.stringify([
        context,
        request.baseSha,
        ...(request.approvedPlaybookPin !== undefined
          ? [request.approvedPlaybookPin]
          : []),
        ...(request.prerequisites ? [request.prerequisites] : []),
        ...(request.localExecutables ? [request.localExecutables] : []),
        ...(request.executionBounds ? [request.executionBounds] : []),
        request.sources,
        request.executionProfiles,
        request.controllerCapabilitiesDigest,
        ...(request.fixedScripts?.length ? [request.fixedScripts] : []),
        ...(request.checkNames?.length ? [request.checkNames] : []),
      ]),
    )
    .digest("hex");
  const itemSchema = strict({
    kind: text,
    id: {
      ...text,
      minLength: 1,
      description:
        "Unique Work Item ID starting with an ASCII letter or digit, followed only by ASCII letters, digits, underscores or hyphens.",
    },
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
      minItems: 1,
      items: {
        ...text,
        description:
          "Literal repository-relative files or trailing-slash directory prefixes; no wildcard, absolute path, empty, dot, parent or whitespace-padded components.",
      },
    },
    newPackages: {
      type: "array",
      items: {
        ...text,
        description:
          "Directory of each package this item creates (it adds that directory's package.json); empty when it creates none.",
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
            lineIndex: {
              ...integer(),
              description:
                "A standalone executable command line or one complete backticked command bullet; never prose around a code span.",
            },
          }),
          strict({
            kind: { type: "string", enum: ["base-observed"] },
            command: {
              ...text,
              description:
                "For package.json, use the repository's authorized npm/pnpm invocation by an existing script name, not its JSON script body. For other tracked files, use an exact standalone executable command line, without Markdown wrappers or surrounding prose.",
            },
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
        path: { ...text, minLength: 1 },
        role: { ...text, minLength: 1 },
        mediaType: { ...text, minLength: 1 },
        visibility: { type: "string", enum: ["private", "repository"] },
      }),
    },
    expectedOutputRoles: { type: "array", items: text },
    minimumAssetSets: { type: "integer", minimum: 0 },
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
  const environment = {
    anyOf: ["local", "real"].flatMap((kind) =>
      ["available", "prepare", "missing"].map((readiness) =>
        strict({
          kind: { type: "string", enum: [kind] },
          readiness: {
            type: "string",
            enum: [readiness],
            description:
              readiness === "available"
                ? "The owner can run its authorized prerequisites followed by its probe before implementation; this choice does not claim readiness passed."
                : readiness === "prepare"
                  ? "An actual declared dependency supplies preparation; same-owner prerequisite commands do not use prepare."
                  : "A source-required prerequisite is missing; this blocks execution for a source decision.",
          },
          probeValidationIndex:
            kind === "real"
              ? integer()
              : { type: ["integer", "null"], minimum: 0 },
          prerequisiteValidationIndices: { type: "array", items: integer() },
          preparedBy:
            readiness === "prepare"
              ? {
                  ...text,
                  minLength: 1,
                  description:
                    "ID of an actual preparation item in this owner's dependencies.",
                }
              : { type: "string", enum: [""] },
        }),
      ),
    ),
  };
  // CI checks are chosen from the names the base and Objective define, so an
  // invented name cannot be expressed.
  const checkNames = request.checkNames ?? [];
  const checkIndex = integer(checkNames.length);
  const proofForms: Record<string, Record<string, Schema>> = {
    "result-command": { validationIndex: integer() },
    "result-semantic": { acceptanceIndex: integer() },
    "integrated-command": { validationIndex: integer() },
    "integrated-semantic": { acceptanceIndex: integer() },
    "final-review": {},
    "final-controller": { guaranteeIndex: integer(guarantees.length) },
    "integrated-ci": { checkIndex },
    "published-ci": { checkIndex, dependencyIndex: integer() },
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
      ...(checkNames.length ? ["integrated-ci", "published-ci"] : []),
      "final-review",
      "final-controller",
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
  // Array position selects the controller obligation. The model chooses its
  // owner once; it cannot repeat or omit an obligation index across items.
  const coverageSchema: Schema = {
    type: "array",
    minItems: obligations.length,
    maxItems: obligations.length,
    items: strict({
      itemId: { ...text, minLength: 1 },
      proof: {
        description:
          "Choose a kind allowed for the owner's item kind by proofModesByItemKind in the compiler choices.",
        anyOf: Object.keys(proofForms)
          .filter((form) => !form.endsWith("-ci") || checkNames.length)
          .map((form) =>
            strict({
              kind: { type: "string", enum: [form] },
              ...proofForms[form],
            }),
          ),
      },
      environment,
    }),
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
    "newPackages",
    "executionProfile",
  ];
  const schema = strict({
    contextId: { type: "string", enum: [contextId] },
    requiredPreIntegrationChecks: {
      type: "array",
      ...(checkNames.length ? {} : { maxItems: 0 }),
      items: strict({
        checkIndex,
        sourceIndex: integer(request.sources.length),
      }),
    },
    items: {
      type: "array",
      minItems: 1,
      items: {
        anyOf: [
          ...Object.entries(modes).map(([kind]) => {
            const item = structuredClone(itemSchema);
            item.properties!.kind = { type: "string", enum: [kind] };
            item.properties!.children = {
              type: "array",
              ...(kind === "aggregate" ? { minItems: 1 } : { maxItems: 0 }),
              items: text,
            };
            if (kind !== "work") {
              for (const field of readonlyFields)
                delete item.properties![field];
              item.required = item.required!.filter(
                (field) => !readonlyFields.includes(field),
              );
            }
            if (kind === "aggregate") {
              delete item.properties!.acceptance;
              item.required = item.required!.filter(
                (field) => field !== "acceptance",
              );
            }
            return item;
          }),
          ...Object.keys(modes).flatMap((kind) => {
            const ids = [...retainedItems.values()]
              .filter((item) => (item.kind ?? "work") === kind)
              .map((item) => item.id);
            const choice = (ids: string[], more: Record<string, Schema> = {}) =>
              strict({
                kind: { type: "string", enum: ["retained"] },
                id: { type: "string", enum: ids },
                ...more,
              });
            const kept = ids.filter((id) => id !== reattempt);
            return [
              ...(kept.length ? [choice(kept)] : []),
              ...(reattempt && ids.includes(reattempt)
                ? [
                    choice([reattempt], {
                      addedOwnedPaths: { type: "array", items: text },
                    }),
                  ]
                : []),
            ];
          }),
        ],
      },
    },
    coverage: coverageSchema,
  });
  // Stable content first, so repeated and revised compilations share a
  // provider-cache prefix; the revision-specific parts and the context
  // identity, which hashes them, come last.
  const data = {
    proofModesByItemKind: structuredClone(modes),
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
    executionBounds: request.executionBounds ?? null,
    ...(request.fixedScripts?.length
      ? { fixedScripts: request.fixedScripts }
      : {}),
    checkNames: checkNames.map((name, checkIndex) => ({ checkIndex, name })),
    instructions: context.instructions,
    ...(retainedItems.size
      ? {
          retainedItems: [...retainedItems.values()].map((item) => ({
            id: item.id,
            kind: item.kind ?? "work",
            acceptance: item.acceptance,
            validation: item.validation,
            dependencies: item.dependencies,
          })),
        }
      : {}),
    contextId,
  };
  return {
    schema,
    data,
    decode(value: unknown): WorkGraph {
      const wire = object(value, "response");
      keys(
        wire,
        ["contextId", "items", "coverage", "requiredPreIntegrationChecks"],
        "response",
      );
      if (wire.contextId !== contextId)
        throw new Error("Planner context identity differs from this request");
      if (!Array.isArray(wire.items) || !wire.items.length)
        throw new Error("Planner requires at least one Work Item");
      if (
        !Array.isArray(wire.coverage) ||
        wire.coverage.length !== obligations.length
      )
        throw new PlannerChoiceError(
          "Planner requires one coverage entry per obligation in supplied order",
        );
      if (!Array.isArray(wire.requiredPreIntegrationChecks))
        throw new Error("Planner pre-integration checks must be an array");
      const requiredPreIntegrationChecks =
        wire.requiredPreIntegrationChecks.map((raw) => {
          const gate = object(raw, "pre-integration check");
          keys(gate, ["checkIndex", "sourceIndex"], "pre-integration check");
          const source =
            request.sources[
              index(gate.sourceIndex, request.sources.length, "sourceIndex")
            ]!;
          return {
            checkName:
              checkNames[
                index(gate.checkIndex, checkNames.length, "checkIndex")
              ]!,
            source: {
              path: source.path,
              digest: createHash("sha256").update(source.content).digest("hex"),
              text: source.content,
            },
          };
        });
      const graph: WorkGraph = {
        objective: context.objectiveNumber,
        baseSha: request.baseSha,
        items: [],
        coverage: [],
        requiredPreIntegrationChecks,
      };
      const referenced = new Set<string>();
      for (const raw of wire.items) {
        let item = structuredClone(object(raw, "item"));
        let newPackages: string[] = [];
        if (item.kind === "retained") {
          const retained =
            typeof item.id === "string"
              ? retainedItems.get(item.id)
              : undefined;
          const widens = retained !== undefined && retained.id === reattempt;
          keys(
            item,
            ["kind", "id", ...(widens ? ["addedOwnedPaths"] : [])],
            "retained item",
          );
          if (!retained || referenced.has(retained.id))
            throw new PlannerChoiceError(
              "Planner retained item is unavailable or duplicated",
            );
          referenced.add(retained.id);
          const added = widens
            ? strings(item.addedOwnedPaths, "addedOwnedPaths")
            : [];
          item = structuredClone(retained) as unknown as ObjectValue;
          if (widens)
            item.ownedPaths = [
              ...retained.ownedPaths,
              ...new Set(
                added.filter((path) => !ownsPath(path, retained.ownedPaths)),
              ),
            ];
        } else {
          if (typeof item.id === "string" && retainedItems.has(item.id))
            throw new Error(
              "Planner must reference started Work Items instead of redefining them",
            );
          if (typeof item.kind !== "string" || !modes[item.kind])
            throw new Error("Planner Work Item kind is invalid");
          const expected = itemSchema.required!.filter(
            (field) =>
              (item.kind === "work" || !readonlyFields.includes(field)) &&
              (item.kind !== "aggregate" || field !== "acceptance"),
          );
          keys(item, expected, "item");
          if (item.kind === "aggregate")
            item.acceptance = aggregateAcceptance(
              item as unknown as WorkGraph["items"][number],
              context.previousGraph,
            );
          if (item.kind !== "work")
            Object.assign(item, structuredClone(readonlyConstants));
          else newPackages = strings(item.newPackages, "newPackages");
          delete item.newPackages;
          if (!Array.isArray(item.sourceAssets))
            throw new Error("Planner sourceAssets must be an array");
          for (const rawAsset of item.sourceAssets) {
            const asset = object(rawAsset, "source asset");
            keys(
              asset,
              ["kind", "path", "role", "mediaType", "visibility"],
              "source asset",
            );
          }
          if (!Array.isArray(item.citations) || !item.citations.length)
            throw new Error("Planner item needs citations");
          const chosen = item.citations.map((value) => {
            const choice = object(value, "citation");
            keys(choice, ["choiceIndex"], "citation");
            return citations[
              index(
                choice.choiceIndex,
                citations.length,
                "citation choiceIndex",
              )
            ]!;
          });
          item.citations = chosen.map(({ path, heading }) => ({
            path,
            heading,
          }));
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
              if (command.startsWith("`")) {
                const literal = /^`([^`]+)`$/.exec(command);
                if (!literal)
                  throw new PlannerChoiceError(
                    "Planner source line is prose around a code span; select a standalone command line",
                  );
                command = literal[1]!;
              }
              if (!validValidationCommand(command))
                throw new PlannerChoiceError(
                  "Planner source line is not an executable command line",
                );
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
        }
        assertWorkItemFields(item);
        // A new package the item declares becomes literal manifest ownership,
        // the fact workspace validation checks (#803).
        for (const directory of newPackages) {
          const manifest = `${directory.replace(/\/$/, "")}/package.json`;
          if (!ownsPath(manifest, item.ownedPaths))
            throw new PlannerChoiceError(
              `Planner item ${item.id} creates the package ${directory} without owning ${manifest}`,
            );
          if (!item.ownedPaths.includes(manifest))
            item.ownedPaths.push(manifest);
        }
        graph.items.push(item as unknown as WorkGraph["items"][number]);
      }
      for (const [obligationIndex, value] of wire.coverage.entries()) {
        const entry = object(value, "coverage");
        keys(entry, ["itemId", "proof", "environment"], "coverage");
        const owners = graph.items.filter((item) => item.id === entry.itemId);
        if (owners.length !== 1)
          throw new PlannerChoiceError(
            "Planner coverage must select one existing unambiguous owner",
          );
        const owner = owners[0]!;
        const ownerKind = owner.kind ?? "work";
        const allowedProofModes = modes[ownerKind]!;
        const obligation = obligations[obligationIndex]!;
        const proof = object(entry.proof, "proof");
        if (
          typeof proof.kind !== "string" ||
          !allowedProofModes.includes(proof.kind)
        )
          throw new PlannerChoiceError(
            `Planner coverage ${obligationIndex} selects ${JSON.stringify(proof.kind)} for ${owner.id} (${ownerKind}); allowed proof kinds: ${allowedProofModes.join(", ")}`,
          );
        keys(proof, ["kind", ...Object.keys(proofForms[proof.kind]!)], "proof");
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
          case "published-ci": {
            const checkName =
              checkNames[
                index(proof.checkIndex, checkNames.length, "checkIndex")
              ]!;
            canonicalProof =
              proof.kind === "published-ci"
                ? {
                    kind: proof.kind,
                    checkName,
                    targetItem:
                      owner.dependencies[
                        index(
                          proof.dependencyIndex,
                          owner.dependencies.length,
                          "dependencyIndex",
                        )
                      ]!,
                  }
                : { kind: proof.kind, checkName };
            break;
          }
          default:
            throw new Error("Planner proof form is invalid");
        }
        const env = object(entry.environment, "environment");
        keys(
          env,
          [
            "kind",
            "readiness",
            "probeValidationIndex",
            "prerequisiteValidationIndices",
            "preparedBy",
          ],
          "environment",
        );
        const {
          probeValidationIndex,
          prerequisiteValidationIndices,
          ...canonicalEnvironment
        } = env;
        if (
          !["local", "real"].includes(String(env.kind)) ||
          !["available", "prepare", "missing"].includes(
            String(env.readiness),
          ) ||
          typeof env.preparedBy !== "string"
        )
          throw new Error("Planner environment readiness is invalid");
        if (
          env.readiness === "prepare"
            ? !env.preparedBy ||
              !owner.dependencies.includes(env.preparedBy) ||
              !graph.items.some((item) => item.id === env.preparedBy)
            : env.preparedBy !== ""
        )
          throw new PlannerChoiceError(
            "Planner prepare requires an actual preparation dependency; same-owner setup uses available with ordered prerequisites and its probe",
          );
        if (env.kind === "real" && probeValidationIndex === null)
          throw new PlannerChoiceError(
            "Planner real environment requires an exact authorized readiness probe",
          );
        if (!Array.isArray(prerequisiteValidationIndices))
          throw new Error(
            "Readiness prerequisites must be ordered validation indices",
          );
        let previousPrerequisite = -1;
        const prerequisites = prerequisiteValidationIndices.map((value) => {
          const selected = index(
            value,
            owner.validation.length,
            "prerequisiteValidationIndices",
          );
          if (
            probeValidationIndex === null ||
            selected <= previousPrerequisite ||
            typeof probeValidationIndex !== "number" ||
            selected >= probeValidationIndex
          )
            throw new Error(
              "Readiness prerequisites must be unique, ordered and precede their probe",
            );
          previousPrerequisite = selected;
          return owner.validation[selected]!.command;
        });
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
          environment: {
            ...canonicalEnvironment,
            probe,
            ...(prerequisites.length ? { prerequisites } : {}),
          } as NonNullable<WorkGraph["coverage"]>[number]["environment"],
        });
      }
      if (referenced.size !== retainedItems.size)
        throw new PlannerChoiceError("Planner omitted retained Work Items");
      if (
        graph.items.some(
          (item) =>
            item.kind === "qa" &&
            !graph.coverage!.some((entry) => entry.itemId === item.id),
        )
      )
        throw new PlannerChoiceError(
          "Planner QA node has no acceptance coverage",
        );
      return graph;
    },
  };
}
