import { parse } from "yaml";
import type { WorkGraph } from "./contracts.js";
import { pinnedGit, pinnedGitRaw } from "./process.js";

const WORKFLOWS = ".github/workflows";
const MAX_MATRIX_NAMES = 256;
const PULL_REQUEST_EVENTS = [
  "pull_request",
  "pull_request_target",
  "merge_group",
];

type Job = {
  name?: unknown;
  uses?: unknown;
  strategy?: { matrix?: unknown };
};

/** Event names from the string, list or map form of `on`. */
function events(on: unknown): string[] {
  if (typeof on === "string") return [on];
  if (Array.isArray(on))
    return on.filter((event): event is string => typeof event === "string");
  if (on && typeof on === "object") return Object.keys(on);
  return [];
}

/**
 * Value lists of each combination of a matrix whose axes are all plain
 * scalar lists, in axis order. Undefined for a matrix Factory cannot expand
 * from structure alone: an expression, include or exclude, or object values.
 */
function matrixValues(matrix: unknown): string[][] | undefined {
  if (!matrix || typeof matrix !== "object" || Array.isArray(matrix)) return;
  const axes = Object.entries(matrix);
  if (
    !axes.length ||
    axes.some(
      ([key, values]) =>
        key === "include" ||
        key === "exclude" ||
        !Array.isArray(values) ||
        !values.length ||
        values.some(
          (value) =>
            !["string", "number", "boolean"].includes(typeof value) ||
            String(value).includes("${{"),
        ),
    ) ||
    axes.reduce(
      (count, [, values]) => count * (values as unknown[]).length,
      1,
    ) > MAX_MATRIX_NAMES
  )
    return;
  return axes.reduce<string[][]>(
    (combinations, [, values]) =>
      combinations.flatMap((combination) =>
        (values as unknown[]).map((value) => [...combination, String(value)]),
      ),
    [[]],
  );
}

/**
 * Check-run names one job reports: its name (or id), or "name (a, b)" for
 * each combination of a matrix. A name built from an expression or a matrix
 * Factory cannot expand reports nothing Factory can know.
 */
function jobNames(id: string, job: Job): string[] {
  const name = typeof job.name === "string" ? job.name : id;
  if (name.includes("${{")) return [];
  if (job.strategy?.matrix === undefined) return [name];
  return (matrixValues(job.strategy.matrix) ?? []).map(
    (values) => `${name} (${values.join(", ")})`,
  );
}

function jobsOf(workflow: unknown): [string, Job][] {
  const jobs = (workflow as { jobs?: unknown } | null)?.jobs;
  if (!jobs || typeof jobs !== "object" || Array.isArray(jobs)) return [];
  return Object.entries(jobs).map(([id, job]) => [id, (job ?? {}) as Job]);
}

/**
 * The check-run names GitHub reports on a pull request for the Actions
 * workflows at the base, read from their YAML structure. Only workflows in
 * the top level of .github/workflows triggered by pull_request,
 * pull_request_target or merge_group count. A job reports its name (or id),
 * a matrix job "name (a, b)" per combination, and a job that calls a local
 * reusable workflow "caller / callee" per called job. Calls to another
 * repository's workflow, expression names and matrices that need include,
 * exclude or expressions cannot be named in a plan.
 */
export function workflowCheckNames(
  checkout: string,
  baseSha: string,
): string[] {
  const read = (path: string): unknown => {
    let text: string;
    try {
      text = pinnedGitRaw(checkout, "show", `${baseSha}:${path}`).toString(
        "utf8",
      );
    } catch (error) {
      throw new Error(
        `Cannot read workflow ${path} at commit ${baseSha}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    try {
      return parse(text);
    } catch {
      // GitHub cannot run a workflow it cannot parse; it reports no checks.
      return undefined;
    }
  };
  let files: string[];
  try {
    files = pinnedGit(
      checkout,
      "ls-tree",
      "-d",
      "--name-only",
      baseSha,
      WORKFLOWS,
    )
      ? pinnedGit(checkout, "ls-tree", `${baseSha}:${WORKFLOWS}`)
          .split("\n")
          .filter(Boolean)
          .flatMap((line) => {
            const [mode, path] = line.split("\t");
            return mode?.split(" ")[1] === "blob" && /\.ya?ml$/.test(path ?? "")
              ? [`${WORKFLOWS}/${path}`]
              : [];
          })
      : [];
  } catch (error) {
    throw new Error(
      `Cannot read the GitHub workflows at commit ${baseSha}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const names = new Set<string>();
  for (const path of files) {
    const workflow = read(path);
    if (
      !events((workflow as { on?: unknown } | null)?.on).some((event) =>
        PULL_REQUEST_EVENTS.includes(event),
      )
    )
      continue;
    for (const [id, job] of jobsOf(workflow)) {
      if (job.uses === undefined) {
        for (const name of jobNames(id, job)) names.add(name);
        continue;
      }
      const called =
        typeof job.uses === "string" &&
        job.uses.match(/^\.\/(\.github\/workflows\/[^/@]+\.ya?ml)$/)?.[1];
      if (
        !called ||
        job.strategy?.matrix !== undefined ||
        !files.includes(called)
      )
        continue;
      const caller = typeof job.name === "string" ? job.name : id;
      if (caller.includes("${{")) continue;
      for (const [calleeId, callee] of jobsOf(read(called)))
        if (callee.uses === undefined)
          for (const name of jobNames(calleeId, callee))
            names.add(`${caller} / ${name}`);
    }
  }
  return [...names].sort();
}

/** The names in `names` that no known source defines. */
export function unknownCheckNames(names: string[], known: string[]): string[] {
  const defined = new Set(known);
  return [...new Set(names)].filter((name) => !defined.has(name));
}

/** Every CI check the plan names must be one the base or Objective defines. */
export function assertKnownCheckNames(graph: WorkGraph, names: string[]): void {
  const [name] = unknownCheckNames(
    [
      ...(graph.requiredPreIntegrationChecks ?? []).map(
        (gate) => gate.checkName,
      ),
      ...(graph.coverage ?? []).flatMap((entry) =>
        "checkName" in entry.proof ? [entry.proof.checkName] : [],
      ),
    ],
    names,
  );
  if (name !== undefined)
    throw new Error(
      `CI check ${JSON.stringify(name)} is not a job in the base's GitHub workflows; use one of those exact names: ${JSON.stringify(names.slice(0, 20))}${names.length > 20 ? ` and ${names.length - 20} more` : ""}`,
    );
}
