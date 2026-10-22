import { execFile } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { CoreConfig } from "../config.js";
import type { Outcome, Step, StepContext } from "../engine.js";
import { type GitHub, GitHubError, TransientError } from "../github.js";
import { checkSources, parseObjective } from "../objective.js";
import { type Planner, PlannerError } from "../providers/planner.js";
import type { ObjectiveState } from "../state.js";
import { checkPlan } from "./checks.js";
import {
  BaseFiles,
  buildFacts,
  childIdentity,
  commandInstructions,
  finalCommands,
  objectiveCommandProblems,
  sectionText,
} from "./facts.js";
import {
  draftItems,
  renderCompilationCall,
  renderGraphReviewCall,
  renderPlanningInstructions,
  revisionScope,
} from "./prompts.js";
import { observeLocalExecutables } from "./executables.js";
import { exportTree, repositoryView } from "./repository.js";
import {
  decodeGraphReview,
  graphReviewSchema,
  planningReviewEvidence,
  type ReviewFinding,
} from "./review.js";
import type {
  Draft,
  Finding,
  Plan,
  PlannerDecision,
  PlanningFacts,
} from "./types.js";
import {
  applyRevision,
  CONTROLLER_GUARANTEES,
  decodePlan,
  planChoices,
  planSchema,
  revisionSchema,
} from "./wire.js";

const run = promisify(execFile);
const MINUTE = 60_000;

