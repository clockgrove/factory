import {
  type FactoryConfig,
  type FactoryConfigFile,
  readConfigFile,
  resolveProvider,
} from "./config.js";
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
export type ProviderSource = "objective" | "flag" | "default" | "unmatched";

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
