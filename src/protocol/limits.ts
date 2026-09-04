import { z } from "zod";

export const PROTOCOL_V2 = "clockgrove.factory/v2" as const;
export const MAX_PERSISTED_EVENT_BYTES = 64 * 1024;
export const MAX_WORKER_PACKET_BYTES = 128 * 1024;
export const MAX_LOG_BYTES = 64 * 1024;

export const boundedText = (max: number) => z.string().min(1).max(max);
export const safeId = boundedText(160).regex(/^[A-Za-z0-9._:/+-]+$/);
export const gitSha = z.string().regex(/^[0-9a-f]{40}$/i);
export const sha256Digest = z.string().regex(/^[0-9a-f]{64}$/i);
export const isoDate = z.string().datetime({ offset: true });

const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ["GitHub token", /\b(?:gh[opurs]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ["OpenAI API key", /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["authorization header", /\bauthorization\s*:\s*(?:bearer|basic)\s+\S+/i],
];

export function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function assertWithinBytes(value: unknown, limit: number, label: string): void {
  const size = byteLength(value);
  if (size > limit) {
    throw new Error(`${label} is ${size} bytes; maximum is ${limit}`);
  }
}

export function assertNoSecretMaterial(value: unknown, label: string): void {
  const serialized = JSON.stringify(value);
  for (const [name, pattern] of SECRET_PATTERNS) {
    if (pattern.test(serialized)) {
      throw new Error(`${label} contains suspected ${name}`);
    }
  }
}

export function validatePersistable(
  value: unknown,
  limit = MAX_PERSISTED_EVENT_BYTES,
  label = "Factory record",
): void {
  assertWithinBytes(value, limit, label);
  assertNoSecretMaterial(value, label);
}
