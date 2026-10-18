import { rm } from "node:fs/promises";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { McpServerStatus } from "@anthropic-ai/claude-agent-sdk";
import { validateToolConfigName } from "../config.js";
import { LocalContentStore } from "../content/local.js";
import {
  hasUnresolvedSubprocesses,
  pinnedGit,
  pinnedGitAsync,
  pinnedGitMagicAsync,
} from "../process.js";
import { workHandoffSchema } from "../objective-knowledge.js";
import { validateTree } from "../validation.js";
import { CandidateValidationFailure } from "../work-repair.js";
import type { HarnessRequest, WorkHandoffNote } from "../contracts.js";
import { readWorkHandoff } from "./harness-support.js";
import {
  FACTORY_EMAIL,
  privateStagingExclusions,
  workerValidationRoot,
} from "./local.js";
import {
  returnProducedFiles,
  type ValidationOutputs,
} from "./validation-outputs.js";

export const factoryValidationServerName = "factory-validation";
const factoryValidationServerVersion = "1.0.0";
export const factoryValidationToolName =
  "mcp__factory-validation__run_validation";

/** Keep the tail: failures report last. */
const maxOutputChars = 8_000;

interface ValidationEnvironmentInput {
  worktree: string;
  commands: readonly string[];
  /** The Work Item's owned paths: produced files under them come back. */
  ownedPaths: readonly string[];
  config: { tools: readonly string[]; allowedTools: readonly string[] };
  handoff: HandoffContext;
  lfs?: HarnessRequest["validationLfs"];
  /** Each completed run's structured facts, for the worker's progress stream. */
  onRun?: (facts: ValidationRunFacts) => void;
}

/** A completed worker validation run: counts and identities, never output. */
interface ValidationRunFacts {
  run: number;
  /** The worker was told it passed: declared commands and its handoff. */
  passed: boolean;
  /** The validated files' Git tree. */
  tree: string;
  commands: number;
  ran: number;
  failed: number;
  handoffPassed: boolean;
}

interface HandoffContext {
  peers: readonly { id: string; title: string }[];
  /** The Work Item's exact acceptance criteria, in criterionIndex order. */
  acceptance: readonly string[];
}

/** Enough of a note to see which criterion and sub-clauses it answers. */
const maxNoteExcerptChars = 600;

function validationAuthorized(input: {
  config: { tools: readonly string[]; allowedTools: readonly string[] };
}): boolean {
  return (
    input.config.tools.includes(validateToolConfigName) &&
    input.config.allowedTools.includes(validateToolConfigName)
  );
}

/** The declared commands a configured worker may run, or none. */
export function workerValidationCommands(input: {
  config: { tools: readonly string[]; allowedTools: readonly string[] };
  request: { item: { validation: { command: string }[] } };
}): string[] {
  return validationAuthorized(input)
    ? input.request.item.validation.map((entry) => entry.command)
    : [];
}

/** Both SDK permission callbacks use the same exact provenance check. */
export function factoryValidationToolAllowed(
  input: {
    config: { tools: readonly string[]; allowedTools: readonly string[] };
  },
  toolName: string,
  toolInput: unknown,
  provenance: unknown,
): boolean {
  if (
    !validationAuthorized(input) ||
    toolName !== factoryValidationToolName ||
    !provenance ||
    typeof provenance !== "object" ||
    Array.isArray(provenance) ||
    !toolInput ||
    typeof toolInput !== "object" ||
    Array.isArray(toolInput)
  )
    return false;
  const source = provenance as Record<string, unknown>;
  return (
    source.name === factoryValidationServerName &&
    source.source === "sdk" &&
    Object.keys(toolInput).length === 0
  );
}

function assertFactoryValidationReady(status: McpServerStatus): void {
  if (
    status.name !== factoryValidationServerName ||
    status.source !== "sdk" ||
    status.status !== "connected" ||
    status.serverInfo?.name !== factoryValidationServerName ||
    status.serverInfo.version !== factoryValidationServerVersion ||
    status.tools?.length !== 1 ||
    status.tools[0]?.name !== "run_validation"
  )
    throw new Error("Factory validation MCP readiness verification failed");
}

/** Plain text: colour codes cost tokens and carry nothing for the worker. */
function bounded(text: string): string {
  const plain = stripVTControlCharacters(text);
  // The first line names the failed command; the tail holds the failures.
  const head = plain.split("\n", 1)[0]!.slice(0, 300);
  const dropped = plain.length - head.length - 1 - maxOutputChars;
  if (dropped <= 0) return plain;
  return `${head}\n[${dropped} earlier characters omitted]\n${plain.slice(-maxOutputChars)}`;
}

/** The tree of the worker's current files without private staging, as collection stages them. */
export async function workerFilesTree(worktree: string): Promise<string> {
  await pinnedGitMagicAsync(
    worktree,
    "add",
    "-A",
    "--",
    ".",
    ...privateStagingExclusions(worktree),
  );
  try {
    return pinnedGit(worktree, "write-tree");
  } finally {
    // Leave the worker's index as it was; collection stages its own result.
    await pinnedGitAsync(worktree, "reset", "--quiet");
  }
}

