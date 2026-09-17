import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";

import { z } from "zod";

import {
  AssetInspectionSchema,
  AssetRightsSchema,
  AssetVisibilitySchema,
} from "../assets/contracts.js";
import { inspectDeclaredAssetBytes } from "../assets/handlers.js";
import { MediaTypeSchema } from "../assets/media-intent.js";
import {
  ContentTransferIdentitySchema,
  persistContentTransfer,
  recoverContentTransfer,
  type ContentTransferStore,
} from "../control/content-transfers.js";
import {
  ArtifactPathSchema,
  cachePayloadBytes,
  inspectContentFile,
  materializePayload,
} from "../execution/artifact-content.js";
import { withArtifactContentScope } from "../execution/artifact-content-scope.js";
import { boundedText, gitSha, safeId, sha256Digest } from "../protocol/limits.js";
import { RepositoryCaptureEgressPolicySchema } from "../protocol/policy.js";
import {
  RepositoryCaptureProfileSchema,
  RepositoryCaptureRecipeSchema,
  type RepositoryCaptureProfile,
  type RepositoryCaptureRecipe,
} from "../protocol/worker-packet.js";

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

const digestOf = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");

const unique = <T extends z.ZodTypeAny>(schema: T, maximum: number, minimum = 0) =>
  z
    .array(schema)
    .min(minimum)
    .max(maximum)
    .refine((values) => new Set(values).size === values.length, "values must be unique");

/** The use binds a recipe to the exact Worker Packet semantic record by digest.
 * Byte transport remains separate, so one descriptor can support many uses. */
export const RepositoryCaptureUseSchema = z
  .object({
    recipeId: safeId,
    recipeDigest: sha256Digest,
    mediaUse: z.object({ intentId: safeId, direction: z.literal("evidence-for") }).strict(),
    criterionIds: unique(safeId, 64, 1),
    scenarioId: safeId,
    outputRole: safeId,
  })
  .strict();

const CaptureCommandSchema = z
  .object({ recipeId: safeId, recipeDigest: sha256Digest, command: boundedText(1_000) })
  .strict();

const CaptureOutputAuthoritySchema = z
  .object({
    recipeId: safeId,
    roleId: safeId,
    visibility: AssetVisibilitySchema,
    rights: AssetRightsSchema,
  })
  .strict();

const ValidationMediaInputSchema = z
  .object({
    descriptorDigest: sha256Digest,
    contentDigest: sha256Digest,
    storageReceiptDigest: sha256Digest,
    activationDigest: sha256Digest.nullable(),
    displayName: boundedText(255),
    declaredMediaType: MediaTypeSchema,
    inspection: AssetInspectionSchema,
    profileIds: unique(safeId, 32),
    visibility: AssetVisibilitySchema,
    rights: AssetRightsSchema,
  })
  .strict();

const CaptureComparisonAuthoritySchema = z
  .object({
    recipeId: safeId,
    expectedDescriptorDigest: sha256Digest,
    expectedContentDigest: sha256Digest,
    expectedStorageReceiptDigest: sha256Digest,
  })
  .strict();

const ValidationToolEnvironmentSchema = z
  .object({
    backendId: safeId,
    backendLocator: boundedText(500).nullable(),
    environmentIdentity: boundedText(500),
    egress: z.enum(["local", "third-party"]),
    toolReceiptDigests: unique(sha256Digest, 32),
  })
  .strict();

const ValidationInvocationCoreObject = z
  .object({
    protocol: z.literal("clockgrove.factory/validation-invocation"),
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    objective: z.number().int().positive(),
    runId: safeId,
    workItem: z.number().int().positive(),
    attempt: z.number().int().positive(),
    attemptAuthority: z
      .object({
        reservationRef: boundedText(500),
        reservationOid: gitSha,
        reservationReceiptDigest: sha256Digest,
        directorEpoch: z.number().int().positive(),
        policyDigest: sha256Digest,
      })
      .strict(),
    validationDeadline: z.string().datetime({ offset: true }),
    artifactDigest: sha256Digest,
    baseSha: gitSha,
    outputTreeSha: gitSha,
    validationCommands: z.array(boundedText(1_000)).min(1).max(128),
    repositoryCaptureRecipes: z.array(RepositoryCaptureRecipeSchema).max(32),
    captureOutputAuthorities: z.array(CaptureOutputAuthoritySchema).max(512),
    comparisonAuthorities: z.array(CaptureComparisonAuthoritySchema).max(32),
    mediaInputs: z.array(ValidationMediaInputSchema).max(32),
    egressPolicy: RepositoryCaptureEgressPolicySchema,
    toolEnvironment: ValidationToolEnvironmentSchema,
  })
  .strict();

