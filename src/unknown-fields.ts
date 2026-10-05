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