/**
 * Run the item's declared validation commands on a snapshot of the worktree.
 * The snapshot is a commit of the current files; the controller's validator
 * runs it in a fresh detached checkout with its own empty TMPDIR, so the
 * worker's files never change and neither its build output nor another
 * run's temporary files reach the commands. It restores the selected LFS
 * bytes controller validation restores, by digest from the controller's
 * staged copy. The worker names no command: only the declared ones run.
 * With `outputs`, files the commands produced under owned paths come back to
 * the worktree after the run settles (see returnProducedFiles).
 */
export async function runDeclaredValidation(
  worktree: string,
  commands: readonly string[],
  run: number,
  lfs?: HarnessRequest["validationLfs"],
  outputs?: ValidationOutputs,
): Promise<{
  passed: boolean;
  text: string;
  tree: string;
  ran: number;
  failed: number;
}> {
  const tree = await workerFilesTree(worktree);
  let ran = 0;
  let failed = 0;
  const commit = (
    await pinnedGitAsync(
      worktree,
      "-c",
      "user.name=Factory",
      "-c",
      `user.email=${FACTORY_EMAIL}`,
      "commit-tree",
      tree,
      "-p",
      "HEAD",
      "-m",
      "Factory worker validation snapshot",
    )
  ).trim();
  const root = join(workerValidationRoot(worktree), `${run}`);
  let produced = "";
  const inspectSettled =
    outputs &&
    ((copy: string) => {
      produced = returnProducedFiles(copy, worktree, outputs);
    });
  const withProduced = (text: string) =>
    produced ? `${text}\n\n${produced}` : text;
  try {
    const evidence = await validateTree(
      worktree,
      root,
      commit,
      tree,
      [...commands],
      (entry) => {
        ran += 1;
        if (!entry.passed) failed += 1;
      },
      undefined,
      lfs?.members ?? [],
      lfs && new LocalContentStore(lfs.store),
      undefined,
      false,
      undefined,
      undefined,
      inspectSettled,
    );
    return {
      passed: true,
      tree,
      ran,
      failed,
      text: withProduced(
        `All ${evidence.commands.length} declared validation commands passed:\n${commands.map((command) => `- ${command}`).join("\n")}`,
      ),
    };
  } catch (error) {
    if (error instanceof CandidateValidationFailure)
      return {
        passed: false,
        tree,
        ran,
        failed,
        text: withProduced(
          `Validation failed. Fix this before you finish.\n${bounded(error.message)}`,
        ),
      };
    throw error;
  } finally {
    if (!hasUnresolvedSubprocesses())
      await rm(root, { recursive: true, force: true });
  }
}

/**
 * Each criterion's exact text beside the note recorded for its index, so the
 * final self-review compares against the criterion, not a remembered paraphrase.
 * Criteria are never cut; long note summaries are, since the worker holds them.
 */
function criterionMap(
  acceptance: readonly string[],
  notes: readonly WorkHandoffNote[] = [],
): string {
  const summaries = new Map(
    notes
      .filter((note) => note.kind === "verification")
      .map((note) => [note.criterionIndex, note.summary]),
  );
  const missing = acceptance.flatMap((_, index) =>
    summaries.has(index) ? [] : [index],
  );
  const lines = acceptance.map((criterion, index) => {
    const summary = summaries.get(index);
    const note =
      summary === undefined
        ? "none recorded"
        : summary.length <= maxNoteExcerptChars
          ? summary
          : `${summary.slice(0, maxNoteExcerptChars)} [${summary.length - maxNoteExcerptChars} more characters]`;
    return `[${index}] ${criterion}\nnote [${index}]: ${note}`;
  });
  return `Check each acceptance criterion's exact text against the verification note recorded for its index. The reviewer checks every sub-clause of this text, not a paraphrase: a note that answers another criterion, merges criteria or omits a sub-clause leaves that criterion unproved. Add any missing proof, then fix the note.${missing.length ? ` No note yet for criteria ${missing.join(", ")}.` : ""}\n${lines.join("\n")}`;
}

/**
 * Decode .factory-handoff.json exactly as collection will, so the worker can
 * repair a manifest that would otherwise reject its whole result. `criteria`
 * maps each criterion to its note once the manifest decodes.
 */
export function checkWorkHandoff(
  worktree: string,
  handoff: HandoffContext,
): { passed: boolean; text?: string; criteria?: string } {
  const count = handoff.acceptance.length;
  try {
    const notes = readWorkHandoff(worktree, handoff.peers, count);
    if (!notes)
      return {
        passed: true,
        ...(count && {
          text: `No .factory-handoff.json yet. Before you finish, record one verification note for each of the ${count} acceptance criteria there, using the schema in your instructions.`,
          criteria: criterionMap(handoff.acceptance),
        }),
      };
    const verified = notes.filter(
      (note) => note.kind === "verification",
    ).length;
    return {
      passed: true,
      text: `.factory-handoff.json decodes: ${notes.length} notes, verification notes for ${verified} of ${count} acceptance criteria.`,
      ...(count && { criteria: criterionMap(handoff.acceptance, notes) }),
    };
  } catch (error) {
    return {
      passed: false,
      text: `.factory-handoff.json would be rejected at collection, and your whole result with it. ${error instanceof Error ? error.message : String(error)}\nRewrite it to match this exact schema, then run validation again: ${JSON.stringify(workHandoffSchema(handoff.peers.length, count))}`,
    };
  }
}

