import { isDeepStrictEqual } from "node:util";
import { markdownLines } from "./markdown.js";
import { pinnedGit, pinnedGitRaw } from "./process.js";

/** A version update, never a manager switch, range, URL or prerelease. */
function exactPin(value: unknown): RegExpMatchArray | null {
  return typeof value === "string"
    ? value.match(/^(npm|pnpm)@(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
    : null;
}

/** Authority comes only from this structured section of the pinned Objective. */
export function packageManagerUpdate(body: string): string | undefined {
  const lines = markdownLines(body);
  const matches = lines.flatMap((line, index) =>
    line.heading?.text.toLowerCase() === "package manager update"
      ? [index]
      : [],
  );
  if (!matches.length) return undefined;
  const start = matches[0]!;
  const level = lines[start]!.heading!.level;
  if (matches.length !== 1 || ![2, 3].includes(level))
    throw new Error(
      "Use one level-two or level-three Package manager update section",
    );
  const entries = [];
  for (const line of lines.slice(start + 1)) {
    if (line.heading && line.heading.level <= level) break;
    if (line.text.trim()) entries.push(line);
  }
  if (
    entries.length === 1 &&
    !entries[0]!.fenced &&
    entries[0]!.text.trim() === "_No response_"
  )
    return undefined;
  const pin =
    entries.length === 1 && !entries[0]!.fenced
      ? entries[0]!.text.match(/^\s*-\s+`([^`]+)`\s*$/)?.[1]
      : undefined;
  if (!exactPin(pin))
    throw new Error(
      "Package manager update requires exactly one backticked stable npm@X.Y.Z or pnpm@X.Y.Z pin",
    );
  return pin;
}

export function packageMetadata(
  checkout: string,
  baseSha: string,
): Record<string, unknown> | undefined {
  const path = "package.json";
  const entry = pinnedGit(checkout, "ls-tree", baseSha, "--", path);
  if (!entry) return undefined;
  if (!/^100(?:644|755) blob /.test(entry))
    throw new Error(
      "Package script validation blocked: package.json is not a regular file",
    );
  try {
    const value: unknown = JSON.parse(
      pinnedGitRaw(checkout, "show", `${baseSha}:${path}`).toString("utf8"),
    );
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid package");
    return value as Record<string, unknown>;
  } catch {
    throw new Error(
      "Package script validation blocked: package.json is invalid",
    );
  }
}

/** Validate the authority even when the current phase still uses the base pin. */
export function assertPackageManagerUpdate(
  before: unknown,
  after: unknown,
  update?: string,
  requireUpdate = false,
): void {
  if (update !== undefined) {
    const target = exactPin(update);
    const baseline = exactPin(before);
    if (!target || !baseline || baseline[1] !== target[1])
      throw new Error(
        "Package manager update requires an existing exact stable pin of the same manager at the accepted base",
      );
    if (after === update) return;
    if (requireUpdate)
      throw new Error(
        `Package manager update was not delivered: expected ${update}`,
      );
  }
  if (!isDeepStrictEqual(before, after))
    throw new Error(
      "Package script validation blocked: packageManager differs from the accepted base without the declared exact update",
    );
}

/** Planning and host readiness validate the same immutable baseline. */
export function plannedPackageManager(
  body: string,
  checkout: string,
  baseSha: string,
): unknown {
  const update = packageManagerUpdate(body);
  let baseline: unknown;
  try {
    baseline = packageMetadata(checkout, baseSha)?.packageManager;
  } catch (error) {
    if (update !== undefined) throw error;
  }
  assertPackageManagerUpdate(baseline, baseline, update);
  return update ?? baseline;
}

export function packageManagerInstructions(update?: string): string {
  return `Root package-manager metadata (fixed): preserve package.json config and pnpm settings, .npmrc, workspace security settings, package.yaml and package-manager hook files. ${
    update
      ? `The pinned Objective's Package manager update section permits only package.json packageManager ${update}; no manager switch or other configuration change is authorized. Keep the base pin until this update is implemented, then preserve the declared pin in successors.`
      : "Preserve package.json packageManager; no exact Package manager update is authorized."
  }`;
}
