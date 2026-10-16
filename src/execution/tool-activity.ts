import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Metadata about one worker tool call, safe to record with capture disabled:
 * the tool's name and, at most, the repository-relative file it targets or a
 * shell command's program name. Never arguments, file contents or output.
 */
export interface ToolActivity {
  tool: string;
  target?: string;
}

const TOOL_NAME = /^[A-Za-z0-9_.:/-]{1,128}$/;
const PROGRAM = /^[A-Za-z0-9._+-]{1,64}$/;
const FILE_FIELDS = ["file_path", "notebook_path", "path"] as const;

/** A shell command's program name (its first word, without a directory), if plain. */
export function shellProgram(command: unknown): string | undefined {
  if (typeof command !== "string") return undefined;
  const first = command.trim().split(/\s+/, 1)[0] ?? "";
  const program = first.split("/").pop() ?? "";
  return PROGRAM.test(program) ? program : undefined;
}

/**
 * The path relative to the worktree when it names something inside it, never
 * Git metadata or Factory's private staging; anything else is dropped.
 */
export function worktreePath(
  worktree: string,
  path: unknown,
): string | undefined {
  if (typeof path !== "string" || !path || path.length > 4096) return undefined;
  const root = resolve(worktree);
  const relativePath = relative(
    root,
    isAbsolute(path) ? path : resolve(root, path),
  );
  if (
    !relativePath ||
    relativePath.startsWith("..") ||
    isAbsolute(relativePath)
  )
    return undefined;
  const parts = relativePath.split(sep);
  if (parts.some((part) => part === ".git" || part.startsWith(".factory-")))
    return undefined;
  const portable = parts.join("/");
  return portable.length <= 300 ? portable : undefined;
}

/** One tool call's safe metadata, or undefined for an unrecognizable call. */
export function toolActivity(
  name: unknown,
  input: unknown,
  worktree: string,
): ToolActivity | undefined {
  if (typeof name !== "string" || !TOOL_NAME.test(name)) return undefined;
  const fields =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  if (name === "Bash") {
    const program = shellProgram(fields.command);
    return { tool: name, ...(program && { target: program }) };
  }
  for (const field of FILE_FIELDS) {
    const target = worktreePath(worktree, fields[field]);
    if (target) return { tool: name, target };
  }
  return { tool: name };
}
