/** The options each CLI command reads; shared by the CLI and guided setup. */
const installFlags = [
  "provider",
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
  propose: ["source", "output", "file", "approve", "enqueue", "provider"],
  dream: [
    "budget-bytes",
    "input-budget-bytes",
    "preview",
    "file",
    "approve",
    "reject",
    "show",
    "record",
    "objective",
    "provider",
  ],
  recipe: ["file", "provider"],
  persistence: ["checkpoint", "objective"],
  run: ["objective", "deadline", "provider"],
  collect: ["objective", "item", "run", "attempt"],
  queue: [],
  supervisor: ["cli", "disable", "service-credential"],
  decide: [
    "objective",
    "item",
    "criterion",
    "outcome",
    "answer",
    "question",
    "reason",
  ],
  status: ["objective", "issue", "json"],
  watch: ["objective", "json", "follow", "interval", "stale-minutes"],
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
    "output",
  ],
  select: ["objective", "item", "set", "output", "bind"],
  "propose-amendment": ["objective", "proposal"],
  "decline-discovery": ["objective", "decision"],
  pause: ["objective"],
  drain: ["objective"],
  resume: ["objective"],
  cancel: ["objective", "provider"],
  repair: ["objective", "proposal"],
  retry: [
    "objective",
    "item",
    "rereview",
    "review-artifacts",
    "fresh",
    "retire-command",
    "reason",
  ],
};
/** Flags that take no value; everything else reads the next argument. */
const booleanFlags = new Set([
  "background",
  "config-only",
  "capture-content",
  "json",
  "follow",
  "summary",
  "analyze",
  "captures",
  "gantt",
  "disable",
  "rereview",
  "fresh",
  "show",
  "record",
  "preview",
]);
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
  for (const arg of args) {
    if (!arg.startsWith("--")) continue;
    const name = arg.slice(2);
    // `--objective=5` is the same mistake as `--objective 5`.
    const [flag, inline] = name.split("=", 2) as [string, string | undefined];
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
