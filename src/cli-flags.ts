/** The options each CLI command reads; shared by the CLI and guided setup. */
export const installFlags = [
  "repository",
  "checkout",
  "concurrency",
  "capture-content",
  "capture-max-bytes",
  "delivery",
  "network",
  "planning",
  "planning-transport",
  "planning-model",
  "planning-reasoning",
  "review-model",
  "review-reasoning",
  "harness",
  "worker-model",
  "worker-reasoning",
  "claude-max-turns",
  "claude-permission",
  "claude-setting-source",
  "claude-tool",
  "claude-allow-tool",
  "copilot-timeout-seconds",
  "copilot-tool",
];
/** Options each command reads; export-captures validates its own, diagnostics checks per mode. */
const commandFlags: Record<string, string[]> = {
  setup: [
    "background",
    "config-only",
    "outside-directory",
    "credential-file",
    ...installFlags,
  ],
  propose: ["source", "output", "file", "approve", "enqueue"],
  dream: [
    "budget-bytes",
    "file",
    "approve",
    "reject",
    "show",
    "record",
    "objective",
  ],
  run: ["objective", "deadline"],
  queue: [],
  supervisor: ["cli", "disable", "service-credential"],
  decide: ["objective", "item", "criterion", "outcome", "answer", "reason"],
  status: ["objective", "json"],
  diagnostics: [
    "objective",
    "follow",
    "summary",
    "scorecard",
    "analyze",
    "logs",
    "captures",
    "content",
    "group-by",
    "filter",
    "json",
    "gantt",
    "native-tool-content",
    "output",
  ],
  select: ["objective", "item", "set", "output", "bind"],
  "propose-amendment": ["objective", "proposal"],
  pause: ["objective"],
  drain: ["objective"],
  resume: ["objective"],
  cancel: ["objective"],
  repair: ["objective", "proposal"],
  retry: ["objective", "item", "rereview"],
};
/** Flags that take no value; everything else reads the next argument. */
export const booleanFlags = new Set([
  "background",
  "config-only",
  "capture-content",
  "json",
  "follow",
  "summary",
  "analyze",
  "captures",
  "gantt",
  "native-tool-content",
  "disable",
  "rereview",
  "show",
  "record",
]);
const removedFlags = ["source", "authority", "admission", "abandon"];
/** Flags dropped when running a command became its own consent. */
const consentFlags = ["service-consent", "actor", "retain-package"];
/** Flags whose value now comes from the Objective's state or the configuration. */
const derivedFlags: Record<string, string> = {
  plan: "the plan digest is read from the Objective's state",
  tree: "the tree is read from the Objective's state",
  "poll-seconds": "set queue.pollSeconds in the configuration",
  "priority-label": "the queue runs Objectives in the order they were added",
  watch: "factory setup --background starts the service that watches the queue",
  intake: "factory setup --background installs the service",
};
/** Commands folded into another; each names where it went. */
export const removedCommands: Record<string, string> = {
  install: "factory setup --config-only",
  readiness:
    "factory setup --background or factory run --objective N, which run the same checks",
  intake: "factory queue add|list|remove|pause|resume|drain",
  "decide-result":
    "factory decide --objective N [--item X] [--criterion TEXT] --outcome accept|refuse --reason TEXT",
  rereview: "factory retry --objective N --item X --rereview",
  plan: "factory run --objective N, which plans and saves the plan for factory status",
  analyze: "factory diagnostics --objective N --analyze",
  logs: "factory diagnostics --objective N --logs ITEM",
  captures: "factory diagnostics --objective N --captures",
  review: "factory select --objective N --item X --output DIR",
};

/** The value after `--name`, if any. */
export function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? undefined : args[index + 1];
}

/** Every value after a repeated `--name`. */
export function options(args: string[], name: string): string[] {
  return args.flatMap((arg, index) =>
    arg === `--${name}` && args[index + 1] ? [args[index + 1]!] : [],
  );
}

/** Setup options that only `--background` reads. */
const backgroundOnlyFlags = ["outside-directory", "credential-file"];

/** The setup command that takes an option, with a placeholder for its value. */
function setupCommand(name: string): string {
  if (name === "background" || name === "config-only")
    return `use factory setup --${name}`;
  const value = booleanFlags.has(name) ? "" : " VALUE";
  return backgroundOnlyFlags.includes(name)
    ? `use factory setup --background --${name}${value}`
    : `use factory setup --config-only --${name}${value} (--background instead also starts the service)`;
}

/** Refuse an option the command does not read, so a typo or removed flag never runs silently. */
export function assertKnownFlags(command: string, args: string[]): void {
  const moved = removedCommands[command];
  if (moved) throw new Error(`factory ${command} was removed; use ${moved}`);
  for (const arg of args) {
    if (!arg.startsWith("--")) continue;
    const name = arg.slice(2);
    if (
      removedFlags.includes(name) &&
      !(command === "propose" && name === "source")
    )
      throw new Error(
        `${arg} was removed; Objectives declare their own sources and running is the consent (see factory help)`,
      );
    if (
      consentFlags.includes(name) ||
      (name === "reason" && command !== "decide")
    )
      throw new Error(
        `${arg} was removed; running the command is the consent (see factory help)`,
      );
    if (derivedFlags[name])
      throw new Error(`${arg} was removed; ${derivedFlags[name]}`);
    // `--objective=5` is the same mistake as `--objective 5`.
    const [flag, inline] = name.split("=", 2) as [string, string | undefined];
    if (
      flag === "objective" &&
      (command === "setup" || command === "supervisor")
    )
      throw new Error(
        `${arg} was removed from factory ${command}; queue Objectives with factory queue add N`,
      );
    if (flag === "objective" && command === "queue") {
      // The number to name: the inline value, else the next word if it is one, else a placeholder.
      const value = inline ?? args[args.indexOf(arg) + 1];
      const number = /^\d+$/.test(value ?? "") ? value : undefined;
      throw new Error(
        `factory queue takes Objective numbers as arguments, not --objective; use factory queue add ${number ?? "N"} (or remove)`,
      );
    }
    const allowed = commandFlags[command];
    if (
      allowed &&
      command !== "setup" &&
      !allowed.includes(name) &&
      commandFlags.setup!.includes(name)
    )
      throw new Error(`${arg} belongs to factory setup; ${setupCommand(name)}`);
    if (allowed && name !== "config" && !allowed.includes(name))
      throw new Error(
        `Unknown option ${arg} for factory ${command}; see factory help`,
      );
  }
}
