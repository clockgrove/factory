import type { SourceRef } from "../objective.js";
import type { ReviewArtifactSelector } from "../review/artifacts.js";
import type { ObjectiveBlock } from "../shown.js";

/**
 * Plan data as the core stores it: plain JSON in the state file. The plan
 * step saves the accepted plan, which currentPlan (plan.ts) reads; each
 * round's draft is kept in that round's `done` result. Base is immutable,
 * so sources are cited by path and heading and read again from the base
 * when needed.
 */

/** A file at the base, whole or one exact heading. Path OBJECTIVE is the Objective body. */
export type Citation = SourceRef;

/** A media input the worker gets, by path. */
export interface SourceAssetBinding {
  /** Omitted kind means a path in the repository at the base. */
  kind?: "repository" | "local" | "github-attachment";
  path: string;
  role: string;
  mediaType: string;
  visibility: "private" | "repository";
}

/** Read-only observation a discovery item makes; never coding or publication. */
export interface DiscoverySpecification {
  mode: "inventory" | "semantic";
  selectors: string[];
  schema: "factory.repository-inventory/v1";
  role: string;
  completeness: "complete";
  allowance: { maxEntries: number; maxBytes: number; maxAttempts: number };
}

/** Every kind a saved plan may hold; graph.ts knows each shape. */
export type ItemKind = "work" | "qa" | "aggregate" | "discovery";

/**
 * The kinds this build executes (work/steps.ts), and so the only kinds the
 * planner is offered: the wire, the planner prompt and the review rubric
 * read this list. A kind joins it when its executor lands; a saved plan
 * with any other kind holds at that item.
 */
export const EXECUTABLE_KINDS: readonly ItemKind[] = [
  "work",
  "qa",
  "aggregate",
];

/** Whether this build executes, and the planner is offered, `kind`. */
export const executable = (kind: ItemKind = "work"): boolean =>
  EXECUTABLE_KINDS.includes(kind);

export interface WorkItem {
  /** A reviewed branch selector; absent or unknown facts never mean false. */
  condition?: { conditionId: string; when: boolean };
  /** Absent means work. See EXECUTABLE_KINDS for the kinds this build runs. */
  kind?: ItemKind;
  /** Read-only observation; never coding or publication. */
  discovery?: DiscoverySpecification;
  /** Dependency observations, selected by exact role and typed fields. */
  discoveryInputs?: {
    producerItemId: string;
    role: string;
    fields: ("path" | "mode" | "blobSha" | "contentRef" | "classification")[];
  }[];
  /** Hierarchy only; every required child also has an explicit dependency edge. */
  children?: string[];
  /** The execution profile the planner chose, by id. */
  executionProfile?: { id: string; reason: string };
  id: string;
  title: string;
  goal: string;
  acceptance: string[];
  nonGoals: string[];
  /** The sources the worker reads, resolved from the base at worker time. */
  citations: Citation[];
  dependencies: string[];
  ownedPaths: string[];
  resources?: string[];
  /** Pending priority: larger values run first, absent means zero. */
  priority?: number;
  /** Advisory duration estimate for ranking, never a reservation. */
  scheduling?: { estimatedDurationMs: number; reason: string };
  validation: ValidationCommand[];
  brief: string;
  sourceAssets?: SourceAssetBinding[];
  expectedOutputRoles?: string[];
  minimumAssetSets?: number;
  requiredLfsRoles?: string[];
}

/**
 * A command a Work Item runs. `source-declared` means a pinned source wrote
 * it, so the worker may create the script it names.
 */
export interface ValidationCommand {
  command: string;
  provenance: "base-observed" | "source-declared";
  /** The source path that declared it. */
  source?: string;
}

/**
 * One thing the delivered result must satisfy: an Objective Acceptance
 * criterion (path OBJECTIVE, with its text) or an exit item the planner
 * found in a cited source, by its zero-based inclusive line range and
 * restated in `statement`.
 */
export interface CoverageObligation {
  source: {
    path: string;
    /** The pinned section a source exit item's lines index; absent for a whole-file pin. */
    heading?: string;
    text?: string;
    lines?: [number, number];
    /** An Objective criterion's command: an Acceptance list item that is exactly one code element. */
    command?: string;
  };
  statement?: string;
}

/** A source exit item the plan leaves out, justified by Objective lines. */
export interface SourceExclusion {
  /** The pinned section, by path and heading (absent for a whole-file pin), and its lines. */
  source: { path: string; heading?: string; lines: [number, number] };
  statement: string;
  reason: string;
  /** Zero-based OBJECTIVE lines whose constraints or out-of-scope text justify it. */
  objectiveLines: number[];
}

export type CoverageProof =
  | { kind: "result-command" | "integrated-command"; validationIndex: number }
  /** The owner's review judges the obligation, with its acceptance as proof. */
  | { kind: "result-semantic" | "integrated-semantic" }
  | { kind: "final-review" }
  | { kind: "final-controller"; guaranteeId: string }
  | { kind: "integrated-ci"; checkName: string }
  | { kind: "published-ci"; checkName: string; targetItem: string };

export interface CoverageEnvironment {
  kind: "local" | "real";
  readiness: "available" | "prepare" | "missing";
  /** Exact source-authorized probe in the owning item's validation commands. */
  probe: string;
  /** Ordered source-authorized preparation in the same fresh checkout. */
  prerequisites?: string[];
  /** Existing prerequisite item, never inferred setup authority. */
  preparedBy: string;
}

