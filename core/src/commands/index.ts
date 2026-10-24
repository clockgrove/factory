/**
 * The command registry: one module per command under commands/, each
 * exporting its spec; this table orders them for `factory help`.
 */
import { spec as answer } from "./answer.js";
import { spec as declineDiscovery } from "./decline-discovery.js";
import { spec as diagnostics } from "./diagnostics.js";
import { spec as dream } from "./dream.js";
import { spec as exportCaptures } from "./export-captures.js";
import { specs as lifecycle } from "./lifecycle.js";
import { spec as log } from "./log.js";
import { spec as propose } from "./propose.js";
import { spec as proposeAmendment } from "./propose-amendment.js";
import { spec as queue } from "./queue.js";
import { spec as recipe } from "./recipe.js";
import { spec as run } from "./run.js";
import { spec as serve } from "./serve.js";
import { spec as setup } from "./setup.js";
import type { Command } from "./shared.js";
import { spec as status } from "./status.js";
import { spec as watch } from "./watch.js";

/**
 * Every command: its arguments, its options, its help and its check. The
 * one table `factory help`, the option parser and the checks read, so the
 * help covers every command by construction.
 */
export const COMMANDS: Record<string, Command> = {
  serve,
  setup,
  run,
  status,
  log,
  diagnostics,
  "export-captures": exportCaptures,
  watch,
  answer,
  "propose-amendment": proposeAmendment,
  "decline-discovery": declineDiscovery,
  ...lifecycle,
  queue,
  dream,
  propose,
  recipe,
  help: { args: "", flags: {}, help: "Show this help" },
};
