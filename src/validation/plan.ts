import { createHash } from "node:crypto";

import type { WorkerPacket } from "../protocol/worker-packet.js";
import {
  futurePackageScriptCommand,
  PACKAGE_SETUP_REGISTRY,
  PNPM_VALIDATION_SETUP_COMMAND,
  PNPM_VERSION_COMMAND,
  validationSetupCommandCount,
} from "../toolchains/authority.js";
import type { ValidationEvidence } from "./evidence.js";
import { runtimeBundleByDigestSync } from "../runtime/toolchain-store.js";

function managedPnpmVersion(packet?: WorkerPacket): string {
  const digests = new Set(
    (packet?.managedRuntimes ?? []).flatMap((runtime) =>
      runtime?.tool === "pnpm" && runtime.bundleDigest ? [runtime.bundleDigest] : [],
    ),
  );
  if (digests.size !== 1)
    throw new Error(
      `pnpm validation lacks one exact activated runtime; observed ${JSON.stringify(packet?.managedRuntimes ?? [])}`,
    );
  const receipt = runtimeBundleByDigestSync("pnpm", [...digests][0]!);
  const component = receipt.components.find(({ id }) => id === "pnpm");
  if (!component) throw new Error("pnpm runtime bundle lacks its executable component");
  return component.version;
}

export interface ValidationPlan {
  commands: string[];
  timeoutMsPerCommand: number;
  isolation: "local" | "isolated";
}

export { NPM_VALIDATION_SETUP_COMMAND } from "../toolchains/authority.js";
export const PNPM_BOOTSTRAP_VERSION_COMMAND = PNPM_VERSION_COMMAND;
export const PNPM_BOOTSTRAP_VALIDATION_SETUP_COMMAND = PNPM_VALIDATION_SETUP_COMMAND;
export const PNPM_BOOTSTRAP_REGISTRY = PACKAGE_SETUP_REGISTRY;

export type BootstrapPackageValidationCommand = {
  manager: "pnpm";
  script: string;
};

/**
 * Recognize only finite package-script entry points. The script body remains
 * untrusted until clean validation inspects the materialized package manifests.
 */
export function bootstrapPackageValidationCommand(
  command: string,
): BootstrapPackageValidationCommand | null {
  const parsed = futurePackageScriptCommand(command);
  return parsed?.manager === "pnpm" ? { manager: "pnpm", script: parsed.script } : null;
}

/** Upper bound reserved for trusted-local validation scopes. npm may consume
 * one setup command; pnpm always proves the bundled version and installs once. */
export function validationLocalCommandCount(packet: WorkerPacket): number {
  return (
    packet.validationCommands.length +
    validationSetupCommandCount(packet.validationCommands, packet.repositoryCapabilities)
  );
}

/** Verify that every finite pnpm command is supplied by the exact immutable
 * execution base. This is intentionally cheap enough to run before admission;
 * clean validation later repeats the deeper lock/configuration inspection. */
export function assertPnpmCommandsGroundedOnManifest(
  packet: WorkerPacket,
  manifestText: string,
): boolean {
  const declared = packet.validationCommands.filter((command) => /^pnpm(?:\s|$)/.test(command));
  if (declared.length === 0) return false;
  const parsed = declared.map((command) => bootstrapPackageValidationCommand(command));
  if (parsed.some((command) => command === null))
    throw new Error("pnpm validation command is outside the finite script contract");
  if (!packet.requirements.tools.includes("pnpm"))
    throw new Error("pnpm validation is missing its declared tool requirement");
  if (!packet.requirements.networkDestinations.includes(PNPM_BOOTSTRAP_REGISTRY))
    throw new Error("pnpm validation is missing registry.npmjs.org setup authority");
  if (Buffer.byteLength(manifestText) > 256 * 1024)
    throw new Error("pnpm execution-base package.json exceeds the inspection bound");
  let value: unknown;
  try {
    value = JSON.parse(manifestText);
  } catch {
    throw new Error("pnpm execution-base package.json is invalid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("pnpm execution-base package.json is invalid");
  const manifest = value as { packageManager?: unknown; scripts?: unknown };
  const version = managedPnpmVersion(packet);
  if (manifest.packageManager !== `pnpm@${version}`)
    throw new Error(`pnpm execution base must pin packageManager to pnpm@${version}`);
  if (!manifest.scripts || typeof manifest.scripts !== "object" || Array.isArray(manifest.scripts))
    throw new Error("pnpm execution base has no valid script map");
  const scripts = manifest.scripts as Record<string, unknown>;
  for (const command of parsed) {
    const script = command!.script;
    if (typeof scripts[script] !== "string" || scripts[script].length === 0)
      throw new Error(`pnpm validation script is absent on execution base: ${script}`);
    if (scripts[`pre${script}`] !== undefined || scripts[`post${script}`] !== undefined)
      throw new Error(`pnpm validation script has lifecycle hooks on execution base: ${script}`);
  }
  return true;
}

export interface ExactHeadValidationEvidence {
  protocol: "clockgrove.factory/exact-head-validation-v1";
  validationDigest: string;
  baseSha: string;
  outputTreeSha: string;
  publishedHeadSha: string;
  digest: string;
}

function exactHeadDigest(evidence: Omit<ExactHeadValidationEvidence, "digest">): string {
  return createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
}

/**
 * Bind an independently validated tree to the exact immutable commit that is
 * published. The binding is intentionally separate from the commit message,
 * avoiding a circular commit-SHA/evidence-digest dependency.
 */
export function bindValidationToPublishedHead(args: {
  validation: Pick<ValidationEvidence, "passed" | "digest" | "baseSha" | "outputTreeSha">;
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
    ![evidence.baseSha, evidence.outputTreeSha, evidence.publishedHeadSha].every((value) =>
      /^[0-9a-f]{40}$/i.test(value),
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

export function assertSafeValidationCommand(command: string, declaredTools: string[]): void {
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
    throw new Error(
      `validation command may not download or execute an arbitrary package: ${command}`,
    );
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
    timeoutMsPerCommand: Math.min((packet.requirements.timeoutMinutes ?? 30) * 60_000, 60 * 60_000),
    isolation: packet.requirements.trust === "trusted_local" ? "local" : "isolated",
  };
}
