/**
 * Registered kinds: a host program's own Planner and Worker
 * (DESIGN.md#Library). The host registers a kind named `host:<name>` before
 * it serves the installation; configuration then names it as a
 * provider's `planner` or `worker.kind`, like a built-in kind, and the
 * service builds the host's implementation where it builds a built-in one
 * (providers/selection.ts). A configuration naming a host kind loads in
 * any process, so the CLI's commands keep working; only a process that
 * registered it can serve it (library.ts serveFactory).
 */
import type { CoreConfig } from "./config.js";
import type { Plan } from "./planning/types.js";
import type { ProviderConfig } from "./providers/config.js";
import type { Planner, PlannerModels } from "./providers/planner.js";
import type { ObjectiveBlock } from "./shown.js";
import type { Worker } from "./work/worker.js";

/** A host kind's name: never a built-in kind's, so a typo in one is still refused. */
export const HOST_KIND = /^host:[a-z][a-z0-9-]{0,31}$/;

export const isHostKind = (name: unknown): name is string =>
  typeof name === "string" && HOST_KIND.test(name);

/** What a registered worker is built for: one Objective's plan, and the Work Item's execution profile. */
export interface WorkerContext {
  plan: Plan;
  blocks: readonly ObjectiveBlock[];
  profile?: string;
  config: CoreConfig;
}

export interface RegisteredKind {
  /** `host:<name>`. */
  name: string;
  /** The provider's planner and reviewer: its `models`, as configured (both choices are required). */
  planner?(models: PlannerModels): Planner;
  /** The provider's worker: its `worker` settings, without `kind`. */
  worker?(settings: Record<string, unknown>, context: WorkerContext): Worker;
  /**
   * Problems with the provider's settings for this kind, checked when
   * configuration loads in this process: `models` for its planner,
   * `worker` (without `kind`) for its worker.
   */
  check?(settings: {
    models?: PlannerModels;
    worker?: Record<string, unknown>;
  }): string[];
}

const registered = new Map<string, RegisteredKind>();

/** Register a kind for this process. Registering a second kind under one name is refused. */
export function registerKind(kind: RegisteredKind): void {
  if (!isHostKind(kind.name))
    throw new Error(
      `A registered kind's name is host:<name> (${HOST_KIND.source}), not ${JSON.stringify(kind.name)}`,
    );
  if (!kind.planner && !kind.worker)
    throw new Error(`${kind.name} registers neither a planner nor a worker`);
  const had = registered.get(kind.name);
  if (had && had !== kind)
    throw new Error(`${kind.name} is registered already`);
  registered.set(kind.name, kind);
}

/** The registered kind `name` as `role`; throws when this process hasn't registered it for that role. */
export function hostKind(
  name: string,
  role: "planner" | "worker",
): RegisteredKind {
  const kind = registered.get(name);
  if (!kind?.[role])
    throw new Error(
      kind
        ? `${name} registers no ${role}`
        : `${name} is not registered in this process: serve the installation from the host program that registers it (serveFactory)`,
    );
  return kind;
}

/**
 * Configuration problems with host kind `name` as `role` at `path`. A
 * planner needs its `models` choices, registered or not. When this process
 * registered the kind, the role must be one it registers, and its own
 * check runs; when it hasn't, serving refuses (unregisteredKinds).
 */
export function hostKindProblems(
  name: string,
  role: "planner" | "worker",
  path: string,
  settings: { models?: unknown; worker?: Record<string, unknown> },
  problems: string[],
): void {
  const models = settings.models as Partial<PlannerModels> | undefined;
  if (role === "planner" && (!models?.planner || !models.reviewer)) {
    problems.push(
      `${path}: host kind ${name} has no default models: give models.planner and models.reviewer, each {model, effort}`,
    );
    return;
  }
  const kind = registered.get(name);
  if (!kind) return;
  if (!kind[role]) problems.push(`${path}: ${name} registers no ${role}`);
  else
    for (const problem of kind.check?.(
      role === "planner"
        ? { models: models as PlannerModels }
        : { worker: settings.worker ?? {} },
    ) ?? [])
      problems.push(`${path}: ${problem}`);
}

/** Each `provider: kind (role)` the configuration names that this process can't build. */
export function unregisteredKinds(
  providers: Readonly<Record<string, ProviderConfig>>,
): string[] {
  return Object.entries(providers).flatMap(([name, provider]) =>
    (
      [
        [provider.planner, "planner"],
        [provider.worker.kind, "worker"],
      ] as const
    )
      .filter(
        ([kind, role]) => isHostKind(kind) && !registered.get(kind)?.[role],
      )
      .map(([kind, role]) => `providers.${name}: ${kind} (${role})`),
  );
}
