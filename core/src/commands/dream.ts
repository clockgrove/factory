/**
 * `factory dream`: its options, help and check, and what it does.
 */
import { loadConfig } from "../config.js";
import { knowledge, Refusal, serviceLive } from "../host.js";
import {
  type DreamCommand,
  dreamCommand,
  runDream,
} from "../knowledge/dream.js";
import { newRunId, RunLog } from "../log.js";
import type { Paths } from "../paths.js";
import { errorMessage } from "../text.js";
import {
  type Args,
  type Command,
  planner,
  providerName,
  sent,
  settledState,
} from "./shared.js";

export const spec: Command = {
  args: "",
  flags: {
    preview: "switch",
    record: "switch",
    show: "switch",
    objective: "value",
    file: "value",
    approve: "value",
    reject: "value",
    "budget-bytes": "value",
    "input-budget-bytes": "value",
    provider: "value",
  },
  help: "Propose a playbook from settled episodes ([--preview] [--budget-bytes N] [--input-budget-bytes N] [--provider NAME]); --record --objective N records one; --file PATH --approve|--reject SHA256 decides a draft; --show shows the playbook",
  check: (args) => {
    const parsed = dreamCommand(args.flags);
    return typeof parsed === "string" ? parsed : undefined;
  },
  run: ({ repository, paths, args }) => dream(repository, paths, args),
};

async function dream(
  repository: string,
  paths: Paths,
  args: Args,
): Promise<number> {
  // Checked by its COMMANDS check.
  const parsed = dreamCommand(args.flags) as DreamCommand;
  const config = loadConfig(repository);
  const name = providerName(config, args);
  const log = new RunLog(
    paths.logs,
    newRunId(),
    config.capture,
    config.secrets,
  );
  try {
    return await runDream(parsed, {
      settings: knowledge(config, paths),
      planner: () => planner(config, name),
      log: (event) => log.write(0, event),
      settledState: (issue) => settledState(paths, issue),
      send: async (write) => {
        // Only the service writes the store: no fallback to a direct write.
        // A call's end waits for the service instead, so a finished model
        // call is never lost to a restart.
        if (write.op !== "end" && !(await serviceLive(paths)))
          throw new Refusal(
            "service_not_running",
            "The service isn't running, and only it writes the knowledge store: start it (factory serve), then run this again.",
          );
        return (await sent(paths, { kind: "dream", issue: 0, write }))?.detail;
      },
      out: (text) => process.stdout.write(text),
    });
  } catch (error) {
    if (error instanceof Refusal) throw error;
    process.stderr.write(`factory: ${errorMessage(error)}\n`);
    return 1;
  } finally {
    log.end(() => "stopped");
  }
}
