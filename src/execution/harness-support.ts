import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  constants,
  closeSync,
  existsSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type {
  AuthenticationRequest,
  HarnessRequest,
  ProducedAssetSet,
} from "../contracts.js";
import { parseProducedAssetSets } from "../media.js";

export function privateProgress(path: string, event: unknown): void {
  const fd = openSync(
    path,
    constants.O_WRONLY |
      constants.O_APPEND |
      constants.O_CREAT |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    if (!fstatSync(fd).isFile() || (fstatSync(fd).mode & 0o077) !== 0)
      throw new Error("Worker progress file is not a restricted regular file");
    appendFileSync(fd, `${JSON.stringify(event)}\n`);
  } finally {
    closeSync(fd);
  }
}

export function redact(value: string, secrets: string[]): string {
  let result = value.replace(
    /\b(?:gh[pousr]_|github_pat_|sk-ant-|sk-)[A-Za-z0-9_-]{8,}\b/g,
    "[REDACTED]",
  );
  for (const secret of secrets)
    if (secret.length) result = result.split(secret).join("[REDACTED]");
  return result;
}

export function authenticationFailure(
  provider: "codex" | "claude" | "github-copilot",
  error: unknown,
):
  | {
      state: "failed";
      error: string;
      authentication: { provider: string; command: string };
    }
  | undefined {
  const detail = error instanceof Error ? error.message : String(error);
  if (
    !/(?:no authentication|not authenticated|not logged in|not signed in|login required|sign in required|authentication required|please (?:run )?(?:\/login|login)|authentication(?:_| )failed|unauthenticated|unauthorized|invalid authentication|oauth.*(?:expired|invalid)|\b401\b)/i.test(
      detail,
    )
  )
    return undefined;
  const commands = {
    codex: "codex login",
    claude: "claude auth login",
    "github-copilot": "copilot",
  } as const;
  const command = commands[provider];
  return {
    state: "failed",
    error: `Authentication required for ${provider}; run \`${command}\` in the developer environment, then retry the Work Item`,
    authentication: { provider, command },
  };
}

export function parseAuthenticationRequest(
  value: unknown,
): AuthenticationRequest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const request = value as Record<string, unknown>;
  return typeof request.provider === "string" &&
    request.provider.length > 0 &&
    typeof request.command === "string" &&
    request.command.length > 0
    ? { provider: request.provider, command: request.command }
    : undefined;
}

export function harnessFailure(
  provider: "codex" | "claude" | "github-copilot",
  error: unknown,
  secrets: string[],
): {
  state: "failed";
  error: string;
  authentication?: { provider: string; command: string };
} {
  const failure = authenticationFailure(provider, error) ?? {
    state: "failed" as const,
    error: error instanceof Error ? error.message : String(error),
  };
  return { ...failure, error: redact(failure.error, secrets) };
}

