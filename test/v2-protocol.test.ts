import { describe, expect, it } from "vitest";

import {
  type FactoryEvent,
  parseFactoryEvent,
} from "../src/protocol/events.js";
import { PROTOCOL_V2 } from "../src/protocol/limits.js";
import {
  DEFAULT_RUN_POLICY,
  assertRequirementsWithinPolicy,
  destinationAllowedByPolicy,
  parseRunPolicy,
  policyDigest,
} from "../src/protocol/policy.js";
import { parseWorkerPacket } from "../src/protocol/worker-packet.js";
import {
  decodeEventComments,
  decodeEventTrailer,
  encodeEventComment,
  encodeEventTrailer,
  latestSupportedRun,
} from "../src/control/receipts.js";

const SHA = "a".repeat(40);

function runStarted(over: Partial<FactoryEvent> = {}): FactoryEvent {
  return {
    protocol: PROTOCOL_V2,
    kind: "run",
    event: "FactoryRunStarted",
    objective: 42,
    runId: "run-1",
    sequence: 1,
    at: "2026-09-03T00:00:00.000Z",
    actor: "operator",
    repository: "clockgrove/factory",
    objectiveAuthor: "operator",
    fork: false,
    baseBranch: "main",
    policy: DEFAULT_RUN_POLICY,
    policyDigest: policyDigest(DEFAULT_RUN_POLICY),
    ...over,
  } as FactoryEvent;
}

describe("v2 run policy", () => {
  it("defaults to local-only execution with bounded parallelism", () => {
    expect(DEFAULT_RUN_POLICY.backendOrder).toEqual(["codex-cli/local-worktree"]);
    expect(DEFAULT_RUN_POLICY.maxParallel).toBe(2);
    expect(DEFAULT_RUN_POLICY.allowedPaidBackends).toEqual([]);
    expect(DEFAULT_RUN_POLICY.cloudFallback).toBe("never");
  });

  it("rejects a paid backend that was not explicitly allowed", () => {
    expect(() =>
      parseRunPolicy({
        ...DEFAULT_RUN_POLICY,
        backendOrder: ["codex-cli/daytona"],
        cloudFallback: "explicit",
        maxSandboxMinutes: 60,
      }),
    ).toThrow(/not explicitly allowed/);
  });

  it("rejects a sandbox selection with no sandbox budget", () => {
    expect(() =>
      parseRunPolicy({
        ...DEFAULT_RUN_POLICY,
        backendOrder: ["codex-cli/daytona"],
        allowedPaidBackends: ["codex-cli/daytona"],
        cloudFallback: "explicit",
      }),
    ).toThrow(/zero sandbox-minute budget/);
  });

  it("creates a stable digest independent of object key order", () => {
    const reversed = Object.fromEntries(Object.entries(DEFAULT_RUN_POLICY).reverse());
    expect(policyDigest(parseRunPolicy(reversed))).toBe(policyDigest(DEFAULT_RUN_POLICY));
  });

  it("keeps compiler-requested network and secret authority inside operator policy", () => {
    expect(
      destinationAllowedByPolicy("cdn.npmjs.org", DEFAULT_RUN_POLICY.allowedNetworkDestinations),
    ).toBe(true);
    expect(
      destinationAllowedByPolicy("npmjs.org", DEFAULT_RUN_POLICY.allowedNetworkDestinations),
    ).toBe(false);
    const requirements = {
      os: [], architecture: [], tools: [], services: [],
      networkDestinations: ["attacker.example"], permittedSecretNames: [],
      trust: "isolated" as const,
    };
    expect(() => assertRequirementsWithinPolicy(requirements, DEFAULT_RUN_POLICY)).toThrow(
      /outside run policy/,
    );
    expect(() =>
      assertRequirementsWithinPolicy(
        { ...requirements, networkDestinations: [], permittedSecretNames: ["DEPLOY_KEY"] },
        DEFAULT_RUN_POLICY,
      ),
    ).toThrow(/unsupported task secrets/);
  });
});