function validateCaptureOutputAuthorities(
  invocation: z.infer<typeof ValidationInvocationCoreObject>,
  context: z.RefinementCtx,
) {
  const captureCommands = new Set(
    invocation.repositoryCaptureRecipes.map((recipe) => recipe.captureCommand.command),
  );
  const comparisonCommands = new Set(
    invocation.repositoryCaptureRecipes.flatMap((recipe) =>
      recipe.comparison.kind === "threshold" ? [recipe.comparison.command.command] : [],
    ),
  );
  const lastCapture = Math.max(
    -1,
    ...[...captureCommands].map((command) => invocation.validationCommands.indexOf(command)),
  );
  const firstComparison = Math.min(
    Number.POSITIVE_INFINITY,
    ...[...comparisonCommands].map((command) => invocation.validationCommands.indexOf(command)),
  );
  if (
    [...captureCommands].some((command) => comparisonCommands.has(command)) ||
    lastCapture > firstComparison
  )
    context.addIssue({
      code: "custom",
      path: ["validationCommands"],
      message: "capture commands must precede distinct comparison commands",
    });
  for (const recipe of invocation.repositoryCaptureRecipes) {
    const recipeCommands = [
      recipe.captureCommand.command,
      ...(recipe.comparison.kind === "threshold" ? [recipe.comparison.command.command] : []),
    ];
    for (const command of recipeCommands)
      if (invocation.validationCommands.filter((candidate) => candidate === command).length !== 1)
        context.addIssue({
          code: "custom",
          path: ["validationCommands"],
          message: "each capture command must occur exactly once in validation order",
        });
  }
  const expected = invocation.repositoryCaptureRecipes.flatMap((recipe) =>
    recipe.outputs.map((output) => `${recipe.id}\0${output.roleId}`),
  );
  const observed = invocation.captureOutputAuthorities.map(
    ({ recipeId, roleId }) => `${recipeId}\0${roleId}`,
  );
  if (
    new Set(observed).size !== observed.length ||
    expected.length !== observed.length ||
    expected.some((identity) => !observed.includes(identity))
  )
    context.addIssue({
      code: "custom",
      path: ["captureOutputAuthorities"],
      message: "capture output authority must cover every recipe output exactly once",
    });
  const comparisons = new Map(
    invocation.comparisonAuthorities.map((authority) => [authority.recipeId, authority]),
  );
  if (
    comparisons.size !== invocation.comparisonAuthorities.length ||
    comparisons.size !== invocation.repositoryCaptureRecipes.length ||
    invocation.repositoryCaptureRecipes.some((recipe) => {
      const authority = comparisons.get(recipe.id);
      return (
        !authority ||
        authority.expectedDescriptorDigest !== recipe.comparison.expectedDescriptorDigest ||
        !invocation.mediaInputs.some(
          (input) =>
            input.descriptorDigest === authority.expectedDescriptorDigest &&
            input.contentDigest === authority.expectedContentDigest &&
            input.storageReceiptDigest === authority.expectedStorageReceiptDigest,
        )
      );
    })
  )
    context.addIssue({
      code: "custom",
      path: ["comparisonAuthorities"],
      message: "capture comparison authority must resolve each expected packet descriptor",
    });
  if (
    new Set(invocation.mediaInputs.map(({ descriptorDigest }) => descriptorDigest)).size !==
    invocation.mediaInputs.length
  )
    context.addIssue({
      code: "custom",
      path: ["mediaInputs"],
      message: "validation media inputs duplicate a descriptor",
    });
  invocation.mediaInputs.forEach((input, index) => {
    if (input.inspection.mediaType !== input.declaredMediaType)
      context.addIssue({
        code: "custom",
        path: ["mediaInputs", index, "inspection", "mediaType"],
        message: "validation media input inspection differs from its declared media type",
      });
    const expectedProfiles = [
      ...new Set(
        invocation.repositoryCaptureRecipes.flatMap((recipe) =>
          recipe.comparison.expectedDescriptorDigest === input.descriptorDigest && recipe.profile
            ? [recipe.profile.kind]
            : [],
        ),
      ),
    ].sort();
    if (canonicalJson(input.profileIds) !== canonicalJson(expectedProfiles))
      context.addIssue({
        code: "custom",
        path: ["mediaInputs", index, "profileIds"],
        message: "validation media input profiles differ from its recipe bindings",
      });
  });
  if (invocation.toolEnvironment.egress === "third-party") {
    const thresholdExpected = new Set(
      invocation.repositoryCaptureRecipes.flatMap((recipe) =>
        recipe.comparison.kind === "threshold" ? [recipe.comparison.expectedDescriptorDigest] : [],
      ),
    );
    const validationEgressInputs = invocation.mediaInputs.filter(({ descriptorDigest }) =>
      thresholdExpected.has(descriptorDigest),
    );
    if (validationEgressInputs.length > 0 && invocation.egressPolicy.validation.mode === "denied")
      context.addIssue({
        code: "custom",
        path: ["egressPolicy", "validation"],
        message: "validation-only assets may not leave the controller",
      });
    if (validationEgressInputs.length > invocation.egressPolicy.validation.maxAssets)
      context.addIssue({
        code: "custom",
        path: ["mediaInputs"],
        message: "validation-only input count exceeds immutable egress authority",
      });
    if (
      invocation.egressPolicy.validation.mode === "public-assets" &&
      validationEgressInputs.some(({ visibility }) => visibility !== "public")
    )
      context.addIssue({
        code: "custom",
        path: ["mediaInputs"],
        message: "private validation-only input is not authorized for this backend",
      });
  }
}

const ValidationInvocationCoreSchema = ValidationInvocationCoreObject.superRefine(
  validateCaptureOutputAuthorities,
);

export const ValidationInvocationSchema = ValidationInvocationCoreObject.extend({
  digest: sha256Digest,
})
  .strict()
  .superRefine((invocation, context) => {
    validateCaptureOutputAuthorities(invocation, context);
    const { digest, ...core } = invocation;
    if (digest !== digestOf(core))
      context.addIssue({
        code: "custom",
        path: ["digest"],
        message: "validation invocation digest mismatch",
      });
    if (invocation.repository !== invocation.repository.toLowerCase())
      context.addIssue({
        code: "custom",
        path: ["repository"],
        message: "validation repository is not canonical",
      });
  });

export type ValidationInvocation = z.infer<typeof ValidationInvocationSchema>;

export function createValidationInvocation(
  input: z.input<typeof ValidationInvocationCoreSchema>,
): ValidationInvocation {
  const core = ValidationInvocationCoreSchema.parse({
    ...input,
    repository: input.repository.toLowerCase(),
  });
  return ValidationInvocationSchema.parse({ ...core, digest: digestOf(core) });
}

const CaptureMechanicalResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("exact"),
      recipeId: safeId,
      outputRoleId: safeId,
      expectedDescriptorDigest: sha256Digest,
      expectedContentDigest: sha256Digest,
      expectedStorageReceiptDigest: sha256Digest,
      observedContentDigest: sha256Digest,
      passed: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("threshold"),
      recipeId: safeId,
      outputRoleId: safeId,
      command: CaptureCommandSchema,
      expectedDescriptorDigest: sha256Digest,
      expectedContentDigest: sha256Digest,
      expectedStorageReceiptDigest: sha256Digest,
      metric: safeId,
      maximumDifference: z.number().finite().nonnegative(),
      observedDifference: z.number().finite().nonnegative(),
      exitCode: z.number().int(),
      passed: z.boolean(),
    })
    .strict(),
]);

const CaptureContentSchema = z
  .object({
    protocol: z.literal("clockgrove.factory/evidence-capture-content"),
    digest: sha256Digest,
    bytes: z
      .number()
      .int()
      .positive()
      .max(100 * 1024 * 1024),
    declaredMediaType: MediaTypeSchema,
    inspection: AssetInspectionSchema,
  })
  .strict();

