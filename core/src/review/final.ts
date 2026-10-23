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
import { coverageCriterion } from "../planning/graph.js";
import { DESIGN_CHECKLIST } from "../planning/rubric.js";
import type { PinnedSource, Plan, WorkItem } from "../planning/types.js";
import type { Planner } from "../providers/planner.js";
import type { PeerNote } from "../work/prompt.js";
import type { ReviewArtifactGroup } from "./artifacts.js";
import {
  type CriterionDecision,
  type PassedValidation,
  REVIEW_GUIDANCE,
  type ResultReview,
  runReview,
  workItemDesign,
} from "./result.js";

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
  /** Operator decisions; those on this tree replace the reviewer's verdict. */
  decisions?: readonly CriterionDecision[];
  signal: AbortSignal;
  log(event: Record<string, unknown>): void;
}): Promise<ResultReview> {
  return runReview({
    ...input,
    phase: "objective-review",
    criteria: finalCriteria(input.plan, input.acceptance),
    instructions: FINAL_INSTRUCTIONS,
    design: input.plan.items.map((item) => ({
      origin: "controller",
      path: `Accepted Work Item design: ${item.id}`,
      content: JSON.stringify(workItemDesign(item)),
      complete: true,
    })),
    artifacts: input.artifacts ?? [],
  });
}

/**
 * Final review judges, on the integrated tree, the Objective criteria and
 * every coverage obligation once per distinct statement, wherever the plan
 * proved it: item reviews judge obligations one Work Item at a time. Then one
 * fixed integration question per dependency edge between coding items, and
 * per source whose obligations coding items without a direct edge deliver
 * together, asks whether the consumer accepts the producer's real outputs and
 * reuses its helpers and types. Each question names the criteria it bears on
 * by index, so its refusal stays tied to them.
 */
function finalCriteria(plan: Plan, objective: readonly string[]): string[] {
  const judged = [
    ...new Set([...objective, ...plan.coverage.map(coverageCriterion)]),
  ];
  const coding = plan.items.filter((item) => (item.kind ?? "work") === "work");
  const ids = new Set(coding.map((item) => item.id));
  const linked = (a: WorkItem, b: WorkItem) =>
    a.dependencies.includes(b.id) || b.dependencies.includes(a.id);
  const bears = (items: string[], paths?: string[]) => {
    const indices = [
      ...new Set(
        plan.coverage
          .filter(
            (entry) =>
              items.includes(entry.itemId) &&
              (!paths || paths.includes(entry.source.path)),
          )
          .map((entry) => judged.indexOf(coverageCriterion(entry))),
      ),
    ].sort((a, b) => a - b);
    return indices.length ? ` It bears on criteria ${indices.join(", ")}.` : "";
  };
  const questions = coding.flatMap((consumer) =>
    consumer.dependencies
      .filter((id) => ids.has(id))
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
