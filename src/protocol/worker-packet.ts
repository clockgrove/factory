import { z } from "zod";
import { createHash } from "node:crypto";
import { WorkerAssetInputSchema } from "../assets/contracts.js";
import { WorkerMediaIntentUseSchema } from "../media/contracts.js";
import {
  AssetProductionDeliverableSchema,
  GeneratedAssetRequirementSchema,
  MediaTypeSchema,
  RasterMediaConstraintsSchema,
  RepositoryChangeDeliverableSchema,
} from "../assets/media-intent.js";

import {
  MAX_WORKER_PACKET_BYTES,
  assertNoSecretMaterial,
  assertWithinBytes,
  boundedText,
  gitSha,
  safeId,
  sha256Digest,
} from "./limits.js";

const shortList = (item: z.ZodTypeAny, max = 64) => z.array(item).max(max);
export const RepositoryScopePathSchema = boundedText(500).refine((value) => {
  if (
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("//") ||
    value.includes("*") ||
    value.includes("?") ||
    value.includes("[")
  )
    return false;
  const withoutTrailingSlash = value.endsWith("/") ? value.slice(0, -1) : value;
  return (
    withoutTrailingSlash.length > 0 &&
    withoutTrailingSlash.split("/").every((part) => part !== "." && part !== ".." && part !== "")
  );
}, "scope must be a repository-relative file or directory ending in '/', without traversal or globs");
export const NetworkDestinationSchema = boundedText(253)
  .regex(/^(?:\*\.)?(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/)
  .refine(
    (value) =>
      !value.toLowerCase().endsWith(".localhost") &&
      value.toLowerCase() !== "metadata.google.internal",
    "network destination may not target local or instance-metadata services",
  );

export const ExecutionRequirementsSchema = z
  .object({
    os: shortList(boundedText(40), 12).default([]),
    architecture: shortList(boundedText(40), 8).default([]),
    cpu: z.number().positive().max(256).optional(),
    memoryMb: z.number().int().positive().max(1_048_576).optional(),
    diskMb: z.number().int().positive().max(10_485_760).optional(),
    timeoutMinutes: z
      .number()
      .int()
      .positive()
      .max(24 * 60)
      .optional(),
    estimatedDurationMinutes: z
      .number()
      .int()
      .positive()
      .max(24 * 60)
      .optional(),
    tools: shortList(safeId).default([]),
    services: shortList(safeId).default([]),
    networkDestinations: shortList(NetworkDestinationSchema, 64).default([]),
    permittedSecretNames: shortList(z.string().regex(/^[A-Z][A-Z0-9_]{1,127}$/), 32).default([]),
    trust: z.enum(["trusted_local", "isolated", "managed"]),
    evidence: shortList(
      z
        .object({
          field: z.enum([
            "os",
            "architecture",
            "cpu",
            "memoryMb",
            "diskMb",
            "timeoutMinutes",
            "deliverable",
          ]),
          kind: z.enum(["repository", "run-policy", "factory-default"]),
          source: boundedText(500),
        })
        .strict(),
      16,
    ).optional(),
  })
  .passthrough();

export const RetryContextSchema = z.object({
  attempt: z.number().int().positive(),
  outcome: z.enum(["failed", "timed_out"]),
  reason: boundedText(2_000),
});

export const ContextManifestSchema = z
  .object({
    mustRead: shortList(RepositoryScopePathSchema).default([]),
    searchSeeds: shortList(boundedText(500)).default([]),
    dependencyEvidence: shortList(
      z
        .object({
          workItem: safeId,
          commit: gitSha,
        })
        .strict(),
    ).default([]),
  })
  .strict();

export const ChangeSurfaceSchema = z
  .object({
    mergeClass: z.enum(["parallel-safe", "exclusive", "generated", "large-binary"]),
    exclusiveResources: shortList(boundedText(200)).default([]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.mergeClass === "parallel-safe" && value.exclusiveResources.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["exclusiveResources"],
        message: "parallel-safe work cannot claim an exclusive resource",
      });
    }
  });

