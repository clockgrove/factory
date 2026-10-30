/**
 * A worker's own Validate, shared by the Claude, Copilot and Codex workers: the
 * Work Item's declared commands through `validateTree` on a snapshot commit
 * of the worker's current files, in a fresh checkout, plus the handoff
 * decode collection will apply. The worker names no command: only the
 * declared ones run. Runs are queued one at a time.
 */

import { closeSync, constants } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { SandboxConfig } from "../config.js";
import { hold, objectiveWide } from "../engine.js";
import { GitRefusal } from "../git.js";
import { needsSelection } from "../media.js";
import { forceRemove, openParent } from "../paths.js";
import { DESIGN_QUESTIONS } from "../planning/rubric.js";
import type { Plan, WorkItem } from "../planning/types.js";
import type { RepairFinding } from "../repair.js";
import { resultCriteria } from "../review/result.js";
import type { ObjectiveBlock } from "../shown.js";
import { errorMessage, failureExcerpt } from "../text.js";
import { type Validation, validateTree } from "../validate.js";
import { hasGitlink, installStorePath } from "../worktree.js";
import {
  type HandoffNote,
  handoffPeers,
  readHandoffNotes,
  snapshot,
  VALIDATE_LOGS,
  VALIDATE_STEP_LOG,
  workHandoffSchema,
} from "./collect.js";
import type { WorkerInput, WorkerResult } from "./worker.js";

/** What Validate needs beyond the worker's input. */
export interface SelfValidateOptions {
  sandbox: SandboxConfig;
  /** The accepted plan: Validate's pins and the handoff's peers. */
  plan: Plan;
  /** The Objective's shown structure as planned: its package-manager and workspace pins. */
  blocks: readonly ObjectiveBlock[];
  /** Origin's `owner/name`: Validate fetches Git LFS objects the local store lacks from it. */
  repository: string;
  /** Each command's limit: `validation.commandTimeoutSeconds`, in ms. */
  commandTimeoutMs: number;
  /** The repository's formatter (`validation.formatCommand`): applied before the commands, as after the worker finishes. */
  formatCommand?: string;
}

/** What the worker hears when Factory formatted its files for a Validate run. */
export function formattedNote(formatted: {
  command: string;
  files: readonly string[];
}): string {
  const files = formatted.files.slice(0, 20).join(", ");
  return `Factory applied the repository's formatter (\`${formatted.command}\`) to ${formatted.files.length} of your files for this run (${files}${formatted.files.length > 20 ? ` and ${formatted.files.length - 20} more` : ""}), and the commands ran on the formatted files. It does the same when it validates your result after you finish, and commits the formatting itself, so don't format by hand or spend turns on formatting.`;
}

export const VALIDATION_TOOL_DESCRIPTION =
  "Run this work item's declared validation commands (the same ones Factory runs after you finish) on a snapshot of your current files, decode .factory-handoff.json as Factory will when it collects your result, and return the result. Files the commands produce under your owned paths that Git ignores (such as actual values a check writes) are copied back to your checkout at the same paths, and the result lists them. A failed command's output in the result is an excerpt: its complete output is written to a log under .factory-validate/ in your checkout, which the result names. Takes several minutes. Run it after implementing and fix any failure it reports. Run it again after your last edit, including self-review and handoff fixes: finish only after a run passes on your final files.";

/**
 * What a failed check asks of a fix outside the owned paths: the worker's
 * discovery (repair.ts `discover`), never a change or a report alone.
 */
export const UNOWNED_FIX =
  "If the fix needs files outside your owned paths, do not change them: write an in-scope .factory-discovery.json naming them and stop.";

/**
 * What Validate means for a media item (#2116): its selected set is never
 * in the worker's checkout, so never in the snapshot Validate runs on, and
 * a check of the delivered files fails there for that reason alone, as the
 * worker prompt's media contract says (work/prompt.ts
 * `ABSENT_DESTINATIONS`). Everything Factory tells the worker about
 * Validate (the tool, a failed run, the request to validate, a turn-limit
 * continuation) carries it, so none of them asks for a fix or a discovery
 * of that failure, or for a passing run it can't have.
 */
export const SELECTED_MEDIA_VALIDATE =
  "This item's selected media are not in your checkout, so not in the files Validate runs on either: Factory writes the operator's chosen set at their destinations after selection, and its own validation runs with them there. A failure caused only by their absence, such as a test of the delivered files that can't find them, is expected: it is no failure to fix and no discovery. Keep the check as the acceptance requires, do not write .factory-discovery.json for it, and finish once every other failure is fixed, reporting it.";

