import type { WorkerPacket } from "../protocol/worker-packet.js";

export interface ValidationPlan {
  commands: string[];
  timeoutMsPerCommand: number;
  isolation: "local" | "isolated";
}

const FORBIDDEN_VALIDATION_RUNNERS = new Set([
  "bash",
  "cmd",
  "git",
  "npx",
  "powershell",
  "pwsh",
  "sh",
  "zsh",
]);

export function assertSafeValidationCommand(
  command: string,
  declaredTools: string[],
): void {
  if (/[\n\r;&|<>`]/.test(command) || command.includes("$(")) {
    throw new Error(`validation command contains shell control syntax: ${command}`);
  }
  const match = /^([A-Za-z0-9_.+-]+)(?:\s|$)/.exec(command.trim());
  if (!match?.[1]) {
    throw new Error(`validation command must start with a simple executable name: ${command}`);
  }
  const executable = match[1];
  if (FORBIDDEN_VALIDATION_RUNNERS.has(executable.toLowerCase())) {
    throw new Error(`validation command may not use ${executable} as its runner`);
  }
  if (executable !== "test" && !declaredTools.includes(executable)) {
    throw new Error(
      `validation command runner ${executable} is absent from execution requirements`,
    );
  }
  const tokens = command.trim().split(/\s+/);
  if (
    ["node", "python", "python3", "ruby", "perl"].includes(executable) &&
    tokens.some((token) => ["-c", "-e", "--eval", "--print"].includes(token))
  ) {
    throw new Error(`validation command may not use an interpreter evaluation flag: ${command}`);
  }
  if (
    ["npm", "pnpm", "yarn", "bun"].includes(executable) &&
    ["exec", "x", "dlx"].includes(tokens[1] ?? "")
  ) {
    throw new Error(`validation command may not download or execute an arbitrary package: ${command}`);
  }
}

export function validationPlanFromPacket(packet: WorkerPacket): ValidationPlan {
  if (packet.validationCommands.length === 0) {
    throw new Error("Worker Packet has no validation commands");
  }
  for (const command of packet.validationCommands) {
    assertSafeValidationCommand(command, packet.requirements.tools);
  }
  return {
    commands: [...packet.validationCommands],
    timeoutMsPerCommand: Math.min(
      (packet.requirements.timeoutMinutes ?? 30) * 60_000,
      60 * 60_000,
    ),
    isolation: packet.requirements.trust === "trusted_local" ? "local" : "isolated",
  };
}
