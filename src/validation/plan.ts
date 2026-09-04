import { createHash } from "node:crypto";

import type { WorkerPacket } from "../protocol/worker-packet.js";
import type { ValidationEvidence } from "./evidence.js";

export interface ValidationPlan {
  commands: string[];
  timeoutMsPerCommand: number;
  isolation: "local" | "isolated";
}

export interface ExactHeadValidationEvidence {
  protocol: "clockgrove.factory/exact-head-validation-v1";
  validationDigest: string;
  baseSha: string;
  outputTreeSha: string;
  publishedHeadSha: string;
  digest: string;
}

function exactHeadDigest(
  evidence: Omit<ExactHeadValidationEvidence, "digest">,
): string {
  return createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
}

/**
 * Bind an independently validated tree to the exact immutable commit that is
 * published. The binding is intentionally separate from the commit message,
 * avoiding a circular commit-SHA/evidence-digest dependency.
 */
export function bindValidationToPublishedHead(args: {
  validation: Pick<
    ValidationEvidence,
    "passed" | "digest" | "baseSha" | "outputTreeSha"
  >;
  publishedHeadSha: string;
  publishedTreeSha: string;
  publishedBaseSha: string;
}): ExactHeadValidationEvidence {
  if (!args.validation.passed) throw new Error("cannot bind failed validation");
  if (args.publishedTreeSha !== args.validation.outputTreeSha) {
    throw new Error("published head tree differs from independently validated tree");
  }
  if (args.publishedBaseSha !== args.validation.baseSha) {
    throw new Error("published head base differs from independently validated base");
  }
  if (!/^[0-9a-f]{40}$/i.test(args.publishedHeadSha)) {
    throw new Error("published head SHA is invalid");
  }
  const evidence = {
    protocol: "clockgrove.factory/exact-head-validation-v1" as const,
    validationDigest: args.validation.digest,
    baseSha: args.validation.baseSha,
    outputTreeSha: args.validation.outputTreeSha,
    publishedHeadSha: args.publishedHeadSha,
  };
  return { ...evidence, digest: exactHeadDigest(evidence) };
}

export function verifyExactHeadValidation(
  evidence: ExactHeadValidationEvidence,
  expectedHeadSha: string,
): void {
  if (
    !/^[0-9a-f]{64}$/i.test(evidence.validationDigest) ||
    !/^[0-9a-f]{64}$/i.test(evidence.digest) ||
    ![evidence.baseSha, evidence.outputTreeSha, evidence.publishedHeadSha].every(
      (value) => /^[0-9a-f]{40}$/i.test(value),
    )
  ) {
    throw new Error("exact-head validation evidence is malformed");
  }
  const { digest, ...withoutDigest } = evidence;
  if (digest !== exactHeadDigest(withoutDigest)) {
    throw new Error("exact-head validation evidence digest mismatch");
  }
  if (evidence.publishedHeadSha !== expectedHeadSha) {
    throw new Error("validation evidence does not name the exact published head SHA");
  }
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