export const DeliveryHintSchema = z
  .object({
    group: safeId,
    relationship: z.enum(["root", "continue-stack", "sibling", "join-after-merge"]),
    parentWorkItem: safeId.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.relationship === "continue-stack" && !value.parentWorkItem) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["parentWorkItem"],
        message: "is required when continuing a stack",
      });
    }
    if (value.relationship !== "continue-stack" && value.parentWorkItem) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["parentWorkItem"],
        message: "is only valid when continuing a stack",
      });
    }
  });

export const ValidationDesignSchema = z
  .array(
    z
      .object({
        tier: z.enum(["mechanical", "semantic", "deterministic-simulation"]),
        criteria: shortList(boundedText(2_000)).min(1),
        rationale: boundedText(2_000).optional(),
        evidenceCommands: shortList(boundedText(1_000), 32).optional(),
      })
      .strict(),
  )
  .min(1)
  .max(4);

const RepositoryCommandIdentitySchema = z
  .object({
    recipeId: safeId,
    recipeDigest: sha256Digest,
    command: boundedText(1_000),
  })
  .strict();

const RepositoryCaptureOutputSchema = z
  .object({
    roleId: safeId,
    mediaType: MediaTypeSchema,
  })
  .strict();

export const RepositoryCaptureProfileSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("raster"),
      viewport: z
        .object({
          width: z.number().int().min(1).max(16_384),
          height: z.number().int().min(1).max(16_384),
        })
        .strict()
        .nullable(),
      output: z
        .object({
          width: z.number().int().min(1).max(16_384),
          height: z.number().int().min(1).max(16_384),
        })
        .strict()
        .nullable(),
      captureRoleId: safeId,
      diffRoleId: safeId.nullable(),
      previewRoleId: safeId.nullable(),
      constraints: RasterMediaConstraintsSchema,
    })
    .strict(),
]);

const RepositoryCaptureComparisonSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("exact"),
      outputRoleId: safeId,
      expectedDescriptorDigest: sha256Digest,
      policy: z.object({ kind: z.literal("exact-bytes") }).strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("threshold"),
      outputRoleId: safeId,
      command: RepositoryCommandIdentitySchema,
      expectedDescriptorDigest: sha256Digest,
      policy: z
        .object({
          kind: z.literal("bounded-difference"),
          metric: safeId,
          maximumDifference: z.number().finite().min(0),
        })
        .strict(),
    })
    .strict(),
]);

const RepositoryCaptureGateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("human-required") }).strict(),
  z.object({ kind: z.literal("deterministic-preauthorized"), ruleId: safeId }).strict(),
]);

const RepositoryCaptureRecipeCoreSchema = z
  .object({
    id: safeId,
    mediaUse: z.object({ intentId: safeId, direction: z.literal("evidence-for") }).strict(),
    criterionIds: shortList(safeId, 64).min(1),
    scenario: z
      .object({
        id: safeId,
        fixture: boundedText(500).nullable(),
        seed: boundedText(500).nullable(),
      })
      .strict(),
    captureCommand: RepositoryCommandIdentitySchema,
    outputs: shortList(RepositoryCaptureOutputSchema, 16).min(1),
    profile: RepositoryCaptureProfileSchema.nullable(),
    comparison: RepositoryCaptureComparisonSchema,
    gate: RepositoryCaptureGateSchema,
  })
  .strict();

export const RepositoryCaptureRecipeSchema = RepositoryCaptureRecipeCoreSchema.extend({
  digest: sha256Digest,
})
  .strict()
  .superRefine((value, context) => {
    const { digest, ...core } = value;
    if (digest !== createHash("sha256").update(canonicalJson(core)).digest("hex"))
      context.addIssue({
        code: "custom",
        path: ["digest"],
        message: "capture recipe digest mismatch",
      });
    if (value.scenario.fixture !== null && value.scenario.seed !== null)
      context.addIssue({
        code: "custom",
        path: ["scenario"],
        message: "scenario may bind a fixture or seed, not both",
      });
    if (new Set(value.criterionIds).size !== value.criterionIds.length)
      context.addIssue({
        code: "custom",
        path: ["criterionIds"],
        message: "capture criteria are duplicated",
      });
    const roles = value.outputs.map(({ roleId }) => roleId);
    if (new Set(roles).size !== roles.length)
      context.addIssue({
        code: "custom",
        path: ["outputs"],
        message: "capture output roles are duplicated",
      });
    if (value.profile)
      for (const roleId of [
        value.profile.captureRoleId,
        value.profile.diffRoleId,
        value.profile.previewRoleId,
      ])
        if (roleId !== null && !roles.includes(roleId))
          context.addIssue({
            code: "custom",
            path: ["profile"],
            message: "raster profile references an undeclared output role",
          });
    if (!roles.includes(value.comparison.outputRoleId))
      context.addIssue({
        code: "custom",
        path: ["comparison", "outputRoleId"],
        message: "capture comparison references an undeclared output role",
      });
    if (value.profile && value.profile.captureRoleId !== value.comparison.outputRoleId)
      context.addIssue({
        code: "custom",
        path: ["comparison", "outputRoleId"],
        message: "raster capture and comparison output roles differ",
      });
  });