/** SELECTED_MEDIA_VALIDATE, with a leading space, for an item that needs a selection; else nothing. */
export function selectedMediaNote(item: WorkItem): string {
  return needsSelection(item) ? ` ${SELECTED_MEDIA_VALIDATE}` : "";
}

/** The Validate tool's description for `item`'s worker. */
export function validationToolDescription(item: WorkItem): string {
  return `${VALIDATION_TOOL_DESCRIPTION}${selectedMediaNote(item)}`;
}

export const VALIDATE_REQUEST = `Run Validate on your final files, fix any failures, then give your final report. ${UNOWNED_FIX}`;

/**
 * The request to validate for `item`'s worker: a media item's also says
 * what a failure for its absent selected set means (`selectedMediaNote`).
 */
export function validateRequest(item: WorkItem): string {
  return `${VALIDATE_REQUEST}${selectedMediaNote(item)}`;
}

/** Turns that return a handoff manifest collection would reject. */
const MAX_HANDOFF_REFUSALS = 2;

/**
 * What a worker's finished turn still owes before its result is returned,
 * asked on the same conversation, as the Claude and Codex workers do: a
 * handoff manifest collection would reject is refused twice, then a result
 * no passing Validate covered gets one request to validate (only when the
 * worker has Validate). `next` gives the request, or undefined when the
 * result is returned as it is.
 */
export class FinishRequests {
  private handoffRefusals = 0;
  private validationRequested = false;

  constructor(
    private readonly validator: SelfValidation,
    /** The worker has Validate. */
    private readonly validating: boolean,
    private readonly item: WorkItem,
    /**
     * How this worker calls Validate, after the request: a Codex worker's
     * model may not see the tool listed (codex-validate.ts
     * `CODEX_VALIDATE_CALL`).
     */
    private readonly call = "",
  ) {}

  /** `race` bounds each check, as the turn's watchdog does. */
  async next(
    race: <T>(operation: Promise<T>) => Promise<T>,
  ): Promise<string | undefined> {
    if (this.handoffRefusals < MAX_HANDOFF_REFUSALS) {
      const handoff = await race(this.validator.checkHandoff());
      if (!handoff.passed) {
        this.handoffRefusals += 1;
        return `Your result is not finished. ${handoff.text}\nThen give your final report.`;
      }
    }
    if (
      this.validating &&
      !this.validationRequested &&
      (await race(this.validator.finalTree())) === false
    ) {
      this.validationRequested = true;
      return `${validateRequest(this.item)}${this.call && ` ${this.call}`}`;
    }
    return undefined;
  }
}

/**
 * The least of a failed command's output a Validate result keeps, in bytes,
 * whatever else it holds; it gets what the result has left when that is
 * more.
 */
const VALIDATION_OUTPUT_CHARS = 8_000;
/**
 * Note excerpts in the criterion map, longest first: enough of a note to see
 * which criterion and sub-clauses it answers, then shorter ones, then none,
 * while the map is over its bound.
 */
const NOTE_EXCERPTS = [600, 200, 0] as const;
/**
 * The most one Validate result holds, in characters, for every worker
 * (#2156). Codex keeps 10,000 tokens of a tool's output for its models
 * (each model's truncation_policy, and code mode's `exec` default), counted
 * as 4 bytes a token, and cuts the middle of anything longer, which would
 * drop part of the criterion map; the Claude Agent SDK's MCP cap is larger.
 * So the whole result stays under Codex's limit, with room for the exec
 * wrapper, and the same for all three workers. A failed run's result is
 * bounded in UTF-8 bytes, since a command's output can be far from ASCII.
 */
export const VALIDATE_RESULT_CHARS = 30_000;

/**
 * Plain text within `bytes` of UTF-8: the start, which names the failed
 * command, the end, and the lines that say why it failed wherever they are
 * (#2201). Codex counts a result's bytes, and output such as a linter's
 * code frames takes more than one a character, so the excerpt shrinks until
 * its bytes fit.
 */
