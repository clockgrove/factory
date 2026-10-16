import { rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { McpServerStatus } from "@anthropic-ai/claude-agent-sdk";
import { validateToolConfigName } from "../config.js";
import {
  hasUnresolvedSubprocesses,
  pinnedGit,
  pinnedGitAsync,
  pinnedGitMagicAsync,
} from "../process.js";
import { validateTree } from "../validation.js";
import { CandidateValidationFailure } from "../work-repair.js";
import { FACTORY_EMAIL, privateStagingExclusions } from "./local.js";

export const factoryValidationServerName = "factory-validation";
export const factoryValidationServerVersion = "1.0.0";
export const factoryValidationToolName =
  "mcp__factory-validation__run_validation";

/** Keep the tail: failures report last. */
const maxOutputChars = 24_000;

interface ValidationEnvironmentInput {
  worktree: string;
  commands: readonly string[];
  config: { tools: readonly string[]; allowedTools: readonly string[] };
}

export function validationAuthorized(input: {
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

export function assertFactoryValidationReady(status: McpServerStatus): void {
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

function bounded(text: string): string {
  return text.length <= maxOutputChars
    ? text
    : `[earlier output omitted]\n${text.slice(-maxOutputChars)}`;
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
 * runs it in a fresh detached checkout, so the worker's files never change.
 * The worker names no command: only the declared ones run.
 */
export async function runDeclaredValidation(
  worktree: string,
  commands: readonly string[],
  run: number,
): Promise<{ passed: boolean; text: string; tree: string }> {
  const tree = await workerFilesTree(worktree);
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
  const root = join(
    dirname(worktree),
    `${basename(worktree)}.validation`,
    `${run}`,
  );
  try {
    const evidence = await validateTree(
      worktree,
      root,
      commit,
      tree,
      [...commands],
      undefined,
      undefined,
      [],
      undefined,
      undefined,
      false,
    );
    return {
      passed: true,
      tree,
      text: `All ${evidence.commands.length} declared validation commands passed:\n${commands.map((command) => `- ${command}`).join("\n")}`,
    };
  } catch (error) {
    if (error instanceof CandidateValidationFailure)
      return {
        passed: false,
        tree,
        text: `Validation failed. Fix this before you finish.\n${bounded(error.message)}`,
      };
    throw error;
  } finally {
    if (!hasUnresolvedSubprocesses())
      await rm(root, { recursive: true, force: true });
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
  const passedTrees = new Set<string>();
  let queue: Promise<unknown> = Promise.resolve();
  const server = createSdkMcpServer({
    name: factoryValidationServerName,
    version: factoryValidationServerVersion,
    tools: [
      tool(
        "run_validation",
        "Run this work item's declared validation commands (the same ones Factory runs after you finish) on a snapshot of your current files, and return the result. Takes several minutes. Run it after implementing and fix any failure it reports. Run it again after your last edit, including self-review fixes: finish only after a run passes on your final files.",
        {},
        async () => {
          const run = ++runs;
          const result = queue.then(async () => {
            if (!ready) throw new Error("Factory validation is not ready");
            return runDeclaredValidation(input.worktree, input.commands, run);
          });
          queue = result.catch(() => undefined);
          try {
            const { passed: ok, text, tree } = await result;
            if (ok) {
              passed += 1;
              passedTrees.add(tree);
            }
            return { content: [{ type: "text" as const, text }] };
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
            readOnlyHint: true,
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
    /** After the turn: did a passing run cover the files the worker returns? */
    evidence: async () => {
      let finalTreeValidated: boolean | undefined = false;
      if (passedTrees.size)
        try {
          finalTreeValidated = passedTrees.has(
            await workerFilesTree(input.worktree),
          );
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
