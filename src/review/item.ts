/**
 * A Work Item's result review (#2344, variant B): its only path back to the
 * worker is a reproduced failure. The earlier result reviewer finds; each
 * of its refusals is then proved by its own task before it can cost a
 * repair. Two things start at once:
 *
 * - the review's workspace (`Workspace`): one checkout of the candidate,
 *   its exact install from the item's warm package store, under
 *   validation's sandbox. Every other checkout of the review is a copy of
 *   it (validate.ts `ValidatedCheckout.copy`), so nothing installs twice;
 * - the finder (review/finder.ts): the earlier result reviewer, in a fresh
 *   session, with its own instructions, criteria (the item's acceptance,
 *   then the Objective criteria it proves) and evidence (result.ts
 *   `runReview`, which also settles operator decisions, asks again once
 *   and sends questions about held evidence back). A criterion its answer
 *   leaves without a valid verdict, even beside a refusal, is asked again
 *   alone once, and one still without a verdict is the operator's
 *   question: never a pass (`find`).
 *
 * Each criterion the finder refused becomes one suspicion: its detail the
 * case, the criterion the expectation. Up to `proofs` a review, each is
 * proved by its own task: a fresh call that gets only the criterion, the
 * suspicion, the workspace's checkout to read and `run_command` in a copy
 * of its own, with a small budget, as many at once as the host has
 * planner slots free. It answers with a repro (input, expected, actual and
 * a command that exits non-zero on the candidate) or none. The refusal
 * check then runs the repro in a fresh copy: confirmed when it exits
 * non-zero by itself (not 126, 127 or at its limit) and its output holds
 * the claimed actual output. A confirmed refusal stands, with its repro;
 * any other becomes a pass, logged (`result-review-suspicion`) and seen by
 * nobody. The finder's passes and questions stand.
 *
 * Confirmed refusals go to repair with their repros (work/repros.ts keeps
 * their commands as extra validation); otherwise the questions ask the
 * operator in one hold; otherwise the item is accepted. A re-review gets
 * the refusals confirmed on the item's previous result and the repair's
 * diff, never a conversation. The `result-review` event times each phase
 * and counts the suspicions. Provider failures escape as `PlannerError`; a
 * workspace Factory can't make escapes as `ScratchUnavailable` with the
 * outcome to take.
 */
import type { SandboxConfig } from "../config.js";
import { crashPoint } from "../crash.js";
import { hostLimits, type Outcome } from "../engine.js";
import { isRecord } from "../planning/graph.js";
import type { WorkItem } from "../planning/types.js";
import type { CallTool, Planner } from "../providers/planner.js";
import { logRefused } from "../providers/usage.js";
import { shellNetwork } from "../sandbox.js";
import { headAndTail } from "../text.js";
import {
  type CheckoutCopy,
  type CheckoutRun,
  type ValidatedCheckout,
  type ValidateInput,
  validateTree,
} from "../validate.js";
import { hostGit } from "../worktree.js";
import {
  type CommandProof,
  commandProofs,
  finderInstructions,
  resultCriteria,
} from "./finder.js";
import {
  checkFailureRows,
  deliveryRows,
  type EvidenceInput,
  type PassedValidation,
  type Repro,
  type ResultEvidence,
  type ResultReview,
  type ResultReviewInput,
  type ReviewedCriterion,
  runReview,
  settledBy,
  workItemDesign,
} from "./result.js";

/**
 * The review's workspace: `use` runs with one checkout of the candidate,
 * its dependencies installed, under validation's sandbox, and its copies
 * (`ValidatedCheckout.copy`); the checkout and its copies are removed
 * after it (work/step-review.ts makes it with `validationWorkspace`).
 */
export type Workspace = <T>(
  use: (checkout: ValidatedCheckout) => Promise<T>,
) => Promise<T>;

/**
 * A workspace made as validation makes its checkout (validate.ts
 * `validateTree`) from `input`: a fresh checkout of the exact commit at
 * `directory`, with the exact install alone run, on the item's kept or
 * shared package store, so it installs warm. Commands there and in its
 * copies run under validation's sandbox (always: it is required here),
 * network and environment, with no secrets. One Factory can't make is
 * `ScratchUnavailable`, with validation's retry or hold.
 */
export function validationWorkspace(
  input: Omit<ValidateInput, "directory" | "use" | "only">,
  directory: string,
): Workspace {
  return async <T>(
    use: (checkout: ValidatedCheckout) => Promise<T>,
  ): Promise<T> => {
    let used: { value: T } | undefined;
    const result = await validateTree({
      ...input,
      // A model chooses these commands: never unsandboxed, whatever
      // `sandbox.required` allows the plan's own.
      sandbox: { ...input.sandbox, required: true },
      directory,
      only: [],
      use: async (checkout) => {
        used = { value: await use(checkout) };
      },
      runFile: (kind) => input.runFile(`scratch-${kind}`),
    });
    if (used) return used.value;
    if (result.kind === "retry" || result.kind === "hold")
      throw new ScratchUnavailable(result);
    throw new ScratchUnavailable({
      kind: "retry",
      reason: `Factory could not make a scratch checkout of the candidate for its review, though validation passed on it: ${result.kind === "failed" ? result.detail : "no checkout"}`,
    });
  };
}

