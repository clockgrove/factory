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
/** Options each command reads; analyze and export-captures validate their own. */
const commandFlags: Record<string, string[]> = {
  setup: [
    "background",
    "config-only",
    "service-consent",
    "actor",
    "reason",
    "retain-package",
    "objective",
    "outside-directory",
    "poll-seconds",
    "credential-file",
    ...installFlags,
  ],
  readiness: ["credential-file", "outside-directory"],
  intake: [
    "service-consent",
    "actor",
    "reason",
    "poll-seconds",
    "objective",
    "priority-label",
    "watch",
  ],
  supervisor: [
    "intake",
    "objective",
    "cli",
    "credential-file",
    "service-credential",
  ],
  install: installFlags,
  run: ["objective", "deadline"],
  decide: ["objective", "plan", "outcome", "answer", "reason", "actor"],
  plan: ["objective", "output"],
  status: ["objective", "json"],
  diagnostics: ["objective", "follow", "summary"],
  captures: ["objective", "content"],
  logs: ["objective", "item", "follow"],
  rereview: ["objective", "item", "tree", "actor", "reason"],
  "decide-result": ["objective", "item", "tree", "outcome", "actor", "reason"],
  review: ["objective", "item", "set", "output"],
  select: ["objective", "item", "set", "actor", "reason", "bind"],
  "propose-amendment": ["objective", "proposal"],
  pause: ["objective"],
  drain: ["objective"],
  resume: ["objective"],
  cancel: ["objective"],
  repair: ["objective", "proposal"],
  retry: ["objective", "item"],
};
const removedFlags = ["source", "authority", "admission", "abandon"];

/** Refuse an option the command does not read, so a typo or removed flag never runs silently. */
export function assertKnownFlags(command: string, args: string[]): void {
  for (const arg of args) {
    if (!arg.startsWith("--")) continue;
    const name = arg.slice(2);
    if (removedFlags.includes(name))
      throw new Error(
        `${arg} was removed; Objectives declare their own sources and running is the consent (see factory help)`,
      );
    const allowed = commandFlags[command];
    if (allowed && name !== "config" && !allowed.includes(name))
      throw new Error(
        `Unknown option ${arg} for factory ${command}; see factory help`,
      );
  }
}