const CaptureDescriptorCoreSchema = z
  .object({
    protocol: z.literal("clockgrove.factory/evidence-capture-descriptor"),
    validationInvocationDigest: sha256Digest,
    recipeId: safeId,
    recipeDigest: sha256Digest,
    outputRole: safeId,
    sourcePath: ArtifactPathSchema,
    profile: RepositoryCaptureProfileSchema.nullable(),
    artifactDigest: sha256Digest,
    baseSha: gitSha,
    outputTreeSha: gitSha,
    content: CaptureContentSchema,
    visibility: AssetVisibilitySchema,
    rights: AssetRightsSchema,
    materializationPath: z
      .string()
      .regex(/^captures\/[a-f0-9]{64}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  })
  .strict();

export const EvidenceCaptureDescriptorSchema = CaptureDescriptorCoreSchema.extend({
  digest: sha256Digest,
})
  .strict()
  .superRefine((descriptor, context) => {
    const { digest, ...core } = descriptor;
    if (digest !== digestOf(core))
      context.addIssue({
        code: "custom",
        path: ["digest"],
        message: "capture descriptor digest mismatch",
      });
  });

const CaptureStorageReceiptCoreSchema = z
  .object({
    protocol: z.literal("clockgrove.factory/evidence-capture-storage-receipt"),
    descriptorDigest: sha256Digest,
    identity: ContentTransferIdentitySchema,
    payloadDigest: sha256Digest,
    payloadBytes: z
      .number()
      .int()
      .positive()
      .max(100 * 1024 * 1024),
    transferRef: boundedText(500),
    intentCommit: gitSha,
    readyCommit: gitSha,
  })
  .strict();

export const EvidenceCaptureStorageReceiptSchema = CaptureStorageReceiptCoreSchema.extend({
  digest: sha256Digest,
})
  .strict()
  .superRefine((receipt, context) => {
    const { digest, ...core } = receipt;
    if (digest !== digestOf(core))
      context.addIssue({
        code: "custom",
        path: ["digest"],
        message: "capture storage receipt digest mismatch",
      });
    if (
      receipt.identity.domain !== "validation-evidence" ||
      receipt.identity.subjectDigest !== receipt.payloadDigest
    )
      context.addIssue({ code: "custom", message: "capture storage receipt authority mismatch" });
  });

export const EvidenceCaptureEntrySchema = z
  .object({
    descriptor: EvidenceCaptureDescriptorSchema,
    storage: EvidenceCaptureStorageReceiptSchema,
  })
  .strict()
  .superRefine((entry, context) => {
    if (
      entry.storage.descriptorDigest !== entry.descriptor.digest ||
      entry.storage.payloadDigest !== entry.descriptor.content.digest ||
      entry.storage.payloadBytes !== entry.descriptor.content.bytes
    )
      context.addIssue({ code: "custom", message: "capture descriptor and receipt differ" });
  });

const CaptureManifestCoreSchema = z
  .object({
    protocol: z.literal("clockgrove.factory/evidence-capture-manifest"),
    validationInvocationDigest: sha256Digest,
    entries: z.array(EvidenceCaptureEntrySchema).min(1).max(512),
    mechanicalResults: z.array(CaptureMechanicalResultSchema).min(1).max(32),
    totalBytes: z
      .number()
      .int()
      .positive()
      .max(256 * 1024 * 1024),
  })
  .strict();

export const EvidenceCaptureManifestSchema = CaptureManifestCoreSchema.extend({
  digest: sha256Digest,
})
  .strict()
  .superRefine((manifest, context) => {
    const { digest, ...core } = manifest;
    if (digest !== digestOf(core))
      context.addIssue({
        code: "custom",
        path: ["digest"],
        message: "capture manifest digest mismatch",
      });
    if (
      manifest.entries.reduce((sum, entry) => sum + entry.descriptor.content.bytes, 0) !==
      manifest.totalBytes
    )
      context.addIssue({
        code: "custom",
        path: ["totalBytes"],
        message: "capture byte total mismatch",
      });
    if (
      new Set(manifest.entries.map(({ descriptor }) => descriptor.digest)).size !==
      manifest.entries.length
    )
      context.addIssue({
        code: "custom",
        path: ["entries"],
        message: "capture descriptors are duplicated",
      });
    if (
      new Set(manifest.mechanicalResults.map(({ recipeId }) => recipeId)).size !==
      manifest.mechanicalResults.length
    )
      context.addIssue({
        code: "custom",
        path: ["mechanicalResults"],
        message: "capture mechanical results duplicate a recipe",
      });
  });

const RepositoryCaptureEvidenceCoreSchema = z
  .object({
    protocol: z.literal("clockgrove.factory/repository-capture-evidence"),
    validationInvocationDigest: sha256Digest,
    collection: z.lazy(() => RepositoryCaptureCollectionManifestSchema),
    manifest: EvidenceCaptureManifestSchema,
    uses: z.array(RepositoryCaptureUseSchema).min(1).max(512),
  })
  .strict();

export const RepositoryCaptureEvidenceSchema = RepositoryCaptureEvidenceCoreSchema.extend({
  digest: sha256Digest,
})
  .strict()
  .superRefine((evidence, context) => {
    const { digest, ...core } = evidence;
    if (digest !== digestOf(core))
      context.addIssue({
        code: "custom",
        path: ["digest"],
        message: "repository capture evidence digest mismatch",
      });
    if (evidence.manifest.validationInvocationDigest !== evidence.validationInvocationDigest)
      context.addIssue({
        code: "custom",
        path: ["manifest"],
        message: "capture manifest invocation differs",
      });
    if (evidence.collection.validationInvocationDigest !== evidence.validationInvocationDigest)
      context.addIssue({
        code: "custom",
        path: ["collection"],
        message: "capture collection invocation differs",
      });
    const recipeIds = new Set(
      evidence.manifest.entries.map(({ descriptor }) => descriptor.recipeId),
    );
    for (const use of evidence.uses)
      if (!recipeIds.has(use.recipeId))
        context.addIssue({
          code: "custom",
          path: ["uses"],
          message: "capture use has no descriptor",
        });
  });

export type RepositoryCaptureEvidence = z.infer<typeof RepositoryCaptureEvidenceSchema>;

export function verifyRepositoryCaptureEvidenceBinding(
  input: RepositoryCaptureEvidence,
  invocationInput: ValidationInvocation,
): void {
  const evidence = RepositoryCaptureEvidenceSchema.parse(input);
  const invocation = ValidationInvocationSchema.parse(invocationInput);
  if (evidence.validationInvocationDigest !== invocation.digest)
    throw new Error("repository capture binds a different validation invocation");
  if (
    canonicalJson(evidence.uses) !==
    canonicalJson(
      invocation.repositoryCaptureRecipes.flatMap((recipe) =>
        recipe.outputs.map((output) => ({
          recipeId: recipe.id,
          recipeDigest: recipe.digest,
          mediaUse: recipe.mediaUse,
          criterionIds: recipe.criterionIds,
          scenarioId: recipe.scenario.id,
          outputRole: output.roleId,
        })),
      ),
    )
  )
    throw new Error("capture uses differ from the validation invocation");
  const recipes = new Map(invocation.repositoryCaptureRecipes.map((recipe) => [recipe.id, recipe]));
  const authorities = new Map(
    invocation.captureOutputAuthorities.map((authority) => [
      `${authority.recipeId}\0${authority.roleId}`,
      authority,
    ]),
  );
  const collected = new Map(
    evidence.collection.files.map((file) => [captureKey(file.recipeId, file.roleId), file]),
  );
  if (collected.size !== evidence.manifest.entries.length)
    throw new Error("capture collection and evidence manifest cardinality differ");
  for (const entry of evidence.manifest.entries) {
    const { descriptor } = entry;
    const recipe = recipes.get(descriptor.recipeId);
    const output = recipe?.outputs.find(({ roleId }) => roleId === descriptor.outputRole);
    const authority = authorities.get(`${descriptor.recipeId}\0${descriptor.outputRole}`);
    const collectedFile = collected.get(captureKey(descriptor.recipeId, descriptor.outputRole));
    const comparisonAuthority = invocation.comparisonAuthorities.find(
      ({ recipeId }) => recipeId === descriptor.recipeId,
    );
    if (
      !recipe ||
      !output ||
      !authority ||
      !collectedFile ||
      !comparisonAuthority ||
      descriptor.validationInvocationDigest !== invocation.digest ||
      descriptor.recipeDigest !== recipe.digest ||
      descriptor.sourcePath !== collectedFile.path ||
      descriptor.content.digest !== collectedFile.digest ||
      descriptor.content.bytes !== collectedFile.bytes ||
      descriptor.content.declaredMediaType !== output.mediaType ||
      descriptor.content.declaredMediaType !== collectedFile.mediaType ||
      canonicalJson(descriptor.profile) !== canonicalJson(recipe.profile) ||
      descriptor.artifactDigest !== invocation.artifactDigest ||
      descriptor.baseSha !== invocation.baseSha ||
      descriptor.outputTreeSha !== invocation.outputTreeSha ||
      descriptor.visibility !== authority.visibility ||
      canonicalJson(descriptor.rights) !== canonicalJson(authority.rights)
    )
      throw new Error("capture descriptor differs from its invocation recipe or authority");
  }
  const mechanicalResults = new Map(
    evidence.manifest.mechanicalResults.map((result) => [result.recipeId, result]),
  );
  if (mechanicalResults.size !== invocation.repositoryCaptureRecipes.length)
    throw new Error("capture evidence must contain one mechanical result per recipe");
  for (const recipe of invocation.repositoryCaptureRecipes) {
    const mechanical = mechanicalResults.get(recipe.id);
    const comparisonAuthority = invocation.comparisonAuthorities.find(
      ({ recipeId }) => recipeId === recipe.id,
    );
    const subject = evidence.manifest.entries.find(
      ({ descriptor }) =>
        descriptor.recipeId === recipe.id &&
        descriptor.outputRole === recipe.comparison.outputRoleId,
    );
    if (
      !mechanical ||
      !comparisonAuthority ||
      !subject ||
      mechanical.kind !== recipe.comparison.kind ||
      mechanical.outputRoleId !== recipe.comparison.outputRoleId ||
      (mechanical.kind === "exact" &&
        recipe.comparison.kind === "exact" &&
        (mechanical.expectedDescriptorDigest !== comparisonAuthority.expectedDescriptorDigest ||
          mechanical.expectedContentDigest !== comparisonAuthority.expectedContentDigest ||
          mechanical.expectedStorageReceiptDigest !==
            comparisonAuthority.expectedStorageReceiptDigest ||
          mechanical.observedContentDigest !== subject.descriptor.content.digest ||
          mechanical.passed !==
            (mechanical.observedContentDigest === mechanical.expectedContentDigest))) ||
      (mechanical.kind === "threshold" &&
        recipe.comparison.kind === "threshold" &&
        (canonicalJson(mechanical.command) !== canonicalJson(recipe.comparison.command) ||
          mechanical.expectedDescriptorDigest !== comparisonAuthority.expectedDescriptorDigest ||
          mechanical.expectedContentDigest !== comparisonAuthority.expectedContentDigest ||
          mechanical.expectedStorageReceiptDigest !==
            comparisonAuthority.expectedStorageReceiptDigest ||
          mechanical.metric !== recipe.comparison.policy.metric ||
          mechanical.maximumDifference !== recipe.comparison.policy.maximumDifference ||
          mechanical.passed !==
            (mechanical.exitCode === 0 &&
              mechanical.observedDifference <= mechanical.maximumDifference)))
    )
      throw new Error("capture result differs from its invocation comparison");
  }
}

export interface CollectedRepositoryCapture {
  recipeId: string;
  roleId: string;
  path: string;
  bytes: Buffer;
  threshold?: { observedDifference: number; exitCode: number };
}

const RepositoryCaptureCollectedFileSchema = z
  .object({
    recipeId: safeId,
    roleId: safeId,
    path: ArtifactPathSchema,
    mediaType: MediaTypeSchema,
    bytes: z
      .number()
      .int()
      .positive()
      .max(100 * 1024 * 1024),
    digest: sha256Digest,
    threshold: z
      .object({ observedDifference: z.number().finite().nonnegative(), exitCode: z.number().int() })
      .strict()
      .optional(),
  })
  .strict();

const RepositoryCaptureCollectionManifestCoreSchema = z
  .object({
    protocol: z.literal("clockgrove.factory/repository-capture-collection"),
    validationInvocationDigest: sha256Digest,
    artifactDigest: sha256Digest,
    baseSha: gitSha,
    outputTreeSha: gitSha,
    files: z.array(RepositoryCaptureCollectedFileSchema).min(1).max(512),
  })
  .strict();

export const RepositoryCaptureCollectionManifestSchema =
  RepositoryCaptureCollectionManifestCoreSchema.extend({ digest: sha256Digest })
    .strict()
    .superRefine((manifest, context) => {
      const { digest, ...core } = manifest;
      if (digest !== digestOf(core))
        context.addIssue({
          code: "custom",
          path: ["digest"],
          message: "capture collection digest mismatch",
        });
      const identities = manifest.files.map(({ recipeId, roleId }) => captureKey(recipeId, roleId));
      if (new Set(identities).size !== identities.length)
        context.addIssue({
          code: "custom",
          path: ["files"],
          message: "capture collection duplicates an output role",
        });
    });

export type RepositoryCaptureCollectionManifest = z.infer<
  typeof RepositoryCaptureCollectionManifestSchema
>;

export function createRepositoryCaptureCollection(args: {
  invocation: ValidationInvocation;
  files: z.input<typeof RepositoryCaptureCollectedFileSchema>[];
}): RepositoryCaptureCollectionManifest {
  const invocation = ValidationInvocationSchema.parse(args.invocation);
  const core = RepositoryCaptureCollectionManifestCoreSchema.parse({
    protocol: "clockgrove.factory/repository-capture-collection",
    validationInvocationDigest: invocation.digest,
    artifactDigest: invocation.artifactDigest,
    baseSha: invocation.baseSha,
    outputTreeSha: invocation.outputTreeSha,
    files: args.files,
  });
  return RepositoryCaptureCollectionManifestSchema.parse({ ...core, digest: digestOf(core) });
}

export function describeRepositoryCaptureBytes(args: {
  invocation: ValidationInvocation;
  captures: CollectedRepositoryCapture[];
}): RepositoryCaptureCollectionManifest {
  const invocation = ValidationInvocationSchema.parse(args.invocation);
  return createRepositoryCaptureCollection({
    invocation,
    files: args.captures.map((capture) => {
      const recipe = invocation.repositoryCaptureRecipes.find(({ id }) => id === capture.recipeId);
      const output = recipe?.outputs.find(({ roleId }) => roleId === capture.roleId);
      if (!output) throw new Error("capture bytes identify an undeclared recipe output role");
      return {
        recipeId: capture.recipeId,
        roleId: capture.roleId,
        path: capture.path,
        mediaType: output.mediaType,
        bytes: capture.bytes.length,
        digest: createHash("sha256").update(capture.bytes).digest("hex"),
        ...(capture.threshold ? { threshold: capture.threshold } : {}),
      };
    }),
  });
}

function captureKey(recipeId: string, roleId: string) {
  return `${recipeId}\0${roleId}`;
}

function safeDisplayName(path: string, opaque: boolean): string {
  if (opaque) return "capture.bin";
  const name = basename(path)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .slice(0, 128);
  return /^[A-Za-z0-9]/.test(name) ? name : "capture.bin";
}

function mechanicalResult(
  recipe: RepositoryCaptureRecipe,
  authority: z.infer<typeof CaptureComparisonAuthoritySchema>,
  observedContentDigest: string,
  threshold: CollectedRepositoryCapture["threshold"],
) {
  if (recipe.comparison.kind === "exact")
    return CaptureMechanicalResultSchema.parse({
      kind: "exact",
      recipeId: recipe.id,
      outputRoleId: recipe.comparison.outputRoleId,
      expectedDescriptorDigest: authority.expectedDescriptorDigest,
      expectedContentDigest: authority.expectedContentDigest,
      expectedStorageReceiptDigest: authority.expectedStorageReceiptDigest,
      observedContentDigest,
      passed: observedContentDigest === authority.expectedContentDigest,
    });
  if (!threshold) throw new Error("threshold capture omitted its repository-grounded result");
  const passed =
    threshold.exitCode === 0 &&
    threshold.observedDifference <= recipe.comparison.policy.maximumDifference;
  return CaptureMechanicalResultSchema.parse({
    kind: "threshold",
    recipeId: recipe.id,
    outputRoleId: recipe.comparison.outputRoleId,
    command: recipe.comparison.command,
    expectedDescriptorDigest: authority.expectedDescriptorDigest,
    expectedContentDigest: authority.expectedContentDigest,
    expectedStorageReceiptDigest: authority.expectedStorageReceiptDigest,
    metric: recipe.comparison.policy.metric,
    maximumDifference: recipe.comparison.policy.maximumDifference,
    observedDifference: threshold.observedDifference,
    exitCode: threshold.exitCode,
    passed,
  });
}

function assertProfile(
  profile: RepositoryCaptureProfile | null,
  declaredMediaType: string,
  inspection: z.infer<typeof AssetInspectionSchema>,
) {
  if (!profile) return;
  const constraints = profile.constraints;
  if (
    inspection.status !== "semantic-valid" ||
    inspection.mediaType !== declaredMediaType ||
    inspection.metadata.kind !== "raster" ||
    (profile.output !== null &&
      (inspection.metadata.width !== profile.output.width ||
        inspection.metadata.height !== profile.output.height)) ||
    (constraints.minimumWidth !== null && inspection.metadata.width < constraints.minimumWidth) ||
    (constraints.maximumWidth !== null && inspection.metadata.width > constraints.maximumWidth) ||
    (constraints.minimumHeight !== null &&
      inspection.metadata.height < constraints.minimumHeight) ||
    (constraints.maximumHeight !== null &&
      inspection.metadata.height > constraints.maximumHeight) ||
    (constraints.alpha === "required" && !inspection.metadata.hasAlpha) ||
    (constraints.alpha === "forbidden" && inspection.metadata.hasAlpha) ||
    (constraints.animation === "required" && inspection.metadata.frames <= 1) ||
    (constraints.animation === "forbidden" && inspection.metadata.frames !== 1)
  )
    throw new Error("captured raster differs from its exact typed profile");
}

/** Host-inspect and durably transfer exact bytes from the independently
 * materialized result tree. This creates validation evidence, never an input
 * asset manifest or activation. */
export async function persistRepositoryCaptures(args: {
  store: ContentTransferStore;
  invocation: ValidationInvocation;
  collection: RepositoryCaptureCollectionManifest;
  downloadCapture(file: RepositoryCaptureCollectionManifest["files"][number]): Promise<Buffer>;
  assertCurrent(): Promise<void>;
  assertOutputTree(outputTreeSha: string): Promise<void>;
}): Promise<RepositoryCaptureEvidence> {
  return withArtifactContentScope(async () => {
    const invocation = ValidationInvocationSchema.parse(args.invocation);
    if (!invocation.repositoryCaptureRecipes.length)
      throw new Error("repository capture invocation has no recipes");
    const collection = RepositoryCaptureCollectionManifestSchema.parse(args.collection);
    if (
      collection.validationInvocationDigest !== invocation.digest ||
      collection.artifactDigest !== invocation.artifactDigest ||
      collection.baseSha !== invocation.baseSha ||
      collection.outputTreeSha !== invocation.outputTreeSha
    )
      throw new Error("repository capture collection differs from its validation invocation");
    await args.assertOutputTree(invocation.outputTreeSha);
    const collected = new Map(
      collection.files.map((capture) => [captureKey(capture.recipeId, capture.roleId), capture]),
    );
    if (collected.size !== collection.files.length)
      throw new Error("repository capture output identities are duplicated");
    const authorities = new Map(
      invocation.captureOutputAuthorities.map((authority) => [
        captureKey(authority.recipeId, authority.roleId),
        authority,
      ]),
    );
    const comparisonAuthorities = new Map(
      invocation.comparisonAuthorities.map((authority) => [authority.recipeId, authority]),
    );
    const entries: Array<z.infer<typeof EvidenceCaptureEntrySchema>> = [];
    const mechanicalResults: Array<z.infer<typeof CaptureMechanicalResultSchema>> = [];
    for (const recipe of invocation.repositoryCaptureRecipes) {
      for (const output of recipe.outputs) {
        const identityKey = captureKey(recipe.id, output.roleId);
        const capture = collected.get(identityKey);
        const authority = authorities.get(identityKey);
        const comparisonAuthority = comparisonAuthorities.get(recipe.id);
        if (!capture)
          throw new Error(`repository capture omitted output ${recipe.id}/${output.roleId}`);
        if (!authority) throw new Error("repository capture output lacks host authority");
        if (!comparisonAuthority)
          throw new Error("repository capture comparison lacks packet descriptor authority");
        if (capture.mediaType !== output.mediaType)
          throw new Error("repository capture transport MIME differs from the pinned recipe");
        const bytes = await args.downloadCapture(capture);
        if (
          bytes.length !== capture.bytes ||
          createHash("sha256").update(bytes).digest("hex") !== capture.digest
        )
          throw new Error("repository capture download differs from its bounded manifest");
        const inspection = await inspectDeclaredAssetBytes(bytes, output.mediaType, {
          allowOpaque: recipe.profile === null,
          displayName: safeDisplayName(capture.path, recipe.profile === null),
        });
        assertProfile(recipe.profile, output.mediaType, inspection);
        const contentDigest = createHash("sha256").update(bytes).digest("hex");
        const displayName = safeDisplayName(capture.path, inspection.status === "opaque");
        const descriptorCore = CaptureDescriptorCoreSchema.parse({
          protocol: "clockgrove.factory/evidence-capture-descriptor",
          validationInvocationDigest: invocation.digest,
          recipeId: recipe.id,
          recipeDigest: recipe.digest,
          outputRole: output.roleId,
          sourcePath: capture.path,
          profile: recipe.profile,
          artifactDigest: invocation.artifactDigest,
          baseSha: invocation.baseSha,
          outputTreeSha: invocation.outputTreeSha,
          content: {
            protocol: "clockgrove.factory/evidence-capture-content",
            digest: contentDigest,
            bytes: bytes.length,
            declaredMediaType: output.mediaType,
            inspection,
          },
          visibility: authority.visibility,
          rights: authority.rights,
          materializationPath: `captures/${contentDigest}/${displayName}`,
        });
        const descriptor = EvidenceCaptureDescriptorSchema.parse({
          ...descriptorCore,
          digest: digestOf(descriptorCore),
        });
        const payload = await cachePayloadBytes(bytes);
        const identity = ContentTransferIdentitySchema.parse({
          domain: "validation-evidence",
          repository: invocation.repository,
          objective: invocation.objective,
          baseSha: invocation.baseSha,
          requestId: `capture-${digestOf([invocation.digest, recipe.id, output.roleId]).slice(0, 40)}`,
          subjectDigest: contentDigest,
        });
        const transfer = await persistContentTransfer({
          store: args.store,
          identity,
          payload,
          assertCurrent: args.assertCurrent,
        });
        const storageCore = CaptureStorageReceiptCoreSchema.parse({
          protocol: "clockgrove.factory/evidence-capture-storage-receipt",
          descriptorDigest: descriptor.digest,
          identity,
          payloadDigest: transfer.payload.digest,
          payloadBytes: transfer.payload.bytes,
          transferRef: transfer.transferRef,
          intentCommit: transfer.intentCommit,
          readyCommit: transfer.readyCommit,
        });
        entries.push(
          EvidenceCaptureEntrySchema.parse({
            descriptor,
            storage: { ...storageCore, digest: digestOf(storageCore) },
          }),
        );
        if (output.roleId === recipe.comparison.outputRoleId)
          mechanicalResults.push(
            mechanicalResult(recipe, comparisonAuthority, contentDigest, capture.threshold),
          );
      }
    }
    if (entries.length !== collected.size)
      throw new Error("repository capture returned an undeclared output");
    entries.sort((left, right) => left.descriptor.digest.localeCompare(right.descriptor.digest));
    const manifestCore = CaptureManifestCoreSchema.parse({
      protocol: "clockgrove.factory/evidence-capture-manifest",
      validationInvocationDigest: invocation.digest,
      entries,
      mechanicalResults,
      totalBytes: entries.reduce((sum, entry) => sum + entry.descriptor.content.bytes, 0),
    });
    const manifest = EvidenceCaptureManifestSchema.parse({
      ...manifestCore,
      digest: digestOf(manifestCore),
    });
    const core = RepositoryCaptureEvidenceCoreSchema.parse({
      protocol: "clockgrove.factory/repository-capture-evidence",
      validationInvocationDigest: invocation.digest,
      collection,
      manifest,
      uses: invocation.repositoryCaptureRecipes.flatMap((recipe) =>
        recipe.outputs.map((output) => ({
          recipeId: recipe.id,
          recipeDigest: recipe.digest,
          mediaUse: recipe.mediaUse,
          criterionIds: recipe.criterionIds,
          scenarioId: recipe.scenario.id,
          outputRole: output.roleId,
        })),
      ),
    });
    await args.assertOutputTree(invocation.outputTreeSha);
    const evidence = RepositoryCaptureEvidenceSchema.parse({ ...core, digest: digestOf(core) });
    verifyRepositoryCaptureEvidenceBinding(evidence, invocation);
    return evidence;
  });
}

export const RepositoryCaptureReviewerCapabilitySchema = z
  .object({
    id: safeId,
    mediaTypes: unique(MediaTypeSchema, 32, 1),
    profiles: unique(safeId, 32),
    allowUnprofiled: z.boolean(),
    visibilities: unique(AssetVisibilitySchema, 2, 1),
    rightsBases: unique(z.enum(["user-owned", "licensed", "permission-granted", "unknown"]), 4, 1),
    semanticHandlers: unique(
      z.object({ id: safeId, contract: z.number().int().positive().max(1_000) }).strict(),
      32,
    ).refine(
      (handlers) => new Set(handlers.map(({ id }) => id)).size === handlers.length,
      "semantic handler ids must be unique",
    ),
    networkDestinations: unique(boundedText(253), 32),
    maximumAssets: z.number().int().positive().max(544),
  })
  .strict();
export type RepositoryCaptureReviewerCapability = z.infer<
  typeof RepositoryCaptureReviewerCapabilitySchema
>;

function reviewerSupportsInspection(
  capability: RepositoryCaptureReviewerCapability,
  inspection: z.infer<typeof AssetInspectionSchema>,
): boolean {
  return capability.semanticHandlers.some(
    ({ id, contract }) => id === inspection.handlerId && contract === inspection.handlerContract,
  );
}

export function authorizeRepositoryCaptureReview(args: {
  evidence: RepositoryCaptureEvidence;
  capability: z.infer<typeof RepositoryCaptureReviewerCapabilitySchema>;
  policy: {
    mode: "denied" | "public-assets" | "private-assets";
    maxAssets: number;
    reviewerCapabilityIds: string[];
    allowedNetworkDestinations: string[];
  };
  recipeIds?: ReadonlySet<string>;
}): void {
  const evidence = RepositoryCaptureEvidenceSchema.parse(args.evidence);
  const capability = RepositoryCaptureReviewerCapabilitySchema.parse(args.capability);
  if (args.policy.mode === "denied" || !args.policy.reviewerCapabilityIds.includes(capability.id))
    throw new Error("repository capture reviewer is not authorized by immutable policy");
  if (
    capability.networkDestinations.some(
      (destination) => !args.policy.allowedNetworkDestinations.includes(destination),
    )
  )
    throw new Error("repository capture reviewer destination is denied by immutable policy");
  const entries = args.recipeIds
    ? evidence.manifest.entries.filter(({ descriptor }) => args.recipeIds!.has(descriptor.recipeId))
    : evidence.manifest.entries;
  if (entries.length > capability.maximumAssets || entries.length > args.policy.maxAssets)
    throw new Error("repository capture count exceeds reviewer capability");
  for (const { descriptor } of entries) {
    const inspection = descriptor.content.inspection;
    if (
      !capability.mediaTypes.includes(descriptor.content.declaredMediaType) ||
      (descriptor.profile
        ? !capability.profiles.includes(descriptor.profile.kind)
        : !capability.allowUnprofiled) ||
      !capability.visibilities.includes(descriptor.visibility) ||
      !capability.rightsBases.includes(descriptor.rights.basis) ||
      (args.policy.mode === "public-assets" && descriptor.visibility === "private")
    )
      throw new Error("repository capture is outside reviewer capability or egress policy");
    if (
      inspection.status !== "semantic-valid" ||
      inspection.mediaType !== descriptor.content.declaredMediaType ||
      !reviewerSupportsInspection(capability, inspection)
    )
      throw new Error("repository capture lacks an exact semantic handler for this reviewer");
  }
}

async function privateRoot(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  )
    throw new Error("repository capture review root is not private owned storage");
}