export const CriterionRiskAssessmentSchema = z
  .array(
    z
      .object({
        criterion: boundedText(2_000),
        risk: z.enum([
          "ordinary",
          "safety",
          "security",
          "destructive-action",
          "accounting",
          "recovery",
        ]),
      })
      .strict(),
  )
  .min(1)
  .max(64);

export const RepositoryCapabilityOperationSchema = z
  .object({
    kind: safeId,
    key: safeId,
  })
  .strict();

export const RuntimeBundleRequirementSchema = z
  .object({
    tool: z.enum(["npm", "pnpm", "bun", "uv"]),
    adapter: safeId,
    adapterContract: z.number().int().positive().max(1_000),
    platform: z
      .object({
        os: z.literal("linux"),
        architecture: z.literal("x64"),
        libc: z.literal("glibc"),
      })
      .strict(),
    releaseChannel: z.literal("ga"),
    bundleDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();

export const SelectedRuntimeBundleRequirementSchema = RuntimeBundleRequirementSchema.extend({
  bundleDigest: sha256Digest,
}).strict();

export const RuntimeBundleReceiptSchema = z
  .object({
    protocol: z.literal("clockgrove.factory/toolchain-runtime-bundle-v1"),
    tool: z.enum(["npm", "pnpm", "bun", "uv"]),
    adapter: safeId,
    adapterContract: z.number().int().positive().max(1_000),
    platform: z
      .object({
        os: z.literal("linux"),
        architecture: z.literal("x64"),
        libc: z.literal("glibc"),
      })
      .strict(),
    components: shortList(
      z
        .object({
          id: safeId,
          version: boundedText(160),
          release: z
            .object({
              provider: z.enum(["github", "nodejs"]),
              repository: boundedText(200),
              releaseId: boundedText(500),
              tag: boundedText(200),
              publishedAt: z.string().datetime(),
              channel: boundedText(160).optional(),
            })
            .strict(),
          asset: z
            .object({
              assetId: boundedText(2_048),
              name: boundedText(500),
              url: boundedText(2_048),
              size: z
                .number()
                .int()
                .positive()
                .max(512 * 1024 * 1024),
              sha256: sha256Digest,
              archive: z.enum(["raw", "tar.gz", "tar.xz", "zip"]),
            })
            .strict(),
          executablePath: RepositoryScopePathSchema.refine(
            (value) => !value.endsWith("/"),
            "runtime executable must be a file path",
          ),
          executableSha256: sha256Digest,
          treeSha256: sha256Digest,
          executableOnly: z.literal(true).optional(),
          entrypoints: shortList(
            z
              .object({
                id: safeId,
                version: boundedText(160),
                path: RepositoryScopePathSchema.refine(
                  (value) => !value.endsWith("/"),
                  "runtime entrypoint must be a file path",
                ),
                sha256: sha256Digest,
                interpreter: safeId.optional(),
              })
              .strict(),
            16,
          )
            .min(1)
            .optional(),
        })
        .strict(),
      8,
    ).min(1),
    resolvedAt: z.string().datetime(),
    digest: sha256Digest,
  })
  .strict()
  .superRefine((receipt, context) => {
    if (new Set(receipt.components.map(({ id }) => id)).size !== receipt.components.length) {
      context.addIssue({ code: "custom", message: "runtime receipt components are duplicated" });
    }
    const { digest, resolvedAt: _resolvedAt, ...identity } = receipt;
    if (digest !== createHash("sha256").update(canonicalJson(identity)).digest("hex")) {
      context.addIssue({ code: "custom", message: "runtime receipt digest mismatch" });
    }
  });

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export const ManagedRuntimeActivationSchema = z
  .object({
    protocol: z.literal("clockgrove.factory/managed-runtime-activation-v1"),
    baseSha: gitSha,
    sourceRef: boundedText(500),
    requirements: shortList(SelectedRuntimeBundleRequirementSchema, 8).min(1),
    receipts: shortList(RuntimeBundleReceiptSchema, 8).min(1),
    packetDigest: sha256Digest,
    proofDigests: shortList(sha256Digest, 32),
    digest: sha256Digest,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.requirements.map(({ adapter, tool }) => `${adapter}\0${tool}`)).size !==
        value.requirements.length ||
      value.proofDigests.some((digest, index) => value.proofDigests.indexOf(digest) !== index)
    ) {
      context.addIssue({ code: "custom", message: "managed runtime activation is duplicated" });
    }
    if (
      value.receipts.length !== value.requirements.length ||
      value.requirements.some(
        (requirement) =>
          !value.receipts.some(
            (receipt) =>
              receipt.tool === requirement.tool &&
              receipt.adapter === requirement.adapter &&
              receipt.adapterContract === requirement.adapterContract &&
              receipt.digest === requirement.bundleDigest &&
              canonicalJson(receipt.platform) === canonicalJson(requirement.platform),
          ),
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "managed runtime activation receipts differ from its requirements",
      });
    }
    const { digest, ...identity } = value;
    if (digest !== createHash("sha256").update(canonicalJson(identity)).digest("hex")) {
      context.addIssue({ code: "custom", message: "managed runtime activation digest mismatch" });
    }
  });

