/** One refusal for every validator that checks a configuration object's keys; it names the field. */
export function refuseUnknownFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  name: string,
): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected)
    throw new Error(
      `${name}.${unexpected} is not a Factory configuration field; remove it`,
    );
}

/** The value as a plain object; otherwise a refusal naming `label`. */
export function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