/** A workspace Factory couldn't make: the step takes `outcome`. */
export class ScratchUnavailable extends Error {
  constructor(readonly outcome: Extract<Outcome, { kind: "retry" | "hold" }>) {
    super(outcome.kind === "hold" ? outcome.question : outcome.reason);
  }
}

/** The re-review packet: the refusals confirmed on the item's previous result. */
export interface PriorRefusals {
  /** The tree they were confirmed on. */
  tree: string;
  refused: readonly { criterion: string; detail: string; repro: Repro }[];
}

/** A review's bounds (the installation's `review` settings, in ms). */
export interface ReviewLimits {
  /** The longest one command of a proof, or a repro, may run. */
  commandMs: number;
  /**
   * Most suspicions proved in one review (0: none is, so nothing is
   * refused), and each proof's commands and their summed time.
   */
  proofs: number;
  proofCommands: number;
  proofBudgetMs: number;
  /** The longest the workspace's install may take (a validation command's limit). */
  prepareMs: number;
  /** The sandbox's network setting, which the commands follow as validation's do; absent: off. */
  network?: SandboxConfig["network"];
}

/**
 * The review pipeline as one call (the bench's replay harness calls it
 * too): the candidate, the criteria it is judged on, the validation that
 * passed on it, and its workspace.
 */
export interface CandidateReview {
  planner: Planner;
  /** A Git checkout that holds `base` and `commit`. */
  checkout: string;
  base: string;
  commit: string;
  /**
   * The criteria, in order: the Work Item's own acceptance, then the
   * Objective criteria its review proves (finder.ts `resultCriteria`).
   */
  criteria: readonly string[];
  /** How many of `criteria` are the item's own acceptance; absent: all. */
  itemCriteria?: number;
  /** The criteria the plan proves by one of the item's commands (finder.ts `commandProofs`). */
  commandProofs?: readonly CommandProof[];
  /** The validation that passed on the candidate's tree. */
  validation: PassedValidation;
  workspace: Workspace;
  limits: ReviewLimits;
  /** The Work Item reviewed: the operator's decisions of its criteria settle them. */
  itemId: string;
  /** Factory's further evidence (sources, design, notes, media); the bench may give none. */
  context?: Partial<
    Pick<
      EvidenceInput,
      | "plan"
      | "sources"
      | "design"
      | "notes"
      | "peerNotes"
      | "memory"
      | "candidates"
      | "inputs"
      | "decisions"
      | "artifacts"
      | "unreachableScope"
    >
  >;
  /** The review the operator is answering: its verdicts on this tree stand. */
  earlier?: ResultReview;
  prior?: PriorRefusals;
  /** A private directory for the evidence root. */
  dir: string;
  signal: AbortSignal;
  log(event: Record<string, unknown>): void;
}

/** What Factory's review step gives: a result review's input, with its workspace. */
export type ItemReviewInput = Omit<ResultReviewInput, "conversation"> &
  Pick<CandidateReview, "workspace" | "limits" | "prior">;

/** Review one Work Item's result: its own acceptance, with Factory's evidence. */
export function reviewResult(input: ItemReviewInput): Promise<ResultReview> {
  const { item } = input;
  return reviewCandidate({
    ...input,
    itemId: item.id,
    criteria: resultCriteria(input.plan, item),
    itemCriteria: item.acceptance.length,
    commandProofs: commandProofs(input.plan, item),
    context: {
      plan: input.plan,
      sources: input.sources,
      design: designRows(input, item),
      ...(input.notes !== undefined && { notes: input.notes }),
      ...(input.peerNotes && { peerNotes: input.peerNotes }),
      ...(input.memory !== undefined && { memory: input.memory }),
      ...(input.candidates && { candidates: input.candidates }),
      ...(input.inputs && { inputs: input.inputs }),
      ...(input.decisions && { decisions: input.decisions }),
      artifacts: [{ artifacts: input.artifacts ?? [] }],
      unreachableScope: item.ownedPaths,
    },
  });
}

/** The accepted design, the delivery position and the CI failures the item was repaired for. */
function designRows(input: ItemReviewInput, item: WorkItem): ResultEvidence[] {
  return [
    {
      origin: "controller",
      path: "Accepted Work Item design",
      content: JSON.stringify(workItemDesign(item)),
      complete: true,
    },
    ...deliveryRows(input),
    ...checkFailureRows(input.checkFailures ?? []),
  ];
}

