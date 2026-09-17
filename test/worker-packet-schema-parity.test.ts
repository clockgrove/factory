import { readFileSync } from "node:fs";

import Ajv from "ajv";
import { describe, expect, it } from "vitest";

import { parsePersistedCompiledObjective } from "../src/graph.js";
import { parseWorkerPacket, type WorkerPacket } from "../src/protocol/worker-packet.js";
import { DEFERRED_CAPABILITY_ADAPTERS } from "../src/toolchains/authority.js";
import { projectCompilerProposal } from "../src/compiler/proposal.js";
import { compilerEvalDigest } from "../src/evaluation/compiler-eval.js";
import {
  semanticPinnedFacts,
  semanticProposal,
  semanticRequest,
} from "./helpers/semantic-compiler.js";
import { DEFAULT_RUN_POLICY } from "../src/protocol/policy.js";

const pnpmRuntime = DEFERRED_CAPABILITY_ADAPTERS.find(({ id }) => id === "node-pnpm")!.runtime!;

const packet: WorkerPacket = {
  protocol: "clockgrove.factory/worker-packet",
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
  deliverable: {
    kind: "repository-change" as const,
    contract: "clockgrove.factory/artifact" as const,
  },
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

  it("preserves distinct media uses while deduplicating immutable transport inputs", () => {
    const descriptorDigest = "1".repeat(64);
    const withUses = {
      ...structuredClone(packet),
      assetInputs: [
        {
          manifestDigest: "2".repeat(64),
          descriptorDigest,
          contentDigest: "3".repeat(64),
          storageReceiptDigest: "4".repeat(64),
          path: `assets/${"3".repeat(64)}/reference.png`,
        },
      ],
      mediaUses: [
        {
          source: "imported",
          intentId: "layout-input",
          role: "layout-reference",
          inputRoleId: null,
          brief: "Use the reference for implementation layout.",
          purpose: "implementation-reference",
          necessity: "required",
          obligationIds: ["layout"],
          rationale: "The layout must follow the reference.",
          direction: "input-to",
          criterionIds: [],
          descriptorDigests: [descriptorDigest],
          manifestDigest: "2".repeat(64),
        },
        {
          source: "imported",
          intentId: "layout-evidence",
          role: "acceptance-capture",
          inputRoleId: null,
          brief: "Use the same bytes as acceptance evidence.",
          purpose: "acceptance-evidence",
          necessity: "required",
          obligationIds: ["visual-proof"],
          rationale: "The criterion requires exact visual evidence.",
          direction: "evidence-for",
          criterionIds: ["visual-proof"],
          descriptorDigests: [descriptorDigest],
          manifestDigest: "2".repeat(64),
        },
      ],
    };
    expect(validate(withUses), JSON.stringify(validate.errors)).toBe(true);
    const parsed = parseWorkerPacket(withUses);
    expect(parsed.assetInputs).toHaveLength(1);
    expect(parsed.deliverable.kind).toBe("repository-change");
    if (parsed.deliverable.kind === "repository-change") expect(parsed.mediaUses).toHaveLength(2);
  });

  it("accepts the same format-neutral repository capture recipe", () => {
    const descriptorDigest = "1".repeat(64);
    const contentDigest = "3".repeat(64);
    const recipeCore = {
      id: "capture-result",
      mediaUse: { intentId: "result-evidence", direction: "evidence-for" as const },
      criterionIds: ["validated"],
      scenario: { id: "fixture", fixture: "fixtures/result.bin", seed: null },
      captureCommand: {
        recipeId: "recipe-capture",
        recipeDigest: "5".repeat(64),
        command: "npm run capture",
      },
      outputs: [{ roleId: "capture", mediaType: "application/octet-stream" }],
      profile: null,
      comparison: {
        kind: "exact" as const,
        outputRoleId: "capture",
        expectedDescriptorDigest: descriptorDigest,
        policy: { kind: "exact-bytes" as const },
      },
      gate: { kind: "human-required" as const },
    };
    const withRecipe = {
      ...structuredClone(packet),
      validationCommands: [...packet.validationCommands, "npm run capture"],
      assetInputs: [
        {
          manifestDigest: "2".repeat(64),
          descriptorDigest,
          contentDigest,
          storageReceiptDigest: "4".repeat(64),
          path: `assets/${contentDigest}/result.bin`,
        },
      ],
      mediaUses: [
        {
          source: "imported" as const,
          intentId: "result-evidence",
          role: "acceptance-capture",
          inputRoleId: null,
          brief: "Capture one exact repository result.",
          purpose: "acceptance-evidence" as const,
          necessity: "required" as const,
          obligationIds: ["validated"],
          rationale: "The criterion requires exact bytes.",
          direction: "evidence-for" as const,
          criterionIds: ["validated"],
          descriptorDigests: [descriptorDigest],
          manifestDigest: "2".repeat(64),
        },
      ],
      repositoryCaptureRecipes: [{ ...recipeCore, digest: compilerEvalDigest(recipeCore) }],
    };
    expect(validate(withRecipe), JSON.stringify(validate.errors)).toBe(true);
    expect(acceptedByZod(withRecipe)).toBe(true);
    expect(withRecipe.repositoryCaptureRecipes[0]!.comparison).not.toHaveProperty("command");

    expect(
      acceptedByZod({
        ...withRecipe,
        validationCommands: ["npm run capture", ...packet.validationCommands],
      }),
    ).toBe(false);

    const conflictingCore = {
      ...recipeCore,
      id: "capture-result-again",
      captureCommand: {
        ...recipeCore.captureCommand,
        recipeId: "recipe-capture-again",
      },
    };
    expect(
      acceptedByZod({
        ...withRecipe,
        repositoryCaptureRecipes: [
          ...withRecipe.repositoryCaptureRecipes,
          { ...conflictingCore, digest: compilerEvalDigest(conflictingCore) },
        ],
      }),
    ).toBe(false);
  });

  it("accepts raster capture acceptance constraints in JSON and Zod schemas", () => {
    const descriptorDigest = "1".repeat(64);
    const contentDigest = "3".repeat(64);
    const recipeCore = {
      id: "capture-raster",
      mediaUse: { intentId: "raster-evidence", direction: "evidence-for" as const },
      criterionIds: ["validated"],
      scenario: { id: "desktop", fixture: null, seed: "fixed" },
      captureCommand: {
        recipeId: "recipe-raster",
        recipeDigest: "5".repeat(64),
        command: "npm run capture",
      },
      outputs: [{ roleId: "capture", mediaType: "image/png" }],
      profile: {
        kind: "raster" as const,
        viewport: { width: 1280, height: 720 },
        output: { width: 800, height: 600 },
        captureRoleId: "capture",
        diffRoleId: null,
        previewRoleId: null,
        constraints: {
          kind: "raster" as const,
          minimumWidth: 640,
          maximumWidth: 1024,
          minimumHeight: 480,
          maximumHeight: 768,
          alpha: "allowed" as const,
          animation: "forbidden" as const,
        },
      },
      comparison: {
        kind: "exact" as const,
        outputRoleId: "capture",
        expectedDescriptorDigest: descriptorDigest,
        policy: { kind: "exact-bytes" as const },
      },
      gate: { kind: "human-required" as const },
    };
    const withRecipe = {
      ...structuredClone(packet),
      validationCommands: [...packet.validationCommands, "npm run capture"],
      assetInputs: [
        {
          manifestDigest: "2".repeat(64),
          descriptorDigest,
          contentDigest,
          storageReceiptDigest: "4".repeat(64),
          path: `assets/${contentDigest}/result.png`,
        },
      ],
      mediaUses: [
        {
          source: "imported" as const,
          intentId: "raster-evidence",
          role: "acceptance-capture",
          inputRoleId: null,
          brief: "Capture one raster repository result.",
          purpose: "acceptance-evidence" as const,
          necessity: "required" as const,
          obligationIds: ["validated"],
          rationale: "The criterion requires raster evidence.",
          direction: "evidence-for" as const,
          criterionIds: ["validated"],
          descriptorDigests: [descriptorDigest],
          manifestDigest: "2".repeat(64),
        },
      ],
      repositoryCaptureRecipes: [{ ...recipeCore, digest: compilerEvalDigest(recipeCore) }],
    };
    expect(validate(withRecipe), JSON.stringify(validate.errors)).toBe(true);
    expect(acceptedByZod(withRecipe)).toBe(true);
  });

  it("accepts the strict asset-production shape and rejects repository and retired fields", () => {
    const intent = {
      id: "primary-media",
      role: "layout-reference" as const,
      purpose: "implementation-reference" as const,
      necessity: "required" as const,
      obligationIds: ["visual-contract"],
      rationale: "The implementation needs an exact visual reference.",
      brief: "Produce a bounded interface wireframe.",
      fulfillment: { kind: "produced" as const, inputRoleBindings: [] },
      output: {
        mediaTypes: ["image/png" as const],
        minimumCount: 1,
        maximumCount: 1,
        profile: {
          kind: "raster" as const,
          minimumWidth: 640,
          maximumWidth: 1024,
          minimumHeight: 480,
          maximumHeight: 768,
          alpha: "allowed" as const,
          animation: "forbidden" as const,
        },
      },
      review: { kind: "human-required" as const },
      repositoryCapture: null,
      bindings: [{ workItemId: "consumer", direction: "input-to" as const, criterionIds: [] }],
    };
    const assetPacket: WorkerPacket = {
      protocol: "clockgrove.factory/worker-packet",
      goal: "Produce the approved visual reference.",
      acceptanceCriteria: ["One immutable PNG variant satisfies the media intent."],
      allowedPaths: [],
      preconditions: [],
      outOfScope: [],
      conventions: [],
      baseSha: "a".repeat(40),
      validationCommands: [],
      requirements: {
        os: ["linux"],
        architecture: [],
        tools: [],
        services: [],
        networkDestinations: [],
        permittedSecretNames: [],
        trust: "managed",
      },
      deliverable: {
        kind: "asset-production",
        contract: "clockgrove.factory/asset-set",
        intent,
        producerCapabilityId: "raster-producer",
        producerCapabilityDigest: "1".repeat(64),
        activationSelection: { minimumCount: 1, maximumCount: 1 },
      },
    };
    expect(validate(assetPacket), JSON.stringify(validate.errors)).toBe(true);
    expect(acceptedByZod(assetPacket)).toBe(true);

    const repositoryField = { ...structuredClone(assetPacket), context: {} };
    expect(validate(repositoryField)).toBe(false);
    expect(acceptedByZod(repositoryField)).toBe(false);
    const retired = {
      ...structuredClone(packet),
      artifactContract: "clockgrove.factory/artifact",
    };
    delete (retired as Partial<typeof retired>).deliverable;
    expect(validate(retired)).toBe(false);
    expect(acceptedByZod(retired)).toBe(false);

    const workItemSchema = JSON.parse(
      readFileSync(new URL("../schemas/work-item.schema.json", import.meta.url), "utf8"),
    );
    const ajv = new Ajv({ strict: false });
    ajv.addSchema(schema);
    const validateWorkItem = ajv.compile(workItemSchema);
    const workItem = {
      id: "asset-primary-media",
      title: "Produce the interface wireframe",
      goal: assetPacket.goal,
      acceptance: assetPacket.acceptanceCriteria,
      scope: [],
      preconditions: [],
      outOfScope: [],
      conventions: [],
      dependsOn: [],
      baseSha: assetPacket.baseSha,
      validationCommands: [],
      requirements: assetPacket.requirements,
      deliverable: assetPacket.deliverable,
    };
    expect(validateWorkItem(workItem), JSON.stringify(validateWorkItem.errors)).toBe(true);
    expect(() =>
      parsePersistedCompiledObjective({ title: "Visual", workItems: [workItem] }),
    ).not.toThrow();
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
      deliverable: rootPacket.deliverable,
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

  it("accepts the current projected graph in the published Objective and Work Item schemas", () => {
    const pinned = semanticPinnedFacts();
    const request = semanticRequest(pinned);
    const proposal = semanticProposal(request);
    const graph = projectCompilerProposal({
      request,
      proposal,
      pinnedFacts: pinned,
      runPolicy: {
        ...DEFAULT_RUN_POLICY,
        workItemTimeoutMinutes: request.constraints.workItemTimeoutMinutes,
        allowedNetworkDestinations: request.constraints.allowedNetworkDestinations,
      },
    }).objective;
    const workerSchema = JSON.parse(
      readFileSync(new URL("../schemas/worker-packet.schema.json", import.meta.url), "utf8"),
    );
    const workItemSchema = JSON.parse(
      readFileSync(new URL("../schemas/work-item.schema.json", import.meta.url), "utf8"),
    );
    const objectiveSchema = JSON.parse(
      readFileSync(new URL("../schemas/objective.schema.json", import.meta.url), "utf8"),
    );
    const ajv = new Ajv({ strict: false });
    ajv.addSchema(workerSchema);
    ajv.addSchema(workItemSchema);
    const validateObjective = ajv.compile(objectiveSchema);
    expect(validateObjective(graph), JSON.stringify(validateObjective.errors)).toBe(true);
    expect(graph.workItems.every((item) => ajv.validate(workItemSchema.$id, item))).toBe(true);
    expect(parsePersistedCompiledObjective(graph)).toEqual(graph);
  });
});
