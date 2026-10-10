/** Producer-authored text sections; labels describe rendered material, not model roles. */
export const PROMPT_SECTION_KINDS = [
  "instructions",
  "objective",
  "evidence",
  "follow-up",
  "other",
] as const;
export type PromptSectionKind = (typeof PROMPT_SECTION_KINDS)[number];
export interface PromptSection {
  kind: PromptSectionKind;
  startByte: number;
  endByte: number;
}

/** Assemble the actual provider text once and record disjoint UTF-8 byte ranges. */
export function renderPrompt(
  parts: readonly (readonly [PromptSectionKind, string])[],
) {
  let offset = 0;
  const sections = parts.map(([kind, text]) => {
    const startByte = offset;
    offset += Buffer.byteLength(text);
    return { kind, startByte, endByte: offset };
  });
  return { prompt: parts.map(([, text]) => text).join(""), sections };
}

/** Serialize producer-owned JSON fields in their original order and escaping. */
export function promptJsonParts(
  value: Record<string, unknown>,
  kinds: Partial<Record<string, PromptSectionKind>>,
): (readonly [PromptSectionKind, string])[] {
  const parts: (readonly [PromptSectionKind, string])[] = [["other", "{"]];
  let first = true;
  for (const [key, valuePart] of Object.entries(value)) {
    const serialized = JSON.stringify(valuePart);
    if (serialized === undefined) continue;
    parts.push([
      kinds[key] ?? "other",
      `${first ? "" : ","}${JSON.stringify(key)}:${serialized}`,
    ]);
    first = false;
  }
  parts.push(["other", "}"]);
  return parts;
}

/** Observational validation only: invalid or absent sections remain unknown. */
export function validPromptSections(
  sections: readonly PromptSection[] | undefined,
  bytes: number,
) {
  if (
    !Array.isArray(sections) ||
    !sections.length ||
    !Number.isSafeInteger(bytes) ||
    bytes < 0
  )
    return false;
  let offset = 0;
  for (const section of sections) {
    if (
      !section ||
      typeof section !== "object" ||
      !PROMPT_SECTION_KINDS.includes(section.kind) ||
      !Number.isSafeInteger(section.startByte) ||
      section.startByte !== offset ||
      !Number.isSafeInteger(section.endByte) ||
      section.endByte < offset
    )
      return false;
    offset = section.endByte;
  }
  return offset === bytes;
}