/** Each phase's time, for the `result-review` event (the replay harness reads them). */
interface Phases {
  /** From the start to the workspace's install done; absent: never ready. */
  prepareMs?: number;
  /** The finder's time, its calls and evidence, both rounds. */
  modelMs: number;
  /** The proofs' wall time, their refusal checks inside. */
  proofsMs: number;
}

/** Review the candidate. See the module comment for the outcomes. */
export async function reviewCandidate(
  input: CandidateReview,
): Promise<ResultReview> {
  const { validation, criteria } = input;
  const tree = validation.tree;
  const started = Date.now();
  const tally: Tally = {
    verdicts: { pass: 0, suspect: 0, question: 0 },
    suspicions: { raised: 0, proved: 0, dropped: 0, tokens: 0 },
    repros: { confirmed: 0, dropped: 0 },
    calls: 0,
  };
  const phases: Phases = { modelMs: 0, proofsMs: 0 };
  const done = (review: ResultReview) => {
    input.log({
      event: "result-review",
      outcome: review.kind,
      criteria: criteria.length,
      ...tally,
      questions: review.kind === "pass" ? 0 : review.questions.length,
      phases,
      ms: Date.now() - started,
    });
    return review;
  };
  const settled = settledBy(
    { decisions: input.context?.decisions, earlier: input.earlier },
    input.itemId,
    tree,
  );
  // Settled criteria need no model and no workspace.
  if (criteria.every(settled)) return done(await find(input, tally));
  // The workspace starts installing beside the finder; only the proofs use it.
  const workspace = openWorkspace(input.workspace);
  void workspace.ready.then(
    () => {
      phases.prepareMs = Date.now() - started;
    },
    () => undefined,
  );
  try {
    const finding = Date.now();
    const found = await find(input, tally).finally(() => {
      phases.modelMs = Date.now() - finding;
    });
    const proving = Date.now();
    const review = await proveRefusals(input, found, {
      workspace,
      tree,
      tally,
      proofs: { next: 0 },
    }).finally(() => {
      phases.proofsMs = Date.now() - proving;
    });
    return done(review);
  } finally {
    await workspace.close();
  }
}

/**
 * The finder (review/finder.ts): the earlier result reviewer, fresh, on
 * the same evidence, with the re-review packet after it, as result.ts
 * `runReview` runs it. A criterion its answers leave without a valid
 * verdict is never met: it is asked again, alone with the others left so,
 * once, and one still without a verdict is the operator's question. Its
 * own `result-review` events are logged as `result-review-find`, and its
 * calls are counted.
 */
async function find(
  input: CandidateReview,
  tally: Tally,
): Promise<ResultReview> {
  const { criteria, validation } = input;
  const tree = validation.tree;
  const after =
    input.prior && input.prior.tree !== tree
      ? [await priorRow(input, input.prior)]
      : [];
  const own = input.itemCriteria ?? criteria.length;
  const ask = (asked: readonly number[], lastChance?: true) =>
    runReview({
      ...input.context,
      sources: input.context?.sources ?? [],
      design: input.context?.design ?? [],
      artifacts: input.context?.artifacts ?? [],
      phase: "result-review",
      planner: input.planner,
      checkout: input.checkout,
      base: input.base,
      commit: input.commit,
      validation,
      dir: input.dir,
      ...(input.earlier && { earlier: input.earlier }),
      itemId: input.itemId,
      criteria: asked.map((index) => criteria[index]!),
      instructions: finderInstructions(
        asked.filter((index) => index < own).length,
        asked.map((index) => criteria[index]!),
        (input.commandProofs ?? []).flatMap((proof) =>
          asked.includes(proof.criterionIndex)
            ? [
                {
                  ...proof,
                  criterionIndex: asked.indexOf(proof.criterionIndex),
                },
              ]
            : [],
        ),
      ),
      after,
      ...(lastChance && { lastChance }),
      signal: input.signal,
      log: (event: Record<string, unknown>) => {
        if (event.event === "model-usage") tally.calls += 1;
        input.log(
          event.event === "result-review"
            ? { ...event, event: "result-review-find" }
            : event,
        );
      },
    }).then((review) => renumber(review, asked));
  const all = criteria.map((_, index) => index);
  const first = await ask(all);
  const missing = all.filter((index) => !judged(first, index));
  if (!missing.length) return first;
  input.log({ event: "result-review-missing", criteria: missing });
  const again = await ask(missing, true);
  const still = missing.filter((index) => !judged(again, index));
  const merged = [first, again];
  const verdicts = merged.flatMap((review) => review.verdicts);
  const refused = merged.flatMap((review) =>
    review.kind === "refused" ? review.refused : [],
  );
  const questions = [
    ...merged.flatMap((review) =>
      review.kind === "pass" ? [] : review.questions,
    ),
    ...still.map((criterionIndex) => ({
      criterionIndex,
      criterion: criteria[criterionIndex]!,
      detail: "The independent reviewer gave no valid verdict for it, twice.",
      question:
        "The independent reviewer could not give a valid answer for this criterion twice. Inspect the evidence and accept or refuse it.",
    })),
  ];
  const order = <T extends { criterionIndex: number }>(entries: T[]) =>
    entries.sort((a, b) => a.criterionIndex - b.criterionIndex);
  if (refused.length)
    return {
      kind: "refused",
      tree,
      refused: order(refused),
      verdicts: order(verdicts),
      questions: order(questions),
    };
  if (questions.length)
    return {
      kind: "needs-human",
      tree,
      questions: order(questions),
      verdicts: order(verdicts),
    };
  return { kind: "pass", tree, verdicts: order(verdicts) };
}

