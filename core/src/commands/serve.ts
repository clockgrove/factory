/**
 * `factory serve`: its options, help and check, and what it does.
 */
import { ConfigurationError, serveInstallation } from "../host.js";
import type { Paths } from "../paths.js";
import { CONFIGURATION_EXIT } from "../systemd.js";
import type { Args, Command } from "./shared.js";

export const spec: Command = {
  args: "",
  flags: { provider: "value", "take-over": "switch" },
  help: "Run the service (the only writer of state); new Objectives use --provider NAME, else defaultProvider. One installation serves a repository: another one is refused, naming it; --take-over takes the repository from an installation that is stopped for good",
  run: ({ repository, paths, args }) => serveCommand(repository, paths, args),
};

/** How long `factory serve` waits at a stop for steps and jobs to end. */
const STOP_DRAIN_MS = 20_000;

async function serveCommand(
  repository: string,
  paths: Paths,
  args: Args,
): Promise<number> {
  try {
    // The process exits once serve returns, ending what still runs: the
    // stop waits for its drain only briefly (docs/reference/process.md#Process model).
    return await serveInstallation(repository, paths, {
      drainMs: STOP_DRAIN_MS,
      ...(args.flags.provider !== undefined
        ? { provider: args.flags.provider }
        : {}),
      takeOver: args.flags["take-over"] !== undefined,
    });
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    // A restart can't fix it: the unit doesn't restart on this code.
    process.stderr.write(`factory: ${error.message}\n`);
    return CONFIGURATION_EXIT;
  }
}