function bounded(output: string, bytes: number): string {
  const plain = stripVTControlCharacters(output);
  const room = Math.max(VALIDATION_OUTPUT_CHARS, bytes);
  for (let chars = room; ; ) {
    const excerpt = failureExcerpt(plain, chars);
    const size = Buffer.byteLength(excerpt);
    if (size <= room) return excerpt;
    chars = Math.max(0, Math.floor((chars * room) / size) - 1);
  }
}

/**
 * The most of one failed command's output a log under VALIDATE_LOGS holds:
 * past it, its first and last halves, with the cut stated.
 */
export const VALIDATE_LOG_BYTES = 8 * 1024 ** 2;

/**
 * A failed command's complete output, as a log of it holds it (#2201): the
 * command's attempt file, its streams in the order they arrived, under a
 * line naming the command; without one, the output the run kept, which
 * bounds each stream and puts stderr after stdout. Plain text.
 */
export function failedCommandLog(
  result: Pick<
    Extract<Validation, { kind: "failed" }>,
    "output" | "outputFile"
  >,
  failed: { command: string; exit?: string } | undefined,
): string {
  const whole = failed ? result.outputFile?.read() : undefined;
  return stripVTControlCharacters(
    whole && failed
      ? `Validation command failed (${failed.exit ?? "failed"}): ${failed.command}\n${whole.text}`
      : result.output,
  );
}

/**
 * `text` as a log under VALIDATE_LOG_BYTES keeps it: whole, or past the
 * bound its first and last halves, with the cut stated.
 */
export function boundedValidateLog(text: string): Buffer {
  const bytes = Buffer.from(text, "utf8");
  const half = VALIDATE_LOG_BYTES / 2;
  return bytes.length <= VALIDATE_LOG_BYTES
    ? bytes
    : Buffer.concat([
        bytes.subarray(0, half),
        Buffer.from(
          `\n[${bytes.length - 2 * half} bytes omitted: this log keeps the first and last ${half} bytes of ${bytes.length}]\n`,
        ),
        bytes.subarray(-half),
      ]);
}

/**
 * What a worker hears about the excerpt of a failed command's output, and
 * where to see everything (#2201). A tool may leave diagnostics out of its
 * own report as well; Factory passes no flag of any tool's.
 */
export function validateLogNote(command: string, path: string): string {
  return `The output above is an excerpt, and a tool can leave diagnostics out of its own report too (a count of diagnostics not shown, say): the complete output of \`${command}\` is in ${path} in your checkout. Read that log, or run the command in your checkout, to see everything. The log is Factory's private staging, never part of your result, and your next Validate run replaces it.`;
}

/**
 * Write `text` to `path`, a new file under VALIDATE_LOGS in `worktree`,
 * read-only and within VALIDATE_LOG_BYTES. The checkout is the worker's,
 * so the directory is reached by held descriptors (paths.ts `openParent`)
 * and the file made new without following a link: nothing the worker
 * planted there redirects the write.
 */
export async function writeValidateLog(
  worktree: string,
  path: string,
  text: string,
): Promise<void> {
  const content = boundedValidateLog(text);
  const parent = openParent(worktree, path, true);
  try {
    await writeFile(`${parent.anchor}/${parent.name}`, content, {
      flag:
        constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      mode: 0o400,
    });
  } finally {
    closeSync(parent.fd);
  }
}

/**
 * A work attempt's VALIDATE_LOGS, made fresh before its worker runs: empty,
 * or holding the validate step's complete output of the command it failed
 * at VALIDATE_STEP_LOG, when the finding kept that in a file
 * (step-validate.ts, #2201). Returns that path when it is there.
 */