/** Whether `review` gave criterion `index` a verdict, a refusal or a question. */
const judged = (review: ResultReview, index: number) =>
  [
    ...review.verdicts,
    ...(review.kind === "refused" ? review.refused : []),
    ...(review.kind === "pass" ? [] : review.questions),
  ].some((entry) => entry.criterionIndex === index);

/** `review` of the criteria `asked`, numbered as the whole review's. */
function renumber(
  review: ResultReview,
  asked: readonly number[],
): ResultReview {
  const at = <T extends { criterionIndex: number }>(entries: T[]) =>
    entries.map((entry) => ({
      ...entry,
      criterionIndex: asked[entry.criterionIndex]!,
    }));
  if (review.kind === "refused")
    return {
      ...review,
      refused: at(review.refused),
      verdicts: at(review.verdicts),
      questions: at(review.questions),
    };
  if (review.kind === "needs-human")
    return {
      ...review,
      questions: at(review.questions),
      verdicts: at(review.verdicts),
    };
  return { ...review, verdicts: at(review.verdicts) };
}

/** What a proof is told the finder's refusal rests on. */
const REFUSAL_BASIS =
  "The reviewer refused the criterion for this. Show the failure on the product, or report that it holds.";

/**
 * The finder's review with each of its own refusals proved: each is one
 * suspicion (its detail the case, its criterion the expectation), proved
 * as `proveSuspicions` does, reading the workspace's checkout. A confirmed
 * one stays a refusal, with its repro; any other is a pass, seen in the
 * run log only. Operator refusals, passes and questions stand.
 */
async function proveRefusals(
  input: CandidateReview,
  found: ResultReview,
  context: Omit<ProofContext, "readDir">,
): Promise<ResultReview> {
  const { tally, tree } = context;
  for (const verdict of found.verdicts)
    if (verdict.verdict === "pass") tally.verdicts.pass += 1;
  if (found.kind !== "pass") tally.verdicts.question += found.questions.length;
  if (found.kind !== "refused") return found;
  const model = found.refused.filter((entry) => entry.source === "model");
  tally.verdicts.suspect += model.length;
  if (!model.length) return found;
  const findings: (Finding | undefined)[] = [];
  for (const entry of model)
    findings[entry.criterionIndex] = {
      detail: entry.detail,
      suspicions: [
        { case: entry.detail, expected: entry.criterion, basis: REFUSAL_BASIS },
      ],
    };
  await proveSuspicions(
    input,
    {
      ...context,
      // A find-only review (no proofs) needs no workspace.
      readDir: input.limits.proofs
        ? (await context.workspace.ready).directory
        : "",
    },
    findings,
    model.map((entry) => entry.criterionIndex),
  );
  const repro = (index: number) => findings[index]?.repro;
  const refused = found.refused.flatMap((entry) =>
    entry.source !== "model"
      ? [entry]
      : repro(entry.criterionIndex)
        ? [{ ...entry, repro: repro(entry.criterionIndex)! }]
        : [],
  );
  const verdicts: ReviewedCriterion[] = [
    ...found.verdicts,
    ...model
      .filter((entry) => !repro(entry.criterionIndex))
      .map((entry) => ({
        criterionIndex: entry.criterionIndex,
        criterion: entry.criterion,
        verdict: "pass" as const,
        detail: "The reviewer's refusal of it did not reproduce.",
        evidence: entry.evidence,
      })),
  ].sort((a, b) => a.criterionIndex - b.criterionIndex);
  const { questions } = found;
  if (refused.length)
    return { kind: "refused", tree, refused, verdicts, questions };
  if (questions.length)
    return { kind: "needs-human", tree, questions, verdicts };
  return { kind: "pass", tree, verdicts };
}

// ---------------------------------------------------------------------------
// Workspace

/**
 * The review's workspace, opened at once and held until `close`: `ready`
 * is its checkout, and `copy` one of its copies, each removed with it.
 * One Factory can't make fails each command with why; the refusal check
 * then takes its outcome (`ScratchUnavailable`).
 */
