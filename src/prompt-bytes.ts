import { createHash } from "node:crypto";

/** Producer-authored text sections; labels describe rendered material, not model roles. */
export const PROMPT_SECTION_KINDS = [
  "instructions",
  "objective",
  "evidence",
  "follow-up",
  "other",
] as const;
type PromptSectionKind = (typeof PROMPT_SECTION_KINDS)[number];
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

/**
 * Literal UTF-8 bodies as raw delimited text instead of JSON strings, which
 * avoids escaping and per-line wrappers. The fence derives from the bodies, so
 * no body can contain it (each is still checked), and the same bodies render
 * byte-identically across calls, keeping a stable provider-cache prefix.
 * Numbered lines show zero-based line indices for line-index choices.
 */
export function literalBodyBlocks(
  bodies: readonly { label: string; content: string }[],
  numberedLines = false,
): { text: string; guidance: string } {
  for (const { label, content } of bodies)
    if (
      !/^[a-z]+ [0-9]+$/.test(label) ||
      Buffer.from(content, "utf8").toString("utf8") !== content
    )
      throw new Error("Literal prompt body is not well-formed UTF-8 text");
  let fence = "";
  for (
    let salt = 0;
    !fence || bodies.some(({ content }) => content.includes(fence));
    salt += 1
  ) {
    const hash = createHash("sha256").update(`factory-literal-body:${salt}`);
    for (const { content } of bodies)
      hash.update(createHash("sha256").update(content).digest());
    fence = `BODY-${hash.digest("hex").slice(0, 20)}`;
  }
  const text = bodies
    .map(
      ({ label, content }) =>
        `<<<${fence} ${label}>>>\n${
          numberedLines
            ? content
                .split("\n")
                .map((line, index) => `${index}|${line}`)
                .join("\n")
            : content
        }\n<<<${fence} end>>>\n`,
    )
    .join("");
  const guidance = `Literal bodies are raw text blocks, not JSON: a line "<<<${fence} LABEL>>>" opens the body named LABEL and the next "<<<${fence} end>>>" line closes it. The body is exactly the text between the newline after the opening line and the newline before the closing line; "${fence}" never occurs inside a body.${numberedLines ? ' Each body line is shown as "lineIndex|text": the zero-based lineIndex and "|" are display prefixes, not content, and joining the texts with newlines gives the exact body.' : ""}`;
  return { text, guidance };
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