const RepositoryCapabilityProvisionSchema = z
  .object({
    adapter: safeId,
    generation: safeId,
    authorityPaths: shortList(RepositoryScopePathSchema, 16).min(1),
    operations: shortList(RepositoryCapabilityOperationSchema, 32).min(1),
    runtime: RuntimeBundleRequirementSchema.optional(),
  })
  .strict();

const RepositoryCapabilityRequirementSchema = z
  .object({
    adapter: safeId,
    generation: safeId,
    providerWorkItem: safeId,
    authorityPaths: shortList(RepositoryScopePathSchema, 16).min(1),
    operation: RepositoryCapabilityOperationSchema,
    activation: z.enum(["artifact", "integrated-base"]),
    runtime: RuntimeBundleRequirementSchema.optional(),
  })
  .strict();

export const RepositoryCapabilityBindingsSchema = z
  .object({
    provides: shortList(RepositoryCapabilityProvisionSchema, 16).default([]),
    requires: shortList(RepositoryCapabilityRequirementSchema, 32).default([]),
  })
  .strict();

const WorkerPacketCommon = z.object({
  protocol: z
    .literal("clockgrove.factory/worker-packet")
    .default("clockgrove.factory/worker-packet"),
  goal: boundedText(4_000),
  acceptanceCriteria: shortList(boundedText(2_000)).min(1),
  preconditions: shortList(boundedText(2_000)).default([]),
  outOfScope: shortList(boundedText(2_000)).default([]),
  conventions: shortList(boundedText(2_000)).default([]),
  retryContext: RetryContextSchema.optional(),
  baseSha: gitSha,
  requirements: ExecutionRequirementsSchema,
  assetInputs: shortList(WorkerAssetInputSchema, 32).default([]),
});

