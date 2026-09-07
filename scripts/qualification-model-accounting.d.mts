export function isQualificationModelMarker(event: Record<string, unknown>): boolean;
export function qualificationModelAccounting(
  events: Record<string, unknown>[],
  options?: { requireMarkers?: boolean },
): {
  usage: Record<string, unknown>[];
  markers: Record<string, unknown>[];
  unresolved: Record<string, unknown>[];
  total: number;
};