function openWorkspace(workspace: Workspace) {
  let release: (() => void) | undefined;
  let held: Promise<unknown> = Promise.resolve();
  const ready = new Promise<ValidatedCheckout>((resolve, reject) => {
    const until = new Promise<void>((done) => {
      release = done;
    });
    held = workspace(async (checkout) => {
      crashPoint("review:scratch:open");
      resolve(checkout);
      await until;
    }).catch(reject);
  });
  // Observed here, so a failure no tool asked for is never unhandled.
  ready.catch(() => undefined);
  return {
    ready,
    async close(): Promise<void> {
      release?.();
      await held;
    },
  };
}

type OpenWorkspace = ReturnType<typeof openWorkspace>;

// ---------------------------------------------------------------------------
// Instructions and tools

/** A reviewer command's limit when it names none. */
const DEFAULT_COMMAND_MS = 60_000;

/**
 * A proof's instructions, which every provider gets verbatim (R10),
 * within 5,000 characters with its tool (R9): show the one suspicion with
 * a repro the refusal check confirms, or say it doesn't reproduce.
 */
export function proofInstructions(
  limits: Pick<ReviewLimits, "proofCommands" | "proofBudgetMs">,
): string {
  return [
    "You check one suspicion about a Work Item's result for Factory: show the failure with a command, or report that it doesn't reproduce. The request gives the acceptance criterion and the suspicion: a case, what the criterion requires there, and the reviewer's basis for suspecting it. Your working directory is a read-only copy of the candidate.",
    `Write a self-contained repro: a shell command that runs the product on that case (inline any script: node -e, python3 -c, a heredoc; build only what it needs; write only temporary files), prints the output and exits non-zero because that output is wrong. Run it with run_command (${limits.proofCommands} commands, ${Math.round(limits.proofBudgetMs / 1000)} s in all). You may vary the case's input to reach the failure the suspicion describes, but a repro of another behaviour, or of a test rather than the product, is no proof.`,
    "reproduced: it failed that way. Give input, expected, actual (copied verbatim from its output) and command. Factory runs the command again in a fresh copy and confirms it only when it exits non-zero (not 126, 127 or at its limit) with actual in its output. After a repair it runs as validation, so it must pass on a correct result.",
    "not-reproduced: the candidate behaves as the criterion requires there, or you could not show the failure within the budget; say what you saw.",
  ].join("\n");
}

/** What `run_command` tells the reviewer and each proof. */
export function commandToolDescription(
  limits: Pick<ReviewLimits, "commandMs" | "network">,
): string {
  return `Run a shell command (sh -c) in your scratch copy of the candidate: the exact result with its dependencies installed, under Factory's validation sandbox (${shellNetwork({ network: limits.network ?? "off" })}; no secrets, nothing else on the host). You may write files there; the candidate itself never changes. Returns the exit code and the output (long output keeps its start and end). Commands run one at a time, each for at most timeoutMs (default ${Math.min(DEFAULT_COMMAND_MS, limits.commandMs)}, at most ${limits.commandMs}), within your command budget.`;
}

const COMMAND_INPUT = {
  type: "object",
  properties: {
    command: { type: "string", minLength: 1 },
    timeoutMs: { type: "integer", minimum: 1000 },
  },
  required: ["command"],
  additionalProperties: false,
} as const;

/**
 * `run_command` in its own copy of the workspace, `copy`, made on its
 * first command, within a budget: `count` commands and `budgetMs` of
 * their summed time, each at most `limits.commandMs`; `spent` counts
 * them. `close` removes the copy.
 */
function commandTool(
  workspace: OpenWorkspace,
  copy: string,
  limits: ReviewLimits,
  budget: { count: number; budgetMs: number },
  spent: { count: number; ms: number },
): { tool: CallTool; close(): Promise<void> } {
  let scratch: Promise<CheckoutCopy> | undefined;
  return {
    tool: {
      name: "run_command",
      description: commandToolDescription(limits),
      input: COMMAND_INPUT,
      // The first command waits for the workspace's install too.
      limitMs: limits.prepareMs + limits.commandMs,
      run: async (raw) => {
        const { command, timeoutMs } = (isRecord(raw) ? raw : {}) as {
          command?: unknown;
          timeoutMs?: unknown;
        };
        if (typeof command !== "string" || !command.trim())
          throw new Error("run_command takes a nonempty command.");
        const left = budget.budgetMs - spent.ms;
        if (spent.count >= budget.count || left < 1000)
          throw new Error(
            `your command budget is spent (${spent.count} commands, ${Math.round(spent.ms / 1000)} s): answer from what you have.`,
          );
        scratch ??= workspace.ready.then((checkout) => {
          crashPoint("review:scratch:copy");
          return checkout.copy(copy);
        });
        const at = await scratch;
        const limit = Math.min(
          typeof timeoutMs === "number" && timeoutMs >= 1000
            ? timeoutMs
            : DEFAULT_COMMAND_MS,
          limits.commandMs,
          left,
        );
        spent.count += 1;
        const ran = await at.run(command, limit);
        spent.ms += ran.ms;
        return ranText(ran, limit);
      },
    },
    async close() {
      const made = await scratch?.catch(() => undefined);
      await made?.remove();
    },
  };
}