function inside(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

/**
 * Follow a path one component at a time so symlink/.. cannot escape and a
 * dangling final symlink cannot be mistaken for a safe new file.
 */
export function pathInsideRoot(path: string, root: string): boolean {
  try {
    if (!path || path.includes("\0")) return false;
    const lexicalRoot = resolve(root);
    const realRoot = realpathSync(root);
    let remainder = path;
    if (isAbsolute(path)) {
      const prefix = [lexicalRoot, realRoot]
        .filter((candidate) => inside(candidate, path))
        .sort((left, right) => right.length - left.length)[0];
      if (!prefix) return false;
      remainder = path.slice(prefix.length);
    }
    let current = realRoot;
    for (const component of remainder.split(sep)) {
      if (!component || component === ".") continue;
      if (component === "..") {
        current = dirname(current);
      } else {
        const next = join(current, component);
        const entry = lstatSync(next, { throwIfNoEntry: false });
        if (entry?.isSymbolicLink()) {
          // realpathSync intentionally rejects dangling symlinks, including a
          // final Write destination that would otherwise redirect later.
          current = realpathSync(next);
        } else {
          current = next;
        }
      }
      if (!inside(realRoot, current)) return false;
    }
    return inside(realRoot, current);
  } catch {
    return false;
  }
}

export function writeHarnessResult(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

export function workItemPrompt(request: HarnessRequest): string {
  const validationInstructions = request.item.validation.length
    ? `\n\nController-run validation constraints (authoritative): Factory, not the worker, executes these exact commands after your turn. Do not run them merely because they are listed here. Preserve the literal meaning of each command together with its provenance and source:\n${request.item.validation
        .map((check) => JSON.stringify(check))
        .join("\n")}`
    : "";
  const mediaInstructions = request.item.expectedOutputRoles?.length
    ? `\n\nProduce at least ${request.item.minimumAssetSets ?? 1} complete candidate AssetSets. Candidate content and any required variation must follow the accepted brief and source requirements; preserve source bytes exactly when byte identity is required. Put candidate bytes under .factory-media/ and write .factory-assets.json at the checkout root. Use this format-neutral manifest shape, replacing every angle-bracket placeholder with the actual declared role, file, media type, and owned destination: {"sets":[{"id":"candidate-a","members":[{"role":"<expected role>","path":".factory-media/candidate-a/<file>","mediaType":"<declared media type>","destination":"<owned target path>"}],"provenance":{"source":"<source path or generated>","rights":"<basis for repository use>","visibility":"repository","lineage":["<source path or input identity>"]}}]}. Include every expected role in each set. You may add member formatMetadata with a named source and uninterpreted values when an authoritative tool supplies it, set-level relationships with from, toRole, and kind when outputs are related, and production evidence with model, tool, request, or parameters when those values are actually supplied. Do not invent metadata or tool identities. .factory-media/ and .factory-assets.json are the only staging exceptions to owned paths. Do not write, remove, or otherwise change final destinations directly. Candidate files and the manifest are staging outputs; do not commit them. The controller owns capture, whole-set selection, final destination materialization (including an authorized byte-identical same-path LFS replacement), publication, and Objective lifecycle. Do not run Factory CLI operations or inspect controller installation, configuration, status, or logs. These staging instructions do not remove explicitly owned ordinary code work. Stop after completing the authorized owned code changes, candidate files, and manifest, and report the staged candidates; do not wait for or perform selection or delivery. If the accepted brief requires a controller operation, report the conflict rather than performing it.\nSource bindings: ${JSON.stringify(request.sourceAssets ?? [])}\nExpected output roles: ${request.item.expectedOutputRoles.join(", ")}`
    : "";
  const inputInstructions =
    request.selectedAssets?.length ||
    request.sourceAssets?.some((source) => source.path)
      ? `\n\nAuthorized read-only asset inputs (files are removed before delivery; do not edit or commit them): ${JSON.stringify(
          {
            selected: request.selectedAssets ?? [],
            privateSources:
              request.sourceAssets?.filter((source) => source.path) ?? [],
          },
        )}`
      : "";
  return `Implement this Work Item in the current repository checkout. Change only the owned paths. Do not commit, push, create issues, create pull requests, or access GitHub credentials. Stop and report if acceptance is impossible.\n\nTitle: ${request.item.title}\nGoal: ${request.item.goal}\nAcceptance:\n${request.item.acceptance.join("\n")}\nNon-goals:\n${request.item.nonGoals.join("\n")}\nOwned paths:\n${request.item.ownedPaths.join("\n")}\nBrief:\n${request.item.brief}${validationInstructions}${mediaInstructions}${inputInstructions}`;
}

export function readProducedAssets(
  request: HarnessRequest,
): ProducedAssetSet[] | undefined {
  const manifest = join(request.worktree, ".factory-assets.json");
  if (
    existsSync(manifest) &&
    (!lstatSync(manifest).isFile() ||
      realpathSync(manifest) !== resolve(manifest))
  )
    throw new Error("AssetSet manifest is not a regular staging file");
  const manifestValue: unknown = existsSync(manifest)
    ? JSON.parse(readFileSync(manifest, "utf8"))
    : undefined;
  if (
    manifestValue !== undefined &&
    (!manifestValue ||
      typeof manifestValue !== "object" ||
      Array.isArray(manifestValue))
  )
    throw new Error("AssetSet manifest must be an object with sets");
  const parsedAssets =
    manifestValue === undefined
      ? undefined
      : parseProducedAssetSets((manifestValue as Record<string, unknown>).sets);
  if (
    request.item.expectedOutputRoles?.length &&
    (!parsedAssets ||
      parsedAssets.length < (request.item.minimumAssetSets ?? 1))
  )
    throw new Error(
      "Media Work Item did not declare the requested complete AssetSets",
    );
  return parsedAssets;
}
