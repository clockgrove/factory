import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { allowances, grant, type Usage } from "../allowances.js";
import { type CoreConfig, ownRepositoryProblem } from "../config.js";
import {
  errored,
  failure,
  hold,
  type Offer,
  type Outcome,
  objectiveWide,
  type Step,
  type StepContext,
} from "../engine.js";
import { defaultHead } from "../git.js";
import type { GitHub } from "../github.js";
import { planningKnowledge } from "../knowledge/index.js";
import { prose } from "../markdown.js";
import { checkObjective } from "../objective.js";
import type { Planner } from "../providers/planner.js";
import { resolvedProvider } from "../providers/selection.js";
import type { ReviewArtifactSelector } from "../review/artifacts.js";
import { readShown, type ShownObjective, shownDigest } from "../shown.js";
import type { Answer, ObjectiveState } from "../state.js";
import { adaptiveWorkflow, declarationProblems } from "../validate.js";
import { checkPlan } from "./checks.js";
import { observeLocalExecutables } from "./executables.js";
import {
  BaseFiles,
  buildFacts,
  childIdentity,
  commandInstructions,
  finalCommands,
  objectiveCommandProblems,
  sectionText,
} from "./facts.js";
import { forgetting, lookupsKey, plannerLookups } from "./lookup.js";
import {
  ACCEPTED_AT,
  currentPlan,
  generationInputs,
  position,
  proposalsOf,
} from "./plan.js";
import {
  type PredecessorEvidence,
  predecessorEvidence,
  predecessorsHold,
  predecessorsOnBase,
} from "./predecessors.js";
import {
  draftItems,
  renderCompilationCall,
  renderGraphReviewCall,
  renderPlanningInstructions,
  revisionScope,
} from "./prompts.js";
import {
  adaptiveGraph,
  type RecipeSelection,
  recipeFindings,
  recipeInstallation,
  recipePrerequisites,
  selectRecipe,
} from "./recipes.js";
import {
  exportTree,
  type RepositoryView,
  repositoryView,
} from "./repository.js";
import {
  decodeGraphReview,
  graphReviewSchema,
  planningReviewEvidence,
  type ReviewFinding,
} from "./review.js";
import type { WorkerCommandAccess } from "./rubric.js";
import type {
  Draft,
  Finding,
  Plan,
  PlannerDecision,
  PlanningFacts,
} from "./types.js";
import {
  applyRevision,
  controllerGuarantees,
  decodePlan,
  planChoices,
  planSchema,
  revisionSchema,
  type WireOptions,
} from "./wire.js";

const MINUTE = 60_000;

/** What planning needs from the installation. */
export interface PlanningDeps {
  config: CoreConfig;
  github: GitHub;
  planner: Planner;
  /** A private directory for one Objective's working files. */
  workDir(issue: number): string;
  /** This installation's Objective state directory: a predecessor's record is read from it. */
  objectives: string;
}

/**
 * Planning as steps. Keys carry a generation `g` (a new one after `replan`,
 * which re-reads the issue) and a round `n` (each revision):
 *
 *   plan:g:n   the planner's answer, decoded and checked
 *   review:g:n the independent plan review, when the draft is clean
 *   decide:g:n accept, revise, or ask the operator (the only place that asks)
 *   plan       the accepted plan, posted on the issue
 *
 * Every step's result is saved in `state.done`, so a restart repeats at most
 * the step that was running.
 */
export function planningStep(
  state: ObjectiveState,
  deps: PlanningDeps,
): Step | undefined {
  if (currentPlan(state)) return undefined;
  const { g, n } = position(state);
  const planKey = `plan:${g}:${n}`;
  const planned = state.done[planKey] as PlanRound | undefined;
  if (!planned) return forgetting(planRoundStep(planKey, g, n, deps));
  const reviewKey = `review:${g}:${n}`;
  if (cleanDraft(planned) && !state.done[reviewKey])
    return reviewStep(reviewKey, g, n, deps);
  const decideKey = `decide:${g}:${n}`;
  if (!state.done[decideKey]) return decideStep(decideKey, g, n, deps);
  const decided = state.done[decideKey] as Decision;
  if (decided.accept) return acceptStep(g, n, deps);
  return undefined; // position() already moved past a revise or replan
}

// ---------------------------------------------------------------------------
// Saved results

/** The issue and base a planning generation reads; the check step's result. */
export interface ObjectiveInputs {
  /** What GitHub shows of the issue body (shown.ts): its structure and the planner text. */
  shown: ShownObjective;
  /** The author can write: mermaid and math sources stay as code. */
  writer?: true;
  /** A Factory-created split child, from the raw body's marker (structure, never text). */
  child?: true;
  base: string;
  title: string;
  /**
   * The installation's review artifact selectors when the generation began:
   * its rounds, the controller guarantee list their answers index, and the
   * accepted plan all use these, whatever the configuration says later.
   */
  reviewArtifacts: ReviewArtifactSelector[];
  /** The Objective's Workflow recipe, resolved once at the base. */
  recipe?: RecipeSelection;
  /**
   * planning.adaptiveGraph when the Objective was admitted: the recipe check
   * and every plan round use this, so a config change can't split them.
   */
  adaptiveGraph?: true;
  /** The done predecessors' accepted results, checked to be on `base` (planning/predecessors.ts). */
  predecessors?: PredecessorEvidence[];
}

interface PlanRound {
  /** The operator's `replan`, recorded against the question it answered. */
  decision?: PlannerDecision;
  /** Generation inputs, saved on round 1 of each generation. */
  inputs?: ObjectiveInputs;
  /** The planner's full answer: the base of the next revision. */
  answer?: unknown;
  draft?: Draft;
  findings?: Finding[];
  question?: string;
  /** The operator answered `replan` to a problem with the Objective. */
  replan?: true;
}