export const RepositoryChangeWorkerPacketSchema = WorkerPacketCommon.extend({
  deliverable: RepositoryChangeDeliverableSchema,
  allowedPaths: shortList(RepositoryScopePathSchema).min(1),
  context: ContextManifestSchema.optional(),
  changeSurface: ChangeSurfaceSchema.optional(),
  delivery: DeliveryHintSchema.optional(),
  criterionRisks: CriterionRiskAssessmentSchema.optional(),
  validation: ValidationDesignSchema.optional(),
  repositoryCapabilities: RepositoryCapabilityBindingsSchema.optional(),
  managedRuntimes: shortList(RuntimeBundleRequirementSchema, 8).optional(),
  generatedAssetRequirements: shortList(GeneratedAssetRequirementSchema, 32).default([]),
  mediaUses: shortList(WorkerMediaIntentUseSchema, 64).default([]),
  repositoryCaptureRecipes: shortList(RepositoryCaptureRecipeSchema, 32).default([]),
  validationCommands: shortList(boundedText(1_000), 32).min(1),
})
  .strict()
  .superRefine((packet, context) => {
    const descriptors = new Set(packet.assetInputs.map(({ descriptorDigest }) => descriptorDigest));
    for (const [index, use] of packet.mediaUses.entries()) {
      if (use.descriptorDigests.some((digest: string) => !descriptors.has(digest)))
        context.addIssue({
          code: "custom",
          path: ["mediaUses", index, "descriptorDigests"],
          message: "media use references a descriptor absent from immutable asset inputs",
        });
    }
    const inputs = new Set(packet.assetInputs.map(({ descriptorDigest }) => descriptorDigest));
    const uses = new Map(packet.mediaUses.map((use) => [`${use.intentId}\0${use.direction}`, use]));
    const recipeIds = new Set<string>();
    const commandIdentities = new Map<string, string>();
    const captureCommands: string[] = [];
    const comparisonCommands: string[] = [];
    const registerCommand = (
      command: string,
      phase: "capture" | "threshold-comparison",
      identity: { recipeId: string; recipeDigest: string },
      path: Array<string | number>,
    ) => {
      const commandIdentity = `${phase}\0${identity.recipeId}\0${identity.recipeDigest}`;
      const existing = commandIdentities.get(command);
      if (existing !== undefined && existing !== commandIdentity)
        context.addIssue({
          code: "custom",
          path,
          message: "validation command text has conflicting phase or recipe identity",
        });
      else commandIdentities.set(command, commandIdentity);
    };
    for (const [index, recipe] of packet.repositoryCaptureRecipes.entries()) {
      if (recipeIds.has(recipe.id))
        context.addIssue({
          code: "custom",
          path: ["repositoryCaptureRecipes", index, "id"],
          message: "capture recipe identity is duplicated",
        });
      recipeIds.add(recipe.id);
      const use = uses.get(`${recipe.mediaUse.intentId}\0evidence-for`);
      if (
        !use ||
        JSON.stringify([...use.criterionIds].sort()) !==
          JSON.stringify([...recipe.criterionIds].sort())
      )
        context.addIssue({
          code: "custom",
          path: ["repositoryCaptureRecipes", index, "mediaUse"],
          message: "capture recipe does not bind its exact evidence media use",
        });
      if (!inputs.has(recipe.comparison.expectedDescriptorDigest))
        context.addIssue({
          code: "custom",
          path: ["repositoryCaptureRecipes", index, "comparison", "expectedDescriptorDigest"],
          message: "capture comparison expected descriptor is absent from immutable asset inputs",
        });
      if (use && !use.descriptorDigests.includes(recipe.comparison.expectedDescriptorDigest))
        context.addIssue({
          code: "custom",
          path: ["repositoryCaptureRecipes", index, "comparison", "expectedDescriptorDigest"],
          message: "capture comparison expected descriptor differs from its evidence media use",
        });
      const commands = [
        recipe.captureCommand.command,
        ...(recipe.comparison.kind === "threshold" ? [recipe.comparison.command.command] : []),
      ];
      for (const command of commands)
        if (!packet.validationCommands.includes(command))
          context.addIssue({
            code: "custom",
            path: ["repositoryCaptureRecipes", index],
            message: "capture recipe references an ungrounded validation command",
          });
      registerCommand(recipe.captureCommand.command, "capture", recipe.captureCommand, [
        "repositoryCaptureRecipes",
        index,
        "captureCommand",
      ]);
      if (!captureCommands.includes(recipe.captureCommand.command))
        captureCommands.push(recipe.captureCommand.command);
      if (recipe.comparison.kind === "threshold") {
        registerCommand(
          recipe.comparison.command.command,
          "threshold-comparison",
          recipe.comparison.command,
          ["repositoryCaptureRecipes", index, "comparison", "command"],
        );
        if (!comparisonCommands.includes(recipe.comparison.command.command))
          comparisonCommands.push(recipe.comparison.command.command);
      }
    }
    const reservedCommands = new Set([...captureCommands, ...comparisonCommands]);
    for (const [validationIndex, validation] of (packet.validation ?? []).entries())
      for (const command of validation.evidenceCommands ?? [])
        if (reservedCommands.has(command))
          context.addIssue({
            code: "custom",
            path: ["validation", validationIndex, "evidenceCommands"],
            message: "ordinary validation command conflicts with a capture command phase",
          });
    const captureCommandSet = new Set(captureCommands);
    const comparisonCommandSet = new Set(comparisonCommands);
    const commandPhases = packet.validationCommands.map((command) =>
      comparisonCommandSet.has(command) ? 2 : captureCommandSet.has(command) ? 1 : 0,
    );
    if (
      new Set(packet.validationCommands).size !== packet.validationCommands.length ||
      commandPhases.some((phase, index) => index > 0 && phase < commandPhases[index - 1]!)
    )
      context.addIssue({
        code: "custom",
        path: ["validationCommands"],
        message:
          "validation commands must be unique and ordered ordinary, capture, then threshold comparison",
      });
  });

