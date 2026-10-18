import { factoryShellAuthorized } from "./execution/claude-shell.js";
import { createHash } from "node:crypto";
import {
  harnessAdapterIdentity,
  type ExecutionProfile,
  type FactoryConfig,
  type LocalHarnessConfig,
  withoutWorkerLimits,
} from "./config.js";
import type {
  ExecutionBinding,
  ExecutionProfileChoices,
  WorkGraph,
  WorkItem,
} from "./contracts.js";

/** The value with object keys sorted, for order-independent JSON. */
export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}

export function profileBinding(
  id: string,
  profile: ExecutionProfile,
  policy: FactoryConfig["policy"],
): ExecutionBinding {
  const harness = profile.harness;
  return {
    id,
    adapter: harnessAdapterIdentity(harness),
    ...(harness.kind !== "registered"
      ? { model: harness.model, reasoningEffort: harness.reasoningEffort }
      : {}),
    digest: createHash("sha256")
      .update(
        JSON.stringify(
          canonical({
            profile: { ...profile, harness: withoutWorkerLimits(harness) },
            policy,
          }),
        ),
      )
      .digest("hex"),
  };
}

/** Operator-owned membership grants access to the whole worktree and supplied inputs. */
export function executionProfileChoices(
  config: FactoryConfig,
): ExecutionProfileChoices | undefined {
  if (config.execution.kind !== "local" || !config.execution.profiles)
    return undefined;
  return {
    defaultProfile: config.execution.defaultProfile!,
    profiles: Object.entries(config.execution.profiles).map(
      ([id, profile]) => ({
        ...profileBinding(id, profile, config.policy),
        description: profile.description,
        selectionHints: profile.selectionHints ?? [],
        ...(profile.harness.kind !== "registered"
          ? {
              environment: {
                instructions:
                  profile.environment?.instructions !== undefined
                    ? {
                        present: true as const,
                        identity: createHash("sha256")
                          .update(profile.environment.instructions)
                          .digest("hex"),
                      }
                    : { present: false as const },
                ...(profile.environment?.mcp
                  ? {
                      mcp: {
                        kind: profile.environment.mcp.kind,
                        version: profile.environment.mcp.version,
                      },
                    }
                  : {}),
              },
            }
          : {}),
        constraints: {
          network: config.policy.network,
          ...(profile.harness.kind === "claude-agent-sdk"
            ? {
                tools: profile.harness.tools,
                permissions: profile.harness.allowedTools,
              }
            : {}),
          ...(profile.harness.kind === "github-copilot-sdk"
            ? {
                tools: profile.harness.availableTools,
                permissions: profile.harness.permissionKinds,
              }
            : {}),
        },
      }),
    ),
  };
}

/**
 * What a worker can execute, decided by its harness kind. Codex workers have
 * a sandboxed shell. Claude workers have one (run_command) when Write and
 * Validate are granted and the command sandbox runs on this host; otherwise,
 * like Copilot workers, only checkout file tools and the item's authorized
 * validation. Registered and managed adapters declare neither, so planning
 * treats them as shell-less.
 */
export type WorkerCommandAccess = "shell" | "validation-only" | "undeclared";

function harnessCommandAccess(
  harness: LocalHarnessConfig,
): WorkerCommandAccess {
  switch (harness.kind) {
    case "codex-sdk":
      return "shell";
    case "claude-agent-sdk":
      return factoryShellAuthorized({ config: harness })
        ? "shell"
        : "validation-only";
    case "github-copilot-sdk":
      return "validation-only";
    case "registered":
      return "undeclared";
  }
}

/** Worker command access by execution profile id; "" names the single worker without profiles. */
export function workerCommandAccess(
  config: FactoryConfig,
): Record<string, WorkerCommandAccess> {
  const execution = config.execution;
  if (execution.kind !== "local") return { "": "undeclared" };
  if (execution.profiles)
    return Object.fromEntries(
      Object.entries(execution.profiles).map(([id, profile]) => [
        id,
        harnessCommandAccess(profile.harness),
      ]),
    );
  return { "": harnessCommandAccess(execution.harness!) };
}

export function normalizeExecutionProfiles(
  graph: WorkGraph,
  choices?: ExecutionProfileChoices,
): void {
  for (const item of [
    ...graph.items,
    ...(graph.expansions ?? []).map((entry) => entry.template),
  ]) {
    if (item.executionProfile === null) delete item.executionProfile;
    if (
      item.kind === "qa" ||
      item.kind === "aggregate" ||
      (item.kind === "discovery" && item.discovery?.mode === "inventory")
    ) {
      if (item.executionProfile || item.executionBinding)
        throw new Error("Controller-only nodes have no worker profile");
      continue;
    }
    if (item.executionBinding !== undefined)
      throw new Error("Model may not supply an execution binding");
    if (!choices) {
      if (item.executionProfile !== undefined)
        throw new Error("Execution profiles are not configured");
      continue;
    }
    const assignment = item.executionProfile ?? {
      id: choices.defaultProfile,
      reason: "Configured default; no stronger supported assignment supplied.",
    };
    if (
      !assignment ||
      typeof assignment.id !== "string" ||
      typeof assignment.reason !== "string" ||
      !assignment.reason.trim() ||
      Object.keys(assignment).some((key) => !["id", "reason"].includes(key))
    )
      throw new Error("Invalid execution profile assignment");
    const profile = choices.profiles.find(
      (profile) => profile.id === assignment.id,
    );
    if (!profile)
      throw new Error(
        `Unknown or unauthorized execution profile ${assignment.id}`,
      );
    item.executionProfile = assignment;
    const { id, adapter, model, reasoningEffort, digest } = profile;
    item.executionBinding = {
      id,
      adapter,
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      digest,
    };
  }
}

export function assertExecutionBinding(
  item: WorkItem,
  binding: ExecutionBinding,
): void {
  if (
    item.executionProfile?.id !== binding.id ||
    JSON.stringify(item.executionBinding) !== JSON.stringify(binding)
  )
    throw new Error(
      `Execution profile binding changed for ${item.id}; no fallback is available`,
    );
}

export function verifyExecutionProfiles(
  graph: WorkGraph,
  choices?: ExecutionProfileChoices,
): void {
  const expected = structuredClone(graph);
  for (const item of [
    ...expected.items,
    ...(expected.expansions ?? []).map((entry) => entry.template),
  ])
    delete item.executionBinding;
  normalizeExecutionProfiles(expected, choices);
  if (JSON.stringify(expected) !== JSON.stringify(graph))
    throw new Error(
      "Accepted execution profile assignment differs from installation configuration",
    );
}