interface ReviewRound {
  findings: ReviewFinding[];
  /** The operator answered `replan` while the review was held. */
  replan?: true;
  decision?: PlannerDecision;
}

interface Decision {
  accept?: true;
  replan?: true;
  /** Findings the next round fixes. */
  corrections?: (Finding & { itemIds?: string[] })[];
  /** Extra rounds the operator granted. */
  grant?: number;
  decision?: PlannerDecision;
  /** An `approve` that found the Objective edited, before this decision. */
  approved?: PlannerDecision;
}

function cleanDraft(round: PlanRound): boolean {
  return Boolean(round.draft && !round.findings?.length && !round.question);
}

/** Saved operator decisions in round order, from the decide steps whose key passes `keep`. */
export function decisions(
  state: ObjectiveState,
  keep: (key: string) => boolean = () => true,
): PlannerDecision[] {
  return Object.entries(state.done)
    .filter(([key]) => key.startsWith("decide:") && keep(key))
    .sort(([a], [b]) => compareKeys(a, b))
    .flatMap(([, value]) => {
      const { approved, decision } = value as Decision;
      return [approved, decision].filter(
        (d): d is PlannerDecision => d !== undefined,
      );
    });
}

function compareKeys(a: string, b: string): number {
  const [, ga, na] = a.split(":").map(Number);
  const [, gb, nb] = b.split(":").map(Number);
  return ga! - gb! || na! - nb!;
}

/** An answer as a planning decision, recorded against the question it answered. */
function decisionOf(answer: Answer, text?: string): PlannerDecision {
  return {
    question: answer.question ?? "",
    answer: answer.answer,
    ...(text ? { text } : {}),
    by: answer.by,
    at: answer.at,
  };
}

/** Exact commands the operator authorized with `allow`. */
function allowedCommands(state: ObjectiveState): string[] {
  return decisions(state)
    .filter((d) => d.answer === "allow" && d.text)
    .map((d) => d.text!.replace(/^`|`$/g, "").trim());
}

/** This generation's answers that carry content for the planner. */
function generationDecisions(
  state: ObjectiveState,
  g: number,
): PlannerDecision[] {
  return decisions(state, (key) => key.startsWith(`decide:${g}:`)).filter(
    (d) => d.answer === "answer" || d.answer === "allow",
  );
}

/** The decisions saved before round `m` of generation `g`. */
function decisionsBefore(
  state: ObjectiveState,
  g: number,
  m: number,
): PlannerDecision[] {
  return decisions(state, (key) => compareKeys(key, `decide:${g}:${m}`) < 0);
}

/** Workers get a sandboxed shell (docs/CORE.md). */
const WORKERS = { default: "shell" } as const;

/**
 * What the workers the planner may assign can execute: the Objective's
 * provider's (a sandboxed shell, as before), or with execution profiles,
 * each profile's provider's worker by kind. A Claude worker's shell needs
 * Write and Validate granted; the host's sandbox is checked when it runs.
 */
export function workers(
  config: CoreConfig,
): Readonly<Record<string, WorkerCommandAccess>> {
  const offered = recipeInstallation(config).profileIds;
  if (!offered.length) return WORKERS;
  return Object.fromEntries(
    offered.map((id) => {
      const provider =
        config.providers[config.execution.profiles![id]!.provider]!;
      const worker = resolvedProvider(provider).worker;
      const claude = worker.kind === "claude" && worker.settings;
      const granted = (tool: string) =>
        claude &&
        claude.tools!.includes(tool as never) &&
        claude.allowedTools!.includes(tool as never);
      const access: WorkerCommandAccess =
        worker.kind === "codex"
          ? "shell"
          : worker.kind === "claude"
            ? granted("Write") && granted("Validate")
              ? "shell"
              : "validation-only"
            : worker.kind === "copilot"
              ? "validation-only"
              : "undeclared";
      return [id, access];
    }),
  );
}

/**
 * The execution profiles the planner is offered, with what each is for:
 * the ones a recipe's expansions are checked against (recipeInstallation),
 * so the two agree. Undefined without any: the planner assigns none.
 */
export function offeredProfiles(
  config: CoreConfig,
): WireOptions["profiles"] | undefined {
  const ids = recipeInstallation(config).profileIds;
  if (!ids.length) return undefined;
  return ids.map((id) => {
    const { description, selectionHints } = config.execution.profiles![id]!;
    return {
      id,
      description,
      ...(selectionHints.length ? { selectionHints } : {}),
    };
  });
}

export const INVALID_ANSWER = "The planner's answer didn't match the schema";

/**
 * The exact base text of the repository sections the items named in the
 * findings cite, for a revision. Pinned sources are already in the prompt.
 */
async function citedSections(
  draft: Draft | undefined,
  fixes: (Finding & { itemIds?: string[] })[],
  facts: PlanningFacts,
  files: BaseFiles,
): Promise<{ path: string; heading?: string; content: string }[]> {
  if (!draft) return [];
  const ids = new Set(
    fixes.flatMap((f) => f.itemIds ?? (f.itemId ? [f.itemId] : [])),
  );
  const pinned = new Set(
    facts.sources.map((source) => `${source.path}#${source.heading ?? ""}`),
  );
  const seen = new Set<string>();
  const sections: { path: string; heading?: string; content: string }[] = [];
  for (const item of draftItems(draft)) {
    if (!ids.has(item.id)) continue;
    for (const citation of item.citations) {
      const id = `${citation.path}#${citation.heading ?? ""}`;
      if (pinned.has(id) || seen.has(id)) continue;
      seen.add(id);
      const text = await files.text(citation.path);
      if (text === undefined) continue;
      const content = citation.heading
        ? sectionText(text, citation.heading)
        : text;
      if (content === undefined) continue;
      sections.push({
        path: citation.path,
        ...(citation.heading ? { heading: citation.heading } : {}),
        content,
      });
    }
  }
  return sections;
}