/** One adapter-owned server that runs only the item's declared validation. */
export async function createFactoryValidationMcp(
  input: ValidationEnvironmentInput,
) {
  if (!validationAuthorized(input) || !input.commands.length)
    throw new Error(
      "Factory validation MCP requires configured Validate authority and declared commands",
    );
  const [{ createSdkMcpServer, tool }] = await Promise.all([
    import("@anthropic-ai/claude-agent-sdk"),
  ]);
  let ready = false;
  let runs = 0;
  let passed = 0;
  const outputs: ValidationOutputs = {
    ownedPaths: input.ownedPaths,
    excluded: new Set(
      (input.lfs?.members ?? []).map((member) => member.destination),
    ),
    delivered: new Map(),
  };
  const passedTrees = new Set<string>();
  let queue: Promise<unknown> = Promise.resolve();
  const server = createSdkMcpServer({
    name: factoryValidationServerName,
    version: factoryValidationServerVersion,
    tools: [
      tool(
        "run_validation",
        "Run this work item's declared validation commands (the same ones Factory runs after you finish) on a snapshot of your current files, decode .factory-handoff.json as Factory will when it collects your result, and return the result. Files the commands produce under your owned paths that Git ignores (such as actual values a check writes) are copied back to your checkout at the same paths, and the result lists them. Takes several minutes. Run it after implementing and fix any failure it reports. Run it again after your last edit, including self-review and handoff fixes: finish only after a run passes on your final files.",
        {},
        async () => {
          const run = ++runs;
          const result = queue.then(async () => {
            if (!ready) throw new Error("Factory validation is not ready");
            const handoff = checkWorkHandoff(input.worktree, input.handoff);
            const declared = await runDeclaredValidation(
              input.worktree,
              input.commands,
              run,
              input.lfs,
              outputs,
            );
            return { declared, handoff };
          });
          queue = result.catch(() => undefined);
          try {
            const { declared, handoff } = await result;
            const parts = [declared.text];
            if (handoff.text)
              if (handoff.passed) parts.push(handoff.text);
              else parts.unshift(handoff.text);
            // Self-review follows a passing run; after the bounded output, so never cut.
            if (declared.passed && handoff.criteria)
              parts.push(handoff.criteria);
            if (declared.passed && !handoff.passed)
              parts.unshift("Validation failed. Fix this before you finish.");
            if (declared.passed) {
              // The handoff is outside the tree; evidence decodes its final bytes.
              passedTrees.add(declared.tree);
              if (handoff.passed) passed += 1;
            }
            try {
              input.onRun?.({
                run,
                passed: declared.passed && handoff.passed,
                tree: declared.tree,
                commands: input.commands.length,
                ran: declared.ran,
                failed: declared.failed,
                handoffPassed: handoff.passed,
              });
            } catch {
              // Telemetry only: a lost observation never changes the result.
            }
            return {
              content: [{ type: "text" as const, text: parts.join("\n\n") }],
            };
          } catch (error) {
            return {
              isError: true,
              content: [
                {
                  type: "text" as const,
                  text: `Factory validation unavailable: ${error instanceof Error ? error.message : String(error)}`,
                },
              ],
            };
          }
        },
        {
          alwaysLoad: true,
          annotations: {
            // It writes only ignored produced files, never the result tree.
            readOnlyHint: false,
            destructiveHint: false,
            openWorldHint: false,
          },
        },
      ),
    ],
  });
  let closing: Promise<void> | undefined;
  return {
    server,
    close: async () => {
      ready = false;
      closing ??= server.instance.close();
      await closing;
      await queue;
    },
    isReady: () => ready,
    markReady: (status: McpServerStatus) => {
      ready = false;
      assertFactoryValidationReady(status);
      ready = true;
    },
    /** After the turn: did a passing run cover the files the worker returns, with a handoff collection accepts? */
    evidence: async () => {
      let finalTreeValidated: boolean | undefined = false;
      if (passedTrees.size)
        try {
          finalTreeValidated =
            passedTrees.has(await workerFilesTree(input.worktree)) &&
            checkWorkHandoff(input.worktree, input.handoff).passed;
        } catch {
          // Collection classifies an unstageable worktree itself.
          finalTreeValidated = undefined;
        }
      return {
        kind: "factory-validation" as const,
        version: 1 as const,
        runs,
        passed,
        ...(finalTreeValidated !== undefined && { finalTreeValidated }),
      };
    },
  };
}

export type PreparedClaudeValidation = Awaited<
  ReturnType<typeof createFactoryValidationMcp>
>;
