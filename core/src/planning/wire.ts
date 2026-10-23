import { errorMessage } from "../text.js";
import {
  coverageCriterion,
  ownsPath,
  sourceLines,
  validValidationCommand,
} from "./graph.js";
import { WORK_ITEM_ENTRY_SIGNAL } from "./rubric.js";
import {
  type AcceptanceCoverage,
  type ChildObjectiveSpec,
  type Citation,
  type CoverageEnvironment,
  type CoverageProof,
  type Draft,
  executable,
  type Finding,
  type GraphExpansionEnvelope,
  type ItemKind,
  type PlanningFacts,
  type RequiredPreIntegrationCheck,
  type SourceAssetBinding,
  type SourceExclusion,
  type ValidationCommand,
  type WorkItem,
} from "./types.js";

/**
 * The planner's output contract: a strict JSON schema of index choices, and
 * the decoder that maps them to a Draft. Choices are made by index into the
 * facts (sources, lines, check names, guarantees), so an invented command,
 * check or source cannot be expressed. Every problem comes back as a Finding
 * whose message names what would pass, so the planner can revise.
 */

type Schema = {
  [key: string]: unknown;
  properties?: Record<string, Schema>;
  items?: Schema;
  required?: string[];
};
type ObjectValue = Record<string, unknown>;

/** Options the facts don't carry. */
export interface WireOptions {
  /** This Objective is itself a split child: children never split again. */
  child?: boolean;
  /** Execution profiles the planner chooses from, by id. */
  profiles?: { id: string }[];
  /** The installation configures reviewArtifacts selectors, so validation captures. */
  reviewArtifacts?: boolean;
  /**
   * The Objective enables its Adaptive workflow section: the planner may
   * add discovery items, declared work conditions and reviewed expansions.
   */
  adaptive?: boolean;
}

/** A choice the planner can revise. Caught inside this module and returned as a Finding. */
class Refusal extends Error {
  constructor(
    message: string,
    readonly itemId?: string,
  ) {
    super(message);
  }
}

/**
 * An answer that does not match the schema's shape (wrong JSON type, missing
 * or extra fields). Strict structured output never produces one, so it means
 * a broken answer: the step retries the call instead of asking for a revision.
 */
class Shape extends Refusal {}

/** A decode error that is a broken answer, not a wrong choice. */
const shapeError = (error: unknown): boolean =>
  error instanceof Shape || !(error instanceof Refusal);

const finding = (error: unknown, itemId?: string): Finding => {
  const message = errorMessage(error);
  const id = error instanceof Refusal ? (error.itemId ?? itemId) : itemId;
  return { source: "check", message, ...(id ? { itemId: id } : {}) };
};

function object(value: unknown, label: string): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Shape(`Planner ${label} must be an object`);
  return value as ObjectValue;
}
function keys(value: ObjectValue, expected: string[], label: string): void {
  if (Object.keys(value).sort().join() !== [...expected].sort().join())
    throw new Shape(
      `Planner ${label} has unexpected or missing fields: give exactly ${expected.join(", ")}`,
    );
}
function index(value: unknown, length: number, label: string): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) >= length
  )
    throw new Refusal(
      `Planner ${label} is invalid: ${length ? `choose an index from 0 to ${length - 1}` : "there is nothing to choose"}`,
    );
  return value as number;
}
function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))
    throw new Shape(`Planner ${label} must be an array of strings`);
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

const short = (criterion: string, max: number): string => {
  const flat = criterion.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
};

/** An aggregate's acceptance: Factory derives it, the planner never writes it. */
const AGGREGATE_ACCEPTANCE =
  "Every explicit child Work Item has completed acceptance. Implementation child results are integrated into this aggregate's exact candidate; read-only QA and aggregate children have accepted proof against that candidate without a worker or delivery.";

/**
 * The guarantees this installation gives: review artifact capture only
 * when it configures selectors.
 */
export function controllerGuarantees(
  reviewArtifacts: boolean,
): { id: string; statement: string }[] {
  return reviewArtifacts
    ? CONTROLLER_GUARANTEES
    : CONTROLLER_GUARANTEES.filter(
        (entry) => entry.id !== "review-artifact-capture",
      );
}

/** What Factory itself guarantees; a final-controller proof names one by index. */
const CONTROLLER_GUARANTEES: { id: string; statement: string }[] = [
  {
    id: "independent-result-review",
    statement:
      "For ordinary regular and native-stack Work Items, Factory validates the exact result tree and requires a separate configured acceptance review before publishing that result. Human acceptance is recorded separately and never counts as an automatic passing independent review. Final Objective review receives controller-derived review completion facts for each exact delivered result, without treating prior reviewer prose as product proof.",
  },
  {
    id: "reviewed-head-publication",
    statement:
      "Only the controller publishes Work Item branches and pull requests. It verifies that each published PR head is the exact result commit whose tree passed validation and acceptance review; workers receive no publication authority.",
  },
  {
    id: "protected-exact-head-integration",
    statement:
      "Factory observes authenticated exact PR identities and check readiness before submitting regular or native-stack integration, requires every source-required named check admitted in the graph to have successful exact-head evidence (including waiting when it has not registered), supplies expected heads, and honors the target's existing GitHub protection and required checks without bypass. Final Objective review receives compact successful uniquely named check identities actually observed on each published head before integration. Missing, ambiguous, stale, pending, neutral, skipped or failing check results do not become successful named-check evidence; configured guarantees never claim that future checks have already passed.",
  },
  {
    id: "selected-set-materialization",
    statement:
      "Factory captures complete candidate AssetSets in private staging and stops for explicit human whole-set selection. It then materializes only selected bytes to Work Item-owned destinations, enforces the target Git attributes for every required LFS role, scans the staged result, and verifies each committed LFS pointer against the captured SHA-256 digest and byte count. Unselected sets stay in private staging: they are never committed, validated, reviewed as delivered bytes or merged; review receives a controller receipt of every captured set and the selection.",
  },
  {
    id: "review-artifact-capture",
    statement:
      "For a configured reviewArtifacts text selector with a stdout locator, Factory runs the exact validation command with TMPDIR, TMP and TEMP set to a fresh directory owned by this validation run (shared by its preparation and commands), accepts the locator only when it names exactly one directory inside that directory, and refuses capture for stale or outside locator paths, selected files whose path or alias target resolves outside the located directory, invalid UTF-8/JSON, missing bodies and bodies over the declared byte bounds. It records the command, exact tree, declaring source digest and verified body identities before cleanup. A supplied capture therefore was written inside this validation run's own fresh temporary directory; it does not by itself prove semantic acceptance.",
  },
  {
    id: "required-lfs-publication",
    statement:
      "Factory uploads required selected Git LFS objects for the exact validated result commit before publishing its Git branch or pull request.",
  },
  {
    id: "post-integration-hydration",
    statement:
      "After target Final commands pass at the exact integrated default-branch commit and before Objective completion, Factory fresh-clones the target origin, checks out that exact commit, pulls Git LFS objects, and verifies every selected member against its captured SHA-256 digest and byte count.",
  },
  {
    id: "hydration-review-evidence",
    statement:
      "Factory supplies a bounded successful hydration receipt tied to the exact integrated commit, tree, selected set, destination, SHA-256 digest, and byte count to final Objective acceptance review; a hydration failure prevents review success and Objective closure.",
  },
];

