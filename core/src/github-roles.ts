import { crashPoint } from "./crash.js";
import { type GitHub, GitHubError, type GraphQLError } from "./github.js";

/**
 * Factory's role labels and the native issue types it gives its issues
 * (tracking.ts applies them). The labels are made once per installation
 * when missing; the types are only read: Factory never changes repository
 * settings or creates an issue type, so a type the repository doesn't
 * offer is a setup prerequisite (readiness.ts reports it), and the issue
 * goes without one.
 */

/** The role label of an Objective issue. */
export const OBJECTIVE_LABEL = "factory:objective";
/** The role label of a Work Item issue: the queue never takes one as an Objective. */
export const WORK_ITEM_LABEL = "factory:work-item";

const ROLE_LABELS: Record<string, string> = {
  [OBJECTIVE_LABEL]: "An Objective Factory runs",
  [WORK_ITEM_LABEL]: "A Work Item Factory tracks for display",
};

/** A priority label an Objective's Work Items inherit: `P0`, `P1`, ... */
export const PRIORITY = /^P\d+$/;

/** The native issue type per role, by name (config.ts `tracking.issueType`). */
export interface RoleTypes {
  objective: string;
  workItem: string;
}

/** The roles as the repository has them: each type's name as offered, absent when it isn't. */
export interface Roles {
  types: Partial<RoleTypes>;
}

const ensured = new WeakMap<GitHub, Map<string, Promise<Roles>>>();

/**
 * Make sure the role labels exist and resolve the role types against the
 * types the repository offers: once per installation (per GitHub client
 * and wanted types; a failure is tried again on the next call). Bounded:
 * one read per label, a create only when missing, one types query. Shared
 * by every Objective's tracking job, so no one job's signal aborts it:
 * each request has GitHub's own deadline.
 */
export function ensureRoles(github: GitHub, wanted: RoleTypes): Promise<Roles> {
  const cache = ensured.get(github) ?? new Map<string, Promise<Roles>>();
  ensured.set(github, cache);
  const key = `${wanted.objective}\0${wanted.workItem}`;
  let roles = cache.get(key);
  if (!roles) {
    roles = resolve(github, wanted);
    cache.set(key, roles);
    roles.catch(() => cache.delete(key));
  }
  return roles;
}

async function resolve(github: GitHub, wanted: RoleTypes): Promise<Roles> {
  for (const [name, description] of Object.entries(ROLE_LABELS))
    await ensureLabel(github, name, description);
  const offered = await offeredTypes(github);
  const types: Partial<RoleTypes> = {};
  for (const role of ["objective", "workItem"] as const) {
    const found = offered.find(
      (type) => type.toLowerCase() === wanted[role].toLowerCase(),
    );
    if (found) types[role] = found;
  }
  return { types };
}

/** The label, found by name before it is created; a create that lost a race to another is fine. */
async function ensureLabel(
  github: GitHub,
  name: string,
  description: string,
): Promise<void> {
  const path = `/repos/${github.repository}/labels`;
  try {
    await github.rest("GET", `${path}/${encodeURIComponent(name)}`);
    return;
  } catch (error) {
    if (!(error instanceof GitHubError) || error.status !== 404) throw error;
  }
  crashPoint("sync:roles:label:before");
  try {
    await github.rest("POST", path, { name, color: "ededed", description });
  } catch (error) {
    if (!(error instanceof GitHubError) || error.status !== 422) throw error;
  }
  crashPoint("sync:roles:label:after");
}

const ISSUE_TYPES = `
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    issueTypes(first: 50) { nodes { name isEnabled } }
  }
}`;

/** The enabled issue types the repository offers; none where it has no issue types. */
export async function offeredTypes(
  github: GitHub,
  signal?: AbortSignal,
): Promise<string[]> {
  const { data } = await github.graphqlPartial<{
    repository: {
      issueTypes: {
        nodes: ({ name: string; isEnabled: boolean } | null)[];
      } | null;
    } | null;
  }>(
    ISSUE_TYPES,
    { owner: github.owner, name: github.name },
    signal,
    (error: GraphQLError) => error.path?.[1] === "issueTypes",
  );
  if (!data.repository)
    throw new GitHubError(`Repository ${github.repository} not found`, 404);
  return (data.repository.issueTypes?.nodes ?? []).flatMap((type) =>
    type?.isEnabled ? [type.name] : [],
  );
}

/** The role types the repository doesn't offer: each one a setup prerequisite. */
export function missingTypes(wanted: RoleTypes, offered: string[]): string[] {
  const names = new Set(offered.map((type) => type.toLowerCase()));
  return [...new Set([wanted.objective, wanted.workItem])].filter(
    (type) => !names.has(type.toLowerCase()),
  );
}

/**
 * Give the Objective issue its role: the `factory:objective` label when it
 * lacks it, and the role's type when it has no type yet (a type someone
 * set is kept). Returns its priority labels, which its Work Items inherit.
 * A type GitHub refuses is logged by the caller and left.
 */
export async function objectiveRole(
  github: GitHub,
  issue: number,
  type: string | undefined,
  signal?: AbortSignal,
): Promise<{ priority: string[]; typeRefused?: GitHubError }> {
  const found = await github.rest<{
    labels?: ({ name?: string } | string)[];
    type?: { name: string } | null;
  }>("GET", `/repos/${github.repository}/issues/${issue}`, undefined, signal);
  const labels = (found.labels ?? []).map((label) =>
    typeof label === "string" ? label : (label.name ?? ""),
  );
  if (!labels.includes(OBJECTIVE_LABEL))
    await addLabels(
      github,
      issue,
      [OBJECTIVE_LABEL],
      "sync:objective-role",
      signal,
    );
  let typeRefused: GitHubError | undefined;
  if (type && !found.type)
    try {
      await github.editIssue(issue, { type }, "sync:objective-role", signal);
    } catch (error) {
      if (
        !(error instanceof GitHubError) ||
        error.status < 400 ||
        error.status >= 500 ||
        // A rejected login isn't the repository refusing the type.
        error.status === 401
      )
        throw error;
      typeRefused = error;
    }
  return {
    priority: labels.filter((label) => PRIORITY.test(label)).sort(),
    ...(typeRefused ? { typeRefused } : {}),
  };
}

/** Add labels to an issue (labels it has stay). */
export async function addLabels(
  github: GitHub,
  issue: number,
  labels: string[],
  point: string,
  signal?: AbortSignal,
): Promise<void> {
  crashPoint(`${point}:before`);
  await github.rest(
    "POST",
    `/repos/${github.repository}/issues/${issue}/labels`,
    { labels },
    signal,
  );
  crashPoint(`${point}:after`);
}

/** Remove a label from an issue; one already gone is fine. */
export async function removeLabel(
  github: GitHub,
  issue: number,
  label: string,
  point: string,
  signal?: AbortSignal,
): Promise<void> {
  crashPoint(`${point}:before`);
  try {
    await github.rest(
      "DELETE",
      `/repos/${github.repository}/issues/${issue}/labels/${encodeURIComponent(label)}`,
      undefined,
      signal,
    );
  } catch (error) {
    if (!(error instanceof GitHubError) || error.status !== 404) throw error;
  }
  crashPoint(`${point}:after`);
}
