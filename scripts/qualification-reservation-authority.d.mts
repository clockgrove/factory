export interface QualificationReservationAuthorityProof {
  logicalRef: string;
  reservationOid: string;
  reservationCommit: Record<string, unknown>;
  authority: Record<string, unknown>;
}
export function qualificationReservationRefs(reserved: Record<string, unknown>): {
  logicalRef: string;
  authorityRef: string;
};
export function assertQualificationReservationAuthority(
  proof: QualificationReservationAuthorityProof,
  reserved: Record<string, unknown>,
): QualificationReservationAuthorityProof;
export function resolveQualificationReservationAuthority(
  port: {
    readRef(ref: string): Promise<string | null>;
    readCommit(oid: string): Promise<Record<string, unknown>>;
  },
  reserved: Record<string, unknown>,
): Promise<QualificationReservationAuthorityProof>;
export function qualificationReservationReadPort(
  request: (route: string, parameters: Record<string, unknown>) => Promise<unknown>,
  options?: { deadline?: number; now?: () => number },
): {
  readRef(ref: string): Promise<string | null>;
  readCommit(oid: string): Promise<Record<string, unknown>>;
};
export function observeQualificationReservationAuthority(
  request: (route: string, parameters: Record<string, unknown>) => Promise<unknown>,
  reserved: Record<string, unknown>,
  options?: { deadline?: number; now?: () => number },
): Promise<QualificationReservationAuthorityProof>;
export interface QualificationReservationAuthorityExpectation {
  source: "issue-admission" | "legacy-attempt";
  canonical: { ref: string; oid: string | null };
  legacy: { ref: string; oid: string | null };
  reservationOid: string;
}
export interface QualificationReservationAuthorityReobservation {
  source: "issue-admission" | "legacy-attempt";
  canonical: { ref: string; openingOid: string | null; closingOid: string | null };
  legacy: { ref: string; openingOid: string | null; closingOid: string | null };
  reservationOid: string;
}
export function qualificationReservationAuthorityExpectation(
  proof: QualificationReservationAuthorityProof,
  reserved: Record<string, unknown>,
): QualificationReservationAuthorityExpectation;
export function assertQualificationReservationAuthorityReobservation(
  observation: QualificationReservationAuthorityReobservation,
  expectation: QualificationReservationAuthorityExpectation,
): QualificationReservationAuthorityReobservation;
export function revalidateQualificationReservationAuthority(
  port: {
    readRef(ref: string): Promise<string | null>;
    readCommit(oid: string): Promise<Record<string, unknown>>;
  },
  expectation: QualificationReservationAuthorityExpectation,
): Promise<QualificationReservationAuthorityReobservation>;
export function reobserveQualificationReservationAuthority(
  request: (route: string, parameters: Record<string, unknown>) => Promise<unknown>,
  proof: QualificationReservationAuthorityProof,
  reserved: Record<string, unknown>,
  options?: { deadline?: number; now?: () => number },
): Promise<QualificationReservationAuthorityReobservation>;