export const AssetProductionWorkerPacketSchema = WorkerPacketCommon.extend({
  deliverable: AssetProductionDeliverableSchema,
  allowedPaths: z.tuple([]),
  validationCommands: z.tuple([]),
  context: z.never().optional(),
  changeSurface: z.never().optional(),
  delivery: z.never().optional(),
  criterionRisks: z.never().optional(),
  validation: z.never().optional(),
  repositoryCapabilities: z.never().optional(),
  managedRuntimes: z.never().optional(),
  generatedAssetRequirements: shortList(GeneratedAssetRequirementSchema, 32).default([]),
  mediaUses: shortList(WorkerMediaIntentUseSchema, 64).default([]),
  repositoryCaptureRecipes: z.never().optional(),
})
  .strict()
  .superRefine((packet, context) => {
    const descriptors = new Set(packet.assetInputs.map(({ descriptorDigest }) => descriptorDigest));
    for (const [index, use] of packet.mediaUses.entries()) {
      if (use.descriptorDigests.some((digest: string) => !descriptors.has(digest)))
        context.addIssue({
          code: "custom",
          path: ["mediaUses", index, "descriptorDigests"],
          message: "media use references a descriptor absent from immutable asset inputs",
        });
    }
  });

export const WorkerPacketSchema = z.union([
  RepositoryChangeWorkerPacketSchema,
  AssetProductionWorkerPacketSchema,
]);

export type ExecutionRequirements = z.infer<typeof ExecutionRequirementsSchema>;
type ParsedRepositoryChangeWorkerPacket = z.output<typeof RepositoryChangeWorkerPacketSchema>;
type ParsedAssetProductionWorkerPacket = z.output<typeof AssetProductionWorkerPacketSchema>;
type OptionalPacketDefaults<T extends { assetInputs: unknown }> = Omit<
  T,
  "assetInputs" | "generatedAssetRequirements" | "mediaUses" | "repositoryCaptureRecipes"
> & {
  assetInputs?: T["assetInputs"];
} & ("generatedAssetRequirements" extends keyof T
    ? {
        generatedAssetRequirements?: T["generatedAssetRequirements"];
        mediaUses?: "mediaUses" extends keyof T ? T["mediaUses"] : never;
        repositoryCaptureRecipes?: "repositoryCaptureRecipes" extends keyof T
          ? T["repositoryCaptureRecipes"]
          : never;
      }
    : object);
export type RepositoryChangeWorkerPacket =
  OptionalPacketDefaults<ParsedRepositoryChangeWorkerPacket>;
export type AssetProductionWorkerPacket = OptionalPacketDefaults<ParsedAssetProductionWorkerPacket>;
export type WorkerPacket = RepositoryChangeWorkerPacket | AssetProductionWorkerPacket;
export type RepositoryCaptureRecipe = z.infer<typeof RepositoryCaptureRecipeSchema>;
export type RepositoryCaptureProfile = z.infer<typeof RepositoryCaptureProfileSchema>;
export function isRepositoryChangeWorkerPacket(
  packet: WorkerPacket,
): packet is RepositoryChangeWorkerPacket {
  return packet.deliverable.kind === "repository-change";
}
export function assertRepositoryChangeWorkerPacket(
  packet: WorkerPacket,
): asserts packet is RepositoryChangeWorkerPacket {
  if (packet.deliverable.kind !== "repository-change")
    throw new Error("asset-production Worker Packet requires the supervised asset execution route");
}