/** What planning needs from the installation. */
export interface PlanningDeps {
  config: CoreConfig;
  github: GitHub;
  planner: Planner;
  /** A private directory for one Objective's working files. */
  workDir(issue: number): string;
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
  if (state.done.plan) return undefined;
  const { g, n } = position(state);
  const planKey = `plan:${g}:${n}`;
  const planned = state.done[planKey] as PlanRound | undefined;
  if (!planned) return planRoundStep(planKey, g, n, deps);
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

interface Inputs {
  body: string;
  base: string;
  title: string;
}

interface PlanRound {
  /** Generation inputs, saved on round 1 of each generation. */
  inputs?: Inputs;
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
}

interface Decision {
  accept?: true;
  replan?: true;
  /** Findings the next round fixes. */
  corrections?: (Finding & { itemIds?: string[] })[];
  /** Extra rounds the operator granted. */
  grant?: number;
  decision?: PlannerDecision;
}

/** The current generation and round, from the saved decisions. */
function position(state: ObjectiveState): { g: number; n: number } {
  let g = 1;
  let n = 1;
  for (;;) {
    const decided = state.done[`decide:${g}:${n}`] as Decision | undefined;
    if (!decided || decided.accept) return { g, n };
    if (decided.replan) {
      g += 1;
      n = 1;
    } else n += 1;
  }
}

function cleanDraft(round: PlanRound): boolean {
  return Boolean(round.draft && !round.findings?.length && !round.question);
}

function generationInputs(state: ObjectiveState, g: number): Inputs {
  if (g > 1) return (state.done[`plan:${g}:1`] as PlanRound).inputs!;
  return state.done.check as Inputs;
}

function decisions(state: ObjectiveState): PlannerDecision[] {
  return Object.entries(state.done)
    .filter(([key]) => key.startsWith("decide:"))
    .sort(([a], [b]) => compareKeys(a, b))
    .flatMap(([, value]) => {
      const decision = (value as Decision).decision;
      return decision ? [decision] : [];
    });
}

function compareKeys(a: string, b: string): number {
  const [, ga, na] = a.split(":").map(Number);
  const [, gb, nb] = b.split(":").map(Number);
  return ga! - gb! || na! - nb!;
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
  return Object.entries(state.done)
    .filter(([key]) => key.startsWith(`decide:${g}:`))
    .sort(([a], [b]) => compareKeys(a, b))
    .flatMap(([, value]) => {
      const decision = (value as Decision).decision;
      return decision &&
        (decision.answer === "answer" || decision.answer === "allow")
        ? [decision]
        : [];
    });
}

/** The decisions saved before round `m` of generation `g`. */
function decisionsBefore(
  state: ObjectiveState,
  g: number,
  m: number,
): PlannerDecision[] {
  return Object.entries(state.done)
    .filter(
      ([key]) =>
        key.startsWith("decide:") && compareKeys(key, `decide:${g}:${m}`) < 0,
    )
    .sort(([a], [b]) => compareKeys(a, b))
    .flatMap(([, value]) => {
      const decision = (value as Decision).decision;
      return decision ? [decision] : [];
    });
}

/** Workers get a sandboxed shell (docs/CORE.md). */
const WORKERS = { default: "shell" } as const;

const INVALID_ANSWER = "The planner's answer didn't match the schema";

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
    deadlineMs: 45 * MINUTE,
    run: (context) =>
      guarded(async () => {
        const { state, signal } = context;
        const { config } = deps;
        // `replan` after an Objective problem: start a new generation, which re-reads the issue.
        if (context.answer?.answer === "replan")
          return done({ replan: true } satisfies PlanRound);
        const files = (base: string) =>
          new BaseFiles(config.checkout, base, signal);
        let inputs: Inputs;
        if (g > 1 && n === 1) {
          // A replan re-reads the issue and the default branch.
          const fresh = await rereadObjective(state.issue, deps, signal);
          if ("hold" in fresh) return fresh.hold;
          inputs = fresh.inputs;
        } else inputs = generationInputs(state, g);
        const built = await buildFacts({
          objective: state.issue,
          body: inputs.body,
          base: inputs.base,
          checkout: config.checkout,
          requiredCommands: config.finalValidation.requiredCommands,
          ciOnlyCommands: config.finalValidation.ciOnlyCommands,
          extraCommands: allowedCommands(state),
          playbook: await readPlaybook(config, inputs.base, signal),
          signal,
        });
        if ("problems" in built) return objectiveProblemsHold(built.problems);
        const { facts } = built;
        const workDir = treeDir(deps, state.issue, inputs.base);
        await exportTree(config.checkout, inputs.base, workDir, signal);
        const repository = await repositoryView(
          config.checkout,
          inputs.base,
          true,
          signal,
        );
        const previousKey = n > 1 ? `plan:${g}:${n - 1}` : undefined;
        const previous = previousKey
          ? (state.done[previousKey] as PlanRound)
          : undefined;
        const fixes =
          n > 1
            ? (
                (state.done[`decide:${g}:${n - 1}`] as Decision).corrections ??
                []
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
        const wire = { child: childIdentity(inputs.body) };
        const cited = revising
          ? await citedSections(
              previous!.draft,
              fixes,
              facts,
              files(inputs.base),
            )
          : [];
        const data = {
          ...planChoices(facts, wire),
          instructions: `${renderPlanningInstructions(
            inputs.body,
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
        };
        const local = await observeLocalExecutables({
          checkout: config.checkout,
          base: inputs.base,
          body: inputs.body,
          finalCommands: finalCommands(
            inputs.body,
            config.finalValidation.requiredCommands,
          ),
          signal,
        });
        const prompt = renderCompilationCall({
          facts,
          data,
          revising,
          repository,
          workers: WORKERS,
          citedSections: cited,
          localExecutables: local.observations,
        });
        const answer = await deps.planner.answer({
          role: "planner",
          phase: "plan",
          prompt,
          schema: revising
            ? revisionSchema(facts, wire)
            : planSchema(facts, wire),
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
        let full: unknown = answer.value;
        if (revising) {
          const revised = applyRevision(
            previous!.answer,
            answer.value,
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
        if (!decoded.plan)
          return done({ ...round, findings: decoded.findings });
        const findings = [
          ...decoded.findings,
          ...(await checkPlan(
            decoded.plan,
            facts,
            files(inputs.base),
            previous?.draft,
          )),
        ];
        return done({
          ...round,
          draft: decoded.plan,
          ...(findings.length ? { findings } : {}),
        });
      }),
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
    deadlineMs: 45 * MINUTE,
    run: (context) =>
      guarded(async () => {
        const { state, signal } = context;
        const { config } = deps;
        if (context.answer?.answer === "replan")
          return done({ findings: [], replan: true } satisfies ReviewRound);
        const inputs = generationInputs(state, g);
        const built = await buildFacts({
          objective: state.issue,
          body: inputs.body,
          base: inputs.base,
          checkout: config.checkout,
          requiredCommands: config.finalValidation.requiredCommands,
          ciOnlyCommands: config.finalValidation.ciOnlyCommands,
          extraCommands: allowedCommands(state),
          playbook: await readPlaybook(config, inputs.base, signal),
          signal,
        });
        if ("problems" in built) return objectiveProblemsHold(built.problems);
        const { facts } = built;
        const draft = (state.done[`plan:${g}:${n}`] as PlanRound).draft!;
        const all = decisions(state);
        const local = await observeLocalExecutables({
          checkout: config.checkout,
          base: inputs.base,
          body: inputs.body,
          finalCommands: finalCommands(
            inputs.body,
            config.finalValidation.requiredCommands,
          ),
          signal,
        });
        const evidence = planningReviewEvidence({
          sources: facts.sources,
          decisions: all,
          localExecutables: local.observations,
        });
        const workDir = treeDir(deps, state.issue, inputs.base);
        await exportTree(config.checkout, inputs.base, workDir, signal);
        const repository = await repositoryView(
          config.checkout,
          inputs.base,
          true,
          signal,
        );
        const scope = lastReview(state, g, n);
        const prompt = renderGraphReviewCall({
          facts,
          draft,
          evidence,
          decisions: all,
          finalCommands: finalCommands(
            inputs.body,
            config.finalValidation.requiredCommands,
          ),
          controllerCapabilities: CONTROLLER_GUARANTEES,
          repository,
          workers: WORKERS,
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
          return {
            kind: "retry",
            reason: `The plan review answer was invalid: ${decoded.reason}`,
            afterMs: -1,
          };
        const result: ReviewRound = { findings: decoded.findings };
        return done(result);
      }),
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

const ASK = ["answer", "allow", "replan", "cancel"];

function decideStep(
  key: string,
  g: number,
  n: number,
  deps: PlanningDeps,
): Step {
  return {
    key,
    deadlineMs: 5 * MINUTE,
    run: ({ state, answer, signal }: StepContext) =>
      guarded(async (): Promise<Outcome> => {
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
        if (planned.replan || reviewed?.replan)
          return done({ replan: true } satisfies Decision);
        const question = questionFor(state, g, n, planned, fixes, asks, deps);
        if (answer) {
          const at = answer.at;
          const record = (text?: string): PlannerDecision => ({
            question: question?.text ?? "",
            answer: answer.answer,
            ...(text ? { text } : {}),
            by: answer.by,
            at,
          });
          switch (answer.answer) {
            case "replan":
              return done({
                replan: true,
                decision: record(),
              } satisfies Decision);
            case "more":
              return done({ corrections: fixes, grant: 2 } satisfies Decision);
            case "approve":
              if (await objectiveChanged(state, g, deps, signal))
                return changedHold(state);
              return done({
                accept: true,
                decision: record(),
              } satisfies Decision);
            case "continue":
              return done({
                accept: true,
                decision: record(),
              } satisfies Decision);
            case "answer":
            case "allow": {
              if (!answer.text?.trim())
                return {
                  kind: "hold",
                  question: `${question?.text ?? "Planning needs your answer."}\n\n\`${answer.answer}\` needs text after it, for example \`/factory ${answer.answer === "allow" ? "allow pnpm run test:e2e" : "answer use the existing parser"}\`.`,
                  answers: question?.answers ?? ASK,
                  recommended: answer.answer,
                };
              const decision = record(answer.text.trim());
              return done({
                decision,
                corrections: [...fixes, ...operatorCorrections([decision])],
              } satisfies Decision);
            }
          }
        }
        if (question)
          return {
            kind: "hold",
            question: question.text,
            answers: question.answers,
            recommended: question.recommended,
          };
        if (findings.length === 0) {
          // Before accepting, the Objective must still read as planning read it.
          if (answer?.answer !== "continue") {
            const changed = await objectiveChanged(state, g, deps, signal);
            if (changed) return changedHold(state);
          }
          return done({ accept: true } satisfies Decision);
        }
        return done({ corrections: fixes } satisfies Decision);
      }),
  };
}

