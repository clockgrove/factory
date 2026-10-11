import { markdownLines } from "./markdown.js";

/** Adaptive compilation is selected by the pinned Objective and bounded by configuration. */
export function adaptiveWorkflowEnabled(body: string): boolean {
  const lines = markdownLines(body);
  const declarations = lines.flatMap((line, index) =>
    line.heading?.text.toLowerCase() === "adaptive workflow" ? [index] : [],
  );
  if (!declarations.length) return false;
  const start = declarations[0]!;
  const level = lines[start]!.heading!.level;
  if (declarations.length !== 1 || ![2, 3].includes(level))
    throw new Error(
      "Use one level-two or level-three Adaptive workflow section",
    );
  const entries = [];
  for (const line of lines.slice(start + 1)) {
    if (line.heading && line.heading.level <= level) break;
    if (line.text.trim()) entries.push(line);
  }
  const selection =
    entries.length === 1 && !entries[0]!.fenced
      ? entries[0]!.text.trim()
      : undefined;
  if (selection !== "enabled" && selection !== "disabled")
    throw new Error("Adaptive workflow requires exactly enabled or disabled");
  return selection === "enabled";
}