export async function stageValidateLog(
  worktree: string,
  finding: RepairFinding | undefined,
): Promise<string | undefined> {
  await forceRemove(join(worktree, VALIDATE_LOGS));
  if (finding?.kind !== "failure" || !finding.output) return undefined;
  // Gone with its work directory: the finding's excerpt is what is left.
  const text = await readFile(finding.output, "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  await writeValidateLog(worktree, VALIDATE_STEP_LOG, text);
  return VALIDATE_STEP_LOG;
}

/** A Validate run's log of a failed command: the run, then the command as a file name. */
function logPath(run: number, command: string): string {
  const slug = command
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${VALIDATE_LOGS}/run-${run}-${slug || "command"}.log`;
}

/**
 * Each criterion's exact text beside the note recorded for its index, so the
 * final self-review compares against the criterion, not a paraphrase, within
 * `bound` characters. A criterion is never cut: past the bound, note
 * excerpts shorten (the worker has its notes), then the criteria that don't
 * fit are named, never shown in part, for the worker to compare from its
 * instructions (#2156).
 */
export function criterionMap(
  acceptance: readonly string[],
  notes: readonly HandoffNote[] = [],
  bound = Number.POSITIVE_INFINITY,
): string {
  const summaries = new Map(
    notes
      .filter((note) => note.kind === "verification")
      .map((note) => [note.criterionIndex, note.summary]),
  );
  const missing = acceptance.flatMap((_, index) =>
    summaries.has(index) ? [] : [index],
  );
  const head = `Check each acceptance criterion's exact text against the verification note recorded for its index. The reviewer checks every sub-clause of this text, not a paraphrase: a note that answers another criterion, merges criteria or omits a sub-clause leaves that criterion unproved. Add any missing proof, then fix the note.${missing.length ? ` No note yet for criteria ${missing.join(", ")}.` : ""}`;
  const lines = (excerpt: number) =>
    acceptance.map((criterion, index) => {
      const summary = summaries.get(index);
      const note =
        summary === undefined
          ? "none recorded"
          : summary.length <= excerpt
            ? summary
            : excerpt
              ? `${summary.slice(0, excerpt)} [${summary.length - excerpt} more characters]`
              : `recorded (${summary.length} characters; not repeated here)`;
      return `[${index}] ${criterion}\nnote [${index}]: ${note}`;
    });
  let shown: string[] = [];
  for (const excerpt of NOTE_EXCERPTS) {
    shown = lines(excerpt);
    const map = `${head}\n${shown.join("\n")}`;
    if (map.length <= bound) return map;
  }
  // Even without notes the criteria are over the bound: whole ones while
  // they fit, then the rest named.
  const rest = (from: number) =>
    `Criteria [${from}] to [${acceptance.length - 1}] are not repeated here, to keep this result within the tool output limit: compare each with its note from the acceptance list in your instructions.`;
  let length = head.length + 1 + rest(acceptance.length).length;
  let fits = 0;
  while (fits < shown.length && length + shown[fits]!.length + 1 <= bound)
    length += shown[fits++]!.length + 1;
  return [head, ...shown.slice(0, fits), rest(fits)].join("\n");
}

/**
 * A declared command the worker's Validate failed, and no later run of the
 * attempt passed: the command, how it ended (`exit`, when it failed by
 * itself) and its output as Validate returned it. An amendment may replace
 * such a planned command, through its review (#2199).
 */
export interface WorkerValidateFailure {
  command: string;
  exit?: string;
  output: string;
}

/** A finished result's `validateFailed`: what `validator`'s runs failed, or nothing. */
export function validateFailed(validator: SelfValidation | undefined): {
  validateFailed?: WorkerValidateFailure[];
} {
  const failures = validator?.failures() ?? [];
  return failures.length ? { validateFailed: failures } : {};
}

export interface HandoffCheck {
  passed: boolean;
  text?: string;
  /** Each criterion beside its note, within a bound (`criterionMap`). */
  criteria?: (bound: number) => string;
}

/**
 * Whether the worktree holds a submodule gitlink. Host Git must not enter a
 * repository the commands could write behind one, so Validate never runs in
 * such a checkout; a Git refusal is the whole Objective's question.
 */
export async function worktreeGitlinks(
  input: WorkerInput,
): Promise<boolean | WorkerResult> {
  try {
    return await hasGitlink(input.worktree, { signal: input.signal });
  } catch (error) {
    if (error instanceof GitRefusal) return objectiveWide(hold(error.message));
    throw error;
  }
}

/** One attempt's Validate: its runs and the trees that passed. */
export class SelfValidation {
  private queue: Promise<unknown> = Promise.resolve();
  private runs = 0;
  private readonly passedTrees = new Set<string>();
  /** Trees whose last run failed. */
  private readonly failedTrees = new Set<string>();
  /** The commands a run failed and no later run passed, by command. */
  private readonly failing = new Map<string, WorkerValidateFailure>();

  /** `signal` stops a running validation: cancel, or the attempt ending. */
  constructor(
    private readonly input: WorkerInput,
    private readonly options: SelfValidateOptions,
    private readonly signal: AbortSignal,
  ) {}

  /** One tool call: the result text, or why validation is unavailable. */
  async call(): Promise<{ text: string; isError: boolean }> {
    const result = this.queue.then(() => this.validate());
    this.queue = result.catch(() => undefined);
    try {
      return { text: await result, isError: false };
    } catch (error) {
      return {
        text: `Factory validation unavailable: ${errorMessage(error)}`,
        isError: true,
      };
    }
  }

  /** Settles once no run is in flight. */
  idle(): Promise<unknown> {
    return this.queue;
  }

  /**
   * The declared commands on a snapshot commit of the worker's current
   * files, in a fresh checkout, so the worker's files never change and no
   * build output or other run's temporary files reach the commands.
   */
  private async validate(): Promise<string> {
    const run = ++this.runs;
    const { input, options } = this;
    const signal = this.signal;
    // An earlier run's logs, or the validate step's, describe other files.
    await forceRemove(join(input.worktree, VALIDATE_LOGS));
    const handoff = await this.checkHandoff();
    const snapped = await snapshot(input.worktree, options.sandbox, signal);
    if ("problem" in snapped)
      return `Validation failed. Fix this before you finish.\n${snapped.problem}`;
    const { tree, commit } = snapped;
    const result = await validateTree({
      checkout: input.worktree,
      repository: options.repository,
      directory: `${input.worktree}.validation`,
      // The validate step keeps the same store (step-validate.ts).
      installStore: installStorePath(input.worktree),
      commit,
      item: input.item,
      plan: options.plan,
      blocks: options.blocks,
      sandbox: options.sandbox,
      commandTimeoutMs: options.commandTimeoutMs,
      returnTo: input.worktree,
      base: input.base,
      predecessor: input.base !== options.plan.base ? input.base : undefined,
      // Resolved here as after the worker finishes, but never committed.
      lockfile: {},
      // Formatted here as after the worker finishes; the commit is
      // never pinned or delivered.
      ...(options.formatCommand
        ? { format: { command: options.formatCommand } }
        : {}),
      signal,
      log: input.log,
      runFile: input.runFile,
    });
    if (result.kind === "retry") throw new Error(result.reason);
    if (result.kind === "hold") throw new Error(result.question);
    const passed = result.kind === "passed";
    const logged =
      result.kind === "failed" && result.failed
        ? `\n${await this.logFailure(run, result, result.failed)}`
        : "";
    const compose = (output: string) => {
      const declared =
        result.kind === "passed"
          ? `All ${result.commands.length} declared validation commands passed:\n${result.commands.map((command) => `- ${command}`).join("\n")}`
          : `Validation failed. Fix this before you finish.\n${output}${logged}\n${UNOWNED_FIX}${selectedMediaNote(input.item)}`;
      const composed = [
        result.produced ? `${declared}\n\n${result.produced}` : declared,
      ];
      if (result.regenerated)
        composed.push(
          `Your dependency change left ${result.regenerated.lockfile} out of date, so Factory resolved it for this run, under the repository's package policy. It does the same when it validates your result, and commits the lockfile on it. Leave ${result.regenerated.lockfile} as it is: don't edit or regenerate it.`,
        );
      if (result.formatted) composed.push(formattedNote(result.formatted));
      if (handoff.text)
        if (handoff.passed) composed.push(handoff.text);
        else composed.unshift(handoff.text);
      if (passed && !handoff.passed)
        composed.unshift("Validation failed. Fix this before you finish.");
      return composed;
    };
    // A failed command's output gets the bytes the rest of the result
    // leaves (VALIDATE_RESULT_CHARS), cut to keep its failure lines (#2201).
    const parts =
      result.kind === "passed"
        ? compose("")
        : compose(
            bounded(
              result.failed
                ? `${result.failed.command} failed:\n${result.output}`
                : result.output || result.detail,
              VALIDATE_RESULT_CHARS -
                Buffer.byteLength(compose("").join("\n\n")),
            ),
          );
    // Self-review follows a passing run, last and within what the result has
    // left (VALIDATE_RESULT_CHARS), so no worker's harness cuts it.
    if (passed && handoff.criteria)
      parts.push(
        handoff.criteria(
          VALIDATE_RESULT_CHARS - parts.join("\n\n").length - "\n\n".length,
        ),
      );
    // The handoff is outside the tree; the final check decodes it again.
    if (passed) {
      this.passedTrees.add(tree);
      this.failedTrees.delete(tree);
    } else this.failedTrees.add(tree);
    // A command a later run passed can pass: it is no longer evidence.
    if (result.kind === "passed") this.failing.clear();
    else {
      for (const ran of result.results) this.failing.delete(ran.command);
      if (result.failed)
        this.failing.set(result.failed.command, {
          command: result.failed.command,
          ...(result.failed.exit !== undefined
            ? { exit: result.failed.exit }
            : {}),
          output: bounded(
            result.output || result.detail,
            VALIDATION_OUTPUT_CHARS,
          ),
        });
    }
    input.log({
      event: "worker-validate",
      run,
      passed: passed && handoff.passed,
      tree,
      handoffPassed: handoff.passed,
    });
    return parts.join("\n\n");
  }

  /**
   * The failed command's complete output, written to a log in the worker's
   * checkout (`writeValidateLog`), so no excerpt decides what the worker
   * can see (#2201): what the result says about it (`failedCommandLog`).
   */
  private async logFailure(
    run: number,
    result: Extract<Validation, { kind: "failed" }>,
    failed: { command: string; exit?: string },
  ): Promise<string> {
    const path = logPath(run, failed.command);
    try {
      await writeValidateLog(
        this.input.worktree,
        path,
        failedCommandLog(result, failed),
      );
      return validateLogNote(failed.command, path);
    } catch (error) {
      return `The complete output of \`${failed.command}\` could not be written to your checkout (${errorMessage(error)}): run the command in your checkout to see everything.`;
    }
  }

  /**
   * Decode .factory-handoff.json as collection will, so the worker can
   * repair a manifest that would reject its whole result. `criteria` maps
   * each criterion to its note once the manifest decodes.
   */
  async checkHandoff(): Promise<HandoffCheck> {
    const { item, worktree } = this.input;
    const { plan } = this.options;
    // The criteria its review judges, as its contract numbers them.
    const criteria = resultCriteria(plan, item);
    const count = criteria.length;
    const notes = await readHandoffNotes(worktree, plan, item);
    if (notes && "problem" in notes)
      return {
        passed: false,
        text: `.factory-handoff.json would be rejected at collection, and your whole result with it. ${notes.problem}\nRewrite it to match this exact schema, then run validation again: ${JSON.stringify(workHandoffSchema(handoffPeers(plan, item).length, count))}`,
      };
    if (!notes)
      return {
        passed: true,
        ...(count && {
          text: `No .factory-handoff.json yet. Before you finish, record one verification note for each of the ${count} acceptance criteria there, using the schema in your instructions.`,
          criteria: (bound: number) => criterionMap(criteria, [], bound),
        }),
      };
    const verified = notes.filter(
      (note) => note.kind === "verification",
    ).length;
    const answered = new Set<string>(
      notes.flatMap((note) => note.designRisk ?? []),
    );
    const unanswered = Object.keys(DESIGN_QUESTIONS).filter(
      (risk) => !answered.has(risk),
    );
    return {
      passed: true,
      text: `.factory-handoff.json decodes: ${notes.length} notes, verification notes for ${verified} of ${count} acceptance criteria.${unanswered.length ? ` No design note yet for ${unanswered.join(", ")}.` : ""}`,
      ...(count && {
        criteria: (bound: number) => criterionMap(criteria, notes, bound),
      }),
    };
  }

  /**
   * Whether a passing Validate run covered the files the worker returns,
   * with a handoff collection accepts: the tree, false, or undefined when
   * the files can't be staged (collection reports that itself).
   */
  async finalTree(): Promise<string | false | undefined> {
    if (!this.passedTrees.size) return false;
    try {
      const snapped = await snapshot(
        this.input.worktree,
        this.options.sandbox,
        this.input.signal,
      );
      if ("problem" in snapped) return undefined;
      return this.passedTrees.has(snapped.tree) &&
        (await this.checkHandoff()).passed
        ? snapped.tree
        : false;
    } catch {
      return undefined;
    }
  }

  /** The commands this attempt's runs failed that no later run passed (`WorkerValidateFailure`). */
  failures(): WorkerValidateFailure[] {
    return [...this.failing.values()];
  }

  /** Whether the last run on the files the worker has now failed. */
  async finalFailed(): Promise<boolean> {
    if (!this.failedTrees.size) return false;
    try {
      const snapped = await snapshot(
        this.input.worktree,
        this.options.sandbox,
        this.input.signal,
      );
      return !("problem" in snapped) && this.failedTrees.has(snapped.tree);
    } catch {
      return false;
    }
  }
}