/** Materialize verified, read-only capture bytes only after the full semantic
 * capability and egress intersection succeeds. */
export async function materializeRepositoryCapturesForReview(args: {
  store: ContentTransferStore;
  evidence: RepositoryCaptureEvidence;
  capability: z.infer<typeof RepositoryCaptureReviewerCapabilitySchema>;
  policy: {
    mode: "denied" | "public-assets" | "private-assets";
    maxAssets: number;
    reviewerCapabilityIds: string[];
    allowedNetworkDestinations: string[];
  };
  supervisorRoot: string;
  recipeIds?: ReadonlySet<string>;
}) {
  authorizeRepositoryCaptureReview(args);
  const evidence = RepositoryCaptureEvidenceSchema.parse(args.evidence);
  return withArtifactContentScope(async () => {
    const base = resolve(args.supervisorRoot);
    await privateRoot(base);
    const root = await mkdtemp(join(base, `review-${evidence.digest.slice(0, 12)}-`));
    try {
      const entries = args.recipeIds
        ? evidence.manifest.entries.filter(({ descriptor }) =>
            args.recipeIds!.has(descriptor.recipeId),
          )
        : evidence.manifest.entries;
      for (const entry of entries) {
        const recovered = await recoverContentTransfer({
          store: args.store,
          identity: entry.storage.identity,
        });
        if (
          !recovered ||
          recovered.transferRef !== entry.storage.transferRef ||
          recovered.intentCommit !== entry.storage.intentCommit ||
          recovered.readyCommit !== entry.storage.readyCommit ||
          recovered.payload.digest !== entry.storage.payloadDigest ||
          recovered.payload.bytes !== entry.storage.payloadBytes
        )
          throw new Error("repository capture transfer differs from its validation receipt");
        const destination = join(root, entry.descriptor.materializationPath);
        if (!resolve(destination).startsWith(`${resolve(root)}${sep}`))
          throw new Error("repository capture materialization escaped its root");
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        await materializePayload(recovered.payload, destination);
        const observed = await inspectContentFile(destination, entry.descriptor.content.bytes);
        if (
          observed.bytes !== entry.descriptor.content.bytes ||
          observed.digest !== entry.descriptor.content.digest
        )
          throw new Error("materialized repository capture identity mismatch");
        const handle = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
        await chmod(destination, 0o444);
      }
      return { root, evidenceDigest: evidence.digest, manifestDigest: evidence.manifest.digest };
    } catch (error) {
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  });
}

/** Build the complete private semantic-review bundle. Authorization covers
 * both validation-only expected inputs and observed result captures before
 * either content channel is touched. */
export async function materializeRepositoryCaptureReviewBundle(args: {
  store: ContentTransferStore;
  invocation: ValidationInvocation;
  evidence: RepositoryCaptureEvidence;
  capability: RepositoryCaptureReviewerCapability;
  policy: {
    mode: "denied" | "public-assets" | "private-assets";
    maxAssets: number;
    reviewerCapabilityIds: string[];
    allowedNetworkDestinations: string[];
  };
  supervisorRoot: string;
  downloadExpected(input: ValidationInvocation["mediaInputs"][number]): Promise<Buffer>;
}) {
  const invocation = ValidationInvocationSchema.parse(args.invocation);
  const evidence = RepositoryCaptureEvidenceSchema.parse(args.evidence);
  verifyRepositoryCaptureEvidenceBinding(evidence, invocation);
  const capability = RepositoryCaptureReviewerCapabilitySchema.parse(args.capability);
  const humanRecipes = invocation.repositoryCaptureRecipes.filter(
    ({ gate }) => gate.kind === "human-required",
  );
  if (humanRecipes.length === 0)
    throw new Error("repository capture review bundle has no human-required recipes");
  const humanRecipeIds = new Set(humanRecipes.map(({ id }) => id));
  const humanExpectedDescriptors = new Set(
    humanRecipes.map(({ comparison }) => comparison.expectedDescriptorDigest),
  );
  const expectedAssociations = new Map<
    string,
    { recipeIds: Set<string>; profileIds: Set<string> }
  >();
  for (const recipe of humanRecipes) {
    const descriptorDigest = recipe.comparison.expectedDescriptorDigest;
    const association = expectedAssociations.get(descriptorDigest) ?? {
      recipeIds: new Set<string>(),
      profileIds: new Set<string>(),
    };
    association.recipeIds.add(recipe.id);
    if (recipe.profile) association.profileIds.add(recipe.profile.kind);
    expectedAssociations.set(descriptorDigest, association);
  }
  const observedEntries = evidence.manifest.entries.filter(({ descriptor }) =>
    humanRecipeIds.has(descriptor.recipeId),
  );
  const expectedInputs = invocation.mediaInputs.filter(({ descriptorDigest }) =>
    humanExpectedDescriptors.has(descriptorDigest),
  );
  authorizeRepositoryCaptureReview({
    evidence,
    capability,
    policy: args.policy,
    recipeIds: humanRecipeIds,
  });
  const total = observedEntries.length + expectedInputs.length;
  if (total > args.policy.maxAssets || total > capability.maximumAssets)
    throw new Error("repository capture review bundle exceeds its immutable count authority");
  for (const input of expectedInputs) {
    if (
      !capability.mediaTypes.includes(input.declaredMediaType) ||
      input.inspection.status !== "semantic-valid" ||
      input.inspection.mediaType !== input.declaredMediaType ||
      !reviewerSupportsInspection(capability, input.inspection) ||
      [...(expectedAssociations.get(input.descriptorDigest)?.profileIds ?? [])].some(
        (profileId) => !capability.profiles.includes(profileId),
      ) ||
      ((expectedAssociations.get(input.descriptorDigest)?.profileIds.size ?? 0) === 0 &&
        !capability.allowUnprofiled) ||
      !capability.visibilities.includes(input.visibility) ||
      !capability.rightsBases.includes(input.rights.basis) ||
      (args.policy.mode === "public-assets" && input.visibility === "private")
    )
      throw new Error("expected review input is outside reviewer capability or egress policy");
  }
  const observed = await materializeRepositoryCapturesForReview({
    store: args.store,
    evidence,
    capability,
    policy: args.policy,
    supervisorRoot: args.supervisorRoot,
    recipeIds: humanRecipeIds,
  });
  try {
    const expectedFiles = [];
    for (const input of expectedInputs) {
      const bytes = await args.downloadExpected(input);
      if (
        bytes.length <= 0 ||
        createHash("sha256").update(bytes).digest("hex") !== input.contentDigest
      )
        throw new Error("expected review bytes differ from validation invocation");
      const inspection = await inspectDeclaredAssetBytes(bytes, input.declaredMediaType, {
        allowOpaque: false,
        displayName: "expected-review-input",
      });
      if (
        inspection.status !== "semantic-valid" ||
        !reviewerSupportsInspection(capability, inspection) ||
        canonicalJson(inspection) !== canonicalJson(input.inspection)
      )
        throw new Error("expected review input lacks an authorized semantic handler");
      const relative = `expected/${input.descriptorDigest}/reference`;
      const destination = join(observed.root, relative);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      const handle = await open(
        destination,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o400,
      );
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      expectedFiles.push({
        kind: "expected" as const,
        descriptorDigest: input.descriptorDigest,
        digest: input.contentDigest,
        bytes: bytes.length,
        mediaType: input.declaredMediaType,
        sourceName: input.displayName,
        handlerId: inspection.handlerId,
        handlerContract: inspection.handlerContract,
        profileIds: [
          ...(expectedAssociations.get(input.descriptorDigest)?.profileIds ?? []),
        ].sort(),
        path: destination,
        recipeIds: [...(expectedAssociations.get(input.descriptorDigest)?.recipeIds ?? [])].sort(),
        outputRole: null,
      });
    }
    return {
      validationInvocationDigest: invocation.digest,
      evidenceDigest: evidence.digest,
      root: observed.root,
      files: [
        ...expectedFiles,
        ...observedEntries.map(({ descriptor }) => ({
          kind: "observed" as const,
          descriptorDigest: descriptor.digest,
          digest: descriptor.content.digest,
          bytes: descriptor.content.bytes,
          mediaType: descriptor.content.declaredMediaType,
          sourceName: basename(descriptor.sourcePath),
          handlerId: descriptor.content.inspection.handlerId,
          handlerContract: descriptor.content.inspection.handlerContract,
          profileIds: descriptor.profile ? [descriptor.profile.kind] : [],
          path: join(observed.root, descriptor.materializationPath),
          recipeIds: [descriptor.recipeId],
          outputRole: descriptor.outputRole,
        })),
      ],
    };
  } catch (error) {
    await rm(observed.root, { recursive: true, force: true });
    throw error;
  }
}

/** One observe-before-replay transaction for every local or isolated validator.
 * The supplied ports are backed by the authenticated attempt ledger. */
export async function runValidationInvocationTransaction<T>(args: {
  invocation: ValidationInvocation;
  observeFinal(): Promise<T | null>;
  observeIntent(): Promise<ValidationInvocation | null>;
  persistIntent(invocation: ValidationInvocation): Promise<void>;
  observe(invocation: ValidationInvocation): Promise<T | null>;
  launch(invocation: ValidationInvocation): Promise<T>;
  persistFinal(result: T): Promise<T>;
}): Promise<T> {
  const invocation = ValidationInvocationSchema.parse(args.invocation);
  const final = await args.observeFinal();
  if (final) return final;
  const prepared = await args.observeIntent();
  if (prepared && canonicalJson(prepared) !== canonicalJson(invocation))
    throw new Error("validation invocation intent differs from the exact requested plan");
  if (!prepared) await args.persistIntent(invocation);
  const observed = await args.observe(invocation);
  if (observed) return args.persistFinal(observed);
  if (prepared)
    throw new Error("prepared validation invocation has no observable result; replay is refused");
  try {
    return await args.persistFinal(await args.launch(invocation));
  } catch (error) {
    const recovered = await args.observe(invocation);
    if (recovered) return args.persistFinal(recovered);
    throw error;
  }
}