/** A command's result as the reviewer reads it. */
function ranText(run: CheckoutRun, limitMs: number): string {
  const status = run.timedOut
    ? `Stopped after ${limitMs} ms, with everything it started`
    : `Exit code ${run.exitCode ?? "none (ended by a signal)"}`;
  return `${status} (${run.ms} ms)\n${run.output}`;
}

/** Most bytes of the repair diff a re-review packet carries. */
const PRIOR_DIFF_BYTES = 48_000;

/** The refusals confirmed on the previous result, and the repair's diff since. */
async function priorRow(
  input: Pick<CandidateReview, "checkout" | "validation" | "signal">,
  prior: PriorRefusals,
): Promise<ResultEvidence> {
  const diff = await hostGit(
    input.checkout,
    [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      prior.tree,
      input.validation.tree,
    ],
    { signal: input.signal },
  ).then(
    (out) => out.toString("utf8"),
    // A tree Git no longer holds: the refusals still count.
    () => "",
  );
  return {
    origin: "controller",
    path: "Previous refusals and the repair",
    content: JSON.stringify({
      scope:
        "The refusals Factory confirmed on this Work Item's previous result (tree previousTree), each by running its repro, and the diff from that result to this one. Each repro command ran again as validation of this result and passed.",
      previousTree: prior.tree,
      refused: prior.refused,
      diff: headAndTail(diff, PRIOR_DIFF_BYTES * 0.75, PRIOR_DIFF_BYTES * 0.25),
    }),
    complete: diff.length <= PRIOR_DIFF_BYTES,
  };
}

// ---------------------------------------------------------------------------
// Proofs and the refusal check

/** A refusal the finder made, as a proof gets it. */
export interface Suspicion {
  case: string;
  expected: string;
  basis: string;
}

/** A criterion being proved: its suspicions, then its first confirmed repro. */
interface Finding {
  detail: string;
  suspicions?: Suspicion[];
  repro?: Repro;
  /** None of its suspicions was confirmed. */
  dropped?: true;
}

const text = (description?: string) => ({
  type: "string",
  minLength: 1,
  ...(description && { description }),
});

/** Whether `value` is an object whose `fields` are all nonempty text. */
const complete = (value: unknown, fields: readonly string[]) =>
  isRecord(value) &&
  fields.every(
    (field) => typeof value[field] === "string" && String(value[field]).trim(),
  );

interface Tally {
  /** The finder's verdicts; `suspect`: a criterion it refused, a suspicion. */
  verdicts: { pass: number; suspect: number; question: number };
  /**
   * Suspicions raised; of those, proved (their repro confirmed) and
   * dropped (not reproduced, not confirmed, or past the review's proofs);
   * the proofs' tokens.
   */
  suspicions: {
    raised: number;
    proved: number;
    dropped: number;
    tokens: number;
  };
  /** The proofs' repros the refusal check confirmed or dropped. */
  repros: { confirmed: number; dropped: number };
  /** The finder's calls. */
  calls: number;
}

/** Exit codes of a command the shell could not run (not executable, not found). */
const NOT_RUN = new Set([126, 127]);

const REPRO_FIELDS = ["input", "expected", "actual", "command"] as const;

/** A proof's answer: the repro it ran, or what it saw instead. */
export const PROOF_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    outcome: {
      anyOf: [
        {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["reproduced"] },
            repro: {
              type: "object",
              properties: {
                input: text(),
                expected: text(),
                actual: text(
                  "Text the command prints on this candidate, verbatim.",
                ),
                command: text(
                  "A self-contained shell command that exits non-zero on this candidate.",
                ),
              },
              required: [...REPRO_FIELDS],
              additionalProperties: false,
            },
          },
          required: ["kind", "repro"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["not-reproduced"] },
            detail: text(),
          },
          required: ["kind", "detail"],
          additionalProperties: false,
        },
      ],
    },
  },
  required: ["outcome"],
  additionalProperties: false,
};

/** A proof's answer decoded: its repro, none, or why the answer is invalid. */
function decodeProof(
  value: unknown,
): { repro: Repro } | { detail: string } | { invalid: string } {
  const outcome = isRecord(value) ? value.outcome : undefined;
  if (isRecord(outcome) && outcome.kind === "reproduced") {
    if (!complete(outcome.repro, REPRO_FIELDS))
      return {
        invalid:
          "A reproduced outcome needs a repro: input, expected, actual and command.",
      };
    const repro = outcome.repro as Record<string, unknown>;
    return {
      repro: Object.fromEntries(
        REPRO_FIELDS.map((field) => [field, String(repro[field])]),
      ) as unknown as Repro,
    };
  }
  if (
    isRecord(outcome) &&
    outcome.kind === "not-reproduced" &&
    typeof outcome.detail === "string"
  )
    return { detail: outcome.detail };
  return {
    invalid:
      'The answer must be {"outcome": {"kind": "reproduced", "repro": {...}}} or {"outcome": {"kind": "not-reproduced", "detail": "..."}}.',
  };
}