/** Shared compilation/diagnosis meaning; no probe result or extra authority. */
export const COMPILER_READINESS_GUIDANCE =
  "Same-owner source-authorized setup followed by the unchanged real readiness probe uses available with empty preparedBy and ordered prerequisiteValidationIndices before probeValidationIndex. available describes that sequence for checking in the actual fresh checkout before implementation; it never claims the probe already passed or grants authority. prepare is exclusively preparation supplied by an actual declared dependency named in preparedBy, not a synonym for the owner's setup commands. Unknown runtime readiness alone does not require an operator decision when this authorized sequence can establish it. Correct a generated mismatch as planning-output only within permitted repair classes and recorded attempt limits; do not invent a dependency, waive the probe or claim readiness. Ask the operator for an actual missing source fact, permission, capability or human-owned choice through decisionRequired.";

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
 * The plan standard's deterministic lint, run before paid review on each
 * item the planner defined: an item above the entry signal states why it is
 * one outcome, and no acceptance entry cites a line.
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

/** Fields only work items carry. */
const READONLY_FIELDS = [
  "ownedPaths",
  "sourceAssets",
  "media",
  "newPackages",
  "executionProfile",
  "condition",
  "discoveryInputs",
];
const DISCOVERY_INPUT_FIELDS = [
  "path",
  "mode",
  "blobSha",
  "contentRef",
  "classification",
];
const INVENTORY = "factory.repository-inventory/v1";
const MEDIA_FIELDS = [
  "expectedOutputRoles",
  "minimumAssetSets",
  "requiredLfsRoles",
];

