/**
 * Independent final review of an Objective: a reviewer reads the integrated
 * tree and judges every Objective Acceptance criterion and every coverage
 * obligation once per distinct statement, wherever the plan proved it, plus
 * one fixed integration question per dependency edge between coding Work
 * Items. The review run (evidence root, schema, decoding and verdicts) is the
 * result review's (result.ts runReview), over the changes this Objective's
 * Work Items merged (each merge's first-parent diff), read in the integrated
 * tree: other work merged on the default branch meanwhile is context, not
 * under review. A refusal lists every refused criterion; a needs-human
 * verdict becomes a question for the operator. An invalid answer is asked
 * again once with the error; still invalid, the criteria it left undecided go
 * to the operator. Provider failures escape as `PlannerError`. The reviewer
 * also gets the Objective's knowledge: every item's accepted handoff notes
 * and the bytes they cite (result.ts knowledgeRows), and the repository
 * memory about its paths as one advisory row.
 */
import type { CandidateRecord, InputRecord } from "../media.js";
import type { Expanded } from "../planning/expansion.js";
import { coverageCriterion } from "../planning/graph.js";
import {
  type ConditionVerdict,
  retiredCriteria,
  retiredLines,
} from "../planning/plan.js";
import { DESIGN_CHECKLIST } from "../planning/rubric.js";
import type { PinnedSource, Plan, WorkItem } from "../planning/types.js";
import type { Planner } from "../providers/planner.js";
import type { PeerNote } from "../work/prompt.js";
import type { ReviewArtifactGroup } from "./artifacts.js";
import {
  type CriterionDecision,
  type PassedValidation,
  type QaObservation,
  qaObservationRow,
  REVIEW_GUIDANCE,
  type ResultReview,
  type ReviewConversation,
  runReview,
  workItemDesign,
} from "./result.js";

/** A conditional Work Item its declared condition skipped. */
export interface SkippedItem extends ConditionVerdict {
  itemId: string;
}

/** Review the integrated Objective. See the module comment for the outcomes. */
export function reviewObjective(input: {
  planner: Planner;
  plan: Plan;
  checkout: string;
  /** The plan base and the integrated final commit. */
  base: string;
  commit: string;
  /** Each Work Item's merge commit, in merge order: the change under review. */
  merges: readonly string[];
  validation: PassedValidation;
  /**
   * Captures of the integrated tree: final validation's (no itemId), then
   * each merged Work Item's validate captures with its itemId, reused only
   * where their tree is the integrated tree and final validation didn't
   * capture the same output.
   */
  artifacts?: readonly ReviewArtifactGroup[];
  sources: readonly PinnedSource[];
  /** The Objective's Acceptance criteria, in order (objective.ts). */
  acceptance: readonly string[];
  /** Each merged item's captured candidate sets and the operator's selection. */
  candidates?: readonly CandidateRecord[];
  /** Each merged item's read-only worker inputs. */
  inputs?: readonly InputRecord[];
  /** Every item's accepted handoff notes (planning/schedule.ts objectiveNotes). */
  peerNotes?: readonly PeerNote[];
  /** Repository memory for the Objective's paths (knowledge/index.ts roleMemory): advisory data. */
  memory?: string;
  /** A private directory for the evidence root. */
  dir: string;
  /** The final reviewer's retained conversation (result.ts ReviewConversation). */
  conversation?: ReviewConversation;
  /**
   * Every operator criterion decision: final review's replace the
   * reviewer's verdict (result.ts `decides`), and the reviewer sees the
   * Work Items' as evidence.
   */
  decisions?: readonly CriterionDecision[];
  /** The final review the operator is answering: its verdicts on this tree stand. */
  earlier?: ResultReview;
  /** What each accepted read-only QA item observed. */
  qa?: readonly QaObservation[];
  /** The conditional Work Items their declared condition skipped, with its evidence. */
  skipped?: readonly SkippedItem[];
  /** The plan's settled expansion envelopes, with the children each added. */
  expansions?: readonly Expanded[];
  signal: AbortSignal;
  log(event: Record<string, unknown>): void;
}): Promise<ResultReview> {
  return runReview({
    ...input,
    phase: "objective-review",
    criteria: finalCriteria(
      input.plan,
      input.acceptance,
      new Set((input.skipped ?? []).map((entry) => entry.itemId)),
      input.expansions ?? [],
    ),
    instructions: FINAL_INSTRUCTIONS,
    design: [
      ...input.plan.items.map((item) => ({
        origin: "controller" as const,
        path: `Accepted Work Item design: ${item.id}`,
        content: JSON.stringify(workItemDesign(item)),
        complete: true,
      })),
      ...(input.qa ?? []).map(qaObservationRow),
      ...retiredRows(input.plan),
      ...(input.skipped ?? []).map((entry) => ({
        origin: "controller" as const,
        path: `Skipped Work Item: ${entry.itemId}`,
        content: JSON.stringify({
          scope: `Work Item ${entry.itemId} runs only when declared condition ${entry.conditionId} is ${entry.when}; Factory evaluated it as ${entry.value} from the discovery result it reads, so the item was skipped: no worker ran and it merged nothing. Its design is not delivered and is not under review; unconditional items own every obligation.`,
          ...entry,
        }),
        complete: true,
      })),
      ...(input.expansions ?? []).map((entry) => ({
        origin: "controller" as const,
        path: `Expansion: ${entry.envelopeId}`,
        content: JSON.stringify({
          scope: `Expansion ${entry.envelopeId} is a reviewed template Factory copied once per batch of the files its discovery producer selected, with no model call; each child Work Item below owns one batch. Its integration barriers waited for every child.`,
          ...entry,
        }),
        complete: true,
      })),
    ],
    artifacts: input.artifacts ?? [],
  });
}