// ---------------------------------------------------------------------------
// plan:g:n

function planRoundStep(
  key: string,
  g: number,
  n: number,
  deps: PlanningDeps,
): Step {
  return {
    key,
    resource: "planner",
    deadlineMs: 45 * MINUTE,
    run: async (context): Promise<Outcome> => {
      const { state, signal } = context;
      const { config } = deps;
      let inputs: ObjectiveInputs;
      if (g > 1 && n === 1) {
        // A replan re-reads the issue and the default branch.
        const fresh = await readObjective(deps, "replan", context);
        if ("hold" in fresh) return fresh.hold;
        inputs = fresh.inputs;
      } else inputs = generationInputs(state, g);
      const files = new BaseFiles(config.checkout, inputs.base, signal);
      const built = await planningFacts(state, inputs, files, config);
      if ("problems" in built)
        return objectiveProblemsHold(built.problems, "replan");
      const { facts } = built;
      const { workDir, repository } = await planningTree(
        deps,
        state.issue,
        inputs.base,
        signal,
      );
      const previousKey = n > 1 ? `plan:${g}:${n - 1}` : undefined;
      const previous = previousKey
        ? (state.done[previousKey] as PlanRound)
        : undefined;
      const fixes =
        n > 1
          ? (
              (state.done[`decide:${g}:${n - 1}`] as Decision).corrections ?? []
            ).filter((f) => f.source !== "operator")
          : [];
      // A broken answer last time: the planner sees why, once.
      const lastError = state.retries[key]?.lastError;
      const corrections = [
        ...operatorCorrections(generationDecisions(state, g)),
        ...fixes,
        ...(lastError?.startsWith(INVALID_ANSWER)
          ? [{ source: "check" as const, message: lastError }]
          : []),
      ];
      const revising = Boolean(previous?.answer);
      const profiles = offeredProfiles(config);
      const wire = {
        child: inputs.child === true,
        reviewArtifacts: inputs.reviewArtifacts.length > 0,
        adaptive: adaptiveGraph(
          inputs.shown.blocks,
          inputs.adaptiveGraph === true,
        ),
        ...(profiles ? { profiles } : {}),
      };
      // An enabled section still plans, with its context and memory but
      // without the graph kinds; say so once per generation.
      if (
        n === 1 &&
        adaptiveWorkflow(inputs.shown.blocks).enabled &&
        inputs.adaptiveGraph !== true
      )
        context.log({
          event: "adaptive-graph-off",
          message:
            "Adaptive workflow is enabled, but planning.adaptiveGraph is off: the planner isn't offered discovery items, work conditions or expansions",
        });
      const cited = revising
        ? await citedSections(previous!.draft, fixes, facts, files)
        : [];
      const lookups = plannerLookups(state, key, inputs, config);
      const data = {
        ...planChoices(facts, wire),
        ...(inputs.recipe ? { workflowRecipe: inputs.recipe.recipe } : {}),
        instructions: `${renderPlanningInstructions(
          inputs.shown.blocks,
          corrections,
          revising,
        )}${await commandInstructions(facts, config.checkout, signal)}`,
        ...(revising
          ? {
              currentPlan: previous!.answer,
              citedSections: cited.map((section, at) => ({
                path: section.path,
                heading: section.heading ?? "",
                content: { block: `section ${at}` },
              })),
            }
          : {}),
        ...(lookups ? { contextLookups: lookups.data } : {}),
      };
      const local = await localExecutables(inputs, config, signal);
      const prompt = renderCompilationCall({
        facts,
        data,
        revising,
        repository,
        workers: workers(config),
        citedSections: cited,
        localExecutables: local.observations,
        reviewArtifacts: inputs.reviewArtifacts,
        adaptive: wire.adaptive,
        recipe: Boolean(inputs.recipe),
        executionProfiles: Boolean(profiles),
        ...(inputs.predecessors ? { prerequisites: inputs.predecessors } : {}),
        ...(lookups ? { lookups } : {}),
      });
      const schema = revising
        ? revisionSchema(facts, wire)
        : planSchema(facts, wire);
      const answer = await deps.planner.answer({
        role: "planner",
        phase: "plan",
        prompt,
        schema: lookups ? lookups.schema(schema) : schema,
        readDir: workDir,
        signal,
        log: context.log,
      });
      context.log({
        event: "planner-answer",
        model: answer.model,
        ms: answer.ms,
        usage: answer.usage,
      });
      const taken = lookups
        ? await lookups.take(answer.value, {
            issue: state.issue,
            files,
            secrets: config.secrets,
            log: context.log,
          })
        : { value: answer.value };
      if ("outcome" in taken) return taken.outcome;
      let full: unknown = taken.value;
      if (revising) {
        const revised = applyRevision(
          previous!.answer,
          taken.value,
          facts,
          wire,
        );
        if (revised.invalidShape) return invalidAnswer(revised.findings);
        if (!revised.answer)
          return done({
            ...(g > 1 && n === 1 ? { inputs } : {}),
            answer: previous!.answer,
            findings: revised.findings,
          });
        full = revised.answer;
      }
      const decoded = decodePlan(full, facts, wire);
      if (decoded.invalidShape) return invalidAnswer(decoded.findings);
      const round: PlanRound = {
        ...(g > 1 && n === 1 ? { inputs } : {}),
        answer: full,
      };
      if (decoded.question)
        return done({ ...round, question: decoded.question });
      if (!decoded.plan) return done({ ...round, findings: decoded.findings });
      const findings = [
        ...decoded.findings,
        ...(await checkPlan(decoded.plan, facts, files, previous?.draft)),
        ...(inputs.recipe
          ? recipeFindings(decoded.plan, inputs.recipe.recipe)
          : []),
      ];
      return done({
        ...round,
        draft: decoded.plan,
        ...(findings.length ? { findings } : {}),
      });
    },
  };
}