export interface AcceptanceCoverage extends CoverageObligation {
  itemId: string;
  proof: CoverageProof;
  environment: CoverageEnvironment;
}

/** A CI check a pinned source requires on every delivery head. */
export interface RequiredPreIntegrationCheck {
  checkName: string;
  source: Citation;
}

/** One reviewed, deterministic inventory-driven graph addition. */
export interface GraphExpansionEnvelope {
  schemaVersion: 1;
  id: string;
  input: {
    producerItemId: string;
    role: string;
    schema: "factory.repository-inventory/v1";
  };
  selectors: string[];
  workShape: "migration" | "cross-cutting-fix";
  selection:
    | { kind: "all-regular-files" }
    | { kind: "classified"; included: string[]; excluded: string[] };
  batching: { maxFilesPerChild: number };
  limits: { maxChildren: number; maxIterations: 1 };
  resources: string[];
  eligibleProfileIds: string[];
  dependencies: string[];
  integrationBarrierItemIds: string[];
  empty: "settle-without-children";
  /** Reviewed ordinary-work shape, never a separately executable item. */
  template: WorkItem;
}

export interface DeclaredWorkCondition {
  schemaVersion: 1;
  id: string;
  input: {
    producerItemId: string;
    role: string;
    schema: "factory.repository-inventory/v1";
  };
  predicate:
    | { kind: "inventory-empty" }
    | {
        kind: "has-classification";
        classification: string;
        otherClassifications: string[];
      };
}

/** One child Objective of a split. */
export interface ChildObjectiveSpec {
  /** Stable key within the split: lowercase letters, digits and hyphens. */
  key: string;
  title: string;
  /** One paragraph: what this child changes and what it leaves to others. */
  goal: string;
  /** Observable outcomes; they become the child's Acceptance bullets. */
  outcomes: string[];
  /** The parent's sources this child needs, as Sources selectors. */
  sources: Citation[];
  /** Keys of sibling children whose merged code this child builds on. */
  dependsOn: string[];
  /** The child's graph, planned in the parent's pass; only without dependencies. */
  graph?: Draft;
}

/** The graph one planning round produces. */
export interface Draft {
  base: string;
  items: WorkItem[];
  /** Complete Objective-wide mapping from obligations to proof. */
  coverage: AcceptanceCoverage[];
  /** Source-required gates on every delivery head, separate from final proof. */
  requiredPreIntegrationChecks?: RequiredPreIntegrationCheck[];
  /** Cited-source exit items the plan leaves out; absent means none. */
  sourceExclusions?: SourceExclusion[];
  /** Literal predicates over structured observations. */
  conditions?: DeclaredWorkCondition[];
  /** Reviewed inventory-driven additions. */
  expansions?: GraphExpansionEnvelope[];
  /** Child Objectives instead of Work Items: items and coverage are then empty. */
  split?: { children: ChildObjectiveSpec[] };
}

/** The accepted plan; currentPlan (plan.ts) reads it. */
export interface Plan extends Draft {
  /** The final commands as reviewed, so a config edit mid-run can't change them. */
  finalCommands: string[];
  /**
   * The installation's review artifact selectors the plan was compiled and
   * reviewed with; validation holds when one is no longer configured.
   */
  reviewArtifacts?: ReviewArtifactSelector[];
  /** Operator answers; workers and final review get them. */
  decisions: PlannerDecision[];
}

/** A problem with a draft, with a message that names what would pass. */
export interface Finding {
  source: "check" | "review" | "operator";
  message: string;
  itemId?: string;
  /** Review findings only: the planner fixes it, or the operator decides. */
  kind?: "fix" | "operator-decision";
}

/** An operator's answer to a planner or review question. */
export interface PlannerDecision {
  question: string;
  answer: string;
  /** The answer text, when the answer carried any. */
  text?: string;
  by: string;
  at: string;
}

/** A pinned source with its text at the base. */
export interface PinnedSource extends Citation {
  content: string;
  /** Set only on the operator-written Objective body. */
  operatorAuthored?: true;
  /**
   * The Objective's shown lines and inline code elements (shown.ts): its
   * command authority reads these, never its Markdown text.
   */
  shown?: { lines: string[]; spans: string[] };
  /** AGENTS.md or README.md read as context: never a source of obligations. */
  context?: true;
}

/** Everything the planner is given, computed once from the base. */
export interface PlanningFacts {
  objective: number;
  /** The planner text (shown.ts). */
  body: string;
  /** The Objective's shown structure: every check reads this. */
  blocks: readonly ObjectiveBlock[];
  base: string;
  sources: PinnedSource[];
  /** Commands a Work Item may run: test and check first, CI-only and network ones left out. */
  authorizedCommands: string[];
  /** Installation commands that need network and run only in CI. */
  ciOnlyCommands: string[];
  /** CI check names the base's pull-request workflows report. */
  checkNames: string[];
  /** CI check names the base's workflows report on a push to the default branch: integrated-ci's only choices. */
  integratedCheckNames: string[];
  /** Root package scripts the final commands run, which no item may change. */
  fixedScripts: { name: string; body: string }[];
  /** The Objective's Acceptance criteria, in order. */
  coverageObligations: CoverageObligation[];
  /** The approved playbook text; empty when there is none. */
  playbook: string;
  /** The operator's media.localAssetRoots: the only places a local source asset may come from. */
  localAssetRoots: readonly string[];
}