describe("v2 event protocol", () => {
  it("round-trips comment and commit-trailer envelopes", () => {
    const event = runStarted();
    expect(decodeEventComments(encodeEventComment("Factory started.", event))).toEqual([
      event,
    ]);
    expect(decodeEventTrailer(`subject\n\n${encodeEventTrailer(event)}`)).toEqual(event);
  });

  it("ignores unknown fields from a future writer on the same protocol", () => {
    const event = parseFactoryEvent({ ...runStarted(), futureEvidence: { value: 1 } });
    expect(event.futureEvidence).toEqual({ value: 1 });
  });

  it("fails closed on an unsupported protocol", () => {
    expect(() =>
      parseFactoryEvent({ ...runStarted(), protocol: "clockgrove.factory/v3" }),
    ).toThrow();
  });

  it("rejects suspected credentials before persistence", () => {
    expect(() =>
      parseFactoryEvent({
        ...runStarted(),
        actor: `ghp_${"x".repeat(40)}`,
      }),
    ).toThrow(/suspected GitHub token/);
  });

  it("finds the newest non-terminal run", () => {
    const old = runStarted({ runId: "old", sequence: 1 });
    const stopped = runStarted({
      runId: "old",
      sequence: 2,
      event: "FactoryRunCancelled",
    });
    const current = runStarted({ runId: "current", sequence: 3 });
    expect(latestSupportedRun([current, stopped, old])?.runId).toBe("current");
  });

  it("keeps a run active after a cancellation request until terminal acknowledgement", () => {
    const started = runStarted();
    const requested = parseFactoryEvent({
      protocol: PROTOCOL_V2,
      kind: "run",
      event: "FactoryRunCancellationRequested",
      objective: 42,
      runId: "run-1",
      sequence: 2,
      at: "2026-09-03T00:01:00.000Z",
      requestedBy: "operator",
      requestId: "cancel-1",
    });
    expect(latestSupportedRun([started, requested])?.event).toBe("FactoryRunStarted");
  });
});

describe("Worker Packet", () => {
  it("accepts a bounded local packet", () => {
    const packet = parseWorkerPacket({
      goal: "Add invitation persistence.",
      acceptanceCriteria: ["Invitations survive a restart."],
      allowedPaths: ["src/invitations/", "test/invitations.test.ts"],
      preconditions: [],
      outOfScope: ["Email delivery"],
      conventions: ["Use the existing repository adapter."],
      baseSha: SHA,
      validationCommands: ["npm test -- invitations"],
      requirements: { trust: "trusted_local" },
      artifactContract: "clockgrove.factory/artifact-v1",
    });
    expect(packet.requirements.networkDestinations).toEqual([]);
  });

  it("rejects secret values while permitting secret names", () => {
    const base = {
      goal: "Use the mail provider.",
      acceptanceCriteria: ["Mail is sent."],
      allowedPaths: ["src/mail.ts"],
      baseSha: SHA,
      validationCommands: ["npm test"],
      requirements: {
        trust: "isolated",
        permittedSecretNames: ["OPENAI_API_KEY"],
      },
      artifactContract: "clockgrove.factory/artifact-v1",
    };
    expect(parseWorkerPacket(base).requirements.permittedSecretNames).toEqual([
      "OPENAI_API_KEY",
    ]);
    expect(() =>
      parseWorkerPacket({ ...base, conventions: [`sk-${"x".repeat(40)}`] }),
    ).toThrow(/suspected OpenAI API key/);
  });

  it("rejects absolute, traversing, and glob scope entries", () => {
    const base = {
      goal: "Change one file.",
      acceptanceCriteria: ["The change is tested."],
      baseSha: SHA,
      validationCommands: ["npm test"],
      requirements: { trust: "trusted_local" },
      artifactContract: "clockgrove.factory/artifact-v1",
    };
    for (const path of ["/etc/passwd", "../outside", "src/*", "src\\file.ts"]) {
      expect(() => parseWorkerPacket({ ...base, allowedPaths: [path] })).toThrow(/scope/i);
    }
  });
});