/** What the proofs of one review share. */
interface ProofContext {
  workspace: OpenWorkspace;
  /** The read-only copy of the candidate each proof reads: the workspace's checkout. */
  readDir: string;
  tree: string;
  tally: Tally;
  /** The proofs started so far, which numbers each one's copies. */
  proofs: { next: number };
}

/**
 * Prove the suspicions of the suspect findings among `indices`, at most
 * the review's `proofs` in all, taken in turn across the criteria (each
 * criterion's first, then each one's second, …), each in its own task as
 * many at once as the host has planner slots free (`atOnce`). Each finding
 * becomes a refusal with its first confirmed repro (the others confirmed
 * in its detail), or, with none, stays as the reviewer gave it.
 */
async function proveSuspicions(
  input: Pick<
    CandidateReview,
    "planner" | "criteria" | "limits" | "base" | "signal" | "log"
  >,
  context: ProofContext,
  findings: (Finding | undefined)[],
  indices: readonly number[],
): Promise<void> {
  const suspect = indices.filter(
    (index) => findings[index]?.suspicions?.length,
  );
  if (!suspect.length) return;
  const queued: { criterionIndex: number; suspicion: Suspicion }[] = [];
  for (let rank = 0; ; rank++) {
    const at = suspect.filter(
      (index) => findings[index]!.suspicions!.length > rank,
    );
    if (!at.length) break;
    for (const criterionIndex of at)
      queued.push({
        criterionIndex,
        suspicion: findings[criterionIndex]!.suspicions![rank]!,
      });
  }
  const { tally } = context;
  tally.suspicions.raised += queued.length;
  const room = Math.max(0, input.limits.proofs - context.proofs.next);
  for (const { criterionIndex, suspicion } of queued.slice(room)) {
    tally.suspicions.dropped += 1;
    input.log({
      event: "result-review-suspicion",
      criterionIndex,
      ...suspicion,
      outcome: "unproved",
      reason: `past the review's ${input.limits.proofs} proofs`,
    });
  }
  const taken = queued.slice(0, room).map((entry) => ({
    ...entry,
    proof: context.proofs.next++,
  }));
  const proved = await atOnce(taken, "planner", input.signal, (entry, signal) =>
    proveOne(input, context, entry, signal),
  );
  for (const index of suspect) {
    const finding = findings[index]!;
    const confirmed = taken.flatMap((entry, n) =>
      entry.criterionIndex === index && proved[n]
        ? [{ suspicion: entry.suspicion, repro: proved[n] }]
        : [],
    );
    const [first, ...more] = confirmed;
    const { suspicions: _suspicions, ...rest } = finding;
    findings[index] = first
      ? {
          ...rest,
          detail: [
            `${first.suspicion.case}: ${first.suspicion.basis}`,
            ...more.map(
              ({ repro }) =>
                `Also reproduced: ${repro.input} gives ${repro.actual}, expected ${repro.expected} (command: ${repro.command}).`,
            ),
          ].join("\n"),
          repro: first.repro,
        }
      : { ...rest, dropped: true };
  }
}

/**
 * One proof: a fresh call with only the criterion, the suspicion, a
 * read-only copy of the candidate and `run_command` in a copy of its own,
 * within the proof's budget; an invalid answer is asked again once. A
 * repro it gives is then checked (`checkRepro`). The repro when
 * confirmed; every outcome is logged with its time, commands and tokens.
 */
