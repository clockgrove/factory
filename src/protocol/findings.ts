import { createHash } from "node:crypto";

import { z } from "zod";

import { assertNoSecretMaterial, boundedText, gitSha, safeId, sha256Digest } from "./limits.js";

export const FINDING_PROTOCOL = "clockgrove.factory/finding-v1" as const;

export const FindingPhaseSchema = z.enum([
  "worker",
  "validation",
  "review",
  "integration",
  "compiler",
  "supervisor",
]);

export const FindingEvidenceReferenceSchema = z
  .object({
    kind: z.enum([
      "worker-packet",
      "artifact",
      "validation",
      "review",
      "integration-candidate",
      "compiler-result",
      "supervisor-observation",
    ]),
    digest: sha256Digest,
    path: boundedText(500).optional(),
    commit: gitSha.optional(),
  })
  .strict();

export const FindingCandidateSchema = z
  .object({
    protocol: z.literal(FINDING_PROTOCOL),
    phase: FindingPhaseSchema,
    failureClass: safeId,
    supportedBehavior: boundedText(2_000),
    observedBehavior: boundedText(4_000),
    reproduction: z.array(boundedText(1_000)).min(1).max(16),
    impact: boundedText(2_000),
    possibleCause: boundedText(2_000).optional(),
    evidence: z.array(FindingEvidenceReferenceSchema).min(1).max(16),
    commonCauseEvidence: z.array(sha256Digest).min(1).max(8).optional(),
  })
  .strict();
export type FindingCandidate = z.infer<typeof FindingCandidateSchema>;

export const FINDING_CANDIDATE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "protocol",
    "phase",
    "failureClass",
    "supportedBehavior",
    "observedBehavior",
    "reproduction",
    "impact",
    "evidence",
  ],
  properties: {
    protocol: { type: "string", const: FINDING_PROTOCOL },
    phase: {
      type: "string",
      enum: ["worker", "validation", "review", "integration", "compiler", "supervisor"],
    },
    failureClass: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$" },
    supportedBehavior: { type: "string", minLength: 1, maxLength: 2000 },
    observedBehavior: { type: "string", minLength: 1, maxLength: 4000 },
    reproduction: {
      type: "array",
      minItems: 1,
      maxItems: 16,
      items: { type: "string", minLength: 1, maxLength: 1000 },
    },
    impact: { type: "string", minLength: 1, maxLength: 2000 },
    possibleCause: { type: "string", minLength: 1, maxLength: 2000 },
    evidence: {
      type: "array",
      minItems: 1,
      maxItems: 16,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "digest"],
        properties: {
          kind: {
            type: "string",
            enum: [
              "worker-packet",
              "artifact",
              "validation",
              "review",
              "integration-candidate",
              "compiler-result",
              "supervisor-observation",
            ],
          },
          digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
          path: { type: "string", minLength: 1, maxLength: 500 },
          commit: { type: "string", pattern: "^[a-f0-9]{40}$" },
        },
      },
    },
    commonCauseEvidence: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: { type: "string", pattern: "^[a-f0-9]{64}$" },
    },
  },
} as const;

export function parseFindingCandidates(value: unknown): FindingCandidate[] | undefined {
  if (value === undefined) return undefined;
  const parsed = z.array(FindingCandidateSchema).max(16).safeParse(value);
  if (!parsed.success) return undefined;
  return parsed.data.map((candidate) => validateFindingCandidate(candidate));
}

export const FindingDestinationSchema = z
  .object({
    repository: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]{1,100}$/),
    audience: z.enum(["private", "public"]),
    operations: z
      .array(z.enum(["read", "create-issue", "comment-evidence"]))
      .min(1)
      .max(3)
      .refine((items) => new Set(items).size === items.length, "operations must be unique"),
  })
  .strict();
export type FindingDestination = z.infer<typeof FindingDestinationSchema>;

export const FindingReportingPolicySchema = z
  .object({
    destinations: z.array(FindingDestinationSchema).min(1).max(8),
    maxPublicationWrites: z.number().int().min(0).max(32),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.destinations.map((item) => item.repository)).size === value.destinations.length,
    "finding destinations must be unique",
  );
export type FindingReportingPolicy = z.infer<typeof FindingReportingPolicySchema>;

export const FindingClassificationSchema = z.enum([
  "in-scope-repair",
  "objective-blocker",
  "nonblocking-follow-up",
  "issue-ready",
  "reporting-refused",
  "reporting-limit",
]);
export type FindingClassification = z.infer<typeof FindingClassificationSchema>;

export const FindingDispositionSchema = z.enum([
  "repaired",
  "issue-filed",
  "existing-issue-linked",
  "issue-ready",
  "reporting-refused",
  "reporting-limit",
]);
export type FindingDisposition = z.infer<typeof FindingDispositionSchema>;

export const FindingOccurrenceSchema = z
  .object({
    objective: z.number().int().positive(),
    workItem: z.number().int().positive().optional(),
    runId: safeId,
    attempt: z.number().int().positive().optional(),
  })
  .strict();
export type FindingOccurrence = z.infer<typeof FindingOccurrenceSchema>;

