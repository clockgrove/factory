export type QualificationDiagnosticValue =
  | null
  | boolean
  | number
  | string
  | QualificationDiagnosticValue[]
  | { [key: string]: QualificationDiagnosticValue };

export interface QualificationViolationDiagnostic {
  protocol: "clockgrove.factory/qualification-violation";
  code: string;
  phase: string;
  item: string;
  field: string;
  expected: string;
  observed: QualificationDiagnosticValue;
}

export class QualificationViolation extends Error {
  constructor(input: Omit<QualificationViolationDiagnostic, "protocol">);
  readonly violation: QualificationViolationDiagnostic;
}

export function qualificationInvariant(
  condition: unknown,
  input: Omit<QualificationViolationDiagnostic, "protocol">,
): asserts condition;

export function qualificationViolation(
  error: unknown,
): QualificationViolationDiagnostic | undefined;