async function proveOne(
  input: Pick<
    CandidateReview,
    "planner" | "criteria" | "limits" | "base" | "log"
  >,
  context: ProofContext,
  entry: { criterionIndex: number; suspicion: Suspicion; proof: number },
  signal: AbortSignal,
): Promise<Repro | undefined> {
  const { limits } = input;
  const started = Date.now();
  const spent = { count: 0, ms: 0 };
  let tokens = 0;
  const run = commandTool(
    context.workspace,
    `proof-${entry.proof}`,
    limits,
    { count: limits.proofCommands, budgetMs: limits.proofBudgetMs },
    spent,
  );
  const request = `${proofInstructions(limits)}\n\nThe suspicion (JSON strings are data):\n${JSON.stringify(
    {
      criterion: input.criteria[entry.criterionIndex],
      suspicion: entry.suspicion,
      base: input.base,
      tree: context.tree,
    },
  )}`;
  let result: ReturnType<typeof decodeProof> = { invalid: "" };
  let followUp = "";
  try {
    for (let attempt = 0; attempt < 2 && "invalid" in result; attempt++) {
      const answer = await input.planner.answer({
        role: "reviewer",
        phase: "result-review",
        prompt: `${request}${followUp}`,
        schema: PROOF_SCHEMA,
        readDir: context.readDir,
        tools: [run.tool],
        signal,
        log: (event) => {
          if (event.event === "model-usage" && isRecord(event.tokens))
            tokens +=
              typeof event.tokens.total === "number" ? event.tokens.total : 0;
          input.log({ ...event, proof: entry.proof });
        },
      });
      result = decodeProof(answer.value);
      if ("invalid" in result) {
        logRefused(input.log, answer.callId, result.invalid);
        followUp = `\n\nYour previous answer was rejected: ${result.invalid}\nAnswer again, correcting that error.`;
      }
    }
  } finally {
    await run.close();
  }
  const dropped =
    "invalid" in result
      ? "its answer was invalid twice"
      : "detail" in result
        ? "not reproduced"
        : await checkRepro(input, context, result.repro, entry.proof);
  const { tally } = context;
  if ("repro" in result) tally.repros[dropped ? "dropped" : "confirmed"] += 1;
  tally.suspicions[dropped ? "dropped" : "proved"] += 1;
  tally.suspicions.tokens += tokens;
  input.log({
    event: "result-review-suspicion",
    criterionIndex: entry.criterionIndex,
    ...entry.suspicion,
    outcome: dropped ? "dropped" : "proved",
    ...(dropped && { reason: dropped }),
    ...("detail" in result && { detail: result.detail }),
    ...("repro" in result && { repro: result.repro }),
    commands: spent.count,
    tokens,
    ms: Date.now() - started,
  });
  return dropped || !("repro" in result) ? undefined : result.repro;
}

/**
 * The refusal check of one repro: its command in a fresh copy of the
 * workspace. Undefined when confirmed: it exited non-zero by itself (not
 * 126, 127 or at its limit) and its output holds the claimed actual
 * output; otherwise why it was dropped. A workspace Factory couldn't make
 * escapes as the step's outcome.
 */
async function checkRepro(
  input: Pick<CandidateReview, "limits" | "log">,
  context: Pick<ProofContext, "workspace">,
  repro: Repro,
  proof: number,
): Promise<string | undefined> {
  const checkout = await context.workspace.ready;
  const copy = await checkout.copy(`repro-${proof}`);
  let run: CheckoutRun;
  try {
    crashPoint("review:repro:before");
    run = await copy.run(repro.command, input.limits.commandMs);
    crashPoint("review:repro:after");
  } finally {
    await copy.remove();
  }
  const dropped = run.timedOut
    ? "it reached its time limit"
    : run.exitCode === 0
      ? "it exited 0"
      : run.exitCode === null || NOT_RUN.has(run.exitCode)
        ? "it did not run"
        : !squeezed(run.output).includes(squeezed(repro.actual))
          ? "its output lacks the claimed actual output"
          : undefined;
  input.log({
    event: "result-review-repro",
    proof,
    confirmed: !dropped,
    ...(dropped && { reason: dropped }),
    exitCode: run.exitCode,
    ms: run.ms,
  });
  return dropped;
}

/**
 * `run` over `items`, one at a time plus one more at once for each slot of
 * `resource` the host has free now (engine.ts `hostLimits`), never
 * waiting for one; results in `items`' order. The first failure stops the
 * rest (their `signal`) and is thrown once all have ended.
 */
async function atOnce<T, R>(
  items: readonly T[],
  resource: "cpu" | "planner",
  signal: AbortSignal,
  run: (item: T, signal: AbortSignal) => Promise<R>,
): Promise<R[]> {
  let lanes = Math.min(1, items.length);
  while (lanes < items.length && hostLimits.acquire(resource)) lanes += 1;
  const stop = new AbortController();
  const each = AbortSignal.any([signal, stop.signal]);
  const results: R[] = [];
  let next = 0;
  try {
    const ended = await Promise.allSettled(
      Array.from({ length: lanes }, async () => {
        while (next < items.length && !each.aborted) {
          const at = next++;
          try {
            results[at] = await run(items[at]!, each);
          } catch (error) {
            stop.abort(error);
            throw error;
          }
        }
      }),
    );
    const failed = ended.find((lane) => lane.status === "rejected");
    // The first failure, not the stops it caused.
    if (failed) throw stop.signal.aborted ? stop.signal.reason : failed.reason;
  } finally {
    for (let lane = 1; lane < lanes; lane++) hostLimits.release(resource);
  }
  return results;
}

/** Text with its runs of whitespace as one space, for comparing output. */
const squeezed = (text: string) => text.replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------------------
// Outcome

/** A review's notes: each met criterion's non-blocking suggestion, for the PR body and final review. */
export function reviewNotes(
  review: ResultReview,
): { criterion: string; note: string }[] {
  return review.verdicts
    .filter((verdict) => verdict.verdict === "note")
    .map((verdict) => ({ criterion: verdict.criterion, note: verdict.detail }));
}