function changedHold(state: ObjectiveState): Outcome {
  return {
    kind: "hold",
    question: `Objective #${state.issue} was edited after planning read it. \`replan\` plans again from the new text; \`continue\` keeps this plan.`,
    answers: ["replan", "continue", "cancel"],
    recommended: "replan",
  };
}

/** Whether the issue body differs from the one this generation planned from. */
async function objectiveChanged(
  state: ObjectiveState,
  g: number,
  deps: PlanningDeps,
  signal: AbortSignal,
): Promise<boolean> {
  const issue = await deps.github.rest<{ body: string | null }>(
    "GET",
    `/repos/${deps.config.repository}/issues/${state.issue}`,
    undefined,
    signal,
  );
  const normalize = (text: string) => text.replace(/\r\n/g, "\n").trim();
  return (
    normalize(issue.body ?? "") !== normalize(generationInputs(state, g).body)
  );
}

/** The question this round needs answered, if any. Recomputed, so an answer re-derives the same text. */
function questionFor(
  state: ObjectiveState,
  g: number,
  n: number,
  planned: PlanRound,
  fixes: Finding[],
  asks: Finding[],
  deps: PlanningDeps,
): { text: string; answers: string[]; recommended: string } | undefined {
  const list = (items: Finding[]) =>
    items.map((f, i) => `${i + 1}. ${f.message}`).join("\n");
  if (planned.question)
    return {
      text: `The planner needs a decision:\n\n${planned.question}\n\nAnswer with \`answer <your choice>\`. If it needs a validation command the Objective doesn't list, \`allow <exact command>\` authorizes it.`,
      answers: ASK,
      recommended: "answer",
    };
  if (asks.length && !fixes.length && !state.done[`review:${g}:${n}`])
    return {
      text: `Factory's plan checks found ${asks.length === 1 ? "a question" : "questions"} only you can decide:\n\n${list(asks)}\n\n\`answer <decision>\` sends your decision back to the planner.`,
      answers: ASK,
      recommended: "answer",
    };
  if (asks.length && !fixes.length)
    return {
      text: `The plan reviewer found ${asks.length === 1 ? "a question" : "questions"} only you can decide:\n\n${list(asks)}\n\n\`approve\` runs the plan as it is; \`answer <decision>\` sends your decision back to the planner.`,
      answers: ["approve", ...ASK],
      recommended: "answer",
    };
  if (!fixes.length) return undefined;
  const previous =
    n > 1 ? (state.done[`decide:${g}:${n - 1}`] as Decision) : undefined;
  if (previous?.corrections && sameFindings(previous.corrections, fixes))
    return {
      text: `Plan round ${n} came back with the same problems as round ${n - 1}:\n\n${list(fixes)}\n\nAnswer with guidance for the planner, or \`replan\` after editing the Objective.`,
      answers: ASK,
      recommended: "answer",
    };
  const allowance = deps.config.planning.revisions + granted(state, g, n);
  if (fixRounds(state, g, n) > allowance)
    return {
      text: `The plan still has ${fixes.length} problem${fixes.length === 1 ? "" : "s"} after ${n} rounds:\n\n${list(fixes)}\n\n\`more\` allows two more rounds.`,
      answers: ["more", ...ASK],
      recommended: "more",
    };
  return undefined;
}

