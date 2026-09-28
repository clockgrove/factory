import { createHash } from "node:crypto";
import type { FactoryConfig, ExecutionProfile } from "./config.js";
import type {
  ExecutionBinding,
  ExecutionProfileChoices,
  WorkGraph,
  WorkItem,
} from "./contracts.js";

function canonical(value: unknown): unknown {
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
    adapter: harness.kind === "codex-sdk" ? harness.kind : harness.adapter,
    ...(harness.kind !== "registered"
      ? { model: harness.model, reasoningEffort: harness.reasoningEffort }
      : {}),
    digest: createHash("sha256")
      .update(JSON.stringify(canonical({ profile, policy })))
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

export function normalizeExecutionProfiles(
  graph: WorkGraph,
  choices?: ExecutionProfileChoices,
): void {
  for (const item of graph.items) {
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
  for (const item of expected.items) delete item.executionBinding;
  normalizeExecutionProfiles(expected, choices);
  if (JSON.stringify(expected) !== JSON.stringify(graph))
    throw new Error(
      "Accepted execution profile assignment differs from installation configuration",
    );
}