function operatorCorrections(all: PlannerDecision[]): Finding[] {
  return all.map((d) => ({
    source: "operator" as const,
    message: `${d.question}\nAnswer: ${d.answer}${d.text ? ` — ${d.text}` : ""}`,
  }));
}

// ---------------------------------------------------------------------------
// review:g:n

function reviewStep(
  key: string,
  g: number,
  n: number,
  deps: PlanningDeps,
): Step {
  return {
    key,
    resource: "planner",
    deadlineMs: 45 * MINUTE,
    run: async (context): Promise<Outcome> => {
      const { state, signal } = context;
      const { config } = deps;
      const inputs = generationInputs(state, g);
      const built = await planningFacts(
        state,
        inputs,
        new BaseFiles(config.checkout, inputs.base, signal),
        config,
      );
      if ("problems" in built)
        return objectiveProblemsHold(built.problems, "replan");
      const { facts } = built;
      const draft = (state.done[`plan:${g}:${n}`] as PlanRound).draft!;
      const all = decisions(state);
      const local = await localExecutables(inputs, config, signal);
      const evidence = planningReviewEvidence({
        sources: facts.sources,
        decisions: all,
        localExecutables: local.observations,
        prerequisites: inputs.predecessors,
      });
      const { workDir, repository } = await planningTree(
        deps,
        state.issue,
        inputs.base,
        signal,
      );
      const scope = lastReview(state, g, n);
      const prompt = renderGraphReviewCall({
        facts,
        draft,
        evidence,
        decisions: all,
        finalCommands: finalCommands(
          inputs.shown.blocks,
          config.finalValidation.requiredCommands,
        ),
        controllerCapabilities: controllerGuarantees(
          inputs.reviewArtifacts.length > 0,
        ),
        reviewArtifacts: inputs.reviewArtifacts,
        repository,
        workers: workers(config),
        ...(inputs.recipe ? { workflowRecipe: inputs.recipe.recipe } : {}),
        ...(offeredProfiles(config)
          ? { executionProfiles: offeredProfiles(config) }
          : {}),
        ...(scope
          ? {
              scope: revisionScope(
                n,
                {
                  ...scope,
                  decisions: decisionsBefore(state, g, scope.round),
                },
                { draft, decisions: all },
              ),
            }
          : {}),
      });
      const answer = await deps.planner.answer({
        role: "reviewer",
        phase: "graph-review",
        prompt,
        schema: graphReviewSchema(),
        readDir: workDir,
        signal,
        log: context.log,
      });
      const decoded = decodeGraphReview(
        answer.value,
        evidence,
        draftItems(draft).map((item) => item.id),
      );
      if (decoded.invalid)
        return errored(`The plan review answer was invalid: ${decoded.reason}`);
      const result: ReviewRound = { findings: decoded.findings };
      return done(result);
    },
  };
}

