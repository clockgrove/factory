import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { McpServerStatus } from "@anthropic-ai/claude-agent-sdk";
import { ownsPath } from "../ownership.js";
import { privateStagingPath } from "./local.js";

export const factoryFilesServerName = "factory-files";
const factoryFilesServerVersion = "1.1.0";
export const factoryFilesToolName = "mcp__factory-files__delete_file";
export const factoryCopyToolName = "mcp__factory-files__copy_file";
/** Both owned-file tools this server serves. */
export const factoryFilesToolNames: readonly string[] = [
  factoryFilesToolName,
  factoryCopyToolName,
];
/** The largest file copy_file copies: well above a check's actual values. */
export const maxCopiedFileBytes = 16 * 1024 * 1024;

interface FilesEnvironmentInput {
  worktree: string;
  ownedPaths: readonly string[];
  config: { tools: readonly string[]; allowedTools: readonly string[] };
}

/**
 * Deleting an owned file, or copying bytes the worktree already holds to an
 * owned file, is a write: Write authority grants both.
 */
export function factoryFilesAuthorized(input: {
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
    !factoryFilesAuthorized(input) ||
    !factoryFilesToolNames.includes(toolName) ||
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
  const keys = Object.keys(args).sort().join(",");
  return (
    source.name === factoryFilesServerName &&
    source.source === "sdk" &&
    (toolName === factoryFilesToolName
      ? keys === "path" && typeof args.path === "string"
      : keys === "from,to" &&
        typeof args.from === "string" &&
        typeof args.to === "string")
  );
}

function assertFactoryFilesReady(status: McpServerStatus): void {
  if (
    status.name !== factoryFilesServerName ||
    status.source !== "sdk" ||
    status.status !== "connected" ||
    status.serverInfo?.name !== factoryFilesServerName ||
    status.serverInfo.version !== factoryFilesServerVersion ||
    status.tools
      ?.map((tool) => tool.name)
      .sort()
      .join(",") !== "copy_file,delete_file"
  )
    throw new Error("Factory files MCP readiness verification failed");
}

/**
 * The normalized Git-relative form of a worker-supplied path inside the
 * worktree that this Work Item owns, never Git metadata or Factory staging.
 */
function ownedRelative(
  worktree: string,
  root: string,
  ownedPaths: readonly string[],
  path: string,
): string {
  if (!path || path.includes("\0") || path.includes("\\"))
    throw new Error("path must name one file in the worktree");
  let relative = path;
  if (isAbsolute(path)) {
    const prefix = [resolve(worktree), root].find((candidate) =>
      path.startsWith(`${candidate}${sep}`),
    );
    if (!prefix) throw new Error(`${path} is outside the worktree`);
    relative = path.slice(prefix.length + 1);
  }
  const parts = relative.split("/");
  if (parts.some((part) => !part || part === "." || part === ".."))
    throw new Error(`${path} must be a normalized path inside the worktree`);
  if (parts.includes(".git") || privateStagingPath(relative))
    throw new Error(`${relative} is Git metadata or Factory staging`);
  if (!ownsPath(relative, [...ownedPaths]))
    throw new Error(`${relative} is not owned by this Work Item`);
  return relative;
}

/**
 * The Git-relative path of an owned file the worker may delete. Every parent
 * must be a real directory under the worktree, so no symlink redirects the
 * unlink; the final entry is a file or a link, and unlink never follows it.
 */
function ownedDeletionTarget(
  worktree: string,
  ownedPaths: readonly string[],
  path: string,
): { root: string; relative: string } {
  const root = realpathSync(worktree);
  const relative = ownedRelative(worktree, root, ownedPaths, path);
  const parts = relative.split("/");
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

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Walk a path's parents from the worktree root: each must be a real
 * directory, never a link. With `create`, missing parents become plain
 * directories. The resolved parent must stay inside the worktree.
 */
function realParents(root: string, relative: string, create: boolean): void {
  let current = root;
  for (const part of relative.split("/").slice(0, -1)) {
    current = join(current, part);
    const entry = lstatSync(current, { throwIfNoEntry: false });
    if (!entry) {
      if (!create) throw new Error(`${relative} does not exist`);
      mkdirSync(current);
    } else if (!entry.isDirectory())
      throw new Error(`${relative} is not reached through real directories`);
  }
  if (!inside(root, realpathSync(dirname(join(root, relative)))))
    throw new Error(`${relative} leaves the worktree`);
}

/**
 * Copy the exact bytes of one owned regular file to an owned destination in
 * the same worktree, so the worker can commit a file a check produced without
 * passing its bytes through the model. The source may be ignored or tracked.
 * Neither side is followed through a link, both must be regular files, and
 * the destination is created or replaced in place. Returns the destination's
 * Git-relative path, the bytes copied and their SHA-256.
 */
export function copyOwnedFile(
  worktree: string,
  ownedPaths: readonly string[],
  from: string,
  to: string,
): { from: string; to: string; bytes: number; sha256: string } {
  const root = realpathSync(worktree);
  const source = ownedRelative(worktree, root, ownedPaths, from);
  const destination = ownedRelative(worktree, root, ownedPaths, to);
  if (source === destination) throw new Error("from and to name the same file");
  realParents(root, source, false);
  let content: Buffer;
  let fd: number;
  try {
    // Never through a link; never blocks on a special file.
    fd = openSync(
      join(root, source),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new Error(
      code === "ENOENT"
        ? `${source} does not exist`
        : `${source} is not a regular file`,
    );
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${source} is not a regular file`);
    if (stat.size > maxCopiedFileBytes)
      throw new Error(
        `${source} has ${stat.size} bytes, over the ${maxCopiedFileBytes / (1024 * 1024)} MiB copy bound`,
      );
    content = readFileSync(fd);
  } finally {
    closeSync(fd);
  }
  if (content.length > maxCopiedFileBytes)
    throw new Error(
      `${source} grew past the ${maxCopiedFileBytes / (1024 * 1024)} MiB copy bound while it was read`,
    );
  realParents(root, destination, true);
  const target = join(root, destination);
  try {
    // Never through a link; never blocks on a special file. Truncate only
    // after the open entry proves to be a regular file with no other name,
    // so the write cannot reach a file outside the worktree.
    fd = openSync(
      target,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
    );
  } catch {
    throw new Error(`${destination} exists and is not a regular file`);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile())
      throw new Error(`${destination} exists and is not a regular file`);
    if (stat.nlink !== 1)
      throw new Error(`${destination} is a hard link to another file`);
    ftruncateSync(fd, 0);
    writeFileSync(fd, content);
  } finally {
    closeSync(fd);
  }
  return {
    from: source,
    to: destination,
    bytes: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

/**
 * One adapter-owned server whose only effects are deleting one owned file and
 * copying one owned file's bytes to another owned path.
 */
export async function createFactoryFilesMcp(input: FilesEnvironmentInput) {
  if (!factoryFilesAuthorized(input))
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
      tool(
        "copy_file",
        `Copy the exact bytes of one file to another path, both in the worktree and owned by this Work Item. Use it to commit a file a check produced, such as an actual golden that Validate returned, instead of retyping it; there is no shell. The destination is created or replaced. Returns the bytes copied and the copy's SHA-256. Links, non-regular files, unowned paths, Git metadata, Factory staging files and files over ${maxCopiedFileBytes / (1024 * 1024)} MiB are refused.`,
        { from: z.string().min(1), to: z.string().min(1) },
        async ({ from, to }) => {
          try {
            if (!ready || realpathSync(input.worktree) !== root)
              throw new Error("Factory file copying is not ready");
            const copied = copyOwnedFile(
              input.worktree,
              input.ownedPaths,
              from,
              to,
            );
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Copied ${copied.from} to ${copied.to}: ${copied.bytes} bytes, sha256 ${copied.sha256}`,
                },
              ],
            };
          } catch (error) {
            return {
              isError: true,
              content: [
                {
                  type: "text" as const,
                  text: `File not copied: ${error instanceof Error ? error.message : String(error)}`,
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
            idempotentHint: true,
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
