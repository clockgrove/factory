import { markdownLines } from "./markdown.js";

/** The pinned Objective selects guidance; acceptance and authority stay unchanged. */
function qualityCheckpointEnabled(body: string): boolean {
  const lines = markdownLines(body);
  const declarations = lines.flatMap((line, index) =>
    line.heading?.text.toLowerCase() === "quality checkpoint" ? [index] : [],
  );
  if (!declarations.length) return false;
  const start = declarations[0]!;
  const level = lines[start]!.heading!.level;
  if (declarations.length !== 1 || ![2, 3].includes(level))
    throw new Error(
      "Use one level-two or level-three Quality checkpoint section",
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
    throw new Error("Quality checkpoint requires exactly enabled or disabled");
  return selection === "enabled";
}

/** Compile the checkpoint into the existing brief, within the author's turn. */
export function qualityCheckpointInstructions(body: string): string {
  if (!qualityCheckpointEnabled(body)) return "";
  return `\n\nQuality checkpoint guidance (enabled by the pinned Objective; no new acceptance or authority): For each new or never-started implementation Work Item, put a short artifact-specific quality checkpoint in its existing brief. Derive a few observable dimensions from the original human intent and this item's deliverable, without repeating source bodies. Visual work may emphasize composition, craftsmanship and visible variety when requested; backend work needs its own relevant behavioral qualities rather than a visual rubric. Do not prescribe a style, library, extra feature or numerical quality threshold. Do not change retained attempted items or add QA, aggregate, grader or polish phases for this guidance.
The brief tells its author to inspect the actual result against those dimensions and the original intent, identify the least convincing dimension, and decide whether a meaningful in-scope improvement is warranted. If warranted, improve within owned paths and inspect the changed result again; report unowned needs through the ordinary discovery path. Hand off when the intent is convincingly fulfilled and remaining choices are minor preferences or outside scope. Include a concise observable summary of the decision, improvements and remaining tradeoffs in the ordinary final response; do not expose private reasoning. Preserve required commands, independent validation and review. No mandatory iteration count, model-facing time target, new acceptance fact, tool or permission is introduced.`;
}
