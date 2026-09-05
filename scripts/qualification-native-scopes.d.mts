export function nativeScopeUnit(identity: unknown): string;
export function nativeOwnedScopes(evidence: unknown, hostIdentity: string): string[];
export function observeNativeScopes(
  evidence: unknown,
  observe?: (unit: string) => string,
  hostIdentity?: string,
): void;
export function assertNativeScopes(evidence: unknown): void;