/** The last reviewed round of this generation before round `n`. */
function lastReview(
  state: ObjectiveState,
  g: number,
  n: number,
): { draft: Draft; findings: Finding[]; round: number } | undefined {
  for (let m = n - 1; m >= 1; m--) {
    const review = state.done[`review:${g}:${m}`] as ReviewRound | undefined;
    if (review)
      return {
        draft: (state.done[`plan:${g}:${m}`] as PlanRound).draft!,
        findings: review.findings,
        round: m,
      };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// decide:g:n

// Text is required (`needsText`): the engine refuses an answer without it.
const ANSWERING: Offer = {
  answer: "answer",
  family: "answer",
  consequence: "Sends your decision back to the planner.",
  needsText: true,
};
const ASK: Offer[] = [
  ANSWERING,
  {
    answer: "allow",
    family: "answer",
    consequence:
      "Authorizes that exact validation command for this Objective and plans again.",
    needsText: true,
  },
  "replan",
  "cancel",
];

function decideStep(
  key: string,
  g: number,
  n: number,
  deps: PlanningDeps,
): Step {
  return {
    key,
    deadlineMs: 5 * MINUTE,
    run: async ({ state, answer, signal }: StepContext): Promise<Outcome> => {
      const planned = state.done[`plan:${g}:${n}`] as PlanRound;
      const reviewed = state.done[`review:${g}:${n}`] as
        | ReviewRound
        | undefined;
      const findings: (Finding & { itemIds?: string[] })[] = [
        ...(planned.findings ?? []),
        ...(reviewed?.findings ?? []),
      ];
      const fixes = findings.filter((f) => f.kind !== "operator-decision");
      const asks = findings.filter((f) => f.kind === "operator-decision");
      if (planned.replan || reviewed?.replan) {
        const decision = planned.decision ?? reviewed?.decision;
        return done({
          replan: true,
          ...(decision ? { decision } : {}),
        } satisfies Decision);
      }
      const question = questionFor(state, g, n, planned, fixes, asks);
      // An `approve` that found the Objective edited (see changedHold).
      const approvedKey = `${key}:approved`;
      const approved = state.kept?.[approvedKey] as PlannerDecision | undefined;
      const withApproved = (
        decision: Decision,
        keep: Record<string, unknown> = {},
      ): Outcome => ({
        kind: "done",
        result: approved ? { ...decision, approved } : decision,
        keep: { [approvedKey]: null, ...keep },
      });
      if (answer) {
        const record = (text?: string) => decisionOf(answer, text);
        switch (answer.answer) {
          case "more":
            return done({
              corrections: fixes,
              grant: grant(state, "planningRevisions"),
              decision: record(),
            } satisfies Decision);
          case "approve":
            if (await objectiveChanged(state, g, deps, signal))
              return {
                ...changedHold(state),
                keep: { [approvedKey]: record() },
              };
            return done({
              accept: true,
              decision: record(),
            } satisfies Decision);
          case "continue":
            // The operator keeps this plan for the text GitHub shows now:
            // build-time edit detection starts from it.
            return withApproved(
              { accept: true, decision: record() },
              {
                [OBJECTIVE_ACCEPTED]: await shownNow(state, g, deps, signal),
              },
            );
          case "answer":
          case "allow": {
            // Text is required (ASK): the engine refuses an answer without it.
            const decision = record((answer.text ?? "").trim());
            return done({
              decision,
              corrections: [...fixes, ...operatorCorrections([decision])],
            } satisfies Decision);
          }
        }
      }
      if (question) return hold(question.text, question.offers);
      if (findings.length === 0) {
        // Before accepting, the Objective must still read as planning read it.
        if (answer?.answer !== "continue") {
          const changed = await objectiveChanged(state, g, deps, signal);
          if (changed) return changedHold(state);
        }
        return done({ accept: true } satisfies Decision);
      }
      return done({ corrections: fixes } satisfies Decision);
    },
  };
}

/**
 * The operator's `replan` to a planning question (`plan:g:n`,
 * `review:g:n`, `decide:g:n`), routed by the workflow: the step records
 * it with the decision, and the decide step starts a new generation,
 * which re-reads the issue.
 */
export function planningReplan(
  state: ObjectiveState,
  key: string,
  answer: Answer,
): Outcome {
  const decision = decisionOf(answer);
  if (!key.startsWith("decide:"))
    return {
      kind: "done",
      result: {
        replan: true,
        decision,
        ...(key.startsWith("review:") ? { findings: [] } : {}),
      } satisfies PlanRound | ReviewRound,
      // A plan step's kept lookup rounds end with it.
      ...(key.startsWith("plan:") ? { keep: { [lookupsKey(key)]: null } } : {}),
    };
  // An `approve` that found the Objective edited (see changedHold).
  const approvedKey = `${key}:approved`;
  const approved = state.kept?.[approvedKey] as PlannerDecision | undefined;
  return {
    kind: "done",
    result: {
      replan: true,
      decision,
      ...(approved ? { approved } : {}),
    } satisfies Decision,
    keep: { [approvedKey]: null },
  };
}

function changedHold(
  state: ObjectiveState,
): Extract<Outcome, { kind: "hold" }> {
  return hold(
    `Objective #${state.issue} was edited after planning read it. \`replan\` plans again from the new text; \`continue\` keeps this plan.`,
    [
      "replan",
      {
        answer: "continue",
        family: "accept",
        consequence: "Keeps this plan and accepts the issue as it reads now.",
      },
      "cancel",
    ],
  );
}

/** Whether what GitHub shows of the issue differs from what this generation planned from. */
async function objectiveChanged(
  state: ObjectiveState,
  g: number,
  deps: PlanningDeps,
  signal: AbortSignal,
): Promise<boolean> {
  return (
    (await shownNow(state, g, deps, signal)) !==
    shownDigest(generationInputs(state, g).shown)
  );
}

/** The digest of what GitHub shows of the issue now, read as this generation read it. */
async function shownNow(
  state: ObjectiveState,
  g: number,
  deps: PlanningDeps,
  signal: AbortSignal,
): Promise<string> {
  const inputs = generationInputs(state, g);
  const issue = await deps.github.renderedIssue(state.issue, signal);
  return shownDigest(
    readShown(issue.body_html, { sources: inputs.writer === true }),
  );
}

/**
 * The digest of the Objective text the operator accepted when it differs
 * from what planning read (a `continue` to an edit): building checks for
 * later edits against it (work/steps.ts objectiveEdited).
 */
export const OBJECTIVE_ACCEPTED = "objective:accepted";

/** The question this round needs answered, if any. Recomputed, so an answer re-derives the same text. */
function questionFor(
  state: ObjectiveState,
  g: number,
  n: number,
  planned: PlanRound,
  fixes: Finding[],
  asks: Finding[],
): { text: string; offers: Offer[] } | undefined {
  const list = (items: Finding[]) =>
    items.map((f, i) => `${i + 1}. ${f.message}`).join("\n");
  if (planned.question)
    return {
      text: `The planner needs a decision:\n\n${planned.question}\n\nAnswer with \`answer <your choice>\`. If it needs a validation command the Objective doesn't list, \`allow <exact command>\` authorizes it.`,
      offers: ASK,
    };
  if (asks.length && !fixes.length && !state.done[`review:${g}:${n}`])
    return {
      text: `Factory's plan checks found ${asks.length === 1 ? "a question" : "questions"} only you can decide:\n\n${list(asks)}\n\n\`answer <decision>\` sends your decision back to the planner.`,
      offers: ASK,
    };
  if (asks.length && !fixes.length)
    return {
      text: `The plan reviewer found ${asks.length === 1 ? "a question" : "questions"} only you can decide:\n\n${list(asks)}\n\n\`approve\` runs the plan as it is; \`answer <decision>\` sends your decision back to the planner.`,
      offers: [
        ANSWERING,
        {
          answer: "approve",
          family: "accept",
          consequence: "Runs the plan as it is.",
        },
        ...ASK.slice(1),
      ],
    };
  if (!fixes.length) return undefined;
  const previous =
    n > 1 ? (state.done[`decide:${g}:${n - 1}`] as Decision) : undefined;
  if (previous?.corrections && sameFindings(previous.corrections, fixes))
    return {
      text: `Plan round ${n} came back with the same problems as round ${n - 1}:\n\n${list(fixes)}\n\nAnswer with guidance for the planner, or \`replan\` after editing the Objective.`,
      offers: ASK,
    };
  const allowance = allowances(state).planningRevisions + granted(state, g, n);
  if (fixRounds(state, g, n) > allowance)
    return {
      text: `The plan still has ${fixes.length} problem${fixes.length === 1 ? "" : "s"} after ${n} rounds, past the ${allowance} autonomy.allowances.planningRevisions allows:

${list(fixes)}

\`more\` allows ${grant(state, "planningRevisions")} more rounds.`,
      offers: [
        {
          answer: "more",
          family: "retry",
          consequence: `Allows ${grant(state, "planningRevisions")} more plan rounds.`,
        },
        ...ASK,
      ],
    };
  return undefined;
}

/** Rounds of this generation spent on fixes (not on operator answers), this one included. */
function fixRounds(state: ObjectiveState, g: number, n: number): number {
  let rounds = 1;
  for (let m = 1; m < n; m++) {
    const decided = state.done[`decide:${g}:${m}`] as Decision | undefined;
    // A `more` grant is a decision, but the round after it fixes findings.
    if (decided && (!decided.decision || decided.grant)) rounds += 1;
  }
  return rounds;
}

/**
 * Planning revisions of the current generation: the rounds spent on fixes
 * before this one, plus the amendments of the plan it accepted, and the
 * rounds allowed with the operator's grants.
 */
export function planningRevisions(state: ObjectiveState): Usage {
  const { g, n } = position(state);
  return {
    used: fixRounds(state, g, n) - 1 + proposalsOf(state).length,
    allowed: allowances(state).planningRevisions + granted(state, g, n),
  };
}

function granted(state: ObjectiveState, g: number, n: number): number {
  let total = 0;
  for (let m = 1; m < n; m++)
    total +=
      (state.done[`decide:${g}:${m}`] as Decision | undefined)?.grant ?? 0;
  return total;
}

function sameFindings(a: Finding[], b: Finding[]): boolean {
  const text = (list: Finding[]) =>
    list
      .map((f) => f.message)
      .sort()
      .join("\n");
  return text(a) === text(b);
}

// ---------------------------------------------------------------------------
// plan (accept)

/**
 * The accepted generation's inputs and the planner's full answer for the
 * accepted draft: the base an amendment revises.
 */
export function acceptedRound(state: ObjectiveState): {
  inputs: ObjectiveInputs;
  answer: unknown;
} {
  const { g, n } = position(state);
  for (let m = n; m >= 1; m--) {
    const round = state.done[`plan:${g}:${m}`] as PlanRound | undefined;
    if (round?.draft)
      return { inputs: generationInputs(state, g), answer: round.answer };
  }
  throw new Error("The accepted plan has no planning round");
}

function acceptStep(g: number, n: number, deps: PlanningDeps): Step {
  return {
    key: "plan",
    deadlineMs: 10 * MINUTE,
    run: async ({ state, signal }): Promise<Outcome> => {
      const inputs = generationInputs(state, g);
      // The accepted draft is the last round that had one.
      let draft: Draft | undefined;
      for (let m = n; m >= 1 && !draft; m--)
        draft = (state.done[`plan:${g}:${m}`] as PlanRound | undefined)?.draft;
      if (!draft)
        return failure(
          "Step plan failed: the accepted round has no plan. Answer retry to read it again; or cancel.",
        );
      const plan: Plan = {
        ...draft,
        finalCommands: finalCommands(
          inputs.shown.blocks,
          deps.config.finalValidation.requiredCommands,
        ),
        decisions: decisions(state),
        ...(inputs.reviewArtifacts.length
          ? { reviewArtifacts: inputs.reviewArtifacts }
          : {}),
      };
      await postPlan(deps, state.issue, plan, signal);
      return {
        kind: "done",
        result: plan,
        keep: { [ACCEPTED_AT]: new Date().toISOString() },
      };
    },
  };
}

const PLAN_MARK = (issue: number) => `<!-- factory:${issue}:plan -->`;
const PART_MARK = (issue: number, part: number) =>
  `<!-- factory:${issue}:plan-data:${part} -->`;
/**
 * A comment's size limit, below GitHub's 65,536. FACTORY_COMMENT_LIMIT
 * (tests only; 1,000 to 65,000) lowers it, so a small plan takes the
 * continuation comments and the `plan:data:*` crash points are reached.
 */
export const COMMENT_LIMIT = commentLimit(process.env.FACTORY_COMMENT_LIMIT);
/** Plan JSON per continuation comment, leaving room for its wrapper. */
const PART_SIZE = COMMENT_LIMIT - Math.min(5_000, COMMENT_LIMIT / 2);

function commentLimit(value: string | undefined): number {
  const limit = Number(value);
  return value && Number.isInteger(limit) && limit >= 1_000
    ? Math.min(limit, 65_000)
    : 65_000;
}
/** Work Items the summary lists by name; the data lists them all. */
const LISTED_ITEMS = 200;

/**
 * Post the plan on the issue, or edit the comments already there. The plan
 * data (what `factory reset` rebuilds from) goes in the plan comment when
 * it fits, else in numbered continuation comments the plan comment names;
 * it is never dropped. An accepted amendment posts its plan the same way,
 * with `note` saying which amendment it is and its own crash points
 * (`point`: `<point>:post:*`, `<point>:data:*`).
 */
export async function postPlan(
  deps: PlanningDeps,
  issue: number,
  plan: Plan,
  signal: AbortSignal,
  { point = "plan", note }: { point?: string; note?: string } = {},
): Promise<void> {
  const marker = PLAN_MARK(issue);
  const children = plan.split
    ? plan.split.children
        .map(
          (child) =>
            `- **${child.key}** ${prose(child.title)} (child Objective)`,
        )
        .join("\n")
    : "";
  const listed = plan.items.slice(0, LISTED_ITEMS);
  const items = `${listed
    .map(
      (item) =>
        `- **${item.id}** ${prose(item.title)}${item.dependencies.length ? ` (after ${item.dependencies.join(", ")})` : ""}`,
    )
    .join(
      "\n",
    )}${plan.items.length > listed.length ? `\n- and ${plan.items.length - listed.length} more (see the plan data)` : ""}`;
  const summary =
    `${marker}\n**Factory's plan** (${plan.split ? `split into ${plan.split.children.length} child Objectives` : `${plan.items.length} Work Item${plan.items.length === 1 ? "" : "s"}`}, base \`${plan.base.slice(0, 12)}\`)${note ? `\n\n${note}` : ""}\n\n${plan.split ? children : items}${plan.decisions.length ? `\n\nDecisions:\n${plan.decisions.map((d) => `- ${d.answer}${d.text ? `: ${prose(d.text)}` : ""} (${prose(d.by)})`).join("\n")}` : ""}`.slice(
      0,
      COMMENT_LIMIT - 200,
    );
  const json = JSON.stringify(plan);
  const data = (text: string, label: string) =>
    `\n\n<details><summary>${label}</summary>\n\n\`\`\`json\n${text}\n\`\`\`\n</details>`;
  const whole = data(json, "Plan data");
  const parts: string[] = [];
  if (summary.length + whole.length > COMMENT_LIMIT)
    for (let at = 0; at < json.length; at += PART_SIZE)
      parts.push(json.slice(at, at + PART_SIZE));
  const body = parts.length
    ? `${summary}\n\nPlan data: in the ${parts.length} comments marked \`factory:${issue}:plan-data:1\` to \`:${parts.length}\` below; join their JSON in order.`
    : summary + whole;
  // Continuation parts first: the plan comment names them only once they exist.
  for (const [index, part] of parts.entries())
    await deps.github.upsertComment(
      issue,
      PART_MARK(issue, index + 1),
      `${PART_MARK(issue, index + 1)}${data(part, `Plan data, part ${index + 1} of ${parts.length}`)}`,
      `${point}:data`,
      signal,
    );
  await deps.github.upsertComment(issue, marker, body, `${point}:post`, signal);
}

// ---------------------------------------------------------------------------
// Shared

/**
 * Read the issue and the default branch head, and run the Objective checks.
 * `again` is the answer that reads it again once the operator has edited it.
 */
export async function readObjective(
  deps: PlanningDeps,
  again: "recheck" | "replan",
  context: StepContext,
): Promise<{ inputs: ObjectiveInputs } | { hold: Outcome }> {
  const { config } = deps;
  const { state, signal } = context;
  const issue = state.issue;
  // The checkout can change under a running service.
  const own = ownRepositoryProblem(config.repository, config.checkout);
  if (own)
    return {
      hold: objectiveWide(
        hold(
          `${own}. Fix the configuration and restart the service; or cancel.`,
          ["cancel", "retry"],
        ),
      ),
    };
  const found = await deps.github.renderedIssue(issue, signal);
  if (found.state !== "open") {
    const by = found.closed_by?.login ? `@${found.closed_by.login}` : "someone";
    const reason = found.state_reason ? ` as ${found.state_reason}` : "";
    // Closed again after the re-run reopened it: something on GitHub
    // closes it, and reopening it alone won't hold.
    if (state.kept?.[REOPENED])
      return {
        hold: hold(
          `Factory reopened issue #${issue} to run it again, but ${by} closed it again${reason}, so Factory won't plan on it. A Project workflow (such as "Auto-close issue", while the item's built-in Status reads Done) or other automation does this: stop it, reopen the issue, then answer retry; or cancel.`,
        ),
      };
    return {
      hold: hold(
        `Issue #${issue} is closed (${by} closed it${reason}). Reopen it and answer \`${again}\`, or cancel. If the Project's "Auto-close issue" workflow closes it again, set the item's Status off Done first.`,
        ["cancel", againOffer(again)],
      ),
    };
  }
  // Planning reads what GitHub shows; Factory's own marker is structure.
  const author = found.user?.login;
  const writer = !!author && (await deps.github.canWrite(author, signal));
  const shown = readShown(found.body_html, { sources: writer });
  if (!writer) {
    const unapproved = authorHold(author, shown, context);
    if (unapproved) return { hold: unapproved };
  }
  const inputs: ObjectiveInputs = {
    shown,
    ...(writer && { writer: true as const }),
    ...(childIdentity(found.body ?? "") && { child: true as const }),
    base: await defaultHead(config.checkout, config.repository, signal),
    title: found.title,
    reviewArtifacts: config.reviewArtifacts,
  };
  const { problems } = checkObjective(shown.blocks);
  // The optional declarations (Package manager update, Quality checkpoint,
  // Workspace package additions, Adaptive workflow): checked here once,
  // trusted afterwards.
  problems.push(...declarationProblems(shown.blocks));
  const recipe = await selectRecipe(
    shown.blocks,
    new BaseFiles(config.checkout, inputs.base, signal),
  );
  if (recipe.problem) problems.push(recipe.problem);
  if (recipe.selected) {
    problems.push(
      ...recipePrerequisites(
        recipe.selected.recipe,
        adaptiveWorkflow(shown.blocks).enabled,
        recipeInstallation(config),
      ),
    );
    inputs.recipe = recipe.selected;
  }
  if (config.planning.adaptiveGraph) inputs.adaptiveGraph = true;
  if (!problems.length)
    problems.push(
      ...(await objectiveCommandProblems(shown, inputs.base, config.checkout, {
        child: inputs.child === true,
        requiredCommands: config.finalValidation.requiredCommands,
        ciOnlyCommands: config.finalValidation.ciOnlyCommands,
        signal,
      })),
    );
  if (!problems.length)
    problems.push(...(await localExecutables(inputs, config, signal)).problems);
  if (problems.length) return { hold: objectiveProblemsHold(problems, again) };
  // Planning reads a base that has its predecessors' accepted work.
  const predecessors = predecessorEvidence(state);
  if (predecessors.length) {
    const off = await predecessorsOnBase(
      config.checkout,
      predecessors,
      inputs.base,
      signal,
    );
    if (off) return { hold: predecessorsHold(off) };
    inputs.predecessors = predecessors;
  }
  return { inputs };
}

/** Where the operator's approval of a non-writer's Objective is kept. */
const AUTHOR_APPROVAL = "objective:author-approval";
/** Set by a re-run that reopened the issue; the check that follows clears it. */
export const REOPENED = "rerun:reopened";

/**
 * An issue a non-writer wrote is planned only once a writer approves its
 * text: until then nothing in it (its commands, Sources, local assets or
 * instructions) counts. The approval holds for that exact shown Objective,
 * by digest, so a later edit asks again. The question names the digest, and
 * an `approve` counts only while the Objective still has it, so an edit made
 * between the question and the answer asks again too.
 */
function authorHold(
  author: string | undefined,
  shown: ShownObjective,
  context: StepContext,
): Outcome | undefined {
  const { state, answer } = context;
  const digest = shownDigest(shown).slice(0, 16);
  const approval = state.kept?.[AUTHOR_APPROVAL] as
    | { digest: string }
    | undefined;
  if (approval?.digest === digest) return undefined;
  if (answer?.answer === "approve" && answer.question?.includes(digest))
    return {
      kind: "retry",
      reason: "Planning the approved Objective.",
      progress: true,
      keep: {
        [AUTHOR_APPROVAL]: { digest, by: answer.by, at: answer.at },
      },
    };
  return objectiveWide(
    hold(
      `Issue #${state.issue} was written by ${author ? `@${author}` : "a deleted account"}, who has no write access; approve to plan it.\n\nFactory plans from what GitHub shows of it (digest \`${digest}\`), so content GitHub hides never reaches a model. Diagram and math sources aren't planner input either: each mermaid diagram is \`[mermaid diagram]\` and each math block \`[math]\`, as you see only the drawing. Nothing in it counts until you approve, and an edit asks again.`,
      [
        {
          answer: "approve",
          family: "accept",
          consequence: "Plans the Objective as GitHub shows it now.",
        },
        "cancel",
      ],
    ),
  );
}

/** The answer that checks an edited Objective again: before planning `recheck`, after it `replan`. */
function againOffer(again: "recheck" | "replan"): Offer {
  return again === "replan"
    ? "replan"
    : {
        answer: "recheck",
        family: "retry",
        consequence: "Checks the edited Objective again.",
      };
}

function objectiveProblemsHold(
  problems: string[],
  again: "recheck" | "replan",
): Outcome {
  return hold(
    `This Objective needs fixing before Factory can plan it:\n${problems.map((p) => `- ${p}`).join("\n")}\n\nEdit the issue, then answer \`${again}\`.`,
    [againOffer(again), "cancel"],
  );
}

/** The planner's facts at the generation's base, with the operator's allowed commands. */
export async function planningFacts(
  state: ObjectiveState,
  inputs: ObjectiveInputs,
  files: BaseFiles,
  config: CoreConfig,
): ReturnType<typeof buildFacts> {
  return buildFacts({
    objective: state.issue,
    shown: inputs.shown,
    child: inputs.child === true,
    base: inputs.base,
    checkout: config.checkout,
    requiredCommands: config.finalValidation.requiredCommands,
    ciOnlyCommands: config.finalValidation.ciOnlyCommands,
    extraCommands: allowedCommands(state),
    localAssetRoots: config.media.localAssetRoots,
    discoveryLimits: config.planning.discoveryLimits,
    // No playbook in the target reads as empty. Knowledge adds the pinned
    // Dream playbook and, for Adaptive workflow, planning context and memory.
    playbook: await planningKnowledge({
      state,
      shown: inputs.shown,
      child: inputs.child === true,
      files,
      playbook: (await files.text(config.planning.playbook)) ?? "",
    }),
    ...(files.signal ? { signal: files.signal } : {}),
  });
}

export function localExecutables(
  inputs: ObjectiveInputs,
  config: CoreConfig,
  signal: AbortSignal,
): ReturnType<typeof observeLocalExecutables> {
  return observeLocalExecutables({
    checkout: config.checkout,
    base: inputs.base,
    blocks: inputs.shown.blocks,
    finalCommands: finalCommands(
      inputs.shown.blocks,
      config.finalValidation.requiredCommands,
    ),
    signal,
  });
}

/** The base tree exported for reading, and its map and conventions. */
export async function planningTree(
  deps: PlanningDeps,
  issue: number,
  base: string,
  signal: AbortSignal,
): Promise<{ workDir: string; repository: RepositoryView }> {
  const workDir = treeDir(deps, issue, base);
  await exportTree(deps.config.checkout, base, workDir, signal);
  return {
    workDir,
    repository: await repositoryView(deps.config.checkout, base, true, signal),
  };
}

/** The exported base tree for planning. Trees of other bases are removed. */
function treeDir(deps: PlanningDeps, issue: number, base: string): string {
  const root = deps.workDir(issue);
  const name = `tree-${base.slice(0, 12)}`;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const entry of readdirSync(root))
    if (entry.startsWith("tree-") && entry !== name)
      rmSync(join(root, entry), { recursive: true, force: true });
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function done(result: unknown): Outcome {
  return { kind: "done", result };
}

export function invalidAnswer(
  findings: Finding[],
): Extract<Outcome, { kind: "retry" }> {
  return errored(
    `${INVALID_ANSWER}: ${findings
      .map((f) => f.message)
      .join("; ")
      .slice(0, 500)}`,
  );
}