export function canonicalFinding(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalFinding).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalFinding(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const digest = (value: unknown) =>
  createHash("sha256").update(canonicalFinding(value)).digest("hex");

/** Stable across retries/runs, but distinct for a recurrence on a different artifact. */
export function findingIdentity(destination: string, input: FindingCandidate): string {
  const candidate = validateFindingCandidate(input);
  return digest({
    destination: FindingDestinationSchema.shape.repository.parse(destination),
    supportedBehavior: candidate.supportedBehavior,
    failureClass: candidate.failureClass,
    phase: candidate.phase,
    evidence: candidate.evidence,
    reproduction: candidate.reproduction,
  });
}

/** Coalescing requires explicit shared evidence; generic prose is deliberately excluded. */
export function findingCommonCauseIdentity(input: FindingCandidate): string | undefined {
  const candidate = validateFindingCandidate(input);
  return candidate.commonCauseEvidence
    ? digest({
        failureClass: candidate.failureClass,
        evidence: [...candidate.commonCauseEvidence].sort(),
      })
    : undefined;
}

const PRIVATE_REPORT_PATTERNS = [
  /(?:^|[\s("'`])(?:\/(?:[^\s/]+(?:\/[^\s]*)?)|[A-Za-z]:[\\/]|\\\\[^\\\s]+\\)/,
  /\b(?:localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/i,
  /\b(?:[A-Za-z0-9-]+\.)+(?:internal|local|corp)\b/i,
  /\b(?:ssn|social security|passport number|private topology|internal hostname|phone number)\b/i,
  /\b(?:raw (?:model )?prompts?|raw logs?|system prompt|developer prompt)\b/i,
  /(?:^|\n)\s*(?:system|developer|assistant|user)\s+(?:prompt|message)\s*:/i,
  /\\[rn](?:\s|at\s|(?:error|exception)\b)/i,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
];

const SECURITY_REPORT_PATTERNS = [
  /\bCVE-\d{4}-\d{4,}\b/i,
  /\b(?:vulnerabilit(?:y|ies)|exploit|credential(?:s| exposure)?|secret|api[- ]?key)\b/i,
  /\b(?:authentication|authorization|auth) bypass\b/i,
  /\b(?:remote code execution|RCE|SQL injection|cross-site scripting|XSS|path traversal)\b/i,
];

export function validateFindingCandidate(input: FindingCandidate): FindingCandidate {
  const candidate = FindingCandidateSchema.parse(input);
  assertNoSecretMaterial(candidate, "finding candidate");
  const prose = canonicalFinding(candidate);
  if (PRIVATE_REPORT_PATTERNS.some((pattern) => pattern.test(prose))) {
    throw new Error(
      "finding candidate contains a private path, topology, personal data, raw log, or prompt",
    );
  }
  return candidate;
}

/** Public issue creation is fail-closed for security-sensitive observations. */
export function isFindingSafeForPublicReport(input: FindingCandidate): boolean {
  const candidate = validateFindingCandidate(input);
  return !SECURITY_REPORT_PATTERNS.some((pattern) => pattern.test(canonicalFinding(candidate)));
}

export function findingReportDigest(input: {
  destination: string;
  candidate: FindingCandidate;
  classification: FindingClassification;
  occurrence: FindingOccurrence;
}): string {
  return digest({
    ...input,
    candidate: validateFindingCandidate(input.candidate),
    occurrence: FindingOccurrenceSchema.parse(input.occurrence),
  });
}

export function findingMarker(
  findingId: string,
  reportDigest: string,
  commonCauseId?: string,
): string {
  return `<!-- clockgrove-factory:finding id=${sha256Digest.parse(findingId)} report=${sha256Digest.parse(reportDigest)}${commonCauseId ? ` cause=${sha256Digest.parse(commonCauseId)}` : ""} -->`;
}

export function findingCommonCauseMarker(commonCauseId: string): string {
  return `cause=${sha256Digest.parse(commonCauseId)}`;
}

export function renderFindingIssue(input: {
  findingId: string;
  reportDigest: string;
  candidate: FindingCandidate;
  classification: FindingClassification;
  occurrence: FindingOccurrence;
}): { title: string; body: string } {
  const candidate = validateFindingCandidate(input.candidate);
  const occurrence = FindingOccurrenceSchema.parse(input.occurrence);
  const commonCauseId = findingCommonCauseIdentity(candidate);
  const body = [
    findingMarker(input.findingId, input.reportDigest, commonCauseId),
    "## Expected behavior",
    candidate.supportedBehavior,
    "## Observation",
    candidate.observedBehavior,
    "## Minimal reproduction",
    ...candidate.reproduction.map((step, index) => `${index + 1}. ${step}`),
    "## Impact",
    candidate.impact,
    "## Classification",
    input.classification,
    "## Possible cause (unverified)",
    candidate.possibleCause ?? "Not inferred.",
    "## Factory evidence",
    `- Objective: #${occurrence.objective}`,
    ...(occurrence.workItem ? [`- Work Item: #${occurrence.workItem}`] : []),
    `- Run: ${occurrence.runId}`,
    ...(occurrence.attempt ? [`- Attempt: ${occurrence.attempt}`] : []),
    `- Phase: ${candidate.phase}`,
    `- Failure class: ${candidate.failureClass}`,
    ...candidate.evidence.map(
      (item) =>
        `- ${item.kind}: sha256:${item.digest}${item.commit ? ` commit:${item.commit}` : ""}${item.path ? ` path:${item.path}` : ""}`,
    ),
  ].join("\n\n");
  assertNoSecretMaterial(body, "finding issue body");
  return {
    title: `[Factory] ${candidate.failureClass}: ${candidate.supportedBehavior}`.slice(0, 256),
    body,
  };
}
