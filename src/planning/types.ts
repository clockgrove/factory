import type { SourceRef } from "../objective.js";
import type { ReviewArtifactSelector } from "../review/artifacts.js";
import type { ObjectiveBlock } from "../shown.js";

/**
 * Plan data as Factory stores it: plain JSON in the state file. The plan
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

/** Every kind a saved plan may hold; graph.ts knows each shape. */
export type ItemKind = "work" | "qa" | "aggregate";

export interface WorkItem {
  /** Absent means work. */
  kind?: ItemKind;
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
}

/**
 * A command a Work Item runs, exactly as the plan wrote it. The plan is its
 * authority: the worker may create the script it names.
 */
export interface ValidationCommand {
  command: string;
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
  /** The probe: one of the owning item's validation commands. */
  probe: string;
  /** Ordered preparation in the same fresh checkout. */
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
  /**
   * The owned paths the Objective came to own after its plan was
   * accepted, each with when (plan.ts `ownedSince`): an accepted
   * amendment's new paths, or every path of a plan rebuilt for a state
   * that couldn't be read; and, beside a path an amendment widened, the
   * paths it owned before inside it, with their times. They take that
   * place in the owned-path order (service.ts `pathOwners`, plan.ts
   * `rankedPaths`); every other path ranks by the plan's acceptance.
   * Absent means none.
   */
  ownedSince?: Record<string, string>;
  /**
   * The final validation commands the operator retired, with their
   * reasons: only currentPlan (plan.ts) sets it, from the kept retirements
   * of the plan accepted now. Never part of a saved plan.
   */
  retired?: Retirement[];
}

/**
 * An operator's `retire-command <n> <reason>` to final validation's
 * failure: command n no longer runs in final validation. Recorded like an
 * amendment, against the plan accepted then (`plan`, its acceptance time),
 * and read back through currentPlan.
 */
export interface Retirement {
  /** The final validation command, exactly as the plan runs it. */
  command: string;
  reason: string;
  by: string;
  at: string;
  /** The question answered: one retirement per answer. */
  holdId: string;
  /** The accepted plan it retires from (plan.ts ACCEPTED_AT). */
  plan: string;
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
  /** The root package scripts in the forms validation runs, test and check first; CI-only and network ones left out. Facts for the planner, not a limit. */
  packageCommands: string[];
  /** Installation commands that need network and run only in CI. */
  ciOnlyCommands: string[];
  /** `sandbox.network: host`: validation reaches the host's network. */
  hostNetwork?: true;
  /** `sandbox.network` isn't off: Factory resolves an out-of-date lockfile itself (validate.ts). */
  lockfileResolution?: true;
  /** `validation.formatCommand`: Factory applies the repository's formatter to each result itself (validate.ts). */
  formatCommand?: string;
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
  /** The base's `.gitattributes` lines that set filter=lfs, as `file: line`. */
  lfsRules: string[];
}