/** Descriptors visible to implementation workers are derived from semantic
 * input uses. Evidence-only expected results stay in the canonical packet for
 * the independent validator but never enter an implementation workspace. */
export function implementationAssetInputs(packet: WorkerPacket) {
  const descriptors = new Set(
    (packet.mediaUses ?? [])
      .filter(({ direction }) => direction === "input-to")
      .flatMap(({ descriptorDigests }) => descriptorDigests),
  );
  return (packet.assetInputs ?? []).filter(({ descriptorDigest }) =>
    descriptors.has(descriptorDigest),
  );
}

export function implementationMediaUses(packet: WorkerPacket) {
  return (packet.mediaUses ?? []).filter(({ direction }) => direction === "input-to");
}
export type ManagedRuntimeActivation = z.infer<typeof ManagedRuntimeActivationSchema>;
export interface RepositoryCapabilityOperation {
  kind: string;
  key: string;
}
export interface RepositoryCapabilityProvision {
  adapter: string;
  generation: string;
  authorityPaths: string[];
  operations: RepositoryCapabilityOperation[];
  runtime?: z.infer<typeof RuntimeBundleRequirementSchema>;
}
export interface RepositoryCapabilityRequirement {
  adapter: string;
  generation: string;
  providerWorkItem: string;
  authorityPaths: string[];
  operation: RepositoryCapabilityOperation;
  activation: "artifact" | "integrated-base";
  runtime?: z.infer<typeof RuntimeBundleRequirementSchema>;
}
export interface RepositoryCapabilityBindings {
  provides: RepositoryCapabilityProvision[];
  requires: RepositoryCapabilityRequirement[];
}

/** Packets without explicit validation design conservatively retain semantic review. */
export function semanticReviewCriteria(packet: WorkerPacket): string[] {
  if (packet.deliverable.kind === "asset-production") return [...packet.acceptanceCriteria];
  if ((packet.repositoryCaptureRecipes ?? []).some(({ gate }) => gate.kind === "human-required"))
    return [...packet.acceptanceCriteria];
  if (!packet.validation) return [...packet.acceptanceCriteria];
  const accepted = new Set(packet.acceptanceCriteria);
  const seenTiers = new Set<string>();
  const mapped = new Map<string, typeof packet.validation>();
  for (const entry of packet.validation) {
    if (
      seenTiers.has(entry.tier) ||
      entry.criteria.some((criterion) => !accepted.has(criterion)) ||
      new Set(entry.criteria).size !== entry.criteria.length ||
      !entry.rationale ||
      !entry.evidenceCommands ||
      new Set(entry.evidenceCommands).size !== entry.evidenceCommands.length
    )
      return [...packet.acceptanceCriteria];
    seenTiers.add(entry.tier);
    for (const criterion of entry.criteria)
      mapped.set(criterion, [...(mapped.get(criterion) ?? []), entry]);
  }
  return packet.acceptanceCriteria.filter((criterion) => {
    const routes = mapped.get(criterion);
    if (!routes?.length) return true;
    if (routes.some((entry) => entry.tier === "semantic")) return true;
    return !routes.some(
      (entry) =>
        (entry.tier === "mechanical" || entry.tier === "deterministic-simulation") &&
        entry.evidenceCommands!.length > 0 &&
        entry.evidenceCommands!.every((command) => packet.validationCommands.includes(command)),
    );
  });
}

export function parseWorkerPacket(input: unknown): WorkerPacket {
  if (
    !input ||
    typeof input !== "object" ||
    (input as { protocol?: unknown }).protocol !== "clockgrove.factory/worker-packet"
  )
    throw new Error("the canonical Worker Packet protocol is required");
  const packet = WorkerPacketSchema.parse(input);
  assertWithinBytes(packet, MAX_WORKER_PACKET_BYTES, "Worker Packet");
  assertNoSecretMaterial(packet, "Worker Packet");
  return packet;
}

/** Stable content identity for a prepared execution, including retry context and
 * policy-grounded requirements. Object key order is not execution authority. */
export function workerPacketDigest(input: unknown): string {
  const packet: unknown = JSON.parse(JSON.stringify(parseWorkerPacket(input)));
  return createHash("sha256").update(canonicalJson(packet)).digest("hex");
}
