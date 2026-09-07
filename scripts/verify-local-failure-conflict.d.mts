import type {
  CheckpointAuthority,
  CheckpointExtension,
  CheckpointPort,
} from "./verify-local-checkpoint-restart.mjs";
import type { FailureCase, FailureContentProof } from "./qualification-failure-conflict.mjs";
export interface FailureAuthority extends CheckpointAuthority {
  failure: { scenario: FailureCase; baseSha: string; fixtureDigest: string };
}
export interface FailurePort extends CheckpointPort {
  contentProof(
    observation: unknown,
    witness?: unknown,
  ): Promise<{ summary: unknown; objects: FailureContentProof }>;
  noPublication(): Promise<void>;
  stopOriginal(original: unknown): Promise<void>;
  compete(held: unknown, content: unknown): Promise<unknown>;
  assertCompeting(competing: unknown): Promise<void>;
  refusal(producer: unknown, competing: unknown): Promise<unknown>;
}
export function failureAuthority(env: Record<string, string | undefined>): FailureAuthority | null;
export function failureExtension(authority: FailureAuthority): CheckpointExtension;
export function runFailureScenario(
  port: FailurePort,
  authority: FailureAuthority,
): Promise<unknown>;
export function assertRefusalJournal(
  rows: unknown,
  authority: { namespace: string },
  competing: { branch: string; before: string; after: string; observedAt: string },
  producer: { invocationId: string },
): Record<string, unknown>;
export function main(env?: Record<string, string | undefined>): Promise<void>;
