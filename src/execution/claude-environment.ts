import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { resolve, sep } from "node:path";
import type { McpServerStatus } from "@anthropic-ai/claude-agent-sdk";
import { pathInsideRoot } from "./harness-support.js";

export const factoryMcpServerName = "factory-worktree";
export const factoryMcpServerVersion = "1.0.0";
export const factoryMcpToolName = "mcp__factory-worktree__read_file";

interface ReadEnvironmentInput {
  worktree: string;
  config: { tools: readonly string[]; allowedTools: readonly string[] };
}

function readAuthorized(input: ReadEnvironmentInput): boolean {
  return (
    input.config.tools.includes("Read") &&
    input.config.allowedTools.includes("Read")
  );
}

/** Both SDK permission callbacks use the same exact provenance check. */
export function factoryMcpToolAllowed(
  input: ReadEnvironmentInput,
  toolName: string,
  toolInput: unknown,
  provenance: unknown,
): boolean {
  if (
    !readAuthorized(input) ||
    toolName !== factoryMcpToolName ||
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
    source.name === factoryMcpServerName &&
    source.source === "sdk" &&
    Object.keys(args).length === 1 &&
    typeof args.path === "string" &&
    pathInsideRoot(args.path, input.worktree)
  );
}

/** Fail closed before accepting model output from an unexpected inventory. */
export function assertFactoryMcpReady(statuses: McpServerStatus[]): void {
  const status = statuses[0];
  if (
    statuses.length !== 1 ||
    !status ||
    status.name !== factoryMcpServerName ||
    status.source !== "sdk" ||
    status.status !== "connected" ||
    status.serverInfo?.name !== factoryMcpServerName ||
    status.serverInfo.version !== factoryMcpServerVersion ||
    status.tools?.length !== 1 ||
    status.tools[0]?.name !== "read_file"
  )
    throw new Error("Factory worktree MCP readiness verification failed");
}

/** One adapter-owned, read-only server. No commands, credentials or network. */
export async function createFactoryWorktreeMcp(input: ReadEnvironmentInput) {
  if (!readAuthorized(input))
    throw new Error("Factory worktree MCP requires configured Read authority");
  const root = realpathSync(input.worktree);
  const [{ createSdkMcpServer, tool }, { z }] = await Promise.all([
    import("@anthropic-ai/claude-agent-sdk"),
    import("zod"),
  ]);
  let successfulReads = 0;
  let ready = false;
  const server = createSdkMcpServer({
    name: factoryMcpServerName,
    version: factoryMcpServerVersion,
    tools: [
      tool(
        "read_file",
        "Read a regular file inside this Factory worker's worktree",
        { path: z.string().min(1) },
        async ({ path }) => {
          let descriptor: number | undefined;
          try {
            if (
              !ready ||
              !readAuthorized(input) ||
              realpathSync(input.worktree) !== root ||
              !pathInsideRoot(path, input.worktree)
            )
              throw new Error("denied");
            descriptor = openSync(
              resolve(input.worktree, path),
              constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
            );
            if (!fstatSync(descriptor).isFile()) throw new Error("denied");
            // Inspect the opened object, not merely the name checked before
            // open: a swapped parent symlink must never disclose outside bytes.
            const openedPath = realpathSync(`/proc/self/fd/${descriptor}`);
            if (!openedPath.startsWith(`${root}${sep}`))
              throw new Error("denied");
            const text = readFileSync(descriptor, "utf8");
            successfulReads += 1;
            return { content: [{ type: "text" as const, text }] };
          } catch {
            return {
              isError: true,
              content: [
                {
                  type: "text" as const,
                  text: "Factory worktree read denied or unavailable",
                },
              ],
            };
          } finally {
            if (descriptor !== undefined) closeSync(descriptor);
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
    close: () => {
      ready = false;
      closing ??= server.instance.close();
      return closing;
    },
    isReady: () => ready,
    markReady: (statuses: McpServerStatus[]) => {
      ready = false;
      assertFactoryMcpReady(statuses);
      ready = true;
    },
    evidence: () => ({
      kind: "factory-worktree-read" as const,
      version: 1 as const,
      successfulReads,
    }),
  };
}

export type PreparedClaudeEnvironment = Awaited<
  ReturnType<typeof createFactoryWorktreeMcp>
>;
