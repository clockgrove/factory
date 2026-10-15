import {
  type FactoryConfig,
  type FactoryConfigFile,
  readConfigFile,
  resolveProvider,
} from "./config.js";
import {
  continuationConfigurationMatches,
  readContinuation,
} from "./state-store.js";

/** Why a command runs with its provider; status reports it. */
export type ProviderSource = "objective" | "flag" | "default";

export interface SelectedConfig {
  config: FactoryConfig;
  provider: string;
  source: ProviderSource;
}

/**
 * Choose one provider: an Objective with state keeps the provider it froze (or the default
 * when none matches, so it stays inspectable); otherwise an explicit `--provider`, else
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
    if (state) {
      const provider = names.find((name) =>
        continuationConfigurationMatches(state, resolveProvider(file, name)),
      );
      // A configuration no provider matches keeps today's single-configuration behavior:
      // inspection works, and continuation refuses where it requires the frozen digest.
      if (provider === undefined)
        return {
          config: resolveProvider(file, file.defaultProvider),
          provider: file.defaultProvider,
          source: "default",
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
