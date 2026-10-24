import { dirname } from "node:path";
import {
  CLAUDE_AGENT_SDK_ADAPTER_IDENTITY,
  type FactoryConfig,
  type FactoryConfigFile,
  harnessAdapterIdentity,
  type LocalHarnessConfig,
  planningSessionRoot,
  readConfigFile,
  resolveProvider,
} from "./config.js";
import {
  CODEX_APP_SERVER_PLANNING_ADAPTER,
  CODEX_PLANNING_ADAPTER,
} from "./compiler/transport.js";
import { isExecutionState, type ContinuationState } from "./state.js";
import { executionCredential } from "./provider-credentials.js";
import { recordedSplitParent } from "./objective-split.js";
import {
  continuationConfigurationMatches,
  readContinuation,
} from "./state-store.js";

/**
 * Why a command runs with its provider; status reports it. "unmatched": the
 * Objective's frozen configuration matches no configured provider and several
 * are configured, so the default may not be the provider it ran with.
 */
type ProviderSource =
  | "objective"
  | "flag"
  | "default"
  | "unmatched"
  | "recorded-adapters";

export interface SelectedConfig {
  config: FactoryConfig;
  provider: string;
  source: ProviderSource;
}

/**
 * Choose one provider: an Objective with state keeps the provider it froze. When none
 * matches (its settings changed), an explicit `--provider` names the one it ran with, else
 * the default keeps it inspectable. Otherwise an explicit `--provider`, else
 * `defaultProvider`. The calling agent host never chooses: overriding the default is explicit.
 */
export function selectProvider(
  file: FactoryConfigFile,
  options: {
    objective?: number;
    flag?: string;
    /** Cancel: an unmatched Objective may resolve by its recorded adapters. */
    cancel?: boolean;
  } = {},
): SelectedConfig {
  const names = Object.keys(file.providers);
  if (options.objective !== undefined) {
    const state = readContinuation(file.repository, options.objective);
    // A child Objective without state of its own runs on its parent's provider.
    const parent = state
      ? undefined
      : recordedSplitParent(file.repository, options.objective);
    if (parent !== undefined)
      return selectProvider(file, { ...options, objective: parent });
    if (state) {
      const provider = names.find((name) =>
        continuationConfigurationMatches(state, resolveProvider(file, name)),
      );
      // A configuration no provider matches stays inspectable, and continuation refuses
      // where it requires the frozen digest. Cancel needs the adapters the Objective ran
      // with, which only the operator's explicit --provider can name (#1398).
      if (
        provider === undefined &&
        options.flag === undefined &&
        options.cancel
      ) {
        // A held restoration releases nothing: cancel only records itself.
        const recorded =
          state.restoration?.status === "held"
            ? file.defaultProvider
            : recordedAdapterProvider(file, state);
        if (recorded !== undefined)
          return {
            config: resolveProvider(file, recorded),
            provider: recorded,
            source: "recorded-adapters",
          };
      }
      if (provider === undefined)
        return options.flag !== undefined
          ? {
              config: resolveProvider(file, options.flag),
              provider: options.flag,
              source: "flag",
            }
          : {
              config: resolveProvider(file, file.defaultProvider),
              provider: file.defaultProvider,
              source: names.length > 1 ? "unmatched" : "default",
            };
      if (options.flag !== undefined && options.flag !== provider)
        throw new Error(
          `Objective #${options.objective} runs with provider ${provider}; --provider cannot switch started work`,
        );
      return {
        config: resolveProvider(file, provider),
        provider,
        source: "objective",
      };
    }
  }
  if (options.flag !== undefined)
    return {
      config: resolveProvider(file, options.flag),
      provider: options.flag,
      source: "flag",
    };
  return {
    config: resolveProvider(file, file.defaultProvider),
    provider: file.defaultProvider,
    source: "default",
  };
}

export function readSelectedConfig(
  path: string,
  options: Parameters<typeof selectProvider>[1] = {},
): SelectedConfig {
  return selectProvider(readConfigFile(path), options);
}

/** An adapter identity without its version: a Factory upgrade keeps its family. */
function family(identity: string): string {
  return /^(@?[^@]+)@/.exec(identity)?.[1] ?? identity;
}

/** Every adapter family a provider's planning and execution can record. */
function providerFamilies(config: FactoryConfig): Set<string> {
  const families = new Set<string>();
  if (config.planning.kind === "codex-sdk")
    for (const id of [
      CODEX_PLANNING_ADAPTER,
      CODEX_APP_SERVER_PLANNING_ADAPTER,
    ])
      families.add(family(id));
  else families.add(family(CLAUDE_AGENT_SDK_ADAPTER_IDENTITY));
  const execution = config.execution;
  if (execution.kind === "managed-agent") {
    families.add(execution.provider);
    return families;
  }
  families.add("local");
  const harnesses = [
    ...(execution.harness ? [execution.harness] : []),
    ...Object.values(execution.profiles ?? {}).map(
      (profile) => profile.harness,
    ),
  ];
  // A default local harness is Codex.
  if (!harnesses.length)
    harnesses.push({ kind: "codex-sdk" } as LocalHarnessConfig);
  for (const harness of harnesses) {
    families.add(family(harnessAdapterIdentity(harness)));
    // Worker session receipts name the harness kind.
    families.add(
      harness.kind === "codex-sdk"
        ? "codex"
        : harness.kind === "registered"
          ? family(harness.adapter)
          : harness.kind,
    );
  }
  return families;
}

/**
 * The one configured provider whose adapters cover every adapter the
 * Objective recorded (its sessions, Work Item bindings and executions) and
 * whose session root holds the recorded sessions, so cancel can release them
 * after the configuration changed. An execution does not record its account,
 * so providers covering the same adapters under different accounts are
 * ambiguous. With nothing recorded, the default releases nothing and cancels.
 * Undefined when no provider or several fit: the operator names it with
 * --provider.
 */
function recordedAdapterProvider(
  file: FactoryConfigFile,
  state: ContinuationState,
): string | undefined {
  const recorded = new Set<string>();
  const roots = new Set<string>();
  for (const ref of [
    ...Object.values(state.agentSessions ?? {}),
    ...(state.agentSessionHistory ?? []),
  ]) {
    recorded.add(family(ref.adapter));
    const data = ref.data as { sessionRoot?: unknown; root?: unknown };
    const root = data?.sessionRoot ?? data?.root;
    if (ref.scope.role !== "implementation" && typeof root === "string")
      roots.add(dirname(root));
  }
  if (isExecutionState(state)) {
    for (const item of state.graph.items)
      if (item.executionBinding)
        recorded.add(family(item.executionBinding.adapter));
    for (const work of Object.values(state.work))
      if (work.execution) recorded.add(work.execution.provider);
  }
  if (!recorded.size) return file.defaultProvider;
  const covering = Object.keys(file.providers).filter((name) => {
    const families = providerFamilies(resolveProvider(file, name));
    return [...recorded].every((value) => families.has(value));
  });
  const accounts = new Set(
    covering.map((name) => executionCredential(resolveProvider(file, name))),
  );
  if (accounts.size > 1) return undefined;
  const fits = covering.filter((name) => {
    const root = planningSessionRoot(resolveProvider(file, name));
    return [...roots].every((value) => value === root);
  });
  return fits.length === 1 ? fits[0] : undefined;
}
