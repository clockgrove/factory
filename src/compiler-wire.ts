import {
  assertDeclaredWorkCondition,
  assertDeclaredConditions,
} from "./adaptive-routing.js";
import { createHash } from "node:crypto";
import { assertDiscoverySpecification } from "./discovery.js";
import { assertGraphExpansionEnvelope } from "./graph-expansion.js";
import {
  assertHumanPlanningDependency,
  assertContextRequest,
  assertPlanningContextPacket,
  type PlanningTurnResponse,
} from "./compiler/context.js";
import {
  assertPlanningExecutionBounds,
  type CoverageObligation,
  type CoverageProof,
  type PlanningRequest,
  type WorkGraph,
} from "./contracts.js";
import { PlannerDecision } from "./fault.js";
import {
  assertChildObjectives,
  type ChildObjectiveSpec,
} from "./objective-split.js";
import { ownsPath } from "./ownership.js";
import {
  aggregateAcceptance,
  coverageCriterion,
  sourceDigest,
  sourceLines,
  sourceObligationId,
} from "./qa.js";
import { assertWorkItemFields, validValidationCommand } from "./scheduler.js";
import { WORK_ITEM_ENTRY_SIGNAL } from "./compiler/work-item-rubric.js";

type Schema = {
  [key: string]: unknown;
  properties?: Record<string, Schema>;
  items?: Schema;
  required?: string[];
};
type ObjectValue = Record<string, unknown>;
interface CompilerCitationChoice {
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
  /** The graph items the refusal concerns, so a revision gets their cited sections. */
  constructor(
    message: string,
    readonly itemIds: string[] = [],
  ) {
    super(message);
  }
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

/**
 * A line-number reference next to a file name in an acceptance entry
 * (`store.ts:88`, `store.ts#L88`, `store.ts line 88`, `store.ts (lines
 * 40-210)`). Structural only: a file name with an extension directly followed
 * by a line marker. Only source-file extensions count, so host:port and data
 * files ("data.csv line 1") do not match, nor do URLs or "line 1" of output.
 */
const LINE_REFERENCE =
  /(?<![:/\w.-])[\w.-]+(?:\/[\w.-]+)*\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|rb|php|cs|c|cc|cpp|h|hpp|swift|sh|sql|css|scss|vue|svelte|md|ya?ml|toml|json|html)`?(?::\d+\b|#L\d+\b|\s*,?\s*\(?\s*(?:around\s+|near\s+|at\s+)?lines?\s+\d+)/i;

/**
 * The plan standard's deterministic lint, run before paid review on the
 * items the planner defined in this answer: an item above the entry signal
 * states why it is one outcome, and no acceptance entry cites a line. An
 * amendment carries pending items over and has no correction channel for
 * these, so it is not linted; graph review checks 3 and 8 judge it there.
 */
function planStandardLint(item: ObjectValue, reason: string | null): string[] {
  if (!Array.isArray(item.acceptance)) return [];
  const findings: string[] = [];
  if (item.acceptance.length > WORK_ITEM_ENTRY_SIGNAL && reason === null)
    findings.push(
      `Work Item ${String(item.id)} has ${item.acceptance.length} acceptance entries, above the signal of ${WORK_ITEM_ENTRY_SIGNAL}, and no oneOutcomeReason: split it into one item per outcome, or state in oneOutcomeReason why it is one outcome`,
    );
  for (const [at, entry] of item.acceptance.entries())
    if (typeof entry === "string" && LINE_REFERENCE.test(entry))
      findings.push(
        `Work Item ${String(item.id)} acceptance ${at} cites a line number: state the behaviour instead; the worker finds the lines in the code`,
      );
  return findings;
}

/** The environment a null planner choice stands for: no setup, no probe. */
const DEFAULT_ENVIRONMENT = {
  kind: "local",
  readiness: "available",
  probeValidationIndex: null,
  prerequisiteValidationIndices: [],
  preparedBy: "",
};

/** Shared compilation/diagnosis meaning; no probe result or extra authority. */
export const COMPILER_READINESS_GUIDANCE =
  "Same-owner source-authorized setup followed by the unchanged real readiness probe uses available with empty preparedBy and ordered prerequisiteValidationIndices before probeValidationIndex. available describes that sequence for checking in the actual fresh checkout before implementation; it never claims the probe already passed or grants authority. prepare is exclusively preparation supplied by an actual declared dependency named in preparedBy, not a synonym for the owner's setup commands. Unknown runtime readiness alone does not require an operator decision when this authorized sequence can establish it. Correct a generated mismatch as planning-output only within permitted repair classes and recorded attempt limits; do not invent a dependency, waive the probe or claim readiness. Ask the operator for an actual missing source fact, permission, capability or human-owned choice through decisionRequired.";

/**
 * A retained answer from an earlier release, in this wire's terms: a semantic
 * proof drops its acceptance entry (owner-level proof judges the obligation
 * itself) and a defined item gains a null oneOutcomeReason. Only the revision
 * base changes; the full decode still judges every resulting choice.
 */
function currentAnswer(answer: unknown): unknown {
  if (!answer || typeof answer !== "object" || Array.isArray(answer))
    return answer;
  const plan = structuredClone(answer) as ObjectValue;
  const proofOf = (entry: unknown) => {
    const proof = (entry as { proof?: ObjectValue } | null)?.proof;
    if (
      proof &&
      typeof proof === "object" &&
      (proof.kind === "result-semantic" || proof.kind === "integrated-semantic")
    )
      delete proof.acceptanceIndex;
  };
  if (Array.isArray(plan.coverage)) plan.coverage.forEach(proofOf);
  if (Array.isArray(plan.sourceObligations))
    for (const entry of plan.sourceObligations)
      proofOf((entry as { disposition?: unknown } | null)?.disposition);
  if (Array.isArray(plan.items))
    for (const item of plan.items as (ObjectValue | null)[])
      if (
        item &&
        typeof item === "object" &&
        item.kind !== "retained" &&
        !Object.hasOwn(item, "oneOutcomeReason")
      )
        item.oneOutcomeReason = null;
  return plan;
}

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
        ...(request.contextLookup ? [request.contextLookup] : []),
        request.executionProfiles,
        request.controllerCapabilitiesDigest,
        ...(request.fixedScripts?.length ? [request.fixedScripts] : []),
        ...(request.checkNames?.length ? [request.checkNames] : []),
      ]),
    )
    .digest("hex");
  // The decoder checks the identity. Keeping it out of the schema keeps the
  // schema byte-stable across corrections, so a provider can reuse its cache.
  const contextIdSchema: Schema = {
    type: "string",
    description: "Copy the contextId supplied with the compiler choices.",
  };
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
      items: strict({
        path: {
          ...text,
          minLength: 1,
          description:
            "A pinned citation choice's path, or any regular UTF-8 repository file path at the base.",
        },
        heading: {
          ...text,
          description:
            'Exact Markdown heading text without # marks, or "" for the whole file.',
        },
      }),
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
    oneOutcomeReason: {
      description: `null unless acceptance has more than ${WORK_ITEM_ENTRY_SIGNAL} entries; then why this item is one outcome that separate items cannot verify. Factory adds it to the brief.`,
      anyOf: [{ type: "null" }, { ...text, minLength: 1 }],
    },
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
    media: {
      description:
        "null for ordinary work. Media work declares its staged outputs.",
      anyOf: [
        { type: "null" },
        strict({
          expectedOutputRoles: {
            type: "array",
            minItems: 1,
            items: text,
            description:
              "Roles of staged media outputs, never code, tests or documentation categories.",
          },
          // Numeric bounds are not supported by every structured-output grammar.
          // A decimal pattern enforces positivity before strict safe-integer decoding.
          minimumAssetSets: { type: "string", pattern: "^[1-9][0-9]*$" },
          requiredLfsRoles: { type: "array", items: text },
        }),
      ],
    },
  });
  if (request.contextLookup) {
    itemSchema.properties!.scheduling = {
      description:
        "Optional advisory duration for one useful batch, including preparation, validation and review. Null means unknown; an estimate grants no capacity or deadline authority.",
      anyOf: [
        strict({
          estimatedDurationMs: { type: "string", pattern: "^[1-9][0-9]*$" },
          reason: { ...text, minLength: 1 },
        }),
        { type: "null" },
      ],
    };
    itemSchema.required!.push("scheduling");
    itemSchema.properties!.condition = {
      anyOf: [
        { type: "null" },
        strict({
          conditionId: { ...text, minLength: 1 },
          when: { type: "boolean" },
        }),
      ],
    };
    itemSchema.required!.push("condition");
    itemSchema.properties!.discoveryInputs = {
      type: "array",
      items: strict({
        producerItemId: { ...text, minLength: 1 },
        role: { ...text, minLength: 1 },
        fields: {
          type: "array",
          minItems: 1,
          items: {
            type: "string",
            enum: ["path", "mode", "blobSha", "contentRef", "classification"],
          },
        },
      }),
    };
    itemSchema.required!.push("discoveryInputs");
  }
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
  // null selects the default environment (see DEFAULT_ENVIRONMENT), so the
  // common case costs the planner no output.
  const environment = {
    description:
      "null for the default: local, available, null probe, no prerequisites or preparedBy.",
    anyOf: [
      { type: "null" },
      {
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
                      : "A source-required external environment prerequisite is missing: name its authorized probe or prerequisite commands. It asks the operator to establish it. Use decisionRequired, not missing, when the Objective as written does not allow covering the criterion.",
              },
              probeValidationIndex:
                kind === "real"
                  ? integer()
                  : { type: ["integer", "null"], minimum: 0 },
              prerequisiteValidationIndices: {
                type: "array",
                items: integer(),
              },
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
      },
    ],
  };
  // CI checks are chosen from the names the base and Objective define, so an
  // invented name cannot be expressed.
  const checkNames = request.checkNames ?? [];
  const checkIndex = integer(checkNames.length);
  const proofForms: Record<string, Record<string, Schema>> = {
    "result-command": { validationIndex: integer() },
    "result-semantic": {},
    "integrated-command": { validationIndex: integer() },
    "integrated-semantic": {},
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
    ...(request.contextLookup ? { discovery: [] } : {}),
    aggregate: [
      "result-command",
      "result-semantic",
      "integrated-command",
      "integrated-semantic",
      "final-review",
      "final-controller",
    ],
  };
  // A new plan may split the Objective into child Objectives, unless it is
  // itself a child: children never split again. An obligation a stub child
  // carries names that child's key as its itemId.
  const splittable =
    !context.previousGraph && !request.contextLookup && !context.splitChild;
  const proofFields: Record<string, Schema> = {
    itemId: { ...text, minLength: 1 },
    proof: {
      description:
        "Choose a kind allowed for the owner's item kind by proofModesByItemKind in the compiler choices.",
      anyOf: [
        ...Object.keys(proofForms)
          .filter((form) => !form.endsWith("-ci") || checkNames.length)
          .map((form) =>
            strict({
              kind: { type: "string", enum: [form] },
              ...proofForms[form],
            }),
          ),
        ...(splittable
          ? [
              strict({
                kind: {
                  type: "string",
                  enum: ["child-objective"],
                  description:
                    "Only in a split: a stub child Objective carries this obligation; itemId is that child's key.",
                },
              }),
            ]
          : []),
      ],
    },
    environment,
  };
  // Array position selects the controller obligation. The model chooses its
  // owner once; it cannot repeat or omit an obligation index across items.
  const coverageSchema: Schema = {
    type: "array",
    minItems: obligations.length,
    maxItems: obligations.length,
    items: strict(proofFields),
  };
  // Exit items the planner extracts from cited sources. Each names its exact
  // line range and is either proved like an Objective obligation or left out
  // with a reason that cites Objective lines.
  const sourceObligationsSchema: Schema = {
    type: "array",
    items: strict({
      sourceIndex: integer(request.sources.length),
      firstLineIndex: integer(),
      lastLineIndex: integer(),
      statement: {
        description:
          "null when the cited lines state the exit item on their own; Factory then uses those exact lines.",
        anyOf: [{ type: "null" }, { ...text, minLength: 1 }],
      },
      disposition: {
        anyOf: [
          strict({
            kind: { type: "string", enum: ["covered"] },
            ...proofFields,
          }),
          strict({
            kind: { type: "string", enum: ["out-of-scope"] },
            reason: { ...text, minLength: 1 },
            objectiveLineIndices: {
              type: "array",
              minItems: 1,
              items: integer(),
              description:
                "Lines of the OBJECTIVE source whose constraints or out-of-scope text justify leaving this exit item out.",
            },
          }),
        ],
      },
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
    "ownedPaths",
    "sourceAssets",
    "media",
    "newPackages",
    "executionProfile",
    "condition",
  ];
  const outputFields = [
    "expectedOutputRoles",
    "minimumAssetSets",
    "requiredLfsRoles",
  ];
  const schema = strict({
    contextId: contextIdSchema,
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
          ...Object.entries(modes).flatMap(([kind]) => {
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
            if (kind === "discovery") {
              item.properties!.validation = {
                type: "array",
                maxItems: 0,
                items: strict({ kind: text }),
              };
              item.properties!.discovery = strict({
                mode: { type: "string", enum: ["inventory", "semantic"] },
                selectors: { type: "array", minItems: 1, items: text },
                schema: {
                  type: "string",
                  enum: ["factory.repository-inventory/v1"],
                },
                role: { ...text, minLength: 1 },
                completeness: { type: "string", enum: ["complete"] },
                allowance: strict({
                  maxEntries: { type: "integer", minimum: 1 },
                  maxBytes: { type: "integer", minimum: 1 },
                  maxAttempts: { type: "integer", minimum: 1 },
                }),
              });
              item.required!.push("discovery");
            }
            if (kind === "aggregate") {
              delete item.properties!.acceptance;
              item.required = item.required!.filter(
                (field) => field !== "acceptance",
              );
            }
            return [item];
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
    sourceObligations: sourceObligationsSchema,
    ...(splittable
      ? {
          split: {
            description:
              "null for one Work Item graph. Otherwise the child Objectives that replace it: every Work Item belongs to one ready child through itemIds, every Objective obligation goes to one child, and every child owns at least one.",
            anyOf: [
              { type: "null" },
              strict({
                children: {
                  type: "array",
                  minItems: 2,
                  maxItems: 16,
                  items: strict({
                    key: {
                      type: "string",
                      pattern: "^[a-z][a-z0-9-]{0,63}$",
                      description:
                        "Stable child key: lowercase letters, digits and hyphens.",
                    },
                    title: { ...text, minLength: 1 },
                    goal: {
                      ...text,
                      minLength: 1,
                      description:
                        "One paragraph: what this child delivers and what it leaves to its siblings.",
                    },
                    sources: {
                      type: "array",
                      items: itemSchema.properties!.citations!.items!,
                      description:
                        "The sections and files this child's own Objective cites as its Sources, by reference; never the OBJECTIVE.",
                    },
                    dependsOn: {
                      type: "array",
                      items: text,
                      description:
                        "Keys of earlier children whose merged code this child builds on; empty for a ready child.",
                    },
                    itemIds: {
                      type: "array",
                      items: text,
                      description:
                        "A ready child's Work Items; empty for a stub, which is compiled after its dependencies merge.",
                    },
                  }),
                },
              }),
            ],
          },
        }
      : {}),
    decisionRequired: {
      description:
        "null when the graph covers every obligation. Otherwise the one obligation the Objective as written does not let you cover (for example, it needs a change the Objective forbids or a human-owned choice) and the concrete question the operator must answer; Factory asks it before using this graph.",
      anyOf: [
        { type: "null" },
        strict({
          obligationIndex: integer(obligations.length),
          question: { ...text, minLength: 1, maxLength: 4096 },
        }),
      ],
    },
  });
  if (request.contextLookup) {
    const template = structuredClone(itemSchema);
    template.properties!.kind = { type: "string", enum: ["work"] };
    template.properties!.children = { type: "array", maxItems: 0, items: text };
    template.properties!.newPackages = {
      type: "array",
      maxItems: 0,
      items: text,
    };
    template.properties!.sourceAssets = {
      type: "array",
      maxItems: 0,
      items: strict({ kind: text }),
    };
    template.properties!.discoveryInputs = {
      type: "array",
      maxItems: 0,
      items: strict({ producerItemId: text }),
    };
    template.properties!.media = { type: "null" };
    schema.properties!.expansions = {
      type: "array",
      items: strict({
        schemaVersion: { type: "integer", enum: [1] },
        id: { ...text, minLength: 1 },
        input: strict({
          producerItemId: text,
          role: text,
          schema: { type: "string", enum: ["factory.repository-inventory/v1"] },
        }),
        selectors: { type: "array", minItems: 1, items: text },
        workShape: { type: "string", enum: ["migration", "cross-cutting-fix"] },
        selection: {
          anyOf: [
            strict({ kind: { type: "string", enum: ["all-regular-files"] } }),
            strict({
              kind: { type: "string", enum: ["classified"] },
              included: { type: "array", minItems: 1, items: text },
              excluded: { type: "array", items: text },
            }),
          ],
        },
        batching: strict({ maxFilesPerChild: { type: "integer", minimum: 1 } }),
        limits: strict({
          maxChildren: { type: "integer", minimum: 1 },
          maxIterations: { type: "integer", enum: [1] },
        }),
        resources: { type: "array", items: text },
        eligibleProfileIds: { type: "array", items: text },
        dependencies: { type: "array", items: text },
        integrationBarrierItemIds: { type: "array", minItems: 1, items: text },
        empty: { type: "string", enum: ["settle-without-children"] },
        template,
      }),
    };
    schema.required!.push("expansions");
    schema.properties!.conditions = {
      type: "array",
      items: strict({
        schemaVersion: { type: "integer", enum: [1] },
        id: { ...text, minLength: 1 },
        input: strict({
          producerItemId: text,
          role: text,
          schema: { type: "string", enum: ["factory.repository-inventory/v1"] },
        }),
        predicate: {
          anyOf: [
            strict({ kind: { type: "string", enum: ["inventory-empty"] } }),
            strict({
              kind: { type: "string", enum: ["has-classification"] },
              classification: { ...text, minLength: 1 },
              otherClassifications: {
                type: "array",
                items: { ...text, minLength: 1 },
              },
            }),
          ],
        },
      }),
    };
    schema.required!.push("conditions");
  }
  // A revision answers with only its changes to the current plan. Factory
  // applies them by id and index alone; the full decode below still judges
  // every resulting choice.
  const revision = context.revision && {
    ...context.revision,
    answer: currentAnswer(context.revision.answer),
  };
  const nullable = (entry: Schema): Schema =>
    Array.isArray(entry.anyOf) &&
    (entry.anyOf as Schema[]).some((branch) => branch.type === "null")
      ? entry
      : { anyOf: [{ type: "null" }, entry] };
  const replaceable = [
    "sourceObligations",
    "requiredPreIntegrationChecks",
    ...(request.contextLookup ? ["expansions", "conditions"] : []),
  ];
  const changeSchema = strict({
    contextId: contextIdSchema,
    items: {
      type: "array",
      description:
        "New Work Items in full, and complete replacements of current items with the same id.",
      items: schema.properties!.items!.items!,
    },
    itemEdits: {
      type: "array",
      description:
        "Field replacements for current items: null keeps that field's current value.",
      items: strict({
        id: { ...text, minLength: 1 },
        ...Object.fromEntries(
          Object.entries(itemSchema.properties!)
            .filter(([field]) => field !== "id" && field !== "kind")
            .map(([field, entry]) => [field, nullable(entry)]),
        ),
        acceptanceReplace: {
          type: "array",
          description:
            "Rewrites single acceptance entries in place; the other indices keep their meaning.",
          items: strict({ index: integer(), text: { ...text, minLength: 1 } }),
        },
        acceptanceAppend: {
          type: "array",
          description:
            "New acceptance entries after the current ones; existing indices keep their meaning.",
          items: { ...text, minLength: 1 },
        },
      }),
    },
    removedItemIds: { type: "array", items: text },
    coverage: {
      type: "array",
      description:
        "Replaced coverage entries; obligationIndex selects the entry, and the rest stay.",
      items: strict({
        obligationIndex: integer(obligations.length),
        ...proofFields,
      }),
    },
    ...Object.fromEntries(
      replaceable.map((field) => [
        field,
        {
          ...nullable(schema.properties![field]!),
          description:
            "null keeps the current list; otherwise the complete new list.",
        },
      ]),
    ),
    decisionRequired: schema.properties!.decisionRequired!,
    ...(splittable ? { split: schema.properties!.split! } : {}),
  });
  const graphSchema = revision ? changeSchema : schema;
  /** The current plan with these changes applied; structure only. */
  const applyRevision = (value: unknown): unknown => {
    const plan = structuredClone(object(revision!.answer, "current plan"));
    const change = object(value, "revision");
    keys(change, Object.keys(changeSchema.properties!), "revision");
    if (!Array.isArray(plan.items) || !Array.isArray(plan.coverage))
      throw new Error("Planner current plan is invalid");
    for (const field of ["items", "itemEdits", "coverage"])
      if (!Array.isArray(change[field]))
        throw new Error(`Planner revision ${field} must be an array`);
    const items = plan.items as unknown[];
    const coverage = plan.coverage as unknown[];
    const touched = new Set<string>();
    const position = (id: unknown, label: string) => {
      if (typeof id !== "string" || touched.has(id))
        throw new PlannerChoiceError(
          `Planner revision ${label} must name each item id at most once`,
        );
      touched.add(id);
      return items.findIndex((entry) => object(entry, "item").id === id);
    };
    for (const raw of change.items as unknown[]) {
      const item = object(raw, "item");
      const at = position(item.id, "items");
      if (at < 0) items.push(item);
      else items[at] = item;
    }
    for (const raw of change.itemEdits as unknown[]) {
      const edit = object(raw, "item edit");
      const at = position(edit.id, "itemEdits");
      if (at < 0)
        throw new PlannerChoiceError(
          `Planner revision edits ${JSON.stringify(edit.id)}, which is not a current item`,
        );
      const item = object(items[at], "item");
      const { acceptanceReplace, acceptanceAppend, ...fields } = edit;
      if (!Array.isArray(acceptanceReplace) || !Array.isArray(acceptanceAppend))
        throw new Error("Planner acceptance edits must be arrays");
      if (acceptanceReplace.length || acceptanceAppend.length) {
        if (!Array.isArray(item.acceptance) || fields.acceptance !== null)
          throw new PlannerChoiceError(
            `Planner revision edits acceptance entries of ${String(edit.id)} without exactly one current acceptance list`,
          );
        const acceptance = [...item.acceptance];
        const rewritten = new Set<number>();
        for (const raw of acceptanceReplace) {
          const entry = object(raw, "acceptance edit");
          const at = index(entry.index, acceptance.length, "acceptance index");
          if (rewritten.has(at) || typeof entry.text !== "string")
            throw new PlannerChoiceError(
              "Planner revision rewrites one acceptance entry more than once",
            );
          rewritten.add(at);
          acceptance[at] = entry.text;
        }
        item.acceptance = [...acceptance, ...acceptanceAppend];
      }
      for (const [field, entry] of Object.entries(fields)) {
        if (field === "id" || entry === null) continue;
        if (!Object.hasOwn(item, field))
          throw new PlannerChoiceError(
            `Planner revision sets ${field} on ${String(edit.id)}, whose kind has no such field; replace the item in items instead`,
          );
        item[field] = entry;
      }
    }
    for (const id of strings(change.removedItemIds, "removedItemIds")) {
      const at = position(id, "removedItemIds");
      if (at < 0)
        throw new PlannerChoiceError(
          `Planner revision removes ${JSON.stringify(id)}, which is not a current item`,
        );
      items.splice(at, 1);
    }
    const replaced = new Set<number>();
    for (const raw of change.coverage as unknown[]) {
      const { obligationIndex, ...entry } = object(raw, "coverage");
      const at = index(obligationIndex, coverage.length, "obligationIndex");
      if (replaced.has(at))
        throw new PlannerChoiceError(
          "Planner revision replaces one coverage entry more than once",
        );
      replaced.add(at);
      coverage[at] = entry;
    }
    for (const field of replaceable)
      if (change[field] !== null) plan[field] = change[field];
    plan.decisionRequired = change.decisionRequired;
    if (splittable) plan.split = change.split;
    plan.contextId = change.contextId;
    return plan;
  };
  /** The complete answer a response stands for, before decoding. */
  const expandGraph = (value: unknown): unknown =>
    revision ? applyRevision(value) : value;
  // Stable content first, so repeated and revised compilations share a
  // provider-cache prefix; the revision-specific parts and the context
  // identity, which hashes them, come last.
  const data = {
    proofModesByItemKind: structuredClone(modes),
    obligations: obligations.map((entry, obligationIndex) => ({
      obligationIndex,
      text: coverageCriterion(entry),
      ...(entry.source.lines
        ? { source: entry.source.path, lines: entry.source.lines }
        : {}),
    })),
    citations: citations.map(({ path, heading }) => ({ path, heading })),
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
    ...(revision
      ? {
          currentPlan: (({ contextId: _contextId, ...plan }) => plan)(
            object(revision.answer, "current plan"),
          ),
          // Bodies render as literal blocks after the choices.
          citedSections: revision.citations.map(({ path, heading }, at) => ({
            path,
            heading,
            content: { block: `section ${at}` },
          })),
        }
      : {}),
    contextId,
  };
  const graphWire = {
    schema: graphSchema,
    data,
    revision: Boolean(revision),
    expand: expandGraph,
    /** The complete graph-level answer, retained as a later revision's base. */
    answer: (expanded: unknown): unknown => expanded,
    decode(value: unknown): WorkGraph {
      const wire = object(value, "response");
      keys(
        wire,
        [
          "contextId",
          "items",
          "coverage",
          "sourceObligations",
          "requiredPreIntegrationChecks",
          "decisionRequired",
          ...(request.contextLookup ? ["expansions", "conditions"] : []),
          ...(splittable ? ["split"] : []),
        ],
        "response",
      );
      if (wire.contextId !== contextId)
        throw new Error("Planner context identity differs from this request");
      if (wire.decisionRequired !== null) {
        const asked = object(wire.decisionRequired, "decision required");
        keys(asked, ["obligationIndex", "question"], "decision required");
        const obligation =
          obligations[
            index(asked.obligationIndex, obligations.length, "obligationIndex")
          ]!;
        if (
          typeof asked.question !== "string" ||
          !asked.question.trim() ||
          asked.question.length > 4096
        )
          throw new Error("A required decision must state its question");
        const criterion = coverageCriterion(obligation)
          .replace(/\s+/g, " ")
          .trim();
        throw new PlannerDecision(
          `${asked.question.trim()} (criterion: "${criterion.length > 160 ? `${criterion.slice(0, 157)}...` : criterion}")`,
        );
      }
      if (!Array.isArray(wire.items) || !wire.items.length)
        throw new Error("Planner requires at least one Work Item");
      if (
        !Array.isArray(wire.coverage) ||
        wire.coverage.length !== obligations.length
      )
        throw new PlannerChoiceError(
          "Planner requires one coverage entry per obligation in supplied order",
        );
      if (!Array.isArray(wire.sourceObligations))
        throw new Error("Planner source obligations must be an array");
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
              ...(source.heading === undefined
                ? {}
                : { heading: source.heading }),
              digest: createHash("sha256").update(source.content).digest("hex"),
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
      const lint: string[] = [];
      const linted = new Set<string>();
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
          if (item.kind === "discovery") expected.push("discovery");
          keys(item, expected, "item");
          const reason = item.oneOutcomeReason;
          delete item.oneOutcomeReason;
          if (reason !== null && (typeof reason !== "string" || !reason.trim()))
            throw new Error("Planner oneOutcomeReason must be null or text");
          const findings = context.previousGraph
            ? []
            : planStandardLint(item, reason);
          if (findings.length) linted.add(String(item.id));
          lint.push(...findings);
          if (reason !== null && typeof item.brief === "string")
            item.brief = `${item.brief}\n\nOne outcome: ${reason.trim()}`;
          if (item.condition === null) delete item.condition;
          if (item.kind === "discovery") {
            assertDiscoverySpecification(item.discovery);
            if (!Array.isArray(item.validation) || item.validation.length)
              throw new PlannerChoiceError(
                "Discovery cannot run graph commands",
              );
          }
          if (item.kind === "aggregate")
            item.acceptance = aggregateAcceptance(
              item as unknown as WorkGraph["items"][number],
              context.previousGraph,
            );
          if (item.kind !== "work")
            Object.assign(item, structuredClone(readonlyConstants));
          else {
            newPackages = strings(item.newPackages, "newPackages");
            if (item.media !== null) {
              const media = object(item.media, "media");
              keys(media, outputFields, "media");
              if (
                !strings(media.expectedOutputRoles, "expectedOutputRoles")
                  .length ||
                typeof media.minimumAssetSets !== "string" ||
                !/^[1-9][0-9]*$/.test(media.minimumAssetSets) ||
                !Number.isSafeInteger(Number(media.minimumAssetSets)) ||
                String(Number(media.minimumAssetSets)) !==
                  media.minimumAssetSets
              )
                throw new Error(
                  "Planner media outputs need a positive safe-integer candidate count",
                );
              item.expectedOutputRoles = media.expectedOutputRoles;
              item.minimumAssetSets = Number(media.minimumAssetSets);
              item.requiredLfsRoles = media.requiredLfsRoles;
            } else {
              item.expectedOutputRoles = [];
              item.minimumAssetSets = 0;
              item.requiredLfsRoles = [];
            }
          }
          delete item.newPackages;
          delete item.media;
          if (request.contextLookup) {
            if (item.scheduling === null) delete item.scheduling;
            else {
              const scheduling = object(item.scheduling, "scheduling");
              keys(scheduling, ["estimatedDurationMs", "reason"], "scheduling");
              if (
                typeof scheduling.estimatedDurationMs !== "string" ||
                !/^[1-9][0-9]*$/.test(scheduling.estimatedDurationMs) ||
                !Number.isSafeInteger(Number(scheduling.estimatedDurationMs)) ||
                String(Number(scheduling.estimatedDurationMs)) !==
                  scheduling.estimatedDurationMs
              )
                throw new PlannerChoiceError(
                  "Advisory duration must be a positive safe integer or null when unknown",
                );
              scheduling.estimatedDurationMs = Number(
                scheduling.estimatedDurationMs,
              );
            }
          }
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
          // Factory pins the cited bytes: a pinned choice, else the file at the base.
          item.citations = item.citations.map((value) => {
            const choice = object(value, "citation");
            keys(choice, ["path", "heading"], "citation");
            if (
              typeof choice.path !== "string" ||
              !choice.path ||
              typeof choice.heading !== "string"
            )
              throw new Error("Planner citation needs a path and a heading");
            return { path: choice.path, heading: choice.heading };
          });
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
      const proved = (
        entry: ObjectValue,
        label: string,
        criterionId: string,
      ): Omit<
        NonNullable<WorkGraph["coverage"]>[number],
        keyof CoverageObligation
      > => {
        const owners = graph.items.filter((item) => item.id === entry.itemId);
        if (owners.length !== 1)
          throw new PlannerChoiceError(
            "Planner coverage must select one existing unambiguous owner",
          );
        const owner = owners[0]!;
        const ownerKind = owner.kind ?? "work";
        const allowedProofModes = modes[ownerKind]!;
        const proof = object(entry.proof, "proof");
        if (
          typeof proof.kind !== "string" ||
          !allowedProofModes.includes(proof.kind)
        )
          throw new PlannerChoiceError(
            `Planner ${label} selects ${JSON.stringify(proof.kind)} for ${owner.id} (${ownerKind}); allowed proof kinds: ${allowedProofModes.join(", ")}`,
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
          // The owner's review judges the obligation itself; its acceptance
          // as a whole is the proof, so no entry is named.
          case "result-semantic":
          case "integrated-semantic": {
            canonicalProof = { kind: proof.kind };
            // A started item's review is settled: it judged only the
            // obligations it owned then. It keeps proving those, with the
            // exact earlier proof; it cannot judge a newly assigned one.
            if (retainedItems.has(owner.id) && owner.id !== reattempt) {
              const previous = context.previousGraph?.coverage?.find(
                (old) =>
                  old.criterionId === criterionId &&
                  old.itemId === owner.id &&
                  (old.proof.kind === "result-semantic" ||
                    old.proof.kind === "integrated-semantic"),
              );
              if (!previous)
                throw new PlannerChoiceError(
                  `Work Item ${owner.id} is already reviewed and cannot judge a newly assigned obligation; use final-review or new work`,
                  [owner.id],
                );
              canonicalProof = structuredClone(previous.proof);
            }
            break;
          }
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
        const env = object(
          entry.environment === null
            ? structuredClone(DEFAULT_ENVIRONMENT)
            : entry.environment,
          "environment",
        );
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
        return {
          itemId: owner.id,
          proof: canonicalProof,
          environment: {
            ...canonicalEnvironment,
            probe,
            ...(prerequisites.length ? { prerequisites } : {}),
          } as NonNullable<WorkGraph["coverage"]>[number]["environment"],
        };
      };
      // Obligations a stub child carries, by obligation index, and the stub
      // keys source obligations name; only a split can have them.
      const stubObligations = new Map<number, string>();
      const stubSourceKeys: { key: string; path: string }[] = [];
      const stubOwner = (entry: ObjectValue, label: string) => {
        const proof = object(entry.proof, "proof");
        if (proof.kind !== "child-objective") return undefined;
        if (!splittable || wire.split === null)
          throw new PlannerChoiceError(
            `Planner ${label} names a child Objective, but the plan has no split`,
          );
        keys(proof, ["kind"], "proof");
        if (typeof entry.itemId !== "string")
          throw new Error("Planner child Objective owner must be its key");
        return entry.itemId;
      };
      for (const [obligationIndex, value] of wire.coverage.entries()) {
        const entry = object(value, "coverage");
        keys(entry, ["itemId", "proof", "environment"], "coverage");
        const stub = stubOwner(entry, `coverage ${obligationIndex}`);
        if (stub !== undefined) {
          stubObligations.set(obligationIndex, stub);
          continue;
        }
        graph.coverage!.push({
          ...structuredClone(obligations[obligationIndex]!),
          ...proved(
            entry,
            `coverage ${obligationIndex}`,
            obligations[obligationIndex]!.criterionId,
          ),
        });
      }
      const objectiveSource = request.sources.find(
        (source) => source.path === "OBJECTIVE",
      );
      const objectiveLines = objectiveSource?.content.split("\n").length ?? 0;
      const exclusions: NonNullable<WorkGraph["sourceExclusions"]> = [];
      for (const [position, value] of wire.sourceObligations.entries()) {
        const entry = object(value, "source obligation");
        keys(
          entry,
          [
            "sourceIndex",
            "firstLineIndex",
            "lastLineIndex",
            "statement",
            "disposition",
          ],
          "source obligation",
        );
        const pinned =
          request.sources[
            index(entry.sourceIndex, request.sources.length, "sourceIndex")
          ]!;
        const lines: [number, number] = [
          entry.firstLineIndex as number,
          entry.lastLineIndex as number,
        ];
        const spanText = sourceLines(pinned.content, lines);
        if (pinned.path === "OBJECTIVE" || !spanText?.trim())
          throw new PlannerChoiceError(
            `Planner source obligation ${position} must select an existing nonblank line range of a cited source, not the Objective`,
          );
        // A null statement is the exact cited lines, already checked nonblank.
        const statement = entry.statement === null ? spanText : entry.statement;
        if (typeof statement !== "string" || !statement.trim())
          throw new Error("Planner source obligation must state its exit item");
        const source = {
          path: pinned.path,
          digest: sourceDigest(pinned.content),
          lines,
        };
        const disposition = object(entry.disposition, "disposition");
        if (disposition.kind === "covered") {
          keys(
            disposition,
            ["kind", "itemId", "proof", "environment"],
            "covered disposition",
          );
          // A stub compiles later from its own sources and extracts this again.
          const stub = stubOwner(disposition, `source obligation ${position}`);
          if (stub !== undefined) {
            stubSourceKeys.push({ key: stub, path: source.path });
            continue;
          }
          const criterionId = sourceObligationId(source);
          graph.coverage!.push({
            criterionId,
            source,
            statement,
            ...proved(
              disposition,
              `source obligation ${position}`,
              criterionId,
            ),
          });
          continue;
        }
        keys(
          disposition,
          ["kind", "reason", "objectiveLineIndices"],
          "out-of-scope disposition",
        );
        if (
          disposition.kind !== "out-of-scope" ||
          typeof disposition.reason !== "string" ||
          !disposition.reason.trim() ||
          !Array.isArray(disposition.objectiveLineIndices) ||
          !disposition.objectiveLineIndices.length
        )
          throw new Error(
            "Planner out-of-scope source obligation needs a reason and Objective lines",
          );
        exclusions.push({
          source,
          statement,
          reason: disposition.reason,
          objectiveLines: disposition.objectiveLineIndices.map((line) =>
            index(line, objectiveLines, "objectiveLineIndices"),
          ),
        });
      }
      if (exclusions.length) graph.sourceExclusions = exclusions;
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
      if (request.contextLookup) {
        if (!Array.isArray(wire.conditions))
          throw new Error("Planner conditions must be an array");
        if (wire.conditions.length)
          graph.conditions = wire.conditions.map((value) => {
            const condition = structuredClone(value);
            assertDeclaredWorkCondition(condition);
            return condition;
          });
        assertDeclaredConditions(graph);
        if (!Array.isArray(wire.expansions))
          throw new Error("Planner expansions must be an array");
        if (wire.expansions.length) {
          graph.expansions = wire.expansions.map((raw) => {
            const envelope = structuredClone(object(raw, "expansion"));
            const rawTemplate = object(envelope.template, "expansion template");
            if (
              !Array.isArray(rawTemplate.newPackages) ||
              rawTemplate.newPackages.length
            )
              throw new PlannerChoiceError(
                "Expansion templates cannot invent packages outside their observed existing-file work shape",
              );
            if (
              rawTemplate.kind !== "work" ||
              graph.items.some((item) => item.id === rawTemplate.id)
            )
              throw new PlannerChoiceError(
                "Expansion template must be a separate ordinary-work shape, never a retained or executable item",
              );
            const decoded = graphWire.decode({
              ...wire,
              expansions: [],
              items: [...(wire.items as unknown[]), rawTemplate],
            });
            envelope.template = decoded.items.at(-1)!;
            assertGraphExpansionEnvelope(envelope);
            return envelope;
          });
        }
        assertDeclaredConditions(graph);
      }
      // Last, so a plan that passes every other check gets these as one
      // batched correction instead of a paid review finding.
      if (lint.length)
        throw new PlannerChoiceError(`Plan standard: ${lint.join("; ")}`, [
          ...linted,
        ]);
      if (splittable && wire.split !== null)
        return splitGraph(graph, wire.split, stubObligations, stubSourceKeys);
      return graph;
    },
  };
  /**
   * The decoded union graph regrouped as child Objectives: each ready child
   * gets its own Work Items and the coverage they own, and every Objective
   * obligation becomes an Acceptance outcome of exactly one child. Planning
   * validates each ready child's graph against that child's own Objective.
   */
  function splitGraph(
    union: WorkGraph,
    raw: unknown,
    stubObligations: Map<number, string>,
    stubSourceKeys: { key: string; path: string }[],
  ): WorkGraph {
    const split = object(raw, "split");
    keys(split, ["children"], "split");
    if (!Array.isArray(split.children) || split.children.length < 2)
      throw new PlannerChoiceError("A split needs at least two children");
    const children = split.children.map((value) => {
      const child = object(value, "split child");
      keys(
        child,
        ["key", "title", "goal", "sources", "dependsOn", "itemIds"],
        "split child",
      );
      if (
        typeof child.key !== "string" ||
        typeof child.title !== "string" ||
        typeof child.goal !== "string" ||
        !Array.isArray(child.sources)
      )
        throw new Error("Planner split child is invalid");
      const sources = child.sources.map((value) => {
        const selected = object(value, "split child source");
        keys(selected, ["path", "heading"], "split child source");
        const { path, heading } = selected;
        if (typeof path !== "string" || !path || typeof heading !== "string")
          throw new Error(
            "Planner split child source needs a path and heading",
          );
        if (path === "OBJECTIVE")
          throw new PlannerChoiceError(
            `Child ${child.key} cites the OBJECTIVE as a source; its own Objective replaces it`,
          );
        return heading ? { path, heading } : { path };
      });
      return {
        key: child.key,
        title: child.title.trim(),
        goal: child.goal.trim(),
        sources,
        dependsOn: strings(child.dependsOn, "dependsOn"),
        itemIds: strings(child.itemIds, "itemIds"),
      };
    });
    const owner = new Map<string, string>();
    for (const child of children) {
      if (child.dependsOn.length && child.itemIds.length)
        throw new PlannerChoiceError(
          `Child ${child.key} depends on siblings, so it is a stub: it is compiled after they merge and has no Work Items now`,
        );
      if (!child.dependsOn.length && !child.itemIds.length)
        throw new PlannerChoiceError(
          `Child ${child.key} has no dependencies, so it is ready: list its Work Items in itemIds`,
        );
      for (const id of child.itemIds) {
        if (!union.items.some((item) => item.id === id) || owner.has(id))
          throw new PlannerChoiceError(
            `Child ${child.key} lists a missing or already assigned Work Item ${id}`,
          );
        owner.set(id, child.key);
      }
    }
    for (const item of union.items) {
      const key = owner.get(item.id);
      if (key === undefined)
        throw new PlannerChoiceError(
          `Work Item ${item.id} belongs to no ready child`,
        );
      if (
        [...item.dependencies, ...(item.children ?? [])].some(
          (id) => owner.get(id) !== key,
        )
      )
        throw new PlannerChoiceError(
          `Work Item ${item.id} depends on another child's Work Item; children depend on each other through dependsOn`,
        );
    }
    const stubs = new Set(
      children.filter((child) => child.dependsOn.length).map(({ key }) => key),
    );
    for (const key of [
      ...stubObligations.values(),
      ...stubSourceKeys.map(({ key }) => key),
    ])
      if (!stubs.has(key))
        throw new PlannerChoiceError(
          `A child-objective proof names ${key}, which is not a stub child`,
        );
    // A stub extracts its source obligations again from its own sources.
    for (const { key, path } of stubSourceKeys)
      if (
        !children
          .find((child) => child.key === key)!
          .sources.some((source) => source.path === path)
      )
        throw new PlannerChoiceError(
          `Stub ${key} carries a source obligation in ${path}, which is not among its sources`,
        );
    const assigned = new Map<string, number[]>(
      children.map(({ key }) => [key, []]),
    );
    for (const [position, obligation] of obligations.entries()) {
      if (obligation.source.path !== "OBJECTIVE")
        throw new PlannerChoiceError(
          "Only a new plan's Objective obligations can be split",
        );
      const entry = union.coverage.find(
        (candidate) => candidate.criterionId === obligation.criterionId,
      );
      const key =
        stubObligations.get(position) ??
        (entry ? owner.get(entry.itemId) : undefined);
      assigned.get(key!)!.push(position);
    }
    const specs: ChildObjectiveSpec[] = children.map((child) => {
      const outcomes = assigned
        .get(child.key)!
        .map((position) => coverageCriterion(obligations[position]!));
      if (!outcomes.length)
        throw new PlannerChoiceError(
          `Child ${child.key} owns no Objective Acceptance outcome, and every child owns at least one (the Child Objectives rule). Remove child ${child.key}: move ${child.itemIds.length ? `its Work Items (${child.itemIds.join(", ")})` : "its work"} into the ready child that needs it, or leave it to the stub that depends on it, which plans it later`,
          child.itemIds,
        );
      const { itemIds, ...spec } = child;
      return {
        ...spec,
        outcomes,
        ...(itemIds.length
          ? {
              graph: {
                objective: union.objective,
                baseSha: union.baseSha,
                items: union.items.filter((item) => itemIds.includes(item.id)),
                coverage: union.coverage.filter(
                  (entry) => owner.get(entry.itemId) === child.key,
                ),
                // Planning keeps each with the children whose sources need it.
                requiredPreIntegrationChecks: structuredClone(
                  union.requiredPreIntegrationChecks ?? [],
                ),
                ...(union.sourceExclusions
                  ? {
                      sourceExclusions: structuredClone(union.sourceExclusions),
                    }
                  : {}),
              },
            }
          : {}),
      };
    });
    try {
      assertChildObjectives(specs);
    } catch (error) {
      throw new PlannerChoiceError(
        error instanceof Error ? error.message : String(error),
      );
    }
    return {
      objective: union.objective,
      baseSha: union.baseSha,
      items: [],
      coverage: [],
      requiredPreIntegrationChecks: [],
      split: { children: specs },
    };
  }
  if (!request.contextLookup) return graphWire;
  assertPlanningContextPacket(request.contextLookup);
  const requestSchema = strict({
    id: { ...text, minLength: 1, maxLength: 128 },
    operation: { type: "string", enum: ["read", "search", "inventory"] },
    collection: { ...text, minLength: 1, maxLength: 128 },
    selector: { ...text, maxLength: 4096 },
    query: { ...text, maxLength: 1024 },
    required: { type: "boolean" },
    reason: { ...text, minLength: 1, maxLength: 4096 },
  });
  return {
    schema: strict({
      contextId: contextIdSchema,
      outcome: {
        anyOf: [
          strict({
            kind: { type: "string", enum: ["graph"] },
            graph: graphSchema,
          }),
          strict({
            kind: { type: "string", enum: ["context-request"] },
            requests: {
              type: "array",
              minItems: 1,
              maxItems: request.contextLookup.bounds.maxRequestsPerRound,
              items: requestSchema,
            },
          }),
          strict({
            kind: { type: "string", enum: ["human-dependency"] },
            dependencyKind: {
              type: "string",
              enum: ["human-choice", "permission", "unavailable-context"],
            },
            requestIds: {
              type: "array",
              maxItems: request.contextLookup.bounds.maxResults,
              items: { ...text, minLength: 1, maxLength: 128 },
            },
            question: { ...text, minLength: 1, maxLength: 4096 },
            detail: { ...text, minLength: 1, maxLength: 4096 },
          }),
        ],
      },
    }),
    data: { ...data, contextLookup: request.contextLookup },
    revision: Boolean(revision),
    expand(value: unknown): unknown {
      const outer = value as { outcome?: { kind?: unknown; graph?: unknown } };
      return revision && outer?.outcome?.kind === "graph"
        ? {
            ...outer,
            outcome: {
              ...outer.outcome,
              graph: expandGraph(outer.outcome.graph),
            },
          }
        : value;
    },
    answer(expanded: unknown): unknown {
      const outcome = (
        expanded as { outcome?: { kind?: unknown; graph?: unknown } }
      )?.outcome;
      return outcome?.kind === "graph" ? outcome.graph : undefined;
    },
    decode(value: unknown): PlanningTurnResponse {
      const outer = object(value, "context response");
      keys(outer, ["contextId", "outcome"], "context response");
      if (outer.contextId !== contextId)
        throw new Error("Planner context identity differs from this request");
      const outcome = object(outer.outcome, "outcome");
      if (outcome.kind === "graph") {
        keys(outcome, ["kind", "graph"], "graph outcome");
        return { kind: "graph", graph: graphWire.decode(outcome.graph) };
      }
      if (outcome.kind === "context-request") {
        keys(outcome, ["kind", "requests"], "context request outcome");
        if (
          !Array.isArray(outcome.requests) ||
          !outcome.requests.length ||
          outcome.requests.length >
            request.contextLookup!.bounds.maxRequestsPerRound
        )
          throw new Error("Context request batch exceeds admitted bounds");
        const ids = new Set(
          [
            ...request.contextLookup!.automatic,
            ...request.contextLookup!.batches.flat(),
          ].map((result) => result.request.id),
        );
        for (const entry of outcome.requests) {
          assertContextRequest(entry);
          if (ids.has(entry.id))
            throw new Error("Context request batch repeats an identity");
          ids.add(entry.id);
        }
        return { kind: "context-request", requests: outcome.requests };
      }
      if (outcome.kind === "human-dependency") {
        keys(
          outcome,
          ["kind", "dependencyKind", "requestIds", "question", "detail"],
          "human dependency outcome",
        );
        if (
          typeof outcome.question !== "string" ||
          !outcome.question.trim() ||
          outcome.question.length > 4096 ||
          typeof outcome.detail !== "string" ||
          !outcome.detail.trim() ||
          outcome.detail.length > 4096
        )
          throw new Error(
            "Human dependency must state a concrete question and missing fact",
          );
        const response = {
          kind: "human-dependency" as const,
          dependencyKind: outcome.dependencyKind as
            | "human-choice"
            | "permission"
            | "unavailable-context",
          requestIds: outcome.requestIds as string[],
          question: outcome.question,
          detail: outcome.detail,
        };
        assertHumanPlanningDependency(response, request.contextLookup!);
        return response;
      }
      throw new Error("Invalid planning context response kind");
    },
  };
}
