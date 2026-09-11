import { readFileSync } from "node:fs";

import Ajv from "ajv";
import { describe, expect, it } from "vitest";

import { parsePersistedCompiledObjective } from "../src/graph.js";
import { parseWorkerPacket, type WorkerPacket } from "../src/protocol/worker-packet.js";
import { DEFERRED_CAPABILITY_ADAPTERS } from "../src/toolchains/authority.js";

const pnpmRuntime = DEFERRED_CAPABILITY_ADAPTERS.find(({ id }) => id === "node-pnpm")!.runtime!;

const packet: WorkerPacket = {
  goal: "Validate the capability.",
  acceptanceCriteria: ["The capability is validated."],
  allowedPaths: ["src/"],
  preconditions: [],
  outOfScope: [],
  conventions: [],
  baseSha: "a".repeat(40),
  validationCommands: ["pnpm check"],
  requirements: {
    os: ["linux"],
    architecture: [],
    tools: ["node", "pnpm"],
    services: [],
    networkDestinations: ["registry.npmjs.org"],
    permittedSecretNames: [],
    trust: "trusted_local",
  },
  repositoryCapabilities: {
    provides: [
      {
        adapter: "node-pnpm",
        generation: "node-pnpm/root",
        authorityPaths: ["package.json", "pnpm-lock.yaml"],
        operations: [{ kind: "package-script", key: "check" }],
        runtime: pnpmRuntime,
      },
    ],
    requires: [
      {
        adapter: "node-pnpm",
        generation: "node-pnpm/root",
        providerWorkItem: "root",
        authorityPaths: ["package.json", "pnpm-lock.yaml"],
        operation: { kind: "package-script", key: "check" },
        activation: "integrated-base",
        runtime: pnpmRuntime,
      },
    ],
  },
  managedRuntimes: [pnpmRuntime],
  artifactContract: "clockgrove.factory/artifact-v1",
};

describe("repository capability JSON Schema parity", () => {
  const schema = JSON.parse(
    readFileSync(new URL("../schemas/worker-packet.schema.json", import.meta.url), "utf8"),
  );
  const validate = new Ajv({ strict: false }).compile(schema);

  const acceptedByZod = (value: unknown) => {
    try {
      parseWorkerPacket(value);
      return true;
    } catch {
      return false;
    }
  };

  it("accepts the same canonical capability packet", () => {
    expect(validate(packet), JSON.stringify(validate.errors)).toBe(true);
    expect(acceptedByZod(packet)).toBe(true);
  });

  it.each([
    [
      "provision adapter",
      (value: WorkerPacket) => (value.repositoryCapabilities!.provides[0]!.adapter = "bad adapter"),
    ],
    [
      "provision generation",
      (value: WorkerPacket) =>
        (value.repositoryCapabilities!.provides[0]!.generation = "bad generation"),
    ],
    [
      "provision path",
      (value: WorkerPacket) =>
        (value.repositoryCapabilities!.provides[0]!.authorityPaths = ["../escape"]),
    ],
    [
      "operation kind",
      (value: WorkerPacket) =>
        (value.repositoryCapabilities!.provides[0]!.operations[0]!.kind = "bad kind"),
    ],
    [
      "operation key",
      (value: WorkerPacket) =>
        (value.repositoryCapabilities!.provides[0]!.operations[0]!.key = "bad key"),
    ],
    [
      "requirement adapter",
      (value: WorkerPacket) => (value.repositoryCapabilities!.requires[0]!.adapter = "bad adapter"),
    ],
    [
      "requirement generation",
      (value: WorkerPacket) =>
        (value.repositoryCapabilities!.requires[0]!.generation = "bad generation"),
    ],
    [
      "provider id",
      (value: WorkerPacket) =>
        (value.repositoryCapabilities!.requires[0]!.providerWorkItem = "bad provider"),
    ],
    [
      "requirement path",
      (value: WorkerPacket) =>
        (value.repositoryCapabilities!.requires[0]!.authorityPaths = ["root/*"]),
    ],
    [
      "activation",
      (value: WorkerPacket) =>
        ((value.repositoryCapabilities!.requires[0] as { activation: string }).activation =
          "later"),
    ],
  ])("rejects the same invalid %s", (_name, mutate) => {
    const value = structuredClone(packet);
    mutate(value);
    expect(validate(value)).toBe(false);
    expect(acceptedByZod(value)).toBe(false);
  });

  it("keeps the persisted Work Item schema reference aligned with runtime parsing", () => {
    const rootPacket = structuredClone(packet);
    rootPacket.allowedPaths = ["package.json", "pnpm-lock.yaml"];
    rootPacket.repositoryCapabilities!.requires[0] = {
      ...rootPacket.repositoryCapabilities!.requires[0]!,
      activation: "artifact",
    };
    const workItem = {
      id: "root",
      title: "Create the toolchain authority",
      goal: rootPacket.goal,
      acceptance: rootPacket.acceptanceCriteria,
      criterionRisks: [{ criterion: rootPacket.acceptanceCriteria[0]!, risk: "ordinary" as const }],
      scope: rootPacket.allowedPaths,
      preconditions: rootPacket.preconditions,
      outOfScope: rootPacket.outOfScope,
      conventions: rootPacket.conventions,
      dependsOn: [],
      baseSha: rootPacket.baseSha,
      validationCommands: rootPacket.validationCommands,
      requirements: rootPacket.requirements,
      repositoryCapabilities: rootPacket.repositoryCapabilities,
      managedRuntimes: rootPacket.managedRuntimes,
      artifactContract: rootPacket.artifactContract,
    };
    const workerSchema = JSON.parse(
      readFileSync(new URL("../schemas/worker-packet.schema.json", import.meta.url), "utf8"),
    );
    const workItemSchema = JSON.parse(
      readFileSync(new URL("../schemas/work-item.schema.json", import.meta.url), "utf8"),
    );
    const ajv = new Ajv({ strict: false });
    ajv.addSchema(workerSchema);
    const validateWorkItem = ajv.compile(workItemSchema);
    expect(validateWorkItem(workItem), JSON.stringify(validateWorkItem.errors)).toBe(true);
    expect(() =>
      parsePersistedCompiledObjective({ title: "Capability", workItems: [workItem] }),
    ).not.toThrow();

    const invalid = structuredClone(workItem);
    invalid.repositoryCapabilities!.requires[0]!.authorityPaths = ["../escape"];
    expect(validateWorkItem(invalid)).toBe(false);
    expect(() =>
      parsePersistedCompiledObjective({ title: "Capability", workItems: [invalid] }),
    ).toThrow();
  });
});