/** Rounds of this generation spent on fixes (not on operator answers), this one included. */
function fixRounds(state: ObjectiveState, g: number, n: number): number {
  let rounds = 1;
  for (let m = 1; m < n; m++) {
    const decided = state.done[`decide:${g}:${m}`] as Decision | undefined;
    if (decided && !decided.decision) rounds += 1;
  }
  return rounds;
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

function acceptStep(g: number, n: number, deps: PlanningDeps): Step {
  return {
    key: "plan",
    deadlineMs: 10 * MINUTE,
    run: ({ state, signal }) =>
      guarded(async () => {
        const inputs = generationInputs(state, g);
        // The accepted draft is the last round that had one.
        let draft: Draft | undefined;
        for (let m = n; m >= 1 && !draft; m--)
          draft = (state.done[`plan:${g}:${m}`] as PlanRound | undefined)
            ?.draft;
        if (!draft)
          return {
            kind: "fail",
            reason: "the accepted round has no plan",
          };
        const plan: Plan = {
          ...draft,
          finalCommands: finalCommands(
            inputs.body,
            deps.config.finalValidation.requiredCommands,
          ),
          decisions: decisions(state),
        };
        await postPlan(deps, state.issue, plan, signal);
        return done(plan);
      }),
  };
}

const PLAN_MARK = (issue: number) => `<!-- factory:${issue}:plan -->`;
const COMMENT_LIMIT = 65_000;

/** Post the plan on the issue, or edit the comment already there. */
async function postPlan(
  deps: PlanningDeps,
  issue: number,
  plan: Plan,
  signal: AbortSignal,
): Promise<void> {
  const marker = PLAN_MARK(issue);
  const children = plan.split
    ? plan.split.children
        .map((child) => `- **${child.key}** ${child.title} (child Objective)`)
        .join("\n")
    : "";
  const items = plan.items
    .map(
      (item) =>
        `- **${item.id}** ${item.title}${item.dependencies.length ? ` (after ${item.dependencies.join(", ")})` : ""}`,
    )
    .join("\n");
  const summary = `${marker}\n**Factory's plan** (${plan.split ? `split into ${plan.split.children.length} child Objectives` : `${plan.items.length} Work Item${plan.items.length === 1 ? "" : "s"}`}, base \`${plan.base.slice(0, 12)}\`)\n\n${plan.split ? children : items}${plan.decisions.length ? `\n\nDecisions:\n${plan.decisions.map((d) => `- ${d.answer}${d.text ? `: ${d.text}` : ""} (${d.by})`).join("\n")}` : ""}`;
  const data = `\n\n<details><summary>Plan data</summary>\n\n\`\`\`json\n${JSON.stringify(plan)}\n\`\`\`\n</details>`;
  const body =
    summary.length + data.length <= COMMENT_LIMIT ? summary + data : summary;
  const { repository } = deps.config;
  const existing = await findComment(
    deps.github,
    repository,
    issue,
    marker,
    signal,
  );
  if (existing)
    await deps.github.rest(
      "PATCH",
      `/repos/${repository}/issues/comments/${existing}`,
      { body },
      signal,
    );
  else
    await deps.github.rest(
      "POST",
      `/repos/${repository}/issues/${issue}/comments`,
      { body },
      signal,
    );
}

async function findComment(
  github: GitHub,
  repository: string,
  issue: number,
  marker: string,
  signal: AbortSignal,
): Promise<number | undefined> {
  for (let page = 1; page <= 20; page++) {
    const batch = await github.rest<{ id: number; body: string }[]>(
      "GET",
      `/repos/${repository}/issues/${issue}/comments?per_page=100&page=${page}`,
      undefined,
      signal,
    );
    const found = batch.find((c) => c.body.startsWith(marker));
    if (found) return found.id;
    if (batch.length < 100) return undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Shared

/** Re-read the issue and the default branch for a new generation, with the check step's checks. */
async function rereadObjective(
  issue: number,
  deps: PlanningDeps,
  signal: AbortSignal,
): Promise<{ inputs: Inputs } | { hold: Outcome }> {
  const { config, github } = deps;
  const found = await github.rest<{
    title: string;
    body: string | null;
    state: string;
  }>("GET", `/repos/${config.repository}/issues/${issue}`, undefined, signal);
  if (found.state !== "open")
    return {
      hold: {
        kind: "hold",
        question: `Issue #${issue} is closed. Reopen it and answer \`replan\`, or cancel.`,
        answers: ["replan", "cancel"],
        recommended: "cancel",
      },
    };
  const body = found.body ?? "";
  const base = await defaultHead(config.checkout, signal);
  const { objective, problems } = parseObjective(body);
  problems.push(
    ...(await checkSources(config.checkout, base, objective.sources, signal)),
  );
  problems.push(
    ...(await objectiveCommandProblems(body, base, config.checkout, {
      requiredCommands: config.finalValidation.requiredCommands,
      ciOnlyCommands: config.finalValidation.ciOnlyCommands,
      signal,
    })),
  );
  if (problems.length) return { hold: objectiveProblemsHold(problems) };
  return { inputs: { body, base, title: found.title } };
}

function objectiveProblemsHold(problems: string[]): Outcome {
  return {
    kind: "hold",
    question: `This Objective needs fixing before Factory can plan it:\n${problems.map((p) => `- ${p}`).join("\n")}\n\nEdit the issue, then answer \`replan\`.`,
    answers: ["replan", "cancel"],
    recommended: "replan",
  };
}

async function readPlaybook(
  config: CoreConfig,
  base: string,
  signal: AbortSignal,
): Promise<string> {
  try {
    const { stdout } = await run(
      "git",
      ["-C", config.checkout, "show", `${base}:${config.planning.playbook}`],
      { signal, maxBuffer: 1024 * 1024 },
    );
    return stdout;
  } catch (error) {
    if (signal.aborted) throw error;
    return ""; // No playbook in the target.
  }
}

async function defaultHead(
  checkout: string,
  signal: AbortSignal,
): Promise<string> {
  try {
    await run(
      "git",
      ["-C", checkout, "fetch", "--quiet", "--prune", "origin"],
      {
        timeout: 5 * MINUTE,
        signal,
      },
    );
    await run(
      "git",
      ["-C", checkout, "remote", "set-head", "origin", "--auto"],
      {
        timeout: MINUTE,
        signal,
      },
    );
    const { stdout } = await run(
      "git",
      [
        "-C",
        checkout,
        "rev-parse",
        "--verify",
        "refs/remotes/origin/HEAD^{commit}",
      ],
      { timeout: MINUTE, signal },
    );
    return stdout.trim();
  } catch (error) {
    if (signal.aborted) throw error;
    throw new TransientError(`git fetch in ${checkout}: ${String(error)}`);
  }
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

function invalidAnswer(findings: Finding[]): Outcome {
  return {
    kind: "retry",
    reason: `${INVALID_ANSWER}: ${findings
      .map((f) => f.message)
      .join("; ")
      .slice(0, 500)}`,
    afterMs: -1,
  };
}

/** Map provider and GitHub failures to outcomes; anything else escapes to the engine. */
async function guarded(work: () => Promise<Outcome>): Promise<Outcome> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof PlannerError) {
      // A provider wait (usage or rate limit) doesn't count as an error; any
      // other retry does, so a call that keeps failing holds after three.
      if (error.outcome === "retry")
        return {
          kind: "retry",
          reason: error.message,
          afterMs: error.afterMs ?? -1,
        };
      if (error.outcome === "hold")
        return {
          kind: "hold",
          question: error.message,
          answers: ["retry", "cancel"],
          recommended: "retry",
        };
      // Too large for the model, or refused: the Objective has to change.
      return {
        kind: "hold",
        question: `${error.message}\n\nEdit the Objective (for example, pin smaller Sources) and answer \`replan\`.`,
        answers: ["replan", "retry", "cancel"],
        recommended: "replan",
      };
    }
    if (error instanceof TransientError)
      return {
        kind: "retry",
        reason: error.message,
        ...(error.retryAfterMs !== undefined
          ? { afterMs: error.retryAfterMs }
          : {}),
      };
    if (error instanceof GitHubError && error.status === 404)
      return {
        kind: "hold",
        question: `GitHub says the issue doesn't exist or Factory can't see it (${error.message}).`,
        answers: ["retry", "cancel"],
        recommended: "cancel",
      };
    throw error;
  }
}

export type { PlanningFacts };