/** The schemas and choice tables for one set of facts. */
function contract(facts: PlanningFacts, options: WireOptions = {}) {
  const sources = facts.sources;
  const obligations = facts.coverageObligations;
  const checkNames = facts.checkNames;
  const integratedCheckNames = facts.integratedCheckNames;
  const guarantees = controllerGuarantees(Boolean(options.reviewArtifacts));
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
    scheduling: {
      description:
        "Optional advisory duration for this item, including preparation, validation and review; Factory uses it only to order runnable items by critical path. null means unknown; an estimate grants no capacity or deadline.",
      anyOf: [
        { type: "null" },
        strict({
          // A decimal pattern, as for minimumAssetSets: numeric bounds are not
          // supported by every structured-output grammar.
          estimatedDurationMs: { type: "string", pattern: "^[1-9][0-9]*$" },
          reason: { ...text, minLength: 1 },
        }),
      ],
    },
    validation: {
      type: "array",
      items: {
        anyOf: [
          strict({
            kind: { type: "string", enum: ["source-line"] },
            sourceIndex: integer(sources.length),
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
          minimumAssetSets: {
            type: "string",
            pattern: "^[1-9][0-9]*$",
            description:
              "How many alternative sets the worker offers for the operator to choose from; only the selected set is delivered and validated.",
          },
          requiredLfsRoles: { type: "array", items: text },
        }),
      ],
    },
  });
  if (options.profiles) {
    itemSchema.properties!.executionProfile = strict({
      id: {
        type: "string",
        enum: options.profiles.map((profile) => profile.id),
      },
      reason: { type: "string", minLength: 1 },
    });
    itemSchema.required!.push("executionProfile");
  }
  const adaptive = Boolean(options.adaptive);
  if (adaptive) {
    itemSchema.properties!.condition = {
      description:
        "null for unconditional work. A work item that runs only on one branch of a declared condition names it and the branch.",
      anyOf: [
        { type: "null" },
        strict({
          conditionId: { ...text, minLength: 1 },
          when: { type: "boolean" },
        }),
      ],
    };
    itemSchema.properties!.discoveryInputs = {
      type: "array",
      description:
        "Observations this work item reads from discovery items it depends on; empty when none.",
      items: strict({
        producerItemId: { ...text, minLength: 1 },
        role: { ...text, minLength: 1 },
        fields: {
          type: "array",
          minItems: 1,
          items: { type: "string", enum: DISCOVERY_INPUT_FIELDS },
        },
      }),
    };
    itemSchema.required!.push("condition", "discoveryInputs");
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
  const checkIndex = integer(checkNames.length);
  const proofForms: Record<string, Record<string, Schema>> = {
    "result-command": { validationIndex: integer() },
    "result-semantic": {},
    "integrated-command": { validationIndex: integer() },
    "integrated-semantic": {},
    "final-review": {},
    "final-controller": { guaranteeIndex: integer(guarantees.length) },
    // integrated-ci observes the default-branch head, so it chooses only
    // from the checks a push there reports.
    "integrated-ci": {
      integratedCheckIndex: integer(integratedCheckNames.length),
    },
    "published-ci": { checkIndex, dependencyIndex: integer() },
  };
  // Proof modes by item kind. The wire offers only the kinds this build
  // executes; the others keep their modes for when their executor lands.
  const allModes: Record<string, string[]> = {
    work: [
      "result-command",
      "result-semantic",
      "final-review",
      "final-controller",
    ],
    qa: [
      "integrated-command",
      "integrated-semantic",
      ...(integratedCheckNames.length ? ["integrated-ci"] : []),
      ...(checkNames.length ? ["published-ci"] : []),
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
    // Discovery observes: it owns no proof.
    ...(adaptive ? { discovery: [] } : {}),
  };
  // Discovery is in allModes only behind the adaptive gate (adaptiveGraph).
  const modes = Object.fromEntries(
    Object.entries(allModes).filter(([kind]) => executable(kind as ItemKind)),
  );
  const offeredForms = new Set(Object.values(modes).flat());
  // A plan may split the Objective into child Objectives, unless it is itself
  // a child: children never split again. An obligation a stub child carries
  // names that child's key as its itemId.
  const splittable = !options.child;
  const proofFields: Record<string, Schema> = {
    itemId: { ...text, minLength: 1 },
    proof: {
      description:
        "Choose a kind allowed for the owner's item kind by proofModesByItemKind in the compiler choices.",
      anyOf: [
        ...Object.keys(proofForms)
          .filter((form) => offeredForms.has(form))
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
  // Array position selects the obligation. The model chooses its owner once;
  // it cannot repeat or omit an obligation index across items.
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
      sourceIndex: integer(sources.length),
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
  // One schema per item kind; decoding checks an item against its kind's.
  const kindSchemas: Record<string, Schema> = Object.fromEntries(
    Object.keys(modes).map((kind) => {
      const item = structuredClone(itemSchema);
      item.properties!.kind = { type: "string", enum: [kind] };
      item.properties!.children = {
        type: "array",
        ...(kind === "aggregate" ? { minItems: 1 } : { maxItems: 0 }),
        items: text,
      };
      if (kind !== "work") {
        for (const field of READONLY_FIELDS) delete item.properties![field];
        item.required = item.required!.filter(
          (field) => !READONLY_FIELDS.includes(field),
        );
      }
      if (kind === "aggregate") {
        delete item.properties!.acceptance;
        item.required = item.required!.filter(
          (field) => field !== "acceptance",
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
          selectors: {
            type: "array",
            minItems: 1,
            items: {
              ...text,
              description:
                "Literal repository file or directory prefix ending in / to observe.",
            },
          },
          schema: { type: "string", enum: [INVENTORY] },
          role: {
            ...text,
            minLength: 1,
            description:
              "The output's role: letters, digits, '.', '_' or '-'. Consumers and conditions name it exactly.",
          },
          completeness: { type: "string", enum: ["complete"] },
          allowance: strict({
            // The controller's ceiling (planning.discoveryLimits); graph.ts checks it too.
            maxEntries: {
              type: "integer",
              minimum: 1,
              maximum: facts.discoveryLimits.maxEntries,
            },
            maxBytes: {
              type: "integer",
              minimum: 1,
              maximum: facts.discoveryLimits.maxBytes,
            },
            maxAttempts: {
              type: "integer",
              minimum: 1,
              maximum: facts.discoveryLimits.maxAttempts,
            },
          }),
        });
        item.required!.push("discovery");
      }
      return [kind, item];
    }),
  );
  const adaptiveFields: Record<string, Schema> = {};
  if (adaptive) {
    // A template is reviewed with the plan but never runs itself: each
    // child the envelope materializes is a copy owning one batch.
    const template = structuredClone(kindSchemas.work!);
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
    template.properties!.condition = { type: "null" };
    const input = strict({
      producerItemId: { ...text, minLength: 1 },
      role: { ...text, minLength: 1 },
      schema: { type: "string", enum: [INVENTORY] },
    });
    adaptiveFields.conditions = {
      type: "array",
      description:
        "Declared work conditions: literal predicates over one discovery item's output that select conditional work. Empty when none.",
      items: strict({
        schemaVersion: { type: "integer", enum: [1] },
        id: { ...text, minLength: 1 },
        input,
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
    adaptiveFields.expansions = {
      type: "array",
      description:
        "Reviewed expansion envelopes: after a discovery item settles, Factory instantiates the template once per batch of discovered files, without a model call. Empty when none.",
      items: strict({
        schemaVersion: { type: "integer", enum: [1] },
        id: { ...text, minLength: 1 },
        input,
        selectors: { type: "array", minItems: 1, items: text },
        workShape: {
          type: "string",
          enum: ["migration", "cross-cutting-fix"],
        },
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
        eligibleProfileIds: {
          type: "array",
          items: options.profiles
            ? { type: "string", enum: options.profiles.map(({ id }) => id) }
            : text,
          ...(options.profiles ? {} : { maxItems: 0 }),
        },
        dependencies: { type: "array", items: text },
        integrationBarrierItemIds: { type: "array", minItems: 1, items: text },
        empty: { type: "string", enum: ["settle-without-children"] },
        template,
      }),
    };
  }
  const schema = strict({
    requiredPreIntegrationChecks: {
      type: "array",
      ...(checkNames.length ? {} : { maxItems: 0 }),
      items: strict({ checkIndex, sourceIndex: integer(sources.length) }),
    },
    items: {
      type: "array",
      minItems: 1,
      items: { anyOf: Object.values(kindSchemas) },
    },
    coverage: coverageSchema,
    ...adaptiveFields,
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
                  maxItems: MAX_CHILDREN,
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
  // A revision answers with only its changes to the current plan. Factory
  // applies them by id and index alone; the full decode still judges every
  // resulting choice.
  const nullable = (entry: Schema): Schema =>
    Array.isArray(entry.anyOf) &&
    (entry.anyOf as Schema[]).some((branch) => branch.type === "null")
      ? entry
      : { anyOf: [{ type: "null" }, entry] };
  const replaceable = [
    "sourceObligations",
    "requiredPreIntegrationChecks",
    ...Object.keys(adaptiveFields),
  ];
  const changeSchema = strict({
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
  return {
    sources,
    obligations,
    checkNames,
    integratedCheckNames,
    guarantees,
    itemSchema,
    kindSchemas,
    profiles: options.profiles,
    proofForms,
    modes,
    splittable,
    adaptive,
    schema,
    changeSchema,
    replaceable,
  };
}
type Contract = ReturnType<typeof contract>;

/** The strict JSON schema of a full planner answer. */
export function planSchema(
  facts: PlanningFacts,
  options?: WireOptions,
): Record<string, unknown> {
  return contract(facts, options).schema;
}

/** The strict JSON schema of a revision: only changes to the current answer. */
export function revisionSchema(
  facts: PlanningFacts,
  options?: WireOptions,
): Record<string, unknown> {
  return contract(facts, options).changeSchema;
}

/**
 * The indexed choices the planner's prompt must show, in the same order the
 * schema and decoder use. Stable content first, so repeated and revised calls
 * share a provider-cache prefix.
 */
export function planChoices(
  facts: PlanningFacts,
  options: WireOptions = {},
): Record<string, unknown> {
  const {
    modes,
    obligations,
    sources,
    guarantees,
    checkNames,
    integratedCheckNames,
  } = contract(facts, options);
  return {
    proofModesByItemKind: structuredClone(modes),
    obligations: obligations.map((entry, obligationIndex) => ({
      obligationIndex,
      text: coverageCriterion(entry),
      ...(entry.source.lines
        ? {
            source: entry.source.path,
            ...(entry.source.heading ? { heading: entry.source.heading } : {}),
            lines: entry.source.lines,
          }
        : {}),
    })),
    citations: sources.map(({ path, heading }) => ({
      path,
      heading: heading ?? "",
    })),
    sources: sources.map(({ content, ...source }, sourceIndex) => ({
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
    executionProfiles: options.profiles ?? null,
    ...(facts.fixedScripts.length ? { fixedScripts: facts.fixedScripts } : {}),
    checkNames: checkNames.map((name, checkIndex) => ({ checkIndex, name })),
    ...(modes.qa?.includes("integrated-ci")
      ? {
          integratedCheckNames: integratedCheckNames.map(
            (name, integratedCheckIndex) => ({ integratedCheckIndex, name }),
          ),
        }
      : {}),
  };
}

/**
 * The current full answer with a revision's changes applied; structure only.
 * The result goes through decodePlan like any full answer, and is the base of
 * the next revision.
 */
export function applyRevision(
  current: unknown,
  change: unknown,
  facts: PlanningFacts,
  options?: WireOptions,
): { answer?: unknown; findings: Finding[]; invalidShape?: true } {
  const wire = contract(facts, options);
  try {
    return { answer: revise(wire, current, change), findings: [] };
  } catch (error) {
    return {
      findings: [finding(error)],
      ...(shapeError(error) ? { invalidShape: true as const } : {}),
    };
  }
}

function revise(wire: Contract, current: unknown, value: unknown): unknown {
  const plan = structuredClone(object(current, "current plan"));
  const change = object(value, "revision");
  keys(change, Object.keys(wire.changeSchema.properties!), "revision");
  if (!Array.isArray(plan.items) || !Array.isArray(plan.coverage))
    throw new Refusal(
      "Planner current plan is invalid: answer the full graph instead of a revision",
    );
  for (const field of ["items", "itemEdits", "coverage"])
    if (!Array.isArray(change[field]))
      throw new Refusal(`Planner revision ${field} must be an array`);
  const items = plan.items as unknown[];
  const coverage = plan.coverage as unknown[];
  const touched = new Set<string>();
  const position = (id: unknown, label: string) => {
    if (typeof id !== "string" || touched.has(id))
      throw new Refusal(
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
      throw new Refusal(
        `Planner revision edits ${JSON.stringify(edit.id)}, which is not a current item; add it in full under items`,
      );
    const item = object(items[at], "item");
    const { acceptanceReplace, acceptanceAppend, ...fields } = edit;
    if (!Array.isArray(acceptanceReplace) || !Array.isArray(acceptanceAppend))
      throw new Refusal("Planner acceptance edits must be arrays");
    if (acceptanceReplace.length || acceptanceAppend.length) {
      if (!Array.isArray(item.acceptance) || fields.acceptance !== null)
        throw new Refusal(
          `Planner revision edits acceptance entries of ${String(edit.id)} without exactly one current acceptance list`,
          String(edit.id),
        );
      const acceptance = [...item.acceptance];
      const rewritten = new Set<number>();
      for (const raw of acceptanceReplace) {
        const entry = object(raw, "acceptance edit");
        const at = index(entry.index, acceptance.length, "acceptance index");
        if (rewritten.has(at) || typeof entry.text !== "string")
          throw new Refusal(
            "Planner revision rewrites one acceptance entry more than once",
            String(edit.id),
          );
        rewritten.add(at);
        acceptance[at] = entry.text;
      }
      item.acceptance = [...acceptance, ...acceptanceAppend];
    }
    for (const [field, entry] of Object.entries(fields)) {
      if (field === "id" || entry === null) continue;
      if (!Object.hasOwn(item, field))
        throw new Refusal(
          `Planner revision sets ${field} on ${String(edit.id)}, whose kind has no such field; replace the item in items instead`,
          String(edit.id),
        );
      item[field] = entry;
    }
  }
  for (const id of strings(change.removedItemIds, "removedItemIds")) {
    const at = position(id, "removedItemIds");
    if (at < 0)
      throw new Refusal(
        `Planner revision removes ${JSON.stringify(id)}, which is not a current item`,
      );
    items.splice(at, 1);
  }
  const replaced = new Set<number>();
  for (const raw of change.coverage as unknown[]) {
    const { obligationIndex, ...entry } = object(raw, "coverage");
    const at = index(obligationIndex, coverage.length, "obligationIndex");
    if (replaced.has(at))
      throw new Refusal(
        "Planner revision replaces one coverage entry more than once",
      );
    replaced.add(at);
    coverage[at] = entry;
  }
  for (const field of wire.replaceable)
    if (change[field] !== null) plan[field] = change[field];
  plan.decisionRequired = change.decisionRequired;
  if (wire.splittable) plan.split = change.split;
  return plan;
}

/** What decoding a planner answer gives the planning step. */
export interface DecodedPlan {
  plan?: Draft;
  findings: Finding[];
  question?: string;
  /**
   * The answer does not match the schema's shape: the step retries the call
   * rather than sending the findings back as a revision.
   */
  invalidShape?: true;
}

/**
 * Decode a full planner answer. Returns the draft when every choice is valid
 * and every plan-standard item lint passes; otherwise every problem found, as
 * findings, with invalidShape set when any of them is a broken answer rather
 * than a wrong choice. A decisionRequired answer returns the operator
 * question instead. The graph-level plan lint runs in checkPlan.
 */
export function decodePlan(
  raw: unknown,
  facts: PlanningFacts,
  options?: WireOptions,
): DecodedPlan {
  const wire = contract(facts, options);
  const { sources, obligations, checkNames, splittable } = wire;
  let answer: ObjectValue;
  try {
    answer = object(raw, "response");
    keys(
      answer,
      [
        "items",
        "coverage",
        "sourceObligations",
        "requiredPreIntegrationChecks",
        "decisionRequired",
        ...(splittable ? ["split"] : []),
        ...(wire.adaptive ? ["conditions", "expansions"] : []),
      ],
      "response",
    );
    if (answer.decisionRequired !== null) {
      const asked = object(answer.decisionRequired, "decision required");
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
        throw new Refusal(
          "A required decision must state its question in at most 4096 characters",
        );
      return {
        findings: [],
        question: `${asked.question.trim()} (criterion: "${short(coverageCriterion(obligation), 160)}")`,
      };
    }
    if (!Array.isArray(answer.items))
      throw new Shape("Planner items must be an array");
    if (!answer.items.length)
      throw new Refusal("Planner requires at least one Work Item");
    // The schema fixes the coverage length, so another length is a broken answer.
    if (
      !Array.isArray(answer.coverage) ||
      answer.coverage.length !== obligations.length
    )
      throw new Shape(
        `Planner requires one coverage entry per obligation in supplied order (${obligations.length})`,
      );
    if (!Array.isArray(answer.sourceObligations))
      throw new Shape("Planner source obligations must be an array");
    if (!Array.isArray(answer.requiredPreIntegrationChecks))
      throw new Shape("Planner pre-integration checks must be an array");
    if (
      wire.adaptive &&
      (!Array.isArray(answer.conditions) || !Array.isArray(answer.expansions))
    )
      throw new Shape("Planner conditions and expansions must be arrays");
  } catch (error) {
    return {
      findings: [finding(error)],
      ...(shapeError(error) ? { invalidShape: true as const } : {}),
    };
  }
  const findings: Finding[] = [];
  let invalidShape = false;
  const attempt = <T>(
    itemId: string | undefined,
    fn: () => T,
  ): T | undefined => {
    try {
      return fn();
    } catch (error) {
      if (shapeError(error)) invalidShape = true;
      findings.push(finding(error, itemId));
      return undefined;
    }
  };
  const requiredPreIntegrationChecks: RequiredPreIntegrationCheck[] = [];
  for (const raw of answer.requiredPreIntegrationChecks as unknown[]) {
    const gate = attempt(undefined, () => {
      const gate = object(raw, "pre-integration check");
      keys(gate, ["checkIndex", "sourceIndex"], "pre-integration check");
      const source =
        sources[index(gate.sourceIndex, sources.length, "sourceIndex")]!;
      return {
        checkName:
          checkNames[index(gate.checkIndex, checkNames.length, "checkIndex")]!,
        source: citation(source.path, source.heading ?? ""),
      };
    });
    if (gate) requiredPreIntegrationChecks.push(gate);
  }
  const draft: Draft = {
    base: facts.base,
    items: [],
    coverage: [],
    requiredPreIntegrationChecks,
  };
  // Items that failed to decode: coverage naming them is not judged again.
  const failed = new Set<string>();
  const lint: Finding[] = [];
  for (const raw of answer.items as unknown[]) {
    const id = (raw as { id?: unknown } | null)?.id;
    const itemId = typeof id === "string" && id ? id : undefined;
    const item = attempt(itemId, () => decodeItem(wire, raw, lint));
    if (item) draft.items.push(item);
    else if (itemId) failed.add(itemId);
  }
  const skipped = (entry: unknown): boolean => {
    const owner = (entry as { itemId?: unknown } | null)?.itemId;
    return typeof owner === "string" && failed.has(owner);
  };
  // Obligations a stub child carries, by obligation index, and the stub keys
  // source obligations name; only a split can have them.
  const stubObligations = new Map<number, string>();
  const obligationOwner = new Map<number, string>();
  const stubSourceKeys: StubSource[] = [];
  const stubOwner = (entry: ObjectValue, label: string) => {
    const proof = object(entry.proof, "proof");
    if (proof.kind !== "child-objective") return undefined;
    if (!splittable || answer.split === null)
      throw new Refusal(
        `Planner ${label} names a child Objective, but the plan has no split: choose a proof kind from proofModesByItemKind`,
      );
    keys(proof, ["kind"], "proof");
    if (typeof entry.itemId !== "string")
      throw new Refusal("Planner child Objective owner must be its key");
    return entry.itemId;
  };
  for (const [obligationIndex, value] of (
    answer.coverage as unknown[]
  ).entries()) {
    if (skipped(value)) continue;
    attempt(undefined, () => {
      const entry = object(value, "coverage");
      keys(entry, ["itemId", "proof", "environment"], "coverage");
      const label = `coverage ${obligationIndex}`;
      const stub = stubOwner(entry, label);
      if (stub !== undefined) {
        stubObligations.set(obligationIndex, stub);
        return;
      }
      const proved = prove(wire, draft.items, entry, label);
      obligationOwner.set(obligationIndex, proved.itemId);
      draft.coverage.push({
        ...structuredClone(obligations[obligationIndex]!),
        ...proved,
      });
    });
  }
  const objectiveSource = sources.find((source) => source.path === "OBJECTIVE");
  const objectiveLines = objectiveSource?.content.split("\n").length ?? 0;
  const exclusions: SourceExclusion[] = [];
  for (const [position, value] of (
    answer.sourceObligations as unknown[]
  ).entries())
    attempt(undefined, () => {
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
        sources[index(entry.sourceIndex, sources.length, "sourceIndex")]!;
      const lines: [number, number] = [
        entry.firstLineIndex as number,
        entry.lastLineIndex as number,
      ];
      const spanText = sourceLines(pinned.content, lines);
      if (pinned.path === "OBJECTIVE" || !spanText?.trim())
        throw new Refusal(
          `Planner source obligation ${position} must select an existing nonblank line range of a cited source, not the Objective`,
        );
      if (pinned.context)
        throw new Refusal(
          `Planner source obligation ${position} cites ${pinned.path}, which is repository context, not a Source the Objective pins. Obligations come only from the Objective's Sources: remove it, and follow ${pinned.path} as guidance instead.`,
        );
      // A null statement is the exact cited lines, already checked nonblank.
      const statement = entry.statement === null ? spanText : entry.statement;
      if (typeof statement !== "string" || !statement.trim())
        throw new Refusal(
          `Planner source obligation ${position} must state its exit item, or use null for the exact lines`,
        );
      // Keyed by the exact pin: one file can be pinned under several headings.
      const source = {
        path: pinned.path,
        ...(pinned.heading ? { heading: pinned.heading } : {}),
        lines,
      };
      const disposition = object(entry.disposition, "disposition");
      if (disposition.kind === "covered") {
        keys(
          disposition,
          ["kind", "itemId", "proof", "environment"],
          "covered disposition",
        );
        if (skipped(disposition)) return;
        const label = `source obligation ${position}`;
        // A stub compiles later from its own sources and extracts this again.
        const stub = stubOwner(disposition, label);
        if (stub !== undefined) {
          stubSourceKeys.push({
            key: stub,
            path: source.path,
            ...(source.heading ? { heading: source.heading } : {}),
          });
          return;
        }
        draft.coverage.push({
          source,
          statement,
          ...prove(wire, draft.items, disposition, label),
        });
        return;
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
        throw new Refusal(
          `Planner out-of-scope source obligation ${position} needs a reason and Objective lines`,
        );
      exclusions.push({
        source,
        statement,
        reason: disposition.reason,
        objectiveLines: disposition.objectiveLineIndices.map((line) =>
          index(line, objectiveLines, "objectiveLineIndices"),
        ),
      });
    });
  if (exclusions.length) draft.sourceExclusions = exclusions;
  if (wire.adaptive) {
    // Their values are judged by the graph checks, like every draft's.
    const conditions = structuredClone(answer.conditions as unknown[]);
    if (conditions.length)
      draft.conditions = conditions as NonNullable<Draft["conditions"]>;
    const expansions: GraphExpansionEnvelope[] = [];
    for (const raw of answer.expansions as unknown[]) {
      const envelope = attempt(undefined, () =>
        decodeExpansion(wire, raw, lint),
      );
      if (envelope) expansions.push(envelope);
    }
    if (expansions.length) draft.expansions = expansions;
  }
  for (const item of draft.items)
    if (
      item.kind === "qa" &&
      !draft.coverage.some((entry) => entry.itemId === item.id)
    )
      findings.push({
        source: "check",
        message: `Planner QA node ${item.id} has no acceptance coverage: make it the owner of the obligations it proves, or remove it`,
        itemId: item.id,
      });
  const split = splittable ? (answer.split as ObjectValue | null) : null;
  // Last, so a plan gets every lint finding with its choice findings in one
  // correction instead of a paid review finding.
  findings.push(...lint);
  if (invalidShape) return { findings, invalidShape: true };
  if (findings.length) return { findings };
  if (split === null) return { plan: draft, findings };
  try {
    return {
      plan: splitDraft(
        wire,
        draft,
        split,
        stubObligations,
        obligationOwner,
        stubSourceKeys,
      ),
      findings,
    };
  } catch (error) {
    return {
      findings: [finding(error)],
      ...(shapeError(error) ? { invalidShape: true as const } : {}),
    };
  }
}

/** A source obligation a stub child carries, by its exact pin. */
type StubSource = { key: string; path: string; heading?: string };

const citation = (path: string, heading: string): Citation =>
  heading ? { path, heading } : { path };

/** One item the planner defined. Lint findings go to `lint`; refusals throw. */
function decodeItem(wire: Contract, raw: unknown, lint: Finding[]): WorkItem {
  const item = object(raw, "item");
  const kind = item.kind;
  if (typeof kind !== "string" || !wire.modes[kind])
    throw new Refusal(
      `Planner Work Item kind is invalid: choose ${Object.keys(wire.modes).join(", ")}`,
    );
  keys(item, wire.kindSchemas[kind]!.required!, "item");
  const id = item.id;
  if (typeof id !== "string" || !id)
    throw new Refusal("Work Item id must be a nonempty string");
  for (const field of ["title", "goal", "brief"])
    if (typeof item[field] !== "string" || !(item[field] as string).length)
      throw new Refusal(`Work Item ${field} must be a nonempty string`, id);
  const reason = item.oneOutcomeReason;
  if (reason !== null && (typeof reason !== "string" || !reason.trim()))
    throw new Refusal("Planner oneOutcomeReason must be null or text", id);
  for (const message of planStandardLint(item, reason))
    lint.push({
      source: "check",
      message: `Plan standard: ${message}`,
      itemId: id,
    });
  const brief =
    reason !== null
      ? `${item.brief as string}\n\nOne outcome: ${reason.trim()}`
      : (item.brief as string);
  const list = (field: string) => strings(item[field], `${id} ${field}`);
  if (item.priority !== undefined && !Number.isSafeInteger(item.priority))
    throw new Refusal("Work Item priority must be an integer", id);
  if (!Array.isArray(item.citations) || !item.citations.length)
    throw new Refusal(
      "Planner item needs citations: cite at least one pinned source or repository file",
      id,
    );
  // A pinned choice, else the file at the base.
  const citations = item.citations.map((value) => {
    const choice = object(value, "citation");
    keys(choice, ["path", "heading"], "citation");
    if (
      typeof choice.path !== "string" ||
      !choice.path ||
      typeof choice.heading !== "string"
    )
      throw new Refusal("Planner citation needs a path and a heading", id);
    return citation(choice.path, choice.heading);
  });
  if (!Array.isArray(item.validation))
    throw new Refusal("Planner validation must be an array", id);
  const validation = item.validation.map((value) =>
    selectCommand(wire, object(value, "validation selection"), id),
  );
  const children = list("children");
  const resources = list("resources");
  const scheduling = schedulingHint(item.scheduling);
  const decoded: WorkItem = {
    kind: kind as WorkItem["kind"] & string,
    id,
    title: item.title as string,
    goal: item.goal as string,
    acceptance:
      kind === "aggregate" ? [AGGREGATE_ACCEPTANCE] : list("acceptance"),
    nonGoals: list("nonGoals"),
    citations,
    dependencies: list("dependencies"),
    ownedPaths: kind === "work" ? list("ownedPaths") : [],
    validation,
    brief,
    ...(children.length ? { children } : {}),
    ...(resources.length ? { resources } : {}),
    ...(item.priority ? { priority: item.priority as number } : {}),
    ...(scheduling ? { scheduling } : {}),
  };
  if (kind === "discovery") {
    if (item.validation.length)
      throw new Refusal(
        "A discovery item only observes: give it no validation",
        id,
      );
    const spec = object(item.discovery, "discovery");
    keys(
      spec,
      ["mode", "selectors", "schema", "role", "completeness", "allowance"],
      "discovery",
    );
    keys(
      object(spec.allowance, "discovery allowance"),
      ["maxEntries", "maxBytes", "maxAttempts"],
      "discovery allowance",
    );
    decoded.discovery = structuredClone(
      spec,
    ) as unknown as WorkItem["discovery"];
  }
  if (kind !== "work") return decoded;
  if (wire.adaptive) {
    if (item.condition !== null) {
      const condition = object(item.condition, "condition");
      keys(condition, ["conditionId", "when"], "condition");
      decoded.condition = structuredClone(condition) as WorkItem["condition"] &
        object;
    }
    if (!Array.isArray(item.discoveryInputs))
      throw new Shape("Planner discoveryInputs must be an array");
    const inputs = item.discoveryInputs.map((value) => {
      const selection = object(value, "discovery input");
      keys(selection, ["producerItemId", "role", "fields"], "discovery input");
      return structuredClone(selection);
    });
    if (inputs.length)
      decoded.discoveryInputs = inputs as WorkItem["discoveryInputs"];
  }
  if (item.executionProfile !== undefined) {
    const profile = object(item.executionProfile, "executionProfile");
    keys(profile, ["id", "reason"], "executionProfile");
    if (typeof profile.id !== "string" || typeof profile.reason !== "string")
      throw new Refusal(
        "Planner executionProfile needs an id and a reason",
        id,
      );
    decoded.executionProfile = { id: profile.id, reason: profile.reason };
  }
  if (!Array.isArray(item.sourceAssets))
    throw new Refusal("Planner sourceAssets must be an array", id);
  const assets = item.sourceAssets.map((rawAsset) => {
    const asset = object(rawAsset, "source asset");
    keys(
      asset,
      ["kind", "path", "role", "mediaType", "visibility"],
      "source asset",
    );
    if (
      !["path", "role", "mediaType"].every(
        (field) => typeof asset[field] === "string" && !!asset[field],
      ) ||
      !["repository", "local", "github-attachment"].includes(
        asset.kind as string,
      ) ||
      !["private", "repository"].includes(asset.visibility as string)
    )
      throw new Refusal(
        "Work Item sourceAssets must contain typed asset declarations",
        id,
      );
    return asset as unknown as SourceAssetBinding;
  });
  if (assets.length) decoded.sourceAssets = assets;
  if (item.media !== null) {
    const media = object(item.media, "media");
    keys(media, MEDIA_FIELDS, "media");
    const roles = strings(media.expectedOutputRoles, "expectedOutputRoles");
    if (
      !roles.length ||
      typeof media.minimumAssetSets !== "string" ||
      !/^[1-9][0-9]*$/.test(media.minimumAssetSets) ||
      !Number.isSafeInteger(Number(media.minimumAssetSets)) ||
      String(Number(media.minimumAssetSets)) !== media.minimumAssetSets
    )
      throw new Refusal(
        "Planner media outputs need a positive safe-integer candidate count",
        id,
      );
    decoded.expectedOutputRoles = roles;
    decoded.minimumAssetSets = Number(media.minimumAssetSets);
    decoded.requiredLfsRoles = strings(
      media.requiredLfsRoles,
      "requiredLfsRoles",
    );
  }
  // A new package the item declares becomes literal manifest ownership, the
  // fact workspace validation checks.
  for (const directory of strings(item.newPackages, "newPackages")) {
    const manifest = `${directory.replace(/\/$/, "")}/package.json`;
    if (!ownsPath(manifest, decoded.ownedPaths))
      throw new Refusal(
        `Planner item ${id} creates the package ${directory} without owning ${manifest}: add ${manifest} or its directory to ownedPaths`,
        id,
      );
    if (!decoded.ownedPaths.includes(manifest))
      decoded.ownedPaths.push(manifest);
  }
  return decoded;
}

/**
 * The item's advisory duration estimate, decoded from the wire's decimal
 * string; null is unknown. Only the shape is read here: graph.ts
 * (`itemFields`) is the one place that validates the values, for every draft.
 */
function schedulingHint(value: unknown): WorkItem["scheduling"] | undefined {
  if (value === null) return undefined;
  const hint = object(value, "scheduling");
  keys(hint, ["estimatedDurationMs", "reason"], "scheduling");
  return {
    estimatedDurationMs: Number(hint.estimatedDurationMs),
    reason:
      typeof hint.reason === "string"
        ? hint.reason.trim()
        : (hint.reason as string),
  };
}

/**
 * An expansion envelope with its template decoded as an ordinary work item.
 * The graph checks judge the envelope's values (graph.ts expansionFindings).
 */
function decodeExpansion(
  wire: Contract,
  raw: unknown,
  lint: Finding[],
): GraphExpansionEnvelope {
  const envelope = object(raw, "expansion");
  keys(
    envelope,
    Object.keys(
      (wire.schema.properties!.expansions!.items as Schema).properties!,
    ),
    "expansion",
  );
  const template = decodeItem(wire, envelope.template, lint);
  const offered = new Set((wire.profiles ?? []).map(({ id }) => id));
  for (const id of strings(envelope.eligibleProfileIds, "eligibleProfileIds"))
    if (!offered.has(id))
      throw new Refusal(
        `Expansion ${String(envelope.id)} names execution profile ${id}, which is not offered: choose from executionProfiles`,
      );
  return {
    ...(structuredClone(envelope) as Omit<GraphExpansionEnvelope, "template">),
    template,
  };
}

/** A validation choice: a line of a pinned source, or a command observed at the base. */
function selectCommand(
  wire: Contract,
  selection: ObjectValue,
  id: string,
): ValidationCommand {
  if (selection.kind === "source-line") {
    keys(selection, ["kind", "sourceIndex", "lineIndex"], "source line");
    const source =
      wire.sources[
        index(selection.sourceIndex, wire.sources.length, "sourceIndex")
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
        throw new Refusal(
          "Planner source line is prose around a code span; select a standalone command line",
          id,
        );
      command = literal[1]!;
    }
    if (!validValidationCommand(command))
      throw new Refusal(
        "Planner source line is not an executable command line; select a line that is exactly one command",
        id,
      );
    return { command, provenance: "source-declared", source: source.path };
  }
  keys(selection, ["kind", "command", "source"], "base-observed command");
  if (
    selection.kind !== "base-observed" ||
    typeof selection.command !== "string" ||
    !selection.command ||
    typeof selection.source !== "string"
  )
    throw new Refusal("Planner base-observed command is invalid", id);
  return {
    command: selection.command,
    provenance: "base-observed",
    source: selection.source,
  };
}

/** An owner, proof and environment choice, checked against the decoded items. */
function prove(
  wire: Contract,
  items: WorkItem[],
  entry: ObjectValue,
  label: string,
): Pick<AcceptanceCoverage, "itemId" | "proof" | "environment"> {
  const owners = items.filter((item) => item.id === entry.itemId);
  if (owners.length !== 1)
    throw new Refusal(
      `Planner ${label} must select one existing unambiguous owner; ${JSON.stringify(entry.itemId)} is not one Work Item id`,
    );
  const owner = owners[0]!;
  const ownerKind = owner.kind ?? "work";
  const allowed = wire.modes[ownerKind] ?? [];
  const proof = object(entry.proof, "proof");
  if (typeof proof.kind !== "string" || !allowed.includes(proof.kind))
    throw new Refusal(
      `Planner ${label} selects ${JSON.stringify(proof.kind)} for ${owner.id} (${ownerKind}); allowed proof kinds: ${allowed.join(", ")}`,
      owner.id,
    );
  keys(proof, ["kind", ...Object.keys(wire.proofForms[proof.kind]!)], "proof");
  let canonical: CoverageProof;
  switch (proof.kind) {
    case "result-command":
    case "integrated-command":
      canonical = {
        kind: proof.kind,
        validationIndex: index(
          proof.validationIndex,
          owner.validation.length,
          `${label} validationIndex`,
        ),
      };
      break;
    // The owner's review judges the obligation itself; its acceptance as a
    // whole is the proof, so no entry is named.
    case "result-semantic":
    case "integrated-semantic":
      canonical = { kind: proof.kind };
      break;
    case "final-review":
      canonical = { kind: "final-review" };
      break;
    case "final-controller":
      canonical = {
        kind: "final-controller",
        guaranteeId:
          wire.guarantees[
            index(
              proof.guaranteeIndex,
              wire.guarantees.length,
              "guaranteeIndex",
            )
          ]!.id,
      };
      break;
    case "integrated-ci":
      canonical = {
        kind: proof.kind,
        checkName:
          wire.integratedCheckNames[
            index(
              proof.integratedCheckIndex,
              wire.integratedCheckNames.length,
              "integratedCheckIndex",
            )
          ]!,
      };
      break;
    case "published-ci":
      canonical = {
        kind: proof.kind,
        checkName:
          wire.checkNames[
            index(proof.checkIndex, wire.checkNames.length, "checkIndex")
          ]!,
        targetItem:
          owner.dependencies[
            index(
              proof.dependencyIndex,
              owner.dependencies.length,
              `${label} dependencyIndex`,
            )
          ]!,
      };
      break;
    default:
      throw new Refusal(`Planner ${label} proof form is invalid`, owner.id);
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
  const { probeValidationIndex, prerequisiteValidationIndices } = env;
  if (
    !["local", "real"].includes(String(env.kind)) ||
    !["available", "prepare", "missing"].includes(String(env.readiness)) ||
    typeof env.preparedBy !== "string"
  )
    throw new Refusal("Planner environment readiness is invalid", owner.id);
  if (
    env.readiness === "prepare"
      ? !env.preparedBy ||
        !owner.dependencies.includes(env.preparedBy) ||
        !items.some((item) => item.id === env.preparedBy)
      : env.preparedBy !== ""
  )
    throw new Refusal(
      "Planner prepare requires an actual preparation dependency; same-owner setup uses available with ordered prerequisites and its probe",
      owner.id,
    );
  if (env.kind === "real" && probeValidationIndex === null)
    throw new Refusal(
      "Planner real environment requires an exact authorized readiness probe",
      owner.id,
    );
  if (!Array.isArray(prerequisiteValidationIndices))
    throw new Refusal(
      "Readiness prerequisites must be ordered validation indices",
      owner.id,
    );
  let previous = -1;
  const prerequisites = prerequisiteValidationIndices.map((value) => {
    const selected = index(
      value,
      owner.validation.length,
      "prerequisiteValidationIndices",
    );
    if (
      typeof probeValidationIndex !== "number" ||
      selected <= previous ||
      selected >= probeValidationIndex
    )
      throw new Refusal(
        "Readiness prerequisites must be unique, ordered and precede their probe",
        owner.id,
      );
    previous = selected;
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
  const environment: CoverageEnvironment = {
    kind: env.kind as CoverageEnvironment["kind"],
    readiness: env.readiness as CoverageEnvironment["readiness"],
    probe,
    ...(prerequisites.length ? { prerequisites } : {}),
    preparedBy: env.preparedBy,
  };
  return { itemId: owner.id, proof: canonical, environment };
}

const KEY = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_CHILDREN = 16;

/**
 * The decoded union draft regrouped as child Objectives: each ready child gets
 * its own Work Items and the coverage they own, and every Objective obligation
 * becomes an Acceptance outcome of exactly one child. Planning checks each
 * ready child's graph against that child's own Objective.
 */
function splitDraft(
  wire: Contract,
  union: Draft,
  raw: ObjectValue,
  stubObligations: Map<number, string>,
  obligationOwner: Map<number, string>,
  stubSourceKeys: StubSource[],
): Draft {
  keys(raw, ["children"], "split");
  if (!Array.isArray(raw.children) || raw.children.length < 2)
    throw new Refusal(
      "A split needs at least two children, or use null for one graph",
    );
  const children = raw.children.map((value) => {
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
      throw new Refusal("Planner split child is invalid");
    const sources = child.sources.map((value) => {
      const selected = object(value, "split child source");
      keys(selected, ["path", "heading"], "split child source");
      const { path, heading } = selected;
      if (typeof path !== "string" || !path || typeof heading !== "string")
        throw new Refusal(
          "Planner split child source needs a path and heading",
        );
      if (path === "OBJECTIVE")
        throw new Refusal(
          `Child ${child.key} cites the OBJECTIVE as a source; its own Objective replaces it`,
        );
      return citation(path, heading);
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
      throw new Refusal(
        `Child ${child.key} depends on siblings, so it is a stub: it is compiled after they merge and has no Work Items now`,
      );
    if (!child.dependsOn.length && !child.itemIds.length)
      throw new Refusal(
        `Child ${child.key} has no dependencies, so it is ready: list its Work Items in itemIds`,
      );
    for (const id of child.itemIds) {
      if (!union.items.some((item) => item.id === id) || owner.has(id))
        throw new Refusal(
          `Child ${child.key} lists a missing or already assigned Work Item ${id}`,
        );
      owner.set(id, child.key);
    }
  }
  for (const item of union.items) {
    const key = owner.get(item.id);
    if (key === undefined)
      throw new Refusal(
        `Work Item ${item.id} belongs to no ready child`,
        item.id,
      );
    if (
      [...item.dependencies, ...(item.children ?? [])].some(
        (id) => owner.get(id) !== key,
      )
    )
      throw new Refusal(
        `Work Item ${item.id} depends on another child's Work Item; children depend on each other through dependsOn`,
        item.id,
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
      throw new Refusal(
        `A child-objective proof names ${key}, which is not a stub child`,
      );
  // A stub extracts its source obligations again from its own sources.
  // A whole-file child source carries every section of that file.
  for (const { key, path, heading } of stubSourceKeys)
    if (
      !children
        .find((child) => child.key === key)!
        .sources.some(
          (source) =>
            source.path === path &&
            (source.heading === undefined || source.heading === heading),
        )
    )
      throw new Refusal(
        `Stub ${key} carries a source obligation in ${heading ? `${path}#${heading}` : path}, which is not among its sources`,
      );
  const assigned = new Map<string, number[]>(
    children.map(({ key }) => [key, []]),
  );
  for (const [position, obligation] of wire.obligations.entries()) {
    if (obligation.source.path !== "OBJECTIVE")
      throw new Refusal("Only a new plan's Objective obligations can be split");
    const itemId = obligationOwner.get(position);
    const key =
      stubObligations.get(position) ??
      (itemId !== undefined ? owner.get(itemId) : undefined);
    if (key !== undefined) assigned.get(key)?.push(position);
  }
  const specs: ChildObjectiveSpec[] = children.map((child) => {
    const outcomes = (assigned.get(child.key) ?? []).map((position) =>
      coverageCriterion(wire.obligations[position]!),
    );
    if (!outcomes.length)
      throw new Refusal(
        `Child ${child.key} owns no Objective Acceptance outcome, and every child owns at least one (the Child Objectives rule). Remove child ${child.key}: move ${child.itemIds.length ? `its Work Items (${child.itemIds.join(", ")})` : "its work"} into the ready child that needs it, or leave it to the stub that depends on it, which plans it later`,
      );
    const { itemIds, ...spec } = child;
    return {
      ...spec,
      outcomes,
      ...(itemIds.length
        ? {
            graph: {
              base: union.base,
              items: union.items.filter((item) => itemIds.includes(item.id)),
              coverage: union.coverage.filter(
                (entry) => owner.get(entry.itemId) === child.key,
              ),
              // Planning keeps each with the children whose sources need it.
              requiredPreIntegrationChecks: structuredClone(
                union.requiredPreIntegrationChecks ?? [],
              ),
              ...(union.sourceExclusions
                ? { sourceExclusions: structuredClone(union.sourceExclusions) }
                : {}),
            },
          }
        : {}),
    };
  });
  const problem = childObjectivesProblem(specs);
  if (problem) throw new Refusal(problem);
  return {
    base: union.base,
    items: [],
    coverage: [],
    requiredPreIntegrationChecks: [],
    split: { children: specs },
  };
}

/** Shape, identity and dependency checks; semantics belong to the planner and review. */
function childObjectivesProblem(
  children: ChildObjectiveSpec[],
): string | undefined {
  if (!children.length) return "A split needs at least one child Objective";
  if (children.length > MAX_CHILDREN)
    return `A split has at most ${MAX_CHILDREN} child Objectives`;
  const seen = new Set<string>();
  for (const child of children) {
    if (!KEY.test(child.key) || seen.has(child.key))
      return `Child Objective key is invalid or repeated: ${child.key}`;
    seen.add(child.key);
    if (!child.title.trim() || child.title.includes("\n"))
      return `Child Objective ${child.key} needs a one-line title`;
    if (!child.goal.trim()) return `Child Objective ${child.key} needs a goal`;
    if (
      !child.outcomes.length ||
      child.outcomes.some(
        (outcome) => !outcome.trim() || outcome.includes("\n"),
      )
    )
      return `Child Objective ${child.key} needs single-line observable outcomes`;
    for (const source of child.sources)
      if (
        !source.path ||
        /[`\n#]/.test(source.path) ||
        (source.heading !== undefined &&
          (!source.heading.trim() || /[`\n]/.test(source.heading)))
      )
        return `Child Objective ${child.key} has an invalid source`;
  }
  for (const child of children)
    for (const dependency of child.dependsOn)
      if (!seen.has(dependency) || dependency === child.key)
        return `Child Objective ${child.key} depends on an unknown sibling: ${dependency}`;
  // Children are created in this order, so a dependency always exists first.
  const done = new Set<string>();
  for (const child of children) {
    if (child.dependsOn.some((dependency) => !done.has(dependency)))
      return "Child Objectives must be listed after the siblings they depend on";
    done.add(child.key);
  }
  if (!children.some((child) => !child.dependsOn.length))
    return "A split needs a child Objective with no dependencies";
  return undefined;
}
