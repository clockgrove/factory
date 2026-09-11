export const MAX_ORDINARY_QUALIFICATION_EVIDENCE_BYTES: number;
export const MAX_LARGE_FILE_REFUSAL_EVIDENCE_BYTES: number;
export function assertQualificationEvidenceValue<T>(value: T, maximum?: number, label?: string): T;
export function largeFileRefusalEvidenceBytes(value: unknown, redact?: string): number;
export function boundedQualificationEvidenceText(
  evidence: Record<string, unknown>,
  redact: string,
  options?: { allowLargeFileRefusal?: boolean },
): string;
