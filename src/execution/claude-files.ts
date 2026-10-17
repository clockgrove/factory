import { lstatSync, realpathSync, unlinkSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { McpServerStatus } from "@anthropic-ai/claude-agent-sdk";
import { ownsPath } from "../ownership.js";
import { privateStagingPath } from "./local.js";

export const factoryFilesServerName = "factory-files";
export const factoryFilesServerVersion = "1.0.0";
export const factoryFilesToolName = "mcp__factory-files__delete_file";

interface FilesEnvironmentInput {
  worktree: string;
  ownedPaths: readonly string[];
  config: { tools: readonly string[]; allowedTools: readonly string[] };
}

/** Deleting an owned file is a write: Write authority grants it. */
export function deletionAuthorized(input: {
  config: { tools: readonly string[]; allowedTools: readonly string[] };
}): boolean {
  return (
    input.config.tools.includes("Write") &&
    input.config.allowedTools.includes("Write")
  );
}

/** Both SDK permission callbacks use the same exact provenance check. */
export function factoryFilesToolAllowed(
  input: {
    config: { tools: readonly string[]; allowedTools: readonly string[] };
  },
  toolName: string,
  toolInput: unknown,
  provenance: unknown,
): boolean {
  if (
    !deletionAuthorized(input) ||
    toolName !== factoryFilesToolName ||
    !provenance ||
    typeof provenance !== "object" ||
    Array.isArray(provenance) ||
    !toolInput ||
    typeof toolInput !== "object" ||
    Array.isArray(toolInput)
  )
    return false;
  const source = provenance as Record<string, unknown>;
  const args = toolInput as Record<string, unknown>;
  return (
    source.name === factoryFilesServerName &&
    source.source === "sdk" &&
    Object.keys(args).length === 1 &&
    typeof args.path === "string"
  );
}

export function assertFactoryFilesReady(status: McpServerStatus): void {
  if (
    status.name !== factoryFilesServerName ||
    status.source !== "sdk" ||
    status.status !== "connected" ||
    status.serverInfo?.name !== factoryFilesServerName ||
    status.serverInfo.version !== factoryFilesServerVersion ||
    status.tools?.length !== 1 ||
    status.tools[0]?.name !== "delete_file"
  )
    throw new Error("Factory files MCP readiness verification failed");
}

/**
 * The Git-relative path of an owned file the worker may delete. Every parent
 * must be a real directory under the worktree, so no symlink redirects the
 * unlink; the final entry is a file or a link, and unlink never follows it.
 */
export function ownedDeletionTarget(
  worktree: string,
  ownedPaths: readonly string[],
  path: string,
): { root: string; relative: string } {
  const root = realpathSync(worktree);
  if (!path || path.includes("\0") || path.includes("\\"))
    throw new Error("path must name one file in the worktree");
  let relative = path;
  if (isAbsolute(path)) {
    const prefix = [resolve(worktree), root].find((candidate) =>
      path.startsWith(`${candidate}${sep}`),
    );
    if (!prefix) throw new Error("path is outside the worktree");
    relative = path.slice(prefix.length + 1);
  }
  const parts = relative.split("/");
  if (parts.some((part) => !part || part === "." || part === ".."))
    throw new Error("path must be a normalized path inside the worktree");
  if (parts.includes(".git") || privateStagingPath(relative))
    throw new Error(`${relative} is Git metadata or Factory staging`);
  if (!ownsPath(relative, [...ownedPaths]))
    throw new Error(`${relative} is not owned by this Work Item`);
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const entry = lstatSync(current, { throwIfNoEntry: false });
    if (!entry) throw new Error(`${relative} does not exist`);
    if (index < parts.length - 1 ? !entry.isDirectory() : entry.isDirectory())
      throw new Error(
        `${relative} is not a file reached through real directories`,
      );
  }
  return { root, relative };
}

/** One adapter-owned server whose only effect is deleting one owned file. */
export async function createFactoryFilesMcp(input: FilesEnvironmentInput) {
  if (!deletionAuthorized(input))
    throw new Error("Factory files MCP requires configured Write authority");
  const root = realpathSync(input.worktree);
  const [{ createSdkMcpServer, tool }, { z }] = await Promise.all([
    import("@anthropic-ai/claude-agent-sdk"),
    import("zod"),
  ]);
  let ready = false;
  const server = createSdkMcpServer({
    name: factoryFilesServerName,
    version: factoryFilesServerVersion,
    tools: [
      tool(
        "delete_file",
        "Delete one file this Work Item owns, by its path in the worktree. Use it when the work removes a file; there is no shell. Factory collects the deletion with your other changes. Directories, unowned paths, Git metadata and Factory staging files are refused.",
        { path: z.string().min(1) },
        async ({ path }) => {
          try {
            if (!ready || realpathSync(input.worktree) !== root)
              throw new Error("Factory file deletion is not ready");
            const target = ownedDeletionTarget(
              input.worktree,
              input.ownedPaths,
              path,
            );
            unlinkSync(join(target.root, target.relative));
            return {
              content: [
                { type: "text" as const, text: `Deleted ${target.relative}` },
              ],
            };
          } catch (error) {
            return {
              isError: true,
              content: [
                {
                  type: "text" as const,
                  text: `File not deleted: ${error instanceof Error ? error.message : String(error)}`,
                },
              ],
            };
          }
        },
        {
          alwaysLoad: true,
          annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: false,
          },
        },
      ),
    ],
  });
  let closing: Promise<void> | undefined;
  return {
    server,
    close: () => {
      ready = false;
      closing ??= server.instance.close();
      return closing;
    },
    isReady: () => ready,
    markReady: (status: McpServerStatus) => {
      ready = false;
      assertFactoryFilesReady(status);
      ready = true;
    },
  };
}

export type PreparedClaudeFiles = Awaited<
  ReturnType<typeof createFactoryFilesMcp>
>;