/**
 * The operator's retirements as controller rows: retired criteria no longer
 * count, while retired commands only no longer run.
 */
function retiredRows(plan: Plan) {
  const row = (path: string, scope: string, kind: "criterion" | "command") => {
    const retired = retiredLines(plan, undefined, kind);
    return retired.length
      ? [
          {
            origin: "controller" as const,
            path,
            content: JSON.stringify({ scope, retired }),
            complete: true,
          },
        ]
      : [];
  };
  return [
    ...row(
      "Retired criteria",
      "The operator retired these criteria and obligations: they no longer apply, so they are not under review and never count as unmet. Judge the remaining criteria without them.",
      "criterion",
    ),
    ...row(
      "Retired commands",
      "The operator retired these validation commands: they no longer run, so they are no evidence either way. Criteria they proved are still judged, on other evidence.",
      "command",
    ),
  ];
}

/**
 * Final review judges, on the integrated tree, the Objective criteria and
 * every coverage obligation once per distinct statement, wherever the plan
 * proved it: item reviews judge obligations one Work Item at a time. Then one
 * fixed integration question per dependency edge between coding items, and
 * per source whose obligations coding items without a direct edge deliver
 * together, asks whether the consumer accepts the producer's real outputs and
 * reuses its helpers and types. Each question names the criteria it bears on
 * by index, so its refusal stays tied to them. The criteria the operator
 * retired (planning/plan.ts) are left out.
 */
function finalCriteria(
  plan: Plan,
  objective: readonly string[],
  skipped: ReadonlySet<string>,
  expansions: readonly Expanded[],
): string[] {
  const retired = retiredCriteria(plan);
  const judged = [
    ...new Set([...objective, ...plan.coverage.map(coverageCriterion)]),
  ].filter((criterion) => !retired.has(criterion));
  // A skipped item delivered nothing, so it integrates with nothing.
  const coding = plan.items.filter(
    (item) => (item.kind ?? "work") === "work" && !skipped.has(item.id),
  );
  const ids = new Set(coding.map((item) => item.id));
  const linked = (a: WorkItem, b: WorkItem) =>
    a.dependencies.includes(b.id) || b.dependencies.includes(a.id);
  // An expansion's children share one question, not one per edge.
  const children = new Set(
    expansions.flatMap((entry) => entry.children.map((child) => child.id)),
  );
  const bears = (items: string[], paths?: string[]) => {
    const indices = [
      ...new Set(
        plan.coverage
          .filter(
            (entry) =>
              items.includes(entry.itemId) &&
              (!paths || paths.includes(entry.source.path)),
          )
          .map((entry) => judged.indexOf(coverageCriterion(entry)))
          .filter((index) => index >= 0),
      ),
    ].sort((a, b) => a - b);
    return indices.length ? ` It bears on criteria ${indices.join(", ")}.` : "";
  };
  const questions = coding.flatMap((consumer) =>
    consumer.dependencies
      .filter(
        (id) => ids.has(id) && !children.has(id) && !children.has(consumer.id),
      )
      .map(
        (producer) =>
          `Integration of Work Item "${consumer.id}" with its dependency "${producer}" on the integrated tree: "${consumer.id}" accepts the real outputs and types "${producer}" produces, exactly as "${producer}" produces them (cite the producing and consuming file:lines), and reuses the helpers and types "${producer}" owns instead of redefining them.${bears([consumer.id, producer])}`,
      ),
  );
  // Coding items delivering one source's obligations share its capability.
  const groups = new Map<string, { items: string[]; paths: string[] }>();
  for (const path of new Set(plan.coverage.map((entry) => entry.source.path)))
    if (path !== "OBJECTIVE") {
      const members = coding.filter((item) =>
        plan.coverage.some(
          (entry) => entry.itemId === item.id && entry.source.path === path,
        ),
      );
      if (
        members.every((a, index) =>
          members.slice(index + 1).every((b) => linked(a, b)),
        )
      )
        continue;
      const items = members.map((item) => item.id);
      const key = JSON.stringify(items);
      const group = groups.get(key) ?? { items, paths: [] };
      group.paths.push(path);
      groups.set(key, group);
    }
  for (const entry of expansions) {
    const made = entry.children.map((child) => child.id);
    if (!made.length) continue;
    const near = [
      ...new Set(
        coding
          .filter(
            (item) =>
              !children.has(item.id) &&
              coding.some(
                (child) => made.includes(child.id) && linked(item, child),
              ),
          )
          .map((item) => item.id),
      ),
    ];
    questions.push(
      `Integration of Work Items ${made.map((id) => `"${id}"`).join(", ")}, which expansion "${entry.envelopeId}" made from one reviewed template, on the integrated tree: each makes the template's change in its own files the same way${near.length ? `, they accept the real outputs and types of ${near.map((id) => `"${id}"`).join(", ")} and what consumes them accepts theirs (cite the producing and consuming file:lines)` : ""}, and a helper or type more than one of them needs has one definition the others reuse.${bears([...made, ...near])}`,
    );
  }
  for (const { items, paths } of groups.values())
    questions.push(
      `Integration of Work Items ${items.map((id) => `"${id}"`).join(", ")}, which together deliver obligations from ${paths.join(", ")}, on the integrated tree: where one consumes another's outputs it accepts their real shape and types (cite the producing and consuming file:lines), and a helper or type more than one of them needs has one definition the others reuse instead of parallel redefinitions.${bears(items, paths)}`,
    );
  return [...new Set([...judged, ...questions])];
}

/**
 * The final-review instructions: the old objective-review prompt, trimmed to
 * what the core supplies (no receipts, bindings, retained bodies or Work Item
 * findings). They don't depend on the Objective, so every
 * final review shares a provider-cache prefix.
 */
const FINAL_INSTRUCTIONS = [
  REVIEW_GUIDANCE.judge,
  REVIEW_GUIDANCE.asyncWork,
  `Apply the design checklist below to the integrated change as a whole: a design defect in code the Objective adds or changes (a new action gated only by a broader existing grant, new state with no enforced bound or retention, attribution to a principal that did not act, avoidable per-request work, a reference test whose expected side runs the code under test, a numeric limit with no origin) is a semantic defect even when every item passed. Refuse the criterion whose implementation contains it, naming the question and citing the file/lines. Where the repository declares its own design checklist, apply it too.\n${DESIGN_CHECKLIST}`,
  "The change under review is the changes this Objective's Work Items merged: each merge's first-parent diff, listed in the change index; a path several merges touched shows its combined change, base/ holds its copy before the first merge that touched it (the entry's baseCommitSha), and its patch runs from there to the integrated head. candidate/ is the integrated default-branch head. Other work may have merged on the default branch meanwhile: it is context, not under review, so never refuse a criterion for changes outside this Objective's merges.",
  "Final review independently judges every original Objective criterion, every source obligation, integrated interaction and final-only requirement on the integrated tree. Work Item reviews proved obligations one item at a time; judge each again against everything that now consumes or produces what it covers. A criterion beginning \"Integration of Work Item\" is a fixed integration question: read the producer's real outputs, types and helpers and the consumer's use of them in the integrated tree, and pass only with both sides' file:lines cited. Refuse it when the consumer rejects or reshapes what the producer actually emits or redefines a helper or type the producer owns, and refuse each criterion it names that the defect breaks, citing the same evidence. Every criterion needs sufficient current evidence.",
  REVIEW_GUIDANCE.behaviour,
  REVIEW_GUIDANCE.findings,
  REVIEW_GUIDANCE.precedent,
  REVIEW_GUIDANCE.labels,
  REVIEW_GUIDANCE.design,
  REVIEW_GUIDANCE.evidenceRoot,
];
